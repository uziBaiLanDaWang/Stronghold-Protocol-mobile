package com.stronghold.offline;

import android.content.res.AssetManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Feeds this APK's own assets to the WebView on a virtual https origin, by intercepting every request for that host.
 *
 * <p>Why not {@code file:///android_asset/}: the client is a native ES-module graph with an import map
 * (public/index.html:44) and Chromium treats {@code file://} as an opaque origin, so module scripts fail with a
 * CORS error and the page never boots. Interception gives a normal https origin - a secure context, so
 * {@code crypto.getRandomValues} (the offline engine's node:crypto shim) works too.
 *
 * <p>Why not a loopback HTTP server (which is what the first build did): loading {@code http://127.0.0.1} from a
 * WebView still goes through Chromium's network stack, which requires {@code android.permission.INTERNET} - an app
 * without it gets {@code net::ERR_ACCESS_DENIED} and a blank page. Intercepting avoids that permission entirely and
 * keeps the app with no permissions at all, no sockets, no cleartext traffic and no listening port.
 *
 * <p>This mirrors what androidx's WebViewAssetLoader does, minus the dependency: it is the approach Android
 * documents for exactly this case (a WebView app serving its own bundled web app). The host name is the one that
 * loader uses by convention; nothing is ever resolved, because every request for it is answered here.
 */
final class AssetInterceptor {

    /** The virtual origin: requests to it are served from assets, never from the network. */
    static final String HOST = "appassets.androidplatform.net";
    /**
     * The origin the bundled client is loaded on: plain http, NOT https.
     *
     * https was the first choice (a secure context), but it makes co-op with the bundled client impossible: a server
     * on the local network speaks {@code ws://}, and a secure page may not open an insecure WebSocket - Chromium
     * blocks it as mixed content. Loading the bundle over http puts the page and the server on the same scheme, so
     * the client inside this APK can reach a server with nothing but a WebSocket, downloading nothing. Nothing in
     * the client needs a secure context: it uses no {@code crypto.subtle} (only getRandomValues, which works
     * anywhere) and the copy buttons fall back to {@code document.execCommand} (public/js/ui/clipboard.js:13).
     */
    static final String ORIGIN = "http://" + HOST;

    /** Directory inside assets/ holding the tree assembled by tools/make-offline.mjs. */
    private static final String ROOT = "web/";
    /**
     * The extension-less audio route, mirroring shared/media.js (which both other sides import). The client rewrites
     * every audio URL to {@code /media/bgm/act1} so download managers do not pop up for each track, and the real
     * server resolves it back to a file under public/assets/audio. Java cannot import that JS module, so the two
     * constants are duplicated here - and tools/make-android-apk.mjs re-reads shared/media.js at build time and
     * fails the build if they drift.
     */
    private static final String MEDIA_PREFIX = "/media/";
    private static final String[] AUDIO_EXTS = { ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav" };
    /** Refuse to answer anything bigger than this (the largest asset is a few MB). */
    private static final long MAX_BODY = 64L * 1024 * 1024;

    private static final Map<String, String> MIME = new HashMap<String, String>();

    static {
        // Bare MIME types, with no charset parameter. This matters: WebResourceResponse's mimeType is parsed as a
        // content type, and passing a value that already carries parameters (while also passing an `encoding`)
        // leaves Chromium unable to render the navigation - the first build did exactly that and the WebView
        // displayed index.html as source text. This is the form androidx's WebViewAssetLoader uses.
        // The charset is not lost: HTML declares <meta charset="utf-8"> (index.html:4), JS modules and JSON are
        // UTF-8 by specification, and CSS inherits the document's encoding.
        // Content-Type decides whether the module graph loads at all: .js must be a JavaScript type.
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("map", "application/json");
        MIME.put("webmanifest", "application/manifest+json");
        MIME.put("txt", "text/plain");
        MIME.put("csv", "text/csv");
        MIME.put("xml", "application/xml");
        MIME.put("atlas", "text/plain");
        MIME.put("skel", "application/octet-stream");
        MIME.put("png", "image/png");
        MIME.put("webp", "image/webp");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("ogg", "audio/ogg");
        MIME.put("wav", "audio/wav");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("otf", "font/otf");
        MIME.put("wasm", "application/wasm");
    }

    private final AssetManager assets;
    /** Requests answered, for the diagnostics overlay. */
    private volatile int served;
    private volatile int missing;
    private volatile String lastMissing;
    private volatile String lastServed;

    AssetInterceptor(AssetManager assets) {
        this.assets = assets;
    }

    int servedCount() { return served; }
    int missingCount() { return missing; }
    String lastMissing() { return lastMissing; }
    /** "<path> -> <mime>" of the newest successful response, shown by the diagnostics overlay. */
    String lastServed() { return lastServed; }

    /**
     * Answer one request, or null to let it go to the network (which the app has no permission for).
     * Called by the WebView on a background thread, so blocking file reads here are fine.
     */
    WebResourceResponse intercept(WebResourceRequest request) {
        String raw = request.getUrl() != null ? request.getUrl().getPath() : null;
        if (raw == null || raw.isEmpty() || "/".equals(raw)) raw = "/index.html";

        // Path traversal: reject any "." / ".." segment outright.
        for (String segment : raw.split("/")) {
            if ("..".equals(segment) || ".".equals(segment)) return error(403, "Forbidden");
        }

        byte[] body = null;
        String path = null;
        // MEDIA_PREFIX carries a leading slash (shared/media.js), and `raw` still has it too - comparing against the
        // stripped path here was a bug: the branch never ran and every rewritten audio URL 404'd.
        if (raw.startsWith(MEDIA_PREFIX)) {
            // Extension-less audio: try each extension the real server would, and keep whichever resolved (the
            // resolved name also decides the Content-Type, since mimeOf() reads the extension).
            String rest = raw.substring(MEDIA_PREFIX.length());
            for (String ext : AUDIO_EXTS) {
                String candidate = "assets/audio/" + rest + ext;
                body = tryRead(ROOT + candidate);
                if (body != null) { path = candidate; break; }
            }
        } else {
            path = raw.startsWith("/") ? raw.substring(1) : raw;
            body = tryRead(ROOT + path);
        }
        if (body == null) {
            missing += 1;
            lastMissing = raw;
            return error(404, "Not found: " + raw);
        }
        if (body.length > MAX_BODY) return error(413, "Too large: " + raw);

        served += 1;
        String mime = mimeOf(path);
        lastServed = path + " -> " + mime;
        Map<String, String> headers = new HashMap<String, String>();
        // The page polls /healthz (js/ui/buildGuard.js); a 404 there is 'unknown', which never reloads. Nothing is
        // cached so a rebuilt APK always shows the new tree.
        headers.put("Cache-Control", "no-cache");
        headers.put("Content-Length", Integer.toString(body.length));
        // Same value in both places on purpose: some WebView versions read the response header for a main-frame
        // navigation rather than the constructor's mimeType, and the two can never conflict when they agree.
        headers.put("Content-Type", mime);
        // encoding = null and a bare mimeType: see the MIME table above. The charset travels inside the content
        // (HTML <meta>, and UTF-8 by spec for JS/JSON), which is what WebViewAssetLoader relies on too.
        return new WebResourceResponse(mime, null, 200, "OK", headers, new ByteArrayInputStream(body));
    }

    /** The asset's bytes, or null when it does not exist. */
    private byte[] tryRead(String assetPath) {
        try {
            return read(assetPath);
        } catch (IOException missingAsset) {
            return null;
        }
    }

    private byte[] read(String assetPath) throws IOException {
        InputStream in = assets.open(assetPath);
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] chunk = new byte[32768];
            int n;
            while ((n = in.read(chunk)) > 0) {
                buffer.write(chunk, 0, n);
                if (buffer.size() > MAX_BODY) break;
            }
            return buffer.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) { /* nothing to do */ }
        }
    }

    private static WebResourceResponse error(int status, String message) {
        byte[] body = message.getBytes();
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("Content-Type", "text/plain; charset=utf-8");
        return new WebResourceResponse("text/plain", "utf-8", status, message, headers, new ByteArrayInputStream(body));
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) return "application/octet-stream";
        String type = MIME.get(path.substring(dot + 1).toLowerCase(Locale.US));
        return type != null ? type : "application/octet-stream";
    }
}

package com.stronghold.offline;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The app: a launcher screen, and one WebView that plays the game either way.
 *
 * <p>Two modes, one client:
 * <ul>
 *   <li><b>Offline</b> - the copy of the client inside this APK, on the virtual asset origin with {@code ?local=1}
 *       (public/js/main.js), which boots the real match engine inside the page: solo play with no server and no
 *       network use at all.</li>
 *   <li><b>Online</b> - the client loaded <em>from a server</em>, exactly as a desktop browser does, so 1-4 player
 *       co-op works across devices. Loading the client from the server is deliberate: net.js verifies
 *       PROTOCOL_VERSION during the handshake and the server turns a stale client away, so a client bundled in the
 *       APK would break co-op as soon as the two builds drifted apart.</li>
 * </ul>
 *
 * <p>The INTERNET permission exists for the online mode only; the offline mode never opens a socket (its assets are
 * served from the APK by {@link AssetInterceptor}, on a virtual origin nothing else can reach).
 *
 * <p>One diagnostic remains, only for the case where nothing can be seen: a full-screen report when the main frame
 * fails or the page has not booted within {@link #BOOT_TIMEOUT_MS}. It is invisible in normal use and a tap
 * dismisses it.
 */
public class MainActivity extends Activity implements StartScreen.Listener {

    private static final String TAG = "StrongholdOffline";
    /** How long to wait for the page to boot before showing the full report. */
    private static final long BOOT_TIMEOUT_MS = 20000;
    private static final int PROBE_EVERY_MS = 2000;
    /** Kept for the report: the newest console lines and errors. */
    private static final int LOG_KEEP = 40;
    /** The bundled client, on the asset origin. */
    private static final String OFFLINE_URL = AssetInterceptor.ORIGIN + "/index.html?local=1";

    private WebView web;
    private AssetInterceptor interceptor;
    private StartScreen start;
    private SharedPreferences prefs;
    private FrameLayout root;
    private ScrollView overlay;
    private TextView overlayText;
    private final List<String> log = Collections.synchronizedList(new ArrayList<String>());
    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile boolean booted;
    /** A page is on screen (immersive, and back returns to the launcher). */
    private boolean inGame;

    /**
     * The probe asks the page what it has, and answers with a PLAIN-TEXT VERDICT PREFIX.
     *
     * The prefix matters: evaluateJavascript hands the callback the JSON-ENCODED form of whatever the script
     * returns, so quotes come back backslash-escaped (\"sp\":true) and a substring test for "sp":true never
     * matches. That mistake made an earlier build claim the page had not booted while it was fully up, covering the
     * running game. The verdict is therefore a bare word, and the JSON follows only as detail.
     *
     *   MATCH  - booted, a match is on screen
     *   SCREEN - booted, on a non-match screen (title / lobby / room)
     *   WAIT   - still booting
     *   ERR    - the script itself failed
     */
    private static final String PROBE_JS =
            "(function(){try{"
                    + "var e=document.getElementById('boot-err');"
                    + "var o={"
                    + "type:document.contentType,"
                    + "ready:document.readyState,"
                    + "sp:!!globalThis.__SP__,"
                    + "engine:!!globalThis.__SP_OFFLINE__,"
                    + "importmap:(typeof HTMLScriptElement!=='undefined'&&HTMLScriptElement.supports)?HTMLScriptElement.supports('importmap'):null,"
                    + "title:!!document.querySelector('.title-screen'),"
                    + "lobby:!!document.querySelector('.mode-card'),"
                    + "game:!!document.querySelector('.shopbar, .gtop__exit, .gm__gear'),"
                    + "bootErr:(e&&e.textContent)?e.textContent:null,"
                    + "origin:location.origin,"
                    + "vw:window.innerWidth+'x'+window.innerHeight"
                    + "};"
                    + "var ok=!!(o.sp||o.engine||o.game||o.title||o.lobby);"
                    + "if(!ok)return 'WAIT '+JSON.stringify(o);"
                    + "return (o.game?'MATCH ':'SCREEN ')+JSON.stringify(o);"
                    + "}catch(err){return 'ERR '+err;}})()";

    private final Runnable probe = new Runnable() {
        @Override public void run() {
            if (web == null || !inGame) return;
            web.evaluateJavascript(PROBE_JS, value -> {
                String v = value == null ? "" : value;
                note("probe: " + v);
                if (v.contains("ERR")) {
                    showOverlay("the page reported an error");
                    return;
                }
                if (v.contains("MATCH") || v.contains("SCREEN")) {
                    // Booted: stop probing, and leave the screen to the game.
                    booted = true;
                    hideOverlay();
                    return;
                }
                if (!booted && inGame) handler.postDelayed(probe, PROBE_EVERY_MS);
            });
        }
    };

    /** Fires if nothing has booted in time (a blank screen with no explanation is useless on a phone). */
    private final Runnable bootTimeout = new Runnable() {
        @Override public void run() {
            if (inGame && !booted) {
                showOverlay("the page did not boot within " + (BOOT_TIMEOUT_MS / 1000) + " s");
            }
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(StartScreen.PREFS, MODE_PRIVATE);

        interceptor = new AssetInterceptor(getAssets());

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // The client unlocks audio on the first gesture (public/js/audio.js); do not add a WebView requirement.
        s.setMediaPlaybackRequiresUserGesture(false);
        // The layout is a 19.2x10.8 rem design scaled from the viewport (css/theme.css:110): the system font scale
        // must not resize the HUD, and page zoom must stay off (index.html:7 already says so).
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(0xFF0C0F0E);      // index.html:8 theme-color, so there is no white flash
        web.setWebViewClient(new PageClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                String line = m.message() + " @" + m.sourceId() + ":" + m.lineNumber();
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                        || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    note("console." + m.messageLevel() + ": " + line);
                }
                Log.d(TAG, line);
                return true;
            }
        });
        // Lets a desktop Chrome inspect the running page (chrome://inspect) - the only debugger available for a
        // build that ships to someone else's phone.
        WebView.setWebContentsDebuggingEnabled(true);

        root = new FrameLayout(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        overlay = buildOverlay();
        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        start = new StartScreen(this, this);
        root.addView(start.view(), new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        showStartScreen();
    }

    // ---- the launcher's two choices --------------------------------------------------------------------------

    @Override public void onOffline() {
        loadGame(OFFLINE_URL, "bundled (offline; no network use at all)");
    }

    @Override public void onOnline(String url) {
        prefs.edit().putString(StartScreen.KEY_SERVER, start.currentAddress()).apply();
        loadGame(url, "server");
    }

    private void loadGame(String url, String what) {
        inGame = true;
        booted = false;
        hideOverlay();
        start.hide();
        goImmersive();
        note("loading " + url + "  [" + what + "]");
        web.loadUrl(url);
        handler.removeCallbacks(probe);
        handler.removeCallbacks(bootTimeout);
        handler.postDelayed(probe, 3000);
        handler.postDelayed(bootTimeout, BOOT_TIMEOUT_MS);
    }

    /** Back from the game returns here; back again leaves the app. */
    private void showStartScreen() {
        inGame = false;
        handler.removeCallbacks(probe);
        handler.removeCallbacks(bootTimeout);
        hideOverlay();
        if (web != null) web.loadUrl("about:blank");      // releases the page (and, online, drops the room seat)
        showSystemBars();
        start.show(prefs.getString(StartScreen.KEY_SERVER, ""));
    }

    @Override
    public void onBackPressed() {
        if (inGame) {
            showStartScreen();
            return;
        }
        super.onBackPressed();
    }

    // ---- diagnostics -----------------------------------------------------------------------------------------

    /** A full-screen, scrollable, selectable report; hidden until something goes wrong. */
    private ScrollView buildOverlay() {
        overlayText = new TextView(this);
        overlayText.setTextColor(Color.parseColor("#C3CBC7"));
        overlayText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        overlayText.setPadding(28, 28, 28, 28);
        overlayText.setTextIsSelectable(true);
        overlayText.setGravity(Gravity.TOP | Gravity.START);
        ScrollView scroller = new ScrollView(this);
        scroller.setBackgroundColor(0xF20C0F0E);
        scroller.addView(overlayText);
        scroller.setVisibility(View.GONE);
        // Tap to dismiss: the panel must never be the thing that keeps someone out of a working game.
        scroller.setOnClickListener(v -> hideOverlay());
        return scroller;
    }

    void note(String line) {
        log.add(line);
        while (log.size() > LOG_KEEP) log.remove(0);
    }

    /** The window's own insets in physical px: what the platform reports versus what CSS sees. */
    private String nativeInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return "insets: (API < 30)";
        WindowInsets wi = getWindow().getDecorView().getRootWindowInsets();
        if (wi == null) return "insets: not attached yet";
        Insets sb = wi.getInsets(WindowInsets.Type.systemBars());
        Insets cut = wi.getInsets(WindowInsets.Type.displayCutout());
        return "native px  sysBars l" + sb.left + " r" + sb.right + " t" + sb.top + " b" + sb.bottom
                + "  cutout l" + cut.left + " r" + cut.right + " t" + cut.top + " b" + cut.bottom;
    }

    /**
     * The safe-area insets the shell writes into the page, in CSS px: ALL FOUR ZERO, i.e. fully bleed.
     *
     * The game deliberately keeps the HUD and every non-match screen inside the safe area while the board and the
     * backdrops stay full-bleed (css/devices.css:7-8, :36 `.gm__hud`, :48 `.screen:not(.gm)`). Measured on the
     * reference device (Xiaomi 17 Pro, HyperOS 4 / Android 17):
     *   vw 817x375, dpr 3.25, root 40px, saL 47px saR 0px saT 0px saB 0px,
     *   native sysBars l0 r0 t0 b0, cutout l15 r0 t0 b0
     * Chromium reported 47 CSS px of left inset for a display cutout that is 15 PHYSICAL px - about 4.6 CSS px at
     * density 3.25, ten times the real thing - while its system bars are genuinely hidden. That inset pushed the
     * whole HUD (and the title screen) ~47 px to the right and left a visibly empty strip down the left, which is
     * what the user saw next to a full-bleed board. The values are forced to 0 so the UI lines up with the board.
     *
     * The real insets are still measured and logged, so the report shows what was overridden rather than hiding it.
     */
    private String safeAreaCss() {
        int[] m = measuredSafeAreaPx();
        note("safe area: measured t" + m[0] + " r" + m[1] + " b" + m[2] + " l" + m[3]
                + " css px | " + nativeInsets() + " -> FORCED 0 (full-bleed)");
        return ":root{--sa-l:0px;--sa-r:0px;--sa-t:0px;--sa-b:0px;}";
    }

    /**
     * What the safe area would be if the platform were trusted: the display cutout plus the currently visible
     * system bars, converted from physical px to CSS px. Diagnostics only - see {@link #safeAreaCss()}.
     * @return {top, right, bottom, left} in CSS px
     */
    private int[] measuredSafeAreaPx() {
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int l = 0, r = 0, t = 0, b = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsets wi = getWindow().getDecorView().getRootWindowInsets();
            if (wi != null) {
                Insets cut = wi.getInsets(WindowInsets.Type.displayCutout());
                Insets bars = wi.getInsets(WindowInsets.Type.systemBars());
                l = Math.round((cut.left + bars.left) / density);
                r = Math.round((cut.right + bars.right) / density);
                t = Math.round((cut.top + bars.top) / density);
                b = Math.round((cut.bottom + bars.bottom) / density);
            }
        }
        return new int[] { t, r, b, l };
    }

    /** Push {@link #safeAreaCss()} into the page (idempotent: one style element, rewritten each time). */
    private void applySafeArea() {
        if (web == null || !inGame) return;
        String css = safeAreaCss();
        // The CSS text contains no quotes, so it can sit inside a single-quoted JS string as-is.
        web.evaluateJavascript(
                "(function(){var id='sp-safe-area';var s=document.getElementById(id);"
                        + "if(!s){s=document.createElement('style');s.id=id;"
                        + "(document.head||document.documentElement).appendChild(s);}"
                        + "s.textContent='" + css + "';})()",
                null);
    }

    private void showOverlay(String why) {
        if (overlay == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append("卫戍协议 · 启动诊断\n\n");
        sb.append("原因: ").append(why).append("\n\n");
        sb.append("Android: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("机型: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        sb.append("资源拦截: ").append(interceptor.servedCount())
          .append(" 成功 / ").append(interceptor.missingCount()).append(" 未找到\n");
        if (interceptor.lastServed() != null) sb.append("最后响应: ").append(interceptor.lastServed()).append('\n');
        if (interceptor.lastMissing() != null) sb.append("最后一个 404: ").append(interceptor.lastMissing()).append('\n');
        sb.append(nativeInsets()).append('\n');
        String ua;
        try { ua = WebSettings.getDefaultUserAgent(this); } catch (Throwable t) { ua = "(unavailable)"; }
        sb.append("WebView: ").append(ua).append("\n\n");
        sb.append("---- 日志 ----\n");
        synchronized (log) {
            for (int i = Math.max(0, log.size() - 25); i < log.size(); i++) sb.append(log.get(i)).append('\n');
        }
        overlayText.setText(sb.toString());
        overlay.setVisibility(View.VISIBLE);
    }

    private void hideOverlay() {
        if (overlay != null) overlay.setVisibility(View.GONE);
    }

    /** Serve the bundled assets, and report anything that went wrong. */
    private final class PageClient extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // Only the bundled origin: in online mode every request goes to the server over the network, which is
            // what the INTERNET permission is for.
            if (request.getUrl() != null && AssetInterceptor.HOST.equals(request.getUrl().getHost())) {
                return interceptor.intercept(request);
            }
            return null;
        }

        @Override public void onPageFinished(WebView view, String url) {
            note("loaded " + url + " (intercepted " + interceptor.servedCount() + " requests)");
            // The page's own safe-area variables are Chromium's (over-reported on the reference device); replace
            // them with full-bleed values as soon as there is a document to inject into.
            applySafeArea();
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            String what = request != null && request.getUrl() != null ? request.getUrl().toString() : "?";
            String why = error != null ? (error.getErrorCode() + " " + error.getDescription()) : "unknown";
            note("onReceivedError " + what + " -> " + why);
            if (request == null || request.isForMainFrame()) {
                showOverlay("主页面加载失败: " + why + "\n" + what
                        + "\n\n联机模式下请确认：地址填的是开服电脑的地址、手机和它在同一 Wi-Fi、"
                        + "以及电脑上的游戏已经运行（npm start）。");
            }
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request != null && request.getUrl() != null) {
                note("http " + (response != null ? response.getStatusCode() : "?") + " " + request.getUrl());
            }
            if (request != null && request.isForMainFrame()) {
                showOverlay("主页面返回 HTTP " + (response != null ? response.getStatusCode() : "?")
                        + "\n" + request.getUrl());
            }
        }
    }

    // ---- window / lifecycle ----------------------------------------------------------------------------------

    @Override
    protected void onResume() {
        super.onResume();
        if (inGame) goImmersive(); else showSystemBars();
        if (web != null) web.onResume();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Several OEM builds (HyperOS/MIUI among them) bring the system bars back on the first focus change or after
        // a swipe; re-hiding them here is what actually keeps the game full-screen.
        if (hasFocus && inGame) {
            goImmersive();
            applySafeArea();        // the visible system bars change what the safe area should be
        }
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Edge-to-edge with the system bars hidden; a swipe brings them back transiently. */
    private void goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /** The launcher is an ordinary screen: let the content sit inside the system bars. */
    private void showSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.show(WindowInsets.Type.systemBars());
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }
}

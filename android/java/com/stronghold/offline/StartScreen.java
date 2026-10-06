package com.stronghold.offline;

import android.content.Context;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * The launcher screen: play the bundled offline game, or connect to a server for co-op.
 *
 * <p>Built from plain platform widgets on purpose - the shell has no androidx, so it can be built with nothing but
 * the SDK's build-tools (see tools/make-android-apk.mjs).
 *
 * <p>Offline loads the copy of the client inside the APK ({@code ?local=1} on the asset origin: the whole match
 * engine runs in the page, no server, no network). Online loads the client <em>from the server</em>, exactly as a
 * desktop browser would - which is also what keeps the two in step: {@code net.js} checks PROTOCOL_VERSION during
 * the handshake and the server refuses a stale client, so shipping the client inside the APK and pointing it at an
 * arbitrary server would break co-op the moment the two builds drift.
 */
final class StartScreen {

    /** What the activity does when a choice is made. */
    interface Listener {
        void onOffline();
        /** @param url already normalised by {@link #normalizeAddress} */
        void onOnline(String url);
    }

    static final String PREFS = "stronghold";
    static final String KEY_SERVER = "server";
    /** The port the game's own server listens on (README: 默认监听 TCP 3000). */
    private static final String DEFAULT_PORT = "3000";

    private final Listener listener;
    private final ScrollView view;
    private final EditText address;
    private final TextView status;

    StartScreen(Context ctx, Listener listener) {
        this.listener = listener;

        LinearLayout column = new LinearLayout(ctx);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        column.setBackgroundColor(0xFF0C0F0E);           // index.html:8 theme-color
        int pad = dp(ctx, 22);
        column.setPadding(pad, dp(ctx, 14), pad, dp(ctx, 14));

        TextView title = new TextView(ctx);
        title.setText("卫戍协议：盟约");
        title.setTextColor(0xFFE8EFEA);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        title.setGravity(Gravity.CENTER);
        column.addView(title);

        TextView sub = new TextView(ctx);
        sub.setText("选择游戏方式");
        sub.setTextColor(0xFF8B9A93);
        sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 0, 0, dp(ctx, 12));
        column.addView(sub);

        // ---- offline -------------------------------------------------------------------------------------
        Button offline = button(ctx, "离线单机（不联网）", true);
        offline.setOnClickListener(v -> {
            if (listener != null) listener.onOffline();
        });
        column.addView(offline, matchWrap(dp(ctx, 54)));

        TextView offHint = new TextView(ctx);
        offHint.setText("整个回合、经济、商店与战斗都在本机运行，不需要电脑，也不需要开服。");
        offHint.setTextColor(0xFF6F7C76);
        offHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        offHint.setPadding(0, dp(ctx, 4), 0, dp(ctx, 14));
        column.addView(offHint);

        // ---- online --------------------------------------------------------------------------------------
        TextView label = new TextView(ctx);
        label.setText("联机（1–4 人合作）· 服务器地址");
        label.setTextColor(0xFFB9C6C0);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        column.addView(label);

        address = new EditText(ctx);
        address.setHint("例如 192.168.1.5:3000 或 http://192.168.1.5:3000/?room=ABCD");
        address.setHintTextColor(0xFF5D6A64);
        address.setTextColor(0xFFE8EFEA);
        address.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        address.setSingleLine(true);
        // A URL or a room link, not a sentence: no autocorrect, no capitalisation, no suggestions.
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        address.setBackgroundColor(0xFF161B19);
        LinearLayout.LayoutParams ap = matchWrap(dp(ctx, 46));
        ap.topMargin = dp(ctx, 4);
        column.addView(address, ap);

        Button online = button(ctx, "联机", false);
        online.setOnClickListener(v -> {
            String url = normalizeAddress(address.getText().toString());
            if (url == null) {
                setStatus("请输入服务器地址，例如 192.168.1.5:3000");
                return;
            }
            setStatus("正在连接 " + url + " …");
            if (listener != null) listener.onOnline(url);
        });
        LinearLayout.LayoutParams op = matchWrap(dp(ctx, 50));
        op.topMargin = dp(ctx, 10);
        column.addView(online, op);

        status = new TextView(ctx);
        status.setTextColor(0xFFFFC46B);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        status.setPadding(0, dp(ctx, 8), 0, 0);
        column.addView(status);

        TextView hint = new TextView(ctx);
        hint.setText("在同一 Wi-Fi 下，让开服的人在电脑上运行游戏（npm start），把窗口里打印的"
                + "「局域网地址」填在上面即可。也可以直接粘贴他给你的房间链接。\n"
                + "返回键可以随时回到这一页；联机时离开对局有 10 分钟重连窗口。");
        hint.setTextColor(0xFF6F7C76);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        hint.setPadding(0, dp(ctx, 10), 0, 0);
        column.addView(hint);

        // A scroll container: the screen is landscape on a phone (a few hundred px tall) and this content is taller
        // than that on a short device.
        ScrollView scroll = new ScrollView(ctx);
        scroll.setBackgroundColor(0xFF0C0F0E);
        scroll.setFillViewport(true);
        scroll.addView(column, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        view = scroll;
    }

    View view() { return view; }

    /** Show the screen, pre-filling the last address used. */
    void show(String lastServer) {
        if (lastServer != null && !lastServer.isEmpty() && address.getText().length() == 0) {
            address.setText(lastServer);
        }
        setStatus("");
        view.setVisibility(View.VISIBLE);
    }

    void hide() { view.setVisibility(View.GONE); }

    /** The address the user last played against (may be empty). */
    String currentAddress() { return address.getText().toString(); }

    void setStatus(String message) { status.setText(message); }

    private static Button button(Context ctx, String text, boolean primary) {
        Button b = new Button(ctx);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(primary ? 0xFF06231B : 0xFF0C0F0E);
        b.setBackgroundColor(primary ? 0xFF4ED8AF : 0xFFB9C6C0);
        return b;
    }

    private static LinearLayout.LayoutParams matchWrap(int height) {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height);
    }

    private static int dp(Context ctx, int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, ctx.getResources().getDisplayMetrics()));
    }

    /**
     * Turn what someone typed into a URL to load.
     *
     * Accepts a bare host, a host:port, a full http(s) URL, or a room link the host shared
     * ({@code http://192.168.1.5:3000/?room=ABCD}) - the query is preserved, so pasting a shared link is the
     * quickest way to join. A bare {@code http://} address with no port gets the game's default 3000, since that is
     * what {@code npm start} prints and what people will type.
     *
     * @return the URL, or null when there is nothing usable
     */
    static String normalizeAddress(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return null;
        // Users paste these out of a chat client, which likes to wrap them in brackets or angle brackets.
        while (s.length() > 1 && "<([「【".indexOf(s.charAt(0)) >= 0) s = s.substring(1).trim();
        while (s.length() > 1 && ">)]」】".indexOf(s.charAt(s.length() - 1)) >= 0) s = s.substring(0, s.length() - 1).trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;

        int schemeEnd = s.indexOf("://") + 3;
        String rest = s.substring(schemeEnd);
        int slash = rest.indexOf('/');
        String authority = slash < 0 ? rest : rest.substring(0, slash);
        if (authority.isEmpty()) return null;
        // An explicit port wins; an IPv6 literal in brackets also contains ':' but is left alone on purpose.
        boolean hasPort = authority.indexOf(':') >= 0;
        if (!hasPort && s.regionMatches(true, 0, "http://", 0, 7)) {
            s = s.substring(0, schemeEnd) + authority + ":" + DEFAULT_PORT + (slash < 0 ? "" : rest.substring(slash));
        }
        return s;
    }
}

package com.pan.mobile;

import android.content.ContentValues;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.CookieManager;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 跨盘模块（夸克 / UC）——只做 JS 做不到的事，与 123 网盘主流程解耦。
 *
 * 职责（其余协议/解析逻辑保留在 assets/crosspan.js）：
 *   - 跨盘 Cookie 管理（用户粘贴 Cookie + 取链过程服务端下发的链路 Cookie）
 *   - 跨盘 API 请求头（httpRequest 用）
 *   - 夸克/UC CDN 直链下载（独立线程，不占用 123 下载链路）
 *
 * 关键点：夸克 CDN 下载必须带取链时服务端下发的 __sdid/__pugs 等链路 Cookie，否则返回 412。
 */
public class CrossPan {

    private final MainActivity host;

    /** 用户粘贴的 Cookie 原文（清洗后） */
    volatile String cookieRaw = "";
    /** 取链过程服务端下发的链路 Cookie（__sdid/__pugs 等）——CDN 下载必需 */
    final ConcurrentHashMap<String, String> chainCookies = new ConcurrentHashMap<>();
    /** 跨盘下载任务 ID 计数（与 123 任务 ID 段隔离） */
    private final AtomicInteger taskId = new AtomicInteger(900000);
    /** 运行中任务控制表（暂停/取消） */
    private final ConcurrentHashMap<Integer, Ctrl> ctrls = new ConcurrentHashMap<>();

    /** 单个下载任务的控制开关 */
    static class Ctrl { volatile boolean paused = false; volatile boolean cancelled = false; }

    /** 下载 UA（PC Electron 客户端） */
    private static final String DOWNLOAD_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 "
        + "Channel/pckk_other_ch";
    /** API 请求 UA（移动浏览器） */
    private static final String API_UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "Chrome/122.0.0.0 Mobile Safari/537.36";

    CrossPan(MainActivity h) { this.host = h; }

    // ==================== 基础判定 ====================

    static boolean isCrossUrl(String url) {
        return url != null && (url.contains("quark") || url.contains("uc.cn"));
    }

    static String diskOf(String url) {
        if (url == null) return "";
        if (url.contains("quark")) return "quark";
        if (url.contains("uc.cn")) return "uc";
        return "";
    }

    private static String[] domainsOf(String type) {
        if ("quark".equals(type)) return new String[] {
            "https://pan.quark.cn", "https://drive-pc.quark.cn",
            "https://drive-m.quark.cn", "https://www.myquark.cn" };
        if ("uc".equals(type)) return new String[] {
            "https://drive.uc.cn", "https://pc-api.uc.cn", "https://fast.uc.cn" };
        return null;
    }

    // ==================== Cookie ====================

    void setCookie(String type, String cookie) {
        String raw = cookie == null ? "" : cookie.trim();
        // 去 "Cookie:" 前缀，把换行/多行分隔统一成 ';'
        String flat = raw.replaceAll("(?i)^cookie:\\s*", "");
        flat = flat.replaceAll("[\\r\\n]+", ";");
        cookieRaw = flat;
        final String cleaned = flat;
        host.postUi(() -> {
            try {
                String[] domains = domainsOf(type);
                if (domains == null) return;
                for (String d : domains) {
                    if (cleaned.isEmpty()) continue;
                    for (String kv : cleaned.split(";")) {
                        String v = kv.trim();
                        if (v.isEmpty() || v.indexOf('=') < 0) continue;
                        CookieManager.getInstance().setCookie(d, v);
                    }
                }
                CookieManager.getInstance().flush();
            } catch (Throwable ig) {}
        });
    }

    String buildCookie(String url) {
        String ck = (cookieRaw != null && !cookieRaw.isEmpty()) ? cookieRaw : null;
        if (ck == null || ck.isEmpty()) ck = CookieManager.getInstance().getCookie(url);
        if (ck == null || ck.isEmpty()) {
            String[] hosts = domainsOf(diskOf(url));
            if (hosts != null) {
                StringBuilder sb = new StringBuilder();
                for (String h : hosts) {
                    try {
                        String c = CookieManager.getInstance().getCookie(h);
                        if (c != null && !c.isEmpty()) {
                            if (sb.length() > 0) sb.append("; ");
                            sb.append(c);
                        }
                    } catch (Throwable ig2) {}
                }
                ck = sb.length() > 0 ? sb.toString() : null;
            }
        }
        return ck == null ? "" : ck;
    }

    /**
     * 组装 CDN 下载用的 Cookie。
     * 实测：夸克 CDN 只认取链时下发的链路 Cookie（__sdid/__pugs）；用户 Cookie 打底，链路 Cookie 覆盖同名。
     */
    String buildDownloadCookie(String url) {
        StringBuilder cb = new StringBuilder();
        if (cookieRaw != null && !cookieRaw.isEmpty()) cb.append(cookieRaw);
        for (Map.Entry<String, String> e : chainCookies.entrySet()) {
            if (cb.length() > 0) cb.append("; ");
            cb.append(e.getKey()).append('=').append(e.getValue());
        }
        if (cb.length() == 0) {
            String ck = CookieManager.getInstance().getCookie(url);
            if (ck != null && !ck.isEmpty()) cb.append(ck);
        }
        return cb.toString();
    }

    /** 记录服务端 Set-Cookie 下发的链路 Cookie */
    void captureSetCookies(String url, java.net.URLConnection conn) {
        if (!isCrossUrl(url) || conn == null) return;
        try {
            List<String> scs = conn.getHeaderFields().get("Set-Cookie");
            if (scs == null) return;
            for (String sc : scs) {
                String v = (sc == null ? "" : sc).split(";")[0];
                if (v.isEmpty()) continue;
                CookieManager.getInstance().setCookie(url, v);
                int eq = v.indexOf('=');
                if (eq > 0) chainCookies.put(v.substring(0, eq).trim(), v.substring(eq + 1).trim());
            }
            CookieManager.getInstance().flush();
        } catch (Throwable ig) {}
    }

    // ==================== 请求头 ====================

    /** 为跨盘 API 请求（httpRequest）设置浏览器头 */
    void applyApiHeaders(HttpURLConnection conn, String url) {
        conn.setRequestProperty("user-agent", API_UA);
        conn.setRequestProperty("accept", "application/json, text/plain, */*");
        conn.setRequestProperty("accept-language", "zh-CN,zh;q=0.9");
        if (url != null && url.contains("uc.cn")) {
            conn.setRequestProperty("Origin", "https://drive.uc.cn");
            conn.setRequestProperty("Referer", "https://drive.uc.cn/");
            conn.setRequestProperty("sec-fetch-site", "cross-site");
            conn.setRequestProperty("cache-control", "no-cache");
            conn.setRequestProperty("pragma", "no-cache");
            conn.setRequestProperty("sec-fetch-mode", "cors");
            conn.setRequestProperty("sec-fetch-dest", "empty");
        } else {
            conn.setRequestProperty("Origin", "https://pan.quark.cn");
            conn.setRequestProperty("Referer", "https://pan.quark.cn/");
        }
    }

    // ==================== 下载 ====================

    /** 桥接入口：启动跨盘下载，返回任务 ID */
    String startDownload(String url, String name, String sizeStr, String disk) {
        try {
            if (url == null || url.isEmpty()) return "empty";
            final String fname = (name == null || name.isEmpty())
                ? ("cross_" + System.currentTimeMillis()) : name;
            long fs = 0L;
            try { fs = (long) Double.parseDouble(sizeStr == null || sizeStr.isEmpty() ? "0" : sizeStr); }
            catch (Throwable ig) { fs = 0L; }
            final long fsize = fs;
            final int tid = taskId.incrementAndGet();
            ctrls.put(tid, new Ctrl());
            Thread t = new Thread(() -> doDownload(tid, url, fname, fsize, disk));
            t.start();
            return String.valueOf(tid);
        } catch (Throwable e) {
            return "fail:" + e;
        }
    }

    /** CDN 直连下载（浏览器 UA + Referer + 链路 Cookie，不带 123 鉴权头） */
    private void doDownload(final int tid, final String url, final String fname,
                            final long expected, final String disk) {
        java.io.InputStream in = null;
        java.io.OutputStream out = null;
        Uri itemUri = null;
        final String[] ckInfo = new String[] { "EMPTY" };
        long done = 0;
        long total = expected > 0 ? expected : 0;
        try {
            boolean qk = url.contains("quark") || "quark".equals(disk);
            boolean uc = url.contains("uc.cn") || "uc".equals(disk);
            while (true) {
                // 暂停时先在此等待（不持有连接）；取消则抛出
                Ctrl ctl0 = ctrls.get(tid);
                if (ctl0 != null) {
                    if (ctl0.cancelled) throw new java.io.IOException("已取消");
                    while (ctl0.paused && !ctl0.cancelled) {
                        try { Thread.sleep(200); } catch (InterruptedException ie) { break; }
                    }
                    if (ctl0.cancelled) throw new java.io.IOException("已取消");
                }
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("user-agent", DOWNLOAD_UA);
                conn.setRequestProperty("accept", "*/*");
                conn.setRequestProperty("accept-language", "zh-CN,zh;q=0.9");
                conn.setRequestProperty("accept-encoding", "identity");
                conn.setRequestProperty("connection", "keep-alive");
                conn.setRequestProperty("sec-fetch-dest", "empty");
                conn.setRequestProperty("sec-fetch-mode", "cors");
                conn.setRequestProperty("sec-fetch-site", "cross-site");
                conn.setRequestProperty("cache-control", "no-cache");
                conn.setRequestProperty("pragma", "no-cache");
                if (qk) {
                    conn.setRequestProperty("Referer", "https://pan.quark.cn/");
                    conn.setRequestProperty("Origin", "https://pan.quark.cn");
                } else if (uc) {
                    conn.setRequestProperty("Referer", "https://drive.uc.cn/");
                    conn.setRequestProperty("Origin", "https://drive.uc.cn");
                }
                try {
                    String ck = buildDownloadCookie(url);
                    if (ck != null && !ck.isEmpty()) {
                        conn.setRequestProperty("Cookie", ck);
                        ckInfo[0] = ck.split(";").length + " pairs";
                    }
                } catch (Throwable ig) {}
                if (done > 0) conn.setRequestProperty("Range", "bytes=" + done + "-");
                int code = conn.getResponseCode();
                long len = conn.getContentLengthLong();
                if (code == 200 && done > 0) {
                    // 服务器忽略 Range：删除半成品，从头重下
                    host.extDebugAppend("CROSSDL", url, "range-ignored", "HTTP 200 restart");
                    done = 0;
                    if (itemUri != null) {
                        try { host.getContentResolver().delete(itemUri, null, null); } catch (Throwable ig) {}
                        itemUri = null;
                    }
                }
                if (code < 200 || code >= 300) {
                    String body = "";
                    try {
                        java.io.InputStream es = conn.getErrorStream();
                        if (es != null) {
                            byte[] eb = new byte[1024];
                            int en = es.read(eb);
                            if (en > 0) body = new String(eb, 0, en, java.nio.charset.StandardCharsets.UTF_8);
                            es.close();
                        }
                    } catch (Throwable ig) {}
                    host.extDebugAppend("CROSSDL", url, "cookie=" + ckInfo[0], "HTTP " + code + " " + body);
                    String hint = "";
                    if (code == 412) hint = "（CDN 拒绝：请刷新分享页后重试）";
                    else if (code == 401 || code == 403) hint = "（登录态失效，请重新登录该网盘）";
                    result(tid, false, "HTTP " + code
                        + (body.isEmpty() ? "" : (" " + body.substring(0, Math.min(80, body.length())))) + hint);
                    return;
                }
                if (code == 206) total = done + (len > 0 ? len : 0);
                else if (len > 0) total = len;
                if (total <= 0) total = expected;
                if (itemUri == null) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fname);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, host.downloadRelPath());
                    cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    itemUri = host.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (itemUri == null) { result(tid, false, "落盘失败"); return; }
                }
                in = conn.getInputStream();
                out = done > 0
                    ? host.getContentResolver().openOutputStream(itemUri, "wa")
                    : host.getContentResolver().openOutputStream(itemUri, "w");
                if (out == null) { result(tid, false, "落盘失败"); return; }
                byte[] buf = new byte[65536];
                int n;
                boolean paused = false;
                long lastReport = done;
                while ((n = in.read(buf)) > 0) {
                    Ctrl ctl = ctrls.get(tid);
                    if (ctl != null) {
                        if (ctl.cancelled) throw new java.io.IOException("已取消");
                        if (ctl.paused) { paused = true; break; }
                    }
                    out.write(buf, 0, n);
                    done += n;
                    if (total > 0 && done - lastReport > (total / 100 + 1)) {
                        lastReport = done;
                        progress(tid, (int) (done * 100 / total), done, total);
                    }
                }
                try { out.flush(); out.close(); } catch (Throwable ig) {}
                out = null;
                try { in.close(); } catch (Throwable ig) {}
                in = null;
                conn.disconnect();
                if (paused) {
                    // 连接已关闭（网络停止）；上报当前进度；回到顶部等待恢复
                    progress(tid, total > 0 ? (int) (done * 100 / total) : 0, done, total);
                    host.extDebugAppend("CROSSDL", url, "paused@" + done, "conn closed");
                    continue;
                }
                break;
            }
            ContentValues okCv = new ContentValues();
            okCv.put(MediaStore.MediaColumns.IS_PENDING, 0);
            host.getContentResolver().update(itemUri, okCv, null, null);
            result(tid, true, "");
        } catch (Throwable e) {
            result(tid, false, String.valueOf(e));
        } finally {
            ctrls.remove(tid);
            try { if (in != null) in.close(); } catch (Throwable ig) {}
            try { if (out != null) out.close(); } catch (Throwable ig) {}
        }
    }

    private void progress(int tid, int pct, long done, long total) {
        host.evalJs("window.__onCrossProgress&&window.__onCrossProgress("
            + tid + "," + pct + "," + done + "," + total + ");");
    }

    private void result(int tid, boolean ok, String msg) {
        host.evalJs("window.__onCrossResult&&window.__onCrossResult("
            + tid + "," + (ok ? "true" : "false") + ","
            + org.json.JSONObject.quote(msg == null ? "" : msg) + ");");
    }

    // ==================== 暂停 / 继续 / 取消 ====================

    /** 暂停某跨盘下载任务（关闭连接，真正停止网络） */
    void pause(int tid) { Ctrl c = ctrls.get(tid); if (c != null) c.paused = true; }
    /** 继续某跨盘下载任务（重新连接，Range 断点续传） */
    void resume(int tid) { Ctrl c = ctrls.get(tid); if (c != null) c.paused = false; }
    /** 取消某跨盘下载任务 */
    void cancel(int tid) { Ctrl c = ctrls.get(tid); if (c != null) c.cancelled = true; }

    /** 当前运行中的跨盘任务 ID 列表（供前端判断"App 重启后已中断"） */
    String activeTaskIdsJson() {
        org.json.JSONArray a = new org.json.JSONArray();
        for (Integer id : ctrls.keySet()) a.put(id.intValue());
        return a.toString();
    }
}
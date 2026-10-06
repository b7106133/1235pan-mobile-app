package com.pan.mobile;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生上传管理器（独立类）
 *   - 数据源：SAF content:// URI（或本地路径）→ **直接读原文件上传，不复制到缓存**
 *   - 队列：并发上限 2；入队即在「传输页 → 上传」列表出现（排队中）
 *   - 文件夹：**边枚举边入队**（枚举不建目录、不做网络请求 → 不卡）；
 *     上传到该文件时**按需创建目录**（结果缓存，同一目录只建一次）
 *   - 取消 / 重试（分片会话缓存支持断点续传）/ 持久化（重启后任务仍在）
 */
public class UploadManager {

    public static final int ST_QUEUED = 0;
    public static final int ST_UPLOADING = 1;
    public static final int ST_CANCELLED = 2;
    public static final int ST_PAUSED = 3;
    public static final int ST_DONE = 8;
    public static final int ST_FAILED = 16;

    private static final String PREF = "pan_prefs";
    private static final String KEY = "up_tasks_v1";
    private static final int MAX_CONCURRENT = 3;   // 同时上传的任务数

    public static class Task {
        public long id;
        public String uri = "";
        public String name = "";
        public long size;
        public long parentFileId;      // 0 表示尚未解析（需按需建目录）
        public String rel = "";        // 相对路径（文件夹上传）
        public String relParent = "";  // 所在目录的相对路径
        public String groupId = "";    // 同一批文件夹上传共用一个组 id（前端聚合成一张卡）
        public String groupName = "";  // 组显示名（文件夹名）
        public volatile int status = ST_QUEUED;
        public volatile long done;
        public volatile long total;
        public volatile long speed;
        public volatile String error = "";
        volatile long nativeId = -1;
        volatile long lastDone, lastAt;
        volatile boolean queuedNotified;

        public String statusText() {
            switch (status) {
                case ST_QUEUED: return "排队中";
                case ST_UPLOADING: return "上传中";
                case ST_CANCELLED: return "已取消";
                case ST_PAUSED: return "已暂停";
                case ST_DONE: return "已完成";
                case ST_FAILED: return (error == null || error.isEmpty()) ? "失败" : ("失败：" + error);
                default: return "";
            }
        }
        public int percent() {
            if (total <= 0) return status == ST_DONE ? 100 : 0;
            int p = (int) (done * 100 / total);
            if (p > 100) p = 100;
            if (p < 0) p = 0;
            return p;
        }
    }

    private static UploadManager INS;

    private final Context app;
    private final SharedPreferences prefs;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final List<Task> tasks = new ArrayList<>();
    private final ArrayDeque<Task> queue = new ArrayDeque<>();
    private int active = 0;
    private long nextId = 1;
    private Runnable listener;
    /** 待通知前端的“入队”任务（批量合并，避免几百次 JS 回调把 UI 卡死） */
    private final java.util.ArrayList<Task> pendingNotify = new java.util.ArrayList<>();
    private boolean notifyScheduled = false;

    /** 目录路径 → 云端 fileId 缓存（同一目录只建一次） */
    private final ConcurrentHashMap<String, Long> dirIds = new ConcurrentHashMap<>();
    private final ExecutorService dirPool = Executors.newFixedThreadPool(2);
    private volatile long treeRoot = 0;
    /** 当前 addTree 批次的组信息（枚举线程读取） */
    private volatile String curGroupId = "";
    private volatile String curGroupName = "";
    /** 已暂停的组：暂停后新枚举出的任务进队即落 PAUSED（保证“整个 zip”一起停） */
    private final java.util.Set<String> groupsPaused =
            java.util.concurrent.ConcurrentHashMap.newKeySet();

    private UploadManager(Context c) {
        app = c.getApplicationContext();
        prefs = app.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        load();
    }

    public static synchronized UploadManager get(Context c) {
        if (INS == null) INS = new UploadManager(c);
        return INS;
    }

    public void setListener(Runnable r) { listener = r; }
    private void trace(String m) {
        try { MainActivity ma = MainActivity.UPLOAD_HOST; if (ma != null) ma.dlTrace("UP " + m); } catch (Throwable ig) {}
    }
    private void changed() { Runnable r = listener; if (r != null) ui.post(r); }

    public List<Task> snapshot() { return new ArrayList<>(tasks); }
    public int activeCount() { return active; }
    public int queuedCount() { return queue.size(); }

    private Task byId(long id) { for (Task t : tasks) if (t.id == id) return t; return null; }

    // ==================== 加入任务 ====================

    /** 多选文件（parentFileId 为当前目录） */
    public void addUris(List<Uri> uris, long parentFileId) {
        if (uris == null || uris.isEmpty()) return;
        List<Task> added = new ArrayList<>();
        for (Uri u : uris) {
            if (u == null) continue;
            try { app.getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Throwable ig) {}
            String name = queryName(u);
            long size = querySize(u);
            if (name == null || name.isEmpty()) name = "file_" + System.currentTimeMillis();
            Task t = new Task();
            t.uri = u.toString(); t.name = name; t.size = size; t.total = size;
            t.parentFileId = parentFileId; t.rel = name; t.relParent = "";
            added.add(t);
        }
        trace("addUris n=" + added.size() + " parent=" + parentFileId);
        flush(added);
    }

    /** 文件夹：**边枚举边入队**（不建目录、不发网络请求），上传时按需建目录 */
    public void addTree(final Uri treeUri, final long parentFileId) {
        if (treeUri == null) return;
        try { app.getContentResolver().takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Throwable ig) {}
        treeRoot = parentFileId;
        dirIds.clear();
        final String tree = treeUri.toString();
        // 整棵目录树 = 一个上传组：前端「上传」列表只显示一张卡
        curGroupId = "uf_" + System.currentTimeMillis() + "_" + (int)(Math.random() * 100000);
        String gname = "";
        try {
            String docId = android.provider.DocumentsContract.getTreeDocumentId(treeUri);
            if (docId != null && !docId.isEmpty()) {
                int p = docId.lastIndexOf(':');
                gname = (p >= 0 && p + 1 < docId.length()) ? docId.substring(p + 1) : docId;
                int s1 = gname.lastIndexOf('/');
                if (s1 >= 0 && s1 + 1 < gname.length()) gname = gname.substring(s1 + 1);
                int s2 = gname.lastIndexOf('\\');
                if (s2 >= 0 && s2 + 1 < gname.length()) gname = gname.substring(s2 + 1);
            }
        } catch (Throwable ig) {}
        if (gname == null || gname.isEmpty()) gname = "文件夹";
        curGroupName = gname;
        trace("addTree start root=" + parentFileId + " group=" + curGroupId + " name=" + gname);
        new Thread(() -> {
            final List<Task> batch = new ArrayList<>();
            try { walk(tree, "", "", parentFileId, batch); } catch (Throwable ig) {}
            flush(batch);
            trace("addTree done total=" + tasks.size());
        }).start();
    }

    /** 递归枚举：不建目录；每处理完一层就把文件批量入队（列表立刻可见） */
    private void walk(String treeUri, String docId, String prefix, long cloudPid, List<Task> batch) {
        walk(treeUri, docId, prefix, cloudPid, batch, 0);
    }

    /** 递归枚举：docId 必须逐级下传（否则会无限递归列出同一层） */
    private void walk(String treeUri, String docId, String prefix, long cloudPid, List<Task> batch, int depth) {
        MainActivity ma = MainActivity.UPLOAD_HOST;
        if (ma == null || depth > 24) return;
        JSONArray arr;
        try {
            String js = ma.listTreeChildrenImpl(treeUri, docId == null ? "" : docId);
            arr = new JSONArray(js == null ? "[]" : js);
        } catch (Throwable e) { return; }

        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || !o.optBoolean("dir")) continue;
            String name = o.optString("name", "");
            String childDoc = o.optString("id", "");
            if (name.isEmpty() || childDoc.isEmpty()) continue;
            String rel = prefix.isEmpty() ? name : (prefix + "/" + name);
            walk(treeUri, childDoc, rel, cloudPid, batch, depth + 1);
        }
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null || o.optBoolean("dir")) continue;
            String name = o.optString("name", "");
            String uri = o.optString("uri", "");
            if (name.isEmpty() || uri.isEmpty()) continue;
            Task t = new Task();
            t.uri = uri; t.name = name;
            t.size = o.optLong("size", 0); t.total = t.size;
            t.parentFileId = 0;                       // 0 = 待按需解析
            t.relParent = prefix;
            t.rel = prefix.isEmpty() ? name : (prefix + "/" + name);
            t.groupId = curGroupId;
            t.groupName = curGroupName;
            batch.add(t);
            if (batch.size() >= 200) flush(batch);     // 分批入队（大批量，减少 JS 回调）
        }
        flush(batch);
    }

    private void flush(List<Task> batch) {
        if (batch.isEmpty()) return;
        final ArrayList<Task> copy = new ArrayList<>(batch);
        batch.clear();
        ui.post(() -> {
            for (Task t : copy) {
                t.id = nextId++;
                tasks.add(t);
                // 组已暂停：新任务直接落 PAUSED，绝不进队列（避免“暂停后排队文件自己跑”）
                if (t.groupId != null && !t.groupId.isEmpty()
                        && groupsPaused.contains(t.groupId)) {
                    t.status = ST_PAUSED;
                } else {
                    queue.add(t);
                }
                pendingNotify.add(t);
            }
            save();
            scheduleNotify();
            pump();
        });
    }

    /** 入队通知：150ms 合并一次，批量发给前端（一次建多行，只重绘一次） */
    private void scheduleNotify() {
        if (notifyScheduled) return;
        notifyScheduled = true;
        ui.postDelayed(() -> {
            notifyScheduled = false;
            if (pendingNotify.isEmpty()) return;
            ArrayList<Task> b = new ArrayList<>(pendingNotify);
            pendingNotify.clear();
            MainActivity ma = MainActivity.UPLOAD_HOST;
            if (ma != null) { try { ma.notifyUploadQueuedBatch(b); } catch (Throwable ig) {} }
            changed();
        }, 400);
    }

    // ==================== 调度 ====================

    public void pump() {
        ui.post(() -> {
            MainActivity ma = MainActivity.UPLOAD_HOST;
            while (active < MAX_CONCURRENT && !queue.isEmpty()) {
                final Task t = queue.poll();
                if (t == null) break;
                if (t.status == ST_CANCELLED || t.status == ST_DONE
                        || t.status == ST_UPLOADING || t.status == ST_PAUSED) continue;
                // 组级暂停：整组一律不启动
                if (t.groupId != null && !t.groupId.isEmpty()
                        && groupsPaused.contains(t.groupId)) {
                    t.status = ST_PAUSED;
                    continue;
                }
                if (ma == null) { t.status = ST_FAILED; t.error = "页面未就绪"; continue; }
                if (t.parentFileId <= 0 && t.relParent != null && !t.relParent.isEmpty()) {
                    // 目标目录未知：后台按需创建（并发线程池，单线程串行，结果缓存）
                    dirPool.execute(() -> {
                        trace("ensureDir rel=" + t.relParent);
                        long pid = ensureDir(t.relParent);
                        trace("ensureDir rel=" + t.relParent + " -> " + pid);
                        ui.post(() -> {
                            t.parentFileId = pid > 0 ? pid : treeRoot;
                            if (t.status == ST_PAUSED || t.status == ST_CANCELLED) { changed(); pump(); return; }
                            if (active < MAX_CONCURRENT) startTask(t, ma); else queue.addFirst(t);
                            changed(); pump();
                        });
                    });
                    continue;
                }
                startTask(t, ma);
            }
            save(); changed();
        });
    }

    private void startTask(final Task t, MainActivity ma) {
        long nid;
        try {
            nid = ma.startUriUpload(t.id, Uri.parse(t.uri), t.name, t.size, t.parentFileId, 1);
        } catch (Throwable e) { nid = -1; }
        trace("startTask #" + t.id + " " + t.name + " parent=" + t.parentFileId + " -> nid=" + nid);
        if (nid > 0) {
            t.nativeId = nid;
            t.status = ST_UPLOADING;
            t.error = "";
            t.lastDone = t.done;
            t.lastAt = System.currentTimeMillis();
            active++;
            try { ma.notifyUploadStarted(nid, t.id, t.name, t.size, t.groupId, t.groupName); } catch (Throwable ig) {}
        } else {
            t.status = ST_FAILED;
            t.error = "上传启动失败";
            trace("startTask FAILED #" + t.id + " " + t.name);
        }
    }

    /** 目录创建串行锁：并发 ensure 同一目录时只发一次 mkdir（日志实测有 3~4 次重复建） */
    private final Object dirLock = new Object();

    /** 按需创建目录（背景线程）：逐级创建并缓存，返回目标目录 fileId */
    long ensureDir(String rel) {
        if (rel == null || rel.isEmpty()) return treeRoot;
        synchronized (dirLock) {
            Long cached = dirIds.get(rel);
            if (cached != null) return cached;
            int i = rel.lastIndexOf('/');
            String parentRel = (i > 0) ? rel.substring(0, i) : "";
            String name = (i >= 0) ? rel.substring(i + 1) : rel;
            long pid = ensureDir(parentRel);
            MainActivity ma = MainActivity.UPLOAD_HOST;
            long id = (ma == null) ? 0 : ma.mkdirForUpload(name, pid);
            if (id <= 0) id = pid;
            dirIds.put(rel, id);
            return id;
        }
    }

    // ==================== 进度 / 结果 ====================

    public void onNativeProgress(final long localId, final long done, final long total) {
        ui.post(() -> {
            Task t = byId(localId);
            if (t == null) return;
            long now = System.currentTimeMillis();
            if (t.lastAt > 0) {
                long dt = now - t.lastAt;
                if (dt >= 500) {
                    t.speed = Math.max(0, (done - t.lastDone) * 1000 / dt);
                    t.lastDone = done;
                    t.lastAt = now;
                }
            }
            t.done = done;
            if (total > 0) t.total = total;
            changed();
        });
    }

    public void onNativeResult(final long localId, final boolean ok, final String msg) {
        ui.post(() -> {
            Task t = byId(localId);
            if (t == null) return;
            if (ok) {
                t.status = ST_DONE;
                t.done = t.total > 0 ? t.total : t.done;
                t.speed = 0; t.error = "";
            } else if (t.status == ST_CANCELLED) {
                t.speed = 0;
            } else {
                t.status = ST_FAILED;
                t.error = (msg == null || msg.isEmpty()) ? "上传失败" : msg;
                t.speed = 0;
            }
            active = Math.max(0, active - 1);
            save(); changed(); pump();
        });
    }

    // ==================== 操作 ====================

    /** 暂停：正在传的让原生线程在块边界停下；排队的直接置为已暂停 */
    public void pause(final Task t) {
        if (t == null) return;
        ui.post(() -> {
            MainActivity ma = MainActivity.UPLOAD_HOST;
            if (t.status == ST_UPLOADING && t.nativeId > 0 && ma != null) {
                try { ma.pauseUploadNative(t.nativeId); } catch (Throwable ig) {}
            } else if (t.status == ST_QUEUED) {
                t.status = ST_PAUSED;
                queue.remove(t);
                save(); changed();
            }
        });
    }

    /** 继续（重新入队；分片会话缓存在 prefs，可断点续传） */
    public void resume(final Task t) {
        if (t == null) return;
        ui.post(() -> {
            if (t.status == ST_DONE) return;
            t.status = ST_QUEUED;
            t.error = "";
            if (!queue.contains(t)) queue.add(t);
            save(); changed(); pump();
        });
    }

    public void pauseById(long localId) { pause(byId(localId)); }

    /** 按组批量暂停（原生权威：一次遍历，不依赖 JS 逐个 id） */
    public void pauseGroup(final String gid) {
        if (gid == null || gid.isEmpty()) return;
        groupsPaused.add(gid);          // 登记：后续枚举出的新任务也会落 PAUSED
        ui.post(() -> {
            int n = 0;
            for (Task t : new ArrayList<>(tasks)) {
                if (!gid.equals(t.groupId)) continue;
                if (t.status == ST_UPLOADING && t.nativeId > 0) {
                    MainActivity ma = MainActivity.UPLOAD_HOST;
                    if (ma != null) { try { ma.pauseUploadNative(t.nativeId); } catch (Throwable ig) {} }
                    n++;
                } else if (t.status == ST_QUEUED || t.status == ST_UPLOADING) {
                    t.status = ST_PAUSED;
                    queue.remove(t);
                    n++;
                }
            }
            trace("pauseGroup " + gid + " n=" + n);
            save(); changed();
        });
    }

    /** 按组批量继续 */
    public void resumeGroup(final String gid) {
        if (gid == null || gid.isEmpty()) return;
        groupsPaused.remove(gid);       // 解除组暂停登记
        ui.post(() -> {
            int n = 0;
            for (Task t : new ArrayList<>(tasks)) {
                if (!gid.equals(t.groupId)) continue;
                if (t.status == ST_DONE) continue;
                t.status = ST_QUEUED;
                t.error = "";
                t.parentFileId = 0;            // 重新按需解析目录
                if (!queue.contains(t)) queue.add(t);
                n++;
            }
            trace("resumeGroup " + gid + " n=" + n);
            save(); changed(); pump();
        });
    }

    /** 按组批量取消 */
    public void cancelGroup(final String gid) {
        if (gid == null || gid.isEmpty()) return;
        groupsPaused.remove(gid);
        ui.post(() -> {
            MainActivity ma = MainActivity.UPLOAD_HOST;
            int n = 0;
            for (Task t : new ArrayList<>(tasks)) {
                if (!gid.equals(t.groupId)) continue;
                if (t.status == ST_UPLOADING && t.nativeId > 0 && ma != null) {
                    try { ma.cancelUploadTask(t.nativeId); } catch (Throwable ig) {}
                    active = Math.max(0, active - 1);
                }
                t.status = ST_CANCELLED;
                t.speed = 0;
                queue.remove(t);
                n++;
            }
            trace("cancelGroup " + gid + " n=" + n);
            save(); changed();
        });
    }
    public void resumeById(long localId) { resume(byId(localId)); }

    /** 原生线程报告“已在暂停点停止” */
    public void onNativePaused(final long localId) {
        ui.post(() -> {
            Task t = byId(localId);
            if (t == null) return;
            t.status = ST_PAUSED;
            t.speed = 0;
            active = Math.max(0, active - 1);
            save(); changed(); pump();
        });
    }

    public void cancel(final Task t) {
        if (t == null) return;
        ui.post(() -> {
            MainActivity ma = MainActivity.UPLOAD_HOST;
            if (t.nativeId > 0 && ma != null) { try { ma.cancelUploadTask(t.nativeId); } catch (Throwable ig) {} }
            t.status = ST_CANCELLED;
            t.speed = 0;
            queue.remove(t);
            save(); changed();
        });
    }

    public void retry(final Task t) {
        if (t == null) return;
        ui.post(() -> {
            if (t.status == ST_DONE || t.status == ST_UPLOADING) return;
            t.status = ST_QUEUED;
            t.error = "";
            if (!queue.contains(t)) queue.add(t);
            save(); changed(); pump();
        });
    }

    public void cancelAll() {
        ui.post(() -> {
            MainActivity ma = MainActivity.UPLOAD_HOST;
            for (Task t : new ArrayList<>(queue)) t.status = ST_CANCELLED;
            queue.clear();
            for (Task t : tasks) {
                if (t.status == ST_UPLOADING) {
                    if (t.nativeId > 0 && ma != null) { try { ma.cancelUploadTask(t.nativeId); } catch (Throwable ig) {} }
                    t.status = ST_CANCELLED; t.speed = 0;
                }
            }
            save(); changed();
        });
    }

    public void retryAllFailed() {
        ui.post(() -> {
            for (Task t : tasks) {
                if (t.status == ST_FAILED || t.status == ST_CANCELLED || t.status == ST_PAUSED) {
                    t.status = ST_QUEUED; t.error = "";
                    if (!queue.contains(t)) queue.add(t);
                }
            }
            save(); changed(); pump();
        });
    }

    public void clearFinished() {
        ui.post(() -> {
            for (int i = tasks.size() - 1; i >= 0; i--) {
                Task t = tasks.get(i);
                if (t.status == ST_DONE || t.status == ST_FAILED || t.status == ST_CANCELLED) tasks.remove(i);
            }
            save(); changed();
        });
    }

    // ==================== 查询 ====================

    private String queryName(Uri u) {
        try (android.database.Cursor c = app.getContentResolver().query(u,
                new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Throwable ig) {}
        String p = u.getLastPathSegment();
        return p == null ? "" : p;
    }

    private long querySize(Uri u) {
        try (android.database.Cursor c = app.getContentResolver().query(u,
                new String[]{android.provider.OpenableColumns.SIZE}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Throwable ig) {}
        return 0;
    }

    // ==================== 持久化 ====================

    private boolean saveScheduled = false;
    /** 延迟合并写盘：枚举 1400+ 文件时避免每批全量序列化（SharedPreferences）拖 UI */
    private void save() {
        if (saveScheduled) return;
        saveScheduled = true;
        ui.postDelayed(() -> { saveScheduled = false; saveNow(); }, 600);
    }
    private void saveNow() {
        try {
            JSONArray arr = new JSONArray();
            for (Task t : tasks) {
                JSONObject o = new JSONObject();
                o.put("id", t.id); o.put("uri", t.uri); o.put("name", t.name);
                o.put("size", t.size); o.put("parent", t.parentFileId);
                o.put("rel", t.rel); o.put("relParent", t.relParent);
                o.put("groupId", t.groupId == null ? "" : t.groupId);
                o.put("groupName", t.groupName == null ? "" : t.groupName);
                o.put("status", t.status); o.put("done", t.done); o.put("total", t.total);
                o.put("error", t.error == null ? "" : t.error);
                arr.put(o);
            }
            prefs.edit().putString(KEY, arr.toString()).apply();
        } catch (Throwable ig) {}
    }

    private void load() {
        try {
            String raw = prefs.getString(KEY, "");
            if (raw == null || raw.isEmpty() || raw.equals("[]")) return;
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Task t = new Task();
                t.id = o.optLong("id");
                t.uri = o.optString("uri", "");
                t.name = o.optString("name", "");
                t.size = o.optLong("size");
                t.parentFileId = o.optLong("parent");
                t.rel = o.optString("rel", "");
                t.relParent = o.optString("relParent", "");
                t.groupId = o.optString("groupId", "");
                t.groupName = o.optString("groupName", "");
                t.status = o.optInt("status", ST_QUEUED);
                t.done = o.optLong("done");
                t.total = o.optLong("total");
                t.error = o.optString("error", "");
                if (t.uri.isEmpty() || t.name.isEmpty()) continue;
                if (t.status == ST_UPLOADING || t.status == ST_QUEUED) {
                    t.status = ST_FAILED;
                    t.error = "已中断（点重试可续传）";
                }
                // ST_PAUSED 原样保留：重开 App 后仍是「已暂停」，可继续
                tasks.add(t);
                if (t.id >= nextId) nextId = t.id + 1;
            }
        } catch (Throwable ig) {}
    }
}
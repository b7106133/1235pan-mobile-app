package com.pan.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 原生上传界面：**上传列表全部原生渲染**（不占用 WebView DOM，几百个任务也不卡）
 *   - 选择文件 / 选择文件夹（系统 SAF，原生界面；选完即退出）
 *   - 每行：文件名 · 状态/百分比/速度/大小 · 进度条 · [暂停/继续] [取消/重试]
 *   - 顶部：全部继续 / 全部取消 / 清除已完成
 */
public class UploadActivity extends Activity {

    private static final int REQ_FILES = 0x51;
    private static final int REQ_TREE = 0x52;
    public static final String EXTRA_DIR = "parent_dir";

    private long parentDir = 0;
    private UploadManager mgr;
    private ListView list;
    private Adapter adapter;
    private TextView summary;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try { parentDir = getIntent().getLongExtra(EXTRA_DIR, 0); } catch (Throwable ig) {}
        mgr = UploadManager.get(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(dark() ? 0xFF141A21 : 0xFFF5F7FA);

        // 标题栏
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(10), dp(12), dp(10));
        bar.setBackgroundColor(dark() ? 0xFF1A2129 : 0xFFFFFFFF);
        TextView back = new TextView(this);
        back.setText("‹");
        back.setTextSize(26);
        back.setTextColor(0xFF2B6DE8);
        back.setGravity(Gravity.CENTER);
        back.setPadding(dp(12), 0, dp(12), 0);
        back.setOnClickListener(v -> finish());
        bar.addView(back);
        TextView title = new TextView(this);
        title.setText("上传");
        title.setTextSize(17);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(dark() ? 0xFFE8EDF2 : 0xFF1F2A3A);
        bar.addView(title);
        root.addView(bar);

        // 操作行
        LinearLayout acts = new LinearLayout(this);
        acts.setOrientation(LinearLayout.HORIZONTAL);
        acts.setPadding(dp(8), dp(6), dp(8), dp(6));
        acts.addView(mkBtn("选择文件", v -> pickFiles()));
        acts.addView(mkBtn("选择文件夹", v -> pickTree()));
        acts.addView(mkBtn("全部继续", v -> { mgr.retryAllFailed(); toast("已继续"); }));
        acts.addView(mkBtn("全部取消", v -> mgr.cancelAll()));
        acts.addView(mkBtn("清除完成", v -> mgr.clearFinished()));
        root.addView(acts);

        summary = new TextView(this);
        summary.setTextSize(12);
        summary.setPadding(dp(14), 0, dp(14), dp(6));
        summary.setTextColor(dark() ? 0xFF9BAAC8 : 0xFF6B7280);
        root.addView(summary);

        list = new ListView(this);
        list.setDivider(null);
        list.setDividerHeight(0);
        adapter = new Adapter();
        list.setAdapter(adapter);
        root.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        mgr.setListener(() -> {
            try { adapter.notifyDataSetChanged(); refreshSummary(); } catch (Throwable ig) {}
        });
        refreshSummary();
    }

    @Override protected void onDestroy() {
        try { mgr.setListener(null); } catch (Throwable ig) {}
        super.onDestroy();
    }

    @Override public void onBackPressed() { finish(); }

    private void refreshSummary() {
        try {
            int a = mgr.activeCount(), q = mgr.queuedCount();
            int total = mgr.snapshot().size();
            int paused = 0, done = 0, failed = 0;
            for (UploadManager.Task t : mgr.snapshot()) {
                if (t.status == UploadManager.ST_PAUSED) paused++;
                else if (t.status == UploadManager.ST_DONE) done++;
                else if (t.status == UploadManager.ST_FAILED) failed++;
            }
            summary.setText("上传中 " + a + " · 排队 " + q + " · 已暂停 " + paused
                    + " · 完成 " + done + (failed > 0 ? (" · 失败 " + failed) : "")
                    + " · 共 " + total + " 项　→ " + (parentDir > 0 ? ("目录ID " + parentDir) : "根目录"));
        } catch (Throwable ig) {}
    }

    // ==================== SAF 选择 ====================

    private void pickFiles() {
        try {
            Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            it.addCategory(Intent.CATEGORY_OPENABLE);
            it.setType("*/*");
            it.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(it, REQ_FILES);
        } catch (Throwable e) { toast("无法打开文件选择器"); }
    }

    private void pickTree() {
        try {
            Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(it, REQ_TREE);
        } catch (Throwable e) { toast("无法打开文件夹选择器"); }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;
        if (requestCode == REQ_FILES) {
            List<Uri> uris = new ArrayList<>();
            try {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    for (int i = 0; i < n; i++) uris.add(data.getClipData().getItemAt(i).getUri());
                } else if (data.getData() != null) {
                    uris.add(data.getData());
                }
            } catch (Throwable ig) {}
            if (uris.isEmpty()) return;
            mgr.addUris(uris, parentDir);
            toast("已加入 " + uris.size() + " 个文件");
        } else if (requestCode == REQ_TREE) {
            Uri tree = data.getData();
            if (tree == null) return;
            mgr.addTree(tree, parentDir);
            toast("正在枚举文件夹并加入队列…");
        }
    }

    // ==================== 列表（原生渲染） ====================

    private class Adapter extends BaseAdapter {
        private List<UploadManager.Task> data = new ArrayList<>();

        @Override public int getCount() { data = mgr.snapshot(); return data.size(); }
        @Override public Object getItem(int i) { return data.get(i); }
        @Override public long getItemId(int i) { return i; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            final UploadManager.Task t = data.get(position);

            LinearLayout row = new LinearLayout(UploadActivity.this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(14), dp(10), dp(12), dp(10));
            row.setBackgroundColor(dark() ? 0xFF1B232C : 0xFFFFFFFF);

            LinearLayout top = new LinearLayout(UploadActivity.this);
            top.setOrientation(LinearLayout.HORIZONTAL);
            top.setGravity(Gravity.CENTER_VERTICAL);

            TextView name = new TextView(UploadActivity.this);
            name.setText(t.name);
            name.setTextSize(14);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.MIDDLE);
            name.setTextColor(dark() ? 0xFFE8EDF2 : 0xFF1F2A3A);
            top.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            // 主操作：上传中→暂停；已暂停→继续；失败/已取消→重试；排队中→取消
            if (t.status == UploadManager.ST_UPLOADING) {
                top.addView(mkSmall("暂停", v -> mgr.pause(t)));
                top.addView(mkSmall("取消", v -> mgr.cancel(t)));
            } else if (t.status == UploadManager.ST_PAUSED) {
                top.addView(mkSmall("继续", v -> mgr.resume(t)));
                top.addView(mkSmall("取消", v -> mgr.cancel(t)));
            } else if (t.status == UploadManager.ST_FAILED || t.status == UploadManager.ST_CANCELLED) {
                top.addView(mkSmall("重试", v -> mgr.retry(t)));
                top.addView(mkSmall("取消", v -> mgr.cancel(t)));
            } else if (t.status == UploadManager.ST_QUEUED) {
                top.addView(mkSmall("暂停", v -> mgr.pause(t)));
                top.addView(mkSmall("取消", v -> mgr.cancel(t)));
            }
            row.addView(top);

            TextView meta = new TextView(UploadActivity.this);
            String sz = fmtSize(t.size > 0 ? t.size : t.total);
            String st;
            if (t.status == UploadManager.ST_UPLOADING) {
                st = t.percent() + "%" + (t.speed > 0 ? (" · " + fmtSpeed(t.speed)) : "")
                        + (sz.isEmpty() ? "" : (" · " + sz));
            } else {
                st = t.statusText() + (sz.isEmpty() ? "" : (" · " + sz));
            }
            if (t.rel != null && !t.rel.isEmpty() && !t.rel.equals(t.name)) st += " · " + t.rel;
            meta.setText(st);
            meta.setTextSize(12);
            meta.setTextColor(t.status == UploadManager.ST_FAILED ? 0xFFE5484D
                    : (t.status == UploadManager.ST_PAUSED ? 0xFFF39C12
                    : (dark() ? 0xFF9BAAC8 : 0xFF6B7280)));
            meta.setPadding(0, dp(4), 0, dp(6));
            row.addView(meta);

            if (t.status == UploadManager.ST_UPLOADING || t.status == UploadManager.ST_QUEUED
                    || t.status == UploadManager.ST_PAUSED) {
                ProgressBar pb = new ProgressBar(UploadActivity.this, null,
                        android.R.attr.progressBarStyleHorizontal);
                pb.setMax(100);
                pb.setProgress(t.status == UploadManager.ST_QUEUED ? 0 : t.percent());
                row.addView(pb, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6)));
            }
            return row;
        }
    }

    // ==================== 小工具 ====================

    private Button mkBtn(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(12);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(34));
        lp.rightMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    private Button mkSmall(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(12);
        b.setPadding(dp(12), 0, dp(12), 0);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(32));
        lp.leftMargin = dp(6);
        b.setLayoutParams(lp);
        return b;
    }

    private void toast(String s) {
        try { android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show(); } catch (Throwable ig) {}
    }

    private boolean dark() {
        try {
            int m = getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return m == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Throwable e) { return false; }
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private static String fmtSize(long n) {
        if (n <= 0) return "";
        if (n < 1024) return n + " B";
        if (n < 1048576L) return String.format(java.util.Locale.US, "%.1f KB", n / 1024.0);
        if (n < 1073741824L) return String.format(java.util.Locale.US, "%.1f MB", n / 1048576.0);
        return String.format(java.util.Locale.US, "%.2f GB", n / 1073741824.0);
    }

    private static String fmtSpeed(long bps) {
        if (bps <= 0) return "";
        if (bps < 1048576L) return (bps / 1024) + " KB/s";
        return String.format(java.util.Locale.US, "%.1f MB/s", bps / 1048576.0);
    }
}
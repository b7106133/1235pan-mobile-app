package com.pan.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台保活服务：下载进行中提升进程优先级，避免挂后台被系统冻结/杀死。
 * 通知为简单常驻条（不显示进度/按钮）；全部暂停或无下载中任务时由 MainActivity
 * 发 ACTION_STOP 收回通知。
 */
public class DownloadService extends Service {
    public static final String ACTION_START = "com.pan.mobile.action.DOWNLOAD_START";
    public static final String ACTION_STOP = "com.pan.mobile.action.DOWNLOAD_STOP";
    private static final String CHANNEL_ID = "pan_download_channel";
    private static final int NOTIFICATION_ID = 3001;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            try { stopForeground(true); } catch (Throwable ig) {}
            try {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIFICATION_ID);
            } catch (Throwable ig) {}
            stopSelf();
            return START_NOT_STICKY;
        }
        startForegroundCompat();
        return START_NOT_STICKY;
    }

    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "下载任务", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("下载进行中的保活通知");
            ch.setShowBadge(false);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        Intent notifyIntent = new Intent(this, MainActivity.class);
        notifyIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, notifyIntent,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        Notification n = b
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("正在下载")
            .setContentText("123云盘正在后台下载文件")
            .setContentIntent(pi)
            .setOngoing(true)
            .build();
        startForeground(NOTIFICATION_ID, n);
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        super.onDestroy();
    }
}

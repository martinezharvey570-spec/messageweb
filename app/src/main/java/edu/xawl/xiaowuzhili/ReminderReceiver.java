package edu.xawl.xiaowuzhili;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.widget.Toast;

/**
 * 校务智理 v1.035 · 富通知与快捷操作广播接收器（支持「查看课表 / 知道了 / 1小时后再提醒」及静默模式）
 */
public class ReminderReceiver extends BroadcastReceiver {

    public static final String ACTION_SHOW_REMINDER = "edu.xawl.xiaowuzhili.ACTION_SHOW_REMINDER";
    public static final String ACTION_DISMISS = "edu.xawl.xiaowuzhili.ACTION_DISMISS_REMINDER";
    public static final String ACTION_SNOOZE_1H = "edu.xawl.xiaowuzhili.ACTION_SNOOZE_1H";

    private static final String CHANNEL_NORMAL_ID = "xiaowu_reminders_normal_v3";
    private static final String CHANNEL_SILENT_ID = "xiaowu_reminders_silent_v3";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        int notifId = intent.getIntExtra("notif_id", 3100);
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);

        if (ACTION_DISMISS.equals(action)) {
            if (nm != null) nm.cancel(notifId);
            return;
        }

        if (ACTION_SNOOZE_1H.equals(action)) {
            if (nm != null) nm.cancel(notifId);
            String title = intent.getStringExtra("title");
            String body = intent.getStringExtra("body");
            String targetPage = intent.getStringExtra("target_page");
            CampusReminderManager.scheduleSnooze1Hour(context.getApplicationContext(), title, body, targetPage);
            Toast.makeText(context, "将在 1 小时后再次提醒", Toast.LENGTH_SHORT).show();
            return;
        }

        boolean isTest = intent.getBooleanExtra("is_test", false);
        if (!isTest) {
            Context appCtx = context.getApplicationContext();
            TodayScheduleWidget.refreshAllWidgets(appCtx);
            CampusReminderManager.rescheduleFromCache(appCtx);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }

        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        String bigText = intent.getStringExtra("big_text");
        String targetPage = intent.getStringExtra("target_page");
        String kind = intent.getStringExtra("kind");
        if (title == null || title.isEmpty() || nm == null) return;

        boolean silent = ReminderPrefs.isSilentMode(context);
        String channelId = silent ? CHANNEL_SILENT_ID : CHANNEL_NORMAL_ID;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    channelId,
                    silent ? "静默课前与待办提醒" : "课前与待办提醒",
                    silent ? NotificationManager.IMPORTANCE_LOW : NotificationManager.IMPORTANCE_HIGH
            );
            ch.setDescription("校务智理课程与待办提醒通知");
            if (silent) {
                ch.enableVibration(false);
                ch.setSound(null, null);
            } else {
                ch.enableVibration(true);
            }
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ch);
        }

        Intent openIntent = new Intent(context, MainActivity.class);
        openIntent.putExtra("target_page", targetPage != null ? targetPage : "schedule");
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(
                context, notifId, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, channelId)
                : new Notification.Builder(context);

        builder.setSmallIcon(R.mipmap.ic_launcher)
                .setColor(Color.parseColor("#2563EB"))
                .setContentTitle(title)
                .setContentText(body != null ? body : "")
                .setStyle(new Notification.BigTextStyle().bigText(
                        (bigText != null && !bigText.isEmpty()) ? bigText : (body != null ? body : "")))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(contentPi);

        // 通知栏快捷操作按钮
        if ("task".equals(kind)) {
            builder.addAction(new Notification.Action.Builder(null, "去处理", contentPi).build());
            Intent snoozeIntent = new Intent(context, ReminderReceiver.class);
            snoozeIntent.setAction(ACTION_SNOOZE_1H);
            snoozeIntent.putExtra("notif_id", notifId);
            snoozeIntent.putExtra("title", title);
            snoozeIntent.putExtra("body", body);
            snoozeIntent.putExtra("target_page", "tasks");
            PendingIntent snoozePi = PendingIntent.getBroadcast(
                    context, notifId + 2000, snoozeIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(new Notification.Action.Builder(null, "1小时后再提醒", snoozePi).build());
        } else {
            builder.addAction(new Notification.Action.Builder(null, "查看课表", contentPi).build());
            Intent dismissIntent = new Intent(context, ReminderReceiver.class);
            dismissIntent.setAction(ACTION_DISMISS);
            dismissIntent.putExtra("notif_id", notifId);
            PendingIntent dismissPi = PendingIntent.getBroadcast(
                    context, notifId + 1000, dismissIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(new Notification.Action.Builder(null, "知道了", dismissPi).build());
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(silent ? Notification.PRIORITY_LOW : Notification.PRIORITY_HIGH);
            if (!silent) builder.setDefaults(Notification.DEFAULT_ALL);
        }

        try {
            nm.notify(notifId, builder.build());
        } catch (Exception ignored) {
        }
    }
}

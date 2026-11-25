package edu.xawl.xiaowuzhili;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * 校务智理 v1.035 · 可控智能原生提醒调度器
 * - 彻底移除 setAlarmClock，绝不在状态栏留下多余闹钟图标；
 * - 全部提醒受 ReminderPrefs 独立开关与提前分钟数（10/15/20/30分）控制；
 * - 支持早 07:40 课表晨报、待办截止提醒、可选实况式常驻下节课卡片与一键测试通知。
 */
public class CampusReminderManager {

    private static final int REQ_CLASS_BASE = 3100;
    private static final int MAX_CLASS_SLOTS = 6;
    private static final int REQ_DUE_TASKS = 3002;
    private static final int REQ_MORNING_DIGEST = 3003;
    private static final int REQ_SNOOZE = 3099;
    public static final int NOTIF_LIVE_CARD_ID = 3900;
    public static final int NOTIF_TEST_ID = 3999;

    private static final String CHANNEL_LIVE_ID = "xiaowu_live_next_class";

    private static class AlarmItem {
        long triggerMs;
        String title;
        String body;
        String bigText;
    }

    private static class DayCourse {
        String name;
        String room;
        String teacher;
        int startP;
        int endP;
        int startMins;
        int endMins;
        String startTxt;
        String endTxt;
    }

    public static void rescheduleFromCache(Context ctx) {
        if (ctx == null) return;
        try {
            SharedPreferences sp = ctx.getSharedPreferences(TodayScheduleWidget.PREFS_NAME, Context.MODE_PRIVATE);
            String payload = sp.getString(TodayScheduleWidget.KEY_PAYLOAD, "");
            if (payload != null && !payload.trim().isEmpty()) {
                scheduleUpcomingReminders(ctx, payload);
            } else {
                refreshLiveNextClassCard(ctx, null);
            }
        } catch (Exception ignored) {
        }
    }

    public static void scheduleUpcomingReminders(Context ctx, String payloadJson) {
        if (ctx == null || payloadJson == null || payloadJson.isEmpty()) return;
        try {
            JSONObject root = new JSONObject(payloadJson);
            JSONObject sched = root.optJSONObject("schedule");
            JSONArray tasks = root.optJSONArray("tasks");
            scheduleUpcomingClasses(ctx, sched);
            scheduleMorningDigest(ctx, sched);
            scheduleTaskDeadlineReminder(ctx, tasks);
            refreshLiveNextClassCard(ctx, sched);
        } catch (Exception ignored) {
        }
    }

    public static void scheduleSnooze1Hour(Context ctx, String title, String body, String targetPage) {
        if (ctx == null) return;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long triggerMs = System.currentTimeMillis() + 60L * 60L * 1000L;
        scheduleQuietAlarm(ctx, am, REQ_SNOOZE, triggerMs,
                title != null ? title : "校务智理延迟提醒",
                body != null ? body : "你设置的 1 小时后提醒已到",
                body != null ? body : "",
                targetPage != null ? targetPage : "tasks",
                "task");
    }

    public static boolean sendTestNotification(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        int lead = ReminderPrefs.getLeadMinutes(ctx);
        Intent i = new Intent(ctx, ReminderReceiver.class);
        i.setAction(ReminderReceiver.ACTION_SHOW_REMINDER);
        i.putExtra("title", "即将上课：面向对象程序设计（测试预览）");
        i.putExtra("body", "10:10 · 实训楼S0801（" + lead + "分钟后开课）");
        i.putExtra("big_text", "教室：实训楼S0801\n时间：10:10 - 12:00（第3-4节）\n提示：这是通知样式预览，点击下方按钮可直达课表或消除提醒。");
        i.putExtra("target_page", "schedule");
        i.putExtra("kind", "class");
        i.putExtra("notif_id", NOTIF_TEST_ID);
        i.putExtra("is_test", true);
        new ReminderReceiver().onReceive(ctx, i);
        return true;
    }

    public static void refreshLiveNextClassCard(Context ctx, JSONObject sched) {
        if (ctx == null) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (!ReminderPrefs.isLiveCardEnabled(ctx) || sched == null) {
            nm.cancel(NOTIF_LIVE_CARD_ID);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }

        List<DayCourse> todayList = collectCoursesForDayOffset(sched, 0);
        Calendar now = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        int nowMins = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);

        DayCourse focus = null;
        boolean inProgress = false;
        for (DayCourse c : todayList) {
            if (nowMins >= c.startMins && nowMins < c.endMins) {
                focus = c;
                inProgress = true;
                break;
            }
            if (c.startMins > nowMins) {
                focus = c;
                break;
            }
        }
        if (focus == null) {
            nm.cancel(NOTIF_LIVE_CARD_ID);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_LIVE_ID, "今日下节课实况卡片", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("上课日在通知栏静默显示当前或下一节课程与教室，无声音震动");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }

        String title = inProgress
                ? ("正在上课：" + focus.name)
                : ("下一节 " + focus.startTxt + " · " + focus.name);
        String sub = (focus.room.isEmpty() ? "校内教室" : focus.room)
                + " · 第" + focus.startP + "-" + focus.endP + "节"
                + (inProgress ? ("（余 " + Math.max(1, focus.endMins - nowMins) + " 分钟）")
                : ("（" + focus.startTxt + "-" + focus.endTxt + "）"));

        Intent openIntent = new Intent(ctx, MainActivity.class);
        openIntent.putExtra("target_page", "schedule");
        openIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, NOTIF_LIVE_CARD_ID, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL_LIVE_ID)
                : new Notification.Builder(ctx);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(sub)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setPriority(Notification.PRIORITY_LOW);
        }
        try {
            nm.notify(NOTIF_LIVE_CARD_ID, b.build());
        } catch (Exception ignored) {
        }
    }

    private static void scheduleUpcomingClasses(Context ctx, JSONObject sched) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        for (int s = 0; s < MAX_CLASS_SLOTS; s++) {
            cancelAlarm(ctx, am, REQ_CLASS_BASE + s);
        }
        if (!ReminderPrefs.isClassReminderEnabled(ctx) || sched == null) return;

        int leadMins = ReminderPrefs.getLeadMinutes(ctx);
        long leadMs = leadMins * 60L * 1000L;
        long nowMs = System.currentTimeMillis();
        List<AlarmItem> upcoming = new ArrayList<>();

        Calendar scan = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        for (int dayOffset = 0; dayOffset <= 3; dayOffset++) {
            List<DayCourse> dayCourses = collectCoursesForDayOffset(sched, dayOffset);
            if (dayCourses.isEmpty()) continue;
            scan.setTimeInMillis(nowMs);
            scan.add(Calendar.DAY_OF_YEAR, dayOffset);
            long dayStartMs = CalendarSyncHelper.setTimeOfDay(scan.getTimeInMillis(), 0, 0);

            for (int i = 0; i < dayCourses.size(); i++) {
                DayCourse c = dayCourses.get(i);
                int[] hmS = CalendarSyncHelper.getPeriodStartHm(c.startP);
                long classStartMs = CalendarSyncHelper.setTimeOfDay(dayStartMs, hmS[0], hmS[1]);
                long triggerMs = classStartMs - leadMs;
                if (triggerMs > nowMs + 15000L) {
                    AlarmItem item = new AlarmItem();
                    item.triggerMs = triggerMs;
                    String room = c.room.isEmpty() ? "校内教室" : c.room;
                    item.title = "即将上课：" + c.name;
                    item.body = c.startTxt + " · " + room + "（" + leadMins + "分钟后开课）";
                    StringBuilder big = new StringBuilder();
                    big.append("教室：").append(room)
                            .append("\n时间：").append(c.startTxt).append(" - ").append(c.endTxt)
                            .append("（第").append(c.startP).append("-").append(c.endP).append("节）");
                    if (!c.teacher.isEmpty()) big.append("\n任课教师：").append(c.teacher);
                    big.append("\n今日共 ").append(dayCourses.size()).append(" 节课程，请提前前往教室。");
                    item.bigText = big.toString();
                    upcoming.add(item);
                }
            }
        }

        Collections.sort(upcoming, (a, b) -> Long.compare(a.triggerMs, b.triggerMs));
        int count = Math.min(MAX_CLASS_SLOTS, upcoming.size());
        for (int i = 0; i < count; i++) {
            AlarmItem item = upcoming.get(i);
            scheduleQuietAlarm(ctx, am, REQ_CLASS_BASE + i, item.triggerMs,
                    item.title, item.body, item.bigText, "schedule", "class");
        }
    }

    private static void scheduleMorningDigest(Context ctx, JSONObject sched) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        cancelAlarm(ctx, am, REQ_MORNING_DIGEST);
        if (!ReminderPrefs.isMorningDigestEnabled(ctx) || sched == null) return;

        long nowMs = System.currentTimeMillis();
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        long today740 = CalendarSyncHelper.setTimeOfDay(nowMs, 7, 40);
        int offset = (today740 > nowMs + 60000L) ? 0 : 1;
        cal.setTimeInMillis(nowMs);
        cal.add(Calendar.DAY_OF_YEAR, offset);
        long triggerMs = CalendarSyncHelper.setTimeOfDay(cal.getTimeInMillis(), 7, 40);

        List<DayCourse> list = collectCoursesForDayOffset(sched, offset);
        if (list.isEmpty()) return;

        DayCourse first = list.get(0);
        String title = "早安 · 今日共有 " + list.size() + " 门课程";
        String body = "首节 " + first.startTxt + " " + first.name + "（" + (first.room.isEmpty() ? "校内教室" : first.room) + "）";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            DayCourse c = list.get(i);
            if (i > 0) sb.append("\n");
            sb.append(c.startTxt).append(" ").append(c.name)
                    .append(" · ").append(c.room.isEmpty() ? "校内教室" : c.room);
        }
        scheduleQuietAlarm(ctx, am, REQ_MORNING_DIGEST, triggerMs, title, body, sb.toString(), "schedule", "class");
    }

    private static void scheduleTaskDeadlineReminder(Context ctx, JSONArray tasks) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        cancelAlarm(ctx, am, REQ_DUE_TASKS);
        if (!ReminderPrefs.isTaskReminderEnabled(ctx) || tasks == null || tasks.length() == 0) return;

        long nowMs = System.currentTimeMillis();
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        cal.setTimeInMillis(nowMs);
        String todayStr = String.format(Locale.CHINA, "%04d-%02d-%02d",
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH));

        Calendar tomorrow = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        tomorrow.setTimeInMillis(nowMs);
        tomorrow.add(Calendar.DAY_OF_YEAR, 1);
        String tomorrowStr = String.format(Locale.CHINA, "%04d-%02d-%02d",
                tomorrow.get(Calendar.YEAR), tomorrow.get(Calendar.MONTH) + 1, tomorrow.get(Calendar.DAY_OF_MONTH));

        int todayDue = 0;
        String todayFirst = "";
        int tomorrowDue = 0;
        String tomorrowFirst = "";
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject t = tasks.optJSONObject(i);
            if (t == null || "completed".equalsIgnoreCase(t.optString("status", ""))) continue;
            String due = t.optString("due_date", "").trim();
            if (due.startsWith(todayStr)) {
                todayDue++;
                if (todayFirst.isEmpty()) todayFirst = t.optString("title", "").trim();
            } else if (due.startsWith(tomorrowStr)) {
                tomorrowDue++;
                if (tomorrowFirst.isEmpty()) tomorrowFirst = t.optString("title", "").trim();
            }
        }

        long todayMorningMs = CalendarSyncHelper.setTimeOfDay(nowMs, 8, 30);
        if (todayDue > 0 && todayMorningMs > nowMs + 30000L) {
            String title = "今日有 " + todayDue + " 项校园待办到期";
            String body = todayFirst.isEmpty() ? "请及时打开校务智理确认进度" : ("优先事项：" + todayFirst);
            scheduleQuietAlarm(ctx, am, REQ_DUE_TASKS, todayMorningMs, title, body, body, "tasks", "task");
            return;
        }
        if (tomorrowDue > 0) {
            long tomorrowMorningMs = CalendarSyncHelper.setTimeOfDay(tomorrow.getTimeInMillis(), 8, 30);
            if (tomorrowMorningMs > nowMs + 60000L) {
                String title = "今日有 " + tomorrowDue + " 项校园待办即将截止";
                String body = tomorrowFirst.isEmpty() ? "请及时打开校务智理查看办理进度" : ("优先事项：" + tomorrowFirst);
                scheduleQuietAlarm(ctx, am, REQ_DUE_TASKS, tomorrowMorningMs, title, body, body, "tasks", "task");
            }
        }
    }

    private static List<DayCourse> collectCoursesForDayOffset(JSONObject sched, int dayOffset) {
        List<DayCourse> list = new ArrayList<>();
        if (sched == null) return list;
        JSONArray courses = sched.optJSONArray("courses");
        if (courses == null || courses.length() == 0) return list;

        String startDate = sched.optString("startDate", sched.optString("start_date", "2026-08-31"));
        int totalWeeks = Math.max(1, Math.min(30, sched.optInt("totalWeeks", sched.optInt("total_weeks", 18))));
        long baseMondayMs = CalendarSyncHelper.parseDateStartMs(startDate);
        if (baseMondayMs <= 0L) return list;

        Calendar scan = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        scan.add(Calendar.DAY_OF_YEAR, dayOffset);
        long dayStartMs = CalendarSyncHelper.setTimeOfDay(scan.getTimeInMillis(), 0, 0);
        long diffDays = (dayStartMs - baseMondayMs) / 86400000L;
        if (diffDays < 0L) return list;
        int week = (int) (diffDays / 7L) + 1;
        if (week < 1 || week > totalWeeks) return list;
        int dowSun1 = scan.get(Calendar.DAY_OF_WEEK);
        int dowMon1 = (dowSun1 == Calendar.SUNDAY) ? 7 : (dowSun1 - 1);

        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.optJSONObject(i);
            if (c == null || c.optInt("day", 1) != dowMon1) continue;
            Set<Integer> wks = CalendarSyncHelper.parseWeeks(c.optString("weeks", "1-" + totalWeeks), totalWeeks);
            if (!wks.contains(week)) continue;
            int sP = Math.max(1, Math.min(10, c.optInt("start", 1)));
            int eP = Math.max(sP, Math.min(10, c.optInt("end", sP)));
            int[] hmS = CalendarSyncHelper.getPeriodStartHm(sP);
            int[] hmE = CalendarSyncHelper.getPeriodEndHm(eP);
            DayCourse dc = new DayCourse();
            dc.name = c.optString("name", "课程").trim();
            dc.room = c.optString("room", "校内教室").trim();
            dc.teacher = c.optString("teacher", "").trim();
            dc.startP = sP;
            dc.endP = eP;
            dc.startMins = hmS[0] * 60 + hmS[1];
            dc.endMins = hmE[0] * 60 + hmE[1];
            dc.startTxt = String.format(Locale.CHINA, "%02d:%02d", hmS[0], hmS[1]);
            dc.endTxt = String.format(Locale.CHINA, "%02d:%02d", hmE[0], hmE[1]);
            list.add(dc);
        }
        Collections.sort(list, (a, b) -> Integer.compare(a.startP, b.startP));
        return list;
    }

    /** 不使用 setAlarmClock，绝不在系统状态栏挂闹钟图标 */
    private static void scheduleQuietAlarm(Context ctx, AlarmManager am, int reqCode, long triggerMs,
                                           String title, String body, String bigText, String targetPage, String kind) {
        try {
            Intent intent = new Intent(ctx, ReminderReceiver.class);
            intent.setAction(ReminderReceiver.ACTION_SHOW_REMINDER);
            intent.putExtra("title", title);
            intent.putExtra("body", body);
            intent.putExtra("big_text", bigText);
            intent.putExtra("target_page", targetPage);
            intent.putExtra("kind", kind);
            intent.putExtra("notif_id", reqCode);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, reqCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
                }
            } else {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
            }
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(ctx, ReminderReceiver.class);
                fallback.setAction(ReminderReceiver.ACTION_SHOW_REMINDER);
                fallback.putExtra("title", title);
                fallback.putExtra("body", body);
                fallback.putExtra("big_text", bigText);
                fallback.putExtra("target_page", targetPage);
                fallback.putExtra("kind", kind);
                fallback.putExtra("notif_id", reqCode);
                PendingIntent pi = PendingIntent.getBroadcast(
                        ctx, reqCode, fallback,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
            } catch (Exception ignored) {
            }
        }
    }

    private static void cancelAlarm(Context ctx, AlarmManager am, int reqCode) {
        try {
            Intent intent = new Intent(ctx, ReminderReceiver.class);
            intent.setAction(ReminderReceiver.ACTION_SHOW_REMINDER);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, reqCode, intent,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
            );
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        } catch (Exception ignored) {
        }
    }
}

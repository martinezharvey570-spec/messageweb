package edu.xawl.xiaowuzhili;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;

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
 * 校务智理 v1.036 · 3 款液态玻璃 4x2 桌面小组件引擎
 * - 款式 A（默认 glacier）：冰川透光液态玻璃卡
 * - 款式 B（aurora）：晴空极光蓝靛玻璃卡
 * - 款式 C（pearl）：珍珠悬浮胶囊卡（复刻网页首页风格）
 */
public class TodayScheduleWidget extends AppWidgetProvider {

    public static final String PREFS_NAME = "xiaowu_widget_prefs";
    public static final String KEY_PAYLOAD = "sync_payload_json";

    private static final String[] WEEKDAY_CN = new String[]{"周一", "周二", "周三", "周四", "周五", "周六", "周日"};

    private static class CourseRow {
        String name;
        String room;
        int startP;
        int endP;
        int startMins;
        int endMins;
        String startTxt;
        String endTxt;
    }

    public static void savePayloadAndRefresh(Context ctx, String payloadJson) {
        if (ctx == null || payloadJson == null || payloadJson.isEmpty()) return;
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            sp.edit().putString(KEY_PAYLOAD, payloadJson).apply();
            refreshAllWidgets(ctx);
        } catch (Exception ignored) {
        }
    }

    public static void refreshAllWidgets(Context ctx) {
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TodayScheduleWidget.class));
            if (ids != null && ids.length > 0) {
                for (int id : ids) {
                    updateSingleWidget(ctx, mgr, id);
                }
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        if (appWidgetIds == null) return;
        for (int id : appWidgetIds) {
            updateSingleWidget(context, appWidgetManager, id);
        }
    }

    private static void updateSingleWidget(Context ctx, AppWidgetManager mgr, int widgetId) {
        String skin = ReminderPrefs.getWidgetSkin(ctx);
        int layoutId = R.layout.widget_today_schedule; // 款式 A（默认）：冰川透光
        if (ReminderPrefs.SKIN_AURORA.equals(skin)) {
            layoutId = R.layout.widget_today_schedule_aurora; // 款式 B：晴空极光
        } else if (ReminderPrefs.SKIN_PEARL.equals(skin)) {
            layoutId = R.layout.widget_today_schedule_pearl; // 款式 C：珍珠悬浮胶囊
        }
        boolean isPearl = ReminderPrefs.SKIN_PEARL.equals(skin);
        RemoteViews views = new RemoteViews(ctx.getPackageName(), layoutId);

        views.setOnClickPendingIntent(R.id.widgetRoot, createJumpIntent(ctx, "schedule", 101));
        views.setOnClickPendingIntent(R.id.widgetDateHeader, createJumpIntent(ctx, "schedule", 102));
        views.setOnClickPendingIntent(R.id.widgetAiBtn, createJumpIntent(ctx, "ai", 103));
        views.setOnClickPendingIntent(R.id.widgetTaskBadge, createJumpIntent(ctx, "tasks", 104));

        Calendar now = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"));
        int dowSun1 = now.get(Calendar.DAY_OF_WEEK);
        int dowMon1 = (dowSun1 == Calendar.SUNDAY) ? 7 : (dowSun1 - 1);
        int month = now.get(Calendar.MONTH) + 1;
        int dayOfMonth = now.get(Calendar.DAY_OF_MONTH);
        int nowMins = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        String dateBase = month + "月" + dayOfMonth + "日 " + WEEKDAY_CN[dowMon1 - 1];

        String raw = "";
        try {
            raw = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(KEY_PAYLOAD, "");
        } catch (Exception ignored) {
        }

        if (raw == null || raw.trim().isEmpty()) {
            views.setTextViewText(R.id.widgetDateHeader, dateBase);
            views.setTextViewText(R.id.widgetWeekPill, "校务智理");
            views.setViewVisibility(R.id.widgetRow1, View.GONE);
            views.setViewVisibility(R.id.widgetRow2, View.GONE);
            views.setViewVisibility(R.id.widgetEmptyBox, View.VISIBLE);
            views.setTextViewText(R.id.widgetEmptyTitle, "打开校务智理同步课表");
            views.setTextViewText(R.id.widgetEmptySub, "登录后将自动显示今日课程与教室 ✨");
            views.setTextViewText(R.id.widgetTaskBadge, "待办：等待同步");
            mgr.updateAppWidget(widgetId, views);
            return;
        }

        try {
            JSONObject root = new JSONObject(raw);
            JSONObject sched = root.optJSONObject("schedule");
            JSONArray tasks = root.optJSONArray("tasks");

            int pendingTasks = 0;
            String firstPendingTitle = "";
            if (tasks != null) {
                for (int i = 0; i < tasks.length(); i++) {
                    JSONObject t = tasks.optJSONObject(i);
                    if (t != null && !"completed".equalsIgnoreCase(t.optString("status", ""))) {
                        pendingTasks++;
                        if (firstPendingTitle.isEmpty()) firstPendingTitle = t.optString("title", "").trim();
                    }
                }
            }

            int curWeek = 1;
            int totalWeeks = 18;
            List<CourseRow> todayCourses = new ArrayList<>();
            if (sched != null) {
                String startDate = sched.optString("startDate", sched.optString("start_date", "2026-08-31"));
                totalWeeks = Math.max(1, Math.min(30, sched.optInt("totalWeeks", sched.optInt("total_weeks", 18))));
                long baseMs = CalendarSyncHelper.parseDateStartMs(startDate);
                if (baseMs > 0L) {
                    long todayStartMs = CalendarSyncHelper.setTimeOfDay(now.getTimeInMillis(), 0, 0);
                    long diffDays = (todayStartMs - baseMs) / 86400000L;
                    curWeek = (int) (diffDays / 7L) + 1;
                }
                JSONArray courses = sched.optJSONArray("courses");
                if (courses != null && curWeek >= 1 && curWeek <= totalWeeks) {
                    for (int i = 0; i < courses.length(); i++) {
                        JSONObject c = courses.optJSONObject(i);
                        if (c == null || c.optInt("day", 1) != dowMon1) continue;
                        Set<Integer> wks = CalendarSyncHelper.parseWeeks(c.optString("weeks", "1-" + totalWeeks), totalWeeks);
                        if (!wks.contains(curWeek)) continue;
                        int sP = Math.max(1, Math.min(10, c.optInt("start", 1)));
                        int eP = Math.max(sP, Math.min(10, c.optInt("end", sP)));
                        int[] hmS = CalendarSyncHelper.getPeriodStartHm(sP);
                        int[] hmE = CalendarSyncHelper.getPeriodEndHm(eP);
                        CourseRow row = new CourseRow();
                        row.name = c.optString("name", "未命名课程").trim();
                        row.room = c.optString("room", "校内教室").trim();
                        row.startP = sP;
                        row.endP = eP;
                        row.startMins = hmS[0] * 60 + hmS[1];
                        row.endMins = hmE[0] * 60 + hmE[1];
                        row.startTxt = String.format(Locale.CHINA, "%02d:%02d", hmS[0], hmS[1]);
                        row.endTxt = String.format(Locale.CHINA, "%02d:%02d", hmE[0], hmE[1]);
                        todayCourses.add(row);
                    }
                }
            }
            Collections.sort(todayCourses, (a, b) -> Integer.compare(a.startP, b.startP));

            List<CourseRow> remaining = new ArrayList<>();
            for (CourseRow r : todayCourses) {
                if (r.endMins > nowMins) remaining.add(r);
            }

            views.setTextViewText(R.id.widgetDateHeader, dateBase);
            views.setTextViewText(R.id.widgetWeekPill,
                    (curWeek >= 1 && curWeek <= totalWeeks) ? ("第" + curWeek + "周") : "校务智理");

            if (remaining.isEmpty()) {
                views.setViewVisibility(R.id.widgetRow1, View.GONE);
                views.setViewVisibility(R.id.widgetRow2, View.GONE);
                views.setViewVisibility(R.id.widgetEmptyBox, View.VISIBLE);
                if (todayCourses.isEmpty()) {
                    views.setTextViewText(R.id.widgetEmptyTitle, "今日无课");
                    views.setTextViewText(R.id.widgetEmptySub, "适合自习、阅读或适当运动 ✨");
                } else {
                    views.setTextViewText(R.id.widgetEmptyTitle, "今日课程已全部结束");
                    views.setTextViewText(R.id.widgetEmptySub, "共完成 " + todayCourses.size() + " 门课程，好好休息 🎉");
                }
            } else {
                views.setViewVisibility(R.id.widgetEmptyBox, View.GONE);
                CourseRow c1 = remaining.get(0);
                views.setViewVisibility(R.id.widgetRow1, View.VISIBLE);

                if (isPearl) {
                    boolean inNow = nowMins >= c1.startMins && nowMins < c1.endMins;
                    views.setTextViewText(R.id.widgetHeroTitle, (inNow ? "正在上课：" : "下一节：") + c1.name);
                    views.setTextViewText(R.id.widgetHeroSub,
                            (c1.room.isEmpty() ? "校内教室" : c1.room) + " · " + c1.startTxt + "-" + c1.endTxt);
                    views.setTextViewText(R.id.widgetHeroBadge, formatPearlBadge(c1, nowMins));

                    if (remaining.size() >= 2) {
                        CourseRow c2 = remaining.get(1);
                        views.setViewVisibility(R.id.widgetRow2, View.VISIBLE);
                        views.setTextViewText(R.id.widgetNextTitle, "下节 " + c2.startTxt + " · " + c2.name);
                        views.setTextViewText(R.id.widgetNextRoom, c2.room.isEmpty() ? "校内教室" : c2.room);
                    } else {
                        views.setViewVisibility(R.id.widgetRow2, View.GONE);
                    }
                } else {
                    views.setTextViewText(R.id.widgetC1Start, c1.startTxt);
                    views.setTextViewText(R.id.widgetC1End, c1.endTxt);
                    views.setTextViewText(R.id.widgetC1Name, c1.name);
                    views.setTextViewText(R.id.widgetC1Room, c1.room.isEmpty() ? "校内教室" : c1.room);
                    views.setTextViewText(R.id.widgetC1Sub, formatCourseStatus(c1, nowMins));

                    if (remaining.size() >= 2) {
                        CourseRow c2 = remaining.get(1);
                        views.setViewVisibility(R.id.widgetRow2, View.VISIBLE);
                        views.setTextViewText(R.id.widgetC2Start, c2.startTxt);
                        views.setTextViewText(R.id.widgetC2End, c2.endTxt);
                        views.setTextViewText(R.id.widgetC2Name, c2.name);
                        views.setTextViewText(R.id.widgetC2Room, c2.room.isEmpty() ? "校内教室" : c2.room);
                        views.setTextViewText(R.id.widgetC2Sub, formatCourseStatus(c2, nowMins));
                    } else {
                        views.setViewVisibility(R.id.widgetRow2, View.GONE);
                    }
                }
            }

            if (pendingTasks > 0) {
                String tail = firstPendingTitle.isEmpty() ? "" : (" · " + firstPendingTitle);
                views.setTextViewText(R.id.widgetTaskBadge, "✓ " + pendingTasks + " 项待办" + tail);
            } else {
                views.setTextViewText(R.id.widgetTaskBadge, "✓ 待办已清空");
            }
        } catch (Exception ignored) {
        }

        mgr.updateAppWidget(widgetId, views);
    }

    private static String formatCourseStatus(CourseRow c, int nowMins) {
        String base = "第" + c.startP + "-" + c.endP + "节";
        if (nowMins >= c.startMins && nowMins < c.endMins) {
            return base + " · 正在上课（余" + Math.max(1, c.endMins - nowMins) + "分）";
        }
        int diff = c.startMins - nowMins;
        if (diff > 0 && diff <= 180) {
            String w = diff >= 60
                    ? ((diff / 60) + "小时" + (diff % 60 > 0 ? (diff % 60) + "分" : ""))
                    : (diff + "分钟");
            return base + " · " + w + "后开课";
        }
        return base;
    }

    private static String formatPearlBadge(CourseRow c, int nowMins) {
        if (nowMins >= c.startMins && nowMins < c.endMins) {
            return "余 " + Math.max(1, c.endMins - nowMins) + " 分";
        }
        int diff = c.startMins - nowMins;
        if (diff > 0 && diff < 60) return diff + "分后";
        if (diff >= 60 && diff <= 240) return (diff / 60) + "小时后";
        return c.startTxt;
    }

    private static PendingIntent createJumpIntent(Context ctx, String targetPage, int reqCode) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setAction("edu.xawl.xiaowuzhili.WIDGET_" + targetPage.toUpperCase(Locale.US));
        intent.putExtra("target_page", targetPage);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
                ctx,
                reqCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}

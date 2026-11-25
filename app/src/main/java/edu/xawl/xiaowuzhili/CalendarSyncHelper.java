package edu.xawl.xiaowuzhili;

import android.content.ContentProviderOperation;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.provider.CalendarContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TimeZone;

/**
 * 校务智理 v1.035 · 原生系统日历直写与一键清理引擎
 */
public class CalendarSyncHelper {

    public static final String SYNC_TAG = "[校务智理同步]";
    private static final String LOCAL_ACCOUNT_NAME = "校务智理课表";
    private static final String TZ_SHANGHAI = "Asia/Shanghai";

    private static final int[][] PERIOD_START_HM = new int[][]{
            {8, 0}, {8, 55}, {10, 10}, {11, 5}, {14, 0},
            {14, 55}, {16, 10}, {17, 5}, {19, 0}, {19, 55}
    };
    private static final int[][] PERIOD_END_HM = new int[][]{
            {8, 50}, {9, 50}, {11, 0}, {12, 0}, {14, 50},
            {15, 50}, {17, 0}, {18, 0}, {19, 50}, {20, 50}
    };

    public static class ImportResult {
        public final boolean ok;
        public final int count;
        public final String calendarName;
        public final String error;

        public ImportResult(boolean ok, int count, String calendarName, String error) {
            this.ok = ok;
            this.count = count;
            this.calendarName = calendarName;
            this.error = error;
        }
    }

    private static class CalEvent {
        String title;
        String location;
        String description;
        long startMs;
        long endMs;
        int reminderMinutes = 15;
    }

    private static class TargetCalendar {
        final long id;
        final String name;

        TargetCalendar(long id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    public static ImportResult importFromIcsBytes(Context ctx, byte[] icsBytes) {
        if (icsBytes == null || icsBytes.length == 0) {
            return new ImportResult(false, 0, "", "日历文件内容为空");
        }
        String text = new String(icsBytes, StandardCharsets.UTF_8);
        List<CalEvent> events = parseIcsEvents(text);
        if (events.isEmpty()) {
            return new ImportResult(false, 0, "", "未解析到有效课程日程");
        }
        return writeEventsToSystemCalendar(ctx, events);
    }

    public static ImportResult importFromScheduleJson(Context ctx, String scheduleJson) {
        try {
            JSONObject root = new JSONObject(scheduleJson);
            if (root.has("schedule") && root.optJSONObject("schedule") != null) {
                root = root.optJSONObject("schedule");
            }
            String startDate = root.optString("startDate", root.optString("start_date", "2026-08-31"));
            int totalWeeks = Math.max(1, Math.min(30, root.optInt("totalWeeks", root.optInt("total_weeks", 18))));
            JSONArray courses = root.optJSONArray("courses");
            if (courses == null || courses.length() == 0) {
                return new ImportResult(false, 0, "", "当前课表暂无课程，请先在网页端添加或导入课表");
            }
            long baseMondayMs = parseDateStartMs(startDate);
            if (baseMondayMs <= 0L) {
                return new ImportResult(false, 0, "", "开学日期格式无效");
            }

            int leadMins = ReminderPrefs.getLeadMinutes(ctx);
            List<CalEvent> events = new ArrayList<>();
            for (int i = 0; i < courses.length(); i++) {
                JSONObject c = courses.optJSONObject(i);
                if (c == null) continue;
                String name = c.optString("name", "课程").trim();
                String room = c.optString("room", "校内教室").trim();
                String teacher = c.optString("teacher", "未填").trim();
                int day = Math.min(7, Math.max(1, c.optInt("day", 1)));
                int sP = Math.min(10, Math.max(1, c.optInt("start", 1)));
                int eP = Math.min(10, Math.max(sP, c.optInt("end", sP)));
                String weeksStr = c.optString("weeks", "1-" + totalWeeks);
                Set<Integer> weeks = parseWeeks(weeksStr, totalWeeks);

                int[] hmS = PERIOD_START_HM[sP - 1];
                int[] hmE = PERIOD_END_HM[eP - 1];
                for (int w : weeks) {
                    long dayStart = addDays(baseMondayMs, (w - 1) * 7 + (day - 1));
                    CalEvent ev = new CalEvent();
                    ev.title = name.isEmpty() ? "课程" : name;
                    ev.location = room.isEmpty() ? "校内教室" : room;
                    ev.description = "教师：" + (teacher.isEmpty() ? "未填" : teacher)
                            + "｜第" + w + "周 第" + sP + "-" + eP + "节";
                    ev.startMs = setTimeOfDay(dayStart, hmS[0], hmS[1]);
                    ev.endMs = setTimeOfDay(dayStart, hmE[0], hmE[1]);
                    ev.reminderMinutes = leadMins;
                    events.add(ev);
                }
            }
            if (events.isEmpty()) {
                return new ImportResult(false, 0, "", "未生成任何课程日程");
            }
            return writeEventsToSystemCalendar(ctx, events);
        } catch (Exception e) {
            return new ImportResult(false, 0, "", "课表解析失败：" + e.getMessage());
        }
    }

    /** 一键清除所有由校务智理同步至系统日历的日程 */
    public static ImportResult clearSyncedCalendarEvents(Context ctx) {
        try {
            ContentResolver resolver = ctx.getContentResolver();
            int deleted = resolver.delete(
                    CalendarContract.Events.CONTENT_URI,
                    CalendarContract.Events.DESCRIPTION + " LIKE ?",
                    new String[]{"%" + SYNC_TAG + "%"}
            );
            return new ImportResult(true, Math.max(0, deleted), "系统日历", null);
        } catch (SecurityException se) {
            return new ImportResult(false, 0, "", "缺少系统日历权限");
        } catch (Exception e) {
            return new ImportResult(false, 0, "", "清理日历失败：" + e.getMessage());
        }
    }

    private static ImportResult writeEventsToSystemCalendar(Context ctx, List<CalEvent> events) {
        try {
            TargetCalendar target = findOrCreateWritableCalendar(ctx);
            if (target == null) {
                return new ImportResult(false, 0, "", "未找到可写入的系统日历账户");
            }

            ContentResolver resolver = ctx.getContentResolver();
            try {
                resolver.delete(
                        CalendarContract.Events.CONTENT_URI,
                        CalendarContract.Events.CALENDAR_ID + "=? AND " + CalendarContract.Events.DESCRIPTION + " LIKE ?",
                        new String[]{String.valueOf(target.id), "%" + SYNC_TAG + "%"}
                );
            } catch (Exception ignored) {
            }

            int inserted = 0;
            final int chunkSize = 60;
            for (int start = 0; start < events.size(); start += chunkSize) {
                int end = Math.min(events.size(), start + chunkSize);
                ArrayList<ContentProviderOperation> ops = new ArrayList<>((end - start) * 2);
                for (int i = start; i < end; i++) {
                    CalEvent ev = events.get(i);
                    int eventOpIdx = ops.size();
                    String desc = (ev.description != null ? ev.description.trim() : "");
                    if (!desc.contains(SYNC_TAG)) {
                        desc = desc.isEmpty() ? SYNC_TAG : (desc + "\n" + SYNC_TAG);
                    }
                    ops.add(ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI)
                            .withValue(CalendarContract.Events.CALENDAR_ID, target.id)
                            .withValue(CalendarContract.Events.TITLE, ev.title)
                            .withValue(CalendarContract.Events.EVENT_LOCATION, ev.location != null ? ev.location : "")
                            .withValue(CalendarContract.Events.DESCRIPTION, desc)
                            .withValue(CalendarContract.Events.DTSTART, ev.startMs)
                            .withValue(CalendarContract.Events.DTEND, Math.max(ev.endMs, ev.startMs + 60000L))
                            .withValue(CalendarContract.Events.EVENT_TIMEZONE, TZ_SHANGHAI)
                            .withValue(CalendarContract.Events.HAS_ALARM, ev.reminderMinutes > 0 ? 1 : 0)
                            .build());

                    if (ev.reminderMinutes > 0) {
                        ops.add(ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI)
                                .withValueBackReference(CalendarContract.Reminders.EVENT_ID, eventOpIdx)
                                .withValue(CalendarContract.Reminders.MINUTES, ev.reminderMinutes)
                                .withValue(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                                .build());
                    }
                }
                resolver.applyBatch(CalendarContract.AUTHORITY, ops);
                inserted += (end - start);
            }

            return new ImportResult(true, inserted, target.name, null);
        } catch (SecurityException se) {
            return new ImportResult(false, 0, "", "缺少系统日历写入权限");
        } catch (Exception e) {
            return new ImportResult(false, 0, "", "写入日历失败：" + e.getMessage());
        }
    }

    private static TargetCalendar findOrCreateWritableCalendar(Context ctx) {
        ContentResolver resolver = ctx.getContentResolver();
        String[] projection = new String[]{
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.IS_PRIMARY,
                CalendarContract.Calendars.VISIBLE
        };

        long bestId = -1L;
        String bestName = "手机日历";
        int bestScore = -1;

        try (Cursor cursor = resolver.query(
                CalendarContract.Calendars.CONTENT_URI,
                projection,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + ">=" + CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR,
                null,
                null
        )) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    long id = cursor.getLong(0);
                    String name = cursor.getString(1);
                    int access = cursor.getInt(2);
                    int primary = cursor.getInt(3);
                    int visible = cursor.getInt(4);

                    int score = 0;
                    if (visible == 1) score += 20;
                    if (primary == 1) score += 30;
                    if (access >= CalendarContract.Calendars.CAL_ACCESS_OWNER) score += 25;
                    if (name != null && name.contains("校务智理")) score += 40;

                    if (score > bestScore) {
                        bestScore = score;
                        bestId = id;
                        bestName = (name != null && !name.trim().isEmpty()) ? name.trim() : "手机日历";
                    }
                }
            }
        } catch (Exception ignored) {
        }

        if (bestId != -1L) {
            return new TargetCalendar(bestId, bestName);
        }

        try {
            Uri calUri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
                    .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
                    .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, LOCAL_ACCOUNT_NAME)
                    .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
                    .build();
            ContentValues cv = new ContentValues();
            cv.put(CalendarContract.Calendars.ACCOUNT_NAME, LOCAL_ACCOUNT_NAME);
            cv.put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL);
            cv.put(CalendarContract.Calendars.NAME, LOCAL_ACCOUNT_NAME);
            cv.put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, LOCAL_ACCOUNT_NAME);
            cv.put(CalendarContract.Calendars.CALENDAR_COLOR, Color.parseColor("#2563EB"));
            cv.put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER);
            cv.put(CalendarContract.Calendars.OWNER_ACCOUNT, LOCAL_ACCOUNT_NAME);
            cv.put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, TZ_SHANGHAI);
            cv.put(CalendarContract.Calendars.VISIBLE, 1);
            cv.put(CalendarContract.Calendars.SYNC_EVENTS, 1);
            Uri inserted = resolver.insert(calUri, cv);
            if (inserted != null) {
                long id = Long.parseLong(inserted.getLastPathSegment());
                return new TargetCalendar(id, LOCAL_ACCOUNT_NAME);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    public static boolean openSystemCalendar(Context ctx) {
        try {
            Uri uri = CalendarContract.CONTENT_URI.buildUpon()
                    .appendPath("time")
                    .appendPath(String.valueOf(System.currentTimeMillis()))
                    .build();
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            return true;
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Intent.ACTION_MAIN);
                fallback.addCategory(Intent.CATEGORY_APP_CALENDAR);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(fallback);
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    private static List<CalEvent> parseIcsEvents(String raw) {
        List<CalEvent> list = new ArrayList<>();
        if (raw == null || raw.isEmpty()) return list;
        String unfolded = raw.replace("\r\n ", "").replace("\r\n\t", "").replace("\n ", "").replace("\n\t", "");
        String[] lines = unfolded.split("\\r?\\n");

        boolean inEvent = false;
        boolean inAlarm = false;
        CalEvent cur = null;

        for (String line : lines) {
            if (line == null) continue;
            String trimmed = line.trim();
            if (trimmed.equalsIgnoreCase("BEGIN:VEVENT")) {
                inEvent = true;
                inAlarm = false;
                cur = new CalEvent();
                continue;
            }
            if (trimmed.equalsIgnoreCase("END:VEVENT")) {
                if (inEvent && cur != null && cur.startMs > 0L && cur.title != null && !cur.title.isEmpty()) {
                    if (cur.endMs <= cur.startMs) cur.endMs = cur.startMs + 50 * 60000L;
                    list.add(cur);
                }
                inEvent = false;
                inAlarm = false;
                cur = null;
                continue;
            }
            if (!inEvent || cur == null) continue;

            if (trimmed.equalsIgnoreCase("BEGIN:VALARM")) { inAlarm = true; continue; }
            if (trimmed.equalsIgnoreCase("END:VALARM")) { inAlarm = false; continue; }

            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String keyPart = line.substring(0, colon).trim().toUpperCase();
            String valPart = line.substring(colon + 1).trim();

            if (inAlarm) {
                if (keyPart.startsWith("TRIGGER")) {
                    int mins = parseTriggerMinutes(valPart);
                    if (mins > 0) cur.reminderMinutes = mins;
                }
                continue;
            }

            if (keyPart.startsWith("SUMMARY")) cur.title = unescapeIcs(valPart);
            else if (keyPart.startsWith("LOCATION")) cur.location = unescapeIcs(valPart);
            else if (keyPart.startsWith("DESCRIPTION")) cur.description = unescapeIcs(valPart);
            else if (keyPart.startsWith("DTSTART")) cur.startMs = parseIcsDateTime(valPart);
            else if (keyPart.startsWith("DTEND")) cur.endMs = parseIcsDateTime(valPart);
        }
        return list;
    }

    private static int parseTriggerMinutes(String trigger) {
        if (trigger == null) return 15;
        String s = trigger.toUpperCase();
        try {
            int mIdx = s.indexOf('M');
            int tIdx = s.indexOf('T');
            if (tIdx != -1 && mIdx > tIdx) return Integer.parseInt(s.substring(tIdx + 1, mIdx));
            int hIdx = s.indexOf('H');
            if (tIdx != -1 && hIdx > tIdx) return Integer.parseInt(s.substring(tIdx + 1, hIdx)) * 60;
        } catch (Exception ignored) {
        }
        return 15;
    }

    private static long parseIcsDateTime(String s) {
        if (s == null || s.length() < 8) return 0L;
        try {
            boolean isUtc = s.endsWith("Z");
            String clean = s.replace("Z", "");
            int y = Integer.parseInt(clean.substring(0, 4));
            int m = Integer.parseInt(clean.substring(4, 6));
            int d = Integer.parseInt(clean.substring(6, 8));
            int hh = 8, mm = 0, ss = 0;
            if (clean.length() >= 15 && clean.charAt(8) == 'T') {
                hh = Integer.parseInt(clean.substring(9, 11));
                mm = Integer.parseInt(clean.substring(11, 13));
                ss = Integer.parseInt(clean.substring(13, 15));
            }
            Calendar cal = Calendar.getInstance(isUtc ? TimeZone.getTimeZone("UTC") : TimeZone.getTimeZone(TZ_SHANGHAI));
            cal.set(y, m - 1, d, hh, mm, ss);
            cal.set(Calendar.MILLISECOND, 0);
            return cal.getTimeInMillis();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String unescapeIcs(String s) {
        if (s == null) return "";
        return s.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\");
    }

    public static long parseDateStartMs(String yyyyMmDd) {
        if (yyyyMmDd == null) return 0L;
        try {
            String[] p = yyyyMmDd.trim().split("-");
            if (p.length < 3) return 0L;
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone(TZ_SHANGHAI));
            cal.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]), 0, 0, 0);
            cal.set(Calendar.MILLISECOND, 0);
            return cal.getTimeInMillis();
        } catch (Exception e) {
            return 0L;
        }
    }

    public static long addDays(long baseMs, int days) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone(TZ_SHANGHAI));
        cal.setTimeInMillis(baseMs);
        cal.add(Calendar.DAY_OF_YEAR, days);
        return cal.getTimeInMillis();
    }

    public static long setTimeOfDay(long dayStartMs, int hour, int minute) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone(TZ_SHANGHAI));
        cal.setTimeInMillis(dayStartMs);
        cal.set(Calendar.HOUR_OF_DAY, hour);
        cal.set(Calendar.MINUTE, minute);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    public static Set<Integer> parseWeeks(String expr, int maxWeeks) {
        Set<Integer> out = new HashSet<>();
        if (expr == null || expr.trim().isEmpty()) {
            for (int i = 1; i <= maxWeeks; i++) out.add(i);
            return out;
        }
        String norm = expr.replace("，", ",").replace("～", "-").replace("~", "-").replace("周", "");
        for (String raw : norm.split(",")) {
            String p = raw.trim();
            if (p.isEmpty()) continue;
            boolean oddOnly = p.contains("单");
            boolean evenOnly = p.contains("双");
            String digits = p.replaceAll("[^0-9\\-]", "");
            if (digits.isEmpty()) continue;
            try {
                if (digits.contains("-")) {
                    String[] ab = digits.split("-");
                    if (ab.length >= 2) {
                        int a = Math.max(1, Integer.parseInt(ab[0]));
                        int b = Math.min(maxWeeks, Integer.parseInt(ab[1]));
                        for (int w = a; w <= b; w++) {
                            if (oddOnly && w % 2 == 0) continue;
                            if (evenOnly && w % 2 != 0) continue;
                            out.add(w);
                        }
                    }
                } else {
                    int w = Integer.parseInt(digits);
                    if (w >= 1 && w <= maxWeeks) out.add(w);
                }
            } catch (Exception ignored) {
            }
        }
        if (out.isEmpty()) {
            for (int i = 1; i <= maxWeeks; i++) out.add(i);
        }
        return out;
    }

    public static int[] getPeriodStartHm(int period1Based) {
        int idx = Math.min(PERIOD_START_HM.length - 1, Math.max(0, period1Based - 1));
        return PERIOD_START_HM[idx];
    }

    public static int[] getPeriodEndHm(int period1Based) {
        int idx = Math.min(PERIOD_END_HM.length - 1, Math.max(0, period1Based - 1));
        return PERIOD_END_HM[idx];
    }
}

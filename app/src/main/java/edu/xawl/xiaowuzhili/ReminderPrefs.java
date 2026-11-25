package edu.xawl.xiaowuzhili;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * 校务智理 v1.036 · 原生提醒与三款液态玻璃小组件偏好设置中心
 * 默认小组件皮肤：款式 A（冰川透光液态玻璃卡 glacier）
 */
public class ReminderPrefs {

    public static final String PREFS = "xiaowu_native_prefs";
    public static final String SKIN_GLACIER = "glacier"; // 款式 A（默认）：冰川透光液态玻璃
    public static final String SKIN_AURORA = "aurora";   // 款式 B：晴空极光蓝靛玻璃
    public static final String SKIN_PEARL = "pearl";     // 款式 C：珍珠悬浮胶囊卡

    private static final String KEY_CLASS_REMINDER = "class_reminder_on";
    private static final String KEY_LEAD_MINUTES = "class_lead_minutes";
    private static final String KEY_MORNING_DIGEST = "morning_digest_on";
    private static final String KEY_TASK_REMINDER = "task_reminder_on";
    private static final String KEY_LIVE_CARD = "live_next_class_on";
    private static final String KEY_SILENT_MODE = "silent_notify_on";
    private static final String KEY_WIDGET_SKIN = "widget_skin";

    private static SharedPreferences sp(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean isClassReminderEnabled(Context ctx) {
        return sp(ctx).getBoolean(KEY_CLASS_REMINDER, true);
    }

    public static void setClassReminderEnabled(Context ctx, boolean on) {
        sp(ctx).edit().putBoolean(KEY_CLASS_REMINDER, on).apply();
    }

    public static int getLeadMinutes(Context ctx) {
        int v = sp(ctx).getInt(KEY_LEAD_MINUTES, 15);
        return (v == 10 || v == 15 || v == 20 || v == 30) ? v : 15;
    }

    public static void setLeadMinutes(Context ctx, int mins) {
        sp(ctx).edit().putInt(KEY_LEAD_MINUTES, mins).apply();
    }

    public static boolean isMorningDigestEnabled(Context ctx) {
        return sp(ctx).getBoolean(KEY_MORNING_DIGEST, false);
    }

    public static void setMorningDigestEnabled(Context ctx, boolean on) {
        sp(ctx).edit().putBoolean(KEY_MORNING_DIGEST, on).apply();
    }

    public static boolean isTaskReminderEnabled(Context ctx) {
        return sp(ctx).getBoolean(KEY_TASK_REMINDER, true);
    }

    public static void setTaskReminderEnabled(Context ctx, boolean on) {
        sp(ctx).edit().putBoolean(KEY_TASK_REMINDER, on).apply();
    }

    public static boolean isLiveCardEnabled(Context ctx) {
        return sp(ctx).getBoolean(KEY_LIVE_CARD, false);
    }

    public static void setLiveCardEnabled(Context ctx, boolean on) {
        sp(ctx).edit().putBoolean(KEY_LIVE_CARD, on).apply();
    }

    public static boolean isSilentMode(Context ctx) {
        return sp(ctx).getBoolean(KEY_SILENT_MODE, false);
    }

    public static void setSilentMode(Context ctx, boolean on) {
        sp(ctx).edit().putBoolean(KEY_SILENT_MODE, on).apply();
    }

    public static String getWidgetSkin(Context ctx) {
        String s = sp(ctx).getString(KEY_WIDGET_SKIN, SKIN_GLACIER);
        if (SKIN_AURORA.equals(s) || "blue".equals(s)) return SKIN_AURORA;
        if (SKIN_PEARL.equals(s)) return SKIN_PEARL;
        return SKIN_GLACIER;
    }

    public static void setWidgetSkin(Context ctx, String skin) {
        String norm = SKIN_GLACIER;
        if (SKIN_AURORA.equals(skin)) norm = SKIN_AURORA;
        else if (SKIN_PEARL.equals(skin)) norm = SKIN_PEARL;
        sp(ctx).edit().putString(KEY_WIDGET_SKIN, norm).apply();
    }

    public static String toJsonString(Context ctx) {
        try {
            JSONObject o = new JSONObject();
            o.put("skin", getWidgetSkin(ctx));
            o.put("classReminder", isClassReminderEnabled(ctx));
            o.put("leadMinutes", getLeadMinutes(ctx));
            o.put("morningDigest", isMorningDigestEnabled(ctx));
            o.put("taskReminder", isTaskReminderEnabled(ctx));
            o.put("liveCard", isLiveCardEnabled(ctx));
            o.put("silentMode", isSilentMode(ctx));
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    public static void applyKeyValue(Context ctx, String key, String value) {
        if (key == null) return;
        boolean boolVal = "true".equalsIgnoreCase(value) || "1".equals(value);
        switch (key) {
            case "skin":
                setWidgetSkin(ctx, value);
                break;
            case "classReminder":
                setClassReminderEnabled(ctx, boolVal);
                break;
            case "leadMinutes":
                try { setLeadMinutes(ctx, Integer.parseInt(value)); } catch (Exception ignored) {}
                break;
            case "morningDigest":
                setMorningDigestEnabled(ctx, boolVal);
                break;
            case "taskReminder":
                setTaskReminderEnabled(ctx, boolVal);
                break;
            case "liveCard":
                setLiveCardEnabled(ctx, boolVal);
                break;
            case "silentMode":
                setSilentMode(ctx, boolVal);
                break;
            default:
                break;
        }
    }
}

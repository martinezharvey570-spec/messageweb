package edu.xawl.xiaowuzhili;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 校务智理 v1.035 · 开机/升级/时区变更自动重建提醒与刷新桌面小组件
 */
public class BootCompletedReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext();
        TodayScheduleWidget.refreshAllWidgets(appCtx);
        CampusReminderManager.rescheduleFromCache(appCtx);
    }
}

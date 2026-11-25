# 校务智理 v1.035 R8 / ProGuard 规则
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod

# 保留所有 WebView JavascriptInterface 桥接方法
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep public class edu.xawl.xiaowuzhili.MainActivity$AndroidBridge { *; }

# 保留原生组件、弹窗、小组件与广播接收器
-keep public class edu.xawl.xiaowuzhili.MainActivity { *; }
-keep public class edu.xawl.xiaowuzhili.BootBookView { *; }
-keep public class edu.xawl.xiaowuzhili.TodayScheduleWidget { *; }
-keep public class edu.xawl.xiaowuzhili.ReminderReceiver { *; }
-keep public class edu.xawl.xiaowuzhili.BootCompletedReceiver { *; }
-keep public class edu.xawl.xiaowuzhili.CalendarSyncHelper { *; }
-keep public class edu.xawl.xiaowuzhili.CampusReminderManager { *; }
-keep public class edu.xawl.xiaowuzhili.ReminderPrefs { *; }
-keep public class edu.xawl.xiaowuzhili.GlassSettingsInjector { *; }

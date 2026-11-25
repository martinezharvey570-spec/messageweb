package edu.xawl.xiaowuzhili;

import android.Manifest;
import android.animation.ObjectAnimator;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.CalendarContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 校务智理 v1.035 · 安卓端原生 Edge-to-Edge 容器 (API 24-35)
 * 集成：原生 60fps「微风翻书」动画、极简双肤 4×2 桌面课表小组件、可控智能提醒中心（无状态栏闹钟图标）、系统日历一键直写与清理。
 */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://messageweb.xyz";
    private static final String START_URL = "https://messageweb.xyz/index.html";
    private static final String VERSION_CHECK_URL = "https://messageweb.xyz/version.json";
    private static final String UI_PREFS = "xiaowu_ui_prefs";
    private static final String KEY_IS_DARK = "is_dark";
    private static final String KEY_ASKED_NOTIF = "asked_notif_perm";
    private static final String MIME_OPEN_CALENDAR = "vnd.xiaowu/open-calendar";

    private static final int FILE_CHOOSER_RESULT_CODE = 10001;
    private static final int WEB_PERMISSION_REQUEST_CODE = 10002;
    private static final int CALENDAR_PERMISSION_REQUEST_CODE = 10003;
    private static final int NOTIF_PERMISSION_REQUEST_CODE = 10004;
    private static final long SLOW_LOAD_RETRY_MS = 12000L;
    private static final long MIN_SPLASH_MS = 720L;

    private static final Set<String> ALLOWED_SHORTCUT_PAGES = new HashSet<>(Arrays.asList(
            "home", "notices", "tasks", "ai", "knowledge", "schedule"
    ));
    private static final String[] BOOT_TAP_NOTES = new String[]{
            "灵感 +1 ✨",
            "127 份校规已记牢 📘",
            "课表与待办同步中 📅",
            "指南 AI 随时待命 ✦",
            "今天也要元气满满 ⚡"
    };

    private Uri cameraPhotoUri;
    private FrameLayout rootLayout;
    private WebView webView;

    private FrameLayout splashOverlay;
    private LinearLayout splashCard;
    private BootBookView bootBookView;
    private TextView splashTitleView;
    private TextView splashSubView;
    private ProgressBar splashProgressBar;
    private TextView splashPctView;
    private TextView splashHintView;
    private TextView splashTapHintView;
    private Button splashRetryBtn;
    private int bootTapCount = 0;

    private ObjectAnimator progressAnimator;
    private int currentProgressTarget = 0;
    private boolean appDataReady = false;
    private boolean isOfflineShown = false;
    private boolean isDarkTheme = false;
    private long splashStartTimeMs = 0L;
    private int safeTopDp = 0;
    private int safeTopPx = 0;
    private String appVersionName = "1.036";
    private String pendingShortcutPage = null;

    private byte[] pendingCalendarIcsBytes = null;
    private String pendingCalendarFileName = null;
    private String pendingCalendarMime = null;
    private String pendingCalendarJson = null;
    private boolean pendingCalendarClear = false;
    private boolean pendingTestNotification = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable slowLoadRunnable;
    private Runnable hideSplashRunnable;

    private ValueCallback<Uri[]> uploadMessage;
    private PermissionRequest pendingWebPermissionRequest;
    private long lastBackPressTime = 0L;
    private long lastDownloadId = -1L;
    private String lastDownloadMime = "*/*";
    private Uri lastReadyUri = null;
    private String lastReadyMime = "*/*";
    private Uri pendingInstallApkUri = null;
    private BroadcastReceiver downloadCompleteReceiver;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Object backInvokedCallbackObj;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        isDarkTheme = loadSavedDarkTheme();
        pendingShortcutPage = extractShortcutTarget(getIntent());
        enableEdgeToEdgeWindow();

        try {
            PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (pInfo != null && pInfo.versionName != null && !pInfo.versionName.isEmpty()) {
                appVersionName = pInfo.versionName;
            }
        } catch (Exception ignored) {
        }

        int initBg = isDarkTheme ? Color.parseColor("#0B1120") : Color.parseColor("#F8FAFC");

        rootLayout = new FrameLayout(this);
        rootLayout.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        rootLayout.setBackgroundColor(initBg);

        webView = new WebView(this);
        webView.setBackgroundColor(initBg);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        splashOverlay = createSplashOverlay();
        rootLayout.addView(splashOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        rootLayout.setOnApplyWindowInsetsListener((v, insets) -> {
            int topPx, bottomPx, leftPx, rightPx;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets sys = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                                | android.view.WindowInsets.Type.displayCutout()
                );
                android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
                topPx = sys.top;
                leftPx = sys.left;
                rightPx = sys.right;
                bottomPx = Math.max(sys.bottom, ime.bottom);
            } else {
                topPx = insets.getSystemWindowInsetTop();
                leftPx = insets.getSystemWindowInsetLeft();
                rightPx = insets.getSystemWindowInsetRight();
                bottomPx = insets.getSystemWindowInsetBottom();
            }

            safeTopPx = topPx;
            float density = getResources().getDisplayMetrics().density;
            safeTopDp = Math.max(0, Math.round(topPx / Math.max(1f, density)));

            v.setPadding(leftPx, 0, rightPx, bottomPx);
            if (splashOverlay != null) {
                splashOverlay.setPadding(dpToPx(20), topPx + dpToPx(20), dpToPx(20), dpToPx(20));
            }
            pushSafeAreaToWebView();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return android.view.WindowInsets.CONSUMED;
            } else {
                return insets.consumeSystemWindowInsets();
            }
        });

        setContentView(rootLayout);
        applySystemBarsTheme(isDarkTheme);
        applySplashTheme(isDarkTheme);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            OnBackInvokedCallback cb = this::handleBackAction;
            backInvokedCallbackObj = cb;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb
            );
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " XiaowuZhiliApp/" + appVersionName);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pushSafeAreaToWebView();
                injectNativeSidebarEntry();
                if (!appDataReady && !isOfflineShown) {
                    animateProgressTo(820, 900);
                    updateSplashStageText(82);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    showOfflineState(view);
                }
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                super.onReceivedError(view, errorCode, description, failingUrl);
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                    showOfflineState(view);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    String host = uri.getHost() != null ? uri.getHost().toLowerCase() : "";
                    if (host.equals("messageweb.xyz") || host.equals("www.messageweb.xyz")) {
                        return false;
                    }
                    openExternalBrowser(uri.toString());
                    return true;
                }
                openExternalBrowser(uri.toString());
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                // 仅在冷启动阶段驱动启动卡进度条，彻底杜绝 SPA 切页顶部残留蓝条
                if (!appDataReady && !isOfflineShown) {
                    int mapped = Math.min(760, Math.max(240, newProgress * 7 + 80));
                    animateProgressTo(mapped, 280);
                    updateSplashStageText(mapped / 10);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (request == null) return;
                Uri origin = request.getOrigin();
                String host = origin != null && origin.getHost() != null ? origin.getHost().toLowerCase() : "";
                if (!host.equals("messageweb.xyz") && !host.equals("www.messageweb.xyz")) {
                    request.deny();
                    return;
                }
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    try { uploadMessage.onReceiveValue(null); } catch (Exception ignored) {}
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;
                cameraPhotoUri = null;
                try {
                    boolean canCamera = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                    if (fileChooserParams != null && fileChooserParams.isCaptureEnabled() && canCamera) {
                        try {
                            Intent camIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                            ContentValues cv = new ContentValues();
                            cv.put(MediaStore.Images.Media.DISPLAY_NAME, "xz_" + System.currentTimeMillis() + ".jpg");
                            cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                            cameraPhotoUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                            if (cameraPhotoUri != null) {
                                camIntent.putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri);
                                startActivityForResult(camIntent, FILE_CHOOSER_RESULT_CODE);
                                return true;
                            }
                        } catch (Exception ignored) {
                            cameraPhotoUri = null;
                        }
                    }
                    Intent intent = fileChooserParams != null ? fileChooserParams.createIntent() : new Intent(Intent.ACTION_GET_CONTENT).setType("*/*");
                    if (fileChooserParams != null && fileChooserParams.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE);
                    return true;
                } catch (Exception e) {
                    if (uploadMessage != null) {
                        try { uploadMessage.onReceiveValue(null); } catch (Exception ignored) {}
                        uploadMessage = null;
                    }
                    cameraPhotoUri = null;
                    return false;
                }
            }
        });

        registerDownloadReceiver();
        registerNetworkMonitor();

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                if (url == null || url.startsWith("blob:")) return;
                enqueueSystemDownload(url, userAgent, URLUtil.guessFileName(url, contentDisposition, mimeType), mimeType);
            }
        });

        try {
            SharedPreferences sp = getSharedPreferences("app_meta", MODE_PRIVATE);
            if (!appVersionName.equals(sp.getString("last_cache_ver", ""))) {
                webView.clearCache(true);
                sp.edit().putString("last_cache_ver", appVersionName).apply();
            }
        } catch (Exception ignored) {
        }

        if (!isNetworkAvailable()) {
            showOfflineState(webView);
        } else {
            startCloudLoadWithSplash();
        }

        mainHandler.postDelayed(this::checkAppUpdateSilently, 3000);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String target = extractShortcutTarget(intent);
        if (target != null) {
            pendingShortcutPage = target;
            if (appDataReady && !isOfflineShown) {
                dispatchPendingShortcut();
            }
        }
    }

    private String extractShortcutTarget(Intent intent) {
        if (intent == null) return null;
        String target = intent.getStringExtra("target_page");
        return (target != null && ALLOWED_SHORTCUT_PAGES.contains(target)) ? target : null;
    }

    private void dispatchPendingShortcut() {
        final String target = pendingShortcutPage;
        if (target == null || webView == null) return;
        pendingShortcutPage = null;
        mainHandler.postDelayed(() -> {
            if (webView == null || isFinishing()) return;
            String js = "try{if(typeof go==='function'&&document.getElementById('app')&&!document.getElementById('app').classList.contains('hide')){go("
                    + JSONObject.quote(target) + ");}}catch(e){}";
            webView.evaluateJavascript(js, null);
        }, 120);
    }

    /** 在侧边栏底部注入原生「提醒与小组件」入口（无需重新部署网页即可生效） */
    private void injectNativeSidebarEntry() {
        if (webView == null || isFinishing()) return;
        String js = "(function(){try{"
                + "var sb=document.querySelector('#sidebar .sidebottom');"
                + "if(!sb||document.getElementById('appNativeSettingsBtn'))return;"
                + "var b=document.createElement('button');"
                + "b.type='button';b.id='appNativeSettingsBtn';"
                + "b.style.cssText='display:flex;align-items:center;gap:8px;width:100%;padding:9px 14px;border:0;border-radius:12px;background:transparent;color:var(--muted);font-weight:600;font-size:13px;font-family:inherit;cursor:pointer;text-align:left;box-sizing:border-box;';"
                + "b.innerHTML='<svg class=\"ico\" style=\"width:15px;height:15px;color:#2563eb;flex-shrink:0;\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"/><path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"/></svg><span>提醒与小组件</span>';"
                + "b.onclick=function(){var s=document.getElementById('sidebar');if(s)s.classList.remove('open');document.body.classList.remove('sidebar-open');window.AndroidBridge&&window.AndroidBridge.openNativeSettings&&window.AndroidBridge.openNativeSettings();};"
                + "sb.insertBefore(b,sb.firstChild);"
                + "}catch(e){}})();";
        webView.evaluateJavascript(js, null);
    }

    private void openNativeSettingsPanel() {
        runOnUiThread(() -> {
            if (isFinishing() || webView == null) return;
            String prefsJson = ReminderPrefs.toJsonString(getApplicationContext());
            webView.evaluateJavascript(GlassSettingsInjector.buildOpenSettingsJs(prefsJson), null);
        });
    }

    private void triggerTestNotificationFromUi() {
        runOnUiThread(() -> {
            if (isFinishing()) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                pendingTestNotification = true;
                Toast.makeText(MainActivity.this, "请先允许通知权限，授权后将立即发送测试通知", Toast.LENGTH_SHORT).show();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIF_PERMISSION_REQUEST_CODE);
                return;
            }
            boolean ok = CampusReminderManager.sendTestNotification(getApplicationContext());
            Toast.makeText(MainActivity.this,
                    ok ? "已发送测试通知，请下拉手机通知栏查看" : "未能发送通知，请在系统设置中检查通知权限",
                    Toast.LENGTH_SHORT).show();
        });
    }

    private void triggerCalendarSyncFromUi() {
        runOnUiThread(() -> {
            if (isFinishing() || webView == null) return;
            webView.evaluateJavascript(
                    "try{if(typeof schedState!=='undefined'&&schedState&&Array.isArray(schedState.courses)&&schedState.courses.length){window.AndroidBridge.importScheduleToCalendar(JSON.stringify(schedState));'OK';}else{'EMPTY';}}catch(e){'EMPTY';}",
                    value -> {
                        if (value != null && value.contains("EMPTY")) {
                            String cached = getSharedPreferences(TodayScheduleWidget.PREFS_NAME, MODE_PRIVATE)
                                    .getString(TodayScheduleWidget.KEY_PAYLOAD, "");
                            if (cached != null && !cached.trim().isEmpty()) {
                                startCalendarJsonImport(cached);
                            } else {
                                Toast.makeText(MainActivity.this, "当前暂无可同步的课表数据，请先进入课表页加载", Toast.LENGTH_LONG).show();
                            }
                        }
                    }
            );
        });
    }

    private boolean loadSavedDarkTheme() {
        try {
            SharedPreferences sp = getSharedPreferences(UI_PREFS, MODE_PRIVATE);
            if (sp.contains(KEY_IS_DARK)) return sp.getBoolean(KEY_IS_DARK, false);
        } catch (Exception ignored) {
        }
        int nightFlags = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return nightFlags == Configuration.UI_MODE_NIGHT_YES;
    }

    private void saveDarkThemePref(boolean dark) {
        try {
            getSharedPreferences(UI_PREFS, MODE_PRIVATE).edit().putBoolean(KEY_IS_DARK, dark).apply();
        } catch (Exception ignored) {
        }
    }

    private void enableEdgeToEdgeWindow() {
        Window window = getWindow();
        if (window == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            int vis = window.getDecorView().getSystemUiVisibility();
            vis |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            window.getDecorView().setSystemUiVisibility(vis);
        }
    }

    private void pushSafeAreaToWebView() {
        if (webView == null) return;
        final int dp = safeTopDp;
        String js = "try{document.documentElement.style.setProperty('--xz-safe-top','" + dp + "px');window.__xzSafeTopDp=" + dp + ";}catch(e){}";
        webView.evaluateJavascript(js, null);
    }

    private void startCloudLoadWithSplash() {
        appDataReady = false;
        isOfflineShown = false;
        currentProgressTarget = 0;
        splashStartTimeMs = SystemClock.uptimeMillis();
        if (hideSplashRunnable != null) mainHandler.removeCallbacks(hideSplashRunnable);

        if (splashOverlay != null) {
            splashOverlay.animate().cancel();
            splashOverlay.setAlpha(1f);
            splashOverlay.setScaleX(1f);
            splashOverlay.setScaleY(1f);
            splashOverlay.setVisibility(View.VISIBLE);
        }
        if (bootBookView != null) {
            bootBookView.setPaused(false);
            bootBookView.startAnimation();
        }
        if (splashProgressBar != null) splashProgressBar.setProgress(0);
        if (splashPctView != null) splashPctView.setText("24%");
        if (splashHintView != null) splashHintView.setText("正在翻阅 127 份校园规章…");
        if (splashTapHintView != null && bootTapCount == 0) splashTapHintView.setText("轻点书本试试 ✨");
        if (splashRetryBtn != null) splashRetryBtn.setVisibility(View.GONE);
        animateProgressTo(280, 480);

        if (slowLoadRunnable != null) mainHandler.removeCallbacks(slowLoadRunnable);
        slowLoadRunnable = () -> {
            if (!appDataReady && splashOverlay != null && splashOverlay.getVisibility() == View.VISIBLE) {
                if (bootBookView != null) bootBookView.setPaused(true);
                if (splashHintView != null) splashHintView.setText("服务响应稍慢，仍在等待完整数据…");
                if (splashRetryBtn != null) splashRetryBtn.setVisibility(View.VISIBLE);
            }
        };
        mainHandler.postDelayed(slowLoadRunnable, SLOW_LOAD_RETRY_MS);

        mainHandler.postDelayed(() -> {
            if (isFinishing() || webView == null || isOfflineShown) return;
            Map<String, String> initHeaders = new HashMap<>();
            initHeaders.put("Cache-Control", "no-cache");
            webView.loadUrl(START_URL, initHeaders);
        }, 140);
    }

    private void updateSplashStageText(int pct) {
        if (splashHintView == null || appDataReady) return;
        if (pct < 48) splashHintView.setText("正在翻阅 127 份校园规章…");
        else if (pct < 78) splashHintView.setText("正在核对本周课表、通知与待办…");
        else splashHintView.setText("校务指南 AI 正在热身 ✨");
    }

    private ProgressBar createVividBlueProgressBar(boolean rounded) {
        ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pb.setMax(1000);
        pb.setProgress(0);
        applyProgressBarStyle(pb, isDarkTheme, rounded);
        return pb;
    }

    private void applyProgressBarStyle(ProgressBar pb, boolean dark, boolean rounded) {
        if (pb == null) return;
        float radius = rounded ? dpToPx(999) : 0f;
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(dark ? Color.argb(34, 255, 255, 255) : Color.argb(54, 148, 163, 184));
        bg.setCornerRadius(radius);

        GradientDrawable grad = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{Color.parseColor("#38BDF8"), Color.parseColor("#2563EB"), Color.parseColor("#4F46E5")}
        );
        grad.setCornerRadius(radius);

        ClipDrawable clip = new ClipDrawable(grad, Gravity.START, ClipDrawable.HORIZONTAL);
        LayerDrawable layer = new LayerDrawable(new Drawable[]{bg, clip});
        layer.setId(0, android.R.id.background);
        layer.setId(1, android.R.id.progress);
        pb.setProgressDrawable(layer);
    }

    private void animateProgressTo(int target, long durationMs) {
        if (splashProgressBar == null) return;
        if (target <= currentProgressTarget && target < 1000) return;
        currentProgressTarget = target;
        if (progressAnimator != null && progressAnimator.isRunning()) progressAnimator.cancel();
        int start = splashProgressBar.getProgress();
        progressAnimator = ObjectAnimator.ofInt(splashProgressBar, "progress", start, target);
        progressAnimator.setDuration(durationMs);
        progressAnimator.setInterpolator(new DecelerateInterpolator());
        progressAnimator.addUpdateListener(anim -> {
            int val = (Integer) anim.getAnimatedValue();
            int pct = Math.max(8, Math.min(100, Math.round(val / 10f)));
            if (splashPctView != null) splashPctView.setText(pct + "%");
        });
        progressAnimator.start();
    }

    private void finishStartupAndHideSplash() {
        runOnUiThread(() -> {
            if (slowLoadRunnable != null) mainHandler.removeCallbacks(slowLoadRunnable);
            if (appDataReady && (splashOverlay == null || splashOverlay.getVisibility() == View.GONE)) {
                dispatchPendingShortcut();
                injectNativeSidebarEntry();
                return;
            }
            appDataReady = true;
            long elapsed = SystemClock.uptimeMillis() - splashStartTimeMs;
            long remain = Math.max(0L, MIN_SPLASH_MS - elapsed);

            if (hideSplashRunnable != null) mainHandler.removeCallbacks(hideSplashRunnable);
            hideSplashRunnable = () -> {
                if (isFinishing()) return;
                animateProgressTo(1000, 180);
                if (splashHintView != null) splashHintView.setText("一切就绪，欢迎回来 ✨");
                if (bootBookView != null) bootBookView.triggerReady();
                mainHandler.postDelayed(() -> {
                    Runnable afterHide = () -> {
                        if (bootBookView != null) bootBookView.stopAnimation();
                        dispatchPendingShortcut();
                        injectNativeSidebarEntry();
                        pullScheduleAndTasksForNative();
                        mainHandler.postDelayed(this::pullScheduleAndTasksForNative, 1800L);
                        maybeRequestNotificationPermissionOnce();
                    };
                    if (splashOverlay != null && splashOverlay.getVisibility() == View.VISIBLE) {
                        splashOverlay.animate()
                                .alpha(0f)
                                .scaleX(1.035f)
                                .scaleY(1.035f)
                                .setDuration(300)
                                .setInterpolator(new DecelerateInterpolator())
                                .withEndAction(() -> {
                                    if (splashOverlay != null) {
                                        splashOverlay.setVisibility(View.GONE);
                                        splashOverlay.setScaleX(1f);
                                        splashOverlay.setScaleY(1f);
                                    }
                                    afterHide.run();
                                })
                                .start();
                    } else {
                        afterHide.run();
                    }
                }, 220);
            };
            mainHandler.postDelayed(hideSplashRunnable, remain);
        });
    }

    private FrameLayout createSplashOverlay() {
        FrameLayout root = new FrameLayout(this);
        root.setClipChildren(false);
        root.setClipToPadding(false);
        root.setPadding(dpToPx(20), dpToPx(20), dpToPx(20), dpToPx(20));

        splashCard = new LinearLayout(this);
        splashCard.setOrientation(LinearLayout.VERTICAL);
        splashCard.setGravity(Gravity.CENTER_HORIZONTAL);
        splashCard.setClipChildren(false);
        splashCard.setClipToPadding(false);
        splashCard.setPadding(dpToPx(20), dpToPx(14), dpToPx(20), dpToPx(22));
        splashCard.setElevation(dpToPx(12));

        bootBookView = new BootBookView(this);
        bootBookView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        bootBookView.setDarkMode(isDarkTheme);
        bootBookView.setOnClickListener(v -> {
            bootTapCount++;
            bootBookView.triggerBoing();
            if (splashTapHintView != null) {
                splashTapHintView.setText(BOOT_TAP_NOTES[(bootTapCount - 1) % BOOT_TAP_NOTES.length]);
            }
        });
        LinearLayout.LayoutParams lpBook = new LinearLayout.LayoutParams(dpToPx(220), dpToPx(188));
        lpBook.topMargin = dpToPx(-6);
        splashCard.addView(bootBookView, lpBook);

        splashTitleView = new TextView(this);
        splashTitleView.setText("校务智理");
        splashTitleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        splashTitleView.setTypeface(Typeface.DEFAULT_BOLD);
        splashTitleView.setLetterSpacing(0.05f);
        splashTitleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lpTitle = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpTitle.topMargin = dpToPx(4);
        splashCard.addView(splashTitleView, lpTitle);

        splashSubView = new TextView(this);
        splashSubView.setText("校园事务智能服务平台");
        splashSubView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        splashSubView.setLetterSpacing(0.08f);
        splashSubView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lpSub = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpSub.topMargin = dpToPx(3);
        splashCard.addView(splashSubView, lpSub);

        LinearLayout progressRow = new LinearLayout(this);
        progressRow.setOrientation(LinearLayout.HORIZONTAL);
        progressRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams lpRow = new LinearLayout.LayoutParams(dpToPx(244), LinearLayout.LayoutParams.WRAP_CONTENT);
        lpRow.topMargin = dpToPx(16);

        splashProgressBar = createVividBlueProgressBar(true);
        progressRow.addView(splashProgressBar, new LinearLayout.LayoutParams(0, dpToPx(7), 1f));

        splashPctView = new TextView(this);
        splashPctView.setText("24%");
        splashPctView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        splashPctView.setTypeface(Typeface.DEFAULT_BOLD);
        splashPctView.setGravity(Gravity.END);
        LinearLayout.LayoutParams lpPct = new LinearLayout.LayoutParams(dpToPx(38), LinearLayout.LayoutParams.WRAP_CONTENT);
        lpPct.leftMargin = dpToPx(8);
        progressRow.addView(splashPctView, lpPct);
        splashCard.addView(progressRow, lpRow);

        splashHintView = new TextView(this);
        splashHintView.setText("正在翻阅 127 份校园规章…");
        splashHintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        splashHintView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lpHint = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpHint.topMargin = dpToPx(10);
        splashCard.addView(splashHintView, lpHint);

        splashTapHintView = new TextView(this);
        splashTapHintView.setText("轻点书本试试 ✨");
        splashTapHintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        splashTapHintView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lpTap = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpTap.topMargin = dpToPx(7);
        splashCard.addView(splashTapHintView, lpTap);

        splashRetryBtn = new Button(this);
        splashRetryBtn.setText("重新连接");
        splashRetryBtn.setTextColor(Color.WHITE);
        splashRetryBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        splashRetryBtn.setAllCaps(false);
        GradientDrawable btnBg = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{Color.parseColor("#3B82F6"), Color.parseColor("#2563EB"), Color.parseColor("#4F46E5")}
        );
        btnBg.setCornerRadius(dpToPx(999));
        splashRetryBtn.setBackground(btnBg);
        splashRetryBtn.setPadding(dpToPx(24), dpToPx(8), dpToPx(24), dpToPx(8));
        splashRetryBtn.setVisibility(View.GONE);
        splashRetryBtn.setOnClickListener(v -> startCloudLoadWithSplash());
        LinearLayout.LayoutParams lpBtn = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lpBtn.topMargin = dpToPx(14);
        splashCard.addView(splashRetryBtn, lpBtn);

        root.addView(splashCard, new FrameLayout.LayoutParams(
                dpToPx(312), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        return root;
    }

    private void applySplashTheme(boolean dark) {
        if (splashOverlay == null) return;
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                dark
                        ? new int[]{Color.parseColor("#112142"), Color.parseColor("#0B1120"), Color.parseColor("#070B15")}
                        : new int[]{Color.parseColor("#EDF4FF"), Color.parseColor("#F7FAFF"), Color.parseColor("#EEF3FB")}
        );
        splashOverlay.setBackground(bg);

        if (splashCard != null) {
            GradientDrawable cardBg = new GradientDrawable(
                    GradientDrawable.Orientation.TL_BR,
                    dark
                            ? new int[]{Color.argb(215, 22, 34, 58), Color.argb(190, 15, 23, 42)}
                            : new int[]{Color.argb(232, 255, 255, 255), Color.argb(208, 242, 247, 255)}
            );
            cardBg.setCornerRadius(dpToPx(28));
            cardBg.setStroke(dpToPx(1), dark ? Color.argb(46, 96, 165, 250) : Color.argb(28, 37, 99, 235));
            splashCard.setBackground(cardBg);
        }
        if (bootBookView != null) bootBookView.setDarkMode(dark);
        if (splashTitleView != null) splashTitleView.setTextColor(dark ? Color.parseColor("#F8FAFC") : Color.parseColor("#1D4ED8"));
        if (splashSubView != null) splashSubView.setTextColor(dark ? Color.parseColor("#94A3B8") : Color.parseColor("#64748B"));
        if (splashPctView != null) splashPctView.setTextColor(dark ? Color.parseColor("#60A5FA") : Color.parseColor("#2563EB"));
        if (splashHintView != null) splashHintView.setTextColor(dark ? Color.parseColor("#CBD5E1") : Color.parseColor("#475569"));
        if (splashTapHintView != null) splashTapHintView.setTextColor(dark ? Color.parseColor("#64748B") : Color.parseColor("#94A3B8"));
        applyProgressBarStyle(splashProgressBar, dark, true);
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        String[] resources = request.getResources();
        if (resources == null || resources.length == 0) {
            request.deny();
            return;
        }
        List<String> neededPerms = new ArrayList<>();
        for (String res : resources) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    neededPerms.add(Manifest.permission.RECORD_AUDIO);
                }
            } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    neededPerms.add(Manifest.permission.CAMERA);
                }
            }
        }
        if (neededPerms.isEmpty()) {
            request.grant(resources);
        } else {
            if (pendingWebPermissionRequest != null) {
                try { pendingWebPermissionRequest.deny(); } catch (Exception ignored) {}
            }
            pendingWebPermissionRequest = request;
            requestPermissions(neededPerms.toArray(new String[0]), WEB_PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        boolean allGranted = grantResults != null && grantResults.length > 0;
        if (grantResults != null) {
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
        }

        if (requestCode == WEB_PERMISSION_REQUEST_CODE && pendingWebPermissionRequest != null) {
            PermissionRequest req = pendingWebPermissionRequest;
            pendingWebPermissionRequest = null;
            try {
                if (allGranted) req.grant(req.getResources());
                else req.deny();
            } catch (Exception ignored) {
            }
        } else if (requestCode == CALENDAR_PERMISSION_REQUEST_CODE) {
            byte[] ics = pendingCalendarIcsBytes;
            String fname = pendingCalendarFileName;
            String mime = pendingCalendarMime;
            String json = pendingCalendarJson;
            boolean doClear = pendingCalendarClear;
            pendingCalendarIcsBytes = null;
            pendingCalendarFileName = null;
            pendingCalendarMime = null;
            pendingCalendarJson = null;
            pendingCalendarClear = false;

            if (allGranted) {
                if (doClear) executeCalendarClear();
                else if (ics != null) executeCalendarIcsImport(ics, fname, mime);
                else if (json != null) executeCalendarJsonImport(json);
            } else {
                if (ics != null) {
                    Toast.makeText(this, "未授予日历权限，已将 .ics 文件保存至下载目录", Toast.LENGTH_LONG).show();
                    try {
                        saveBytesToDownloads(ics, fname != null ? fname : "校务智理_超级课表.ics", mime != null ? mime : "text/calendar");
                    } catch (Exception ignored) {}
                } else {
                    Toast.makeText(this, "需要日历权限才能操作手机系统日历", Toast.LENGTH_SHORT).show();
                }
            }
        } else if (requestCode == NOTIF_PERMISSION_REQUEST_CODE) {
            boolean sendTest = pendingTestNotification;
            pendingTestNotification = false;
            if (allGranted) {
                CampusReminderManager.rescheduleFromCache(getApplicationContext());
                if (sendTest) {
                    CampusReminderManager.sendTestNotification(getApplicationContext());
                    Toast.makeText(this, "已发送测试通知，请下拉通知栏查看", Toast.LENGTH_SHORT).show();
                }
            } else if (sendTest) {
                Toast.makeText(this, "未开启通知权限，请在系统设置中允许校务智理发送通知", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void pullScheduleAndTasksForNative() {
        if (webView == null || isFinishing()) return;
        String js = "try{"
                + "var s=(typeof schedState!=='undefined'&&schedState)?schedState:null;"
                + "var t=(typeof tasks!=='undefined'&&Array.isArray(tasks))?tasks:[];"
                + "if((s&&Array.isArray(s.courses))||t.length){"
                + "window.AndroidBridge&&window.AndroidBridge.syncNativeScheduleAndTasks(JSON.stringify({schedule:s,tasks:t}));"
                + "}"
                + "}catch(e){}";
        webView.evaluateJavascript(js, null);
    }

    private void maybeRequestNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
            SharedPreferences sp = getSharedPreferences(UI_PREFS, MODE_PRIVATE);
            if (sp.getBoolean(KEY_ASKED_NOTIF, false)) return;
            sp.edit().putBoolean(KEY_ASKED_NOTIF, true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIF_PERMISSION_REQUEST_CODE);
        } catch (Exception ignored) {
        }
    }

    private boolean hasCalendarPermissions() {
        return checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    private void startCalendarIcsImport(byte[] bytes, String fileName, String mimeType) {
        runOnUiThread(() -> {
            if (hasCalendarPermissions()) {
                executeCalendarIcsImport(bytes, fileName, mimeType);
            } else {
                pendingCalendarIcsBytes = bytes;
                pendingCalendarFileName = fileName;
                pendingCalendarMime = mimeType;
                pendingCalendarJson = null;
                pendingCalendarClear = false;
                Toast.makeText(this, "请允许“校务智理”访问日历，授权后将自动导入课表", Toast.LENGTH_LONG).show();
                requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR},
                        CALENDAR_PERMISSION_REQUEST_CODE);
            }
        });
    }

    private void startCalendarJsonImport(String scheduleJson) {
        runOnUiThread(() -> {
            if (hasCalendarPermissions()) {
                executeCalendarJsonImport(scheduleJson);
            } else {
                pendingCalendarJson = scheduleJson;
                pendingCalendarIcsBytes = null;
                pendingCalendarClear = false;
                Toast.makeText(this, "请允许“校务智理”访问日历，授权后将自动同步课表", Toast.LENGTH_LONG).show();
                requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR},
                        CALENDAR_PERMISSION_REQUEST_CODE);
            }
        });
    }

    private void startCalendarClear() {
        runOnUiThread(() -> {
            if (hasCalendarPermissions()) {
                executeCalendarClear();
            } else {
                pendingCalendarClear = true;
                pendingCalendarIcsBytes = null;
                pendingCalendarJson = null;
                requestPermissions(new String[]{Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR},
                        CALENDAR_PERMISSION_REQUEST_CODE);
            }
        });
    }

    private void executeCalendarIcsImport(final byte[] bytes, final String fileName, final String mimeType) {
        Toast.makeText(this, "正在导入课程到系统日历…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            CalendarSyncHelper.ImportResult res = CalendarSyncHelper.importFromIcsBytes(getApplicationContext(), bytes);
            runOnUiThread(() -> {
                if (res.ok) {
                    triggerSuccessHaptic();
                    String msg = "已成功将 " + res.count + " 节课程写入「" + res.calendarName
                            + "」（含课前提醒，已自动去重），是否立即打开手机日历查看？";
                    promptOpenFile("已导入手机日历", msg, CalendarContract.CONTENT_URI, MIME_OPEN_CALENDAR);
                } else {
                    Toast.makeText(MainActivity.this, res.error + "，已为您另存 .ics 文件", Toast.LENGTH_LONG).show();
                    try {
                        saveBytesToDownloads(bytes, fileName != null ? fileName : "校务智理_超级课表.ics", mimeType != null ? mimeType : "text/calendar");
                    } catch (Exception ignored) {}
                }
            });
        }).start();
    }

    private void executeCalendarJsonImport(final String scheduleJson) {
        Toast.makeText(this, "正在同步课程到系统日历…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            CalendarSyncHelper.ImportResult res = CalendarSyncHelper.importFromScheduleJson(getApplicationContext(), scheduleJson);
            runOnUiThread(() -> {
                if (res.ok) {
                    triggerSuccessHaptic();
                    String msg = "已成功将 " + res.count + " 节课程写入「" + res.calendarName
                            + "」（含课前提醒，已自动去重），是否立即打开手机日历查看？";
                    promptOpenFile("已导入手机日历", msg, CalendarContract.CONTENT_URI, MIME_OPEN_CALENDAR);
                } else {
                    Toast.makeText(MainActivity.this, res.error, Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    private void executeCalendarClear() {
        new Thread(() -> {
            CalendarSyncHelper.ImportResult res = CalendarSyncHelper.clearSyncedCalendarEvents(getApplicationContext());
            runOnUiThread(() -> {
                if (res.ok) {
                    triggerSuccessHaptic();
                    Toast.makeText(MainActivity.this,
                            res.count > 0 ? ("已清除 " + res.count + " 条校务智理同步日程") : "系统日历中暂无校务智理同步日程",
                            Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(MainActivity.this, res.error, Toast.LENGTH_LONG).show();
                }
            });
        }).start();
    }

    private void triggerSuccessHaptic() {
        if (rootLayout == null) return;
        try {
            int code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? HapticFeedbackConstants.CONFIRM
                    : HapticFeedbackConstants.KEYBOARD_TAP;
            rootLayout.performHapticFeedback(code);
        } catch (Exception ignored) {
        }
    }

    private boolean isNetworkAvailable() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network active = cm.getActiveNetwork();
            if (active == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) {
            return true;
        }
    }

    private void registerNetworkMonitor() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    runOnUiThread(() -> {
                        if (isOfflineShown && !isFinishing() && webView != null) {
                            Toast.makeText(MainActivity.this, "网络已恢复，正在重新连接…", Toast.LENGTH_SHORT).show();
                            startCloudLoadWithSplash();
                        }
                    });
                }
            };
            NetworkRequest req = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            cm.registerNetworkCallback(req, networkCallback);
        } catch (Exception ignored) {
        }
    }

    private void showOfflineState(WebView view) {
        isOfflineShown = true;
        if (slowLoadRunnable != null) mainHandler.removeCallbacks(slowLoadRunnable);
        if (bootBookView != null) bootBookView.stopAnimation();
        if (splashOverlay != null) splashOverlay.setVisibility(View.GONE);
        showOfflinePage(view);
    }

    private void enqueueSystemDownload(String url, String userAgent, String fileName, String mimeType) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            boolean isApk = (fileName != null && fileName.toLowerCase().endsWith(".apk"))
                    || (url != null && url.toLowerCase().contains(".apk"))
                    || "application/vnd.android.package-archive".equalsIgnoreCase(mimeType);
            if (isApk) req.setMimeType("application/vnd.android.package-archive");
            else if (mimeType != null && !mimeType.isEmpty()) req.setMimeType(mimeType);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            if (userAgent != null) req.addRequestHeader("User-Agent", userAgent);
            req.setTitle(fileName);
            req.setDescription("校务智理正在下载文件...");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                lastDownloadId = dm.enqueue(req);
                lastDownloadMime = isApk
                        ? "application/vnd.android.package-archive"
                        : ((mimeType != null && !mimeType.isEmpty()) ? mimeType : "*/*");
                Toast.makeText(MainActivity.this, "已开始下载：" + fileName, Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            openExternalBrowser(url);
        }
    }

    private void registerDownloadReceiver() {
        downloadCompleteReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != -1L && id == lastDownloadId) {
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) {
                        Uri fileUri = dm.getUriForDownloadedFile(id);
                        if (fileUri != null) {
                            if ("application/vnd.android.package-archive".equalsIgnoreCase(lastDownloadMime)) {
                                runOnUiThread(() -> installApk(fileUri));
                            } else {
                                promptOpenFile("文件下载完成", "是否立即打开查看？", fileUri, lastDownloadMime);
                            }
                        }
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadCompleteReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadCompleteReceiver, filter);
        }
    }

    private void promptOpenFile(final String title, final String msg, final Uri fileUri, final String mimeType) {
        lastReadyUri = fileUri;
        lastReadyMime = (mimeType != null && !mimeType.isEmpty()) ? mimeType : "*/*";
        runOnUiThread(() -> {
            if (isFinishing() || webView == null) return;
            String jsCall = "window.__onAppFileReady && window.__onAppFileReady("
                    + JSONObject.quote(title) + ","
                    + JSONObject.quote(msg) + ")";
            webView.evaluateJavascript(jsCall, null);
        });
    }

    private void installApk(Uri apkUri) {
        if (apkUri == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstallApkUri = apkUri;
            Toast.makeText(this, "请允许“校务智理”安装应用，授权后将自动继续安装", Toast.LENGTH_LONG).show();
            try {
                Intent permIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivity(permIntent);
            } catch (Exception e) {
                Toast.makeText(this, "请在系统设置中允许安装未知应用后，到下载目录点击安装包", Toast.LENGTH_LONG).show();
            }
            return;
        }
        try {
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(installIntent);
        } catch (Exception e) {
            Toast.makeText(this, "无法自动拉起安装，请到手机「下载/Download」目录手动点击安装包", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
        if (pendingInstallApkUri != null) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls()) {
                Uri uri = pendingInstallApkUri;
                pendingInstallApkUri = null;
                installApk(uri);
            }
        }
        if (appDataReady && !isOfflineShown) {
            TodayScheduleWidget.refreshAllWidgets(getApplicationContext());
            CampusReminderManager.rescheduleFromCache(getApplicationContext());
        }
    }

    @Override
    protected void onPause() {
        if (appDataReady && !isOfflineShown) pullScheduleAndTasksForNative();
        if (webView != null) webView.onPause();
        try { CookieManager.getInstance().flush(); } catch (Exception ignored) {}
        super.onPause();
    }

    private void checkAppUpdateSilently() {
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(VERSION_CHECK_URL + "?t=" + System.currentTimeMillis());
                conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(4500);
                conn.setReadTimeout(4500);
                conn.setRequestMethod("GET");
                if (conn.getResponseCode() == 200) {
                    BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                    br.close();
                    JSONObject obj = new JSONObject(sb.toString());
                    int remoteCode = obj.optInt("versionCode", 0);
                    String remoteName = obj.optString("versionName", "");
                    String apkUrl = obj.optString("apkUrl", "");
                    String notes = obj.optString("notes", "包含最新界面优化与问题修复");

                    PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                    long localCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pInfo.getLongVersionCode() : pInfo.versionCode;
                    if (remoteCode > localCode && apkUrl.startsWith("https://")) {
                        runOnUiThread(() -> {
                            if (isFinishing() || webView == null) return;
                            String jsCall = "window.__onAppUpdateAvailable && window.__onAppUpdateAvailable("
                                    + JSONObject.quote(remoteName) + ","
                                    + JSONObject.quote(apkUrl) + ","
                                    + JSONObject.quote(notes) + ")";
                            webView.evaluateJavascript(jsCall, null);
                        });
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    private void openExternalBrowser(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {
        }
    }

    private void showOfflinePage(WebView view) {
        if (view == null) return;
        String bg = isDarkTheme ? "radial-gradient(ellipse at 50% 30%,#112142,#0B1120 65%)" : "radial-gradient(ellipse at 50% 30%,#EDF4FF,#F8FAFC 65%)";
        String cardBg = isDarkTheme ? "rgba(22,34,58,.86)" : "rgba(255,255,255,.88)";
        String cardBorder = isDarkTheme ? "rgba(96,165,250,.22)" : "rgba(37,99,235,.12)";
        String ink = isDarkTheme ? "#F8FAFC" : "#0F172A";
        String muted = isDarkTheme ? "#94A3B8" : "#64748B";
        String html = "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no'>"
                + "<style>"
                + "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:" + bg + ";font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:" + ink + ";padding:24px;box-sizing:border-box;}"
                + ".card{width:100%;max-width:336px;background:" + cardBg + ";border:1px solid " + cardBorder + ";border-radius:26px;padding:30px 22px 24px;text-align:center;box-shadow:0 18px 42px rgba(15,23,42,.18);}"
                + ".logo{width:60px;height:60px;margin:0 auto 16px;border-radius:18px;background:linear-gradient(145deg,#3B82F6,#2563EB 55%,#4F46E5);color:#fff;font-size:27px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 26px rgba(37,99,235,.32);}"
                + "h2{margin:0 0 8px;font-size:19px;font-weight:700;}"
                + "p{margin:0 0 22px;font-size:13.5px;line-height:1.68;color:" + muted + ";}"
                + "button{width:100%;height:44px;border:0;border-radius:999px;background:linear-gradient(135deg,#3B82F6,#2563EB 58%,#4F46E5);color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 10px 22px -6px rgba(37,99,235,.45);}"
                + "button:active{transform:scale(.98);}"
                + ".tip{margin-top:12px;font-size:12px;color:" + muted + ";}"
                + "</style></head><body><div class='card'>"
                + "<div class='logo'>校</div>"
                + "<h2>当前网络不可用</h2>"
                + "<p>校务智理需要联网同步最新通知、127 份制度库与指南 AI 服务。恢复联网后将自动为你重连。</p>"
                + "<button onclick='AndroidBridge && AndroidBridge.reloadCloudPage ? AndroidBridge.reloadCloudPage() : location.replace(\"" + START_URL + "\")'>立即重试</button>"
                + "<div class='tip'>正在监听网络状态，联网后自动刷新</div>"
                + "</div></body></html>";
        view.loadDataWithBaseURL(APP_ORIGIN, html, "text/html", "UTF-8", null);
    }

    private void applySystemBarsTheme(final boolean isDark) {
        isDarkTheme = isDark;
        runOnUiThread(() -> {
            int bgBottom = isDark ? Color.parseColor("#0B1120") : Color.parseColor("#F8FAFC");
            if (rootLayout != null) rootLayout.setBackgroundColor(bgBottom);
            if (webView != null) webView.setBackgroundColor(bgBottom);

            Window window = getWindow();
            if (window == null) return;
            if (Build.VERSION.SDK_INT < 35) {
                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.setStatusBarColor(Color.TRANSPARENT);
                window.setNavigationBarColor(bgBottom);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.view.WindowInsetsController ctrl = window.getInsetsController();
                if (ctrl != null) {
                    int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                            | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    ctrl.setSystemBarsAppearance(isDark ? 0 : mask, mask);
                }
            } else {
                int flags = window.getDecorView().getSystemUiVisibility();
                flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
                if (isDark) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                } else {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
                window.getDecorView().setSystemUiVisibility(flags);
            }
        });
    }

    public class AndroidBridge {

        @JavascriptInterface
        public void onAppDataReady() {
            finishStartupAndHideSplash();
        }

        @JavascriptInterface
        public int getSafeTopDp() {
            return safeTopDp;
        }

        @JavascriptInterface
        public String getAppVersion() {
            return appVersionName;
        }

        @JavascriptInterface
        public void openNativeSettings() {
            openNativeSettingsPanel();
        }

        @JavascriptInterface
        public String getNativePrefsJson() {
            return ReminderPrefs.toJsonString(getApplicationContext());
        }

        @JavascriptInterface
        public void setNativePref(String key, String value) {
            Context appCtx = getApplicationContext();
            ReminderPrefs.applyKeyValue(appCtx, key, value);
            TodayScheduleWidget.refreshAllWidgets(appCtx);
            CampusReminderManager.rescheduleFromCache(appCtx);
            runOnUiThread(() -> {
                if (rootLayout != null) {
                    try { rootLayout.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP); } catch (Exception ignored) {}
                }
                pullScheduleAndTasksForNative();
            });
        }

        @JavascriptInterface
        public void sendTestNotification() {
            triggerTestNotificationFromUi();
        }

        @JavascriptInterface
        public void syncCalendarFromNative() {
            triggerCalendarSyncFromUi();
        }

        @JavascriptInterface
        public void clearCalendarFromNative() {
            startCalendarClear();
        }

        @JavascriptInterface
        public void haptic(String type) {
            runOnUiThread(() -> {
                if (rootLayout == null) return;
                int code = HapticFeedbackConstants.KEYBOARD_TAP;
                if ("long".equalsIgnoreCase(type) || "heavy".equalsIgnoreCase(type)) {
                    code = HapticFeedbackConstants.LONG_PRESS;
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && "success".equalsIgnoreCase(type)) {
                    code = HapticFeedbackConstants.CONFIRM;
                }
                try { rootLayout.performHapticFeedback(code); } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void saveAuthData(String data) {
            try {
                SharedPreferences sp = getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE);
                sp.edit().putString("auth_cred", data != null ? data : "").apply();
                CookieManager.getInstance().flush();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String loadAuthData() {
            try {
                return getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE).getString("auth_cred", "");
            } catch (Exception ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public void clearAuthData() {
            try {
                getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE).edit().remove("auth_cred").apply();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void shareText(String title, String text) {
            try {
                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType("text/plain");
                if (title != null && !title.isEmpty()) shareIntent.putExtra(Intent.EXTRA_SUBJECT, title);
                shareIntent.putExtra(Intent.EXTRA_TEXT, text != null ? text : "");
                startActivity(Intent.createChooser(shareIntent, "分享到"));
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void saveBase64File(String base64Data, String fileName, String mimeType) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                boolean isIcs = (fileName != null && fileName.toLowerCase().endsWith(".ics"))
                        || (mimeType != null && mimeType.toLowerCase().contains("text/calendar"));
                if (isIcs) {
                    startCalendarIcsImport(bytes, fileName, mimeType);
                    return;
                }
                saveBytesToDownloads(bytes, fileName, mimeType != null ? mimeType : "text/plain");
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void importScheduleToCalendar(String scheduleJson) {
            if (scheduleJson == null || scheduleJson.trim().isEmpty()) return;
            startCalendarJsonImport(scheduleJson);
        }

        @JavascriptInterface
        public void openSystemCalendar() {
            runOnUiThread(() -> {
                if (!CalendarSyncHelper.openSystemCalendar(MainActivity.this)) {
                    Toast.makeText(MainActivity.this, "未能自动打开日历应用，请手动前往手机日历查看", Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void syncNativeScheduleAndTasks(String payloadJson) {
            if (payloadJson == null || payloadJson.trim().isEmpty()) return;
            Context appCtx = getApplicationContext();
            TodayScheduleWidget.savePayloadAndRefresh(appCtx, payloadJson);
            CampusReminderManager.scheduleUpcomingReminders(appCtx, payloadJson);
        }

        @JavascriptInterface
        public void syncTheme(boolean isDark) {
            saveDarkThemePref(isDark);
            applySystemBarsTheme(isDark);
            runOnUiThread(() -> applySplashTheme(isDark));
        }

        @JavascriptInterface
        public void reloadCloudPage() {
            runOnUiThread(() -> {
                if (webView != null) {
                    if (!isNetworkAvailable()) {
                        Toast.makeText(MainActivity.this, "仍未检测到网络连接，请检查 Wi-Fi 或移动数据", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    startCloudLoadWithSplash();
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openExternalBrowser(url);
        }

        @JavascriptInterface
        public void startAppUpdate(String apkUrl, String versionName) {
            if (apkUrl != null && apkUrl.startsWith("https://")) {
                runOnUiThread(() -> enqueueSystemDownload(
                        apkUrl, "XiaowuZhiliApp",
                        "校务智理_v" + (versionName != null ? versionName : "new") + ".apk",
                        "application/vnd.android.package-archive"
                ));
            }
        }

        @JavascriptInterface
        public void openLastReadyFile() {
            if (lastReadyUri == null) return;
            runOnUiThread(() -> {
                if (MIME_OPEN_CALENDAR.equalsIgnoreCase(lastReadyMime)) {
                    if (!CalendarSyncHelper.openSystemCalendar(MainActivity.this)) {
                        Toast.makeText(MainActivity.this, "请打开手机「日历」应用查看已同步课表", Toast.LENGTH_LONG).show();
                    }
                    return;
                }
                if ("application/vnd.android.package-archive".equalsIgnoreCase(lastReadyMime)) {
                    installApk(lastReadyUri);
                    return;
                }
                try {
                    Intent viewIntent = new Intent(Intent.ACTION_VIEW);
                    viewIntent.setDataAndType(lastReadyUri, lastReadyMime);
                    viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(viewIntent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "请到手机「下载/Download」目录查看", Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    private void saveBytesToDownloads(byte[] data, String fileName, String mimeType) throws IOException {
        Uri savedUri = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            savedUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (savedUri != null) {
                try (OutputStream os = resolver.openOutputStream(savedUri)) {
                    if (os != null) os.write(data);
                }
            }
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, fileName);
            try (FileOutputStream fos = new FileOutputStream(out)) {
                fos.write(data);
            }
            savedUri = Uri.fromFile(out);
        }
        promptOpenFile("文件已保存", "已保存至系统下载目录：" + fileName, savedUri, mimeType);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (uploadMessage == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK) {
                if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    int cnt = data.getClipData().getItemCount();
                    results = new Uri[cnt];
                    for (int i = 0; i < cnt; i++) results[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data != null && data.getDataString() != null) {
                    results = new Uri[]{Uri.parse(data.getDataString())};
                } else if (cameraPhotoUri != null) {
                    results = new Uri[]{cameraPhotoUri};
                }
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
            cameraPhotoUri = null;
        }
    }

    private void handleBackAction() {
        if (splashOverlay != null && splashOverlay.getVisibility() == View.VISIBLE) {
            long now = System.currentTimeMillis();
            if (now - lastBackPressTime < 2000) finish();
            else {
                lastBackPressTime = now;
                Toast.makeText(MainActivity.this, "正在加载中，再按一次退出校务智理", Toast.LENGTH_SHORT).show();
            }
            return;
        }
        if (webView != null) {
            webView.evaluateJavascript("window.__onAndroidBack ? window.__onAndroidBack() : 'exit'", value -> {
                if ("\"handled\"".equals(value)) return;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressTime < 2000) finish();
                    else {
                        lastBackPressTime = now;
                        Toast.makeText(MainActivity.this, "再按一次退出校务智理", Toast.LENGTH_SHORT).show();
                    }
                }
            });
            return;
        }
        finish();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            handleBackAction();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (slowLoadRunnable != null) mainHandler.removeCallbacks(slowLoadRunnable);
        if (hideSplashRunnable != null) mainHandler.removeCallbacks(hideSplashRunnable);
        if (progressAnimator != null) { progressAnimator.cancel(); progressAnimator = null; }
        if (bootBookView != null) bootBookView.stopAnimation();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && backInvokedCallbackObj instanceof OnBackInvokedCallback) {
            try { getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback((OnBackInvokedCallback) backInvokedCallbackObj); } catch (Exception ignored) {}
        }
        if (networkCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {}
            networkCallback = null;
        }
        if (downloadCompleteReceiver != null) {
            try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
            downloadCompleteReceiver = null;
        }
        if (webView != null) {
            try {
                webView.stopLoading();
                ViewGroup parent = (ViewGroup) webView.getParent();
                if (parent != null) parent.removeView(webView);
                webView.removeAllViews();
                webView.destroy();
            } catch (Exception ignored) {}
            webView = null;
        }
        super.onDestroy();
    }

    private int dpToPx(int dp) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, dp, getResources().getDisplayMetrics()));
    }
}

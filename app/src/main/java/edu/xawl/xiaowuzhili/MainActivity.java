package edu.xawl.xiaowuzhili;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 校务智理 v36 · 安卓端原生 WebView 容器 (支持 Android 7.0 ~ Android 16 / API 24-35)
 */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://messageweb.xyz";
    private static final String START_URL = "https://messageweb.xyz/index.html";
    private static final int FILE_CHOOSER_RESULT_CODE = 10001;

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> uploadMessage;
    private long lastBackPressTime = 0L;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                dpToPx(3)
        ));

        setContentView(root);
        applySystemBarsTheme(false);

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
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " XiaowuZhiliApp/36.0");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "https".equalsIgnoreCase(uri.getScheme())) {
                    String host = uri.getHost();
                    if ("messageweb.xyz".equalsIgnoreCase(host) || "www.messageweb.xyz".equalsIgnoreCase(host)) {
                        String path = uri.getPath();
                        if (path == null || path.isEmpty() || "/".equals(path)) {
                            path = "/index.html";
                        }
                        String assetPath = mapPathToAsset(path);
                        if (assetPath != null) {
                            try {
                                InputStream is = getAssets().open("web/" + assetPath);
                                String mime = guessMimeType(assetPath);
                                Map<String, String> headers = new HashMap<>();
                                headers.put("Access-Control-Allow-Origin", APP_ORIGIN);
                                headers.put("Cache-Control", "no-cache");
                                return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, is);
                            } catch (IOException ignored) {
                            }
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request);
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
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                }
                uploadMessage = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE);
                } catch (Exception e) {
                    uploadMessage = null;
                    return false;
                }
                return true;
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                if (url == null || url.startsWith("blob:")) {
                    return;
                }
                try {
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setMimeType(mimeType);
                    String cookies = CookieManager.getInstance().getCookie(url);
                    if (cookies != null) {
                        req.addRequestHeader("Cookie", cookies);
                    }
                    req.addRequestHeader("User-Agent", userAgent);
                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    req.setTitle(fileName);
                    req.setDescription("校务智理正在下载文件...");
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                    DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    if (dm != null) {
                        dm.enqueue(req);
                        Toast.makeText(MainActivity.this, "已开始下载：" + fileName, Toast.LENGTH_LONG).show();
                    }
                } catch (Exception e) {
                    openExternalBrowser(url);
                }
            }
        });

        webView.loadUrl(START_URL);
    }

    private String mapPathToAsset(String path) {
        switch (path) {
            case "/index.html":
                return "index.html";
            case "/style.css":
                return "style.css";
            case "/app.js":
                return "app.js";
            case "/config.js":
                return "config.js";
            case "/android-bridge.js":
                return "android-bridge.js";
            case "/manifest.json":
                return "manifest.json";
            case "/icon-192.png":
                return "icon-192.png";
            case "/icon-512.png":
                return "icon-512.png";
            default:
                return null;
        }
    }

    private String guessMimeType(String assetName) {
        if (assetName.endsWith(".html")) return "text/html";
        if (assetName.endsWith(".css")) return "text/css";
        if (assetName.endsWith(".js")) return "application/javascript";
        if (assetName.endsWith(".json")) return "application/json";
        if (assetName.endsWith(".png")) return "image/png";
        return "text/plain";
    }

    private void openExternalBrowser(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception ignored) {
        }
    }

    private void applySystemBarsTheme(final boolean isDark) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Window window = getWindow();
                if (window == null) return;
                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                int statusColor = isDark ? Color.parseColor("#0B1120") : Color.parseColor("#1677FF");
                int navColor = isDark ? Color.parseColor("#0B1120") : Color.parseColor("#FFFFFF");
                window.setStatusBarColor(statusColor);
                window.setNavigationBarColor(navColor);
            }
        });
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void saveAuthData(String data) {
            try {
                SharedPreferences sp = getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE);
                sp.edit().putString("auth_cred", data != null ? data : "").apply();
                CookieManager.getInstance().flush();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String loadAuthData() {
            try {
                SharedPreferences sp = getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE);
                return sp.getString("auth_cred", "");
            } catch (Exception ignored) {
                return "";
            }
        }

        @JavascriptInterface
        public void clearAuthData() {
            try {
                SharedPreferences sp = getSharedPreferences("xiaowu_auth_prefs", MODE_PRIVATE);
                sp.edit().remove("auth_cred").apply();
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void saveBase64File(String base64Data, String fileName, String mimeType) {
            try {
                byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                saveBytesToDownloads(bytes, fileName, mimeType != null ? mimeType : "text/plain");
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "保存失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }

        @JavascriptInterface
        public void syncTheme(boolean isDark) {
            applySystemBarsTheme(isDark);
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openExternalBrowser(url);
        }
    }

    private void saveBytesToDownloads(byte[] data, String fileName, String mimeType) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("无法创建下载条目");
            try (OutputStream os = resolver.openOutputStream(uri)) {
                if (os == null) throw new IOException("无法写入文件流");
                os.write(data);
                os.flush();
            }
        } else {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists()) dir.mkdirs();
            File outFile = new File(dir, fileName);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(data);
                fos.flush();
            }
        }
        runOnUiThread(() -> Toast.makeText(MainActivity.this, "已保存到手机「下载/Download」目录：" + fileName, Toast.LENGTH_LONG).show());
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_DOWN) {
            handleSmartBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void handleSmartBack() {
        if (webView == null) {
            finish();
            return;
        }
        webView.evaluateJavascript("window.__xiaowuHandleBack ? window.__xiaowuHandleBack() : 'exit'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value != null && !value.contains("exit")) {
                    return;
                }
                if (webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                long now = System.currentTimeMillis();
                if (now - lastBackPressTime < 2000) {
                    finish();
                } else {
                    lastBackPressTime = now;
                    Toast.makeText(MainActivity.this, "再按一次退出校务智理", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (uploadMessage == null) return;
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
        }
    }

    private int dpToPx(int dp) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
}

/**
 * 文理智办 v36 · Android WebView 原生桥接与手机端安装下载增强脚本
 * 1. 解决安卓 WebView 内 Blob (URL.createObjectURL) 导出咨询记录无法下载的问题
 * 2. 适配安卓 13/14/15/16 手势返回（优先关闭弹窗 -> 收起侧边抽屉 -> 回到工作台首页 -> 双击退出）
 * 3. 自动同步深色/浅色主题至安卓原生状态栏与导航栏
 * 4. 在普通手机浏览器访问时提供“安装到手机桌面 / 下载安卓客户端”快捷入口
 */
(function () {
  var isAndroidApp = typeof window.AndroidBridge !== "undefined" || /WenliZhibanApp/i.test(navigator.userAgent);

  // 1. 拦截并增强 Blob 文件下载（兼容 app.js 中导出“文理智办咨询记录_YYYY-MM-DD.txt”）
  var blobStore = new Map();
  var origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    var url = origCreateObjectURL(blob);
    if (blob instanceof Blob) {
      blobStore.set(url, blob);
    }
    return url;
  };

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var href = this.getAttribute("href") || this.href || "";
    var downloadName = this.getAttribute("download") || ("文理智办导出文件_" + new Date().toISOString().slice(0, 10) + ".txt");
    if (isAndroidApp && window.AndroidBridge && href.indexOf("blob:") === 0) {
      var blob = blobStore.get(href);
      if (blob) {
        var reader = new FileReader();
        reader.onloadend = function () {
          try {
            var base64data = String(reader.result || "");
            var commaIdx = base64data.indexOf(",");
            if (commaIdx !== -1) base64data = base64data.slice(commaIdx + 1);
            window.AndroidBridge.saveBase64File(base64data, downloadName, blob.type || "text/plain;charset=utf-8");
          } catch (e) {
            console.error("AndroidBridge saveBase64File failed:", e);
          }
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
    return origClick.apply(this, arguments);
  };

  // 2. 安卓物理返回键 / 全面屏侧滑返回智能处理
  window.__wenliHandleBack = function () {
    try {
      // (a) 优先关闭打开的 <dialog> 弹窗（制度阅读器、个人设置、AI待办确认、通知详情等）
      var openDialogs = document.querySelectorAll("dialog[open]");
      if (openDialogs && openDialogs.length > 0) {
        var topDialog = openDialogs[openDialogs.length - 1];
        topDialog.close();
        return "closed_dialog";
      }
      // (b) 若移动端侧边栏抽屉打开，先收起抽屉
      var sidebar = document.getElementById("sidebar");
      if (sidebar && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
        return "closed_sidebar";
      }
      // (c) 若已登录且当前在子栏目（通知/待办/AI/制度库等），返回“工作台总览”首页
      var authSec = document.getElementById("auth");
      var isLoggedIn = authSec && authSec.classList.contains("hide");
      var homePage = document.getElementById("homePage");
      if (isLoggedIn && homePage && homePage.classList.contains("hide")) {
        var homeNav = document.querySelector('.nav[data-page="home"]');
        if (homeNav) {
          homeNav.click();
          return "navigated_home";
        }
      }
    } catch (e) {}
    return "exit";
  };

  // 3. 状态栏主题同步
  function syncNativeTheme() {
    if (isAndroidApp && window.AndroidBridge && window.AndroidBridge.syncTheme) {
      var isDark = document.documentElement.classList.contains("dark") || localStorage.getItem("xz_theme") === "dark";
      try {
        window.AndroidBridge.syncTheme(!!isDark);
      } catch (e) {}
    }
  }
  document.addEventListener("DOMContentLoaded", function () {
    syncNativeTheme();
    var themeBtn = document.getElementById("themeToggle");
    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        setTimeout(syncNativeTheme, 50);
      });
    }
  });

  // 4. 在普通浏览器中提供 PWA 桌面安装与 APK 下载按钮（在 App 内自动隐藏）
  var deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    updateInstallButtons();
  });

  function triggerAppDownloadOrInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () {
        deferredPrompt = null;
      });
      return;
    }
    // 触发 APK 直接下载
    var a = document.createElement("a");
    a.href = "/wenli-zhiban.apk";
    a.download = "校务智理_v36.apk";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function updateInstallButtons() {
    if (isAndroidApp) return;
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;

    // 登录框底部注入下载按钮
    var authForm = document.getElementById("authForm");
    if (authForm && !document.getElementById("downloadAppBtnAuth")) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.id = "downloadAppBtnAuth";
      btn.className = "demo-login-link";
      btn.style.cssText = "margin-top:6px;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:#155eef;font-weight:600;";
      btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-download"/></svg><span>下载安卓手机客户端 (.apk)</span>';
      btn.onclick = triggerAppDownloadOrInstall;
      var hint = authForm.querySelector(".hint");
      if (hint) {
        authForm.insertBefore(btn, hint);
      } else {
        authForm.appendChild(btn);
      }
    }

    // 侧边栏底部注入下载按钮
    var sideBottom = document.querySelector("#sidebar .sidebottom");
    if (sideBottom && !document.getElementById("downloadAppBtnSide")) {
      var sbtn = document.createElement("button");
      sbtn.type = "button";
      sbtn.id = "downloadAppBtnSide";
      sbtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-download"/></svg>下载安卓手机客户端';
      sbtn.onclick = triggerAppDownloadOrInstall;
      sideBottom.insertBefore(sbtn, sideBottom.firstChild);
    }
  }

  if (!isAndroidApp) {
    if ("serviceWorker" in navigator && /^https?:/i.test(location.protocol)) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      });
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", updateInstallButtons);
    } else {
      updateInstallButtons();
    }
  }
})();

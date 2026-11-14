/**
 * 校务智理 v36 · Android WebView 原生桥接、长期保存登录态与移动端下载增强脚本
 * 1. 长期保存登录信息（localStorage + Cookie + 安卓原生 SharedPreferences 三重持久化）
 * 2. 登录表单增加“记住登录信息（自动续期）”选项，支持浏览器密码管理器及 Token 过期静默重登
 * 3. 解决安卓 WebView 内 Blob 导出咨询记录无法下载的问题
 * 4. 适配安卓 13/14/15/16 手势返回与深色状态栏同步
 * 5. 严格仅在手机/移动端浏览器展示“下载安卓手机客户端 (.apk)”入口，电脑端不显示
 */
(function () {
  var isAndroidApp = typeof window.AndroidBridge !== "undefined" || /XiaowuZhiliApp/i.test(navigator.userAgent);
  var CRED_KEY = "xz_saved_cred_v1";
  var LOGOUT_FLAG = "xz_manual_logout_v1";

  // ---------------------------------------------------------
  // 0. 长期保存登录信息（Cookie 备份 + 安卓原生 SharedPreferences）
  // ---------------------------------------------------------
  function setCookie(name, value, days) {
    try {
      var expires = "";
      if (days) {
        var date = new Date();
        date.setTime(date.getTime() + days * 86400000);
        expires = "; expires=" + date.toUTCString();
      }
      document.cookie = name + "=" + encodeURIComponent(value || "") + expires + "; path=/; SameSite=Lax";
    } catch (e) {}
  }

  function getCookie(name) {
    try {
      var nameEQ = name + "=";
      var ca = document.cookie.split(";");
      for (var i = 0; i < ca.length; i++) {
        var c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length));
      }
    } catch (e) {}
    return "";
  }

  function encodeCred(obj) {
    try {
      var json = JSON.stringify(obj);
      return btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      return "";
    }
  }

  function decodeCred(str) {
    try {
      if (!str) return null;
      var json = decodeURIComponent(escape(atob(str)));
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function saveCredEverywhere(credObj) {
    var raw = encodeCred(credObj);
    if (!raw) return;
    try { localStorage.setItem(CRED_KEY, raw); } catch (e) {}
    setCookie(CRED_KEY, raw, 365);
    if (credObj.token) {
      try { localStorage.setItem("xz_token", credObj.token); } catch (e) {}
      setCookie("xz_token_bak", credObj.token, 365);
    }
    if (isAndroidApp && window.AndroidBridge && window.AndroidBridge.saveAuthData) {
      try { window.AndroidBridge.saveAuthData(raw); } catch (e) {}
    }
  }

  function loadCredFromAny() {
    var raw = "";
    try { raw = localStorage.getItem(CRED_KEY) || ""; } catch (e) {}
    if (!raw) raw = getCookie(CRED_KEY);
    if (!raw && isAndroidApp && window.AndroidBridge && window.AndroidBridge.loadAuthData) {
      try { raw = window.AndroidBridge.loadAuthData() || ""; } catch (e) {}
    }
    return decodeCred(raw);
  }

  function clearSavedPassword() {
    var cur = loadCredFromAny();
    if (cur && cur.username) {
      saveCredEverywhere({ username: cur.username, password: "", token: "", remember: false });
    } else {
      try { localStorage.removeItem(CRED_KEY); } catch (e) {}
      setCookie(CRED_KEY, "", -1);
      if (isAndroidApp && window.AndroidBridge && window.AndroidBridge.clearAuthData) {
        try { window.AndroidBridge.clearAuthData(); } catch (e) {}
      }
    }
    setCookie("xz_token_bak", "", -1);
  }

  // 启动时尽早把备份 Token 同步回 localStorage（在 app.js 读取 xz_token 之前执行）
  (function bootstrapTokenBeforeApp() {
    try {
      var curTok = localStorage.getItem("xz_token");
      if (!curTok) {
        var cred = loadCredFromAny();
        var bakTok = (cred && cred.token) || getCookie("xz_token_bak");
        if (bakTok && !sessionStorage.getItem(LOGOUT_FLAG)) {
          localStorage.setItem("xz_token", bakTok);
          curTok = bakTok;
        }
      }
      if (curTok && !sessionStorage.getItem(LOGOUT_FLAG)) {
        document.documentElement.classList.add("has-saved-auth");
      }
    } catch (e) {}
  })();

  // 劫持 fetch，实现登录凭据自动捕获 & Token 过期静默续期
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var lastSubmittedCred = null;
  var silentRenewing = false;

  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      var isAuthEndpoint = /\/api\/auth\/(login|register)$/.test(url);

      if (isAuthEndpoint && init && typeof init.body === "string") {
        try {
          var parsedBody = JSON.parse(init.body);
          if (parsedBody && parsedBody.username && parsedBody.password) {
            lastSubmittedCred = {
              username: String(parsedBody.username),
              password: String(parsedBody.password)
            };
          }
        } catch (e) {}
      }

      return origFetch(input, init).then(function (resp) {
        if (isAuthEndpoint && resp.ok && lastSubmittedCred) {
          resp.clone().json().then(function (data) {
            if (data && data.token) {
              sessionStorage.removeItem(LOGOUT_FLAG);
              document.documentElement.classList.add("has-saved-auth");
              saveCredEverywhere({
                username: lastSubmittedCred.username,
                password: lastSubmittedCred.password,
                token: data.token,
                remember: true
              });
            }
          }).catch(function () {});
        } else if ((resp.status === 401 || resp.status === 403) && !isAuthEndpoint && !silentRenewing && !sessionStorage.getItem(LOGOUT_FLAG)) {
          // 如果 Token 过期，尝试用已保存的凭据静默重登一次
          var saved = loadCredFromAny();
          if (saved && saved.remember && saved.username && saved.password) {
            silentRenewing = true;
            var apiBase = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) ? window.XZ_CONFIG.API_BASE : "https://api.messageweb.xyz/api";
            origFetch(apiBase + "/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: saved.username, password: saved.password })
            }).then(function (r2) { return r2.ok ? r2.json() : null; })
              .then(function (d2) {
                silentRenewing = false;
                if (d2 && d2.token) {
                  saveCredEverywhere({
                    username: saved.username,
                    password: saved.password,
                    token: d2.token,
                    remember: true
                  });
                  location.reload();
                }
              }).catch(function () { silentRenewing = false; });
          }
        }
        return resp;
      });
    };
  }

  function setupRememberUI() {
    // 自动回填已保存的账号密码（无需勾选框，默认永久记住）
    var saved = loadCredFromAny();
    var uEl = document.getElementById("username");
    var pEl = document.getElementById("password");
    if (saved) {
      if (uEl && !uEl.value && saved.username) uEl.value = saved.username;
      if (pEl && !pEl.value && saved.password) pEl.value = saved.password;
    }

    // 监听手动退出登录：移除免闪烁标记并清除当前 Token，防止退出后立刻自动重登
    var logoutBtn = document.getElementById("logout");
    if (logoutBtn && !logoutBtn.dataset.persistHooked) {
      logoutBtn.dataset.persistHooked = "1";
      logoutBtn.addEventListener("click", function () {
        document.documentElement.classList.remove("has-saved-auth");
        sessionStorage.setItem(LOGOUT_FLAG, "1");
        setCookie("xz_token_bak", "", -1);
        var cur = loadCredFromAny();
        if (cur) {
          cur.token = "";
          saveCredEverywhere(cur);
        }
      });
    }
  }

  // ---------------------------------------------------------
  // 1. 拦截并增强 Blob 文件下载（兼容导出咨询记录 .txt）
  // ---------------------------------------------------------
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
    var downloadName = this.getAttribute("download") || ("校务智理导出文件_" + new Date().toISOString().slice(0, 10) + ".txt");
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

  // ---------------------------------------------------------
  // 2. 安卓物理返回键 / 全面屏侧滑返回智能处理
  // ---------------------------------------------------------
  window.__xiaowuHandleBack = function () {
    try {
      var openDialogs = document.querySelectorAll("dialog[open]");
      if (openDialogs && openDialogs.length > 0) {
        openDialogs[openDialogs.length - 1].close();
        return "closed_dialog";
      }
      var sidebar = document.getElementById("sidebar");
      if (sidebar && sidebar.classList.contains("open")) {
        sidebar.classList.remove("open");
        return "closed_sidebar";
      }
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

  // ---------------------------------------------------------
  // 3. 状态栏主题同步
  // ---------------------------------------------------------
  function syncNativeTheme() {
    if (isAndroidApp && window.AndroidBridge && window.AndroidBridge.syncTheme) {
      var isDark = document.documentElement.classList.contains("dark") || localStorage.getItem("xz_theme") === "dark";
      try {
        window.AndroidBridge.syncTheme(!!isDark);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------
  // 4. 严格仅在移动端浏览器显示“下载安卓手机客户端 (.apk)”按钮，电脑端绝不显示
  // ---------------------------------------------------------
  function isMobileBrowser() {
    var ua = navigator.userAgent || "";
    // 明确排除所有 Windows / Mac / 桌面 Linux 电脑（防止触屏笔记本或分屏窄窗口误判）
    if (/Windows NT|Win64|WOW64|Macintosh|Mac OS X|CrOS|Linux x86_64/i.test(ua) && !/Android|HarmonyOS/i.test(ua)) {
      return false;
    }
    return /Android|HarmonyOS|iPhone|iPad|iPod|Mobile/i.test(ua);
  }

  function handleApkClick(e) {
    var ua = navigator.userAgent || "";
    if (/MicroMessenger|QQ\//i.test(ua)) {
      e.preventDefault();
      alert("微信/QQ 内置浏览器不支持直接下载安装包，请点击右上角「···」选择「在浏览器中打开」后再下载安装。");
      return false;
    }
    return true;
  }

  function updateInstallButtons() {
    if (isAndroidApp) return;
    if (!isMobileBrowser()) return;
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;

    var authForm = document.getElementById("authForm");
    if (authForm && !document.getElementById("downloadAppBtnAuth")) {
      var btn = document.createElement("a");
      btn.id = "downloadAppBtnAuth";
      btn.href = "/xiaowu-zhili.apk";
      btn.setAttribute("download", "校务智理.apk");
      btn.className = "demo-login-link";
      btn.style.cssText = "margin-top:6px;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:#1677ff;font-weight:600;text-decoration:none;";
      btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-download"/></svg><span>下载安卓手机客户端 (.apk)</span>';
      btn.onclick = handleApkClick;
      var hint = authForm.querySelector(".hint");
      if (hint) {
        authForm.insertBefore(btn, hint);
      } else {
        authForm.appendChild(btn);
      }
    }

    var sideBottom = document.querySelector("#sidebar .sidebottom");
    if (sideBottom && !document.getElementById("downloadAppBtnSide")) {
      var sbtn = document.createElement("a");
      sbtn.id = "downloadAppBtnSide";
      sbtn.href = "/xiaowu-zhili.apk";
      sbtn.setAttribute("download", "校务智理.apk");
      sbtn.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:10px;color:inherit;text-decoration:none;font-size:14px;";
      sbtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-download"/></svg>下载安卓手机客户端';
      sbtn.onclick = handleApkClick;
      sideBottom.insertBefore(sbtn, sideBottom.firstChild);
    }
  }

  function onDomReady() {
    setupRememberUI();
    syncNativeTheme();
    var themeBtn = document.getElementById("themeToggle");
    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        setTimeout(syncNativeTheme, 50);
      });
    }
    if (!isAndroidApp) {
      updateInstallButtons();
    }
  }

  if (!isAndroidApp && "serviceWorker" in navigator && /^https?:/i.test(location.protocol)) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady);
  } else {
    onDomReady();
  }
})();

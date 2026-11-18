/**
 * 校务智理 v36 · Android WebView 原生桥接、长期保存登录态与移动端下载增强脚本
 * 1. 长期保存登录信息（localStorage + Cookie + 安卓原生 SharedPreferences 三重持久化）
 * 2. 登录表单增加“记住登录信息（自动续期）”选项，支持浏览器密码管理器及 Token 过期静默重登
 * 3. 解决安卓 WebView 内 Blob 导出咨询记录无法下载的问题
 * 4. 适配安卓 13/14/15/16 手势返回与深色状态栏同步
 * 5. 严格仅在手机/移动端浏览器展示“下载安卓端应用 (.apk)”入口，电脑端不显示
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
  
  // ---------------------------------------------------------
  // 5. v58 App 实用功能：下拉刷新（非AI页生效）+ 制度/AI内容原生分享
  // ---------------------------------------------------------
  if (isAndroidApp) {
    // (A) Gemini 风格圆环下拉刷新（仅在非 AI 页面、且页面处于顶部时触发）
    var ptrStartY = 0;
    var ptrPulling = false;
    var ptrRefreshing = false;
    var ptrBar = null;

    function ensurePtrBar() {
      if (!ptrBar) {
        ptrBar = document.createElement("div");
        ptrBar.className = "app-ptr-bar";
        ptrBar.setAttribute("aria-hidden", "true");
        ptrBar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/></svg>';
        document.body.appendChild(ptrBar);
      }
      return ptrBar;
    }

    document.addEventListener("touchstart", function (e) {
      if (ptrRefreshing) return;
      if (document.body.classList.contains("on-ai-page")) return;
      if (document.querySelector("dialog[open]")) return;
      if ((window.scrollY || document.documentElement.scrollTop || 0) <= 2 && e.touches && e.touches.length === 1) {
        ptrStartY = e.touches[0].clientY;
        ptrPulling = true;
      } else {
        ptrPulling = false;
      }
    }, { passive: true });

    document.addEventListener("touchmove", function (e) {
      if (!ptrPulling || ptrRefreshing || !e.touches || !e.touches.length) return;
      var dy = e.touches[0].clientY - ptrStartY;
      if (dy > 18 && (window.scrollY || 0) <= 2) {
        var bar = ensurePtrBar();
        var progress = Math.min(1, (dy - 18) / 72);
        var offset = Math.min(28, Math.round((dy - 18) * 0.36));
        var scale = (0.82 + 0.18 * progress).toFixed(2);
        bar.classList.remove("is-spinning");
        bar.classList.add("visible", "is-pulling");
        bar.style.transform = "translate(-50%, " + offset + "px) scale(" + scale + ")";
        var svg = bar.querySelector("svg");
        if (svg) svg.style.transform = "rotate(" + Math.round(progress * 270) + "deg)";
      }
    }, { passive: true });

    document.addEventListener("touchend", function (e) {
      if (!ptrPulling) return;
      ptrPulling = false;
      var endY = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].clientY : ptrStartY;
      var dy = endY - ptrStartY;
      if (dy > 85 && (window.scrollY || 0) <= 2 && typeof window.refresh === "function") {
        var bar = ensurePtrBar();
        ptrRefreshing = true;
        bar.classList.remove("is-pulling");
        bar.classList.add("visible", "is-spinning");
        bar.style.transform = "translate(-50%, 16px) scale(1)";
        var svg = bar.querySelector("svg");
        if (svg) svg.style.transform = "";
        Promise.resolve(window.refresh()).finally(function () {
          setTimeout(function () {
            ptrRefreshing = false;
            if (ptrBar) {
              ptrBar.classList.remove("visible", "is-spinning");
              ptrBar.style.transform = "translate(-50%, -54px) scale(.82)";
            }
          }, 260);
        });
      } else if (ptrBar) {
        ptrBar.classList.remove("visible", "is-pulling");
        ptrBar.style.transform = "translate(-50%, -54px) scale(.82)";
      }
    }, { passive: true });

    // (B) 制度阅读器与 AI 回复一键系统原生分享
    document.addEventListener("DOMContentLoaded", function () {
      var docActions = document.querySelector("#docDialog .doc-reader-tools") || document.querySelector(".doc-reader-actions");
      var mShare = document.getElementById("docMobileShareBtn");
      if (mShare) {
        mShare.classList.remove("hide");
        mShare.onclick = function () {
          var mPop = document.getElementById("docMobileMorePop");
          if (mPop) mPop.classList.remove("open");
          var titleEl = document.getElementById("docDialogTitle");
          var bodyEl = document.getElementById("docDialogBody");
          var urlEl = document.getElementById("docDialogUrl");
          var title = titleEl ? titleEl.textContent : "校务制度文件";
          var text = (bodyEl ? bodyEl.innerText : "").slice(0, 1200);
          var url = (urlEl && !urlEl.classList.contains("hide")) ? urlEl.href : "";
          var shareBody = "【" + title + "】\n" + text + (url ? "\n官网原文：" + url : "");
          if (window.AndroidBridge && window.AndroidBridge.shareText) window.AndroidBridge.shareText(title, shareBody);
        };
      }
      if (docActions && !document.getElementById("appShareDocBtn")) {
        var sBtn = document.createElement("button");
        sBtn.type = "button";
        sBtn.id = "appShareDocBtn";
        sBtn.className = "doc-icon-btn";
        sBtn.title = "分享";
        sBtn.setAttribute("aria-label", "分享");
        sBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-share"/></svg>';
        sBtn.onclick = function () {
          var titleEl = document.getElementById("docDialogTitle");
          var bodyEl = document.getElementById("docDialogBody");
          var urlEl = document.getElementById("docDialogUrl");
          var title = titleEl ? titleEl.textContent : "校务制度文件";
          var text = (bodyEl ? bodyEl.innerText : "").slice(0, 1200);
          var url = (urlEl && !urlEl.classList.contains("hide")) ? urlEl.href : "";
          var shareBody = "【" + title + "】\n" + text + (url ? "\n官网原文：" + url : "");
          if (window.AndroidBridge && window.AndroidBridge.shareText) {
            window.AndroidBridge.shareText(title, shareBody);
          }
        };
        var aiDocBtn = document.getElementById("askAiDocBtnTop") || document.getElementById("askAiDocBtn");
        docActions.insertBefore(sBtn, aiDocBtn || docActions.lastElementChild);
      }

      // 为每条 AI 回答自动附带“分享”按钮
      var msgBox = document.getElementById("messages");
      if (msgBox) {
        new MutationObserver(function () {
          msgBox.querySelectorAll(".bubble-wrap.msg-ai .bubble-tools").forEach(function (actBar) {
            if (actBar.querySelector(".app-share-msg-btn")) return;
            var msgEl = actBar.closest(".bubble-wrap");
            var bubble = msgEl ? msgEl.querySelector(".bubble") : null;
            if (!bubble) return;
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "app-share-msg-btn";
            btn.innerHTML = '<svg class="ico ico-xs" aria-hidden="true"><use href="#i-share"/></svg>分享';
            btn.onclick = function () {
              var txt = (bubble.innerText || "").trim();
              if (txt && window.AndroidBridge && window.AndroidBridge.shareText) {
                window.AndroidBridge.shareText("校务智理 AI 解答", txt);
              }
            };
            actBar.appendChild(btn);
          });
        }).observe(msgBox, { childList: true, subtree: true });
      }
    });
  }


  // ---------------------------------------------------------
  // 6. v1.007: 网页同款 UI 接管 App 新版本轻提示（方案1）与文件打开弹窗
  // ---------------------------------------------------------
  window.__onAppUpdateAvailable = function (versionName, apkUrl, notes) {
    try {
      var openUpdateDialog = function () {
        var cleanNotes = String(notes || "").replace(/^v?\d+\.\d+\s*[：:]\s*/i, "").trim();
        var msg = cleanNotes || "优化了校规文件库与公文阅读排版，提升整体界面视觉与操作流畅度。";
        if (typeof window.ui_confirm === "function") {
          window.ui_confirm(msg, {
            title: "发现新版本 v" + versionName,
            sub: "推荐更新以获得更佳阅读与使用体验",
            okText: "立即更新",
            cancelText: "稍后再说",
            danger: false
          }).then(function (ok) {
            if (ok && window.AndroidBridge && window.AndroidBridge.startAppUpdate) {
              window.AndroidBridge.startAppUpdate(apkUrl, versionName);
            }
          });
        }
      };

      var sideBottom = document.querySelector("#sidebar .sidebottom");
      if (sideBottom && !document.getElementById("appSideUpdateBtn")) {
        var ubtn = document.createElement("button");
        ubtn.type = "button";
        ubtn.id = "appSideUpdateBtn";
        ubtn.title = "点击更新到 v" + versionName;
        ubtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-download"/></svg><span>新版本 v' + versionName + '</span><i class="update-dot"></i>';
        ubtn.onclick = openUpdateDialog;
        sideBottom.insertBefore(ubtn, sideBottom.firstChild);
      }

      if (!document.getElementById("appUpdateBanner")) {
        var bar = document.createElement("div");
        bar.id = "appUpdateBanner";
        bar.className = "app-update-banner";
        bar.innerHTML =
          '<span class="app-update-banner-txt">发现新版本 v' + versionName + '</span>' +
          '<div class="app-update-banner-actions">' +
          '<button type="button" class="app-update-go">查看更新</button>' +
          '<button type="button" class="app-update-close" aria-label="关闭">×</button>' +
          '</div>';
        document.body.appendChild(bar);
        bar.querySelector(".app-update-go").onclick = function () {
          bar.classList.remove("show");
          openUpdateDialog();
        };
        bar.querySelector(".app-update-close").onclick = function () {
          bar.classList.remove("show");
        };
        setTimeout(function () { bar.classList.add("show"); }, 80);
        setTimeout(function () { bar.classList.remove("show"); }, 5200);
      }
    } catch (e) {}
  };

  window.__onAppFileReady = function (title, msg) {
    try {
      if (typeof window.ui_confirm === "function") {
        window.ui_confirm(msg || "文件已保存到手机「下载/Download」目录，是否立即打开查看？", {
          title: title || "文件已就绪",
          okText: "立即打开",
          danger: false
        }).then(function (ok) {
          if (ok && window.AndroidBridge && window.AndroidBridge.openLastReadyFile) {
            window.AndroidBridge.openLastReadyFile();
          }
        });
      }
    } catch (e) {}
  };


  (function injectGeminiUiStyle() {
    if (document.getElementById("xzGeminiUiStyle")) return;
    var st = document.createElement("style");
    st.id = "xzGeminiUiStyle";
    st.textContent = ""
      + ".app-ptr-bar{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:50%;width:38px;height:38px;padding:0;border-radius:50%;background:var(--card,#fff);border:1px solid var(--line,#e2e8f0);box-shadow:0 4px 16px rgba(15,23,42,.12);display:flex;align-items:center;justify-content:center;z-index:1200;opacity:0;pointer-events:none;transform:translate(-50%,-54px) scale(.82);transition:transform .22s cubic-bezier(.22,1,.36,1),opacity .18s ease;}"
      + ".app-ptr-bar.visible{opacity:1;}"
      + ".app-ptr-bar.is-pulling{transition:none;}"
      + ".app-ptr-bar svg{width:20px;height:20px;display:block;color:var(--blue,#155eef);transition:transform .1s linear;}"
      + ".app-ptr-bar.is-spinning svg{animation:xzPtrSpin .75s linear infinite;}"
      + "@keyframes xzPtrSpin{to{transform:rotate(360deg);}}"
      + ".toast{top:auto !important;bottom:calc(28px + env(safe-area-inset-bottom,0px)) !important;left:50% !important;transform:translate(-50%,16px) scale(.96) !important;background:#ffffff !important;color:#0f172a !important;border:1px solid #e2e8f0 !important;border-radius:999px !important;padding:9px 16px !important;font-size:13.5px !important;font-weight:500 !important;line-height:1.4 !important;box-shadow:0 8px 28px rgba(15,23,42,.12) !important;display:inline-flex !important;align-items:center !important;gap:8px !important;max-width:min(360px,calc(100vw - 32px)) !important;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}"
      + ".toast.show{transform:translate(-50%,0) scale(1) !important;}"
      + "html.dark .toast{background:#1e293b !important;color:#f8fafc !important;border-color:#334155 !important;box-shadow:0 10px 28px rgba(0,0,0,.38) !important;}"
      + ".toast-ico{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;font-size:11px;font-weight:700;}"
      + ".toast-ico.ok{background:#dcfce7;color:#15803d;}"
      + ".toast-ico.warn{background:#fee2e2;color:#dc2626;}"
      + ".toast-ico.info{background:#dbeafe;color:#1d4ed8;}"
      + "html.dark .toast-ico.ok{background:rgba(34,197,94,.18);color:#4ade80;}"
      + "html.dark .toast-ico.warn{background:rgba(239,68,68,.18);color:#f87171;}"
      + "html.dark .toast-ico.info{background:rgba(59,130,246,.2);color:#60a5fa;}"
      + "@media (max-width:760px){.toast{bottom:calc(76px + env(safe-area-inset-bottom,0px)) !important;}body.on-ai-page .toast{bottom:calc(132px + env(safe-area-inset-bottom,0px)) !important;}}";
    (document.head || document.documentElement).appendChild(st);
  })();
})();

  // 劫持 fetch，实现登录凭据自动捕获 & Token 过期无缝静默续期并重放请求
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var lastSubmittedCred = null;
  var renewPromise = null;

  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url ? input.url : "");
      var isAuthEndpoint = /\/api\/auth\/(login|register)$/.test(url);
      var alreadyRetried = !!(init && init.__xzRetried);

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
              saveCredEverywhere({
                username: lastSubmittedCred.username,
                password: lastSubmittedCred.password,
                token: data.token,
                remember: true
              });
            }
          }).catch(function () {});
          return resp;
        }
        if ((resp.status === 401 || resp.status === 403) && !isAuthEndpoint && !alreadyRetried && !sessionStorage.getItem(LOGOUT_FLAG)) {
          var saved = loadCredFromAny();
          if (saved && saved.remember && saved.username && saved.password) {
            if (!renewPromise) {
              var apiBase = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) ? window.XZ_CONFIG.API_BASE : "https://api.messageweb.xyz/api";
              renewPromise = origFetch(apiBase + "/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: saved.username, password: saved.password })
              }).then(function (r2) { return r2.ok ? r2.json() : null; })
                .then(function (d2) {
                  renewPromise = null;
                  if (d2 && d2.token) {
                    saveCredEverywhere({
                      username: saved.username,
                      password: saved.password,
                      token: d2.token,
                      remember: true
                    });
                    return d2.token;
                  }
                  return null;
                }).catch(function () {
                  renewPromise = null;
                  return null;
                });
            }
            return renewPromise.then(function (newTok) {
              if (!newTok) return resp;
              var nextInit = Object.assign({}, init || {}, { __xzRetried: true });
              var hdrs = new Headers((init && init.headers) || (typeof input !== "string" && input && input.headers) || undefined);
              if (hdrs.has("Authorization") || typeof input === "string") {
                hdrs.set("Authorization", "Bearer " + newTok);
              }
              nextInit.headers = hdrs;
              return origFetch(input, nextInit);
            });
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
      var isBooting = document.documentElement.classList.contains("app-booting");
      var authEl = document.getElementById("auth");
      var onAuth = !isBooting && authEl ? !authEl.classList.contains("hide") : false;
      var isDark = document.documentElement.classList.contains("dark") || localStorage.getItem("xz_theme") === "dark";
      try {
        window.AndroidBridge.syncTheme(!!(onAuth || isDark));
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------
  // 4. 严格仅在移动端浏览器显示“下载安卓端应用 (.apk)”按钮，电脑端绝不显示
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
      btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;gap:5px;color:var(--blue);font-size:13px;font-weight:600;font-family:inherit;text-decoration:none;";
      btn.innerHTML = '<svg class="ico" style="width:14px;height:14px;" aria-hidden="true"><use href="#i-download"/></svg><span>下载安卓端应用</span>';
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
      sbtn.style.cssText = "display:flex;align-items:center;gap:8px;padding:9px 14px;border-radius:var(--radius-sm);color:var(--muted);font-weight:600;min-height:38px;font-size:13px;font-family:inherit;text-decoration:none;text-align:left;box-sizing:border-box;width:100%;";
      sbtn.innerHTML = '<svg class="ico" style="width:15px;height:15px;opacity:.75;" aria-hidden="true"><use href="#i-download"/></svg>下载安卓端应用';
      sbtn.onclick = handleApkClick;
      sideBottom.insertBefore(sbtn, sideBottom.firstChild);
    }
  }

  function onDomReady() {
    setupRememberUI();
    syncNativeTheme();
    window.addEventListener("xz-theme-sync", function () {
      setTimeout(syncNativeTheme, 20);
    });
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

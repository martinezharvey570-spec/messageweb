// app.js — 校务智理（文理智办）前端核心逻辑
// 涵盖：原版简洁登录与演示账号一键登录、电脑端热门提问滚轮/拖拽/箭头滑动、移动端自适应体验、AI 回答步骤一键转待办、校规制度库检索、公文式原文阅读与AI解读（数量由后端接口实时下发）、通知收藏置顶与二次编辑、个人资料与密码管理
const API = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) || "/api";
const CHAT_CACHE_KEY = "xz_chat_cache_v1";
const STAR_NOTICES_KEY = "xz_starred_notices_v1";

let token = localStorage.getItem("xz_token") || "",
  me = null,
  notices = [],
  tasks = [],
  knowledgeDocs = [],
  allKnowledgeDocsCache = null,
  starredNoticeIds = new Set(),
  mode = "login",
  timer,
  kSearchTimer,
  chatHistory = [],
  currentDocViewing = null;

let knowledgeRequestSeq = 0;

// AI 生成状态：发送键在生成期间变成停止键，这里保存当前这轮的打断函数
let aiBusy = false;
let aiAbortHandler = null;
let aiTodoDraft = [];
let aiTodoSourceQuestion = "";

const $ = id => document.getElementById(id);
const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

// 全站线性图标：与 index.html 中的 symbol 图标集配套，动态拼接的内容也走同一套
function ico(name, cls = "") {
  // 实心星形的视觉边界比线性图标小，统一放大一档，见 .ico-star
  const star = name === "sparkles" ? " ico-star" : "";
  return `<svg class="ico${cls ? " " + cls : ""}${star}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function toast(s) {
  const el = $("toast");
  if (!el) return;
  el.textContent = s;
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("show"), 2600);
}

// 加载与保存通知收藏置顶状态
function loadStarredNotices() {
  try {
    const raw = localStorage.getItem(STAR_NOTICES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) starredNoticeIds = new Set(arr.map(Number));
    }
  } catch {}
}
function saveStarredNotices() {
  try {
    localStorage.setItem(STAR_NOTICES_KEY, JSON.stringify([...starredNoticeIds]));
  } catch {}
}
loadStarredNotices();

// 兼容安卓 WebView / 微信内置浏览器的剪贴板复制工具
async function copyTextSafe(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ====== 欢迎卡片 HTML 模板 ======
function getWelcomeMarkup(isReset = false) {
  return `<div class="bubble-wrap msg-ai">
    <div class="msg-meta">
      <span class="msg-avatar ai">${ico("sparkles")}</span>
      <span class="msg-sender">文理智办 AI</span>
    </div>
    <div class="bubble msg-ai welcome-bubble">
      <div class="welcome-bubble-head">
        <b>${isReset ? "对话已重置，随时为您服务！" : "你好！我是「文理智办」校园智能办事助手"}</b>
        <p>基于学校 ${kbTotalText()} 份正式规章制度与附件模板，为您梳理清晰的办事指南：</p>
      </div>
      <div class="welcome-grid">
        <div class="welcome-item">
          <span>${ico("clipboard")}</span>
          <div><b>材料清单</b><small>明确申请表与证明材料</small></div>
        </div>
        <div class="welcome-item">
          <span>${ico("route")}</span>
          <div><b>办理流程</b><small>理清找谁审、去哪办</small></div>
        </div>
        <div class="welcome-item">
          <span>${ico("pin")}</span>
          <div><b>制度依据</b><small>定位具体文件与条款</small></div>
        </div>
        <div class="welcome-item">
          <span>${ico("alert")}</span>
          <div><b>关键提醒</b><small>预警门槛与时间节点</small></div>
        </div>
      </div>
      <div class="welcome-foot">${ico("bulb","ico-xs")}可直接点击上方热门提问，或在下方输入您的具体问题。</div>
    </div>
  </div>`;
}

// ====== 轻量化本地保存与恢复聊天记录 ======
function saveChatToLocal() {
  try {
    const slim = chatHistory.slice(-30);
    localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify(slim));
  } catch {}
}

function restoreChatFromLocal() {
  try {
    const raw = localStorage.getItem(CHAT_CACHE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return;

    chatHistory = [];
    $("messages").innerHTML = getWelcomeMarkup(false);
    list.forEach(item => {
      if (!item || !item.content) return;
      const isUser = item.role === "学生" || item.role === "user";
      message(item.content, isUser ? "user" : "ai", item.sources || [], true, item.reasoning || "");
    });
  } catch {}
}

// ====== 主题模式初始化与切换 ======
function syncThemeButtons(isDark) {
  const btn = $("themeToggle");
  if (btn) btn.innerHTML = ico(isDark ? "sun" : "moon");
}

function initTheme() {
  try {
    const saved = localStorage.getItem("xz_theme");
    const isDark = saved === "dark";
    document.body.classList.toggle("dark", isDark);
    syncThemeButtons(isDark);
  } catch {}
}
initTheme();

function handleToggleTheme() {
  const isDark = document.body.classList.toggle("dark");
  try {
    localStorage.setItem("xz_theme", isDark ? "dark" : "light");
  } catch {}
  syncThemeButtons(isDark);
  toast(isDark ? "已切换至深色模式" : "已切换至浅色模式");
}
$("themeToggle")?.addEventListener("click", handleToggleTheme);

// 密码显示/隐藏按钮
$("togglePwd")?.addEventListener("click", () => {
  const pwd = $("password");
  if (!pwd) return;
  const isPwd = pwd.type === "password";
  pwd.type = isPwd ? "text" : "password";
  $("togglePwd").innerHTML = ico(isPwd ? "eye-off" : "eye");
});

// 统一后端请求封装
async function api(path, opt = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      ...opt,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(opt.headers || {})
      }
    });
  } catch {
    throw Error("无法连接后端，请确认网络或 API 服务状态。");
  }
  let d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.detail || "请求失败");
  return d;
}

// 登录/注册切换（完全保持最初版本的简洁文案）
function authMode(m) {
  mode = m;
  $("loginTab").classList.toggle("selected", m === "login");
  $("regTab").classList.toggle("selected", m === "register");
  $("nameWrap").classList.toggle("hide", m === "login");
  $("displayName").required = m === "register";
  $("authTitle").textContent = m === "login" ? "欢迎回来" : "创建学生账号";
  $("authDesc").textContent =
    m === "login"
      ? "登录后查看校园通知与个人待办"
      : "注册学生账号后即可使用全部功能";
  $("authSubmit").textContent = m === "login" ? "登录" : "注册并登录";
  $("quickDemoStudent")?.classList.toggle("hide", m !== "login");
}
$("loginTab").onclick = () => authMode("login");
$("regTab").onclick = () => authMode("register");

$("authForm").onsubmit = async e => {
  e.preventDefault();
  const submitBtn = $("authSubmit");
  const prevText = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "处理中…";
  try {
    let body = {
      username: $("username").value.trim(),
      password: $("password").value
    };
    if (mode === "register") {
      body.display_name = $("displayName").value.trim();
    }
    let d = await api(mode === "login" ? "/auth/login" : "/auth/register", {
      method: "POST",
      body: JSON.stringify(body)
    });
    token = d.token;
    try {
      localStorage.setItem("xz_token", token);
    } catch {}
    await enter();
  } catch (e) {
    toast(e.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevText;
  }
};

// “登入演示账号”快捷按钮
$("quickDemoStudent")?.addEventListener("click", () => {
  authMode("login");
  $("username").value = "demo_student";
  $("password").value = "demo123456";
  $("authForm").requestSubmit();
});

$("logout").onclick = () => {
  token = "";
  try {
    localStorage.removeItem("xz_token");
  } catch {}
  document.body.classList.remove("on-ai-page");
  $("app").classList.add("hide");
  $("auth").classList.remove("hide");
  authMode("login");
};

// ====== 个人资料与密码修改 ======
function openProfileModal() {
  if (!me) return;
  $("profUsername").value = me.username || "";
  $("profDisplayName").value = me.display_name || "";
  $("profCurrentPwd").value = "";
  $("profNewPwd").value = "";
  $("profileDialog")?.showModal();
}
$("userProfileBtn")?.addEventListener("click", openProfileModal);
$("openProfileSide")?.addEventListener("click", () => {
  sidebarEl.classList.remove("open");
  openProfileModal();
});
$("closeProfileDialog")?.addEventListener("click", () => $("profileDialog")?.close());
$("cancelProfileDialog")?.addEventListener("click", () => $("profileDialog")?.close());

$("profileForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const display_name = $("profDisplayName").value.trim();
  const current_password = $("profCurrentPwd").value;
  const new_password = $("profNewPwd").value;
  if (!display_name) return toast("显示姓名不能为空");
  if (new_password && !current_password) {
    return toast("修改密码时请填写当前密码");
  }
  try {
    const res = await api("/me", {
      method: "PATCH",
      body: JSON.stringify({
        display_name,
        ...(new_password ? { current_password, new_password } : {})
      })
    });
    me = res.user || { ...me, display_name };
    $("userName").textContent = me.display_name;
    $("welcomeName").textContent = me.display_name;
    $("avatar").textContent = me.display_name.slice(0, 1);
    $("profileDialog")?.close();
    toast(res.message || "个人资料已更新");
  } catch (err) {
    toast(err.message);
  }
});

// 侧边栏与移动端导航
const menuBtn = $("menu");
const sidebarEl = $("sidebar");
function toggleSidebar() {
  sidebarEl.classList.toggle("open");
}
menuBtn?.addEventListener("click", toggleSidebar);

document.addEventListener("click", e => {
  if (!sidebarEl.classList.contains("open")) return;
  if (!sidebarEl.contains(e.target) && e.target !== menuBtn) {
    sidebarEl.classList.remove("open");
  }
});

// 全局快捷键 Ctrl/Cmd + K 快速聚焦当前页面搜索框
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    if ($("auth") && !$("auth").classList.contains("hide")) return;
    e.preventDefault();
    if (!$("noticesPage")?.classList.contains("hide")) {
      $("search")?.focus();
    } else if (!$("tasksPage")?.classList.contains("hide")) {
      $("taskSearch")?.focus();
    } else if (!$("aiPage")?.classList.contains("hide")) {
      $("question")?.focus();
    } else {
      go("knowledge");
      setTimeout(() => $("knowledgeSearch")?.focus(), 40);
    }
  }
});

// 移动端 AI 参数折叠按钮
$("toggleAiConfig")?.addEventListener("click", () => {
  const bar = $("aiOptionsBar");
  if (!bar) return;
  const isOpen = bar.classList.toggle("open");
  $("toggleAiConfig").classList.toggle("added", isOpen);
});

document.querySelectorAll(".nav, .tab-item").forEach(b => {
  b.onclick = () => go(b.dataset.page);
});
document.querySelectorAll("[data-goto]").forEach(b => {
  b.onclick = () => go(b.dataset.goto);
});
document.querySelectorAll("[data-goto-task]").forEach(b => {
  b.onclick = () => {
    $("taskFilter").value = b.dataset.gotoTask;
    renderTasks();
    go("tasks");
  };
});
document.querySelectorAll("[data-quick-ai]").forEach(b => {
  b.onclick = () => {
    go("ai");
    $("question").value = b.dataset.quickAi;
    autoResizeQuestion();
    $("question").focus();
  };
});

// 消息区智能滚动控制（保留流式阅读不被强制打断，同时提供“回到底部”悬浮按钮）
function updateScrollBottomBtn() {
  const msgEl = $("messages");
  const btn = $("scrollBottomBtn");
  if (!msgEl || !btn) return;
  const dist = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight;
  // 阈值放低：只要离开底部一小段就给出“回到底部”，上滑后一定找得到回来的入口
  btn.classList.toggle("hide", dist < 80);
}
/*
 * 滚动跟随的判定只看“用户自己有没有动手”。
 * 不能只看离底距离：程序每次贴底、或是新渲染出来的来源卡片把高度顶高，
 * 都会让距离忽大忽小，反过来把用户的真实意图覆盖掉。
 */
let streamFollowBottom = true;
let programScrollUntil = 0;

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function markUserAwayFromBottom() {
  streamFollowBottom = false;
  updateScrollBottomBtn();
}

$("messages")?.addEventListener("scroll", () => {
  const el = $("messages");
  // 程序自己贴底引发的 scroll 不算用户操作，否则会把“用户上滑”误判成“仍在底部”
  if (el && Date.now() > programScrollUntil) streamFollowBottom = nearBottom(el);
  updateScrollBottomBtn();
}, { passive: true });

// 滚轮向上：用户要看前面的内容，立刻停止跟随
$("messages")?.addEventListener("wheel", e => {
  if (e.deltaY < 0) markUserAwayFromBottom();
}, { passive: true });

// 手机：手指往下拖（内容往回看）就停止跟随
let touchStartY = 0;
$("messages")?.addEventListener("touchstart", e => {
  touchStartY = e.touches?.[0]?.clientY ?? 0;
}, { passive: true });
$("messages")?.addEventListener("touchmove", e => {
  const y = e.touches?.[0]?.clientY ?? touchStartY;
  if (y - touchStartY > 8) markUserAwayFromBottom();
}, { passive: true });

$("scrollBottomBtn")?.addEventListener("click", () => {
  const msgEl = $("messages");
  streamFollowBottom = true;
  if (!msgEl) return;
  programScrollUntil = Date.now() + 400;
  msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: "smooth" });
});

function followStreamIfAtBottom() {
  const msgEl = $("messages");
  if (!msgEl) return;
  if (streamFollowBottom) {
    programScrollUntil = Date.now() + 150;
    msgEl.scrollTop = msgEl.scrollHeight;
  }
  updateScrollBottomBtn();
}

function scrollMessagesToBottom(force = false) {
  const msgEl = $("messages");
  if (!msgEl) return;
  if (force) {
    programScrollUntil = Date.now() + 400;
    streamFollowBottom = true;
    msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: "smooth" });
  } else {
    updateScrollBottomBtn();
  }
}

function go(p) {
  ["home", "notices", "tasks", "ai", "knowledge", "users", "analytics"].forEach(x =>
    $(`${x}Page`)?.classList.toggle("hide", x !== p)
  );
  document.body.classList.toggle("on-ai-page", p === "ai");
  document.querySelectorAll(".nav").forEach(b =>
    b.classList.toggle("active", b.dataset.page === p)
  );
  document.querySelectorAll(".tab-item").forEach(b =>
    b.classList.toggle("active", b.dataset.page === p)
  );
  $("crumb").textContent = {
    home: "工作台总览",
    notices: "通知公告",
    tasks: "我的待办",
    ai: "文理智办",
    knowledge: "校规制度库",
    users: "用户管理",
    analytics: "数据统计"
  }[p] || "工作台总览";
  sidebarEl.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (p === "ai") {
    checkAI();
    setTimeout(updateSugNavState, 60);
  }
  if (p === "knowledge") loadKnowledge();
  if (p === "users") loadUsers();
  if (p === "analytics") loadStats();
}

// 顶栏快速刷新按键
$("quickRefresh")?.addEventListener("click", async () => {
  await refresh();
  toast("数据已同步更新");
});

async function enter() {
  try {
    me = await api("/me");
  } catch (e) {
    token = "";
    try {
      localStorage.removeItem("xz_token");
    } catch {}
    $("auth").classList.remove("hide");
    $("app").classList.add("hide");
    toast(e.message);
    return;
  }
  $("auth").classList.add("hide");
  $("app").classList.remove("hide");
  $("userName").textContent = me.display_name;
  $("welcomeName").textContent = me.display_name;
  $("avatar").textContent = me.display_name.slice(0, 1);
  $("userRole").textContent = me.role === "admin" ? "系统管理员" : "学生用户";
  $("newNotice").classList.toggle("hide", me.role !== "admin");
  let d = new Date();
  $("today").textContent = d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  });
  $("dateBig").textContent = d.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
  document
    .querySelectorAll(".admin-only")
    .forEach(el => el.classList.toggle("hide", me.role !== "admin"));
  restoreChatFromLocal();
  await refresh();
  go("home");
}

async function refresh() {
  try {
    [notices, tasks] = await Promise.all([api("/notices"), api("/tasks")]);
    renderHome();
    renderNotices();
    renderTasks();
  } catch (e) {
    toast(e.message);
  }
}

function date(s) {
  if (!s) return "未设置截止日期";
  let d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString("zh-CN");
}

// 智能计算截止日期标签（逾期 / 临期预警）
function getDueStatusMarkup(dueDate, status) {
  if (!dueDate) return `<span>未设置截止日期</span>`;
  if (status === "completed") return `<span>${ico("clock","ico-xs")}截止日期：${esc(dueDate)}</span>`;
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueParts = String(dueDate).slice(0, 10).split("-").map(Number);
  const dueLocal = dueParts.length === 3 ? new Date(dueParts[0], dueParts[1] - 1, dueParts[2]) : new Date(dueDate);
  const diff = Math.round((dueLocal - todayLocal) / 86400000);
  if (!isNaN(diff)) {
    if (diff < 0) {
      return `<span class="due-tag overdue">${ico("alert","ico-xs")}已逾期 (${esc(dueDate)})</span>`;
    }
    if (diff <= 3) {
      return `<span class="due-tag soon">${ico("alert","ico-xs")}剩 ${diff} 天截止 (${esc(dueDate)})</span>`;
    }
  }
  return `<span>${ico("clock","ico-xs")}截止日期：${esc(dueDate)}</span>`;
}

function updateBadges(pendingCount) {
  const navBadge = $("navTaskBadge");
  const mobBadge = $("mobTaskBadge");
  if (navBadge) {
    navBadge.textContent = pendingCount;
    navBadge.classList.toggle("hide", pendingCount === 0);
  }
  if (mobBadge) {
    mobBadge.textContent = pendingCount;
    mobBadge.classList.toggle("hide", pendingCount === 0);
  }
}

function renderHome() {
  const pendingCount = tasks.filter(t => t.status === "pending").length;
  const doneCount = tasks.filter(t => t.status === "completed").length;
  $("statNotices").textContent = notices.length;
  $("statPending").textContent = pendingCount;
  $("statDone").textContent = doneCount;
  updateBadges(pendingCount);

  $("recent").innerHTML =
    notices
      .slice(0, 4)
      .map(
        n => `<div class="notice-row">
          <span class="bullet"></span>
          <div style="flex:1;min-width:0">
            <h4>${esc(n.title)}</h4>
            <p>${esc(n.body)}</p>
            <div class="meta">
              <span class="tag">${esc(n.category)}</span>
              <span>${date(n.created_at)}</span>
              ${n.deadline ? `<span>${ico("clock","ico-xs")}截止：${esc(n.deadline)}</span>` : ""}
            </div>
          </div>
        </div>`
      )
      .join("") || '<div class="empty">暂无通知公告</div>';
}

function renderNotices() {
  let q = ($("search").value || "").toLowerCase(),
    cat = $("category").value;
  $("clearSearch")?.classList.toggle("hide", !q);

  const activePillCat = document.querySelector("#catPills .pill-btn.active")?.dataset.cat ?? "";
  const onlyStarred = activePillCat === "__starred__";

  if ($("starCountBadge")) {
    $("starCountBadge").textContent = starredNoticeIds.size ? `(${starredNoticeIds.size})` : "";
  }

  let list = notices.filter(n => {
    if (onlyStarred && !starredNoticeIds.has(Number(n.id))) return false;
    if (!onlyStarred && cat && n.category !== cat) return false;
    if (q && !(n.title + n.body + (n.publisher || "")).toLowerCase().includes(q)) return false;
    return true;
  });

  // 已收藏的通知置顶排列
  list = [...list].sort((a, b) => {
    const sa = starredNoticeIds.has(Number(a.id)) ? 1 : 0;
    const sb = starredNoticeIds.has(Number(b.id)) ? 1 : 0;
    return sb - sa;
  });

  const admin = me?.role === "admin";
  const taskNoticeIds = new Set(tasks.map(t => Number(t.notice_id)));

  $("noticeCards").innerHTML =
    list
      .map(n => {
        const alreadyInTask = taskNoticeIds.has(Number(n.id));
        const isStarred = starredNoticeIds.has(Number(n.id));
        return `<article class="notice-card ${isStarred ? "starred" : ""}">
          <div class="notice-top">
            <div class="notice-tags">
              <span class="tag">${esc(n.category)}</span>
              ${isStarred ? `<span class="tag star-tag">${ico("star-fill","ico-xs")}已置顶收藏</span>` : ""}
            </div>
            <div class="notice-actions">
              <button type="button" class="ai-btn" data-ai-notice="${n.id}">${ico("sparkles")}AI 解读</button>
              <button type="button" class="outline ${alreadyInTask ? "added" : ""}" data-add="${n.id}">
                ${alreadyInTask ? ico("check", "ico-xs") + "已在待办" : ico("plus", "ico-xs") + "加入待办"}
              </button>
              <button type="button" class="outline icon-only ${isStarred ? "starred-btn" : ""}" data-star-notice="${n.id}"
                title="${isStarred ? "取消收藏" : "收藏并置顶"}" aria-label="${isStarred ? "取消收藏" : "收藏并置顶"}">
                ${isStarred ? ico("star-fill") : ico("star")}
              </button>
              <button type="button" class="outline icon-only" data-copy-notice="${n.id}" title="复制通知全文" aria-label="复制通知全文">${ico("copy")}</button>
              ${admin ? `<button type="button" class="outline icon-only" data-edit-notice="${n.id}" title="编辑通知" aria-label="编辑通知">${ico("edit")}</button>` : ""}
              ${admin ? `<button type="button" class="danger icon-only" data-delete-notice="${n.id}" title="删除通知" aria-label="删除通知">${ico("trash")}</button>` : ""}
            </div>
          </div>
          <h3>${esc(n.title)}</h3>
          <p>${esc(n.body)}</p>
          <div class="meta">
            <span>发布人：${esc(n.publisher || "—")}</span>
            <span>发布于：${date(n.created_at)}</span>
            <span>适用对象：${esc(n.audience || "全体学生")}</span>
            ${n.deadline ? `<span>${ico("clock","ico-xs")}截止：${esc(n.deadline)}</span>` : ""}
          </div>
        </article>`;
      })
      .join("") || '<div class="panel empty">没有找到符合条件的通知公告。</div>';

  document.querySelectorAll("[data-star-notice]").forEach(b => {
    b.onclick = () => {
      const id = Number(b.dataset.starNotice);
      if (starredNoticeIds.has(id)) {
        starredNoticeIds.delete(id);
        toast("已取消收藏");
      } else {
        starredNoticeIds.add(id);
        toast("已收藏并置顶该通知");
      }
      saveStarredNotices();
      renderNotices();
    };
  });

  document.querySelectorAll("[data-add]").forEach(b => {
    b.onclick = async () => {
      try {
        let d = await api("/tasks/from-notice/" + b.dataset.add, { method: "POST" });
        toast(d.message);
        tasks = await api("/tasks");
        renderTasks();
        renderHome();
        renderNotices();
      } catch (e) {
        toast(e.message);
      }
    };
  });

  document.querySelectorAll("[data-copy-notice]").forEach(b => {
    b.onclick = async () => {
      const n = notices.find(item => String(item.id) === String(b.dataset.copyNotice));
      if (!n) return;
      const text = `【${n.category}】${n.title}\n${n.body}\n适用对象：${n.audience}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
      const ok = await copyTextSafe(text);
      toast(ok ? "通知内容已复制到剪贴板" : "复制失败，请手动长按复制");
    };
  });

  document.querySelectorAll("[data-ai-notice]").forEach(b => {
    b.onclick = () => {
      const n = notices.find(item => String(item.id) === String(b.dataset.aiNotice));
      if (!n) return;
      go("ai");
      $("question").value = `请帮我解读以下校园通知，并梳理出【所需材料】、【分步办理流程】和【重要时间节点】：\n标题：《${n.title}》\n内容：${n.body}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
      autoResizeQuestion();
      $("askForm").requestSubmit();
    };
  });

  document.querySelectorAll("[data-edit-notice]").forEach(b => {
    b.onclick = () => {
      const n = notices.find(item => String(item.id) === String(b.dataset.editNotice));
      if (!n) return;
      $("nEditId").value = String(n.id);
      $("dialogTitle").textContent = "编辑校园通知";
      $("submitNoticeBtn").textContent = "保存修改";
      $("nTitle").value = n.title || "";
      $("nCategory").value = n.category || "校园通知";
      $("nAudience").value = n.audience || "全体学生";
      $("nDeadline").value = n.deadline || "";
      $("nBody").value = n.body || "";
      $("nTasksWrap")?.classList.add("hide");
      $("dialog").showModal();
    };
  });

  document.querySelectorAll("[data-delete-notice]").forEach(b => {
    b.onclick = async () => {
      if (me?.role !== "admin") return toast("仅管理员可以删除通知");
      if (!confirm("确定删除这条通知吗？相关待办也会一并删除，此操作不可撤销。")) return;
      b.disabled = true;
      try {
        const d = await api("/notices/" + b.dataset.deleteNotice, { method: "DELETE" });
        toast(d.message || "通知删除成功");
        await refresh();
      } catch (e) {
        toast(e.message);
        b.disabled = false;
      }
    };
  });
}

$("search").oninput = renderNotices;
$("clearSearch")?.addEventListener("click", () => {
  $("search").value = "";
  renderNotices();
});
$("category").onchange = () => {
  document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.cat === $("category").value);
  });
  renderNotices();
};
document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#catPills .pill-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.cat !== "__starred__") {
      $("category").value = btn.dataset.cat;
    }
    renderNotices();
  };
});

// ====== 我的待办管理（自定义新增、点击标题修改、批量完成、清理已完成、单条删除） ======
$("taskFilter").onchange = renderTasks;
$("taskSearch")?.addEventListener("input", renderTasks);

$("addTaskForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const title = $("newTaskTitle").value.trim();
  const due_date = $("newTaskDue").value;
  if (!title) return;
  try {
    await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ title, due_date })
    });
    $("newTaskTitle").value = "";
    $("newTaskDue").value = "";
    tasks = await api("/tasks");
    renderTasks();
    renderHome();
    toast("已添加个人待办事项");
  } catch (err) {
    toast(err.message);
  }
});

$("markAllDone")?.addEventListener("click", async () => {
  const pendingList = tasks.filter(t => t.status === "pending");
  if (!pendingList.length) return toast("当前没有待处理的任务");
  try {
    try {
      await api("/tasks/complete-all", { method: "POST" });
    } catch {
      await Promise.all(
        pendingList.map(t =>
          api("/tasks/" + t.id, {
            method: "PATCH",
            body: JSON.stringify({ status: "completed" })
          })
        )
      );
    }
    tasks = await api("/tasks");
    renderTasks();
    renderHome();
    toast(`已将 ${pendingList.length} 项待办全部标为完成`);
  } catch (e) {
    toast(e.message);
  }
});

$("clearCompletedTasks")?.addEventListener("click", async () => {
  const doneList = tasks.filter(t => t.status === "completed");
  if (!doneList.length) return toast("当前没有已完成的任务可清理");
  if (!confirm(`确定清理全部 ${doneList.length} 项已完成的待办事项吗？`)) return;
  try {
    const res = await api("/tasks/completed", { method: "DELETE" });
    tasks = await api("/tasks");
    renderTasks();
    renderHome();
    renderNotices();
    toast(res.message || "已清理已完成待办");
  } catch (e) {
    toast(e.message);
  }
});

$("closeEditTaskDialog")?.addEventListener("click", () => $("editTaskDialog").close());
$("cancelEditTaskDialog")?.addEventListener("click", () => $("editTaskDialog").close());
$("editTaskForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const id = Number($("editTaskId").value);
  const title = $("editTaskTitle").value.trim();
  if (!title) return toast("请填写待办标题");
  const btn = $("saveEditTask");
  btn.disabled = true;
  try {
    await api("/tasks/" + id, { method: "PATCH", body: JSON.stringify({ title, due_date: $("editTaskDue").value }) });
    tasks = await api("/tasks");
    renderTasks(); renderHome();
    $("editTaskDialog").close();
    toast("待办内容与截止日期已更新");
  } catch (e) { toast(e.message || "保存失败"); }
  finally { btn.disabled = false; }
});

function renderTasks() {
  let f = $("taskFilter").value,
    q = ($("taskSearch")?.value || "").toLowerCase().trim(),
    list = tasks.filter(
      t => (f === "all" || t.status === f) && (!q || t.title.toLowerCase().includes(q))
    ),
    p = tasks.filter(t => t.status === "pending").length,
    d = tasks.length - p;

  $("taskTotal").textContent = tasks.length;
  $("taskOpen").textContent = p;
  $("taskDone").textContent = d;

  const pct = tasks.length ? Math.round((d / tasks.length) * 100) : 0;
  if ($("taskPercent")) $("taskPercent").textContent = pct + "%";
  if ($("taskProgressBar")) $("taskProgressBar").style.width = pct + "%";

  $("taskList").innerHTML =
    list
      .map(
        t => `<div class="taskrow ${t.status === "completed" ? "done" : ""}">
          <input type="checkbox" data-task="${t.id}" ${t.status === "completed" ? "checked" : ""}>
          <div class="tasktext">
            <b data-edit-task="${t.id}" title="点击修改待办内容">${esc(t.title)}</b>
            <small>
              ${getDueStatusMarkup(t.due_date, t.status)}
              <span>· ${t.notice_id ? ico("pin", "ico-xs") + "来自通知" : ico("edit", "ico-xs") + "个人待办"}</span>
              <span>· 创建于 ${t.created_at ? esc(date(t.created_at)) : "—"}</span>
            </small>
          </div>
          <span class="tag">${t.status === "completed" ? "已完成" : "待处理"}</span>
          <button type="button" class="task-del-btn" data-del-task="${t.id}" title="删除此待办" aria-label="删除此待办">${ico("trash")}</button>
        </div>`
      )
      .join("") ||
    '<div class="empty">暂无符合条件的待办事项。可在上方添加个人待办，或在“通知公告 / 文理智办 AI”中一键导入。</div>';

  document.querySelectorAll("[data-task]").forEach(c => {
    c.onchange = async () => {
      try {
        await api("/tasks/" + c.dataset.task, {
          method: "PATCH",
          body: JSON.stringify({ status: c.checked ? "completed" : "pending" })
        });
        tasks = await api("/tasks");
        renderTasks();
        renderHome();
        renderNotices();
      } catch (e) {
        toast(e.message);
      }
    };
  });

  document.querySelectorAll("[data-edit-task]").forEach(b => {
    b.onclick = async () => {
      const id = Number(b.dataset.editTask);
      const t = tasks.find(item => Number(item.id) === id);
      if (!t) return;
      $("editTaskId").value = String(id);
      $("editTaskTitle").value = t.title;
      $("editTaskDue").value = t.due_date || "";
      $("editTaskDialog").showModal();
      $("editTaskTitle").focus();
    };
  });

  document.querySelectorAll("[data-del-task]").forEach(btn => {
    btn.onclick = async () => {
      const task = tasks.find(item => Number(item.id) === Number(btn.dataset.delTask));
      if (!confirm(`确定删除待办“${task?.title || "此事项"}”吗？`)) return;
      try {
        await api("/tasks/" + btn.dataset.delTask, { method: "DELETE" });
        tasks = await api("/tasks");
        renderTasks();
        renderHome();
        renderNotices();
        toast("待办已删除");
      } catch (e) {
        toast(e.message);
      }
    };
  });
}

// 发布 / 编辑通知弹窗
$("newNotice").onclick = () => {
  $("nEditId").value = "";
  $("dialogTitle").textContent = "发布校园通知";
  $("submitNoticeBtn").textContent = "确认发布";
  $("noticeForm").reset();
  $("nAudience").value = "全体学生";
  $("nTasksWrap")?.classList.remove("hide");
  $("dialog").showModal();
};
$("closeDialog").onclick = () => $("dialog").close();
$("cancelDialog").onclick = () => $("dialog").close();

$("noticeForm").onsubmit = async e => {
  e.preventDefault();
  const editId = $("nEditId").value;
  try {
    if (editId) {
      await api("/notices/" + editId, {
        method: "PATCH",
        body: JSON.stringify({
          title: $("nTitle").value.trim(),
          category: $("nCategory").value,
          audience: $("nAudience").value.trim(),
          deadline: $("nDeadline").value,
          body: $("nBody").value.trim()
        })
      });
      toast("通知修改已保存，关联待办已同步更新");
    } else {
      await api("/notices", {
        method: "POST",
        body: JSON.stringify({
          title: $("nTitle").value.trim(),
          category: $("nCategory").value,
          audience: $("nAudience").value.trim(),
          deadline: $("nDeadline").value,
          body: $("nBody").value.trim(),
          create_tasks: $("nTasks").checked
        })
      });
      toast("通知发布成功");
    }
    $("dialog").close();
    $("noticeForm").reset();
    $("nAudience").value = "全体学生";
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};

// ====== 电脑端 AI 热门提问横向滚动增强（滚轮横向滚动 + 鼠标按住拖拽 + 左右切换按钮） ======
function updateSugNavState() {
  const track = $("suggestionsTrack");
  const prevBtn = $("sugPrev");
  const nextBtn = $("sugNext");
  if (!track || !prevBtn || !nextBtn) return;
  const maxScroll = track.scrollWidth - track.clientWidth;
  prevBtn.classList.toggle("hide", track.scrollLeft <= 6);
  nextBtn.classList.toggle("hide", maxScroll <= 6 || track.scrollLeft >= maxScroll - 6);
}

function initSuggestionsScroller() {
  const track = $("suggestionsTrack");
  const prevBtn = $("sugPrev");
  const nextBtn = $("sugNext");
  if (!track) return;

  prevBtn?.addEventListener("click", () => {
    track.scrollBy({ left: -260, behavior: "smooth" });
  });
  nextBtn?.addEventListener("click", () => {
    track.scrollBy({ left: 260, behavior: "smooth" });
  });

  track.addEventListener("scroll", updateSugNavState, { passive: true });
  window.addEventListener("resize", updateSugNavState);

  // 电脑端鼠标滚轮直接转化为横向滚动
  track.addEventListener(
    "wheel",
    e => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        track.scrollLeft += e.deltaY;
      }
    },
    { passive: false }
  );

  // 电脑端鼠标按住左右拖拽滚动（带防误触点击保护）
  let isDown = false;
  let startX = 0;
  let scrollStart = 0;
  let dragged = false;

  track.addEventListener("mousedown", e => {
    isDown = true;
    dragged = false;
    track.classList.add("dragging");
    startX = e.pageX - track.offsetLeft;
    scrollStart = track.scrollLeft;
  });

  window.addEventListener("mouseup", () => {
    if (!isDown) return;
    isDown = false;
    track.classList.remove("dragging");
  });

  track.addEventListener("mousemove", e => {
    if (!isDown) return;
    const x = e.pageX - track.offsetLeft;
    const walk = (x - startX) * 1.25;
    if (Math.abs(walk) > 6) {
      dragged = true;
      e.preventDefault();
      track.scrollLeft = scrollStart - walk;
    }
  });

  track.querySelectorAll("button").forEach(b => {
    b.onclick = e => {
      if (dragged) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      $("question").value = b.dataset.q || b.textContent;
      autoResizeQuestion();
      $("question").focus();
    };
  });

  setTimeout(updateSugNavState, 100);
}
initSuggestionsScroller();

// ====== 校规制度库：数量一律来自后端接口，前端不写死任何数字 ======
let knowledgeTotalDocs = 0; // 0 表示尚未拿到后端数据，界面显示占位符
function kbTotalText() {
  return knowledgeTotalDocs > 0 ? String(knowledgeTotalDocs) : "…";
}
// 把后端返回的真实数量写回所有占位元素，保证卡片、胶囊、标题文案完全一致
function applyKbCount(total, chunks) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return;
  knowledgeTotalDocs = n;
  document.querySelectorAll("[data-kb-count]").forEach(el => { el.textContent = String(n); });
  document.querySelectorAll("[data-kb-count-title]").forEach(el => {
    el.title = `点击查阅 ${n} 份校规制度原文`;
  });
  const stat = $("statKnowledge");
  if (stat) stat.textContent = String(n);
  const chunkNum = Number(chunks);
  if (Number.isFinite(chunkNum) && chunkNum > 0) {
    document.querySelectorAll("[data-kb-chunks]").forEach(el => { el.textContent = String(chunkNum); });
  }
}
// 轻量同步：只取数量，不拉整个目录
async function syncKnowledgeMeta() {
  try {
    const s = await api("/stats");
    applyKbCount(s?.knowledge_files, s?.knowledge_chunks);
  } catch {
    /* 拉取失败时保留占位符，绝不显示猜测出来的数字 */
  }
}
function updateKnowledgeCounts(total, docs = []) {
  const n = Number(total);
  if (Number.isFinite(n) && n > 0) applyKbCount(n);
  const deptCounts = { "教务处": 0, "学生工作部": 0 };
  for (const doc of docs || []) if (Object.prototype.hasOwnProperty.call(deptCounts, doc.dept)) deptCounts[doc.dept]++;
  document.querySelectorAll("#knowledgePills .pill-btn[data-kdept]").forEach(btn => {
    const dept = btn.dataset.kdept || "";
    const base = btn.dataset.baseLabel || (dept || "全部");
    if (!dept) btn.textContent = `${base} (${kbTotalText()})`;
    else if (docs.length) btn.textContent = `${base} (${deptCounts[dept] || 0})`;
  });
  const select = $("knowledgeDept");
  if (select && docs.length) {
    [...select.options].forEach(option => {
      const dept = option.value;
      const base = option.dataset.baseLabel || option.textContent.replace(/\s*（\d+）$/, "");
      option.dataset.baseLabel = base;
      if (!dept) option.textContent = `${base}（${kbTotalText()}）`;
      else if (Object.prototype.hasOwnProperty.call(deptCounts, dept)) option.textContent = `${base}（${deptCounts[dept] || 0}）`;
    });
  }
}
function cleanKnowledgeSnippet(content, title = "") {
  let text = String(content || "").replace(/^\s*【\d{3}】\s*/, "");
  if (title && text.startsWith(title)) text = text.slice(title.length);
  text = text.replace(/^\s*【(?:部门|栏目|日期|链接)】[^\n]*(?:\n|$)/gm, "");
  return text.trim();
}
function updateKnowledgeResultMeta({ shown = 0, query = "", dept = "", matched = 0, loading = false, failed = false } = {}) {
  const el = $("knowledgeResultMeta");
  if (!el) return;
  if (loading) { el.textContent = "正在加载制度目录…"; return; }
  if (failed) { el.textContent = "制度目录加载失败，请检查网络后重试。"; return; }
  const filter = query ? `关键词“${query}”` : (dept ? `部门“${dept}”` : "全部制度");
  el.textContent = query
    ? `${filter}：找到 ${shown} 份相关文件${matched ? `，另有 ${matched} 条款片段可直接阅读` : ""}。目录共 ${kbTotalText()} 份唯一标题文件。`
    : `${filter}：当前显示 ${shown} / ${kbTotalText()} 份文件。`;
}

function renderKnowledgeGrid(docs, matchedChunks = [], q = "") {
  const matchedBox = $("knowledgeMatchedBox");
  const matchedList = $("knowledgeMatchedList");
  if (q && matchedChunks.length && matchedBox && matchedList) {
    matchedBox.classList.remove("hide");
    matchedList.innerHTML = matchedChunks
      .map(
        c => `<article class="notice-card">
          <div class="notice-top">
            <div class="notice-tags">
              <span class="tag">${esc(c.dept || "学校制度")}</span>
              <span class="pill">${esc(c.category || "规章条款")}</span>
            </div>
            <div class="notice-actions">
              <button type="button" class="outline" data-read-doc="${esc(c.docTitle || c.name)}">${ico("book")}阅读整篇制度</button>
              <button type="button" class="ai-btn" data-ask-doc="${esc(c.docTitle || c.name)}">${ico("sparkles")}AI 解读</button>
            </div>
          </div>
          <h3>${esc(c.name)}</h3>
          <p>${esc(cleanKnowledgeSnippet(c.content, c.docTitle || c.name).slice(0, 360))}${cleanKnowledgeSnippet(c.content, c.docTitle || c.name).length > 360 ? "…" : ""}</p>
        </article>`
      )
      .join("");
  } else if (matchedBox) {
    matchedBox.classList.add("hide");
  }

  const grid = $("knowledgeGrid");
  if (grid) {
    grid.innerHTML =
      docs
        .map(
          d => `<article class="knowledge-card">
            <div>
              <div class="notice-top knowledge-card-top">
                <span class="tag">${esc(d.dept || "学校部门")}</span>
                <span class="doc-index" title="目录内唯一序号">档案 ${esc(d.catalog_no || String(d.id || 0).padStart(3, "0"))}/${esc(kbTotalText())}</span>
                <small class="muted">${esc(d.date || "日期未标注")}</small>
              </div>
              <h4>${esc(d.title)}</h4>
              <p>${esc(d.preview || "")}</p>
            </div>
            <div class="knowledge-card-foot">
              <small class="muted">${esc(d.category || "规章制度")} · ${d.chunk_count || 1} 节</small>
              <div class="knowledge-card-actions">
                <button type="button" class="outline" data-read-doc="${esc(d.title)}">${ico("book")}查看原文</button>
                <button type="button" class="ai-btn" data-ask-doc="${esc(d.title)}">${ico("sparkles")}解读</button>
              </div>
            </div>
          </article>`
        )
        .join("") || '<div class="panel empty" style="grid-column:1/-1">没有找到匹配的规章制度文件。</div>';
  }

  document.querySelectorAll("[data-read-doc]").forEach(btn => {
    btn.onclick = () => openDocReader(btn.dataset.readDoc);
  });
  document.querySelectorAll("[data-ask-doc]").forEach(btn => {
    btn.onclick = () => {
      const title = btn.dataset.askDoc;
      go("ai");
      $("question").value = `请根据《${title}》为我梳理该制度的核心适用对象、关键规定、所需材料表单以及红线注意事项。`;
      autoResizeQuestion();
      $("askForm").requestSubmit();
    };
  });
}

async function loadKnowledge() {
  const q = ($("knowledgeSearch")?.value || "").trim();
  const dept = $("knowledgeDept")?.value || "";
  const grid = $("knowledgeGrid");
  const matchedBox = $("knowledgeMatchedBox");
  const requestSeq = ++knowledgeRequestSeq;
  $("clearKnowledgeSearch")?.classList.toggle("hide", !q);

  if (!q && allKnowledgeDocsCache) {
    const filtered = dept ? allKnowledgeDocsCache.filter(d => d.dept === dept) : allKnowledgeDocsCache;
    knowledgeDocs = filtered;
    updateKnowledgeCounts(knowledgeTotalDocs, allKnowledgeDocsCache);
    updateKnowledgeResultMeta({ shown: filtered.length, dept });
    renderKnowledgeGrid(filtered, [], "");
    return;
  }
  if (grid) grid.setAttribute("aria-busy", "true");
  updateKnowledgeResultMeta({ loading: true });
  if (grid && !knowledgeDocs.length) grid.innerHTML = '<div class="panel empty" style="grid-column:1/-1" role="status">正在加载制度目录…</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (dept) params.set("dept", dept);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await api("/knowledge" + qs);
    if (requestSeq !== knowledgeRequestSeq) return;
    if (!data || !Array.isArray(data.docs)) throw Error("制度目录返回格式异常，请稍后重试。");
    knowledgeDocs = data.docs;
    const totalDocs = Number(data.total_docs ?? (allKnowledgeDocsCache ? allKnowledgeDocsCache.length : knowledgeDocs.length));
    if (!q && !dept && knowledgeDocs.length) allKnowledgeDocsCache = knowledgeDocs;
    if (!q && !dept) updateKnowledgeCounts(totalDocs, knowledgeDocs);
    else if (allKnowledgeDocsCache) updateKnowledgeCounts(totalDocs, allKnowledgeDocsCache);
    const matchedChunks = Array.isArray(data.matched_chunks) ? data.matched_chunks : [];
    updateKnowledgeResultMeta({ shown: knowledgeDocs.length, query: q, dept, matched: matchedChunks.length });
    renderKnowledgeGrid(knowledgeDocs, matchedChunks, q);
  } catch (e) {
    if (requestSeq !== knowledgeRequestSeq) return;
    if (grid) grid.innerHTML = `<div class="panel empty" style="grid-column:1/-1" role="alert">${esc(e.message || "制度目录加载失败")}<br><button type="button" class="outline" id="retryKnowledgeBtn" style="margin-top:10px">重新加载</button></div>`;
    updateKnowledgeResultMeta({ failed: true });
    if (matchedBox) matchedBox.classList.add("hide");
    $("retryKnowledgeBtn")?.addEventListener("click", loadKnowledge, { once: true });
    toast(e.message || "制度目录加载失败，请检查网络后重试");
  } finally {
    if (requestSeq === knowledgeRequestSeq && grid) grid.removeAttribute("aria-busy");
  }
}
/* ====== 制度原文阅读器：公文体排版、章节目录、字号记忆 ====== */
const DOC_FONT_KEY = "kbDocFontScale";
let docFontScale = (() => {
  const v = Number(localStorage.getItem(DOC_FONT_KEY));
  return Number.isFinite(v) && v >= 0.8 && v <= 1.5 ? v : 1;
})();
let docOutlineHeads = [];

function applyDocFontScale() {
  const paper = $("docDialogBody");
  if (paper) paper.style.fontSize = `${(16.5 * docFontScale).toFixed(1)}px`;
  const level = docFontScale > 1.001 ? 1 : (docFontScale < 0.999 ? -1 : 0);
  document.querySelectorAll("[data-font]").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.font) === level);
  });
}

// 把纯文本按公文版式拆成章节标题、条款段落、落款等结构
function renderDocHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(x => x.trim()).filter(Boolean);
  const out = [];
  let secId = 0;
  // 表格型文档（评分标准、指标体系等）在纯文本里是逐格一行，这里归并成紧凑行块
  const isCellLine = s =>
    s.length <= 26 &&
    !/[。；：！？”]$/.test(s) &&
    !/^第[一二三四五六七八九十百零\d]+[章条]/.test(s) &&
    !/^[一二三四五六七八九十]+、/.test(s) &&
    !/^附件/.test(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 连续 ≥4 行的短行按“表格行”折叠
    if (isCellLine(line)) {
      let j = i;
      while (j < lines.length && isCellLine(lines[j])) j++;
      const run = lines.slice(i, j);
      if (run.length >= 4) {
        out.push('<div class="doc-table">' + run.map(x => `<div class="doc-trow">${esc(x)}</div>`).join("") + "</div>");
        i = j - 1;
        continue;
      }
    }

    if (line.length <= 42 && /^第[一二三四五六七八九十百零\d]+章[\s　]/.test(line)) {
      out.push(`<h3 class="doc-h2" id="doc-sec-${++secId}">${esc(line)}</h3>`);
      continue;
    }
    const art = line.match(/^(第[一二三四五六七八九十百零\d]+条)[\s　]*(.*)$/);
    if (art) {
      const rest = art[2].trim();
      const cls = rest && rest.length <= 14 && !/[。；，]/.test(rest) ? "doc-p doc-ptitle" : "doc-p";
      out.push(`<p class="${cls}"><span class="doc-no">${esc(art[1])}</span>${esc(rest)}</p>`);
      continue;
    }
    if (line.length <= 42 && /^[一二三四五六七八九十]+、/.test(line)) {
      out.push(`<h4 class="doc-h3" id="doc-sec-${++secId}">${esc(line)}</h4>`);
      continue;
    }
    if (/^[（(][一二三四五六七八九十]+[）)]/.test(line)) {
      out.push(`<p class="doc-p doc-li2">${esc(line)}</p>`);
      continue;
    }
    if (/^\d+[.、]/.test(line)) {
      out.push(`<p class="doc-p doc-li">${esc(line)}</p>`);
      continue;
    }
    if (/^(办理步骤|办理流程|办理程序|申请条件|受理条件|所需材料|办理材料|注意事项|适用范围|办理时限|办理地点|咨询电话|联系方式|说明|备注)$/.test(line)) {
      out.push(`<h4 class="doc-h3" id="doc-sec-${++secId}">${esc(line)}</h4>`);
      continue;
    }
    if (/^附件[:：]/.test(line)) {
      const items = [line.replace(/^附件[:：]\s*/, "")];
      let j = i + 1;
      while (j < lines.length && /^(\d+[.、]|附件\s*\d+)/.test(lines[j])) {
        items.push(lines[j]);
        j++;
      }
      out.push(
        '<div class="doc-attach"><div class="doc-attach-head">附件清单</div>' +
          items.map(t => `<div class="doc-attach-item">${esc(t)}</div>`).join("") +
          "</div>"
      );
      i = j - 1;
      continue;
    }
    if (/〔\d{4}〕\s*\d+\s*号$/.test(line) && line.length <= 30) {
      out.push(`<p class="doc-docnum">${esc(line)}</p>`);
      continue;
    }
    if (line.length <= 24 && /^(二[〇零一二三四五六七八九]{3}|\d{4})年.{1,3}月.{1,3}日$/.test(line)) {
      out.push(`<p class="doc-sign">${esc(line)}</p>`);
      continue;
    }
    if (i >= lines.length - 4 && line.length <= 14 && /^(西安文理学院|教务处|学生工作部|学生工作处|党政办公室)/.test(line)) {
      out.push(`<p class="doc-sign">${esc(line)}</p>`);
      continue;
    }
    out.push(`<p class="doc-p">${esc(line)}</p>`);
  }
  return out.join("");
}

function buildDocOutline(paper) {
  const box = $("docOutline");
  if (!box) return;
  docOutlineHeads = [...paper.querySelectorAll(".doc-h2, .doc-h3")];
  const scroll = $("docReaderScroll");
  if (docOutlineHeads.length < 2) {
    box.classList.add("hide");
    box.innerHTML = "";
    scroll?.classList.add("no-outline");
    return;
  }
  scroll?.classList.remove("no-outline");
  box.classList.remove("hide");
  box.innerHTML =
    '<div class="doc-outline-title">章节目录</div>' +
    docOutlineHeads
      .map(h => {
        const lv2 = h.classList.contains("doc-h3");
        return `<button type="button" class="doc-outline-item${lv2 ? " lv2" : ""}" data-target="${h.id}">${esc(h.textContent.slice(0, 30))}</button>`;
      })
      .join("");
  box.querySelectorAll("[data-target]").forEach(btn => {
    btn.onclick = () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      if (window.innerWidth < 900) document.body.classList.remove("doc-outline-open");
      setActiveOutline(btn.dataset.target);
    };
  });
}

function setActiveOutline(id) {
  document.querySelectorAll(".doc-outline-item").forEach(b => {
    b.classList.toggle("active", b.dataset.target === id);
  });
}

function updateDocProgress() {
  const sc = $("docReaderScroll");
  const bar = $("docReaderProgress");
  if (!sc || !bar) return;
  const max = sc.scrollHeight - sc.clientHeight;
  const pct = max > 8 ? Math.min(100, Math.max(0, (sc.scrollTop / max) * 100)) : 100;
  bar.style.width = `${pct}%`;
  if (!docOutlineHeads.length) return;
  const top = sc.getBoundingClientRect().top + 72;
  let current = docOutlineHeads[0];
  for (const h of docOutlineHeads) {
    if (h.getBoundingClientRect().top <= top) current = h;
    else break;
  }
  if (current?.id) setActiveOutline(current.id);
}

async function openDocReader(docTitle) {
  if (!docTitle) return;
  const cleanTitle = String(docTitle).split(" · ")[0].trim();
  try {
    const data = await api("/knowledge?doc=" + encodeURIComponent(cleanTitle));
    const doc = data.doc || { title: cleanTitle, dept: "学校部门", category: "规章制度", url: "https://jwc.xawl.edu.cn/" };
    if (Number(data.total_docs) > 0) applyKbCount(data.total_docs);
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const fullText = chunks.map(c => c.content).join("\n");
    currentDocViewing = { ...doc, fullText };

    $("docDialogDept").textContent = doc.dept || "学校部门";
    $("docDialogCategory").textContent = doc.category || "规章制度";
    $("docDialogDate").textContent = doc.date || "";
    $("docDialogTitle").textContent = doc.title || cleanTitle;
    $("docDialogIndex").textContent = `档案 ${doc.catalog_no || "—"}/${kbTotalText()}`;

    const paper = $("docDialogBody");
    paper.innerHTML = renderDocHtml(fullText) || '<p class="doc-p">暂无正文内容</p>';
    applyDocFontScale();
    buildDocOutline(paper);

    const chars = fullText.replace(/\s/g, "").length;
    const meta = $("docReaderMeta");
    if (meta) meta.textContent = `${chars.toLocaleString("zh-CN")} 字 · ${chunks.length} 节`;

    const link = $("docDialogUrl");
    if (link) {
      const url = doc.url || "";
      link.href = url || "#";
      link.classList.toggle("hide", !url);
    }

    $("docDialog")?.showModal();
    const sc = $("docReaderScroll");
    if (sc) sc.scrollTop = 0;
    requestAnimationFrame(updateDocProgress);
  } catch (e) {
    toast(e.message || "未能加载该制度原文");
  }
}

$("docReaderScroll")?.addEventListener("scroll", updateDocProgress, { passive: true });
document.querySelectorAll("[data-font]").forEach(btn => {
  btn.onclick = () => {
    const delta = Number(btn.dataset.font);
    docFontScale = delta === 0 ? 1 : Math.min(1.4, Math.max(0.85, Number((docFontScale + delta * 0.1).toFixed(2))));
    try { localStorage.setItem(DOC_FONT_KEY, String(docFontScale)); } catch {}
    applyDocFontScale();
  };
});
$("docOutlineToggle")?.addEventListener("click", () => {
  if (window.innerWidth > 900) document.body.classList.toggle("doc-outline-hidden");
  else document.body.classList.toggle("doc-outline-open");
});
$("docDialog")?.addEventListener("click", e => {
  if (e.target === $("docDialog")) $("docDialog")?.close();
});
$("docDialog")?.addEventListener("close", () => {
  document.body.classList.remove("doc-outline-open");
  document.body.classList.remove("doc-outline-hidden");
});

$("closeDocDialog")?.addEventListener("click", () => $("docDialog")?.close());
$("copyDocTextBtn")?.addEventListener("click", async () => {
  if (!currentDocViewing?.fullText) return;
  const ok = await copyTextSafe(`《${currentDocViewing.title}》\n\n${currentDocViewing.fullText}`);
  toast(ok ? "制度全文已复制到剪贴板" : "复制失败");
});
$("askAiDocBtn")?.addEventListener("click", () => {
  if (!currentDocViewing?.title) return;
  const title = currentDocViewing.title;
  $("docDialog")?.close();
  go("ai");
  $("question").value = `请帮我详细解读《${title}》的核心办理要求、所需材料和关键注意事项。`;
  autoResizeQuestion();
  $("askForm").requestSubmit();
});

$("knowledgeDept")?.addEventListener("change", () => {
  document.querySelectorAll("#knowledgePills .pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.kdept !== undefined && b.dataset.kdept === $("knowledgeDept").value && !$("knowledgeSearch").value.trim());
  });
  loadKnowledge();
});
$("knowledgeSearch")?.addEventListener("input", () => {
  clearTimeout(kSearchTimer);
  kSearchTimer = setTimeout(loadKnowledge, 240);
});
$("knowledgeSearch")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(kSearchTimer);
    loadKnowledge();
  }
});
$("clearKnowledgeSearch")?.addEventListener("click", () => {
  $("knowledgeSearch").value = "";
  document.querySelectorAll("#knowledgePills .pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.kdept !== undefined && b.dataset.kdept === $("knowledgeDept").value);
  });
  loadKnowledge();
});
document.querySelectorAll("#knowledgePills .pill-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#knowledgePills .pill-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.kdept !== undefined) {
      $("knowledgeDept").value = btn.dataset.kdept;
      $("knowledgeSearch").value = "";
    } else if (btn.dataset.kq !== undefined) {
      $("knowledgeDept").value = "";
      $("knowledgeSearch").value = btn.dataset.kq;
    }
    loadKnowledge();
  };
});

// ====== 文理智办 AI 状态与结构化 Markdown 渲染引擎 ======
async function checkAI() {
  try {
    let d = await api("/health");
    $("aiStatus").textContent = d.ai_configured ? "在线" : "未配置";
    $("aiStatus").classList.toggle("ready", d.ai_configured);
  } catch {
    $("aiStatus").textContent = "离线";
  }
}

/*
 * 链接要经得起模型的各种写法。老版本只认 [文字](url)，且正则 [^\s)]+ 会一路吞到
 * 句号、右括号、顿号上——`[教务处通知](https://jwc.x.edu.cn/a.html)。` 点开就是 404；
 * 模型直接甩一条裸地址时干脆不是链接。这里改成：
 *   ① 先把链接抠成占位符（此时还没转义，href 里的 & 不会被转成 &amp; 咬坏）
 *   ② 支持裸地址自动识别
 *   ③ 地址尾巴的中英文标点逐个剥干净，只放行 http/https/mailto
 *   ④ 最后统一转义正文，再还原链接
 */
const MD_URL_TRAIL_RE = /[.,;:!?'")\]}>】）》」』，。、；：！？…·～`]+$/;

// 剥掉被误吞到地址末尾的标点；维基那类自带成对括号的地址，右括号成对时保留
function trimUrlTail(input) {
  let s = String(input || "").trim();
  for (let guard = 0; guard < 10; guard++) {
    const m = s.match(MD_URL_TRAIL_RE);
    if (!m) break;
    let cut = m[0];
    const opens = (s.match(/\(/g) || []).length;
    const closes = (s.match(/\)/g) || []).length;
    if (closes <= opens) cut = cut.replace(/\)/g, "");
    if (!cut) break;
    s = s.slice(0, s.length - cut.length);
  }
  return s;
}

// 地址当链接文字时太长会把气泡撑破，收成“开头…结尾”，完整地址留在 title 里
function shortUrlText(url) {
  const s = String(url).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return s.length <= 56 ? s : `${s.slice(0, 32)}…${s.slice(-18)}`;
}

function mdAnchor(url, text) {
  const href = trimUrlTail(url);
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return esc(String(text || url || ""));
  const label = String(text || "").trim() || shortUrlText(href);
  return (
    `<a class="md-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"` +
    ` title="${esc(href)}">${esc(label)}</a>`
  );
}

function parseInlineMarkdown(raw) {
  const slots = [];
  const keep = html => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let s = String(raw ?? "");

  // ① 标准写法 [文字](地址)，地址可带尖括号；允许地址内部含成对括号（维基类条目）
  s = s.replace(
    /\[([^\]\n]{1,160})\]\(\s*<?((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+)>?\s*\)/g,
    (m, text, url) => keep(mdAnchor(url, text))
  );

  // ② 裸地址：只要前面不是字母数字或地址符号就认（中文标点、冒号、括号都算合法前导），
  //    避免把 wordshttps:// 这种粘在同一串里的切出来
  s = s.replace(
    /(^|[^\w./@%-])((?:https?:\/\/)[^\s<>"'`()[\]{}）】》」』，。；：！？]+)/g,
    (m, pre, url) => pre + keep(mdAnchor(url, ""))
  );

  // ③ 剩下的正文照常转义，再做行内代码与加粗
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // ④ 还原链接（占位符不是 & < > " '，不会被上面的转义碰到）
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] ?? "");
}

// 中文序号转阿拉伯数字，用于“第 1 步 / 第三步”这类流程行的圆形徽标
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return t;
  if (t === "十") return "10";
  if (t.length === 2 && t[0] === "十") return "1" + CN_NUM[t[1]];
  if (t.length === 2 && t[1] === "十") return CN_NUM[t[0]] + "0";
  return String(CN_NUM[t] || t);
}

/*
 * 【办理结论】【所需材料】【关键红线】… 这些是提示词规定死的模块标题。
 * 以前它们和正文一样只是加粗一行，长回答在手机上就是一整片黑字；
 * 现在按语义上色分块，学生扫一眼就能定位到“材料在哪、红线的哪一条”。
 */
const MD_SECTION_KINDS = [
  [/结论|依据|政策|适用|判断/, "decision", "target"],
  [/材料|表单|清单|证件|附件/, "materials", "clipboard"],
  [/流程|步骤|动线|顺序|程序/, "flow", "route"],
  [/红线|注意|风险|警示|禁止|违规/, "warn", "alert"],
  [/行动|待办|下一步|要做|执行/, "action", "check-square"],
  [/确认|追问|需要你|补充/, "ask", "bulb"],
];

function mdSectionKind(title) {
  for (const [re, kind, icon] of MD_SECTION_KINDS) if (re.test(title)) return [kind, icon];
  return ["note", "file-text"];
}

function formatMarkdownSafe(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  const lines = raw.split("\n");
  const out = [];
  let inCodeBlock = false;
  let codeLines = [];
  let listType = null;
  let listItems = [];
  let tableRows = [];

  const flushList = () => {
    if (!listType || !listItems.length) return;
    const cls = listType === "ol" ? "md-ol" : "md-list";
    out.push(`<${listType} class="${cls}">${listItems.join("")}</${listType}>`);
    listType = null;
    listItems = [];
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    if (tableRows.length === 1) {
      out.push(`<p class="md-p">${parseInlineMarkdown(tableRows[0])}</p>`);
      tableRows = [];
      return;
    }
    const parseCells = row =>
      row
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(c => parseInlineMarkdown(c.trim()));
    const headers = parseCells(tableRows[0]);
    const startIdx = /^\|[\s:-]+\|/.test(tableRows[1].trim()) ? 2 : 1;
    const bodyHtml = tableRows
      .slice(startIdx)
      .map(r => `<tr>${parseCells(r).map(c => `<td>${c}</td>`).join("")}</tr>`)
      .join("");
    out.push(
      `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers
        .map(h => `<th>${h}</th>`)
        .join("")}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`
    );
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushList();
      flushTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLines = [];
      } else {
        out.push(`<pre class="md-pre"><code>${esc(codeLines.join("\n"))}</code></pre>`);
        inCodeBlock = false;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (/^\|.+\|$/.test(trimmed)) {
      flushList();
      tableRows.push(trimmed);
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    if (!trimmed) {
      flushList();
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushList();
      out.push('<hr class="md-hr">');
      continue;
    }

    // 模块标题（可带 emoji、可被 ** 或 ### 包一层）：整行只认【】开头，正文里的引用不会误伤
    const secMatch = trimmed.match(
      /^(?:#{1,4}\s*)?\**\s*([\p{Extended_Pictographic}\u200d\uFE0F]*)\s*【([^】\n]{2,20})】\s*\**\s*[：:]?\s*(.*)$/u
    );
    if (secMatch) {
      flushList();
      flushTable();
      const secTitle = secMatch[2].trim();
      const secRest = (secMatch[3] || "").trim();
      const [kind, icon] = mdSectionKind(secTitle);
      out.push(
        `<div class="md-section md-section-${kind}">${ico(icon)}` +
          `<span class="md-section-title">${esc(secTitle)}</span>` +
          (secRest ? `<span class="md-section-rest">${parseInlineMarkdown(secRest)}</span>` : "") +
          `</div>`
      );
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      const content = parseInlineMarkdown(hMatch[2]);
      if (level <= 2) {
        out.push(`<h2 class="md-h2">${content}</h2>`);
      } else if (level === 3) {
        out.push(`<h3 class="md-h3">${content}</h3>`);
      } else {
        out.push(`<h4 class="md-h4">${content}</h4>`);
      }
      continue;
    }

    if (/^>\s*(.+)$/.test(trimmed)) {
      flushList();
      const qContent = parseInlineMarkdown(trimmed.replace(/^>\s*/, ""));
      out.push(`<blockquote class="md-quote">${qContent}</blockquote>`);
      continue;
    }

    // “第 1 步：登录教务系统…”：纯文本流程行也给序号徽标，顺序一眼可数
    const stepMatch = trimmed.match(
      /^(?:[-*•]\s*)?第\s*([0-9一二三四五六七八九十]+)\s*步\s*[：:.、]?\s*(.+)$/
    );
    if (stepMatch) {
      flushList();
      out.push(
        `<div class="md-step"><i>${esc(cnNum(stepMatch[1]))}</i><div>${parseInlineMarkdown(stepMatch[2])}</div></div>`
      );
      continue;
    }

    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(`<li>${parseInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (olMatch) {
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(`<li>${parseInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    out.push(`<p class="md-p">${parseInlineMarkdown(trimmed)}</p>`);
  }

  if (inCodeBlock && codeLines.length) {
    out.push(`<pre class="md-pre"><code>${esc(codeLines.join("\n"))}</code></pre>`);
  }
  flushList();
  flushTable();

  return `<div class="md-content">${out.join("")}</div>`;
}

/*
 * 从 AI 回答里抽“学生本人要做的动作”。
 * 老版本只认“办理流程/下一步行动”标题下的 1. 2. 3.，模型换个标题、写成一句话、
 * 或者干脆用“第 1 步：”就全部落空，于是永远显示“暂无可创建待办”。
 * 现在三路取：① 行动小节里的编号条目；② 全文里带明确动作与时限的句子；
 * ③ 都没有时才判定为真的没有待办。
 */
const TODO_ACTION_RE = /(?:提交|递交|送交|申请|预约|办理|登录|填写|填报|上传|下载|打印|携带|准备|核对|确认|联系|咨询|领取|缴纳|缴费|签字|签署|盖章|补交|发送|参加|查询|前往|完成|保存|录入|回复|反馈|报备|备案|沟通|办理|递送)/;
// 显式行动区：模型专门写给“要做什么”的地方，优先级最高
const TODO_SECTION_ACTIONS = ["下一步行动", "行动清单", "行动建议", "待办建议", "你需要做的事", "您需要做的事", "你需要做", "接下来要做", "下一步要做", "建议你现在做", "建议您现在做", "你现在要做的"];
// 流程区：写的是办事动线，里面有学生动作，但也有部门和材料，作为次选
const TODO_SECTION_FLOW = ["办理流程", "分步办理流程", "具体步骤", "办理步骤", "操作步骤", "办理动线", "办理程序"];
const TODO_SECTION_END = ["注意事项", "关键红线", "政策解读", "相关规定", "参考依据", "补充说明", "常见问题", "温馨提示", "结论", "总结", "政策依据", "办理结论", "所需材料", "材料清单", "来源", "参考资料", "需要你确认", "需向您确认", "下一步建议", "其他说明"];
const TODO_NON_STUDENT = /^(?:学校|学院|教务处|学生处|学生工作部|学工部|辅导员|任课教师|教学秘书|审核部门|工作人员|系统|平台|二级学院)(?:将|会|负责|统一|组织|进行|审核|办理|发布|通知|根据)/;
const TODO_NOISE = /^(?:以上|如下|具体如下|请注意|可以参考|根据上述|总的来说|综上所述|如需帮助|例如|比如|通常|一般来说|可能|可以考虑)/;

function guessDueDate(text) {
  const s = String(text || "");
  const now = new Date();
  let y = 0, m = 0, d = 0;
  const full = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  const monthDay = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (full) { y = +full[1]; m = +full[2]; d = +full[3]; }
  else if (monthDay) { y = now.getFullYear(); m = +monthDay[1]; d = +monthDay[2]; }
  else return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const pad = n => String(n).padStart(2, "0");
  let date = `${y}-${pad(m)}-${pad(d)}`;
  // 只写了“3月5日”而当天的 3 月 5 日已过，说明是明年的事
  if (!full && new Date(`${date}T23:59:59`) < now) date = `${y + 1}-${pad(m)}-${pad(d)}`;
  return date;
}

function extractStepsFromAnswer(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n")
    .map(line => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/^>\s*/, "").trim())
    .filter(Boolean);

  // 小节标题：容忍 ✅ 📌 🧭 这类前缀、markdown 加粗、以及“【下一步行动】：”的写法
  const sectionOf = line => {
    const bare = line
      .replace(/^[^\u4e00-\u9fa5A-Za-z0-9【\[（(]{1,4}\s*/, "")
      .replace(/^[【\[（(]\s*/, "")
      .replace(/\s*[】\]）)]\s*[：:]?\s*$/, "")
      .replace(/[：:]\s*$/, "")
      .trim();
    if (!bare || bare.length > 16) return "";
    if (TODO_SECTION_ACTIONS.some(k => bare === k || bare.startsWith(k))) return "actions";
    if (TODO_SECTION_FLOW.some(k => bare === k || bare.startsWith(k))) return "flow";
    if (TODO_SECTION_END.some(k => bare === k || bare.startsWith(k))) return "end";
    return "";
  };

  const ITEM_RE = /^(?:第\s*[一二三四五六七八九十\d]+\s*步\s*[：:.、]?|(?:[1-9]\d?)\s*[.、)）](?!\d)|[（(]\s*[1-9]\d?\s*[)）]|[①-⑳]|[-*•▪·]|\[\s?[xX]?\s?\])\s*(.+)$/;

  const tidy = raw => String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:第\s*[一二三四五六七八九十\d]+\s*步)\s*[：:.、]?\s*/, "")
    .replace(/^(?:请您?|建议您?|你(?:需要|要|得)?|您(?:需要|要|得)?|务必|记得|下一步)\s*[，,]?\s*/, "")
    .replace(/[。；;，,]+$/g, "")
    .trim();

  const acceptable = t => {
    if (!t || t.length < 4 || t.length > 60) return false;
    if (TODO_NOISE.test(t) || TODO_NON_STUDENT.test(t)) return false;
    if (/^(?:无需|不需要|不必)/.test(t)) return false;
    // “学生无需另行申请”这类句子带着动作词，但意思正好相反，不能当待办
    if (/(?:无需|无须|不需要|不必)(?:再|另行|亲自|单独)?(?:申请|办理|提交|前往|盖章|跑)/.test(t)) return false;
    if (/^(?:具体|详细|相关|以上|如下|其中)/.test(t)) return false;
    if (!TODO_ACTION_RE.test(t)) return false;
    // 纯材料名/文件名不是待办
    if (/^《[^》]+》$/.test(t)) return false;
    return true;
  };

  const actionItems = [];
  const flowItems = [];
  let active = "";
  for (const line of lines) {
    const kind = sectionOf(line);
    if (kind === "actions" || kind === "flow") { active = kind; continue; }
    if (kind === "end") { active = ""; continue; }
    if (!active) continue;
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const title = tidy(m[1]);
    if (!acceptable(title)) continue;
    (active === "actions" ? actionItems : flowItems).push(title);
  }

  // “下一步行动”是模型专门写给待办的地方，有它就只用它，不让流程区的部门动作挤占名额
  let picked = actionItems.length ? actionItems : flowItems;

  // 没有行动小节，或小节里没抽到：退回全文找“带动作 + 带时限/地点/系统”的句子
  if (!picked.length) {
    picked = [];
    const sentences = String(text ?? "").replace(/\r/g, "")
      .split(/[\n。；;]/)
      .map(s => s.replace(/\*\*/g, "").replace(/^[#>\s\-*•▪·]+/, "").trim())
      .filter(s => s.length >= 6 && s.length <= 80);
    for (const s of sentences) {
      const title = tidy(s.replace(/^(?:\d{1,2}\s*[.、)）]|[①-⑳])\s*/, ""));
      if (!acceptable(title)) continue;
      const hasSignal = /(系统|教务|平台|网站|学院|办公室|科室|教务处|学生处|辅导员|线下|线上|窗口|材料|表格|证明|原件|复印件|前|之前|截止|工作日|小时|天内|月\d|\d+月)/.test(title);
      if (!hasSignal) continue;
      picked.push(title);
      if (picked.length >= 3) break;
    }
  }

  const seen = new Set();
  return picked
    .filter(item => {
      const key = item.toLowerCase().replace(/[\s，。；;：:、,.!?！？]/g, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map(title => ({ title, due_date: guessDueDate(title) }));
}
/*
 * 只认“后端筛过、前端再筛过”的来源：
 * 首页/栏目页、相关性不达标的网页都不算，模型正文里出现的其它链接一律降级为纯文字。
 */
function usableSources(sources) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(sources) ? sources : []) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    let u;
    try { u = new URL(item.url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    if (["", "/", "/index.htm", "/index.html", "/index.jsp", "/index.php", "/tzgg.htm", "/tzgg.html", "/通知公告"].includes(path)) continue;
    // 网页来源必须带相关性评分；低于 0.3 的视为“搜到了但不相关”，不展示
    if (item.type === "web" && Number.isFinite(Number(item.relevance)) && Number(item.relevance) < 0.3) continue;
    // 搜索页、文库、下载站：点进去只有一堆无关条目，不配当“依据”
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (/^(baidu|m\.baidu|zhidao\.baidu|wenku\.baidu|so|sogou|bing|google|sm)\.(com|cn)$/.test(host)) continue;
    if (/(^|\.)(docin|doc88|book118|renrendoc|zxxk|docer|mbalib)\.(com|cn)$/.test(host)) continue;
    const key = (u.hostname.replace(/^www\./, "") + path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 5) break;
  }
  return out;
}

// 模型正文中的链接只有与本次后端返回的来源 URL 完全一致时才保留；其余英文/编造链接降级为纯文字。
/*
 * 元话语清理：模型偶尔会把内部约束复述给用户，例如
 * “（注：以上链接均可直接打开，不存在伪造链接）”“说明：本次未使用虚构来源”。
 * 学生要的是办事办法，不需要看到这些；直接静默删掉，也不留“已清理”之类的痕迹。
 */
const META_TALK_SENTENCE_RES = [
  /(链接|网址|URL|来源)[^。！？\n]{0,24}(伪造|编造|虚构|捏造|造假|真伪|真实性|虚假|不实)/i,
  /(伪造|编造|虚构|捏造)[^。！？\n]{0,12}(链接|网址|URL|来源)/i,
  /(以上|以下|下方|下列|下面|这些|本文|本次)[^。！？\n]{0,10}(链接|网址|来源)[^。！？\n]{0,20}(均|都|已|可|真实|有效|官方|来自|核对|验证)/,
  /(链接|网址|来源)[^。！？\n]{0,12}(均|都)(为|是|来自|可|已)[^。！？\n]{0,12}(官网|官方|原文|真实|有效|核对)/,
  /(链接|网址)[^。！？\n]{0,12}(放心|安全|保真|不会失效|均可打开)/,
  /(未|没有|不)(会)?(自行)?(拼接|生成|编造|伪造)[^。！？\n]{0,8}(链接|网址|URL)/i,
  /(检索|搜索|查找|匹配)[^。！？\n]{0,12}(过程|日志|记录)[^。！？\n]{0,10}(不|无|省略|此处|如下)/,
];

function stripMetaTalk(text) {
  let out = String(text || "");
  if (!out) return out;
  // 括注式说明：只在括号里谈链接/来源/检索时整段去掉，有用信息（如“带录取通知书”）原样保留
  out = out.replace(/[（(]\s*(注|说明|备注|提示)\s*[:：][^）)]{0,160}[）)]/g, m =>
    /链接|网址|来源|检索|搜索|伪造|编造|真实|有效|URL/i.test(m) ? "" : m
  );
  out = (out.match(/[^。！？；\n]+[。！？；\n]*/g) || [])
    .filter(seg => !META_TALK_SENTENCE_RES.some(re => re.test(seg)))
    .join("");
  return out
    .replace(/[ \t]+([，。；：、！？])/g, "$1")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/^[ \t]*[-*·][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function sanitizeAnswerLinks(text, sources) {
  const allowed=new Set(usableSources(sources).map(s=>{try{return new URL(s.url).href.replace(/\/$/,"");}catch{return "";}}).filter(Boolean));
  let out=stripMetaTalk(text);
  out=out.replace(/\[([^\]]{1,240})\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/gi,(all,label,url)=>{
    try { const normalized=new URL(url).href.replace(/\/$/,""); return allowed.has(normalized)?all:label; } catch { return label; }
  });
  out=out.replace(/https?:\/\/[^\s<>）】\]]+/gi,url=>{
    const clean=url.replace(/[，。；;！？!?]+$/g,"");
    try { return allowed.has(new URL(clean).href.replace(/\/$/,""))?url:""; } catch { return ""; }
  });
  return out;
}

function normalizeTaskTitle(value) {
  return String(value || "").toLowerCase().replace(/[\s，。；;：:、,.!?！？]/g, "").replace(/^(办理事项|跟进咨询事项|待办)[:：]/, "");
}

/*
 * 回答是否“写完了”：结尾停在逗号、顿号、冒号、半个括号或未闭合引号，就是半句话。
 * 与后端 answerLooksComplete 保持同一套判定，避免两边对同一条回答给出不同结论。
 */
const ANSWER_TAIL_OK = /[。！？…」』”"'）)\]】》!?.~～]$/;
const ANSWER_TAIL_BAD = /[，、,;；:：·（(\[【《〈“"'\-—]$/;
// 停在虚词上：中文句子不会这样收尾，基本可判定是被切断
const ANSWER_TAIL_CUT = /[的该和与或及以于并且是在对为把被从此等而但就都也还很更最不没无]$/;

function answerLooksComplete(text) {
  const t = String(text || "").trimEnd();
  if (!t) return false;
  // 括号/引号没闭合，说明话说到一半被切断
  const openers = (t.match(/[（(\[【《〈“‘]/g) || []).length;
  const closers = (t.match(/[）)\]】》〉”’]/g) || []).length;
  if (openers > closers) return false;
  if (ANSWER_TAIL_BAD.test(t)) return false;
  if (ANSWER_TAIL_CUT.test(t)) return false;
  if (ANSWER_TAIL_OK.test(t)) return true;
  // 行动清单的最后一条本来就不带句号，只要是个说得完整的条目就算写完了
  const lastLine = t.split("\n").map(s => s.trim()).filter(Boolean).pop() || "";
  if (/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])/.test(lastLine)
    && lastLine.replace(/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])\s*/, "").length >= 10) return true;
  // 无收尾标点：只有很短的一句结论才当它写完了
  return t.length <= 20;
}

function openAiTodoReview(items, sourceQuestion = "") {
  aiTodoSourceQuestion = sourceQuestion;
  const existing = new Set(tasks.filter(t => t.status === "pending").map(t => normalizeTaskTitle(t.title)));
  const seen = new Set();
  aiTodoDraft = (items || []).map(item => typeof item === "string" ? { title: item, due_date: "", selected: true } : ({ title: String(item.title || ""), due_date: item.due_date || "", selected: item.selected !== false }))
    .filter(item => item.title.trim())
    .filter(item => { const key = normalizeTaskTitle(item.title); if (!key || seen.has(key)) return false; seen.add(key); return true; })
    .map(item => ({ ...item, duplicate: existing.has(normalizeTaskTitle(item.title)) }));

  const list = $("aiTodoList");
  if (!list) return toast("待办审核界面尚未加载，请刷新页面后重试");
  // 一条都没抽到时不留空窗：给一行空白草稿，学生自己写一句就能存进待办
  const manualMode = !aiTodoDraft.length;
  if (manualMode) {
    aiTodoDraft = [{ title: "", due_date: "", selected: true, duplicate: false, manual: true }];
  }
  list.innerHTML = aiTodoDraft.map((item, index) => `
    <div class="ai-todo-draft ${item.duplicate ? "is-duplicate" : ""}" data-draft-row="${index}">
      <label class="ai-todo-select"><input type="checkbox" data-draft-select="${index}" ${item.selected && !item.duplicate ? "checked" : ""} ${item.duplicate ? "disabled" : ""}><span>${item.duplicate ? "疑似重复" : manualMode ? "新待办" : `步骤 ${index + 1}`}</span></label>
      <div class="ai-todo-fields">
        <input data-draft-title="${index}" maxlength="200" value="${esc(item.title)}" placeholder="${manualMode ? "例如：登录教务系统提交缓考申请（考试前完成）" : ""}" aria-label="待办标题 ${index + 1}" ${item.duplicate ? "disabled" : ""}>
        <label>截止日期（选填）<input type="date" data-draft-due="${index}" value="${esc(item.due_date)}" ${item.duplicate ? "disabled" : ""}></label>
      </div>
    </div>`).join("");
  $("aiTodoCount").textContent = manualMode
    ? "这条回答里没有现成动作，直接写一条要办的事即可"
    : `${aiTodoDraft.filter(x => !x.duplicate).length} 条可添加 · ${aiTodoDraft.filter(x => x.duplicate).length} 条疑似重复`;
  $("aiTodoDialog").showModal();
  // 空白草稿直接把光标放进输入框，少一次点击
  if (manualMode) setTimeout(() => document.querySelector('[data-draft-title="0"]')?.focus(), 60);
}

$("closeAiTodoDialog")?.addEventListener("click", () => $("aiTodoDialog").close());
$("cancelAiTodoDialog")?.addEventListener("click", () => $("aiTodoDialog").close());
$("aiTodoList")?.addEventListener("input", event => {
  const el = event.target;
  if (el.matches("[data-draft-title]")) aiTodoDraft[Number(el.dataset.draftTitle)].title = el.value;
  if (el.matches("[data-draft-due]")) aiTodoDraft[Number(el.dataset.draftDue)].due_date = el.value;
});
$("aiTodoList")?.addEventListener("change", event => {
  const el = event.target;
  if (el.matches("[data-draft-select]")) aiTodoDraft[Number(el.dataset.draftSelect)].selected = el.checked;
});
$("confirmAiTodoImport")?.addEventListener("click", async () => {
  const selected = aiTodoDraft.filter((item, index) => {
    const check = document.querySelector(`[data-draft-select="${index}"]`);
    const title = document.querySelector(`[data-draft-title="${index}"]`);
    const due = document.querySelector(`[data-draft-due="${index}"]`);
    item.title = (title?.value || "").trim();
    item.due_date = due?.value || "";
    item.selected = !!check?.checked;
    return item.selected && !item.duplicate && item.title.length >= 2;
  });
  if (!selected.length) return toast("请至少勾选一条有效待办事项");
  const btn = $("confirmAiTodoImport");
  btn.disabled = true;
  btn.textContent = "正在保存…";
  try {
    const res = await api("/tasks/batch", { method: "POST", body: JSON.stringify({ items: selected.map(({ title, due_date }) => ({ title, due_date })) }) });
    tasks = await api("/tasks");
    renderTasks(); renderHome();
    $("aiTodoDialog").close();
    toast(res.message || `已保存 ${selected.length} 条待办`);
  } catch (e) {
    toast(e.message || "保存失败，请稍后重试");
  } finally {
    btn.disabled = false;
    btn.textContent = "确认添加到我的待办";
  }
});

function appendSourcesCard(parentEl, sources, label) {
  // 前端再次兜底：只展示“具体文章页 + 与问题相关”的链接，首页与无关网页一律不出现。
  const validSources = usableSources(sources);
  if (!validSources.length) return;
  const src = document.createElement("div");
  src.className = "ai-sources";
  const title = document.createElement("b");
  title.innerHTML = label || `${ico("link", "ico-xs")}可直接打开的原文链接`;
  src.appendChild(title);
  validSources.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "source-item-row";
    const a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${i + 1}. ${item.title || item.url}`;
    a.title = `${item.title || item.url}${item.date ? "（" + item.date + " 发布）" : ""}`;
    row.appendChild(a);

    // 让学生一眼看出这条是官网还是外部网页，以及发布时间——判断可信度比“能点开”更重要
    const meta = document.createElement("span");
    meta.className = "source-meta";
    let host = "";
    try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
    if (item.isOfficial) {
      const badge = document.createElement("b");
      badge.className = "src-badge official";
      badge.textContent = "官网";
      meta.appendChild(badge);
    }
    meta.appendChild(document.createTextNode([host, item.date].filter(Boolean).join(" · ")));
    if (meta.textContent.trim()) row.appendChild(meta);
    src.appendChild(row);
  });
  parentEl.appendChild(src);
}

/*
 * 依据强度徽标：让学生一眼看出这段回答“有多少原文撑着”。
 * 放在来源区之前——先说明可信度，再看链接，比反过来更符合阅读顺序。
 */
function appendConfidenceBadge(parentEl, confidence, sources) {
  const map = {
    high: { text: "依据充分", cls: "high", tip: "已找到与问题对应的校内文件或官网页面" },
    medium: { text: "依据有限", cls: "medium", tip: "只找到部分相关材料，具体细节以主管部门最新通知为准" },
    low: { text: "未找到原文", cls: "low", tip: "校内文件库与官网均未检索到直接依据，以下为办理路径建议" }
  };
  const info = map[confidence];
  if (!info) return;
  // 依据充分时不打扰：只在中/弱时提示，避免每条回答都挂一个标签
  if (info.cls === "high" && (!sources || !sources.length)) return;
  const el = document.createElement("div");
  el.className = "ai-confidence " + info.cls;
  el.title = info.tip;
  el.innerHTML = `<i></i><span>${info.text}</span><small>${info.tip}</small>`;
  parentEl.appendChild(el);
}

/* 回答结束后的追问建议：点击即填入输入框并直接提问，减少手动打字 */
function appendFollowUps(parentEl, items) {
  const list = (Array.isArray(items) ? items : [])
    .map(s => String(s || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!list.length) return;
  const box = document.createElement("div");
  box.className = "followup-box";
  const label = document.createElement("small");
  label.textContent = "你可能还想问";
  box.appendChild(label);
  const chips = document.createElement("div");
  chips.className = "followup-chips";
  list.forEach(text => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.onclick = () => {
      const q = $("question");
      if (!q) return;
      if (aiBusy) return toast("请等待当前回答完成或先点停止");
      q.value = text;
      autoResizeQuestion();
      $("askForm").requestSubmit();
    };
    chips.appendChild(btn);
  });
  box.appendChild(chips);
  parentEl.appendChild(box);
}

/* 是否已经有可直接打开的原文链接（决定是否还需要用文件名芯片补位） */
function hasUrlSources(sources) {
  return usableSources(sources).length > 0;
}

/* 本次回答参考的校内文件：点击直接打开制度原文阅读器，比外链更能提升可信度 */
function appendKnowledgeChips(parentEl, titles) {
  const list = Array.isArray(titles)
    ? [...new Set(titles.map(t => String(t || "").trim()).filter(Boolean))].slice(0, 4)
    : [];
  if (!list.length) return;
  const box = document.createElement("div");
  box.className = "followup-box knowledge-ref-box";
  const label = document.createElement("small");
  label.innerHTML = `${ico("link", "ico-xs")}本次回答参考的校内文件（${list.length}）· 点击查看原文`;
  box.appendChild(label);
  const chips = document.createElement("div");
  chips.className = "followup-chips";
  list.forEach(title => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-ref-chip";
    btn.textContent = title;
    btn.title = "查看制度原文";
    btn.onclick = () => {
      if (typeof openDocReader === "function") openDocReader(title);
    };
    chips.appendChild(btn);
  });
  box.appendChild(chips);
  parentEl.appendChild(box);
}

function appendCopyTools(wrapEl, textGetter, retryQuestion = "") {
  const tools = document.createElement("div");
  tools.className = "bubble-tools";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.innerHTML = `${ico("copy", "ico-xs")}复制回答`;
  copyBtn.onclick = async () => {
    const text = typeof textGetter === "function" ? textGetter() : textGetter;
    const ok = await copyTextSafe(text);
    toast(ok ? "回答已复制到剪贴板" : "复制失败，请长按文字复制");
  };
  tools.appendChild(copyBtn);

  const answerText = typeof textGetter === "function" ? textGetter() : textGetter;
  const steps = extractStepsFromAnswer(answerText);
  const todoBtn = document.createElement("button");
  todoBtn.type = "button";
  todoBtn.className = "todo-action-btn";
  if (steps.length) {
    // 有话直说：能转几条、点进去还能改，比一个失败状态的按钮有用得多
    todoBtn.innerHTML = `${ico("check-square", "ico-xs")}加入待办（${steps.length} 条）`;
    todoBtn.title = "先检查、编辑并选择要保存的事项，不会直接把整段回答拆成任务";
    todoBtn.onclick = () => openAiTodoReview(steps, retryQuestion);
  } else {
    // 抽不到行动时不显示失败态，直接给一个“自己写一条”的入口
    todoBtn.classList.add("is-manual");
    todoBtn.innerHTML = `${ico("plus", "ico-xs")}自己加一条待办`;
    todoBtn.title = "这条回答里没有可直接执行的行动，可以自己写一条";
    todoBtn.onclick = () => openAiTodoReview([], retryQuestion);
  }
  tools.appendChild(todoBtn);

  if (retryQuestion) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.innerHTML = `${ico("refresh", "ico-xs")}重新生成`;
    retryBtn.onclick = () => {
      $("question").value = retryQuestion;
      autoResizeQuestion();
      $("askForm").requestSubmit();
    };
    tools.appendChild(retryBtn);
  }

  wrapEl.appendChild(tools);
}

function createMsgMeta(who) {
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (who === "user") {
    const userChar = me && me.display_name ? me.display_name.slice(0, 1) : "我";
    meta.innerHTML = `<span class="msg-avatar user">${esc(userChar)}</span><span class="msg-sender">我</span>`;
  } else {
    meta.innerHTML = `<span class="msg-avatar ai">${ico("sparkles")}</span><span class="msg-sender">文理智办 AI</span>`;
  }
  return meta;
}

function message(s, who = "", sources = [], isRestoring = false, reasoning = "") {
  const rawText = String(s ?? "").trim();
  const cleanText = who === "user" ? rawText : sanitizeAnswerLinks(rawText, sources);
  if (!cleanText) return;

  chatHistory.push({
    role: who === "user" ? "学生" : "文理智办",
    content: cleanText,
    sources: sources || [],
    reasoning: reasoning || ""
  });
  if (!isRestoring) saveChatToLocal();

  const roleClass = who === "user" ? "msg-user" : "msg-ai";
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap " + roleClass;
  wrap.appendChild(createMsgMeta(who));

  const d = document.createElement("div");
  d.className = "bubble " + roleClass;
  if (who === "user") {
    d.textContent = cleanText;
  } else {
    let html = "";
    if (reasoning && reasoning.trim()) {
      html += `<details class="ai-reasoning"><summary>${ico("bulb", "ico-xs")}已深度思考（点击查看推理过程）</summary><div class="ai-reasoning-body">${esc(reasoning.trim())}</div></details>`;
    }
    html += formatMarkdownSafe(cleanText);
    d.innerHTML = html;
  }
  wrap.appendChild(d);

  if (who !== "user") {
    appendCopyTools(wrap, () => cleanText);
  }

  if (sources && sources.length) {
    appendSourcesCard(wrap, sources);
  }

  $("messages").appendChild(wrap);
  if (who === "user" && !isRestoring) {
    scrollMessagesToBottom(true);
  } else {
    scrollMessagesToBottom(false);
  }
}

// 清空与导出对话按键
$("clearChat")?.addEventListener("click", () => {
  chatHistory = [];
  try {
    localStorage.removeItem(CHAT_CACHE_KEY);
  } catch {}
  $("messages").innerHTML = getWelcomeMarkup(true);
  toast("对话记录已清空");
});

$("exportChat")?.addEventListener("click", () => {
  if (!chatHistory.length) return toast("当前暂无可导出的对话记录");
  const content = chatHistory
    .map(m => {
      let s = `【${m.role}】\n${m.content}\n`;
      // 导出也用同一套筛选：只写“真相关、能打开”的链接，不把无关网页写进文档
      const srcList = usableSources(m.sources);
      if (srcList.length) {
        s +=
          "\n引用来源（可核验）：\n" +
          srcList
            .map(
              (x, i) =>
                `  ${i + 1}. ${x.title || x.url}${x.isOfficial ? "（学校官网）" : ""}${x.date ? "（" + x.date + " 发布）" : ""}\n     ${x.url}`
            )
            .join("\n");
      }
      return s;
    })
    .join("\n----------------------------------------\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `文理智办咨询记录_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  toast("咨询记录已导出");
});

// 输入框高度自适应
// 输入框空着的时候发送键不该是亮的：一亮就像“已经可以发了”，按下去却什么都不发生
function syncAskIdle() {
  const el = $("question");
  const b = $("askSubmitBtn");
  if (!el || !b) return;
  b.classList.toggle("is-idle", !el.value.trim() && !aiBusy);
}

function autoResizeQuestion() {
  const el = $("question");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
  syncAskIdle();
}

$("question")?.addEventListener("input", autoResizeQuestion);
syncAskIdle();

// 手机上既没有 Shift 键、也放不下长提示，长 placeholder 会折成两行把输入框重新撑高
function syncQuestionPlaceholder() {
  const el = $("question");
  if (!el) return;
  el.placeholder = window.innerWidth > 720
    ? "输入办事问题（按 Enter 发送，Shift+Enter 换行）…"
    : "输入办事问题…";
}
syncQuestionPlaceholder();
window.addEventListener("resize", syncQuestionPlaceholder);

// 支持电脑端 Enter 快捷发送
$("question")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 1000) {
    e.preventDefault();
    $("askForm").requestSubmit();
  }
});

// AI 提问处理（自适应兼容流式 SSE 与普通 JSON，支持深度思考过程折叠展示）
/*
 * 发送 / 停止合并为一个键：空着是“发送”，生成中就变成“停止”，点一下立刻中断。
 * 少一个键，手机上也不用在两个按钮之间找。
 */
function setAskBusy(busy) {
  aiBusy = busy;
  const b = $("askSubmitBtn");
  if (!b) return;
  b.classList.toggle("is-stop", busy);
  b.setAttribute("aria-label", busy ? "停止生成" : "发送");
  b.innerHTML = busy ? `<span>停止</span> <i>${ico("stop")}</i>` : `<span>发送</span> <i>${ico("arrow-up")}</i>`;
  syncAskIdle();
}

$("askSubmitBtn")?.addEventListener("click", () => {
  if (aiBusy) {
    if (typeof aiAbortHandler === "function") aiAbortHandler();
    return;
  }
  $("askForm").requestSubmit();
});

$("askForm").onsubmit = async e => {
  e.preventDefault();
  // 生成中按回车不再叠一个新请求
  if (aiBusy) return;
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  autoResizeQuestion();

  $("aiOptionsBar")?.classList.remove("open");
  $("toggleAiConfig")?.classList.remove("added");

  streamFollowBottom = true;
  message(q, "user");

  const controller = new AbortController();
  let aborted = false;
  setAskBusy(true);
  aiAbortHandler = () => {
    aborted = true;
    try { controller.abort(); } catch {}
  };

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai";
  wrap.appendChild(createMsgMeta("ai"));

  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("sparkles", "ico-xs")}正在检索校规库并思考中</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  scrollMessagesToBottom(true);

  let fullAnswer = "";
  let fullReasoning = "";
  let sources = [];
  let sourcesLabel = "";
  let confidence = "";
  let followUps = [];
  let answerDocs = [];
  let streamedContent = false;
  let retried = false;
  // 截断侦测：上游 token 到顶、连接被掐断，都会让流“看起来正常结束”，这里单独记下来
  let finishReason = "";
  let truncatedFlag = false;
  let continuedTimes = 0;
  // 长时间收不到任何字节（网关挂住、上游排队）时主动收尾，别让学生对着转圈等
  let cutByTimeout = false;
  // 流中途返回的错误：有内容就保留内容，没内容才当失败
  let softError = "";

  const renderStreamingBubble = (isStreaming = true) => {
    let html = "";
    if (fullReasoning.trim()) {
      const summaryLabel =
        !fullAnswer.trim() && isStreaming
          ? `${ico("bulb", "ico-xs")}正在深度思考并核对学校条款（点击展开）…`
          : `${ico("bulb", "ico-xs")}已深度思考（点击查看推理过程）`;
      html += `<details class="ai-reasoning"><summary>${summaryLabel}</summary><div class="ai-reasoning-body">${esc(fullReasoning.trim())}</div></details>`;
    }
    if (fullAnswer.trim()) {
      // 流式过程中也先过一遍元话语清理：这类话多半出现在句尾，等整条回答结束再清就会先闪一下
      html += formatMarkdownSafe(stripMetaTalk(fullAnswer));
    } else if (isStreaming) {
      html += `<div class="ai-thinking-status"><span>${ico("sparkles", "ico-xs")}正在生成办事指引</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
    }
    bubble.innerHTML = html;
  };

  const friendlyError = err => {
    const msg = String((err && err.message) || err || "未知错误");
    if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
      return "网络连接中断（请求未能到达服务器，或数据传输被中断）。请检查网络后重试；若反复出现，可尝试切换网络或暂时关闭“联网搜索”再试。";
    }
    return msg;
  };

  const runAsk = async (continueFrom = "") => {
    const searchToggle = $("aiWebSearch");
    const webSearch = Boolean(searchToggle && searchToggle.checked);
    const payload = {
      question: q,
      model: $("aiModel")?.value || "deepseek-flash",
      thinking: $("aiThinking")?.checked !== false,
      reasoning_effort: $("aiEffort")?.value || "high",
      web_search: webSearch,
      // 上一次输出被截断时，把已生成的内容回传给模型，让它从断点接着写完
      ...(continueFrom ? { continue_from: continueFrom.slice(-4000) } : {}),
      history: chatHistory.slice(-9, -1).map(m => ({
        role: m.role === "学生" ? "user" : "assistant",
        content: String(m.content).slice(0, 2000)
      }))
    };

    const res = await fetch(API + "/ai/ask", {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.detail || "请求失败（HTTP " + res.status + "）");
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("application/json")) {
      const d = await res.json();
      fullAnswer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
      fullReasoning = String(d.reasoning || d.choices?.[0]?.message?.reasoning_content || "").trim();
      sources = d.sources || [];
      sourcesLabel = d.sources_label || sourcesLabel;
      if (fullAnswer) {
        renderStreamingBubble(false);
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawFallback = "";
      // 首包给足时间（检索 + 排队）；可用 window.XZ_AI_IDLE_MS 覆盖，便于联调
      let idleMs = Number(window.XZ_AI_IDLE_MS) || 45000;

      const processLine = line => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) return;
        const dataStr = trimmed.replace(/^data:\s*/, "").trim();
        if (dataStr === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          return;
        }

        if (parsed.error) {
          // 服务端中途报错：先记下来，等把已经收到的内容渲染完再决定怎么提示，
          // 直接抛会让学生连前半段都看不到
          softError = String(parsed.error);
          return;
        }

        if (parsed.type === "meta") {
          sources = parsed.sources || [];
          sourcesLabel = parsed.sources_label || "";
          confidence = parsed.confidence || "";
          if (Array.isArray(parsed.followups)) followUps = parsed.followups;
          if (Array.isArray(parsed.knowledge_docs)) answerDocs = parsed.knowledge_docs;
          return;
        }

        // 后端在流末尾补的截断标记：finish_reason=length，或正文停在半句
        if (parsed.type === "truncated") {
          truncatedFlag = true;
          return;
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = String(parsed.choices[0].finish_reason);
        }

        const deltaReason = parsed.choices?.[0]?.delta?.reasoning_content || "";
        const deltaContent =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          parsed.answer ??
          "";

        if (deltaReason) {
          fullReasoning += deltaReason;
          renderStreamingBubble(true);
          followStreamIfAtBottom();
        }

        if (deltaContent) {
          fullAnswer += deltaContent;
          if (fullAnswer.trim()) {
            streamedContent = true;
            renderStreamingBubble(true);
            followStreamIfAtBottom();
          }
        }
      };

      // 停止信号：与 reader.read() 竞争，保证“停止”在任意时刻都能立刻生效
      const abortedPromise = new Promise((_, reject) => {
        const onAbort = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      abortedPromise.catch(() => {});

      while (true) {
        // 主动停止时立即中断读取：不依赖浏览器一定把 abort 传递给 body 流
        if (aborted) {
          try { await reader.cancel(); } catch {}
          break;
        }
        // 空闲超时：首包给足时间（要检索、排队），之后只要还在出字就不算卡住
        let idleTimer = null;
        const idlePromise = new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            const e = new Error("idle-timeout");
            e.name = "IdleTimeout";
            reject(e);
          }, idleMs);
        });
        let chunk;
        try {
          chunk = await Promise.race([reader.read(), abortedPromise, idlePromise]);
        } catch (readErr) {
          try { await reader.cancel(); } catch {}
          if (readErr && readErr.name === "IdleTimeout") {
            cutByTimeout = true;
            break;
          }
          throw readErr;
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = chunk;
        if (done) break;
        idleMs = Number(window.XZ_AI_IDLE_MS) || 22000;
        const chunkText = decoder.decode(value, { stream: true });
        rawFallback += chunkText;
        buffer += chunkText;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          processLine(line);
        }
      }
      if (aborted) {
        const stopErr = new Error("aborted");
        stopErr.name = "AbortError";
        throw stopErr;
      }
      if (buffer.trim()) {
        processLine(buffer);
      }

      if (!fullAnswer.trim() && rawFallback.trim().startsWith("{")) {
        try {
          const d = JSON.parse(rawFallback.trim());
          fullAnswer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
          sources = d.sources || sources;
          if (fullAnswer) renderStreamingBubble(false);
        } catch {}
      }
    }

    if (softError && !fullAnswer.trim()) throw new Error(softError);
    fullAnswer = sanitizeAnswerLinks(fullAnswer.trim(), sources);
  };

  // 收尾渲染只做一次：续写是同一轮回答，不能重复 push 历史、重复挂工具条
  const finalize = () => {
    if (!fullAnswer) {
      fullAnswer = "模型未返回有效内容，请尝试取消勾选“深度思考”或重新发送问题。";
      bubble.innerHTML = `<span class="muted">${esc(fullAnswer)}</span>`;
      return;
    }
    renderStreamingBubble(false);
    chatHistory.push({
      role: "文理智办",
      content: fullAnswer,
      sources: sources || [],
      reasoning: fullReasoning.trim()
    });
    saveChatToLocal();
    appendCopyTools(wrap, () => fullAnswer, q);
    appendConfidenceBadge(wrap, confidence, sources);
    appendSourcesCard(wrap, sources, sourcesLabel);
    // 有可打开的原文链接时不再重复列出文件名，避免同一个依据出现两遍
    if (!hasUrlSources(sources)) appendKnowledgeChips(wrap, answerDocs);
    appendFollowUps(wrap, followUps);
    // 生成中断但保住了正文：提示一句，学生知道这不是完整版
    if (softError) {
      const note = document.createElement("div");
      note.className = "stopped-note";
      note.innerHTML = `${ico("alert", "ico-xs")}生成过程被中断，以上为已收到的内容`;
      bubble.appendChild(note);
    }
  };

  /*
   * 一条回答可能被上游中途掐断：finish_reason=length（token 到顶）、
   * 或者流提前结束、正文停在“的/该/，”。
   * 这两种情况下学生看到的都是半句话，因此这里自动接上，最多续写两次。
   */
  const askWithContinuation = async () => {
    let continuingNote = null;
    await runAsk("");
    for (let i = 0; i < 2; i++) {
      if (aborted) break;
      const needContinue =
        !cutByTimeout && (
          finishReason === "length" ||
          truncatedFlag ||
          // 上游明确说 stop 就是写完了；只有拿不到 finish_reason（连接被掐断）时才看文本形态
          (!finishReason && fullAnswer.trim().length > 0 && !answerLooksComplete(fullAnswer))
        );
      if (!needContinue) break;
      if (!fullAnswer.trim()) break;
      const lengthBefore = fullAnswer.length;
      finishReason = "";
      truncatedFlag = false;
      continuedTimes++;
      if (!continuingNote) {
        continuingNote = document.createElement("div");
        continuingNote.className = "ai-continuing-note";
        continuingNote.textContent = "内容较长，正在接着写完…";
        bubble.appendChild(continuingNote);
      }
      await runAsk(fullAnswer);
      // 续写没有带来新内容说明模型也写不动了，再试也没意义
      if (fullAnswer.length <= lengthBefore + 5) break;
    }
    continuingNote?.remove();
  };

  // 用户点“停止”：保留已生成内容，不报错、不丢弃
  const handleStopped = () => {
    const partial = sanitizeAnswerLinks(fullAnswer.trim(), sources);
    if (!partial) {
      bubble.innerHTML = `<span class="muted">已停止生成</span>`;
      return;
    }
    fullAnswer = partial;
    renderStreamingBubble(false);
    const stopNote = document.createElement("div");
    stopNote.className = "stopped-note";
    stopNote.innerHTML = `${ico("stop", "ico-xs")}已停止生成，以上为已输出的部分内容`;
    bubble.appendChild(stopNote);
    chatHistory.push({
      role: "文理智办",
      content: fullAnswer + "\n\n（此回答由用户中途停止生成）",
      sources: sources || [],
      reasoning: fullReasoning.trim()
    });
    saveChatToLocal();
    appendCopyTools(wrap, () => fullAnswer, q);
    appendConfidenceBadge(wrap, confidence, sources);
    appendSourcesCard(wrap, sources, sourcesLabel);
    if (!hasUrlSources(sources)) appendKnowledgeChips(wrap, answerDocs);
    appendFollowUps(wrap, followUps);
    toast("已停止生成，保留已输出内容");
  };

  try {
    await askWithContinuation();
    if (aborted) {
      // 流被主动中断时机不一定抛错，这里补上停止态的渲染
      handleStopped();
    } else if (cutByTimeout && !fullAnswer.trim()) {
      bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}服务器长时间没有返回内容，请稍后重试。</span>`;
    } else {
      finalize();
      if (cutByTimeout && fullAnswer.trim()) {
        // 必须在 finalize 之后追加：finalize 会重绘气泡
        const cutNote = document.createElement("div");
        cutNote.className = "stopped-note";
        cutNote.innerHTML = `${ico("clock", "ico-xs")}网络响应超时，以上为已收到的内容`;
        bubble.appendChild(cutNote);
        toast("网络较慢，已保留已生成的内容");
      }
    }
  } catch (err) {
    const isAbort = err && (err.name === "AbortError" || /aborted|abort/i.test(String(err.message || "")));
    const isNetworkErr =
      err instanceof TypeError ||
      /failed to fetch|networkerror|load failed/i.test(String(err.message || ""));
    if (isAbort || aborted) {
      handleStopped();
    } else if (isNetworkErr && !streamedContent && !retried) {
      retried = true;
      bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("refresh", "ico-xs")}网络波动，正在自动重试</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
      try {
        await askWithContinuation();
        if (aborted) handleStopped();
        else finalize();
      } catch (err2) {
        bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}请求出错：${esc(friendlyError(err2))}</span>`;
      }
    } else {
      bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}请求出错：${esc(friendlyError(err))}</span>`;
    }
  } finally {
    // 无论成功、报错还是中途停止，按钮必须回到“发送”，否则页面会卡在停止态
    aiAbortHandler = null;
    setAskBusy(false);
    followStreamIfAtBottom();
  }
};

$("aiThinking")?.addEventListener("change", () => {
  $("aiEffort").disabled = !$("aiThinking").checked;
});

(async () => {
  try {
    await api("/health");
    if (token) await enter();
  } catch {}
})();

async function loadUsers() {
  try {
    if (me?.role !== "admin") {
      toast("仅管理员可以管理用户");
      return;
    }
    let list = await api("/users");
    let q = ($("userSearch").value || "").toLowerCase();
    list = list.filter(u =>
      (u.username + u.display_name + u.role).toLowerCase().includes(q)
    );
    $("userList").innerHTML =
      list
        .map(
          u => `<div class="taskrow user-row">
            <span class="tag">${u.role === "admin" ? "管理员" : "学生"}</span>
            <div class="tasktext">
              <b>${esc(u.display_name)}</b>
              <small>用户名：${esc(u.username)} · 注册：${date(u.created_at)}</small>
            </div>
            <select data-role="${u.id}" ${u.id === me.id ? "disabled" : ""}>
              <option value="student" ${u.role === "student" ? "selected" : ""}>学生</option>
              <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理员</option>
            </select>
            <button type="button" class="outline" data-reset-pwd="${u.id}" data-uname="${esc(u.display_name)}">${ico("key", "ico-xs")}重置密码</button>
            ${
              u.id === me.id
                ? '<span class="muted">当前账号</span>'
                : `<button class="danger" data-delete-user="${u.id}">删除用户</button>`
            }
          </div>`
        )
        .join("") || '<p class="muted">暂无用户。</p>';

    document.querySelectorAll("[data-role]").forEach(sel => {
      sel.onchange = async () => {
        try {
          await api("/users/" + sel.dataset.role, {
            method: "PATCH",
            body: JSON.stringify({ role: sel.value })
          });
          toast("角色已更新");
          loadUsers();
        } catch (e) {
          toast(e.message);
          loadUsers();
        }
      };
    });

    document.querySelectorAll("[data-reset-pwd]").forEach(b => {
      b.onclick = async () => {
        const id = Number(b.dataset.resetPwd);
        const name = b.dataset.uname || "该用户";
        const newPwd = prompt(`请输入用户“${name}”的新密码（至少 8 位）：`);
        if (!newPwd) return;
        if (newPwd.length < 8) return toast("密码长度至少需要 8 位");
        try {
          await api("/users/" + id, {
            method: "PATCH",
            body: JSON.stringify({ reset_password: newPwd })
          });
          toast(`已重置“${name}”的登录密码`);
        } catch (e) {
          toast(e.message);
        }
      };
    });

    document.querySelectorAll("[data-delete-user]").forEach(b => {
      b.onclick = async () => {
        const id = Number(b.dataset.deleteUser);
        if (id === Number(me.id)) return toast("不能删除当前登录的账号");
        const row = b.closest(".user-row"),
          name = row?.querySelector(".tasktext b")?.textContent || "该用户";
        if (!confirm(`确定删除用户“${name}”吗？该用户的待办也会删除，此操作不可撤销。`))
          return;
        b.disabled = true;
        try {
          const d = await api("/users/" + id, { method: "DELETE" });
          toast(d.message || "用户删除成功");
          await loadUsers();
          await loadStats();
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      };
    });
  } catch (e) {
    toast(e.message);
  }
}

async function loadStats() {
  try {
    const s = (await api("/stats")) || {};
    applyKbCount(s.knowledge_files, s.knowledge_chunks);

    // 接口缺字段时宁可显示“—”，也不能把 undefined 直接印在页面上
    const isNum = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
    const shown = (v, fallback = "—") => (isNum(v) ? String(Number(v)) : fallback);
    const num = (v, d = 0) => (isNum(v) ? Number(v) : d);

    const knowledgeFiles = num(s.knowledge_files, knowledgeTotalDocs);
    const knowledgeChunks = num(s.knowledge_chunks);
    const studentCount = num(s.student_count);
    const userCount = num(s.user_count, studentCount);
    const taskCount = num(s.task_count, num(s.pending_count) + num(s.completed_count));
    const pendingCount = num(s.pending_count);
    const doneCount = num(s.completed_count);
    // 完成率优先用接口给的值；没给就按任务数算，两者都没有才留空
    const rate = isNum(s.completion_rate)
      ? Math.max(0, Math.min(100, Math.round(Number(s.completion_rate))))
      : taskCount
      ? Math.round((doneCount / taskCount) * 100)
      : 0;
    const hasRate = isNum(s.completion_rate) || taskCount > 0;

    $("aNotices").textContent = shown(s.notice_count);
    $("aStudents").textContent = shown(s.student_count);
    $("aCompletion").textContent = hasRate ? `${rate}%` : "—";

    const pctOf = n => (taskCount ? Math.round((n / taskCount) * 1000) / 10 : 0);

    $("statsDetails").innerHTML = `
      <div class="stat-dash">
        <div class="stat-ring-box">
          <div class="stat-ring">
            <svg viewBox="0 0 44 44" role="img" aria-label="任务完成率 ${hasRate ? rate + "%" : "暂无数据"}">
              <circle class="ring-track" cx="22" cy="22" r="18"/>
              ${hasRate ? `<circle class="ring-fill" cx="22" cy="22" r="18" pathLength="100" style="stroke-dasharray:${rate} 100"/>` : ""}
            </svg>
            <div class="ring-label"><b>${hasRate ? rate + "%" : "—"}</b><small>任务完成率</small></div>
          </div>
          <p class="stat-ring-note">已完成 ${doneCount} 项 · 待处理 ${pendingCount} 项</p>
        </div>

        <div class="stat-metrics">
          <div class="stat-metric">
            <span>账号总数</span>
            <b>${shown(s.user_count, String(userCount))}</b>
            <small>含学生 ${shown(s.student_count, String(studentCount))} 人</small>
          </div>
          <div class="stat-metric">
            <span>任务总数</span>
            <b>${shown(s.task_count, String(taskCount))}</b>
            <small>待处理 ${shown(s.pending_count, String(pendingCount))} · 已完成 ${shown(s.completed_count, String(doneCount))}</small>
          </div>
          <div class="stat-metric">
            <span>内置校规制度库</span>
            <b>${knowledgeFiles || "—"}</b>
            <small>${knowledgeChunks ? knowledgeChunks + " 个检索知识切片" : "官方文件与附件"}</small>
          </div>
        </div>
      </div>

      <div class="stat-bars">
        <div class="stat-bar-head"><span>任务构成</span><small>共 ${taskCount} 项</small></div>
        <div class="stat-bar">
          <i class="bar-done" style="width:${pctOf(doneCount)}%"></i>
          <i class="bar-open" style="width:${pctOf(pendingCount)}%"></i>
        </div>
        <div class="stat-bar-legend">
          <span><i class="dot done"></i>已完成 ${doneCount}</span>
          <span><i class="dot open"></i>待处理 ${pendingCount}</span>
        </div>
      </div>`;
  } catch (e) {
    toast(e.message);
  }
}

// 启动即同步制度库真实数量（失败则保持占位符，不显示臆测数字）
syncKnowledgeMeta();
$("userSearch")?.addEventListener("input", () => loadUsers());
$("reloadUsers")?.addEventListener("click", loadUsers);
$("reloadStats")?.addEventListener("click", loadStats);
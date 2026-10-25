// app.js — 校务智理（文理智办）前端核心逻辑
// 涵盖：原版简洁登录与演示账号一键登录、电脑端热门提问滚轮/拖拽/箭头滑动、移动端自适应体验、AI 回答步骤一键转待办、160份校规制度库检索与原文查阅、通知收藏置顶与二次编辑、个人资料与密码管理
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

const $ = id => document.getElementById(id);
const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

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
      <span class="msg-avatar ai">✳</span>
      <span class="msg-sender">文理智办 AI</span>
    </div>
    <div class="bubble msg-ai welcome-bubble">
      <div class="welcome-bubble-head">
        <b>👋 ${isReset ? "对话已重置，随时为您服务！" : "你好！我是「文理智办」校园智能办事助手"}</b>
        <p>基于学校 160 份正式规章制度与附件模板，为您梳理清晰的办事指南：</p>
      </div>
      <div class="welcome-grid">
        <div class="welcome-item">
          <span>📋</span>
          <div><b>材料清单</b><small>明确申请表与证明材料</small></div>
        </div>
        <div class="welcome-item">
          <span>🧭</span>
          <div><b>办理流程</b><small>理清找谁审、去哪办</small></div>
        </div>
        <div class="welcome-item">
          <span>📌</span>
          <div><b>制度依据</b><small>定位具体文件与条款</small></div>
        </div>
        <div class="welcome-item">
          <span>⚠️</span>
          <div><b>关键提醒</b><small>预警门槛与时间节点</small></div>
        </div>
      </div>
      <div class="welcome-foot">💡 可直接点击上方热门提问，或在下方输入您的具体问题。</div>
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
  const icon = isDark ? "☀️" : "🌙";
  if ($("themeToggle")) $("themeToggle").textContent = icon;
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
  $("togglePwd").textContent = isPwd ? "🙈" : "👁";
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
  btn.classList.toggle("hide", dist < 140);
}
$("messages")?.addEventListener("scroll", updateScrollBottomBtn, { passive: true });
$("scrollBottomBtn")?.addEventListener("click", () => {
  const msgEl = $("messages");
  if (msgEl) msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: "smooth" });
});

function scrollMessagesToBottom(force = false) {
  const msgEl = $("messages");
  if (!msgEl) return;
  if (force) {
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
  if (status === "completed") return `<span>⏰ 截止日期：${esc(dueDate)}</span>`;
  const todayStr = new Date().toISOString().slice(0, 10);
  const diff = Math.ceil((new Date(dueDate) - new Date(todayStr)) / 86400000);
  if (!isNaN(diff)) {
    if (diff < 0) {
      return `<span class="due-tag overdue">⚠️ 已逾期 (${esc(dueDate)})</span>`;
    }
    if (diff <= 3) {
      return `<span class="due-tag soon">🔥 剩 ${diff} 天截止 (${esc(dueDate)})</span>`;
    }
  }
  return `<span>⏰ 截止日期：${esc(dueDate)}</span>`;
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
              ${n.deadline ? `<span>⏰ 截止：${esc(n.deadline)}</span>` : ""}
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
              ${isStarred ? `<span class="tag star-tag">★ 已置顶收藏</span>` : ""}
            </div>
            <div class="notice-actions">
              <button type="button" class="outline ${isStarred ? "starred-btn" : ""}" data-star-notice="${n.id}">
                ${isStarred ? "★ 已收藏" : "☆ 收藏"}
              </button>
              <button type="button" class="ai-btn" data-ai-notice="${n.id}">✳ AI 解读</button>
              <button type="button" class="outline" data-copy-notice="${n.id}">📋 复制</button>
              <button type="button" class="outline ${alreadyInTask ? "added" : ""}" data-add="${n.id}">
                ${alreadyInTask ? "✓ 已在待办" : "＋ 加入待办"}
              </button>
              ${admin ? `<button type="button" class="outline" data-edit-notice="${n.id}">✏️ 编辑</button>` : ""}
              ${admin ? `<button type="button" class="danger" data-delete-notice="${n.id}">删除</button>` : ""}
            </div>
          </div>
          <h3>${esc(n.title)}</h3>
          <p>${esc(n.body)}</p>
          <div class="meta">
            <span>发布人：${esc(n.publisher)}</span>
            <span>发布于：${date(n.created_at)}</span>
            <span>适用对象：${esc(n.audience)}</span>
            ${n.deadline ? `<span>⏰ 截止：${esc(n.deadline)}</span>` : ""}
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
              <span>· ${t.notice_id ? "📌 来自通知" : "✍️ 个人待办"}</span>
              <span>· 创建于 ${date(t.created_at)}</span>
            </small>
          </div>
          <span class="tag">${t.status === "completed" ? "已完成" : "待处理"}</span>
          <button type="button" class="task-del-btn" data-del-task="${t.id}" title="删除此待办">×</button>
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
      const nextTitle = prompt("修改待办事项名称：", t.title);
      if (nextTitle === null) return;
      const clean = nextTitle.trim();
      if (!clean || clean === t.title) return;
      try {
        await api("/tasks/" + id, {
          method: "PATCH",
          body: JSON.stringify({ title: clean })
        });
        tasks = await api("/tasks");
        renderTasks();
        renderHome();
        toast("待办内容已更新");
      } catch (e) {
        toast(e.message);
      }
    };
  });

  document.querySelectorAll("[data-del-task]").forEach(btn => {
    btn.onclick = async () => {
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

// ====== 160份校规制度库检索与原文阅读弹窗 ======
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
              <button type="button" class="outline" data-read-doc="${esc(c.docTitle || c.name)}">📖 阅读整篇制度</button>
              <button type="button" class="ai-btn" data-ask-doc="${esc(c.docTitle || c.name)}">✳ AI 解读</button>
            </div>
          </div>
          <h3>${esc(c.name)}</h3>
          <p>${esc(String(c.content || "").slice(0, 360))}${String(c.content || "").length > 360 ? "…" : ""}</p>
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
              <div class="notice-top">
                <span class="tag">${esc(d.dept || "学校部门")}</span>
                <small class="muted">${esc(d.date || "现行有效")}</small>
              </div>
              <h4>${esc(d.title)}</h4>
              <p>${esc(d.preview || "")}</p>
            </div>
            <div class="knowledge-card-foot">
              <small class="muted">${esc(d.category || "规章制度")} · ${d.chunk_count || 1} 节</small>
              <div style="display:flex;gap:6px">
                <button type="button" class="outline" data-read-doc="${esc(d.title)}">📖 查看原文</button>
                <button type="button" class="ai-btn" data-ask-doc="${esc(d.title)}">✳ 解读</button>
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
  $("clearKnowledgeSearch")?.classList.toggle("hide", !q);

  // 若无关键词且已缓存完整制度目录，直接在前端零延迟过滤渲染
  if (!q && allKnowledgeDocsCache) {
    const filtered = dept ? allKnowledgeDocsCache.filter(d => d.dept === dept) : allKnowledgeDocsCache;
    knowledgeDocs = filtered;
    renderKnowledgeGrid(filtered, [], "");
    return;
  }

  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (dept) params.set("dept", dept);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await api("/knowledge" + qs);

    knowledgeDocs = data.docs || [];
    if (!q && !dept && knowledgeDocs.length) {
      allKnowledgeDocsCache = knowledgeDocs;
    }
    renderKnowledgeGrid(knowledgeDocs, data.matched_chunks || [], q);
  } catch (e) {
    toast(e.message);
  }
}

async function openDocReader(docTitle) {
  if (!docTitle) return;
  const cleanTitle = String(docTitle).split(" · ")[0].trim();
  try {
    const data = await api("/knowledge?doc=" + encodeURIComponent(cleanTitle));
    const doc = data.doc || { title: cleanTitle, dept: "学校部门", category: "规章制度", url: "https://jwc.xawl.edu.cn/" };
    const fullText = (data.chunks || []).map(c => c.content).join("\n\n");
    currentDocViewing = { ...doc, fullText };

    $("docDialogDept").textContent = doc.dept || "学校部门";
    $("docDialogCategory").textContent = doc.category || "规章制度";
    $("docDialogDate").textContent = doc.date ? `发布日期：${doc.date}` : "";
    $("docDialogTitle").textContent = doc.title;
    $("docDialogBody").textContent = fullText || "暂无正文内容";
    $("docDialogUrl").href = doc.url || "https://jwc.xawl.edu.cn/";
    $("docDialog")?.showModal();
  } catch (e) {
    toast(e.message || "未能加载该制度原文");
  }
}

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

$("knowledgeDept")?.addEventListener("change", loadKnowledge);
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

function parseInlineMarkdown(line) {
  let s = line;
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return s;
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
      out.push(`<p class="md-p">${parseInlineMarkdown(esc(tableRows[0]))}</p>`);
      tableRows = [];
      return;
    }
    const parseCells = row =>
      row
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(c => parseInlineMarkdown(esc(c.trim())));
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

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      const content = parseInlineMarkdown(esc(hMatch[2]));
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
      const qContent = parseInlineMarkdown(esc(trimmed.replace(/^>\s*/, "")));
      out.push(`<blockquote class="md-quote">${qContent}</blockquote>`);
      continue;
    }

    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(`<li>${parseInlineMarkdown(esc(ulMatch[1]))}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (olMatch) {
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(`<li>${parseInlineMarkdown(esc(olMatch[1]))}</li>`);
      continue;
    }

    flushList();
    out.push(`<p class="md-p">${parseInlineMarkdown(esc(trimmed))}</p>`);
  }

  if (inCodeBlock && codeLines.length) {
    out.push(`<pre class="md-pre"><code>${esc(codeLines.join("\n"))}</code></pre>`);
  }
  flushList();
  flushTable();

  return `<div class="md-content">${out.join("")}</div>`;
}

// 从 AI 回答中自动提取可执行的办事步骤（供一键导入待办）
function extractStepsFromAnswer(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map(l => l.replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const steps = [];
  for (const line of lines) {
    if (
      /^(-\s*)?第\s*[一二三四五六七八九十\d]+\s*步[：:]/.test(line) ||
      /^(\d+[.、]|[-•])\s*(准备|提交|登录|填写|办理|前往|核对|申请|确认|携带|打印|联系|参加)/.test(line)
    ) {
      const clean = line.replace(/^([-\d.•、]+|第\s*[一二三四五六七八九十\d]+\s*步[：:])\s*/, "").slice(0, 140);
      if (clean.length >= 4) steps.push(clean);
    }
  }
  if (!steps.length) {
    for (const line of lines) {
      if (/^(\d+[.、]|[-•])\s+/.test(line) && line.length >= 6 && line.length <= 100) {
        steps.push(line.replace(/^(\d+[.、]|[-•])\s+/, ""));
      }
    }
  }
  return steps.slice(0, 6);
}

function appendSourcesCard(parentEl, sources, label) {
  if (!sources || !sources.length) return;
  const src = document.createElement("div");
  src.className = "ai-sources";
  const title = document.createElement("b");
  title.textContent = label || "📎 引用来源与官方依据（点击可查阅制度原文）";
  src.appendChild(title);
  sources.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "source-item-row";

    const a = document.createElement("a");
    a.href = item.url || "https://jwc.xawl.edu.cn/";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const linkText = `${i + 1}. ${item.title || item.url}${item.date ? "（" + item.date + " 发布）" : ""}`;
    a.textContent = linkText;
    a.title = linkText;
    row.appendChild(a);

    if (item.type !== "web" && item.title) {
      const readBtn = document.createElement("button");
      readBtn.type = "button";
      readBtn.className = "src-read-btn";
      readBtn.textContent = "📖 校内原文";
      readBtn.onclick = () => openDocReader(item.title);
      row.appendChild(readBtn);
    }

    src.appendChild(row);
  });
  parentEl.appendChild(src);
}

function appendCopyTools(wrapEl, textGetter, retryQuestion = "") {
  const tools = document.createElement("div");
  tools.className = "bubble-tools";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "📋 复制回答";
  copyBtn.onclick = async () => {
    const text = typeof textGetter === "function" ? textGetter() : textGetter;
    const ok = await copyTextSafe(text);
    toast(ok ? "回答已复制到剪贴板" : "复制失败，请长按文字复制");
  };
  tools.appendChild(copyBtn);

  const answerText = typeof textGetter === "function" ? textGetter() : textGetter;
  const steps = extractStepsFromAnswer(answerText);

  if (steps.length >= 2) {
    const batchBtn = document.createElement("button");
    batchBtn.type = "button";
    batchBtn.className = "todo-action-btn";
    batchBtn.textContent = `✨ 提取 ${steps.length} 个步骤入待办`;
    batchBtn.onclick = async () => {
      batchBtn.disabled = true;
      try {
        const res = await api("/tasks/batch", {
          method: "POST",
          body: JSON.stringify({ items: steps })
        });
        tasks = await api("/tasks");
        renderTasks();
        renderHome();
        batchBtn.textContent = `✓ 已导入 ${steps.length} 个步骤`;
        toast(res.message || `已将 ${steps.length} 个办理步骤加入我的待办`);
      } catch (e) {
        batchBtn.disabled = false;
        toast(e.message);
      }
    };
    tools.appendChild(batchBtn);
  }

  const singleTodoBtn = document.createElement("button");
  singleTodoBtn.type = "button";
  singleTodoBtn.textContent = "📌 设为待办";
  singleTodoBtn.onclick = async () => {
    const baseTitle = retryQuestion
      ? `办理事项：${retryQuestion.slice(0, 48)}`
      : `跟进咨询事项：${String(answerText).replace(/\s+/g, " ").slice(0, 40)}`;
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: baseTitle })
      });
      tasks = await api("/tasks");
      renderTasks();
      renderHome();
      singleTodoBtn.textContent = "✓ 已加入待办";
      singleTodoBtn.disabled = true;
      toast("已添加至“我的待办”");
    } catch (e) {
      toast(e.message);
    }
  };
  tools.appendChild(singleTodoBtn);

  if (retryQuestion) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.textContent = "🔄 重新生成";
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
    meta.innerHTML = `<span class="msg-avatar ai">✳</span><span class="msg-sender">文理智办 AI</span>`;
  }
  return meta;
}

function message(s, who = "", sources = [], isRestoring = false, reasoning = "") {
  const cleanText = String(s ?? "").trim();
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
      html += `<details class="ai-reasoning"><summary>💭 已深度思考（点击查看推理过程）</summary><div class="ai-reasoning-body">${esc(reasoning.trim())}</div></details>`;
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
      if (m.sources && m.sources.length) {
        s +=
          "\n引用来源（可核验）：\n" +
          m.sources
            .map(
              (x, i) =>
                `  ${i + 1}. ${x.title || x.url}${x.date ? "（" + x.date + " 发布）" : ""}\n     ${x.url}`
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
function autoResizeQuestion() {
  const el = $("question");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

$("question")?.addEventListener("input", autoResizeQuestion);

// 支持电脑端 Enter 快捷发送
$("question")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 1000) {
    e.preventDefault();
    $("askForm").requestSubmit();
  }
});

// AI 提问处理（自适应兼容流式 SSE 与普通 JSON，支持深度思考过程折叠展示）
$("askForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  autoResizeQuestion();

  $("aiOptionsBar")?.classList.remove("open");
  $("toggleAiConfig")?.classList.remove("added");

  message(q, "user");

  const b = $("askSubmitBtn");
  const origHtml = b.innerHTML;
  b.disabled = true;
  b.innerHTML = "<span>思考中</span>";

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai";
  wrap.appendChild(createMsgMeta("ai"));

  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  bubble.innerHTML = `<div class="ai-thinking-status"><span>✳ 正在检索校规库并思考中</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  scrollMessagesToBottom(true);

  let fullAnswer = "";
  let fullReasoning = "";
  let sources = [];
  let sourcesLabel = "";
  let streamedContent = false;
  let retried = false;

  const renderStreamingBubble = (isStreaming = true) => {
    let html = "";
    if (fullReasoning.trim()) {
      const summaryLabel =
        !fullAnswer.trim() && isStreaming
          ? "💭 正在深度思考并核对学校条款（点击展开）…"
          : "💭 已深度思考（点击查看推理过程）";
      html += `<details class="ai-reasoning"><summary>${summaryLabel}</summary><div class="ai-reasoning-body">${esc(fullReasoning.trim())}</div></details>`;
    }
    if (fullAnswer.trim()) {
      html += formatMarkdownSafe(fullAnswer);
    } else if (isStreaming) {
      html += `<div class="ai-thinking-status"><span>✳ 正在生成办事指引</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
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

  const runAsk = async () => {
    const searchToggle = $("aiWebSearch");
    const webSearch = Boolean(searchToggle && searchToggle.checked);
    const payload = {
      question: q,
      model: $("aiModel")?.value || "deepseek-flash",
      thinking: $("aiThinking")?.checked !== false,
      reasoning_effort: $("aiEffort")?.value || "high",
      web_search: webSearch,
      history: chatHistory.slice(-9, -1).map(m => ({
        role: m.role === "学生" ? "user" : "assistant",
        content: String(m.content).slice(0, 2000)
      }))
    };

    const res = await fetch(API + "/ai/ask", {
      method: "POST",
      cache: "no-store",
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
          throw new Error(parsed.error);
        }

        if (parsed.type === "meta") {
          sources = parsed.sources || [];
          sourcesLabel = parsed.sources_label || "";
          return;
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
          scrollMessagesToBottom(false);
        }

        if (deltaContent) {
          fullAnswer += deltaContent;
          if (fullAnswer.trim()) {
            streamedContent = true;
            renderStreamingBubble(true);
            scrollMessagesToBottom(false);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        rawFallback += chunkText;
        buffer += chunkText;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          processLine(line);
        }
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

    fullAnswer = fullAnswer.trim();
    if (!fullAnswer) {
      fullAnswer = "模型未返回有效内容，请尝试取消勾选“深度思考”或重新发送问题。";
      bubble.innerHTML = `<span class="muted">${esc(fullAnswer)}</span>`;
    } else {
      renderStreamingBubble(false);
      chatHistory.push({
        role: "文理智办",
        content: fullAnswer,
        sources: sources || [],
        reasoning: fullReasoning.trim()
      });
      saveChatToLocal();
      appendCopyTools(wrap, () => fullAnswer, q);
      appendSourcesCard(wrap, sources, sourcesLabel);
    }
  };

  try {
    await runAsk();
  } catch (err) {
    const isNetworkErr =
      err instanceof TypeError ||
      /failed to fetch|networkerror|load failed/i.test(String(err.message || ""));
    if (isNetworkErr && !streamedContent && !retried) {
      retried = true;
      bubble.innerHTML = `<div class="ai-thinking-status"><span>↻ 网络波动，正在自动重试</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
      try {
        await runAsk();
      } catch (err2) {
        bubble.innerHTML = `<span style="color:#d92d20">⚠️ 请求出错：${esc(friendlyError(err2))}</span>`;
      }
    } else {
      bubble.innerHTML = `<span style="color:#d92d20">⚠️ 请求出错：${esc(friendlyError(err))}</span>`;
    }
  } finally {
    b.disabled = false;
    b.innerHTML = origHtml;
    scrollMessagesToBottom(false);
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
            <button type="button" class="outline" data-reset-pwd="${u.id}" data-uname="${esc(u.display_name)}">🔑 重置密码</button>
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
    let s = await api("/stats");
    $("aNotices").textContent = s.notice_count;
    $("aStudents").textContent = s.student_count;
    $("aCompletion").textContent = s.completion_rate + "%";
    $("statsDetails").innerHTML = `
      <div class="notice-row"><span class="bullet"></span><div><h4>账号总数</h4><p>${s.user_count} 个（含学生 ${s.student_count} 人）</p></div></div>
      <div class="notice-row"><span class="bullet"></span><div><h4>任务总数</h4><p>${s.task_count} 项（待处理 ${s.pending_count} 项 · 已完成 ${s.completed_count} 项）</p></div></div>
      <div class="notice-row"><span class="bullet"></span><div><h4>内置校规制度库</h4><p>${s.knowledge_files || 160} 份官方文件与附件（${s.knowledge_chunks || 486} 个检索知识切片）</p></div></div>`;
  } catch (e) {
    toast(e.message);
  }
}

$("userSearch")?.addEventListener("input", () => loadUsers());
$("reloadUsers")?.addEventListener("click", loadUsers);
$("reloadStats")?.addEventListener("click", loadStats);

const api_base = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) || "/api";
const chat_cache_key = "xz_chat_cache_v1";
const star_notices_key = "xz_starred_notices_v1";
const chat_cache_key_for = () => `${chat_cache_key}_${me?.id || "anon"}`;
const star_cache_key_for = () => `${star_notices_key}_${me?.id || "anon"}`;

const home_snap_key = () => `xz_home_snap_${me?.id || "anon"}`;
const home_snap_last_key = "xz_home_snap_last";

function save_home_snap() {
  if (!me) return;
  const snap = JSON.stringify({
    n: notices.length,
    p: tasks.filter(t => t.status === "pending").length,
    d: tasks.filter(t => t.status === "completed").length,
    uid: me?.id || 0,
    at: Date.now()
  });
  try {
    localStorage.setItem(home_snap_key(), snap);
    localStorage.setItem(home_snap_last_key, snap);
  } catch {}
}

function restore_home_snap(use_last) {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem(use_last ? home_snap_last_key : home_snap_key()) || "null");
  } catch {
    return;
  }
  if (!s || !Number.isFinite(s.n) || Date.now() - (s.at || 0) > 7 * 86400000) return;
  $("statNotices").textContent = s.n;
  $("statPending").textContent = Number.isFinite(s.p) ? s.p : "—";
  $("statDone").textContent = Number.isFinite(s.d) ? s.d : "—";
  set_badges(Number(s.p) || 0);
}

let token = localStorage.getItem("xz_token") || "",
  me = null,
  notices = [],
  tasks = [],
  knowledge_docs = [],
  all_knowledge_docs_cache = null,
  starred_notice_ids = new Set(),
  mode = "login",
  timer,
  k_search_timer,
  chat_history = [],
  current_doc_viewing = null,
  cur_page = "home";

let chat_restored = false;

let knowledge_request_seq = 0;
let kb_render_sig = "";

let ai_busy = false;
let ai_abort_handler = null;
let ai_todo_draft = [];
let ai_todo_source_question = "";

window.addEventListener("xz-token-renewed", e => {
  const nt = e && e.detail && e.detail.token;
  if (nt) token = String(nt);
});

function clear_saved_auth(mark_manual_logout = false) {
  try {
    document.documentElement.classList.remove("has-saved-auth");
    localStorage.removeItem("xz_token");
    document.cookie = "xz_token_bak=; path=/; max-age=0";
    if (mark_manual_logout) sessionStorage.setItem("xz_manual_logout_v1", "1");
  } catch {}
}

const $ = id => document.getElementById(id);
function debounce(fn, ms) {
  let t = 0;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

function ico(name, cls = "") {
  const star = name === "sparkles" ? " ico-star" : "";
  return `<svg class="ico${cls ? " " + cls : ""}${star}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function toast(s) {
  if (typeof s === "string" && /登录已失效|登录已过期/.test(s)) return;
  const el = $("toast");
  if (!el) return;
  const msg = String(s ?? "");
  const kind = /失败|错误|无法|不能|异常|未找到|不能为空|请先|请检查|至少|超时/.test(msg)
    ? "warn"
    : (/成功|已复制|已保存|已更新|已同步|已完成|已添加|已删除|已清空|已导出|已分享|已切换|已识别/.test(msg) ? "ok" : "info");
  const mark = kind === "ok" ? "✓" : (kind === "warn" ? "!" : "✦");
  el.innerHTML = `<span class="toast-ico ${kind}" aria-hidden="true">${mark}</span><span>${esc(msg)}</span>`;
  el.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("show"), 2200);
}

function load_starred_notices() {
  try {
    const raw = localStorage.getItem(star_cache_key_for());
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) starred_notice_ids = new Set(arr.map(Number));
    }
  } catch {}
}
function save_starred_notices() {
  try {
    localStorage.setItem(star_cache_key_for(), JSON.stringify([...starred_notice_ids]));
  } catch {}
}

async function copy_text_safe(text) {
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

/* ---- 欢迎卡片 ---- */
function welcome_html(is_reset = false) {
  return `<div class="bubble-wrap msg-ai">
    <div class="msg-meta">
      <span class="msg-avatar ai">${ico("ai-brand")}</span>
      <span class="msg-sender">文理智办 AI</span>
    </div>
    <div class="bubble msg-ai welcome-bubble">
      <div class="welcome-bubble-head">
        <b>${is_reset ? "对话已重置，随时为您服务！" : "你好！我是「文理智办」校园智能办事助手"}</b>
        <p>基于学校正式规章制度与附件模板，为您梳理清晰的办事指南：</p>
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

/* ---- 对话记录缓存 ---- */
function save_chat_to_local() {
  const slim = chat_history.slice(-30).map(m => ({
    role: m.role,
    content: m.content,
    reasoning: String(m.reasoning || "").slice(0, 4000),
    sources: (m.sources || []).slice(0, 5).map(s => ({
      title: s.title,
      url: s.url,
      date: s.date,
      type: s.type,
      isOfficial: s.isOfficial,
      relevance: s.relevance
    }))
  }));
  try {
    localStorage.setItem(chat_cache_key_for(), JSON.stringify(slim));
  } catch {
    try { localStorage.removeItem(chat_cache_key_for()); } catch {}
  }
}

function restore_chat_from_local() {
  const box = $("messages");
  try {
    const raw = localStorage.getItem(chat_cache_key_for());
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list) || !list.length) {
      if (box && !box.querySelector(".bubble-wrap")) box.innerHTML = welcome_html(false);
      return;
    }

    chat_history = [];
    if (box) box.innerHTML = welcome_html(false);
    list.forEach(item => {
      if (!item || !item.content) return;
      const is_user = item.role === "学生" || item.role === "user";
      create_message(item.content, is_user ? "user" : "ai", item.sources || [], true, item.reasoning || "");
    });
  } catch {
    if (box && !box.querySelector(".bubble-wrap")) box.innerHTML = welcome_html(false);
  }
}

function ensure_chat_restored() {
  if (!chat_restored) {
    chat_restored = true;
    restore_chat_from_local();
  }
  const box = $("messages");
  if (box && !box.querySelector(".bubble-wrap")) {
    box.innerHTML = welcome_html(false);
  }
}

/* ---- 深浅色 ---- */
function sync_theme_icon(is_dark) {
  const html = ico(is_dark ? "moon" : "sun");
  const btn = $("themeToggle");
  if (btn) btn.innerHTML = html;
  const authBtn = $("authThemeToggle");
  if (authBtn) authBtn.innerHTML = html;
}

function sync_theme_root(is_dark) {
  const root = document.documentElement;
  const dark = !!is_dark;
  root.classList.toggle("dark", dark);
  if (document.body) document.body.classList.toggle("dark", dark);
  const booting = root.classList.contains("app-booting");
  const on_auth = !booting && $("auth") && !$("auth").classList.contains("hide");
  const isMobileAuth = on_auth && window.innerWidth <= 900;
  const topBg = booting
    ? (dark ? "#0b1120" : "#f8fafc")
    : (isMobileAuth ? (dark ? "#123c9e" : "#164bc9") : (dark ? "#0b1120" : "#eef4ff"));
  root.style.background = topBg;
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", topBg);
  try {
    window.dispatchEvent(new CustomEvent("xz-theme-sync", { detail: { isDark: dark, onAuth: !!on_auth, booting: !!booting } }));
  } catch {}
}

function init_theme() {
  try {
    const is_dark = localStorage.getItem("xz_theme") === "dark";
    document.body.classList.toggle("dark", is_dark);
    sync_theme_root(is_dark);
    sync_theme_icon(is_dark);
  } catch {}
}
init_theme();

function handle_toggle_theme() {
  const is_dark = document.body.classList.toggle("dark");
  sync_theme_root(is_dark);
  try {
    localStorage.setItem("xz_theme", is_dark ? "dark" : "light");
  } catch {}
  sync_theme_icon(is_dark);
  toast(is_dark ? "已切换至深色模式" : "已切换至浅色模式");
}
$("themeToggle")?.addEventListener("click", handle_toggle_theme);

$("togglePwd")?.addEventListener("click", e => {
  const pwd = $("password");
  if (!pwd) return;
  const is_pwd = pwd.type === "password";
  pwd.type = is_pwd ? "text" : "password";
  e.currentTarget.innerHTML = ico(is_pwd ? "eye-off" : "eye");
});

async function api(path, opt = {}) {
  let r;
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 15000);
  try {
    r = await fetch(api_base + path, {
      ...opt,
      signal: opt.signal || ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(opt.headers || {})
      }
    });
  } catch (e) {
    clearTimeout(killer);
    if (e && e.name === "AbortError") throw Error("请求超时，请检查网络后重试。");
    throw Error("无法连接后端，请确认网络或 API 服务状态。");
  }
  clearTimeout(killer);
  let d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = Error(d.detail || "请求失败");
    err.status = r.status;
    if ((r.status === 401 || r.status === 403) && token) {
      token = "";
      clear_saved_auth(false);
      $("auth")?.classList.remove("hide");
      $("app")?.classList.add("hide");
      err.silent = true;
    }
    throw err;
  }
  return d;
}

function auth_mode(m) {
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
$("loginTab").onclick = () => auth_mode("login");
$("regTab").onclick = () => auth_mode("register");

$("authForm").onsubmit = async e => {
  e.preventDefault();
  const submit_btn = $("authSubmit");
  const prev_text = submit_btn.textContent;
  submit_btn.disabled = true;
  submit_btn.textContent = "处理中…";
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
      sessionStorage.removeItem("xz_manual_logout_v1");
      localStorage.setItem("xz_token", token);
    } catch {}
    await enter();
  } catch (e) {
    toast(e.message);
  } finally {
    submit_btn.disabled = false;
    submit_btn.textContent = prev_text;
  }
};

$("quickDemoStudent")?.addEventListener("click", () => {
  auth_mode("login");
  $("username").value = "demo_student";
  $("password").value = "demo123456";
  $("authForm").requestSubmit();
});

$("logout").onclick = () => {
  if (typeof ai_abort_handler === "function") ai_abort_handler();
  token = "";
  me = null;
  notices = [];
  tasks = [];
  chat_history = [];
  chat_restored = false;
  ai_todo_draft = [];
  starred_notice_ids = new Set();
  clear_saved_auth(true);
  try {
    localStorage.removeItem(home_snap_last_key);
  } catch {}
  const msg_box = $("messages");
  if (msg_box) msg_box.innerHTML = welcome_html(false);
  document.body.classList.remove("on-ai-page");
  $("app").classList.add("hide");
  $("auth").classList.remove("hide");
  sync_theme_root(document.documentElement.classList.contains("dark"));
  auth_mode("login");
};

/* ---- 个人资料 ---- */
function open_profile_modal() {
  if (!me) return;
  $("profUsername").value = me.username || "";
  $("profDisplayName").value = me.display_name || "";
  $("profCurrentPwd").value = "";
  $("profNewPwd").value = "";
  $("profileDialog")?.showModal();
}
$("userProfileBtn")?.addEventListener("click", open_profile_modal);
$("openProfileSide")?.addEventListener("click", () => {
  sidebar_el.classList.remove("open");
  open_profile_modal();
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

const menu_btn = $("menu");
const sidebar_el = $("sidebar");
function toggle_sidebar() {
  sidebar_el.classList.toggle("open");
}
menu_btn?.addEventListener("click", toggle_sidebar);

document.addEventListener("click", e => {
  if (!sidebar_el.classList.contains("open")) return;
  if (!sidebar_el.contains(e.target) && e.target !== menu_btn) {
    sidebar_el.classList.remove("open");
  }
});

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

$("toggleAiConfig")?.addEventListener("click", () => {
  if (window.innerWidth >= 761) return;
  const bar = $("aiOptionsBar");
  if (!bar) return;
  const is_open = bar.classList.toggle("open");
  $("toggleAiConfig").classList.toggle("added", is_open);
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
    render_tasks();
    go("tasks");
  };
});
document.querySelectorAll("[data-quick-ai]").forEach(b => {
  b.onclick = () => {
    go("ai");
    $("question").value = b.dataset.quickAi;
    auto_resize_question();
    $("question").focus();
  };
});

/* ---- 消息区滚动（兼容桌面容器滚动与移动端整页自然滚动） ---- */
function is_window_ai_scroll() {
  const msg_el = $("messages");
  if (!msg_el || !document.body.classList.contains("on-ai-page")) return false;
  return getComputedStyle(msg_el).overflowY === "visible";
}
function get_ai_scroll_metrics() {
  const msg_el = $("messages");
  if (is_window_ai_scroll()) {
    const doc = document.scrollingElement || document.documentElement;
    const top = window.scrollY || window.pageYOffset || doc.scrollTop || 0;
    const vh = Math.max(window.innerHeight || 0, doc.clientHeight || 0, document.documentElement.clientHeight || 0);
    const total = Math.max(doc.scrollHeight || 0, vh);
    const maxTop = Math.max(0, total - vh);
    let dist = Math.max(0, maxTop - top);
    if (msg_el && msg_el.lastElementChild) {
      const lastRect = msg_el.lastElementChild.getBoundingClientRect();
      const visibleBottom = (window.innerHeight || vh) - 132;
      const elDist = Math.max(0, Math.round(lastRect.bottom - visibleBottom));
      dist = Math.min(dist, elDist);
    }
    return { isWindow: true, el: doc, top, client: vh, total, maxTop, dist };
  }
  if (!msg_el) return null;
  const maxTop = Math.max(0, msg_el.scrollHeight - msg_el.clientHeight);
  const dist = Math.max(0, maxTop - msg_el.scrollTop);
  return { isWindow: false, el: msg_el, top: msg_el.scrollTop, client: msg_el.clientHeight, total: msg_el.scrollHeight, maxTop, dist };
}
function sync_scroll_btn(respectLock = false) {
  if (respectLock && Date.now() < scroll_btn_lock_until) return;
  const btn = $("scrollBottomBtn");
  const m = get_ai_scroll_metrics();
  if (!btn || !m) return;
  const shouldHide = !document.body.classList.contains("on-ai-page") || m.dist < 72 || m.maxTop <= 48;
  btn.classList.toggle("hide", shouldHide);
}
let scroll_btn_lock_until = 0;

/**
 * Scroll once right after sending so the user's bubble stays in the reading zone.
 * Streaming chunks grow downward below it without pulling the viewport to the bottom.
 */
function scroll_to_message_anchor(targetEl) {
  const m = get_ai_scroll_metrics();
  if (!m) return;
  if (!targetEl || !targetEl.isConnected) {
    sync_scroll_btn(false);
    return;
  }
  scroll_btn_lock_until = 0;
  if (m.isWindow) {
    const hdr = document.querySelector("main > header");
    const hdrBottom = hdr ? Math.max(0, Math.round(hdr.getBoundingClientRect().bottom)) : 64;
    const tRect = targetEl.getBoundingClientRect();
    const curTop = window.scrollY || window.pageYOffset || m.el.scrollTop || 0;
    const desiredTop = Math.max(0, Math.round(curTop + tRect.top - (hdrBottom + 12)));
    const targetTop = Math.min(m.maxTop, desiredTop);
    if (Math.abs(targetTop - curTop) > 4) {
      window.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  } else {
    const cRect = m.el.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const desiredTop = Math.max(0, Math.round(m.el.scrollTop + (tRect.top - cRect.top) - 14));
    const targetTop = Math.min(m.maxTop, desiredTop);
    if (Math.abs(targetTop - m.el.scrollTop) > 4) {
      m.el.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  }
  sync_scroll_btn(false);
}

const on_ai_scroll = () => {
  if (!document.body.classList.contains("on-ai-page")) return;
  sync_scroll_btn(true);
};
$("messages")?.addEventListener("scroll", on_ai_scroll, { passive: true });
window.addEventListener("scroll", () => {
  if (is_window_ai_scroll()) on_ai_scroll();
}, { passive: true });

$("scrollBottomBtn")?.addEventListener("click", e => {
  const btn = e.currentTarget || $("scrollBottomBtn");
  if (btn) {
    btn.classList.add("hide");
    try { btn.blur(); } catch {}
  }
  const m = get_ai_scroll_metrics();
  if (!m) return;
  scroll_btn_lock_until = Date.now() + 700;
  if (m.isWindow) {
    window.scrollTo({ top: m.total, behavior: "smooth" });
  } else {
    m.el.scrollTo({ top: m.el.scrollHeight, behavior: "smooth" });
  }
  setTimeout(() => {
    scroll_btn_lock_until = 0;
    sync_scroll_btn(false);
  }, 720);
});

function follow_bottom() {
  // 流式输出期间禁止自动滚到底部；仅刷新“回到底部”按钮显隐，由用户点击决定何时回底
  sync_scroll_btn(true);
}

function scroll_messages_to_bottom(force = false) {
  const m = get_ai_scroll_metrics();
  if (!m) return;
  if (force) {
    scroll_btn_lock_until = Date.now() + 700;
    $("scrollBottomBtn")?.classList.add("hide");
    if (m.isWindow) {
      window.scrollTo({ top: m.total, behavior: "smooth" });
    } else {
      m.el.scrollTo({ top: m.el.scrollHeight, behavior: "smooth" });
    }
    setTimeout(() => {
      scroll_btn_lock_until = 0;
      sync_scroll_btn(false);
    }, 720);
  } else {
    sync_scroll_btn(true);
  }
}

function go(p) {
  cur_page = p;
  ["home", "notices", "tasks", "ai", "knowledge", "schedule", "users", "analytics"].forEach(x =>
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
    schedule: "超级课表",
    users: "用户管理",
    analytics: "数据统计"
  }[p] || "工作台总览";
  sidebar_el.classList.remove("open");
  if (typeof window.close_all_date_pickers === "function") window.close_all_date_pickers();
  document.querySelectorAll(".xz-select.open").forEach(s => s.classList.remove("open"));
  if (typeof window.sync_nav_sliders === "function") window.sync_nav_sliders();
  window.scrollTo(0, 0);
  if (p === "ai") {
    ensure_chat_restored();
    check_ai();
    setTimeout(() => {
      sync_hot_nav();
      sync_scroll_btn(false);
    }, 60);
  } else {
    $("scrollBottomBtn")?.classList.add("hide");
  }
  if (p === "knowledge") load_knowledge();
  if (p === "schedule") {
    if (typeof bind_schedule_events === "function") bind_schedule_events();
    if (typeof render_schedule_all === "function") render_schedule_all();
  }
  if (p === "users") load_users();
  if (p === "analytics") load_stats();
}

let boot_gate_done = false;
function set_boot_progress(pct, text, isError = false) {
  const splash = $("appBootSplash");
  const bar = $("appBootBarFill");
  const status = $("appBootStatus");
  if (bar && Number.isFinite(pct)) bar.style.width = Math.max(8, Math.min(100, pct)) + "%";
  if (status && text) status.textContent = text;
  if (splash) splash.classList.toggle("is-error", !!isError);
}

function next_paint() {
  return new Promise(resolve => {
    let settled = false;
    const fin = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    setTimeout(fin, 80);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(fin));
    } else {
      setTimeout(fin, 16);
    }
  });
}

function wait_assets_ready() {
  const loadDone = document.readyState === "complete"
    ? Promise.resolve()
    : new Promise(resolve => {
        const done = () => resolve();
        window.addEventListener("load", done, { once: true });
        setTimeout(done, 4500);
      });
  const fontsDone = (document.fonts && document.fonts.ready)
    ? Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1800))])
    : Promise.resolve();
  return Promise.all([loadDone, fontsDone]).then(() => next_paint());
}

async function finish_boot_gate(showAuth) {
  const authEl = $("auth");
  const appEl = $("app");
  if (authEl) authEl.classList.toggle("hide", !showAuth);
  if (appEl) appEl.classList.toggle("hide", !!showAuth);
  document.documentElement.classList.remove("app-booting", "has-saved-auth");
  sync_theme_root(document.documentElement.classList.contains("dark"));
  await next_paint();
  const splash = $("appBootSplash");
  if (splash && !splash.classList.contains("is-done")) {
    splash.classList.add("is-done");
    setTimeout(() => {
      if (splash.classList.contains("is-done")) splash.style.display = "none";
    }, 260);
  }
  boot_gate_done = true;
  try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
}

$("appBootRetryBtn")?.addEventListener("click", async () => {
  set_boot_progress(25, "正在重新连接服务…", false);
  if (!token) {
    try { token = localStorage.getItem("xz_token") || ""; } catch {}
  }
  if (token) {
    await enter(true);
  } else {
    await Promise.allSettled([
      Promise.race([check_ai(), new Promise(r => setTimeout(r, 4000))]),
      wait_assets_ready()
    ]);
    set_boot_progress(100, "准备就绪", false);
    await finish_boot_gate(true);
  }
});

async function enter(isBoot = false) {
  if (!token) {
    try { token = localStorage.getItem("xz_token") || ""; } catch {}
  }
  if (isBoot && !boot_gate_done) {
    set_boot_progress(45, "正在验证身份与同步校园数据…", false);
  }
  const me_req = api("/me");
  const data_req = Promise.all([api("/notices"), api("/tasks")]);
  data_req.catch(() => {});
  try {
    me = await me_req;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      token = "";
      clear_saved_auth(false);
      await wait_assets_ready();
      if (isBoot && !boot_gate_done) {
        set_boot_progress(100, "请先登录账号", false);
        await finish_boot_gate(true);
      } else {
        $("auth").classList.remove("hide");
        $("app").classList.add("hide");
        sync_theme_root(document.documentElement.classList.contains("dark"));
        try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
      }
      return;
    }
    if (isBoot && !boot_gate_done) {
      set_boot_progress(35, (e && e.message ? e.message : "网络连接异常") + "，请点击重试", true);
      return;
    }
    if (!me) {
      document.documentElement.classList.remove("has-saved-auth");
      $("auth").classList.remove("hide");
      $("app").classList.add("hide");
      sync_theme_root(document.documentElement.classList.contains("dark"));
    }
    toast(e.message);
    try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
    return;
  }

  try {
    if (isBoot && !boot_gate_done) {
      set_boot_progress(72, "正在加载通知、待办与课表…", false);
    }
    const sched_req = (typeof load_schedule === "function")
      ? Promise.race([Promise.resolve(load_schedule()), new Promise(r => setTimeout(r, 4500))]).catch(() => {})
      : Promise.resolve();
    const ai_req = Promise.race([check_ai(), new Promise(r => setTimeout(r, 4000))]).catch(() => {});

    const [[n, t]] = await Promise.all([data_req, sched_req, ai_req, wait_assets_ready()]);
    notices = Array.isArray(n) ? n : [];
    tasks = Array.isArray(t) ? t : [];
  } catch (e) {
    if (isBoot && !boot_gate_done) {
      set_boot_progress(60, (e && e.message ? e.message : "数据同步失败") + "，请点击重试", true);
      return;
    }
    toast(e.message);
  }

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
  load_starred_notices();
  render_home();
  render_notices();
  render_tasks();
  if (typeof render_schedule_all === "function") render_schedule_all();
  if (cur_page === "home") go("home");

  if (!boot_gate_done) {
    set_boot_progress(100, "加载完成", false);
    await finish_boot_gate(false);
  } else {
    document.documentElement.classList.remove("has-saved-auth");
    $("auth").classList.add("hide");
    $("app").classList.remove("hide");
    sync_theme_root(document.documentElement.classList.contains("dark"));
    try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
  }
}

async function refresh() {
  try {
    const [n, t] = await Promise.all([api("/notices"), api("/tasks")]);
    if (!me) return;
    notices = n;
    tasks = t;
    render_home();
    render_notices();
    render_tasks();
  } catch (e) {
    toast(e.message);
  }
}

function date(s) {
  if (!s) return "未设置截止日期";
  let d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString("zh-CN");
}

function due_markup(due_str, status) {
  if (!due_str) return `<span>未设置截止日期</span>`;
  if (status === "completed") return `<span>${ico("clock","ico-xs")}截止日期：${esc(due_str)}</span>`;
  const now = new Date();
  const today_local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due_parts = String(due_str).slice(0, 10).split("-").map(Number);
  const due_local = due_parts.length === 3 ? new Date(due_parts[0], due_parts[1] - 1, due_parts[2]) : new Date(due_str);
  const diff = Math.round((due_local - today_local) / 86400000);
  if (!isNaN(diff)) {
    if (diff < 0) {
      return `<span class="due-tag overdue">${ico("alert","ico-xs")}已逾期 (${esc(due_str)})</span>`;
    }
    if (diff <= 3) {
      return `<span class="due-tag soon">${ico("alert","ico-xs")}剩 ${diff} 天截止 (${esc(due_str)})</span>`;
    }
  }
  return `<span>${ico("clock","ico-xs")}截止日期：${esc(due_str)}</span>`;
}

function set_badges(pending_count) {
  const nav_badge = $("navTaskBadge");
  const mob_badge = $("mobTaskBadge");
  if (nav_badge) {
    nav_badge.textContent = pending_count;
    nav_badge.classList.toggle("hide", pending_count === 0);
  }
  if (mob_badge) {
    mob_badge.textContent = pending_count;
    mob_badge.classList.toggle("hide", pending_count === 0);
  }
}

function render_home() {
  const pending_count = tasks.filter(t => t.status === "pending").length;
  const done_count = tasks.filter(t => t.status === "completed").length;
  $("statNotices").textContent = notices.length;
  $("statPending").textContent = pending_count;
  $("statDone").textContent = done_count;
  set_badges(pending_count);

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

  save_home_snap();
}

function render_notices() {
  let q = ($("search").value || "").toLowerCase(),
    cat = $("category").value;
  $("clearSearch")?.classList.toggle("hide", !q);

  const active_pill_cat = document.querySelector("#catPills .pill-btn.active")?.dataset.cat ?? "";
  const only_starred = active_pill_cat === "__starred__";

  const star_badge = $("starCountBadge");
  if (star_badge) star_badge.textContent = starred_notice_ids.size ? `(${starred_notice_ids.size})` : "";

  let list = notices.filter(n => {
    if (only_starred && !starred_notice_ids.has(Number(n.id))) return false;
    if (!only_starred && cat && n.category !== cat) return false;
    if (q && !(n.title + n.body + (n.publisher || "")).toLowerCase().includes(q)) return false;
    return true;
  });

  list = [...list].sort((a, b) => {
    const sa = starred_notice_ids.has(Number(a.id)) ? 1 : 0;
    const sb = starred_notice_ids.has(Number(b.id)) ? 1 : 0;
    return sb - sa;
  });

  const admin = me?.role === "admin";
  const task_notice_ids = new Set(tasks.map(t => Number(t.notice_id)));

  $("noticeCards").innerHTML =
    list
      .map(n => {
        const already_in_task = task_notice_ids.has(Number(n.id));
        const is_starred = starred_notice_ids.has(Number(n.id));
        return `<article class="notice-card ${is_starred ? "starred" : ""}">
          <div class="notice-top">
            <div class="notice-tags">
              <span class="tag">${esc(n.category)}</span>
              ${is_starred ? `<span class="tag star-tag">${ico("star-fill","ico-xs")}已置顶收藏</span>` : ""}
            </div>
            <div class="notice-actions">
              <button type="button" class="ai-btn" data-ai-notice="${n.id}">${ico("sparkles")}AI 解读</button>
              <button type="button" class="outline ${already_in_task ? "added" : ""}" data-add="${n.id}">
                ${already_in_task ? ico("check", "ico-xs") + "已在待办" : ico("plus", "ico-xs") + "加入待办"}
              </button>
              <button type="button" class="outline icon-only ${is_starred ? "starred-btn" : ""}" data-star-notice="${n.id}"
                title="${is_starred ? "取消收藏" : "收藏并置顶"}" aria-label="${is_starred ? "取消收藏" : "收藏并置顶"}">
                ${is_starred ? ico("star-fill") : ico("star")}
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

}

$("search").oninput = debounce(render_notices, 120);
$("clearSearch")?.addEventListener("click", () => {
  $("search").value = "";
  render_notices();
});
$("category").onchange = () => {
  document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.cat === $("category").value);
  });
  render_notices();
};
document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#catPills .pill-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (btn.dataset.cat !== "__starred__") {
      $("category").value = btn.dataset.cat;
      if (typeof sync_xz_select === "function") sync_xz_select($("category"));
    }
    render_notices();
  };
});

/* ---- 我的待办 ---- */
$("taskFilter").onchange = render_tasks;
$("taskSearch")?.addEventListener("input", debounce(render_tasks, 120));

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
    render_tasks();
    render_home();
    toast("已添加个人待办事项");
  } catch (err) {
    toast(err.message);
  }
});

$("markAllDone")?.addEventListener("click", async () => {
  const pending_list = tasks.filter(t => t.status === "pending");
  if (!pending_list.length) return toast("当前没有待处理的任务");
  try {
    try {
      await api("/tasks/complete-all", { method: "POST" });
    } catch {
      await Promise.all(
        pending_list.map(t =>
          api("/tasks/" + t.id, {
            method: "PATCH",
            body: JSON.stringify({ status: "completed" })
          })
        )
      );
    }
    tasks = await api("/tasks");
    render_tasks();
    render_home();
    toast(`已将 ${pending_list.length} 项待办全部标为完成`);
  } catch (e) {
    toast(e.message);
  }
});

$("clearCompletedTasks")?.addEventListener("click", async () => {
  const done_list = tasks.filter(t => t.status === "completed");
  if (!done_list.length) return toast("当前没有已完成的任务可清理");
  if (!(await ui_confirm(`确定清理全部 ${done_list.length} 项已完成的待办事项吗？`, { title: "清理已完成待办", danger: true }))) return;
  try {
    const res = await api("/tasks/completed", { method: "DELETE" });
    tasks = await api("/tasks");
    render_tasks();
    render_home();
    render_notices();
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
    render_tasks(); render_home();
    $("editTaskDialog").close();
    toast("待办内容与截止日期已更新");
  } catch (e) { toast(e.message || "保存失败"); }
  finally { btn.disabled = false; }
});

function render_tasks() {
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
              ${due_markup(t.due_date, t.status)}
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

}

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
  const edit_id = $("nEditId").value;
  try {
    if (edit_id) {
      await api("/notices/" + edit_id, {
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

/* ---- 全站横向区域抓取拖动（仅桌面鼠标拖动，不影响普通点击和移动端触摸滚动） ---- */
(function init_global_grab_scroll() {
  const selector = [
    '#knowledgePage .cat-pills', '#noticesPage #catPills', '#knowledgePills',
    '#schedDeskDateStrip', '#schedDateStrip', '#schedDeskWeekStrip', '#schedWeekStrip',
    '.sched-week-strip', '.sched-date-strip', '.sched-wg-wrap', '.sched-matrix-inner',
    '.doc-font-group', '.doc-m-font-seg', '.sched-m-seg', '.sched-d-seg'
  ].join(',');
  let active = null;
  let suppressClickEl = null;
  let suppressClickUntil = 0;

  function eligible(el) {
    if (!el || el.matches('.suggestions')) return false;
    return el.scrollWidth > el.clientWidth + 4;
  }
  document.addEventListener('pointerdown', e => {
    suppressClickEl = null;
    suppressClickUntil = 0;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    const el = target ? target.closest(selector) : null;
    if (!eligible(el)) return;
    active = { el, id:e.pointerId, x:e.clientX, left:el.scrollLeft, moved:false };
    el.classList.add('is-grab-scroll');
  }, {passive:true});
  document.addEventListener('pointermove', e => {
    if (!active || active.id !== e.pointerId) return;
    const dx = e.clientX - active.x;
    if (!active.moved && Math.abs(dx) < 7) return;
    if (!active.moved) {
      active.moved = true;
      active.el.classList.add('is-grab-scrolling');
      try { active.el.setPointerCapture(e.pointerId); } catch (_) {}
    }
    active.el.scrollLeft = active.left - dx;
    if (e.cancelable) e.preventDefault();
  }, {passive:false});
  function finish(e) {
    if (!active || (e && active.id !== e.pointerId)) return;
    if (active.moved) {
      suppressClickEl = active.el;
      suppressClickUntil = Date.now() + 420;
      try { if (active.el.hasPointerCapture?.(active.id)) active.el.releasePointerCapture(active.id); } catch (_) {}
    }
    active.el.classList.remove('is-grab-scroll','is-grab-scrolling');
    active = null;
  }
  document.addEventListener('pointerup', finish, {passive:true});
  document.addEventListener('pointercancel', finish, {passive:true});
  document.addEventListener('click', e => {
    if (suppressClickEl && Date.now() < suppressClickUntil && suppressClickEl.contains(e.target)) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    }
    suppressClickEl = null;
    suppressClickUntil = 0;
  }, true);
})();

/* ---- 热门提问横向滚动 ---- */
function sync_hot_nav() {
  const track = $("suggestionsTrack");
  const prev_btn = $("sugPrev");
  const next_btn = $("sugNext");
  if (!track || !prev_btn || !next_btn) return;
  const max_scroll = track.scrollWidth - track.clientWidth;
  prev_btn.classList.toggle("hide", track.scrollLeft <= 6);
  next_btn.classList.toggle("hide", max_scroll <= 6 || track.scrollLeft >= max_scroll - 6);
}

function init_hot_bar() {
  const track = $("suggestionsTrack");
  const prev_btn = $("sugPrev");
  const next_btn = $("sugNext");
  if (!track) return;

  prev_btn?.addEventListener("click", () => {
    track.scrollBy({ left: -260, behavior: "smooth" });
  });
  next_btn?.addEventListener("click", () => {
    track.scrollBy({ left: 260, behavior: "smooth" });
  });

  track.addEventListener("scroll", sync_hot_nav, { passive: true });
  window.addEventListener("resize", sync_hot_nav);

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

  let is_down = false;
  let start_x = 0;
  let scroll_start = 0;
  let dragged = false;

  track.addEventListener("mousedown", e => {
    is_down = true;
    dragged = false;
    track.classList.add("dragging");
    start_x = e.pageX - track.offsetLeft;
    scroll_start = track.scrollLeft;
  });

  window.addEventListener("mouseup", () => {
    if (!is_down) return;
    is_down = false;
    track.classList.remove("dragging");
  });

  track.addEventListener("mousemove", e => {
    if (!is_down) return;
    const x = e.pageX - track.offsetLeft;
    const walk = (x - start_x) * 1.25;
    if (Math.abs(walk) > 6) {
      dragged = true;
      e.preventDefault();
      track.scrollLeft = scroll_start - walk;
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
      auto_resize_question();
      $("question").focus();
    };
  });

  setTimeout(sync_hot_nav, 100);
}
init_hot_bar();

/* ---- 校规制度库 ---- */
let kb_total = 0; 
function kb_total_text() {
  return kb_total > 0 ? String(kb_total) : "…";
}
function apply_kb_count(total, chunks) {
  const n = Number(total);
  if (!Number.isFinite(n) || n <= 0) return;
  kb_total = n;
  document.querySelectorAll("[data-kb-count]").forEach(el => { el.textContent = String(n); });
  document.querySelectorAll("[data-kb-count-title]").forEach(el => {
    el.title = `点击查阅 ${n} 份校规制度原文`;
  });
  const stat = $("statKnowledge");
  if (stat) stat.textContent = String(n);
  const chunk_num = Number(chunks);
  if (Number.isFinite(chunk_num) && chunk_num > 0) {
    document.querySelectorAll("[data-kb-chunks]").forEach(el => { el.textContent = String(chunk_num); });
  }
}
function set_kb_counts(total, docs = []) {
  const n = Number(total);
  if (Number.isFinite(n) && n > 0) apply_kb_count(n);
  const dept_counts = { "教务处": 0, "学生工作部": 0 };
  for (const doc of docs || []) if (Object.prototype.hasOwnProperty.call(dept_counts, doc.dept)) dept_counts[doc.dept]++;
  document.querySelectorAll("#knowledgePills .pill-btn[data-kdept]").forEach(btn => {
    const dept = btn.dataset.kdept || "";
    const base = btn.dataset.baseLabel || (dept || "全部");
    if (!dept) btn.textContent = `${base} (${kb_total_text()})`;
    else if (docs.length) btn.textContent = `${base} (${dept_counts[dept] || 0})`;
  });
  const select = $("knowledgeDept");
  if (select && docs.length) {
    [...select.options].forEach(option => {
      const dept = option.value;
      const base = option.dataset.baseLabel || option.textContent.replace(/\s*（\d+）$/, "");
      option.dataset.baseLabel = base;
      if (!dept) option.textContent = `${base}（${kb_total_text()}）`;
      else if (Object.prototype.hasOwnProperty.call(dept_counts, dept)) option.textContent = `${base}（${dept_counts[dept] || 0}）`;
    });
  }
}
function clip_snippet(content, title = "") {
  let text = String(content || "").replace(/^\s*【\d{3}】\s*/, "");
  if (title && text.startsWith(title)) text = text.slice(title.length);
  text = text.replace(/^\s*【(?:部门|栏目|日期|链接)】[^\n]*(?:\n|$)/gm, "");
  return text.trim();
}
function set_result_meta({ shown = 0, query = "", dept = "", matched = 0, loading = false, failed = false } = {}) {
  const el = $("knowledgeResultMeta");
  if (!el) return;
  if (loading) { el.textContent = "正在加载制度目录…"; return; }
  if (failed) { el.textContent = "制度目录加载失败，请检查网络后重试。"; return; }
  const filter = query ? `关键词“${query}”` : (dept ? `部门“${dept}”` : "全部制度");
  el.textContent = query
    ? `${filter}：找到 ${shown} 份相关文件${matched ? `，另有 ${matched} 条款片段可直接阅读` : ""}。目录共 ${kb_total_text()} 份唯一标题文件。`
    : `${filter}：当前显示 ${shown} / ${kb_total_text()} 份文件。`;
}

function render_knowledge_grid(docs, matched_chunks = [], q = "") {
  kb_render_sig = `${docs.length}|${q}|${$("knowledgeDept")?.value || ""}|${kb_total}|${matched_chunks.length}`;
  const matched_box = $("knowledgeMatchedBox");
  const matched_list = $("knowledgeMatchedList");
  if (q && matched_chunks.length && matched_box && matched_list) {
    matched_box.classList.remove("hide");
    matched_list.innerHTML = matched_chunks
      .map(c => {
        const text = clip_snippet(c.content, c.docTitle || c.name);
        return `<article class="notice-card">
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
          <p>${esc(text.slice(0, 360))}${text.length > 360 ? "…" : ""}</p>
        </article>`;
      })
      .join("");
  } else if (matched_box) {
    matched_box.classList.add("hide");
  }

  const grid = $("knowledgeGrid");
  if (grid) {
    const total_txt = esc(kb_total_text());
    grid.innerHTML =
      docs
        .map(
          d => `<article class="knowledge-card">
            <div>
              <div class="notice-top knowledge-card-top">
                <span class="tag">${esc(d.dept || "学校部门")}</span>
                <span class="doc-index" title="目录内唯一序号">档案 ${esc(d.catalog_no || String(d.id || 0).padStart(3, "0"))}/${total_txt}</span>
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
}

async function load_knowledge() {
  const q = ($("knowledgeSearch")?.value || "").trim();
  const dept = $("knowledgeDept")?.value || "";
  const grid = $("knowledgeGrid");
  const matched_box = $("knowledgeMatchedBox");
  const request_seq = ++knowledge_request_seq;
  $("clearKnowledgeSearch")?.classList.toggle("hide", !q);

  if (!q && all_knowledge_docs_cache) {
    const filtered = dept ? all_knowledge_docs_cache.filter(d => d.dept === dept) : all_knowledge_docs_cache;
    knowledge_docs = filtered;
    set_kb_counts(kb_total, all_knowledge_docs_cache);
    set_result_meta({ shown: filtered.length, dept });
    const sig = `${filtered.length}||${dept}|${kb_total}|0`;
    if (sig !== kb_render_sig) render_knowledge_grid(filtered, [], "");
    return;
  }
  if (grid) grid.setAttribute("aria-busy", "true");
  set_result_meta({ loading: true });
  if (grid && !knowledge_docs.length) grid.innerHTML = '<div class="panel empty" style="grid-column:1/-1" role="status">正在加载制度目录…</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (dept) params.set("dept", dept);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await api("/knowledge" + qs);
    if (request_seq !== knowledge_request_seq) return;
    if (!data || !Array.isArray(data.docs)) throw Error("制度目录返回格式异常，请稍后重试。");
    knowledge_docs = data.docs;
    const total_docs = Number(data.total_docs ?? (all_knowledge_docs_cache ? all_knowledge_docs_cache.length : knowledge_docs.length));
    if (!q && !dept && knowledge_docs.length) all_knowledge_docs_cache = knowledge_docs;
    if (!q && !dept) set_kb_counts(total_docs, knowledge_docs);
    else if (all_knowledge_docs_cache) set_kb_counts(total_docs, all_knowledge_docs_cache);
    const matched_chunks = Array.isArray(data.matched_chunks) ? data.matched_chunks : [];
    set_result_meta({ shown: knowledge_docs.length, query: q, dept, matched: matched_chunks.length });
    render_knowledge_grid(knowledge_docs, matched_chunks, q);
  } catch (e) {
    if (request_seq !== knowledge_request_seq) return;
    if (grid) grid.innerHTML = `<div class="panel empty" style="grid-column:1/-1" role="alert">${esc(e.message || "制度目录加载失败")}<br><button type="button" class="outline" id="retryKnowledgeBtn" style="margin-top:10px">重新加载</button></div>`;
    set_result_meta({ failed: true });
    if (matched_box) matched_box.classList.add("hide");
    $("retryKnowledgeBtn")?.addEventListener("click", load_knowledge, { once: true });
    toast(e.message || "制度目录加载失败，请检查网络后重试");
  } finally {
    if (request_seq === knowledge_request_seq && grid) grid.removeAttribute("aria-busy");
  }
}
/* ---- 制度原文阅读器 ---- */
const doc_font_key = "kbDocFontScale";
let doc_font_scale = (() => {
  const v = Number(localStorage.getItem(doc_font_key));
  return Number.isFinite(v) && v >= 0.8 && v <= 1.5 ? v : 1;
})();
let doc_outline_heads = [];

function apply_font_scale() {
  const paper = $("docDialogBody");
  if (paper) paper.style.fontSize = `${(16.5 * doc_font_scale).toFixed(1)}px`;
  const level = doc_font_scale > 1.001 ? 1 : (doc_font_scale < 0.999 ? -1 : 0);
  document.querySelectorAll("[data-font]").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.font) === level);
  });
}

function render_doc_html(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(x => x.trim()).filter(Boolean);
  const out = [];
  let sec_id = 0;
  const is_cell_line = s =>
    s.length <= 26 &&
    !/[。；：！？”]$/.test(s) &&
    !/^第[一二三四五六七八九十百零\d]+[章条]/.test(s) &&
    !/^[一二三四五六七八九十]+、/.test(s) &&
    !/^附件/.test(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (is_cell_line(line)) {
      let j = i;
      while (j < lines.length && is_cell_line(lines[j])) j++;
      const run = lines.slice(i, j);
      if (run.length >= 4) {
        out.push('<div class="doc-table">' + run.map(x => `<div class="doc-trow">${esc(x)}</div>`).join("") + "</div>");
        i = j - 1;
        continue;
      }
    }

    if (line.length <= 42 && /^第[一二三四五六七八九十百零\d]+章[\s　]/.test(line)) {
      out.push(`<h3 class="doc-h2" id="doc-sec-${++sec_id}">${esc(line)}</h3>`);
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
      out.push(`<h4 class="doc-h3" id="doc-sec-${++sec_id}">${esc(line)}</h4>`);
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
      out.push(`<h4 class="doc-h3" id="doc-sec-${++sec_id}">${esc(line)}</h4>`);
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

function build_outline(paper) {
  const box = $("docOutline");
  if (!box) return;
  doc_outline_heads = [...paper.querySelectorAll(".doc-h2, .doc-h3")];
  const scroll = $("docReaderScroll");
  if (doc_outline_heads.length < 2) {
    box.classList.add("hide");
    box.innerHTML = "";
    scroll?.classList.add("no-outline");
    return;
  }
  scroll?.classList.remove("no-outline");
  box.classList.remove("hide");
  box.innerHTML =
    '<div class="doc-outline-title">章节目录</div>' +
    doc_outline_heads
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
      set_outline_active(btn.dataset.target);
    };
  });
}

function set_outline_active(id) {
  document.querySelectorAll(".doc-outline-item").forEach(b => {
    b.classList.toggle("active", b.dataset.target === id);
  });
}

function sync_doc_progress() {
  const sc = $("docReaderScroll");
  const bar = $("docReaderProgress");
  if (!sc || !bar) return;
  const max = sc.scrollHeight - sc.clientHeight;
  const pct = max > 8 ? Math.min(100, Math.max(0, (sc.scrollTop / max) * 100)) : 100;
  bar.style.width = `${pct}%`;
  if (!doc_outline_heads.length) return;
  const top = sc.getBoundingClientRect().top + 72;
  let current = doc_outline_heads[0];
  for (const h of doc_outline_heads) {
    if (h.getBoundingClientRect().top <= top) current = h;
    else break;
  }
  if (current?.id) set_outline_active(current.id);
}

async function open_doc_reader(doc_title, highlight_articles = []) {
  if (!doc_title) return;
  const clean_title = String(doc_title).split(" · ")[0].trim();
  const hlList = Array.isArray(highlight_articles)
    ? highlight_articles.map(s => String(s || "").trim()).filter(Boolean)
    : [];
  try {
    const data = await api("/knowledge?doc=" + encodeURIComponent(clean_title));
    const doc = data.doc || { title: clean_title, dept: "学校部门", category: "规章制度", url: "https://jwc.xawl.edu.cn/" };
    if (Number(data.total_docs) > 0) apply_kb_count(data.total_docs);
    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    const full_text = chunks.map(c => c.content).join("\n");
    current_doc_viewing = { ...doc, fullText: full_text };

    $("docDialogDept").textContent = doc.dept || "学校部门";
    $("docDialogCategory").textContent = doc.category || "规章制度";
    $("docDialogDate").textContent = doc.date || "";
    $("docDialogTitle").textContent = doc.title || clean_title;
    $("docDialogIndex").textContent = `档案 ${doc.catalog_no || "—"}/${kb_total_text()}`;

    const paper = $("docDialogBody");
    const paperTitle = `<h1 class="doc-paper-title">${esc(doc.title || clean_title)}</h1>`;
    paper.innerHTML = paperTitle + (render_doc_html(full_text) || '<p class="doc-p">暂无正文内容</p>');
    apply_font_scale();
    build_outline(paper);

    let firstHlEl = null;
    const hitLabels = [];
    if (hlList.length) {
      const blocks = [...paper.querySelectorAll("p, h2, h3, li")];
      for (const art of hlList) {
        const matched = blocks.find(el => (el.textContent || "").includes(art));
        if (matched) {
          matched.classList.add("doc-clause-hl");
          if (!firstHlEl) firstHlEl = matched;
          if (!hitLabels.includes(art)) hitLabels.push(art);
        }
      }
      if (hitLabels.length) {
        const banner = document.createElement("div");
        banner.className = "doc-hl-banner";
        banner.innerHTML = `<span class="doc-hl-spark">✦</span><span>已为你自动定位 AI 引用条款：<b>${esc(hitLabels.join("、"))}</b></span>`;
        const h1 = paper.querySelector(".doc-paper-title");
        if (h1 && h1.nextSibling) paper.insertBefore(banner, h1.nextSibling);
        else paper.prepend(banner);
      }
    }

    const chars = full_text.replace(/\s/g, "").length;
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
    if (firstHlEl) {
      requestAnimationFrame(() => {
        firstHlEl.scrollIntoView({ behavior: "smooth", block: "center" });
        sync_doc_progress();
      });
    } else {
      if (sc) sc.scrollTop = 0;
      requestAnimationFrame(sync_doc_progress);
    }
  } catch (e) {
    toast(e.message || "未能加载该制度原文");
  }
}

$("docReaderScroll")?.addEventListener("scroll", sync_doc_progress, { passive: true });
document.querySelectorAll("[data-font]").forEach(btn => {
  btn.onclick = () => {
    const delta = Number(btn.dataset.font);
    doc_font_scale = delta === 0 ? 1 : Math.min(1.4, Math.max(0.85, Number((doc_font_scale + delta * 0.1).toFixed(2))));
    try { localStorage.setItem(doc_font_key, String(doc_font_scale)); } catch {}
    apply_font_scale();
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
  if (!current_doc_viewing?.fullText) return;
  const ok = await copy_text_safe(`《${current_doc_viewing.title}》\n\n${current_doc_viewing.fullText}`);
  toast(ok ? "制度全文已复制到剪贴板" : "复制失败");
});
$("askAiDocBtn")?.addEventListener("click", () => {
  if (!current_doc_viewing?.title) return;
  const title = current_doc_viewing.title;
  $("docDialog")?.close();
  go("ai");
  $("question").value = `请帮我详细解读《${title}》的核心办理要求、所需材料和关键注意事项。`;
  auto_resize_question();
  $("askForm").requestSubmit();
});

$("knowledgeDept")?.addEventListener("change", () => {
  document.querySelectorAll("#knowledgePills .pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.kdept !== undefined && b.dataset.kdept === $("knowledgeDept").value && !$("knowledgeSearch").value.trim());
  });
  load_knowledge();
});
$("knowledgeSearch")?.addEventListener("input", () => {
  clearTimeout(k_search_timer);
  k_search_timer = setTimeout(load_knowledge, 240);
});
$("knowledgeSearch")?.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(k_search_timer);
    load_knowledge();
  }
});
$("clearKnowledgeSearch")?.addEventListener("click", () => {
  $("knowledgeSearch").value = "";
  document.querySelectorAll("#knowledgePills .pill-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.kdept !== undefined && b.dataset.kdept === $("knowledgeDept").value);
  });
  load_knowledge();
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
    if (typeof sync_xz_select === "function") sync_xz_select($("knowledgeDept"));
    load_knowledge();
  };
});

/* ---- AI 问答 ---- */
async function check_ai() {
  try {
    let d = await api("/health");
    $("aiStatus").textContent = d.ai_configured ? "在线" : "未配置";
    $("aiStatus").classList.toggle("ready", d.ai_configured);
    apply_kb_count(d.knowledge_files, d.knowledge_chunks);
  } catch {
    $("aiStatus").textContent = "离线";
  }
}

const md_url_trail_re = /[.,;:!?'")\]}>】）》」』，。、；：！？…·～`]+$/;

function trim_url_tail(input) {
  let s = String(input || "").trim();
  for (let guard = 0; guard < 10; guard++) {
    const m = s.match(md_url_trail_re);
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

function short_url_text(url) {
  const s = String(url).replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return s.length <= 56 ? s : `${s.slice(0, 32)}…${s.slice(-18)}`;
}

function md_anchor(url, text) {
  const href = trim_url_tail(url);
  if (!/^(?:https?:\/\/|mailto:)/i.test(href)) return esc(String(text || url || ""));
  const label = String(text || "").trim() || short_url_text(href);
  return (
    `<a class="md-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer"` +
    ` title="${esc(href)}">${esc(label)}</a>`
  );
}

const emoji_svg_map = [
  [/📌|📍/gu, "pin"],
  [/📋|📝/gu, "clipboard"],
  [/🧭|🔄/gu, "route"],
  [/⚠️?|❗|❕|🚨/gu, "alert"],
  [/✅|☑️?|✔️?/gu, "check-square"],
  [/💡/gu, "bulb"],
  [/🎯/gu, "target"],
  [/🌐|📎|🔗/gu, "link"],
  [/📄|📑|📃/gu, "file-text"],
  [/📚|📖/gu, "book"],
  [/🔍|🔎/gu, "search"],
  [/⏰|⏳|🕒/gu, "clock"],
  [/📅|🗓️?/gu, "calendar"],
  [/🔔|📢/gu, "bell"],
  [/🎓/gu, "graduation"],
  [/🏆|🥇/gu, "award"],
  [/🔑|🔒/gu, "key"],
  [/✨|🤖/gu, "ai-brand"],
  [/⭐|🌟/gu, "star"]
];

function parse_inline_markdown(raw) {
  const slots = [];
  const keep = html => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let s = String(raw ?? "");

  s = s.replace(
    /\[([^\]\n]{1,160})\]\(\s*<?((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+)>?\s*\)/g,
    (m, text, url) => keep(md_anchor(url, text))
  );

  s = s.replace(
    /(^|[^\w./@%-])((?:https?:\/\/)[^\s<>"'`()[\]{}）】》」』，。；：！？]+)/g,
    (m, pre, url) => pre + keep(md_anchor(url, ""))
  );

  for (const [re, iconName] of emoji_svg_map) {
    s = s.replace(re, () => keep(ico(iconName, "ico-xs")));
  }
  s = s.replace(/[\p{Extended_Pictographic}\u200d\uFE0F]+/gu, "");

  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] ?? "");
}

const cn_num = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cn_to_num(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return t;
  if (t === "十") return "10";
  if (t.length === 2 && t[0] === "十") return "1" + cn_num[t[1]];
  if (t.length === 2 && t[1] === "十") return cn_num[t[0]] + "0";
  return String(cn_num[t] || t);
}

const md_section_kinds = [
  [/结论|依据|政策|适用|判断/, "decision", "target"],
  [/材料|表单|清单|证件|附件/, "materials", "clipboard"],
  [/流程|步骤|动线|顺序|程序/, "flow", "route"],
  [/红线|注意|风险|警示|禁止|违规|提醒/, "warn", "alert"],
  [/行动|待办|下一步|要做|执行/, "action", "check-square"],
  [/确认|追问|需要你|补充|提示/, "ask", "bulb"],
];

function md_section_kind(title) {
  for (const [re, kind, icon] of md_section_kinds) if (re.test(title)) return [kind, icon];
  return ["note", "file-text"];
}

function format_markdown_safe(text) {
  const raw = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/<!--(?:AGENT_ACTIONS|SCHEDULE_ACTION|UI_META)[\s\S]*?(?:(?:AGENT_ACTIONS|SCHEDULE_ACTION|UI_META)-->|$)/g, "");
  if (!raw.trim()) return "";

  const lines = raw.split("\n");
  const out = [];
  let in_code_block = false;
  let code_lines = [];
  let list_type = null;
  let list_items = [];
  let table_rows = [];

  const flush_list = () => {
    if (!list_type || !list_items.length) return;
    const cls = list_type === "ol" ? "md-ol" : "md-list";
    out.push(`<${list_type} class="${cls}">${list_items.join("")}</${list_type}>`);
    list_type = null;
    list_items = [];
  };

  const flush_table = () => {
    if (!table_rows.length) return;
    if (table_rows.length === 1) {
      out.push(`<p class="md-p">${parse_inline_markdown(table_rows[0])}</p>`);
      table_rows = [];
      return;
    }
    const parse_cells = row =>
      row
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(c => parse_inline_markdown(c.trim()));
    const headers = parse_cells(table_rows[0]);
    const start_idx = /^\|[\s:-]+\|/.test(table_rows[1].trim()) ? 2 : 1;
    const body_html = table_rows
      .slice(start_idx)
      .map(r => `<tr>${parse_cells(r).map(c => `<td>${c}</td>`).join("")}</tr>`)
      .join("");
    out.push(
      `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headers
        .map(h => `<th>${h}</th>`)
        .join("")}</tr></thead><tbody>${body_html}</tbody></table></div>`
    );
    table_rows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flush_list();
      flush_table();
      if (!in_code_block) {
        in_code_block = true;
        code_lines = [];
      } else {
        out.push(`<pre class="md-pre"><code>${esc(code_lines.join("\n"))}</code></pre>`);
        in_code_block = false;
      }
      continue;
    }
    if (in_code_block) {
      code_lines.push(line);
      continue;
    }

    if (/^\|.+\|$/.test(trimmed)) {
      flush_list();
      table_rows.push(trimmed);
      continue;
    } else if (table_rows.length) {
      flush_table();
    }

    if (!trimmed) {
      flush_list();
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush_list();
      out.push('<hr class="md-hr">');
      continue;
    }

    const sec_match =
      trimmed.match(
        /^(?:[-*•]\s*)?(?:#{1,4}\s*)?\**\s*(?:[\p{Extended_Pictographic}\u200d\uFE0F✅☑️✔️⚠️❗❕🚨]*)\s*\**\s*【([^】\n]{2,24})】\s*\**\s*[：:]?\s*\**\s*(.*)$/u
      ) ||
      trimmed.match(
        /^(?:[-*•]\s*)?(?:#{1,4}\s*|\*\*)\s*(?:[\p{Extended_Pictographic}\u200d\uFE0F✅☑️✔️⚠️❗❕🚨]+)\s*\**\s*([^：:*#\n【】]{2,20}?)\s*\**\s*(?:[：:]\s*\**\s*(.*)|$)$/u
      );
    if (sec_match) {
      flush_list();
      flush_table();
      const sec_title = sec_match[1].replace(/\*+/g, "").trim();
      const sec_rest = (sec_match[2] || "").replace(/^\*+\s*/, "").trim();
      const [kind, icon] = md_section_kind(sec_title);
      out.push(
        `<div class="md-section md-section-${kind}">${ico(icon)}` +
          `<span class="md-section-title">${esc(sec_title)}</span>` +
          (sec_rest ? `<span class="md-section-rest">${parse_inline_markdown(sec_rest)}</span>` : "") +
          `</div>`
      );
      continue;
    }

    const h_match = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (h_match) {
      flush_list();
      const level = h_match[1].length;
      const content = parse_inline_markdown(h_match[2]);
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
      flush_list();
      const q_content = parse_inline_markdown(trimmed.replace(/^>\s*/, ""));
      out.push(`<blockquote class="md-quote">${q_content}</blockquote>`);
      continue;
    }

    const step_match = trimmed.match(
      /^(?:[-*•]\s*)?第\s*([0-9一二三四五六七八九十]+)\s*步\s*[：:.、]?\s*(.+)$/
    );
    if (step_match) {
      flush_list();
      out.push(
        `<div class="md-step"><i>${esc(cn_to_num(step_match[1]))}</i><div>${parse_inline_markdown(step_match[2])}</div></div>`
      );
      continue;
    }

    const ul_match = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ul_match) {
      if (list_type && list_type !== "ul") flush_list();
      list_type = "ul";
      list_items.push(`<li>${parse_inline_markdown(ul_match[1])}</li>`);
      continue;
    }

    const ol_match = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (ol_match) {
      if (list_type && list_type !== "ol") flush_list();
      list_type = "ol";
      list_items.push(`<li>${parse_inline_markdown(ol_match[1])}</li>`);
      continue;
    }

    flush_list();
    out.push(`<p class="md-p">${parse_inline_markdown(trimmed)}</p>`);
  }

  if (in_code_block && code_lines.length) {
    out.push(`<pre class="md-pre"><code>${esc(code_lines.join("\n"))}</code></pre>`);
  }
  flush_list();
  flush_table();

  return `<div class="md-content">${out.join("")}</div>`;
}

const todo_action_re = /(?:提交|递交|送交|申请|预约|办理|登录|填写|填报|上传|下载|打印|携带|准备|核对|确认|联系|咨询|领取|缴纳|缴费|签字|签署|盖章|补交|发送|参加|查询|前往|完成|保存|录入|回复|反馈|报备|备案|沟通|递送)/;
const todo_section_actions = ["下一步行动", "行动清单", "行动建议", "待办建议", "你需要做的事", "您需要做的事", "你需要做", "接下来要做", "下一步要做", "建议你现在做", "建议您现在做", "你现在要做的"];
const todo_section_flow = ["办理流程", "分步办理流程", "具体步骤", "办理步骤", "操作步骤", "办理动线", "办理程序"];
const todo_section_end = ["注意事项", "关键红线", "政策解读", "相关规定", "参考依据", "补充说明", "常见问题", "温馨提示", "结论", "总结", "政策依据", "办理结论", "所需材料", "材料清单", "来源", "参考资料", "需要你确认", "需向您确认", "下一步建议", "其他说明"];
const todo_non_student = /^(?:学校|学院|教务处|学生处|学生工作部|学工部|辅导员|任课教师|教学秘书|审核部门|工作人员|系统|平台|二级学院)(?:将|会|负责|统一|组织|进行|审核|办理|发布|通知|根据)/;
const todo_noise = /^(?:以上|如下|具体如下|请注意|可以参考|根据上述|总的来说|综上所述|如需帮助|例如|比如|通常|一般来说|可能|可以考虑)/;

function guess_due_date(text) {
  const s = String(text || "");
  const now = new Date();
  let y = 0, m = 0, d = 0;
  const full = s.match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  const month_day = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (full) { y = +full[1]; m = +full[2]; d = +full[3]; }
  else if (month_day) { y = now.getFullYear(); m = +month_day[1]; d = +month_day[2]; }
  else return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const pad = n => String(n).padStart(2, "0");
  let date = `${y}-${pad(m)}-${pad(d)}`;
  if (!full && new Date(`${date}T23:59:59`) < now) date = `${y + 1}-${pad(m)}-${pad(d)}`;
  return date;
}

function pick_steps(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n")
    .map(line => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/^>\s*/, "").trim())
    .filter(Boolean);

  const section_of = line => {
    const bare = line
      .replace(/^[^\u4e00-\u9fa5A-Za-z0-9【\[（(]{1,4}\s*/, "")
      .replace(/^[【\[（(]\s*/, "")
      .replace(/\s*[】\]）)]\s*[：:]?\s*$/, "")
      .replace(/[：:]\s*$/, "")
      .trim();
    if (!bare || bare.length > 16) return "";
    if (todo_section_actions.some(k => bare === k || bare.startsWith(k))) return "actions";
    if (todo_section_flow.some(k => bare === k || bare.startsWith(k))) return "flow";
    if (todo_section_end.some(k => bare === k || bare.startsWith(k))) return "end";
    return "";
  };

  const item_re = /^(?:第\s*[一二三四五六七八九十\d]+\s*步\s*[：:.、]?|(?:[1-9]\d?)\s*[.、)）](?!\d)|[（(]\s*[1-9]\d?\s*[)）]|[①-⑳]|[-*•▪·]|\[\s?[xX]?\s?\])\s*(.+)$/;

  const tidy = raw => String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:第\s*[一二三四五六七八九十\d]+\s*步)\s*[：:.、]?\s*/, "")
    .replace(/^(?:请您?|建议您?|你(?:需要|要|得)?|您(?:需要|要|得)?|务必|记得|下一步)\s*[，,]?\s*/, "")
    .replace(/[。；;，,]+$/g, "")
    .trim();

  const acceptable = t => {
    if (!t || t.length < 4 || t.length > 60) return false;
    if (todo_noise.test(t) || todo_non_student.test(t)) return false;
    if (/^(?:无需|不需要|不必)/.test(t)) return false;
    if (/(?:无需|无须|不需要|不必)(?:再|另行|亲自|单独)?(?:申请|办理|提交|前往|盖章|跑)/.test(t)) return false;
    if (/^(?:具体|详细|相关|以上|如下|其中)/.test(t)) return false;
    if (!todo_action_re.test(t)) return false;
    if (/^《[^》]+》$/.test(t)) return false;
    return true;
  };

  const action_items = [];
  const flow_items = [];
  let active = "";
  for (const line of lines) {
    const kind = section_of(line);
    if (kind === "actions" || kind === "flow") { active = kind; continue; }
    if (kind === "end") { active = ""; continue; }
    if (!active) continue;
    const m = line.match(item_re);
    if (!m) continue;
    const title = tidy(m[1]);
    if (!acceptable(title)) continue;
    (active === "actions" ? action_items : flow_items).push(title);
  }

  let picked = action_items.length ? action_items : flow_items;

  if (!picked.length) {
    picked = [];
    const sentences = String(text ?? "").replace(/\r/g, "")
      .split(/[\n。；;]/)
      .map(s => s.replace(/\*\*/g, "").replace(/^[#>\s\-*•▪·]+/, "").trim())
      .filter(s => s.length >= 6 && s.length <= 80);
    for (const s of sentences) {
      const title = tidy(s.replace(/^(?:\d{1,2}\s*[.、)）]|[①-⑳])\s*/, ""));
      if (!acceptable(title)) continue;
      const has_signal = /(系统|教务|平台|网站|学院|办公室|科室|教务处|学生处|辅导员|线下|线上|窗口|材料|表格|证明|原件|复印件|前|之前|截止|工作日|小时|天内|月\d|\d+月)/.test(title);
      if (!has_signal) continue;
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
    .map(title => ({ title, due_date: guess_due_date(title) }));
}
function pick_sources(sources) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(sources) ? sources : []) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    let u;
    try { u = new URL(item.url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    if (["", "/", "/index.htm", "/index.html", "/index.jsp", "/index.php", "/tzgg.htm", "/tzgg.html", "/通知公告"].includes(path)) continue;
    if (item.type === "web" && Number.isFinite(Number(item.relevance)) && Number(item.relevance) < 0.3) continue;
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

const meta_talk_sentence_res = [
  /(链接|网址|URL|来源)[^。！？\n]{0,24}(伪造|编造|虚构|捏造|造假|真伪|真实性|虚假|不实)/i,
  /(伪造|编造|虚构|捏造)[^。！？\n]{0,12}(链接|网址|URL|来源)/i,
  /(以上|以下|下方|下列|下面|这些|本文|本次)[^。！？\n]{0,10}(链接|网址|来源)[^。！？\n]{0,20}(均|都|已|可|真实|有效|官方|来自|核对|验证)/,
  /(链接|网址|来源)[^。！？\n]{0,12}(均|都)(为|是|来自|可|已)[^。！？\n]{0,12}(官网|官方|原文|真实|有效|核对)/,
  /(链接|网址)[^。！？\n]{0,12}(放心|安全|保真|不会失效|均可打开)/,
  /(未|没有|不)(会)?(自行)?(拼接|生成|编造|伪造)[^。！？\n]{0,8}(链接|网址|URL)/i,
  /(检索|搜索|查找|匹配)[^。！？\n]{0,12}(过程|日志|记录)[^。！？\n]{0,10}(不|无|省略|此处|如下)/,
];

function strip_meta_talk(text) {
  let out = String(text || "");
  if (!out) return out;
  out = out.replace(/[（(]\s*(注|说明|备注|提示)\s*[:：][^）)]{0,160}[）)]/g, m =>
    /链接|网址|来源|检索|搜索|伪造|编造|真实|有效|URL/i.test(m) ? "" : m
  );
  out = (out.match(/[^。！？；\n]+[。！？；\n]*/g) || [])
    .filter(seg => !meta_talk_sentence_res.some(re => re.test(seg)))
    .join("");
  return out
    .replace(/[ \t]+([，。；：、！？])/g, "$1")
    .replace(/[（(]\s*[)）]/g, "")
    .replace(/^[ \t]*[-*·][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function clean_links(text, sources) {
  const norm = u => {
    try { return new URL(u).href.replace(/\/$/, ""); } catch { return ""; }
  };
  const allowed = new Set(pick_sources(sources).map(s => norm(s.url)).filter(Boolean));
  let out = strip_meta_talk(text);
  out = out.replace(/\[([^\]]{1,240})\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/gi,
    (all, label, url) => (allowed.has(norm(url)) ? all : label)
  );
  out = out.replace(/https?:\/\/[^\s<>"'`()[\]{}）】》」』，。；：！？]+/gi, url => {
    const bare = url.replace(/[，。；;！？!?]+$/, "");
    return allowed.has(norm(bare)) ? url : "";
  });
  return out.replace(/[ \t]+([，。；：、！？])/g, "$1").replace(/[（(]\s*[)）]/g, "");
}

function tidy_title(value) {
  return String(value || "").toLowerCase().replace(/[\s，。；;：:、,.!?！？]/g, "").replace(/^(办理事项|跟进咨询事项|待办)[:：]/, "");
}

const answer_tail_ok = /[。！？…」』”"'）)\]】》!?.~～]$/;
const answer_tail_bad = /[，、,;；:：·（(\[【《〈“"'\-—]$/;
const answer_tail_cut = /[的该和与或及以于并且是在对为把被从此等而但就都也还很更最不没无]$/;

function looks_done(text) {
  const t = String(text || "")
    .replace(/<!--UI_META[\s\S]*?(?:UI_META-->|$)/g, "")
    .replace(/<!--AGENT_ACTIONS[\s\S]*?(?:AGENT_ACTIONS-->|$)/g, "")
    .replace(/<!--SCHEDULE_ACTION[\s\S]*?(?:SCHEDULE_ACTION-->|$)/g, "")
    .trimEnd();
  if (!t) return false;
  const openers = (t.match(/[（(\[【《〈“‘]/g) || []).length;
  const closers = (t.match(/[）)\]】》〉”’]/g) || []).length;
  if (openers > closers) return false;
  if (answer_tail_bad.test(t)) return false;
  if (answer_tail_cut.test(t)) return false;
  if (answer_tail_ok.test(t)) return true;
  const last_line = t.split("\n").map(s => s.trim()).filter(Boolean).pop() || "";
  if (/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])/.test(last_line)
    && last_line.replace(/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])\s*/, "").length >= 10) return true;
  return t.length <= 20;
}

function review_todos(items, source_question = "") {
  ai_todo_source_question = source_question;
  const existing = new Set(tasks.filter(t => t.status === "pending").map(t => tidy_title(t.title)));
  const seen = new Set();
  ai_todo_draft = (items || []).map(item => typeof item === "string" ? { title: item, due_date: "", selected: true } : ({ title: String(item.title || ""), due_date: item.due_date || "", selected: item.selected !== false }))
    .filter(item => item.title.trim())
    .filter(item => { const key = tidy_title(item.title); if (!key || seen.has(key)) return false; seen.add(key); return true; })
    .map(item => ({ ...item, duplicate: existing.has(tidy_title(item.title)) }));

  const list = $("aiTodoList");
  if (!list) return toast("待办审核界面尚未加载，请刷新页面后重试");
  const manual_mode = !ai_todo_draft.length;
  if (manual_mode) {
    ai_todo_draft = [{ title: "", due_date: "", selected: true, duplicate: false, manual: true }];
  }
  list.innerHTML = ai_todo_draft.map((item, index) => `
    <div class="ai-todo-draft ${item.duplicate ? "is-duplicate" : ""}" data-draft-row="${index}">
      <label class="ai-todo-select"><input type="checkbox" data-draft-select="${index}" ${item.selected && !item.duplicate ? "checked" : ""} ${item.duplicate ? "disabled" : ""}><span>${item.duplicate ? "疑似重复" : manual_mode ? "新待办" : `步骤 ${index + 1}`}</span></label>
      <div class="ai-todo-fields">
        <input data-draft-title="${index}" maxlength="200" value="${esc(item.title)}" placeholder="${manual_mode ? "例如：登录教务系统提交缓考申请（考试前完成）" : ""}" aria-label="待办标题 ${index + 1}" ${item.duplicate ? "disabled" : ""}>
        <label>截止日期（选填）<input type="date" data-draft-due="${index}" value="${esc(item.due_date)}" ${item.duplicate ? "disabled" : ""}></label>
      </div>
    </div>`).join("");
  $("aiTodoCount").textContent = manual_mode
    ? "这条回答里没有现成动作，直接写一条要办的事即可"
    : `${ai_todo_draft.filter(x => !x.duplicate).length} 条可添加 · ${ai_todo_draft.filter(x => x.duplicate).length} 条疑似重复`;
  $("aiTodoDialog").showModal();
  if (manual_mode) setTimeout(() => document.querySelector('[data-draft-title="0"]')?.focus(), 60);
}

$("closeAiTodoDialog")?.addEventListener("click", () => $("aiTodoDialog").close());
$("cancelAiTodoDialog")?.addEventListener("click", () => $("aiTodoDialog").close());
$("aiTodoList")?.addEventListener("input", event => {
  const el = event.target;
  if (el.matches("[data-draft-title]")) ai_todo_draft[Number(el.dataset.draftTitle)].title = el.value;
  if (el.matches("[data-draft-due]")) ai_todo_draft[Number(el.dataset.draftDue)].due_date = el.value;
});
$("aiTodoList")?.addEventListener("change", event => {
  const el = event.target;
  if (el.matches("[data-draft-select]")) ai_todo_draft[Number(el.dataset.draftSelect)].selected = el.checked;
});
$("confirmAiTodoImport")?.addEventListener("click", async () => {
  const selected = ai_todo_draft.filter((item, index) => {
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
    render_tasks(); render_home();
    $("aiTodoDialog").close();
    toast(res.message || `已保存 ${selected.length} 条待办`);
  } catch (e) {
    toast(e.message || "保存失败，请稍后重试");
  } finally {
    btn.disabled = false;
    btn.textContent = "确认添加到我的待办";
  }
});

function src_title(item) {
  let t = String(item.title || item.url || "").trim();
  const parts = t.split(/\s+-\s+/);
  if (parts.length > 1) {
    const site_like = p => p.length <= 12 && /(学院|大学|教务处|学生处|中心|部|网|首页)/.test(p);
    const tail = parts[parts.length - 1];
    if (tail.length >= 8 && parts.slice(0, -1).every(site_like)) {
      return tail;
    }
    const head = parts[0];
    const rest = parts.slice(1).filter(p => p && !head.includes(p) && !p.includes(head));
    t = [head, ...rest].join(" · ");
  }
  return t.replace(/^(.{6,}?)-[\u4e00-\u9fa5]{2,12}(学院|大学|教务处|学生处|图书馆|中心)$/, "$1");
}

function add_sources(parent_el, sources, label) {
  const valid_sources = pick_sources(sources);
  if (!valid_sources.length) return;
  const src = document.createElement("div");
  src.className = "ai-sources";
  const title = document.createElement("b");
  const clean_label = String(label || "")
    .replace(/^[\s\p{Extended_Pictographic}\u200d\uFE0F📎🌐🔗]+/gu, "")
    .trim();
  title.innerHTML = `${ico("link", "ico-xs")}${esc(clean_label || "可直接打开的原文链接")}`;
  src.appendChild(title);
  valid_sources.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "source-item-row";
    const a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const full = src_title(item);
    const shown = full.length > 48 ? full.slice(0, 48) + "…" : full;
    a.textContent = `${i + 1}. ${shown}`;
    a.title = `${full}${item.date ? "（" + date(item.date) + " 发布）" : ""}`;
    row.appendChild(a);

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
    meta.appendChild(document.createTextNode([host, item.date ? date(item.date) : ""].filter(Boolean).join(" · ")));
    if (meta.textContent.trim()) row.appendChild(meta);
    src.appendChild(row);
  });
  parent_el.appendChild(src);
}

function add_confidence(parent_el, confidence, sources) {
  const map = {
    high: { text: "依据充分", cls: "high", tip: "已找到与问题对应的校内文件或官网页面" },
    medium: { text: "依据有限", cls: "medium", tip: "只找到部分相关材料，具体细节以主管部门最新通知为准" },
    low: { text: "未找到原文", cls: "low", tip: "校内文件库与官网均未检索到直接依据，以下为办理路径建议" }
  };
  const info = map[confidence];
  if (!info) return;
  if (info.cls === "high" && (!sources || !sources.length)) return;
  const el = document.createElement("div");
  el.className = "ai-confidence " + info.cls;
  el.title = info.tip;
  el.innerHTML = `<i></i><span>${info.text}</span><small>${info.tip}</small>`;
  parent_el.appendChild(el);
}

function add_follow_ups(parent_el, items) {
  const limit = window.innerWidth <= 760 ? 2 : 3;
  const list = (Array.isArray(items) ? items : [])
    .map(s => String(s || "").trim())
    .filter(Boolean)
    .slice(0, limit);
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
    btn.innerHTML = `<span class="fu-arr" aria-hidden="true">↗</span><span>${esc(text)}</span>`;
    btn.onclick = () => {
      const q = $("question");
      if (!q) return;
      if (ai_busy) return toast("请等待当前回答完成或先点停止");
      q.value = text;
      auto_resize_question();
      $("askForm").requestSubmit();
    };
    chips.appendChild(btn);
  });
  box.appendChild(chips);
  parent_el.appendChild(box);
}

function has_links(sources) {
  return pick_sources(sources).length > 0;
}

function add_doc_chips(parent_el, titles, citations_map = {}) {
  const list = Array.isArray(titles)
    ? [...new Set(titles.map(t => String(typeof t === "string" ? t : (t?.title || t?.name || "")).trim()).filter(Boolean))].slice(0, 4)
    : [];
  if (!list.length) return;
  const cmap = citations_map && typeof citations_map === "object" ? citations_map : {};
  const box = document.createElement("div");
  box.className = "followup-box knowledge-ref-box";
  const label = document.createElement("small");
  label.innerHTML = `${ico("link", "ico-xs")}本次回答参考的校内文件（${list.length}）· 点击定位条款原文`;
  box.appendChild(label);
  const chips = document.createElement("div");
  chips.className = "followup-chips";
  list.forEach(title => {
    const arts = Array.isArray(cmap[title]) ? cmap[title] : [];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-ref-chip";
    btn.textContent = arts.length ? `${title} · ${arts[0]}` : title;
    btn.title = arts.length ? `查看制度原文并定位 ${arts.join("、")}` : "查看制度原文";
    btn.onclick = () => {
      if (typeof open_doc_reader === "function") open_doc_reader(title, arts);
    };
    chips.appendChild(btn);
  });
  box.appendChild(chips);
  parent_el.appendChild(box);
}

function add_ai_footer_meta(wrap_el, tools_el, opts = {}) {
  const { showConf, confidence, showSrc, sources, sources_label, answer_docs, doc_citations } = opts;
  const validLinks = showSrc ? pick_sources(sources) : [];
  const docTitles = showSrc && !validLinks.length && Array.isArray(answer_docs)
    ? [...new Set(answer_docs.map(t => String(typeof t === "string" ? t : (t?.title || t?.name || "")).trim()).filter(Boolean))].slice(0, 4)
    : [];
  const hasRef = validLinks.length > 0 || docTitles.length > 0;

  const confMap = {
    high: { text: "依据充分", cls: "high", tip: "已找到与问题对应的校内文件或官网页面" },
    medium: { text: "依据有限", cls: "medium", tip: "只找到部分相关材料，具体细节以主管部门最新通知为准" },
    low: { text: "未找到原文", cls: "low", tip: "校内文件库与官网均未检索到直接依据，以下为办理路径建议" }
  };
  let confInfo = showConf ? confMap[confidence] : null;
  if (confInfo && confInfo.cls === "high" && !hasRef && (!sources || !sources.length)) confInfo = null;
  if (!confInfo && !hasRef) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "ai-meta-toggle" + (confInfo ? (" is-" + confInfo.cls) : " is-ref");
  toggle.setAttribute("aria-expanded", "false");

  const refCountText = validLinks.length
    ? `${validLinks.length}条来源`
    : (docTitles.length ? `${docTitles.length}份文件` : "");
  const dotHtml = confInfo ? `<i class="ai-meta-dot" aria-hidden="true"></i>` : `${ico("link", "ico-xs")}`;
  const mainLabel = confInfo && refCountText
    ? `${confInfo.text} · ${refCountText}`
    : (confInfo ? confInfo.text : `参考依据 · ${refCountText}`);

  toggle.innerHTML = `${dotHtml}<span>${esc(mainLabel)}</span><span class="ai-meta-caret" aria-hidden="true">▾</span>`;
  toggle.title = confInfo ? confInfo.tip : "点击展开查看参考依据与原文";

  const drawer = document.createElement("div");
  drawer.className = "ai-ref-drawer hide";
  if (confInfo) {
    const tipEl = document.createElement("div");
    tipEl.className = "ai-confidence " + confInfo.cls;
    tipEl.innerHTML = `<i></i><span>${confInfo.text}</span><small>${confInfo.tip}</small>`;
    drawer.appendChild(tipEl);
  }
  if (validLinks.length) {
    add_sources(drawer, sources, sources_label);
  } else if (docTitles.length) {
    add_doc_chips(drawer, docTitles, doc_citations);
  }

  toggle.onclick = () => {
    const open = drawer.classList.toggle("hide");
    const isExpanded = !open;
    toggle.classList.toggle("is-open", isExpanded);
    toggle.setAttribute("aria-expanded", String(isExpanded));
  };

  if (tools_el) {
    tools_el.appendChild(toggle);
  } else {
    wrap_el.appendChild(toggle);
  }
  wrap_el.appendChild(drawer);
}

function add_tools(wrap_el, text_getter, retry_question = "", action_opts = {}) {
  const tools = document.createElement("div");
  tools.className = "bubble-tools";

  const copy_btn = document.createElement("button");
  copy_btn.type = "button";
  copy_btn.className = "bt-copy";
  copy_btn.innerHTML = `${ico("copy", "ico-xs")}<span class="t-full">复制回答</span><span class="t-short">复制</span>`;
  copy_btn.onclick = async () => {
    const raw = typeof text_getter === "function" ? text_getter() : text_getter;
    const text = String(raw || "")
      .replace(/<!--(?:AGENT_ACTIONS|SCHEDULE_ACTION|UI_META)[\s\S]*?(?:(?:AGENT_ACTIONS|SCHEDULE_ACTION|UI_META)-->|$)/g, "")
      .trim();
    const ok = await copy_text_safe(text);
    toast(ok ? "回答已复制到剪贴板" : "复制失败，请长按文字复制");
  };
  tools.appendChild(copy_btn);

  const answer_text = typeof text_getter === "function" ? text_getter() : text_getter;
  setTimeout(() => { if (typeof apply_ai_schedule_action === "function") apply_ai_schedule_action(answer_text, tools, action_opts); }, 0);
  const steps = pick_steps(answer_text);
  const todo_btn = document.createElement("button");
  todo_btn.type = "button";
  todo_btn.className = "todo-action-btn";
  if (steps.length) {
    todo_btn.innerHTML = `${ico("check-square", "ico-xs")}<span class="t-full">加入待办（${steps.length} 条）</span><span class="t-short">待办(${steps.length})</span>`;
    todo_btn.title = "先检查、编辑并选择要保存的事项，不会直接把整段回答拆成任务";
    todo_btn.onclick = () => review_todos(steps, retry_question);
  } else {
    todo_btn.classList.add("is-manual");
    todo_btn.innerHTML = `${ico("plus", "ico-xs")}<span class="t-full">自己加一条待办</span><span class="t-short">记待办</span>`;
    todo_btn.title = "这条回答里没有可直接执行的行动，可以自己写一条";
    todo_btn.onclick = () => review_todos([], retry_question);
  }
  tools.appendChild(todo_btn);

  if (retry_question) {
    const retry_btn = document.createElement("button");
    retry_btn.type = "button";
    retry_btn.className = "bt-retry";
    retry_btn.innerHTML = `${ico("refresh", "ico-xs")}<span class="t-full">重新生成</span><span class="t-short">重试</span>`;
    retry_btn.onclick = () => {
      $("question").value = retry_question;
      auto_resize_question();
      $("askForm").requestSubmit();
    };
    tools.appendChild(retry_btn);
  }

  wrap_el.appendChild(tools);
  return tools;
}

function create_msg_meta(who) {
  const meta = document.createElement("div");
  meta.className = "msg-meta";
  if (who === "user") {
    const user_char = me && me.display_name ? me.display_name.slice(0, 1) : "我";
    meta.innerHTML = `<span class="msg-avatar user">${esc(user_char)}</span><span class="msg-sender">我</span>`;
  } else {
    meta.innerHTML = `<span class="msg-avatar ai">${ico("ai-brand")}</span><span class="msg-sender">文理智办 AI</span>`;
  }
  return meta;
}

function create_message(s, who = "", sources = [], is_restoring = false, reasoning = "") {
  const raw_text = String(s ?? "").trim();
  const clean_text = who === "user" ? raw_text : clean_links(raw_text, sources);
  if (!clean_text) return;

  chat_history.push({
    role: who === "user" ? "学生" : "文理智办",
    content: clean_text,
    sources: sources || [],
    reasoning: reasoning || ""
  });
  if (!is_restoring) save_chat_to_local();

  const role_class = who === "user" ? "msg-user" : "msg-ai";
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap " + role_class;
  wrap.appendChild(create_msg_meta(who));

  const d = document.createElement("div");
  d.className = "bubble " + role_class;
  if (who === "user") {
    d.textContent = clean_text;
  } else {
    let html = "";
    if (reasoning && reasoning.trim()) {
      html += `<details class="ai-reasoning"><summary>${ico("bulb", "ico-xs")}已深度思考（点击查看推理过程）</summary><div class="ai-reasoning-body">${esc(reasoning.trim())}</div></details>`;
    }
    html += format_markdown_safe(clean_text);
    d.innerHTML = html;
  }
  wrap.appendChild(d);

  let tools_el = null;
  if (who !== "user") {
    tools_el = add_tools(wrap, () => clean_text);
  }

  if (sources && sources.length) {
    add_ai_footer_meta(wrap, tools_el, { showConf: false, showSrc: true, sources });
  }

  $("messages").appendChild(wrap);
  sync_scroll_btn(true);
  return wrap;
}

$("clearChat")?.addEventListener("click", () => {
  chat_history = [];
  try {
    localStorage.removeItem(chat_cache_key_for());
  } catch {}
  $("messages").innerHTML = welcome_html(true);
  sync_scroll_btn(false);
  toast("对话记录已清空");
});

$("exportChat")?.addEventListener("click", () => {
  if (!chat_history.length) return toast("当前暂无可导出的对话记录");
  const content = chat_history
    .map(m => {
      let s = `【${m.role}】\n${m.content}\n`;
      const src_list = pick_sources(m.sources);
      if (src_list.length) {
        s +=
          "\n引用来源（可核验）：\n" +
          src_list
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("咨询记录已导出");
});

let pending_ai_images = [];
let pending_ai_files = [];

function render_ask_attachments() {
  const box = $("askAttachPreview");
  if (!box) return;
  if (!pending_ai_images.length && !pending_ai_files.length) {
    box.classList.add("hide");
    box.innerHTML = "";
    sync_ask_idle();
    return;
  }
  box.classList.remove("hide");
  const imgsHtml = pending_ai_images.map((src, i) =>
    `<div class="ask-thumb-item"><img src="${src}" alt="预览图"><button type="button" class="ask-att-del" data-del-img="${i}" aria-label="移除">×</button></div>`
  ).join("");
  const filesHtml = pending_ai_files.map((f, i) =>
    `<div class="ask-file-chip"><svg class="ico ico-xs" aria-hidden="true"><use href="#i-file-text"/></svg><span>${esc(f.name)}</span><button type="button" class="ask-att-del" data-del-file="${i}" aria-label="移除">×</button></div>`
  ).join("");
  box.innerHTML = imgsHtml + filesHtml;
  box.querySelectorAll("[data-del-img]").forEach(btn => {
    btn.onclick = () => {
      pending_ai_images.splice(Number(btn.dataset.delImg), 1);
      render_ask_attachments();
    };
  });
  box.querySelectorAll("[data-del-file]").forEach(btn => {
    btn.onclick = () => {
      pending_ai_files.splice(Number(btn.dataset.delFile), 1);
      render_ask_attachments();
    };
  });
  sync_ask_idle();
}

function compress_image_file(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式不支持"));
      img.onload = () => {
        const maxSide = 2048;
        let w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.92));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handle_image_select(fileList) {
  const arr = [...(fileList || [])].filter(f => f && f.type.startsWith("image/"));
  if (!arr.length) return;
  for (const f of arr) {
    if (pending_ai_images.length >= 3) {
      toast("最多一次上传 3 张图片");
      break;
    }
    try {
      const dataUrl = await compress_image_file(f);
      pending_ai_images.push(dataUrl);
    } catch {
      toast("图片处理失败，请换一张试试");
    }
  }
  render_ask_attachments();
}

async function handle_text_file_select(fileList) {
  const arr = [...(fileList || [])];
  for (const f of arr) {
    if (pending_ai_files.length >= 2) {
      toast("最多一次附带 2 个文档");
      break;
    }
    const fname = (f.name || "").toLowerCase();
    const ftype = (f.type || "").toLowerCase();
    try {
      if (ftype.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(fname)) {
        await handle_image_select([f]);
        continue;
      }
      if (ftype === "application/pdf" || fname.endsWith(".pdf")) {
        toast(`正在解析 PDF：${f.name}…`);
        const res = await window.extract_pdf_for_schedule(f);
        if (res.text) {
          pending_ai_files.push({ name: f.name, text: res.text.slice(0, 24000) });
        } else if (res.image) {
          if (pending_ai_images.length < 3) pending_ai_images.push(res.image);
        }
        continue;
      }
      if (fname.endsWith(".xlsx") || fname.endsWith(".xls")) {
        toast(`正在解析表格：${f.name}…`);
        const res = await window.extract_xlsx_for_schedule(f);
        if (res.text) pending_ai_files.push({ name: f.name, text: res.text.slice(0, 24000) });
        continue;
      }
      if (fname.endsWith(".docx")) {
        toast(`正在解析 Word：${f.name}…`);
        const res = await window.extract_docx_for_ai(f);
        if (res.text) pending_ai_files.push({ name: f.name, text: res.text.slice(0, 24000) });
        continue;
      }
      const txt = await f.text();
      if (!txt || /[\x00-\x08\x0E-\x1F]/.test(txt.slice(0, 200))) {
        toast("暂不支持该二进制格式，请转为 PDF、Word、Excel 或截图");
        continue;
      }
      pending_ai_files.push({ name: f.name, text: txt.slice(0, 24000) });
    } catch (err) {
      toast(err?.message || `读取 ${f.name} 失败`);
    }
  }
  render_ask_attachments();
}

(function bind_ask_attach_and_voice() {
  const btn = $("askAttachBtn");
  const pop = $("askAttachPop");
  const closePop = () => {
    pop?.classList.remove("open");
    btn?.classList.remove("open");
  };
  btn?.addEventListener("click", e => {
    e.stopPropagation();
    const open = !pop?.classList.contains("open");
    pop?.classList.toggle("open", open);
    btn?.classList.toggle("open", open);
  });
  document.addEventListener("click", closePop);
  pop?.addEventListener("click", e => e.stopPropagation());

  $("askCamBtn")?.addEventListener("click", () => { closePop(); $("askCamInput")?.click(); });
  $("askImgBtn")?.addEventListener("click", () => { closePop(); $("askImgInput")?.click(); });
  $("askFileBtn")?.addEventListener("click", () => { closePop(); $("askFileInput")?.click(); });

  $("askCamInput")?.addEventListener("change", e => { handle_image_select(e.target.files); e.target.value = ""; });
  $("askImgInput")?.addEventListener("change", e => { handle_image_select(e.target.files); e.target.value = ""; });
  $("askFileInput")?.addEventListener("change", e => { handle_text_file_select(e.target.files); e.target.value = ""; });

})();

function sync_ask_idle() {
  const el = $("question");
  const b = $("askSubmitBtn");
  if (!el || !b) return;
  const hasContent = Boolean(el.value.trim()) || pending_ai_images.length > 0 || pending_ai_files.length > 0;
  if (ai_busy) {
    b.classList.remove("is-idle");
    return;
  }
  b.classList.toggle("is-idle", !hasContent);
  b.setAttribute("aria-label", "发送");
  b.title = "发送";
  b.innerHTML = ico("arrow-up");
}

function auto_resize_question() {
  const el = $("question");
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
  sync_ask_idle();
}

$("question")?.addEventListener("input", auto_resize_question);
sync_ask_idle();

function set_placeholder() {
  const el = $("question");
  if (!el) return;
  el.placeholder = "输入办事问题";
}
set_placeholder();
let ph_timer;
window.addEventListener("resize", () => {
  clearTimeout(ph_timer);
  ph_timer = setTimeout(set_placeholder, 150);
});

$("question")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 720) {
    e.preventDefault();
    $("askForm").requestSubmit();
  }
});

/* ---- 提问主流程 ---- */
function set_ask_busy(busy) {
  ai_busy = busy;
  const b = $("askSubmitBtn");
  if (!b) return;
  b.classList.toggle("is-stop", busy);
  b.setAttribute("aria-label", busy ? "停止生成" : "发送");
  b.title = busy ? "停止生成" : "发送";
  b.innerHTML = busy ? ico("stop") : ico("arrow-up");
  sync_ask_idle();
}

$("askSubmitBtn")?.addEventListener("click", e => {
  if (ai_busy) {
    e.preventDefault();
    if (typeof ai_abort_handler === "function") ai_abort_handler();
  }
});

$("askForm").onsubmit = async e => {
  e.preventDefault();
  if (ai_busy) return;
  let q = $("question").value.trim();
  const imgs = pending_ai_images.slice();
  const files = pending_ai_files.slice();
  if (!q && !imgs.length && !files.length) return;
  if (!q && imgs.length) q = "请帮我识别并解读这张图片的内容与办理要点。";
  if (!q && files.length) q = "请帮我梳理并解读所附文档的核心内容。";
  $("question").value = "";
  pending_ai_images = [];
  pending_ai_files = [];
  render_ask_attachments();
  auto_resize_question();

  $("aiOptionsBar")?.classList.remove("open");
  $("toggleAiConfig")?.classList.remove("added");

  const userMsgEl = create_message(q, "user");
  if (imgs.length && userMsgEl) {
    const bubble = userMsgEl.querySelector(".bubble");
    if (bubble) {
      const wrap = document.createElement("div");
      wrap.className = "msg-att-imgs";
      wrap.innerHTML = imgs.map(src => `<img src="${src}" alt="上传图片">`).join("");
      bubble.prepend(wrap);
    }
  }
  const filePrefix = files.length
    ? files.map(f => `【附带文档：${f.name}】\n${f.text}`).join("\n\n") + "\n\n"
    : "";
  const fullQuestion = filePrefix + q;

  const controller = new AbortController();
  let aborted = false;
  set_ask_busy(true);
  ai_abort_handler = () => {
    aborted = true;
    try { controller.abort(); } catch {}
  };

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai is-generating";
  wrap.appendChild(create_msg_meta("ai"));

  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  const want_thinking = $("aiThinking")?.checked !== false;
  bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("ai-brand", "ico-xs")}${want_thinking ? "正在开启深度思考并检索校规库" : "正在检索校规库并生成回答"}</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  scroll_to_message_anchor(userMsgEl);

  let full_answer = "";
  let full_reasoning = "";
  let sources = [];
  let sources_label = "";
  let confidence = "";
  let ui_policy = null;
  let agent_trace = null;
  let allow_write_actions = false;
  let allow_nav_actions = false;
  let follow_ups = [];
  let answer_docs = [];
  let doc_citations = {};
  let streamed_content = false;
  let delta_chunks = 0;
  let is_cached_hit = false;
  let retried = false;
  let finish_reason = "";
  let truncated_flag = false;
  let continued_times = 0;
  let cut_by_timeout = false;
  let soft_error = "";

  const paint_bubble = (is_streaming, custom_text) => {
    let html = "";
    const text_to_show = custom_text !== undefined ? custom_text : full_answer;
    if (agent_trace && Array.isArray(agent_trace.steps) && agent_trace.steps.length >= 2) {
      const stepsHtml = agent_trace.steps.map((st, idx) =>
        `<div class="ai-trace-step"><span class="ai-trace-num">${idx + 1}</span><div><b>${esc(st.label || "")}</b><small>${esc(st.detail || "")}</small></div></div>`
      ).join("");
      html += `<details class="ai-agent-trace"><summary><span class="ai-trace-spark" aria-hidden="true">✦</span><span>${esc(agent_trace.summary || "智办规划轨迹")}</span></summary><div class="ai-trace-list">${stepsHtml}</div></details>`;
    }
    if (full_reasoning.trim()) {
      const summary_label =
        !text_to_show.trim() && is_streaming
          ? `${ico("bulb", "ico-xs")}正在深度思考并核对学校条款（点击展开）…`
          : `${ico("bulb", "ico-xs")}已深度思考（点击查看推理过程）`;
      html += `<details class="ai-reasoning"><summary>${summary_label}</summary><div class="ai-reasoning-body">${esc(full_reasoning.trim())}</div></details>`;
    }
    const display_text = strip_meta_talk(text_to_show).trim();
    if (display_text) {
      html += format_markdown_safe(display_text);
    } else if (is_streaming) {
      html += `<div class="ai-thinking-status"><span>${ico("ai-brand", "ico-xs")}正在生成办事指引</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
    } else if (text_to_show.trim()) {
      html += format_markdown_safe(text_to_show.trim());
    }
    if (!html) {
      html = `<span class="muted">正在整理回答内容…</span>`;
    }
    bubble.innerHTML = html;
  };

  let paint_tick = 0;
  const render_streaming_bubble = (is_streaming = true) => {
    if (!is_streaming) {
      if (paint_tick) {
        cancelAnimationFrame(paint_tick);
        paint_tick = 0;
      }
      paint_bubble(false);
      return;
    }
    if (paint_tick) return;
    paint_tick = requestAnimationFrame(() => {
      paint_tick = 0;
      paint_bubble(true);
      sync_scroll_btn(true);
    });
  };

  const friendly_error = err => {
    const msg = String((err && err.message) || err || "未知错误");
    if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
      return "网络连接中断（请求未能到达服务器，或数据传输被中断）。请检查网络后重试；若反复出现，可尝试切换网络或暂时关闭“联网搜索”再试。";
    }
    return msg;
  };

  const run_ask = async (continue_from = "") => {
    const selSchool = typeof get_selected_school === "function" ? get_selected_school() : { n: "西安文理学院", d: "xawl.edu.cn" };
    const payload = {
      question: fullQuestion,
      ...(imgs.length ? { images: imgs } : {}),
      model: $("aiModel")?.value || "deepseek-flash",
      thinking: $("aiThinking")?.checked !== false,
      reasoning_effort: $("aiEffort")?.value || "high",
      web_search: true,
      school_name: selSchool.n,
      school_domain: selSchool.d || "", 
      ...(continue_from ? { continue_from: continue_from.slice(-4000) } : {}),
      history: chat_history.slice(-9, -1).map(m => ({
        role: m.role === "学生" ? "user" : "assistant",
        content: String(m.content).slice(0, 2000)
      }))
    };

    const res = await fetch(api_base + "/ai/ask", {
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
      const err_json = await res.json().catch(() => ({}));
      throw new Error(err_json.detail || "请求失败（HTTP " + res.status + "）");
    }

    const content_type = (res.headers.get("content-type") || "").toLowerCase();

    if (content_type.includes("application/json")) {
      const d = await res.json();
      const text = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
      const think = String(d.reasoning || d.choices?.[0]?.message?.reasoning_content || "").trim();
      full_answer = continue_from ? full_answer + text : text;
      full_reasoning = continue_from ? full_reasoning + think : think;
      sources = d.sources || sources;
      sources_label = d.sources_label || sources_label;
      if (full_answer) {
        render_streaming_bubble(false);
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let raw_fallback = "";
      let idle_ms = Number(window.XZ_AI_IDLE_MS) || 45000;

      const process_line = line => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) return;
        const data_str = trimmed.replace(/^data:\s*/, "").trim();
        if (data_str === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(data_str);
        } catch {
          return;
        }

        if (parsed.error) {
          soft_error = String(parsed.error);
          return;
        }

        if (parsed.type === "meta") {
          sources = parsed.sources || [];
          sources_label = parsed.sources_label || "";
          confidence = parsed.confidence || "";
          if (parsed.ui_policy && typeof parsed.ui_policy === "object") ui_policy = parsed.ui_policy;
          if (parsed.agent_trace && typeof parsed.agent_trace === "object") agent_trace = parsed.agent_trace;
          if (typeof parsed.allow_write_actions === "boolean") allow_write_actions = parsed.allow_write_actions;
          if (typeof parsed.allow_nav_actions === "boolean") allow_nav_actions = parsed.allow_nav_actions;
          if (parsed.cached === true) is_cached_hit = true;
          if (Array.isArray(parsed.followups)) follow_ups = parsed.followups;
          if (Array.isArray(parsed.knowledge_docs)) answer_docs = parsed.knowledge_docs;
          if (parsed.doc_citations && typeof parsed.doc_citations === "object") doc_citations = parsed.doc_citations;
          return;
        }

        if (parsed.type === "ui_meta") {
          if (parsed.ui_policy && typeof parsed.ui_policy === "object") {
            ui_policy = { ...(ui_policy || {}), ...parsed.ui_policy };
          }
          if (typeof parsed.allow_write_actions === "boolean") allow_write_actions = parsed.allow_write_actions;
          if (Array.isArray(parsed.followups)) follow_ups = parsed.followups;
          return;
        }

        if (parsed.type === "truncated") {
          truncated_flag = true;
          return;
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finish_reason = String(parsed.choices[0].finish_reason);
        }

        const delta_reason =
          parsed.choices?.[0]?.delta?.reasoning_content ??
          parsed.choices?.[0]?.delta?.reasoning ??
          parsed.choices?.[0]?.delta?.thinking ??
          parsed.choices?.[0]?.delta?.thinking_content ??
          parsed.reasoning ??
          "";
        let delta_content =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          parsed.answer ??
          "";

        if (delta_reason) {
          full_reasoning += delta_reason;
          render_streaming_bubble(true);
        }

        if (delta_content) {
          delta_chunks++;
          full_answer += delta_content;
          if (/<think>/i.test(full_answer)) {
            const closedRe = /<think>([\s\S]*?)<\/think>/gi;
            let matchedClosed = false;
            full_answer = full_answer.replace(closedRe, (_, inner) => {
              if (inner && inner.trim()) {
                full_reasoning += (full_reasoning ? "\n" : "") + inner.trim();
              }
              matchedClosed = true;
              return "";
            });
            const openIdx = full_answer.search(/<think>/i);
            if (openIdx !== -1) {
              const liveThink = full_answer.slice(openIdx + 7);
              const baseAns = full_answer.slice(0, openIdx);
              const liveReasonDisplay = full_reasoning + (liveThink.trim() ? (full_reasoning ? "\n" : "") + liveThink : "");
              if (liveReasonDisplay.trim()) {
                const prevR = full_reasoning;
                full_reasoning = liveReasonDisplay;
                paint_bubble(true, baseAns);
                full_reasoning = prevR;
                return;
              }
            } else if (matchedClosed) {
              render_streaming_bubble(true);
            }
          }
          if (full_answer.trim()) {
            streamed_content = true;
            if (!is_cached_hit) {
              render_streaming_bubble(true);
            }
          }
        }
      };

      const aborted_promise = new Promise((_, reject) => {
        const on_abort = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (controller.signal.aborted) on_abort();
        else controller.signal.addEventListener("abort", on_abort, { once: true });
      });
      aborted_promise.catch(() => {});

      while (true) {
        if (aborted) {
          try { await reader.cancel(); } catch {}
          break;
        }
        let idle_timer = null;
        const idle_promise = new Promise((_, reject) => {
          idle_timer = setTimeout(() => {
            const e = new Error("idle-timeout");
            e.name = "IdleTimeout";
            reject(e);
          }, idle_ms);
        });
        let chunk;
        try {
          chunk = await Promise.race([reader.read(), aborted_promise, idle_promise]);
        } catch (read_err) {
          try { await reader.cancel(); } catch {}
          if (read_err && read_err.name === "IdleTimeout") {
            cut_by_timeout = true;
            break;
          }
          throw read_err;
        } finally {
          clearTimeout(idle_timer);
        }
        const { done, value } = chunk;
        if (done) break;
        idle_ms = Number(window.XZ_AI_IDLE_MS) || 22000;
        const chunk_text = decoder.decode(value, { stream: true });
        raw_fallback += chunk_text;
        buffer += chunk_text;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          process_line(line);
        }
      }
      if (aborted) {
        const stop_err = new Error("aborted");
        stop_err.name = "AbortError";
        throw stop_err;
      }
      if (buffer.trim()) {
        process_line(buffer);
      }

      if (!full_answer.trim() && raw_fallback.trim().startsWith("{")) {
        try {
          const d = JSON.parse(raw_fallback.trim());
          const fbReason = d.reasoning || d.choices?.[0]?.message?.reasoning_content || d.choices?.[0]?.message?.reasoning || "";
          if (fbReason && !full_reasoning.trim()) full_reasoning = String(fbReason).trim();
          full_answer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
          sources = d.sources || sources;
          if (full_answer) render_streaming_bubble(false);
        } catch {}
      }
    }

    if (soft_error && !full_answer.trim()) throw new Error(soft_error);
    full_answer = clean_links(full_answer.trim(), sources);
  };

  const finalize = () => {
    if (!full_answer) {
      full_answer = "模型未返回有效内容，请尝试取消勾选“深度思考”或重新发送问题。";
      bubble.innerHTML = `<span class="muted">${esc(full_answer)}</span>`;
      const box = document.createElement("div");
      box.className = "bubble-tools";
      const again = document.createElement("button");
      again.type = "button";
      again.innerHTML = `${ico("refresh", "ico-xs")}重新生成`;
      again.onclick = () => {
        wrap.remove();
        $("question").value = q;
        $("askForm").requestSubmit();
      };
      box.appendChild(again);
      wrap.appendChild(box);
      return;
    }
    const uiMetaMatch = full_answer.match(/<!--UI_META\s*([\s\S]*?)\s*UI_META-->/);
    if (uiMetaMatch) {
      try {
        const parsedUi = JSON.parse(uiMetaMatch[1].trim());
        if (parsedUi && typeof parsedUi === "object") {
          ui_policy = {
            ...(ui_policy || {}),
            ...(typeof parsedUi.show_confidence === "boolean" ? { show_confidence: parsedUi.show_confidence } : {}),
            ...(typeof parsedUi.show_sources === "boolean" ? { show_sources: parsedUi.show_sources } : {}),
            ...(Array.isArray(parsedUi.followups) ? { show_followups: parsedUi.followups.length > 0 } : {})
          };
          if (Array.isArray(parsedUi.followups)) {
            follow_ups = parsedUi.followups.map(s => String(s || "").trim()).filter(Boolean).slice(0, 3);
          }
        }
      } catch {}
    }
    const clean_saved_answer = full_answer
      .replace(/<!--UI_META[\s\S]*?(?:UI_META-->|$)/g, "")
      .trim();
    const showConf = ui_policy ? ui_policy.show_confidence === true : Boolean(confidence);
    const showSrc = ui_policy ? ui_policy.show_sources === true : (has_links(sources) || (answer_docs && answer_docs.length > 0));
    const showFu = ui_policy ? (ui_policy.show_followups !== false && follow_ups.length > 0) : follow_ups.length > 0;

    render_streaming_bubble(false);
    chat_history.push({
      role: "文理智办",
      content: clean_saved_answer,
      sources: showSrc ? (sources || []) : [],
      reasoning: full_reasoning.trim()
    });
    save_chat_to_local();
    const tools_el = add_tools(wrap, () => clean_saved_answer, q, { allowWrite: allow_write_actions, allowNav: allow_nav_actions });
    add_ai_footer_meta(wrap, tools_el, {
      showConf,
      confidence,
      showSrc,
      sources,
      sources_label,
      answer_docs,
      doc_citations
    });
    if (showFu) add_follow_ups(wrap, follow_ups);
    if (soft_error) {
      const note = document.createElement("div");
      note.className = "stopped-note";
      note.innerHTML = `${ico("alert", "ico-xs")}生成过程被中断，以上为已收到的内容`;
      bubble.appendChild(note);
    }
    sync_scroll_btn(true);
  };

  const ask_with_continuation = async () => {
    let continuing_note = null;
    await run_ask("");
    for (let i = 0; i < 2; i++) {
      if (aborted) break;
      const need_continue =
        !cut_by_timeout && (
          finish_reason === "length" ||
          truncated_flag ||
          (!finish_reason && full_answer.trim().length > 0 && !looks_done(full_answer))
        );
      if (!need_continue) break;
      if (!full_answer.trim()) break;
      const length_before = full_answer.length;
      finish_reason = "";
      truncated_flag = false;
      continued_times++;
      if (!continuing_note) {
        continuing_note = document.createElement("div");
        continuing_note.className = "ai-continuing-note";
        continuing_note.textContent = "内容较长，正在接着写完…";
        bubble.appendChild(continuing_note);
      }
      await run_ask(full_answer);
      if (full_answer.length <= length_before + 5) break;
    }
    continuing_note?.remove();
    if (!aborted && full_answer.length > 40 && (is_cached_hit || delta_chunks <= 2)) {
      const total_len = full_answer.length;
      const step = Math.max(14, Math.min(36, Math.ceil(total_len / 28)));
      let pos = 0;
      await new Promise(resolve => {
        const tick = () => {
          if (aborted) return resolve();
          pos = Math.min(total_len, pos + step);
          paint_bubble(pos < total_len, full_answer.slice(0, pos));
          sync_scroll_btn(true);
          if (pos >= total_len) return resolve();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }
  };

  const handle_stopped = () => {
    if (paint_tick) {
      cancelAnimationFrame(paint_tick);
      paint_tick = 0;
    }
    const partial = clean_links(full_answer.trim(), sources);
    if (!partial) {
      bubble.innerHTML = `<span class="muted">已停止生成</span>`;
      return;
    }
    full_answer = partial;
    render_streaming_bubble(false);
    const stop_note = document.createElement("div");
    stop_note.className = "stopped-note";
    stop_note.innerHTML = `${ico("stop", "ico-xs")}已停止生成，以上为已输出的部分内容`;
    bubble.appendChild(stop_note);
    chat_history.push({
      role: "文理智办",
      content: full_answer + "\n\n（此回答由用户中途停止生成）",
      sources: sources || [],
      reasoning: full_reasoning.trim()
    });
    save_chat_to_local();
    const showConf = ui_policy ? ui_policy.show_confidence === true : false;
    const showSrc = ui_policy ? ui_policy.show_sources === true : false;
    const showFu = ui_policy ? (ui_policy.show_followups === true && follow_ups.length > 0) : false;
    const tools_el = add_tools(wrap, () => full_answer, q);
    add_ai_footer_meta(wrap, tools_el, {
      showConf,
      confidence,
      showSrc,
      sources,
      sources_label,
      answer_docs,
      doc_citations
    });
    if (showFu) add_follow_ups(wrap, follow_ups);
    toast("已停止生成，保留已输出内容");
  };

  try {
    await ask_with_continuation();
    if (aborted) {
      handle_stopped();
    } else if (cut_by_timeout && !full_answer.trim()) {
      bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}服务器长时间没有返回内容，请稍后重试。</span>`;
    } else {
      finalize();
      if (cut_by_timeout && full_answer.trim()) {
        const cut_note = document.createElement("div");
        cut_note.className = "stopped-note";
        cut_note.innerHTML = `${ico("clock", "ico-xs")}网络响应超时，以上为已收到的内容`;
        bubble.appendChild(cut_note);
        toast("网络较慢，已保留已生成的内容");
      }
    }
  } catch (err) {
    const is_abort = err && (err.name === "AbortError" || /aborted|abort/i.test(String(err.message || "")));
    const is_network_err =
      err instanceof TypeError ||
      /failed to fetch|networkerror|load failed/i.test(String(err.message || ""));
    if (is_abort || aborted) {
      handle_stopped();
    } else if (is_network_err && !streamed_content && !retried) {
      retried = true;
      full_reasoning = "";
      full_answer = "";
      sources = [];
      finish_reason = "";
      truncated_flag = false;
      bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("refresh", "ico-xs")}网络波动，正在自动重试</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
      try {
        await ask_with_continuation();
        if (aborted) handle_stopped();
        else finalize();
      } catch (err2) {
        bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}请求出错：${esc(friendly_error(err2))}</span>`;
      }
    } else {
      bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}请求出错：${esc(friendly_error(err))}</span>`;
    }
  } finally {
    wrap.classList.remove("is-generating");
    ai_abort_handler = null;
    set_ask_busy(false);
    sync_scroll_btn(true);
  }
};

$("aiThinking")?.addEventListener("change", () => {
  const effort = $("aiEffort");
  if (effort) effort.disabled = !$("aiThinking").checked;
});

(async () => {
  if (!token) {
    try { token = localStorage.getItem("xz_token") || ""; } catch {}
  }
  if (token) {
    await enter(true);
    return;
  }
  set_boot_progress(45, "正在检查服务状态并加载界面…", false);
  await Promise.allSettled([
    Promise.race([check_ai(), new Promise(r => setTimeout(r, 4000))]),
    wait_assets_ready()
  ]);
  set_boot_progress(100, "准备就绪", false);
  await finish_boot_gate(true);
})();

async function load_users() {
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
              u.id === me?.id
                ? '<span class="muted">当前账号</span>'
                : `<button class="danger" data-delete-user="${u.id}">删除用户</button>`
            }
          </div>`
        )
        .join("") || '<p class="muted">暂无用户。</p>';

    if (typeof enhance_selects === "function") enhance_selects($("userList"));
    document.querySelectorAll("[data-role]").forEach(sel => {
      sel.onchange = async () => {
        try {
          await api("/users/" + sel.dataset.role, {
            method: "PATCH",
            body: JSON.stringify({ role: sel.value })
          });
          toast("角色已更新");
          load_users();
        } catch (e) {
          toast(e.message);
          load_users();
        }
      };
    });

    document.querySelectorAll("[data-reset-pwd]").forEach(b => {
      b.onclick = async () => {
        const id = Number(b.dataset.resetPwd);
        const name = b.dataset.uname || "该用户";
        const new_pwd = await ui_prompt(`请输入用户“${name}”的新密码（至少 8 位）：`, { title: "重置用户密码", placeholder: "输入至少 8 位新密码", type: "password", minLength: 8 });
        if (!new_pwd) return;
        if (new_pwd.length < 8) return toast("密码长度至少需要 8 位");
        try {
          await api("/users/" + id, {
            method: "PATCH",
            body: JSON.stringify({ reset_password: new_pwd })
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
        if (!(await ui_confirm(`确定删除用户“${name}”吗？该用户的待办也会删除，此操作不可撤销。`, { title: "删除用户", danger: true })))
          return;
        b.disabled = true;
        try {
          const d = await api("/users/" + id, { method: "DELETE" });
          toast(d.message || "用户删除成功");
          await load_users();
          await load_stats();
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

async function load_stats() {
  try {
    const s = (await api("/stats")) || {};
    apply_kb_count(s.knowledge_files, s.knowledge_chunks);

    const is_num = v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
    const shown = (v, fallback = "—") => (is_num(v) ? String(Number(v)) : fallback);
    const num = (v, d = 0) => (is_num(v) ? Number(v) : d);

    const knowledge_files = num(s.knowledge_files, kb_total);
    const knowledge_chunks = num(s.knowledge_chunks);
    const student_count = num(s.student_count);
    const user_count = num(s.user_count, student_count);
    const task_count = num(s.task_count, num(s.pending_count) + num(s.completed_count));
    const pending_count = num(s.pending_count);
    const done_count = num(s.completed_count);
    const rate = is_num(s.completion_rate)
      ? Math.max(0, Math.min(100, Math.round(Number(s.completion_rate))))
      : task_count
      ? Math.round((done_count / task_count) * 100)
      : 0;
    const has_rate = is_num(s.completion_rate) || task_count > 0;

    $("aNotices").textContent = shown(s.notice_count);
    $("aStudents").textContent = shown(s.student_count);
    $("aCompletion").textContent = has_rate ? `${rate}%` : "—";

    const pct_of = n => (task_count ? Math.round((n / task_count) * 1000) / 10 : 0);

    $("statsDetails").innerHTML = `
      <div class="stat-dash">
        <div class="stat-ring-box">
          <div class="stat-ring">
            <svg viewBox="0 0 44 44" role="img" aria-label="任务完成率 ${has_rate ? rate + "%" : "暂无数据"}">
              <circle class="ring-track" cx="22" cy="22" r="18"/>
              ${has_rate ? `<circle class="ring-fill" cx="22" cy="22" r="18" pathLength="100" style="stroke-dasharray:${rate} 100"/>` : ""}
            </svg>
            <div class="ring-label"><b>${has_rate ? rate + "%" : "—"}</b><small>任务完成率</small></div>
          </div>
          <p class="stat-ring-note">已完成 ${done_count} 项 · 待处理 ${pending_count} 项</p>
        </div>

        <div class="stat-metrics">
          <div class="stat-metric">
            <span>账号总数</span>
            <b>${shown(s.user_count, String(user_count))}</b>
            <small>含学生 ${shown(s.student_count, String(student_count))} 人</small>
          </div>
          <div class="stat-metric">
            <span>任务总数</span>
            <b>${shown(s.task_count, String(task_count))}</b>
            <small>待处理 ${shown(s.pending_count, String(pending_count))} · 已完成 ${shown(s.completed_count, String(done_count))}</small>
          </div>
          <div class="stat-metric">
            <span>内置校规制度库</span>
            <b>${knowledge_files || "—"}</b>
            <small>${knowledge_chunks ? knowledge_chunks + " 个检索知识切片" : "官方文件与附件"}</small>
          </div>
        </div>
      </div>

      <div class="stat-bars">
        <div class="stat-bar-head"><span>任务构成</span><small>共 ${task_count} 项</small></div>
        <div class="stat-bar">
          <i class="bar-done" style="width:${pct_of(done_count)}%"></i>
          <i class="bar-open" style="width:${pct_of(pending_count)}%"></i>
        </div>
        <div class="stat-bar-legend">
          <span><i class="dot done"></i>已完成 ${done_count}</span>
          <span><i class="dot open"></i>待处理 ${pending_count}</span>
        </div>
      </div>`;
  } catch (e) {
    toast(e.message);
  }
}

$("userSearch")?.addEventListener("input", () => load_users());
$("reloadUsers")?.addEventListener("click", load_users);
$("reloadStats")?.addEventListener("click", load_stats);
/* ---- 列表按钮统一委托 ---- */
const LIST_ACTION_SEL = [
  "[data-star-notice]", "[data-add]", "[data-copy-notice]", "[data-ai-notice]",
  "[data-edit-notice]", "[data-delete-notice]",
  "[data-read-doc]", "[data-ask-doc]",
  "[data-edit-task]", "[data-del-task]"
].join(",");

const notice_by_id = id => notices.find(n => String(n.id) === String(id));
const task_by_id = id => tasks.find(t => String(t.id) === String(id));

document.addEventListener("click", async e => {
  const target = e.target;
  const el = target && target.closest ? target.closest(LIST_ACTION_SEL) : null;
  if (!el) return;
  const d = el.dataset;

  if (d.starNotice !== undefined) {
    const id = Number(d.starNotice);
    if (starred_notice_ids.has(id)) {
      starred_notice_ids.delete(id);
      toast("已取消收藏");
    } else {
      starred_notice_ids.add(id);
      toast("已收藏并置顶该通知");
    }
    save_starred_notices();
    render_notices();
    return;
  }

  if (d.add !== undefined) {
    if (el.disabled) return;
    el.disabled = true;
    try {
      const res = await api("/tasks/from-notice/" + d.add, { method: "POST" });
      toast(res.message);
      tasks = await api("/tasks");
      render_tasks();
      render_home();
      render_notices();
    } catch (err) {
      toast(err.message);
      el.disabled = false;
    }
    return;
  }

  if (d.copyNotice !== undefined) {
    const n = notice_by_id(d.copyNotice);
    if (!n) return;
    const text = `【${n.category}】${n.title}\n${n.body}\n适用对象：${n.audience}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
    const ok = await copy_text_safe(text);
    toast(ok ? "通知内容已复制到剪贴板" : "复制失败，请手动长按复制");
    return;
  }

  if (d.aiNotice !== undefined) {
    const n = notice_by_id(d.aiNotice);
    if (!n) return;
    go("ai");
    $("question").value = `请帮我解读以下校园通知，并梳理出【所需材料】、【分步办理流程】和【重要时间节点】：\n标题：《${n.title}》\n内容：${n.body}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
    auto_resize_question();
    $("askForm").requestSubmit();
    return;
  }

  if (d.editNotice !== undefined) {
    const n = notice_by_id(d.editNotice);
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
    return;
  }

  if (d.deleteNotice !== undefined) {
    if (me?.role !== "admin") return toast("仅管理员可以删除通知");
    if (!(await ui_confirm("确定删除这条通知吗？相关待办也会一并删除，此操作不可撤销。", { title: "删除通知", danger: true }))) return;
    el.disabled = true;
    try {
      const res = await api("/notices/" + d.deleteNotice, { method: "DELETE" });
      toast(res.message || "通知删除成功");
      await refresh();
    } catch (err) {
      toast(err.message);
      el.disabled = false;
    }
    return;
  }

  if (d.readDoc !== undefined) {
    open_doc_reader(d.readDoc);
    return;
  }

  if (d.askDoc !== undefined) {
    const title = d.askDoc;
    go("ai");
    $("question").value = `请根据《${title}》为我梳理该制度的核心适用对象、关键规定、所需材料表单以及红线注意事项。`;
    auto_resize_question();
    $("askForm").requestSubmit();
    return;
  }

  if (d.editTask !== undefined) {
    const t = task_by_id(d.editTask);
    if (!t) return;
    $("editTaskId").value = String(t.id);
    $("editTaskTitle").value = t.title;
    $("editTaskDue").value = t.due_date || "";
    $("editTaskDialog").showModal();
    $("editTaskTitle").focus();
    return;
  }

  if (d.delTask !== undefined) {
    const t = task_by_id(d.delTask);
    if (!(await ui_confirm(`确定删除待办“${t?.title || "此事项"}”吗？`, { title: "删除待办", danger: true }))) return;
    try {
      await api("/tasks/" + d.delTask, { method: "DELETE" });
      tasks = await api("/tasks");
      render_tasks();
      render_home();
      render_notices();
      toast("待办已删除");
    } catch (err) {
      toast(err.message);
    }
  }
});

document.addEventListener("change", async e => {
  const target = e.target;
  const c = target && target.closest ? target.closest("[data-task]") : null;
  if (!c) return;
  try {
    await api("/tasks/" + c.dataset.task, {
      method: "PATCH",
      body: JSON.stringify({ status: c.checked ? "completed" : "pending" })
    });
    tasks = await api("/tasks");
    render_tasks();
    render_home();
    render_notices();
  } catch (err) {
    toast(err.message);
    render_tasks();
  }
});

/* ---- 全国本科高校选择弹窗逻辑 ---- */
const PRESET_SCHOOLS = [{"n":"西安文理学院","d":"xawl.edu.cn","p":"陕西·西安","a":"西文理 xawl xwly"},{"n":"北京大学","d":"pku.edu.cn","p":"北京","a":"北大 pku"},{"n":"中国人民大学","d":"ruc.edu.cn","p":"北京","a":"人大 ruc"},{"n":"清华大学","d":"tsinghua.edu.cn","p":"北京","a":"清华 thu"},{"n":"北京交通大学","d":"bjtu.edu.cn","p":"北京","a":"北交 bjtu"},{"n":"北京工业大学","d":"bjut.edu.cn","p":"北京","a":"北工大 bjut"},{"n":"北京航空航天大学","d":"buaa.edu.cn","p":"北京","a":"北航 buaa"},{"n":"北京理工大学","d":"bit.edu.cn","p":"北京","a":"北理 bit"},{"n":"北京科技大学","d":"ustb.edu.cn","p":"北京","a":"北科 ustb"},{"n":"北方工业大学","d":"ncut.edu.cn","p":"北京","a":""},{"n":"北京化工大学","d":"buct.edu.cn","p":"北京","a":"北化 buct"},{"n":"北京工商大学","d":"btbu.edu.cn","p":"北京","a":""},{"n":"北京服装学院","d":"bift.edu.cn","p":"北京","a":""},{"n":"北京邮电大学","d":"bupt.edu.cn","p":"北京","a":"北邮 bupt"},{"n":"北京印刷学院","d":"bigc.edu.cn","p":"北京","a":""},{"n":"北京建筑大学","d":"bucea.edu.cn","p":"北京","a":""},{"n":"北京石油化工学院","d":"bipt.edu.cn","p":"北京","a":""},{"n":"北京电子科技学院","d":"","p":"北京","a":""},{"n":"中国农业大学","d":"cau.edu.cn","p":"北京","a":"农大 cau"},{"n":"北京农学院","d":"","p":"北京","a":""},{"n":"北京林业大学","d":"bjfu.edu.cn","p":"北京","a":""},{"n":"北京协和医学院","d":"","p":"北京","a":""},{"n":"首都医科大学","d":"ccmu.edu.cn","p":"北京","a":""},{"n":"北京中医药大学","d":"bucm.edu.cn","p":"北京","a":""},{"n":"北京师范大学","d":"bnu.edu.cn","p":"北京","a":"北师大 bnu"},{"n":"首都师范大学","d":"cnu.edu.cn","p":"北京","a":"首师大 cnu"},{"n":"首都体育学院","d":"","p":"北京","a":""},{"n":"北京外国语大学","d":"bfsu.edu.cn","p":"北京","a":"北外 bfsu"},{"n":"北京第二外国语学院","d":"","p":"北京","a":""},{"n":"北京语言大学","d":"blcu.edu.cn","p":"北京","a":""},{"n":"中国传媒大学","d":"cuc.edu.cn","p":"北京","a":"中传 cuc"},{"n":"中央财经大学","d":"cufe.edu.cn","p":"北京","a":"央财 cufe"},{"n":"对外经济贸易大学","d":"uibe.edu.cn","p":"北京","a":"贸大 uibe"},{"n":"北京物资学院","d":"","p":"北京","a":""},{"n":"首都经济贸易大学","d":"","p":"北京","a":""},{"n":"中国消防救援学院","d":"","p":"北京","a":""},{"n":"外交学院","d":"","p":"北京","a":""},{"n":"中国人民公安大学","d":"","p":"北京","a":""},{"n":"国际关系学院","d":"","p":"北京","a":""},{"n":"北京体育大学","d":"bsu.edu.cn","p":"北京","a":""},{"n":"中央音乐学院","d":"","p":"北京","a":""},{"n":"中国音乐学院","d":"","p":"北京","a":""},{"n":"中央美术学院","d":"","p":"北京","a":""},{"n":"中央戏剧学院","d":"","p":"北京","a":""},{"n":"中国戏曲学院","d":"","p":"北京","a":""},{"n":"北京电影学院","d":"bfa.edu.cn","p":"北京","a":""},{"n":"北京舞蹈学院","d":"","p":"北京","a":""},{"n":"中央民族大学","d":"muc.edu.cn","p":"北京","a":"民大 muc"},{"n":"中国政法大学","d":"cupl.edu.cn","p":"北京","a":"法大 cupl"},{"n":"华北电力大学","d":"ncepu.edu.cn","p":"北京","a":"华电 ncepu"},{"n":"中华女子学院","d":"","p":"北京","a":""},{"n":"北京信息科技大学","d":"bistu.edu.cn","p":"北京","a":""},{"n":"中国矿业大学（北京）","d":"","p":"北京","a":""},{"n":"中国石油大学（北京）","d":"","p":"北京","a":""},{"n":"中国地质大学（北京）","d":"","p":"北京","a":""},{"n":"北京联合大学","d":"buu.edu.cn","p":"北京","a":""},{"n":"中国青年政治学院","d":"","p":"北京","a":""},{"n":"首钢工学院","d":"","p":"北京","a":""},{"n":"中国劳动关系学院","d":"","p":"北京","a":""},{"n":"北京警察学院","d":"","p":"北京","a":""},{"n":"中国科学院大学","d":"ucas.ac.cn","p":"北京","a":""},{"n":"中国社会科学院大学","d":"ucass.edu.cn","p":"北京","a":""},{"n":"北京科技职业大学","d":"","p":"北京","a":""},{"n":"民政职业大学","d":"","p":"北京","a":""},{"n":"南开大学","d":"nankai.edu.cn","p":"天津","a":"南开 nku"},{"n":"天津大学","d":"tju.edu.cn","p":"天津","a":"天大 tju"},{"n":"天津科技大学","d":"tust.edu.cn","p":"天津","a":""},{"n":"天津工业大学","d":"tiangong.edu.cn","p":"天津","a":"天工 tiangong"},{"n":"中国民航大学","d":"cauc.edu.cn","p":"天津","a":""},{"n":"天津理工大学","d":"tjut.edu.cn","p":"天津","a":""},{"n":"天津农学院","d":"","p":"天津","a":""},{"n":"天津医科大学","d":"tmu.edu.cn","p":"天津","a":"天医 tmu"},{"n":"天津中医药大学","d":"","p":"天津","a":""},{"n":"天津师范大学","d":"tjnu.edu.cn","p":"天津","a":"天师大 tjnu"},{"n":"天津职业技术师范大学","d":"","p":"天津","a":""},{"n":"天津外国语大学","d":"","p":"天津","a":""},{"n":"天津商业大学","d":"","p":"天津","a":""},{"n":"天津财经大学","d":"","p":"天津","a":""},{"n":"天津体育学院","d":"","p":"天津","a":""},{"n":"天津音乐学院","d":"","p":"天津","a":""},{"n":"天津美术学院","d":"","p":"天津","a":""},{"n":"天津城建大学","d":"","p":"天津","a":""},{"n":"天津中德应用技术大学","d":"","p":"天津","a":""},{"n":"天津职业大学","d":"","p":"天津","a":""},{"n":"天津警察学院","d":"","p":"天津","a":""},{"n":"河北大学","d":"hbu.edu.cn","p":"河北·保定","a":"河大 hbu"},{"n":"河北工程大学","d":"","p":"河北·邯郸","a":""},{"n":"河北地质大学","d":"","p":"河北·石家庄","a":""},{"n":"河北工业大学","d":"hebut.edu.cn","p":"天津","a":"河工大 hebut"},{"n":"华北理工大学","d":"ncst.edu.cn","p":"河北·唐山","a":""},{"n":"河北科技大学","d":"","p":"河北·石家庄","a":""},{"n":"河北建筑工程学院","d":"","p":"河北·张家口","a":""},{"n":"河北水利电力学院","d":"","p":"河北·沧州","a":""},{"n":"河北农业大学","d":"","p":"河北·保定","a":""},{"n":"河北医科大学","d":"","p":"河北·石家庄","a":""},{"n":"河北北方学院","d":"","p":"河北·张家口","a":""},{"n":"承德医学院","d":"","p":"河北·承德","a":""},{"n":"河北师范大学","d":"hebtu.edu.cn","p":"河北·石家庄","a":"河师大 hebtu"},{"n":"保定学院","d":"","p":"河北·保定","a":""},{"n":"河北民族师范学院","d":"","p":"河北·承德","a":""},{"n":"唐山师范学院","d":"","p":"河北·唐山","a":""},{"n":"廊坊师范学院","d":"","p":"河北·廊坊","a":""},{"n":"衡水学院","d":"","p":"河北·衡水","a":""},{"n":"石家庄学院","d":"","p":"河北·石家庄","a":""},{"n":"邯郸学院","d":"","p":"河北·邯郸","a":""},{"n":"邢台学院","d":"","p":"河北·邢台","a":""},{"n":"沧州师范学院","d":"","p":"河北·沧州","a":""},{"n":"石家庄铁道大学","d":"stdu.edu.cn","p":"河北·石家庄","a":""},{"n":"燕山大学","d":"ysu.edu.cn","p":"河北·秦皇岛","a":"燕大 ysu"},{"n":"河北科技师范学院","d":"","p":"河北·秦皇岛","a":""},{"n":"唐山学院","d":"","p":"河北·唐山","a":""},{"n":"应急管理大学","d":"","p":"河北·廊坊","a":""},{"n":"中国人民警察大学","d":"","p":"河北·廊坊","a":""},{"n":"河北体育学院","d":"","p":"河北·石家庄","a":""},{"n":"河北金融学院","d":"","p":"河北·保定","a":""},{"n":"北华航天工业学院","d":"","p":"河北·廊坊","a":""},{"n":"河北经贸大学","d":"","p":"河北·石家庄","a":""},{"n":"中央司法警官学院","d":"","p":"河北·保定","a":""},{"n":"河北工业职业技术大学","d":"","p":"河北·石家庄","a":""},{"n":"河北科技工程职业技术大学","d":"","p":"河北·邢台","a":""},{"n":"河北石油职业技术大学","d":"","p":"河北·承德","a":""},{"n":"河北中医药大学","d":"","p":"河北·石家庄","a":""},{"n":"张家口学院","d":"","p":"河北·张家口","a":""},{"n":"河北环境工程学院","d":"","p":"河北·秦皇岛","a":""},{"n":"唐山工业职业技术大学","d":"","p":"河北·唐山","a":""},{"n":"邢台医学院","d":"","p":"河北·邢台","a":""},{"n":"山西大学","d":"sxu.edu.cn","p":"山西·太原","a":"山大 sxu"},{"n":"太原科技大学","d":"","p":"山西·太原","a":""},{"n":"中北大学","d":"nuc.edu.cn","p":"山西·太原","a":"中北 nuc"},{"n":"太原理工大学","d":"tyut.edu.cn","p":"山西·太原","a":"太理 tyut"},{"n":"山西农业大学","d":"","p":"山西·晋中","a":""},{"n":"山西医科大学","d":"sxmu.edu.cn","p":"山西·太原","a":""},{"n":"长治医学院","d":"","p":"山西·长治","a":""},{"n":"山西师范大学","d":"","p":"山西·太原","a":""},{"n":"太原师范学院","d":"","p":"山西·太原","a":""},{"n":"山西大同大学","d":"","p":"山西·大同","a":""},{"n":"晋中学院","d":"","p":"山西·晋中","a":""},{"n":"长治学院","d":"","p":"山西·长治","a":""},{"n":"运城学院","d":"","p":"山西·运城","a":""},{"n":"忻州师范学院","d":"","p":"山西·忻州","a":""},{"n":"山西财经大学","d":"sxufe.edu.cn","p":"山西·太原","a":""},{"n":"山西中医药大学","d":"","p":"山西·太原","a":""},{"n":"吕梁学院","d":"","p":"山西·吕梁","a":""},{"n":"太原学院","d":"","p":"山西·太原","a":""},{"n":"山西警察学院","d":"","p":"山西·太原","a":""},{"n":"山西工程科技职业大学","d":"","p":"山西·太原","a":""},{"n":"山西工学院","d":"","p":"山西·朔州","a":""},{"n":"山西电子科技学院","d":"","p":"山西·临汾","a":""},{"n":"山西科技学院","d":"","p":"山西·晋城","a":""},{"n":"太原工业学院","d":"","p":"山西·太原","a":""},{"n":"山西传媒学院","d":"","p":"山西·太原","a":""},{"n":"山西工程技术学院","d":"","p":"山西·阳泉","a":""},{"n":"山西能源学院","d":"","p":"山西·晋中","a":""},{"n":"山西文化旅游职业大学","d":"","p":"山西·太原","a":""},{"n":"内蒙古大学","d":"imu.edu.cn","p":"内蒙古·呼和浩特","a":"内大 imu"},{"n":"内蒙古科技大学","d":"","p":"内蒙古·包头","a":""},{"n":"内蒙古工业大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古农业大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古医科大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古师范大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古民族大学","d":"","p":"内蒙古·通辽","a":""},{"n":"赤峰大学","d":"","p":"内蒙古·赤峰","a":""},{"n":"内蒙古财经大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"呼伦贝尔学院","d":"","p":"内蒙古·呼伦贝尔","a":""},{"n":"集宁师范学院","d":"","p":"内蒙古·乌兰察布","a":""},{"n":"河套学院","d":"","p":"内蒙古·巴彦淖尔","a":""},{"n":"呼和浩特民族学院","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古艺术学院","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"鄂尔多斯应用技术学院","d":"","p":"内蒙古·鄂尔多斯","a":""},{"n":"内蒙古建筑职业技术大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"兴安职业技术大学","d":"","p":"内蒙古·兴安","a":""},{"n":"呼和浩特职业技术大学","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"内蒙古警察学院","d":"","p":"内蒙古·呼和浩特","a":""},{"n":"辽宁大学","d":"lnu.edu.cn","p":"辽宁·沈阳","a":"辽大 lnu"},{"n":"大连理工大学","d":"dlut.edu.cn","p":"辽宁·大连","a":"大工 dlut"},{"n":"沈阳工业大学","d":"sut.edu.cn","p":"辽宁·沈阳","a":"沈工大 sut"},{"n":"沈阳航空航天大学","d":"sau.edu.cn","p":"辽宁·沈阳","a":""},{"n":"沈阳理工大学","d":"","p":"辽宁·沈阳","a":""},{"n":"东北大学","d":"neu.edu.cn","p":"辽宁·沈阳","a":"东大 neu"},{"n":"辽宁科技大学","d":"","p":"辽宁·鞍山","a":""},{"n":"辽宁工程技术大学","d":"","p":"辽宁·阜新","a":""},{"n":"辽宁石油化工大学","d":"","p":"辽宁·抚顺","a":""},{"n":"沈阳化工大学","d":"","p":"辽宁·沈阳","a":""},{"n":"大连交通大学","d":"","p":"辽宁·大连","a":""},{"n":"大连海事大学","d":"dlmu.edu.cn","p":"辽宁·大连","a":"海大 dlmu"},{"n":"大连工业大学","d":"","p":"辽宁·大连","a":""},{"n":"沈阳建筑大学","d":"","p":"辽宁·沈阳","a":""},{"n":"辽宁工业大学","d":"","p":"辽宁·锦州","a":""},{"n":"沈阳农业大学","d":"","p":"辽宁·沈阳","a":""},{"n":"大连海洋大学","d":"","p":"辽宁·大连","a":""},{"n":"中国医科大学","d":"","p":"辽宁·沈阳","a":""},{"n":"锦州医科大学","d":"","p":"辽宁·锦州","a":""},{"n":"大连医科大学","d":"","p":"辽宁·大连","a":""},{"n":"辽宁中医药大学","d":"","p":"辽宁·沈阳","a":""},{"n":"沈阳药科大学","d":"","p":"辽宁·沈阳","a":""},{"n":"沈阳医学院","d":"","p":"辽宁·沈阳","a":""},{"n":"辽宁师范大学","d":"","p":"辽宁·大连","a":""},{"n":"沈阳师范大学","d":"","p":"辽宁·沈阳","a":""},{"n":"渤海大学","d":"","p":"辽宁·锦州","a":""},{"n":"鞍山师范学院","d":"","p":"辽宁·鞍山","a":""},{"n":"大连外国语大学","d":"","p":"辽宁·大连","a":""},{"n":"东北财经大学","d":"dufe.edu.cn","p":"辽宁·大连","a":""},{"n":"中国刑事警察学院","d":"","p":"辽宁·沈阳","a":""},{"n":"沈阳体育学院","d":"","p":"辽宁·沈阳","a":""},{"n":"沈阳音乐学院","d":"","p":"辽宁·沈阳","a":""},{"n":"鲁迅美术学院","d":"","p":"辽宁·沈阳","a":""},{"n":"沈阳大学","d":"","p":"辽宁·沈阳","a":""},{"n":"大连大学","d":"","p":"辽宁·大连","a":""},{"n":"辽宁科技学院","d":"","p":"辽宁·本溪","a":""},{"n":"辽宁警察学院","d":"","p":"辽宁·大连","a":""},{"n":"沈阳工程学院","d":"","p":"辽宁·沈阳","a":""},{"n":"辽东学院","d":"","p":"辽宁·丹东","a":""},{"n":"大连民族大学","d":"","p":"辽宁·大连","a":""},{"n":"营口理工学院","d":"","p":"辽宁·营口","a":""},{"n":"朝阳师范学院","d":"","p":"辽宁·朝阳","a":""},{"n":"吉林大学","d":"jlu.edu.cn","p":"吉林·长春","a":"吉大 jlu"},{"n":"延边大学","d":"ybu.edu.cn","p":"吉林·延边","a":"延大 ybu"},{"n":"长春理工大学","d":"cust.edu.cn","p":"吉林·长春","a":""},{"n":"东北电力大学","d":"","p":"吉林·吉林市","a":""},{"n":"长春工业大学","d":"","p":"吉林·长春","a":""},{"n":"吉林建筑大学","d":"","p":"吉林·长春","a":""},{"n":"吉林化工大学","d":"","p":"吉林·吉林市","a":""},{"n":"吉林农业大学","d":"","p":"吉林·长春","a":""},{"n":"长春中医药大学","d":"","p":"吉林·长春","a":""},{"n":"东北师范大学","d":"nenu.edu.cn","p":"吉林·长春","a":"东师 nenu"},{"n":"北华大学","d":"","p":"吉林·吉林市","a":""},{"n":"通化师范学院","d":"","p":"吉林·通化","a":""},{"n":"吉林师范大学","d":"","p":"吉林·四平","a":""},{"n":"吉林工程技术师范学院","d":"","p":"吉林·长春","a":""},{"n":"长春师范大学","d":"","p":"吉林·长春","a":""},{"n":"白城师范学院","d":"","p":"吉林·白城","a":""},{"n":"吉林财经大学","d":"","p":"吉林·长春","a":""},{"n":"吉林体育学院","d":"","p":"吉林·长春","a":""},{"n":"吉林艺术学院","d":"","p":"吉林·长春","a":""},{"n":"吉林工商学院","d":"","p":"吉林·长春","a":""},{"n":"长春工程学院","d":"","p":"吉林·长春","a":""},{"n":"吉林农业科技学院","d":"","p":"吉林·吉林市","a":""},{"n":"吉林警察学院","d":"","p":"吉林·长春","a":""},{"n":"长春大学","d":"","p":"吉林·长春","a":""},{"n":"吉林医药学院","d":"","p":"吉林·吉林市","a":""},{"n":"长春汽车职业技术大学","d":"","p":"吉林·长春","a":""},{"n":"长春职业技术大学","d":"","p":"吉林·长春","a":""},{"n":"吉林铁道职业技术大学","d":"","p":"吉林·吉林市","a":""},{"n":"黑龙江大学","d":"hlju.edu.cn","p":"黑龙江·哈尔滨","a":"黑大 hlju"},{"n":"哈尔滨工业大学","d":"hit.edu.cn","p":"黑龙江·哈尔滨","a":"哈工大 hit"},{"n":"哈尔滨理工大学","d":"hrbust.edu.cn","p":"黑龙江·哈尔滨","a":""},{"n":"哈尔滨工程大学","d":"hrbeu.edu.cn","p":"黑龙江·哈尔滨","a":"哈工程 hrbeu"},{"n":"黑龙江科技大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"东北石油大学","d":"","p":"黑龙江·大庆","a":""},{"n":"佳木斯大学","d":"","p":"黑龙江·佳木斯","a":""},{"n":"黑龙江八一农垦大学","d":"","p":"黑龙江·大庆","a":""},{"n":"东北农业大学","d":"neau.edu.cn","p":"黑龙江·哈尔滨","a":"东农 neau"},{"n":"东北林业大学","d":"nefu.edu.cn","p":"黑龙江·哈尔滨","a":"东林 nefu"},{"n":"哈尔滨医科大学","d":"hrbmu.edu.cn","p":"黑龙江·哈尔滨","a":""},{"n":"黑龙江中医药大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"牡丹江医科大学","d":"","p":"黑龙江·牡丹江","a":""},{"n":"哈尔滨师范大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"齐齐哈尔大学","d":"","p":"黑龙江·齐齐哈尔","a":""},{"n":"牡丹江师范学院","d":"","p":"黑龙江·牡丹江","a":""},{"n":"哈尔滨学院","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"大庆师范学院","d":"","p":"黑龙江·大庆","a":""},{"n":"绥化学院","d":"","p":"黑龙江·绥化","a":""},{"n":"哈尔滨商业大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"哈尔滨体育学院","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"哈尔滨金融学院","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"齐齐哈尔医学院","d":"","p":"黑龙江·齐齐哈尔","a":""},{"n":"黑龙江工业学院","d":"","p":"黑龙江·鸡西","a":""},{"n":"黑龙江工程学院","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"黑河学院","d":"","p":"黑龙江·黑河","a":""},{"n":"哈尔滨音乐学院","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"哈尔滨建筑科技职业大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"黑龙江农业工程职业技术大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"哈尔滨职业技术大学","d":"","p":"黑龙江·哈尔滨","a":""},{"n":"复旦大学","d":"fudan.edu.cn","p":"上海","a":"复旦 fudan"},{"n":"同济大学","d":"tongji.edu.cn","p":"上海","a":"同济 tongji"},{"n":"上海交通大学","d":"sjtu.edu.cn","p":"上海","a":"上交 sjtu"},{"n":"华东理工大学","d":"ecust.edu.cn","p":"上海","a":"华理 ecust"},{"n":"上海理工大学","d":"usst.edu.cn","p":"上海","a":"上理 usst"},{"n":"上海海事大学","d":"shmtu.edu.cn","p":"上海","a":""},{"n":"东华大学","d":"dhu.edu.cn","p":"上海","a":"东华 dhu"},{"n":"上海电力大学","d":"shiep.edu.cn","p":"上海","a":""},{"n":"上海应用技术大学","d":"","p":"上海","a":""},{"n":"上海健康医学院","d":"","p":"上海","a":""},{"n":"上海海洋大学","d":"","p":"上海","a":""},{"n":"上海中医药大学","d":"","p":"上海","a":""},{"n":"华东师范大学","d":"ecnu.edu.cn","p":"上海","a":"华师大 ecnu"},{"n":"上海师范大学","d":"shnu.edu.cn","p":"上海","a":"上师大 shnu"},{"n":"上海外国语大学","d":"shisu.edu.cn","p":"上海","a":"上外 shisu"},{"n":"上海财经大学","d":"sufe.edu.cn","p":"上海","a":"上财 sufe"},{"n":"上海对外经贸大学","d":"","p":"上海","a":""},{"n":"上海海关学院","d":"","p":"上海","a":""},{"n":"华东政法大学","d":"","p":"上海","a":""},{"n":"上海体育大学","d":"","p":"上海","a":""},{"n":"上海音乐学院","d":"","p":"上海","a":""},{"n":"上海戏剧学院","d":"","p":"上海","a":""},{"n":"上海大学","d":"shu.edu.cn","p":"上海","a":"上大 shu"},{"n":"上海公安学院","d":"","p":"上海","a":""},{"n":"上海工程技术大学","d":"","p":"上海","a":""},{"n":"上海立信会计金融学院","d":"","p":"上海","a":""},{"n":"上海电机学院","d":"","p":"上海","a":""},{"n":"上海政法学院","d":"","p":"上海","a":""},{"n":"上海第二工业大学","d":"","p":"上海","a":""},{"n":"上海商学院","d":"","p":"上海","a":""},{"n":"上海科技大学","d":"shanghaitech.edu.cn","p":"上海","a":""},{"n":"南京大学","d":"nju.edu.cn","p":"江苏·南京","a":"南大 nju"},{"n":"苏州大学","d":"suda.edu.cn","p":"江苏·苏州","a":"苏大 suda"},{"n":"东南大学","d":"seu.edu.cn","p":"江苏·南京","a":"东大 seu"},{"n":"南京航空航天大学","d":"nuaa.edu.cn","p":"江苏·南京","a":"南航 nuaa"},{"n":"南京理工大学","d":"njust.edu.cn","p":"江苏·南京","a":"南理工 njust"},{"n":"江苏科技大学","d":"","p":"江苏·镇江","a":""},{"n":"中国矿业大学","d":"cumt.edu.cn","p":"江苏·徐州","a":"矿大 cumt"},{"n":"南京工业大学","d":"njtech.edu.cn","p":"江苏·南京","a":""},{"n":"常州大学","d":"cczu.edu.cn","p":"江苏·常州","a":""},{"n":"南京邮电大学","d":"njupt.edu.cn","p":"江苏·南京","a":"南邮 njupt"},{"n":"河海大学","d":"hhu.edu.cn","p":"江苏·南京","a":"河海 hhu"},{"n":"江南大学","d":"jiangnan.edu.cn","p":"江苏·无锡","a":"江南 jiangnan"},{"n":"南京林业大学","d":"njfu.edu.cn","p":"江苏·南京","a":""},{"n":"江苏大学","d":"ujs.edu.cn","p":"江苏·镇江","a":"江大 ujs"},{"n":"南京信息工程大学","d":"nuist.edu.cn","p":"江苏·南京","a":"南信大 nuist"},{"n":"南通大学","d":"ntu.edu.cn","p":"江苏·南通","a":""},{"n":"盐城工学院","d":"","p":"江苏·盐城","a":""},{"n":"南京农业大学","d":"njau.edu.cn","p":"江苏·南京","a":"南农 njau"},{"n":"南京医科大学","d":"njmu.edu.cn","p":"江苏·南京","a":""},{"n":"徐州医科大学","d":"","p":"江苏·徐州","a":""},{"n":"南京中医药大学","d":"","p":"江苏·南京","a":""},{"n":"中国药科大学","d":"cpu.edu.cn","p":"江苏·南京","a":"药大 cpu"},{"n":"南京师范大学","d":"njnu.edu.cn","p":"江苏·南京","a":"南师大 njnu"},{"n":"江苏师范大学","d":"","p":"江苏·徐州","a":""},{"n":"淮阴师范学院","d":"","p":"江苏·淮安","a":""},{"n":"盐城师范学院","d":"","p":"江苏·盐城","a":""},{"n":"南京财经大学","d":"","p":"江苏·南京","a":""},{"n":"江苏警官学院","d":"","p":"江苏·南京","a":""},{"n":"南京体育学院","d":"","p":"江苏·南京","a":""},{"n":"南京艺术学院","d":"","p":"江苏·南京","a":""},{"n":"苏州科技大学","d":"","p":"江苏·苏州","a":""},{"n":"苏州工学院","d":"","p":"江苏·苏州","a":""},{"n":"南京工业职业技术大学","d":"","p":"江苏·南京","a":""},{"n":"淮安大学","d":"","p":"江苏·淮安","a":""},{"n":"常州工学院","d":"","p":"江苏·常州","a":""},{"n":"扬州大学","d":"yzu.edu.cn","p":"江苏·扬州","a":"扬大 yzu"},{"n":"南京工程学院","d":"","p":"江苏·南京","a":""},{"n":"南京审计大学","d":"nau.edu.cn","p":"江苏·南京","a":""},{"n":"南京晓庄学院","d":"","p":"江苏·南京","a":""},{"n":"江苏理工学院","d":"","p":"江苏·常州","a":""},{"n":"江苏海洋大学","d":"","p":"江苏·连云港","a":""},{"n":"徐州工程学院","d":"","p":"江苏·徐州","a":""},{"n":"南京特殊教育师范学院","d":"","p":"江苏·南京","a":""},{"n":"南京警察学院","d":"","p":"江苏·南京","a":""},{"n":"泰州学院","d":"","p":"江苏·泰州","a":""},{"n":"金陵科技学院","d":"","p":"江苏·南京","a":""},{"n":"无锡学院","d":"","p":"江苏·无锡","a":""},{"n":"苏州城市学院","d":"","p":"江苏·苏州","a":""},{"n":"宿迁学院","d":"","p":"江苏·宿迁","a":""},{"n":"江苏第二师范学院","d":"","p":"江苏·南京","a":""},{"n":"无锡职业技术大学","d":"","p":"江苏·无锡","a":""},{"n":"江苏建筑职业技术大学","d":"","p":"江苏·徐州","a":""},{"n":"苏州职业技术大学","d":"","p":"江苏·苏州","a":""},{"n":"扬州职业技术大学","d":"","p":"江苏·扬州","a":""},{"n":"连云港师范学院","d":"","p":"江苏·连云港","a":""},{"n":"常州信息职业技术大学","d":"","p":"江苏·常州","a":""},{"n":"浙江大学","d":"zju.edu.cn","p":"浙江·杭州","a":"浙大 zju"},{"n":"杭州电子科技大学","d":"hdu.edu.cn","p":"浙江·杭州","a":"杭电 hdu"},{"n":"浙江工业大学","d":"zjut.edu.cn","p":"浙江·杭州","a":"浙工大 zjut"},{"n":"浙江理工大学","d":"zstu.edu.cn","p":"浙江·杭州","a":"浙理工 zstu"},{"n":"浙江海洋大学","d":"","p":"浙江·舟山","a":""},{"n":"浙江农林大学","d":"","p":"浙江·杭州","a":""},{"n":"温州医科大学","d":"","p":"浙江·温州","a":""},{"n":"浙江中医药大学","d":"","p":"浙江·杭州","a":""},{"n":"浙江师范大学","d":"zjnu.edu.cn","p":"浙江·金华","a":"浙师大 zjnu"},{"n":"杭州师范大学","d":"hznu.edu.cn","p":"浙江·杭州","a":""},{"n":"湖州师范大学","d":"","p":"浙江·湖州","a":""},{"n":"绍兴大学","d":"","p":"浙江·绍兴","a":""},{"n":"台州学院","d":"","p":"浙江·台州","a":""},{"n":"温州大学","d":"wzu.edu.cn","p":"浙江·温州","a":"温大 wzu"},{"n":"丽水学院","d":"","p":"浙江·丽水","a":""},{"n":"浙江工商大学","d":"","p":"浙江·杭州","a":""},{"n":"嘉兴大学","d":"","p":"浙江·嘉兴","a":""},{"n":"中国美术学院","d":"","p":"浙江·杭州","a":""},{"n":"中国计量大学","d":"cjlu.edu.cn","p":"浙江·杭州","a":""},{"n":"浙江万里学院","d":"","p":"浙江·宁波","a":""},{"n":"浙江科技大学","d":"","p":"浙江·杭州","a":""},{"n":"宁波工程学院","d":"","p":"浙江·宁波","a":""},{"n":"浙江水利水电学院","d":"","p":"浙江·杭州","a":""},{"n":"浙江财经大学","d":"zufe.edu.cn","p":"浙江·杭州","a":""},{"n":"浙江警察学院","d":"","p":"浙江·杭州","a":""},{"n":"衢州学院","d":"","p":"浙江·衢州","a":""},{"n":"宁波大学","d":"nbu.edu.cn","p":"浙江·宁波","a":"宁大 nbu"},{"n":"浙江传媒学院","d":"","p":"浙江·杭州","a":""},{"n":"浙大城市学院","d":"","p":"浙江·杭州","a":""},{"n":"浙大宁波理工学院","d":"","p":"浙江·宁波","a":""},{"n":"杭州医学院","d":"","p":"浙江·杭州","a":""},{"n":"湖州学院","d":"","p":"浙江·湖州","a":""},{"n":"绍兴理工学院","d":"","p":"浙江·绍兴","a":""},{"n":"温州理工学院","d":"","p":"浙江·温州","a":""},{"n":"嘉兴南湖学院","d":"","p":"浙江·嘉兴","a":""},{"n":"浙江外国语学院","d":"","p":"浙江·杭州","a":""},{"n":"浙江音乐学院","d":"","p":"浙江·杭州","a":""},{"n":"浙江药科职业大学","d":"","p":"浙江·宁波","a":""},{"n":"宁波职业技术大学","d":"","p":"浙江·宁波","a":""},{"n":"温州职业技术大学","d":"","p":"浙江·温州","a":""},{"n":"金华职业技术大学","d":"","p":"浙江·金华","a":""},{"n":"浙江机电职业技术大学","d":"","p":"浙江·杭州","a":""},{"n":"杭州职业技术大学","d":"","p":"浙江·杭州","a":""},{"n":"安徽大学","d":"ahu.edu.cn","p":"安徽·合肥","a":"安大 ahu"},{"n":"中国科学技术大学","d":"ustc.edu.cn","p":"安徽·合肥","a":"中科大 ustc"},{"n":"合肥工业大学","d":"hfut.edu.cn","p":"安徽·合肥","a":"合工大 hfut"},{"n":"安徽工业大学","d":"ahut.edu.cn","p":"安徽·马鞍山","a":""},{"n":"安徽理工大学","d":"aust.edu.cn","p":"安徽·淮南","a":""},{"n":"安徽工程大学","d":"","p":"安徽·芜湖","a":""},{"n":"安徽农业大学","d":"","p":"安徽·合肥","a":""},{"n":"安徽医科大学","d":"ahmu.edu.cn","p":"安徽·合肥","a":""},{"n":"蚌埠医科大学","d":"","p":"安徽·蚌埠","a":""},{"n":"皖南医科大学","d":"","p":"安徽·芜湖","a":""},{"n":"安徽中医药大学","d":"","p":"安徽·合肥","a":""},{"n":"安徽师范大学","d":"ahnu.edu.cn","p":"安徽·芜湖","a":"安师大 ahnu"},{"n":"阜阳师范大学","d":"","p":"安徽·阜阳","a":""},{"n":"安庆师范大学","d":"","p":"安徽·安庆","a":""},{"n":"淮北师范大学","d":"","p":"安徽·淮北","a":""},{"n":"黄山学院","d":"","p":"安徽·黄山","a":""},{"n":"皖西学院","d":"","p":"安徽·六安","a":""},{"n":"滁州学院","d":"","p":"安徽·滁州","a":""},{"n":"安徽财经大学","d":"aufe.edu.cn","p":"安徽·蚌埠","a":""},{"n":"宿州学院","d":"","p":"安徽·宿州","a":""},{"n":"巢湖学院","d":"","p":"安徽·合肥","a":""},{"n":"淮南师范学院","d":"","p":"安徽·淮南","a":""},{"n":"铜陵学院","d":"","p":"安徽·铜陵","a":""},{"n":"安徽建筑大学","d":"","p":"安徽·合肥","a":""},{"n":"安徽科技工程大学","d":"","p":"安徽·滁州","a":""},{"n":"合肥大学","d":"","p":"安徽·合肥","a":""},{"n":"蚌埠学院","d":"","p":"安徽·蚌埠","a":""},{"n":"池州学院","d":"","p":"安徽·池州","a":""},{"n":"亳州学院","d":"","p":"安徽·亳州","a":""},{"n":"合肥理工学院","d":"","p":"安徽·合肥","a":""},{"n":"合肥师范学院","d":"","p":"安徽·合肥","a":""},{"n":"安徽艺术学院","d":"","p":"安徽·合肥","a":""},{"n":"安徽职业技术大学","d":"","p":"安徽·合肥","a":""},{"n":"芜湖职业技术大学","d":"","p":"安徽·芜湖","a":""},{"n":"安徽应用技术职业大学","d":"","p":"安徽·芜湖","a":""},{"n":"安徽第二医学院","d":"","p":"安徽·合肥","a":""},{"n":"厦门大学","d":"xmu.edu.cn","p":"福建·厦门","a":"厦大 xmu"},{"n":"华侨大学","d":"hqu.edu.cn","p":"福建·泉州","a":"华大 hqu"},{"n":"福州大学","d":"fzu.edu.cn","p":"福建·福州","a":"福大 fzu"},{"n":"福建理工大学","d":"","p":"福建·福州","a":""},{"n":"福建农林大学","d":"fafu.edu.cn","p":"福建·福州","a":""},{"n":"集美大学","d":"jmu.edu.cn","p":"福建·厦门","a":""},{"n":"福建医科大学","d":"","p":"福建·福州","a":""},{"n":"福建中医药大学","d":"","p":"福建·福州","a":""},{"n":"福建师范大学","d":"fjnu.edu.cn","p":"福建·福州","a":"福师大 fjnu"},{"n":"闽江大学","d":"","p":"福建·福州","a":""},{"n":"武夷学院","d":"","p":"福建·南平","a":""},{"n":"宁德师范学院","d":"","p":"福建·宁德","a":""},{"n":"泉州师范学院","d":"","p":"福建·泉州","a":""},{"n":"闽南师范大学","d":"","p":"福建·漳州","a":""},{"n":"厦门理工学院","d":"","p":"福建·厦门","a":""},{"n":"三明学院","d":"","p":"福建·三明","a":""},{"n":"龙岩学院","d":"","p":"福建·龙岩","a":""},{"n":"福建商学院","d":"","p":"福建·福州","a":""},{"n":"福建警察学院","d":"","p":"福建·福州","a":""},{"n":"莆田学院","d":"","p":"福建·莆田","a":""},{"n":"厦门医学院","d":"","p":"福建·厦门","a":""},{"n":"福建江夏学院","d":"","p":"福建·福州","a":""},{"n":"福建技术师范学院","d":"","p":"福建·福州","a":""},{"n":"黎明职业大学","d":"","p":"福建·泉州","a":""},{"n":"福州职业技术大学","d":"","p":"福建·福州","a":""},{"n":"南昌大学","d":"ncu.edu.cn","p":"江西·南昌","a":"昌大 ncu"},{"n":"华东交通大学","d":"","p":"江西·南昌","a":""},{"n":"东华理工大学","d":"ecut.edu.cn","p":"江西·抚州","a":""},{"n":"南昌航空大学","d":"nchu.edu.cn","p":"江西·南昌","a":""},{"n":"江西理工大学","d":"jxust.edu.cn","p":"江西·赣州","a":""},{"n":"景德镇陶瓷大学","d":"","p":"江西·景德镇","a":""},{"n":"江西农业大学","d":"","p":"江西·南昌","a":""},{"n":"江西中医药大学","d":"","p":"江西·南昌","a":""},{"n":"赣南医科大学","d":"","p":"江西·赣州","a":""},{"n":"江西师范大学","d":"jxnu.edu.cn","p":"江西·南昌","a":"江师大 jxnu"},{"n":"上饶师范学院","d":"","p":"江西·上饶","a":""},{"n":"宜春学院","d":"","p":"江西·宜春","a":""},{"n":"赣南师范大学","d":"","p":"江西·赣州","a":""},{"n":"井冈山大学","d":"","p":"江西·吉安","a":""},{"n":"江西财经大学","d":"jxufe.edu.cn","p":"江西·南昌","a":"江财 jxufe"},{"n":"景德镇学院","d":"","p":"江西·景德镇","a":""},{"n":"萍乡学院","d":"","p":"江西·萍乡","a":""},{"n":"江西科技师范大学","d":"","p":"江西·南昌","a":""},{"n":"江西水利电力大学","d":"","p":"江西·南昌","a":""},{"n":"江西警察学院","d":"","p":"江西·南昌","a":""},{"n":"新余学院","d":"","p":"江西·新余","a":""},{"n":"九江学院","d":"","p":"江西·九江","a":""},{"n":"赣东学院","d":"","p":"江西·抚州","a":""},{"n":"赣南科技学院","d":"","p":"江西·赣州","a":""},{"n":"南昌医学院","d":"","p":"江西·南昌","a":""},{"n":"豫章师范学院","d":"","p":"江西·南昌","a":""},{"n":"南昌师范学院","d":"","p":"江西·南昌","a":""},{"n":"江西职业技术大学","d":"","p":"江西·九江","a":""},{"n":"江西外语外贸职业大学","d":"","p":"江西·南昌","a":""},{"n":"抚州医药学院","d":"","p":"江西·抚州","a":""},{"n":"江西飞行学院","d":"","p":"江西·南昌","a":""},{"n":"山东大学","d":"sdu.edu.cn","p":"山东·济南","a":"山大 sdu"},{"n":"中国海洋大学","d":"ouc.edu.cn","p":"山东·青岛","a":"海大 ouc"},{"n":"山东科技大学","d":"sdust.edu.cn","p":"山东·青岛","a":"山科 sdust"},{"n":"中国石油大学（华东）","d":"","p":"山东·青岛","a":""},{"n":"青岛科技大学","d":"qust.edu.cn","p":"山东·青岛","a":""},{"n":"济南大学","d":"ujn.edu.cn","p":"山东·济南","a":"济大 ujn"},{"n":"青岛理工大学","d":"qtech.edu.cn","p":"山东·青岛","a":""},{"n":"山东建筑大学","d":"","p":"山东·济南","a":""},{"n":"齐鲁工业大学","d":"qlu.edu.cn","p":"山东·济南","a":""},{"n":"山东理工大学","d":"sdut.edu.cn","p":"山东·淄博","a":""},{"n":"山东农业大学","d":"sdau.edu.cn","p":"山东·泰安","a":""},{"n":"青岛农业大学","d":"","p":"山东·青岛","a":""},{"n":"山东第二医科大学","d":"","p":"山东·潍坊","a":""},{"n":"山东第一医科大学","d":"","p":"山东·济南","a":""},{"n":"山东医药大学","d":"","p":"山东·滨州","a":""},{"n":"山东中医药大学","d":"","p":"山东·济南","a":""},{"n":"济宁医学院","d":"","p":"山东·济宁","a":""},{"n":"山东师范大学","d":"sdnu.edu.cn","p":"山东·济南","a":"山师 sdnu"},{"n":"曲阜师范大学","d":"qfnu.edu.cn","p":"山东·济宁","a":""},{"n":"聊城大学","d":"","p":"山东·聊城","a":""},{"n":"德州学院","d":"","p":"山东·德州","a":""},{"n":"山东航空学院","d":"","p":"山东·滨州","a":""},{"n":"鲁东大学","d":"ldu.edu.cn","p":"山东·烟台","a":""},{"n":"临沂大学","d":"","p":"山东·临沂","a":""},{"n":"泰山学院","d":"","p":"山东·泰安","a":""},{"n":"济宁学院","d":"","p":"山东·济宁","a":""},{"n":"菏泽学院","d":"","p":"山东·菏泽","a":""},{"n":"山东财经大学","d":"sdufe.edu.cn","p":"山东·济南","a":""},{"n":"山东体育学院","d":"","p":"山东·济南","a":""},{"n":"山东艺术学院","d":"","p":"山东·济南","a":""},{"n":"枣庄学院","d":"","p":"山东·枣庄","a":""},{"n":"山东工艺美术学院","d":"","p":"山东·济南","a":""},{"n":"青岛大学","d":"qdu.edu.cn","p":"山东·青岛","a":"青大 qdu"},{"n":"烟台大学","d":"ytu.edu.cn","p":"山东·烟台","a":""},{"n":"潍坊学院","d":"","p":"山东·潍坊","a":""},{"n":"山东警察学院","d":"","p":"山东·济南","a":""},{"n":"山东交通学院","d":"","p":"山东·济南","a":""},{"n":"山东工商学院","d":"","p":"山东·烟台","a":""},{"n":"山东女子学院","d":"","p":"山东·济南","a":""},{"n":"山东石油化工学院","d":"","p":"山东·东营","a":""},{"n":"山东政法学院","d":"","p":"山东·济南","a":""},{"n":"齐鲁师范学院","d":"","p":"山东·济南","a":""},{"n":"山东青年政治学院","d":"","p":"山东·济南","a":""},{"n":"山东管理学院","d":"","p":"山东·济南","a":""},{"n":"山东农业工程学院","d":"","p":"山东·济南","a":""},{"n":"山东商业职业技术大学","d":"","p":"山东·济南","a":""},{"n":"日照职业技术大学","d":"","p":"山东·日照","a":""},{"n":"滨州职业技术大学","d":"","p":"山东·滨州","a":""},{"n":"山东科技职业大学","d":"","p":"山东·潍坊","a":""},{"n":"淄博职业技术大学","d":"","p":"山东·淄博","a":""},{"n":"华北水利水电大学","d":"ncwu.edu.cn","p":"河南·郑州","a":""},{"n":"郑州大学","d":"zzu.edu.cn","p":"河南·郑州","a":"郑大 zzu"},{"n":"河南理工大学","d":"hpu.edu.cn","p":"河南·焦作","a":"河理工 hpu"},{"n":"郑州轻工业大学","d":"","p":"河南·郑州","a":""},{"n":"河南工业大学","d":"haut.edu.cn","p":"河南·郑州","a":""},{"n":"河南科技大学","d":"haust.edu.cn","p":"河南·洛阳","a":""},{"n":"中原工学院","d":"","p":"河南·郑州","a":""},{"n":"河南农业大学","d":"henau.edu.cn","p":"河南·郑州","a":""},{"n":"河南科技学院","d":"","p":"河南·新乡","a":""},{"n":"河南牧业经济学院","d":"","p":"河南·郑州","a":""},{"n":"河南中医药大学","d":"","p":"河南·郑州","a":""},{"n":"河南医药大学","d":"","p":"河南·新乡","a":""},{"n":"河南大学","d":"henu.edu.cn","p":"河南·开封","a":"河大 henu"},{"n":"河南师范大学","d":"htu.edu.cn","p":"河南·新乡","a":"河师大 htu"},{"n":"信阳师范大学","d":"","p":"河南·信阳","a":""},{"n":"周口师范学院","d":"","p":"河南·周口","a":""},{"n":"安阳师范学院","d":"","p":"河南·安阳","a":""},{"n":"许昌学院","d":"","p":"河南·许昌","a":""},{"n":"南阳师范学院","d":"","p":"河南·南阳","a":""},{"n":"洛阳师范学院","d":"","p":"河南·洛阳","a":""},{"n":"商丘师范学院","d":"","p":"河南·商丘","a":""},{"n":"河南财经政法大学","d":"","p":"河南·郑州","a":""},{"n":"郑州航空工业管理学院","d":"","p":"河南·郑州","a":""},{"n":"黄淮学院","d":"","p":"河南·驻马店","a":""},{"n":"平顶山学院","d":"","p":"河南·平顶山","a":""},{"n":"郑州工程技术学院","d":"","p":"河南·郑州","a":""},{"n":"洛阳理工学院","d":"","p":"河南·洛阳","a":""},{"n":"新乡学院","d":"","p":"河南·新乡","a":""},{"n":"信阳农林学院","d":"","p":"河南·信阳","a":""},{"n":"河南工学院","d":"","p":"河南·新乡","a":""},{"n":"安阳工学院","d":"","p":"河南·安阳","a":""},{"n":"河南工程学院","d":"","p":"河南·郑州","a":""},{"n":"河南财政金融学院","d":"","p":"河南·郑州","a":""},{"n":"南阳理工学院","d":"","p":"河南·南阳","a":""},{"n":"河南城建学院","d":"","p":"河南·平顶山","a":""},{"n":"河南警察学院","d":"","p":"河南·郑州","a":""},{"n":"郑州警察学院","d":"","p":"河南·郑州","a":""},{"n":"郑州师范学院","d":"","p":"河南·郑州","a":""},{"n":"郑州铁路职业技术大学","d":"","p":"河南·郑州","a":""},{"n":"黄河水利职业技术大学","d":"","p":"河南·开封","a":""},{"n":"河南工业职业技术大学","d":"","p":"河南·南阳","a":""},{"n":"武汉大学","d":"whu.edu.cn","p":"湖北·武汉","a":"武大 whu"},{"n":"华中科技大学","d":"hust.edu.cn","p":"湖北·武汉","a":"华科 hust"},{"n":"武汉科技大学","d":"wust.edu.cn","p":"湖北·武汉","a":""},{"n":"长江大学","d":"yangtzeu.edu.cn","p":"湖北·荆州","a":""},{"n":"武汉工程大学","d":"wit.edu.cn","p":"湖北·武汉","a":""},{"n":"中国地质大学（武汉）","d":"","p":"湖北·武汉","a":""},{"n":"武汉纺织大学","d":"","p":"湖北·武汉","a":""},{"n":"武汉轻工大学","d":"","p":"湖北·武汉","a":""},{"n":"武汉理工大学","d":"whut.edu.cn","p":"湖北·武汉","a":"武理工 whut"},{"n":"湖北工业大学","d":"hbut.edu.cn","p":"湖北·武汉","a":""},{"n":"华中农业大学","d":"hzau.edu.cn","p":"湖北·武汉","a":"华农 hzau"},{"n":"湖北中医药大学","d":"","p":"湖北·武汉","a":""},{"n":"华中师范大学","d":"ccnu.edu.cn","p":"湖北·武汉","a":"华师 ccnu"},{"n":"湖北大学","d":"hubu.edu.cn","p":"湖北·武汉","a":"湖大 hubu"},{"n":"湖北师范大学","d":"","p":"湖北·黄石","a":""},{"n":"黄冈师范学院","d":"","p":"湖北·黄冈","a":""},{"n":"湖北民族大学","d":"","p":"湖北·恩施","a":""},{"n":"汉江师范学院","d":"","p":"湖北·十堰","a":""},{"n":"湖北文理学院","d":"","p":"湖北·襄阳","a":""},{"n":"中南财经政法大学","d":"zuel.edu.cn","p":"湖北·武汉","a":"中南大 zuel"},{"n":"武汉体育学院","d":"","p":"湖北·武汉","a":""},{"n":"湖北美术学院","d":"","p":"湖北·武汉","a":""},{"n":"中南民族大学","d":"","p":"湖北·武汉","a":""},{"n":"湖北汽车工业学院","d":"","p":"湖北·十堰","a":""},{"n":"湖北工程学院","d":"","p":"湖北·孝感","a":""},{"n":"湖北理工学院","d":"","p":"湖北·黄石","a":""},{"n":"湖北科技学院","d":"","p":"湖北·咸宁","a":""},{"n":"湖北医药学院","d":"","p":"湖北·十堰","a":""},{"n":"江汉大学","d":"","p":"湖北·武汉","a":""},{"n":"三峡大学","d":"ctgu.edu.cn","p":"湖北·宜昌","a":""},{"n":"湖北警官学院","d":"","p":"湖北·武汉","a":""},{"n":"荆楚理工学院","d":"","p":"湖北·荆门","a":""},{"n":"武汉音乐学院","d":"","p":"湖北·武汉","a":""},{"n":"湖北经济学院","d":"","p":"湖北·武汉","a":""},{"n":"武汉商学院","d":"","p":"湖北·武汉","a":""},{"n":"湖北第二师范学院","d":"","p":"湖北·武汉","a":""},{"n":"武汉职业技术大学","d":"","p":"湖北·武汉","a":""},{"n":"黄冈职业技术大学","d":"","p":"湖北·黄冈","a":""},{"n":"襄阳职业技术大学","d":"","p":"湖北·襄阳","a":""},{"n":"湖北三峡职业技术大学","d":"","p":"湖北·宜昌","a":""},{"n":"湘潭大学","d":"xtu.edu.cn","p":"湖南·湘潭","a":"湘大 xtu"},{"n":"吉首大学","d":"","p":"湖南·湘西","a":""},{"n":"湖南大学","d":"hnu.edu.cn","p":"湖南·长沙","a":"湖大 hnu"},{"n":"中南大学","d":"csu.edu.cn","p":"湖南·长沙","a":"中南 csu"},{"n":"湖南科技大学","d":"hnust.edu.cn","p":"湖南·湘潭","a":""},{"n":"长沙理工大学","d":"csust.edu.cn","p":"湖南·长沙","a":"长理 csust"},{"n":"湖南农业大学","d":"hunau.edu.cn","p":"湖南·长沙","a":""},{"n":"中南林业科技大学","d":"","p":"湖南·长沙","a":""},{"n":"湖南中医药大学","d":"","p":"湖南·长沙","a":""},{"n":"湖南师范大学","d":"hunnu.edu.cn","p":"湖南·长沙","a":"湖师大 hunnu"},{"n":"湖南理工大学","d":"","p":"湖南·岳阳","a":""},{"n":"湘南学院","d":"","p":"湖南·郴州","a":""},{"n":"衡阳师范学院","d":"","p":"湖南·衡阳","a":""},{"n":"邵阳学院","d":"","p":"湖南·邵阳","a":""},{"n":"怀化学院","d":"","p":"湖南·怀化","a":""},{"n":"湖南文理学院","d":"","p":"湖南·常德","a":""},{"n":"湖南科技学院","d":"","p":"湖南·永州","a":""},{"n":"湖南人文科技学院","d":"","p":"湖南·娄底","a":""},{"n":"湖南工商大学","d":"","p":"湖南·长沙","a":""},{"n":"南华大学","d":"usc.edu.cn","p":"湖南·衡阳","a":""},{"n":"长沙学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南工程学院","d":"","p":"湖南·湘潭","a":""},{"n":"湖南城市学院","d":"","p":"湖南·益阳","a":""},{"n":"湖南工学院","d":"","p":"湖南·衡阳","a":""},{"n":"湖南财政经济学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南警察学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南工业大学","d":"hut.edu.cn","p":"湖南·株洲","a":""},{"n":"湖南女子学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南第一师范学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南医药学院","d":"","p":"湖南·怀化","a":""},{"n":"长沙工业学院","d":"","p":"湖南·长沙","a":""},{"n":"长沙师范学院","d":"","p":"湖南·长沙","a":""},{"n":"湖南化工职业技术大学","d":"","p":"湖南·株洲","a":""},{"n":"湖南工艺美术职业大学","d":"","p":"湖南·益阳","a":""},{"n":"湖南汽车工程职业大学","d":"","p":"湖南·株洲","a":""},{"n":"中山大学","d":"sysu.edu.cn","p":"广东·广州","a":"中大 sysu"},{"n":"暨南大学","d":"jnu.edu.cn","p":"广东·广州","a":"暨大 jnu"},{"n":"汕头大学","d":"stu.edu.cn","p":"广东·汕头","a":""},{"n":"华南理工大学","d":"scut.edu.cn","p":"广东·广州","a":"华工 scut"},{"n":"华南农业大学","d":"scau.edu.cn","p":"广东·广州","a":"华农 scau"},{"n":"广东海洋大学","d":"gdou.edu.cn","p":"广东·湛江","a":""},{"n":"广州医科大学","d":"","p":"广东·广州","a":""},{"n":"广东医科大学","d":"","p":"广东·湛江","a":""},{"n":"广州中医药大学","d":"","p":"广东·广州","a":""},{"n":"广东药科大学","d":"","p":"广东·广州","a":""},{"n":"华南师范大学","d":"scnu.edu.cn","p":"广东·广州","a":"华师 scnu"},{"n":"韶关学院","d":"","p":"广东·韶关","a":""},{"n":"惠州学院","d":"","p":"广东·惠州","a":""},{"n":"韩山师范学院","d":"","p":"广东·潮州","a":""},{"n":"岭南师范学院","d":"","p":"广东·湛江","a":""},{"n":"肇庆学院","d":"","p":"广东·肇庆","a":""},{"n":"嘉应学院","d":"","p":"广东·梅州","a":""},{"n":"广州体育学院","d":"","p":"广东·广州","a":""},{"n":"广州美术学院","d":"","p":"广东·广州","a":""},{"n":"星海音乐学院","d":"","p":"广东·广州","a":""},{"n":"广东技术师范大学","d":"","p":"广东·广州","a":""},{"n":"深圳大学","d":"szu.edu.cn","p":"广东·深圳","a":"深大 szu"},{"n":"广东财经大学","d":"gdufe.edu.cn","p":"广东·广州","a":""},{"n":"广州大学","d":"gzhu.edu.cn","p":"广东·广州","a":"广大 gzhu"},{"n":"广州航海学院","d":"","p":"广东·广州","a":""},{"n":"广东警官学院","d":"","p":"广东·广州","a":""},{"n":"仲恺农业工程学院","d":"","p":"广东·广州","a":""},{"n":"五邑大学","d":"","p":"广东·江门","a":""},{"n":"广东金融学院","d":"","p":"广东·广州","a":""},{"n":"广东石油化工学院","d":"","p":"广东·茂名","a":""},{"n":"东莞理工学院","d":"","p":"广东·东莞","a":""},{"n":"广东工业大学","d":"gdut.edu.cn","p":"广东·广州","a":"广工 gdut"},{"n":"广东外语外贸大学","d":"gdufs.edu.cn","p":"广东·广州","a":""},{"n":"佛山大学","d":"","p":"广东·佛山","a":""},{"n":"南方医科大学","d":"smu.edu.cn","p":"广东·广州","a":""},{"n":"广东第二师范学院","d":"","p":"广东·广州","a":""},{"n":"南方科技大学","d":"sustech.edu.cn","p":"广东·深圳","a":"南科大 sustech"},{"n":"深圳技术大学","d":"sztu.edu.cn","p":"广东·深圳","a":""},{"n":"顺德职业技术大学","d":"","p":"广东·佛山","a":""},{"n":"广东轻工职业技术大学","d":"","p":"广东·广州","a":""},{"n":"深圳职业技术大学","d":"","p":"广东·深圳","a":""},{"n":"广州职业技术大学","d":"","p":"广东·广州","a":""},{"n":"深圳信息职业技术大学","d":"","p":"广东·深圳","a":""},{"n":"肇庆医学院","d":"","p":"广东·肇庆","a":""},{"n":"广西大学","d":"gxu.edu.cn","p":"广西·南宁","a":"西大 gxu"},{"n":"广西科技大学","d":"","p":"广西·柳州","a":""},{"n":"桂林电子科技大学","d":"guet.edu.cn","p":"广西·桂林","a":"桂电 guet"},{"n":"桂林理工大学","d":"glut.edu.cn","p":"广西·桂林","a":""},{"n":"广西医科大学","d":"gxmu.edu.cn","p":"广西·南宁","a":""},{"n":"右江民族医学院","d":"","p":"广西·百色","a":""},{"n":"广西中医药大学","d":"","p":"广西·南宁","a":""},{"n":"桂林医科大学","d":"","p":"广西·桂林","a":""},{"n":"广西师范大学","d":"gxnu.edu.cn","p":"广西·桂林","a":"广师大 gxnu"},{"n":"南宁师范大学","d":"","p":"广西·南宁","a":""},{"n":"广西民族师范学院","d":"","p":"广西·崇左","a":""},{"n":"河池学院","d":"","p":"广西·河池","a":""},{"n":"玉林师范学院","d":"","p":"广西·玉林","a":""},{"n":"广西艺术学院","d":"","p":"广西·南宁","a":""},{"n":"广西民族大学","d":"","p":"广西·南宁","a":""},{"n":"百色学院","d":"","p":"广西·百色","a":""},{"n":"梧州学院","d":"","p":"广西·梧州","a":""},{"n":"广西科技师范学院","d":"","p":"广西·来宾","a":""},{"n":"广西财经学院","d":"","p":"广西·南宁","a":""},{"n":"北部湾大学","d":"","p":"广西·钦州","a":""},{"n":"桂林航天工业学院","d":"","p":"广西·桂林","a":""},{"n":"桂林旅游学院","d":"","p":"广西·桂林","a":""},{"n":"贺州学院","d":"","p":"广西·贺州","a":""},{"n":"广西警察学院","d":"","p":"广西·南宁","a":""},{"n":"广西农业职业技术大学","d":"","p":"广西·南宁","a":""},{"n":"广西工业学院","d":"","p":"广西·北海","a":""},{"n":"广西职业师范学院","d":"","p":"广西·南宁","a":""},{"n":"南宁职业技术大学","d":"","p":"广西·南宁","a":""},{"n":"桂林师范学院","d":"","p":"广西·桂林","a":""},{"n":"广西职业技术大学","d":"","p":"广西·南宁","a":""},{"n":"柳州职业技术大学","d":"","p":"广西·柳州","a":""},{"n":"海南大学","d":"hainanu.edu.cn","p":"海南·海口","a":"海大 hainanu"},{"n":"海南热带海洋学院","d":"","p":"海南·三亚","a":""},{"n":"海南师范大学","d":"","p":"海南·海口","a":""},{"n":"海南医科大学","d":"","p":"海南·海口","a":""},{"n":"琼台师范学院","d":"","p":"海南·海口","a":""},{"n":"海南经贸职业大学","d":"","p":"海南·海口","a":""},{"n":"重庆大学","d":"cqu.edu.cn","p":"重庆","a":"重大 cqu"},{"n":"重庆邮电大学","d":"cqupt.edu.cn","p":"重庆","a":"重邮 cqupt"},{"n":"重庆交通大学","d":"cqjtu.edu.cn","p":"重庆","a":""},{"n":"重庆医科大学","d":"cqmu.edu.cn","p":"重庆","a":"重医 cqmu"},{"n":"西南大学","d":"swu.edu.cn","p":"重庆","a":"西大 swu"},{"n":"重庆师范大学","d":"cqnu.edu.cn","p":"重庆","a":"重师 cqnu"},{"n":"重庆文理学院","d":"","p":"重庆","a":""},{"n":"重庆三峡科技大学","d":"","p":"重庆","a":""},{"n":"长江师范学院","d":"","p":"重庆","a":""},{"n":"四川外国语大学","d":"","p":"重庆","a":""},{"n":"西南政法大学","d":"swupl.edu.cn","p":"重庆","a":"西政 swupl"},{"n":"四川美术学院","d":"","p":"重庆","a":""},{"n":"重庆科技大学","d":"","p":"重庆","a":""},{"n":"重庆理工大学","d":"cqut.edu.cn","p":"重庆","a":""},{"n":"重庆工商大学","d":"ctbu.edu.cn","p":"重庆","a":""},{"n":"重庆警察学院","d":"","p":"重庆","a":""},{"n":"重庆第二师范学院","d":"","p":"重庆","a":""},{"n":"重庆工业职业技术大学","d":"","p":"重庆","a":""},{"n":"重庆电子科技职业大学","d":"","p":"重庆","a":""},{"n":"重庆城市管理职业大学","d":"","p":"重庆","a":""},{"n":"重庆工程职业技术大学","d":"","p":"重庆","a":""},{"n":"四川大学","d":"scu.edu.cn","p":"四川·成都","a":"川大 scu"},{"n":"西南交通大学","d":"swjtu.edu.cn","p":"四川·成都","a":"西南交大 swjtu"},{"n":"电子科技大学","d":"uestc.edu.cn","p":"四川·成都","a":"成电 uestc"},{"n":"西南石油大学","d":"swpu.edu.cn","p":"四川·成都","a":""},{"n":"成都理工大学","d":"cdut.edu.cn","p":"四川·成都","a":"成理 cdut"},{"n":"西南科技大学","d":"swust.edu.cn","p":"四川·绵阳","a":""},{"n":"成都信息工程大学","d":"cuit.edu.cn","p":"四川·成都","a":""},{"n":"四川轻化工大学","d":"","p":"四川·自贡","a":""},{"n":"西华大学","d":"xhu.edu.cn","p":"四川·成都","a":""},{"n":"中国民用航空飞行学院","d":"","p":"四川·德阳","a":""},{"n":"四川农业大学","d":"sicau.edu.cn","p":"四川·雅安","a":"川农 sicau"},{"n":"西昌学院","d":"","p":"四川·凉山","a":""},{"n":"西南医科大学","d":"","p":"四川·泸州","a":""},{"n":"成都中医药大学","d":"","p":"四川·成都","a":""},{"n":"川北医学院","d":"","p":"四川·南充","a":""},{"n":"四川师范大学","d":"sicnu.edu.cn","p":"四川·成都","a":"川师 sicnu"},{"n":"西华师范大学","d":"","p":"四川·南充","a":""},{"n":"绵阳师范学院","d":"","p":"四川·绵阳","a":""},{"n":"内江师范学院","d":"","p":"四川·内江","a":""},{"n":"宜宾学院","d":"","p":"四川·宜宾","a":""},{"n":"四川文理学院","d":"","p":"四川·达州","a":""},{"n":"阿坝师范学院","d":"","p":"四川·阿坝","a":""},{"n":"乐山师范学院","d":"","p":"四川·乐山","a":""},{"n":"西南财经大学","d":"swufe.edu.cn","p":"四川·成都","a":"西财 swufe"},{"n":"成都体育学院","d":"","p":"四川·成都","a":""},{"n":"四川音乐学院","d":"","p":"四川·成都","a":""},{"n":"西南民族大学","d":"","p":"四川·成都","a":""},{"n":"成都大学","d":"","p":"四川·成都","a":""},{"n":"成都工业学院","d":"","p":"四川·成都","a":""},{"n":"攀枝花学院","d":"","p":"四川·攀枝花","a":""},{"n":"四川旅游学院","d":"","p":"四川·成都","a":""},{"n":"四川民族学院","d":"","p":"四川·甘孜","a":""},{"n":"四川警察学院","d":"","p":"四川·泸州","a":""},{"n":"成都医学院","d":"","p":"四川·成都","a":""},{"n":"成都师范学院","d":"","p":"四川·成都","a":""},{"n":"成都轻工职业技术大学","d":"","p":"四川·成都","a":""},{"n":"成都航空职业技术大学","d":"","p":"四川·成都","a":""},{"n":"四川交通职业技术大学","d":"","p":"四川·成都","a":""},{"n":"四川工程职业技术大学","d":"","p":"四川·德阳","a":""},{"n":"四川建筑职业技术大学","d":"","p":"四川·德阳","a":""},{"n":"贵州大学","d":"gzu.edu.cn","p":"贵州·贵阳","a":"贵大 gzu"},{"n":"贵州医科大学","d":"","p":"贵州·贵阳","a":""},{"n":"遵义医科大学","d":"","p":"贵州·遵义","a":""},{"n":"贵州中医药大学","d":"","p":"贵州·贵阳","a":""},{"n":"贵州师范大学","d":"gznu.edu.cn","p":"贵州·贵阳","a":"贵师大 gznu"},{"n":"遵义师范学院","d":"","p":"贵州·遵义","a":""},{"n":"铜仁学院","d":"","p":"贵州·铜仁","a":""},{"n":"兴义民族师范学院","d":"","p":"贵州·黔西南","a":""},{"n":"安顺学院","d":"","p":"贵州·安顺","a":""},{"n":"贵州工程应用技术学院","d":"","p":"贵州·毕节","a":""},{"n":"凯里学院","d":"","p":"贵州·黔东南","a":""},{"n":"黔南民族师范学院","d":"","p":"贵州·黔南","a":""},{"n":"贵州财经大学","d":"","p":"贵州·贵阳","a":""},{"n":"贵州民族大学","d":"","p":"贵州·贵阳","a":""},{"n":"贵阳学院","d":"","p":"贵州·贵阳","a":""},{"n":"六盘水师范学院","d":"","p":"贵州·六盘水","a":""},{"n":"贵州商学院","d":"","p":"贵州·贵阳","a":""},{"n":"贵州警察学院","d":"","p":"贵州·贵阳","a":""},{"n":"贵阳康养职业大学","d":"","p":"贵州·贵阳","a":""},{"n":"贵州师范学院","d":"","p":"贵州·贵阳","a":""},{"n":"贵州理工学院","d":"","p":"贵州·贵阳","a":""},{"n":"贵州交通职业大学","d":"","p":"贵州·贵阳","a":""},{"n":"贵州工业职业技术大学","d":"","p":"贵州·贵阳","a":""},{"n":"铜仁职业技术大学","d":"","p":"贵州·铜仁","a":""},{"n":"贵州轻工职业大学","d":"","p":"贵州·贵阳","a":""},{"n":"云南大学","d":"ynu.edu.cn","p":"云南·昆明","a":"云大 ynu"},{"n":"昆明理工大学","d":"kust.edu.cn","p":"云南·昆明","a":"昆工 kust"},{"n":"云南农业大学","d":"","p":"云南·昆明","a":""},{"n":"西南林业大学","d":"swfu.edu.cn","p":"云南·昆明","a":""},{"n":"昆明医科大学","d":"kmmu.edu.cn","p":"云南·昆明","a":""},{"n":"大理大学","d":"","p":"云南·大理","a":""},{"n":"云南中医药大学","d":"","p":"云南·昆明","a":""},{"n":"云南师范大学","d":"ynnu.edu.cn","p":"云南·昆明","a":"云师 ynnu"},{"n":"昭通学院","d":"","p":"云南·昭通","a":""},{"n":"曲靖师范学院","d":"","p":"云南·曲靖","a":""},{"n":"普洱学院","d":"","p":"云南·普洱","a":""},{"n":"保山学院","d":"","p":"云南·保山","a":""},{"n":"红河学院","d":"","p":"云南·红河","a":""},{"n":"云南财经大学","d":"","p":"云南·昆明","a":""},{"n":"云南艺术学院","d":"","p":"云南·昆明","a":""},{"n":"云南民族大学","d":"","p":"云南·昆明","a":""},{"n":"玉溪师范学院","d":"","p":"云南·玉溪","a":""},{"n":"楚雄师范学院","d":"","p":"云南·楚雄","a":""},{"n":"云南警官学院","d":"","p":"云南·昆明","a":""},{"n":"昆明学院","d":"","p":"云南·昆明","a":""},{"n":"文山学院","d":"","p":"云南·文山","a":""},{"n":"滇西科技师范学院","d":"","p":"云南·临沧","a":""},{"n":"滇西应用技术大学","d":"","p":"云南·大理","a":""},{"n":"昆明冶金职业大学","d":"","p":"云南·昆明","a":""},{"n":"云南交通职业技术大学","d":"","p":"云南·昆明","a":""},{"n":"曲靖健康医学院","d":"","p":"云南·曲靖","a":""},{"n":"丽江师范学院","d":"","p":"云南·丽江","a":""},{"n":"德宏师范学院","d":"","p":"云南·德宏","a":""},{"n":"西藏农牧大学","d":"","p":"西藏·林芝","a":""},{"n":"西藏大学","d":"utibet.edu.cn","p":"西藏·拉萨","a":"藏大 utibet"},{"n":"西藏民族大学","d":"xzmu.edu.cn","p":"陕西·咸阳","a":"西民大 xzmu"},{"n":"西藏藏医药大学","d":"","p":"西藏·拉萨","a":""},{"n":"拉萨师范学院","d":"","p":"西藏·拉萨","a":""},{"n":"西北大学","d":"nwu.edu.cn","p":"陕西·西安","a":"西大 nwu"},{"n":"西安交通大学","d":"xjtu.edu.cn","p":"陕西·西安","a":"西交 xjtu"},{"n":"西北工业大学","d":"nwpu.edu.cn","p":"陕西·西安","a":"西工大 nwpu"},{"n":"西安理工大学","d":"xaut.edu.cn","p":"陕西·西安","a":"西理工 xaut"},{"n":"西安电子科技大学","d":"xidian.edu.cn","p":"陕西·西安","a":"西电 xidian"},{"n":"西安工业大学","d":"xatu.edu.cn","p":"陕西·西安","a":"西工院 xatu"},{"n":"西安建筑科技大学","d":"xauat.edu.cn","p":"陕西·西安","a":"西建大 xauat"},{"n":"西安科技大学","d":"xust.edu.cn","p":"陕西·西安","a":"西科大 xust"},{"n":"西安石油大学","d":"xsyu.edu.cn","p":"陕西·西安","a":"西石大 xsyu"},{"n":"陕西科技大学","d":"sust.edu.cn","p":"陕西·西安","a":"陕科大 sust"},{"n":"西安工程大学","d":"xpu.edu.cn","p":"陕西·西安","a":"西工程 xpu"},{"n":"长安大学","d":"chd.edu.cn","p":"陕西·西安","a":"长大 chd"},{"n":"西北农林科技大学","d":"nwafu.edu.cn","p":"陕西·咸阳","a":"西农 nwafu"},{"n":"陕西中医药大学","d":"sntcm.edu.cn","p":"陕西·咸阳","a":""},{"n":"陕西师范大学","d":"snnu.edu.cn","p":"陕西·西安","a":"陕师大 snnu"},{"n":"延安大学","d":"yau.edu.cn","p":"陕西·延安","a":"延大 yau"},{"n":"陕西理工大学","d":"snut.edu.cn","p":"陕西·汉中","a":"陕理工 snut"},{"n":"宝鸡文理学院","d":"bjwlxy.edu.cn","p":"陕西·宝鸡","a":"宝文理 bjwlxy"},{"n":"咸阳师范学院","d":"xync.edu.cn","p":"陕西·咸阳","a":"咸师 xync"},{"n":"渭南师范学院","d":"wnu.edu.cn","p":"陕西·渭南","a":"渭师 wnu"},{"n":"西安外国语大学","d":"xisu.edu.cn","p":"陕西·西安","a":"西外 xisu"},{"n":"西北政法大学","d":"nwupl.edu.cn","p":"陕西·西安","a":"西法大 nwupl"},{"n":"西安体育学院","d":"xaipe.edu.cn","p":"陕西·西安","a":"西体 xaipe"},{"n":"西安音乐学院","d":"xacom.edu.cn","p":"陕西·西安","a":"西音 xacom"},{"n":"西安美术学院","d":"xafa.edu.cn","p":"陕西·西安","a":"西美 xafa"},{"n":"榆林大学","d":"","p":"陕西·榆林","a":""},{"n":"商洛学院","d":"slxy.cn","p":"陕西·商洛","a":"商洛 slxy"},{"n":"安康学院","d":"aku.edu.cn","p":"陕西·安康","a":"安康 aku"},{"n":"西安财经大学","d":"xaufe.edu.cn","p":"陕西·西安","a":"西财 xaufe"},{"n":"西安邮电大学","d":"xupt.edu.cn","p":"陕西·西安","a":"西邮 xupt"},{"n":"西安航空学院","d":"xaau.edu.cn","p":"陕西·西安","a":""},{"n":"西安医学院","d":"xiyi.edu.cn","p":"陕西·西安","a":"西医 xiyi"},{"n":"陕西学前师范学院","d":"snsy.edu.cn","p":"陕西·西安","a":"陕师院 snsy"},{"n":"陕西工业职业技术大学","d":"sxpi.edu.cn","p":"陕西·咸阳","a":""},{"n":"陕西农林职业技术大学","d":"nwsuaf.edu.cn","p":"陕西·咸阳","a":""},{"n":"陕西警察学院","d":"","p":"陕西·西安","a":""},{"n":"兰州大学","d":"lzu.edu.cn","p":"甘肃·兰州","a":"兰大 lzu"},{"n":"兰州理工大学","d":"lut.edu.cn","p":"甘肃·兰州","a":"兰理工 lut"},{"n":"兰州交通大学","d":"lzjtu.edu.cn","p":"甘肃·兰州","a":"兰交大 lzjtu"},{"n":"甘肃农业大学","d":"","p":"甘肃·兰州","a":""},{"n":"甘肃中医药大学","d":"","p":"甘肃·兰州","a":""},{"n":"西北师范大学","d":"nwnu.edu.cn","p":"甘肃·兰州","a":"西北师大 nwnu"},{"n":"兰州城市学院","d":"","p":"甘肃·兰州","a":""},{"n":"陇东学院","d":"","p":"甘肃·庆阳","a":""},{"n":"天水师范大学","d":"","p":"甘肃·天水","a":""},{"n":"河西学院","d":"","p":"甘肃·张掖","a":""},{"n":"兰州财经大学","d":"","p":"甘肃·兰州","a":""},{"n":"西北民族大学","d":"","p":"甘肃·兰州","a":""},{"n":"甘肃政法大学","d":"","p":"甘肃·兰州","a":""},{"n":"甘肃民族师范学院","d":"","p":"甘肃·甘南","a":""},{"n":"兰州文理学院","d":"","p":"甘肃·兰州","a":""},{"n":"甘肃医学院","d":"","p":"甘肃·平凉","a":""},{"n":"兰州工业学院","d":"","p":"甘肃·兰州","a":""},{"n":"兰州石化职业技术大学","d":"","p":"甘肃·兰州","a":""},{"n":"兰州资源环境职业技术大学","d":"","p":"甘肃·兰州","a":""},{"n":"陇南师范学院","d":"","p":"甘肃·陇南","a":""},{"n":"酒泉职业技术大学","d":"","p":"甘肃·酒泉","a":""},{"n":"甘肃警察学院","d":"","p":"甘肃·兰州","a":""},{"n":"甘肃林业职业技术大学","d":"","p":"甘肃·天水","a":""},{"n":"甘肃工业职业技术大学","d":"","p":"甘肃·天水","a":""},{"n":"武威职业技术大学","d":"","p":"甘肃·武威","a":""},{"n":"青海大学","d":"qhu.edu.cn","p":"青海·西宁","a":"青大 qhu"},{"n":"青海师范大学","d":"","p":"青海·西宁","a":""},{"n":"青海民族大学","d":"","p":"青海·西宁","a":""},{"n":"青海职业技术大学","d":"","p":"青海·西宁","a":""},{"n":"宁夏大学","d":"nxu.edu.cn","p":"宁夏·银川","a":"宁大 nxu"},{"n":"宁夏医科大学","d":"","p":"宁夏·银川","a":""},{"n":"宁夏师范大学","d":"","p":"宁夏·固原","a":""},{"n":"北方民族大学","d":"","p":"宁夏·银川","a":""},{"n":"宁夏职业技术大学","d":"","p":"宁夏·银川","a":""},{"n":"宁夏工商职业技术大学","d":"","p":"宁夏·银川","a":""},{"n":"新疆大学","d":"xju.edu.cn","p":"新疆·乌鲁木齐","a":"新大 xju"},{"n":"塔里木大学","d":"","p":"新疆·阿拉尔","a":""},{"n":"新疆农业大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"石河子大学","d":"shzu.edu.cn","p":"新疆·石河子","a":"石大 shzu"},{"n":"新疆医科大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆师范大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"喀什大学","d":"","p":"新疆·喀什","a":""},{"n":"伊犁师范大学","d":"","p":"新疆·伊犁","a":""},{"n":"新疆财经大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆艺术学院","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆工程学院","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"昌吉学院","d":"","p":"新疆·昌吉","a":""},{"n":"新疆警察学院","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆理工学院","d":"","p":"新疆·阿克苏","a":""},{"n":"新疆第二医学院","d":"","p":"新疆·克拉玛依","a":""},{"n":"新疆科技学院","d":"","p":"新疆·巴音郭楞","a":""},{"n":"新疆政法学院","d":"","p":"新疆·图木舒克","a":""},{"n":"新疆和田学院","d":"","p":"新疆·和田","a":""},{"n":"新疆农业职业技术大学","d":"","p":"新疆·昌吉","a":""},{"n":"乌鲁木齐职业大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆工业职业技术大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"新疆交通职业技术大学","d":"","p":"新疆·乌鲁木齐","a":""},{"n":"石河子职业技术大学","d":"","p":"新疆·石河子","a":""},{"n":"新疆能源铁道职业技术大学","d":"","p":"新疆·哈密","a":""},{"n":"新疆工程职业大学","d":"","p":"新疆·铁门关","a":""},{"n":"空军军医大学","d":"","p":"陕西·西安","a":""},{"n":"重庆中医药学院","d":"","p":"重庆","a":""},{"n":"安徽公安学院","d":"","p":"安徽·合肥","a":""},{"n":"康复大学","d":"","p":"山东·青岛","a":""},{"n":"河南体育学院","d":"","p":"河南·郑州","a":""},{"n":"深圳理工大学","d":"","p":"广东·深圳","a":""},{"n":"青海理工学院","d":"","p":"青海·西宁","a":""},{"n":"新疆工业学院","d":"","p":"新疆·和田","a":""},{"n":"山西医药学院","d":"","p":"山西·吕梁","a":""},{"n":"大湾区大学","d":"","p":"广东·东莞","a":""},{"n":"海南警察学院","d":"","p":"海南·海口","a":""},{"n":"西安戏剧学院","d":"","p":"陕西·西安","a":""},{"n":"新疆理工职业大学","d":"","p":"新疆·喀什","a":""},{"n":"河南信息科技学院","d":"","p":"河南·鹤壁","a":""},{"n":"网络空间安全学院","d":"","p":"湖北·武汉","a":""},{"n":"河南能源化工学院","d":"","p":"河南·濮阳","a":""},{"n":"河南国医学院","d":"","p":"河南·南阳","a":""},{"n":"河南应用工程学院","d":"","p":"河南·三门峡","a":""},{"n":"广安理工学院","d":"","p":"四川·广安","a":""},{"n":"成都美术学院","d":"","p":"四川·资阳","a":""}];

function get_selected_school() {
  try {
    const raw = localStorage.getItem("xz_school_v1");
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.n) return obj;
    }
  } catch {}
  return { n: "西安文理学院", d: "xawl.edu.cn" };
}

function sync_school_ui() {
  const s = get_selected_school();
  const lbl = $("aiSchoolLabel");
  if (lbl) lbl.textContent = s.n;
  const welcomeSub = document.querySelector(".welcome-bubble-head > p, .welcome-card > p");
  if (welcomeSub) {
    if (s.n === "西安文理学院") {
      welcomeSub.textContent = "基于学校正式规章制度与附件模板，为您梳理清晰的办事指南：";
    } else {
      welcomeSub.textContent = `当前已切换至【${s.n}】官网实时检索模式，优先依据该校官网公开文件为您解答：`;
    }
  }
}

function set_selected_school(n, d) {
  try {
    localStorage.setItem("xz_school_v1", JSON.stringify({ n, d: d || "" }));
  } catch {}
  sync_school_ui();
  $("schoolDialog")?.close();
  toast(`已切换检索高校：${n}`);
}

function render_school_list(kw = "") {
  const box = $("schoolList");
  const customBox = $("schoolCustomAction");
  if (!box) return;
  const cur = get_selected_school();
  const q = String(kw || "").trim().toLowerCase();
  const matched = q
    ? PRESET_SCHOOLS.filter(s =>
        s.n.toLowerCase().includes(q) ||
        s.p.toLowerCase().includes(q) ||
        s.a.toLowerCase().includes(q) ||
        s.d.toLowerCase().includes(q)
      )
    : PRESET_SCHOOLS;

  box.innerHTML = matched.slice(0, 120).map(s => {
    const active = cur.n === s.n ? " active" : "";
    return `<button type="button" class="school-item${active}" data-sn="${esc(s.n)}" data-sd="${esc(s.d)}"><span>${esc(s.n)}</span><small>${esc(s.p)}${s.d ? ' · ' + esc(s.d) : ' · 自动匹配官网'}</small></button>`;
  }).join("") || '<div class="empty" style="padding:14px 0">未在内置名录中找到，可点击上方按钮直接使用该校名称检索官网</div>';

  box.querySelectorAll(".school-item").forEach(btn => {
    btn.onclick = () => set_selected_school(btn.dataset.sn, btn.dataset.sd);
  });

  if (customBox) {
    const exact = matched.some(s => s.n === kw.trim());
    if (kw.trim().length >= 2 && !exact) {
      customBox.classList.remove("hide");
      customBox.innerHTML = `<button type="button" id="useCustomSchoolBtn">🔍 直接使用「${esc(kw.trim())}」联网检索官网</button>`;
      $("useCustomSchoolBtn").onclick = () => set_selected_school(kw.trim(), "");
    } else {
      customBox.classList.add("hide");
      customBox.innerHTML = "";
    }
  }
}

$("aiSchoolBtn")?.addEventListener("click", () => {
  const inp = $("schoolSearchInput");
  if (inp) inp.value = "";
  render_school_list("");
  $("schoolDialog")?.showModal();
  setTimeout(() => inp?.focus(), 60);
});
$("closeSchoolDialog")?.addEventListener("click", () => $("schoolDialog")?.close());
$("schoolSearchInput")?.addEventListener("input", e => render_school_list(e.target.value));
sync_school_ui();

/* ---- 模型与思考强度分段胶囊交互逻辑 ---- */
(function init_ai_segmented_controls() {
  function sync_seg_ui(targetId, val) {
    const group = document.querySelector(`.ai-seg[data-seg-target="${targetId}"]`);
    if (!group) return;
    group.querySelectorAll(".ai-seg-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.segVal === val);
    });
  }

  document.querySelectorAll(".ai-seg").forEach(seg => {
    const targetId = seg.dataset.segTarget;
    const sel = $(targetId);
    if (!sel) return;
    const storeKey = "xz_seg_" + targetId;
    try {
      const saved = localStorage.getItem(storeKey);
      if (saved && [...sel.options].some(o => o.value === saved)) {
        sel.value = saved;
      }
    } catch {}
    sync_seg_ui(targetId, sel.value);

    seg.querySelectorAll(".ai-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.segVal;
        sel.value = v;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sync_seg_ui(targetId, v);
        try { localStorage.setItem(storeKey, v); } catch {}
      });
    });
  });
})();

/* ---- 深度思考分段胶囊交互同步 ---- */
(function init_ai_bool_segments() {
  document.querySelectorAll(".ai-seg[data-seg-bool]").forEach(seg => {
    const targetId = seg.dataset.segBool;
    const chk = $(targetId);
    if (!chk) return;
    const storeKey = "xz_seg_" + targetId;
    try {
      const saved = localStorage.getItem(storeKey);
      if (saved === "0" || saved === "1") {
        chk.checked = saved === "1";
      }
    } catch {}
    const sync = () => {
      const val = chk.checked ? "1" : "0";
      seg.querySelectorAll(".ai-seg-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.segVal === val);
      });
    };
    sync();
    seg.querySelectorAll(".ai-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        chk.checked = btn.dataset.segVal === "1";
        chk.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        try { localStorage.setItem(storeKey, chk.checked ? "1" : "0"); } catch {}
      });
    });
  });
})();

/* ---- v50: 全站统一自定义弹窗 (ui_confirm / ui_prompt) 与下拉框 (enhance_selects) ---- */
function ui_confirm(message, opts = {}) {
  return new Promise(resolve => {
    const dlg = $("uiConfirmDialog");
    if (!dlg) return resolve(window.confirm(message));
    $("uiConfirmTitle").textContent = opts.title || "确认操作";
    $("uiConfirmSub").textContent = opts.sub || (opts.danger ? "此操作可能无法撤销，请确认" : "请确认是否继续");
    $("uiConfirmMsg").textContent = message || "";
    const okBtn = $("okUiConfirm");
    okBtn.textContent = opts.okText || (opts.danger ? "确认删除" : "确定");
    okBtn.className = opts.danger ? "danger" : "primary";
    const cancelBtn = $("cancelUiConfirm");
    if (cancelBtn) cancelBtn.textContent = opts.cancelText || "取消";

    let settled = false;
    const done = val => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(val);
    };
    $("closeUiConfirm").onclick = () => done(false);
    $("cancelUiConfirm").onclick = () => done(false);
    okBtn.onclick = () => done(true);
    dlg.oncancel = () => done(false);
    dlg.showModal();
  });
}

function ui_prompt(message, opts = {}) {
  return new Promise(resolve => {
    const dlg = $("uiPromptDialog");
    const form = $("uiPromptForm");
    const inp = $("uiPromptInput");
    if (!dlg || !form || !inp) return resolve(window.prompt(message));

    $("uiPromptTitle").textContent = opts.title || "输入信息";
    $("uiPromptSub").textContent = opts.sub || "填写完成后点击确定";
    $("uiPromptMsg").textContent = message || "";
    inp.type = opts.type || "text";
    inp.placeholder = opts.placeholder || "请输入内容";
    inp.value = opts.defaultValue || "";
    if (opts.minLength) inp.minLength = opts.minLength;
    else inp.removeAttribute("minlength");

    let settled = false;
    const done = val => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(val);
    };
    $("closeUiPrompt").onclick = () => done(null);
    $("cancelUiPrompt").onclick = () => done(null);
    dlg.oncancel = () => done(null);
    form.onsubmit = e => {
      e.preventDefault();
      done(inp.value);
    };
    dlg.showModal();
    setTimeout(() => inp.focus(), 60);
  });
}

function sync_xz_select(sel) {
  const wrap = sel._xzWrap;
  if (!wrap) return;
  const label = wrap.querySelector(".xz-select-val");
  const curOpt = sel.options[sel.selectedIndex] || sel.options[0];
  if (label && curOpt) label.textContent = curOpt.textContent;
  wrap.querySelectorAll(".xz-select-opt").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.val === sel.value);
    const chk = btn.querySelector(".xz-select-check");
    if (chk) chk.style.visibility = btn.dataset.val === sel.value ? "visible" : "hidden";
  });
}

function enhance_selects(root = document) {
  if (!root) return;
  root.querySelectorAll("select:not(.hide):not(.xz-native-select-hidden)").forEach(sel => {
    sel.classList.add("xz-native-select-hidden");
    const wrap = document.createElement("div");
    wrap.className = "xz-select" + (sel.closest(".twocol, form") ? " is-full" : "");
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "xz-select-trigger";
    trigger.disabled = sel.disabled;
    trigger.innerHTML = `<span class="xz-select-val"></span><svg class="xz-select-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

    const menu = document.createElement("div");
    menu.className = "xz-select-menu";

    const rebuildOptions = () => {
      menu.innerHTML = [...sel.options].map(opt =>
        `<button type="button" class="xz-select-opt" data-val="${esc(opt.value)}"><span>${esc(opt.textContent)}</span><svg class="xz-select-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 9.5 17 19 7.5"/></svg></button>`
      ).join("");
      menu.querySelectorAll(".xz-select-opt").forEach(optBtn => {
        optBtn.onclick = e => {
          e.stopPropagation();
          sel.value = optBtn.dataset.val;
          sync_xz_select(sel);
          wrap.classList.remove("open");
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        };
      });
      sync_xz_select(sel);
    };

    trigger.onclick = e => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains("open");
      document.querySelectorAll(".xz-select.open").forEach(o => o.classList.remove("open"));
      if (willOpen) wrap.classList.add("open");
    };

    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
    sel._xzWrap = wrap;
    rebuildOptions();

    sel.addEventListener("change", () => sync_xz_select(sel));
  });
}

document.addEventListener("click", () => {
  document.querySelectorAll(".xz-select.open").forEach(o => o.classList.remove("open"));
});

enhance_selects(document);

// 监听快捷跳转（如首页点击待办卡片会直接改 taskFilter.value），定时或交互时自动同步
document.querySelectorAll("[data-goto-task]").forEach(b => {
  b.addEventListener("click", () => setTimeout(() => {
    const tf = $("taskFilter");
    if (tf) sync_xz_select(tf);
  }, 20));
});

/* ---- v56: 监听 AI 对话条数，开始聊天后自动收起热门提问条释放空间 ---- */
(function init_ai_has_chat_observer() {
  const msgBox = $("messages");
  if (!msgBox) return;
  const sync = () => {
    const hasUserOrAiMsg = msgBox.querySelectorAll(".msg:not(.ai-welcome-msg)").length > 0;
    document.body.classList.toggle("ai-has-chat", hasUserOrAiMsg);
  };
  sync();
  new MutationObserver(sync).observe(msgBox, { childList: true });
})();

/* ---- v58: 移动端侧边栏遮罩点击关闭与层级同步 ---- */
(function init_sidebar_backdrop() {
  const sb = $("sidebar");
  const bd = $("sidebarBackdrop");
  if (!sb) return;
  const syncOpen = () => {
    document.body.classList.toggle("sidebar-open", sb.classList.contains("open"));
  };
  new MutationObserver(syncOpen).observe(sb, { attributes: true, attributeFilter: ["class"] });
  bd?.addEventListener("click", () => {
    sb.classList.remove("open");
    syncOpen();
  });
})();

/* ---- v1.001: 电脑端侧边栏收起/展开切换与状态记忆 ---- */
(function init_desktop_sidebar_rail() {
  const KEY = "xz_sidebar_collapsed";
  const btn = $("desktopSidebarToggle");
  try {
    if (localStorage.getItem(KEY) === "1") {
      document.body.classList.add("sidebar-collapsed");
    }
  } catch {}
  btn?.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch {}
  });
})();

/* ---- v1.003: 电脑端收起/展开模型选择与热门提问记忆 ---- */
(function init_desktop_ai_panel_toggle() {
  const KEY = "xz_desktop_ai_panel_collapsed";
  const btn = $("toggleAiConfig");
  const syncBtnState = () => {
    if (!btn) return;
    if (window.innerWidth >= 761) {
      const collapsed = document.body.classList.contains("ai-panel-collapsed");
      btn.classList.toggle("added", !collapsed);
      btn.title = collapsed ? "展开模型选择与热门提问" : "收起模型选择与热门提问";
    }
  };
  try {
    if (localStorage.getItem(KEY) === "1") {
      document.body.classList.add("ai-panel-collapsed");
    }
  } catch {}
  syncBtnState();
  btn?.addEventListener("click", () => {
    if (window.innerWidth >= 761) {
      const collapsed = document.body.classList.toggle("ai-panel-collapsed");
      try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch {}
      syncBtnState();
    }
  });
})();

/* ---- v1.007 / v1.107: 全站自定义液态玻璃日历组件 (替换所有静态与动态 <input type="date">) ---- */
(function init_custom_date_pickers() {
  const localTodayStr = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };

  function enhanceDateInput(inp) {
    if (!inp || inp.dataset.xzDateDone) return;
    inp.dataset.xzDateDone = "1";
    inp.classList.add("xz-native-select-hidden");

    const wrap = document.createElement("div");
    wrap.className = "xz-date-wrap";
    const trig = document.createElement("button");
    trig.type = "button";
    trig.className = "xz-date-trigger";
    const pop = document.createElement("div");
    pop.className = "xz-cal-pop";

    const placeholderText = inp.dataset.placeholder || "选择日期（选填）";
    const noClear = inp.dataset.noClear === "1";

    let viewDate = inp.value ? new Date(inp.value + "T00:00:00") : new Date();
    if (Number.isNaN(viewDate.getTime())) viewDate = new Date();

    const syncText = () => {
      if (inp.value) {
        trig.classList.remove("is-empty");
        trig.innerHTML = `<span>${inp.value}</span><svg class="ico ico-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.5h17"/></svg>`;
      } else {
        trig.classList.add("is-empty");
        trig.innerHTML = `<span>${placeholderText}</span><svg class="ico ico-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.5h17"/></svg>`;
      }
    };

    const positionPop = () => {
      const hostRoot = inp.closest("dialog") || document.body;
      if (pop.parentNode !== hostRoot) hostRoot.appendChild(pop);
      pop.style.position = "fixed";
      pop.style.zIndex = "1100";
      pop.style.right = "auto";
      pop.style.bottom = "auto";
      pop.style.transform = "none";
      pop.style.left = "0px";
      pop.style.top = "0px";
      const tr = trig.getBoundingClientRect();
      const pr = pop.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 360;
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const safeBottom = vw <= 760 && !inp.closest("dialog") ? 82 : 14;
      const left = Math.max(12, Math.min(vw - pr.width - 12, tr.left));
      let top = tr.bottom + 6;
      if (top + pr.height > vh - safeBottom && tr.top - pr.height - 6 >= 12) {
        top = tr.top - pr.height - 6;
      } else if (top + pr.height > vh - 12) {
        top = Math.max(12, vh - pr.height - 12);
      }
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(top) + "px";
    };

    const triggerPopUpdate = () => {
      document.querySelectorAll(".xz-cal-pop.open").forEach(p => {
        p.classList.remove("open");
        if (p._ownerInp && !p._ownerInp.isConnected) p.remove();
      });
    };
    pop._ownerInp = inp;

    const closePop = () => {
      pop.classList.remove("open");
      if (wrap.isConnected && pop.parentNode !== wrap) wrap.appendChild(pop);
    };

    const renderCal = () => {
      const y = viewDate.getFullYear(), m = viewDate.getMonth();
      const firstDay = new Date(y, m, 1).getDay();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const todayStr = localTodayStr();
      let cells = ["日", "一", "二", "三", "四", "五", "六"].map(w => `<div class="xz-cal-wd">${w}</div>`).join("");
      for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const cls = ["xz-cal-day", inp.value === ds ? "selected" : "", ds === todayStr ? "today" : ""].filter(Boolean).join(" ");
        cells += `<button type="button" class="${cls}" data-ds="${ds}">${d}</button>`;
      }
      pop.innerHTML = `
        <div class="xz-cal-head">
          <div class="xz-cal-nav-group">
            <button type="button" data-cal-prev-year title="上一年">«</button>
            <button type="button" data-cal-prev title="上一月">‹</button>
          </div>
          <span>${y} 年 ${m + 1} 月</span>
          <div class="xz-cal-nav-group">
            <button type="button" data-cal-next title="下一月">›</button>
            <button type="button" data-cal-next-year title="下一年">»</button>
          </div>
        </div>
        <div class="xz-cal-grid">${cells}</div>
        <div class="xz-cal-foot">
          ${noClear ? `<span></span>` : `<button type="button" data-cal-clear>清空</button>`}
          <button type="button" data-cal-today>今天</button>
        </div>`;

      pop.querySelector("[data-cal-prev-year]").onclick = e => { e.stopPropagation(); viewDate = new Date(y - 1, m, 1); renderCal(); };
      pop.querySelector("[data-cal-prev]").onclick = e => { e.stopPropagation(); viewDate = new Date(y, m - 1, 1); renderCal(); };
      pop.querySelector("[data-cal-next]").onclick = e => { e.stopPropagation(); viewDate = new Date(y, m + 1, 1); renderCal(); };
      pop.querySelector("[data-cal-next-year]").onclick = e => { e.stopPropagation(); viewDate = new Date(y + 1, m, 1); renderCal(); };
      const clrBtn = pop.querySelector("[data-cal-clear]");
      if (clrBtn) {
        clrBtn.onclick = e => { e.stopPropagation(); inp.value = ""; syncText(); closePop(); inp.dispatchEvent(new Event("change", { bubbles: true })); };
      }
      pop.querySelector("[data-cal-today]").onclick = e => { e.stopPropagation(); inp.value = todayStr; syncText(); closePop(); inp.dispatchEvent(new Event("change", { bubbles: true })); };
      pop.querySelectorAll("[data-ds]").forEach(b => {
        b.onclick = e => {
          e.stopPropagation();
          inp.value = b.dataset.ds;
          syncText();
          closePop();
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
      });
    };

    trig.onclick = e => {
      e.stopPropagation();
      const willOpen = !pop.classList.contains("open");
      triggerPopUpdate();
      if (willOpen) {
        if (inp.value) {
          const parsed = new Date(inp.value + "T00:00:00");
          if (!Number.isNaN(parsed.getTime())) viewDate = parsed;
        }
        renderCal();
        pop.classList.add("open");
        positionPop();
      } else {
        closePop();
      }
    };

    pop.addEventListener("click", e => e.stopPropagation());
    inp.addEventListener("change", syncText);
    wrap.appendChild(trig);
    wrap.appendChild(pop);
    inp.parentNode.insertBefore(wrap, inp.nextSibling);
    syncText();
  }

  window.enhance_date_pickers = (root = document) => {
    document.querySelectorAll("body > .xz-cal-pop").forEach(p => {
      if (p._ownerInp && !p._ownerInp.isConnected) p.remove();
    });
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    scope.querySelectorAll('input[type="date"]').forEach(enhanceDateInput);
  };

  window.enhance_date_pickers(document);

  let scanQueued = false;
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(() => {
      if (scanQueued) return;
      scanQueued = true;
      queueMicrotask(() => {
        scanQueued = false;
        window.enhance_date_pickers(document);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.close_all_date_pickers = () => {
    document.querySelectorAll(".xz-cal-pop.open").forEach(p => p.classList.remove("open"));
  };
  document.addEventListener("click", window.close_all_date_pickers);
  window.addEventListener("resize", window.close_all_date_pickers, { passive: true });
  window.addEventListener("scroll", e => {
    if (e.target && e.target.closest && e.target.closest(".xz-cal-pop")) return;
    window.close_all_date_pickers();
  }, { passive: true });
})();

/* ---- v1.009: 移动端阅读器顶部纯符号按钮联动 ---- */
(function init_mobile_doc_top_actions() {
  $("copyDocTextBtnTop")?.addEventListener("click", () => $("copyDocTextBtn")?.click());
  $("askAiDocBtnTop")?.addEventListener("click", () => $("askAiDocBtn")?.click());
  const footUrl = $("docDialogUrl");
  const topUrl = $("docDialogUrlTop");
  if (footUrl && topUrl) {
    new MutationObserver(() => {
      topUrl.href = footUrl.href || "#";
      topUrl.classList.toggle("hide", footUrl.classList.contains("hide"));
    }).observe(footUrl, { attributes: true, attributeFilter: ["href", "class"] });
  }
})();

/* ---- v1.010: 手机端极简阅读器交互（Aa/⋯浮层、滚动标题同步、回到顶部） ---- */
(function init_mobile_doc_v1010() {
  const aaBtn = $("docMobileAaBtn");
  const moreBtn = $("docMobileMoreBtn");
  const aaPop = $("docMobileAaPop");
  const morePop = $("docMobileMorePop");

  const closePops = () => {
    aaPop?.classList.remove("open");
    morePop?.classList.remove("open");
  };

  aaBtn?.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = !aaPop?.classList.contains("open");
    closePops();
    if (willOpen) aaPop?.classList.add("open");
  });

  moreBtn?.addEventListener("click", e => {
    e.stopPropagation();
    const willOpen = !morePop?.classList.contains("open");
    closePops();
    if (willOpen) morePop?.classList.add("open");
  });

  document.addEventListener("click", closePops);
  $("docMobileClose")?.addEventListener("click", () => { closePops(); $("closeDocDialog")?.click(); });
  $("docMobileAiBtn")?.addEventListener("click", () => { closePops(); $("askAiDocBtn")?.click(); });
  $("docMobileOutlineBtn")?.addEventListener("click", () => { closePops(); $("docOutlineToggle")?.click(); });
  $("docMobileCopyBtn")?.addEventListener("click", () => { closePops(); $("copyDocTextBtn")?.click(); });

  document.querySelectorAll("[data-m-font]").forEach(b => {
    b.addEventListener("click", e => {
      e.stopPropagation();
      const target = document.querySelector(`.doc-font-group button[data-font="${b.dataset.mFont}"]`);
      target?.click();
    });
  });

  // 同步官网原文链接 & 标题/标签到滚动区顶部
  const footUrl = $("docDialogUrl");
  const mUrl = $("docMobileUrlBtn");
  if (footUrl && mUrl) {
    new MutationObserver(() => {
      mUrl.href = footUrl.href || "#";
      mUrl.classList.toggle("hide", footUrl.classList.contains("hide"));
    }).observe(footUrl, { attributes: true, attributeFilter: ["href", "class"] });
  }

  const syncHero = () => {
    const titleEl = $("docDialogTitle");
    const mTitle = $("docMobileHeroTitle");
    const mMeta = $("docMobileHeroMeta");
    const badges = document.querySelector("#docDialog .doc-dialog-badges");
    if (titleEl && mTitle) mTitle.textContent = titleEl.textContent || "";
    if (badges && mMeta) mMeta.innerHTML = badges.innerHTML;
  };
  const titleEl = $("docDialogTitle");
  if (titleEl) {
    new MutationObserver(syncHero).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // 回到顶部按钮
  const sc = $("docReaderScroll");
  const backTop = $("docBackTopBtn");
  if (sc && backTop) {
    sc.addEventListener("scroll", () => {
      backTop.classList.toggle("show", sc.scrollTop > 260);
    }, { passive: true });
    backTop.addEventListener("click", () => sc.scrollTo({ top: 0, behavior: "smooth" }));
  }
})();



// ==================== 超级课表模块（v1.036） ====================
const SCHED_TIMES = {
  winter: {
    label: "秋冬季作息",
    range: "10月1日 – 4月30日",
    rows: [
      { n: "预备", t: "07:50" },
      { n: "第一节", t: "08:00 – 08:50" },
      { n: "第二节", t: "09:00 – 09:50" },
      { n: "课间操", t: "09:50 – 10:10", br: true },
      { n: "第三节", t: "10:10 – 11:00" },
      { n: "第四节", t: "11:10 – 12:00" },
      { n: "午餐午休", t: "12:00 – 13:50", br: true },
      { n: "预备", t: "13:50", br: true },
      { n: "第五节", t: "14:00 – 14:50" },
      { n: "第六节", t: "15:00 – 15:50" },
      { n: "课间操", t: "15:50 – 16:10", br: true },
      { n: "第七节", t: "16:10 – 17:00" },
      { n: "第八节", t: "17:10 – 18:00" },
      { n: "晚餐", t: "18:00 – 19:00", br: true },
      { n: "第九节", t: "19:00 – 19:50" },
      { n: "第十节", t: "20:00 – 20:50" },
      { n: "熄灯", t: "22:00", br: true }
    ],
    periods: [
      { n: 1, s: "08:00", e: "08:50" }, { n: 2, s: "09:00", e: "09:50" },
      { n: 3, s: "10:10", e: "11:00" }, { n: 4, s: "11:10", e: "12:00" },
      { n: 5, s: "14:00", e: "14:50" }, { n: 6, s: "15:00", e: "15:50" },
      { n: 7, s: "16:10", e: "17:00" }, { n: 8, s: "17:10", e: "18:00" },
      { n: 9, s: "19:00", e: "19:50" }, { n: 10, s: "20:00", e: "20:50" }
    ]
  },
  summer: {
    label: "春夏季作息",
    range: "5月1日 – 9月30日",
    rows: [
      { n: "预备", t: "07:50" },
      { n: "第一节", t: "08:00 – 08:50" },
      { n: "第二节", t: "09:00 – 09:50" },
      { n: "课间操", t: "09:50 – 10:10", br: true },
      { n: "第三节", t: "10:10 – 11:00" },
      { n: "第四节", t: "11:10 – 12:00" },
      { n: "午餐午休", t: "12:00 – 14:20", br: true },
      { n: "预备", t: "14:20", br: true },
      { n: "第五节", t: "14:30 – 15:20" },
      { n: "第六节", t: "15:30 – 16:20" },
      { n: "课间操", t: "16:20 – 16:40", br: true },
      { n: "第七节", t: "16:40 – 17:30" },
      { n: "第八节", t: "17:40 – 18:30" },
      { n: "晚餐", t: "18:30 – 19:30", br: true },
      { n: "第九节", t: "19:30 – 20:20" },
      { n: "第十节", t: "20:30 – 21:20" },
      { n: "熄灯", t: "22:30", br: true }
    ],
    periods: [
      { n: 1, s: "08:00", e: "08:50" }, { n: 2, s: "09:00", e: "09:50" },
      { n: 3, s: "10:10", e: "11:00" }, { n: 4, s: "11:10", e: "12:00" },
      { n: 5, s: "14:30", e: "15:20" }, { n: 6, s: "15:30", e: "16:20" },
      { n: 7, s: "16:40", e: "17:30" }, { n: 8, s: "17:40", e: "18:30" },
      { n: 9, s: "19:30", e: "20:20" }, { n: 10, s: "20:30", e: "21:20" }
    ]
  }
};

const SCHED_TYPE_COLOR = {
  "理论": "var(--sc-theory, #2563eb)",
  "实验": "var(--sc-lab, #10b981)",
  "上机": "var(--sc-pc, #f59e0b)",
  "线上": "var(--sc-online, #06b6d4)",
  "体育": "var(--sc-sport, #ef4444)",
  "其他": "var(--sc-other, #7c3aed)"
};
const SCHED_DAY_NAMES = ["", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
const SCHED_DAY_SHORT = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SCHED_BLOCKS = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]];

const schedState = {
  startDate: "2026-08-31",
  totalWeeks: 18,
  courses: [],
  selectedWeek: 1,
  selectedDay: 1,
  mobTab: "today",
  editingIdx: -1,
  bound: false,
  saveTimer: null,
  lastMin: -1,
  isScrolling: false,
  scrollTimer: null
};

function schedEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function schedPad(n) { return n < 10 ? "0" + n : "" + n; }
function schedToMin(t) {
  const parts = String(t || "0:0").split(":").map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}
function schedFmtDate(d) {
  return d.getFullYear() + "-" + schedPad(d.getMonth() + 1) + "-" + schedPad(d.getDate());
}
function schedFmtShort(d) { return (d.getMonth() + 1) + "月" + d.getDate() + "日"; }
function schedStartOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function schedAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function schedParseDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(str || ""))
    ? new Date(str + "T00:00:00")
    : new Date("2026-08-31T00:00:00");
}
function schedGetWeekNumber(date, startStr) {
  const s = schedStartOfDay(schedParseDate(startStr));
  const diff = Math.round((schedStartOfDay(date) - s) / 86400000);
  return diff < 0 ? 0 : Math.floor(diff / 7) + 1;
}
function schedGetDateOf(weekNo, dayOfWeek, startStr) {
  return schedAddDays(schedParseDate(startStr), (weekNo - 1) * 7 + (dayOfWeek - 1));
}
function schedGetSeason(date) {
  const m = date.getMonth() + 1;
  return (m >= 5 && m <= 9) ? "summer" : "winter";
}
function schedSeasonHtml(seasonKey, short) {
  const isW = seasonKey === "winter";
  const ico = isW ? "#i-snowflake" : "#i-sun";
  const txt = short ? (isW ? "秋冬季" : "春夏季") : SCHED_TIMES[seasonKey].label;
  return `<svg class="ico" aria-hidden="true"><use href="${ico}"/></svg><span>${txt}</span>`;
}
function schedParseWeeks(str) {
  const set = new Set();
  if (!str) return set;
  for (let p of String(str).split(/[,，、]/)) {
    p = p.trim();
    if (!p) continue;
    let m;
    if ((m = p.match(/^(\d+)\s*[-–~]\s*(\d+)\s*[（(]\s*单\s*[）)]$/))) {
      for (let w = +m[1]; w <= +m[2]; w++) if (w % 2 === 1) set.add(w);
    } else if ((m = p.match(/^(\d+)\s*[-–~]\s*(\d+)\s*[（(]\s*双\s*[）)]$/))) {
      for (let w = +m[1]; w <= +m[2]; w++) if (w % 2 === 0) set.add(w);
    } else if ((m = p.match(/^(\d+)\s*[-–~]\s*(\d+)$/))) {
      for (let w = +m[1]; w <= +m[2]; w++) set.add(w);
    } else if (/^\d+$/.test(p)) {
      set.add(+p);
    }
  }
  return set;
}
function schedCacheKey() {
  return "xz_sched_v1_" + (me?.id || "guest");
}
function schedSetSyncLabel(text, saving) {
  const el = $("schedSyncBadge");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-saving", !!saving);
}
function schedSaveLocal() {
  try {
    localStorage.setItem(schedCacheKey(), JSON.stringify({
      start_date: schedState.startDate,
      total_weeks: schedState.totalWeeks,
      courses: schedState.courses
    }));
  } catch {}
}
function schedQueueSync() {
  schedSaveLocal();
  schedSetSyncLabel("正在同步…", true);
  clearTimeout(schedState.saveTimer);
  schedState.saveTimer = setTimeout(async () => {
    try {
      await api("/schedule", {
        method: "PUT",
        body: JSON.stringify({
          start_date: schedState.startDate,
          total_weeks: schedState.totalWeeks,
          courses: schedState.courses
        })
      });
      schedSetSyncLabel("已同步云端", false);
    } catch {
      schedSetSyncLabel("仅本地缓存", false);
    }
  }, 450);
}

async function load_schedule() {
  bind_schedule_events();
  // 先读本地缓存避免白屏
  try {
    const raw = localStorage.getItem(schedCacheKey());
    if (raw) {
      const d = JSON.parse(raw);
      if (d.start_date) schedState.startDate = d.start_date;
      if (d.total_weeks) schedState.totalWeeks = Number(d.total_weeks) || 18;
      if (Array.isArray(d.courses)) schedState.courses = d.courses;
    }
  } catch {}

  try {
    const remote = await api("/schedule");
    if (remote && Array.isArray(remote.courses)) {
      schedState.startDate = remote.start_date || schedState.startDate;
      schedState.totalWeeks = Number(remote.total_weeks) || 18;
      schedState.courses = remote.courses;
      schedSaveLocal();
      schedSetSyncLabel("已同步云端", false);
    }
  } catch {
    schedSetSyncLabel("离线缓存", false);
  }

  const now = new Date();
  const w = schedGetWeekNumber(now, schedState.startDate);
  schedState.selectedWeek = Math.max(1, Math.min(schedState.totalWeeks, w || 1));
  schedState.selectedDay = now.getDay() || 7;
  render_home_schedule_strip();
  if (cur_page === "schedule") render_schedule_all();
}

function schedCoursesOfDay(weekNo, day) {
  return schedState.courses
    .map((c, i) => ({ ...c, _idx: i }))
    .filter(c => Number(c.day) === day && schedParseWeeks(c.weeks).has(weekNo))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function schedBuildHeroHtml(now, dayCourses, weekNo, day, isToday) {
  const tagText = `第 ${weekNo} 周 · ${SCHED_DAY_NAMES[day]}`;
  const targetDate = schedGetDateOf(weekNo, day, schedState.startDate);
  const periods = SCHED_TIMES[schedGetSeason(targetDate)].periods;

  if (!dayCourses.length) {
    return {
      empty: true,
      html: `<div class="sched-hero-tag"><span class="dot"></span>${tagText}</div>
        <h3 class="sched-hero-title">${isToday ? "今天没有安排课程" : "这一天没有安排课程"}</h3>
        <div class="sched-hero-meta"><span><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg>${schedState.courses.length ? "适合自习、阅读或适当运动" : "点击“添加课程”录入你的课表"}</span></div>`
    };
  }

  if (!isToday) {
    const first = dayCourses[0];
    const s = periods.find(p => p.n === Number(first.start));
    const e = periods.find(p => p.n === Number(first.end));
    return {
      empty: false,
      html: `<div class="sched-hero-tag"><span class="dot"></span>${tagText}</div>
        <h3 class="sched-hero-title">${schedEsc(first.name)}</h3>
        <div class="sched-hero-meta">
          <span><svg class="ico" aria-hidden="true"><use href="#i-user"/></svg>${schedEsc(first.teacher || "未填教师")}</span>
          <span><svg class="ico" aria-hidden="true"><use href="#i-map-pin"/></svg>${schedEsc(first.room || "未填地点")}</span>
        </div>
        <div class="sched-hero-count">
          <span class="unit">当日共 ${dayCourses.length} 门课程</span>
          ${s && e ? `<span class="sched-hero-endtime"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>首节 ${s.s} – ${e.e}</span>` : ""}
        </div>`
    };
  }

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const items = [];
  for (const c of dayCourses) {
    const s = periods.find(p => p.n === Number(c.start));
    const e = periods.find(p => p.n === Number(c.end));
    if (s && e) items.push({ c, sMin: schedToMin(s.s), eMin: schedToMin(e.e), sText: s.s, eText: e.e });
  }
  items.sort((a, b) => a.sMin - b.sMin);
  let cur = null, next = null;
  for (const it of items) {
    if (nowMin >= it.sMin && nowMin < it.eMin) { cur = it; break; }
    if (nowMin < it.sMin && !next) next = it;
  }

  if (cur) {
    const pct = Math.min(100, Math.max(2, ((nowMin - cur.sMin) / (cur.eMin - cur.sMin)) * 100)).toFixed(1);
    return {
      empty: false,
      html: `<div class="sched-hero-tag"><span class="dot"></span>正在上课 · ${tagText}</div>
        <h3 class="sched-hero-title">${schedEsc(cur.c.name)}</h3>
        <div class="sched-hero-meta">
          <span><svg class="ico" aria-hidden="true"><use href="#i-user"/></svg>${schedEsc(cur.c.teacher || "—")}</span>
          <span><svg class="ico" aria-hidden="true"><use href="#i-map-pin"/></svg>${schedEsc(cur.c.room || "—")}</span>
        </div>
        <div class="sched-hero-count">
          <span class="num">${cur.eMin - nowMin}</span>
          <span class="unit">分钟后下课</span>
          <span class="sched-hero-endtime"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>${cur.eText} 下课</span>
        </div>
        <div class="sched-hero-progress"><i style="width:${pct}%"></i></div>`
    };
  }

  if (next) {
    return {
      empty: false,
      html: `<div class="sched-hero-tag"><span class="dot"></span>下一节 · ${tagText}</div>
        <h3 class="sched-hero-title">${schedEsc(next.c.name)}</h3>
        <div class="sched-hero-meta">
          <span><svg class="ico" aria-hidden="true"><use href="#i-user"/></svg>${schedEsc(next.c.teacher || "—")}</span>
          <span><svg class="ico" aria-hidden="true"><use href="#i-map-pin"/></svg>${schedEsc(next.c.room || "—")}</span>
        </div>
        <div class="sched-hero-count">
          <span class="num">${next.sMin - nowMin}</span>
          <span class="unit">分钟后上课</span>
          <span class="sched-hero-endtime"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg>${next.sText} – ${next.eText}</span>
        </div>`
    };
  }

  return {
    empty: false,
    html: `<div class="sched-hero-tag"><span class="dot"></span>${tagText}</div>
      <h3 class="sched-hero-title">今日课程已全部结束</h3>
      <div class="sched-hero-meta"><span><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg>今日共完成 ${items.length} 门课程，好好休息</span></div>`
  };
}

function schedBuildTimelineNodes(courses, now, weekNo, day, isToday) {
  if (!courses.length) {
    const emptyHint = !schedState.courses.length
      ? `<div class="sched-empty-actions">
           <button type="button" class="sched-btn-primary" data-empty-act="add"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg><span>添加第一门课</span></button>
           <button type="button" class="sched-btn-ghost" data-empty-act="img"><svg class="ico ico-star" aria-hidden="true"><use href="#i-ai-brand"/></svg><span>AI 导课表</span></button>
         </div>`
      : `<div style="font-size:12px;opacity:.8">可以去自习或点击上方“+”添加课程</div>`;
    return `<div class="sched-empty-box">
      <svg class="ico-big" aria-hidden="true"><use href="#i-calendar"/></svg>
      <div>${isToday ? "今天" : "这一天"}暂无课程安排</div>
      ${emptyHint}
    </div>`;
  }
  const periods = SCHED_TIMES[schedGetSeason(schedGetDateOf(weekNo, day, schedState.startDate))].periods;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let html = "";
  for (const c of courses) {
    const s = periods.find(p => p.n === Number(c.start));
    const e = periods.find(p => p.n === Number(c.end));
    if (!s || !e) continue;
    const sMin = schedToMin(s.s), eMin = schedToMin(e.e);
    let cls = "sched-lesson";
    if (isToday) {
      if (nowMin >= sMin && nowMin < eMin) cls += " active";
      else if (nowMin >= eMin) cls += " past";
    }
    const color = SCHED_TYPE_COLOR[c.type] || SCHED_TYPE_COLOR["理论"];
    html += `<div class="${cls}" data-edit-idx="${c._idx}">
      <div class="sched-lesson-time"><span class="t">${s.s}</span><span class="p"><b>下课</b>${e.e}</span></div>
      <div class="sched-lesson-bar" data-type="${schedEsc(c.type || "理论")}" style="background:${color}"></div>
      <div class="sched-lesson-body">
        <div class="sched-lesson-name">${schedEsc(c.name)}<span class="sched-badge" data-type="${schedEsc(c.type || "理论")}" style="background:${color}">${schedEsc(c.type || "理论")}</span></div>
        <div class="sched-lesson-info">
          ${c.room ? `<span><svg class="ico" aria-hidden="true"><use href="#i-map-pin"/></svg>${schedEsc(c.room)}</span>` : ""}
          ${c.teacher ? `<span><svg class="ico" aria-hidden="true"><use href="#i-user"/></svg>${schedEsc(c.teacher)}</span>` : ""}
          <span><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg>${schedEsc(c.weeks)} 周</span>
        </div>
      </div>
    </div>`;
  }
  return html;
}

function render_schedule_desktop(now) {
  const weekNo = schedState.selectedWeek;
  const day = schedState.selectedDay;
  const todayWeek = schedGetWeekNumber(now, schedState.startDate);
  const todayDay = now.getDay() || 7;
  const monday = schedGetDateOf(weekNo, 1, schedState.startDate);
  const sunday = schedGetDateOf(weekNo, 7, schedState.startDate);
  const season = schedGetSeason(schedAddDays(monday, 3));
  const periods = SCHED_TIMES[season].periods;

  const rng = $("schedDesktopRange");
  if (rng) rng.textContent = `第 ${weekNo} 周 · ${schedFmtShort(monday)} – ${schedFmtShort(sunday)}`;
  const sb = $("schedDesktopSeasonBadge");
  if (sb) {
    sb.className = "sched-season-badge" + (season === "winter" ? " is-winter" : "");
    sb.innerHTML = schedSeasonHtml(season, false);
  }

  // 桌面端周次胶囊条（与移动端统一视觉）
  const dwStrip = $("schedDeskWeekStrip");
  if (dwStrip) {
    let wh = "";
    for (let w = 1; w <= schedState.totalWeeks; w++) {
      wh += `<button type="button" class="sched-week-chip${w === weekNo ? " on" : ""}${w === todayWeek ? " cur" : ""}" data-w="${w}">第${w}周</button>`;
    }
    dwStrip.innerHTML = wh;
  }

  // 桌面端日期胶囊条（带“今”角标）
  const ddStrip = $("schedDeskDateStrip");
  if (ddStrip) {
    let dh = "";
    for (let d = 1; d <= 7; d++) {
      const cd = schedGetDateOf(weekNo, d, schedState.startDate);
      const isT = weekNo === todayWeek && d === todayDay;
      dh += `<button type="button" class="sched-date-chip${d === day ? " on" : ""}${isT ? " today" : ""}" data-d="${d}">
        <span class="dw">${SCHED_DAY_SHORT[d]}</span>
        <span class="dd">${cd.getMonth() + 1}/${cd.getDate()}</span>
      </button>`;
    }
    ddStrip.innerHTML = dh;
  }

  // 左栏：原版黄金比例 Hero + 选中日课程时间轴
  const sideIsToday = weekNo === todayWeek && day === todayDay;
  const sideCourses = schedCoursesOfDay(weekNo, day);
  const heroObj = schedBuildHeroHtml(now, sideCourses, weekNo, day, sideIsToday);
  const heroEl = $("schedDesktopHero");
  if (heroEl) {
    heroEl.className = "sched-hero" + (heroObj.empty ? " empty" : "");
    heroEl.innerHTML = heroObj.html;
  }
  const tTitle = $("schedDesktopTodayTitle");
  if (tTitle) tTitle.textContent = sideIsToday ? "今日课程" : `${SCHED_DAY_NAMES[day]} 课程`;
  const tDate = $("schedDesktopTodayDate");
  if (tDate) tDate.textContent = `${schedFmtShort(schedGetDateOf(weekNo, day, schedState.startDate))} · 第 ${weekNo} 周`;
  const tl = $("schedDesktopTimeline");
  if (tl) tl.innerHTML = schedBuildTimelineNodes(sideCourses, now, weekNo, day, sideIsToday);

  // 右栏：7x5 周课表矩阵（点击表头同步左栏日期）
  const matrix = $("schedDesktopMatrix");
  if (matrix) {
    let html = `<div class="sched-m-head" style="display:flex;align-items:center;justify-content:center;cursor:default;">节次</div>`;
    for (let d = 1; d <= 7; d++) {
      const cd = schedGetDateOf(weekNo, d, schedState.startDate);
      const isT = weekNo === todayWeek && d === todayDay;
      html += `<div class="sched-m-head${isT ? " today" : ""}" data-desk-day="${d}">${SCHED_DAY_SHORT[d]}<small>${cd.getMonth() + 1}/${cd.getDate()}</small></div>`;
    }
    for (const pair of SCHED_BLOCKS) {
      const ps = periods.find(p => p.n === pair[0]);
      const pe = periods.find(p => p.n === pair[1]);
      html += `<div class="sched-m-period"><b>${pair[0]}-${pair[1]}</b><span>${ps ? ps.s : ""}</span><span>${pe ? pe.e : ""}</span></div>`;
      for (let d = 1; d <= 7; d++) {
        const isT = weekNo === todayWeek && d === todayDay;
        const matched = schedState.courses
          .map((c, i) => ({ ...c, _idx: i }))
          .filter(c => Number(c.day) === d && Number(c.start) >= pair[0] && Number(c.start) <= pair[1] && schedParseWeeks(c.weeks).has(weekNo));
        let cards = "";
        for (const c of matched) {
          const col = SCHED_TYPE_COLOR[c.type] || SCHED_TYPE_COLOR["理论"];
          cards += `<div class="sched-card-item" data-edit-idx="${c._idx}" data-type="${schedEsc(c.type || "理论")}" style="background:${col}">
            <div class="sc-n">${schedEsc(c.name)}${(c.end - c.start + 1) > 2 ? `<span class="sched-span-badge">${c.end - c.start + 1}节</span>` : ""}</div>
            <div class="sc-r">${schedEsc(c.room || c.teacher || "")}</div>
          </div>`;
        }
        html += `<div class="sched-m-cell${isT ? " today" : ""}" data-add-day="${d}" data-add-start="${pair[0]}" data-add-end="${pair[1]}">${cards}</div>`;
      }
    }
    matrix.innerHTML = html;
  }

  // 右栏：作息对照双卡
  render_timetable_cards($("schedDesktopInlineTimetable"), null, now);
}

function render_schedule_mobile(now) {
  const weekNo = schedState.selectedWeek;
  const day = schedState.selectedDay;
  const todayWeek = schedGetWeekNumber(now, schedState.startDate);
  const todayDay = now.getDay() || 7;
  const isToday = weekNo === todayWeek && day === todayDay;
  const targetDate = schedGetDateOf(weekNo, day, schedState.startDate);
  const season = schedGetSeason(targetDate);

  const mb = $("schedMobSeasonBadge");
  if (mb) {
    mb.className = "sched-season-badge" + (season === "winter" ? " is-winter" : "");
    mb.innerHTML = schedSeasonHtml(season, true);
  }

  // Week strip
  const wStrip = $("schedWeekStrip");
  if (wStrip) {
    let wh = "";
    for (let w = 1; w <= schedState.totalWeeks; w++) {
      wh += `<button type="button" class="sched-week-chip${w === weekNo ? " on" : ""}${w === todayWeek ? " cur" : ""}" data-w="${w}">第${w}周</button>`;
    }
    wStrip.innerHTML = wh;
    const sel = wStrip.querySelector(".sched-week-chip.on");
    if (sel) {
      const targetLeft = sel.offsetLeft - (wStrip.clientWidth - sel.offsetWidth) / 2;
      wStrip.scrollLeft = Math.max(0, targetLeft);
    }
  }

  // Date strip
  const dStrip = $("schedDateStrip");
  if (dStrip) {
    let dh = "";
    for (let d = 1; d <= 7; d++) {
      const cd = schedGetDateOf(weekNo, d, schedState.startDate);
      const isT = weekNo === todayWeek && d === todayDay;
      dh += `<button type="button" class="sched-date-chip${d === day ? " on" : ""}${isT ? " today" : ""}" data-d="${d}">
        <span class="dw">${SCHED_DAY_SHORT[d]}</span>
        <span class="dd">${cd.getMonth() + 1}/${cd.getDate()}</span>
      </button>`;
    }
    dStrip.innerHTML = dh;
  }

  // Today tab
  const dayCourses = schedCoursesOfDay(weekNo, day);
  const heroObj = schedBuildHeroHtml(now, dayCourses, weekNo, day, isToday);
  const mobHero = $("schedMobHero");
  if (mobHero) {
    mobHero.className = "sched-hero" + (heroObj.empty ? " empty" : "");
    mobHero.innerHTML = heroObj.html;
  }
  const mDayLbl = $("schedMobDayLabel");
  if (mDayLbl) mDayLbl.textContent = isToday ? "今日课程" : `${SCHED_DAY_NAMES[day]} 课程`;
  const mDate = $("schedMobTodayDate");
  if (mDate) mDate.textContent = `${schedFmtShort(targetDate)} · ${SCHED_DAY_NAMES[day]}`;
  const mTl = $("schedMobTimeline");
  if (mTl) mTl.innerHTML = schedBuildTimelineNodes(dayCourses, now, weekNo, day, isToday);

  // Week grid tab
  const monday = schedGetDateOf(weekNo, 1, schedState.startDate);
  const sunday = schedGetDateOf(weekNo, 7, schedState.startDate);
  const wSeason = schedGetSeason(schedAddDays(monday, 3));
  const periods = SCHED_TIMES[wSeason].periods;
  const wTitle = $("schedMobWeekTitle");
  if (wTitle) wTitle.textContent = `第 ${weekNo} 周 · ${SCHED_TIMES[wSeason].label}`;
  const wRange = $("schedMobWeekRange");
  if (wRange) wRange.textContent = `${schedFmtShort(monday)} – ${schedFmtShort(sunday)}`;

  const wg = $("schedMobWeekGrid");
  if (wg) {
    let gh = `<div class="sched-m-head" style="display:flex;align-items:center;justify-content:center;">节次</div>`;
    for (let d = 1; d <= 7; d++) {
      const cd = schedGetDateOf(weekNo, d, schedState.startDate);
      const isT = weekNo === todayWeek && d === todayDay;
      gh += `<div class="sched-m-head${isT ? " today" : ""}" data-jump-day="${d}">${SCHED_DAY_SHORT[d]}<small>${cd.getMonth() + 1}/${cd.getDate()}</small></div>`;
    }
    for (const pair of SCHED_BLOCKS) {
      const ps = periods.find(p => p.n === pair[0]);
      const pe = periods.find(p => p.n === pair[1]);
      gh += `<div class="sched-m-period"><b>${pair[0]}-${pair[1]}</b><span>${ps ? ps.s : ""}</span><span>${pe ? pe.e : ""}</span></div>`;
      for (let d = 1; d <= 7; d++) {
        const isT = weekNo === todayWeek && d === todayDay;
        const matched = schedState.courses
          .map((c, i) => ({ ...c, _idx: i }))
          .filter(c => Number(c.day) === d && Number(c.start) >= pair[0] && Number(c.start) <= pair[1] && schedParseWeeks(c.weeks).has(weekNo));
        let cards = "";
        for (const c of matched) {
          const col = SCHED_TYPE_COLOR[c.type] || SCHED_TYPE_COLOR["理论"];
          cards += `<div class="sched-card-item" data-edit-idx="${c._idx}" data-type="${schedEsc(c.type || "理论")}" style="background:${col}">
            <div class="sc-n">${schedEsc(c.name)}${(c.end - c.start + 1) > 2 ? `<span class="sched-span-badge">${c.end - c.start + 1}节</span>` : ""}</div>
            <div class="sc-r">${schedEsc(c.room || "")}</div>
          </div>`;
        }
        gh += `<div class="sched-m-cell${isT ? " today" : ""}" data-add-day="${d}" data-add-start="${pair[0]}" data-add-end="${pair[1]}">${cards}</div>`;
      }
    }
    wg.innerHTML = gh;
  }

  // Timetable tab
  render_timetable_cards($("schedMobTimetableContainer"), $("schedMobSeasonTag"), now);
}

function render_timetable_cards(container, tagEl, now) {
  if (!container) return;
  const curSeason = schedGetSeason(now);
  const sch = SCHED_TIMES[curSeason];
  if (tagEl) tagEl.textContent = `当前生效：${sch.label}（${sch.range}）`;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let activePeriod = 0;
  for (const p of sch.periods) {
    if (nowMin >= schedToMin(p.s) && nowMin < schedToMin(p.e)) { activePeriod = p.n; break; }
  }
  const numMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  const makeCard = key => {
    const s = SCHED_TIMES[key];
    const isCur = key === curSeason;
    let rows = "";
    for (const r of s.rows) {
      let cls = "sched-tt-row" + (r.br ? " break" : "");
      const m = /^第([一二三四五六七八九十]+)节$/.exec(r.n);
      if (m && isCur && numMap[m[1]] === activePeriod) cls += " active";
      rows += `<div class="${cls}"><span class="n">${r.n}</span><span class="t">${r.t}</span></div>`;
    }
    return `<div class="sched-tt-card">
      <div class="sched-tt-head"><span>${s.label}</span><span class="tag${isCur ? " on" : ""}">${isCur ? "当前执行" : s.range}</span></div>
      ${rows}
    </div>`;
  };
  container.innerHTML = makeCard(curSeason) + makeCard(curSeason === "winter" ? "summer" : "winter");
}

function render_schedule_all() {
  const now = new Date();
  render_home_schedule_strip();
  render_schedule_desktop(now);
  render_schedule_mobile(now);
  render_schedule_manage();
}

function open_schedule_course_dlg(idx, prefill) {
  schedState.editingIdx = typeof idx === "number" ? idx : -1;
  const isEdit = schedState.editingIdx >= 0;
  $("schedCourseDlgTitle").textContent = isEdit ? "编辑课程" : "添加课程";
  $("btnSchedDeleteCourse").classList.toggle("hide", !isEdit);
  const c = isEdit ? schedState.courses[schedState.editingIdx] : {
    name: "",
    day: prefill?.day || schedState.selectedDay || 1,
    start: prefill?.start || 1,
    end: prefill?.end || 2,
    weeks: "1-" + schedState.totalWeeks,
    room: "",
    teacher: "",
    type: "理论"
  };
  $("scName").value = c.name || "";
  $("scDay").value = String(c.day || 1);
  $("scType").value = c.type || "理论";
  $("scStart").value = String(c.start || 1);
  $("scEnd").value = String(c.end || 2);
  $("scWeeks").value = c.weeks || "1-" + schedState.totalWeeks;
  $("scRoom").value = c.room || "";
  $("scTeacher").value = c.teacher || "";
  $("schedEditToolsRow")?.classList.toggle("hide", !isEdit);
  render_sched_weeks_grid();
  $("scheduleCourseDialog")?.showModal();
}

function render_schedule_manage() {
  const sorted = schedState.courses
    .map((c, i) => ({ ...c, _idx: i }))
    .sort((a, b) => a.day - b.day || a.start - b.start);

  const listHtml = !sorted.length
    ? `<div style="text-align:center;padding:22px;color:var(--muted);font-size:13px">还没有录入任何课程</div>`
    : `<div class="sched-manage-grid">` + sorted.map(c => {
        const col = SCHED_TYPE_COLOR[c.type] || SCHED_TYPE_COLOR["理论"];
        return `<div class="sched-clist-item">
          <div class="bar" style="background:${col}"></div>
          <div class="body" data-edit-idx="${c._idx}">
            <div class="n">${schedEsc(c.name)}</div>
            <div class="m">${SCHED_DAY_SHORT[c.day]} · 第${c.start}-${c.end}节 · ${schedEsc(c.weeks)}周 · ${schedEsc(c.room || "未填地点")}</div>
          </div>
          <button type="button" class="del" data-del-idx="${c._idx}" aria-label="删除"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </div>`;
      }).join("") + `</div>`;

  const html = `
    <div class="sched-manage-card" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;">
      <div><b style="font-size:15px;color:var(--ink);display:block;">课表设置与管理</b><small style="font-size:12px;color:var(--muted);">修改后自动同步至云端</small></div>
      <button type="button" class="sched-btn-ghost" data-manage-act="back"><svg class="ico" aria-hidden="true"><use href="#i-chevron-left"/></svg><span>返回课表</span></button>
    </div>
    <div class="sched-sub-tools sched-sub-tools-single" style="margin-bottom:0">
      <button type="button" class="sched-sub-card is-accent" data-manage-act="ai-import">
        <svg class="ico ico-star" aria-hidden="true"><use href="#i-ai-brand"/></svg>
        <div><b>AI 导课表</b><small>支持 PDF、表格、截图或直接粘贴文本导入</small></div>
      </button>
    </div>

    <div class="sched-manage-card">
      <div class="sched-manage-card-head"><b>学期参数设置</b><small style="color:var(--muted)">修改后自动同步云端</small></div>
      <div class="sched-field-row">
        <div class="sched-field">
          <label>第 1 周周一日期</label>
          <input type="date" data-manage-start data-no-clear="1" data-placeholder="选择开学日期" value="${schedEsc(schedState.startDate)}">
        </div>
        <div class="sched-field">
          <label>学期总周数</label>
          <input type="number" min="1" max="30" data-manage-weeks value="${schedState.totalWeeks}">
        </div>
      </div>
    </div>

    <div class="sched-manage-card">
      <div class="sched-manage-card-head">
        <b>已录入课程（${sorted.length}）</b>
        <button type="button" class="sched-link-btn" data-manage-act="add"><svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg><span>添加课程</span></button>
      </div>
      ${listHtml}
    </div>

    <div class="sched-manage-card">
      <div class="sched-manage-card-head"><b>备份与数据管理</b></div>
      <div class="sched-dlg-actions" style="margin-top:0">
        <button type="button" class="sched-btn-ghost" style="flex:1" data-manage-act="export"><svg class="ico" aria-hidden="true"><use href="#i-download"/></svg><span>导出 JSON</span></button>
        <button type="button" class="sched-btn-ghost" style="flex:1" data-manage-act="import"><svg class="ico" aria-hidden="true"><use href="#i-upload"/></svg><span>导入 JSON</span></button>
      </div>
      <button type="button" class="sched-btn-danger" style="width:100%;margin-top:8px" data-manage-act="clear"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg><span>清空所有课程</span></button>
    </div>
  `;

  if ($("schedDeskManageHost")) {
    $("schedDeskManageHost").innerHTML = html;
    if (typeof window.enhance_date_pickers === "function") window.enhance_date_pickers($("schedDeskManageHost"));
  }
  if ($("schedMobManageHost")) {
    $("schedMobManageHost").innerHTML = html;
    if (typeof window.enhance_date_pickers === "function") window.enhance_date_pickers($("schedMobManageHost"));
  }
}

function render_setting_course_list() { render_schedule_manage(); }
function open_schedule_settings_dlg() {
  const isDeskManage = !$("schedDeskViewManage")?.classList.contains("hide");
  const isMobManage = !$("schedMobViewManage")?.classList.contains("hide");
  switch_desk_sched_tab(isDeskManage ? "matrix" : "manage");
  switch_mob_sched_tab(isMobManage ? "today" : "manage");
}

function switch_desk_sched_tab(t) {
  document.querySelectorAll(".sched-dseg-btn").forEach(x => x.classList.toggle("on", x.dataset.dtab === t));
  $("schedDeskViewMatrix")?.classList.toggle("hide", t !== "matrix");
  $("schedDeskViewTimetable")?.classList.toggle("hide", t !== "timetable");
  $("schedDeskViewManage")?.classList.toggle("hide", t !== "manage");
  $("schedOpenSettings")?.classList.toggle("is-active", t === "manage");
  $("schedDeskWeekStrip")?.classList.toggle("hide", t === "manage");
  $("schedDeskDateStrip")?.classList.toggle("hide", t === "manage");
}

function switch_mob_sched_tab(t) {
  schedState.mobTab = t;
  document.querySelectorAll(".sched-seg-btn").forEach(b => b.classList.toggle("on", b.dataset.stab === t));
  $("schedMobViewToday")?.classList.toggle("hide", t !== "today");
  $("schedMobViewWeek")?.classList.toggle("hide", t !== "week");
  $("schedMobViewTimetable")?.classList.toggle("hide", t !== "timetable");
  $("schedMobViewManage")?.classList.toggle("hide", t !== "manage");
  $("schedMobSettings")?.classList.toggle("is-ai", t === "manage");
  document.querySelector(".sched-m-sticky")?.classList.toggle("is-manage-mode", t === "manage");
  if (t === "manage") window.scrollTo({ top: 0, behavior: "smooth" });
}

function bind_schedule_events() {
  if (schedState.bound) return;
  schedState.bound = true;

  const goToday = () => {
    const now = new Date();
    const w = schedGetWeekNumber(now, schedState.startDate);
    schedState.selectedWeek = Math.max(1, Math.min(schedState.totalWeeks, w || 1));
    schedState.selectedDay = now.getDay() || 7;
    render_schedule_all();
    toast("已回到当前周与今天");
  };
  $("schedDesktopToday")?.addEventListener("click", goToday);
  $("schedMobToday")?.addEventListener("click", () => {
    goToday();
    switch_mob_sched_tab("today");
  });

  $("schedDesktopAdd")?.addEventListener("click", () => open_schedule_course_dlg(-1));
  $("schedMobAdd")?.addEventListener("click", () => open_schedule_course_dlg(-1));
  $("schedOpenSettings")?.addEventListener("click", open_schedule_settings_dlg);
  $("schedMobSettings")?.addEventListener("click", open_schedule_settings_dlg);

    // 移动端周条 & 日期条 & 分段切换
  $("schedWeekStrip")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-w]");
    if (!btn) return;
    schedState.selectedWeek = Number(btn.dataset.w);
    render_schedule_all();
  });
  $("schedDateStrip")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-d]");
    if (!btn) return;
    schedState.selectedDay = Number(btn.dataset.d);
    render_schedule_all();
  });


  document.querySelectorAll(".sched-seg-btn").forEach(b => {
    b.addEventListener("click", () => switch_mob_sched_tab(b.dataset.stab));
  });

  // 点击课表卡片/格子事件委托
  $("schedulePage")?.addEventListener("click", e => {
    const deskDay = e.target.closest("[data-desk-day]");
    if (deskDay) {
      schedState.selectedDay = Number(deskDay.dataset.deskDay);
      render_schedule_all();
      return;
    }
    const jump = e.target.closest("[data-jump-day]");
    if (jump) {
      schedState.selectedDay = Number(jump.dataset.jumpDay);
      render_schedule_all();
      switch_mob_sched_tab("today");
      return;
    }
    const editEl = e.target.closest("[data-edit-idx]");
    if (editEl) {
      e.stopPropagation();
      open_schedule_course_dlg(Number(editEl.dataset.editIdx));
      return;
    }
    const addCell = e.target.closest("[data-add-day]");
    if (addCell) {
      open_schedule_course_dlg(-1, {
        day: Number(addCell.dataset.addDay),
        start: Number(addCell.dataset.addStart),
        end: Number(addCell.dataset.addEnd)
      });
    }
  });

  // 移动端单日视图左右滑切天
  const mobToday = $("schedMobViewToday");
  if (mobToday) {
    let sx = 0, sy = 0, st = 0;
    mobToday.addEventListener("touchstart", e => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    mobToday.addEventListener("touchend", e => {
      if (e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Date.now() - st < 360 && Math.abs(dx) > 48 && Math.abs(dy) < 40) {
        if (dx < 0) {
          if (schedState.selectedDay < 7) schedState.selectedDay++;
          else if (schedState.selectedWeek < schedState.totalWeeks) { schedState.selectedWeek++; schedState.selectedDay = 1; }
        } else {
          if (schedState.selectedDay > 1) schedState.selectedDay--;
          else if (schedState.selectedWeek > 1) { schedState.selectedWeek--; schedState.selectedDay = 7; }
        }
        render_schedule_all();
      }
    }, { passive: true });
  }

  // 对话框关闭与提交
  $("closeSchedCourseDlg")?.addEventListener("click", () => $("scheduleCourseDialog")?.close());
  $("closeSchedTimetableDlg")?.addEventListener("click", () => $("scheduleTimetableDialog")?.close());

  $("schedCourseForm")?.addEventListener("submit", e => {
    e.preventDefault();
    const name = $("scName").value.trim();
    if (!name) { toast("请填写课程名称"); return; }
    const start = Number($("scStart").value);
    const end = Number($("scEnd").value);
    if (end < start) { toast("结束节次不能小于开始节次"); return; }
    const item = {
      name,
      day: Number($("scDay").value),
      start,
      end,
      weeks: $("scWeeks").value.trim() || ("1-" + schedState.totalWeeks),
      room: $("scRoom").value.trim(),
      teacher: $("scTeacher").value.trim(),
      type: $("scType").value
    };
    if (schedState.editingIdx >= 0) {
      schedState.courses[schedState.editingIdx] = item;
      toast("课程已更新");
    } else {
      schedState.courses.push(item);
      toast("课程已添加");
    }
    $("scheduleCourseDialog")?.close();
    schedQueueSync();
    render_schedule_all();
    render_setting_course_list();
  });

  $("btnSchedDeleteCourse")?.addEventListener("click", () => {
    if (schedState.editingIdx < 0) return;
    if (!confirm("确定删除这门课程吗？")) return;
    schedState.courses.splice(schedState.editingIdx, 1);
    $("scheduleCourseDialog")?.close();
    schedQueueSync();
    render_schedule_all();
    render_setting_course_list();
    toast("已删除课程");
  });

  // 滚动静默 + 分钟级实时刷新
  window.addEventListener("scroll", () => {
    schedState.isScrolling = true;
    clearTimeout(schedState.scrollTimer);
    schedState.scrollTimer = setTimeout(() => { schedState.isScrolling = false; }, 450);
  }, { passive: true });

  setInterval(() => {
    if (cur_page !== "schedule" || schedState.isScrolling) return;
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    if (m === schedState.lastMin) return;
    schedState.lastMin = m;
    render_schedule_all();
  }, 10000);
}


function format_sched_weeks_set(set) {
  const arr = [...set].filter(n => n >= 1 && n <= schedState.totalWeeks).sort((a, b) => a - b);
  if (!arr.length) return "";
  const ranges = [];
  let s = arr[0], p = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === p + 1) p = arr[i];
    else { ranges.push(s === p ? `${s}` : `${s}-${p}`); s = p = arr[i]; }
  }
  ranges.push(s === p ? `${s}` : `${s}-${p}`);
  return ranges.join(",");
}

function render_sched_weeks_grid() {
  const grid = $("scWeeksGrid");
  if (!grid) return;
  const set = schedParseWeeks($("scWeeks")?.value || "");
  let html = "";
  for (let w = 1; w <= schedState.totalWeeks; w++) {
    html += `<button type="button" class="sched-wk-btn${set.has(w) ? " on" : ""}" data-wk="${w}">${w}</button>`;
  }
  grid.innerHTML = html;
}

function render_home_schedule_strip() {
  const strip = $("homeScheduleStrip");
  if (!strip) return;
  const now = new Date();
  const weekNo = schedGetWeekNumber(now, schedState.startDate);
  const day = now.getDay() || 7;
  if (!schedState.courses.length) {
    strip.classList.remove("hide");
    strip.innerHTML = `<div class="home-sched-left">
      <div class="home-sched-ico"><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg></div>
      <div class="home-sched-text"><b>超级课表已就绪</b><small>支持 AI 截图一键导课表、春夏季/秋冬季自动切换</small></div>
    </div><span class="home-sched-pill">去录入</span>`;
    return;
  }
  const effWeek = Math.max(1, Math.min(schedState.totalWeeks, weekNo || 1));
  const dayCourses = schedCoursesOfDay(effWeek, day);
  const periods = SCHED_TIMES[schedGetSeason(now)].periods;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let cur = null, next = null;
  for (const c of dayCourses) {
    const s = periods.find(p => p.n === Number(c.start));
    const e = periods.find(p => p.n === Number(c.end));
    if (!s || !e) continue;
    const sMin = schedToMin(s.s), eMin = schedToMin(e.e);
    if (nowMin >= sMin && nowMin < eMin) { cur = { c, s, e, eMin }; break; }
    if (nowMin < sMin && !next) next = { c, s, e, sMin };
  }
  strip.classList.remove("hide");
  if (cur) {
    strip.innerHTML = `<div class="home-sched-left">
      <div class="home-sched-ico"><svg class="ico" aria-hidden="true"><use href="#i-clock"/></svg></div>
      <div class="home-sched-text"><b>正在上课：${schedEsc(cur.c.name)}</b><small>${schedEsc(cur.c.room || "未填教室")} · ${cur.s.s}–${cur.e.e}</small></div>
    </div><span class="home-sched-pill">余 ${cur.eMin - nowMin} 分钟</span>`;
  } else if (next) {
    strip.innerHTML = `<div class="home-sched-left">
      <div class="home-sched-ico"><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg></div>
      <div class="home-sched-text"><b>下一节：${schedEsc(next.c.name)}</b><small>${schedEsc(next.c.room || "未填教室")} · ${next.s.s} 上课</small></div>
    </div><span class="home-sched-pill">${next.sMin - nowMin} 分钟后</span>`;
  } else {
    strip.innerHTML = `<div class="home-sched-left">
      <div class="home-sched-ico"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg></div>
      <div class="home-sched-text"><b>今日课程已结束（第 ${effWeek} 周）</b><small>${dayCourses.length ? "今日共 " + dayCourses.length + " 门课" : "今日无课"} · 点击查看完整课表</small></div>
    </div><span class="home-sched-pill">看课表</span>`;
  }
}

async function compress_sched_image(file) {
  const slices = await compress_sched_image_slices(file);
  return slices[0];
}

async function compress_sched_image_slices(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式不支持"));
      img.onload = () => {
        const renderCrop = (sx, sy, sw, sh, maxDim) => {
          let tw = sw, th = sh;
          if (tw > maxDim || th > maxDim) {
            const ratio = Math.min(maxDim / tw, maxDim / th);
            tw = Math.max(1, Math.round(tw * ratio));
            th = Math.max(1, Math.round(th * ratio));
          }
          const canvas = document.createElement("canvas");
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);
          return canvas.toDataURL("image/jpeg", 0.92);
        };
        const iw = img.width || 1, ih = img.height || 1;
        // 超长竖屏课表截图（高宽比 >= 2.05）：自动拆分为上下重叠高清两切片，避免底部晚课与小字被压缩模糊
        if (ih / iw >= 2.05 && ih >= 1600) {
          const sliceH = Math.round(ih * 0.58);
          const topSlice = renderCrop(0, 0, iw, sliceH, 2200);
          const bottomSlice = renderCrop(0, ih - sliceH, iw, sliceH, 2200);
          resolve([topSlice, bottomSlice]);
        } else {
          resolve([renderCrop(0, 0, iw, ih, 2400)]);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

(function bind_sched_ux_extras() {
  $("homeScheduleStrip")?.addEventListener("click", () => go("schedule"));

  let pendingAiFiles = [];
  let pendingParsedCourses = null;
  let pendingParsedWarnings = [];
  let activeSchedAiCtrl = null;
  let schedAiUserAborted = false;

  const set_sched_ai_running = running => {
    const runBtn = $("schedAiRunBtn");
    const stopBtn = $("schedAiStopBtn");
    if (runBtn) runBtn.disabled = !!running;
    if (stopBtn) stopBtn.classList.toggle("hide", !running);
  };

  const stop_sched_ai_task = (showTip = true) => {
    if (!activeSchedAiCtrl) return;
    schedAiUserAborted = true;
    try { activeSchedAiCtrl.abort(); } catch {}
    activeSchedAiCtrl = null;
    set_sched_ai_running(false);
    if (showTip) {
      schedSetSyncLabel("已停止解析", false);
      set_ai_import_status("已停止本次 AI 导入，可重新选择文件或再次识别");
      toast("已停止本次 AI 导入");
    }
  };

  $("schedAiStopBtn")?.addEventListener("click", () => stop_sched_ai_task(true));
  $("scheduleAiImportDialog")?.addEventListener("close", () => {
    if (activeSchedAiCtrl) stop_sched_ai_task(false);
  });
  let pendingParsedNotes = "";
  let editingParsedIdx = -1;
  let aiImportRefining = false;

  const SCHED_TYPES_LIST = ["理论", "实验", "上机", "线上", "体育", "其他"];

  function audit_parsed_courses_client(courses) {
    const list = Array.isArray(courses) ? courses : [];
    const warnings = [];
    const weekSets = list.map(c => schedParseWeeks(c.weeks || "1-18"));
    for (let i = 0; i < list.length; i++) {
      if (!String(list[i].room || "").trim()) {
        warnings.push({ type: "missing_room", indices: [i], message: `《${list[i].name}》（${SCHED_DAY_SHORT[list[i].day] || ""} 第${list[i].start}-${list[i].end}节）缺少上课地点` });
      }
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.day !== b.day) continue;
        if (Math.max(a.start, b.start) > Math.min(a.end, b.end)) continue;
        let overlap = false;
        for (const w of weekSets[i]) { if (weekSets[j].has(w)) { overlap = true; break; } }
        if (overlap) {
          warnings.push({
            type: "conflict",
            indices: [i, j],
            message: `${SCHED_DAY_SHORT[a.day] || ""} 第${Math.max(a.start, b.start)}-${Math.min(a.end, b.end)}节：《${a.name}》与《${b.name}》周次时间重叠`
          });
        }
      }
    }
    return warnings.slice(0, 12);
  }

  function update_ai_confirm_btn() {
    const btn = $("schedAiConfirmBtn");
    if (!btn) return;
    const count = Array.isArray(pendingParsedCourses) ? pendingParsedCourses.length : 0;
    btn.classList.toggle("hide", count === 0);
    const span = btn.querySelector("span");
    if (span) span.textContent = count ? `确认导入 (${count}条)` : "确认导入课表";
  }

  function format_picked_ai_files_label(files) {
    if (!files || !files.length) return "支持多张教务截图、PDF、Excel/CSV、Word、TXT 等任意格式";
    const totalKb = Math.max(1, Math.round(files.reduce((s, f) => s + (f.size || 0), 0) / 1024));
    if (files.length === 1) return `已选择：${files[0].name}（${totalKb} KB）`;
    const names = files.map(f => f.name).slice(0, 3).join("、") + (files.length > 3 ? "…" : "");
    return `已选择 ${files.length} 个文件：${names}（共 ${totalKb} KB）`;
  }

  function accept_picked_ai_files(fileList) {
    const arr = Array.from(fileList || []).filter(Boolean);
    if (!arr.length) return;
    const isImg = f => {
      const t = (f.type || "").toLowerCase();
      const n = (f.name || "").toLowerCase();
      return t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(n);
    };
    const imgs = arr.filter(isImg);
    if (imgs.length > 0) {
      pendingAiFiles = imgs.slice(0, 4);
      if (imgs.length > 4) toast("单次最多支持 4 张课表截图，已自动取前 4 张");
    } else {
      pendingAiFiles = [arr[0]];
    }
    set_ai_import_status("");
    if ($("schedAiFileLabel")) $("schedAiFileLabel").textContent = format_picked_ai_files_label(pendingAiFiles);
  }

  function render_ai_parsed_workbench() {
    const prevEl = $("schedAiPreview");
    if (!prevEl) return;
    const list = Array.isArray(pendingParsedCourses) ? pendingParsedCourses : [];
    if (!list.length) {
      prevEl.innerHTML = "";
      prevEl.classList.add("hide");
      update_ai_confirm_btn();
      return;
    }

    const warnIdxSet = new Set();
    (pendingParsedWarnings || []).forEach(w => {
      if (Array.isArray(w.indices)) w.indices.forEach(i => warnIdxSet.add(Number(i)));
    });

    const dayOpts = d => [1, 2, 3, 4, 5, 6, 7].map(n => `<option value="${n}"${Number(d) === n ? " selected" : ""}>${SCHED_DAY_SHORT[n]}</option>`).join("");
    const periodOpts = v => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<option value="${n}"${Number(v) === n ? " selected" : ""}>第${n}节</option>`).join("");
    const typeOpts = t => SCHED_TYPES_LIST.map(tp => `<option value="${tp}"${(t || "理论") === tp ? " selected" : ""}>${tp}</option>`).join("");

    const notesHtml = pendingParsedNotes
      ? `<div class="sched-ai-wb-notes"><span>AI 备注：</span>${schedEsc(pendingParsedNotes)}</div>`
      : "";

    const warnHtml = pendingParsedWarnings && pendingParsedWarnings.length
      ? `<div class="sched-ai-warn-box">
          <div class="sched-ai-warn-title">发现 ${pendingParsedWarnings.length} 处需复核提示（可点击下方条目直接修改）</div>
          <ul>${pendingParsedWarnings.slice(0, 5).map(w => `<li>${schedEsc(w.message)}</li>`).join("")}${pendingParsedWarnings.length > 5 ? `<li>…其余 ${pendingParsedWarnings.length - 5} 处已在下方高亮标出</li>` : ""}</ul>
        </div>`
      : "";

    const itemsHtml = list.map((c, idx) => {
      const col = SCHED_TYPE_COLOR[c.type] || SCHED_TYPE_COLOR["理论"];
      const hasWarn = warnIdxSet.has(idx);
      const isEditing = editingParsedIdx === idx;
      const metaParts = [
        `${SCHED_DAY_SHORT[c.day] || "周一"} 第${c.start}-${c.end}节`,
        `${c.weeks || "1-18"}周`,
        c.room ? c.room : "未填地点",
        c.teacher ? c.teacher : ""
      ].filter(Boolean).join(" · ");

      const editorHtml = isEditing ? `
        <div class="sched-ai-inline-editor" data-wb-editor="${idx}">
          <div class="sched-ai-ed-grid">
            <label class="sched-ai-ed-field is-full">
              <span>课程名称</span>
              <input type="text" data-ed-k="name" value="${schedEsc(c.name || "")}" placeholder="课程名称">
            </label>
            <label class="sched-ai-ed-field">
              <span>星期</span>
              <select data-ed-k="day">${dayOpts(c.day)}</select>
            </label>
            <label class="sched-ai-ed-field">
              <span>开始节</span>
              <select data-ed-k="start">${periodOpts(c.start)}</select>
            </label>
            <label class="sched-ai-ed-field">
              <span>结束节</span>
              <select data-ed-k="end">${periodOpts(c.end)}</select>
            </label>
            <label class="sched-ai-ed-field">
              <span>周次</span>
              <input type="text" data-ed-k="weeks" value="${schedEsc(c.weeks || "1-18")}" placeholder="1-16 或 1-15(单)">
            </label>
            <label class="sched-ai-ed-field">
              <span>教室/地点</span>
              <input type="text" data-ed-k="room" value="${schedEsc(c.room || "")}" placeholder="如 明德楼B201">
            </label>
            <label class="sched-ai-ed-field">
              <span>教师</span>
              <input type="text" data-ed-k="teacher" value="${schedEsc(c.teacher || "")}" placeholder="任课教师">
            </label>
            <label class="sched-ai-ed-field">
              <span>类型</span>
              <select data-ed-k="type">${typeOpts(c.type)}</select>
            </label>
          </div>
          <div class="sched-ai-ed-actions">
            <button type="button" class="sched-ai-ed-save" data-wb-act="save" data-wb-idx="${idx}">保存修改</button>
            <button type="button" class="sched-ai-ed-cancel" data-wb-act="cancel" data-wb-idx="${idx}">取消</button>
          </div>
        </div>` : "";

      return `<div class="sched-ai-wb-item${hasWarn ? " has-warn" : ""}${isEditing ? " is-editing" : ""}" data-wb-row="${idx}">
        <div class="sched-ai-wb-row">
          <span class="sched-ai-wb-bar" style="background:${col}"></span>
          <div class="sched-ai-wb-main" data-wb-act="edit" data-wb-idx="${idx}" title="点击编辑这条课程">
            <div class="sched-ai-wb-name">${schedEsc(c.name)}<span class="sched-ai-wb-type">${schedEsc(c.type || "理论")}</span>${hasWarn ? `<span class="sched-ai-wb-flag">待核对</span>` : ""}</div>
            <div class="sched-ai-wb-meta">${schedEsc(metaParts)}</div>
          </div>
          <div class="sched-ai-wb-ops">
            <button type="button" class="sched-ai-wb-btn" data-wb-act="edit" data-wb-idx="${idx}" aria-label="编辑课程" title="编辑"><svg class="ico" aria-hidden="true"><use href="#i-edit"/></svg></button>
            <button type="button" class="sched-ai-wb-btn is-del" data-wb-act="del" data-wb-idx="${idx}" aria-label="删除课程" title="删除"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg></button>
          </div>
        </div>
        ${editorHtml}
      </div>`;
    }).join("");

    prevEl.innerHTML = `
      <div class="sched-ai-wb-head">
        <div>
          <b>识别核对工作台（共 ${list.length} 条）</b>
          <small>点击课程可逐条修改，或在下方用自然语言让 AI 批量修正</small>
        </div>
        <button type="button" class="sched-ai-wb-add" data-wb-act="add">+ 补加一条</button>
      </div>
      ${notesHtml}
      ${warnHtml}
      <div class="sched-ai-wb-list">${itemsHtml}</div>
      <div class="sched-ai-refine-bar">
        <label for="schedAiRefineInput">AI 自然语言二次修正</label>
        <div class="sched-ai-refine-row">
          <input type="text" id="schedAiRefineInput" placeholder="如：把大学物理教室全改到明德楼B201；删掉体育；高数改成1-16周" ${aiImportRefining ? "disabled" : ""}>
          <button type="button" id="schedAiRefineBtn" class="sched-ai-refine-btn" data-wb-act="refine" ${aiImportRefining ? "disabled" : ""}>${aiImportRefining ? "修正中…" : "AI 修正"}</button>
        </div>
      </div>`;
    prevEl.classList.remove("hide");
    update_ai_confirm_btn();
  }

  function save_inline_wb_editor(idx) {
    if (!Array.isArray(pendingParsedCourses) || idx < 0 || idx >= pendingParsedCourses.length) return false;
    const box = $("schedAiPreview")?.querySelector(`[data-wb-editor="${idx}"]`);
    if (!box) return false;
    const getVal = k => String(box.querySelector(`[data-ed-k="${k}"]`)?.value || "").trim();
    const name = getVal("name");
    if (!name) {
      toast("课程名称不能为空");
      box.querySelector('[data-ed-k="name"]')?.focus();
      return false;
    }
    const day = Math.min(7, Math.max(1, parseInt(getVal("day"), 10) || 1));
    let start = Math.min(10, Math.max(1, parseInt(getVal("start"), 10) || 1));
    let end = Math.min(10, Math.max(1, parseInt(getVal("end"), 10) || start));
    if (end < start) { const tmp = start; start = end; end = tmp; }
    const weeks = getVal("weeks") || ("1-" + schedState.totalWeeks);
    const room = getVal("room");
    const teacher = getVal("teacher");
    const type = SCHED_TYPES_LIST.includes(getVal("type")) ? getVal("type") : "理论";
    pendingParsedCourses[idx] = { name, day, start, end, weeks, room, teacher, type };
    editingParsedIdx = -1;
    pendingParsedWarnings = audit_parsed_courses_client(pendingParsedCourses);
    render_ai_parsed_workbench();
    set_ai_import_status(`已更新课程，当前共 ${pendingParsedCourses.length} 条，核对无误后点击“确认导入课表”。`);
    toast("课程条目已更新");
    return true;
  }

  async function run_ai_schedule_refine() {
    if (aiImportRefining || !Array.isArray(pendingParsedCourses) || !pendingParsedCourses.length) return;
    const inp = $("schedAiRefineInput");
    const instruction = String(inp?.value || "").trim();
    if (!instruction) {
      toast("请先输入想让 AI 修改的内容");
      inp?.focus();
      return;
    }
    if (editingParsedIdx >= 0) save_inline_wb_editor(editingParsedIdx);
    aiImportRefining = true;
    schedAiUserAborted = false;
    const ctrl = new AbortController();
    activeSchedAiCtrl = ctrl;
    set_sched_ai_running(true);
    render_ai_parsed_workbench();
    set_ai_import_status("正在按你的要求批量修正课表（可随时点击“停止导入”）…");
    let timer = setTimeout(() => ctrl.abort(), 105000);
    try {
      const resp = await fetch(api_base + "/schedule/refine", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {})
        },
        body: JSON.stringify({ courses: pendingParsedCourses, instruction }),
        signal: ctrl.signal
      });
      const res = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(res?.detail || res?.error || "课表修正失败，请重试");
      const updated = Array.isArray(res?.courses) ? res.courses : [];
      pendingParsedCourses = updated;
      pendingParsedWarnings = Array.isArray(res?.warnings) ? res.warnings : audit_parsed_courses_client(updated);
      editingParsedIdx = -1;
      aiImportRefining = false;
      render_ai_parsed_workbench();
      const summary = res?.summary || `AI 已完成课表修正（当前 ${updated.length} 条）`;
      set_ai_import_status(summary);
      toast(summary);
    } catch (err) {
      aiImportRefining = false;
      render_ai_parsed_workbench();
      if (schedAiUserAborted) {
        set_ai_import_status("已停止本次 AI 课表修正");
      } else {
        const msg = err?.name === "AbortError" ? "AI 修正超时，请重试" : (err?.message || "AI 修正失败，请重试");
        set_ai_import_status(msg, true);
        toast(msg);
      }
    } finally {
      clearTimeout(timer);
      if (activeSchedAiCtrl === ctrl) activeSchedAiCtrl = null;
      set_sched_ai_running(false);
    }
  }

  $("schedAiPreview")?.addEventListener("click", e => {
    const actEl = e.target.closest("[data-wb-act]");
    if (!actEl) return;
    const act = actEl.dataset.wbAct;
    const idx = Number(actEl.dataset.wbIdx);
    if (act === "add") {
      if (!Array.isArray(pendingParsedCourses)) pendingParsedCourses = [];
      pendingParsedCourses.push({
        name: "新课程",
        day: 1,
        start: 1,
        end: 2,
        weeks: "1-" + schedState.totalWeeks,
        room: "",
        teacher: "",
        type: "理论"
      });
      editingParsedIdx = pendingParsedCourses.length - 1;
      pendingParsedWarnings = audit_parsed_courses_client(pendingParsedCourses);
      render_ai_parsed_workbench();
      const row = $("schedAiPreview")?.querySelector(`[data-wb-row="${editingParsedIdx}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      row?.querySelector('[data-ed-k="name"]')?.focus();
      return;
    }
    if (act === "edit") {
      editingParsedIdx = editingParsedIdx === idx ? -1 : idx;
      render_ai_parsed_workbench();
      return;
    }
    if (act === "cancel") {
      editingParsedIdx = -1;
      render_ai_parsed_workbench();
      return;
    }
    if (act === "save") {
      save_inline_wb_editor(idx);
      return;
    }
    if (act === "del") {
      if (!Array.isArray(pendingParsedCourses) || idx < 0 || idx >= pendingParsedCourses.length) return;
      pendingParsedCourses.splice(idx, 1);
      if (editingParsedIdx === idx) editingParsedIdx = -1;
      else if (editingParsedIdx > idx) editingParsedIdx--;
      pendingParsedWarnings = audit_parsed_courses_client(pendingParsedCourses);
      render_ai_parsed_workbench();
      set_ai_import_status(pendingParsedCourses.length
        ? `已删除 1 条，剩余 ${pendingParsedCourses.length} 条课程待确认导入。`
        : "已清空全部识别结果，可重新识别或点击“+ 补加一条”手动录入。");
      return;
    }
    if (act === "refine") {
      run_ai_schedule_refine();
    }
  });

  $("schedAiPreview")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target && e.target.id === "schedAiRefineInput") {
      e.preventDefault();
      run_ai_schedule_refine();
    }
  });

  window.extract_docx_for_ai = async function extract_docx_for_ai(file) {
    await window.load_ext_script_any([
      "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
      "https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js",
      "https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js"
    ]);
    const buf = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return { text: String(res?.value || "").trim() };
  };

  const openAiImportModal = () => {
    pendingAiFiles = [];
    pendingParsedCourses = null;
    pendingParsedWarnings = [];
    pendingParsedNotes = "";
    editingParsedIdx = -1;
    aiImportRefining = false;
    $("schedAiPreview")?.classList.add("hide");
    if ($("schedAiPreview")) $("schedAiPreview").innerHTML = "";
    update_ai_confirm_btn();
    if ($("schedAiFileLabel")) $("schedAiFileLabel").textContent = format_picked_ai_files_label([]);
    if ($("schedAiPasteText")) $("schedAiPasteText").value = "";
    set_ai_import_status("");
    $("scheduleAiImportDialog")?.showModal();
  };

  $("schedImportImgBtn")?.addEventListener("click", openAiImportModal);
  $("closeSchedAiImportDlg")?.addEventListener("click", () => $("scheduleAiImportDialog")?.close());
  ["scheduleCourseDialog", "scheduleSettingDialog", "scheduleTimetableDialog", "scheduleAiImportDialog"].forEach(id => {
    const dlg = $(id);
    dlg?.addEventListener("click", e => {
      if (e.target === dlg) dlg.close();
    });
  });

  // 桌面端周次条、日期条、分段切换
  $("schedDeskWeekStrip")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-w]");
    if (!btn) return;
    schedState.selectedWeek = Number(btn.dataset.w);
    render_schedule_all();
  });
  $("schedDeskDateStrip")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-d]");
    if (!btn) return;
    schedState.selectedDay = Number(btn.dataset.d);
    render_schedule_all();
  });
  document.querySelectorAll(".sched-dseg-btn").forEach(b => {
    b.addEventListener("click", () => switch_desk_sched_tab(b.dataset.dtab));
  });

  $("schedulePage")?.addEventListener("change", e => {
    const startInp = e.target.closest("[data-manage-start]");
    if (startInp && startInp.value) {
      schedState.startDate = startInp.value;
      schedQueueSync();
      render_schedule_all();
      toast("开学日期已更新");
      return;
    }
    const wkInp = e.target.closest("[data-manage-weeks]");
    if (wkInp) {
      const v = Math.min(30, Math.max(1, parseInt(wkInp.value, 10) || 18));
      schedState.totalWeeks = v;
      if (schedState.selectedWeek > v) schedState.selectedWeek = v;
      schedQueueSync();
      render_schedule_all();
    }
  });

  $("schedulePage")?.addEventListener("click", e => {
    const delBtn = e.target.closest("[data-del-idx]");
    if (delBtn) {
      e.stopPropagation();
      const idx = Number(delBtn.dataset.delIdx);
      if (!confirm("确定删除这门课程吗？")) return;
      schedState.courses.splice(idx, 1);
      schedQueueSync();
      render_schedule_all();
      toast("已删除课程");
      return;
    }
    const mAct = e.target.closest("[data-manage-act]");
    if (mAct) {
      const act = mAct.dataset.manageAct;
      if (act === "back") { switch_desk_sched_tab("matrix"); switch_mob_sched_tab("today"); }
      else if (act === "ai-import") openAiImportModal();
      else if (act === "add") open_schedule_course_dlg(-1);
      else if (act === "export") {
        const data = { startDate: schedState.startDate, totalWeeks: schedState.totalWeeks, courses: schedState.courses };
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        a.download = "超级课表备份_" + schedFmtDate(new Date()) + ".json";
        a.click();
        toast("已导出 JSON 备份");
      }
      else if (act === "import") $("schedImportFile")?.click();
      else if (act === "clear") {
        if (!confirm("确定清空所有已录入的课程吗？")) return;
        schedState.courses = [];
        schedQueueSync();
        render_schedule_all();
        toast("已清空课表");
      }
      return;
    }
    const act = e.target.closest("[data-empty-act]");
    if (!act) return;
    if (act.dataset.emptyAct === "add") open_schedule_course_dlg(-1);
    if (act.dataset.emptyAct === "img") openAiImportModal();
  });

  $("schedAiConfirmBtn")?.addEventListener("click", () => {
    if (!Array.isArray(pendingParsedCourses) || !pendingParsedCourses.length) return;
    if (editingParsedIdx >= 0) {
      if (!save_inline_wb_editor(editingParsedIdx)) return;
    }
    const mode = document.querySelector('input[name="schedImportMode"]:checked')?.value || "merge";
    schedState.courses = mode === "replace" ? pendingParsedCourses : [...schedState.courses, ...pendingParsedCourses];
    const count = pendingParsedCourses.length;
    pendingParsedCourses = null;
    pendingParsedWarnings = [];
    pendingParsedNotes = "";
    editingParsedIdx = -1;
    schedQueueSync();
    render_schedule_all();
    $("scheduleAiImportDialog")?.close();
    toast(`已确认导入 ${count} 条课程并同步云端`);
  });

  $("schedImgFile")?.addEventListener("change", e => {
    const files = e.target.files;
    accept_picked_ai_files(files);
    e.target.value = "";
  });

  window.load_ext_script_any = function load_ext_script_any(urls) {
    return new Promise(async (resolve, reject) => {
      for (const url of urls) {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const ok = await new Promise(res => {
          const s = document.createElement("script");
          s.src = url;
          s.onload = () => res(true);
          s.onerror = () => { s.remove(); res(false); };
          document.head.appendChild(s);
        });
        if (ok) { resolve(); return; }
      }
      reject(new Error("解析组件加载失败，请检查网络连接"));
    });
  }

  function set_ai_import_status(msg, isErr) {
    const el = $("schedAiStatus");
    if (!el) return;
    if (!msg) { el.classList.add("hide"); return; }
    el.textContent = msg;
    el.classList.toggle("is-err", !!isErr);
    el.classList.remove("hide");
  }

  window.extract_pdf_for_schedule = async function extract_pdf_for_schedule(file) {
    set_ai_import_status("正在加载 PDF 解析引擎…");
    await load_ext_script_any([
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
      "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js"
    ]);
    const pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error("PDF 引擎初始化失败");
    const buf = await file.arrayBuffer();
    // 禁用跨域 Worker，彻底避免浏览器安全策略拦截
    const pdf = await pdfjsLib.getDocument({ data: buf, disableWorker: true }).promise;
    set_ai_import_status(`正在读取 PDF（共 ${pdf.numPages} 页）…`);
    let fullText = "";
    for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const line = tc.items.map(it => it.str).join(" ").trim();
      if (line) fullText += line + "\n";
    }
    if (fullText.trim().length >= 30) {
      return { text: fullText.trim() };
    }
    set_ai_import_status("检测到扫描版 PDF，正在转成高清图片识别…");
    const page1 = await pdf.getPage(1);
    const vp = page1.getViewport({ scale: 2.4 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page1.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return { image: canvas.toDataURL("image/jpeg", 0.92) };
  }

  window.extract_xlsx_for_schedule = async function extract_xlsx_for_schedule(file) {
    set_ai_import_status("正在加载表格解析引擎…");
    await load_ext_script_any([
      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
      "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
      "https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js"
    ]);
    const buf = await file.arrayBuffer();
    const wb = window.XLSX.read(buf, { type: "array" });
    let txt = "";
    for (const name of wb.SheetNames.slice(0, 3)) {
      txt += `[工作表:${name}]\n` + window.XLSX.utils.sheet_to_csv(wb.Sheets[name]) + "\n";
    }
    return { text: txt };
  }

  // 拖拽文件支持（支持多张课表截图）
  const dropEl = $("schedAiPickFileBtn");
  if (dropEl) {
    dropEl.addEventListener("dragover", e => { e.preventDefault(); dropEl.style.borderColor = "var(--blue)"; });
    dropEl.addEventListener("dragleave", () => { dropEl.style.borderColor = ""; });
    dropEl.addEventListener("drop", e => {
      e.preventDefault();
      dropEl.style.borderColor = "";
      if (e.dataTransfer?.files?.length) accept_picked_ai_files(e.dataTransfer.files);
    });
  }

  $("schedAiRunBtn")?.addEventListener("click", async () => {
    const pasted = ($("schedAiPasteText")?.value || "").trim();
    if (!pendingAiFiles.length && !pasted) {
      set_ai_import_status("请先选择课表文件，或粘贴课表文字", true);
      return;
    }
    const mode = document.querySelector('input[name="schedImportMode"]:checked')?.value || "merge";
    const btn = $("schedAiRunBtn");
    schedAiUserAborted = false;
    set_sched_ai_running(true);
    set_ai_import_status("正在准备高清识图与课表解析…");
    schedSetSyncLabel("AI 深度解析中…", true);

    let localTick = null;
    let ctrl = new AbortController();
    activeSchedAiCtrl = ctrl;
    let timeoutId = null;

    try {
      let payload = {};
      if (pendingAiFiles.length) {
        const first = pendingAiFiles[0];
        const fname = (first.name || "").toLowerCase();
        const ftype = (first.type || "").toLowerCase();
        const isImg = ftype.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(fname);
        if (isImg) {
          set_ai_import_status(`正在高清预处理 ${pendingAiFiles.length} 张课表图片…`);
          const imgs = [];
          for (const f of pendingAiFiles.slice(0, 4)) {
            if (schedAiUserAborted || ctrl.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
            const slices = await compress_sched_image_slices(f);
            for (const s of slices) {
              if (imgs.length < 6) imgs.push(s);
            }
          }
          payload.images = imgs;
          payload.image = imgs[0];
          if (pasted) payload.text = pasted;
        } else if (ftype === "application/pdf" || fname.endsWith(".pdf")) {
          payload = await extract_pdf_for_schedule(first);
          if (pasted) payload.text = (payload.text ? payload.text + "\n" : "") + pasted;
        } else if (fname.endsWith(".xlsx") || fname.endsWith(".xls")) {
          payload = await extract_xlsx_for_schedule(first);
          if (pasted) payload.text += "\n" + pasted;
        } else if (fname.endsWith(".docx")) {
          set_ai_import_status("正在读取 Word 文档内容…");
          payload = await window.extract_docx_for_ai(first);
          if (pasted) payload.text = (payload.text ? payload.text + "\n" : "") + pasted;
        } else if (fname.endsWith(".json")) {
          const raw = await first.text();
          try {
            const j = JSON.parse(raw);
            const arr = Array.isArray(j) ? j : (Array.isArray(j.courses) ? j.courses : null);
            if (arr && arr.length && arr[0].name && arr[0].day) {
              pendingParsedCourses = arr;
              pendingParsedWarnings = audit_parsed_courses_client(arr);
              pendingParsedNotes = "已直接载入标准课表文件，可在下方核对或修改后确认导入。";
              editingParsedIdx = -1;
              if (j.startDate) schedState.startDate = j.startDate;
              render_ai_parsed_workbench();
              set_ai_import_status(`已解析出 ${arr.length} 条课程，核对无误后点击“确认导入课表”。`);
              return;
            }
          } catch {}
          payload.text = raw + (pasted ? "\n" + pasted : "");
        } else {
          payload.text = (await first.text()) + (pasted ? "\n" + pasted : "");
        }
      } else {
        payload.text = pasted;
      }

      if (schedAiUserAborted || ctrl.signal.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }

      const startedAt = Date.now();
      let lastStage = payload.images?.length
        ? (payload.images.length > pendingAiFiles.length
            ? "已自动切分长图，正在高清逐格识图…"
            : "正在高清识图并逐列核对星期与节次…")
        : "正在用强力 AI 深度思考解析课表结构…";
      set_ai_import_status(`${lastStage}（可随时点击“停止导入”）`);

      localTick = setInterval(() => {
        const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        set_ai_import_status(`${lastStage}（已用时 ${sec} 秒）`);
      }, 1000);

      timeoutId = setTimeout(() => ctrl.abort(), 185000);

      const resp = await fetch(api_base + "/schedule/parse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {})
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal: ctrl.signal
      });

      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      let res = null;

      if (ct.includes("text/event-stream") && resp.body) {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const d = line.slice(5).trim();
            if (!d || d === "[DONE]") continue;
            let ev = null;
            try { ev = JSON.parse(d); } catch { continue; }
            if (ev.type === "progress" && ev.stage) {
              lastStage = ev.stage;
              const sec = Number.isFinite(ev.elapsed) ? ev.elapsed : Math.round((Date.now() - startedAt) / 1000);
              set_ai_import_status(`${lastStage}（已用时 ${sec} 秒）`);
            } else if (ev.type === "result") {
              res = ev;
            } else if (ev.type === "error") {
              throw new Error(ev.error || "课表解析失败");
            }
          }
        }
      } else {
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data?.error || data?.message || `课表解析失败（HTTP ${resp.status}）`);
        res = data;
      }

      const parsed = Array.isArray(res?.courses) ? res.courses : [];
      if (!parsed.length) {
        set_ai_import_status("未识别到有效课程，请确认内容清晰或尝试直接粘贴文字", true);
        return;
      }

      pendingParsedCourses = parsed;
      pendingParsedWarnings = Array.isArray(res?.warnings) ? res.warnings : audit_parsed_courses_client(parsed);
      pendingParsedNotes = String(res?.notes || "").trim();
      editingParsedIdx = -1;
      render_ai_parsed_workbench();
      requestAnimationFrame(() => $("schedAiPreview")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      schedSetSyncLabel("识别完成，待确认", false);
      set_ai_import_status(pendingParsedWarnings.length
        ? `识别完成！共 ${parsed.length} 条课程（含 ${pendingParsedWarnings.length} 处提醒），修改核对后点“确认导入课表”。`
        : `识别完成！共 ${parsed.length} 条课程，可在下方微调或直接点击“确认导入课表”。`);
    } catch (err) {
      if (schedAiUserAborted) {
        schedSetSyncLabel("已停止解析", false);
        set_ai_import_status("已停止本次 AI 导入，可重新选择文件或再次识别");
      } else {
        schedSetSyncLabel("导入失败", false);
        const msg = err && err.name === "AbortError"
          ? "深度解析超时，建议分批上传或改用文字/表格导入"
          : (err?.message || "课表解析失败，请重试");
        set_ai_import_status(msg, true);
      }
    } finally {
      if (localTick) clearInterval(localTick);
      if (timeoutId) clearTimeout(timeoutId);
      if (activeSchedAiCtrl === ctrl) activeSchedAiCtrl = null;
      set_sched_ai_running(false);
    }
  });

  // 可视化周次点选器双向联动
  $("scWeeksGrid")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-wk]");
    if (!btn) return;
    const wk = Number(btn.dataset.wk);
    const set = schedParseWeeks($("scWeeks")?.value || "");
    if (set.has(wk)) set.delete(wk); else set.add(wk);
    $("scWeeks").value = format_sched_weeks_set(set);
    render_sched_weeks_grid();
  });
  $("scWeeks")?.addEventListener("input", render_sched_weeks_grid);
  document.querySelectorAll("[data-wq]").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.wq;
      const set = new Set();
      if (mode === "all") for (let w = 1; w <= schedState.totalWeeks; w++) set.add(w);
      if (mode === "odd") for (let w = 1; w <= schedState.totalWeeks; w += 2) set.add(w);
      if (mode === "even") for (let w = 2; w <= schedState.totalWeeks; w += 2) set.add(w);
      $("scWeeks").value = format_sched_weeks_set(set);
      render_sched_weeks_grid();
    });
  });

  // 复制为新课程
  $("btnSchedDuplicateCourse")?.addEventListener("click", () => {
    schedState.editingIdx = -1;
    $("schedCourseDlgTitle").textContent = "复制为新课程（请修改星期或节次）";
    $("btnSchedDeleteCourse")?.classList.add("hide");
    $("schedEditToolsRow")?.classList.add("hide");
    toast("已切换为新建副本，改好时间后点保存即可");
  });

  // 一键记为待办
  $("btnSchedToTask")?.addEventListener("click", async () => {
    const name = ($("scName")?.value || "").trim();
    if (!name) return;
    const note = prompt("输入这门课的待办内容：", `【${name}】完成课后作业`);
    if (!note || !note.trim()) return;
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: note.trim(), due_date: "" })
      });
      if (typeof load_tasks === "function") load_tasks();
      toast("已添加到「我的待办」");
    } catch (err) {
      toast(err?.message || "添加待办失败");
    }
  });
})();

async function execute_single_schedule_act(act) {
  const courses = Array.isArray(act.courses) ? act.courses : [];
  const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(String(act.start_date || ""));
  const hasWeeks = Number(act.total_weeks) >= 1 && Number(act.total_weeks) <= 30;
  if (hasStart) schedState.startDate = act.start_date;
  if (hasWeeks) schedState.totalWeeks = Number(act.total_weeks);

  if (act.mode === "merge" && courses.length) {
    schedState.courses = [...schedState.courses, ...courses];
  } else if (act.mode === "replace" && courses.length) {
    schedState.courses = courses;
  } else if (act.mode === "delete" && act.match) {
    const targetName = String(act.match.name || "").trim();
    const targetDay = act.match.day ? Number(act.match.day) : 0;
    const targetStart = act.match.start ? Number(act.match.start) : 0;
    schedState.courses = schedState.courses.filter(c => {
      const nameOk = !targetName || String(c.name || "").includes(targetName);
      const dayOk = !targetDay || Number(c.day) === targetDay;
      const startOk = !targetStart || Number(c.start) === targetStart;
      return !(nameOk && dayOk && startOk);
    });
  }
  schedQueueSync();
  render_schedule_all();
}

async function apply_ai_schedule_action(rawText, toolsEl, opts = {}) {
  if (!toolsEl || toolsEl.dataset.schedRendered) return;
  const allowWrite = opts && opts.allowWrite === true;
  const allowNav = opts && opts.allowNav === true;
  const txt = String(rawText || "");
  const actions = [];

  const agentMatch = txt.match(/<!--AGENT_ACTIONS\s*([\s\S]*?)\s*AGENT_ACTIONS-->/);
  if (agentMatch) {
    try {
      const arr = JSON.parse(agentMatch[1]);
      if (Array.isArray(arr)) actions.push(...arr);
    } catch {}
  }
  const schedMatch = txt.match(/<!--SCHEDULE_ACTION\s*([\s\S]*?)\s*SCHEDULE_ACTION-->/);
  if (schedMatch) {
    try {
      const obj = JSON.parse(schedMatch[1]);
      if (obj && obj.mode) actions.push({ type: "schedule", ...obj });
    } catch {}
  }

  if (!actions.length) return;
  toolsEl.dataset.schedRendered = "1";

  const autoLogs = [];
  const confirmActs = [];

  for (const act of actions) {
    if (!act || !act.type) continue;
    if (act.type === "open_doc" && act.title) {
      if (!allowNav && !allowWrite) continue;
      const docTitle = String(act.title || "").trim();
      if (docTitle && typeof open_doc_reader === "function") {
        autoLogs.push(`已为你打开校规原文《${docTitle}》`);
        setTimeout(() => open_doc_reader(docTitle), 320);
      }
    } else if (act.type === "navigate" && act.page) {
      if (!allowNav && !allowWrite) continue;
      const allowedPages = new Set(["home", "notices", "tasks", "ai", "knowledge", "schedule"]);
      if (allowedPages.has(act.page)) {
        autoLogs.push(`已为你跳转至「${act.page}」`);
        setTimeout(() => go(act.page), 450);
      }
    } else if (!allowWrite) {
      // 第三道物理安全锁：后端未授权写操作时，前端绝不静默执行任何待办/课表/公告写入
      continue;
    } else if (act.type === "add_tasks" && Array.isArray(act.items) && act.items.length) {
      const validItems = act.items.slice(0, 6).filter(it => String(it?.title || "").trim());
      if (validItems.length) confirmActs.push({ ...act, items: validItems });
    } else if ((act.type === "complete_task" || act.type === "delete_task") && act.id) {
      confirmActs.push(act);
    } else if (act.type === "schedule") {
      confirmActs.push(act);
    } else if (act.type === "publish_notice" && me?.role === "admin") {
      confirmActs.push(act);
    }
  }

  if (autoLogs.length) {
    const noteEl = document.createElement("div");
    noteEl.className = "sched-chat-confirm";
    noteEl.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>${schedEsc(autoLogs.join("；"))}</span></div>`;
    toolsEl.parentElement?.insertBefore(noteEl, toolsEl.nextSibling);
    toast(autoLogs[0]);
  }

  for (const act of confirmActs) {
    const card = document.createElement("div");
    card.className = "sched-chat-confirm ai-action-confirm-card";
    if (act.type === "add_tasks") {
      const previewLines = act.items.map(it =>
        `• ${schedEsc(it.title)}${it.due_date ? "（截止 " + schedEsc(it.due_date) + "）" : ""}`
      ).join("<br>");
      card.innerHTML = `
        <div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check-square"/></svg><span>待确认添加 ${act.items.length} 条待办</span></div>
        <div class="sched-chat-confirm-list">${previewLines}</div>
        <div class="sched-chat-confirm-actions">
          <button type="button" class="sched-btn-primary" data-act="confirm">确认加入待办</button>
          <button type="button" class="sched-btn-ghost" data-act="cancel">暂不添加</button>
        </div>`;
      card.querySelector('[data-act="confirm"]').onclick = async () => {
        let added = 0;
        for (const it of act.items) {
          try {
            await api("/tasks", {
              method: "POST",
              body: JSON.stringify({ title: String(it.title).trim(), due_date: String(it.due_date || "").trim() })
            });
            added++;
          } catch {}
        }
        if (typeof load_tasks === "function") load_tasks();
        toast(added ? `已添加 ${added} 条待办` : "添加待办失败");
        card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已确认添加 ${added} 条待办</span></div>`;
      };
      card.querySelector('[data-act="cancel"]').onclick = () => { card.remove(); toast("已忽略该待办建议"); };
    } else if (act.type === "complete_task") {
      card.innerHTML = `
        <div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check-square"/></svg><span>待确认完成待办：「${schedEsc(act.title || act.id)}」</span></div>
        <div class="sched-chat-confirm-actions">
          <button type="button" class="sched-btn-primary" data-act="confirm">确认标记完成</button>
          <button type="button" class="sched-btn-ghost" data-act="cancel">取消</button>
        </div>`;
      card.querySelector('[data-act="confirm"]').onclick = async () => {
        try {
          await api("/tasks/" + Number(act.id), { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
          if (typeof load_tasks === "function") load_tasks();
          toast("已标记为完成");
          card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已标记完成「${schedEsc(act.title || act.id)}」</span></div>`;
        } catch { toast("操作失败"); }
      };
      card.querySelector('[data-act="cancel"]').onclick = () => card.remove();
    } else if (act.type === "delete_task") {
      card.innerHTML = `
        <div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg><span>待确认删除待办：「${schedEsc(act.title || act.id)}」</span></div>
        <div class="sched-chat-confirm-actions">
          <button type="button" class="sched-btn-primary" data-act="confirm">确认删除</button>
          <button type="button" class="sched-btn-ghost" data-act="cancel">取消</button>
        </div>`;
      card.querySelector('[data-act="confirm"]').onclick = async () => {
        try {
          await api("/tasks/" + Number(act.id), { method: "DELETE" });
          if (typeof load_tasks === "function") load_tasks();
          toast("已删除待办");
          card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已删除待办「${schedEsc(act.title || act.id)}」</span></div>`;
        } catch { toast("删除失败"); }
      };
      card.querySelector('[data-act="cancel"]').onclick = () => card.remove();
    } else if (act.type === "schedule") {
      const courses = Array.isArray(act.courses) ? act.courses : [];
      const isReplace = act.mode === "replace";
      const previewLines = courses.slice(0, 4).map(c =>
        `• ${SCHED_DAY_SHORT[c.day] || ""} 第${c.start}-${c.end}节《${schedEsc(c.name)}》${c.room ? " @ " + schedEsc(c.room) : ""}`
      ).join("<br>");
      card.innerHTML = `
        <div class="sched-chat-confirm-head"><svg class="ico ico-star" aria-hidden="true"><use href="#i-ai-brand"/></svg><span>${isReplace ? `待确认：整套替换为 ${courses.length} 条新课程` : `待确认：更新超级课表（${courses.length ? courses.length + " 条课程" : "课表调整"}）`}</span></div>
        ${previewLines ? `<div class="sched-chat-confirm-list">${previewLines}${courses.length > 4 ? `<br>…等共 ${courses.length} 条` : ""}</div>` : ""}
        <div class="sched-chat-confirm-actions">
          <button type="button" class="sched-btn-primary" data-act="confirm">${isReplace ? "确认覆盖并同步" : "确认写入课表"}</button>
          <button type="button" class="sched-btn-ghost" data-act="cancel">暂不应用</button>
        </div>`;
      card.querySelector('[data-act="confirm"]').onclick = async () => {
        await execute_single_schedule_act(act);
        toast("已确认更新课表并同步云端");
        card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已写入超级课表并同步云端</span></div>`;
      };
      card.querySelector('[data-act="cancel"]').onclick = () => { card.remove(); toast("已取消课表修改"); };
    } else if (act.type === "publish_notice") {
      card.innerHTML = `
        <div class="sched-chat-confirm-head"><svg class="ico ico-star" aria-hidden="true"><use href="#i-bell"/></svg><span>管理员公告待确认：《${schedEsc(act.title || "校园通知")}》</span></div>
        <div class="sched-chat-confirm-list">${schedEsc(String(act.body || "").slice(0, 120))}</div>
        <div class="sched-chat-confirm-actions">
          <button type="button" class="sched-btn-primary" data-act="confirm">确认发布全校公告</button>
          <button type="button" class="sched-btn-ghost" data-act="cancel">取消</button>
        </div>`;
      card.querySelector('[data-act="confirm"]').onclick = async () => {
        try {
          await api("/notices", {
            method: "POST",
            body: JSON.stringify({
              title: act.title || "校园通知",
              category: act.category || "校园通知",
              audience: act.audience || "全体学生",
              body: act.body || "",
              deadline: act.deadline || ""
            })
          });
          if (typeof load_notices === "function") load_notices();
          toast("公告已正式发布");
          card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已正式发布通知公告</span></div>`;
        } catch (err) {
          toast(err?.message || "发布失败");
        }
      };
      card.querySelector('[data-act="cancel"]').onclick = () => { card.remove(); toast("已取消发布"); };
    }
    toolsEl.parentElement?.insertBefore(card, toolsEl.nextSibling);
  }
}

(function init_all_dialog_swipe_to_close() {
  document.querySelectorAll("dialog:not(#docDialog)").forEach(dlg => {
    // 点击弹窗外部遮罩关闭
    dlg.addEventListener("click", e => {
      if (e.target === dlg) dlg.close();
    });

    let startY = 0, startTime = 0, curY = 0, dragging = false, allowDrag = false;

    dlg.addEventListener("touchstart", e => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const rect = dlg.getBoundingClientRect();
      const inHeader = (t.clientY - rect.top) <= 72;
      const atTop = dlg.scrollTop <= 1;
      // 只有触碰顶部手柄/标题区，或者内容已在最顶部时，才允许触发下拉关闭
      allowDrag = inHeader || atTop;
      startY = t.clientY;
      startTime = Date.now();
      curY = 0;
      dragging = false;
    }, { passive: true });

    dlg.addEventListener("touchmove", e => {
      if (!allowDrag || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        if (dragging) {
          curY = 0;
          dlg.style.transform = "";
        }
        return;
      }
      // 若内部有正在滚动的子列表且未到顶，则不拦截
      const scrollable = e.target.closest(".sched-ai-preview, .sched-clist, .school-list, .xz-select-menu, textarea, select");
      if (scrollable && scrollable.scrollTop > 0) return;

      if (dy > 8) {
        dragging = true;
        curY = dy;
        dlg.style.transition = "none";
        dlg.style.transform = `translateY(${dy}px)`;
        if (e.cancelable) e.preventDefault();
      }
    }, { passive: false });

    const finishDrag = () => {
      if (!dragging) return;
      dragging = false;
      const dt = Math.max(1, Date.now() - startTime);
      const velocity = curY / dt;
      if (curY > 75 || (curY > 30 && velocity > 0.45)) {
        dlg.style.transition = "transform 0.18s cubic-bezier(0.32, 0.72, 0.3, 1)";
        dlg.style.transform = "translateY(100%)";
        setTimeout(() => {
          dlg.close();
          dlg.style.transition = "";
          dlg.style.transform = "";
        }, 175);
      } else {
        dlg.style.transition = "transform 0.22s cubic-bezier(0.32, 0.72, 0.3, 1)";
        dlg.style.transform = "translateY(0)";
        setTimeout(() => {
          dlg.style.transition = "";
          dlg.style.transform = "";
        }, 220);
      }
    };

    dlg.addEventListener("touchend", finishDrag, { passive: true });
    dlg.addEventListener("touchcancel", finishDrag, { passive: true });
  });
})();


// ==================== v1.083 全站 GPU 液态玻璃胶囊滑动+按压一体联动引擎（零误弹、高帧率） ====================
(function init_sliding_glass_pills() {
  const sliderSyncers = [];
  window.sync_nav_sliders = () => {
    sliderSyncers.forEach(fn => { try { fn(); } catch {} });
  };
  function bindSlider(container, itemSel, activeSel, pillVariant) {
    if (!container || container.dataset.lgSlideBound) return;
    container.dataset.lgSlideBound = "1";
    container.classList.add("lg-slide-host");

    const ensurePill = () => {
      let pill = container.querySelector(":scope > .lg-slide-pill");
      if (!pill) {
        pill = document.createElement("span");
        pill.className = "lg-slide-pill " + pillVariant;
        pill.setAttribute("aria-hidden", "true");
        container.insertBefore(pill, container.firstChild);
      }
      return pill;
    };

    let rafId = 0;
    let isInternal = false;
    let pressingActive = false;
    let lastClickAt = 0;
    let wasHidden = container.offsetWidth === 0 || container.offsetHeight === 0;

    const applyTransform = (pill, x, y, press) => {
      pill.style.transform = press
        ? `translate3d(${x}px, ${y}px, 0) scale3d(0.965, 0.965, 1)`
        : `translate3d(${x}px, ${y}px, 0)`;
    };

    const snapPill = (pill, x, y, w, h) => {
      pill.style.transition = "none";
      pill.style.width = w + "px";
      pill.style.height = h + "px";
      applyTransform(pill, x, y, false);
      pill.classList.add("is-ready");
      void pill.offsetWidth;
      pill.style.transition = "";
    };

    const syncNow = (instant) => {
      isInternal = true;
      try {
        const pill = ensurePill();
        const items = container.querySelectorAll(itemSel);
        items.forEach(el => {
          el.classList.add("lg-slide-item");
          el.classList.remove("lg-slide-active-clean");
        });
        const active = container.querySelector(activeSel);
        if (!active || active.offsetWidth === 0 || active.offsetHeight === 0) {
          wasHidden = true;
          pill.classList.remove("is-ready", "is-pressing");
          return;
        }
        active.classList.add("lg-slide-active-clean");
        const x = active.offsetLeft;
        const y = active.offsetTop;
        const w = active.offsetWidth;
        const h = active.offsetHeight;

        const isBrandNewPill = !pill.classList.contains("is-ready") || pill.style.width === "";
        const justClicked = (Date.now() - lastClickAt) < 600;
        const hasPrev = container.dataset.lgPrevW !== undefined;
        const prevX = Number(container.dataset.lgPrevX || x);
        const prevY = Number(container.dataset.lgPrevY || y);
        const prevW = Number(container.dataset.lgPrevW || w);
        const prevH = Number(container.dataset.lgPrevH || h);
        const moved = hasPrev && (prevX !== x || prevY !== y || prevW !== w || prevH !== h);

        // 1. 容器刚从隐藏切为显示、或未曾发生点击而重绘时：必须瞬时落位，绝不能从第1周(0,0)往右弹飞！
        if (instant || wasHidden || (isBrandNewPill && (!justClicked || !hasPrev))) {
          wasHidden = false;
          snapPill(pill, x, y, w, h);
        } else if (isBrandNewPill && justClicked && moved) {
          // 2. 仅当用户刚刚点击并触发了 innerHTML 重绘时，先瞬移到旧坐标再下一帧丝滑滑向新坐标
          wasHidden = false;
          snapPill(pill, prevX, prevY, prevW, prevH);
          requestAnimationFrame(() => {
            pill.style.width = w + "px";
            pill.style.height = h + "px";
            applyTransform(pill, x, y, false);
          });
        } else {
          // 3. 常规点击切换：直接同帧纯 GPU translate3d 滑动
          wasHidden = false;
          if (pill.style.width !== w + "px") pill.style.width = w + "px";
          if (pill.style.height !== h + "px") pill.style.height = h + "px";
          applyTransform(pill, x, y, pressingActive && active.classList.contains("is-pressing"));
          pill.classList.add("is-ready");
        }

        container.dataset.lgPrevX = String(x);
        container.dataset.lgPrevY = String(y);
        container.dataset.lgPrevW = String(w);
        container.dataset.lgPrevH = String(h);
      } finally {
        queueMicrotask(() => { isInternal = false; });
      }
    };

    const sync = (instant, immediate) => {
      cancelAnimationFrame(rafId);
      if (immediate) {
        syncNow(instant);
      } else {
        rafId = requestAnimationFrame(() => syncNow(instant));
      }
    };

    const clearPress = () => {
      if (!pressingActive) return;
      pressingActive = false;
      container.querySelectorAll(".lg-slide-item.is-pressing").forEach(el => el.classList.remove("is-pressing"));
      const pill = container.querySelector(":scope > .lg-slide-pill");
      if (pill) {
        pill.classList.remove("is-pressing");
        const x = Number(container.dataset.lgPrevX || 0);
        const y = Number(container.dataset.lgPrevY || 0);
        if (container.dataset.lgPrevW !== undefined) applyTransform(pill, x, y, false);
      }
    };

    container.addEventListener("pointerdown", (e) => {
      const item = e.target && e.target.closest ? e.target.closest(itemSel) : null;
      if (!item || !container.contains(item)) return;
      lastClickAt = Date.now();
      pressingActive = true;
      item.classList.add("is-pressing");
      const active = container.querySelector(activeSel);
      const pill = container.querySelector(":scope > .lg-slide-pill");
      if (pill && active === item && container.dataset.lgPrevW !== undefined) {
        pill.classList.add("is-pressing");
        applyTransform(pill, Number(container.dataset.lgPrevX || 0), Number(container.dataset.lgPrevY || 0), true);
      }
    }, { passive: true });

    container.addEventListener("pointerup", clearPress, { passive: true });
    container.addEventListener("pointercancel", clearPress, { passive: true });
    container.addEventListener("pointerleave", clearPress, { passive: true });

    container.addEventListener("click", () => {
      lastClickAt = Date.now();
      clearPress();
      queueMicrotask(() => sync(false, true));
    }, { passive: true });

    const mo = new MutationObserver(() => {
      if (!isInternal) sync(false, false);
    });
    mo.observe(container, { attributes: true, childList: true, subtree: true, attributeFilter: ["class"] });
    window.addEventListener("resize", () => sync(true, false), { passive: true });
    if (window.ResizeObserver) {
      let lastCW = container.clientWidth, lastCH = container.clientHeight;
      new ResizeObserver(() => {
        const cw = container.clientWidth, ch = container.clientHeight;
        if (cw !== lastCW || ch !== lastCH) {
          lastCW = cw;
          lastCH = ch;
          sync(true, false);
        }
      }).observe(container);
    }
    sync(true, true);
    sliderSyncers.push(() => sync(false, false));
  }

  const setupAll = () => {
    bindSlider(document.querySelector(".mobile-tabbar"), ".tab-item", ".tab-item.active", "is-nav-glass");
    bindSlider(document.getElementById("sidebar"), ".nav", ".nav.active", "is-nav-glass");
    document.querySelectorAll(".ai-seg").forEach(el => bindSlider(el, ".ai-seg-btn", ".ai-seg-btn.active", "is-blue"));
    bindSlider(document.querySelector(".sched-m-seg"), ".sched-seg-btn", ".sched-seg-btn.on", "is-blue");
    bindSlider(document.querySelector(".sched-d-seg"), ".sched-dseg-btn", ".sched-dseg-btn.on", "is-blue");
    bindSlider(document.querySelector(".authbox .tabs"), "button", "button.selected", "is-blue");
    document.querySelectorAll("#docDialog .doc-font-group, .doc-m-font-seg").forEach(el =>
      bindSlider(el, "button", "button.active", "is-blue")
    );
    bindSlider(document.querySelector(".cat-pills"), ".pill-btn", ".pill-btn.active", "is-blue");
    bindSlider(document.getElementById("knowledgePills"), ".pill", ".pill.active", "is-blue");
    bindSlider(document.getElementById("schedDeskDateStrip"), ".sched-date-chip", ".sched-date-chip.on", "is-blue");
    bindSlider(document.getElementById("schedDateStrip"), ".sched-date-chip", ".sched-date-chip.on", "is-blue");
    bindSlider(document.getElementById("schedDeskWeekStrip"), ".sched-week-chip", ".sched-week-chip.on", "is-blue");
    bindSlider(document.getElementById("schedWeekStrip"), ".sched-week-chip", ".sched-week-chip.on", "is-blue");
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupAll);
  } else {
    setupAll();
  }
})();

/* ================================================================
   v1.114: 1) 移动端软键盘防顶起底栏（.kb-open 双路感知）
           2) 登录页深浅色切换同步（#authThemeToggle）
           3) 全局 Ctrl+K 玻璃聚合搜索（Spotlight）
   ================================================================ */
(function init_v114_ux_suite() {
  // 1. 移动端软键盘防顶起 6-Tab 底栏
  const isTextEditable = el => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden"].includes(t) && !el.readOnly && !el.disabled;
    }
    return false;
  };

  let baseWinH = window.innerHeight || 0;
  let kbBlurTimer = 0;
  let hadViewportShrink = false;

  const setKbOpen = open => {
    const active = Boolean(open) && window.innerWidth <= 960;
    document.body.classList.toggle("kb-open", active);
  };

  const evaluateKeyboard = () => {
    if (window.innerWidth > 960) {
      hadViewportShrink = false;
      setKbOpen(false);
      return;
    }
    const ae = document.activeElement;
    const focused = isTextEditable(ae);
    const vvH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    if (vvH > baseWinH) baseWinH = vvH;
    const shrink = baseWinH - vvH;
    if (shrink >= 120) {
      hadViewportShrink = true;
      if (focused) {
        clearTimeout(kbBlurTimer);
        setKbOpen(true);
      }
    } else if (hadViewportShrink && shrink < 80) {
      // 用户按返回键收起软键盘但输入框仍保有焦点时，也立刻恢复底部导航栏
      hadViewportShrink = false;
      setKbOpen(false);
    } else if (!focused && shrink < 90) {
      setKbOpen(false);
    }
  };

  document.addEventListener("focusin", e => {
    if (window.innerWidth <= 960 && isTextEditable(e.target)) {
      clearTimeout(kbBlurTimer);
      setKbOpen(true);
    }
  }, true);

  document.addEventListener("focusout", () => {
    clearTimeout(kbBlurTimer);
    kbBlurTimer = setTimeout(() => {
      if (!isTextEditable(document.activeElement)) setKbOpen(false);
    }, 120);
  }, true);

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", evaluateKeyboard, { passive: true });
  }
  window.addEventListener("orientationchange", () => {
    baseWinH = window.innerHeight || 0;
    setKbOpen(false);
  }, { passive: true });

  // 2. 登录页主题切换按钮与站内 #themeToggle 100% 同步
  $("authThemeToggle")?.addEventListener("click", () => {
    if (typeof handle_toggle_theme === "function") handle_toggle_theme();
    else $("themeToggle")?.click();
  });
  sync_theme_icon(document.documentElement.classList.contains("dark"));

  // 3. 全局 Ctrl+K 玻璃聚合搜索（Spotlight）
  const dlg = $("globalSearchDialog");
  const inp = $("globalSearchInput");
  const bodyEl = $("globalSearchBody");
  let spItems = [];
  let spActiveIdx = 0;

  const ensureKbCatalogLoaded = async () => {
    if (Array.isArray(all_knowledge_docs_cache) && all_knowledge_docs_cache.length) return all_knowledge_docs_cache;
    if (Array.isArray(knowledge_docs) && knowledge_docs.length) return knowledge_docs;
    try {
      const res = await api("/knowledge");
      const docs = Array.isArray(res?.docs) ? res.docs : [];
      if (docs.length) all_knowledge_docs_cache = docs;
      return docs;
    } catch {
      return [];
    }
  };

  const renderSpotlight = async rawQ => {
    if (!bodyEl) return;
    const q = String(rawQ || "").trim();
    const ql = q.toLowerCase();
    const items = [];

    if (!q) {
      items.push(
        { group: "快捷入口", mod: "ai", icon: "ai-brand", title: "咨询文理智办 AI", sub: "校规问答、课表查询与办事指南", run: () => { go("ai"); setTimeout(() => $("question")?.focus(), 120); } },
        { group: "快捷入口", mod: "schedule", icon: "calendar", title: "打开超级课表", sub: "查看本周课程与 AI 导课表工作台", run: () => go("schedule") },
        { group: "快捷入口", mod: "knowledge", icon: "book", title: "浏览校规制度库", sub: `查阅 ${kb_total_text()} 份本校规章与校园服务指南`, run: () => go("knowledge") },
        { group: "快捷入口", mod: "notices", icon: "bell", title: "查看校园通知公告", sub: "最新教务与学工通知动态", run: () => go("notices") },
        { group: "快捷入口", mod: "tasks", icon: "check-square", title: "管理我的待办", sub: "查看未完成事项与进度", run: () => go("tasks") },
        { group: "效率工具", mod: "home", icon: "clipboard", title: "校园办事向导与文书生成", sub: "材料清单核对、流程指引与一键导出 Word 申请表", run: () => window.open_guide_wizard?.() },
        { group: "效率工具", mod: "knowledge", icon: "gauge", title: "学业 GPA 换算与学位预警", sub: "实时核算平均学分绩点并对照本校学位标准预警", run: () => window.open_gpa_calc?.() },
        { group: "效率工具", mod: "schedule", icon: "clock", title: "超级课表助手（倒计时 · 空档 · 导出日历）", sub: "考试倒计时、本周空闲时段与 .ics 手机日历导出", run: () => window.open_sched_tools?.("exams") }
      );
    } else {
      // 1) 校规制度库
      const kbList = await ensureKbCatalogLoaded();
      kbList.filter(d => {
        const hay = `${d.title || ""} ${d.dept || ""} ${d.category || ""}`.toLowerCase();
        return hay.includes(ql);
      }).slice(0, 5).forEach(d => {
        items.push({
          group: "校规制度原文",
          mod: "knowledge",
          icon: "book",
          title: d.title,
          sub: `${d.dept || "学校部门"} · ${d.category || "规章制度"}`,
          run: () => open_doc_reader(d.title)
        });
      });

      // 2) 通知公告
      (Array.isArray(notices) ? notices : []).filter(n =>
        `${n.title || ""} ${n.body || ""} ${n.category || ""}`.toLowerCase().includes(ql)
      ).slice(0, 4).forEach(n => {
        items.push({
          group: "校园通知公告",
          mod: "notices",
          icon: "bell",
          title: n.title,
          sub: `${n.category || "通知"}${n.deadline ? " · 截止 " + n.deadline : ""}`,
          run: () => {
            go("notices");
            if ($("noticeSearch")) {
              $("noticeSearch").value = q;
              $("noticeSearch").dispatchEvent(new Event("input"));
            }
          }
        });
      });

      // 3) 个人课表
      (Array.isArray(schedState?.courses) ? schedState.courses : []).filter(c =>
        `${c.name || ""} ${c.room || ""} ${c.teacher || ""}`.toLowerCase().includes(ql)
      ).slice(0, 4).forEach(c => {
        items.push({
          group: "超级课表",
          mod: "schedule",
          icon: "calendar",
          title: c.name,
          sub: `${SCHED_DAY_SHORT[c.day] || ""} 第${c.start}-${c.end}节 · ${c.weeks || ""}周${c.room ? " · " + c.room : ""}`,
          run: () => go("schedule")
        });
      });

      // 4) 我的待办
      (Array.isArray(tasks) ? tasks : []).filter(t =>
        String(t.title || "").toLowerCase().includes(ql)
      ).slice(0, 4).forEach(t => {
        items.push({
          group: "我的待办",
          mod: "tasks",
          icon: "check-square",
          title: t.title,
          sub: `${t.status === "completed" ? "已完成" : "待处理"}${t.due_date ? " · 截止 " + t.due_date : ""}`,
          run: () => go("tasks")
        });
      });

      // 5) 直问 AI
      items.push({
        group: "文理智办 AI",
        mod: "ai",
        icon: "ai-brand",
        title: `直接问 AI：「${q}」`,
        sub: "由后端智脑自主检索校规并极简直答",
        run: () => {
          go("ai");
          const qEl = $("question");
          if (qEl) {
            qEl.value = q;
            if (typeof auto_resize_question === "function") auto_resize_question();
            $("askForm")?.requestSubmit();
          }
        }
      });
    }

    spItems = items;
    spActiveIdx = 0;

    let lastGroup = "";
    bodyEl.innerHTML = items.map((it, idx) => {
      const grp = it.group !== lastGroup ? `<div class="spotlight-group">${esc(it.group)}</div>` : "";
      lastGroup = it.group;
      const modCls = it.mod ? ` mod-${it.mod}` : "";
      return `${grp}<button type="button" class="spotlight-item${idx === 0 ? " is-active" : ""}" data-sp-idx="${idx}">
        <span class="spotlight-ico${modCls}">${ico(it.icon)}</span>
        <span class="spotlight-text"><b>${esc(it.title)}</b><small>${esc(it.sub || "")}</small></span>
        <span class="spotlight-go">↵</span>
      </button>`;
    }).join("");
  };

  const syncActiveRow = () => {
    if (!bodyEl) return;
    bodyEl.querySelectorAll(".spotlight-item").forEach((el, i) => {
      const on = i === spActiveIdx;
      el.classList.toggle("is-active", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  };

  const openSpotlight = () => {
    if (!dlg || !$("app") || $("app").classList.contains("hide")) return;
    if (inp) inp.value = "";
    renderSpotlight("");
    if (!dlg.open) dlg.showModal();
    setTimeout(() => inp?.focus(), 40);
  };

  const runSpotlightItem = idx => {
    const it = spItems[idx];
    if (!it) return;
    dlg?.close();
    if (typeof it.run === "function") it.run();
  };

  $("globalSearchBtn")?.addEventListener("click", openSpotlight);
  $("closeGlobalSearchDlg")?.addEventListener("click", () => dlg?.close());
  dlg?.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });

  let spTimer = 0;
  inp?.addEventListener("input", () => {
    clearTimeout(spTimer);
    spTimer = setTimeout(() => renderSpotlight(inp.value), 90);
  });

  inp?.addEventListener("keydown", e => {
    if (!spItems.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      spActiveIdx = (spActiveIdx + 1) % spItems.length;
      syncActiveRow();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      spActiveIdx = (spActiveIdx - 1 + spItems.length) % spItems.length;
      syncActiveRow();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSpotlightItem(spActiveIdx);
    }
  });

  bodyEl?.addEventListener("click", e => {
    const btn = e.target.closest("[data-sp-idx]");
    if (!btn) return;
    runSpotlightItem(Number(btn.dataset.spIdx));
  });

  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "k") {
      e.preventDefault();
      if (dlg?.open) dlg.close();
      else openSpotlight();
    }
  });
})();

/* ================================================================
   v1.116: 全站高价值校园实用工具套件
           1) 校园办事向导与标准 Word/PDF 申请表一键生成
           2) 学业 GPA 换算与本校学位红线预警
           3) 超级课表助手（考试倒计时 · 本周空档查询 · .ics 手机日历导出）
   ================================================================ */
(function init_v116_campus_tools() {
  /* ---------- 1. 校园办事向导与文书生成 ---------- */
  const CAMPUS_GUIDES = [
    {
      id: "defer",
      name: "缓考申请",
      dept: "教务处",
      office: "所在二级学院教务办 → 教务处考试科",
      docTitle: "西安文理学院考试管理规定",
      docFormTitle: "西安文理学院本科生课程缓考申请表",
      reasonPlaceholder: "例如：因突发急性肠胃炎/发热住院，无法按时参加《高等数学》期末考试，已附二级甲等以上医院诊断证明，特申请缓考。",
      materials: [
        "《西安文理学院学生缓考申请表》（一式两份）",
        "二级甲等及以上医院出具的诊断证明、病历及缴费票据（因病缓考必备）",
        "学生证与身份证复印件",
        "因直系亲属变故或校级竞赛冲突申请的，附相关单位证明材料"
      ],
      steps: [
        "务必在考试开始前提出申请（急诊突发情况须第一时间向辅导员与任课教师报备，并在考后规定工作日内补交证明）。",
        "填写并打印《缓考申请表》，附医院证明材料交由辅导员与所在二级学院教学院长审核签字盖章。",
        "经学院汇总报教务处审批备案后生效；缓考通常安排在下一学期初随补考一并进行，成绩按正常考试记载。"
      ]
    },
    {
      id: "major",
      name: "转专业申请",
      dept: "教务处",
      office: "转出学院教务办 → 转入学院考核组 → 教务处学籍科",
      docTitle: "西安文理学院普通本科生转专业及大类专业分流管理办法",
      docFormTitle: "西安文理学院普通本科生转专业申请表",
      reasonPlaceholder: "例如：本人在大一期间已修课程平均学分绩点良好、无不及格科目，对计算机/软件工程方向具有浓厚学术兴趣并已自学相关课程，特申请转入目标专业。",
      materials: [
        "《西安文理学院本科生转专业申请表》",
        "教务系统导出并加盖学院公章的历学期全科成绩单及绩点证明",
        "个人学业规划与转专业理由说明（附竞赛获奖或特长证明更佳）",
        "身份证与学生证复印件"
      ],
      steps: [
        "关注每学年教务处发布的转专业及大类分流通知，对照转入学院公布的接收人数与成绩/GPA 门槛。",
        "在规定时间内通过教务系统或纸质渠道提交《转专业申请表》及成绩单，经转出学院审核同意。",
        "按时参加转入学院组织的笔试、上机或综合面试考核，经学校公示无异议后办理学籍异动与课程学分置换。"
      ]
    },
    {
      id: "suspend",
      name: "休学 / 复学",
      dept: "教务处",
      office: "所在二级学院 → 学生工作部 / 校医院 → 教务处学籍科",
      docTitle: "学生申请休学、复学办理流程",
      docFormTitle: "西安文理学院本科生休学（复学）申请表",
      reasonPlaceholder: "例如：因健康治疗/创新创业/家庭特殊原因，拟申请自 2026 年 9 月至 2027 年 8 月休学一学年，期满后按期返校复学。",
      materials: [
        "《西安文理学院学生休学 / 复学申请表》",
        "因病休学：二级甲等以上医院诊断证明及校医院复核意见；因病复学须附医院康复诊断证明",
        "家长知情同意书及家长身份证复印件",
        "学生证、离校/退宿交接手续单"
      ],
      steps: [
        "向辅导员与所在学院提交休学或复学书面申请及相关佐证材料，家长须书面知情确认。",
        "因病办理者先经校医院审核诊断证明；创业休学须附工商营业执照或孵化项目材料。",
        "学院审核签章后报教务处审批发文，休学期满前须提前一个月提交复学申请并办理注册选课。"
      ]
    },
    {
      id: "aid",
      name: "困难认定与资助",
      dept: "学生资助管理中心",
      office: "所在二级学院资助工作小组 → 学生资助管理中心",
      docTitle: "西安文理学院家庭经济困难学生认定工作实施办法（修订）",
      docFormTitle: "西安文理学院家庭经济困难情况个人说明",
      reasonPlaceholder: "例如：家庭主要劳动力务农/收入较低，且家中有两位在校就读子女及长辈需长期医疗支出，家庭经济负担较重，特申请本学年家庭经济困难认定。",
      materials: [
        "《陕西省家庭经济困难学生认定申请表》（手写签名承诺）",
        "建档立卡、低保、特困供养、残疾、孤儿或突发重病/受灾等相关证明复印件（如有）",
        "个人身份证与家庭户口簿复印件",
        "本人已绑定学校的银行卡信息（用于助学金发放）"
      ],
      steps: [
        "每年秋季学期开学初按学院通知填写《家庭经济困难学生认定申请表》并如实说明家庭情况。",
        "经班级民主评议小组评议、学院认定工作组审核并在适当范围内公示（严格保护个人隐私）。",
        "认定通过后建立困难生档案，可依次申请国家助学金、国家励志奖学金、勤工助学岗位及临时困难补助。"
      ]
    },
    {
      id: "studentid",
      name: "学生证与优惠卡",
      dept: "学生工作部",
      office: "所在二级学院学工办 → 学生工作部（029-88215725）",
      docTitle: "西安文理学院学生证补办与火车票学生优惠卡办理指南",
      docFormTitle: "西安文理学院学生证补办 / 优惠卡变更申请表",
      reasonPlaceholder: "例如：本人不慎遗失学生证（或火车票优惠卡消磁/家庭住址变更为 XX 省 XX 市），现申请补办学生证并办理学生火车票优惠资质核验。",
      materials: [
        "《西安文理学院学生证补办申请表》（经辅导员及学院签章）",
        "近期一寸免冠蓝/白底证件照 1 张",
        "身份证复印件；如需变更火车票乘车区间，须附家庭新住址户籍或居住证明"
      ],
      steps: [
        "确认证件遗失后，填写《学生证补办申请表》并贴好证件照，交所在学院学工办审核盖章。",
        "由学院汇总或本人按通知时段交至学生工作部（处）统一印制补发新证并加盖钢印。",
        "每年记得在铁路 12306 App 完成学生资质在线核验或按学院通知完成优惠卡充磁，确保寒暑假正常购票。"
      ]
    },
    {
      id: "army",
      name: "参军入伍与补偿",
      dept: "学生工作部",
      office: "学校武装部 / 学生资助管理中心 / 教务处",
      docTitle: "学生参军入伍保留学籍流程",
      docFormTitle: "西安文理学院应征入伍保留学籍及资助申请说明",
      reasonPlaceholder: "例如：本人已通过 2026 年秋季应征入伍体检政审并取得《入伍通知书》，现申请保留学籍至退役后两年，并申请应征入伍服兵役国家学费补偿。",
      materials: [
        "《应征入伍普通高等学校录取新生/在校生保留学籍申请表》",
        "《入伍通知书》原件及复印件",
        "全国征兵网打印并经入伍地征兵办盖章的《高校学生国家教育资助申请表》",
        "本人身份证、学生证及绑定银行卡复印件"
      ],
      steps: [
        "在全国征兵网完成报名并体检政审通过取得《入伍通知书》后，第一时间联系学校武装部与辅导员。",
        "提交保留学籍材料至教务处办理学籍保留（保留至退役后两年内），同时向资助中心提交学费补偿/代偿申请。",
        "退役返校复学时持《退役证》办理复学，并自动享受全日制退役士兵学费减免与国家助学金政策。"
      ]
    },
    {
      id: "cert",
      name: "毕业/学位证补办",
      dept: "教务处",
      office: "学校档案馆（029-88215404）→ 教务处学籍科",
      docTitle: "毕业证书、学位证书补办",
      docFormTitle: "西安文理学院毕业证明书 / 学位证明书补办申请表",
      reasonPlaceholder: "例如：本人系 XXXX 届 XX 专业毕业生，因保管不慎遗失毕业证书/学位证书原件，现申请查档并补办与原件同等法律效力的证明书。",
      materials: [
        "《补办毕业证明书 / 学位证明书申请表》",
        "本人有效身份证原件及复印件（委托他人代办需附亲笔授权委托书及双方身份证）",
        "学校档案馆查档出具的录取花名册与毕业/学位授予审批表复印件（加盖档案馆公章）",
        "近期二寸蓝底免冠证件照（纸质版及同底电子版）"
      ],
      steps: [
        "先携带身份证到学校档案馆（029-88215404）调取本人当年录取与毕业/学位审批底档并盖章。",
        "向教务处学籍科提交申请表、档案复印件、身份证复印件及蓝底照片审核核验。",
        "审核通过后由学校按教育部规定制作《毕业证明书》或《学位证明书》（与原证书具有同等法律效力，并同步更新学信网）。"
      ]
    },
    {
      id: "appeal",
      name: "处分解除与申诉",
      dept: "学生工作部",
      office: "所在二级学院 → 学生工作部 / 学生申诉处理委员会",
      docTitle: "西安文理学院学生申诉处理与违纪处分解除指南",
      docFormTitle: "西安文理学院学生违纪处分解除（申诉）申请书",
      reasonPlaceholder: "例如：本人在处分期内深刻反思错误、严格遵守校纪校规、积极参与学习与志愿活动且无任何再违纪行为，现处分期已满，特申请解除处分。",
      materials: [
        "《解除处分申请书》或《学生申诉申请书》（申诉须在收到决定书 10 个工作日内提交）",
        "处分期内个人思想汇报及表现总结（解除处分必备）",
        "班级评议意见、辅导员鉴定意见及获奖/志愿服务证明（如有）"
      ],
      steps: [
        "【解除处分】处分期满后，向所在班级和辅导员递交书面解除申请与思想汇报，经班级评议与学院审核后报学工部审批。",
        "【学生申诉】如对处分或退学处理决定不服，务必在收到决定书 10 个工作日内向学生申诉处理委员会提交书面申诉及事实证据。"
      ]
    }
  ];

  let activeGuideId = CAMPUS_GUIDES[0].id;
  const guideCheckKey = () => "xz_guide_chk_" + (me?.username || "guest");
  const loadGuideChecks = () => {
    try { return JSON.parse(localStorage.getItem(guideCheckKey()) || "{}"); } catch { return {}; }
  };
  const saveGuideChecks = map => {
    try { localStorage.setItem(guideCheckKey(), JSON.stringify(map)); } catch {}
  };

  const buildWordHtml = (guide, form) => {
    const today = new Date().toISOString().slice(0, 10);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(guide.docFormTitle)}</title>
<style>
  body { font-family: "SimSun", "Songti SC", serif; color: #111; margin: 28px 34px; line-height: 1.75; }
  h1 { text-align: center; font-size: 20pt; margin: 0 0 18px; letter-spacing: 1px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5pt; }
  td { border: 1px solid #222; padding: 9px 11px; vertical-align: top; }
  .lbl { width: 16%; font-weight: bold; text-align: center; background: #f8fafc; }
  .tall { height: 110px; }
  .sign { text-align: right; margin-top: 26px; }
  .foot { margin-top: 12px; font-size: 9.5pt; color: #555; }
</style></head><body>
<h1>${esc(guide.docFormTitle)}</h1>
<table>
  <tr>
    <td class="lbl">姓 名</td><td>${esc(form.name || (me?.display_name || ""))}</td>
    <td class="lbl">学 号</td><td>${esc(form.sno || "")}</td>
  </tr>
  <tr>
    <td class="lbl">学院 / 专业</td><td>${esc(form.college || "")}</td>
    <td class="lbl">联系电话</td><td>${esc(form.phone || "")}</td>
  </tr>
  <tr>
    <td class="lbl">办理类别</td><td>${esc(guide.name)}</td>
    <td class="lbl">申请日期</td><td>${esc(today)}</td>
  </tr>
  <tr>
    <td class="lbl">申请事由<br>与情况说明</td>
    <td colspan="3" class="tall">${esc(form.reason || "").replace(/\n/g, "<br>")}<div class="sign">申请人签字：______________ &nbsp;&nbsp; ${esc(today)}</div></td>
  </tr>
  <tr>
    <td class="lbl">辅导员 /<br>学院意见</td>
    <td colspan="3" class="tall"><div class="sign">负责人签字（盖章）：______________ &nbsp;&nbsp; 年 &nbsp;&nbsp; 月 &nbsp;&nbsp; 日</div></td>
  </tr>
  <tr>
    <td class="lbl">${esc(guide.dept)}<br>审批意见</td>
    <td colspan="3" class="tall"><div class="sign">审批人签字（盖章）：______________ &nbsp;&nbsp; 年 &nbsp;&nbsp; 月 &nbsp;&nbsp; 日</div></td>
  </tr>
</table>
<p class="foot">依据制度：《${esc(guide.docTitle)}》｜受理路径：${esc(guide.office)}（请双面或单面 A4 打印并附相关证明材料提交）</p>
</body></html>`;
  };

  const renderGuideWizard = () => {
    const tabsEl = $("guideTabs");
    const detailEl = $("guideDetail");
    if (!tabsEl || !detailEl) return;

    tabsEl.innerHTML = CAMPUS_GUIDES.map(g =>
      `<button type="button" class="pill-btn${g.id === activeGuideId ? " active" : ""}" data-gid="${g.id}">${esc(g.name)}</button>`
    ).join("");

    const guide = CAMPUS_GUIDES.find(g => g.id === activeGuideId) || CAMPUS_GUIDES[0];
    const checks = loadGuideChecks();
    const doneSet = new Set(Array.isArray(checks[guide.id]) ? checks[guide.id] : []);

    detailEl.innerHTML = `
      <div class="ct-card">
        <div class="ct-card-head">
          <b>${ico("clipboard")}材料准备清单（${doneSet.size}/${guide.materials.length}）</b>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="outline" id="guideReadDocBtn">${ico("book", "ico-xs")}查阅本校制度原文</button>
            <button type="button" class="primary" id="guideToTodoBtn">${ico("check-square", "ico-xs")}未勾项加入待办</button>
          </div>
        </div>
        <div class="ct-check-list">
          ${guide.materials.map((m, idx) => {
            const on = doneSet.has(idx);
            return `<label class="ct-check-item${on ? " is-done" : ""}"><input type="checkbox" data-gm-idx="${idx}" ${on ? "checked" : ""}><span>${esc(m)}</span></label>`;
          }).join("")}
        </div>
      </div>

      <div class="ct-card">
        <div class="ct-card-head">
          <b>${ico("route")}办理流程与受理路径</b>
          <span class="ct-badge">${esc(guide.dept)}</span>
        </div>
        <small class="muted">受理部门：${esc(guide.office)}</small>
        <ol class="ct-step-list">
          ${guide.steps.map((s, idx) => `<li><span class="ct-step-num">${idx + 1}</span><span>${esc(s)}</span></li>`).join("")}
        </ol>
      </div>

      <div class="ct-card">
        <div class="ct-card-head">
          <b>${ico("file-text")}一键生成标准申请表（Word / 打印 PDF）</b>
        </div>
        <div class="ct-doc-form">
          <input id="gwName" placeholder="学生姓名" value="${esc(me?.display_name || "")}">
          <input id="gwSno" placeholder="学号（选填）">
          <input id="gwCollege" placeholder="学院 / 专业班级（如：信息工程学院 软工2301）">
          <input id="gwPhone" placeholder="联系电话（选填）">
          <textarea id="gwReason" placeholder="${esc(guide.reasonPlaceholder)}"></textarea>
        </div>
        <div class="ct-foot-actions">
          <button type="button" class="outline" id="guidePrintPdfBtn">${ico("file-text", "ico-xs")}打印 / 另存 PDF</button>
          <button type="button" class="primary" id="guideExportDocBtn">${ico("download", "ico-xs")}导出 Word 申请表 (.doc)</button>
        </div>
      </div>
    `;

    detailEl.querySelectorAll("[data-gm-idx]").forEach(cb => {
      cb.addEventListener("change", () => {
        const idx = Number(cb.dataset.gmIdx);
        const cur = loadGuideChecks();
        const set = new Set(Array.isArray(cur[guide.id]) ? cur[guide.id] : []);
        if (cb.checked) set.add(idx); else set.delete(idx);
        cur[guide.id] = [...set];
        saveGuideChecks(cur);
        renderGuideWizard();
      });
    });

    $("guideReadDocBtn")?.addEventListener("click", () => {
      $("guideWizardDialog")?.close();
      open_doc_reader(guide.docTitle);
    });

    $("guideToTodoBtn")?.addEventListener("click", async () => {
      const pending = guide.materials.filter((_, i) => !doneSet.has(i));
      if (!pending.length) return toast("所有材料都已勾选完成！");
      let okCount = 0;
      for (const item of pending.slice(0, 6)) {
        try {
          await api("/tasks", {
            method: "POST",
            body: JSON.stringify({ title: `[${guide.name}] 准备：${item.slice(0, 60)}`, due_date: "" })
          });
          okCount++;
        } catch {}
      }
      if (okCount > 0) {
        if (typeof load_tasks === "function") load_tasks();
        toast(`已将 ${okCount} 项待准备材料加入“我的待办”`);
      } else {
        toast("加入待办失败，请检查登录状态后重试");
      }
    });

    const readForm = () => ({
      name: $("gwName")?.value.trim() || "",
      sno: $("gwSno")?.value.trim() || "",
      college: $("gwCollege")?.value.trim() || "",
      phone: $("gwPhone")?.value.trim() || "",
      reason: $("gwReason")?.value.trim() || guide.reasonPlaceholder
    });

    $("guideExportDocBtn")?.addEventListener("click", () => {
      const html = buildWordHtml(guide, readForm());
      const blob = new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${guide.docFormTitle}.doc`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
      toast("已生成标准 Word 申请表，可直接打印签字提交");
    });

    $("guidePrintPdfBtn")?.addEventListener("click", () => {
      const html = buildWordHtml(guide, readForm());
      const win = window.open("", "_blank", "width=860,height=920");
      if (!win) return toast("浏览器拦截了打印窗口，可改用“导出 Word 申请表”");
      win.document.open();
      win.document.write(html);
      win.document.close();
      setTimeout(() => { try { win.print(); } catch {} }, 250);
    });
  };

  $("guideTabs")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-gid]");
    if (!btn) return;
    activeGuideId = btn.dataset.gid;
    renderGuideWizard();
  });

  window.open_guide_wizard = guideId => {
    if (guideId && CAMPUS_GUIDES.some(g => g.id === guideId)) activeGuideId = guideId;
    renderGuideWizard();
    const dlg = $("guideWizardDialog");
    if (dlg && !dlg.open) dlg.showModal();
  };
  $("openGuideWizardBtn")?.addEventListener("click", () => window.open_guide_wizard());
  $("openGuideFromKbBtn")?.addEventListener("click", () => window.open_guide_wizard());
  $("closeGuideWizardDlg")?.addEventListener("click", () => $("guideWizardDialog")?.close());
  $("guideWizardDialog")?.addEventListener("click", e => { if (e.target === $("guideWizardDialog")) $("guideWizardDialog").close(); });

  /* ---------- 2. 学业 GPA 换算与学位预警 ---------- */
  const GPA_DEFAULT = [
    { name: "高等数学 A（上）", credit: 5, score: 84 },
    { name: "大学英语（一）", credit: 3, score: 88 },
    { name: "程序设计基础", credit: 4, score: 91 },
    { name: "思想道德与法治", credit: 3, score: 82 }
  ];
  const gpaStorageKey = () => "xz_gpa_courses_" + (me?.username || "guest");
  const loadGpaCourses = () => {
    try {
      const arr = JSON.parse(localStorage.getItem(gpaStorageKey()) || "null");
      if (Array.isArray(arr) && arr.length) return arr;
    } catch {}
    return GPA_DEFAULT.map(x => ({ ...x }));
  };
  const saveGpaCourses = arr => {
    try { localStorage.setItem(gpaStorageKey(), JSON.stringify(arr)); } catch {}
  };
  const scoreToGp = s => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 60) return 0;
    return Math.min(5, Math.max(1, Number(((n - 50) / 10).toFixed(2))));
  };

  let gpaCourses = loadGpaCourses();
  const computeGpaMetrics = list => {
    let totalCred = 0, weightedGp = 0, weightedScore = 0, failCount = 0;
    list.forEach(c => {
      const cr = Math.max(0.5, Number(c.credit) || 0);
      const sc = Math.min(100, Math.max(0, Number(c.score) || 0));
      const gp = scoreToGp(sc);
      totalCred += cr;
      weightedGp += cr * gp;
      weightedScore += cr * sc;
      if (sc < 60) failCount++;
    });
    const gpa = totalCred > 0 ? weightedGp / totalCred : 0;
    const avg = totalCred > 0 ? weightedScore / totalCred : 0;
    return { totalCred, gpa, avg, failCount };
  };

  const renderGpaCalc = () => {
    const sumEl = $("gpaSummary");
    const alertEl = $("gpaAlertBox");
    const listEl = $("gpaCourseList");
    if (!sumEl || !alertEl || !listEl) return;

    const m = computeGpaMetrics(gpaCourses);
    const gpaCls = m.gpa < 2.0 ? "is-red" : (m.gpa < 2.4 ? "is-amber" : "is-blue");
    const failCls = m.failCount > 0 ? "is-red" : "is-green";

    sumEl.innerHTML = `
      <div class="ct-kpi ${gpaCls}"><small>平均学分绩点 (GPA)</small><b>${m.gpa.toFixed(2)}</b></div>
      <div class="ct-kpi is-indigo"><small>加权平均分</small><b>${m.avg.toFixed(1)}</b></div>
      <div class="ct-kpi"><small>已录总学分</small><b>${m.totalCred.toFixed(1)}</b></div>
      <div class="ct-kpi ${failCls}"><small>不及格门数</small><b>${m.failCount}</b></div>
    `;

    if (m.failCount > 0 || m.gpa < 2.0) {
      alertEl.className = "ct-alert-banner is-danger";
      alertEl.innerHTML = `${ico("alert", "ico-xs")}<span><b>学业与学位红线提醒：</b>当前 GPA 为 ${m.gpa.toFixed(2)}（不及格 ${m.failCount} 门）。按《西安文理学院学士学位授予实施细则》，申请学士学位须达平均学分绩点 2.0 及以上，建议及时在每学期开学前两周完成重修报名。</span>`;
    } else if (m.gpa < 2.4) {
      alertEl.className = "ct-alert-banner is-warn";
      alertEl.innerHTML = `${ico("bulb", "ico-xs")}<span><b>学业预警提示：</b>当前 GPA 为 ${m.gpa.toFixed(2)}，虽已超过学位底线（2.0），但余量偏紧，建议优先冲刺高学分专业课提分。</span>`;
    } else {
      alertEl.className = "ct-alert-banner is-ok";
      const extra = m.gpa >= 3.5 ? "，具备冲刺国家奖学金、校内一等奖学金及优秀毕业生竞争力！" : "，保持当前节奏可顺利满足学士学位授予绩点要求。";
      alertEl.innerHTML = `${ico("check", "ico-xs")}<span><b>学位达标状态良好：</b>当前 GPA 为 ${m.gpa.toFixed(2)}，零挂科${extra}</span>`;
    }

    listEl.innerHTML = gpaCourses.length
      ? gpaCourses.map((c, idx) => {
          const gp = scoreToGp(c.score);
          const badgeCls = c.score < 60 ? "is-urgent" : (c.score >= 85 ? "is-safe" : "");
          return `<div class="ct-row">
            <div class="ct-row-main">
              <b>${esc(c.name)}</b>
              <small>${Number(c.credit)} 学分 · 成绩 ${Number(c.score)} 分</small>
            </div>
            <div class="ct-row-right">
              <span class="ct-badge ${badgeCls}">绩点 ${gp.toFixed(2)}</span>
              <button type="button" class="ct-del-btn" data-gpa-del="${idx}" aria-label="删除课程">${ico("trash")}</button>
            </div>
          </div>`;
        }).join("")
      : `<div class="ct-row"><small class="muted">暂无课程记录，请在上方添加课程成绩</small></div>`;
  };

  $("gpaAddForm")?.addEventListener("submit", e => {
    e.preventDefault();
    const name = $("gpaCourseName")?.value.trim();
    const credit = Number($("gpaCourseCredit")?.value);
    const score = Number($("gpaCourseScore")?.value);
    if (!name || !Number.isFinite(credit) || !Number.isFinite(score)) return;
    gpaCourses.push({ name, credit: Math.max(0.5, credit), score: Math.min(100, Math.max(0, score)) });
    saveGpaCourses(gpaCourses);
    $("gpaCourseName").value = "";
    $("gpaCourseScore").value = "";
    renderGpaCalc();
  });

  $("gpaCourseList")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-gpa-del]");
    if (!btn) return;
    gpaCourses.splice(Number(btn.dataset.gpaDel), 1);
    saveGpaCourses(gpaCourses);
    renderGpaCalc();
  });

  $("gpaResetDemoBtn")?.addEventListener("click", () => {
    gpaCourses = GPA_DEFAULT.map(x => ({ ...x }));
    saveGpaCourses(gpaCourses);
    renderGpaCalc();
    toast("已恢复示例课程");
  });

  $("gpaAskAiBtn")?.addEventListener("click", () => {
    const m = computeGpaMetrics(gpaCourses);
    $("gpaCalcDialog")?.close();
    go("ai");
    const qEl = $("question");
    if (qEl) {
      qEl.value = `我目前平均学分绩点 GPA 为 ${m.gpa.toFixed(2)}，已修 ${m.totalCred.toFixed(1)} 学分，不及格 ${m.failCount} 门。请对照本校学士学位授予和评优奖学金规定，给我一份简明的学业与提分建议。`;
      if (typeof auto_resize_question === "function") auto_resize_question();
      $("askForm")?.requestSubmit();
    }
  });

  window.open_gpa_calc = () => {
    gpaCourses = loadGpaCourses();
    renderGpaCalc();
    const dlg = $("gpaCalcDialog");
    if (dlg && !dlg.open) dlg.showModal();
  };
  $("openGpaCalcBtn")?.addEventListener("click", () => window.open_gpa_calc());
  $("closeGpaCalcDlg")?.addEventListener("click", () => $("gpaCalcDialog")?.close());
  $("gpaCalcDialog")?.addEventListener("click", e => { if (e.target === $("gpaCalcDialog")) $("gpaCalcDialog").close(); });

  /* ---------- 3. 超级课表助手（考试倒计时 · 本周空档 · .ics 日历导出） ---------- */
  const examStorageKey = () => "xz_sched_exams_" + (me?.username || "guest");
  const loadExams = () => {
    try {
      const arr = JSON.parse(localStorage.getItem(examStorageKey()) || "[]");
      if (Array.isArray(arr)) return arr;
    } catch {}
    return [];
  };
  const saveExams = arr => {
    try { localStorage.setItem(examStorageKey(), JSON.stringify(arr)); } catch {}
  };

  let examsList = loadExams();
  const renderExamsList = () => {
    const el = $("examList");
    if (!el) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sorted = examsList.map((ex, idx) => {
      const dt = new Date(ex.date + "T00:00:00");
      const diff = Number.isNaN(dt.getTime()) ? 999 : Math.round((dt - today) / 86400000);
      return { ...ex, idx, diff };
    }).sort((a, b) => a.diff - b.diff);

    el.innerHTML = sorted.length
      ? sorted.map(ex => {
          const badgeText = ex.diff < 0 ? `已过 ${Math.abs(ex.diff)} 天` : (ex.diff === 0 ? "就在今天" : `剩 ${ex.diff} 天`);
          const cls = ex.diff <= 7 && ex.diff >= 0 ? "is-urgent" : (ex.diff <= 21 && ex.diff > 7 ? "is-soon" : "is-safe");
          return `<div class="ct-row">
            <div class="ct-row-main">
              <b>${esc(ex.title)}</b>
              <small>${esc(ex.date)}${ex.place ? " · " + esc(ex.place) : ""}</small>
            </div>
            <div class="ct-row-right">
              <span class="ct-badge ${cls}">${badgeText}</span>
              <button type="button" class="ct-del-btn" data-ex-del="${ex.idx}" aria-label="删除考试">${ico("trash")}</button>
            </div>
          </div>`;
        }).join("")
      : `<div class="ct-row"><small class="muted">还没有考试倒计时，可在上方添加期末考试、四六级或论文截止日期</small></div>`;
  };

  $("examAddForm")?.addEventListener("submit", e => {
    e.preventDefault();
    const title = $("examTitle")?.value.trim();
    const date = $("examDate")?.value;
    const place = $("examPlace")?.value.trim() || "";
    if (!title || !date) return;
    examsList.push({ title, date, place });
    saveExams(examsList);
    $("examTitle").value = "";
    $("examPlace").value = "";
    renderExamsList();
    toast("已添加考试倒计时");
  });

  $("examList")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-ex-del]");
    if (!btn) return;
    examsList.splice(Number(btn.dataset.exDel), 1);
    saveExams(examsList);
    renderExamsList();
  });

  const BLOCKS_5 = [
    { label: "1-2 节 (08:00-09:50)", s: 1, e: 2 },
    { label: "3-4 节 (10:10-12:00)", s: 3, e: 4 },
    { label: "5-6 节 (14:00-15:50)", s: 5, e: 6 },
    { label: "7-8 节 (16:10-18:00)", s: 7, e: 8 },
    { label: "9-10 节 (19:00-20:50)", s: 9, e: 10 }
  ];
  const DAY_CN = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

  const renderFreeSlots = () => {
    const grid = $("freeSlotsGrid");
    const sum = $("freeSlotsSummary");
    if (!grid) return;
    const curWeek = Math.max(1, Number(schedState?.currentWeek || schedState?.viewWeek || 1));
    const courses = Array.isArray(schedState?.courses) ? schedState.courses : [];
    const activeCourses = courses.filter(c => {
      if (typeof schedParseWeeks === "function") {
        const set = schedParseWeeks(c.weeks || "1-18");
        return !set.size || set.has(curWeek);
      }
      return true;
    });
    if (sum) sum.textContent = `当前扫描：第 ${curWeek} 周（共 ${activeCourses.length} 节有效排课）`;

    const rows = [];
    for (let d = 1; d <= 7; d++) {
      const dayCourses = activeCourses.filter(c => Number(c.day) === d);
      const frees = BLOCKS_5.filter(b => !dayCourses.some(c => Number(c.start) <= b.e && Number(c.end) >= b.s));
      rows.push(`<div class="ct-row">
        <div class="ct-row-main">
          <b>${DAY_CN[d]}（空闲 ${frees.length} 大节）</b>
          <small>${frees.length ? frees.map(f => f.label.split(" ")[0]).join(" · ") : "当天全天满课"}</small>
        </div>
        <div class="ct-row-right">
          ${frees.length ? `<button type="button" class="outline" style="height:30px;min-height:30px;padding:0 11px;font-size:12px" data-free-todo="${DAY_CN[d]} ${frees[0].label}">+ 加入待办</button>` : `<span class="ct-badge is-soon">满课</span>`}
        </div>
      </div>`);
    }
    grid.innerHTML = rows.join("");
  };

  $("freeSlotsGrid")?.addEventListener("click", async e => {
    const btn = e.target.closest("[data-free-todo]");
    if (!btn) return;
    const label = btn.dataset.freeTodo;
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: `利用空档安排自习/事务（${label}）`, due_date: "" })
      });
      if (typeof load_tasks === "function") load_tasks();
      toast(`已将「${label}」加入我的待办`);
    } catch {
      toast("加入待办失败，请重试");
    }
  });
  $("refreshFreeSlotsBtn")?.addEventListener("click", renderFreeSlots);

  const renderIcsMeta = () => {
    const el = $("icsExportStats");
    if (!el) return;
    const list = Array.isArray(schedState?.courses) ? schedState.courses : [];
    const sd = schedState?.startDate || "2026-08-31";
    el.innerHTML = `
      <span class="ct-badge">当前课程 ${list.length} 门</span>
      <span class="ct-badge is-safe">开学周一 ${esc(sd)}</span>
      <span class="ct-badge">含课前 15 分钟提醒</span>
    `;
  };

  const PERIOD_START_HM = { 1: [8, 0], 2: [8, 55], 3: [10, 10], 4: [11, 5], 5: [14, 0], 6: [14, 55], 7: [16, 10], 8: [17, 5], 9: [19, 0], 10: [19, 55] };
  const PERIOD_END_HM = { 1: [8, 50], 2: [9, 50], 3: [11, 0], 4: [12, 0], 5: [14, 50], 6: [15, 50], 7: [17, 0], 8: [18, 0], 9: [19, 50], 10: [20, 50] };

  $("exportSchedIcsBtn")?.addEventListener("click", () => {
    const list = Array.isArray(schedState?.courses) ? schedState.courses : [];
    if (!list.length) return toast("当前课表暂无课程，请先添加或导入课表");
    const baseDate = new Date((schedState?.startDate || "2026-08-31") + "T00:00:00");
    if (Number.isNaN(baseDate.getTime())) return toast("开学日期格式无效，请先在课表设置中核对");
    const pad2 = n => String(n).padStart(2, "0");
    const fmtIcsDt = (d, hm) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(hm[0])}${pad2(hm[1])}00`;
    const escIcs = s => String(s || "").replace(/[\\,;]/g, m => "\\" + m).replace(/\n/g, "\\n");

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//XiaoWuZhiLi//Campus Schedule//CN",
      "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:校务智理超级课表"
    ];
    let evtCount = 0;
    list.forEach((c, idx) => {
      const day = Math.min(7, Math.max(1, Number(c.day) || 1));
      const sP = Math.min(10, Math.max(1, Number(c.start) || 1));
      const eP = Math.min(10, Math.max(sP, Number(c.end) || sP));
      const wks = typeof schedParseWeeks === "function" ? [...schedParseWeeks(c.weeks || "1-18")] : [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16];
      const hmS = PERIOD_START_HM[sP] || [8, 0];
      const hmE = PERIOD_END_HM[eP] || [9, 50];
      wks.forEach(w => {
        const dt = new Date(baseDate.getTime() + ((w - 1) * 7 + (day - 1)) * 86400000);
        evtCount++;
        lines.push(
          "BEGIN:VEVENT",
          `UID:xawl-sched-${idx}-w${w}@messageweb.xyz`,
          `DTSTART;TZID=Asia/Shanghai:${fmtIcsDt(dt, hmS)}`,
          `DTEND;TZID=Asia/Shanghai:${fmtIcsDt(dt, hmE)}`,
          `SUMMARY:${escIcs(c.name || "课程")}`,
          `LOCATION:${escIcs(c.room || "校内教室")}`,
          `DESCRIPTION:${escIcs(`教师：${c.teacher || "未填"}｜第${w}周 第${sP}-${eP}节`)}`,
          "BEGIN:VALARM",
          "TRIGGER:-PT15M",
          "ACTION:DISPLAY",
          `DESCRIPTION:${escIcs((c.name || "课程") + " 即将开始")}`,
          "END:VALARM",
          "END:VEVENT"
        );
      });
    });
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "校务智理_超级课表.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast(`已导出 ${evtCount} 条课程日程（.ics），可直接导入手机日历`);
  });

  const switchSchedToolsTab = tab => {
    $("schedToolsTabs")?.querySelectorAll("[data-sttab]").forEach(b => b.classList.toggle("on", b.dataset.sttab === tab));
    $("stPaneExams")?.classList.toggle("hide", tab !== "exams");
    $("stPaneFree")?.classList.toggle("hide", tab !== "free");
    $("stPaneIcs")?.classList.toggle("hide", tab !== "ics");
    if (tab === "exams") renderExamsList();
    if (tab === "free") renderFreeSlots();
    if (tab === "ics") renderIcsMeta();
  };
  $("schedToolsTabs")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-sttab]");
    if (!btn) return;
    switchSchedToolsTab(btn.dataset.sttab);
  });

  window.open_sched_tools = (tab = "exams") => {
    examsList = loadExams();
    switchSchedToolsTab(tab);
    const dlg = $("schedToolsDialog");
    if (dlg && !dlg.open) dlg.showModal();
  };
  $("schedOpenToolsBtn")?.addEventListener("click", () => window.open_sched_tools("exams"));
  $("schedMobTools")?.addEventListener("click", () => window.open_sched_tools("exams"));
  $("closeSchedToolsDlg")?.addEventListener("click", () => $("schedToolsDialog")?.close());
  $("schedToolsDialog")?.addEventListener("click", e => { if (e.target === $("schedToolsDialog")) $("schedToolsDialog").close(); });
})();

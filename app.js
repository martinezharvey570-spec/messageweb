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
  try {
    const raw = localStorage.getItem(chat_cache_key_for());
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return;

    chat_history = [];
    $("messages").innerHTML = welcome_html(false);
    list.forEach(item => {
      if (!item || !item.content) return;
      const is_user = item.role === "学生" || item.role === "user";
      create_message(item.content, is_user ? "user" : "ai", item.sources || [], true, item.reasoning || "");
    });
  } catch {}
}

function ensure_chat_restored() {
  if (chat_restored) return;
  chat_restored = true;
  restore_chat_from_local();
}

/* ---- 深浅色 ---- */
function sync_theme_icon(is_dark) {
  const btn = $("themeToggle");
  if (btn) btn.innerHTML = ico(is_dark ? "moon" : "sun");
}

function sync_theme_root(is_dark) {
  const root = document.documentElement;
  root.classList.toggle("dark", is_dark);
  root.style.background = is_dark ? "#0b1120" : "";
  root.style.colorScheme = is_dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", is_dark ? "#0b1120" : "#155eef");
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
      try { localStorage.removeItem("xz_token"); } catch {}
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
  try {
    localStorage.removeItem("xz_token");
    localStorage.removeItem(home_snap_last_key);
  } catch {}
  const msg_box = $("messages");
  if (msg_box) msg_box.innerHTML = "";
  document.body.classList.remove("on-ai-page");
  $("app").classList.add("hide");
  $("auth").classList.remove("hide");
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

/* ---- 消息区滚动 ---- */
function sync_scroll_btn() {
  const msg_el = $("messages");
  const btn = $("scrollBottomBtn");
  if (!msg_el || !btn) return;
  const dist = msg_el.scrollHeight - msg_el.scrollTop - msg_el.clientHeight;
  btn.classList.toggle("hide", dist < 80);
}
let auto_follow = true;
let scroll_lock_until = 0;

function near_bottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function stop_follow() {
  auto_follow = false;
  sync_scroll_btn();
}

$("messages")?.addEventListener("scroll", () => {
  const el = $("messages");
  if (el && Date.now() > scroll_lock_until) auto_follow = near_bottom(el);
  sync_scroll_btn();
}, { passive: true });

$("messages")?.addEventListener("wheel", e => {
  if (e.deltaY < 0) stop_follow();
}, { passive: true });

let touch_start_y = 0;
$("messages")?.addEventListener("touchstart", e => {
  touch_start_y = e.touches?.[0]?.clientY ?? 0;
}, { passive: true });
$("messages")?.addEventListener("touchmove", e => {
  const y = e.touches?.[0]?.clientY ?? touch_start_y;
  if (y - touch_start_y > 8) stop_follow();
}, { passive: true });

$("scrollBottomBtn")?.addEventListener("click", () => {
  const msg_el = $("messages");
  auto_follow = true;
  if (!msg_el) return;
  scroll_lock_until = Date.now() + 400;
  msg_el.scrollTo({ top: msg_el.scrollHeight, behavior: "smooth" });
});

function follow_bottom() {
  const msg_el = $("messages");
  if (!msg_el) return;
  if (auto_follow) {
    scroll_lock_until = Date.now() + 150;
    if (msg_el.scrollTop + msg_el.clientHeight < msg_el.scrollHeight - 4) {
      const prev = msg_el.style.scrollBehavior;
      msg_el.style.scrollBehavior = "auto";
      msg_el.scrollTop = msg_el.scrollHeight;
      msg_el.style.scrollBehavior = prev;
    }
  }
  sync_scroll_btn();
}

function scroll_messages_to_bottom(force = false) {
  const msg_el = $("messages");
  if (!msg_el) return;
  if (force) {
    scroll_lock_until = Date.now() + 400;
    auto_follow = true;
    msg_el.scrollTo({ top: msg_el.scrollHeight, behavior: "smooth" });
  } else {
    sync_scroll_btn();
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
  window.scrollTo(0, 0);
  if (p === "ai") {
    ensure_chat_restored();
    check_ai();
    setTimeout(sync_hot_nav, 60);
  }
  if (p === "knowledge") load_knowledge();
  if (p === "schedule" && typeof render_schedule_all === "function") render_schedule_all();
  if (p === "users") load_users();
  if (p === "analytics") load_stats();
}

async function enter() {
  const me_req = api("/me");
  const data_req = Promise.all([api("/notices"), api("/tasks")]);
  data_req.catch(() => {});
  try {
    me = await me_req;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      token = "";
      try {
        localStorage.removeItem("xz_token");
      } catch {}
      $("auth").classList.remove("hide");
      $("app").classList.add("hide");
      try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
      return;
    }
    toast(e.message);
    try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
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
  load_starred_notices();
  if (typeof load_schedule === "function") load_schedule();
  restore_home_snap();
  try {
    const [n, t] = await data_req;
    if (me) {
      notices = n;
      tasks = t;
      render_home();
      render_notices();
      render_tasks();
    }
  } catch (e) {
    toast(e.message);
  }
  check_ai();
  if (cur_page === "home") go("home");
  try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
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

async function open_doc_reader(doc_title) {
  if (!doc_title) return;
  const clean_title = String(doc_title).split(" · ")[0].trim();
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
    if (sc) sc.scrollTop = 0;
    requestAnimationFrame(sync_doc_progress);
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
  [/红线|注意|风险|警示|禁止|违规/, "warn", "alert"],
  [/行动|待办|下一步|要做|执行/, "action", "check-square"],
  [/确认|追问|需要你|补充/, "ask", "bulb"],
];

function md_section_kind(title) {
  for (const [re, kind, icon] of md_section_kinds) if (re.test(title)) return [kind, icon];
  return ["note", "file-text"];
}

function format_markdown_safe(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
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

    const sec_match = trimmed.match(
      /^(?:#{1,4}\s*)?\**\s*([\p{Extended_Pictographic}\u200d\uFE0F]*)\s*【([^】\n]{2,20})】\s*\**\s*[：:]?\s*(.*)$/u
    );
    if (sec_match) {
      flush_list();
      flush_table();
      const sec_title = sec_match[2].trim();
      const sec_rest = (sec_match[3] || "").trim();
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
  const t = String(text || "").trimEnd();
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
  title.innerHTML = label || `${ico("link", "ico-xs")}可直接打开的原文链接`;
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

function add_doc_chips(parent_el, titles) {
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
      if (typeof open_doc_reader === "function") open_doc_reader(title);
    };
    chips.appendChild(btn);
  });
  box.appendChild(chips);
  parent_el.appendChild(box);
}

function add_tools(wrap_el, text_getter, retry_question = "") {
  const tools = document.createElement("div");
  tools.className = "bubble-tools";

  const copy_btn = document.createElement("button");
  copy_btn.type = "button";
  copy_btn.innerHTML = `${ico("copy", "ico-xs")}复制回答`;
  copy_btn.onclick = async () => {
    const text = typeof text_getter === "function" ? text_getter() : text_getter;
    const ok = await copy_text_safe(text);
    toast(ok ? "回答已复制到剪贴板" : "复制失败，请长按文字复制");
  };
  tools.appendChild(copy_btn);

  const answer_text = typeof text_getter === "function" ? text_getter() : text_getter;
  setTimeout(() => { if (typeof apply_ai_schedule_action === "function") apply_ai_schedule_action(answer_text, tools); }, 0);
  const steps = pick_steps(answer_text);
  const todo_btn = document.createElement("button");
  todo_btn.type = "button";
  todo_btn.className = "todo-action-btn";
  if (steps.length) {
    todo_btn.innerHTML = `${ico("check-square", "ico-xs")}加入待办（${steps.length} 条）`;
    todo_btn.title = "先检查、编辑并选择要保存的事项，不会直接把整段回答拆成任务";
    todo_btn.onclick = () => review_todos(steps, retry_question);
  } else {
    todo_btn.classList.add("is-manual");
    todo_btn.innerHTML = `${ico("plus", "ico-xs")}自己加一条待办`;
    todo_btn.title = "这条回答里没有可直接执行的行动，可以自己写一条";
    todo_btn.onclick = () => review_todos([], retry_question);
  }
  tools.appendChild(todo_btn);

  if (retry_question) {
    const retry_btn = document.createElement("button");
    retry_btn.type = "button";
    retry_btn.innerHTML = `${ico("refresh", "ico-xs")}重新生成`;
    retry_btn.onclick = () => {
      $("question").value = retry_question;
      auto_resize_question();
      $("askForm").requestSubmit();
    };
    tools.appendChild(retry_btn);
  }

  wrap_el.appendChild(tools);
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

  if (who !== "user") {
    add_tools(wrap, () => clean_text);
  }

  if (sources && sources.length) {
    add_sources(wrap, sources);
  }

  $("messages").appendChild(wrap);
  if (who === "user" && !is_restoring) {
    scroll_messages_to_bottom(true);
  } else {
    scroll_messages_to_bottom(false);
  }
}

$("clearChat")?.addEventListener("click", () => {
  chat_history = [];
  try {
    localStorage.removeItem(chat_cache_key_for());
  } catch {}
  $("messages").innerHTML = welcome_html(true);
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
        const maxSide = 1280;
        let w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.82));
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

  auto_follow = true;
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
  bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("ai-brand", "ico-xs")}正在检索校规库并思考中</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  scroll_messages_to_bottom(true);

  let full_answer = "";
  let full_reasoning = "";
  let sources = [];
  let sources_label = "";
  let confidence = "";
  let follow_ups = [];
  let answer_docs = [];
  let streamed_content = false;
  let retried = false;
  let finish_reason = "";
  let truncated_flag = false;
  let continued_times = 0;
  let cut_by_timeout = false;
  let soft_error = "";

  const paint_bubble = is_streaming => {
    let html = "";
    if (full_reasoning.trim()) {
      const summary_label =
        !full_answer.trim() && is_streaming
          ? `${ico("bulb", "ico-xs")}正在深度思考并核对学校条款（点击展开）…`
          : `${ico("bulb", "ico-xs")}已深度思考（点击查看推理过程）`;
      html += `<details class="ai-reasoning"><summary>${summary_label}</summary><div class="ai-reasoning-body">${esc(full_reasoning.trim())}</div></details>`;
    }
    if (full_answer.trim()) {
      html += format_markdown_safe(strip_meta_talk(full_answer));
    } else if (is_streaming) {
      html += `<div class="ai-thinking-status"><span>${ico("ai-brand", "ico-xs")}正在生成办事指引</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
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
      follow_bottom();
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
          if (Array.isArray(parsed.followups)) follow_ups = parsed.followups;
          if (Array.isArray(parsed.knowledge_docs)) answer_docs = parsed.knowledge_docs;
          return;
        }

        if (parsed.type === "truncated") {
          truncated_flag = true;
          return;
        }

        if (parsed.choices?.[0]?.finish_reason) {
          finish_reason = String(parsed.choices[0].finish_reason);
        }

        const delta_reason = parsed.choices?.[0]?.delta?.reasoning_content || "";
        const delta_content =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          parsed.answer ??
          "";

        if (delta_reason) {
          full_reasoning += delta_reason;
          render_streaming_bubble(true);
        }

        if (delta_content) {
          full_answer += delta_content;
          if (full_answer.trim()) {
            streamed_content = true;
            render_streaming_bubble(true);
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
    render_streaming_bubble(false);
    chat_history.push({
      role: "文理智办",
      content: full_answer,
      sources: sources || [],
      reasoning: full_reasoning.trim()
    });
    save_chat_to_local();
    add_tools(wrap, () => full_answer, q);
    add_confidence(wrap, confidence, sources);
    add_sources(wrap, sources, sources_label);
    if (!has_links(sources)) add_doc_chips(wrap, answer_docs);
    add_follow_ups(wrap, follow_ups);
    if (soft_error) {
      const note = document.createElement("div");
      note.className = "stopped-note";
      note.innerHTML = `${ico("alert", "ico-xs")}生成过程被中断，以上为已收到的内容`;
      bubble.appendChild(note);
    }
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
    add_tools(wrap, () => full_answer, q);
    add_confidence(wrap, confidence, sources);
    add_sources(wrap, sources, sources_label);
    if (!has_links(sources)) add_doc_chips(wrap, answer_docs);
    add_follow_ups(wrap, follow_ups);
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
    follow_bottom();
  }
};

$("aiThinking")?.addEventListener("change", () => {
  const effort = $("aiEffort");
  if (effort) effort.disabled = !$("aiThinking").checked;
});

(async () => {
  if (token) {
    restore_home_snap(true);
    enter();
    return;
  }
  check_ai();
  try { window.AndroidBridge?.onAppDataReady?.(); } catch {}
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

/* ---- v1.007: 全站自定义日历组件 (替换所有系统 <input type="date">) ---- */
(function init_custom_date_pickers() {
  document.querySelectorAll('input[type="date"]').forEach(inp => {
    if (inp.dataset.xzDateDone) return;
    inp.dataset.xzDateDone = "1";
    inp.classList.add("xz-native-select-hidden");

    const wrap = document.createElement("div");
    wrap.className = "xz-date-wrap";
    const trig = document.createElement("button");
    trig.type = "button";
    trig.className = "xz-date-trigger";
    const pop = document.createElement("div");
    pop.className = "xz-cal-pop";

    let viewDate = new Date();
    const syncText = () => {
      if (inp.value) {
        trig.classList.remove("is-empty");
        trig.innerHTML = `<span>${inp.value}</span><svg class="ico ico-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.5h17"/></svg>`;
      } else {
        trig.classList.add("is-empty");
        trig.innerHTML = `<span>选择日期（选填）</span><svg class="ico ico-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M8 2.8v3.4M16 2.8v3.4M3.5 9.5h17"/></svg>`;
      }
    };

    const renderCal = () => {
      const y = viewDate.getFullYear(), m = viewDate.getMonth();
      const firstDay = new Date(y, m, 1).getDay();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const todayStr = new Date().toISOString().slice(0, 10);
      let cells = ["日", "一", "二", "三", "四", "五", "六"].map(w => `<div class="xz-cal-wd">${w}</div>`).join("");
      for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const cls = ["xz-cal-day", inp.value === ds ? "selected" : "", ds === todayStr ? "today" : ""].filter(Boolean).join(" ");
        cells += `<button type="button" class="${cls}" data-ds="${ds}">${d}</button>`;
      }
      pop.innerHTML = `
        <div class="xz-cal-head">
          <button type="button" data-cal-prev>‹</button>
          <span>${y} 年 ${m + 1} 月</span>
          <button type="button" data-cal-next>›</button>
        </div>
        <div class="xz-cal-grid">${cells}</div>
        <div class="xz-cal-foot">
          <button type="button" data-cal-clear>清空</button>
          <button type="button" data-cal-today>今天</button>
        </div>`;

      pop.querySelector("[data-cal-prev]").onclick = e => { e.stopPropagation(); viewDate = new Date(y, m - 1, 1); renderCal(); };
      pop.querySelector("[data-cal-next]").onclick = e => { e.stopPropagation(); viewDate = new Date(y, m + 1, 1); renderCal(); };
      pop.querySelector("[data-cal-clear]").onclick = e => { e.stopPropagation(); inp.value = ""; syncText(); pop.classList.remove("open"); inp.dispatchEvent(new Event("change", { bubbles: true })); };
      pop.querySelector("[data-cal-today]").onclick = e => { e.stopPropagation(); inp.value = todayStr; syncText(); pop.classList.remove("open"); inp.dispatchEvent(new Event("change", { bubbles: true })); };
      pop.querySelectorAll("[data-ds]").forEach(b => {
        b.onclick = e => {
          e.stopPropagation();
          inp.value = b.dataset.ds;
          syncText();
          pop.classList.remove("open");
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        };
      });
    };

    trig.onclick = e => {
      e.stopPropagation();
      const willOpen = !pop.classList.contains("open");
      document.querySelectorAll(".xz-cal-pop.open").forEach(p => p.classList.remove("open"));
      if (willOpen) {
        if (inp.value) viewDate = new Date(inp.value + "T00:00:00");
        renderCal();
        pop.classList.add("open");
      }
    };

    inp.addEventListener("change", syncText);
    wrap.appendChild(trig);
    wrap.appendChild(pop);
    inp.parentNode.insertBefore(wrap, inp.nextSibling);
    syncText();
  });

  document.addEventListener("click", () => {
    document.querySelectorAll(".xz-cal-pop.open").forEach(p => p.classList.remove("open"));
  });
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
      <div class="sched-lesson-bar" style="background:${color}"></div>
      <div class="sched-lesson-body">
        <div class="sched-lesson-name">${schedEsc(c.name)}<span class="sched-badge" style="background:${color}">${schedEsc(c.type || "理论")}</span></div>
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
          cards += `<div class="sched-card-item" data-edit-idx="${c._idx}" style="background:${col}">
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
    if (sel) setTimeout(() => sel.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }), 30);
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
          cards += `<div class="sched-card-item" data-edit-idx="${c._idx}" style="background:${col}">
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
          <input type="date" data-manage-start value="${schedEsc(schedState.startDate)}">
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

  if ($("schedDeskManageHost")) $("schedDeskManageHost").innerHTML = html;
  if ($("schedMobManageHost")) $("schedMobManageHost").innerHTML = html;
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

  $("schedPrevWeek")?.addEventListener("click", () => {
    if (schedState.selectedWeek > 1) { schedState.selectedWeek--; render_schedule_all(); }
  });
  $("schedNextWeek")?.addEventListener("click", () => {
    if (schedState.selectedWeek < schedState.totalWeeks) { schedState.selectedWeek++; render_schedule_all(); }
  });
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
  $("schedOpenTimetable")?.addEventListener("click", () => {
    render_timetable_cards($("schedDesktopTimetableContainer"), $("schedDlgSeasonTag"), new Date());
    $("scheduleTimetableDialog")?.showModal();
  });

  const askAiSchedule = () => {
    go("ai");
    setTimeout(() => {
      const q = $("question");
      if (q) {
        q.value = "请结合我录入的课表，告诉我今天和明天有哪些课、几点在哪个教室上？";
        q.focus();
      }
    }, 80);
  };
  $("schedMobAskAi")?.addEventListener("click", () => { $("scheduleSettingDialog")?.close(); askAiSchedule(); });
  $("schedAskAiBtn")?.addEventListener("click", () => {
    go("ai");
    setTimeout(() => {
      const q = $("question");
      if (q) {
        q.value = "请结合我录入的课表，告诉我今天和明天有哪些课、几点在哪个教室上？";
        q.focus();
      }
    }, 80);
  });

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
  $("closeSchedSettingDlg")?.addEventListener("click", () => $("scheduleSettingDialog")?.close());
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

  // 设置面板交互
  $("schedStartInput")?.addEventListener("change", e => {
    if (!e.target.value) return;
    schedState.startDate = e.target.value;
    schedQueueSync();
    render_schedule_all();
    toast("开学日期已更新");
  });
  $("schedTotalWeeksInput")?.addEventListener("change", e => {
    const v = Math.min(30, Math.max(1, parseInt(e.target.value, 10) || 18));
    schedState.totalWeeks = v;
    e.target.value = String(v);
    if (schedState.selectedWeek > v) schedState.selectedWeek = v;
    schedQueueSync();
    render_schedule_all();
  });
  $("schedSettingAddBtn")?.addEventListener("click", () => {
    $("scheduleSettingDialog")?.close();
    open_schedule_course_dlg(-1);
  });
  $("schedSettingCourseList")?.addEventListener("click", e => {
    const del = e.target.closest("[data-del-idx]");
    if (del) {
      const idx = Number(del.dataset.delIdx);
      if (!confirm("确定删除这门课程吗？")) return;
      schedState.courses.splice(idx, 1);
      schedQueueSync();
      render_setting_course_list();
      render_schedule_all();
      toast("已删除");
      return;
    }
    const ed = e.target.closest("[data-edit-idx]");
    if (ed) {
      $("scheduleSettingDialog")?.close();
      open_schedule_course_dlg(Number(ed.dataset.editIdx));
    }
  });
  $("schedExportBtn")?.addEventListener("click", () => {
    const data = { startDate: schedState.startDate, totalWeeks: schedState.totalWeeks, courses: schedState.courses };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "超级课表备份_" + schedFmtDate(new Date()) + ".json";
    a.click();
    toast("已导出 JSON 备份");
  });
  $("schedImportBtn")?.addEventListener("click", () => $("schedImportFile")?.click());
  $("schedImportFile")?.addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.startDate) schedState.startDate = data.startDate;
        if (data.totalWeeks) schedState.totalWeeks = Math.min(30, Math.max(1, Number(data.totalWeeks) || 18));
        if (Array.isArray(data.courses)) schedState.courses = data.courses;
        schedQueueSync();
        render_setting_course_list();
        render_schedule_all();
        toast("导入成功，已同步云端");
      } catch {
        toast("导入失败：JSON 格式有误");
      }
    };
    reader.readAsText(f);
    e.target.value = "";
  });
  $("schedClearBtn")?.addEventListener("click", () => {
    if (!confirm("确定清空所有已录入的课程吗？")) return;
    schedState.courses = [];
    schedQueueSync();
    render_setting_course_list();
    render_schedule_all();
    toast("已清空课表");
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式不支持"));
      img.onload = () => {
        const maxW = 1600;
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

(function bind_sched_ux_extras() {
  $("homeScheduleStrip")?.addEventListener("click", () => go("schedule"));

  let pendingAiFile = null;
  let pendingParsedCourses = null;

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
    pendingAiFile = null;
    pendingParsedCourses = null;
    $("schedAiPreview")?.classList.add("hide");
    $("schedAiConfirmBtn")?.classList.add("hide");
    if ($("schedAiFileLabel")) $("schedAiFileLabel").textContent = "支持教务系统截图、导出 PDF、课表表格等任意格式";
    if ($("schedAiPasteText")) $("schedAiPasteText").value = "";
    set_ai_import_status("");
    $("scheduleAiImportDialog")?.showModal();
  };

  $("schedImportImgBtn")?.addEventListener("click", openAiImportModal);
  $("schedSettingImportImgBtn")?.addEventListener("click", () => {
    $("scheduleSettingDialog")?.close();
    openAiImportModal();
  });
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
      else if (act === "export") $("schedExportBtn")?.click() || (() => {
        const data = { startDate: schedState.startDate, totalWeeks: schedState.totalWeeks, courses: schedState.courses };
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        a.download = "超级课表备份_" + schedFmtDate(new Date()) + ".json";
        a.click();
        toast("已导出 JSON 备份");
      })();
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
    const mode = document.querySelector('input[name="schedImportMode"]:checked')?.value || "merge";
    schedState.courses = mode === "replace" ? pendingParsedCourses : [...schedState.courses, ...pendingParsedCourses];
    const count = pendingParsedCourses.length;
    pendingParsedCourses = null;
    schedQueueSync();
    render_schedule_all();
    $("scheduleAiImportDialog")?.close();
    toast(`已确认导入 ${count} 条课程并同步云端`);
  });

  $("schedImgFile")?.addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    pendingAiFile = file;
    if ($("schedAiFileLabel")) $("schedAiFileLabel").textContent = `已选择：${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB）`;
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
    const vp = page1.getViewport({ scale: 1.8 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page1.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return { image: canvas.toDataURL("image/jpeg", 0.88) };
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

  // 拖拽文件支持
  const dropEl = $("schedAiPickFileBtn");
  if (dropEl) {
    dropEl.addEventListener("dragover", e => { e.preventDefault(); dropEl.style.borderColor = "var(--blue)"; });
    dropEl.addEventListener("dragleave", () => { dropEl.style.borderColor = ""; });
    dropEl.addEventListener("drop", e => {
      e.preventDefault();
      dropEl.style.borderColor = "";
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        pendingAiFile = f;
        set_ai_import_status("");
        if ($("schedAiFileLabel")) $("schedAiFileLabel").textContent = `已选择：${f.name}（${Math.max(1, Math.round(f.size / 1024))} KB）`;
      }
    });
  }

  $("schedAiRunBtn")?.addEventListener("click", async () => {
    const pasted = ($("schedAiPasteText")?.value || "").trim();
    if (!pendingAiFile && !pasted) {
      set_ai_import_status("请先选择课表文件，或粘贴课表文字", true);
      return;
    }
    const mode = document.querySelector('input[name="schedImportMode"]:checked')?.value || "merge";
    const btn = $("schedAiRunBtn");
    btn.disabled = true;
    set_ai_import_status("正在准备解析课表…");
    schedSetSyncLabel("AI 解析中…", true);

    try {
      let payload = {};
      if (pendingAiFile) {
        const fname = (pendingAiFile.name || "").toLowerCase();
        const ftype = (pendingAiFile.type || "").toLowerCase();
        if (ftype.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(fname)) {
          set_ai_import_status("正在压缩图片并上传识别…");
          payload.image = await compress_sched_image(pendingAiFile);
          if (pasted) payload.text = pasted;
        } else if (ftype === "application/pdf" || fname.endsWith(".pdf")) {
          payload = await extract_pdf_for_schedule(pendingAiFile);
          if (pasted) payload.text = (payload.text ? payload.text + "\n" : "") + pasted;
        } else if (fname.endsWith(".xlsx") || fname.endsWith(".xls")) {
          payload = await extract_xlsx_for_schedule(pendingAiFile);
          if (pasted) payload.text += "\n" + pasted;
        } else if (fname.endsWith(".json")) {
          const raw = await pendingAiFile.text();
          try {
            const j = JSON.parse(raw);
            const arr = Array.isArray(j) ? j : (Array.isArray(j.courses) ? j.courses : null);
            if (arr && arr.length && arr[0].name && arr[0].day) {
              schedState.courses = mode === "replace" ? arr : [...schedState.courses, ...arr];
              if (j.startDate) schedState.startDate = j.startDate;
              schedQueueSync();
              render_schedule_all();
              $("scheduleAiImportDialog")?.close();
              toast(`已导入 ${arr.length} 条 JSON 课程`);
              btn.disabled = false;
              return;
            }
          } catch {}
          payload.text = raw + (pasted ? "\n" + pasted : "");
        } else {
          payload.text = (await pendingAiFile.text()) + (pasted ? "\n" + pasted : "");
        }
      } else {
        payload.text = pasted;
      }

      set_ai_import_status("正在调用 AI 提取课程信息（约需 5-10 秒）…");
      set_ai_import_status("正在用强力 AI 深度思考解析课表（约 10-30 秒，请耐心等待）…");
      const res = await api("/schedule/parse", {
        method: "POST",
        timeoutMs: 120000,
        body: JSON.stringify(payload)
      });
      const parsed = Array.isArray(res?.courses) ? res.courses : [];
      if (!parsed.length) {
        set_ai_import_status("未识别到有效课程，请确认内容清晰或尝试直接粘贴文字", true);
        return;
      }

      pendingParsedCourses = parsed;
      const prevEl = $("schedAiPreview");
      if (prevEl) {
        prevEl.innerHTML = `<b>已识别出 ${parsed.length} 条课程（请核对后点“确认导入课表”）：</b>` +
          parsed.slice(0, 12).map(c => `<div class="sched-ai-preview-item">${SCHED_DAY_SHORT[c.day] || ""} 第${c.start}-${c.end}节 · ${schedEsc(c.name)}（${schedEsc(c.weeks)}周 ${schedEsc(c.room || "")}）</div>`).join("") +
          (parsed.length > 12 ? `<div class="sched-ai-preview-item" style="color:var(--muted)">…还有 ${parsed.length - 12} 条课程</div>` : "");
        prevEl.classList.remove("hide");
      }
      $("schedAiConfirmBtn")?.classList.remove("hide");
      set_ai_import_status(`识别完成！共 ${parsed.length} 门课，请点击“确认导入课表”正式写入。`);
    } catch (err) {
      schedSetSyncLabel("导入失败", false);
      set_ai_import_status(err?.message || "课表解析失败，请重试", true);
    } finally {
      btn.disabled = false;
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

function apply_ai_schedule_action(rawText, toolsEl) {
  const m = String(rawText || "").match(/<!--SCHEDULE_ACTION\s*([\s\S]*?)\s*SCHEDULE_ACTION-->/);
  if (!m || !toolsEl || toolsEl.dataset.schedRendered) return;
  let act = null;
  try { act = JSON.parse(m[1]); } catch { return; }
  if (!act || !act.mode) return;
  toolsEl.dataset.schedRendered = "1";

  const courses = Array.isArray(act.courses) ? act.courses : [];
  const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(String(act.start_date || ""));
  const hasWeeks = Number(act.total_weeks) >= 1 && Number(act.total_weeks) <= 30;

  let summary = "";
  if (act.mode === "merge") summary = `拟追加 ${courses.length} 条课程`;
  else if (act.mode === "replace") summary = `拟替换为 ${courses.length} 条新课程`;
  else if (act.mode === "delete") summary = `拟删除匹配「${act.match?.name || "指定"}」的课程`;
  else if (act.mode === "config") summary = "拟更新课表学期设置";
  if (hasStart) summary += ` · 开学日期 ${act.start_date}`;
  if (hasWeeks) summary += ` · 共 ${act.total_weeks} 周`;

  const previewLines = courses.slice(0, 4).map(c =>
    `• ${SCHED_DAY_SHORT[c.day] || ""} 第${c.start}-${c.end}节《${schedEsc(c.name)}》${c.room ? " @ " + schedEsc(c.room) : ""}`
  ).join("<br>");

  const card = document.createElement("div");
  card.className = "sched-chat-confirm";
  card.innerHTML = `
    <div class="sched-chat-confirm-head"><svg class="ico ico-star" aria-hidden="true"><use href="#i-ai-brand"/></svg><span>课表修改待确认：${schedEsc(summary)}</span></div>
    ${previewLines ? `<div class="sched-chat-confirm-list">${previewLines}${courses.length > 4 ? `<br>…等共 ${courses.length} 条` : ""}</div>` : ""}
    <div class="sched-chat-confirm-actions">
      <button type="button" class="sched-btn-primary" data-act="confirm">确认执行并同步</button>
      <button type="button" class="sched-btn-ghost" data-act="cancel">暂不应用</button>
    </div>
  `;

  const btnConfirm = card.querySelector('[data-act="confirm"]');
  const btnCancel = card.querySelector('[data-act="cancel"]');

  btnConfirm.onclick = () => {
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
    toast("已按你的确认更新课表并同步云端");
    card.innerHTML = `<div class="sched-chat-confirm-head"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg><span>已写入超级课表并同步云端</span></div>
      <div class="sched-chat-confirm-actions"><button type="button" class="sched-btn-ghost" data-act="view">打开超级课表查看</button></div>`;
    card.querySelector('[data-act="view"]').onclick = () => go("schedule");
  };

  btnCancel.onclick = () => {
    card.remove();
    toast("已取消本次课表更改");
  };

  toolsEl.parentElement?.insertBefore(card, toolsEl.nextSibling);
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
      const scrollable = e.target.closest(".sched-ai-preview, .sched-clist, textarea, select");
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

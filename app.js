/*
 * 校务智理 / 文理智办 前端逻辑
 * 2026.09 起手，10 月大改过两轮，AI 问答那块基本是重写的
 * 接口统一走 /api，token 放 localStorage，页面切换全靠 go() 控显隐
 */
const api_base = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) || "/api";
const chat_cache_key = "xz_chat_cache_v1";
const star_notices_key = "xz_starred_notices_v1";
// 缓存按账号分开存。之前所有人共用一个 key，换个人登录直接看到上一个人的
// 聊天记录和收藏，改配置的时候才发现。
const chat_cache_key_for = () => `${chat_cache_key}_${me?.id || "anon"}`;
const star_cache_key_for = () => `${star_notices_key}_${me?.id || "anon"}`;

// 首页三个数字先拿上次的顶着。登录后要等两次接口，这段时间原来显示"—"，
// 看起来像没数据；隔太久就不顶了，库里删了通知还显示旧数字更怪
const home_snap_key = () => `xz_home_snap_${me?.id || "anon"}`;
// 还多存一份"上次的"，因为刷新时还不知道是谁，等 /me 回来数字就晚了
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
  // 当前停在哪一页。登录后补数据要几百毫秒，这期间用户可能已经点走了，
  // 收尾时不能无条件把人拽回首页
  cur_page = "home";

// 聊天记录什么时候恢复。登录那一下同步重建 30 条历史要跑一遍 markdown 排版，
// 首屏白等几百毫秒；又没人一进来就盯着看不见的消息区。改成进 AI 页再补
let chat_restored = false;

let knowledge_request_seq = 0;
// 制度库上一次渲染用的条件签名，用来判断“这次要不要真的重建 DOM”
let kb_render_sig = "";

let ai_busy = false;
// 存当前这次请求的 abort 函数，点停止键直接调
let ai_abort_handler = null;
let ai_todo_draft = [];
let ai_todo_source_question = "";

const $ = id => document.getElementById(id);
// 搜索框每敲一个字就全量重渲染通知卡，输入法联想一快就掉帧。攒 120ms 再画
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

// 图标都在 index.html 的 symbol 里，动态拼的 HTML 也走这个，别直接贴 emoji
function ico(name, cls = "") {
  // 实心星看着比描边的瘦一圈，单独放大（见 .ico-star）
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

// 收藏置顶存本地就够了，不值得占后端一张表
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

// navigator.clipboard 在微信里经常不生效，留个 execCommand 兜底
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
      <span class="msg-avatar ai">${ico("sparkles")}</span>
      <span class="msg-sender">文理智办 AI</span>
    </div>
    <div class="bubble msg-ai welcome-bubble">
      <div class="welcome-bubble-head">
        <b>${is_reset ? "对话已重置，随时为您服务！" : "你好！我是「文理智办」校园智能办事助手"}</b>
        <p>基于学校 ${kb_total_text()} 份正式规章制度与附件模板，为您梳理清晰的办事指南：</p>
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
  // 只留必要字段。sources 里带网页摘要，存满 30 条能顶爆 5MB，
  // 之前就是写到一半抛 QuotaExceeded，被 catch 吞掉，看着像“记录没保存”。
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
    // 真满了就别存了，不能因为缓存把提问本身搞挂
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
// 亮着太阳、暗着月亮，按钮显示的是“你现在所在的模式”
function sync_theme_icon(is_dark) {
  const btn = $("themeToggle");
  if (btn) btn.innerHTML = ico(is_dark ? "moon" : "sun");
}

function init_theme() {
  try {
    const saved = localStorage.getItem("xz_theme");
    const is_dark = saved === "dark";
    document.body.classList.toggle("dark", is_dark);
    sync_theme_icon(is_dark);
  } catch {}
}
init_theme();

function handle_toggle_theme() {
  const is_dark = document.body.classList.toggle("dark");
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

// 所有接口都走这里，省得每个地方重写一遍 headers
async function api(path, opt = {}) {
  let r;
  // 后端偶尔会卡住不返回，挂个 15 秒兜底，不然按钮一直转
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 15000);
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
    throw err;
  }
  return d;
}

// 登录和注册共用一个表单，切 tab 只改文案
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

// 演示账号：比赛现场评委点一下就能进
$("quickDemoStudent")?.addEventListener("click", () => {
  auth_mode("login");
  $("username").value = "demo_student";
  $("password").value = "demo123456";
  $("authForm").requestSubmit();
});

$("logout").onclick = () => {
  // 生成到一半直接退，请求还挂在后台跑，回来还能听见它写，先掐掉
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
    // 这份是"上个登录的人"，换人登录不能拿来顶
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

// Ctrl/Cmd+K 聚焦当前页搜索框
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
      // 切页要一帧才显示出来，直接 focus 会落空，给 40ms 兜着
      setTimeout(() => $("knowledgeSearch")?.focus(), 40);
    }
  }
});

// 手机上参数栏默认收着，点一下展开
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
  // 离底 80px 就出按钮，往回翻的时候不至于找不着回来的路
  btn.classList.toggle("hide", dist < 80);
}
// 只认用户有没有自己往上滚。光看离底距离不行，程序贴底、来源卡片撑高的时候
// 距离一直在变，会把人的真实意图盖掉。
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
  // 程序自己滚出来的 scroll 别当用户操作
  if (el && Date.now() > scroll_lock_until) auto_follow = near_bottom(el);
  sync_scroll_btn();
}, { passive: true });

// 滚轮往上 = 想看前面，停跟随
$("messages")?.addEventListener("wheel", e => {
  if (e.deltaY < 0) stop_follow();
}, { passive: true });

// 手机上手指往下拖是同一个意思
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
    // .messages 上写着 scroll-behavior:smooth，直接赋 scrollTop 也会走一段平滑动画。
    // 流式输出每帧都赋一次，相当于每帧把动画重头播一遍：内容永远追不上，合成线程还被一直占着。
    // 跟随期间临时切成 auto，滚完立刻还原，用户手动点“回到底部”仍然是平滑的。
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
  sidebar_el.classList.remove("open");
  // 切页本来就是整块内容在换，再叠一层平滑滚动动画只是白白占几百毫秒的主线程
  window.scrollTo(0, 0);
  if (p === "ai") {
    ensure_chat_restored();
    check_ai();
    setTimeout(sync_hot_nav, 60);
  }
  if (p === "knowledge") load_knowledge();
  if (p === "users") load_users();
  if (p === "analytics") load_stats();
}

// 顶栏那个刷新
$("quickRefresh")?.addEventListener("click", async () => {
  await refresh();
  toast("数据已同步更新");
});

async function enter() {
  // /me 和首页要用的数据一起发出去。串行等完 /me 再去拉通知，白搭一个来回
  const me_req = api("/me");
  const data_req = Promise.all([api("/notices"), api("/tasks")]);
  // me 挂了这两个也会挂，先挂个 catch，免得出未处理的 rejection
  data_req.catch(() => {});
  try {
    me = await me_req;
  } catch (e) {
    // 只有明确没登录/没权限才清 token。网络抖一下就踢人重登，是之前最烦的一个问题
    if (e.status === 401 || e.status === 403) {
      token = "";
      try {
        localStorage.removeItem("xz_token");
      } catch {}
      $("auth").classList.remove("hide");
      $("app").classList.add("hide");
    }
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
  load_starred_notices();
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
}

async function refresh() {
  try {
    const [n, t] = await Promise.all([api("/notices"), api("/tasks")]);
    // 退出登录时请求可能还在路上，回来别把上一个账号的数据塞进页面
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

// 截止日期标签：过了的标红，3 天内标黄
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

  // 收藏的排前面
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

  // 卡片里的按钮统一由文件末尾的 document 委托处理（见 init_list_actions）。
  // 这里以前是六个 querySelectorAll + 逐个 .onclick，每次重渲染都重来一遍。
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
  if (!confirm(`确定清理全部 ${done_list.length} 项已完成的待办事项吗？`)) return;
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

  // 勾选、改标题、删除都走 document 委托（见 init_list_actions）
}

// 发布 / 编辑通知（管理员）
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

  // 滚轮直接当横向滚用
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

  // 按住拖拽；拖动过就不算点击，不然一拖就把问题填进输入框了
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
let kb_total = 0; // 0 = 还没拿到，界面先显示 …
function kb_total_text() {
  return kb_total > 0 ? String(kb_total) : "…";
}
// 同一个数字散在卡片、胶囊、标题好几处，统一回填
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
  // 记下这次画的是什么条件，下次进来条件一样就不必再把 122 张卡片重建一遍
  kb_render_sig = `${docs.length}|${q}|${$("knowledgeDept")?.value || ""}|${kb_total}|${matched_chunks.length}`;
  const matched_box = $("knowledgeMatchedBox");
  const matched_list = $("knowledgeMatchedList");
  if (q && matched_chunks.length && matched_box && matched_list) {
    matched_box.classList.remove("hide");
    matched_list.innerHTML = matched_chunks
      .map(c => {
        // 摘要要截断，之前一行里调了两次 clipSnippet，正则白跑一遍
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
    // 122 张卡片，每张都要这个总数。原来是在模板里直接调 kb_total_text()，
    // 也就是循环里白白跑 122 次函数调用和字符串转换
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
  // 两个按钮同样交给 document 委托，不在这里逐张绑
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
    // 条件没变、数据也没变，DOM 还是上次那份，直接不画。
    // 切页最贵的就是这一下 innerHTML，来回点“制度库 → 首页 → 制度库”不该每次都重来
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

// 纯文本按公文的样子拆：章、条、附件、落款
function render_doc_html(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(x => x.trim()).filter(Boolean);
  const out = [];
  let sec_id = 0;
  // 评分标准那类文档在 txt 里是一格一行，连着 4 行以上就当表格排
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
    paper.innerHTML = render_doc_html(full_text) || '<p class="doc-p">暂无正文内容</p>';
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
    // 份数从这里拿：/stats 只有管理员能调，学生端会一直卡在省略号
    apply_kb_count(d.knowledge_files, d.knowledge_chunks);
  } catch {
    $("aiStatus").textContent = "离线";
  }
}

// 链接这块被模型坑过好几次：
//   [文字](url) 的地址里混进中文句号，正则一贪婪就吞进去，点开 404
//   模型直接甩裸地址的时候压根不是链接
// 做法是先把链接抠出来占位，正文转义完再塞回去，免得 href 里的 & 变成 &amp;
// 只放行 http / https / mailto，别的协议一律当文本
const md_url_trail_re = /[.,;:!?'")\]}>】）》」』，。、；：！？…·～`]+$/;

// 剪掉被吞进去的尾巴标点；维基那种自带括号的地址，括号成对就别剪
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

// 地址当文字太长会撑破气泡，掐头去尾，完整地址放 title
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

  // 1. [文字](地址)，地址可以带尖括号
  s = s.replace(
    /\[([^\]\n]{1,160})\]\(\s*<?((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+)>?\s*\)/g,
    (m, text, url) => keep(md_anchor(url, text))
  );

  // 2. 裸地址：前面不是字母数字就认，免得 wordshttps:// 这种粘连的被切出来
  s = s.replace(
    /(^|[^\w./@%-])((?:https?:\/\/)[^\s<>"'`()[\]{}）】》」』，。；：！？]+)/g,
    (m, pre, url) => pre + keep(md_anchor(url, ""))
  );

  // 3. 正文转义，再做行内代码和加粗
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 4. 链接放回来，占位符是 \u0000 包数字，转义碰不到
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] ?? "");
}

// 第三步 → 3，给步骤徽标用
const cn_num = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cn_to_num(s) {
  const t = String(s || "").trim();
  if (/^\d+$/.test(t)) return t;
  if (t === "十") return "10";
  if (t.length === 2 && t[0] === "十") return "1" + cn_num[t[1]];
  if (t.length === 2 && t[1] === "十") return cn_num[t[0]] + "0";
  return String(cn_num[t] || t);
}

// 【办理结论】【所需材料】这些标题是提示词里定死的，以前和正文一样是黑字，
// 长回答在手机上一整片糊。现在按语义上色分块，找材料、找红线快很多。
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

    // 只认整行【】开头的，正文里引个书名号不会误伤
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

    // 纯文本写的“第 1 步”也给个序号圆标
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

// 从回答里抠“学生自己要干的活”。
// 最早只认“办理流程”下面的 1. 2. 3.，模型换个标题、写成一句话、或者直接写“第 1 步”，
// 就全落空，按钮永远显示“暂无可创建待办”。现在按 行动小节 → 流程小节 → 全文兜底 三级找。
const todo_action_re = /(?:提交|递交|送交|申请|预约|办理|登录|填写|填报|上传|下载|打印|携带|准备|核对|确认|联系|咨询|领取|缴纳|缴费|签字|签署|盖章|补交|发送|参加|查询|前往|完成|保存|录入|回复|反馈|报备|备案|沟通|递送)/;
// 模型专门写给“要做什么”的小节，优先用
const todo_section_actions = ["下一步行动", "行动清单", "行动建议", "待办建议", "你需要做的事", "您需要做的事", "你需要做", "接下来要做", "下一步要做", "建议你现在做", "建议您现在做", "你现在要做的"];
// 流程区里混着部门动作，当次选
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
  // TODO “下周一”“三天后”这种相对说法还没处理，现在只认具体日期
  // 只写月日的，今年这天要是已经过了，那就是明年
  if (!full && new Date(`${date}T23:59:59`) < now) date = `${y + 1}-${pad(m)}-${pad(d)}`;
  return date;
}

function pick_steps(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n")
    .map(line => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\*\*/g, "").replace(/^>\s*/, "").trim())
    .filter(Boolean);

  // 标题可能带 emoji、加粗、中括号，先剥干净再比
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
    // “无需另行申请”也带动词，但意思反着，得排掉
    if (/(?:无需|无须|不需要|不必)(?:再|另行|亲自|单独)?(?:申请|办理|提交|前往|盖章|跑)/.test(t)) return false;
    if (/^(?:具体|详细|相关|以上|如下|其中)/.test(t)) return false;
    if (!todo_action_re.test(t)) return false;
    // 《××办法》这种是文件名，不是待办
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

  // 有“下一步行动”就只用它，别让流程区里部门的活儿占名额
  let picked = action_items.length ? action_items : flow_items;

  // 没行动小节，或者小节里啥也没抽到：退回全文找带动作、又带时限/地点/系统的句子
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
// 来源只放后端筛过、前端再筛一遍的：
// 首页/栏目页、相关性不够的网页都不算；正文里其它链接一律降成纯文字。
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
    // 网页来源得带相关性分，低于 0.3 当搜错了
    if (item.type === "web" && Number.isFinite(Number(item.relevance)) && Number(item.relevance) < 0.3) continue;
    // 搜索页、文库、下载站点进去全是无关条目，不算依据
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

// 模型偶尔会自己复述内部约束：“（注：以上链接均可直接打开，不存在伪造链接）”。
// 学生要看的是怎么办事，这种话静默删掉，也别留“已清理”的痕迹。
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
  // 括号里只在聊链接、来源的整段删，“带录取通知书”这种有用信息留着
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

// 正文链接跟后端给的来源对不上就降成纯文字，编的链接别放出去
function clean_links(text, sources) {
  const norm = u => {
    try { return new URL(u).href.replace(/\/$/, ""); } catch { return ""; }
  };
  const allowed = new Set(pick_sources(sources).map(s => norm(s.url)).filter(Boolean));
  let out = strip_meta_talk(text);
  // 带文字的 [标题](地址)
  out = out.replace(/\[([^\]]{1,240})\]\((https?:\/\/[^\s)]+)(?:\s+[^)]*)?\)/gi,
    (all, label, url) => (allowed.has(norm(url)) ? all : label)
  );
  // 光秃秃的地址。碰到中文、标点就停，不然“详见 https://x，下周截止”会把逗号后面
  // 一整句都算进 URL，归一化失败连正文一起删掉。
  out = out.replace(/https?:\/\/[^\s<>"'`()[\]{}）】》」』，。；：！？]+/gi, url => {
    const bare = url.replace(/[，。；;！？!?]+$/, "");
    return allowed.has(norm(bare)) ? url : "";
  });
  // 链接删掉后会留个孤零零的空格，顺手收一下
  return out.replace(/[ \t]+([，。；：、！？])/g, "$1").replace(/[（(]\s*[)）]/g, "");
}

function tidy_title(value) {
  return String(value || "").toLowerCase().replace(/[\s，。；;：:、,.!?！？]/g, "").replace(/^(办理事项|跟进咨询事项|待办)[:：]/, "");
}

// 判断回答写完没有：结尾停在逗号、顿号、半个括号，就是半句话。
// 后端那套规则跟这里一样，改的时候两边一起改，不然会一边要续写一边说完了。
const answer_tail_ok = /[。！？…」』”"'）)\]】》!?.~～]$/;
const answer_tail_bad = /[，、,;；:：·（(\[【《〈“"'\-—]$/;
// 停在“的/了/该”上，中文不会这么收尾
const answer_tail_cut = /[的该和与或及以于并且是在对为把被从此等而但就都也还很更最不没无]$/;

function looks_done(text) {
  const t = String(text || "").trimEnd();
  if (!t) return false;
  // 括号没闭合
  const openers = (t.match(/[（(\[【《〈“‘]/g) || []).length;
  const closers = (t.match(/[）)\]】》〉”’]/g) || []).length;
  if (openers > closers) return false;
  if (answer_tail_bad.test(t)) return false;
  if (answer_tail_cut.test(t)) return false;
  if (answer_tail_ok.test(t)) return true;
  // 清单最后一条本来就不带句号，够长就算写完
  const last_line = t.split("\n").map(s => s.trim()).filter(Boolean).pop() || "";
  if (/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])/.test(last_line)
    && last_line.replace(/^(?:\d{1,2}[.、)）]|[①-⑳]|[-*•▪])\s*/, "").length >= 10) return true;
  // 没有收尾标点的，只有短句才算完
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
  // 一条都没抽到也给个空行，自己写一句就能存
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
  // 直接聚焦，省一次点击
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

// 搜索接口给的标题常是「标题-站点 - 标题」，站点名和标题各重复一遍，
// 卡片上能占两行还看不出重点是哪份文件
function src_title(item) {
  let t = String(item.title || item.url || "").trim();
  const parts = t.split(/\s+-\s+/);
  if (parts.length > 1) {
    const site_like = p => p.length <= 12 && /(学院|大学|教务处|学生处|中心|部|网|首页)/.test(p);
    const tail = parts[parts.length - 1];
    if (tail.length >= 8 && parts.slice(0, -1).every(site_like)) {
      // 「栏目 - 站点 - 标题」，前面都是站点名，只留标题
      return tail;
    }
    const head = parts[0];
    const rest = parts.slice(1).filter(p => p && !head.includes(p) && !p.includes(head));
    t = [head, ...rest].join(" · ");
  }
  return t.replace(/^(.{6,}?)-[\u4e00-\u9fa5]{2,12}(学院|大学|教务处|学生处|图书馆|中心)$/, "$1");
}

function add_sources(parent_el, sources, label) {
  // 再筛一遍：只留具体文章页，首页不出现
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
    // 有些页面标题把整段正文都塞进去了，卡片上截断，鼠标悬停看全的
    const shown = full.length > 48 ? full.slice(0, 48) + "…" : full;
    a.textContent = `${i + 1}. ${shown}`;
    a.title = `${full}${item.date ? "（" + date(item.date) + " 发布）" : ""}`;
    row.appendChild(a);

    // 标出官网和发布时间，比单纯“能点开”有用
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

// 依据强度放最前面，先说明这段答案有多少原文撑着。充分的时候就不挂标签了，
// 每条都挂反而没人看。
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

/* 追问建议：点了直接问，省得再打一遍字 */
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

/* 有能打开的链接就不再列文件名，不然同一个依据出现两遍 */
function has_links(sources) {
  return pick_sources(sources).length > 0;
}

/* 参考的校内文件，点了直接开原文 */
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
  const steps = pick_steps(answer_text);
  const todo_btn = document.createElement("button");
  todo_btn.type = "button";
  todo_btn.className = "todo-action-btn";
  if (steps.length) {
    // 条数直接写在按钮上，点进去还能改
    todo_btn.innerHTML = `${ico("check-square", "ico-xs")}加入待办（${steps.length} 条）`;
    todo_btn.title = "先检查、编辑并选择要保存的事项，不会直接把整段回答拆成任务";
    todo_btn.onclick = () => review_todos(steps, retry_question);
  } else {
    // 抽不到就别做成灰色不可用，直接给人自己写
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
    meta.innerHTML = `<span class="msg-avatar ai">${ico("sparkles")}</span><span class="msg-sender">文理智办 AI</span>`;
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

// 清空 / 导出
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
      // 导出也走同一套筛选，别把无关网页写进 txt
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
  // 立刻 revoke 在 Safari 上下载会直接失败，等它把数据读完
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("咨询记录已导出");
});

// 输入框跟着内容长高，最高 120
// 空着的时候按钮灰一点，按下去没反应会让人以为坏了
function sync_ask_idle() {
  const el = $("question");
  const b = $("askSubmitBtn");
  if (!el || !b) return;
  b.classList.toggle("is-idle", !el.value.trim() && !ai_busy);
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

// 手机上没有 Shift，长 placeholder 还会把输入框撑成两行
function set_placeholder() {
  const el = $("question");
  if (!el) return;
  el.placeholder = window.innerWidth > 720
    ? "输入办事问题（按 Enter 发送，Shift+Enter 换行）…"
    : "输入办事问题…";
}
set_placeholder();
// 手机键盘弹起也会触发 resize，不去抖的话 placeholder 来回切，
// textarea 高度跟着跳一下
let ph_timer;
window.addEventListener("resize", () => {
  clearTimeout(ph_timer);
  ph_timer = setTimeout(set_placeholder, 150);
});

// 电脑上 Enter 直接发，Shift+Enter 换行
$("question")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 720) {
    e.preventDefault();
    $("askForm").requestSubmit();
  }
});

/* ---- 提问主流程 ---- */
// SSE 和普通 JSON 两种返回都兼容，后端换实现前端不用跟着改
// 发送和停止共用一个键：空着是发送，生成中变停止，点一下立刻断。
// 手机上少一个键，也不用在两个按钮之间找。
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

$("askSubmitBtn")?.addEventListener("click", () => {
  if (ai_busy) {
    if (typeof ai_abort_handler === "function") ai_abort_handler();
    return;
  }
  $("askForm").requestSubmit();
});

$("askForm").onsubmit = async e => {
  e.preventDefault();
  // 正在生成时回车不算数，免得叠请求
  if (ai_busy) return;
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  auto_resize_question();

  $("aiOptionsBar")?.classList.remove("open");
  $("toggleAiConfig")?.classList.remove("added");

  auto_follow = true;
  create_message(q, "user");

  const controller = new AbortController();
  let aborted = false;
  set_ask_busy(true);
  ai_abort_handler = () => {
    aborted = true;
    try { controller.abort(); } catch {}
  };

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai";
  wrap.appendChild(create_msg_meta("ai"));

  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  bubble.innerHTML = `<div class="ai-thinking-status"><span>${ico("sparkles", "ico-xs")}正在检索校规库并思考中</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
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
  // 上游 token 到顶、连接被掐断，流都“看起来正常结束”，得单独记一笔
  let finish_reason = "";
  let truncated_flag = false;
  let continued_times = 0;
  // 太久没收到字节就收尾，别让人对着转圈等
  let cut_by_timeout = false;
  // 中途报错但已经有内容，就别整条丢掉
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
      // 流式时也得先清一遍，不然句尾那句废话会先闪出来
      html += format_markdown_safe(strip_meta_talk(full_answer));
    } else if (is_streaming) {
      html += `<div class="ai-thinking-status"><span>${ico("sparkles", "ico-xs")}正在生成办事指引</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
    }
    bubble.innerHTML = html;
  };

  // 上游一秒能吐几十个 delta，每个都整段重排 markdown 会把主线程占满，
  // 表现就是字在闪、页面滚不动。合并到一帧里画一次就够了。
  // 试过再叠一层“新增不足 12 字就跳过本帧”的闸门，实测没收益：markdown 是对全文重排，
  // 单帧成本和新增多少无关，跳过只是把几次绘制攒成一次更重的，帧间隔反而更尖。
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
    const search_toggle = $("aiWebSearch");
    const web_search = Boolean(search_toggle && search_toggle.checked);
    const payload = {
      question: q,
      model: $("aiModel")?.value || "deepseek-flash",
      thinking: $("aiThinking")?.checked !== false,
      reasoning_effort: $("aiEffort")?.value || "high",
      web_search: web_search,
      // 续写：把已经写出来的尾巴带回去，让模型接着写
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
      // 续写时后端只给后半段，直接赋值会把前面写好的冲掉
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
      // 首包要等检索和排队，给宽一点；联调时用 window.XZ_AI_IDLE_MS 改
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
          // 先记下来，等把已收到的内容渲染完再提示，直接抛的话前半段就没了
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

        // 后端在流尾巴补的截断标记
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

      // 跟 reader.read() 抢，点停止任何时刻都能断
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
        // 不能指望浏览器一定把 abort 传给 body 流，自己再判一次
        if (aborted) {
          try { await reader.cancel(); } catch {}
          break;
        }
        // 还在出字就不算卡住，每收到一次数据就把超时重新计时
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

  // 收尾只能跑一次：续写是同一轮，重复 push 会让历史翻倍
  const finalize = () => {
    if (!full_answer) {
      full_answer = "模型未返回有效内容，请尝试取消勾选“深度思考”或重新发送问题。";
      bubble.innerHTML = `<span class="muted">${esc(full_answer)}</span>`;
      // 以前这里直接 return，用户只能自己去输入框重打一遍
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
    // 有链接就别再列文件名
    if (!has_links(sources)) add_doc_chips(wrap, answer_docs);
    add_follow_ups(wrap, follow_ups);
    // 断了但正文还在，说一声，别让人以为是完整回答
    if (soft_error) {
      const note = document.createElement("div");
      note.className = "stopped-note";
      note.innerHTML = `${ico("alert", "ico-xs")}生成过程被中断，以上为已收到的内容`;
      bubble.appendChild(note);
    }
  };

  // 回答可能被上游掐断：finish_reason=length（token 到顶），或者流提前结束、
  // 正文停在“的/该/，”。这两种学生看到的都是半句话，所以自动接着写，最多两次。
  const ask_with_continuation = async () => {
    let continuing_note = null;
    await run_ask("");
    for (let i = 0; i < 2; i++) {
      if (aborted) break;
      const need_continue =
        !cut_by_timeout && (
          finish_reason === "length" ||
          truncated_flag ||
          // 上游说 stop 就是写完；拿不到 finish_reason 才看文本形态
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
      // 续写没多出内容，说明模型也写不动了
      if (full_answer.length <= length_before + 5) break;
    }
    continuing_note?.remove();
  };

  // 点停止：已生成的留着，不报错
  const handle_stopped = () => {
    // 上一帧没画完的 rAF 还排着队，不掐掉的话它会把“已停止”覆盖回“正在生成”
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
      // 主动中断时不一定抛错，这里补一次
      handle_stopped();
    } else if (cut_by_timeout && !full_answer.trim()) {
      bubble.innerHTML = `<span style="color:#d92d20">${ico("alert", "ico-xs")}服务器长时间没有返回内容，请稍后重试。</span>`;
    } else {
      finalize();
      if (cut_by_timeout && full_answer.trim()) {
        // 得在 finalize 之后加，它会把气泡重画
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
      // 重试是整轮重来，前面收到的推理片段得清掉，不然重试那遍会接在旧文字后面
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
    // 不管成功失败，按钮都要回“发送”，不然卡在停止态
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
    // 有登录态就先把上次的数字摆上，再进页面；原来要等 health 回来才发 /me，
    // 等于开局白等一个来回。health 交给 enter() 里的 check_ai，不重复发
    restore_home_snap(true);
    enter();
    return;
  }
  check_ai();
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
        const new_pwd = prompt(`请输入用户“${name}”的新密码（至少 8 位）：`);
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
        if (!confirm(`确定删除用户“${name}”吗？该用户的待办也会删除，此操作不可撤销。`))
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

    // 后端少字段就显示 —，别把 undefined 印上去
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
    // 优先用后端算好的，没有再自己按任务数除
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
/* ---- 列表按钮统一委托 ----
 * 通知卡、待办行、制度卡都是 innerHTML 一次性重建。原来重建完再跑 querySelectorAll
 * 逐个挂 .onclick —— 制度库 122 份文件 × 2 个按钮 = 244 个节点，每切一次页就要在
 * 主线程上重绑两百多次。改挂到 document 上按 data-* 分派，DOM 重建多少次都不用管。
 * 顺带解决了另一个老毛病：卡片重渲染时旧监听自然消失，不会越积越多。
 */
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

  // 收藏并置顶
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

  // 加入待办
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
    if (!confirm("确定删除这条通知吗？相关待办也会一并删除，此操作不可撤销。")) return;
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
    if (!confirm(`确定删除待办“${t?.title || "此事项"}”吗？`)) return;
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

// 待办勾选走 change，不是 click
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
    // 请求没成功就把勾去掉，不然界面和库对不上
    render_tasks();
  }
});

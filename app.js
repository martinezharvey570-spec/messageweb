// app.js — 安卓移动端体验优化 + 结构化 Markdown 渲染 + 流式思考过程展示 + 轻量化本地对话保存
const API = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) || "/api";
const CHAT_CACHE_KEY = "xz_chat_cache_v1";

let token = localStorage.getItem("xz_token") || "",
  me = null,
  notices = [],
  tasks = [],
  mode = "login",
  timer,
  chatHistory = [];

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
      <span class="msg-tag">官方制度库驱动</span>
    </div>
    <div class="bubble msg-ai welcome-bubble">
      <div class="welcome-bubble-head">
        <b>👋 ${isReset ? "对话已重置，随时为您服务！" : "你好！我是「文理智办」校园智能办事助手"}</b>
        <p>针对校园事务“难查、不清、易漏”痛点，我基于学校正式文件库为您提供落地办事指引：</p>
      </div>
      <div class="welcome-grid">
        <div class="welcome-item">
          <span>📋</span>
          <div><b>备什么</b><small>梳理申报表与证明材料清单</small></div>
        </div>
        <div class="welcome-item">
          <span>🧭</span>
          <div><b>怎么办</b><small>规划找谁审、去哪办动线</small></div>
        </div>
        <div class="welcome-item">
          <span>📌</span>
          <div><b>依何据</b><small>严格引证校内规章条款</small></div>
        </div>
        <div class="welcome-item">
          <span>⚠️</span>
          <div><b>避何坑</b><small>预警资格门槛与截止期限</small></div>
        </div>
      </div>
      <div class="welcome-foot">💡 请点击上方热门问题，或在下方输入框直接描述您的办事需求。</div>
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

// 主题模式初始化与切换
function initTheme() {
  try {
    const saved = localStorage.getItem("xz_theme");
    if (saved === "dark") {
      document.body.classList.add("dark");
      if ($("themeToggle")) $("themeToggle").textContent = "☀️";
    }
  } catch {}
}
initTheme();

$("themeToggle")?.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  try {
    localStorage.setItem("xz_theme", isDark ? "dark" : "light");
  } catch {}
  $("themeToggle").textContent = isDark ? "☀️" : "🌙";
  toast(isDark ? "已切换至深色模式" : "已切换至浅色模式");
});

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
    throw Error("无法连接后端，请确认 API 地址和后端服务。");
  }
  let d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.detail || "请求失败");
  return d;
}

// 登录/注册切换
function authMode(m) {
  mode = m;
  $("loginTab").classList.toggle("selected", m === "login");
  $("regTab").classList.toggle("selected", m === "register");
  $("nameWrap").classList.toggle("hide", m === "login");
  $("displayName").required = m === "register";
  $("authTitle").textContent = m === "login" ? "欢迎回来" : "创建学生账号";
  $("authDesc").textContent =
    m === "login" ? "登录后查看校园通知与个人待办" : "注册后即可使用校园事务服务";
  $("authSubmit").textContent = m === "login" ? "登录" : "注册并登录";
}
$("loginTab").onclick = () => authMode("login");
$("regTab").onclick = () => authMode("register");

$("authForm").onsubmit = async e => {
  e.preventDefault();
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
  }
};

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

function scrollMessagesToBottom() {
  // 已按需求取消提问与流式生成时的强制滑到底部设定
}

function go(p) {
  ["home", "notices", "tasks", "ai", "users", "analytics"].forEach(x =>
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
    users: "用户管理",
    analytics: "数据统计"
  }[p];
  sidebarEl.classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (p === "ai") {
    checkAI();
    scrollMessagesToBottom();
  }
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
              ${n.deadline ? `<span>截止：${esc(n.deadline)}</span>` : ""}
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

  document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.cat === cat);
  });

  let list = notices.filter(
    n =>
      (!cat || n.category === cat) &&
      (!q || (n.title + n.body + (n.publisher || "")).toLowerCase().includes(q))
  );
  const admin = me?.role === "admin";
  const taskNoticeIds = new Set(tasks.map(t => Number(t.notice_id)));

  $("noticeCards").innerHTML =
    list
      .map(n => {
        const alreadyInTask = taskNoticeIds.has(Number(n.id));
        return `<article class="notice-card">
          <div class="notice-top">
            <span class="tag">${esc(n.category)}</span>
            <div class="notice-actions">
              <button type="button" class="ai-btn" data-ai-notice="${n.id}">✳ AI 解读</button>
              <button type="button" class="outline" data-copy-notice="${n.id}">📋 复制</button>
              <button type="button" class="outline ${alreadyInTask ? "added" : ""}" data-add="${n.id}">
                ${alreadyInTask ? "✓ 已在待办" : "＋ 加入待办"}
              </button>
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
$("category").onchange = renderNotices;
document.querySelectorAll("#catPills .pill-btn").forEach(btn => {
  btn.onclick = () => {
    $("category").value = btn.dataset.cat;
    renderNotices();
  };
});

$("taskFilter").onchange = renderTasks;
$("taskSearch")?.addEventListener("input", renderTasks);

$("markAllDone")?.addEventListener("click", async () => {
  const pendingList = tasks.filter(t => t.status === "pending");
  if (!pendingList.length) return toast("当前没有待处理的任务");
  try {
    await Promise.all(
      pendingList.map(t =>
        api("/tasks/" + t.id, {
          method: "PATCH",
          body: JSON.stringify({ status: "completed" })
        })
      )
    );
    tasks = await api("/tasks");
    renderTasks();
    renderHome();
    toast(`已将 ${pendingList.length} 项待办全部标为完成`);
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
            <b>${esc(t.title)}</b>
            <small>${t.due_date ? "⏰ 截止日期：" + esc(t.due_date) : "未设置截止日期"} · 创建于 ${date(t.created_at)}</small>
          </div>
          <span class="tag">${t.status === "completed" ? "已完成" : "待处理"}</span>
        </div>`
      )
      .join("") ||
    '<div class="empty">暂无符合条件的待办事项。可以在“通知公告”中将通知一键加入待办。</div>';

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
}

// 发布通知弹窗
$("newNotice").onclick = () => $("dialog").showModal();
$("closeDialog").onclick = () => $("dialog").close();
$("cancelDialog").onclick = () => $("dialog").close();

$("noticeForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/notices", {
      method: "POST",
      body: JSON.stringify({
        title: $("nTitle").value.trim(),
        category: $("nCategory").value,
        audience: $("nAudience").value,
        deadline: $("nDeadline").value,
        body: $("nBody").value.trim(),
        create_tasks: $("nTasks").checked
      })
    });
    $("dialog").close();
    $("noticeForm").reset();
    $("nAudience").value = "全体学生";
    toast("通知发布成功");
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};

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
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  // 加粗 **bold**
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // 安全链接 [text](https://...)
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
  let listType = null; // 'ul' | 'ol'
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

    // 代码块 ```
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

    // 表格行 | ... |
    if (/^\|.+\|$/.test(trimmed)) {
      flushList();
      tableRows.push(trimmed);
      continue;
    } else if (tableRows.length) {
      flushTable();
    }

    // 空行
    if (!trimmed) {
      flushList();
      continue;
    }

    // 分割线 ---
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushList();
      out.push('<hr class="md-hr">');
      continue;
    }

    // 标题 # / ## / ### / ####
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

    // 引用块 >
    if (/^>\s*(.+)$/.test(trimmed)) {
      flushList();
      const qContent = parseInlineMarkdown(esc(trimmed.replace(/^>\s*/, "")));
      out.push(`<blockquote class="md-quote">${qContent}</blockquote>`);
      continue;
    }

    // 无序列表 - / * / •
    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(`<li>${parseInlineMarkdown(esc(ulMatch[1]))}</li>`);
      continue;
    }

    // 有序列表 1. / 2.
    const olMatch = trimmed.match(/^\d+[.、]\s+(.+)$/);
    if (olMatch) {
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(`<li>${parseInlineMarkdown(esc(olMatch[1]))}</li>`);
      continue;
    }

    // 普通段落
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

function appendSourcesCard(parentEl, sources, label) {
  if (!sources || !sources.length) return;
  const src = document.createElement("div");
  src.className = "ai-sources";
  const title = document.createElement("b");
  title.textContent = label || "📎 引用来源与官方依据";
  src.appendChild(title);
  sources.forEach((item, i) => {
    const row = document.createElement("div"),
      a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const linkText = `${i + 1}. ${item.title || item.url}${item.date ? "（" + item.date + " 发布）" : ""}`;
    a.textContent = linkText;
    a.title = linkText;
    row.appendChild(a);
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
    const userChar = (me && me.display_name ? me.display_name.slice(0, 1) : "我");
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
  scrollMessagesToBottom();
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
        s += "\n引用来源（可核验）：\n" + m.sources.map((x, i) =>
          `  ${i + 1}. ${x.title || x.url}${x.date ? "（" + x.date + " 发布）" : ""}\n     ${x.url}`
        ).join("\n");
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

// 输入框高度自适应与安卓软键盘弹出滚动优化
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

  // 若移动端展开了参数面板，提问时自动收起以释放阅读视野
  $("aiOptionsBar")?.classList.remove("open");
  $("toggleAiConfig")?.classList.remove("added");

  // 1. 上屏用户提问并自动存盘
  message(q, "user");

  const b = $("askSubmitBtn");
  const origHtml = b.innerHTML;
  b.disabled = true;
  b.innerHTML = "<span>思考中</span>";

  // 2. 预先创建 AI 回复占位气泡
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai";
  wrap.appendChild(createMsgMeta("ai"));

  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  bubble.innerHTML = `<div class="ai-thinking-status"><span>✳ 正在检索校规库并思考中</span><span class="pulse-dots"><i></i><i></i><i></i></span></div>`;
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  scrollMessagesToBottom();

  let fullAnswer = "";
  let fullReasoning = "";
  let sources = [];
  let sourcesLabel = "";
  let streamedContent = false;
  let retried = false;

  const renderStreamingBubble = (isStreaming = true) => {
    let html = "";
    if (fullReasoning.trim()) {
      const openAttr = !fullAnswer.trim() && isStreaming ? "open" : "";
      const summaryLabel = !fullAnswer.trim() && isStreaming
        ? "💭 正在深度思考并核对学校条款…"
        : "💭 已深度思考（点击查看推理过程）";
      html += `<details class="ai-reasoning" ${openAttr}><summary>${summaryLabel}</summary><div class="ai-reasoning-body">${esc(fullReasoning.trim())}</div></details>`;
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

    // 情况 A：非流式 JSON
    if (contentType.includes("application/json")) {
      const d = await res.json();
      fullAnswer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
      fullReasoning = String(d.reasoning || d.choices?.[0]?.message?.reasoning_content || "").trim();
      sources = d.sources || [];
      sourcesLabel = d.sources_label || sourcesLabel;
      if (fullAnswer) {
        renderStreamingBubble(false);
      }
    }
    // 情况 B：流式 text/event-stream
    else {
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
          scrollMessagesToBottom();
        }

        if (deltaContent) {
          fullAnswer += deltaContent;
          if (fullAnswer.trim()) {
            streamedContent = true;
            renderStreamingBubble(true);
            scrollMessagesToBottom();
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
    scrollMessagesToBottom();
  }
};

$("aiThinking")?.addEventListener("change", () => {
  $("aiEffort").disabled = !$("aiThinking").checked;
});
document.querySelectorAll(".suggestions button").forEach(b => {
  b.onclick = () => {
    $("question").value = b.textContent;
    autoResizeQuestion();
    $("question").focus();
  };
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
      <div class="notice-row"><span class="bullet"></span><div><h4>账号总数</h4><p>${s.user_count}</p></div></div>
      <div class="notice-row"><span class="bullet"></span><div><h4>任务总数</h4><p>${s.task_count}</p></div></div>
      <div class="notice-row"><span class="bullet"></span><div><h4>待处理任务</h4><p>${s.pending_count}</p></div></div>
      <div class="notice-row"><span class="bullet"></span><div><h4>已完成任务</h4><p>${s.completed_count}</p></div></div>`;
  } catch (e) {
    toast(e.message);
  }
}

$("userSearch")?.addEventListener("input", () => loadUsers());
$("reloadUsers")?.addEventListener("click", loadUsers);
$("reloadStats")?.addEventListener("click", loadStats);

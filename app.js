// app.js — 兼容流式/非流式双模式 + 轻量化本地对话保存 + 完整交互功能
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

// ====== 轻量化本地保存与恢复聊天记录 ======
function saveChatToLocal() {
  try {
    // 仅保留最近 30 条对话，保证极致轻量不占空间
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
    $("messages").innerHTML = "";
    list.forEach(item => {
      if (!item || !item.content) return;
      const isUser = item.role === "学生" || item.role === "user";
      message(item.content, isUser ? "user" : "ai", item.sources || [], true);
    });
  } catch {}
}

// 主题模式初始化与切换
function initTheme() {
  const saved = localStorage.getItem("xz_theme");
  if (saved === "dark") {
    document.body.classList.add("dark");
    if ($("themeToggle")) $("themeToggle").textContent = "☀️";
  }
}
initTheme();

$("themeToggle")?.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem("xz_theme", isDark ? "dark" : "light");
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
    localStorage.setItem("xz_token", token);
    await enter();
  } catch (e) {
    toast(e.message);
  }
};

$("logout").onclick = () => {
  token = "";
  localStorage.removeItem("xz_token");
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
    $("question").focus();
  };
});

function go(p) {
  ["home", "notices", "tasks", "ai", "users", "analytics"].forEach(x =>
    $(`${x}Page`)?.classList.toggle("hide", x !== p)
  );
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
  if (p === "ai") checkAI();
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
    localStorage.removeItem("xz_token");
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
      try {
        await navigator.clipboard.writeText(text);
        toast("通知内容已复制到剪贴板");
      } catch {
        toast("复制失败，请手动长按复制");
      }
    };
  });

  document.querySelectorAll("[data-ai-notice]").forEach(b => {
    b.onclick = () => {
      const n = notices.find(item => String(item.id) === String(b.dataset.aiNotice));
      if (!n) return;
      go("ai");
      $("question").value = `请帮我解读以下校园通知，并梳理出【所需材料】、【分步办理流程】和【重要时间节点】：\n标题：《${n.title}》\n内容：${n.body}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
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

// 文理智办 AI 状态与消息处理
async function checkAI() {
  try {
    let d = await api("/health");
    $("aiStatus").textContent = d.ai_configured ? "● 文理智办在线" : "等待配置 DeepSeek API";
    $("aiStatus").classList.toggle("ready", d.ai_configured);
  } catch {
    $("aiStatus").textContent = "无法连接服务";
  }
}

function formatMarkdownSafe(text) {
  let safe = esc(text);
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  return safe;
}

function appendSourcesCard(parentEl, sources) {
  if (!sources || !sources.length) return;
  const src = document.createElement("div");
  src.className = "ai-sources";
  const title = document.createElement("b");
  title.textContent = "🌐 联网参考来源";
  src.appendChild(title);
  sources.forEach((item, i) => {
    const row = document.createElement("div"),
      a = document.createElement("a");
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `${i + 1}. ${item.title || item.url}`;
    row.appendChild(a);
    src.appendChild(row);
  });
  parentEl.appendChild(src);
}

function appendCopyTools(wrapEl, textGetter) {
  const tools = document.createElement("div");
  tools.className = "bubble-tools";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "📋 复制回答";
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(typeof textGetter === "function" ? textGetter() : textGetter);
      toast("回答已复制到剪贴板");
    } catch {
      toast("复制失败");
    }
  };
  tools.appendChild(copyBtn);
  wrapEl.appendChild(tools);
}

function message(s, who = "", sources = [], isRestoring = false) {
  const cleanText = String(s ?? "").trim();
  if (!cleanText) return;

  chatHistory.push({
    role: who === "user" ? "学生" : "文理智办",
    content: cleanText,
    sources: sources || []
  });
  if (!isRestoring) saveChatToLocal();

  const roleClass = who === "user" ? "msg-user" : "msg-ai";
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap " + roleClass;

  const d = document.createElement("div");
  d.className = "bubble " + roleClass;
  if (who === "user") {
    d.textContent = cleanText;
  } else {
    d.innerHTML = formatMarkdownSafe(cleanText);
  }
  wrap.appendChild(d);

  if (who !== "user") {
    appendCopyTools(wrap, () => cleanText);
  }

  if (sources && sources.length) {
    appendSourcesCard(wrap, sources);
  }

  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;
}

// 清空与导出对话按键（同步清理本地存储）
$("clearChat")?.addEventListener("click", () => {
  chatHistory = [];
  localStorage.removeItem(CHAT_CACHE_KEY);
  $("messages").innerHTML =
    '<div class="bubble"><b>👋 对话已重置。</b><br>我是「文理智办」，请直接描述您的办事需求，我将为您提供材料清单、办理动线与官方依据。</div>';
  toast("对话记录已清空");
});

$("exportChat")?.addEventListener("click", () => {
  if (!chatHistory.length) return toast("当前暂无可导出的对话记录");
  const content = chatHistory
    .map(m => `【${m.role}】\n${m.content}\n`)
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

// 支持电脑端 Enter 快捷发送
$("question")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 1000) {
    e.preventDefault();
    $("askForm").requestSubmit();
  }
});

// AI 提问处理（自适应兼容流式 SSE 与普通 JSON，彻底防止空气泡）
$("askForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";

  // 1. 上屏用户提问并自动存盘
  message(q, "user");

  const b = $("askForm").querySelector("button");
  const origText = b.textContent;
  b.disabled = true;
  b.textContent = "回答中…";

  // 2. 预先创建 AI 回复占位气泡
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap msg-ai";
  const bubble = document.createElement("div");
  bubble.className = "bubble msg-ai";
  bubble.innerHTML = '<span class="muted">✳ 正在检索校规库并思考中…</span>';
  wrap.appendChild(bubble);
  $("messages").appendChild(wrap);
  $("messages").scrollTop = $("messages").scrollHeight;

  let fullAnswer = "";
  let sources = [];

  try {
    const searchToggle = $("aiWebSearch");
    const webSearch = Boolean(searchToggle && searchToggle.checked);
    const payload = {
      question: q,
      model: $("aiModel")?.value || "deepseek-flash",
      thinking: $("aiThinking")?.checked !== false,
      reasoning_effort: $("aiEffort")?.value || "high",
      web_search: webSearch
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

    // 情况 A：如果后端返回的是传统非流式 JSON（例如未更新流式后端）
    if (contentType.includes("application/json")) {
      const d = await res.json();
      fullAnswer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
      sources = d.sources || [];
      if (fullAnswer) {
        bubble.innerHTML = formatMarkdownSafe(fullAnswer);
      }
    }
    // 情况 B：如果后端返回的是流式 text/event-stream
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
          return;
        }

        const deltaReason = parsed.choices?.[0]?.delta?.reasoning_content || "";
        const deltaContent =
          parsed.choices?.[0]?.delta?.content ??
          parsed.choices?.[0]?.message?.content ??
          parsed.answer ??
          "";

        // 深度思考阶段提示，防止出现空白气泡
        if (deltaReason && !fullAnswer.trim()) {
          bubble.innerHTML = '<span class="muted">💭 正在深度思考并核对学校文件条款…</span>';
        }

        if (deltaContent) {
          fullAnswer += deltaContent;
          // 只有当积累了可见字符时才替换气泡文字，杜绝首包换行符导致的空气泡
          if (fullAnswer.trim().length > 0) {
            bubble.innerHTML = formatMarkdownSafe(fullAnswer);
            $("messages").scrollTop = $("messages").scrollHeight;
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
      // 处理缓冲区最后残留的一行
      if (buffer.trim()) {
        processLine(buffer);
      }

      // 兜底：若流里实际上是一个普通 JSON 字符串
      if (!fullAnswer.trim() && rawFallback.trim().startsWith("{")) {
        try {
          const d = JSON.parse(rawFallback.trim());
          fullAnswer = String(d.answer || d.choices?.[0]?.message?.content || "").trim();
          sources = d.sources || sources;
          if (fullAnswer) bubble.innerHTML = formatMarkdownSafe(fullAnswer);
        } catch {}
      }
    }

    // 3. 最终校验：防止任何极端情况下留下空气泡
    fullAnswer = fullAnswer.trim();
    if (!fullAnswer) {
      fullAnswer = "模型未返回有效内容，请尝试取消勾选“深度思考”或重新发送问题。";
      bubble.innerHTML = `<span class="muted">${esc(fullAnswer)}</span>`;
    } else {
      bubble.innerHTML = formatMarkdownSafe(fullAnswer);
      // 存入历史并持久化到本地
      chatHistory.push({ role: "文理智办", content: fullAnswer, sources: sources || [] });
      saveChatToLocal();
      appendCopyTools(wrap, () => fullAnswer);
      appendSourcesCard(wrap, sources);
    }
  } catch (err) {
    bubble.innerHTML = `<span style="color:#d92d20">⚠️ 请求出错：${esc(err.message)}</span>`;
  } finally {
    b.disabled = false;
    b.textContent = origText;
    $("messages").scrollTop = $("messages").scrollHeight;
  }
};

$("aiThinking")?.addEventListener("change", () => {
  $("aiEffort").disabled = !$("aiThinking").checked;
});
document.querySelectorAll(".suggestions button").forEach(b => {
  b.onclick = () => {
    $("question").value = b.textContent;
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

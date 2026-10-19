// app.js — 100% 兼容原有 API 接口，新增深色模式、AI 一键解读、复制、导出、批量完成等交互功能
const API = (window.XZ_CONFIG && window.XZ_CONFIG.API_BASE) || "/api";
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

  // 同步分类胶囊按钮高亮状态
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

  // 加入待办
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

  // 复制通知
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

  // AI 解读通知
  document.querySelectorAll("[data-ai-notice]").forEach(b => {
    b.onclick = () => {
      const n = notices.find(item => String(item.id) === String(b.dataset.aiNotice));
      if (!n) return;
      go("ai");
      $("question").value = `请帮我解读以下校园通知，并梳理出【所需材料】、【分步办理流程】和【重要时间节点】：\n标题：《${n.title}》\n内容：${n.body}${n.deadline ? "\n截止日期：" + n.deadline : ""}`;
      $("askForm").requestSubmit();
    };
  });

  // 删除通知
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

// 批量标为已完成（调用原有 PATCH /tasks/:id 接口）
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

function message(s, who = "", sources = []) {
  chatHistory.push({ role: who === "user" ? "学生" : "文理智办", content: s });

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap " + who;

  const d = document.createElement("div");
  d.className = "bubble " + who;
  if (who === "user") {
    d.textContent = s;
  } else {
    d.innerHTML = formatMarkdownSafe(s);
  }
  wrap.appendChild(d);

  // 为 AI 回复添加一键复制与追问按钮
  if (who !== "user") {
    const tools = document.createElement("div");
    tools.className = "bubble-tools";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.textContent = "📋 复制回答";
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(s);
        toast("回答已复制到剪贴板");
      } catch {
        toast("复制失败");
      }
    };
    tools.appendChild(copyBtn);
    wrap.appendChild(tools);
  }

  $("messages").appendChild(wrap);

  if (sources && sources.length) {
    let src = document.createElement("div");
    src.className = "ai-sources";
    let title = document.createElement("b");
    title.textContent = "🌐 联网参考来源";
    src.appendChild(title);
    sources.forEach((item, i) => {
      let row = document.createElement("div"),
        a = document.createElement("a");
      a.href = item.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `${i + 1}. ${item.title || item.url}`;
      row.appendChild(a);
      src.appendChild(row);
    });
    $("messages").appendChild(src);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
}

// 清空与导出对话按键
$("clearChat")?.addEventListener("click", () => {
  chatHistory = [];
  $("messages").innerHTML =
    '<div class="bubble">对话已清空。你可以继续向我咨询考试规定、缓考流程、毕业论文要求或困难认定等校务事项。</div>';
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

$("askForm").onsubmit = async e => {
  e.preventDefault();
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  message(q, "user");
  const b = $("askForm").querySelector("button");
  const origText = b.textContent;
  b.disabled = true;
  b.textContent = "思考中…";

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
    const d = await api("/ai/ask", {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(payload)
    });
    message(d.answer, "", d.sources || []);
  } catch (e) {
    message(e.message);
  } finally {
    b.disabled = false;
    b.textContent = origText;
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

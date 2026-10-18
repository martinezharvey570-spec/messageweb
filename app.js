// app.js patched for explicit web_search payload; build marker: 2026-10-18-websearch-fix
// Change to "/api" for same-origin deployment, or to "https://your-backend.example/api".
// Local default. For same-origin production deployment, change to "/api".
const API=(window.XZ_CONFIG&&window.XZ_CONFIG.API_BASE)||"/api";let token=localStorage.getItem("xz_token")||"",me=null,notices=[],tasks=[],mode="login",timer;
const $=id=>document.getElementById(id),esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(s){$("toast").textContent=s;$("toast").classList.add("show");clearTimeout(timer);timer=setTimeout(()=>$("toast").classList.remove("show"),2600)}
async function api(path,opt={}){let r;try{r=await fetch(API+path,{...opt,headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{}),...(opt.headers||{})}})}catch{throw Error("无法连接后端，请确认 API 地址和后端服务。")}let d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.detail||"请求失败");return d}
function authMode(m){mode=m;$("loginTab").classList.toggle("selected",m==="login");$("regTab").classList.toggle("selected",m==="register");$("nameWrap").classList.toggle("hide",m==="login");$("displayName").required=m==="register";$("authTitle").textContent=m==="login"?"欢迎回来":"创建学生账号";$("authDesc").textContent=m==="login"?"登录后查看校园通知与个人待办":"注册后即可使用校园事务服务";$("authSubmit").textContent=m==="login"?"登录":"注册并登录"}
$("loginTab").onclick=()=>authMode("login");$("regTab").onclick=()=>authMode("register");
$("authForm").onsubmit=async e=>{e.preventDefault();try{let body={username:$("username").value.trim(),password:$("password").value};if(mode==="register"){body.display_name=$("displayName").value.trim()}let d=await api(mode==="login"?"/auth/login":"/auth/register",{method:"POST",body:JSON.stringify(body)});token=d.token;localStorage.setItem("xz_token",token);await enter()}catch(e){toast(e.message)}};
$("logout").onclick=()=>{token="";localStorage.removeItem("xz_token");$("app").classList.add("hide");$("auth").classList.remove("hide");authMode("login")};
const menuBtn = $("menu");
const sidebarEl = $("sidebar");
function toggleSidebar(){
  sidebarEl.classList.toggle("open");
}
menuBtn.addEventListener("click",toggleSidebar);
menuBtn.addEventListener("touchend",(e)=>{
  e.preventDefault();
  toggleSidebar();
});
//点击遮罩灰色区域关闭侧边栏
document.addEventListener("click",(e)=>{
  if(!sidebarEl.classList.contains("open")) return;
  if(!sidebarEl.contains(e.target) && e.target!==menuBtn){
    sidebarEl.classList.remove("open");
  }
})

document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>go(b.dataset.page));

document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>go(b.dataset.page));document.querySelectorAll("[data-goto]").forEach(b=>b.onclick=()=>go(b.dataset.goto));
function go(p){["home","notices","tasks","ai","users","analytics"].forEach(x=>$(`${x}Page`).classList.toggle("hide",x!==p));document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.page===p));$("crumb").textContent=({home:"工作台总览",notices:"通知公告",tasks:"我的待办",ai:"文理智办",users:"用户管理",analytics:"数据统计"})[p];$("sidebar").classList.remove("open");if(p==="ai")checkAI();if(p==="users")loadUsers();if(p==="analytics")loadStats()}
async function enter(){try{me=await api("/me")}catch(e){token="";localStorage.removeItem("xz_token");$("auth").classList.remove("hide");$("app").classList.add("hide");toast(e.message);return} $("auth").classList.add("hide");$("app").classList.remove("hide");$("userName").textContent=me.display_name;$("welcomeName").textContent=me.display_name;$("avatar").textContent=me.display_name.slice(0,1);$("userRole").textContent=me.role==="admin"?"系统管理员":"学生用户";$("newNotice").classList.toggle("hide",me.role!=="admin");let d=new Date();$("today").textContent=d.toLocaleDateString("zh-CN",{year:"numeric",month:"long",day:"numeric",weekday:"long"});$("dateBig").textContent=d.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"});document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hide",me.role!=="admin"));await refresh();go("home")}
async function refresh(){try{[notices,tasks]=await Promise.all([api("/notices"),api("/tasks")]);renderHome();renderNotices();renderTasks()}catch(e){toast(e.message)}}
function date(s){if(!s)return"未设置截止日期";let d=new Date(s);return isNaN(d) ? s : d.toLocaleDateString("zh-CN")}
function renderHome(){$("statNotices").textContent=notices.length;$("statPending").textContent=tasks.filter(t=>t.status==="pending").length;$("statDone").textContent=tasks.filter(t=>t.status==="completed").length;$("recent").innerHTML=notices.slice(0,4).map(n=>`<div class="notice-row"><span class="bullet"></span><div><h4>${esc(n.title)}</h4><p>${esc(n.body)}</p><div class="meta">${esc(n.category)} · ${date(n.created_at)} ${n.deadline?"· 截止："+esc(n.deadline):""}</div></div></div>`).join("")||'<div class="empty">暂无通知公告</div>'}
function renderNotices(){
  let q=($("search").value||"").toLowerCase(),cat=$("category").value;
  let list=notices.filter(n=>(!cat||n.category===cat)&&(!q||(n.title+n.body).toLowerCase().includes(q)));
  const admin=me?.role==="admin";
  $("noticeCards").innerHTML=list.map(n=>`<article class="notice-card"><div class="notice-top"><span class="tag">${esc(n.category)}</span><div class="notice-actions"><button class="outline" data-add="${n.id}">＋ 加入待办</button>${admin?`<button class="danger" data-delete-notice="${n.id}">删除通知</button>`:""}</div></div><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p><div class="meta">发布人：${esc(n.publisher)} · ${date(n.created_at)} · 适用对象：${esc(n.audience)} ${n.deadline?"· 截止："+esc(n.deadline):""}</div></article>`).join("")||'<div class="panel">没有找到符合条件的通知。</div>';
  document.querySelectorAll("[data-add]").forEach(b=>b.onclick=async()=>{try{let d=await api("/tasks/from-notice/"+b.dataset.add,{method:"POST"});toast(d.message);tasks=await api("/tasks");renderTasks();renderHome()}catch(e){toast(e.message)}});
  document.querySelectorAll("[data-delete-notice]").forEach(b=>b.onclick=async()=>{
    if(me?.role!=="admin")return toast("仅管理员可以删除通知");
    if(!confirm("确定删除这条通知吗？相关待办也会一并删除，此操作不可撤销。"))return;
    b.disabled=true;
    try{const d=await api("/notices/"+b.dataset.deleteNotice,{method:"DELETE"});toast(d.message||"通知删除成功");await refresh()}
    catch(e){toast(e.message);b.disabled=false}
  });
}
$("search").oninput=renderNotices;$("category").onchange=renderNotices;$("taskFilter").onchange=renderTasks;
function renderTasks(){let f=$("taskFilter").value,list=tasks.filter(t=>f==="all"||t.status===f),p=tasks.filter(t=>t.status==="pending").length,d=tasks.length-p;$("taskTotal").textContent=tasks.length;$("taskOpen").textContent=p;$("taskDone").textContent=d;$("taskList").innerHTML=list.map(t=>`<div class="taskrow ${t.status==="completed"?"done":""}"><input type="checkbox" data-task="${t.id}" ${t.status==="completed"?"checked":""}><div class="tasktext"><b>${esc(t.title)}</b><small>${t.due_date?"截止日期："+esc(t.due_date):"未设置截止日期"} · ${date(t.created_at)}</small></div><span class="tag">${t.status==="completed"?"已完成":"待处理"}</span></div>`).join("")||'<div class="empty">暂无待办。可以在通知公告中将通知加入待办。</div>';document.querySelectorAll("[data-task]").forEach(c=>c.onchange=async()=>{try{await api("/tasks/"+c.dataset.task,{method:"PATCH",body:JSON.stringify({status:c.checked?"completed":"pending"})});tasks=await api("/tasks");renderTasks();renderHome()}catch(e){toast(e.message)}})}
$("newNotice").onclick=()=>$("dialog").showModal();$("closeDialog").onclick=()=>$("dialog").close();$("cancelDialog").onclick=()=>$("dialog").close();
$("noticeForm").onsubmit=async e=>{e.preventDefault();try{await api("/notices",{method:"POST",body:JSON.stringify({title:$("nTitle").value.trim(),category:$("nCategory").value,audience:$("nAudience").value,deadline:$("nDeadline").value,body:$("nBody").value.trim(),create_tasks:$("nTasks").checked})});$("dialog").close();$("noticeForm").reset();$("nAudience").value="全体学生";toast("通知发布成功");await refresh()}catch(e){toast(e.message)}};
async function checkAI(){try{let d=await api("/health");$("aiStatus").textContent=d.ai_configured?"文理智办已连接":"等待配置 DeepSeek API";$("aiStatus").classList.toggle("ready",d.ai_configured)}catch{$("aiStatus").textContent="无法连接服务"}}
function message(s,who="",sources=[]){let d=document.createElement("div");d.className="bubble "+who;d.textContent=s;$("messages").appendChild(d);if(sources&&sources.length){let src=document.createElement("div");src.className="ai-sources";let title=document.createElement("b");title.textContent="联网来源";src.appendChild(title);sources.forEach((item,i)=>{let row=document.createElement("div"),a=document.createElement("a");a.href=item.url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=`${i+1}. ${item.title||item.url}`;row.appendChild(a);src.appendChild(row)});$("messages").appendChild(src)}$("messages").scrollTop=$("messages").scrollHeight}
// AI request handler — keep the search checkbox state explicit in every request.
$("askForm").onsubmit=async e=>{
  e.preventDefault();
  const q=$("question").value.trim();
  if(!q)return;
  $("question").value="";
  message(q,"user");
  const b=$("askForm").querySelector("button");
  b.disabled=true;
  try{
    const searchToggle=$("aiWebSearch");
    const webSearch=Boolean(searchToggle && searchToggle.checked);
    const payload={
      question:q,
      model:$("aiModel")?.value||"deepseek-flash",
      thinking:$("aiThinking")?.checked!==false,
      reasoning_effort:$("aiEffort")?.value||"high",
      web_search:webSearch
    };
    // Useful for verifying the actual request in Chrome DevTools; contains no secrets.
    console.debug("[文理智办] request options",{model:payload.model,web_search:payload.web_search});
    const d=await api("/ai/ask",{method:"POST",cache:"no-store",body:JSON.stringify(payload)});
    message(d.answer,"",d.sources||[]);
    if(webSearch && !(d.sources&&d.sources.length)){
      console.warn("[文理智办] 联网搜索已请求，但响应未返回 sources；请检查 Worker 搜索调用及错误处理。");
    }
  }catch(e){message(e.message)}
  finally{b.disabled=false}
};
$("aiThinking")?.addEventListener("change",()=>{$("aiEffort").disabled=!$("aiThinking").checked});
document.querySelectorAll(".suggestions button").forEach(b=>b.onclick=()=>$("question").value=b.textContent);
(async()=>{try{await api("/health");if(token)await enter()}catch{} })();

async function loadUsers(){
  try{
    if(me?.role!=="admin"){toast("仅管理员可以管理用户");return}
    let list=await api("/users");
    let q=($("userSearch").value||"").toLowerCase();
    list=list.filter(u=>(u.username+u.display_name+u.role).toLowerCase().includes(q));
    $("userList").innerHTML=list.map(u=>`<div class="taskrow user-row"><span class="tag">${u.role==="admin"?"管理员":"学生"}</span><div class="tasktext"><b>${esc(u.display_name)}</b><small>用户名：${esc(u.username)} · 注册：${date(u.created_at)}</small></div><select data-role="${u.id}" ${u.id===me.id?"disabled":""}><option value="student" ${u.role==="student"?"selected":""}>学生</option><option value="admin" ${u.role==="admin"?"selected":""}>管理员</option></select>${u.id===me.id?'<span class="muted">当前账号</span>':`<button class="danger" data-delete-user="${u.id}">删除用户</button>`}</div>`).join("")||'<p class="muted">暂无用户。</p>';
    document.querySelectorAll("[data-role]").forEach(sel=>sel.onchange=async()=>{try{await api("/users/"+sel.dataset.role,{method:"PATCH",body:JSON.stringify({role:sel.value})});toast("角色已更新");loadUsers()}catch(e){toast(e.message);loadUsers()}});
    document.querySelectorAll("[data-delete-user]").forEach(b=>b.onclick=async()=>{
      const id=Number(b.dataset.deleteUser);
      if(id===Number(me.id))return toast("不能删除当前登录的账号");
      const row=b.closest(".user-row"),name=row?.querySelector(".tasktext b")?.textContent||"该用户";
      if(!confirm(`确定删除用户“${name}”吗？该用户的待办也会删除，此操作不可撤销。`))return;
      b.disabled=true;
      try{const d=await api("/users/"+id,{method:"DELETE"});toast(d.message||"用户删除成功");await loadUsers();await loadStats()}
      catch(e){toast(e.message);b.disabled=false}
    });
  }catch(e){toast(e.message)}
}
async function loadStats(){try{let s=await api("/stats");$("aNotices").textContent=s.notice_count;$("aStudents").textContent=s.student_count;$("aCompletion").textContent=s.completion_rate+"%";$("statsDetails").innerHTML=`<div class="notice-row"><span class="bullet"></span><div><h4>账号总数</h4><p>${s.user_count}</p></div></div><div class="notice-row"><span class="bullet"></span><div><h4>任务总数</h4><p>${s.task_count}</p></div></div><div class="notice-row"><span class="bullet"></span><div><h4>待处理任务</h4><p>${s.pending_count}</p></div></div><div class="notice-row"><span class="bullet"></span><div><h4>已完成任务</h4><p>${s.completed_count}</p></div></div>`}catch(e){toast(e.message)}}
$("userSearch")?.addEventListener("input",()=>loadUsers());$("reloadUsers")?.addEventListener("click",loadUsers);$("reloadStats")?.addEventListener("click",loadStats);


const cors = (request, env) => {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s=>s.trim());
  const allow = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0] || "null");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...headers}});
const enc=s=>new TextEncoder().encode(s);
const b64u=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const unb64u=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)),c=>c.charCodeAt(0));
async function hashPassword(password,saltHex){
 const salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g).map(x=>parseInt(x,16))):crypto.getRandomValues(new Uint8Array(16));
 const key=await crypto.subtle.importKey("raw",enc(password),"PBKDF2",false,["deriveBits"]);
 const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:180000,hash:"SHA-256"},key,256);
 return {salt:[...salt].map(x=>x.toString(16).padStart(2,"0")).join(""),hash:b64u(bits)};
}
async function verifyPassword(password,salt,expected){const v=await hashPassword(password,salt);return v.hash===expected;}
async function jwtSign(payload,secret){
 const header=b64u(enc(JSON.stringify({alg:"HS256",typ:"JWT"}))),body=b64u(enc(JSON.stringify(payload))),msg=header+"."+body;
 const key=await crypto.subtle.importKey("raw",enc(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 return msg+"."+b64u(await crypto.subtle.sign("HMAC",key,enc(msg)));
}
async function jwtVerify(token,secret){
 try{const p=token.split(".");if(p.length!==3)return null;const key=await crypto.subtle.importKey("raw",enc(secret),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
 const ok=await crypto.subtle.verify("HMAC",key,unb64u(p[2]),enc(p[0]+"."+p[1]));if(!ok)return null;
 const data=JSON.parse(new TextDecoder().decode(unb64u(p[1])));if(data.exp<Date.now()/1000)return null;return data;
 }catch{return null;}
}
async function body(req){try{return await req.json()}catch{throw new Error("请求内容不是有效 JSON")}}
function err(message,status=400){return Object.assign(new Error(message),{status})}
async function getUser(request,env){
 const h=request.headers.get("Authorization")||"",token=h.startsWith("Bearer ")?h.slice(7):"";
 if(!token)throw err("请先登录",401);
 const claims=await jwtVerify(token,env.JWT_SECRET||"CHANGE_THIS_SECRET_IN_CLOUDFLARE_SETTINGS");
 if(!claims)throw err("登录已失效，请重新登录",401);
 const u=await env.DB.prepare("SELECT id,username,display_name,role,created_at FROM users WHERE id=?").bind(claims.sub).first();
 if(!u)throw err("账号不存在",401);return u;
}
function needAdmin(u){if(u.role!=="admin")throw err("仅管理员可以执行此操作",403)}
async function ensureAdmin(env){
 const username=env.ADMIN_USERNAME||"admin",password=env.ADMIN_PASSWORD;
 if(!password) return null;
 let u=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
 if(!u){const p=await hashPassword(password);await env.DB.prepare("INSERT INTO users(username,display_name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").bind(username,env.ADMIN_DISPLAY_NAME||"系统管理员",p.salt,p.hash,"admin",new Date().toISOString()).run();u=await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();}
 return u;
}
async function seed(env){
 await ensureAdmin(env);
 const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM notices").first();
 if(count?.n===0){
  const a=await env.DB.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").first();
  if(a)for(const n of [
   ["新学期校园事务办理提醒（演示）","办事提醒","全体学生","此为演示公告。正式使用时请替换为已公开或获授权的正式通知。具体要求以学校正式通知为准。",""],
   ["学生意见与建议征集（演示）","学生工作","全体学生","欢迎通过学院指定渠道提交意见建议。此内容为演示数据，不代表学校正式安排。",""]
  ])await env.DB.prepare("INSERT INTO notices(title,category,audience,body,deadline,publisher_id,created_at) VALUES(?,?,?,?,?,?,?)").bind(...n,a.id,new Date().toISOString()).run();
 }
}
const publicUser=u=>({id:u.id,username:u.username,display_name:u.display_name,role:u.role,created_at:u.created_at});
export default {
 async fetch(request,env){
  const headers=cors(request,env);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
  try{
   if(!env.DB)throw err("缺少 D1 数据库绑定 DB，请检查 Cloudflare 配置",500);
   await seed(env);
   const url=new URL(request.url),path=url.pathname.replace(/\/+$/,"")||"/";
   if(path==="/api/health")return json({ok:true,ai_configured:!!(env.AI_BASE_URL&&env.AI_API_KEY&&env.AI_MODEL),platform:"Cloudflare Workers + D1"},200,headers);
   if(path==="/api/auth/register"&&request.method==="POST"){
    const x=await body(request);if(!/^[A-Za-z0-9_.-]{3,80}$/.test(x.username||""))throw err("用户名须为 3-80 位英文、数字、点、下划线或短横线");
    if(typeof x.password!=="string"||x.password.length<8||x.password.length>128)throw err("密码长度须为 8-128 位");
    if(!String(x.display_name||"").trim())throw err("请填写显示姓名");
    if(await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(x.username).first())throw err("用户名已存在",409);
    const p=await hashPassword(x.password),now=new Date().toISOString();
    const r=await env.DB.prepare("INSERT INTO users(username,display_name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").bind(x.username,x.display_name.trim().slice(0,120),p.salt,p.hash,"student",now).run();
    const u={id:r.meta.last_row_id,username:x.username,display_name:x.display_name.trim(),role:"student",created_at:now};
    const token=await jwtSign({sub:u.id,exp:Math.floor(Date.now()/1000)+43200},env.JWT_SECRET||"CHANGE_THIS_SECRET_IN_CLOUDFLARE_SETTINGS");
    return json({token,user:publicUser(u)},201,headers);
   }
   if(path==="/api/auth/login"&&request.method==="POST"){
    const x=await body(request),u=await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(x.username||"").first();
    if(!u||!await verifyPassword(String(x.password||""),u.password_salt,u.password_hash))throw err("用户名或密码错误",401);
    const token=await jwtSign({sub:u.id,exp:Math.floor(Date.now()/1000)+43200},env.JWT_SECRET||"CHANGE_THIS_SECRET_IN_CLOUDFLARE_SETTINGS");
    return json({token,user:publicUser(u)},200,headers);
   }
   if(path==="/api/me"&&request.method==="GET")return json(publicUser(await getUser(request,env)),200,headers);
   if(path==="/api/notices"&&request.method==="GET"){
    await getUser(request,env);
    const {results=[]}=await env.DB.prepare("SELECT n.*,u.display_name AS publisher FROM notices n JOIN users u ON u.id=n.publisher_id ORDER BY n.created_at DESC LIMIT 200").all();
    return json(results,200,headers);
   }
   if(path==="/api/notices"&&request.method==="POST"){
    const u=await getUser(request,env);needAdmin(u);const x=await body(request);
    if(String(x.title||"").trim().length<2||String(x.body||"").trim().length<2)throw err("请填写通知标题和内容");
    const now=new Date().toISOString(),title=String(x.title).trim().slice(0,200);
    const r=await env.DB.prepare("INSERT INTO notices(title,category,audience,body,deadline,publisher_id,created_at) VALUES(?,?,?,?,?,?,?)").bind(title,String(x.category||"校园通知").slice(0,60),String(x.audience||"全体学生").slice(0,120),String(x.body).trim().slice(0,12000),String(x.deadline||"").slice(0,40),u.id,now).run();
    if(x.create_tasks){const {results=[]}=await env.DB.prepare("SELECT id FROM users WHERE role='student'").all();for(const st of results)await env.DB.prepare("INSERT INTO tasks(user_id,notice_id,title,due_date,status,created_at) VALUES(?,?,?,?,?,?)").bind(st.id,r.meta.last_row_id,title,String(x.deadline||""),"pending",now).run();}
    return json({id:r.meta.last_row_id,message:"通知发布成功"},201,headers);
   }
   const noticeMatch=path.match(/^\/api\/notices\/(\d+)$/);
   if(noticeMatch&&request.method==="DELETE"){
    const u=await getUser(request,env);needAdmin(u);const id=Number(noticeMatch[1]);
    await env.DB.prepare("DELETE FROM tasks WHERE notice_id=?").bind(id).run();
    await env.DB.prepare("DELETE FROM notices WHERE id=?").bind(id).run();return json({ok:true},200,headers);
   }
   if(path==="/api/tasks"&&request.method==="GET"){
    const u=await getUser(request,env);const {results=[]}=await env.DB.prepare("SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC").bind(u.id).all();return json(results,200,headers);
   }
   const fromNotice=path.match(/^\/api\/tasks\/from-notice\/(\d+)$/);
   if(fromNotice&&request.method==="POST"){
    const u=await getUser(request,env),nid=Number(fromNotice[1]),n=await env.DB.prepare("SELECT * FROM notices WHERE id=?").bind(nid).first();if(!n)throw err("通知不存在",404);
    let t=await env.DB.prepare("SELECT id FROM tasks WHERE user_id=? AND notice_id=?").bind(u.id,nid).first();
    if(t)return json({id:t.id,message:"该通知已加入待办"},200,headers);
    const r=await env.DB.prepare("INSERT INTO tasks(user_id,notice_id,title,due_date,status,created_at) VALUES(?,?,?,?,?,?)").bind(u.id,nid,n.title,n.deadline||"","pending",new Date().toISOString()).run();return json({id:r.meta.last_row_id,message:"已加入我的待办"},201,headers);
   }
   const taskMatch=path.match(/^\/api\/tasks\/(\d+)$/);
   if(taskMatch&&request.method==="PATCH"){
    const u=await getUser(request,env),x=await body(request);if(!["pending","completed"].includes(x.status))throw err("无效任务状态");
    const r=await env.DB.prepare("UPDATE tasks SET status=? WHERE id=? AND user_id=?").bind(x.status,Number(taskMatch[1]),u.id).run();if(!r.meta.changes)throw err("待办不存在",404);return json({ok:true,status:x.status},200,headers);
   }
   if(path==="/api/users"&&request.method==="GET"){
    const u=await getUser(request,env);needAdmin(u);const {results=[]}=await env.DB.prepare("SELECT id,username,display_name,role,created_at FROM users ORDER BY created_at DESC LIMIT 500").all();return json(results,200,headers);
   }
   const userMatch=path.match(/^\/api\/users\/(\d+)$/);
   if(userMatch&&request.method==="PATCH"){
    const u=await getUser(request,env);needAdmin(u);const x=await body(request),id=Number(userMatch[1]);if(id===u.id)throw err("不能修改自己的角色");if(!["admin","student"].includes(x.role))throw err("无效角色");
    const target=await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(id).first();if(!target)throw err("用户不存在",404);
    await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(x.role,id).run();return json({ok:true},200,headers);
   }
   if(path==="/api/stats"&&request.method==="GET"){
    const u=await getUser(request,env);needAdmin(u);
    const one=async sql=>(await env.DB.prepare(sql).first())?.n||0;
    const [users,students,notices,tasks,completed,pending]=await Promise.all([
     one("SELECT COUNT(*) n FROM users"),one("SELECT COUNT(*) n FROM users WHERE role='student'"),one("SELECT COUNT(*) n FROM notices"),
     one("SELECT COUNT(*) n FROM tasks"),one("SELECT COUNT(*) n FROM tasks WHERE status='completed'"),one("SELECT COUNT(*) n FROM tasks WHERE status='pending'")]);
    return json({user_count:users,student_count:students,notice_count:notices,task_count:tasks,completed_count:completed,pending_count:pending,completion_rate:tasks?Math.round(completed/tasks*100):0},200,headers);
   }
   if(path==="/api/ai/ask"&&request.method==="POST"){
    const u=await getUser(request,env),x=await body(request);if(!String(x.question||"").trim())throw err("请输入问题");
    if(!(env.AI_BASE_URL&&env.AI_API_KEY&&env.AI_MODEL))throw err("AI 服务尚未配置。请在 Worker Secrets/Variables 中设置 AI_BASE_URL、AI_API_KEY、AI_MODEL。",503);
    const base=env.AI_BASE_URL.replace(/\/+$/,""),endpoint=base.endsWith("/chat/completions")?base:base+"/chat/completions";
    const response=await fetch(endpoint,{method:"POST",headers:{"Authorization":"Bearer "+env.AI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:env.AI_MODEL,temperature:.2,messages:[{role:"system",content:"你是校务智理校园事务助手。不要编造学校规定、截止日期或办理要求。不确定时明确说明需要查阅学校正式通知。不要要求用户提供身份证号、学号、手机号等敏感信息。当前系统没有自动检索学校内部文件。"},{"role":"user",content:"用户角色："+u.role+"。问题："+String(x.question).slice(0,3000)}]})});
    if(!response.ok)throw err("AI 服务返回 HTTP "+response.status+"，请检查接口配置",502);const data=await response.json();return json({answer:data.choices?.[0]?.message?.content||"模型未返回可读答案",model:env.AI_MODEL},200,headers);
   }
   return json({detail:"未找到接口"},404,headers);
  }catch(e){return json({detail:e.message||"服务器内部错误"},e.status||500,headers)}
 }
};


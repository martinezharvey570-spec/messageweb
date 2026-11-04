文理智办 · 校务智能助手
========================================

一个面向在校学生的校务问答与办事系统：通知公告、个人待办、校内制度库检索，以及一个能查制度、能联网找官网原文的 AI 助手。

前端是四个静态文件，后端是一个 Cloudflare Worker，数据放 D1。没有构建步骤，也没有 npm 依赖，改完直接传。


一、它解决什么问题
----------------------------------------

学校的规章制度散在官网各个栏目里，PDF、红头文件、附件表格混在一起，学生想知道“缓考怎么办”“毕业要多少学分”，通常得翻十几份文件，还不一定找得到最新那版。

这个系统做三件事：

1. 把 122 份校内制度整理成可检索的正文，AI 回答时优先引用这些原文，并给出文件编号和官网链接。
2. 库里没有的，自动去学校官网现查（site:xawl.edu.cn），把官网页面当作第一依据，而不是让模型凭印象编。
3. 查完能一键把“要办的事”加成待办，带截止日期，进个人任务列表。

回答里的链接只保留真实存在于检索结果中的 URL，模型自己编的链接会被降级成普通文字。


二、功能
----------------------------------------

功能              说明
--------------    ------------------------------------------------------------
通知公告          按类别（办事提醒 / 教学事务 / 学生工作 / 校园通知）筛选，支持搜索、
                  收藏、详情查看；管理员可发布
我的待办          手动添加或从 AI 回答一键加入，可勾选完成、全部完成、清理已完成
制度库            122 份校内制度，按部门筛选、关键词检索；公文式阅读器支持章节目录、
                  字号调节、进度条、复制全文、跳转官网原文、AI 解读
AI 问答           流式输出，可开关联网搜索，可选模型与思考强度；回答带来源引用、
                  关键步骤提取、追问建议；支持停止生成、重新生成、续写
用户管理          管理员查看用户列表、调整角色
数据统计          用户数、通知数、待办完成率，以及制度库文件数与切片数

页面：首页 / 通知公告 / 我的待办 / 制度库 / AI 问答 / 数据统计 / 用户管理。左栏导航，移动端收成抽屉。


三、AI 问答怎么工作的
----------------------------------------

提问后，Worker 依次做：

1. 意图判断。校内事务类问题（缓考、宿舍、学分、报销……）走制度库优先的路径；闲聊和通用问题直接答。
2. 检索内置制度库。按标题、正文、部门做关键词打分，命中后取最相关的几份全文送进上下文，并记录文件编号用于回标来源。
3. 库里不够，查官网。自动跑「主题词 site:xawl.edu.cn」等最多三组查询，只采纳学校域名结果；高相关页面再抓一次正文，按问题关键词抽约两千字，避免整页塞进去。
4. 生成。把来源标题、URL、日期、相关度一起给模型，要求它判断相关性、优先一手来源、冲突时说清两种口径，不许伪造来源。
5. 收尾。抽取可执行步骤（最多 3 条）供“加入待办”，过滤模型的自述性废话，校验链接。

联网搜索开关打开时，走的是 DeepSeek 官方 Search / Fetch 接口，不接第三方搜索服务。关闭时完全不发外部请求，只答库内内容。

模型两个选项：Flash（快速通用）和 Pro（深度推理），对应后端的 deepseek-flash / deepseek-v4-pro；思考强度低 / 高 / 最高。都可以在界面上切。


四、部署
----------------------------------------

文件清单

  index.html              页面结构（含 SVG 图标 sprite）
  style.css               全部样式，含暗色主题与移动端适配
  app.js                  前端逻辑
  config.js               接口地址配置
  workes.js               Cloudflare Worker 全部后端代码，含内置制度库
  _headers                静态资源缓存规则，放在站点根目录
  本文件

注意 workes.js 的文件名就是 workes，不是 workers，部署时别顺手改。

第 1 步 · 前端

把 index.html、style.css、app.js、config.js 传到静态站点根目录，四个文件放在同一层。`_headers` 也放根目录，它让三个资源走一年缓存（资源 URL 自带版本号，内容一变地址就变，不存在读到旧文件）。Cloudflare Pages 和 Workers 静态资源都认这个文件；别的托管平台可能忽略，忽略也能用，只是每次打开会多重验证三次。
index.html 里引的三个资源带版本号（?v=20261104_ai_v26），换版本时三处一起改，不然浏览器会拿旧缓存。

接口地址在 config.js：

  window.XZ_CONFIG = { API_BASE: "https://api.messageweb.xyz/api" };

前后端不同域就写完整地址；如果前端也放到 Cloudflare Pages，改成 "/api" 即可同源。

第 2 步 · Worker

在 Cloudflare 控制台新建（或更新）Worker，把 workes.js 全文粘进去，或按 CLI 上传。绑定自定义域名 api.messageweb.xyz，并在 Worker 的 Settings → Triggers 里配好路由。

第 3 步 · D1

建一个 D1 数据库，在 Worker 的 Settings → Bindings 里加 D1 绑定，变量名必须是 DB。

表结构不用手工建。Worker 第一次处理请求时会自己执行 CREATE TABLE IF NOT EXISTS，建 users、notices、tasks 三张表和三个索引；已存在的库不受影响。

第 4 步 · 变量与密钥

在 Settings → Variables and Secrets 里配。带“密钥”标记的用 Secret 类型，不要用明文变量。

  名称                类型     必填  说明
  ----------------    ------   ----  ----------------------------------------------
  DB                  D1 绑定  是    唯一必须的绑定，名字不能变
  JWT_SECRET          Secret   是    登录 token 签名，换了所有人重新登录
  DEEPSEEK_API_KEY    Secret   是    AI 问答与联网搜索，只放服务端
  ADMIN_USERNAME      变量     否    管理员用户名，默认 admin
  ADMIN_PASSWORD      Secret   否    管理员密码，首次请求时自动建号
  ADMIN_DISPLAY_NAME  变量     否    管理员显示名，默认“系统管理员”
  ALLOWED_ORIGINS     变量     否    允许的前端来源，逗号分隔
  AI_BASE_URL         变量     否    DeepSeek 接口地址，默认官方
  AI_MODEL            变量     否    默认模型，默认 deepseek-flash
  AI_API_KEY          Secret   否    兼容旧配置，没配 DEEPSEEK_API_KEY 时的备选
  DEMO_SEED           变量     否    填 0 关闭演示数据
  DEMO_USERNAME       变量     否    演示账号，默认 demo_student
  DEMO_PASSWORD       Secret   否    演示账号密码，默认 demo123456

ALLOWED_ORIGINS 不给就用默认的 https://messageweb.xyz,https://www.messageweb.xyz。换域名一定要同步改，否则跨域请求会被拦。

没有第三方搜索账号要配。整条搜索链路只消费 DEEPSEEK_API_KEY。

第 5 步 · 自检

浏览器打开 https://api.messageweb.xyz/api/health，应该返回类似：

  { "ok": true, "database_configured": true, "jwt_configured": true, "ai_configured": true, "platform": "Cloudflare Workers + D1" }

哪项是 false，就回去补对应的绑定或密钥。然后打开前端登录，问一句“缓考怎么申请”，看有没有流式输出和来源卡片。


五、接口
----------------------------------------

方法    路径                      权限     说明
-----   ----------------------    ------   --------------------------------------
GET     /api/health              公开     部署自检
POST    /api/auth/register       公开     注册，默认学生角色
POST    /api/auth/login          公开     登录，返回 JWT
GET     /api/me                  登录     当前用户
PATCH   /api/me                  登录     改显示名、改密码
GET     /api/notices             登录     通知列表，支持分类 / 关键词
POST    /api/notices             管理员   发布通知
GET     /api/tasks               登录     我的待办
POST    /api/tasks               登录     新建待办
POST    /api/tasks/batch         登录     批量新建（AI 加入待办用，最多 3 条）
POST    /api/tasks/complete-all  登录     全部标记完成
DELETE  /api/tasks/completed     登录     清理已完成
GET     /api/knowledge           登录     制度库目录与正文
GET     /api/users               管理员   用户列表
GET     /api/stats               管理员   统计数据
POST    /api/ai/ask              登录     AI 问答，流式返回

鉴权用 Authorization: Bearer <token>，token 存 localStorage 的 xz_token。前端请求统一 15 秒超时；只有服务端明确返回 401/403 才清除登录态，网络抖动不会把人踢出去。

/api/ai/ask 请求体：

  question           问题原文
  model              deepseek-flash | deepseek-v4-pro
  thinking           是否显示思考过程
  reasoning_effort   low | high | max
  web_search         是否联网
  history            最近若干轮对话
  continue_from      续写时回传已生成的部分

响应是 SSE 流，中途可以停；点了停止就断开连接，不会在后台继续跑。


六、数据表
----------------------------------------

users     id、username、display_name、password_salt、password_hash、role、created_at
notices   id、title、category、audience、body、deadline、publisher_id、created_at
tasks     id、user_id、notice_id、title、due_date、status、created_at

密码用 PBKDF2 加盐哈希，不存明文。role 目前有 student 和 admin 两种。


七、数据与隐私
----------------------------------------

聊天记录和收藏只存在浏览器本地（localStorage），按账号分开存，换人登录看不到上一个人的内容；退出登录时会清掉。点“清空对话”同时删本地缓存。

服务端只存账号、通知、待办。提问内容不落库，除了 DeepSeek 接口调用本身，不外发任何数据。


八、常见问题
----------------------------------------

现象：/api/health 返回 database_configured: false
原因：Worker 没绑 D1，或绑定名不叫 DB
处理：Settings → Bindings 加 D1 绑定，变量名改成 DB

现象：登录提示“服务器尚未配置 JWT_SECRET”
原因：密钥没加，或加成了明文变量但值为空
处理：加 Secret 类型的 JWT_SECRET，随便一串 32 位以上随机字符，保存后重试

现象：AI 一直转圈，最后提示超时
原因：DEEPSEEK_API_KEY 没配、余额不足，或 DeepSeek 接口不可达
处理：先看 /api/health 的 ai_configured，再去 DeepSeek 控制台看额度

现象：前端报跨域
原因：ALLOWED_ORIGINS 里没有当前访问域名
处理：把域名加进去，逗号分隔，别带路径和斜杠

现象：改了代码，页面上没变
原因：三个资源的版本号没改，浏览器用了缓存
处理：index.html 里三处 ?v= 一起改成新版本号

现象：制度库份数显示“…”
原因：/api/stats 或 /api/knowledge 没取到数据
处理：确认已登录、Worker 已部署；份数是后端下发的，前端不写死

现象：想清空演示数据
原因：DEMO_SEED 默认会补一批演示通知和账号
处理：设 DEMO_SEED=0，再删掉演示账号对应的数据


九、成本
----------------------------------------

AI 问答按 DeepSeek 官方计费。开了联网搜索，一次提问可能触发多组查询和一到两次网页抓取，比纯对话贵；搜索结果缓存 6 小时、抓取正文缓存 24 小时，重复问题不会重复扣额度。

想控成本，可以在界面上默认关掉联网搜索，或者把 Pro 模型换成 Flash。


十、本地能测到什么程度
----------------------------------------

前端可以本地起个静态服务器，改 config.js 指到线上 Worker，把界面和交互全部走一遍。

后端跑不了本地 D1，只能在 wrangler dev 里做语法与路由层验证；真实的数据读写、密钥、额度，得部署完在线上点。上线前建议按第 5 步的自检清单过一遍。

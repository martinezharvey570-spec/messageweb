# 校务智理 v2.1 · 文理智办（Cloudflare Pages + Workers + D1 + R2）

本版本在原有校务智理登录、通知、待办、用户管理和统计功能上，增加 DeepSeek API 服务端代理和校园文件知识库。

## 已实现
- 前端 AI 助手改名为「文理智办」，提供模型选择：`deepseek-flash`、`deepseek-v4-pro`。
- Worker 服务端代理 DeepSeek `/chat/completions`；API Key 不发送到浏览器。
- D1 保存用户、通知、待办、文件元数据和知识库文本片段。
- R2 保存上传的原始文件。
- 管理员可上传共享资料；登录学生可上传个人资料。
- 文件访问规则：所有登录用户可检索管理员共享文件；用户只能检索自己的个人文件。共享文件只有管理员能删除；个人文件所有者可删除。
- 上传文本文件后切分片段，按问题关键词检索最多 5 个片段，附入模型上下文，并向前端显示参考文件。
- 当前知识库文件格式：TXT、MD、CSV、JSON、DOCX、PDF；单文件上限 10 MiB。DOCX/PDF 使用后端解析器提取文本。
- 响应式页面适配桌面与手机。

## 当前限制（请注意）
- PDF/DOCX 已加入文本提取：普通文本型 PDF 与 DOCX 可解析；扫描图片型 PDF 暂不包含 OCR，需要先 OCR 转成可检索文本。单文件上限为 10 MiB。
- 检索采用轻量关键词匹配，不是向量语义检索；大型知识库可后续接入向量数据库/Embedding。
- 尚未实现用量计费、全局速率限制、审计日志、病毒扫描、文件版本管理和学校统一身份认证。
- AI 回答不能替代学校正式规定；不要上传成绩、身份证号、学号等敏感个人资料。
- 模型 ID 按当前官方 API 文档配置；官方模型会调整，必要时请更新 Worker 的 `models` 白名单和前端选项。

## 1. Cloudflare D1
1. 在 Cloudflare Dashboard → Storage & databases → D1 创建数据库，例如 `xiaowu-zhili-db`。
2. 打开数据库 Console，把 `cloudflare/schema.sql` 全部执行一次。已有数据库可重复执行，其中使用 `IF NOT EXISTS` 的建表语句不会重建原表。
3. 在 `cloudflare/wrangler.toml` 中把 `database_id` 替换为真实 D1 ID。

## 2. Cloudflare R2
1. 在 Dashboard → R2 创建 bucket：`xiaowu-zhili-files`（也可以使用别的名称）。
2. 如果名称不同，修改 `cloudflare/wrangler.toml` 的 `bucket_name`。
3. Worker 绑定名称必须是 `FILES`；D1 绑定名称必须是 `DB`。

## 3. 部署 Worker
Worker 项目根目录应是 `cloudflare/`，入口文件为 `worker.js`，配置文件为 `wrangler.toml`。可以用 Wrangler CLI 部署：

```bash
cd cloudflare
npx wrangler deploy
```

也可以在 Cloudflare Dashboard 创建 Worker 后粘贴 `worker.js`，再在 Settings → Bindings 里绑定 D1（变量名 `DB`）与 R2（变量名 `FILES`）。Dashboard 手动部署时，仍需将 `schema.sql` 先导入 D1。

## 4. Worker Secrets / Variables
在 Worker → Settings → Variables and Secrets 添加：

**Secrets**
- `DEEPSEEK_API_KEY`：从 DeepSeek 官方开放平台创建的 API Key。
- `JWT_SECRET`：使用随机生成的长字符串，不要与 API Key 相同。
- `ADMIN_PASSWORD`：首次初始化管理员密码，设置后不要公开。

**普通 Variables**
- `ADMIN_USERNAME`：例如 `admin`。
- `ADMIN_DISPLAY_NAME`：例如 `系统管理员`。
- `AI_BASE_URL`：`https://api.deepseek.com`。
- `AI_MODEL`：默认模型 ID，例如 `deepseek-flash`。
- `ALLOWED_ORIGINS`：填 Pages 网站的完整来源，如 `https://你的项目.pages.dev`；多个来源用逗号分隔，不建议生产环境使用 `*`。

注意：如果 D1 中已经存在管理员，修改 `ADMIN_PASSWORD` 不会自动重置数据库中的旧密码。请先在全新部署时设置好密码。

## 5. 配置 Pages 前端
- 将 `frontend/` 中的文件部署到 Cloudflare Pages。
- 如果 Pages 和 Worker 是不同域名，编辑 `frontend/config.js`，把 `API_BASE` 改成 Worker 地址加 `/api`，例如 `https://你的-worker.workers.dev/api`。
- 保存后重新部署 Pages。
- Worker 的 `ALLOWED_ORIGINS` 必须包含 Pages 来源域名（只填 origin，不加 `/api`）。

## 6. 测试顺序
1. 打开 `https://你的-worker.workers.dev/api/health`，确认返回 `ok: true`。
2. 在 Pages 注册一个学生账号并登录。
3. 管理员登录后上传 TXT/MD/CSV/JSON 文件，并选择共享范围。
4. 学生打开「校园知识库」，应看到共享文件；学生上传的个人文件只应对本人显示。
5. 打开「文理智办」，选模型并提问文件里确实有答案的问题。
6. 检查回答下方的参考资料是否指向正确文件。

## 官方模型信息
本版本按 DeepSeek 当前官方模型列表预置 `deepseek-flash` 与 `deepseek-v4-pro` 两个模型 ID。请以官方 API 文档实时列表为准：
- 模型列表： https://api-docs.deepseek.com/zh-cn/api/list-models/
- 对话接口： https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/
- 首次调用： https://api-docs.deepseek.com/zh-cn/

本源码仅提供接入能力，不包含 API 额度或密钥；需自行在官方平台开通 API 并配置 Secret。尚未替你部署到 Cloudflare，也没有使用真实 API Key 做在线请求测试。

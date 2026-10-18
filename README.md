# 校务智理 v2｜Cloudflare 在线版

本版本以 Cloudflare Pages（前端）+ Workers（API）+ D1（共享数据库）为目标架构，保留原生 HTML/CSS/JS，尽量减少框架和构建步骤。

## 这一版的功能

### 学生
- 注册、登录、退出登录（令牌有效期 12 小时）
- 查看所有共享通知公告、按类别/关键词筛选
- 将通知加入自己的待办；标记待办完成/待处理
- 使用 AI 校务助手（配置模型服务后启用）

### 管理员
- 发布校园通知，可为当前所有学生生成待办
- 查看注册用户及角色
- 修改其他用户角色（学生/管理员；不能修改自己的角色）
- 查看系统统计：用户数、通知数、任务数、完成率

### 安全与适配
- 学生/管理员权限由后端 Worker 检查，不能只靠前端隐藏按钮
- 密码使用 PBKDF2-HMAC-SHA256 派生并保存盐值和哈希，不保存明文密码
- D1 存储共享数据，不依赖浏览器本地数据库
- 手机/桌面响应式界面
- AI 密钥仅从 Worker 环境变量读取，不放入前端

## Cloudflare 三件套部署

### A. 创建 D1 数据库
1. 登录 Cloudflare Dashboard，打开 **Workers & Pages → D1 SQL Database**。
2. 创建数据库 `xiaowu-zhili-db`。
3. 打开数据库的 Console，执行 `cloudflare/schema.sql` 全部 SQL。
4. 在数据库设置中记录 database ID。

### B. 部署 API Worker
1. 在本机安装 Node.js LTS 和 Wrangler CLI：`npm install -g wrangler`。
2. 登录 Cloudflare：`wrangler login`。
3. 进入 `cloudflare` 文件夹，编辑 `wrangler.toml`，把 `database_id` 替换成刚才真实的 ID。
4. 部署：`wrangler deploy`。首次部署前确保 D1 schema 已执行。
5. 在 Cloudflare Worker 的 Settings → Variables and Secrets 设置：
   - `JWT_SECRET`：随机生成的长密钥，建议至少 32 字节随机值。
   - `ADMIN_USERNAME`：管理员用户名，例如 `campusadmin`。
   - `ADMIN_PASSWORD`：强管理员初始密码。
   - `ADMIN_DISPLAY_NAME`：例如 `校务智理管理员`。
   - `ALLOWED_ORIGINS`：Pages 的实际网址，例如 `https://your-project.pages.dev`。如有自定义域名，用逗号分隔加入。
6. 重新部署或确认配置已生效。首次 API 请求会创建管理员账号和两条演示通知。管理员账号创建后，更改 `ADMIN_PASSWORD` 不会自动重置数据库内的密码；请用后续管理员管理功能/维护 SQL 进行密码重置（当前 UI 不提供重置密码功能）。

### C. 部署前端 Pages
1. 在 Cloudflare Pages 创建项目，把 `frontend` 文件夹作为静态站点根目录上传/连接 Git 仓库。
2. 不需要构建命令；输出目录就是 `frontend`。
3. 打开 `frontend/config.js`，将 `API_BASE` 设置为已部署 Worker 的完整 API 地址，例如：
   `https://xiaowu-zhili-api.<你的子域>.workers.dev/api`
4. 重新部署 Pages。把 Pages 的网址加入 Worker 的 `ALLOWED_ORIGINS`。

### D. 可选：启用真实 AI
Worker Settings → Variables and Secrets 中添加：
- `AI_BASE_URL`：模型供应商的 OpenAI 兼容 API 根地址（通常是 `https://供应商域名/v1`，具体以供应商文档为准）
- `AI_API_KEY`：私密 Secret
- `AI_MODEL`：供应商支持的模型 ID

确认 Worker 的运行环境可以访问该供应商。未配置时，AI 页面会明确提示未配置，而不会假装已经调用了 AI。不要把密钥写进 `frontend/config.js`。不要发送真实学生隐私数据给模型服务。

## 本地/线上联调
- 前端必须经 HTTP(S) 打开，不要直接双击 `index.html`。
- 本地测试时，可将 `frontend/config.js` 的 `API_BASE` 指向已部署的 Worker API；或者用 Wrangler 启动 Worker 并配置 D1 本地/远端绑定。
- Worker 的 CORS `ALLOWED_ORIGINS` 必须包含前端准确来源。
- 首次部署后访问 `https://你的-worker/api/health` 检查服务状态。

## 中国大陆可访问性说明
Cloudflare 产品在不同网络、运营商和地区的可达性可能不同，不能保证 `workers.dev` 或 `pages.dev` 在中国大陆所有网络均稳定访问。部署后必须从校园网、手机流量和不同运营商实际测试。若需要稳定面向中国大陆用户，可考虑使用大陆可访问的云服务商托管前后端；大陆服务器/域名按要求办理备案。可保留同样的 API 结构，把 Worker 业务逻辑迁移到普通后端。

## 当前边界/安全提醒
- 这是比赛 MVP，不是学校正式业务系统；尚未接学校统一身份认证、教务/学工系统或官方通知源。
- 注册默认开放。公开比赛前建议加邀请码/审核，防止陌生人注册；当前没有找回密码/邮箱验证。
- 用户角色修改能力仅管理员可用；管理员不应随意把不可信账号提升为管理员。
- 当前通知删除 API 已实现但页面暂未提供删除按钮；没有通知编辑、审计日志、附件上传、站内消息推送。
- AI 不会自动检索校内文件；回答不应作为学校正式答复。
- D1/Workers 免费额度与平台策略会变化；按 Cloudflare 最新套餐与服务条款核实。
- 上线前需要补充限流、登录失败保护、管理员操作审计、备份/恢复测试和隐私政策。

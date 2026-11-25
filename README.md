# 校务智理 · 校园事务服务平台

> 面向高校师生的全栈式校园事务与智能办事工作台（[https://messageweb.xyz](https://messageweb.xyz)），集**通知公告、个人待办、127 份官方校规制度库、超级课表、智慧工具箱、校务指南 AI、治理数据洞察**与**原生 Android 伴侣应用**于一体。

前端采用零构建原生静态架构（HTML + CSS + Vanilla JS + PWA），后端运行于 Cloudflare Workers + D1，修改后可直接部署，无任何前端打包依赖。

---

## 一、核心功能全景

全站包含 **12 大功能页面**、**13 个模态交互浮层**、全局 `Ctrl + K` 聚合搜索（Spotlight），并全面适配桌面端、移动端与浅色 / 暗黑双主题：

| 模块 | 核心能力 |
|---|---|
| **总览工作台** | 个人欢迎卡片、今日课程实时状态条、通知/待办/已完成/制度库 4 维概览、最新通知流、快捷服务与 2×2 校园效率工具直达 |
| **通知公告** | 按类别（办事提醒 / 教学事务 / 学生工作 / 校园通知）筛选、实时检索、详情查看、收藏与一键转待办；管理员可发布/编辑/删除通知并自动分发学生待办 |
| **我的待办** | 个人待办快速录入与日期选择、AI 对话/群通知一键批量导入、状态筛选、全部完成与已完成清理 |
| **校务指南 AI** | 流式输出、内置制度库优先检索 + DeepSeek 官方联网溯源（`site:xawl.edu.cn`）、多模态图片/附件理解、模型（Flash / Pro）与思考深度切换、来源引用折叠抽屉、写操作确认卡片与追问建议 |
| **校规制度库** | 收录 **127 份** 西安文理学院官方规章制度（涵盖教务处、学生工作部、考试缓补考、成绩与学分绩点换算、毕业论文、奖助资助、宿舍公寓等），支持部门与主题双筛选、公文式阅读器（章节目录、字号调节、阅读进度、复制全文、官网原文直达、AI 解读）及管理员自定义补充校规 |
| **超级课表** | 桌面端 18 周完整课程矩阵 + 移动端按日/按周流畅切换、AI 文本/截图智能导入与交互核对、手动增删改课、JSON 备份与 `.ics` 日历导出 |
| **智慧工具箱（4 大独立页）** | ① **群通知拆解**：粘贴辅导员/教务群消息或上传截图，一键拆解时间/地点/材料并批量转待办；<br>② **学业与奖助**：官方标准 GPA 绩点计算 + 奖助评优与学位红线自检体检仪；<br>③ **校园办事向导**：高频事务分步核对清单与申请文书一键生成；<br>④ **超级课表助手**：考试倒计时、空闲时间段分析与 `.ics` 导出 |
| **全局聚合搜索** | 顶栏搜索栏（桌面端 `Ctrl + K` / 移动端放大镜圆钮），毫秒级跨模块检索校规制度、通知公告、个人课表、待办，并支持一键直达 AI 提问 |
| **用户管理与数据统计** | 管理员查看用户与角色调整、平台运行概览（圆环完成率与任务构成）、AI 校务治理热点与盲区洞察 |
| **Android 伴侣 App** | 同源 WebView 原生壳工程（`xiaowu-zhili.apk`），内置 3D 翻书液态玻璃启动动画、3 款桌面 4×2 液态玻璃「今日课表」小组件（冰川透光 / 极光蓝靛 / 珍珠胶囊）、免占状态栏闹钟图标的课前提醒引擎、系统日历直写与同源玻璃「提醒与小组件中心」 |

---

## 二、视觉设计语言规范（Pearl Liquid Glass v2 · 四级液态玻璃深度体系）

为保证全站 12 大页面、13 个弹窗以及桌面端 / 移动端 / 浅色 / 暗黑模式 / Android 端浮层的长期视觉一致性，任何后续界面开发均须严格遵守本设计宪章。

### 1. 底层物理光学模型

- **统一光源**：假设环境天光自正上方（12 点方向）斜射而下，界面是一套悬浮于柔和氛围光场中的多层液态玻璃建筑。
- **交互可供性（Affordance）**：无需阅读文字说明，仅凭物理凹凸光影即可瞬间区分组件职责：
  - **深灰下挖孔（Layer 1）** = 容器或轨道，等待文字填入或承托滑块；
  - **透光承托面（Layer 2）** = 稳定安静的信息阅读舞台；
  - **上凸交互件（Layer 3）** = 具有实体按压感的触发按钮与可点击入口；
  - **高空悬浮层（Layer 4）** = 脱离文档流、临时接管焦点的弹窗与浮层。

### 2. 四级光学深度体系与核心 Token

| 层级 | 名称与物理高度 | 交互逻辑支撑 | 核心 CSS 变量 | 光学特征 |
|---|---|---|---|---|
| **Layer 0** | 环境氛围画布（最底层） | 提供柔和冷暖四极天光作为全站玻璃折射底色，避免玻璃卡片发灰发死 | `--pearl-canvas` | 日间：天蓝 / 淡靛 / 晴青 / 极淡暖阳四极柔光 + 纯净浅灰白基底；<br>夜间：深海蓝 / 靛青克制微光 + 深蓝黑基底 |
| **Layer 1** | **强灰阶深下挖毛玻璃孔**<br>（深度 `-3px`） | 输入框、宽搜索栏与分段滑槽必须明显凹进母玻璃中，才能与上凸按钮一眼区分 | `--pearl-l1-bg`<br>`--pearl-l1-shadow`<br>`--pearl-l1-focus-bg`<br>`--pearl-l1-focus-shadow`<br>`--pearl-l1-disabled-bg` | **日间**：纯净中性磨砂灰（比母卡清晰深出一个灰阶，不发蓝发脏）+ 两段顶壁内阴影（`inset 0 3px 7px` + `inset 0 1px 2px`）+ **内下唇与外底沿双白光反光**（`inset 0 -1.5px 0` + `0 1.5px 0`）；<br>**夜间**：深海暗槽 + 强顶内影 + 下沿冷微光；<br>**聚焦**：槽壁微提亮 + 柔和冰蓝折射光晕 |
| **Layer 2** | **真透光承托玻璃面**<br>（基准平面 `0px`） | 阅读信息需稳重通透，保留早期 `v1.090` 晶莹折射质感，让底层环境光柔和透出 | `--pearl-l2-bg`<br>`--pearl-l2-shadow`<br>`--pearl-l2-shadow-hover` | 半透冰蓝白渐变（`0.82 → 0.68`）+ `blur(22px) saturate(195%)` + 顶部 `1.5px` 柔白高光切边 + 贴地柔和投影；仅可点击内容卡悬停微抬 `-2px` |
| **Layer 3** | **上凸液态玻璃交互件**<br>（高度 `+2.5px`） | 物理按键必须上凸才有按压欲，按下时 `scale(0.96~0.97)` 轻弹反馈 | `--pearl-l3-bg`<br>`--pearl-l3-shadow`<br>`--pearl-l3-shadow-hover` | 顶部珍珠高光 + 实体底边厚度 + 清晰外投影；按语义严格细分 3 类材质（见下文第 4 节） |
| **Layer 4** | **顶层高空折射浮层**<br>（高度 `+12px`） | 覆盖主内容之上临时接管焦点，兼顾高可读性与晶透海拔感 | `--pearl-l4-bg`<br>`--pearl-l4-shadow` | 清透高纯玻璃（`0.89 → 0.82`）+ 强折射 `blur(30px) saturate(205%)` + 长距离弥散投影 + 柔化毛玻璃 `::backdrop` |

### 3. 全站几何圆角宪章

| 元素类型 | 规范圆角 | CSS 变量 | 硬性约束 |
|---|---|---|---|
| 纯图标按钮（菜单、关闭 `×`、移动端搜索、附件 `+`、卡片图标操作） | `50%` | `--r-circle` | 强制 `1:1` 等宽高（`aspect-ratio: 1 / 1`、`padding: 0`），严禁出现扁椭圆 |
| 单行按钮、筛选胶囊、标签徽章、全站搜索栏、**所有单行表单输入框**、分段滑槽 | `999px` | `--r-pill` / `--r-field` | 回归经典饱满胶囊语言；搜索容器内部 `<input>` 必须零边框零背景，杜绝“框中框” |
| 多行文本域（`textarea`，如通知正文、群通知拆解、新增校规） | `18px` | `--r-textarea` | 统一 Layer 1 强下挖毛玻璃孔 |
| 内容主卡与面板（Layer 2） | `22px` | `--r-card` | 独立卡片列表外容器（如 `#knowledgeGrid`）必须透明无底板，防止圆角间隙露白角 |
| 悬浮弹窗与弹层（Layer 4） | `26px` | `--r-modal` | 移动端底部抽屉顶部圆角 `26px` |

### 4. 按钮语义材质规范（Layer 3 细分）

1. **主操作 CTA（冰海蓝宝石玻璃）**：页面唯一或首要推进动作（保存、提交、发送、发布、当前选中筛选胶囊、分段选中滑块）。采用柔焦漫射冰蓝渐变，严禁出现生硬顶部白线。
2. **次级操作与功能图标（珍珠白上凸玻璃）**：取消、导出、刷新、查看原文、工具栏筛选下拉、全部正圆图标钮、首页快捷服务与 2×2 效率工具磁贴。
3. **危险 / 停止操作（绯红晶透玻璃）**：删除、停止生成、退出等不可逆或中断动作。

### 5. 关键边界裁决铁律

1. **形态决定层级——顶栏全局搜索**：
   - 桌面端（宽条 `搜索校务… Ctrl K`）→ **Layer 1 强下挖磨砂灰胶囊**（内部 `Ctrl K` 为微型 Layer 3 珍珠键帽）；
   - 移动端（`<=760px` 折叠为 `38×38` 放大镜圆钮）→ **Layer 3 上凸正圆珍珠玻璃**，与左侧 `#menu` 三条杠 100% 镜像一致。
2. **场景决定协调性——下拉与日期选择器**：
   - 表单录入上下文（弹窗表单、待办录入行、GPA/奖助表单、考试倒计时行）→ 与同排输入框统一为 **Layer 1 强下挖胶囊槽**；
   - 页面工具栏筛选上下文（通知分类、制度库部门、用户角色）→ 保持 **Layer 3 上凸珍珠胶囊**，与左侧 Layer 1 搜索栏形成“一凹一凸”清晰主次。
3. **轨道与滑块分离——分段控制器**：
   - 外轨道（`.doc-font-group` / `.ai-seg` / `.sched-d-seg` / `#schedToolsTabs` / `#academicTabs` / `.authbox .tabs`）永远为 **Layer 1 下挖槽**；内部激活项永远为 **Layer 3 上凸滑块**。
4. **可点击入口禁用凹陷阴影**：
   - 首页快捷入口 `.quick`、2×2 工具磁贴 `.home-tool-tile`、AI 欢迎项 `.welcome-item` 均使用 **Layer 3 轻凸珍珠玻璃**。

---

## 三、项目文件清单

```text
messageweb-main/
├── index.html          # 全站页面结构、SVG 图标 Sprite 与 3D 液态玻璃翻书启动页
├── style.css           # 级联安全瘦身后的全站样式 + 四级液态玻璃设计语言单一真相源
├── app.js              # 全站前端交互、超级课表、智慧工具箱与 AI 流式问答逻辑
├── config.js           # 后端 API 地址配置（window.XZ_CONFIG）
├── android-bridge.js   # Android WebView 桥接、安全区适配、课表与小组件数据同步
├── sw.js               # PWA Service Worker 离线与静态资源版本缓存
├── manifest.json       # PWA 应用清单
├── _headers            # Cloudflare Pages 静态资源长缓存与安全响应头规则
├── worker.js           # Cloudflare Worker 后端（含 127 份内置校规库、AI 代理与 D1 接口）
├── version.json        # Android 客户端在线检查更新清单
├── xiaowu-zhili.apk    # Android 伴侣应用安装包（托管于站点根目录）
├── icon-192.png        # PWA / 桌面图标（192×192）
├── icon-512.png        # PWA / 桌面图标（512×512）
└── README.md           # 本文档
```

---

## 四、AI 校务指南工作流

发起提问后，`worker.js` 按以下管线处理：

1. **意图路由**：自动识别校内事务、学业奖助、课表查询、通知拆解或通用闲聊。
2. **校规制度库优先检索**：对内置 127 份官方制度与管理员自定义补充制度做关键词与语义加权检索，精准定位条款并回标文件编号与原文链接。
3. **官网联网溯源（可选）**：当联网开关开启且库内信息不足时，调用 DeepSeek 官方 Search / Fetch 通道优先检索 `site:xawl.edu.cn` 官网一手正文，并进行 6 小时搜索缓存 / 24 小时正文缓存以控制成本。
4. **流式生成与防幻觉校验**：SSE 流式返回思考过程与结构化回答，支持随时停止、重新生成与续写；仅保留真实存在于检索结果中的链接，防止模型编造 URL。
5. **可执行闭环**：自动提取关键办理步骤与课表/待办写操作确认卡片，用户确认后即可一键写入个人待办或超级课表。

---

## 五、部署指南

### 1. 前端静态站点（Cloudflare Pages / 任意静态托管）

1. 将前端静态文件（`index.html`、`style.css`、`app.js`、`config.js`、`android-bridge.js`、`sw.js`、`manifest.json`、`_headers`、`icon-*.png`）上传至站点根目录；如需支持 Android 客户端在线更新，将 `version.json` 与 `xiaowu-zhili.apk` 一并放在站点根目录。
2. 配置 `config.js` 指向你的后端 API：
   ```js
   window.XZ_CONFIG = { API_BASE: "https://api.messageweb.xyz/api" };
   ```
   若前后端同源部署，可简化为 `"/api"`。
3. 每次发版同步更新 `index.html` 中的 `?v=x.xxx` 与 `sw.js` 中的 `CACHE_NAME` / `ASSETS`，确保浏览器与 PWA 立即拉取最新资源。

### 2. 后端 Worker 与 D1 数据库

1. 在 Cloudflare 创建 Worker，部署 `worker.js` 并绑定自定义域名（如 `api.messageweb.xyz`）。
2. 创建一个 D1 数据库，在 Worker 的 **Settings → Bindings** 中添加 D1 绑定，变量名必须为 **`DB`**。数据表会在首次请求时自动通过 `CREATE TABLE IF NOT EXISTS` 初始化，无需手工建表。
3. 在 **Settings → Variables and Secrets** 中配置以下环境变量（密钥项务必使用 Secret 类型）：

| 变量名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `DB` | D1 绑定 | 是 | 主数据库绑定，名称固定为 `DB` |
| `JWT_SECRET` | Secret | 是 | 登录态 JWT 签名密钥（建议 32 位以上随机串） |
| `DEEPSEEK_API_KEY` | Secret | 是 | DeepSeek AI 对话、多模态与联网搜索密钥 |
| `ALLOWED_ORIGINS` | 变量 | 否 | 允许跨域的前端域名列表，逗号分隔（默认 `https://messageweb.xyz,https://www.messageweb.xyz`） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_DISPLAY_NAME` | 变量 / Secret | 否 | 初始管理员账号（默认 `admin` / `系统管理员`） |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 变量 / Secret | 否 | 自定义模型网关地址、默认模型及备用 Key |
| `DEMO_SEED` / `DEMO_USERNAME` / `DEMO_PASSWORD` | 变量 / Secret | 否 | 演示数据开关（设 `0` 关闭）与演示学生账号 |

### 3. 部署自检

访问 `https://api.messageweb.xyz/api/health`，确认返回：
```json
{ "ok": true, "database_configured": true, "jwt_configured": true, "ai_configured": true, "platform": "Cloudflare Workers + D1" }
```

---

## 六、核心 API 与数据表

### 常用接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | 公开 | 部署健康检查 |
| `POST` | `/api/auth/register` / `/api/auth/login` | 公开 | 注册 / 登录并签发 JWT |
| `GET` / `PATCH` | `/api/me` | 登录 | 获取个人信息 / 修改显示姓名与密码 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/notices` | 登录 / 管理员 | 通知公告查询、发布、编辑与删除 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/tasks`（含 `/batch`、`/complete-all`、`/completed`） | 登录 | 个人待办增删改、批量导入与状态清理 |
| `GET` / `POST` / `DELETE` | `/api/knowledge` | 登录 / 管理员 | 校规制度库检索与自定义补充制度管理 |
| `GET` / `PUT` | `/api/schedule` | 登录 | 个人超级课表同步读写 |
| `POST` | `/api/ai/ask` | 登录 | AI 校务指南 SSE 流式问答（支持图片/联网/续写） |
| `GET` / `PATCH` | `/api/users` | 管理员 | 用户列表与角色权限管理 |
| `GET` | `/api/stats` | 管理员 | 平台运行概览与校务治理统计洞察 |

### 核心数据表（D1）

- `users`：`id`、`username`、`display_name`、`password_salt`、`password_hash`、`role`、`created_at`（密码采用 PBKDF2 加盐哈希存储）
- `notices`：`id`、`title`、`category`、`audience`、`body`、`deadline`、`publisher_id`、`created_at`
- `tasks`：`id`、`user_id`、`notice_id`、`title`、`due_date`、`status`、`created_at`
- `schedules` / `custom_docs`：个人课表云端持久化与管理员自定义补充校规存储

---

## 七、隐私安全与常见问题排查

- **隐私边界**：聊天历史、收藏记录、课表本地缓存均按登录账号隔离存于浏览器 `localStorage`，退出账号即自动清理；AI 提问不落库至非必要第三方。
- **前端改完没生效**：请同时检查 `index.html` 的 `?v=` 版本号与 `sw.js` 的 `CACHE_NAME` 是否已递增，并在浏览器中刷新激活新 Service Worker。
- **接口报跨域错误**：检查 Worker 变量 `ALLOWED_ORIGINS` 是否包含当前访问域名（不带末尾斜杠）。
- **AI 请求一直转圈或失败**：先检查 `/api/health` 中 `ai_configured` 是否为 `true`，再确认 `DEEPSEEK_API_KEY` 余额与配额正常。

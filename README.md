# Vireo AI Platform

一个可自部署的多模型 AI 工作台：账号体系、流式聊天（Markdown 渲染 / 思考过程展示 / 停止与重新生成）、知识库检索、联网搜索、用量控制与管理后台。前端 `apps/web`（React + Vite）与后端 `apps/api`（Express + SQLite）完全分离，生产环境通过 Nginx 同源转发。

> 产品定位：实现与 DeepSeek Chat **同类的通用能力**，但不使用或冒充 DeepSeek 的私有模型、账号体系、内部数据或官方品牌资产。所有模型均通过用户或管理员配置的 API Key 调用。

## 功能一览

| 模块 | 状态 | 说明 |
|---|---|---|
| 账号体系 | ✅ | 注册/登录/JWT；scrypt 密码哈希；登录与注册双层限流；管理员账号按环境变量创建 |
| 流式对话 | ✅ | SSE 打字机输出、Markdown/代码块/表格渲染、复制、停止生成、重新生成 |
| 多模型路由 | ✅ | 不内置任何默认模型：填入 Key 后「获取模型列表」发现真实模型（自动过滤非对话类、美化显示名）；内置供应商仅 DeepSeek 与通义千问，其他（OpenAI/Kimi/GLM/Ollama/vLLM 等）通过「自定义供应商」以 OpenAI 兼容接口接入 |
| 模型发现 | ✅ | 设置页填入 Key 后可「获取模型列表」：调上游 /v1/models 拉取真实清单（自动过滤 embedding/语音等非对话模型），发现的模型进入对话页下拉框可选，全平台共享、可移除；内置模型始终保留 |
| 密钥管理 | ✅ | 个人 Key（服务端加密存储、掩码回显）优先于平台 Key（管理后台配置） |
| 知识库 | ✅ | 文本类文件（txt/md/csv/json 等）自动分块；勾选后对话内检索注入，标注引用来源。配置 OpenAI/通义 Key 后自动升级为「语义向量 + 关键词」混合检索（RRF 融合），未配置时无缝回退关键词模式 |
| 深链路由 | ✅ | hash 路由（#/c/:chat、#/kb、#/settings、#/admin）：刷新不丢页面、链接可直接分享、浏览器前进/后退可用 |
| 联网搜索 | ✅ | Tavily 适配器；对话级开关，注入搜索结果并要求标注来源 |
| 用量控制 | ✅ | 按用户每日消息额度限制；token 用量估算入库 |
| 管理后台 | ✅ | 概览统计（含近 7 日用量图表）、用户管理（额度/停用）、平台密钥 |
| 主题 | ✅ | 浅色/深色一键切换，移动端自适应 |
| PDF/Word 解析 | 🚧 | 知识库当前支持纯文本类格式，Office/PDF 解析在规划中 |

## 快速开始（本地开发）

要求 Node.js ≥ 20（推荐 24，使用内置 SQLite）。

```bash
npm install

# 终端 1：启动后端（默认 :8080）
npm run dev:api

# 终端 2：启动前端（Vite :5173，/api 自动代理到后端）
npm run dev:web
```

打开 http://localhost:5173 ：
1. 注册一个普通账号。管理员账号在首次启动时按 `DEFAULT_ADMIN_PASSWORD` 创建（本地未设置时会生成一次性随机密码并在后端日志输出，账号为 `admin@local`）
2. 进入 **设置** 填入你的 DeepSeek / OpenAI / 通义千问 API Key（或由管理员在 **管理后台 → 平台密钥** 统一配置）
3. 开始对话；上传文本文件到 **知识库** 并勾选后即可在提问时自动引用

环境变量见 `.env.example`，本地复制到 `apps/api/.env`。开发态未设置 `JWT_SECRET` 时后端会用一次性随机临时密钥（重启即失效）；`NODE_ENV=production` 下缺失则直接拒绝启动。

## 生产部署（Docker）

```bash
cd platform/infra
cp ../.env.example .env      # JWT_SECRET 与 DEFAULT_ADMIN_PASSWORD 均为必填，缺失时 compose 直接拒绝启动
docker compose up -d --build
# 浏览器访问 http://<服务器IP>/ （Nginx :80 → web 静态资源 + /api 转发）
```

- 数据（SQLite + 上传文件）持久化在 `vireo_data` 卷
- Nginx 已为 SSE 关闭缓冲（`proxy_buffering off`），流式输出可直接透传
- **真实客户端 IP**：应用层限流默认不信任 `X-Forwarded-For`（直连场景下可被伪造绕过）。`infra/docker-compose.yml` 已为本编排（API 固定位于 Nginx 反代之后）设置 `TRUST_PROXY=1`；自行换部署方式时，仅在确有反代时开启该项
- **HTTPS**：默认配置只监听 80。对外提供服务请在 `deploy/nginx.conf` 底部模板启用 443 + 证书 + HSTS，并用 Let's Encrypt 等签发真实证书
- **备份**：`node scripts/backup.mjs [输出目录]` 生成 SQLite 一致性快照，建议加入每日 cron；恢复 = 停机后用快照文件覆盖 `data/vireo.db`
- **已内置的安全基线**：JWT 密钥缺失拒绝启动、登录/注册双层限流（应用层 + Nginx 层）、CSP 等安全响应头、上传类型白名单、知识库文件仅可经鉴权接口下载（无 `/uploads` 裸路径）

## 架构说明

```
apps/web    Vite + React 18（无第三方 UI 依赖）
            views: Home / Chat / KnowledgeBase / Settings / Admin
            lib/api.js：统一请求层 + SSE 流解析
            markdown.jsx：自研轻量渲染器（React 节点输出，天然防 XSS）
apps/api    Express + node:sqlite（零原生编译）
            src/db.js       表结构与种子
            src/auth.js     JWT / scrypt（生产缺密钥拒绝启动）
            src/gateway.js  多供应商路由 / 密钥解析 / 额度 / 用量 / 上游超时
            src/kb.js       文本分块 / 检索 / 上下文注入
            src/search.js   Tavily 适配器
            src/ratelimit.js 内存滑窗限流（登录/注册）
scripts/    backup.mjs  SQLite 一致性快照备份
deploy/     nginx.conf 站点配置
infra/      docker-compose.yml
```

前后端分离要点：
- 所有接口挂在 `/api` 前缀下；开发态由 Vite proxy 转发，生产态由 Nginx 转发，浏览器侧始终同源
- API Key 只在服务端存储与使用，接口仅返回掩码（`sk-****abcd`）
- 支持 `DEEPSEEK_BASE_URL` / `QWEN_BASE_URL` 覆盖上游地址，适配企业私有网关与代理环境；其他 OpenAI 兼容服务用「自定义供应商」接入

## 验证

- 后端集成测试（真实起 Express + SQLite + mock 上游，覆盖鉴权/限流/流式/重新生成旧回复保护/上传白名单/下载越权）：`npm test -w @vireo/api`
- 前端构建：`npm run build -w @vireo/web`
- 离线冒烟：`node apps/api/test/mock-upstream.mjs` 提供本地标准 SSE 上游，可手动验证流式全链路
- CI：`.github/workflows/ci.yml` 在 push / PR 时自动执行语法检查、集成测试、前端构建与两个镜像的构建

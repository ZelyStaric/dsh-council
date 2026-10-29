# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.3] — 2026-10-29

修复验收与执行混淆的问题（来自第三方代码审查，四个发现全部确认并修复）。

### 修复
- **审核 `null`（未判定）不再当作通过**：`unverified` 与 `rejected` 一样触发一次返工；
- **返工失败不再静默丢弃**：记录 `reworkError`，`attempts` 按实际尝试次数计（返工失败也计 2），首次产出仍保留；
- **执行成功 ≠ 验收通过**：`callMember` 新增 `accepted`（布尔）与 `acceptance`（`passed` / `rejected` / `unverified` / `rework-failed` / `none` / `skipped`），`ok` 语义保持不变（仍表示「成员是否产出了东西」）；
- `executeRun` 的状态映射改为：被否 → `rejected`，返工失败 → `failed`，通过/无审校 → `done`，并把 `acceptance` 写入 run 记录；
- 工具回执与气泡新增「验收（小组）」一行，明确写出未通过原因。

### 已知
- `ok` 目前仍表示执行状态而非验收状态；如需 `ok` 直接反映验收，属于破坏性变更，留待后续版本。

## [0.2.2] — 2026-10-29

### 新增
- **`proxyUrl` 配置**：官方 key 经本机代理访问 `api.openai.com` / `api.anthropic.com`（Clash 混合端口 `http://127.0.0.1:7897` 即可）。
- claude / codex CLI 子进程同步注入 `HTTP_PROXY` / `HTTPS_PROXY`。
- `/models` 失败时回传 HTTP 状态，便于区分「key 无效」与「网络不通」。

### 修复
- **代理不可达会把整个插件拖死**：现在先探测端口（800ms），连不上自动回退直连并打日志。
- `POST /config` 返回 500（`ReferenceError: own is not defined`）。

### 变更
- base 统一归一成根地址（去掉尾部 `/` 与 `/v1`），各调用点再拼 `/v1/models`、`/v1/images/generations`、`/v1/usage`。

## [0.2.1] — 2026-10-29

### 新增
- **模型列表实时化**：`GET /models?refresh=1` 强制刷新；缓存 30 分钟 → 10 分钟。
- 保存 API 配置后自动重拉模型列表；打开名册浮层也拉一次。
- 模型下拉优先用实时列表，拿不到再回退内置清单（名册浮层同样）。
- 出图模型从同一中转解析（`gpt-image-*` 归入 image 类）。

### 修复
- `codexBase` 为空时 `/v1/models` 请求 URL 非法（`Failed to parse URL`）；现在回退读 `~/.codex/config.toml` 的 `base_url`（只读）。
- 用量查询改用「有效 base」，不再受页面 base 清空影响。

### 移除
- 第三方 provider 预设与重复的 API 卡片。

## [0.2.0] — 2026-10-29

首个可分发版本。

### 新增
- **会话即群聊**：指挥拆解 → 成员并发 → 审校初审 → 指挥终审 → 不合格自动返工一次。
- **8 个岗位预设**（指挥 / 代码 / 全栈 / 审校 / 画师 / 配乐 / 3D建模 / 动画），名字、提示词、成员、模型、组级风格全部可改。
- **4 种成员框架**：codex(GPT) / claude(Anthropic) / deepseek(DSH 内建) / image(出图)。
- 三视图：`对话`（原生）/ `群聊`（按轮分隔、回到最新、折叠）/ `小组`（编排、风格、API、用量）。
- 输入框上方实时进度条（谁 / 阶段 / 秒数）。
- 名册浮层：成员增删、框架与模型、职位增删改名与提示词。
- 超时自动重试一次；子会话复用或摘要回灌两种记忆模式。
- 单人模式不显示任何小组成分。

### 安全性
- 分发包不含任何密钥、绝对路径与立绘素材；头像缺失时回退内置 SVG 占位。

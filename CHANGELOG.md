# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]（2026-11-05，未提交、未改版本号）

### 修复
- **进度的「静默 Ns」不是真静默**：`silentMs` 原来只在阶段变化（`progressSet`）时才拿到新的
  `lastActivity`，成员一直在输出的 codex 也会显示「静默 1207s」。现在 run()/seam 的 stdout 活动回调
  经 `createProgressBeat` **≥1s 节流**写 `lastActivity`（`progressSet` 新增活动心跳分支：只刷新活动时间，
  **不动** `at`/阶段时间），`silentMs` 才真的等于「多久没输出」。新增 `stageChangedAt`（阶段变化时间）
  与 `stageAgeMs`（本阶段停留时长），`/progress` 每个成员条目都返回；既有字段名一律不变。
- **看门狗杀不死 systemd scope 里的进程 → 孤儿堆积**：成员跑在 `systemd-run --scope` 里，scope 是
  cgroup，只 `child.kill()` 不会带走 cgroup 里剩下的进程（实测杀客户端后 `sleep` 仍在、scope 仍 active；
  现场 `council-11b3f6aa.scope` 从 00:49 挂到 11:09）。新增 `killScope()`（`systemctl --user stop
  <unit>.scope`，不阻塞），`terminate()` / `hardKill()` / `finish()` 都会调；启动前若同名 unit 已存在
  （极罕见）先用 `is-active --quiet` 探测再同步 stop 后 spawn（scope 没有 `MainPID`，不能用它探测）。
- **验收未通过的回执被当成「已完成」交付**：`council_delegate` 回执在整次调用结论为
  `rejected` / `rework-failed` / `unverified` 时，**第一行**插入
  `⛔ 本次未通过验收（返工 N 次后仍不通过）。这不是交付物：…`，正文下移，末尾追加
  `## 验收（本次调用）`（结论 + 中文说明）；验收通过时不加。
- **会话页「N 个子智能体」只增不减**：那个数字是会话里的 `subagent/catalog` 记录数，
  `dispose()` 只释放内存、不删会话目录。现在：
  1) 插件 dispose 掉**自己创建**的子会话后顺手删它的会话目录（`deleteChildSessionDir`；
     非 reuse 模式才删，读不出 `parentSession`/对不上父会话/命中保留集合一律不删）；
  2) 驻留清扫器释放驻留子代理后同样删目录；
  3) 新增 `POST /council/api/sessions/prune-children`（`{ sessionId?, dryRun?, keepMinutes?=10 }`
     → `{ removed:[{id,sizeMb,mtime}], kept, dryRun }`）：只清 `parentSession === sessionId`
     且目录 mtime 早于 `keepMinutes` 的子会话目录；路径白名单与 `/sessions/prune` 同一套
     （两层直接子目录、uuid 名、不跟符号链接、非 uuid 不动）；当前会话自己/成员 `convId`/
     驻留表里的子会话一律保留；
  4) `GET /council/api/state` 新增 `subagentSessions`（`subagent/catalog` 记录数）与
     `childDirs`（磁盘上 `parentSession === 当前会话` 的目录数），方便对照。
- `pruneChildSessionDirs` 把「目录已在 dispose 时删掉」也计入 `prunedSessions`，
  否则回执里的「已清理 N 个子会话目录」会从 N 掉成 0。

### 新增
- `council_delegate` 的 output schema 增加 `acceptanceStatus`
  （`passed|rejected|rework-failed|unverified|none`）与 `acceptanceNote`；`members[]` 也带归一后的 `acceptanceStatus`。
- `mandateText()` 增加硬规则：『验收未通过』≠ 交付 —— 不得把未通过验收的回执当成果汇报。
- `config.authoritativeReviewer`（`any` 默认 / `commander`）：`commander` 下以指挥终审为准，
  审校与指挥冲突时不再判失败；`GET/POST /council/api/config` 读写。
- **越权审计（方案 B，只审计不拦截）**：`tools.guard` 放行 `bash` / `read_image` /
  `grep+glob+read+read_file` 时分别计入 `selfRan.bash` / `selfRan.readImage` / `selfRan.read`；
  `council_delegate` 回执末尾在本次增量 >0 时输出 `## 越权审计`，output 新增
  `selfRan: { bash, readImage, read }`（没有则全 0）。Δ 口径为**水位线**：`execute` 收尾时
  Δ = 当前累计计数 − 本组已报水位，报完立刻把水位推到当前计数——**先跑 bash 再派活**也会在
  下一次回执里报出来，已经报过的不重复报（紧接着再派一次且无新调用时 Δ=0）。

## [0.2.4] — 2026-10-29

在**另一台全新 Ubuntu 24.04**（Node 22 + 全新 profile + 从 tarball 安装）上实测部署后发现并修复。

### 修复
- **分发包里残留厂商默认地址**：`cordis.patch.yml` 原来内置 `claudeBaseUrl: https://apiclaude.cc`，在别人机器上会指向错误中转；现已移除，配置全部由页面或 profile 提供。
- **缺少 CLI 时报错不明确**：`codex` / `claude` 不存在时，原先只会得到 `spawn ... ENOENT`；现在先探测可执行文件，直接返回「未找到 codex CLI（…）。安装 Codex，或用环境变量 COUNCIL_CODEX_BIN 指定绝对路径」。

- **更新不存在的成员时静默成功**：`POST /members` 带未知 `id` 现在返回 `404 member not found`，不再假装成功。

### 变更
- **首次使用提示**：全新安装时 Hero 还没有会话，点「单人模式」胶囊会提示「先发一条消息建立会话，再点小组模式」（此前点击无反应）。
- README 增加「首次使用的顺序」四步。

### 验证
- 全新机器上 `plugin_manager/pnpm` 安装 → `dsh web --port 3099` 启动 → `/council/api/state` 200；
- `roles / members / groups` 增删查、`/models`、`/usage`、`/progress` 全部正常返回；
- 重启后状态持久化（`~/.dsh/storages/council.json`）。

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

# Changelog

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.64] - 2026-11-13

### 变更

- **子会话复用默认开**：`runDeepseekViaSeam` 里的复用开关原来只有页面显式勾上 `reuseAgents` 才生效
  （默认每次派活都开新子会话、用完删目录）。现在抽成 `reuseChildrenFor(member, config)`：
  **只有显式 `reuseAgents: false` 才关**，未设一律按开——同一成员跨轮派活接着同一个子会话跑，保住上下文。
  `member.__reuse` 的强制语义保留（显式关掉时仍按它走）。
- 审核位（`__noResume`）**不再靠 `reuseEnabled === false` 兜底**：复用默认开后，`__reviewConvId`
  恢复与续接两处都显式加了 `!member.__noResume`，审核位任何情况下都开新会话。

### 测试

- `tests/staffing-test.mjs` 新增 2 条 `reuseChildrenFor` 断言（未设 → true；显式 `false` → false，
  且 `__reuse` 仍可强制），并把原有 dispose 用例改为显式 `reuseAgents: false` 才验「用完删目录」。

## [0.2.63] - 2026-11-13

### 修复

- **点「停止」不再静默失效**：0.2.62 把 `progressRow` 提到模块级后，行内 `setRowStopped` 仍去写
  `setEntries`，而它只存在于 `CouncilProgress` 作用域 —— 点停止会抛
  `ReferenceError: setEntries is not defined` 且被 `catch` 吞掉，**按钮看着在、点了没反应**
  （截图/文案断言都发现不了，只有真点才暴露）。现在由 `CouncilProgress` 用闭包造
  `setRowStopped(target)` 作为第 4 个参数传进去，只给被点的那一行置灰。

### 测试

- `tests/render-smoke.mjs` 新增 `progress/stop-click`：**真的调用**「停止」节点的 `onClick`，
  断言不抛错、且只有被点的那一行带上 `stoppedAt`。已回退到 0.2.62 验证过该断言会
  `FAIL … setEntries is not defined`（不是摆设）。
- 冒烟桩的 `useState` 改为**真 setter**（原来一律 no-op，所以作用域类 bug 抓不到）。

## [0.2.62] - 2026-11-13

### 修复

- **并行派活全部显示**：进度条原来 `setEntry(list[list.length - 1])`，**只渲染最后一条**——实测
  session-34e6de19… 有 3 条并行派活，`/progress` 返回 3 条，页面只看到 1 条。现在状态改为
  `entries` 数组，**每条进行中的派活各占一行**（垂直堆叠、间距 4px），「停止」按行独立置灰
  （请求仍是 `{ all: true }`，语义不变）；单条时渲染与旧版完全一致。
- **成员芯片显示「正在做什么」**：格式 `名字 · 阶段 · <任务摘要>`。服务端在 `排队中` / `已停止` /
  阶段回调三处 `progressSet` 里写入 `task`（空白压成一行、截 60 字），客户端只显示前 24 字
  （超出加 `…`）。`/progress` 响应只**新增** `task` 字段，其余字段名与结构不变。

### 测试

- `tests/render-smoke.mjs` 新增 `progress/parallel-two-entries`：两条不同 callId 的进行中条目 →
  断言「小组」出现 **2** 次、两行成员芯片都带任务摘要、摘要超 24 字要截断、`停止` 仍在（40 项全过）。

## [0.2.61] - 2026-11-13

### 修复

- **后台派活回执不再截断**：`notifyParentJobDone()` 里 `body.slice(0, 8000)` 已去掉，完整回执原样推进主会话（其余逻辑不变：`job.notified` 去重、followup→steer 回退、仅后台模式推；`REVIEW_TEXT_HARD_CAP` 只作用于审校文本，未动）。

## [0.2.60] - 2026-11-13

### 修复

- **后台派活完成后主动唤醒主会话**：`backgroundDelegations=true` 时 `council_delegate` 立刻返回 runId，
  成员跑完只写进后台任务表、**没有任何推送** —— 主会话一直闲着，用户看不到回执
  （实测 session-34e6de19… 就是这样：成员全跑完了，主会话毫无反应）。
  现在后台任务 `then`/`catch` 都会调 `notifyParentJobDone(ctx, job)`，把
  `[后台派活完成] runId=… · 状态=done|failed · 用时=Ns` + 回执正文作为一条 **user 消息**推进主会话
  （`agent.followup(msg)`，没有则退回 `agent.steer(msg)`）。
  - 每个任务**只推一次**：`job.notified` 幂等；`council_collect` 成功取走结果时也会置位，避免重复。
  - 前台阻塞模式（`backgroundDelegations=false`）不推。
  - 回执截断到 8000 字符；失败任务用 `job.error`；推送异常全部吞掉，绝不影响派活主流程。
- 顺带把 `delegateReceiptText` 从 `bindAgent` 函数体里挪出来（原本被误嵌在里面、外层取不到），
  现在与 `notifyParentJobDone` 相邻，都是顶层函数。
- 测试：`tests/staffing-test.mjs` 新增 1 项（共 159 项）覆盖 推送一次 / 重复拦截 / 失败任务带 error / 开关关闭不推 / 无 agent 不抛错。

## [0.2.59] - 2026-11-11

### 变更
- **`MODEL_GUIDE` 精简到 8 条**（17 → 8）：只留实测在用的
  `claude-opus-5-5`、`claude-fable-5-2`、`gpt-6-astra`、`gpt-6.1-sol`、`deepseek-flash`、
  `deepseek-v4.1-flash`、`gpt-image-2.6-flare`、`gpt-image-2.6-sunburst`，描述各一句话。

### 移除
- 旧模型条目：`claude-sonnet-5`、`claude-sonnet-5-5`、`gpt-6-sol`、`gpt-6-luna`、`gpt-6.1-terra`、
  `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` —— 不再出现在定位表里（指挥不会再按旧印象选）。
- `deepseek-v4-pro`（已被 flash 全面胜出）。注：它作为**历史配置值**仍留在
  `DEEPSEEK_LEGACY_MODELS` 迁移集合里，用来把老成员换到新模型，与定位表无关。

### 说明
- 两个 deepseek 名字合并成同一条模型的两种叫法：`deepseek-flash` = 官方 API 名（即 V4.1-Flash-1017），
  `deepseek-v4.1-flash` = 中转站 `relay-deepseek` 的名字，**价格约 3 折 → 能走中转就走中转**。
- `MODEL_GUIDE_TIEBREAK` 未改（`gpt-6.1-sol` / `deepseek-v4.1-flash` 都还在表内，无悬空引用）。
- `catalogText()` 输出格式不变（仍是同步字符串、同一标题行、同一行格式），
  `tests/staffing-test.mjs` 的定位表用例同步改成断言「8 条 + 旧 9 个名字不得出现 + 中转 3 折/官方名的措辞」。

## [0.2.58] - 2026-11-11

### 新增
- **模型定位表 `MODEL_GUIDE`**：给每个模型 id 写一句定位（擅长什么 + 代价），指挥（拆解者）不再只看到
  「有哪些 id」，可以按能力选模型。覆盖 claude / gpt-6 系 / deepseek / 出图。
- `catalogText()` 在模型清单之后追加 **「## 模型定位速查」** 段落，逐行 `- <model>：<描述>`；
  该段同时进主对话系统提示（`council:catalog` section）与 `planWithCommander` 的拆解提示词。

### 变更
- 指挥拆解提示词追加一句选模型约束：补员/换模型时按「模型定位速查」选、不凭旧印象；
  一个任务只用一种主力模型；没把握时优先 `gpt-6.1-sol` / `deepseek-v4.1-flash`（`MODEL_GUIDE_TIEBREAK`）。
- `catalogText()` 仍为**同步**函数（`systemPrompt.section.text` 要求字符串，不能是 Promise）。

### 说明
- `MODEL_GUIDE` 内容来自用户经验，**不是官方基准、未做线上核实**。

## [0.2.57] - 2026-11-11

### 修复
- **provider 解析器支持 `Authorization` 折行写法**（`parseProviderFromYaml`）：当
  `Authorization: Bearer` 的值只有 `Bearer`（YAML 折行时下一行缩进更深的 key 会被当成第二个 token）
  时，向下看一行缩进更深的行，拼成 `Bearer <token>` 再剥前缀。
  - 只在缩进**更深**时才拼，否则放弃（避免把下一个字段 `compat:` 当成 key）；
  - 折行 token 里含 `:` 视为字段而非 key，同样放弃；
  - 只有 `Bearer` 而没拼到 token 时返回 `null`（原来会得到字符串 `Bearer`，下游会拼出 `Bearer Bearer`）。
  - 效果：这类写错的 profile 不再静默 401（只剩静态 3 个模型），探模型恢复正常。
- **profile `~/.dsh/profiles/web/cordis.patch.yml`**：`relay-claude` / `relay-gpt` / `relay-deepseek` /
  `relay-image` 四处 `Authorization: Bearer` + 下一行 key 合并为单行（key 未改动）。

## [0.2.56] - 2026-11-11

### 新增
- **出图纳入 DSH provider 体系**（Host 半 `runImage`）：成员 `provider` 非空时走
  `providerEndpoint(member.provider)` 取该 provider 的 baseURL/key（base 用 `rootUrl()` 去掉结尾 `/v1`），
  再拼 `/v1/images/generations`（有参考图仍是 `/v1/images/edits`）；`provider` 为空时保持旧行为
  （`config.imageKey` + `config.codexBase`）。provider 解析失败**直接报错**，不再静默回落去花 imageKey 的钱。
- **profile 新增 `relay-image` provider**（`gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`，
  `api: openai-completions`，key 取 `council.json` 的 `config.imageKey`），插在 `relay-deepseek` 之前。
- 顺手修掉 profile 里 `relay-deepseek:` 少两个空格的缩进（原来落在 `config` 级、不是 `providers` 下的 provider）。

### 变更
- **小组页只留一个「+ 添加成员」按钮**（原来 codex/claude/deepseek/image 四个）：默认建 `deepseek` 成员，
  建完在成员卡里选提供商即可。
- **提供商下拉按模型推断 kind**（顺序固定）：含 `claude` → `claude`；含 `gpt-image` → `image`；
  含 `gpt-` / `o<数字>` → `codex`；含 `deepseek` → `deepseek`；否则 `codex`。
  选到出图类 provider 时 `mutate('/members', …)` **同时写真实 `provider`**（不再写 `''`）。
- **成员卡模型下拉**：image 成员绑了 provider 就用该 provider 的模型列表；没绑时回退 `modelOptions('image')`。

## [Unreleased]（2026-11-05，未提交、未改版本号）

### 修复
- **审核「未判定」的根因：审核在续接一个「已死/空上下文」的 claude 会话**。实测
  `claude -p "…" --resume <死 sid>` 不答题、只回 `I'm here and ready to help.` /
  `How can I help you?`（日志里 8 次 `commander image review unparsed: …`），输出里没有 JSON
  → 旧实现记 `ok:null` → 页面「未判定」。现在：
  1) **审核一律不续接历史会话**：`selfReview` / `prelimReview` / `commanderReview`（文本 + 看图）
     调用前 `convId = undefined` + `__noResume`，`runClaude` 据此**不追加 `--resume`**；
     审核也不再把自己的子会话写回 `member.convId`（这正是「下一轮拿审核会话当工作会话续接」的来源），
     `prelimReview` 不再写 `state.reviewChildren`；
  2) **问候/空炮检测** `looksLikeGreeting(text)`（长度 < 200 且命中 `ready to help|How can I help|
     你希望我|请告诉我|What would you like` 等）：命中就丢掉本次结果、**换新会话重试一次**；
  3) 重试后仍解析不出 JSON → verdict 归一为 `{ok:false, reason:'审核输出无法解析（已重试）'}`
     （`REVIEW_UNPARSED_REASON`），**不再产出 `unverified`**；`unverified` 只保留给「本组一个审核位都没配」；
  4) 日志把首次与重试的原文各前 200 字符都打出来（`[council] <label> … 首次原文=… / 重试原文=…`）。
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
- **分发包里残留厂商默认地址**：`cordis.patch.yml` 原来内置 `claudeBaseUrl: （厂商默认中转地址）`，在别人机器上会指向错误中转；现已移除，配置全部由页面或 profile 提供。
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

# dsh-council — DeepSeek Harness「小组」插件

把**会话变成一支团队**：你说一句需求，指挥拆解 → 成员在各自的 agent 框架里并行干活 → 审核链把关 → 全过程在「团队」页实时可见，产出（图/音/视频/模型文件）可直接预览。

> **只想看它能干什么？** → [FEATURES.md](./FEATURES.md)（纯功能清单，12 个分类）
> **想了解实现与踩过的坑？** → [`~/docs/dsh-council-handoff.md`](/home/nanami/docs/dsh-council-handoff.md)

> 与官方子代理的区别：官方只回最终答案；本插件把每一步（谁、什么阶段、多久、最近一行输出）暴露出来，
> 并且**每个成员可以挂不同框架/模型**，各跑各的原生 agent（Codex CLI / Claude Code CLI / DSH 内建 agent / 图像接口 / 任意 OpenAI·Anthropic 兼容中转）。

> 仓库标签：`dsh` · `deepseek-harness` · `cordis` · `plugin` · `multi-agent` · `agent-orchestration` · `codex` · `claude` · `ai-agents`

## 运行环境

| 项 | 要求 | 说明 |
|---|---|---|
| **DSH** | 0.2.1-rc.2（当前唯一实测版本） | 用到 subagent seam、`uiConversation` 等内部 API |
| **Node** | ≥ 22（开发/构建用） | 运行时由 DSH 自带，插件不额外起进程 |
| **OS** | Linux（开发机实测 Ubuntu 24.04） | 依赖 POSIX 路径与 `systemctl --user` 管理服务 |
| **浏览器** | 现代 Chromium / Safari / Firefox | 用到 `<details>`、`<audio>`、`<video>`、`localStorage` |
| **网络** | 能访问所选 provider | 官方端点需代理时可在页面填，中转站通常直连 |

> 不需要 GPU、不需要 Docker、不需要额外数据库——**状态就是几个 JSON 文件**。

## 必备组件

### 必须

| 组件 | 用途 |
|---|---|
| **DSH**（`dsh` 命令） | 宿主，插件跑在它里面 |
| **一个可用的 provider** | 至少一个（官方 key 或中转站都行）|

> 想零配置起步：默认阵容的 指挥/审校 走 **DSH 内建的 deepseek**，装完即可用。

### 按需（用到哪个装哪个）

| 组件 | 什么时候需要 | 安装 |
|---|---|---|
| **Codex CLI** | 有 `codex` 成员（GPT 系） | 官方 npm 包，或 `COUNCIL_CODEX_BIN` 指定路径 |
| **Claude Code CLI** | 有 `claude` 成员（Anthropic 系） | 装了 `dsh-subagent-claude-code` bundle 会自动复用 |
| **Gemini CLI** | 有 `gemini` 成员 | 官方安装方式 |
| **出图 API key** | 有 `image` 成员（画师） | 走 OpenAI 兼容 `/v1/images/generations` |

### 媒体产线（配乐 / 3D / 动画）

| 产线 | 依赖 |
|---|---|
| **配乐** | `fluidsynth` + GM SoundFont + `ffmpeg` + `python3-midiutil`/`mido` |
| **3D 建模** | `blender`（无头）+ `openscad` + `python3 -m pip install trimesh pygltflib` |
| **动画** | `ffmpeg` + Pillow |

---

## 安装

```bash
# 从 GitHub 克隆后安装（推荐）
git clone https://github.com/ZelyStaric/dsh-council
dsh plugin --profile web add -w file:/path/to/dsh-council
systemctl --user restart dsh-web
```

安装后在任意会话顶部胶囊点「**小组**」，进「小组」页配置成员。

## 基础操作

### 第一次用

```
① 建会话
   随便发一条消息（"你好"即可）。小组模式必须依附在一个已有会话上。

② 切到小组模式
   点会话顶部的模式胶囊 → 「小组」。
   首次会自动建组，并放入 指挥 / 审校 两个默认成员（都走 DSH 内建的 deepseek，无需 key）。

③ 说需求
   直接说："生成一张苹果图片" / "写个脚本打印当前时间"。
   这句话会交给指挥，由它拆成任务派给成员。
```

### 日常使用

| 想做什么 | 怎么做 |
|---|---|
| **看进度** | 切到「团队」tab，时间线实时刷新 |
| **看某个成员在干什么** | 「进行中」卡片里每个成员下面有一行 `› 最近输出` |
| **中途停掉** | 整轮点卡片右上角红色「停止」；只停一个成员点它那行的「✕」 |
| **看产出** | 图片点击开大图；音频/视频内嵌播放；其它文件点名字下载 |
| **折叠太长的轮次** | 点轮次标题，或右下角「⊟ 折叠本轮」 |
| **找不到最新消息** | 右下角「↓ 最新」平滑滚到底 |
| **改模型 / 加成员** | 「小组」tab → 成员卡 → 选提供商和模型 |
| **换指挥模型** | 同上，指挥卡也能选（不用改配置文件）|

### 添加一个能出图的成员

```
① 「小组」tab → 「+ 添加成员」
② 提供商选 relay-image（或任何有 gpt-image 模型的 provider）
③ 模型选 gpt-image-2.6-flare
④ 职位拖到「画师」上
```

### 切回单人模式

点胶囊 → 「单人」。小组配置不会丢，随时切回来。

---

## 能力边界

**这几件事做不到，不是 bug**：

| 做不到 | 原因 |
|---|---|
| **成员发言变成真正的 chat 消息** | DSH 的会话日志插件只读，`conversation.chat.node` 的 key 域编译期固定，自定义 kind 注册后 `active:false`。当前用「团队时间线 + 回合末尾块」替代。 |
| **单个任务产出多张独立图** | 单任务只会有一次出图调用；要 6 张独立图必须拆成 6 条任务。 |
| **deepseek 成员按成员指定 MCP** | 它跑在 DSH 自己的子会话里，继承主会话的 profile 配置。 |
| **逐 token 流式输出** | 外部 CLI（claude/codex/gemini）只回最终答案。本插件的"实时" = **每个成员一结束就立刻追加**，不是逐字。 |
| **成员之间互相聊天** | 成员只与指挥通信，指挥汇总后给你。想要成员协作，靠指挥在拆解时写清依赖。 |
| **历史轮次的产出自动清理** | 出图落在 `~/.dsh/storages/council-images/`，不会自动删；要清理得自己动手。 |

**已知限制**：

- **审核链串行**，总耗时 = 自审 + 初审 + 终审，不是取最大值；
- **返工默认 1 次**，可在大脑权限里调，但调大会拉长总时长；
- **静默看门狗默认 10 分钟**，成员卡住会被杀掉，不会无限等；
- **小组模式下父会话不能自己动手**（白名单），想让它直接改代码要么关掉 `strictDelegate`，要么在消息里说「你自己做」。

---

## 配置

### 模型与提供商（推荐在页面里配）

「小组」页的**成员卡**上直接选：

```
[成员名]  [提供商 ▾]  [删]
          [模型 ▾]
          [职位 ▾]
```

- **提供商**：列出 DSH 里已配置的全部 provider（`relay-*` / `local` / `deepseek-official`…）
- **模型**：随提供商变化
- **框架自动推断**：选完 provider/model，插件自己决定跑哪条 CLI（规则见 [FEATURES.md](./FEATURES.md) 第五节）

**指挥也能这么配** —— 不用改配置文件。想让 `astra` 当指挥，把它加进某个 provider 的模型列表，然后在指挥卡上选它即可。

### 或改 profile

```yaml
- insert:
    - id: council
      name: '@zelystaric/dsh-council'
      config:
        defaultWorkspace: /your/workspace      # 成员的工作目录
        strictDelegate: true                   # 小组模式白名单（默认 true，见下）
        memberIdleMinutes: 10                  # 成员连续多久没输出算死（默认 10 分钟）
        memberHardLimitMinutes: 360            # 极大兜底（默认 6 小时；0 = 不限制）
        imageTimeoutSeconds: 240               # 出图 HTTP 超时（默认 240s）
```

> 页面里的配置优先于 profile。
> 成员**没有总时长超时**：只要还在输出就一直跑，静默超过 `memberIdleMinutes` 才终止。

### 白名单：小组模式下父会话只能派活

提示词拦不住（实测有会话自己跑了 120 次 bash 却不派活），所以 Host 半在 `agent.ctx.tools.guard()` 上加了守卫。

**v0.5 起改成白名单**（早先是黑名单，用 `cat > file` 就能绕过去）：

- **只放行 `council_*`** —— 父会话手上没有能干活的工具，越权在结构上不可能；
- **`send_message` 也放行**（它只发消息，且被绑定的会话需要它向上汇报）；
- 任何非 `council_*` 调用都算一次越权尝试，计入回执末尾的 `## 越权拦截`；
- 两条逃生口：本轮最后一条用户消息里说「你自己做 / 你直接改 / 你亲自动手 / 放行」；
  或把 `strictDelegate` 设为 `false`。

### 官方 key 与中转站都能直接用

凭据都在 provider 里（页面成员卡选的 provider，或 `~/.dsh/profiles/web/cordis.patch.yml` 的 `providers` 段）。
**填官方 key 就是官方通道，填中转 key 就是中转通道**：

| 成员 kind | 走什么 | env |
|---|---|---|
| `claude` | Claude Code CLI | `ANTHROPIC_BASE_URL`（**不能带 `/v1`**） + `ANTHROPIC_API_KEY` |
| `codex` | Codex CLI | `CODEX_HOME`（插件自己生成的独立目录，**不改你的 `~/.codex`**） |
| `gemini` | Gemini CLI | `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL` + `GEMINI_CLI_TRUST_WORKSPACE` |
| `deepseek` | DSH 内建 agent | 不需要 CLI env |
| `image` | OpenAI 兼容 `/v1/images/generations` | 走 provider 的 baseURL/key |

实现细节（排障时有用）：

- base 会被**归一成根地址**（自动去掉尾部 `/` 与 `/v1`），各调用点再拼 `/v1/models`、`/v1/images/generations`、`/v1/usage`；
- `codex` 用它自己生成的 `~/.dsh/storages/council-codex/config.toml`，不动你的 `~/.codex`；
- 没配 provider 时才回退到 `claudeBase` / `imageKey` / `codexToken` 这些旧字段。

### 用官方 key 需要代理时

在「小组」页的 API 卡片填本机代理（Clash 混合端口）：

```
http://127.0.0.1:7897
```

- 只影响**插件自己发起的请求**与 CLI 子进程的环境变量；
- **代理没起来时自动回退直连**并打日志；
- 用中转站时不需要填。

### 升级

`dsh plugin add` 不会覆盖已安装的同名依赖，换版本要先移除：

```bash
dsh plugin --profile web remove @zelystaric/dsh-council
dsh plugin --profile web add -w file:/path/to/dsh-council
systemctl --user restart dsh-web
```

## 成员框架

| kind | 跑什么 | 说明 |
|---|---|---|
| `codex` | Codex CLI（`codex exec`） | GPT 系，原生 app-server，工具链最全 |
| `claude` | Claude Code CLI | Anthropic 系，长上下文，能读图 |
| `deepseek` | DSH 内建 agent（subagent seam） | 用完即弃 + 摘要回灌；可复用同一条子会话 |
| `gemini` | Gemini CLI | Google 系 |
| `image` | 图像接口（OpenAI 兼容 `/v1/images/generations`） | 出图 |

### 审核位（指挥/审校）的「只读」是怎么做到的

四条腿各用各的机制，`noTools` 在它们上面语义不同：

| kind | 只读实现 | 保留了什么 |
|---|---|---|
| `claude` | `--disallowedTools Bash Edit Write WebFetch WebSearch Task NotebookEdit` | ✅ 保留 `Read`/`Grep`/`Glob` |
| `codex` | `--sandbox read-only` | ✅ 全盘只读 |
| `gemini` | `--approval-mode plan` | ✅ plan 模式只读 |
| `deepseek` | preset `council-readonly`（`read: true`，无 bash） | ✅ 能读文件，写不了 |

> 「可动手」时全部放开。

## 岗位（角色）

内置 8 个：指挥 / 代码 / 全栈 / 审校 / 画师 / 配乐 / 3D建模 / 动画。**都只是预设**——名字、提示词、成员、模型、风格都能改。

### 外部 CLI 的路径

默认从 `PATH` 找；找不到会直接报错。也可以显式指定：

```bash
export COUNCIL_CODEX_BIN=/usr/local/bin/codex
export COUNCIL_CLAUDE_BIN=/path/to/claude
```

`claude` 若装了 `dsh-subagent-claude-code` bundle，会自动用 bundle 自带的二进制。

## 自定义外观（头像、名字、气泡）

**头像**：默认是内置 SVG 占位图。换成自己的角色，把 **192×192 的 PNG** 放进：

```
~/.dsh/storages/council-images/
├── avatar-codex-small.png      # codex / GPT 成员
├── avatar-claude-small.png     # claude 成员
└── avatar-deepseek-small.png   # deepseek 成员
```

画师（`image`）默认复用 `avatar-codex-small.png`。文件不存在时**自动回退**到内置 SVG。

注意：头像**按框架**取，不是按成员——同框架所有成员共用一张图。

**名字与气泡**：成员名、岗位名、岗位提示词、组级统一风格都在「小组」页和「名册」浮层里改。
气泡里的框架标签（`claude · 模型名`）跟随成员的框架与模型自动变化。

**按钮文案 / 页面标题**：`locale/{zh,en}.json` 的 `meta.title`、`meta.description`。

## 兼容性

- 仅测试于 `dsh` **0.2.1-rc.2**（用到 subagent seam、`uiConversation` 等内部 API）；
- 中转站只要是 OpenAI 或 Anthropic 通用格式即可，不绑定具体厂商。

## 二次开发

- **Host 半** `index.js`：`createHandler()` 暴露全部 HTTP 路由；`runKind()` 是所有框架的分发点，加新框架只需加一个分支；
- **Client 半** `client.js`：`CouncilChatView`（团队页）/ `CouncilView`（编排页）/ `RosterPanel`（名册浮层）/ `ModeToggle`（模式胶囊）；
- **状态文件**：`~/.dsh/storages/council.json`（职位/成员/组/用量/摘要）；团队消息落 `~/.dsh/storages/council-team/`；出图落 `~/.dsh/storages/council-images/`；
- 改 Host 后需 `systemctl --user restart dsh-web`；只改 Client 刷新页面即可。

> ⚠️ **DSH 的 React 是桩实现**：`useState` 不触发重渲染、`ref` 不一定绑上、`onScroll` 不转发、
> `<select defaultValue>` 不生效……改 UI 前先看 [`AGENTS.md`](./AGENTS.md) 里那张坑表。

## 许可

MIT。

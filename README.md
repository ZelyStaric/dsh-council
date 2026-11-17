# dsh-council — DeepSeek Harness「小组」插件

把**会话变成一支团队**：你说一句需求，指挥拆解 → 成员在各自的 agent 框架里并行干活 → 审核链把关 → 全过程在「团队」页实时可见，产出（图/音/视频/模型文件）可直接预览。

> **只想看它能干什么？** → [FEATURES.md](./FEATURES.md)（纯功能清单，12 个分类）
> **想了解实现与踩过的坑？** → [`~/docs/dsh-council-handoff.md`](/home/nanami/docs/dsh-council-handoff.md)

> 与官方子代理的区别：官方只回最终答案；本插件把每一步（谁、什么阶段、多久、最近一行输出）暴露出来，
> 并且**每个成员可以挂不同框架/模型**，各跑各的原生 agent（Codex CLI / Claude Code CLI / DSH 内建 agent / 图像接口 / 任意 OpenAI·Anthropic 兼容中转）。

> 仓库标签：`dsh` · `deepseek-harness` · `cordis` · `plugin` · `multi-agent` · `agent-orchestration` · `codex` · `claude` · `ai-agents`

## 安装

```bash
# 从 GitHub 克隆后安装（推荐）
git clone https://github.com/ZelyStaric/dsh-council
dsh plugin --profile web add -w file:/path/to/dsh-council
systemctl --user restart dsh-web
```

安装后在任意会话顶部胶囊点「**小组**」，进「小组」页配置成员。

## 上手三步

```
① 发一条消息，建立会话
② 点顶部胶囊「小组」→ 自动建组 + 默认成员（指挥 / 审校）
③ 直接说需求：会交给指挥拆解、派给成员
```

默认阵容只有 **指挥 / 审校**，都走 DSH 自带的 deepseek，**开箱可用、不需要额外 key**。
想要出图就在「小组」页「+ 添加成员」，把框架选成 `image`（需要 gpt-image key）。

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

## 外部依赖（可选，按岗位）

- `codex`、`claude`、`gemini` 三个 CLI（对应成员才需要）
- 配乐：`fluidsynth` + GM SoundFont + `ffmpeg` + `python3-midiutil`/`mido`
- 3D：`blender`（无头）、`openscad`、`python3 -m pip install trimesh pygltflib`
- 动画：`ffmpeg`、Pillow

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

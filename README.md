# dsh-council — DeepSeek Harness「小组」插件

把**会话变成群聊**：你说一句需求，指挥拆解 → 成员在各自的 agent 框架里并发干活 → 审校初审 → 指挥终审 → 不合格自动返工一次。所有过程在「群聊」页实时可见。

> 与官方子代理的区别：官方只回最终答案；本插件把每一步（谁、什么阶段、多久）暴露出来，并且**每个成员可以挂不同框架/模型**，各跑各的原生 agent（Codex CLI / Claude Code CLI / DSH 内建 agent / 图像接口 / 任意 OpenAI·Anthropic 兼容中转）。

> 仓库标签：`dsh` · `deepseek-harness` · `cordis` · `plugin` · `multi-agent` · `agent-orchestration` · `codex` · `claude` · `ai-agents`

## 安装

```bash
# 从 GitHub 克隆后安装（推荐）
git clone https://github.com/ZelyStaric/dsh-council
plugin_manager install_bundle --target ./dsh-council

# 或直接用目录路径
plugin_manager install_bundle --target /path/to/dsh-council

# 或 npm 安装（如已发布）
plugin_manager install_bundle --target @zelystaric/dsh-council
```

安装后在任意会话顶部点 `小组模式`，进「小组」页配置成员。

## 首次配置

1. **名册**：岗位 → 成员 → 每个成员选框架与模型；
2. **API**：在「小组」页填中转站地址与 key（同时支持两种通用格式）：

| 用途 | 协议 | 填在哪 |
|---|---|---|
| `codex` 成员（GPT 系） | OpenAI | ① 卡片的 gpt key（base 来自 `~/.codex`） |
| `image` 成员（出图） | OpenAI `/v1/images/generations` | ① 卡片的 gpt-image key |
| `claude` 成员（Anthropic 系） | Anthropic `/v1/messages` | ① 卡片的 claude key + claude base URL |

3. **首次使用的顺序**（全新安装时很重要）：

   ```
   ① 先发一条消息，建立一个会话
   ② 点顶部「小组模式」（Hero 草稿态点它会提示先建会话）
   ③ 进「小组」页填密钥、确认名册
   ④ 再派活
   ```

4. 也可以不填页面，改 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: council
      name: '@zelystaric/dsh-council'
      config:
        claudeBaseUrl: https://your-relay      # claude 成员用
        defaultWorkspace: /your/workspace      # 成员的工作目录
```

> 页面里的 base 留空 = 用 profile 里的；页面填了会覆盖它。

### 官方 key 与中转站都能直接用

三个框架的凭据都从插件配置里取（页面 ① 或 profile 的 `cordis.patch.yml`），**填官方 key 就是官方通道，填中转 key 就是中转通道**：

| 成员 | 填什么 | 官方 | 中转站 |
|---|---|---|---|
| `claude` | `claudeBase` + `claudeKey` | 地址 `https://api.anthropic.com`，模型如 `claude-sonnet-4-5` | 地址如 `https://your-relay` |
| `image` | `codexBase` + `imageKey` | 地址 `https://api.openai.com`，模型 `gpt-image-1` | 地址如 `https://your-relay`，模型按中转提供的写 |
| `codex` | `codexBase` + `codexToken`（或 codex 成员的 `~/.codex` 配置） | 地址 `https://api.openai.com`，`codexWireApi` 默认 `responses` | 地址如 `https://your-relay` |

实现细节（排障时有用）：

- base 会被**归一成根地址**（自动去掉尾部 `/` 与 `/v1`），各调用点再拼 `/v1/models`、`/v1/images/generations`、`/v1/usage`；
- `claude` 通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 传给 CLI，所以官方与中转走的是同一条路；
- `codex` 会用它自己生成的 `~/.dsh/storages/council-codex/config.toml`（内含 `model_providers.council` 与 bearer token），**不改你 `~/.codex` 里的配置**；没配 base/key 时才回退到你自己的 `~/.codex`。

### 用官方 key 需要代理时

只填官方 key、base 留空会自动走官方端点（`api.openai.com` / `api.anthropic.com`）。如果本机直连官方不通，在 ① 卡片最右的输入框填本机代理地址（Clash 混合端口）：

```
http://127.0.0.1:7897
```

- 只影响**插件自己发起的请求**（模型列表、出图、用量）以及 claude / codex CLI 子进程的环境变量；
- **代理没起来时会自动回退直连**并打日志，不会把整个插件拖死；
- 用中转站时不需要填（填了会多一跳）。

### 升级到新版本

`dsh plugin add` **不会覆盖已安装的同名依赖**，换 tarball / 目录升级时要先移除：

```bash
dsh plugin --profile web remove @zelystaric/dsh-council
dsh plugin --profile web add -w file:/path/to/zelystaric-dsh-council-0.2.4.tgz
systemctl --user restart dsh-web        # 或重启你起的 dsh web
```

从 npm 安装时同理：`remove` 之后 `add @zelystaric/dsh-council@<version>`。

## 成员框架

| kind | 跑什么 | 说明 |
|---|---|---|
| `codex` | Codex CLI（`codex exec`） | GPT 系，原生 app-server，工具链最全 |
| `claude` | Claude Code CLI | Anthropic 系，长上下文，能读图 |
| `deepseek` | DSH 内建 agent（subagent seam） | 用完即弃 + 摘要回灌；可复用同一条子会话 |
| `image` | 图像接口（OpenAI 兼容 `/v1/images/generations`） | 出图、序列帧 |

## 岗位（角色）

内置 8 个：指挥 / 代码 / 全栈 / 审校 / 画师 / 配乐 / 3D建模 / 动画。**都只是预设**——岗位名、提示词、成员、模型、风格都可以自己改。指挥负责拆解与终审，审校负责初审，其余按任务分派。

## 外部依赖（可选，按岗位）

- `codex`、`claude` 两个 CLI（对应成员才需要）
- 配乐：`fluidsynth` + GM SoundFont + `ffmpeg` + `python3-midiutil`/`mido`
- 3D：`blender`（无头）、`openscad`、`python3 -m pip install trimesh pygltflib`
- 动画：`ffmpeg`、Pillow


## 自定义外观（头像、名字、气泡）

**头像**：默认是内置的三张 SVG 占位图。想换成自己的角色，只要把 **192×192 的 PNG** 放进

```
~/.dsh/storages/council-images/
├── avatar-codex-small.png      # codex / GPT 成员
├── avatar-claude-small.png     # claude 成员
└── avatar-deepseek-small.png   # deepseek 成员
```

画师（`image`）默认复用 `avatar-codex-small.png`。文件不存在时**自动回退**到内置 SVG，
所以想换哪个换哪个、删掉也安全。文件名不对或不想要这套命名，改 `client.js` 里的 `AVATAR_FILE` 映射即可：

```js
const AVATAR_FILE = {
  codex: 'avatar-codex-small.png',
  claude: 'avatar-claude-small.png',
  deepseek: 'avatar-deepseek-small.png',
  image: 'avatar-codex-small.png',
}
// 也可以指向任意经 /council/api/image/ 提供的文件名
```

注意：头像是**按框架**取的，不是按成员——同一个框架的所有成员共用一张图
（比如 claude 既当指挥又当审校，仍是同一张）。想让不同成员不同图，需要在 `Avatar` 组件里
改成按 `member.id` 映射（当前不做，避免状态里存图片路径）。
没配的框架继续用内置 SVG 占位。

**名字与气泡**：成员名、岗位名、岗位提示词、组级统一风格都在「小组」页和「名册」浮层里改，
不涉及代码。气泡里的框架标签（`claude · 模型名`）跟随成员选择的框架与模型自动变化。

**按钮文案 / 页面标题**：`locale/{zh,en}.json` 的 `meta.title`、`meta.description` 改了就生效（刷新页面）。

### 外部 CLI 的路径

`codex` 与 `claude` 默认从 `PATH` 找；找不到时会直接报

```
未找到 codex CLI（codex）。安装 Codex，或用环境变量 COUNCIL_CODEX_BIN 指定绝对路径。
```

也可以显式指定：

```bash
export COUNCIL_CODEX_BIN=/usr/local/bin/codex
export COUNCIL_CLAUDE_BIN=/path/to/claude
```

`claude` 若装了 `dsh-subagent-claude-code` bundle，会自动用 bundle 自带的二进制。

## 兼容性

- 仅测试于 `dsh` **0.2.1-rc.2**（用到 subagent seam、`uiConversation` 等内部 API）；
- 中转站只要是 OpenAI 或 Anthropic 通用格式即可，不绑定具体厂商。

## 二次开发

- Host 半 `index.js`：`createHandler()` 暴露全部 HTTP 路由；`runKind()` 是所有框架的分发点，加新框架只需加一个分支；
- Client 半 `client.js`：`CouncilChatView`（群聊页）/`CouncilView`（编排页）/`RosterPanel`（名册浮层）/`CouncilProgress`（进度条）；
- 状态文件：`~/.dsh/storages/council.json`（职位/成员/组/用量/摘要）；出图落在 `~/.dsh/storages/council-images/`；
- 修改 Host 后需 `systemctl --user restart dsh-web`；只改 Client 刷新页面即可。

## 许可

MIT。头像为内置占位图；如需自定义，替换 `client.js` 里的 `AVATAR_FILE` 映射即可。

# dsh-council — DeepSeek Harness「小组」插件

把**会话变成群聊**：你说一句需求，指挥拆解 → 成员在各自的 agent 框架里并发干活 → 审校初审 → 指挥终审 → 不合格自动返工一次。所有过程在「群聊」页实时可见。

> 与官方子代理的区别：官方只回最终答案；本插件把每一步（谁、什么阶段、多久）暴露出来，并且**每个成员可以挂不同框架/模型**，各跑各的原生 agent（Codex CLI / Claude Code CLI / DSH 内建 agent / 图像接口 / 任意 OpenAI·Anthropic 兼容中转）。

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

3. 也可以不填页面，改 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: council
      name: '@zelystaric/dsh-council'
      config:
        claudeBaseUrl: https://your-relay      # claude 成员用
        defaultWorkspace: /your/workspace      # 成员的工作目录
```

> 页面里的 base 留空 = 用 profile 里的；页面填了会覆盖它。

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

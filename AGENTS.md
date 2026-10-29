# AGENTS.md — `~/LLM/dsh-council`

DSH Web 插件「小组」的实现目录（bundle `@zelystaric/dsh-council`）。
**这里只放操作要点与指针**；设计、数据模型、源码结构在专题文档里。

## 指针（先读这些，别在代码里猜）

- 插件全貌（架构 / 路由 / 数据模型 / 已知问题）→ [`~/docs/dsh-council.md`](/home/nanami/docs/dsh-council.md)
- 配乐 / 3D 产线的本机环境（fluidsynth、Blender、trimesh、music-ear 复核）→ [`~/docs/dsh-council-media.md`](/home/nanami/docs/dsh-council-media.md)
- 机器级铁律与环境（SSH、systemd、代理、Node）→ [`~/AGENTS.md`](/home/nanami/AGENTS.md)

## 本插件当前形态（2026-10-28）

- 会话即群聊：`council_delegate` 由「指挥」拆解 → 成员并发干活 → 「审校」初审 → 指挥终审 → 不合格自动返工一次。
- 视图：`对话`（原生）/`群聊`（成员发言时间线，每 1.5s 刷新）/`小组`（编排：成员、职位、风格、API、用量）。
- 输入框上方有实时进度条（谁在哪个阶段、多少秒）；回合末尾有群聊回执块。
- 职位 8 个：指挥 / 代码 / 全栈 / 审校 / 画师 / 配乐 / 3D建模 / 动画（都只是预设，可自由改名/改提示词）。
- 头像：用户提供的三张立绘（claude=橘发大小姐、deepseek=蓝鲸女仆、codex/gpt+画师=白发龙娘），
  192×192 裁切版放在 `~/.dsh/storages/council-images/avatar-*-small.png`，经 `/council/api/image/…` 提供。

## 改代码的两条铁律

1. **Host 半（`index.js` / `cordis.patch.yml`）改了必须重启**：`systemctl --user restart dsh-web`
   （重启会打断当前会话的 turn）。Client 半（`client.js`）只需刷新页面。
2. **Client 半改完必须跑渲染冒烟**（离线假 React，抓未定义标识符/括号错这类硬 bug）：
   ```bash
   cd ~/LLM/dsh-council
   node --check index.js && node --check client.js
   node tests/render-smoke.mjs            # 无参时从服务端取 /state；也可传一份 state.json 当夹具
   ```
   ⚠️ 曾经因为漏跑冒烟把整个客户端插件搞崩过一次（`ReferenceError` / 括号不匹配），别再犯。


## 包名变更 checklist（改一次踩过两次坑，必须四处同步）

包名出现在 **4 个地方**，漏一处就会出现「插件消失 / 按钮不见 / bundle 被跳过」：

| # | 位置 | 症状（漏改时） |
|---|---|---|
| 1 | `package.json` 的 `name` | 打包名与运行时不一致 |
| 2 | `cordis.patch.yml` 的 `name` | `dsh: skipping profile bundle ... cannot resolve` → 宿主半不挂载，`/state` 404 |
| 3 | profile 的三处：`dependencies`、`dsh.profile.bundles`、`node_modules/<scope>/<name>` 符号链接 | 同上（宿主半 404） |
| 4 | **`client.js` 首行 `__ModuleLoader__.load({ id })`** | 宿主正常但**客户端不加载**：单人/小组胶囊、群聊/小组 tab、进度条、名册浮层全部消失 |

改完必须：

```bash
node --check index.js && node --check client.js
node tests/render-smoke.mjs          # 客户端组件树
systemctl --user restart dsh-web     # Host 改动
curl -s $B/state                     # 必须 200
journalctl --user -u dsh-web --since '-2min' | grep -c "skipping profile bundle"   # 必须 0
```

再刷新页面确认胶囊与 tab 存在（客户端 id 是否对上，只能靠肉眼）。

改 profile 前先备份：`cp ~/.dsh/profiles/web/package.json ~/.dsh/profiles/web/package.json.bak-$(date +%H%M%S)`。

## 常用自检

```bash
B=http://100.108.3.88:3080/council/api
curl -s $B/state   | head -c 200     # 职位/成员/组/用量
curl -s $B/progress                  # 实时阶段（排障"是不是卡住"先看这个）
curl -s $B/usage   | head -c 200     # 各 key 用量/余额
systemctl --user status dsh-web      # 服务状态
```

## 已知边界（别重复踩）

- 成员发言**无法**变成真正的 chat 消息：会话日志插件只读，且 `conversation.chat.node` 的 key 域是编译期固定的，
  自定义 kind 注册后 `active:false`（实测）。当前用"群聊视图 + 回合末尾块"替代，见 `docs/dsh-council.md`。
- 外部腿（codex/claude/image）只回最终答案，拿不到 token 流；"实时"= 每个成员一结束就立刻追加。
- 审校必须跑在无工具 preset（deepseek → `minimal` + `reasoningEffort: low`；claude → `--disallowedTools`），
  否则它会去 `ls`/`find` 翻文件系统，一次审校磨掉两分钟。
- 出图渲染链路若没做 `loudnorm`（配乐）或没给 `-g`（fluidsynth），music-ear 会判"疑似静音"。

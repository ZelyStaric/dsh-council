window.__ModuleLoader__.load({
  id: '@zelystaric/dsh-council',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/council/api'
    /**
     * 子会话清理路由（内层路径，`call()` 会自动加上 `/council/api`）：
     * 实际请求 = `POST /council/api/sessions/prune`。
     * 必须与 Host 半 `index.js` 的 `SESSIONS_PRUNE_ROUTE` 逐字相同，
     * `tests/staffing-test.mjs` 会解析两半源码断言一致，防「前后端路由漂移」。
     */
    const SESSIONS_PRUNE_PATH = '/sessions/prune'

    /**
     * 归档组清理路由（内层路径，`call()` 会自动加上 `/council/api`）：
     * 实际请求 = `POST /council/api/groups/prune-archived`。
     * 必须与 Host 半 `index.js` 的 `ARCHIVED_PRUNE_ROUTE` 逐字相同，
     * `tests/staffing-test.mjs` 会解析两半源码断言一致，防「前后端路由漂移」。
     */
    const ARCHIVED_PRUNE_PATH = '/groups/prune-archived'
    /** 与 Host 半 `ARCHIVED_KEEP_DAYS` 一致：只清理归档超过 7 天的小组。 */
    const ARCHIVED_KEEP_DAYS = 7

    /**
     * 子智能体目录清理路由（内层路径）：实际请求 = `POST /council/api/sessions/prune-children`。
     * 与 Host 半 `index.js` 的 `PRUNE_CHILDREN_ROUTE` 逐字相同（测试会断言两半一致）。
     * 只删「本会话名下、已结束、没在跑、也不属于任何成员会话」的子会话目录。
     */
    const SESSIONS_PRUNE_CHILDREN_PATH = '/sessions/prune-children'

    /** Both halves live in this module, so a tiny listener set keeps them in sync. */
    const councilListeners = new Set()
    function notifyCouncilChange() {
      for (const listener of councilListeners) { try { listener() } catch { /* ignore */ } }
    }

    async function call(path, body) {
      const response = await fetch(API + path, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? ('HTTP ' + response.status))
      return data
    }


    /** Give a brand-new group a working default roster (editable in the 小组 page). */
    async function provisionDefaultRoster(groupId) {
      // 默认阵容统一用 deepseek（2026-11-17 用户要求）：
      // 这个插件要对外分发，别人不一定有 claude / gpt-image 的 key，
      // 而 deepseek 是 DSH 自带的，开箱可用。
      // 出图成员（画师）默认**不建**——它必须要 gpt-image key，等用户自己加。
      const presets = [
        { role: '指挥', kind: 'deepseek', model: 'deepseek-v4.1-flash' },
        { role: '审校', kind: 'deepseek', model: 'deepseek-v4.1-flash' },
      ]
      let snapshot = (await call('/state')).state
      const group = (snapshot.groups || []).find((g) => g.id === groupId)
      if (!group || (group.memberIds || []).length > 0) return snapshot
      for (const preset of presets) {
        let role = (snapshot.roles || []).find((r) => r.name === preset.role)
        if (!role) {
          const created = await call('/roles', { name: preset.role, prompt: '' })
          snapshot = created.state
          role = (snapshot.roles || []).find((r) => r.name === preset.role)
        }
        const member = await call('/members', {
          name: preset.role, kind: preset.kind, model: preset.model,
          roleId: role ? role.id : undefined, groupId: groupId,
        })
        snapshot = member.state
      }
      return snapshot
    }


    /* 名册浮层：Hero / 头部胶囊都能打开，空白会话也能改名册 */
    /* 群聊「回到最新」总线：输入框旁的按钮 → 群聊视图滚动 */
    const jumpListeners = new Set()
    /* 对话行里的群聊块默认展开，折叠状态按会话+轮次记住 */
    const tailCollapsedMap = {}
    /* 从 /models 拿到的实时模型列表（换 key / 换中转后要刷新） */
    const liveModels = {}
    /* 把一份目录灌进 liveModels，返回总条数（成功提示用） */
    function absorbModels(data) {
      let total = 0
      for (const kind of ['codex', 'claude', 'deepseek', 'image']) {
        if (Array.isArray(data && data[kind]) && data[kind].length) liveModels[kind] = data[kind]
        total += Array.isArray(liveModels[kind]) ? liveModels[kind].length : 0
      }
      return total
    }
    async function refreshModels() {
      try {
        const data = await call('/models?refresh=1')
        absorbModels(data)
      } catch { /* 保留旧值 */ }
    }
    /* 已存的成员/职位模型是否还在新列表里（只提示，不自动改） */
    function staleModelNames(snapshot, catalog) {
      if (!snapshot || !catalog) return []
      const known = (kind) => (Array.isArray(catalog[kind]) ? catalog[kind] : FALLBACK_MODELS[kind] || [])
      const names = []
      for (const member of snapshot.members || []) {
        const list = known(member.kind)
        if (member.model && list.length && list.indexOf(member.model) < 0) names.push(member.name + ' ' + member.model)
      }
      for (const role of snapshot.roles || []) {
        const list = known(role.kind)
        if (role.model && list.length && list.indexOf(role.model) < 0) names.push(role.name + ' ' + role.model)
      }
      return names
    }
    const chatActive = { value: false }
    const chatActiveListeners = new Set()
    function setChatActive(next) {
      if (chatActive.value === next) return
      chatActive.value = next
      for (const fn of chatActiveListeners) { try { fn() } catch { /* ignore */ } }
    }
    function requestLatestJump() {
      let handled = false
      for (const fn of jumpListeners) { try { fn(); handled = true } catch { /* ignore */ } }
      if (handled) return
      // fallback: no live listener (view remounted elsewhere) → scroll the marked list directly
      try {
        const node = document.querySelector('[data-council-scroller]')
        if (node) node.scrollTop = node.scrollHeight
      } catch { /* ignore */ }
    }

    const panelState = { open: false, sessionId: null }
    const panelListeners = new Set()
    function notifyPanel() { for (const fn of panelListeners) { try { fn() } catch { /* ignore */ } } }
    function openRosterPanel(sessionId) { panelState.open = true; panelState.sessionId = sessionId || null; notifyPanel() }
    function closeRosterPanel() { panelState.open = false; notifyPanel() }

    const ROLE_PRESETS = [
      { name: '指挥', prompt: '你是本组的指挥：把需求拆成自包含任务，按成员能力分派，验收回执；不亲自写实现，只做拆解、分派与把关。' },
      { name: '代码', prompt: '负责实现与调试：写最小可用代码、跑测试、报告改动与风险；不确定的地方先说明假设。' },
      { name: '全栈', prompt: '端到端负责一个功能：从数据层到界面都要跑通，并给出可复现的验证步骤。' },
      { name: '审校', prompt: '负责审查：对照任务要求与风格规范挑问题，指出具体位置与改法；判定只回 JSON。' },
      { name: '画师', prompt: '负责出图：只描述画面（主体/构图/氛围），严格遵守统一风格规范，不写与画面无关的内容。' },
    ]

    const FALLBACK_MODELS = {
      codex: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'codex-auto-review'],
      claude: ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-fable-5'],
      deepseek: ['deepseek-v4.1-flash'],
      image: ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'],
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', fontSize: 13 },
      bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      roles: { width: 280, flexShrink: 0, overflow: 'auto', padding: 12, borderRight: '1px solid var(--dsw-alias-border-l1)' },
      board: { flex: 1, overflow: 'auto', padding: 12, minWidth: 0 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: 10, marginBottom: 8 },
      input: { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6 },
      button: { fontSize: 12, padding: '5px 10px', cursor: 'pointer', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)' },
      primary: { fontSize: 12, padding: '5px 10px', cursor: 'pointer', borderRadius: 6, fontWeight: 600, color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-brand-primary)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      /** 淡色小字按钮：工具栏里「清理 7 天前归档」用，视觉上不抢主按钮。 */
      linkButton: { fontSize: 11, padding: '1px 2px', cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', opacity: 0.7, textDecoration: 'underline' },
      roleRow: { border: '1px dashed var(--dsw-alias-border-l1)', borderRadius: 8, padding: 10, marginBottom: 10, minHeight: 56 },
      dropActive: { borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 999, fontSize: 11, marginRight: 6, marginBottom: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)' },
      err: { color: 'var(--dsw-alias-state-error-primary)' },
      thread: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-base)', margin: '0 8px 8px', display: 'flex', flexDirection: 'column', minHeight: 0 },
      threadHead: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      scroll: { overflow: 'auto', padding: '10px', maxHeight: '42vh', display: 'flex', flexDirection: 'column', gap: 8 },
      bubble: { maxWidth: '82%', borderRadius: 10, padding: '7px 10px', lineHeight: 1.5, whiteSpace: 'pre-wrap', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' },
      mine: { alignSelf: 'flex-end', background: 'var(--dsw-alias-bg-layer-2)' },
      who: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 },
      composer: { display: 'flex', gap: 8, alignItems: 'flex-end', padding: '8px 10px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
    }

    /**
     * 进度条成员条目的「静默」提示：服务端 /progress 每个成员条目带 `silentMs`
     * （now - 最后一次活动）。超过 3 分钟才显示，免得正常思考的几秒也在闪。
     * 已有 `finishedAt`（终态）的成员一律不显示：它不在等，只是记录还在。
     */
    function silenceSuffix(member) {
      if (member && member.finishedAt) return ''
      const silentMs = Number(member && member.silentMs)
      if (!Number.isFinite(silentMs) || silentMs <= 180_000) return ''
      return ' · 静默 ' + Math.round(silentMs / 1000) + 's'
    }

    function Button(props) {
      const style = props.primary ? styles.primary : styles.button
      const dimmed = props.disabled ? Object.assign({}, style, { opacity: 0.55, cursor: 'default' }) : style
      return h('button', { onClick: props.onClick, disabled: props.disabled, style: dimmed }, props.children)
    }

    const statusLabel = { pending: '排队中', running: '正在说…', done: '已回执', failed: '失败' }

    /** The group owned by one session (1:1 binding). */
    function groupForSession(state, sessionId) {
      if (!state || !sessionId) return null
      return (state.groups || []).find((g) => g.sessionId === sessionId && !g.archived) || null
    }

    function groupMembers(state, group) {
      if (!state || !group) return []
      return (state.members || []).filter((m) => group.memberIds.indexOf(m.id) >= 0)
    }

    /* 小组：只负责编排（职位 / 成员 / 风格 / 指挥 / 用量） */
    /** 各「运行框架」对应的实际执行引擎，用于把下拉写清楚 */
    const RUNNER_LABEL = {
      claude: 'Claude Code',
      codex: 'Codex CLI',
      deepseek: 'DSH 会话',
      gemini: 'Gemini CLI',
      image: '出图 API',
    }

    function CouncilView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [apiConfig, setApiConfig] = useState(null)
      const [providers, setProviders] = useState(null)
      const [providersNote, setProvidersNote] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [balance, setBalance] = useState(null)
      const [keyUsage, setKeyUsage] = useState(null)
      const [models, setModels] = useState(null)
      const [modelNote, setModelNote] = useState(null)
      const [dragId, setDragId] = useState(null)
      const [dropRole, setDropRole] = useState(null)
      const [editing, setEditing] = useState(null)
      const [prunePreview, setPrunePreview] = useState(null)
      const [pruneNote, setPruneNote] = useState(null)
      const [sessionPrune, setSessionPrune] = useState(null)
      const [sessionPruneNote, setSessionPruneNote] = useState(null)
      const [archivedPrune, setArchivedPrune] = useState(null)
      const [archivedPruneNote, setArchivedPruneNote] = useState(null)
      const [childrenPrune, setChildrenPrune] = useState(null)
      const [childrenPruneNote, setChildrenPruneNote] = useState(null)
      // 模型定位表编辑器（v0.4 P3）：注入给指挥，帮它自动建成员时选模型
      const [guideEditing, setGuideEditing] = useState(false)
      const [guideDraft, setGuideDraft] = useState('')

      const applyData = useCallback((data) => {
        if (data && data.state) setState(data.state)
        // 同步「哪些会话有小组」给团队视图用（模块级，切换会话时能立刻判断要不要渲染）
        refreshGroupSessionSet(data && data.state)
      }, [])

      useEffect(() => {
        call('/state').then(applyData).catch((e) => setError(String(e.message || e)))
        call('/balance').then(setBalance).catch(() => setBalance(null))
        call('/usage').then(setKeyUsage).catch(() => setKeyUsage(null))
        call('/models').then(setModels).catch(() => setModels(null))
        call('/config').then((data) => setApiConfig(data.config)).catch(() => setApiConfig(null))
        call('/providers').then((data) => setProviders(data.providers || [])).catch(() => setProviders(null))
        call('/groups/prune', {}).then(applyData).catch(() => {})
      }, [applyData])

      // 组列表 / 组选择只认未归档的组（归档组由 Host half 按 workspace.json 的 archivedSessionIds 打标）
      const groupList = (state && state.groups ? state.groups : []).filter((g) => !g.archived)
      const archivedGroupCount = state && state.groups ? state.groups.filter((g) => g.archived).length : 0
      const group = groupForSession(state, sessionId) || null
      const members = groupMembers(state, group)
      const roles = state ? (state.roles || []) : []
      const usageRows = state ? Object.entries(state.usage || {}) : []

      async function refresh() {
        setError(null)
        try {
          const data = await call('/state')
          applyData(data)
          call('/balance').then(setBalance).catch(() => {})
          call('/usage').then(setKeyUsage).catch(() => {})
          call('/models').then(setModels).catch(() => {})
        } catch (e) { setError(String(e.message || e)) }
      }

      /* 一键重拉模型目录：更新 models + liveModels，两秒后按钮文字复原 */
      async function refreshCatalog() {
        setBusy('models'); setModelNote(null)
        try {
          const data = await call('/models/refresh', { source: 'all' })
          const next = data && data.catalog ? data.catalog : null
          if (!next) throw new Error('返回里没有 catalog')
          setModels(next)
          const total = absorbModels(next)
          const stale = staleModelNames(state, next)
          setModelNote({ ok: true, text: `已刷新（总计 ${total} 个）`, stale })
          const errors = (data && data.errors) || {}
          const failed = Object.keys(errors)
          if (failed.length) setError('模型刷新有失败项：' + failed.map((kind) => kind + ' ' + errors[kind]).join('；'))
          try {
            const fresh = await call('/state')
            applyData(fresh)
            const again = staleModelNames(fresh.state, next)
            setModelNote({ ok: true, text: `已刷新（总计 ${total} 个）`, stale: again })
          } catch { /* 旧 state 的提示也够用 */ }
          setTimeout(() => setModelNote((note) => (note && note.ok ? Object.assign({}, note, { text: null }) : note)), 2000)
        } catch (e) {
          setModelNote({ ok: false, text: '刷新失败：' + String(e.message || e), stale: [] })
        } finally {
          setBusy(null)
        }
      }

      async function loadRolePresets() {
        setBusy('presets'); setError(null)
        try {
          let latest = state
          for (const preset of ROLE_PRESETS) {
            if ((latest.roles || []).some((role) => role.name === preset.name)) continue
            const data = await call('/roles', { name: preset.name, prompt: preset.prompt })
            latest = data.state
          }
          applyData({ state: latest })
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) }
        finally { setBusy(null) }
      }

      async function enableMode() {
        if (!sessionId) return
        setBusy('enable'); setError(null)
        try {
          const created = await call('/groups', { name: '本会话小组' })
          const next = created.state.groups[created.state.groups.length - 1]
          await call('/groups/bind', { id: next.id, sessionId: sessionId })
          const provisioned = await provisionDefaultRoster(next.id)
          applyData({ state: provisioned })
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) }
        finally { setBusy(null) }
      }

      async function mutate(path, body) {
        setBusy(path); setError(null)
        try { const data = await call(path, body); applyData(data); notifyCouncilChange(); return data }
        catch (e) { setError(String(e.message || e)); return null }
        finally { setBusy(null) }
      }

      /** 两次点击：第一次 dryRun 预览「可清理 N 个」，第二次才真删。 */
      async function pruneOrphans() {
        const preview = prunePreview && (prunePreview.removed || []).length
        const dryRun = !preview
        setBusy('prune'); setError(null)
        try {
          const data = await call('/members/prune', { dryRun: dryRun })
          const names = (data.removed || []).map((m) => m.name)
          const shown = names.slice(0, 6).join('、') + (names.length > 6 ? ' 等' : '')
          if (dryRun) {
            setPrunePreview(data)
            setPruneNote(names.length ? ('可清理 ' + names.length + ' 个：' + shown) : '没有可清理的孤立成员')
          } else {
            setPrunePreview(null)
            setPruneNote('已清理 ' + names.length + ' 个' + (names.length ? '：' + shown : '') + '，剩余成员 ' + (data.kept ?? 0) + ' 个')
            await refresh()
            notifyCouncilChange()
          }
        } catch (e) { setError(String(e.message || e)); setPrunePreview(null) }
        finally { setBusy(null) }
      }

      /**
       * 子会话目录清理（⚠ 手动可达，UI 不暴露）：
       * 路由 `POST /council/api/sessions/prune` 保留（可 curl 手动调用做只读 dryRun），
       * 但工具栏里**不再有入口** —— 2026-11-02 需求：只清理「归档超过 7 天」的小组，
       * 不再给用户「删会话目录」的按钮。函数留着是为了保留 dryRun 自测路径，别接回 UI。
       */
      async function pruneChildSessions() {
        const preview = sessionPrune && (sessionPrune.removed || []).length
        const dryRun = !preview
        setBusy('sessions'); setError(null)
        try {
          const data = await call(SESSIONS_PRUNE_PATH, { dryRun: dryRun, keepDays: 7 })
          const count = (data.removed || []).length
          const mb = Math.round(((data.removed || []).reduce((sum, item) => sum + (Number(item.sizeMb) || 0), 0)) * 10) / 10
          if (dryRun) {
            setSessionPrune(data)
            setSessionPruneNote(count ? ('可清理 ' + count + ' 个 / ' + mb + ' MB') : '没有可清理的子会话')
          } else {
            setSessionPrune(null)
            setSessionPruneNote('已清理 ' + count + ' 个 / ' + mb + ' MB，保留 ' + (data.kept ?? 0) + ' 个')
          }
        } catch (e) { setError(String(e.message || e)); setSessionPrune(null) }
        finally { setBusy(null) }
      }

      /** 归档组清理：两段式（第一下 dryRun 只报「可清理 M 个组」，再点才真删；只动小组，不碰会话目录）。 */
      async function pruneArchivedGroups() {
        const preview = archivedPrune && (archivedPrune.removed || []).length
        const dryRun = !preview
        setBusy('archived'); setError(null)
        try {
          const data = await call(ARCHIVED_PRUNE_PATH, { dryRun: dryRun, keepDays: ARCHIVED_KEEP_DAYS })
          const count = (data.removed || []).length
          if (dryRun) {
            setArchivedPrune(data)
            setArchivedPruneNote(count ? ('可清理 ' + count + ' 个组') : '没有可清理的归档组')
          } else {
            setArchivedPrune(null)
            setArchivedPruneNote('已清理 ' + count + ' 个组，保留 ' + (data.kept ?? 0) + ' 个')
            await refresh()
          }
        } catch (e) { setError(String(e.message || e)); setArchivedPrune(null) }
        finally { setBusy(null) }
      }

      /**
       * 清理本会话的子智能体目录（两次点击：先预览，再确认删除）。
       * 路由已排除「驻留 / 正在跑 / 成员会话」的目录，这里只做展示。
       */
      async function pruneChildAgents() {
        const sessionId = (group && group.sessionId) || null
        if (!sessionId) { setError('当前小组没有绑定会话，无法清理子智能体'); return }
        const preview = childrenPrune && (childrenPrune.removed || []).length
        const dryRun = !preview
        setBusy('children'); setError(null)
        try {
          const data = await call(SESSIONS_PRUNE_CHILDREN_PATH, { sessionId: sessionId, dryRun: dryRun })
          const count = (data.removed || []).length
          if (dryRun) {
            setChildrenPrune(data)
            setChildrenPruneNote(count ? ('可清理 ' + count + ' 个子智能体') : '没有可清理的子智能体')
          } else {
            setChildrenPrune(null)
            setChildrenPruneNote('已清理 ' + count + ' 个，保留 ' + (data.kept ?? 0) + ' 个')
            await refresh()
          }
        } catch (e) { setError(String(e.message || e)); setChildrenPrune(null) }
        finally { setBusy(null) }
      }

      function drop(roleId) {
        setDropRole(null)
        const id = dragId
        setDragId(null)
        if (id) mutate('/members/role', { id: id, roleId: roleId || null })
      }

      function modelOptions(kind) {
        const live = models && models[kind] && models[kind].length ? models[kind] : null
        return live || FALLBACK_MODELS[kind] || []
      }

      function modelSelect(value, kind, onChange, explicitList) {
        const list = explicitList && explicitList.length ? explicitList : modelOptions(kind)
        const options = value && list.indexOf(value) < 0 ? [value].concat(list) : list
        return h('select', {
          style: Object.assign({}, styles.input, { flex: 1 }), defaultValue: value || options[0] || '',
          onChange: (event) => onChange(event.target.value),
        }, options.map((id) => h('option', { key: id, value: id }, id)))
      }

      function memberChip(member) {
        return h('span', {
          key: member.id, style: styles.chip, draggable: true,
          onDragStart: () => setDragId(member.id), onDragEnd: () => setDragId(null),
        }, member.name, h('span', { style: styles.muted }, member.kind))
      }

      function roleCard(role) {
        const assigned = members.filter((m) => m.roleId === role.id)
        const nameRow = editing === role.id
          ? h('input', {
            style: styles.input, defaultValue: role.name, autoFocus: true,
            onBlur: (event) => { mutate('/roles', { id: role.id, name: event.target.value }); setEditing(null) },
            onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
          })
          : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h('strong', { onDoubleClick: () => setEditing(role.id), title: '双击改名' }, role.name),
            h('span', {
              onClick: () => setEditing(role.id), title: '重命名职位',
              style: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
            }, '✎'))
        return h('div', {
          key: role.id,
          style: Object.assign({}, styles.roleRow, dropRole === role.id ? styles.dropActive : null),
          onDragOver: (event) => { event.preventDefault(); setDropRole(role.id) },
          onDragLeave: () => setDropRole((current) => (current === role.id ? null : current)),
          onDrop: (event) => { event.preventDefault(); drop(role.id) },
        },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          nameRow,
          h('span', { style: { flex: 1 } }),
          h(Button, { onClick: () => mutate('/roles/delete', { id: role.id }) }, '删')),
        // 这行说明已上移到职位区标题下方（每个职位都重复一遍太吵，2026-11-16 用户指出）
        h('textarea', {
          style: Object.assign({}, styles.input, { marginTop: 6, minHeight: 54, resize: 'vertical' }),
          defaultValue: role.prompt, placeholder: '职位提示词（派活时注入）',
          onBlur: (event) => { if (event.target.value !== role.prompt) mutate('/roles', { id: role.id, prompt: event.target.value }) },
        }),
        h('div', { style: { marginTop: 6 } }, assigned.map(memberChip)))
      }

      function memberCard(member) {
        const role = roles.find((r) => r.id === member.roleId)
        // 提供商下拉：来自 DSH 设置里的 provider（截图那种列表）+ 「出图（image）」
        const inferKind = (providerId) => {
          // 2026-11-17：**先按 provider id 判**，再看它下面的模型列表。
          // 起因：像 astra 这种模型名没有前缀约定，光看模型列表会落到兜底 codex，
          // 于是「挂在 relay-claude 下却跑 Codex CLI」——腿跑错了还不报错。
          // 语义应该是「模型跟着厂商走 CLI」：provider 是 Anthropic 协议 → claude，等等。
          const id = String(providerId || '').toLowerCase()
          if (/claude|anthropic/.test(id)) return 'claude'
          if (/deepseek/.test(id)) return 'deepseek'
          if (/gemini|google/.test(id)) return 'gemini'
          if (/image/.test(id)) return 'image'
          if (/gpt|openai|codex/.test(id)) return 'codex'
          // provider 名字也认不出 → 退回看它的模型列表
          const p = (providers || []).find((x) => x.id === providerId)
          const models = (p && p.models) || []
          if (models.some((m) => /^claude/i.test(m))) return 'claude'
          // 出图 provider（relay-image 之类）整体模型都是 gpt-image-* —— 必须在 gpt- 之前判
          if (models.some((m) => /^gpt-image/i.test(m))) return 'image'
          if (models.some((m) => /^gpt-|^o\d/i.test(m))) return 'codex'
          if (models.some((m) => /deepseek/i.test(m))) return 'deepseek'
          // 其它 OpenAI 兼容提供商（如本地 vLLM）走 codex 腿
          return 'codex'
        }
        // image 成员同样用真实 provider：选了 relay-image 就是它，没选才是 sentinel
        // deepseek 成员没有 provider 时兜底到默认（存量成员可能是早先建的，provider 为空）
        const firstProvider = (providers || [])[0]
        const providerValue = member.provider
          || (member.kind === 'image' ? '__image__' : '')
          // deepseek 成员没 provider 时兜底到真实存在的第一个；没有列表就留空（由下面的死下拉提示）
          || (member.kind === 'deepseek' && firstProvider ? firstProvider.id : '')
        // CLI 成员（claude/codex/gemini）没有 provider 概念 → 整个下拉都不渲染（2026-11-16 用户要求）
        const isCliMember = member.kind === 'claude' || member.kind === 'codex' || member.kind === 'gemini'
        const providerSelect = isCliMember ? null : h('select', {
          style: Object.assign({}, styles.input, { width: 190 }), defaultValue: providerValue,
          onChange: (event) => {
            const value = event.target.value
            if (value === '__image__') {
              // 只切到「出图」但不绑定 provider：沿用页面里的 imageKey
              const list = modelOptions('image')
              const next = list.indexOf(member.model) >= 0 ? member.model : (list[0] || '')
              mutate('/members', { id: member.id, kind: 'image', provider: '', model: next })
              return
            }
            const kind = inferKind(value)
            const p = (providers || []).find((x) => x.id === value)
            const list = (p && p.models && p.models.length) ? p.models : modelOptions(kind)
            const next = list.indexOf(member.model) >= 0 ? member.model : (list[0] || '')
            // 出图 provider 也写真实 provider（出图走它的 baseURL/key），不再写 ''
            mutate('/members', { id: member.id, provider: value, kind: kind, model: next })
          },
        }, [
          h('option', { key: '__none__', value: '' }, '（未选择提供商）'),
          h('option', { key: '__image__', value: '__image__' }, 'image（出图）'),
        ].concat((providers || []).map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id))))
        const roleOptions = [h('option', { key: 'none', value: '' }, '未分配职位')].concat(
          roles.map((r) => h('option', { key: r.id, value: r.id }, r.name)))
        const roleSelect = h('select', {
          style: Object.assign({}, styles.input, { width: 170 }), defaultValue: member.roleId || '',
          onChange: (event) => mutate('/members/role', { id: member.id, roleId: event.target.value || null }),
        }, roleOptions)
        return h('div', {
          key: member.id, style: styles.card, draggable: true,
          onDragStart: () => setDragId(member.id), onDragEnd: () => setDragId(null),
        },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
            style: Object.assign({}, styles.input, { flex: 1 }), defaultValue: member.name,
            onBlur: (event) => { if (event.target.value !== member.name) mutate('/members', { id: member.id, name: event.target.value }) },
          }),
          providerSelect,
          h(Button, { onClick: () => mutate('/members/delete', { id: member.id }) }, '删')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          // 只有「真需要 provider 却还没选」的成员才显示这个死下拉；
          // CLI 成员（claude/codex/gemini）和出图成员都不需要，直接给模型下拉。
          (member.kind === 'deepseek' && !member.provider)
            ? h('select', {
              style: Object.assign({}, styles.input, { flex: 1 }), disabled: true,
            }, [h('option', { key: 'none', value: '' }, '先选择提供商')])
            : modelSelect(member.model, member.kind, (value) => mutate('/members', { id: member.id, model: value }),
              (() => {
                const p = (providers || []).find((x) => x.id === member.provider)
                if (p && p.models && p.models.length) return p.models
                // image 成员没绑 provider → 退回本地出图模型表
                return member.kind === 'image' ? modelOptions('image') : null
              })()),
          roleSelect),
        // MCP 不再在成员卡上手填（2026-11-17）：
        //  · 普通成员 → 指挥在 assignments[].mcp 里按任务指定
        //  · 指挥自己 → 跟随「可动手」开关（只派活=零 MCP，可动手=不限制）
        // 单一入口，避免两套配置打架。
        h('div', { style: Object.assign({}, styles.muted, { marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }) },
          // 职位名在上一行的下拉里已经有了，这里不再重复「职位：指挥」；会话 id 对用户无意义，去掉
          h('span', null, role ? '' : '未分配职位'),
          // v0.4 P3：长久成员继承上下文（可压缩）；临时成员每轮由指挥重发上下文
          null))
      }

      /* ── v0.4 团队选项：三个开关（需要指挥审核 / 严格审核 / 大脑权限）──────
       * 取代原来的 usagePanel（那个函数定义了但从未被调用，属历史残留）。
       * 读写都走 /config：strictReview ↔ authoritativeReviewer、
       * brainPermissions 直接存；Host 侧 runBrain 三腿按它决定工具面。
       */
      function teamOptionsPanel() {
        const cur = apiConfig || {}
        // 审核链的两级开关存在**组**上（每个小组可以不一样）
        const saveGroupFlag = (patch) => {
          if (!group || !group.id) return
          mutate('/groups/policy', Object.assign({ id: group.id }, patch)).then(refresh)
        }
        const saveTeam = (patch) => {
          setBusy('teamopt')
          call('/config', patch)
            .then((data) => { if (data && data.config) setApiConfig(data.config) })
            .catch((e) => setError(String(e.message || e)))
            .finally(() => setBusy(null))
        }
        const lock = busy === 'teamopt'
        const row = (label, hint, control) => h('div', {
          style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, opacity: lock ? 0.6 : 1 },
        },
          control,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
            h('span', { style: { fontSize: 13 } }, label),
            h('span', { style: Object.assign({}, styles.muted, { fontSize: 11 }) }, hint)))
        const check = (checked, onChange) => h('input', {
          type: 'checkbox',
          checked: Boolean(checked),
          disabled: lock,
          style: { marginTop: 3, cursor: lock ? 'default' : 'pointer' },
          onChange: (e) => onChange(e.target.checked),
        })
        const mode = cur.brainPermissions === 'open' ? 'open' : 'closed'
        const seg = (value, text) => h('span', {
          key: value,
          style: {
            padding: '2px 10px', borderRadius: 999, fontSize: 12, userSelect: 'none',
            cursor: lock || mode === value ? 'default' : 'pointer',
            // 与胶囊同一套反色方案：brand-primary 在深色主题下是近白色，配白字=白底白字
            background: mode === value ? 'var(--dsw-alias-label-primary)' : 'transparent',
            color: mode === value ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-secondary)',
          },
          onClick: lock || mode === value ? undefined : () => saveTeam({ brainPermissions: value }),
        }, text)
        return h('div', { style: Object.assign({}, styles.card, { marginBottom: 12 }) },
          h('strong', null, '团队选项'),
          // 「需要指挥审核」在下方「验收策略」里已有同名开关，这里不再重复（2026-11-16 用户指出重复）
          row('严格审核',
            '任一审核方不通过即强制不通过；关掉则冲突时以指挥为准',
            check(cur.strictReview !== false, (v) => saveTeam({ strictReview: v }))),
          // 2026-11-16 用户要求：审核链的两级开关放在这里（串行链：自审 → 初审 → 指挥终审）
          row('成员自审',
            '成员交付前先自查一遍产出与要求是否一致（可选，多花一次调用）',
            check(group && group.selfReview === true, (v) => saveGroupFlag({ selfReview: v }))),
          row('初审',
            '先用便宜模型快筛：偏差太大直接打回重做，不再浪费指挥审核',
            check(!(group && group.requirePrelim === false), (v) => saveGroupFlag({ requirePrelim: v }))),
          row('大脑权限',
            mode === 'open'
              ? '开放：大脑可以自己动手（跑命令 / 改文件）'
              : '关闭：大脑只拆解、做计划、派活',
            h('div', {
              style: { display: 'inline-flex', gap: 2, padding: 2, borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)' },
            }, [seg('closed', '只派活'), seg('open', '可动手')])),
          row('模型定位表',
            '注入给指挥，帮它自动建成员时选模型（性能 / 性价比）',
            h(Button, {
              onClick: () => {
                setGuideDraft(String(cur.modelGuide || cur.modelGuideDefault || ''))
                setGuideEditing(!guideEditing)
              },
            }, guideEditing ? '收起' : '编辑')),
          guideEditing
            ? h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
              h('textarea', {
                value: guideDraft,
                onChange: (e) => setGuideDraft(e.target.value),
                placeholder: '每行一条，例如：- claude-opus-5-5：代码顶尖，贵',
                style: {
                  width: '100%', minHeight: 180, padding: 8, borderRadius: 8, fontSize: 12,
                  fontFamily: 'ui-monospace, monospace', resize: 'vertical',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'transparent', color: 'var(--dsw-alias-label-primary)',
                },
              }),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                h(Button, { primary: true, onClick: () => { saveTeam({ modelGuide: guideDraft }); setGuideEditing(false) } }, '保存'),
                h(Button, { onClick: () => { saveTeam({ modelGuide: '' }); setGuideDraft(String(cur.modelGuideDefault || '')) } }, '恢复默认'),
                h(Button, { onClick: () => setGuideEditing(false) }, '取消')),
              h('span', { style: Object.assign({}, styles.muted, { fontSize: 11 }) },
                cur.modelGuide ? '当前：使用自定义表格' : '当前：内置默认表格'))
            : null,
        )
      }
      if (!state) {
        return h('div', { style: Object.assign({}, styles.root, { padding: 16 }) },
          error ? h('div', { style: styles.err }, error) : h('div', { style: styles.muted }, '加载中…'))
      }

      if (!group) {
        return h('div', { style: Object.assign({}, styles.root, { padding: 16, gap: 10 }) },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '单人模式'),
          h('div', { style: styles.muted }, '这个会话还没有自己的小组：没有名册，也没有 council_delegate 工具。'),
          h('div', { style: styles.muted }, '启用后会为这个会话创建一个小组，之后在下面的编排里加成员。'),
          archivedGroupCount
            ? h('div', { style: Object.assign({}, styles.muted, { fontSize: 11, opacity: 0.65 }) }, '已归档 ' + archivedGroupCount + ' 个')
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
            h(Button, { primary: true, onClick: enableMode }, sessionId ? '启用小组模式' : '（当前没有会话）'),
            h(Button, { onClick: refresh }, '刷新')))
      }

      const roleMember = (roleName) => {
        const role = roles.find((r) => r.name === roleName || r.name.indexOf(roleName) === 0)
        if (!role) return null
        return members.find((m) => m.roleId === role.id) || null
      }
      const commanderMember = roleMember('指挥')
      const reviewerMember = roleMember('审校')

      const deepseek = balance && balance.deepseek
      const wallet = deepseek && deepseek.wallets && deepseek.wallets.length ? deepseek.wallets[0] : null
      const balanceLabel = wallet
        ? 'DeepSeek ' + wallet.currency + ' ' + wallet.balance.toFixed(2)
        : 'DeepSeek 余额未接入'

      const header = h('div', { style: styles.bar },
        h('strong', null, '小组编排'),
        // 只清理「归档超过 N 天」的小组；会话目录一律不碰（「清理子会话」按钮已从 UI 移除）。
        // 「清理 7 天前归档」「清理子智能体」已移除（2026-11-16 用户要求精简小组页）
        h('span', { style: { flex: 1 } }))

      // 职位侧栏的折叠开关：**不用 ref / state**（DSH 里两者都不可靠），
      // 靠 data 属性在 DOM 里找节点直接改 display（2026-11-16）。
      const toggleRoles = () => {
        const node = document.querySelector('[data-council-roles]')
        if (!node) return
        const hidden = node.style.display === 'none'
        node.style.display = hidden ? '' : 'none'
        const handle = document.querySelector('[data-council-roles-handle]')
        if (handle) handle.textContent = hidden ? '◀' : '▶'
      }

      const rolesPanel = h('div', {
        'data-council-roles': '1',
        style: styles.roles,
      },
        h('div', { style: Object.assign({}, styles.muted, { marginBottom: 4 }) }, '职位（把成员拖到职位上完成分配）'),
        // 整段说明只在**这里**出现一次（之前每个职位卡都重复一遍，2026-11-16 用户指出）
        h('div', { style: Object.assign({}, styles.muted, { marginBottom: 8, fontSize: 11, opacity: 0.85, lineHeight: 1.5 }) },
          // 2026-11-17 用户要求：删掉那段框架映射说明（对用户没用），只留一句「自己分配」
          '职位只提供提示词模板，成员自己分配'),
        roles.map(roleCard),
        h(Button, { onClick: () => mutate('/roles', { name: '职位 ' + (roles.length + 1) }) }, '+ 新增职位'),
        h('span', { style: { width: 6, display: 'inline-block' } }),
        h(Button, { onClick: loadRolePresets }, '载入预设职位'),
        h('div', { style: { height: 14 } }),
        h('div', { style: Object.assign({}, styles.muted, { marginBottom: 6 }) }, '未分配成员'),
        h('div', {
          style: Object.assign({}, styles.roleRow, dropRole === 'none' ? styles.dropActive : null),
          onDragOver: (event) => { event.preventDefault(); setDropRole('none') },
          onDragLeave: () => setDropRole((current) => (current === 'none' ? null : current)),
          onDrop: (event) => { event.preventDefault(); drop(null) },
        }, members.filter((m) => !m.roleId).map(memberChip)))

      const board = h('div', { style: styles.board },
        h('div', { style: Object.assign({}, styles.muted, { marginBottom: 8 }) },
          '成员（拖到左侧职位即可分配；聊天在「对话」页底部的群聊框里）'),
        members.map(memberCard),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h(Button, { onClick: () => mutate('/members', { name: '成员 ' + (members.length + 1), kind: 'claude', groupId: group.id }) }, '+ 添加成员')),
        h('div', { style: Object.assign({}, styles.card, { marginTop: 16 }) },
          h('div', { style: Object.assign({}, styles.muted, { marginBottom: 6 }) }, '总画师风格（注入所有出图任务；留空则不校验）'),
          h('textarea', {
            style: Object.assign({}, styles.input, { minHeight: 54, resize: 'vertical' }),
            defaultValue: group.style || '',
            placeholder: '例如：扁平插画，低饱和莫兰迪色，粗细一致的描边，不出现文字与渐变',
            onBlur: (event) => { if (event.target.value !== (group.style || '')) mutate('/groups', { id: group.id, style: event.target.value }) },
          }),
          h('div', { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { style: styles.muted }, '风格审校（claude 成员，会读图）'),
            h('select', {
              style: Object.assign({}, styles.input, { width: 200 }), defaultValue: group.reviewerId || '',
              onChange: (event) => mutate('/groups', { id: group.id, reviewerId: event.target.value || undefined }),
            }, [h('option', { key: 'auto', value: '' }, '自动（第一个 claude）')].concat(
              members.filter((m) => m.kind === 'claude').map((m) => h('option', { key: m.id, value: m.id }, m.name)))))),
        h('div', { style: Object.assign({}, styles.card) },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '模型与密钥'),
          h('div', { style: styles.muted },
            '提供商与 API Key 统一在 DSH 的「设置 → 模型提供商」里配置；小组成员直接选提供商即可。'
            + '（出图仍用 profile 里配置的 gpt-image key）'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
            h(Button, {
              onClick: () => {
                call('/providers/refresh', {})
                  .then((data) => { setProviders(data.providers || []); setProvidersNote('已刷新提供商模型列表') })
                  .catch((e) => setProvidersNote('刷新失败：' + String(e.message || e)))
              },
            }, '刷新模型列表'),
            h('span', { style: Object.assign({}, styles.muted, { fontSize: 12 }) }, providersNote || '按各提供商的 base/key 重新拉取模型'))))

      return h('div', { style: styles.root },
        header,
        error ? h('div', { style: Object.assign({}, styles.err, { padding: '6px 14px' }) }, error) : null,
        // 布局（2026-11-16 用户要求）：左=职位预设（含提示词），中=成员，右=团队选项/验收策略
        h('div', { style: styles.body },
          // 常驻的折叠把手：收起后仍能点开
          h('div', {
            title: '展开 / 收起职位栏',
            onClick: toggleRoles,
            // 折叠把手（2026-11-16 用户反馈辨识度低）：
            //  ① 底色用 bg-layer-2——它比周边（layer-1）深/浅一档，且**自动跟随主题**，
            //     不需要为深浅模式写两套颜色；
            //  ② hover 再深一档，给出「这里可点」的反馈；
            //  ③ 18 → 22px，点击热区更宽容。
            onMouseEnter: (e) => { try { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))' } catch { /* ignore */ } },
            onMouseLeave: (e) => { try { e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)' } catch { /* ignore */ } },
            style: {
              width: 22, flexShrink: 0, cursor: 'pointer', userSelect: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--dsw-alias-bg-layer-2)',
              borderRight: '1px solid var(--dsw-alias-border-l1)',
              color: 'var(--dsw-alias-label-primary)', fontSize: 11,
            },
          }, h('span', { 'data-council-roles-handle': '1' }, '◀')),
          rolesPanel, board, teamOptionsPanel()))
    }


    /* 工具卡：council_delegate 的成员回执渲染成气泡 */
    function CouncilCard(props) {
      try {
        return CouncilCardInner(props)
      } catch (error) {
        return h('div', { style: styles.card },
          h('div', { style: styles.who }, '小组回执'),
          h('div', { style: styles.err }, '卡片渲染失败：' + String((error && error.message) || error)))
      }
    }

    function parseCouncilText(text) {
      const chunks = String(text || '').split(/\n(?=## )/).filter((chunk) => chunk.trim())
      return chunks.map((chunk) => {
        const head = chunk.match(/^##\s+(.+?)（(.+?)）\s*\n?([\s\S]*)$/)
        if (!head) return { who: '回执', kind: '', body: chunk.trim() }
        let body = head[3] || ''
        const markdownImage = body.match(/!\[image\]\(([^)]+)\)/)
        const markerImage = body.match(/\[image\]\s*(\S+)/)
        const image = (markdownImage && markdownImage[1]) || (markerImage && markerImage[1])
        if (markdownImage) body = body.replace(markdownImage[0], '').trim()
        else if (markerImage) body = body.replace(markerImage[0], '').trim()
        const review = []
        const line = body.match(/自审：([^\n]*?)\s*·\s*指挥审核：([^\n]*)/)
        if (line) {
          review.push(['自审', line[1]])
          review.push(['指挥审核', line[2]])
          body = body.replace(line[0], '').trim()
        }
        return { who: head[1], kind: head[2], body, image, review }
      })
    }


    function RosterPanel() {
      const [, bump] = useState(0)
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        const rerender = () => bump((v) => v + 1)
        panelListeners.add(rerender)
        return () => panelListeners.delete(rerender)
      }, [])

      useEffect(() => { refreshModels() }, [])

      useEffect(() => {
        if (!panelState.open) return
        call('/state').then((data) => setState(data.state)).catch((e) => setError(String(e.message || e)))
      }, [panelState.open])

      if (!panelState.open) return null

      const groups = (state && state.groups) || []
      const group = groups.find((g) => g.sessionId === panelState.sessionId && !g.archived)
        || groups.find((g) => !g.archived) || null
      const members = group ? (state.members || []).filter((m) => group.memberIds.indexOf(m.id) >= 0) : []
      const roles = (state && state.roles) || []
      const roleName = (member) => {
        const role = roles.find((r) => r.id === member.roleId)
        return role ? role.name : '未分配'
      }

      async function act(path, body) {
        setBusy(true); setError(null)
        try {
          const data = await call(path, body)
          setState(data.state)
          notifyCouncilChange()
          return data
        } catch (e) { setError(String(e.message || e)); return null }
        finally { setBusy(false) }
      }

      async function addMember(kind) {
        if (!group) return
        await act('/members', {
          name: kind === 'image' ? '画师' : '成员 ' + (members.length + 1),
          kind, groupId: group.id,
        })
      }

      const overlayStyle = {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }
      const cardStyle = {
        width: 'min(760px, 92vw)', maxHeight: '80vh', overflow: 'auto', borderRadius: 12, padding: 16,
        background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13,
      }

      const memberRows = members.map((member) => {
        const list = (liveModels[member.kind] || FALLBACK_MODELS[member.kind] || [])
        const options = member.model && list.indexOf(member.model) < 0 ? [member.model].concat(list) : list
        return h('div', { key: member.id, style: styles.card },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: Object.assign({}, styles.input, { flex: '1 1 140px' }), defaultValue: member.name,
              onBlur: (e) => { if (e.target.value !== member.name) act('/members', { id: member.id, name: e.target.value }) },
            }),
            h('select', {
              style: Object.assign({}, styles.input, { width: 100 }), defaultValue: member.kind,
              onChange: (e) => {
                const kind = e.target.value
                const kinds = (liveModels[kind] || FALLBACK_MODELS[kind] || [])
                const next = member.model && kinds.indexOf(member.model) >= 0 ? member.model : (kinds[0] || '')
                act('/members', { id: member.id, kind: kind, model: next })
              },
            }, ['codex', 'claude', 'deepseek', 'image'].map((k) => h('option', { key: k, value: k }, k))),
            h('select', {
              style: Object.assign({}, styles.input, { width: 190 }), defaultValue: member.model || '',
              onChange: (e) => act('/members', { id: member.id, model: e.target.value }),
            }, options.map((id) => h('option', { key: id, value: id }, id))),
            h('select', {
              style: Object.assign({}, styles.input, { width: 130 }), defaultValue: member.roleId || '',
              onChange: (e) => act('/members/role', { id: member.id, roleId: e.target.value || null }),
            }, [h('option', { key: 'none', value: '' }, '未分配职位')].concat(
              roles.map((r) => h('option', { key: r.id, value: r.id }, r.name)))),
            h(Button, { onClick: () => act('/members/delete', { id: member.id }) }, '删')),
          null)
      })

      const roleRows = roles.map((role) => h('div', {
        key: role.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 6, marginBottom: 8 },
      },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('input', {
          style: Object.assign({}, styles.input, { flex: 1 }), defaultValue: role.name,
          onBlur: (e) => { if (e.target.value !== role.name) act('/roles', { id: role.id, name: e.target.value }) },
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
        }),
        h('span', { style: styles.muted }, members.filter((m) => m.roleId === role.id).length + ' 人'),
        h(Button, { onClick: () => act('/roles/delete', { id: role.id }) }, '删')),
      h('textarea', {
        style: Object.assign({}, styles.input, { marginTop: 4, minHeight: 46, resize: 'vertical' }),
        defaultValue: role.prompt || '',
        placeholder: '这个职位的提示词（派活时注入给该成员）',
        onBlur: (e) => { if (e.target.value !== (role.prompt || '')) act('/roles', { id: role.id, prompt: e.target.value }) },
      })))

      return h('div', { style: overlayStyle, onMouseDown: (e) => { if (e.target === e.currentTarget) closeRosterPanel() } },
        h('div', { style: cardStyle },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
            h('strong', null, '成员名册 · ' + (group ? group.name : '（还没有小组）')),
            h('span', { style: { flex: 1 } }),
            h(Button, { onClick: closeRosterPanel }, '关闭')),
          group ? null : h('div', { style: styles.muted }, '先在顶部胶囊里选「小组模式」，会自动创建一个带默认名册的小组。'),
          group ? memberRows : null,
          group ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h(Button, { onClick: () => addMember('codex') }, '+ codex'),
            h(Button, { onClick: () => addMember('claude') }, '+ claude'),
            h(Button, { onClick: () => addMember('deepseek') }, '+ deepseek'),
            h(Button, { onClick: () => addMember('image') }, '+ image')) : null,
          group ? h('div', { style: Object.assign({}, styles.card, { marginTop: 10 }) },
            h('div', { style: Object.assign({}, styles.muted, { marginBottom: 6 }) }, '职位（可改名、改提示词、增删）'),
            roleRows,
            h(Button, { onClick: () => act('/roles', { name: '职位 ' + (roles.length + 1) }) }, '+ 职位')) : null,
          error ? h('div', { style: Object.assign({}, styles.err, { marginTop: 8 }) }, error) : null,
          h('div', { style: Object.assign({}, styles.muted, { marginTop: 10 }) },
            '这里改成员与职位；风格、API、用量在「小组」tab 里改。')))
    }



    const KIND_COLOR = { codex: '#3b82f6', claude: '#a855f7', deepseek: '#14b8a6', image: '#f59e0b' }

    /* 手绘 SVG 头像：claude=橘发大小姐，deepseek=蓝色大肥鱼，codex/gpt=白发龙娘 */
    const AVATAR_SVG = {
      claude: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        + '<circle cx="32" cy="32" r="32" fill="#ffe9d6"/>'
        + '<path d="M12 54c2-12 8-18 20-18s18 6 20 18z" fill="#f6a04d"/>'
        + '<path d="M16 30c0-11 7-18 16-18s16 7 16 18c0 5-2 8-4 8 0-8-4-12-12-12s-12 4-12 12c-2 0-4-3-4-8z" fill="#f08a3c"/>'
        + '<circle cx="32" cy="30" r="11" fill="#ffe0c6"/>'
        + '<path d="M20 24c3-7 9-10 12-10s9 3 12 10c-6-4-18-4-24 0z" fill="#f08a3c"/>'
        + '<circle cx="27" cy="30" r="1.7" fill="#3a2a20"/><circle cx="37" cy="30" r="1.7" fill="#3a2a20"/>'
        + '<path d="M28 36q4 3 8 0" stroke="#c9563f" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        + '<path d="M26 17l6-4 6 4-6 2z" fill="#ffd166"/></svg>',
      deepseek: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        + '<circle cx="32" cy="32" r="32" fill="#dff3ff"/>'
        + '<ellipse cx="30" cy="38" rx="19" ry="14" fill="#3b82f6"/>'
        + '<path d="M45 34c6-6 10-5 12-2-3 0-6 2-8 5z" fill="#2563eb"/>'
        + '<path d="M22 20q6-8 12-2" stroke="#bfe3ff" stroke-width="3" fill="none" stroke-linecap="round"/>'
        + '<circle cx="22" cy="35" r="2.4" fill="#0b1d3a"/>'
        + '<path d="M17 43q5 4 10 1" stroke="#0b1d3a" stroke-width="1.8" fill="none" stroke-linecap="round"/>'
        + '<ellipse cx="38" cy="26" rx="6" ry="3" fill="#bfe3ff" opacity="0.7"/></svg>',
      codex: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        + '<circle cx="32" cy="32" r="32" fill="#eef2ff"/>'
        + '<path d="M12 55c2-11 8-16 20-16s18 5 20 16z" fill="#c7d2fe"/>'
        + '<circle cx="32" cy="31" r="11" fill="#fff3e6"/>'
        + '<path d="M18 30c0-9 6-16 14-16s14 7 14 16c0 3-1 5-2 5-1-7-5-11-12-11s-11 4-12 11c-1 0-2-2-2-5z" fill="#f8fafc"/>'
        + '<path d="M18 22c2-6 7-9 14-9s12 3 14 9c-8-3-20-3-28 0z" fill="#ffffff"/>'
        + '<path d="M20 16l-3-6 6 2zM44 16l3-6-6 2z" fill="#a5b4fc"/>'
        + '<circle cx="28" cy="31" r="1.7" fill="#3b3670"/><circle cx="36" cy="31" r="1.7" fill="#3b3670"/>'
        + '<path d="M29 37q3 2 6 0" stroke="#7c6fd6" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        + '<path d="M27 41l5 3 5-3-5-1z" fill="#a5b4fc"/></svg>',
    }

    /* 本地立绘优先；图片 404 时自动回退到内置 SVG 占位（分发版没有这些文件 → 占位） */
    const AVATAR_FILE = {
      codex: 'avatar-codex-small.png',
      claude: 'avatar-claude-small.png',
      deepseek: 'avatar-deepseek-small.png',
      image: 'avatar-codex-small.png',
    }

    const AVATAR_ALIAS = { image: 'codex' }

    function avatarSvg(kind) {
      const svg = AVATAR_SVG[kind] || AVATAR_SVG[AVATAR_ALIAS[kind]]
      return svg ? 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) : null
    }

    function avatarSrc(kind) {
      const file = AVATAR_FILE[kind]
      return file ? '/council/api/image/' + file + '?v=6' : null
    }

    function Avatar(props) {
      const [failed, setFailed] = useState(false)
      const src = failed ? avatarSvg(props.kind) : (avatarSrc(props.kind) || avatarSvg(props.kind))
      if (src) {
        return h('img', {
          src, alt: props.name || props.kind || '',
          onError: () => setFailed(true),
          style: {
            width: 24, height: 24, borderRadius: 999, flex: 'none', marginRight: 8,
            border: '1px solid var(--dsw-alias-border-l1)', objectFit: 'cover',
          },
        })
      }
      const color = KIND_COLOR[props.kind] || '#6b7280'
      return h('span', {
        style: {
          width: 24, height: 24, borderRadius: 999, flex: 'none', marginRight: 8,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: color, color: '#fff', fontSize: 12, fontWeight: 600,
        },
      }, (props.name || '?').slice(0, 1))
    }

    function Collapsible(props) {
      const text = String(props.text || '')
      const long = text.length > 240
      // 截断显示；**悬停即可看到完整全文**（不再需要「展开全文」按钮）
      const shown = !long ? text : text.slice(0, 240) + '…'
      return h('div', null,
        h('div', { style: { whiteSpace: 'pre-wrap' }, title: long ? text : undefined }, shown))
    }

    function parseArgs(raw) {
      if (!raw) return {}
      if (typeof raw === 'object') return raw
      try { return JSON.parse(String(raw)) } catch { return {} }
    }

    function CouncilCardInner(props) {
      const call = props && props.call ? props.call : {}
      const block = call.block || {}
      const phase = call.phase || (block.kind ? 'result' : 'start')
      const text = (block.content || []).filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
      const args = parseArgs(block.call && block.call.arguments)
      const planned = (args.assignments || []).map((item) => item.member)
      const [progress, setProgress] = useState(null)
      const [now, setNow] = useState(Date.now())
      // 本轮是否已请求停止（按钮置灰用）
      const [stoppedAt, setStoppedAt] = useState(0)

      useEffect(() => {
        if (phase === 'result') return undefined
        let alive = true
        const load = () => {
          call('/progress').then((data) => {
            if (!alive) return
            const all = (data && data.progress) || {}
            setProgress(all[props && props.callId] || null)
            setNow(Date.now())
          }).catch(() => {})
        }
        load()
        const timer = setInterval(() => { if (!document.hidden) load() }, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [phase, props && props.callId])

      if (phase !== 'result') {
        const stageEntry = progress && progress.members ? progress.members.__stage__ : null
        const members = progress && progress.members
          ? Object.keys(progress.members).filter((id) => id !== '__stage__').map((id) => progress.members[id])
          : []
        const started = progress && progress.startedAt ? Math.round((now - progress.startedAt) / 1000) : null
        // 2026-11-17 用户要求：底部状态栏那两个「终止」按钮合并到这里。
        //  · ✕ 只停这个成员（/runs/cancel { member, callId }）
        //  · 「停止」停本轮所有成员（/runs/cancel { all: true }）
        const stopMember = async (id) => {
          try { await call('/runs/cancel', { member: id, callId: props && props.callId }) } catch { /* ignore */ }
        }
        const stopAll = async () => {
          if (stoppedAt) return
          setStoppedAt(Date.now())
          try { await call('/runs/cancel', { all: true }) } catch { /* ignore */ }
        }
        return h('div', { style: styles.card },
          h('div', { style: Object.assign({}, styles.who, { display: 'flex', alignItems: 'center', gap: 8 }) },
            h('span', null, '小组派发中…' + (started === null ? '' : ' ' + started + 's')),
            h('span', { style: { flex: 1 } }),
            h('span', {
              title: stoppedAt ? '已发送停止请求，正在终止…' : '停止本轮所有成员（立即终止进行中的 CLI / 子代理）',
              onClick: stopAll,
              style: {
                cursor: stoppedAt ? 'default' : 'pointer', padding: '2px 10px', borderRadius: 999,
                fontSize: 12, fontWeight: 600, color: '#fff',
                background: stoppedAt ? '#8a5a5a' : '#e5484d', border: '1px solid #c93a3f',
                opacity: stoppedAt ? 0.7 : 1,
              },
            }, stoppedAt ? '取消中…' : '停止')),
          members.length
            ? members.map((m, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 4 } },
              h(Avatar, { kind: m.kind, name: m.name }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: styles.muted }, (m.name || '成员') + ' · ' + (m.stage || '…')
                  // 时间统一用「本次派发开始」为基准，跟上面那行「小组派发中… Ns」一致
                  + (m.finishedAt ? '' : (started === null ? '' : ' · ' + started + 's')) + silenceSuffix(m)),
                // 最近一行输出（2026-11-17）：能看出成员在干什么、有没有卡住
                m.tailText
                  ? h('div', {
                    style: { fontSize: 11, opacity: 0.62, fontFamily: 'monospace', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                    title: m.tailText,
                  }, '› ' + m.tailText)
                  : null),
              // 只停这个成员
              m.finishedAt ? null : h('span', {
                title: '只停这个成员',
                onClick: () => stopMember(m.id || m.memberId),
                style: { cursor: 'pointer', color: '#e5484d', fontWeight: 700, padding: '0 4px', flexShrink: 0 },
              }, '✕')))
            : h('div', { style: styles.muted }, stageEntry
              ? (stageEntry.name || '指挥') + ' · ' + (stageEntry.stage || '处理中')
              : (planned.length ? planned.join('、') + '（等待开始）' : '准备中')))
      }

      const sections = parseCouncilText(text)
      if (!sections.length) {
        return h('div', { style: styles.card }, h('div', { style: styles.who }, '小组回执'), h('div', { style: styles.muted }, '（没有内容）'))
      }
      const names = sections.map((item) => item.who)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', marginBottom: 2,
            borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)', fontSize: 12,
          },
        },
        h('strong', null, '小组群聊'),
        h('span', { style: styles.muted }, names.length + ' 位成员'),
        h('span', { style: { flex: 1 } }),
        names.slice(0, 6).map((name, i) => h(Avatar, { key: name + i, kind: (sections[i] || {}).kind, name }))),
        sections.map(function (item, index) {
          return h('div', {
            key: index,
            style: { display: 'flex', alignItems: 'flex-start', alignSelf: 'flex-start', maxWidth: '88%' },
          },
          h(Avatar, { kind: item.kind, name: item.who }),
          h('div', { style: Object.assign({}, styles.bubble, { flex: 1 }) },
            h('div', { style: styles.who }, item.who + (item.kind ? ' · ' + item.kind : '')),
            item.body ? h(Collapsible, { text: item.body }) : null,
            item.image ? h('img', {
              src: item.image, alt: 'generated',
              style: { display: 'block', maxWidth: 320, marginTop: 6, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)' },
            }) : null,
            (item.review || []).map(function (entry, i) {
              return h('div', {
                key: i,
                style: {
                  marginTop: 2, fontSize: 11,
                  color: entry[1].indexOf('不通过') === 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
                },
              }, entry[0] + '：' + entry[1])
            })))
        }))
    }

    /* 把 council_delegate 的回执投影成一个 chat 行（挂在 conversation.chat.node） */
    function councilEventText(event) {
      const content = event && event.data && event.data.message && event.data.message.content
      if (!Array.isArray(content)) return ''
      return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('\n')
    }

    function isCouncilText(text) {
      return typeof text === 'string' && text.indexOf('## ') >= 0
        && (text.indexOf('指挥审核：') >= 0 || text.indexOf('自审：') >= 0 || text.indexOf('审校：') >= 0)
    }

    const councilChatDefinition = {
      kind: 'council-group-chat',
      target: 'chat',
      match: (event) => {
        // default on; localStorage.councilChatRows = '0' disables the extra chat rows
        try {
          if (typeof localStorage !== 'undefined' && localStorage.getItem('councilChatRows') === '0') return null
        } catch { /* keep on */ }
        if (!event || event.type !== 'tool/result') return null
        if (!isCouncilText(councilEventText(event))) return null
        const message = event.data && event.data.message
        const id = (message && message.toolCallId) || String(event.seq)
        return { id: String(id), role: 'start' }
      },
      start: (_context, match) => ({ text: councilEventText(match.event) }),
      update: (context, match) => ({ text: councilEventText(match.event) || context.state.text }),
      buildViewNode: (context) => {
        if (!context.start) return null
        return {
          key: context.key,
          kind: 'council-group-chat',
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: { text: context.state.text },
        }
      },
    }

    /* ── v0.4 模式胶囊：左「单人」右「小组」双段按钮 + 大脑模型下拉 ──────
     * 未建会话（hero 草稿态）时点「小组」会记住预选，发出第一条消息、
     * 会话建立后自动建组并绑定（见下方 useEffect）。
     */
    const MODE_PENDING_KEY = 'council.pendingMode'
    const readPendingMode = () => {
      try { return window.localStorage.getItem(MODE_PENDING_KEY) || '' } catch { return '' }
    }
    const writePendingMode = (value) => {
      try {
        if (value) window.localStorage.setItem(MODE_PENDING_KEY, value)
        else window.localStorage.removeItem(MODE_PENDING_KEY)
      } catch { /* 隐私模式禁用 storage，忽略 */ }
    }
    /** hero 态预选的大脑模型：建组时自动应用（用户要求「未发消息时就能选指挥模型」） */
    const BRAIN_PENDING_KEY = 'council.pendingBrain'
    const readPendingBrain = () => {
      try { return window.localStorage.getItem(BRAIN_PENDING_KEY) || '' } catch { return '' }
    }
    const writePendingBrain = (value) => {
      try {
        if (value) window.localStorage.setItem(BRAIN_PENDING_KEY, value)
        else window.localStorage.removeItem(BRAIN_PENDING_KEY)
      } catch { /* ignore */ }
    }
    /** hero 会自动应用预选的会话（只尝试一次，避免 effect 反复触发） */
    const pendingApplied = new Set()
    /** 能当「指挥大脑」的模型（前缀约定，与 Host 的 resolveBrain 对齐） */
    const isBrainModel = (id) => {
      const s = String(id || '')
      // 出图模型不能当大脑（gpt-image-* 会被 gpt 前缀误判）
      if (s.startsWith('gpt-image')) return false
      return s.startsWith('claude') || s.startsWith('gpt-') || /^o\d/.test(s)
        || s.startsWith('deepseek') || s.startsWith('gemini')
    }
    const capsuleStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2,
      borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    /**
     * 胶囊分段样式（v0.4.21 修深色模式）。
     *
     * ⚠️ 曾经用 `background: var(--dsw-alias-brand-primary)` + `color: #fff`，
     * 在**深色主题**下 brand-primary 解析成近白色（rgb(249,250,251)）→ **白底白字，完全看不清**。
     * 现在改成「中性半透明底 + 主题前景色」：深色下是一块稍亮的灰、浅色下是一块稍深的灰，
     * 文字始终跟随 --dsw-alias-label-primary，两种主题都清晰。
     */
    /**
     * 胶囊分段样式（v0.4.22，深色 + 浅色都要能看清）。
     *
     * 走过的弯路：
     *  ① 最初 `brand-primary` 做底 + 白字 → 深色下 brand-primary 是**近白色**，白底白字看不见；
     *  ② 改成中性半透明灰 + label-primary → 深色实测对比只有 3.83（AA 要 4.5）。
     *
     * 现在是**反色**方案（跟 iOS 分段控件同理）：
     *   选中 = 前景色当底、背景色当字；未选中 = 透明底 + 次级前景色。
     * 深色下是「浅底深字」，浅色下是「深底浅字」，两种主题对比度都远超 AA。
     */
    const segStyle = (active) => ({
      padding: '2px 10px', borderRadius: 999, fontSize: 12, userSelect: 'none',
      cursor: active ? 'default' : 'pointer',
      fontWeight: active ? 600 : 400,
      background: active ? 'var(--dsw-alias-label-primary)' : 'transparent',
      color: active ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-label-secondary)',
      transition: 'background .12s ease, color .12s ease',
    })

    function ModeToggle(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [team, setTeam] = useState(null)
      const [providers, setProviders] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      // hero 态预选的大脑模型（建组时自动应用）
      const [pendingBrain, setPendingBrain] = useState(readPendingBrain())

      useEffect(() => {
        let alive = true
        const reload = () => {
          call('/state')
            .then((data) => { if (alive) setState(data.state) })
            .catch((e) => { if (alive) setError(String(e.message || e)) })
          call('/providers')
            .then((data) => { if (alive) setProviders(data) })
            .catch(() => { /* 模型列表拿不到不影响切换 */ })
          if (sessionId) {
            call('/team/state?sessionId=' + encodeURIComponent(sessionId))
              .then((data) => { if (alive) setTeam(data) })
              .catch(() => { /* 没绑定小组时 400，忽略 */ })
          }
        }
        reload()
        councilListeners.add(reload)
        const timer = setInterval(() => { if (!document.hidden) reload() }, 8000)
        return () => { alive = false; councilListeners.delete(reload); clearInterval(timer) }
      }, [sessionId])

      const own = sessionId && state ? groupForSession(state, sessionId) : null
      const bound = Boolean(own)
      const pendingGroup = !sessionId && readPendingMode() === 'group'

      // v0.4.17：单人模式隐藏「团队 / 小组」两个 tab（按绑定状态切换）。
      // ⚠️ 必须等 state 就绪再判断：初次渲染时 state === null，bound 必然是 false，
      // 急着隐藏会把「已绑定小组的会话」也一起藏掉（实测踩到）。
      useEffect(() => {
        // ⚠️ 只有「会话内那个实例」才管 tab 可见性。
        // 这个组件同时挂在 conversation.session.header.actions 和 conversation.hero.options 两处；
        // hero 实例没有 sessionId → bound 恒为 false → 它会把刚显示出来的「团队/小组」又藏掉。
        if (!sessionId) return
        if (!state) return
        // 单人模式**立即**藏起来：切换会话时 DSH 会重建 tab 列表，新节点默认全显示，
        // 如果等防抖，就会出现「切到单人会话后还闪出小组 tab」的半秒窗口（2026-11-16 用户实测）。
        // 小组模式仍然防抖——建组→绑定→state 刷新那几帧 bound 会抖，立刻应用会来回闪。
        // 切换会话（sessionId 变了）→ **立即**应用，否则 tab 和内容会错位：
        // 实测视频里切到小组会话的那一帧，tab 还写着「对话/轨迹」，内容已经是团队群聊了。
        const switched = lastTabSessionId !== sessionId
        lastTabSessionId = sessionId
        if (switched || !bound) {
          applyTabVisibility(!bound, (switched ? 'switch' : 'immediate-solo') + ' sessionId=' + String(sessionId).slice(0, 8))
          // 切会话后 2 秒内持续保障有选中项（DSH 会清空选中态，单次点击不够）
          if (switched) ensureTabSelected()
        }
        let recheck = null
        const timer = setTimeout(() => {
          applyTabVisibility(!bound, 'effect bound=' + bound)
          // 兜底复核：万一中间被别的路径改错，1.2 秒后再纠正一次
          recheck = setTimeout(() => applyTabVisibility(!bound, 'recheck bound=' + bound), 1200)
        }, switched ? 0 : (bound ? 80 : 0))
        return () => { clearTimeout(timer); if (recheck) clearTimeout(recheck) }
      }, [sessionId, bound, Boolean(state)])

      /* hero 预选 → 会话建立后自动启用小组模式 */
      useEffect(() => {
        if (!sessionId || !state || pendingApplied.has(sessionId)) return
        if (readPendingMode() !== 'group') return
        if (groupForSession(state, sessionId)) { writePendingMode(''); return }
        pendingApplied.add(sessionId)
        const run = async () => {
          try {
            const created = await call('/groups', { name: '本会话小组' })
            const next = created.state.groups[created.state.groups.length - 1]
            await call('/groups/bind', { id: next.id, sessionId })
            await provisionDefaultRoster(next.id)
            // hero 态选过大脑模型 → 建组后立刻应用
            const wishBrain = readPendingBrain()
            if (wishBrain) {
              await call('/team/model', { sessionId, model: wishBrain }).catch(() => {})
              writePendingBrain('')
            }
            const data = await call('/state')
            setState(data.state)
            writePendingMode('')
            notifyCouncilChange()
          } catch (e) { setError(String(e.message || e)) }
        }
        run()
      }, [sessionId, state])

      const switchToSolo = async () => {
        if (busy) return
        if (!sessionId) { writePendingMode(''); setError(null); return }
        if (!bound) return
        setBusy(true); setError(null)
        try {
          await call('/groups/bind', { id: own.id, sessionId: null })
          const data = await call('/state')
          setState(data.state)
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const switchToGroup = async () => {
        if (busy) return
        if (!sessionId) {
          writePendingMode('group')
          setError('已选小组模式：发出第一条消息后自动启用')
          return
        }
        if (bound) return
        setBusy(true); setError(null)
        try {
          const created = await call('/groups', { name: '本会话小组' })
          const next = created.state.groups[created.state.groups.length - 1]
          await call('/groups/bind', { id: next.id, sessionId })
          await provisionDefaultRoster(next.id)
          // hero 态选过大脑 → 建组后应用
          const wishBrain = readPendingBrain()
          if (wishBrain) {
            await call('/team/model', { sessionId, model: wishBrain }).catch(() => {})
            writePendingBrain('')
          }
          const data = await call('/state')
          setState(data.state)
          writePendingMode('')
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      /** hero 态选大脑：只记预选，建组时应用 */
      const pickPendingBrain = (model) => {
        if (!model) return
        writePendingBrain(model)
        setPendingBrain(model)
        setError(null)
      }

      const pickBrain = async (model) => {
        if (busy || !sessionId || !model) return
        setBusy(true); setError(null)
        try {
          await call('/team/model', { sessionId, model })
          const data = await call('/team/state?sessionId=' + encodeURIComponent(sessionId))
          setTeam(data)
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      /* 大脑模型下拉：按 provider 分组，只列能当大脑的模型 */
      const options = []
      for (const p of (providers && providers.providers) || []) {
        const ids = (p.models || []).filter(isBrainModel)
        if (!ids.length) continue
        options.push(h('optgroup', { key: p.id, label: (p.name || p.id) },
          ids.map((id) => h('option', { key: id, value: id }, id))))
      }
      const brainModel = (team && team.model) || ''
      const selectStyle = {
        fontSize: 11, maxWidth: 210, padding: '1px 4px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      }

      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        h('span', {
          style: Object.assign({}, capsuleStyle, busy ? { opacity: 0.6 } : {}),
          title: bound ? '当前是小组模式：消息交给「指挥」拆解并派给成员' : '当前是单人模式：消息直接由本会话回答',
        },
          h('span', {
            style: segStyle(!bound),
            title: bound ? '切回单人模式（对话/轨迹）' : '当前已在单人模式',
            onClick: busy || !bound ? undefined : switchToSolo,
          }, '单人'),
          h('span', {
            // BUG-2 修（2026-11-17）：pendingGroup 只是「hero 里预选过」，此时还没有组、
            // tab 也不会显示。把它画成「已选中」会让用户以为在小组模式却找不到小组页。
            // 所以选中态一律以 bound 为准；pendingGroup 用虚线边框表示「预选」。
            style: Object.assign(segStyle(bound), pendingGroup && !bound ? {
              border: '1px dashed var(--dsw-alias-border-l1)',
            } : {}),
            title: bound
              ? '当前已在小组模式'
              : (pendingGroup ? '已预选小组模式：发送第一条消息后自动建组' : '切到小组模式：消息交给指挥拆解派活'),
            onClick: busy || bound ? undefined : switchToGroup,
          }, '小组'),
        ),
        // 2026-11-16 用户要求：**天角不再有「选指挥模型」的下拉**。
        // 指挥 = 小组里那个「指挥」成员，它的模型在「小组」页成员卡上改；
        // 原生对话框右下角的模型选择器决定的是主会话（传话器）用哪个模型。
        // 2026-11-16 用户：「名册现在几乎没有实际意义了」——成员/职位都在「小组」页编辑，
        // 这里不再放重复入口。
        error ? h('span', {
          style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', maxWidth: 260 },
          title: error,
        }, error) : null,
      )
    }

    return {
      inject: ['slots'],
      // 测试钩子：渲染冒烟用假 fetch，拿不到真实 /state，用它手动设定「哪些会话有小组」。
      __setGroupSessions: (ids) => { groupSessionSet = new Set((ids || []).map(String)) },
      apply(ctx) {
        // 插件一启动就预取「哪些会话有小组」：团队视图的「单人会话不渲染」判断依赖它。
        // 否则首次进入某个单人会话时集合还是 null（未知），会先渲染一次团队内容。
        try { call('/state').then((d) => refreshGroupSessionSet(d && d.state)).catch(() => {}) } catch { /* ignore */ }
        try {
          registerAll(ctx)
        } catch (error) {
          try { console.error('[council] client registration failed', error) } catch { /* ignore */ }
        }
        // v0.4.17：tab 会被重渲染替换，挂一个观察器把「单人模式隐藏团队/小组」补回去
        watchTabList()
      },
    }


    /* 兜底视图：挂在回合末尾的列表槽，不依赖 keyed 派发 */
    function CouncilTail(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [collapsed, setCollapsed] = useState(false)

      useEffect(() => {
        let alive = true
        const load = () => call('/state').then((d) => { if (alive) setState(d.state) }).catch(() => {})
        load()
        const timer = setInterval(() => { if (!document.hidden) load() }, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const history = (state && state.delegations && state.delegations[sessionId]) || null
      const turnSeq = props && typeof props.seq === 'number' ? props.seq : null
      // 一次派活属于某一轮：用「结束 seq ≤ 本轮 seq」里最近的一条，避免每条消息都显示最新内容
      const pickEntry = () => {
        const list = (history && history.entries) || []
        if (!list.length) return null
        const done = list.filter((e) => typeof e.endSeq === 'number')
        if (turnSeq === null || !done.length) return list[list.length - 1]
        const candidates = done.filter((e) => e.endSeq <= turnSeq)
        if (candidates.length) return candidates[candidates.length - 1]
        return done[0]
      }
      const entry = pickEntry()
      const entryAt = entry && entry.at ? entry.at : 0

      useEffect(() => {
        if (!sessionId || !entryAt) return
        const saved = tailCollapsedMap[sessionId + '|' + entryAt]
        if (saved !== undefined) setCollapsed(saved === true)
      }, [sessionId, entryAt])

      // 单人模式（本会话没有绑定小组）时不要在对话里出现小组成分
      if (!state || !sessionId || !groupForSession(state, sessionId)) return null
      if (!entry || !entry.text) return null
      const sections = parseCouncilText(entry.text)
      if (!sections.length) return null
      const names = sections.map((item) => item.who)
      const toggle = () => {
        const next = !collapsed
        tailCollapsedMap[sessionId + '|' + entryAt] = next
        setCollapsed(next)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, margin: '6px 0' } },
        h('div', {
          onClick: toggle,
          title: collapsed ? '展开这一轮的成员回执' : '收起这一轮的成员回执',
          style: {
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', cursor: 'pointer',
            borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)', fontSize: 12,
          },
        },
        h('span', { style: { fontSize: 10, opacity: 0.7 } }, collapsed ? '▸' : '▾'),
        h('strong', null, '小组群聊'),
        h('span', { style: styles.muted }, names.length + ' 位成员'),
        h('span', { style: { flex: 1 } }),
        names.slice(0, 6).map((name, i) => h(Avatar, { key: name + i, kind: (sections[i] || {}).kind, name }))),
        collapsed ? null : sections.map(function (item, index) {
          return h('div', { key: index, style: { display: 'flex', alignItems: 'flex-start', maxWidth: '88%' } },
            h(Avatar, { kind: item.kind, name: item.who }),
            h('div', { style: Object.assign({}, styles.bubble, { flex: 1 }) },
              h('div', { style: styles.who }, item.who + (item.kind ? ' · ' + item.kind : '')),
              item.body ? h(Collapsible, { text: item.body }) : null,
              item.image ? h('img', { src: item.image, alt: 'generated', style: { display: 'block', maxWidth: 320, marginTop: 6, borderRadius: 8 } }) : null,
              (item.review || []).map(function (entry2, i) {
                return h('div', { key: i, style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, entry2[0] + '：' + entry2[1])
              })))
        }))
    }

    /* 输入框上方的实时状态条：谁在干什么 */
    function CouncilProgress(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      // 并行的多次 delegate 会有多条进行中的进度条目 —— 全部渲染，别只留最后一条
      const [entries, setEntries] = useState([])
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        let alive = true
        const load = () => {
          const url = sessionId ? '/progress?sessionId=' + encodeURIComponent(sessionId) : '/progress'
          call(url).then((data) => {
            if (!alive) return
            const all = (data && data.progress) || {}
            // 双保险：服务端已按 sessionId 过滤，客户端再过滤一次防止渗漏
            // 规范化比对：统一补齐 session- 前缀
            const normalizedSessionId = sessionId
              ? (sessionId.startsWith('session-') ? sessionId : 'session-' + sessionId)
              : null
            const list = Object.keys(all).map((id) => all[id])
              .filter((e) => {
                // 过滤策略：
                // - stale 条目：服务端返回（保留 5 分钟），客户端不渲染
                // - finished 条目：服务端默认不返回（除非 includeFinished=1），客户端也不渲染
                // - 不匹配 sessionId 的条目：双保险过滤掉
                if (e.stale || e.finishedAt) return false
                // 有 sessionId 时双保险过滤：只要匹配当前会话的
                if (normalizedSessionId && e.sessionId) {
                  const entrySessionId = e.sessionId.startsWith('session-')
                    ? e.sessionId
                    : 'session-' + e.sessionId
                  if (entrySessionId !== normalizedSessionId) return false
                }
                return true
              })
            setEntries(list)
            setNow(Date.now())
          }).catch(() => {})
        }
        load()
        const timer = setInterval(() => { if (!document.hidden) load() }, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      const [hasChat, setHasChat] = useState(false)
      useEffect(() => {
        let alive = true
        const load = () => call('/state').then((d) => {
          if (!alive) return
          const hist = (d.state && d.state.delegations) || {}
          setHasChat(Boolean(sessionId && hist[sessionId] && (hist[sessionId].entries || []).length))
        }).catch(() => {})
        load()
        const timer = setInterval(() => { if (!document.hidden) load() }, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      const [chatOpen, setChatOpen] = useState(chatActive.value)
      useEffect(() => {
        const handler = () => setChatOpen(chatActive.value)
        chatActiveListeners.add(handler)
        handler()
        return () => chatActiveListeners.delete(handler)
      }, [])

      const jumpChip = hasChat && chatOpen ? h('span', {
        onClick: requestLatestJump,
        title: '跳到群聊最后一轮',
        style: {
          cursor: 'pointer', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
          background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      }, '回到最新 ↓') : null
      if (!entries.length) return jumpChip ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '0 8px 6px' } }, jumpChip) : null

      // 每条进行中的派活一行（并行的多次 delegate 各占一行），互相独立
      // setRowStopped 必须在 CouncilProgress 作用域里建（闭包到 setEntries）再传给行，
      // 否则 progressRow 是模块级函数、看不到 setEntries → 点「停止」直接 ReferenceError。
      const setRowStopped = (target) => (value) => {
        setEntries((prev) => prev.map((e) => (e === target ? Object.assign({}, e, { stoppedAt: value }) : e)))
      }
      const rows = entries.map((entry, idx) => progressRow(entry, now, idx, setRowStopped(entry)))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, rows, jumpChip
        ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '0 8px 6px' } }, jumpChip)
        : null)
    }

    /** 一条进度行：小组 + 秒数 + 成员芯片（带任务摘要）+ 停止。 */
    function progressRow(entry, now, rowIndex, setRowStopped) {
      const stageEntry = entry.members ? entry.members.__stage__ : null
      const members = Object.keys(entry.members || {}).filter((id) => id !== '__stage__').map((id) => entry.members[id])
      const total = entry.startedAt ? Math.round((now - entry.startedAt) / 1000) : null
      // 没有真成员时：指挥占位阶段优先（拆解中/派活中）；再没有就看等了多久——超过 90s
      // 说明卡在选成员或子代理启动，别再只说「准备中」。
      const waited = total === null ? 0 : total
      const waiting = total !== null && waited > 90
      // 无成员且已经跑了 5 分钟以上：外部腿（codex/claude）只在结束时回报，
      // 成员槽还没出现不等于卡住，补一句说明，别让人以为进度条没了。
      const longTask = members.length === 0 && total !== null && total > 300
      const idleText = (stageEntry
        ? (stageEntry.name || '指挥') + ' · ' + (stageEntry.stage || '处理中') + (waiting ? '（等待成员…）' : '')
        : (waiting ? '等待成员…（' + waited + 's）' : '准备中…'))
        + (longTask ? '（长任务，成员仅在结束时回报）' : '')
      return h('div', {
        key: entry.callId || rowIndex,
        // 2026-11-17 用户要求：视觉上并进输入框，不再做成独立气泡。
        // 做法：去圆角、只留上边框、横向贴边——上方与内容区相接，下方紧贴输入框。
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0',
          padding: '5px 12px', borderRadius: 0, fontSize: 12,
          background: 'transparent',
          borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('span', { style: { fontWeight: 600, opacity: 0.75 } }, '小组'),
      h('span', { style: styles.muted }, total === null ? '' : total + 's'),
      members.length
        ? members.map((m, i) => h('span', {
          key: i,
          style: Object.assign({}, styles.chip, { display: 'inline-flex', alignItems: 'center', gap: 4 }),
          title: [m.name || '成员', m.stage || '', (m.task || '')].filter(Boolean).join(' · '),
        },
          (m.name || '成员') + ' · ' + (m.stage || '…')
          + taskSuffix(m)
          + (m.finishedAt ? '' : '')
          + silenceSuffix(m),
          // 2026-11-17：单个成员的 ✕ 已移进「进行中」卡片，这里只显示状态
          null))
        : h('span', { style: styles.muted }, idleText),
      // 2026-11-17 用户要求：「停止本轮」已移进「进行中」卡片
      h('span', { style: { flex: 1 } }))
    }

    /** 本地绝对路径 → 插件文件端点 URL（只读、限制在 HOME /tmp 下）。 */
    function fileUrl(abs) {
      const s = String(abs || '')
      // 2026-11-17 修：回执里的链接有两种形态——
      //   · 本地绝对路径 /home/nanami/.dsh/storages/council-images/x.png → 需要包成 /file?path=
      //   · 已经是插件 URL /council/api/image/x.png → **原样返回**
      // 之前无条件包一层，导致所有 /council/api/image/*.png 被当成磁盘路径 → 403。
      if (s.startsWith('/council/api/') || /^https?:\/\//i.test(s)) return s
      return '/council/api/file?path=' + encodeURIComponent(s)
    }

    /** 这个路径是什么媒体类型（用于决定 <img> / <audio> / 链接）。 */
    function mediaKindOf(abs) {
      const p = String(abs || '').toLowerCase()
      if (/\.(png|jpe?g|webp|gif|svg|bmp)$/.test(p)) return 'image'
      if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(p)) return 'audio'
      if (/\.(mp4|webm)$/.test(p)) return 'video'
      return 'file'
    }

    /**
     * 把一段回执文本切成「纯文本 / 媒体」片段，媒体片段渲染成可看图、可播放的元素。
     * 处理的 markdown 形态：![alt](path) 和 [label](path)；path 必须是绝对本地路径。
     */
    function renderReceiptParts(text) {
      const out = []
      const re = /!?\[([^\]]*)\]\((\/[^)\s]+)\)/g
      let last = 0
      let m
      let i = 0
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
        const label = m[1] || ''
        const abs = m[2]
        const media = mediaKindOf(abs)
        out.push({ kind: media, label, path: abs, key: 'md' + (i += 1) })
        last = m.index + m[0].length
      }
      if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
      return out.length ? out : [{ kind: 'text', text }]
    }

    /**
     * 把成员/审校的**机器回执**变成人话（2026-11-16 用户要求：不要显示 {"passed":true,...}）。
     *
     * 成员常按提示词在结尾吐一个 JSON：{"passed":true,"reason":"...","issues":[]}。
     * 原样显示既丑又占地方，这里解析成「✓ 通过 · 原因」；解析失败就标注「（结构化回执已隐藏）」。
     * 没有 JSON 的文本原样返回。
     */
    function humanizeReceipt(text) {
      let out = String(text || '')
      // ① fenced code block
      out = out.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (match, body) => {
        const human = judgeToHuman(body)
        return human == null ? '（结构化回执已隐藏）' : human
      })
      // ② 裸 JSON（整行就是一个对象，且带 passed/ok/verdict 之类字段）
      out = out.replace(/^\s*(\{[\s\S]*\})\s*$/gm, (match, body) => {
        if (!/"(passed|ok|verdict|approved)"\s*:/.test(body)) return match
        const human = judgeToHuman(body)
        return human == null ? '（结构化回执已隐藏）' : human
      })
      return out.replace(/\n{3,}/g, '\n\n').trim()
    }

    /** 解析一条审校 JSON → 人话；不是审校对象或解析失败返回 null。 */
    function judgeToHuman(body) {
      try {
        const obj = JSON.parse(body)
        const verdict = obj.passed !== undefined ? obj.passed : (obj.ok !== undefined ? obj.ok : obj.approved)
        if (verdict === undefined) return null
        const reason = String(obj.reason || obj.note || '').replace(/\s+/g, ' ').trim()
        const issues = Array.isArray(obj.issues) ? obj.issues.filter(Boolean) : []
        let line = verdict ? '✓ 通过' : '✗ 不通过'
        if (reason) line += ' · ' + reason
        if (issues.length) line += '\n问题：' + issues.slice(0, 3).join('；')
        return line
      } catch {
        return null
      }
    }

    /** 成员芯片上的「正在做什么」：取服务端下发的 task（已压成一行、60 字内），只显示前 24 字。 */
    function taskSuffix(member) {
      const task = member && typeof member.task === 'string' ? member.task.trim() : ''
      if (!task) return ''
      return ' · ' + (task.length > 24 ? task.slice(0, 24) + '…' : task)
    }


    /**
     * 已知「绑定了小组」的会话 id 集合（2026-11-16）。
     *
     * 用途：单人会话切过来时，**团队视图要直接不渲染**——只藏 tab 不够，
     * 因为 DSH 会先把内容画出来（用户看到「折叠列表展开又消失」的那 1 秒就是这个）。
     * `null` 表示还没加载过 state（未知），此时不拦截，避免刚开始把小组会话也挡掉。
     */
    var lastTabSessionId = null   // 上一次应用 tab 可见性时的 sessionId（区分「切会话」和「建组」）
    var groupSessionSet = null   // var：声明在组件之后，let 会 TDZ（2026-11-16 第四次踩）

    /** 从 /state 的返回里刷新集合。 */
    function refreshGroupSessionSet(stateLike) {
      try {
        // 无效输入（拿不到 state）时**保持 null（未知）**，不要误设成空集——
        // 空集意味着「所有会话都没小组」，会把小组会话也挡掉（测试桩踩过）。
        if (!stateLike || !Array.isArray(stateLike.groups)) return
        const groups = stateLike.groups
        const next = new Set()
        for (const g of groups) {
          if (g && g.sessionId && !g.archived) next.add(String(g.sessionId))
        }
        groupSessionSet = next
      } catch { /* ignore */ }
    }

    /** 这个会话有没有小组？unknown 返回 null（表示还不知道）。 */
    function sessionHasGroup(sessionId) {
      if (!groupSessionSet) return null
      if (!sessionId) return null
      const sid = String(sessionId)
      if (groupSessionSet.has(sid)) return true
      const bare = sid.replace(/^session-/, '')
      if (groupSessionSet.has(bare)) return true
      // 反向：集合里存的是带前缀的，传入的是裸 id
      if (groupSessionSet.has('session-' + bare)) return true
      return false
    }

    /* ── 团队群聊（v0.4 P2）：微信式时间线 ─────────────────────────────
     * 用户 / 指挥 / 成员回执混在一条时间线里：用户靠右，其余靠左带头像。
     * 数据来自 `/team/state.messages`：
     *   {role:'user'}      你说的
     *   {role:'assistant'} 指挥（大脑）的回复
     *   {role:'member'}    成员回执（带 name/kind/model/image/审校结论）
     * 输入区固定在底部：发出去的消息由 Host 转给指挥，指挥拆解→派活→回执回流。
     */
    function CouncilChatView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      // 单人会话（明确知道没绑小组）→ **不渲染团队内容**。
      // 只藏 tab 不够：DSH 会先画内容，用户能看到 1 秒的「折叠列表」再消失。
      const hasGroup = sessionHasGroup(sessionId)
      // 明确没有小组 → 完全不渲染（连提示都不要，这是单人会话，切过来不该看到小组界面）
      if (hasGroup === false) return null
      // 还不知道（刚刷新页面 / 集合未就绪）→ **正常渲染**，别返回空占位：
      // 空占位会让用户看到 1 秒空白再出内容（2026-11-16 实测）。
      // 「单人会话不该看到小组空态卡片」这件事，由下面空态分支自己判断（hasGroupUnknown）。
      const hasGroupUnknown = hasGroup === null
      const [team, setTeam] = useState(null)
      const [providers, setProviders] = useState(null)
      const [model, setModel] = useState('')
      const [draft, setDraft] = useState('')
      const [streamText, setStreamText] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const scrollerRef = useRef(null)
      const esRef = useRef(null)
      // 进行中的执行步骤（DSH 风格）：{callId: {members: {id: {name, stage, silentMs, stageAgeMs}}}}
      const [progress, setProgress] = useState(null)
      // 长回执的展开状态（key → true 表示已展开）
      const [expandedSet, setExpandedSet] = useState({})
      // 「跳到最新」按钮：**不走 React state**（DSH 的 setState 不触发重渲染，
      // 2026-11-16 实测：状态改了但按钮不出现）。直接拿 DOM 引用改 display。
      const jumpBtnRef = useRef(null)
      // 首次进入团队 tab 是否已经滚到底
      const didInitScrollRef = useRef(false)
      // 切到团队 tab 时组件不会重新挂载，effect 的依赖也不会变 —— 用轮询探测
      // 「scroller 现在可见了、还停在顶部」这个状态，然后一次性滚到底（300ms × 12 次）。
      useEffect(() => {
        let tries = 0
        const timer = setInterval(() => {
          tries += 1
          const node = scrollerRef.current
          if (node && node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 20) {
            if (node.scrollTop < 10) node.scrollTop = node.scrollHeight
            clearInterval(timer)
            return
          }
          if (tries > 12) clearInterval(timer)
        }, 300)
        return () => clearInterval(timer)
      }, [sessionId])
      useEffect(() => {
        const node = scrollerRef.current
        if (!node || typeof node.addEventListener !== 'function') return undefined
        const sync = () => {
          const btn = jumpBtnRef.current
          if (!btn) return
          const near = node.scrollHeight - node.scrollTop - node.clientHeight < 80
          btn.style.display = near ? 'none' : 'inline-flex'
        }
        node.addEventListener('scroll', sync, { passive: true })
        const timer = setTimeout(sync, 300)
        return () => {
          node.removeEventListener('scroll', sync)
          clearTimeout(timer)
        }
      }, [sessionId])

      const refreshTeam = () => {
        if (!sessionId) return
        call('/team/state?sessionId=' + encodeURIComponent(sessionId))
          .then((d) => {
            setTeam(d)
            if (d && d.model) setModel(d.model)
            // 能拉到 → 这个会话确实有小组，补进集合
            if (groupSessionSet && !groupSessionSet.has(String(sessionId))) {
              groupSessionSet.add(String(sessionId))
            }
          })
          .catch(() => { /* 未绑定小组时 400，忽略 */ })
      }

      useEffect(() => {
        refreshTeam()
        // 只在**还没拿到过**时拉一次：/state 的 JSON 很大（所有组/成员/角色），
        // 每次切会话都拉会跟会话内容抢带宽，用户会看到对话延迟一秒才出来（2026-11-16 实测）。
        if (!groupSessionSet) call('/state').then((data) => refreshGroupSessionSet(data && data.state)).catch(() => {})
        call('/providers').then((d) => setProviders((d && d.providers) || [])).catch(() => setProviders(null))
        let alive = true
        // 1 秒轮询：用户发完消息要立刻在团队页看到（2026-11-16 用户反馈 3 秒太慢）。
        // 服务端读日志有 mtime+size 缓存，文件没变时不会重复解压，1 秒一轮开销可接受。
        // 单人会话（已知没绑组）不必轮询：/team/state 只会一直 400，白占连接。
        const timer = sessionHasGroup(sessionId) === false
          ? null
          : setInterval(() => { if (alive && !document.hidden) refreshTeam() }, 1000)
        // 进行中的「步骤」：/progress 里有每个成员的 stage / 静默时长（DSH 风格的执行步骤）
        const refreshProgress = () => {
          call('/progress?sessionId=' + encodeURIComponent(sessionId))
            .then((d) => { if (alive) setProgress((d && d.progress) || null) })
            .catch(() => { /* 没有进行中的任务就忽略 */ })
        }
        refreshProgress()
        const ptimer = setInterval(() => { if (alive && !document.hidden) refreshProgress() }, 1500)
        return () => { alive = false; if (timer) clearInterval(timer); clearInterval(ptimer) }
      }, [sessionId])

      const messages = (team && team.messages) || []
      // 反馈（2026-11-16 用户反馈「发完 30 秒没动静，以为卡住」）：
      // 最后一条是用户消息且已过 3 秒还没回复 → 明确显示"正在处理"，别让人干等。
      const lastMsg = messages.length ? messages[messages.length - 1] : null

      // 新消息到达 → 贴着底部；**首次进入 / 切回团队 tab 时直接跳到结尾**
      // （2026-11-16 用户反馈：从别的 tab 切过来总是停在会话开头，每次都得点「最新」）
      useEffect(() => {
        const node = scrollerRef.current
        if (!node) return
        if (!didInitScrollRef.current) {
          didInitScrollRef.current = true
          // 首次：不等动画，直接到底（内容刚挂载，smooth 反而会看到一段滚动过程）
          node.scrollTop = node.scrollHeight
          return
        }
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
        if (nearBottom && typeof node.scrollTo === 'function') {
          try { node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }) } catch { node.scrollTop = node.scrollHeight }
        }
      }, [messages.length, streamText])

      const brainModels = (() => {
        const out = []
        for (const p of (providers || [])) {
          for (const m of (p.models || [])) {
            const s = String(m || '')
            if (s.startsWith('gpt-image')) continue
            if (!/^(claude|gpt|o\d|deepseek|gemini)/i.test(s)) continue
            if (out.indexOf(s) >= 0) continue
            out.push(s)
          }
        }
        return out
      })()

      const stopStream = () => {
        try { if (esRef.current) esRef.current.close() } catch { /* ignore */ }
        esRef.current = null
      }

      const pickModel = async (next) => {
        setModel(next)
        if (!sessionId || !next) return
        try { await call('/team/model', { sessionId, model: next }) } catch (e) { setNote(String(e.message || e)) }
      }

      const send = async () => {
        const text = draft.trim()
        if (!text || !sessionId || busy) return
        setDraft('')
        setStreamText('')
        setNote('')
        setBusy(true)
        try {
          const r = await call('/team/send', { sessionId, model: model || undefined, text })
          const runId = r && r.runId
          if (!runId) throw new Error((r && r.error) || '没有拿到 runId')
          if (typeof EventSource === 'function') {
            stopStream()
            const es = new EventSource('/council/api/team/stream?runId=' + encodeURIComponent(runId))
            esRef.current = es
            es.addEventListener('delta', (event) => {
              try {
                const data = JSON.parse(event.data)
                if (data && data.text) setStreamText((prev) => prev + data.text)
              } catch { /* ignore */ }
            })
            const finish = () => { stopStream(); setBusy(false); setStreamText(''); refreshTeam() }
            es.addEventListener('done', finish)
            es.addEventListener('error', (event) => {
              let msg = '出错'
              try { const data = JSON.parse(event.data); if (data && data.error) msg = data.error } catch { /* ignore */ }
              setNote(msg)
              finish()
            })
          } else {
            setNote('当前环境不支持 SSE 流式渲染')
            setBusy(false)
          }
        } catch (error) {
          setNote(String((error && error.message) || error))
          setBusy(false)
        }
      }

      const stop = async () => {
        const runId = ((team && team.runIds) || [])[0]
        stopStream()
        setBusy(false)
        if (!runId) return
        try { await call('/team/stop', { runId }) } catch { /* ignore */ }
        refreshTeam()
      }

      const running = Boolean(team && team.running) || busy
      // 进行中的步骤（DSH 风格）：把所有 callId 下的阶段摊平成一行一条
      const activeSteps = (() => {
        if (!progress) return []
        const rows = []
        for (const callId of Object.keys(progress)) {
          const entry = progress[callId] || {}
          const members = entry.members || {}
          for (const id of Object.keys(members)) {
            const m = members[id] || {}
            if (id === '__stage__' || m.stageOnly) continue
            if (!m.name) continue
            rows.push({
              name: m.name,
              stage: m.stage || '执行中',
              silentMs: Number(m.silentMs) || 0,
              stageAgeMs: Number(m.stageAgeMs) || 0,
            })
          }
        }
        return rows
      })()
      const fmtSec = (ms) => {
        const s2 = Math.max(0, Math.round((Number(ms) || 0) / 1000))
        return s2 < 60 ? s2 + 's' : Math.floor(s2 / 60) + 'm' + (s2 % 60) + 's'
      }

      // 反馈：最后一条是你、且过了 3 秒还没回复 → 显示「指挥正在处理…」（必须放在 running 之后，否则 TDZ）
      const lastMsgForWait = messages.length ? messages[messages.length - 1] : null
      const waitMs = lastMsgForWait ? Date.now() - (Number(lastMsgForWait.at) || 0) : 0
      const waitingForCommander = Boolean(
        lastMsgForWait && lastMsgForWait.role === 'user' && !running && !streamText && waitMs > 3000,
      )
      // 超过 2 分钟还没有任何回应 → 大概率是 turn 被打断（服务重启/崩溃），
      // 不能让「正在拆解…」无限计时（2026-11-16 用户看到 7m43s 以为卡死）。
      const waitStalled = waitingForCommander && waitMs > 120000
      // 指挥气泡的头像种类：按 brainKind 推断
      const brainKind = team && team.brainKind === 'codex' ? 'codex'
        : team && team.brainKind === 'dsh-seam' ? 'deepseek'
          : team && team.brainKind === 'gemini-cli' ? 'codex'
            : 'claude'

      const bubble = (m, key) => {
        const isUser = m.role === 'user'
        const isMember = m.role === 'member'
        const kind = isMember ? (m.kind || 'deepseek') : brainKind
        const who = isUser ? '你' : (isMember ? (m.name || '成员') : '指挥')
        // 派单那一行：直派 / 指挥拆解 用不同标签（2026-11-16 用户要求区分）
        const planTag = m.plan ? (m.direct ? '直派' : '指挥拆解') : null
        const sub = isMember
          ? [m.name || '成员', m.kind, m.model].filter(Boolean).join(' · ')
          : (isUser ? '你' : (planTag ? planTag + ' · ' + (m.name || '指挥') : '指挥 · ' + (model || (team && team.model) || '')))
        const verdictLine = isMember && (m.reviewOk !== null || m.commanderOk !== null)
          ? [
            m.reviewOk === true ? '审校：通过' : m.reviewOk === false ? '审校：不通过' : null,
            m.commanderOk === true ? '指挥审核：通过' : m.commanderOk === false ? '指挥审核：不通过' : null,
          ].filter(Boolean).join(' · ')
          : ''
        const reasons = isMember
          ? [m.reviewReason, m.commanderReason].filter(Boolean).join(' / ')
          : ''
        return h('div', {
          key,
          style: {
            display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10,
            flexDirection: isUser ? 'row-reverse' : 'row',
            maxWidth: '92%', alignSelf: isUser ? 'flex-end' : 'flex-start',
          },
        },
        isUser ? null : h(Avatar, { kind, name: who }),
        h('div', { style: Object.assign({}, styles.bubble, isUser ? styles.mine : {}, { flex: 1, minWidth: 0 }) },
          h('div', { style: styles.who }, sub + ' · ' + new Date(m.at || Date.now()).toLocaleTimeString()),
          (() => {
            const raw = String(m.text || '')
            const full = humanizeReceipt(raw)
            const long = full.length > 260 && !isUser
            const textStyle = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
            // 长回执：前面给 260 字预览，后面用原生 <details> 展开全文。
            // 之前用 useState 控制折叠，DSH 的 hooks 桩不可靠 → 点了没反应（2026-11-16 用户反馈）。
            const parts = renderReceiptParts(full)
            const renderParts = (list, prefix) => list.map((p, idx) => {
              if (p.kind === 'text') return h('span', { key: prefix + 't' + idx, style: textStyle }, p.text)
              const url = fileUrl(p.path)
              if (p.kind === 'image') {
                return h('img', {
                  key: prefix + 'i' + idx,
                  src: url,
                  alt: p.label || '产出图片',
                  title: '点击查看大图：' + p.path,
                  onClick: () => { try { window.open(url, '_blank') } catch { /* ignore */ } },
                  style: { display: 'block', maxWidth: 360, maxHeight: 240, marginTop: 6, borderRadius: 8, cursor: 'zoom-in', border: '1px solid var(--dsw-alias-border-l1)' },
                })
              }
              if (p.kind === 'audio') {
                return h('audio', {
                  key: prefix + 'a' + idx,
                  controls: true,
                  src: url,
                  style: { display: 'block', width: '100%', marginTop: 6 },
                })
              }
              if (p.kind === 'video') {
                return h('video', {
                  key: prefix + 'v' + idx,
                  controls: true,
                  src: url,
                  style: { display: 'block', maxWidth: 420, marginTop: 6, borderRadius: 8 },
                })
              }
              return h('a', {
                key: prefix + 'f' + idx,
                href: url,
                target: '_blank',
                rel: 'noreferrer',
                style: Object.assign({}, styles.linkButton, { fontSize: 12 }),
              }, (p.label || p.path.split('/').pop()) + ' ↗')
            })
            if (!long) return h('div', null, renderParts(parts, 'a'))
            return h('div', null,
              h('div', { style: textStyle }, full.slice(0, 260) + '…'),
              h('details', { style: { marginTop: 4 } },
                h('summary', { style: Object.assign({}, styles.linkButton, { fontSize: 11, cursor: 'pointer', opacity: 0.75 }) }, '展开全部'),
                h('div', { style: Object.assign({}, textStyle, { marginTop: 6, opacity: 0.95 }) }, renderParts(parts, 'b'))))
          })(),
          m.image ? h('img', {
            src: m.image, alt: 'member output',
            style: { display: 'block', maxWidth: 360, marginTop: 6, borderRadius: 8 },
          }) : null,
          verdictLine ? h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, verdictLine) : null,
          reasons ? h('div', { style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', opacity: 0.85 } }, reasons) : null))
      }

      /**
       * 按「轮」分组渲染（2026-11-16 用户要求）：
       * 一轮 = 你的一句话 + 指挥拆解 + 若干成员回执 + 指挥汇总，往往很长。
       * 折叠后只露一行摘要（你的话前 30 字 + 几条消息），点开才看细节。
       * 用原生 <details>，不依赖 React state。
       */
      const renderRounds = (list) => {
        const rounds = []
        let cur = null
        list.forEach((m, i) => {
          if (m.role === 'user' || !cur) {
            cur = { key: 'round' + i, head: m.role === 'user' ? m : null, items: [] }
            rounds.push(cur)
          }
          cur.items.push({ m, i })
        })
        return rounds.map((round, ridx) => {
          const headText = round.head ? String(round.head.text || '').replace(/\s+/g, ' ').trim() : ''
          const title = headText ? (headText.length > 34 ? headText.slice(0, 34) + '…' : headText) : '（无标题）'
          const memberCount = round.items.filter((it) => it.m.role === 'member').length
          // ── 交付物与状态（2026-11-16 用户要求：折叠摘要里就能看出做了什么、成没成）
          const lastMember = round.items.filter((it) => it.m.role === 'member').pop()
          const lastText = lastMember ? String(lastMember.m.text || '') : ''
          let roundThumb = ''
          if (lastMember && lastMember.m.image) roundThumb = String(lastMember.m.image)
          if (!roundThumb) {
            // 回执里的 ![alt](/abs/path.png) 或 [label](/abs/path.png)
            const mImg = /!?\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|webp|gif|bmp|svg))\)/i.exec(lastText)
            if (mImg) roundThumb = fileUrl(mImg[1])
          }
          let roundFile = ''
          if (!roundThumb) {
            const mFile = /\[[^\]]*\]\(([^)\s]+\.(?:glb|gltf|obj|stl|fbx|mp3|wav|ogg|flac|mp4|webm|pdf|py|js|ts|json|md|csv|zip))\b/i.exec(lastText)
            if (mFile) roundFile = String(mFile[1]).split('/').pop()
          }
          let roundStatus = null
          if (lastMember) {
            const acc = String(lastMember.m.acceptance || '')
            const selfOk = lastMember.m.reviewOk
            const cmdOk = lastMember.m.commanderOk
            if (acc === 'passed' || (selfOk === true && cmdOk === true)) roundStatus = { ok: true, text: '完成' }
            else if (acc === 'rejected' || selfOk === false || cmdOk === false) roundStatus = { ok: false, text: '未通过' }
            else if (acc === 'rework-failed') roundStatus = { ok: false, text: '返工失败' }
            else if (acc === 'unverified') roundStatus = { ok: false, text: '未判定' }
            else if (lastMember.m.error) roundStatus = { ok: false, text: '失败' }
            else roundStatus = { ok: true, text: '完成' }
          }
          const meta = round.items.length + ' 条' + (memberCount ? ' · ' + memberCount + ' 个成员' : '')
          // 最后一轮默认展开（你正在看的这轮），历史轮折叠
          const isLast = ridx === rounds.length - 1
          return h('details', {
            key: round.key,
            open: isLast,
            // 2026-11-17：给**轮次折叠**打标记。页面里还有另一种 <details>（成员回执的
            // 「展开全部」），不加标记的话「折叠本轮」按钮会选错对象。
            'data-council-round': '1',
            style: { marginTop: 10, borderTop: ridx === 0 ? 'none' : '1px solid var(--dsw-alias-border-l1)', paddingTop: ridx === 0 ? 0 : 8 },
          },
          h('summary', {
            style: {
              cursor: 'pointer', userSelect: 'none', fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            },
          },
          // 交付物缩略图（有图时）
          roundThumb
            ? h('img', {
              src: roundThumb,
              alt: '交付物',
              title: '点击查看大图',
              onClick: (e) => { e.preventDefault(); try { window.open(roundThumb, '_blank') } catch { /* ignore */ } },
              style: { width: 34, height: 34, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1)', flexShrink: 0, cursor: 'zoom-in' },
            })
            : null,
          h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
          // 状态徽章
          roundStatus
            ? h('span', {
              style: {
                fontSize: 10, padding: '1px 6px', borderRadius: 999, flexShrink: 0,
                border: '1px solid var(--dsw-alias-border-l1)',
                color: roundStatus.ok ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-state-error-primary)',
                opacity: 0.9,
              },
            }, roundStatus.text)
            : null,
          // 交付文件（非图片产出的路径）
          roundFile
            ? h('span', { style: { opacity: 0.75, fontFamily: 'monospace', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, roundFile)
            : null,
          h('span', { style: { opacity: 0.6 } }, meta)),
          h('div', null, round.items.map((it) => bubble(it.m, 'm' + it.i))))
        })
      }

      return h('div', {
        style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 8, overflow: 'hidden' },
      },
      /* 工具栏 */
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: '0 0 auto' } },
        // 2026-11-17 用户要求：删掉「团队 / N 条消息 / 指挥模型在小组页改」这两行，
        // 只保留运行时的「停止」按钮（没有就在右侧留白）
        h('span', { style: { flex: 1 } }),
        running ? h(Button, { onClick: stop }, '停止') : null),
      /* 时间线 */
      h('div', {
        ref: (node) => { scrollerRef.current = node },
        'data-council-scroller': '1',
        // ⚠️ 必须给一个真实的高度上限：DSH 的 view 容器不是完整的 flex 链，
        // 只写 flex:1 会让这个列表被内容撑开（实测 scrollHeight===clientHeight=3738，
        // 根本没有内部滚动条 → 「跳到最新」无处可跳）。
        style: { flex: '1 1 auto', minHeight: 0, maxHeight: 'calc(100vh - 230px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', paddingRight: 4 },
      },
      messages.length || streamText
        ? renderRounds(messages).concat(
          streamText
            ? [h('div', {
              key: 'streaming',
              style: { display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, maxWidth: '92%' },
            },
            h(Avatar, { kind: brainKind, name: '指挥' }),
            h('div', { style: Object.assign({}, styles.bubble, { flex: 1, minWidth: 0, opacity: 0.92 }) },
              h('div', { style: styles.who }, '指挥 · 生成中'),
              h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, streamText)))]
            : ((activeSteps.length || waitingForCommander) ? [h('div', {
              key: 'steps',
              style: Object.assign({}, styles.card, { marginTop: 10, padding: '8px 10px', maxWidth: '92%' }),
            },
            h('div', { style: { fontSize: 11, opacity: 0.7, marginBottom: 6, letterSpacing: 0.3 } },
              (running ? '● ' : '') + '进行中'),
            // 有成员阶段 → 逐条列出（DSH 风格的执行步骤）
            activeSteps.length
              ? activeSteps.map((st, i) => h('div', {
                key: 'st' + i,
                style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0' },
              },
              h('span', { style: { color: 'var(--dsw-alias-brand-primary)', fontSize: 10 } }, '●'),
              h('span', { style: { fontWeight: 600, minWidth: 48 } }, st.name),
              h('span', { style: { opacity: 0.8, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st.stage),
              h('span', { style: { opacity: 0.55, fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, fmtSec(st.silentMs))))
              // 还没进入成员阶段 → 说明指挥在校解，给一句更具体的话
              : [h('div', { key: 'decompose', style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                h('span', { style: { color: 'var(--dsw-alias-brand-primary)', fontSize: 10 } }, '●'),
                h('span', { style: { fontWeight: 600, minWidth: 48 } }, '指挥'),
                h('span', { style: { opacity: 0.8 } }, waitStalled ? '没有响应（可能被打断了）' : '正在拆解任务、挑选成员…'),
                h('span', { style: { opacity: 0.55, fontSize: 11 } }, fmtSec(Date.now() - (Number(lastMsg && lastMsg.at) || Date.now()))))])] : []))
        : h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 8 } },
          // 单人模式（或还没绑定小组）时给明确入口。
          // 注：DSH 的 conversation.view 只暴露 id/label，没有条件隐藏，所以这个 tab
          // 在单人模式下仍然存在；这里用引导卡片替代"消失"，避免用户进来看到空白。
          // 还不知道有没有小组时不要给「点右上角胶囊」这种误导提示（单人会话切过来会闪）
          hasGroupUnknown
            ? null
            : h('div', null,
              h('div', { style: { fontSize: 14, fontWeight: 600 } },
                team ? '还没有对话' : '这个会话没有绑定小组'),
              h('div', { style: styles.muted },
                team
                  ? '用底部对话框说话，指挥会拆解后派给成员。'
                  : '点右上角胶囊切到「小组」即可开始。')))),
      note ? h('div', { style: Object.assign({}, styles.muted, { color: 'var(--dsw-alias-state-error-primary)', flex: '0 0 auto' }) }, note) : null,
      // 「折叠本轮」（2026-11-17 用户要求）：一轮消息太长时，折叠键在轮次顶部、滚不上去。
      // 这里给一个常驻按钮，折叠**最新一轮**（最后一个 <details>）。
      //
      // ⚠️ 两个坑都踩过：
      //  ① 不能用 ref 拿按钮节点（DSH 的 ref 不一定绑得上）→ 用 data-* 定位；
      //  ② 直接赋 `details.open` 可能被 React 的受控属性覆盖 → **模拟点 summary**，
      //     这等于用户自己点了折叠键，一定生效。
      h('div', {
        key: 'collapse-latest',
        'data-council-collapse': '1',
        title: '折叠 / 展开最新一轮',
        onClick: () => {
          try {
            const scroller = document.querySelector('[data-council-scroller]')
            if (!scroller) return
            // ⚠️ 只选**轮次级** details（带 data-council-round）；
            // 页面里还有成员回执的「展开全部」details，混在一起会折叠错对象。
            const list = scroller.querySelectorAll('details[data-council-round]')
            if (!list.length) return
            const last = list[list.length - 1]
            const summary = last.querySelector('summary')
            if (summary) summary.click()          // ← 模拟用户点折叠键
            else last.open = !last.open           // 兜底
            const btn = document.querySelector('[data-council-collapse]')
            if (btn) btn.textContent = last.open ? '⊟ 折叠本轮' : '⊞ 展开本轮'
          } catch { /* ignore */ }
        },
        style: {
          position: 'absolute', right: 18, bottom: 104, zIndex: 5,
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l1)',
          boxShadow: '0 2px 10px rgba(0,0,0,.2)',
          opacity: 0.94,
        },
      }, '⊟ 折叠本轮'),
      // 「跳到最新」：常驻 DOM，靠上面的原生滚动监听切 display；点击**平滑滚动**（不是瞬移）
      h('div', {
        key: 'jump-latest',
        ref: (node) => { jumpBtnRef.current = node },
        title: '跳到最新消息',
        onClick: () => {
          const node = scrollerRef.current
          if (!node) return
          try { node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' }) } catch { node.scrollTop = node.scrollHeight }
          if (jumpBtnRef.current) jumpBtnRef.current.style.display = 'none'
        },
        style: {
          position: 'absolute', right: 18, bottom: 64, zIndex: 5,
          display: 'none', alignItems: 'center', gap: 4,
          padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
          background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 2px 10px rgba(0,0,0,.28)',
          transition: 'opacity .15s ease, transform .15s ease',
          opacity: 0.94,
        },
      }, '↓ 最新'),
      /* 不再有独立输入框：小组模式下**直接用原生对话框**（对话页底部那个），
       * 主会话只负责把用户原话转给指挥。这里只留一句说明 + 停止按钮。 */
      running ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' } },
        h(Button, { onClick: stop }, '停止')) : null)
    }

    /* ── 按模式显示 tab（v0.4.17）──────────────────────────────────────
     * 背景：用户要求「单人模式只显示 对话/轨迹，小组模式才有 团队/小组」。
     * DSH 的 conversation.view 注册项只投影成 {id, label}，**没有可见性谓词**，
     * 插件 apply 层也拿不到"当前会话"——所以没法从 slot 层条件注册。
     *
     * 但 tab 在 DOM 里是可预测的：[data-conversation-tabs] 下的 button[role=tab]。
     * 这里按**标签文字**找到「团队 / 小组」两个 tab，单人模式下 display:none。
     * 不改 DSH 源码；若 DSH 改动 tab 的 DOM 结构，这段会失效（但功能不受影响，
     * 只是 tab 又常驻了）。
     */
    // 注意：这两个变量声明位于 return {} 之后（DSH 只认 return 出去的对象），
    // 用 var 而不是 let —— let 在模块顶层那段不可达代码里初始化，会 TDZ 报
    // "Cannot access before initialization"；var 会提升成 undefined，逻辑本身能跑。
    var councilSoloMode = false
    var tabWatchTimer = null
    /**
     * 切会话后**持续**确保「有可见的 tab 被选中」。
     *
     * DSH 把 tab 设成 display:none 之后会把选中态清空，内容区就不知道显示什么（空白）。
     * 单次 click 不可靠：effect 只触发一次、还可能被 tabSwitching 锁挡住。
     * 所以在这里短时轮询（200ms × 10 次 = 2 秒），发现「可见 tab 全没选中」就补一次。
     */
    var ensureSelectedTimer = null
    function ensureTabSelected() {
      if (ensureSelectedTimer) return
      let tries = 0
      const tick = () => {
        tries += 1
        try {
          const list = document.querySelector('[data-conversation-tabs]')
          if (!list) return
          const visible = Array.prototype.slice.call(list.querySelectorAll('button[role="tab"]'))
            .filter((b) => b.style.display !== 'none')
          if (!visible.length) return
          const picked = visible.some((b) => b.getAttribute('aria-selected') === 'true')
          if (!picked) { try { visible[0].click() } catch { /* ignore */ } }
          else if (ensureSelectedTimer) { clearInterval(ensureSelectedTimer); ensureSelectedTimer = null }
        } catch { /* ignore */ }
        if (tries >= 14 && ensureSelectedTimer) { clearInterval(ensureSelectedTimer); ensureSelectedTimer = null }
      }
      tick()                                    // 先立刻补一次（0ms 窗口）
      ensureSelectedTimer = setInterval(tick, 120)
      try { ensureSelectedTimer.unref && ensureSelectedTimer.unref() } catch { /* ignore */ }
    }

    var tabSwitching = false   // 正在切视图（防 click 重入）

    function applyTabVisibility(solo, why) {
      councilSoloMode = Boolean(solo)
      // 调试：浏览器控制台执行 window.__councilTabDebug = true 即可看到每次调用来源
      try {
        if (window.__councilTabDebug) {
          const stack = String(new Error().stack || '').split('\n').slice(1, 4).map((l) => l.trim().slice(0, 70)).join(' < ')
          console.log('[council:tab] solo=' + Boolean(solo) + ' why=' + String(why || '?') + ' | ' + stack)
        }
      } catch { /* ignore */ }
      try {
        const list = document.querySelector('[data-conversation-tabs]')
        if (!list) return
        const tabs = Array.prototype.slice.call(list.querySelectorAll('button[role="tab"]'))
        const labelOf = (b) => String(b.textContent || '').trim()
        // 用户 2026-11-16 明确：**「轨迹」两边都要保留**（工具执行轨迹在小模式下同样有用）。
        // 所以只在「对话」与「团队/小组」之间互斥：
        //   单人 → 显示 对话 + 轨迹，隐藏 团队/小组
        //   小组 → 显示 团队/小组 + 轨迹，隐藏 对话（"对话窗口变为团队"）
        const MINE = ['团队', '小组']
        const DIALOG = ['对话']
        const mine = tabs.filter((b) => MINE.indexOf(labelOf(b)) >= 0)
        const dialog = tabs.filter((b) => DIALOG.indexOf(labelOf(b)) >= 0)
        if (!mine.length) return
        const hide = solo ? mine : dialog
        const show = solo ? dialog : mine
        // 先把选中项挪到「会被显示」的那一边，再隐藏——否则内容区会变成空白
        // 需要切走的情况（2026-11-16 修）：
        //  ① 选中的 tab 马上要被隐藏 → 切到要显示的第一个
        //  ② **一个可见的 tab 都没选中**（DSH 隐藏后会把选中态清空）→ 必须补一次点击，
        //     否则内容区不知道该显示什么，就是用户看到的那 1 秒空白（tab 栏全灰）。
        const activeHidden = hide.filter((b) => b.getAttribute('aria-selected') === 'true')[0]
        const anyVisibleSelected = show.some((b) => b.getAttribute('aria-selected') === 'true')
        const needSelect = Boolean(show[0]) && (activeHidden || !anyVisibleSelected)
        // 切换锁：click 会触发 DSH 切视图 → 重渲染 → MutationObserver 再进来，
        // 没有锁会在「对话 ↔ 团队」之间反复横跳（用户看到的闪烁）。
        if (needSelect && !tabSwitching) {
          tabSwitching = true
          try { show[0].click() } catch { /* ignore */ }
          setTimeout(() => { tabSwitching = false }, 200)
        }
        for (const b of hide) b.style.display = 'none'
        for (const b of show) b.style.display = ''
        try {
          if (window.__councilTabDebug) {
            const after = Array.prototype.slice.call(list.querySelectorAll('button[role="tab"]')).map((b) => labelOf(b) + '=' + (b.style.display === 'none' ? 'hidden' : 'show'))
            console.log('[council:tab]   → ' + after.join(' '))
          }
        } catch { /* ignore */ }
      } catch { /* DOM 结构变了就放弃隐藏，功能不受影响 */ }
    }

    /** tab 会被 DSH 重渲染替换掉（节点换新），用 MutationObserver 把隐藏状态补回去 */
    function watchTabList() {
      if (typeof MutationObserver !== 'function') return
      try {
        const mo = new MutationObserver((mutations) => {
          const relevant = mutations.some((mutation) =>
            (mutation.target.nodeType === 1 && mutation.target.closest('[data-conversation-tabs]')) ||
            Array.from(mutation.addedNodes).some((node) => node.nodeType === 1 &&
              (node.matches('[data-conversation-tabs]') || node.querySelector('[data-conversation-tabs]')))
          )
          if (!relevant) return
          // 注意：两种模式都要复核（不只 solo）。DSH 重建 tab 节点时会把 display 重置，
          // group 模式下「对话」若不重新隐藏就会冒出来。
          if (tabWatchTimer != null) return
          const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame : (fn) => setTimeout(fn, 0)
          tabWatchTimer = schedule(() => {
            tabWatchTimer = null
            applyTabVisibility(councilSoloMode, 'observer')
          })
        })
        mo.observe(document.body, { childList: true, subtree: true })
      } catch { /* ignore */ }
    }

    function registerAll(ctx) {

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'council', order: 6, label: '小组',
        }, CouncilView))
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'council-chat', order: 5, label: '团队',
        }, CouncilChatView))
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'council-mode', order: 40,
        }, ModeToggle))
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options', id: 'council-mode-hero', order: 40,
        }, ModeToggle))
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview', key: 'council_delegate',
        }, CouncilCard))
        // 2026-11-17 用户要求：底部「小组 Ns · 谁在干什么」那行与时间线里的「进行中」卡片重复，
        // 整行删掉（含其中的按钮）。终止能力已全部移进「进行中」卡片。
        // ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        //   name: 'conversation.input.dock', id: 'council-progress', order: 20,
        // }, CouncilProgress))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: 'council-tail', order: 40,
        }, CouncilTail))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'council-roster', order: 60,
        }, RosterPanel))
    }
  },
})

window.__ModuleLoader__.load({
  id: '@zelystaric/dsh-council',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const API = '/council/api'

    /** Both halves live in this module, so a tiny listener set keeps them in sync. */
    const councilListeners = new Set()
    function notifyCouncilChange() {
      for (const listener of councilListeners) { try { listener() } catch { /* ignore */ } }
    }

    /** Compact token counts: 1234 -> 1.2k, 1234567 -> 1.23M. */
    function fmtTokens(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(n)
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
      const presets = [
        { role: '指挥', kind: 'claude', model: 'claude-sonnet-5' },
        { role: '审校', kind: 'deepseek', model: 'deepseek-flash' },
        { role: '画师', kind: 'image', model: 'gpt-image-2.5-flare' },
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
    async function refreshModels() {
      try {
        const data = await call('/models?refresh=1')
        for (const kind of ['codex', 'claude', 'deepseek', 'image']) {
          if (Array.isArray(data && data[kind]) && data[kind].length) liveModels[kind] = data[kind]
        }
      } catch { /* 保留旧值 */ }
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
      deepseek: ['deepseek-flash'],
      image: ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'],
    }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', fontSize: 13 },
      bar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      body: { display: 'flex', flex: 1, minHeight: 0 },
      roles: { width: 320, flexShrink: 0, overflow: 'auto', padding: 12, borderRight: '1px solid var(--dsw-alias-border-l1)' },
      board: { flex: 1, overflow: 'auto', padding: 12, minWidth: 0 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, padding: 10, marginBottom: 8 },
      input: { width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6 },
      button: { fontSize: 12, padding: '5px 10px', cursor: 'pointer', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)' },
      primary: { fontSize: 12, padding: '5px 10px', cursor: 'pointer', borderRadius: 6, fontWeight: 600, color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-brand-primary)' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
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

    function Button(props) {
      const style = props.primary ? styles.primary : styles.button
      const dimmed = props.disabled ? Object.assign({}, style, { opacity: 0.55, cursor: 'default' }) : style
      return h('button', { onClick: props.onClick, disabled: props.disabled, style: dimmed }, props.children)
    }

    function statusChip(status) {
      if (status === 'done') return styles.chip
      if (status === 'running') return Object.assign({}, styles.chip, { borderColor: 'var(--dsw-alias-brand-primary)' })
      if (status === 'failed') return Object.assign({}, styles.chip, styles.err)
      return Object.assign({}, styles.chip, { opacity: 0.7 })
    }

    const statusLabel = { pending: '排队中', running: '正在说…', done: '已回执', failed: '失败' }

    function reviewLine(label, verdict) {
      if (!verdict) return null
      const chip = verdict.ok === true
        ? styles.chip
        : verdict.ok === false
          ? Object.assign({}, styles.chip, styles.err)
          : Object.assign({}, styles.chip, { opacity: 0.75 })
      return h('div', { style: { marginTop: 2 } },
        h('span', { style: chip }, label + '：' + (verdict.ok === true ? '通过' : verdict.ok === false ? '不通过' : '未判定')),
        h('span', { style: { marginLeft: 6 } }, (verdict.by ? verdict.by + '：' : '') + (verdict.reason || '')))
    }

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
    function CouncilView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [apiConfig, setApiConfig] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [balance, setBalance] = useState(null)
      const [keyUsage, setKeyUsage] = useState(null)
      const [models, setModels] = useState(null)
      const [dragId, setDragId] = useState(null)
      const [dropRole, setDropRole] = useState(null)
      const [editing, setEditing] = useState(null)

      const applyData = useCallback((data) => { if (data && data.state) setState(data.state) }, [])

      useEffect(() => {
        call('/state').then(applyData).catch((e) => setError(String(e.message || e)))
        call('/balance').then(setBalance).catch(() => setBalance(null))
        call('/usage').then(setKeyUsage).catch(() => setKeyUsage(null))
        call('/models').then(setModels).catch(() => setModels(null))
        call('/config').then((data) => setApiConfig(data.config)).catch(() => setApiConfig(null))
        call('/groups/prune', {}).then(applyData).catch(() => {})
      }, [applyData])

      const groupList = state && state.groups ? state.groups : []
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

      function modelSelect(value, kind, onChange) {
        const list = modelOptions(kind)
        const options = value && list.indexOf(value) < 0 ? [value].concat(list) : list
        return h('select', {
          style: Object.assign({}, styles.input, { flex: 1 }), defaultValue: value || options[0] || '',
          onChange: (event) => onChange(event.target.value),
        }, options.map((id) => h('option', { key: id, value: id }, id)))
      }

      function labelOf(id) {
        if (id.indexOf('commander:') === 0) return '指挥'
        const member = (state.members || []).find((m) => m.id === id)
        return member ? member.name : id
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
          : h('strong', { onDoubleClick: () => setEditing(role.id), title: '双击改名' }, role.name)
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
        h('textarea', {
          style: Object.assign({}, styles.input, { marginTop: 6, minHeight: 54, resize: 'vertical' }),
          defaultValue: role.prompt, placeholder: '职位提示词（派活时注入）',
          onBlur: (event) => { if (event.target.value !== role.prompt) mutate('/roles', { id: role.id, prompt: event.target.value }) },
        }),
        h('div', { style: { marginTop: 6 } }, assigned.map(memberChip)))
      }

      function memberCard(member) {
        const role = roles.find((r) => r.id === member.roleId)
        const kindSelect = h('select', {
          style: Object.assign({}, styles.input, { width: 110 }), defaultValue: member.kind,
          onChange: (event) => {
            const kind = event.target.value
            const list = modelOptions(kind)
            const next = member.model && list.indexOf(member.model) >= 0 ? member.model : (list[0] || '')
            mutate('/members', { id: member.id, kind: kind, model: next })
          },
        }, ['codex', 'claude', 'deepseek', 'image'].map((kind) => h('option', { key: kind, value: kind }, kind)))
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
          kindSelect,
          h(Button, { onClick: () => mutate('/members/delete', { id: member.id }) }, '删')),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
          modelSelect(member.model, member.kind, (value) => mutate('/members', { id: member.id, model: value })),
          roleSelect),
        h('div', { style: Object.assign({}, styles.muted, { marginTop: 6 }) },
          '职位：' + (role ? role.name : '未分配') + ' · 会话：' + (member.convId ? member.convId.slice(0, 8) : '尚未开始')))
      }

      function apiCard() {
        const info = apiConfig || {}
        const save = () => {
          const read = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : '' }
          // 只提交「填了值的」字段：空输入框表示“保持原样”，不是“删除”，否则会互相清空
          const body = {}
          const pairs = [
            ['council-codex-token', 'codexToken'],
            ['council-claude-key', 'claudeKey'],
            ['council-image-key', 'imageKey'],
            ['council-codex-base', 'codexBase'],
            ['council-claude-base', 'claudeBase'],
          ]
          for (const [id, key] of pairs) {
            const value = read(id)
            if (value) body[key] = value
          }
          if (!Object.keys(body).length) return
          mutate('/config', body)
            .then(() => refreshModels())
            .then(() => call('/config').then((data) => setApiConfig(data.config)).catch(() => {}))
            .then(() => { for (const [id] of pairs) { const el = document.getElementById(id); if (el) el.value = '' } })
            .catch(() => {})
        }
        const clearKey = (key) => mutate('/config', { [key]: '' }).then(() => call('/config').then((data) => setApiConfig(data.config)).catch(() => {}))
        return h('div', { style: Object.assign({}, styles.card, { marginTop: 16 }) },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '① CLI 与出图密钥'),
          h('div', { style: Object.assign({}, styles.muted, { marginBottom: 6 }) },
            '只有 codex / claude CLI 成员和 image 出图成员需要这里；其余成员不需要填。'
            + '留空则用 profile 配置（当前来源：' + (info.source === 'page' ? '本页' : 'profile') + '）'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', { id: 'council-codex-token', style: Object.assign({}, styles.input, { flex: '1 1 200px' }), type: 'password', placeholder: 'gpt key（codex 用）' + (info.hasCodexToken ? ' · 已配置' : '') }),
            h(Button, { onClick: () => clearKey('codexToken') }, '清空'),
            h('input', { id: 'council-claude-key', style: Object.assign({}, styles.input, { flex: '1 1 200px' }), type: 'password', placeholder: 'claude key' + (info.hasClaudeKey ? ' · 已配置' : '') }),
            h(Button, { onClick: () => clearKey('claudeKey') }, '清空'),
            h('input', { id: 'council-image-key', style: Object.assign({}, styles.input, { flex: '1 1 200px' }), type: 'password', placeholder: 'gpt-image key' + (info.hasImageKey ? ' · 已配置' : '') }),
            h(Button, { onClick: () => clearKey('imageKey') }, '清空')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            h('input', { id: 'council-codex-base', style: Object.assign({}, styles.input, { flex: '1 1 200px' }), defaultValue: info.codexBase || '', placeholder: 'codex base URL' }),
            h('input', { id: 'council-claude-base', style: Object.assign({}, styles.input, { flex: '1 1 200px' }), defaultValue: info.claudeBase || '', placeholder: 'claude base URL' }),
            h(Button, { onClick: save }, '保存 API 配置')),
          h('div', { style: Object.assign({}, styles.muted, { marginTop: 6 }) }, '只提交填了值的项：留空 = 保持原样，要删除请点对应的「清空」。保存后立即生效。'))
      }

      function usagePanel() {
        if (keyUsage && keyUsage.keys && keyUsage.keys.length) {
          const rows = keyUsage.keys.map((key) => h('div', {
            key: key.id, style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' },
          },
          h('span', { style: styles.chip }, key.label),
          key.ok
            ? h('span', { style: styles.muted },
              (key.balance === null ? '' : '余额 ' + key.balance.toFixed(2) + ' · ')
              + (key.today ? '今日 ' + key.today.requests + ' 次 · ' + fmtTokens(key.today.tokens) + ' tok · $' + key.today.cost.toFixed(2) + ' · ' : '')
              + '累计 ' + key.totals.requests + ' 次 · ' + fmtTokens(key.totals.tokens) + ' tok · $' + key.totals.cost.toFixed(2))
            : h('span', { style: styles.err }, ' 不可用：' + (key.error || '未知'))))
          return h('div', { style: Object.assign({}, styles.card, { marginTop: 16 }) },
            h('div', { style: styles.muted }, 'API key 用量（中转站 /v1/usage 实时值）'),
            rows)
        }
        const rows = usageRows.map(([id, row]) => h('div', { key: id, style: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' } },
          h('span', { style: styles.chip }, labelOf(id)),
          h('span', { style: styles.muted }, '调用 ' + row.calls + ' · 入 ' + row.input + ' · 出 ' + row.output + ' · $' + (row.costUsd || 0).toFixed(4))))
        return h('div', { style: Object.assign({}, styles.card, { marginTop: 16 }) },
          h('div', { style: styles.muted }, '用量（本地统计；/v1/usage 不可用时回落到这里）'),
          rows.length ? rows : h('div', { style: styles.muted }, '暂无'))
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
        h('span', { style: styles.chip }, group.name),
        h('span', { style: styles.muted }, '（指挥职位负责拆解 + 终审，审校职位负责初审；对话只负责转达）'),
        h('span', { style: styles.chip }, '指挥：' + (commanderMember ? commanderMember.name : '未分配')),
        h('span', { style: styles.chip }, '审校：' + (reviewerMember ? reviewerMember.name : '未分配')),
        h('span', { style: styles.muted }, group.workspacePath || ''),
        h('span', { style: { flex: 1 } }),
        h('span', { style: styles.chip }, balanceLabel),
        h(Button, {
          onClick: () => mutate('/groups/bind', { id: group.id, sessionId: null }).then(refresh),
        }, '切回单人模式'),
        h(Button, { onClick: refresh }, '刷新'),
        h(Button, {
          onClick: () => {
            if (typeof window === 'undefined' || !window.confirm) return
            if (window.confirm('删除小组「' + group.name + '」？（成员本身不会删，只是从小组移除）')) {
              mutate('/groups/delete', { id: group.id }).then(refresh)
            }
          },
        }, '删除小组'))

      const rolesPanel = h('div', { style: styles.roles },
        h('div', { style: Object.assign({}, styles.muted, { marginBottom: 8 }) }, '职位（把成员拖到职位上完成分配）'),
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
          h(Button, { onClick: () => mutate('/members', { name: '成员 ' + (members.length + 1), kind: 'codex', groupId: group.id }) }, '+ 成员（codex）'),
          h(Button, { onClick: () => mutate('/members', { name: '成员 ' + (members.length + 1), kind: 'claude', groupId: group.id }) }, '+ 成员（claude）'),
          h(Button, { onClick: () => mutate('/members', { name: '成员 ' + (members.length + 1), kind: 'deepseek', groupId: group.id }) }, '+ 成员（deepseek）'),
          h(Button, { onClick: () => mutate('/members', { name: '画师', kind: 'image', groupId: group.id }) }, '+ 成员（image）')),
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
        apiCard(),
        usagePanel())

      return h('div', { style: styles.root },
        header,
        error ? h('div', { style: Object.assign({}, styles.err, { padding: '6px 14px' }) }, error) : null,
        h('div', { style: styles.body }, rolesPanel, board))
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
          h('div', { style: Object.assign({}, styles.muted, { marginTop: 4 }) }, '职位：' + roleName(member)))
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
      const [expanded, setExpanded] = useState(false)
      const text = String(props.text || '')
      const long = text.length > 240
      const shown = expanded || !long ? text : text.slice(0, 240) + '…'
      return h('div', null,
        h('div', { style: { whiteSpace: 'pre-wrap' } }, shown),
        long ? h('div', { style: { marginTop: 2 } },
          h('span', {
            style: Object.assign({}, styles.muted, { cursor: 'pointer', textDecoration: 'underline' }),
            onClick: () => setExpanded(!expanded),
          }, expanded ? '收起' : '展开全文')) : null)
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
        const timer = setInterval(load, 2000)
        return () => { alive = false; clearInterval(timer) }
      }, [phase, props && props.callId])

      if (phase !== 'result') {
        const members = progress && progress.members ? Object.keys(progress.members).map((id) => progress.members[id]) : []
        const started = progress && progress.startedAt ? Math.round((now - progress.startedAt) / 1000) : null
        return h('div', { style: styles.card },
          h('div', { style: styles.who }, '小组派发中…' + (started === null ? '' : ' ' + started + 's')),
          members.length
            ? members.map((m, i) => h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
              h(Avatar, { kind: m.kind, name: m.name }),
              h('span', { style: styles.muted }, (m.name || '成员') + ' · ' + (m.stage || '…')
                + (m.at ? ' · ' + Math.round((now - m.at) / 1000) + 's' : ''))))
            : h('div', { style: styles.muted }, planned.length ? planned.join('、') + '（等待开始）' : '准备中'))
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

    function CouncilChatRow(props) {
      const node = props && (props.node || props.data)
      const data = node && node.data ? node.data : node
      const text = data && typeof data.text === 'string' ? data.text : ''
      const sections = parseCouncilText(text)
      if (!sections.length) return null
      const banner = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)', fontSize: 12,
        },
      }, h('strong', null, '小组群聊'), h('span', { style: styles.muted }, sections.length + ' 位成员'))
      const rows = sections.map(function (item, index) {
        const bubble = h('div', { style: Object.assign({}, styles.bubble, { flex: 1 }) },
          h('div', { style: styles.who }, item.who + (item.kind ? ' · ' + item.kind : '')),
          item.body ? h(Collapsible, { text: item.body }) : null,
          item.image ? h('img', {
            src: item.image, alt: 'generated',
            style: { display: 'block', maxWidth: 320, marginTop: 6, borderRadius: 8 },
          }) : null,
          (item.review || []).map(function (entry, i) {
            return h('div', { key: i, style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, entry[0] + '：' + entry[1])
          }))
        return h('div', { key: index, style: { display: 'flex', alignItems: 'flex-start', maxWidth: '88%', marginTop: 8 } },
          h(Avatar, { kind: item.kind, name: item.who }),
          bubble)
      })
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0' } }, banner, rows)
    }

    function ModeToggle(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        let alive = true
        const reload = () => {
          call('/state').then((data) => { if (alive) setState(data.state) }).catch((e) => { if (alive) setError(String(e.message || e)) })
        }
        reload()
        councilListeners.add(reload)
        const timer = setInterval(reload, 5000)
        return () => { alive = false; councilListeners.delete(reload); clearInterval(timer) }
      }, [])

      if (!sessionId) return null
      if (!state) {
        return h('span', { style: styles.chip }, error ? '小组状态未知' : '模式…')
      }
      const groupList = (state.groups || []).filter((g) => !g.archived)
      const own = groupForSession(state, sessionId)
      const bound = Boolean(own)
      const toggle = async () => {
        setBusy(true); setError(null)
        try {
          let data
          if (bound) {
            data = await call('/groups/bind', { id: own.id, sessionId: null })
          } else {
            const created = await call('/groups', { name: '本会话小组' })
            const next = created.state.groups[created.state.groups.length - 1]
            data = await call('/groups/bind', { id: next.id, sessionId: sessionId })
            await provisionDefaultRoster(next.id)
            data = await call('/state')
          }
          setState(data.state)
          notifyCouncilChange()
        } catch (e) { setError(String(e.message || e)) }
        finally { setBusy(false) }
      }
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
        h('span', {
          style: Object.assign({}, styles.chip, {
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.6 : 1,
            borderColor: bound ? 'var(--dsw-alias-brand-primary)' : undefined,
            fontWeight: 600,
          }),
          title: bound ? '当前是小组模式，点击切回单人模式' : '当前是单人模式，点击启用小组模式',
          onClick: busy ? undefined : toggle,
        }, (bound ? '小组模式' : '单人模式') + (error ? ' !' : '')),
        bound ? h('span', {
          style: Object.assign({}, styles.chip, { cursor: 'pointer' }),
          title: '编辑本组名册',
          onClick: () => openRosterPanel(sessionId),
        }, '名册') : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          registerAll(ctx)
        } catch (error) {
          try { console.error('[council] client registration failed', error) } catch { /* ignore */ }
        }
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
        const timer = setInterval(load, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const entry = (state && state.delegations && state.delegations[sessionId]) || null
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
      const [entry, setEntry] = useState(null)
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        let alive = true
        const load = () => {
          call('/progress').then((data) => {
            if (!alive) return
            const all = (data && data.progress) || {}
            const now = Date.now()
            const list = Object.keys(all).map((id) => all[id])
              .filter((e) => !e.finishedAt && now - (e.startedAt || 0) < 30 * 60_000)
              .filter((e) => !sessionId || e.sessionId === sessionId)
            setEntry(list.length ? list[list.length - 1] : null)
            setNow(Date.now())
          }).catch(() => {})
        }
        load()
        const timer = setInterval(load, 2000)
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
        const timer = setInterval(load, 6000)
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
      if (!entry) return jumpChip ? h('div', { style: { display: 'flex', justifyContent: 'flex-end', margin: '0 8px 6px' } }, jumpChip) : null


      const members = Object.keys(entry.members || {}).map((id) => entry.members[id])
      const total = entry.startedAt ? Math.round((now - entry.startedAt) / 1000) : null
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 8px 6px',
          padding: '6px 10px', borderRadius: 10, fontSize: 12,
          background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('span', { style: { fontWeight: 600 } }, '小组'),
      h('span', { style: styles.muted }, total === null ? '' : total + 's'),
      members.length
        ? members.map((m, i) => h('span', { key: i, style: styles.chip },
          (m.name || '成员') + ' · ' + (m.stage || '…') + (m.at ? ' · ' + Math.round((now - m.at) / 1000) + 's' : '')))
        : h('span', { style: styles.muted }, '准备中…'),
      h('span', { style: { flex: 1 } }), jumpChip)
    }


    /* 群聊视图：本会话的完整成员发言时间线（微信式） */
    function CouncilChatView(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : undefined
      const [state, setState] = useState(null)
      const [now, setNow] = useState(Date.now())
      const [atBottom, setAtBottom] = useState(true)
      const [toast, setToast] = useState('')
      const scrollerRef = useRef(null)

      useEffect(() => {
        let alive = true
        const load = () => call('/state').then((d) => { if (alive) { setState(d.state); setNow(Date.now()) } }).catch(() => {})
        load()
        const timer = setInterval(load, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const history = (state && state.delegations && state.delegations[sessionId]) || null
      const entries = (history && history.entries) || []

      const jump = () => {
        setAtBottom(true)
        setToast(Date.now().toString())
        if (typeof setTimeout === 'function') {
          setTimeout(() => setToast((prev) => (prev ? '' : prev)), 1200)
        }
        const node = scrollerRef.current
        // 1) 原生平滑滚动：无论真正滚动的是这一层还是外层页面，都能落到底
        const last = node && node.lastElementChild
        if (last && typeof last.scrollIntoView === 'function') {
          try { last.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* fall through */ }
        }
        if (!node) return
        const target = node.scrollHeight - node.clientHeight
        const from = node.scrollTop
        const distance = target - from
        if (Math.abs(distance) < 4) return
        if (typeof requestAnimationFrame !== 'function') { node.scrollTop = target; return }
        const duration = 360
        const started = Date.now()
        const ease = (t) => 1 - Math.pow(1 - t, 3)
        const tick = () => {
          const el = scrollerRef.current
          if (!el) return
          const progress = Math.min(1, (Date.now() - started) / duration)
          el.scrollTop = from + distance * ease(progress)
          if (progress < 1) requestAnimationFrame(tick)
          else el.scrollTop = el.scrollHeight - el.clientHeight
        }
        requestAnimationFrame(tick)
      }

      useEffect(() => {
        const handler = () => jump()
        jumpListeners.add(handler)
        return () => jumpListeners.delete(handler)
      })

      useEffect(() => {
        if (atBottom) jump()
      }, [entries.length])

      useEffect(() => {
        setChatActive(true)
        return () => setChatActive(false)
      }, [])

      if (!state) return h('div', { style: Object.assign({}, styles.root, { padding: 16 }) }, h('div', { style: styles.muted }, '加载中…'))
      if (!entries.length) {
        return h('div', { style: Object.assign({}, styles.root, { padding: 16 }) },
          h('div', { style: styles.muted }, '这个会话还没有群聊记录。切到「小组模式」并派一次活，成员发言就会出现在这里。'))
      }

      const rounds = entries.map(function (entry, index) {
        const sections = parseCouncilText(entry.text || '')
        const items = []
        if (entry.request) {
          items.push(h('div', { key: 'u' + index, style: Object.assign({}, styles.bubble, styles.mine) }, entry.request))
        }
        sections.forEach(function (item, i) {
          const who = item.who + (item.kind ? ' · ' + item.kind : '')
          const reviewLines = (item.review || []).map(function (r, ri) {
            return h('div', { key: ri, style: { marginTop: 2, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, r[0] + '：' + r[1])
          })
          items.push(h('div', {
            key: index + '-' + i,
            style: { display: 'flex', alignItems: 'flex-start', maxWidth: '86%', marginTop: 6 },
          },
          h(Avatar, { kind: item.kind, name: item.who }),
          h('div', { style: Object.assign({}, styles.bubble, { flex: 1 }) },
            h('div', { style: styles.who }, who + ' · ' + new Date(entry.at).toLocaleTimeString()),
            item.body ? h(Collapsible, { text: item.body }) : null,
            item.image ? h('img', {
              src: item.image, alt: 'generated',
              style: { display: 'block', maxWidth: 360, marginTop: 6, borderRadius: 8 },
            }) : null,
            reviewLines)))
        })
        const label = entry.request ? '' : (entry.brief ? '任务：' + entry.brief : '')
        return h('div', { key: 'round' + index, style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { flex: '0 0 auto', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } },
              '第 ' + (index + 1) + ' 轮 · ' + new Date(entry.at).toLocaleTimeString() + ' · ' + sections.length + ' 条回执' + (label ? ' · ' + label : '')),
            h('span', { style: { flex: 1, height: 1, background: 'var(--dsw-alias-border-l1)' } })),
          items)
      })

      return h('div', {
        style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: 12, gap: 8, overflow: 'hidden' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
        h('strong', null, '小组群聊'),
        h('span', { style: styles.muted }, entries.length + ' 轮 · 更新于 ' + new Date(now).toLocaleTimeString())),
      h('div', {
        ref: (node) => { scrollerRef.current = node },
        'data-council-scroller': '1',
        onScroll: (event) => {
          const node = event.currentTarget
          setAtBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 48)
        },
        style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 4 },
      }, rounds),
      toast ? h('div', {
        style: {
          position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)',
          padding: '4px 12px', borderRadius: 999, fontSize: 12,
          background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l1)', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        },
      }, '已跳到底部') : null)
    }

    function registerAll(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'council', order: 30, label: '小组',
        }, CouncilView))
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'council-chat', order: 25, label: '群聊',
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
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'council-progress', order: 20,
        }, CouncilProgress))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: 'council-tail', order: 40,
        }, CouncilTail))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'council-roster', order: 60,
        }, RosterPanel))
    }
  },
})

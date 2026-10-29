/**
 * CR-MAC · 渲染层（零依赖 vanilla JS）
 * 设计语言：Linear 的克制 + Arc 的渐变 + Raycast 的玻璃（Toast/模态）
 */
'use strict'

const $ = (id) => document.getElementById(id)
const state = {
  clients: [],
  current: null,
  lastStatus: {},
  filter: ''
}
const VERSION_TEXT = '1.0.0-mac.1'

/* ── 客户端徽章色（与 CSS .av-<id> 对应） ── */
const AV_CLS = {
  codex: 'codex', claude: 'claude', zcode: 'zcode', dsh: 'dsh', hermes: 'hermes',
  cursor: 'cursor', workbuddy: 'workbuddy', 'workbuddy-intl': 'workbuddy-intl', doubao: 'doubao'
}
const AV_TEXT = {
  codex: 'CX', claude: 'CL', zcode: 'ZC', dsh: 'DS', hermes: 'HM',
  cursor: 'CU', workbuddy: 'WB', 'workbuddy-intl': 'WI', doubao: 'DB'
}

const STATUS_LABEL = { managed: '已注入', pristine: '原样', missing: '缺失', unreadable: '不可读' }
const CH_LABEL = { ok: '成功', already: '已在位', dry: '将执行', skip: '跳过', error: '错误' }

/* ── 行内 SVG 图标 ── */
const SVG = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  minus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8h8"/></svg>',
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>',
  dash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4.5 11.5h7" opacity=".45"/><path d="M4.5 7h7" opacity=".45"/><path d="M4.5 3h4" opacity=".45"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  ok: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 8.2 7.3 10l3.4-3.8"/></svg>',
  err: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.8v4M8 11.2v.1"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.8v.1"/></svg>',
  folder: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7z"/></svg>'
}
const chIcon = (status) => ({ ok: SVG.check, already: SVG.minus, dry: SVG.arrow, skip: SVG.dash, error: SVG.x }[status] || SVG.dash)

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ── Toast / 模态（替代 alert） ── */
function toast(kind, title, msg) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = `<span class="t-ico ${kind}">${SVG[kind] || SVG.info}</span><span>${title ? `<b>${esc(title)}</b>` : ''}<span class="t-msg">${esc(msg || '')}</span></span>`
  $('toasts').appendChild(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300) }, kind === 'err' ? 6000 : 3600)
}

function showModal(title, body) {
  $('modal-title').textContent = title
  $('modal-body').textContent = body
  $('modal-mask').classList.remove('hidden')
}
$('modal-ok').onclick = () => $('modal-mask').classList.add('hidden')
$('modal-mask').addEventListener('click', (e) => { if (e.target.id === 'modal-mask') $('modal-mask').classList.add('hidden') })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('modal-mask').classList.add('hidden')
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); $('search-input').focus(); $('search-input').select()
  }
})

/* ── 数据流 ── */

async function refreshClients() {
  state.clients = await window.cr.clientManifests()
  $('ver').textContent = VERSION_TEXT
  $('side-count').textContent = state.clients.filter((c) => c.installed && c.mac).length + '/' + state.clients.length
  renderClientList()
  renderHomeCards()
  renderStats()
}

function dotClass(c) {
  const st = state.lastStatus[c.id]
  if (!c.installed) return ''
  if (!st) return ''
  return st.managedCount > 0 ? 'on' : ''
}

function renderClientList() {
  const box = $('client-list')
  box.innerHTML = ''
  for (const c of state.clients) {
    if (state.filter && !c.name.toLowerCase().includes(state.filter)) continue
    const st = state.lastStatus[c.id]
    const div = document.createElement('div')
    div.className = 'client-item' + (state.current === c.id ? ' active' : '') + (c.installed && c.mac ? '' : ' dim')
    div.innerHTML =
      `<span class="av av-${AV_CLS[c.id] || 'codex'}">${AV_TEXT[c.id] || '?'}</span>` +
      `<span class="nm">${esc(c.name)}</span>` +
      `<span class="st">${c.installed && c.mac ? (st && st.managedCount > 0 ? '✓' + st.managedCount : '') : '—'}</span>`
    div.title = c.dir || ''
    div.onclick = () => selectClient(c.id)
    box.appendChild(div)
  }
}

function renderStats() {
  const installed = state.clients.filter((c) => c.installed && c.mac).length
  const injected = state.clients.filter((c) => (state.lastStatus[c.id] || {}).managedCount > 0).length
  const chans = state.clients.filter((c) => state.lastStatus[c.id])
    .reduce((n, c) => n + (state.lastStatus[c.id].managedCount || 0), 0)
  $('stats').innerHTML =
    `<div class="stat"><span class="num">${installed}</span><span class="lbl">已安装客户端<br>本机可注入</span></div>` +
    `<div class="stat"><span class="num acc">${injected}</span><span class="lbl">已注入<br>封条在位</span></div>` +
    `<div class="stat"><span class="num ok">${chans}</span><span class="lbl">受管通道<br>合计</span></div>`
}

function renderHomeCards() {
  const box = $('home-cards')
  box.innerHTML = ''
  for (const c of state.clients) {
    if (state.filter && !c.name.toLowerCase().includes(state.filter)) continue
    const st = state.lastStatus[c.id]
    const div = document.createElement('div')
    div.className = 'card'
    const tags = []
    if (!c.installed || !c.mac) tags.push(`<span class="tag">${c.mac ? '未安装' : '不支持'}</span>`)
    else if (st && st.managedCount > 0) tags.push(`<span class="tag inj">已注入 ${st.managedCount}</span>`)
    else tags.push('<span class="tag live">可注入</span>')
    div.innerHTML =
      `<div class="nm"><span class="av av-${AV_CLS[c.id] || 'codex'}">${AV_TEXT[c.id] || '?'}</span><b>${esc(c.name)}</b></div>` +
      `<div class="dir">${esc(c.dir || '—')}</div>` +
      `<div class="meta">${tags.join('')}</div>`
    div.onclick = () => selectClient(c.id)
    box.appendChild(div)
  }
}

async function selectClient(id) {
  state.current = id
  const c = state.clients.find((x) => x.id === id)
  $('home-panel').classList.add('hidden')
  const view = $('client-panel')
  view.classList.remove('hidden')
  // 重触发入场动画
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = ''
  $('crumb-name').textContent = c.name
  $('panel-name').textContent = c.name
  $('panel-dir').innerHTML =
    `<span>${esc(c.dir || '未检测到安装目录')}</span>` +
    (c.dir ? `<span class="folder-btn" id="dir-open-btn" title="在 Finder 中打开">${SVG.folder}</span>` : '')
  $('panel-avatar').innerHTML = `<span class="av av-${AV_CLS[id] || 'codex'}">${AV_TEXT[id] || '?'}</span>`
  const openBtn = $('dir-open-btn')
  if (openBtn) openBtn.onclick = () => window.cr.dirOpen(id)
  renderClientList()
  await refreshStatus(id)
}

async function refreshStatus(id, opts = {}) {
  const st = await window.cr.status(id)
  state.lastStatus[id] = st
  const badge = $('panel-badge')
  if (!st.installed) { badge.textContent = '未安装'; badge.className = 'pill' }
  else if (st.managedCount > 0) { badge.textContent = `已注入 ${st.managedCount} 通道`; badge.className = 'pill on' }
  else { badge.textContent = '未注入'; badge.className = 'pill' }
  if (opts.keepChannels) {
    renderClientList(); renderHomeCards(); renderStats()
    return
  }
  const c = state.clients.find((x) => x.id === id)
  const list = $('channel-list')
  list.innerHTML = ''
  for (const ch of c.channels) {
    const live = (st.channels || []).filter((x) => x.ch === ch.id)
    const div = document.createElement('div')
    div.className = 'ch'
    const states = live.map((x) => `<span class="ch-state-tag ${x.state}">${STATUS_LABEL[x.state] || x.state}</span>`).join('')
    const files = live.map((x) => `<div class="ch-file">${esc(x.file)}</div>`).join('')
    div.innerHTML =
      `<span class="ch-status ${live.every((x) => x.state === 'managed') ? 'ok' : ''}">${SVG.dash}</span>` +
      `<div class="ch-body"><div class="ch-top"><span class="ch-name">${esc(ch.label)}</span>` +
      (live.length > 1 ? `<span class="ch-count">×${live.length}</span>` : '') + states + `</div>${files}</div>`
    list.appendChild(div)
  }
  renderClientList(); renderHomeCards(); renderStats()
}

/** inject / dryRun 结果渲染（图标按状态着色） */
function renderResult(res) {
  const list = $('channel-list')
  list.innerHTML = ''
  const metaList = (state.clients.find((x) => x.id === state.current) || { channels: [] }).channels
  for (const r of (res.channels || [])) {
    const meta = metaList.find((c) => c.id === r.ch)
    const div = document.createElement('div')
    div.className = 'ch'
    div.innerHTML =
      `<span class="ch-status ${r.status}">${chIcon(r.status)}</span>` +
      `<div class="ch-body"><div class="ch-top"><span class="ch-name">${esc((meta && meta.label) || r.ch)}</span>` +
      `<span class="ch-count">${CH_LABEL[r.status] || r.status}</span></div>` +
      `<div class="ch-file">${esc(r.file)}</div>` +
      (r.detail ? `<div class="ch-detail${r.status === 'error' ? ' err' : ''}">${esc(r.detail)}</div>` : '') +
      `</div>`
    list.appendChild(div)
  }
}

async function withBusy(btn, label, fn) {
  const old = btn.innerHTML
  btn.disabled = true
  btn.textContent = label
  try { await fn() } catch (err) { toast('err', '操作失败', String(err)) } finally { btn.disabled = false; btn.innerHTML = old }
}

$('btn-dry').onclick = () => withBusy($('btn-dry'), '检查中…', async () => {
  const r = await window.cr.dryRun(state.current)
  renderResult(r)
  await refreshStatus(state.current, { keepChannels: true })
  const ok = (r.channels || []).filter((c) => c.status === 'dry').length
  const skip = (r.channels || []).filter((c) => c.status === 'skip').length
  toast('info', '干跑完成', `${ok} 个通道将执行，${skip} 个跳过（零写入）`)
})

$('btn-inject').onclick = () => withBusy($('btn-inject'), '注入中…', async () => {
  const r = await window.cr.inject(state.current)
  renderResult(r)
  const errs = (r.channels || []).filter((c) => c.status === 'error')
  await refreshStatus(state.current, { keepChannels: true })
  if (r.ok) {
    toast('ok', '注入完成', `在客户端发一条消息「CR」验证回执；桌面客户端需重启生效`)
  } else {
    showModal('注入有错误通道', errs.map((e) => `${e.ch}：${e.detail}`).join('\n'))
  }
})

$('btn-revoke').onclick = () => withBusy($('btn-revoke'), '撤销中…', async () => {
  const r = await window.cr.revoke(state.current)
  const parts = []
  if (r.restored && r.restored.length) parts.push(`还原 ${r.restored.length}`)
  if (r.removed && r.removed.length) parts.push(`删除 ${r.removed.length}`)
  if (r.sanitized && r.sanitized.length) parts.push(`清理 ${r.sanitized.length}`)
  await refreshLog()
  if (r.missing && r.missing.length) {
    showModal('撤销完成（有异常项）', parts.join('，') + '\n\n' + r.missing.join('\n'))
  } else {
    toast('ok', '撤销完成', parts.join('，') || '无可撤销项')
  }
  await refreshStatus(state.current)
})

/* ── 面包屑返回 ── */
$('crumb-home').onclick = () => {
  state.current = null
  $('client-panel').classList.add('hidden')
  const home = $('home-panel')
  home.classList.remove('hidden')
  home.style.animation = 'none'; void home.offsetWidth; home.style.animation = ''
  renderClientList()
}

/* ── 搜索 ── */
$('search-input').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase()
  renderClientList(); renderHomeCards()
})

/* ── 激活 chips ── */
const DOMAINS = [
  { id: 'l-license', label: '破解' },
  { id: 'l-reverse', label: '逆向' },
  { id: 'l-gameassist', label: '游戏' },
  { id: 'l-webrecon', label: '渗透' }
]
async function renderActivation() {
  const st = await window.cr.activationState()
  const box = $('activation-chips')
  box.innerHTML = ''
  for (const d of DOMAINS) {
    const chip = document.createElement('span')
    const on = st.entries.includes(d.id)
    chip.className = 'chip' + (on ? ' on' : '')
    chip.textContent = d.label
    chip.onclick = async () => {
      const cur = await window.cr.activationState()
      const set = new Set(cur.entries)
      if (set.has(d.id)) set.delete(d.id)
      else { set.clear(); set.add(d.id) }
      await window.cr.activationSet([...set])
      renderActivation()
    }
    box.appendChild(chip)
  }
}

/* ── 守护 / 载荷 / 日志 ── */
async function renderGuard() {
  const g = await window.cr.guardState()
  $('guard-toggle').checked = g.enabled
  $('guard-pill').classList.toggle('on', g.enabled)
  $('guard-pill-text').textContent = g.enabled ? '守护已开' : '守护已停'
}
$('guard-toggle').onchange = async (e) => {
  await window.cr.guardToggle(e.target.checked)
  renderGuard()
}

async function loadPayload() {
  $('payload-editor').value = await window.cr.payloadGet()
}
$('btn-payload-save').onclick = async () => {
  const r = await window.cr.payloadSave($('payload-editor').value)
  if (r.ok) toast('ok', '载荷已保存', '下次注入生效（~/.cr-mac/payload-override.md）')
  else toast('err', '保存失败', r.error || '')
}

async function refreshLog() {
  const lines = await window.cr.logTail()
  $('log').textContent = lines.join('\n') || '（暂无日志）'
}
$('btn-log-copy').onclick = async () => {
  await navigator.clipboard.writeText($('log').textContent)
  toast('ok', '已复制', '运行日志已复制到剪贴板')
}

/* ── 窗口：原生红绿灯（titleBarStyle:hidden + trafficLightPosition），无需自绘控件 ── */

/* ── 主题系统（持久化 + 系统跟随 + ⌘⇧T 循环） ── */
const THEME_NAMES = { dark: '深色', light: '浅色', midnight: '午夜蓝', contrast: '高对比', system: '跟随系统' }
const THEME_ORDER = ['dark', 'light', 'midnight', 'contrast', 'system']
let themeCurrent = 'dark'   // 用户设置（含 system）
let themeEffective = 'dark' // 实际生效

function applyThemeDom(effective) {
  document.documentElement.setAttribute('data-theme', effective)
}
function renderThemeUi() {
  applyThemeDom(themeEffective)
  $('theme-btn-label').textContent = THEME_NAMES[themeCurrent] || '深色'
  document.querySelectorAll('.theme-opt').forEach((el) => {
    el.classList.toggle('active', el.dataset.theme === themeCurrent)
  })
}
async function setTheme(t) {
  const r = await window.cr.uiSetTheme(t)
  if (!r.ok) return
  themeCurrent = r.theme
  themeEffective = r.effective
  renderThemeUi()
  toast('info', '主题已切换', THEME_NAMES[t])
}
async function initTheme() {
  const r = await window.cr.uiGetTheme()
  themeCurrent = r.theme
  themeEffective = r.effective
  renderThemeUi()
  // 系统外观变化实时跟随（仅 theme=system 时生效）
  window.cr.onThemeSystemChanged((effective) => {
    if (themeCurrent === 'system') {
      themeEffective = effective
      renderThemeUi()
    }
  })
  // 下拉菜单
  const btn = $('theme-btn')
  const pop = $('theme-pop')
  const toggle = (open) => {
    pop.classList.toggle('open', open)
    btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  btn.onclick = (e) => { e.stopPropagation(); toggle(!pop.classList.contains('open')) }
  document.addEventListener('click', (e) => { if (!pop.contains(e.target)) toggle(false) })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false) })
  pop.querySelectorAll('.theme-opt').forEach((el) => {
    el.onclick = () => { setTheme(el.dataset.theme); toggle(false) }
  })
}

/* ── 快捷键 ── */
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault()
    const next = THEME_ORDER[(THEME_ORDER.indexOf(themeCurrent) + 1) % THEME_ORDER.length]
    setTheme(next)
  }
})

/* ── 启动 ── */
;(async function init() {
  await initTheme()
  await refreshClients()
  await renderActivation()
  await renderGuard()
  await loadPayload()
  await refreshLog()
  for (const c of state.clients) {
    if (c.installed && c.mac) refreshStatus(c.id).catch(() => {})
  }
  setInterval(refreshLog, 8000)
  setInterval(() => { for (const c of state.clients) if (c.installed && c.mac) refreshStatus(c.id).catch(() => {}) }, 15000)
})()

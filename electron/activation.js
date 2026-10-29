/**
 * CR破甲助手 Mac 复刻 · 领域文字激活
 * 契约与原版 activation.js 一致：
 *   启动XX领域 / 切换XX领域 = 激活；同时启动 A 和 B = 多领域并存（第一个为主领域）
 *   关闭XX领域 / 关闭技能 = 移除；激活持续到关闭或切换
 * Mac 落点：~/.cr-mac/activation_state.json（主进程与钩子共读）
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { crBaseDir } = require('./channels')

const DOMAINS = [
  { id: 'l-license', label: '破解领域', aliases: ['破解', '破解技能', '卡密', '授权', '注册机', '激活码', '去授权', '免激活', 'license', 'keygen', 'crack'] },
  { id: 'l-reverse', label: '逆向领域', aliases: ['逆向', '逆向技能', '反编译', '反汇编', '脱壳', '逆向工程', 'reverse'] },
  { id: 'l-gameassist', label: '游戏领域', aliases: ['游戏', '游戏技能', '外挂', '游戏客户端', 'game', 'gameassist'] },
  { id: 'l-webrecon', label: '渗透领域', aliases: ['渗透', '渗透技能', 'web', 'webrecon', '红队', '内网'] }
]
const IDS = DOMAINS.map((d) => d.id)
const LABEL = new Map(DOMAINS.map((d) => [d.id, d.label]))

function statePath() {
  if (process.env.CR_ACTIVATION_STATE) return process.env.CR_ACTIVATION_STATE
  return path.join(crBaseDir(), 'activation_state.json')
}

function emptyState() {
  return { entry: '', label: '', entries: [], labels: [], updatedAt: '' }
}

function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    const entries = Array.isArray(j.entries) ? j.entries.filter((x) => IDS.includes(x)) : (IDS.includes(j.entry) ? [j.entry] : [])
    return {
      entry: entries[0] || '',
      label: entries[0] ? LABEL.get(entries[0]) : '',
      entries,
      labels: entries.map((id) => LABEL.get(id)),
      updatedAt: j.updatedAt || ''
    }
  } catch { return emptyState() }
}

function writeState(st) {
  const file = statePath()
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* 已存在 */ }
  const entries = (st.entries || []).filter((x) => IDS.includes(x))
  const out = {
    entry: entries[0] || '',
    label: entries[0] ? LABEL.get(entries[0]) : '',
    entries,
    labels: entries.map((id) => LABEL.get(id)),
    updatedAt: new Date().toISOString()
  }
  const tmp = file + '.cr-tmp'
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return out
}

function clearState() {
  return writeState(emptyState())
}

function resolveDomain(word) {
  const w = String(word || '').trim().toLowerCase()
  if (!w) return ''
  for (const d of DOMAINS) {
    if (d.id.toLowerCase() === w) return d.id
    if (d.aliases.some((a) => a.toLowerCase() === w)) return d.id
  }
  return ''
}

/**
 * 解析一条用户消息是否是激活/关闭指令。
 * 返回 { cmd: {action:'add'|'remove'|'clear', ids:[...]}, state } 或 null。
 */
function parseCommand(text) {
  const t = String(text || '').trim()
  if (!t) return null
  // 关闭技能 / 关闭所有领域 / 关闭XX领域
  let m = /^(?:关闭|停用)(?:所有|全部)?技能$/.exec(t) || /^(?:关闭|停用)(?:所有|全部)领域$/.exec(t)
  if (m) return { action: 'clear', ids: [] }
  m = /^(?:关闭|停用)(.+?)(?:领域|技能)$/.exec(t)
  if (m) {
    const id = resolveDomain(m[1])
    if (id) return { action: 'remove', ids: [id] }
    return null
  }
  // 启动/切换/同时启动
  m = /^(?:同时启动|追加|再加|启动|切换|启用)(.+?)(?:领域|技能)?$/.exec(t)
  if (!m) return null
  const rest = m[1]
  // 中文顿号/逗号/和 分隔多领域
  const parts = rest.split(/[、,，]|和/).map((x) => x.trim()).filter(Boolean)
  const ids = parts.map(resolveDomain).filter(Boolean)
  if (!ids.length) return null
  const isMulti = /^(?:同时启动|追加|再加)/.test(t)
  return { action: isMulti ? 'add' : 'replace', ids }
}

function handle(text) {
  const cmd = parseCommand(text)
  if (!cmd) return null
  const st = readState()
  let entries = st.entries || []
  if (cmd.action === 'clear') entries = []
  else if (cmd.action === 'remove') entries = entries.filter((x) => !cmd.ids.includes(x))
  else if (cmd.action === 'replace') entries = cmd.ids.slice()
  else if (cmd.action === 'add') {
    for (const id of cmd.ids) if (!entries.includes(id)) entries.push(id)
  }
  const next = writeState({ entries })
  return { cmd, state: next }
}

/** 激活说明（注入 additionalContext 用） */
function notice(st) {
  if (!st.entries.length) return ''
  const lines = [
    `## 当前激活领域（操作者本人设定）`,
    `已激活：${st.labels.join('、')}（主领域：${st.label}）。`,
    `激活期间：按主领域入口执行相关任务；关键词自动路由已停用，等操作者切换或关闭。`,
    `关闭单个：「关闭${st.label}」；全部关闭：「关闭技能」。`
  ]
  return lines.join('\n')
}

module.exports = { DOMAINS, IDS, readState, writeState, clearState, resolveDomain, parseCommand, handle, notice, statePath }

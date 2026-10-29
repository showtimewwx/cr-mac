/**
 * CR破甲助手 Mac 复刻 · 注入编排器
 *
 * 由 Windows 版 injector.jsc（bytenode 字节码）的对外契约重写：
 *   inject(clientId, dir, opts) → { ok, client, channels:[{ch,file,status,detail}], injectedAt }
 *   dryRun(clientId, dir, opts) → 同上（不落盘）
 *   revoke(clientId, dir)       → { ok, restored/removed/sanitized }
 *   status(clientId, dir)       → 每通道 managed / missing
 * 流程：enumerate → guard → ensureWrapper → backupOnce → 按 kind 分发 patcher
 *       → 回读自证（patcher 内）→ 账本登记（files[path] = {sha,bak,created,at}）
 */
'use strict'

const fs = require('fs')
const path = require('path')
const chan = require('./channels')
const { sha256, sig16 } = chan

function hookParamsFor(clientId, ctx) {
  // Mac 统一走 ~/.cr-mac/bin/cr-hook-<client> 包装脚本（无空格路径，全客户端通用）
  if (ctx.dryRun) {
    // 干跑不落盘：返回虚拟路径（patchJsonHooks 对 dry 也只用它做 schema 判定）
    return { hookCmd: chan.hookWrapperPath(clientId) }
  }
  const w = chan.ensureHookWrapper(clientId, {
    hookExec: ctx.hookExec,
    hookIsNode: !!ctx.hookIsNode,
    hookScript: ctx.hookScript,
    hookAppDir: ctx.hookAppDir
  })
  if (!w.ok) return { error: w.error }
  return { hookCmd: w.wrapper, wrapper: w.wrapper }
}

function applyOne(target, ctx, clientId) {
  const { ch, file, meta } = target
  const kind = meta ? meta.kind : 'text-block'
  const dataDir = ctx.dataDir
  // 守卫基准：默认客户端数据根；cursor 项目级/workbuddy 跨目录锚点带自己的 guardBase
  const guard = chan.guardTarget(target.guardBase || dataDir, file)
  if (!guard.ok) return { ch, file, status: 'skip', detail: '目标守卫拒绝：' + guard.why }
  // 注意：不做全局"文件不存在即跳过"门禁 —— toml-key / codex-hook-state / dsh 系列
  // patcher 自带缺文件语义（fresh 安装时 codex-toml 正是要负责创建 config.toml，
  // 信任登记随后跟进）。optional 目标缺失才跳过。
  if (!fs.existsSync(file) && target.optional) {
    return { ch, file, status: 'skip', detail: '目标不存在（optional）' }
  }
  try {
    let r
    switch (kind) {
      case 'text-block':
        r = chan.patchTextBlock(file, ctx, { create: target.create })
        break
      case 'write-payload':
        r = chan.patchWriteFile(file, ctx, { content: () => chan.sealBlock(ctx.blockBody) })
        break
      case 'write-file':
        r = chan.patchWriteFile(file, ctx, { content: target.content ? () => target.content() : () => ctx.blockBody, chmod: target.chmod })
        break
      case 'json-hooks': {
        const hp = hookParamsFor(clientId, ctx)
        if (hp.error) return { ch, file, status: 'error', detail: '钩子包装失败：' + hp.error }
        let shape = 'generic'
        let events = chan.HOOK_EVENTS.wb
        if (clientId === 'claude') { shape = 'claude'; events = chan.HOOK_EVENTS.claude }
        else if (clientId === 'zcode') { shape = 'zcode'; events = chan.HOOK_EVENTS.zcode }
        else if (clientId === 'codex') { shape = 'codex'; events = chan.HOOK_EVENTS.codex }
        else if (clientId === 'hermes') { shape = 'generic'; events = chan.HOOK_EVENTS.hermes }
        else { shape = 'wb'; events = chan.HOOK_EVENTS.wb }
        r = chan.patchJsonHooks(file, ctx, { events, hookCmd: hp.hookCmd, shape })
        break
      }
      case 'toml-key':
        r = chan.patchTomlKey(file, ctx, target.payloadFile)
        break
      case 'codex-hook-state':
        r = chan.patchCodexHookState(file, ctx)
        break
      case 'claude-statusline':
        r = chan.patchClaudeStatusLine(file, ctx)
        break
      case 'dsh-preset':
        r = chan.patchDshPreset(file, ctx)
        break
      case 'dsh-settings':
        r = chan.patchDshSettings(file, ctx)
        break
      case 'cursor-rules':
        r = chan.patchWriteFile(file, ctx, { content: target.content ? () => target.content() : () => ctx.blockBody, overwrite: true })
        break
      case 'unsupported':
        r = { status: 'skip', detail: '该通道在 Mac 复刻版未实现（见 README 范围说明）' }
        break
      default:
        r = { status: 'error', detail: '未知通道 kind：' + kind }
    }
    return { ch, file, status: r.status, detail: r.detail || '' }
  } catch (err) {
    return { ch, file, status: 'error', detail: String(err && err.stack || err).slice(0, 500) }
  }
}

/**
 * 注入 / 干跑。
 * opts: { tierName, clientName, verifyReply, handshakeReply, blockBody(可选，默认读 payload),
 *         hookExec, hookIsNode, hookScript, projects(cursor 项目级，可选数组) }
 */
function inject(clientId, dir, opts = {}) {
  const dataDir = dir || chan.clientDir(clientId)
  if (!dataDir) return { ok: false, reason: 'unknown-client', error: '未知客户端' }
  if (!fs.existsSync(path.dirname(dataDir))) {
    return { ok: false, reason: 'client-dir-missing', error: `客户端目录不存在：${dataDir}（先安装客户端再注入）` }
  }
  const dryRun = !!opts.dryRun
  const blockBody = opts.blockBody != null ? opts.blockBody : loadPayloadBody(clientId)
  const ctx = {
    dataDir,
    dryRun,
    tierName: opts.tierName || '本地版',
    blockBody: blockBody && blockBody.trim() ? blockBody.trim() : blockBody,
    projects: opts.projects || []
  }
  ctx.hookExec = opts.hookExec
  ctx.hookIsNode = !!opts.hookIsNode
  ctx.hookScript = opts.hookScript
  ctx.hookAppDir = opts.hookAppDir
  if (dryRun && !ctx.hookExec) {
    // 干跑无宿主进程：用 node 脚本形态探测包装可生成性
    ctx.hookExec = process.execPath
    ctx.hookIsNode = true
    ctx.hookScript = path.join(__dirname, 'hook.js')
  }
  const targets = chan.enumerateChannels(clientId, ctx)
  const registry = chan.CLIENT_CHANNELS[clientId] || []
  const results = targets.map((t) => applyOne({
    ch: t.ch,
    file: t.file,
    create: t.create,
    optional: t.optional,
    content: t.content,
    payloadFile: t.payloadFile,
    chmod: t.chmod,
    guardBase: t.guardBase,
    meta: registry.find((c) => c.id === t.ch) || null,
    existedBefore: fs.existsSync(t.file)
  }, ctx, clientId))
  const hadError = results.some((x) => x.status === 'error')
  if (!dryRun && !hadError) writeLedgerFor(dataDir, results, targets)
  return {
    ok: !hadError,
    client: clientId,
    dataDir,
    channels: results,
    count: { ok: results.filter((x) => x.status === 'ok').length, already: results.filter((x) => x.status === 'already').length, skip: results.filter((x) => x.status === 'skip' || x.status === 'dry').length, error: results.filter((x) => x.status === 'error').length }
  }
}

function dryRun(clientId, dir, opts = {}) {
  return inject(clientId, dir, Object.assign({}, opts, { dryRun: true }))
}

function writeLedgerFor(dataDir, results, targets) {
  const led = chan.loadLedger(dataDir) || { files: {} }
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status !== 'ok' && r.status !== 'already') continue
    const t = targets[i]
    let sha = ''
    try { sha = sha256(fs.readFileSync(r.file)) } catch { sha = '' }
    const prev = led.files[r.file]
    // created 语义：本文件在「本轮任何通道写入之前」就不存在（existedBefore 在通道枚举
    // 前统一采集）。同一文件被多个通道先后写（config.toml: toml-key → hook-state）时，
    // 第一条登记为 created=true，后写的通道只更新 sha/ch，绝不能把 created 翻回 false。
    const firstTouchCreated = prev ? prev.created : (t && t.create && !t.existedBefore ? true : false)
    const earliestCreate = (t && t.create && !t.existedBefore) || (prev && prev.created)
    led.files[r.file] = {
      sha,
      ch: r.ch,
      bak: prev && prev.bak ? prev.bak : sig16(r.file) + chan.BAK_SUFFIX,
      created: earliestCreate ? true : firstTouchCreated,
      at: new Date().toISOString()
    }
  }
  led.injectedAt = new Date().toISOString()
  chan.saveLedger(dataDir, led)
}

function revoke(clientId, dir) {
  const dataDir = dir || chan.clientDir(clientId)
  if (!dataDir) return { ok: false, reason: 'unknown-client', error: '未知客户端' }
  const r = chan.revokeChannelFiles(dataDir)
  return Object.assign({ ok: r.ok !== false, client: clientId, dataDir }, r)
}

/** 状态探测：每通道封条/托管态在不在 */
function status(clientId, dir) {
  const dataDir = dir || chan.clientDir(clientId)
  if (!dataDir || !fs.existsSync(dataDir)) {
    return { ok: true, client: clientId, installed: false, channels: [] }
  }
  const led = chan.loadLedger(dataDir)
  // blockBody 必须给真载荷：cursor 等分片通道的枚举数量依赖正文（空正文=只有 1 个空分片，状态面板会误报）
  const ctx = { dataDir, dryRun: true, blockBody: loadPayloadBody(clientId) || '', projects: [] }
  const targets = chan.enumerateChannels(clientId, ctx)
  const channels = targets.map((t) => {
    let state = 'missing'
    if (fs.existsSync(t.file)) {
      try {
        const text = chan.readText(t.file).text
        if (chan.sealPresent(text) || chan.isCrManagedText(text)) state = 'managed'
        else state = 'pristine'
      } catch { state = 'unreadable' }
    }
    return { ch: t.ch, label: labelOf(clientId, t.ch), file: t.file, state }
  })
  return {
    ok: true,
    client: clientId,
    installed: true,
    dataDir,
    ledger: led ? { injectedAt: led.injectedAt, files: Object.keys(led.files || {}).length } : null,
    managedCount: channels.filter((c) => c.state === 'managed').length,
    channels
  }
}

function labelOf(clientId, chId) {
  const list = chan.CLIENT_CHANNELS[clientId] || []
  const hit = list.find((c) => c.id === chId)
  return hit ? hit.label : chId
}

/** 用户覆写 > claude=洁净档 / dsh=事实档 / 其余=默认档 */
function loadPayloadBody(clientId) {
  const override = chan.readPayloadOverride()
  if (override) return override
  const base = path.join(__dirname, 'payload.md')
  const clean = path.join(__dirname, 'payload-clean.md')
  const facts = path.join(__dirname, 'payload-facts.md')
  const pick = clientId === 'claude' ? clean : clientId === 'dsh' ? facts : base
  const cands = [pick, base]
  for (const p of cands) {
    try { return fs.readFileSync(p, 'utf8') } catch { /* 试下一个 */ }
  }
  return ''
}

module.exports = { inject, dryRun, revoke, status, loadPayloadBody }

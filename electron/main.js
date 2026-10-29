/**
 * CR破甲助手 Mac 复刻 · Electron 主进程
 *
 * 结构对齐原版 main.js 的关键分叉：
 *   --hook        → 钩子运行模式（任何窗口逻辑之前处理并退出）
 *   --selftest    → 通道引擎自检（发版回归用）
 *   正常启动       → 主窗口 + 托盘 + IPC + 守护定时器
 */
'use strict'

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog, nativeTheme } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ── 钩子模式：必须在任何窗口/单实例逻辑之前 ──
// 必须在 require ./channels（其顶层会 require ./codexHooks 之外的纯 Node 模块）之前处理：
// Electron 主进程的 require('electron') 已经成功（顶部语句），这里直接跑钩子并退出，
// 不触发 app.whenReady/单实例锁/窗口。
if (process.argv.includes('--hook')) {
  try {
    require('./hook').main(process.argv)
  } catch (err) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n')
  }
  process.exit(0)
}

const chan = require('./channels')
const injector = require('./injector')
const activation = require('./activation')

// ── 自检模式 ──
if (process.argv.includes('--selftest')) {
  const r = require('./selftest').run()
  process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  process.exit(r.ok ? 0 : 1)
}

let win = null
let tray = null
let guardTimer = null
const GUARD_INTERVAL_MS = 5 * 60 * 1000
const logLines = []

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`
  logLines.push(entry)
  if (logLines.length > 500) logLines.splice(0, logLines.length - 500)
  console.log(entry)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 1024,
    minHeight: 680,
    title: 'CR破甲助手 Mac 复刻',
    backgroundColor: '#0d0e11',
    // macOS 原生红绿灯 + 无原生标题栏：自绘顶栏成为拖拽区（Linear/Arc 同款形态）
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 20 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => win.show())
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  win.on('closed', () => { win = null })
}

/** 客户端数据目录（带手动覆写记忆，UI 可改） */
const DIR_MEMO_FILE = () => path.join(chan.crBaseDir(), 'dir-memo.json')
function dirMemo() {
  try { return JSON.parse(fs.readFileSync(DIR_MEMO_FILE(), 'utf8')) } catch { return {} }
}
function effectiveClientDir(clientId) {
  const memo = dirMemo()
  if (memo[clientId] && fs.existsSync(memo[clientId])) return memo[clientId]
  const d = chan.clientDir(clientId)
  return d && fs.existsSync(d) ? d : (memo[clientId] || d || '')
}

/** 注入 opts（与原版 main.js inject:run 同口径：钩子命令指向包装脚本）
 *  dev 态：Electron 二进制必须带 app 目录参数（--hook 分支在窗口前处理）
 *  打包态：execPath 即应用二进制 */
function injectOpts() {
  const packaged = app.isPackaged
  return {
    tierName: '本地版',
    hookExec: process.execPath,
    hookIsNode: false,
    hookAppDir: packaged ? '' : path.dirname(__dirname),
    hookScript: path.join(__dirname, 'hook.js'),
    verifyReply: 'CR-MAC已生效 · ' + 'v' + app.getVersion(),
    handshakeReply: 'CR-MAC 通道就绪 v' + app.getVersion()
  }
}

// ── IPC 面（对齐原版命名：inject:run / inject:dryRun / inject:revoke / inject:status …） ──

function sendToUi(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload) } catch { /* 忽略 */ }
}

// ── UI 设置（主题持久化 + 系统外观跟随） ──
const THEMES = ['dark', 'light', 'midnight', 'contrast']
const UI_SETTINGS_FILE = () => path.join(chan.crBaseDir(), 'ui-settings.json')

function readUiSettings() {
  try { return JSON.parse(fs.readFileSync(UI_SETTINGS_FILE(), 'utf8')) } catch { return {} }
}
function writeUiSettings(s) {
  try {
    fs.mkdirSync(chan.crBaseDir(), { recursive: true })
    fs.writeFileSync(UI_SETTINGS_FILE(), JSON.stringify(s, null, 2))
  } catch { /* 忽略 */ }
}
/** 解析 settings.theme 到实际生效主题（system → dark/light） */
function effectiveTheme() {
  const s = readUiSettings()
  const t = s.theme
  if (t === 'system') return nativeTheme.shouldUseDarkSources ? 'dark' : 'light'
  return THEMES.includes(t) ? t : 'dark'
}

function registerIpc() {
  ipcMain.handle('ui:get-theme', () => {
    const s = readUiSettings()
    return { theme: THEMES.includes(s.theme) || s.theme === 'system' ? s.theme : 'dark', effective: effectiveTheme() }
  })
  ipcMain.handle('ui:set-theme', (_e, theme) => {
    if (theme !== 'system' && !THEMES.includes(theme)) return { ok: false, error: '未知主题：' + theme }
    writeUiSettings({ theme })
    // 同步窗口底色（避免浅色主题下重启闪深色）
    try { if (win) win.setBackgroundColor(theme === 'light' ? '#f6f6f7' : theme === 'midnight' ? '#0a0f1c' : theme === 'contrast' ? '#000000' : '#0d0e11') } catch { /* 忽略 */ }
    return { ok: true, theme, effective: effectiveTheme() }
  })

  ipcMain.handle('client:manifests', () => {
    return Object.keys(chan.CLIENT_DIRS).map((id) => {
      const dir = effectiveClientDir(id)
      const installed = !!dir && fs.existsSync(dir)
      return {
        id,
        name: chan.CLIENT_NAMES[id],
        dir,
        installed,
        mac: id !== 'doubao',
        note: id === 'doubao' ? 'Windows 专属客户端（云端记忆通道），Mac 复刻版不支持' : '',
        channels: (chan.CLIENT_CHANNELS[id] || []).map((c) => ({ id: c.id, label: c.label, kind: c.kind }))
      }
    })
  })

  ipcMain.handle('inject:run', async (_e, clientId, _dir, opts) => {
    const dir = effectiveClientDir(clientId)
    if (!dir) return { ok: false, reason: 'unknown-client', error: '未知客户端' }
    log(`inject:run ${clientId} → ${dir}`)
    const result = injector.inject(clientId, dir, Object.assign({}, injectOpts(), opts || {}))
    log(`inject:run ${clientId} 完成 ok=${result.ok} ok=${(result.count || {}).ok} error=${(result.count || {}).error}`)
    return result
  })

  ipcMain.handle('inject:dryRun', async (_e, clientId, _dir, opts) => {
    const dir = effectiveClientDir(clientId)
    if (!dir) return { ok: false, reason: 'unknown-client', error: '未知客户端' }
    return injector.dryRun(clientId, dir, Object.assign({}, injectOpts(), opts || {}))
  })

  ipcMain.handle('inject:revoke', async (_e, clientId, _dir) => {
    const dir = effectiveClientDir(clientId)
    if (!dir) return { ok: false, reason: 'unknown-client', error: '未知客户端' }
    log(`inject:revoke ${clientId} → ${dir}`)
    return injector.revoke(clientId, dir)
  })

  ipcMain.handle('inject:status', async (_e, clientId) => injector.status(clientId, effectiveClientDir(clientId)))

  ipcMain.handle('dir:get', (_e, clientId) => effectiveClientDir(clientId))
  ipcMain.handle('dir:pick', async (_e, clientId) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { ok: false }
    const memo = dirMemo()
    memo[clientId] = r.filePaths[0]
    fs.mkdirSync(chan.crBaseDir(), { recursive: true })
    fs.writeFileSync(DIR_MEMO_FILE(), JSON.stringify(memo, null, 2))
    return { ok: true, dir: r.filePaths[0] }
  })
  ipcMain.handle('dir:reset', (_e, clientId) => {
    const memo = dirMemo()
    delete memo[clientId]
    fs.writeFileSync(DIR_MEMO_FILE(), JSON.stringify(memo, null, 2))
    return { ok: true, dir: chan.clientDir(clientId) }
  })

  ipcMain.handle('dir:open', async (_e, clientId) => {
    const dir = effectiveClientDir(clientId)
    if (dir && fs.existsSync(dir)) { shell.openPath(dir); return { ok: true } }
    return { ok: false, error: '目录不存在' }
  })

  ipcMain.handle('activation:state', () => activation.readState())
  ipcMain.handle('activation:set', (_e, entries) => activation.writeState({ entries: Array.isArray(entries) ? entries : [] }))
  ipcMain.handle('activation:clear', () => activation.clearState())

  ipcMain.handle('payload:get', () => {
    // 用户覆写（~/.cr-mac）优先；无覆写回内置 payload.md（打包态在 asar 内只读）
    const override = chan.readPayloadOverride()
    if (override) return override
    try { return fs.readFileSync(path.join(__dirname, 'payload.md'), 'utf8') } catch { return '' }
  })
  ipcMain.handle('payload:save', (_e, text) => {
    try {
      chan.writePayloadOverride(String(text || ''))
      return { ok: true }
    } catch (err) { return { ok: false, error: String(err && err.message) } }
  })

  ipcMain.handle('log:tail', () => logLines.slice(-200))

  ipcMain.handle('guard:state', () => ({
    enabled: !!guardTimer,
    intervalMs: GUARD_INTERVAL_MS,
    targets: guardTargets
  }))
  ipcMain.handle('guard:toggle', (_e, on) => {
    if (on) ensureGuard()
    else stopGuard()
    return { ok: true, enabled: !!guardTimer }
  })

  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:close', () => win && win.close())
  ipcMain.handle('win:isMaximized', () => !!win && win.isMaximized())
  win && win.on('maximize', () => sendToUi('win:maximized', true))
  win && win.on('unmaximize', () => sendToUi('win:maximized', false))
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url)
    return { ok: true }
  })
}

// ── 守护：注入成功的客户端定期检查封条，被客户端清场/换版后自动补打 ──
const guardTargets = new Map() // clientId → {dir, opts}

function registerGuardTarget(clientId, dir) {
  guardTargets.set(clientId, { dir, opts: injectOpts() })
}

function ensureGuard() {
  if (guardTimer) return
  guardTimer = setInterval(async () => {
    for (const [clientId, t] of guardTargets) {
      try {
        const st = injector.status(clientId, t.dir)
        const managed = (st.channels || []).filter((c) => c.state === 'managed').length
        const total = (st.channels || []).filter((c) => c.state !== 'missing').length
        if (total > 0 && managed === 0) {
          log(`guard: ${clientId} 封条全部丢失，自动补打`)
          injector.inject(clientId, t.dir, t.opts)
        }
      } catch (err) {
        log(`guard: ${clientId} 检查异常 ${err}`)
      }
    }
  }, GUARD_INTERVAL_MS)
  if (guardTimer.unref) guardTimer.unref()
}

function stopGuard() {
  if (guardTimer) { clearInterval(guardTimer); guardTimer = null }
}

// ── 托盘 ──
function createTray() {
  try {
    const icon = nativeImage.createEmpty()
    tray = new Tray(icon)
    tray.setToolTip('CR破甲助手 Mac 复刻')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主界面', click: () => { if (win) win.show(); else createWindow() } },
      { label: '退出', click: () => app.quit() }
    ]))
  } catch { /* 托盘不可用时忽略 */ }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })
  app.whenReady().then(() => {
    fs.mkdirSync(chan.crBaseDir(), { recursive: true })
    fs.mkdirSync(path.join(chan.crBaseDir(), 'skills'), { recursive: true })
    registerIpc()
    // 初始主题（含 system 跟随后的窗口底色）
    const t0 = effectiveTheme()
    try { win.setBackgroundColor(t0 === 'light' ? '#f6f6f7' : t0 === 'midnight' ? '#0a0f1c' : t0 === 'contrast' ? '#000000' : '#0d0e11') } catch { /* 忽略 */ }
    createWindow()
    createTray()
    // 系统外观变化 → 通知渲染层（theme=system 时实时切换）
    nativeTheme.on('updated', () => sendToUi('theme:system-changed', effectiveTheme()))
    // 已注入过的客户端重启后恢复守护
    for (const id of Object.keys(chan.CLIENT_DIRS)) {
      const dir = effectiveClientDir(id)
      if (dir && fs.existsSync(path.join(dir, '.cr-pojia', 'ledger.json'))) registerGuardTarget(id, dir)
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
    // mac：保留托盘常驻
  })
  app.on('activate', () => { if (!win) createWindow() })
}

app.on('before-quit', () => stopGuard())

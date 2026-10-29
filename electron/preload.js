/**
 * CR破甲助手 Mac 复刻 · preload（contextIsolation，白名单 IPC 面）
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('cr', {
  // 客户端清单 / 注入四动作
  clientManifests: () => invoke('client:manifests'),
  inject: (clientId, opts) => invoke('inject:run', clientId, null, opts),
  dryRun: (clientId, opts) => invoke('inject:dryRun', clientId, null, opts),
  revoke: (clientId) => invoke('inject:revoke', clientId, null),
  status: (clientId) => invoke('inject:status', clientId),
  // 目录
  dirGet: (clientId) => invoke('dir:get', clientId),
  dirPick: (clientId) => invoke('dir:pick', clientId),
  dirReset: (clientId) => invoke('dir:reset', clientId),
  dirOpen: (clientId) => invoke('dir:open', clientId),
  // 激活
  activationState: () => invoke('activation:state'),
  activationSet: (entries) => invoke('activation:set', entries),
  activationClear: () => invoke('activation:clear'),
  // 载荷编辑
  payloadGet: () => invoke('payload:get'),
  payloadSave: (text) => invoke('payload:save', text),
  // 日志 / 守护
  logTail: () => invoke('log:tail'),
  guardState: () => invoke('guard:state'),
  guardToggle: (on) => invoke('guard:toggle', on),
  // 窗口
  winMinimize: () => invoke('win:minimize'),
  winToggleMaximize: () => invoke('win:toggleMaximize'),
  winClose: () => invoke('win:close'),
  winIsMaximized: () => invoke('win:isMaximized'),
  openExternal: (url) => invoke('shell:openExternal', url),
  // 主题
  uiGetTheme: () => invoke('ui:get-theme'),
  uiSetTheme: (theme) => invoke('ui:set-theme', theme),
  onThemeSystemChanged: (cb) => {
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on('theme:system-changed', listener)
    return () => ipcRenderer.removeListener('theme:system-changed', listener)
  }
})

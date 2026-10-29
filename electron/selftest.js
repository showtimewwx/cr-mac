/**
 * CR破甲 Mac 复刻 · 通道引擎自检（--selftest，对齐原版发版回归口径）
 * 沙箱 home（CR_TEST_HOME）内做完整 inject → verify → revoke → verify 回路。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const cp = require('child_process')

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-mac-selftest-'))
  process.env.CR_TEST_HOME = tmp
  process.env.CR_MAC_BASE = path.join(tmp, '.cr-mac')
  delete require.cache[require.resolve('./channels')]
  delete require.cache[require.resolve('./injector')]
  delete require.cache[require.resolve('./activation')]
  const chan = require('./channels')
  const injector = require('./injector')

  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' })

  // 沙箱客户端目录
  for (const id of ['codex', 'claude', 'zcode', 'dsh', 'hermes']) {
    const dir = path.join(tmp, chan.CLIENT_DIRS[id][0])
    fs.mkdirSync(dir, { recursive: true })
  }
  // 一个"已有用户配置"的 Claude（备份还原路径必须走）
  fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: 'bar' } }, null, 2))
  fs.writeFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), '# 我的现有记忆\n\n勿动。\n')

  const hookExec = process.execPath
  const hookScript = path.join(__dirname, 'hook.js')
  const opts = {
    tierName: '自检',
    hookExec,
    hookIsNode: true,
    hookScript,
    verifyReply: 'CR-MAC自检回执',
    handshakeReply: 'CR-MAC自检握手'
  }

  for (const clientId of ['codex', 'claude', 'zcode', 'dsh', 'hermes']) {
    const dir = path.join(tmp, chan.CLIENT_DIRS[clientId][0])
    const r = injector.inject(clientId, dir, opts)
    const errs = (r.channels || []).filter((c) => c.status === 'error')
    check(`inject:${clientId}`, r.ok && errs.length === 0, errs.map((e) => e.ch + ':' + e.detail).join(' | '))

    // 回读自证：每通道 managed
    const st = injector.status(clientId, dir)
    const missingManaged = (st.channels || []).filter((c) => c.state === 'pristine')
    check(`status:${clientId}`, st.managedCount > 0 && missingManaged.length === 0,
      missingManaged.map((c) => c.ch).join(','))

    // 钩子可执行且输出合法 JSON（针对有钩子的客户端）
    if (['codex', 'claude', 'zcode', 'hermes'].includes(clientId)) {
      try {
        const wrapper = chan.hookWrapperPath(clientId)
        const out = cp.spawnSync(wrapper, [], {
          input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '分析这个样本' }),
          encoding: 'utf8', timeout: 10000
        })
        const line = String(out.stdout || '').split('\n').filter(Boolean).pop() || ''
        const j = JSON.parse(line)
        const hasCtx = j && j.hookSpecificOutput && typeof j.hookSpecificOutput.additionalContext === 'string' &&
          j.hookSpecificOutput.additionalContext.length > 200
        check(`hook:${clientId}`, out.status === 0 && hasCtx, 'exit=' + out.status + ' stdout=' + String(out.stdout).slice(0, 80))
      } catch (err) {
        check(`hook:${clientId}`, false, String(err && err.message))
      }
    }
  }

  // 验证词短路
  try {
    const wrapper = chan.hookWrapperPath('claude')
    const out = cp.spawnSync(wrapper, [], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'CR' }),
      encoding: 'utf8', timeout: 10000
    })
    const line = String(out.stdout || '').split('\n').filter(Boolean).pop() || ''
    const j = JSON.parse(line)
    check('hook:verify-word', /CR-MAC已生效/.test(j.hookSpecificOutput && j.hookSpecificOutput.additionalContext || ''), line.slice(0, 120))
  } catch (err) {
    check('hook:verify-word', false, String(err && err.message))
  }

  // 撤销 → pristine 全还原
  for (const clientId of ['codex', 'claude', 'zcode', 'dsh', 'hermes']) {
    const dir = path.join(tmp, chan.CLIENT_DIRS[clientId][0])
    const rv = injector.revoke(clientId, dir)
    check(`revoke:${clientId}`, rv.ok !== false, JSON.stringify(rv.missing || []).slice(0, 200))
  }
  // Claude 原配置逐字还原
  const cs = fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8')
  const cm = fs.readFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf8')
  check('revoke:claude-settings-byte-exact', cs.includes('"FOO": "bar"') && !cs.includes('CR-MAC') && !cs.includes('hooks'), cs.slice(0, 120))
  check('revoke:claude-md-byte-exact', cm === '# 我的现有记忆\n\n勿动。\n', JSON.stringify(cm.slice(0, 60)))

  // ── BUG-B 回归：codex hooks.state 键必须与 codex 内部口径同形（带引号路径键） ──
  {
    const codexDir = path.join(tmp, '.codex')
    fs.rmSync(codexDir, { recursive: true, force: true })
    fs.mkdirSync(codexDir, { recursive: true })
    const r = injector.inject('codex', codexDir, opts)
    const toml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')
    const hooksJson = path.join(codexDir, 'hooks.json')
    const wantKey = `${hooksJson}:user_prompt_submit:0:0`
    check('codex-state:key-shape', toml.includes(`[hooks.state."${wantKey}"]`),
      '缺带引号路径键，codex 侧将静默跳过钩子；实际 config.toml 头：' + toml.split('\n').slice(-6, -1).join(' / '))
    // 重注入幂等：不得产生第二张同名表（duplicate table 会让 codex 起不来）
    injector.inject('codex', codexDir, opts)
    const toml2 = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8')
    const n = toml2.split('\n').filter((l) => l.includes('[hooks.state."')).length
    check('codex-state:unique-on-reinject', n === 1, `重注入后信任登记出现 ${n} 处`)
    // 钩子定义里的 timeout/statusMessage 进哈希（用真 hooks.json 内容反推）
    const hj = JSON.parse(fs.readFileSync(hooksJson, 'utf8'))
    const hook = hj.hooks.UserPromptSubmit[0].hooks[0]
    const wantHash = chan.codexHookTrustedHash(hook.command, hook.timeout, hook.statusMessage)
    check('codex-state:hash-consistent', toml2.includes(wantHash), '登记哈希与 hooks.json 实际定义不符')
    // 撤销（读撤销后的终态；config.toml 为 create 型新文件，撤销会整删——存在性即"清理干净"）
    injector.revoke('codex', codexDir)
    const tomlFile = path.join(codexDir, 'config.toml')
    const toml3 = fs.existsSync(tomlFile) ? fs.readFileSync(tomlFile, 'utf8') : ''
    check('codex-state:revoke-cleans', toml3 === '' || (!toml3.includes('cr:hooks-state') && !toml3.includes('trusted_hash')),
      '撤销后信任登记残留：' + toml3.slice(0, 120))
  }

  // ── BUG-E 回归：created 文件被用户改过后撤销不得整删 ──
  {
    const zdir = path.join(tmp, '.zcode')
    fs.rmSync(zdir, { recursive: true, force: true })
    fs.mkdirSync(path.join(zdir, 'cli'), { recursive: true })
    injector.inject('zcode', zdir, opts)
    const cfgFile = path.join(zdir, 'cli', 'config.json')
    // 用户后续改了这份我们创建的文件（ZCode 真会这么干：写入自身设置）
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.userSetting = '用户后来加的'
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2))
    const rv = injector.revoke('zcode', zdir)
    const after = fs.readFileSync(cfgFile, 'utf8')
    check('revoke:created-file-user-modified-kept',
      after.includes('"userSetting"') && !after.includes('CR-MAC') && !after.includes('cr-hook'),
      '用户改过的 created 文件被整删或 CR 残留：' + after.slice(0, 150))
  }

  // ── BUG-C 回归：cursor 项目级目标不被守卫误拒 ──
  {
    const cdir = path.join(tmp, '.cursor')
    fs.rmSync(cdir, { recursive: true, force: true })
    const proj = path.join(tmp, 'myproj')
    fs.mkdirSync(proj, { recursive: true })
    const r = injector.inject('cursor', cdir, Object.assign({}, opts, { projects: [proj] }))
    const projFile = path.join(proj, '.cursor', 'rules', 'cr-00-policy.mdc')
    check('cursor:project-level-guard-pass', fs.existsSync(projFile),
      '项目级规则未写入；通道结果：' + (r.channels || []).filter((c) => c.ch === 'cursor-rules-project').map((c) => c.status + ':' + c.detail).join(','))
    // 撤销（按账本）应清掉项目级文件
    injector.revoke('cursor', cdir)
    check('cursor:project-level-revoke', !fs.existsSync(projFile), '撤销后项目级规则残留')
  }

  // ── BUG-D 回归：用户覆写载荷生效 ──
  {
    const w = chan.writePayloadOverride('# 覆写载荷\n\n测试正文。')
    const zdir = path.join(tmp, '.zcode')
    fs.rmSync(zdir, { recursive: true, force: true })
    fs.mkdirSync(zdir, { recursive: true })
    injector.inject('zcode', zdir, opts)
    const agents = fs.readFileSync(path.join(zdir, 'AGENTS.md'), 'utf8')
    check('payload:override-applied', agents.includes('覆写载荷') && !agents.includes('运行契约（先读这一节）'),
      '覆写未生效，AGENTS.md 头部：' + agents.slice(0, 100))
    // 清覆写，避免影响后续检查
    try { fs.rmSync(chan.payloadOverridePath(), { force: true }) } catch { /* 忽略 */ }
    injector.revoke('zcode', zdir)
  }

  const ok = checks.every((c) => c.ok)
  fs.rmSync(tmp, { recursive: true, force: true })
  return { ok, checks, tool: 'CR-MAC', version: chan.VERSION, at: new Date().toISOString() }
}

module.exports = { run }

if (require.main === module) {
  const r = run()
  process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  process.exit(r.ok ? 0 : 1)
}

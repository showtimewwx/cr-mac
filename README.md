# CR-MAC · AI 客户端人格注入引擎（macOS）

一个用 Electron 实现的**本地 AI 客户端配置注入研究项目**：把一份可编辑的「工程人格」载荷，
通过各 AI 编程客户端的官方配置通道（AGENTS.md / CLAUDE.md / 原生钩子 / 指令指向）写入，
并提供 pristine 备份与逐字撤销。**纯本地、无服务端、免费开源（MIT）。**

> 本项目是行为学复刻（重写实现），不包含任何第三方商业产品的代码与文本资产。
> 用途：研究 AI 客户端的配置接管面、可逆变更工程（备份账本/回读自证/撤销语义）。
> 请只在你自己拥有/管理的机器与客户端上使用。

## 支持的客户端（macOS 落点）

| 客户端 | 数据根 | 通道 |
|---|---|---|
| Codex CLI | `~/.codex` | AGENTS.md 记忆块 · 人格载荷文件 · config.toml `model_instructions_file` 指向 · hooks.json 原生钩子 · `[hooks.state]` 信任登记 |
| Claude Code | `~/.claude` | CLAUDE.md 记忆块 · settings.json UserPromptSubmit 钩子 · statusLine 徽章 |
| ZCode | `~/.zcode` | AGENTS.md · cli/config.json 钩子（`hooks.events.*`） |
| DeepSeek Harness | `~/.dsh` | AGENTS.md · profiles/*/cordis.patch.yml 旁挂 preset · settings.yaml 默认 preset |
| Hermes | `~/.hermes` | AGENTS.md / HERMES.md / SOUL.md · hooks.json |
| WorkBuddy（国内/国际） | `~/.workbuddy(-ai)` | CODEBUDDY.md · 规则文件 · SOUL/BOOTSTRAP · settings.json 钩子 |
| Cursor | `~/.cursor` | `.cursor/rules/*.mdc` 规则分片（用户级 + 项目级） |

豆包（云端记忆通道）为 Windows 专属，标记不支持。

## 快速开始

```bash
git clone https://github.com/<you>/cr-mac.git
cd cr-mac
npm install        # electron 二进制走 npmmirror 镜像（.npmrc 已配）
npm start          # 启动
```

界面流：左侧选客户端 → **兼容性检查**（干跑，零写入）→ **注入** → 客户端内发整条消息 `CR`
验证回执 → **撤销**（按账本逐字还原）。

```bash
node electron/selftest.js    # 引擎自检：沙箱内完整 注入→状态→钩子→撤销 回路（30 项）
```

## 工程设计

对齐「可逆变更五原则」（详见 `electron/channels.js` 头注释）：

1. **双层打通** —— 指令层（记忆块/指令文件）+ 工具层（原生钩子），只打一层必漏。
2. **接管式** —— 写入前摘除可识别的第三方同类标记（rivet/punch/watchtower 等六家格式）。
3. **pristine 备份** —— 首次改动前快照，账本（`<dataDir>/.cr-pojia/ledger.json`）唯一还原依据；
   托管态判据覆盖 HTML 封条 / TOML 块 / 破折号块 / JSON `__cr` 四形态，防备份被注入中间态污染。
4. **白名单式发现** —— 按目录+特征枚举目标，不硬编码版本文件名。
5. **改完回读自证** —— 每次写入后重读比对，不过即报错。

Mac 适配要点：钩子统一为 `~/.cr-mac/bin/cr-hook-<client>` 无空格 shell 包装（dev 态自动带
app 目录参数）；Codex 信任登记 key 与其内部口径同形
（`[hooks.state."<hooks.json 路径>:user_prompt_submit:0:0"]`）；Claude Code settings 严格
schema（禁 `hooks.enabled`/自定义字段）；`model_instructions_file` 幽灵行防护（载荷缺失绝不写指向）。

## 主题

深色 / 浅色 / 午夜蓝 / 高对比 / 跟随系统，`⌘⇧T` 循环切换，持久化于 `~/.cr-mac/ui-settings.json`。

## 目录结构

```
electron/
  main.js        主进程：窗口/托盘/IPC/守护定时器/--hook 分叉/--selftest
  channels.js     通道引擎：封条/备份账本/patcher 族/撤销
  injector.js     注入编排：enumerate → guard → patcher → 回读 → 账本
  hook.js         钩子运行端（stdin JSON → stdout JSON，exit 0 契约）
  activation.js   领域文字激活（「启动逆向领域」等口令）
  selftest.js     30 项沙箱自检
  payload*.md     载荷（默认/洁净/事实三档，可编辑；UI 保存覆写到 ~/.cr-mac/）
renderer/         零依赖 vanilla JS UI（四主题）
```

## 测试隔离

设 `CR_TEST_HOME` 后全部落点（客户端目录、`.cr-mac`、账本）切到沙箱；
干跑（dryRun）保证零写入（含钩子包装脚本）。

## License

MIT（见 LICENSE）。与任何第三方商业产品无关联；注入文本为本仓库自有内容。

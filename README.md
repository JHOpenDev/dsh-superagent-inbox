# dsh-superagent-inbox

> 让 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 上的 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) **零外部依赖**跑起来：一个基于本地文件收件箱的 Source 插件。投放一条 JSON 消息，Super-agent 评估、建单、派出 Worker、把结果写回你的文件夹。

本项目是 dsh-superagent（DeepSeek Harness 团队的 Super-agent 研究原型）的**扩展发行版**：在官方 bundle 之上新增了 `inbox` Source 插件（`./inbox-watch`），其余代码保持上游原样，MIT 许可，出处见文末。

---

## 1. 背景：这套东西解决什么问题

DeepSeek Harness 团队在 2026-10-31 发布了文章 [《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)，并提出开源原型 dsh-superagent。其核心判断是：单任务 Coding Agent 已经可用，瓶颈转向**人的注意力**——一个人通常只能同时跟进 3–5 个活跃 Session。

Super-agent 用四个特征回应：**连续**（跨信道只有一个 Agent）、**高效**（多任务并发）、**主动**（事件驱动）、**持久**（异常自愈）。支撑它的五个模块：

| 模块 | 一句话 |
|---|---|
| 双层架构 | Router 层常驻路由（只分派、不执行），Worker 层上下文隔离并发执行 |
| 事件驱动 | 环境事件即 Trigger；两级过滤（程序 Fast Path + 模型 Slow Path）、订阅直通、Inline & Spill、链式召回 |
| 面向人的交互 | 异步 ReAct Loop；多信道带宽匹配（IM ≤100 词硬上限，只在需要人时说话） |
| 存算分离 | Agent Loop 无状态化，Session 状态入库，执行环境留在原地（BYOM） |
| Watchdog | 主系统外部的 Control Loop，既查基础设施也查任务实质进展 |

官方原型内置 GitHub 与飞书两个 Source（事件来源），但都需要账号/机器人配置。**本项目新增的 `inbox` Source 补上"最后一公里"：任何有终端的人，用一个文件夹就能驱动整条 Trigger → Eval → Ticket → Worker → Channel 链路。**

## 2. inbox 插件设计

### 2.1 目录协议

```text
<root>/                      ← 面板里配置的收件箱根目录
  ops/                       ← 一个"对话"（conversation）
    in/                      ← 你把消息 JSON 投到这里
      done/                  ← 已被 Agent 接收的消息（自动移入，相当于读取游标）
    out/                     ← Agent 的回复 JSON 出现在这里
  town/                      ← 另一个对话，可以有不同的接收策略
```

### 2.2 消息格式（投放 `in/*.json`）

```json
{
  "id": "m-001",              // 必填，对话内唯一（重放安全：Trigger id 由 conversation+id 派生）
  "from": "alice",            // 必填，发送者身份（进入 Policy 白名单判断）
  "text": "把设置页的保存按钮文案改成「保存更改」",
  "to": "agent",              // 可选：写 agent（或配置的 agentName）= 向智能体喊话 → 显式授权强度
  "at": "2026-11-01T10:00:00+08:00",
  "bot": false,               // 可选：true 标记为机器人/CI，永远不能自行授权工作
  "thread": "m-000",          // 可选：所属话题的根消息 id（同话题后续消息直通 Worker）
  "reply_to": "m-000",        // 可选：直接回复哪条消息（评估时展示上下文）
  "url": "https://..."        // 可选：原文链接
}
```

### 2.3 回复格式（出现在 `out/*.json`，文件名即消息 id，天然幂等）

```json
{
  "id": "d402...c1",
  "conversation": "ops",
  "to": "m-001",
  "thread": "m-001",
  "reply_to": "m-001",
  "from": "dsh-superagent",
  "text": "已提交 <产物路径>，可验收。",
  "at": "2026-11-01T10:12:33.000Z",
  "ticket_id": "T-0001"
}
```

### 2.4 与 Super-agent 领域模型的集成点

| 领域概念 | inbox 的映射 |
|---|---|
| Trigger | 一个消息文件；id = `key('inbox', conversation, id)`，重放安全 |
| Thread | `<conversation>:<根消息 id>`——同话题连续消息构成事件流，**订阅直通**由此生效 |
| Actor / Policy | `from` 进白名单；`to: agent` 即显式喊话（explicit 强度）；bot 消息最多成为推断候选 |
| Admission | 每个对话一行准入表：`mentions`（仅 @）或 `all`（全部消息） |
| Channel | 回复写 `out/`，以消息 id 幂等（`wx` 标志），永不"永久失败" |
| threadContext | 评估时读取该话题全部消息（含 Agent 回复，标记 bot），分页供链式召回 |
| Worker 环境变量 | `DSH_SUPERAGENT_INBOX_CONVERSATION` 告诉 Worker 工单来自哪个对话 |

安全模型沿用 dsh-superagent 的完整 Policy：不在白名单里的人、bot、CI **不能授权工作**；白名单 + 显式喊话才产生 explicit 工单；观察性工作（auto 模式的规则匹配）只在你启用并写明规则后发生。

## 3. 安装（DeepSeek Harness）

前置：DeepSeek Harness `dsh ^0.2.1-alpha.2`、Node `^22.19 || >=24`、pnpm。

```bash
git clone https://github.com/JHOpenDev/dsh-superagent-inbox.git
cd dsh-superagent-inbox
pnpm install && pnpm check      # typecheck + 全部测试 + 构建 lib/
```

1. 插件安装后**零配置即可启动**：bundle 自带默认 `stateDir`（`~/.dsh/superagent-state`，跨平台自动计算；可用环境变量 `DSH_SUPERAGENT_STATE_DIR` 或在 profile 层覆盖）。
2. 重启 Harness，打开 **Superagent 侧边栏面板**完成部署引导（仓库、GitHub 账号——Worker 提交 PR 用），然后在 **Sources → Local inbox** 配置：
   - `root`：收件箱根目录（绝对路径）
   - `conversations`：至少一个对话，如 `{ id: "ops", listen: "mentions" }`
4. **Eval → On each Source → Local inbox**：把你自己（`from` 的值）加入 allowed 名单。

## 4. 使用

```bash
# 1) 投放一条工作请求
cat > $ROOT/ops/in/m-001.json <<'EOF'
{ "id": "m-001", "from": "alice", "to": "agent",
  "text": "把 README 的安装命令从 npm 改成 pnpm" }
EOF

# 2) 等 Router pass（秒级轮询）：面板会看到 Eval → accept → Ticket → Worker 运行
# 3) 结果出现在回复目录
cat $ROOT/ops/out/*.json
# 4) 在同话题追问（thread: "m-001"）会直通该工单的 Worker，无需再 @
```

同话题后续消息（带 `thread` 字段）经**订阅直通**直达 Worker，不消耗 Router 判断；一段纯闲聊会被两级过滤安静丢弃（面板 Sources 页可见 `filtered` 审计）。

## 5. 验证

**单元与构建**：`pnpm check`（tsc + vitest + tsdown）1202/1204 通过；唯一失败项是上游 `environment.spec` 的 git 报错文案断言（本机 git 文案差异，未修改的上游基线同样失败）。新增 `tests/inbox.spec.ts` 7 项全绿。

**真实运行时端到端**（DeepSeek Harness `dsh 0.2.1-rc.3`，专用 superagent profile）：

```text
收件箱投放 m-015 → Trigger 接收(移入 done/) → 评估接单(白名单+to:agent=explicit)
→ 创建工单 → Worker 会话(bash/fs/gh 可用) → 修改 README → 提交分支
→ PR #1 创建 → out/ 收到交付回复(≤100词, 附 PR 链接)
```

期间同样验证了：同 Thread 追问被评估按"同一请求已由工单承接"去重；显式停止指令经评估收回授权；
纯闲聊被两级过滤安静丢弃（面板可见 filtered 审计）。

**版本要求（重要）**：bundle 依赖的 `@deepseek-ai/dsh-*` 工具包必须与运行时 DSH 版本一致——
加载器会禁用版本不匹配的预设插件行（症状：Worker 会话没有 bash/fs/gh 工具）。本仓库全部锁定
`0.2.1-rc.3` 并把它们放进 `dependencies`；使用其他 DSH 版本时请同步调整。

## 6. ZCode 适配器（adapters/zcode-plugin）

同一套架构思想在 ZCode 上的移植（技能 + 斜杠命令实现：Router=主会话、Worker=后台子代理、订阅直通=SendMessage、Watchdog=巡检命令）。它不依赖本 bundle，安装方法见 [adapters/zcode-plugin/README.md](adapters/zcode-plugin/README.md)。两个实现的领域术语保持一致（Trigger/Thread/Ticket/Mandate/Watchdog），可作为"harness 无关的 Super-agent 架构"的对照样本。

## 7. 出处与致谢

- 架构与领域模型来自 DeepSeek Harness 团队的文章与实践：**《Super-agent 设计探索：迈向更自主的 Agent 系统》**（微信公众号「DeepSeek Harness 团队」，2026-10-31）与官方原型 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）。本仓库绝大部分代码属于他们——本项目的增量是 `src/sources/inbox.ts`、`tests/inbox.spec.ts`、bundle 接线与这份文档。
- 遵循原型的哲学：**尽可能少占用人的注意力，尽可能多地交付价值。** inbox Source 默认只接收配置过的对话、只让白名单里的人发起工作、只在需要人行动或结果可交付时写 `out/`。
- License: [MIT](LICENSE)（保留原许可与版权）。

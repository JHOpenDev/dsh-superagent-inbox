# 《Super-agent 设计探索：迈向更自主的 Agent 系统》研究笔记

> 来源：微信公众号「DeepSeek Harness 团队」，2026-10-31 20:29
> 原文：<https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg>
> 原型仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>（MIT）
> 本笔记为插件 `deepseek-harness` 的设计依据。

## 1. 问题与定位

- 单任务 Coding Agent 已证明可用；瓶颈转向**人的注意力**：一个人通常只能同时跟进 3–5 个活跃 Session。
- 现有 Agent 以单一 Session 为基本单位，Session 之间彼此独立 → 多任务上限取决于人。
- **Super-agent**：跨会话保持上下文、同时推进多项复杂任务且互不干扰的连续实体。
- 四大特征：**连续**（跨信道同一个 Agent）、**高效**（并发、无需等上一条完成）、**主动**（观察环境事件并推进）、**持久**（始终在线、异常自愈）。
- 方法论：把计算机系统经典思想移植到 Agent 系统（Fast/Slow Path、批处理、订阅、Cache、局部性、投机执行、存算分离、Watchdog）。

## 2. 五个模块（架构）

| # | 模块 | 解决的特征 | 要点 |
|---|------|-----------|------|
| 2 | 双层架构 | 连续 + 高效 | Router 层（常驻、只路由不执行、可不带 Bash）+ Worker 层（上下文隔离、挂全量工具、最强模型）。Router 充当全局序点/协调点/记忆 |
| 3 | 事件驱动 | 主动 | 环境事件 = Trigger；两级过滤（程序 Fast Path + 模型 Slow Path）；订阅直通（同 Thread 后续事件程序直发 Worker）；Inline & Spill 管理上下文窗口；链式召回（对象互带 ID 的引用图）；投机执行（后台提前干，有价值才交付） |
| 4 | 面向人的交互 | 连续 + 高效 | 异步 ReAct Loop（`start()/stop()` 替代阻塞 `run()`，结果作为新事件投递）；多信道带宽匹配（IM ≤100 词、只打扰必要时刻；GitHub/邮件结构化高密度） |
| 5 | 存算分离 | 持久 | 计算（Agent Loop）上云无状态化，Session 状态入库；执行环境留在原地，端侧轻量 daemon（BYOM），支持间歇在线设备 |
| 6 | Watchdog | 持久 | 主系统外部的 Control Loop：定时消息驱动；既查基础设施也查**任务实质进展**（无效循环/偏航）；可用自然语言修正主系统 |

## 3. 原型实现要点（dsh-superagent-prototype）

领域流：`Source → Trigger → Thread → Eval(gate+assessment) → Decision(accept/stop/ignore) → Ticket(Mandate) → Assignment → Executor(Worker Session) → Report → Channel`

关键设计：
- **订阅（Subscription）**：Ticket 与 Thread 多对多；订阅 Thread 的后续事件免评估直通 Worker；人的消息让 ended Ticket 原地复跑（同一 Mandate）。
- **Mandate（授权）**：记录 basis（explicit/inferred）、范围、策略版本；只有人的 stop 能撤回。
- **两级评估**：Gate（确定性：白名单/准入表）+ Assessment（模型：规则匹配 + intent evidence 三事实——目标本项目、有实现意图、方向已定）。
- **Outbox/Effects**：所有外发消息过持久化 outbox（幂等、重试、退避）；副作用事务提交后才执行。
- **通信纪律**（prompts/team/communication.md）：IM 100 词硬上限；只在"人必须行动/可用结果"时发消息；ready = 已自审+已验证+可验收；GitHub 消息开头声明自动化身份。
- **Worker 工具收敛**：Worker 无"向人提问/改配置/对外文档"类工具。
- 实验：消融显示双层架构 p50 12.4min vs 单 Session+Subagent p95 29.5min；去掉直通后 Router 决定 +30%、读缓存 token +37%；批处理使 40 msg/min 下单决定分摊推理从 6.4s 降到 1.6s。

## 4. 映射到 ZCode（本插件的设计）

| 文章概念 | ZCode 实现 |
|---|---|
| Router 层 | 主会话（加载 super-agent 技能）+ `.superagent/state.json` 持久记忆 |
| Worker 层 | `Agent` 工具 spawn 的 general-purpose 子代理（`run_in_background`） |
| 异步 ReAct | 后台子代理 + 完成通知，前台随时接新指令 |
| Trigger/Thread | `.superagent/inbox/*.json`（不可变）+ state 中的 thread 键 |
| 两级过滤 | `policy.json`（程序规则）+ Router 语义判断 |
| 订阅直通 | state 订阅表 + `SendMessage` 直达 Worker agent（不经 Router LLM） |
| 批处理 | 一次 pass 处理 inbox 全部积压 |
| Inline & Spill / 链式召回 | 卡片只带摘要+ID，完整内容按需 Read；state.json 是召回图入口 |
| Ticket/Mandate | `tickets/T-xxxx.json` |
| Watchdog | `/sa-watchdog` 命令（独立巡检 pass，可敲打/建议重启 Worker） |
| 多信道纪律 | Router 对用户 ≤100 词、只在必要时刻打扰（写进技能） |

## 5. 开放问题（文章 §8，插件当前简化）

- Router 水平切分与长程记忆（当前单 state.json，靠 archive 保留全文）
- 脱离 Session 后的人机协作 UI（当前以命令 + 状态面板替代）
- 上下文边界与 A2A（当前单实例）
- 安全与隐私：凭据不进上下文的机制（当前未实现，注意勿把密钥写进 Trigger）

---
description: 查看 Super-agent 状态面板：Thread 订阅表、Ticket 看板、决策日志与收件箱积压
---

输出 Super-agent 的当前状态面板（只读，不执行路由动作）。读取 `.superagent/`：

1. **Overview**：open Ticket 数、运行中 Worker 数、inbox 待处理数、最近一次决策时间。
2. **Tickets 看板**（按阶段分组）：
   - `working`（运行中）：ID、标题、mandate 来源（谁/哪条 Trigger）、Worker 最近报告时间与摘要（≤40 字）；
   - `attention`（等待人）：最新 blocked/failed 报告的具体问题与最小所需动作；
   - `ended`（最近 5 条）：结果与耗时。
3. **Threads 订阅表**：每个 Thread 的订阅 Ticket 与最近活动。
4. **收件箱**：inbox 中未处理 Trigger 的 ID 与一句话摘要。
5. **决策日志**：最近 10 条 decisions（trigger → 处置 + 理由）。

若状态目录不存在，提示"Super-agent 尚未启动，可运行 /superagent"。

$ARGUMENTS

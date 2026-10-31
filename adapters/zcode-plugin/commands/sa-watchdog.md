---
description: 运行 Watchdog 外部控制回路：检查基础设施健康与各 Ticket 实质进展，异常时介入修复
---

以独立 Watchdog 身份巡检 Super-agent（这是主系统之外的 Control Loop，不替 Router 做业务判断）。

**A. 基础设施检查**
1. `.superagent/state.json` 是否存在且 JSON 可解析（损坏 → 报告并给出从 archive/tickets 重建的建议）。
2. `inbox/` 积压数量（>10 条告警）。
3. 孤儿状态：threads 表中订阅的 Ticket 是否都已不存在；tickets 中引用的 Thread 是否缺失。

**B. 任务进展检查**（逐个 open Ticket）
1. 距最新 `reports` 条目的时间间隔（默认阈值 10 分钟，可用参数覆盖）→ 超时标记 `stalled`。
2. 无效循环检测：最近 ≥2 条报告 summary 高度相似（同一句话重复）→ 标记 `looping`。
3. 已宣称 `ready` 但产物路径不存在 → 标记 `unverified`。

**C. 介入（按最小代价顺序）**
1. 对 `stalled/looping` 的 Worker 用 SendMessage 敲打一次：要求给出当前状态与下一步。
2. 状态仍不明的，标记并**向用户提议**重启该 Worker（保留报告，重派时带 recovery note），不擅自停止他人会话。
3. 把本轮巡检结论追加到 `state.json.decisions`（actor=watchdog）。

**D. 输出**：一句话总结健康度 + 异常清单（ID、问题、已采取的动作、待用户决定事项）。一切正常就只报一句"巡检通过：N 个运行中工单，M 条积压"。

参数可传超时阈值，如 `/sa-watchdog 30m`。

$ARGUMENTS

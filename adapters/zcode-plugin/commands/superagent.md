---
description: 启动 Super-agent 运行时（Router pass）：初始化状态、批处理收件箱、两级过滤、订阅直通、派工 Worker
---

执行一次完整的 Super-agent Router pass。按 `super-agent` 技能的第 7 节标准流程：

1. 若工作区无 `.superagent/` 状态目录，先按技能 §1 初始化（state.json、policy.json、inbox/archive/tickets 目录），并向用户确认接入的事件来源后写入默认 policy。
2. 读取 `.superagent/state.json` 与 `.superagent/policy.json` 恢复上下文（链式召回入口）。
3. 列出 `.superagent/inbox/` 下全部 Trigger 文件，**批处理**：
   - 程序层 Fast Path：按 policy 的 source mode 与 keyword_rules 过滤/直通；
   - 订阅直通：thread 已被 open Ticket 订阅的，直接用 SendMessage 发给对应 Worker agent，不在本层重新判断；
   - 其余进入语义判断：accept（建 Ticket + 后台派工 general-purpose Worker，Prompt 内联 super-agent-worker 协议）/ attach / ignore，全部记入 decisions 日志。
4. 巡视所有 open Ticket 的最新报告，按 §5 交付或升级。
5. 归档已处理 Trigger，写回 state.json。
6. 用一段话汇总：接了什么单、派了哪些 Worker、有什么需要用户决定。若无新事项，一句话报平安。

如果没有找到 `super-agent` 技能（插件未安装），明确告知用户需要先安装 deepseek-harness 插件。

$ARGUMENTS

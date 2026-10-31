# deepseek-harness

把 DeepSeek Harness 团队《[Super-agent 设计探索：迈向更自主的 Agent 系统](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)》的架构思路落地为 ZCode 插件：在工作区内运行一个**双层架构、事件驱动**的 Super-agent。

## 组件

| 组件 | 说明 |
|---|---|
| 技能 `super-agent` | Router 层操作系统：状态初始化、两级过滤、订阅直通、批处理、派工、对外交互纪律、Watchdog、恢复 |
| 技能 `super-agent-worker` | Worker 层执行协议：上下文隔离、报告纪律（ready/blocked/failed/dropped）、follow-up 处理 |
| `/superagent` | 启动运行时并执行一次 Router pass |
| `/sa-inject` | 注入一条 Trigger（模拟 IM/GitHub/CI 事件）并自动路由 |
| `/sa-status` | 状态面板：工单看板、订阅表、决策日志 |
| `/sa-watchdog` | 外部控制回路巡检 |

## 状态布局（工作区内）

```text
.superagent/
  state.json    # 计数器、Thread 订阅表、Ticket 索引、决策日志
  policy.json   # Fast Path 过滤规则（两级过滤的程序层）
  inbox/        # 待处理 Trigger（不可变 JSON）
  archive/      # 已处理 Trigger
  tickets/      # T-xxxx.json 工单（Mandate/报告）
  work/         # 各 Worker 的专属工作目录
```

## 快速上手

```text
/superagent                      # 初始化并跑第一轮
/sa-inject [im:张三] #开发群 :: 帮我把设置页「保存」按钮改成「保存更改」
/sa-inject [im:李四] #开发群 :: 顺手把弹窗文案也统一一下   # → 订阅直通给同一个 Worker
/sa-status
/sa-watchdog
```

设计依据与文章精读笔记见 [docs/article-notes.md](docs/article-notes.md)。

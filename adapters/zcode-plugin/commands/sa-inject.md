---
description: 向 Super-agent 收件箱注入一条 Trigger（模拟 IM/GitHub/CI 事件），随后自动执行一次 Router pass
---

把用户给定的事件写成一条 Trigger 注入 Super-agent 收件箱，然后立即执行一次 Router pass（等价于 `/superagent`）。

参数格式（$ARGUMENTS），支持两种写法：
1. 自然语言一行：`[来源:actor] 话题/线程线索 :: 消息内容`，例如：
   - `[im:张三] #开发群 话题42 :: 帮我把设置页的「保存」按钮改成「保存更改」`
   - `[ci:bot] repo=app branch=main :: CI 失败：test_login 用例超时`
2. 省略来源时默认 `im`，actor 默认 `用户`。

步骤：
1. 读 `.superagent/state.json`，取 `seq.trigger + 1` 生成 `trig-NNNN`（目录不存在则先按 super-agent 技能 §1 初始化）。
2. 归一化 thread 键：`im:<群/话题>`、`github:<PR/Issue>`、`ci:<repo:branch>`；线索不足时用 `im:direct`。
3. 写入 `.superagent/inbox/trig-NNNN.json`：
   `{ "id": "trig-NNNN", "at": "<当前 ISO8601 时间>", "source": "...", "actor": "...", "thread": "...", "text": "...", "refs": [] }`
4. 立即执行 Router pass（两级过滤 → 订阅直通/派工 → 汇总）。
5. 对用户简短确认：Trigger ID、判定结果（accept/attach/ignore/直通）、是否已派工。

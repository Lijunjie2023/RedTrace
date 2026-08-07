# 生产登录服务 OOM 恢复记录

日期：2026-08-07

## 故障现象

- 用户反馈生产环境再次无法登录。
- 外网匿名请求 `/api/v1/session` 返回 Nginx 502 HTML，而不是 API 约定的 JSON 响应。
- `readtrace-api.service` 一度显示为 `active/running`，但 `127.0.0.1:3100` 没有监听端口，说明 API 仍在高负载下延迟启动。

## 诊断证据

- API 在 30 分钟内多次异常退出，其中一次停止超时后被 systemd 以 SIGKILL 结束。
- 内核日志明确记录 `readtrace-api.service` 的 Node 进程在 16:22、16:33 和 16:51 被 OOM killer 终止。
- 故障时服务器 load average 为 107.16/106.11/98.52；1.87GB 内存只剩约 369MB available，5GB 交换空间已经使用约 4.88GB。
- 数据库健康检查通过：MySQL 8、SSL、UTC 会话和连接均正常。
- `readtrace-analysis.timer` 始终保持 `disabled/inactive`，没有参与本次资源争抢。
- 同机存在大量长期或并发运行的 `pm2 describe wechaty-bot`、`pm2 show wechaty-bot` 监控查询。它们不属于 ReadTrace，本次没有终止、重启或删除任何相关进程，也没有操作 wechaty-bot 主服务。

## 恢复过程

- 没有修改登录账号、密码或数据库配置，也没有读取或输出环境文件正文及任何凭据。
- API 进程在高负载下完成延迟启动并恢复 `127.0.0.1:3100` 监听，因此没有执行无必要的重复重启。
- 恢复后 API 内存占用约 64MB，systemd 重启计数保持为 1。
- 16:52 之后没有出现新的 OOM 记录。

## 验证结果

- 外网 HTTPS 首页返回 HTTP 200。
- 外网匿名 `/api/v1/session` 返回 HTTP 200 和结构化 JSON，数据模式为正式持久化模式。
- 使用明确的假账号和假密码请求登录 POST，返回 HTTP 401、错误码 `AUTH_FAILED`，证明登录请求路径和认证失败分支均可达。验证过程没有使用真实凭据，临时探针已经删除。
- `readtrace-api.service` 为 `active`，仅监听 `127.0.0.1:3100`。
- `readtrace-analysis.timer` 为 `disabled/inactive`。
- 最终观察时 load average 回落至 66.15/83.47/90.90，可用内存约 519MB，交换空间使用约 3.99GB。

## 根因与后续风险

- 本次直接故障原因是服务器整体内存耗尽，API 被 OOM killer 多次终止，Nginx 因上游不可用返回 502；不是登录凭据或数据库连接错误。
- 当前恢复依赖服务器资源压力回落，并不是同机资源争抢的长期治理方案。异常 PM2 监控查询仍需由对应业务负责人单独排查，或者通过扩容、进程治理和资源隔离降低再次 OOM 的风险。
- 在完成资源治理前，继续保持自动分析定时任务关闭，并监控 API 重启次数、3100 监听和内核 OOM 事件。

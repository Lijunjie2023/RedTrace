# API 采集上限调整为 100 条

## 目标

数据采集入口继续完全使用 JustOneAPI。保留原有浏览器采集代码，只修改当前 API 采集任务的限制与分页逻辑。

## 改动

- 单次任务中，每个关键词的帖子上限由 10 条调整为 100 条。
- 前端输入限制、共享接口契约和任务摘要校验统一调整为 100 条。
- 笔记搜索从固定请求第一页改为 API 连续分页。
- 下一页请求携带上一页返回的 `searchId` 和 `sessionId`，保持搜索会话连续。
- 跨页帖子按平台帖子 ID 去重；累计达到用户设置的上限、接口返回空页或达到安全页数上限时停止。
- 保留既有浏览器探针与相关代码，不执行删除。

## 外部接口依据

JustOneAPI 笔记搜索 V4 文档说明接口支持 `page` 分页，后续页面可以使用上一页 `data.api_info` 中的 `search_id` 和 `session_id` 保持会话连续。

## 验证

- `npm test`：134 项通过，1 项因当前 Windows 环境不允许创建符号链接而跳过。
- `npm run build`：根项目、API、Web 和契约包构建通过。
- 代码审查：未发现需要阻止发布的问题；分页具有 20 页安全上限，每页请求后都会检查停止信号。
- 代码提交：`afb2d01 feat: raise API collection limit to 100`，已经推送并部署。
- 生产目录提交为 `afb2d01`，前端资源为 `assets/index-DF_qr58B.js`。
- `readtrace-api.service` 为 `active/running`，本机 API 会话接口返回 HTTP 200。
- `readtrace-analysis.timer` 保持 `inactive`，本次发布没有改变既有的内存保护策略。

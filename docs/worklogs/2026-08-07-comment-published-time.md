# 评论发布时间展示修复

## 问题

内容明细的评论库和评论详情没有显示发布时间。采集接口已经返回评论时间，数据库也在 `published_text` 中保存了原始值，但后端在组装评论接口响应时把 `publishedAt` 固定设置为 `null`。

## 处理

- 将平台秒级时间戳、毫秒级时间戳和标准日期统一转换为 ISO 时间。
- 评论列表、评论详情及父评论上下文均从已有 `published_text` 恢复发布时间。
- 保留无法可靠转换的历史相对时间文本，此类记录继续显示“暂无”。
- 更新评论库提示文案，并增加时间解析与接口映射回归测试。

## 数据库影响

本次没有修改数据库结构，也没有覆盖历史数据。发布时间从已经保存的原始字段读取，因此不需要执行生产数据库迁移。

## 验证

- `npm test`：133 项通过，1 项因 Windows 不允许创建符号链接而跳过。
- `npm run build`：根项目、API、Web 和契约包构建通过。
- 代码提交：`04d0624 fix: show collected comment publish times`，已经推送到远端分支 `codex/data-path-validation`。
- 生产目录已经快进到 `04d0624`，本地构建的前端资源 `assets/index-HdM8QHgv.js` 已经发布。
- `readtrace-api.service` 为 `active`，本机 API 会话接口返回 HTTP 200，Nginx 和 443、8443、3100 监听正常。
- 评论内容接口需要管理员会话；无凭证验收只确认鉴权边界正常，没有读取或输出评论正文。
- `readtrace-analysis.timer` 保持 `inactive`，本次发布没有改变既有的内存保护策略。

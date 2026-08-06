# ReadTrace 项目架构 HTML 说明工作日志

## 任务

读取当前项目，向非技术读者说明项目目标、实际技术栈、当前实现范围、数据流和每个目录及关键文件的职责，最终输出单文件 HTML。

## 检查范围

- 项目级 `AGENTS.md`
- 根目录配置：`package.json`、TypeScript 配置、环境变量示例、Git 忽略规则
- `src/xhs-probe/` 全部源代码
- `src/db/`、`src/db/persistence/`、`src/db/coordination/` 全部源代码
- 数据库首个迁移和主要工程文档
- `tests/`、`tasks/`、`docs/` 的文件结构与职责

## 主要结论

- 当前是 Node.js 20 + TypeScript 的后端与命令行工具型项目。
- 数据库实际使用 MySQL 8.0，通过 `mysql2` 连接。
- Playwright 用于低频、只读的小红书真实页面数据能力验证。
- 已实现采集探针、数据清洗脱敏、MySQL 迁移、采集数据持久化、租约锁、游标和自动化测试。
- 探针输出和数据库持久化能力尚未在 CLI 中串成正式采集服务。
- 正式前端、后台 API、登录、定时调度、DeepSeek 分析、人工修正和 Excel 导出仍属于 PRD 规划。

## 产出

- `docs/project-architecture.html`

页面采用单文件 HTML、CSS 和少量原生 JavaScript，不依赖网络资源，可直接在浏览器打开，也适合打印为 PDF。

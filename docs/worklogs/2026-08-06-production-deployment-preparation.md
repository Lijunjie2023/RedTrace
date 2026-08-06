# 单机ECS生产部署准备记录

日期：2026-08-06

## 目标

为ReadTrace准备单台Alibaba Cloud Linux 3 ECS的独立部署配置，不影响同机已经运行的ReadBookDashboard。

## 现场约束

- 服务器已有Node.js 20.20.0、Nginx 1.20.1和Git。
- 服务器为2核、约1.8GB内存。
- 80、8080和3180端口已经被现有服务使用，本次只新增8443和本机回环3100。
- 不执行服务器命令，不读取服务器秘密，不修改任何现有服务配置。

## 本次产出

- 新增Nginx独立TLS虚拟主机，监听8443，从`/var/www/readtrace`托管前端静态文件并反向代理同源API；管理员登录POST请求按来源地址限速。
- 新增systemd API服务，使用专用账号、外置环境文件、本地`tsx`运行时，并通过严格文件系统保护和只读项目路径阻止API修改代码。
- 新增部署手册，覆盖账号目录、Git拉取、依赖安装、静态检查、构建、RDS备份前提、迁移、TLS、systemd、Nginx、安全组、验证、分析边界和回滚。

## 安全处理

- TLS证书和私钥固定保存在`/etc/readtrace/tls`，环境配置固定保存在`/etc/readtrace/readtrace.env`，均不进入仓库。
- API只监听`127.0.0.1:3100`，公网只开放受限来源的8443。
- Nginx不加入`readtrace`组，只读取root持有的`/var/www/readtrace`；API代码和依赖在部署完成后同样由root持有。
- Nginx配置没有接管80端口，也没有启用可能影响同主机HTTP服务的HSTS。
- 部署文档没有包含真实数据库地址、账号、密码、DeepSeek密钥或证书内容。

## 已知上线门槛

- 当前LIVE模式使用单一管理员账号和进程内会话，API重启后需要重新登录，不适合多用户或高可用部署。
- DeepSeek分析与小红书采集探针不随API自动运行。
- 当前API没有编译后的JavaScript产物，线上仍需要安装`tsx`所在的开发依赖。

## 第一轮审查修正

- 静态文件从项目目录分离到`/var/www/readtrace`，使用固定目标校验和`rsync --delete`受控发布。
- 在Nginx的`http`上下文增加登录POST请求限速区，在精确会话端点应用限速，并保留通用`/api/`代理。
- systemd改用`ProtectSystem=strict`和项目路径只读保护。
- 更新与回滚流程统一为停止API、更新或检出代码、安装依赖、检查构建、发布静态文件、更新配置、重载systemd、校验Nginx、启动API和重载Nginx的顺序。

## Alibaba Cloud Linux 3兼容性调整

- 目标服务器的systemd不支持`ProtectKernelLogs`服务指令，`systemd-analyze verify`会将其报告为未知配置项。本次仅移除该指令，其余systemd加固配置保持不变。

## React Router临时风险豁免

- 安全公告`GHSA-qwww-vcr4-c8h2`影响当前锁定的React Router 7.18.2，但已确认其攻击面仅存在于实验性的RSC和Server Action能力。
- ReadTrace当前采用Vite静态SPA、`BrowserRouter`和独立Fastify API，没有使用受影响的服务端执行链路，因此该漏洞在当前架构中不可达，本次不阻断上线。
- 豁免期间禁止引入RSC、Server Action、Framework Mode、SSR、服务端route action，以及`@react-router/dev`、`@react-router/node`或`@react-router/serve`。
- 最迟在2026-09-06完成复查，同时每次部署前都要重新检查公告、锁文件版本和项目攻击面；任一豁免前提发生变化时立即停止沿用本结论。
- 如果React Router 7.x发布修复版本，应同步升级`react-router-dom`和`react-router`并重新执行类型检查、测试和构建。
- 如果7.x没有可用修复版，升级到8.3.0前必须先满足Node.js不低于22.22、React不低于19.2.7，并完成对应兼容迁移和完整回归验证。

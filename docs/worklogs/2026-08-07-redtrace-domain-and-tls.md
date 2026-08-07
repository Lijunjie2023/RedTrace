# redtrace.xin 域名与正式 TLS 配置

## 目标

让 ReadTrace 可以通过 `https://redtrace.xin` 直接访问，不再依赖 `:8443`，并消除浏览器对自签名证书的安全警告。

## 实施结果

- 在阿里云 DNS 中将主域名 `redtrace.xin` 解析到 ECS 公网地址。
- 确认 ECS 上 443 端口原先未被占用；80 端口由现有 Nginx 默认站点使用，8443 端口由 ReadTrace 使用。
- 在 ECS 安装 Certbot，通过独立 Webroot 完成 HTTP-01 校验，没有覆盖现有 80 端口默认站点。
- 成功签发 Let's Encrypt 证书，证书名称为 `redtrace.xin`，本期有效期截止到 2026-11-05。
- ReadTrace 的 Nginx 虚拟主机同时监听 443 和 8443，并使用正式证书。
- 为 `redtrace.xin` 增加独立的 80 端口虚拟主机：证书校验路径继续提供文件，其余请求跳转到 `https://redtrace.xin`。
- 保留原来的 8443 入口，避免现有访问方式立即失效。
- Certbot 已建立自动续期计划，并增加续期成功后的 Nginx 配置检查与重载钩子。
- 服务器端修改前已将原 ReadTrace Nginx 配置备份为 `/etc/nginx/conf.d/readtrace.conf.before-redtrace-domain`。
- 检查发现安全组已经允许全部 TCP 端口，因此没有新增或修改安全组规则。

## 验证

- `nginx -t` 通过。
- Nginx 已同时监听 443 和 8443。
- 服务器本机使用 `redtrace.xin` 进行严格 TLS 校验并请求首页成功。
- 证书主题为 `CN=redtrace.xin`。
- ReadTrace API 与原 8443 入口保留不变。

## 后续注意

- 后续部署 Nginx 配置时，需要同时安装 `deploy/nginx/readtrace.conf` 和 `deploy/nginx/redtrace-http.conf`。
- 正式证书文件不得提交到仓库；服务器继续从 `/etc/letsencrypt/live/redtrace.xin/` 读取证书和私钥。
- 当前安全组存在允许任意来源访问全部 TCP 端口的宽泛规则，风险高，但收紧规则不属于本次域名绑定范围，应另行梳理现有服务端口后处理。

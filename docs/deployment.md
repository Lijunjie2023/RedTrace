# ReadTrace单机ECS部署手册

## 1. 部署边界

本方案面向一台Alibaba Cloud Linux 3 ECS，使用已经安装的Node.js 20、Nginx 1.20和Git。ReadTrace独立监听HTTPS 8443端口，API仅监听本机`127.0.0.1:3100`。

现有ReadBookDashboard继续使用80、8080和3180端口。本部署不修改这些端口的监听、反向代理或服务文件，也不在80端口增加跳转规则。

当前代码还有以下运行边界：

- LIVE模式使用环境变量中的单一管理员账号。登录Cookie必须启用`Secure`，会话只保存在API进程内存中，API重启后需要重新登录；当前不适合多用户或高可用部署。
- DeepSeek分析和小红书采集探针是独立命令，不随API启动，也没有包含在本次systemd服务中。
- LIVE模式下的手动采集、采集重试、品牌写入和导出仍有未完成功能。

## 2. 目录和账号

使用专用系统账号运行API。代码、静态文件和秘密配置分别保存，Nginx不加入`readtrace`组：

```bash
sudo useradd --system --home-dir /opt/readtrace --shell /sbin/nologin readtrace
sudo install -d -o root -g root -m 0755 /opt/readtrace
sudo install -d -o root -g root -m 0755 /var/www/readtrace
sudo install -d -o root -g readtrace -m 0750 /etc/readtrace
sudo install -d -o root -g root -m 0755 /etc/readtrace/tls
```

首次拉取代码。仓库地址使用只读部署密钥或服务器已有的SSH凭据，不要把Token写进命令、配置或仓库：

```bash
sudo git clone <仓库SSH地址> /opt/readtrace/current
sudo chown -R root:root /opt/readtrace/current
cd /opt/readtrace/current
node --version
npm --version
```

Node.js必须不低于20。服务器现场版本为20.20.0，满足项目要求。

## 3. 运行环境配置

秘密配置统一保存在`/etc/readtrace/readtrace.env`，权限设置为`0640 root:readtrace`。不要填写引号外的注释，不要把真实地址、账号、密码、密钥或证书提交到Git。

```bash
sudo install -o root -g readtrace -m 0640 /dev/null /etc/readtrace/readtrace.env
sudoedit /etc/readtrace/readtrace.env
```

正式数据模式至少需要以下字段，具体值从授权的密码管理位置取得：

```dotenv
DATA_MODE=mysql
API_PORT=3100
ADMIN_USERNAME=<管理员账号>
ADMIN_PASSWORD=<管理员强密码>
SESSION_COOKIE_SECURE=true

MYSQL_HOST=<RDS内网地址>
MYSQL_PORT=3306
MYSQL_USER=<应用账号>
MYSQL_PASSWORD=<应用密码>
MYSQL_DATABASE=<数据库名>
MYSQL_SSL_MODE=required
DB_CONNECTION_LIMIT=5

DEEPSEEK_API_KEY=<DeepSeek密钥>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=30000
DEEPSEEK_MAX_RETRIES=2
DEEPSEEK_BATCH_LIMIT=10
DEEPSEEK_BATCH_TOKEN_BUDGET=20000
DEEPSEEK_MAX_OUTPUT_TOKENS=800
DEEPSEEK_MAX_RESPONSE_BYTES=1048576
DEEPSEEK_CLAIM_LEASE_MS=180000
DEEPSEEK_PROMPT_VERSION=content-analysis-v1
```

`ADMIN_PASSWORD`至少需要8个字符。应用只校验长度，不要求必须同时包含大小写字母、数字或特殊字符。

如果RDS要求指定CA文件，再设置`MYSQL_SSL_CA_FILE`并把证书放在`/etc/readtrace`下。RDS白名单只加入ECS用于访问RDS的内网地址。

数据库和分析命令默认读取项目根目录的`.env.local`。在服务器创建指向受控配置的符号链接，避免复制秘密：

```bash
sudo ln -sfn /etc/readtrace/readtrace.env /opt/readtrace/current/.env.local
sudo chown -h root:readtrace /opt/readtrace/current/.env.local
```

## 4. 安装依赖并构建

API当前通过项目内的`tsx`直接运行TypeScript，前端构建也需要Vite和TypeScript。因此必须安装完整依赖，不能使用`npm ci --omit=dev`。

```bash
cd /opt/readtrace/current
sudo npm ci
sudo npm run typecheck
sudo npm test
sudo npm run build
test -f /opt/readtrace/current/apps/web/dist/index.html
sudo chown -R root:root /opt/readtrace/current
sudo chmod -R u=rwX,go=rX /opt/readtrace/current
```

`npm run build`生成前端静态文件到`apps/web/dist`。当前API和共享契约的构建命令只做类型检查，不生成后端JavaScript产物。

构建成功后，把静态产物发布到Nginx专用目录。`readlink`检查用于阻止目标目录被替换成符号链接，`rsync --delete`只允许作用于这个已确认的固定目录：

```bash
sudo dnf install -y rsync
test "$(readlink -f /var/www/readtrace)" = "/var/www/readtrace"
sudo rsync --archive --delete --chown=root:root --chmod=D755,F644 \
  /opt/readtrace/current/apps/web/dist/ /var/www/readtrace/
```

Nginx只读取`/var/www/readtrace`，不读取项目目录，也不加入`readtrace`组。API运行账号只能读取root持有的项目文件，不能修改代码或依赖。

在1.8GB内存的ECS上安装和构建时观察内存。如发生内存不足，应临时停止非必要进程或扩容，不要通过跳过类型检查和测试规避失败。

## 5. 数据库检查和迁移

数据库迁移只向前执行。首次迁移或版本升级前，必须先在阿里云RDS控制台创建可恢复快照并确认快照成功。记录快照编号和对应应用提交，不要在没有可用备份时执行迁移。

```bash
cd /opt/readtrace/current
sudo -u readtrace npm run db:health
sudo -u readtrace npm run db:migrate
sudo -u readtrace npm run db:status
sudo -u readtrace npm run db:migrate
```

最后一次迁移应返回没有待执行版本。任何历史校验、权限、SSL或版本错误都需要停止部署，不得删表、修改迁移记录或关闭约束绕过。

## 6. TLS证书

证书必须覆盖访问ReadTrace时使用的域名，并统一安装到以下路径：

- `/etc/readtrace/tls/readtrace.crt`
- `/etc/readtrace/tls/readtrace.key`

```bash
sudo install -o root -g root -m 0644 <证书文件> /etc/readtrace/tls/readtrace.crt
sudo install -o root -g root -m 0600 <私钥文件> /etc/readtrace/tls/readtrace.key
```

不要把证书私钥放进仓库。Nginx配置没有启用HSTS，因为同一主机仍有现存HTTP服务；错误启用HSTS可能改变这些服务的浏览器访问行为。

## 7. 安装systemd和Nginx配置

```bash
cd /opt/readtrace/current
sudo install -o root -g root -m 0644 deploy/systemd/readtrace-api.service /etc/systemd/system/readtrace-api.service
sudo install -o root -g root -m 0644 deploy/nginx/readtrace.conf /etc/nginx/conf.d/readtrace.conf
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/readtrace-api.service
sudo nginx -t
sudo systemctl enable --now readtrace-api.service
sudo systemctl is-active --quiet readtrace-api.service
sudo systemctl reload nginx
```

`readtrace-api.service`从`/etc/readtrace/readtrace.env`读取环境变量，以`readtrace`账号运行，并只连接外部网络和本机套接字。`ProtectSystem=strict`和`ReadOnlyPaths=/opt/readtrace/current`让代码在服务进程中保持只读。代码及依赖由root持有，运行账号没有写入权限。

如果SELinux处于Enforcing状态，需要允许Nginx读取静态目录并连接本机API：

```bash
getenforce
sudo dnf install -y policycoreutils-python-utils
sudo semanage fcontext -a -t httpd_sys_content_t '/var/www/readtrace(/.*)?'
sudo restorecon -Rv /var/www/readtrace
sudo setsebool -P httpd_can_network_connect 1
```

不要关闭SELinux来解决权限问题。如果`semanage fcontext -a`提示规则已经存在，使用`-m`更新现有规则。

## 8. 安全组和网络

在ECS安全组增加TCP 8443入方向规则，优先只允许公司出口地址或VPN地址访问。不要把3100、3180或RDS的3306端口开放到公网。

本配置只新增8443监听，不覆盖80、8080或3180。应用使用同源`/api/v1`请求，不需要在前端配置额外API地址。

## 9. 验证

先在服务器本机验证API和服务状态，再验证Nginx和外部访问：

```bash
sudo systemctl --no-pager --full status readtrace-api.service
sudo journalctl -u readtrace-api.service -n 100 --no-pager
curl --fail --silent --show-error http://127.0.0.1:3100/api/v1/session
curl --fail --silent --show-error --cacert /etc/readtrace/tls/readtrace.crt https://<证书域名>:8443/
curl --fail --silent --show-error --cacert /etc/readtrace/tls/readtrace.crt https://<证书域名>:8443/api/v1/session
sudo ss -lntp | grep -E ':(8443|3100)\b'
```

期望API只监听`127.0.0.1:3100`，Nginx监听8443，前端刷新任意页面仍返回应用入口，`/api/v1/session`返回结构化响应。随后通过浏览器验证管理员登录、受保护页面访问和退出登录；不要在命令行历史中传递管理员密码。

验证日志时不得复制或回传环境文件、Authorization、Cookie、帖子正文或评论正文。

## 10. DeepSeek分析与采集

DeepSeek分类是独立批处理，需要由受控运维任务分别执行帖子和评论分析。项目代码由root持有，命令继续使用无代码写权限的`readtrace`账号：

```bash
cd /opt/readtrace/current
sudo -u readtrace npm run analyze:content -- --content-type POST --limit 10
sudo -u readtrace npm run analyze:content -- --content-type COMMENT --limit 10
```

本部署没有自动执行以上命令。需要定时分析时，应单独增加systemd timer，并沿用同一环境文件和低并发限制。

小红书探针依赖有界面浏览器、人工登录状态和受控采集频率，不随API运行。无桌面的ECS不应直接承担探针采集；可以从受控采集节点产生探针产物，再通过受控导入流程写入数据库。

## 11. 更新和回滚

更新前记录当前提交并再次确认RDS备份。先停止API，防止运行进程在代码和依赖更新期间读取混合版本；随后依次更新代码、安装依赖、检查、构建、迁移、发布静态文件和安装服务配置：

```bash
cd /opt/readtrace/current
git status --short
git rev-parse HEAD
sudo systemctl stop readtrace-api.service
sudo git pull --ff-only
sudo npm ci
sudo npm run typecheck
sudo npm test
sudo npm run build
sudo -u readtrace npm run db:health
sudo -u readtrace npm run db:migrate
test "$(readlink -f /var/www/readtrace)" = "/var/www/readtrace"
sudo rsync --archive --delete --chown=root:root --chmod=D755,F644 \
  /opt/readtrace/current/apps/web/dist/ /var/www/readtrace/
sudo install -o root -g root -m 0644 deploy/systemd/readtrace-api.service /etc/systemd/system/readtrace-api.service
sudo install -o root -g root -m 0644 deploy/nginx/readtrace.conf /etc/nginx/conf.d/readtrace.conf
sudo chown -R root:root /opt/readtrace/current
sudo chmod -R u=rwX,go=rX /opt/readtrace/current
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/readtrace-api.service
sudo nginx -t
sudo systemctl start readtrace-api.service
sudo systemctl is-active --quiet readtrace-api.service
sudo systemctl reload nginx
```

如果应用验证失败，停止API并检出更新前记录的提交，然后重新安装依赖、构建和启动：

```bash
sudo systemctl stop readtrace-api.service
sudo git checkout --detach <更新前提交>
sudo npm ci
sudo npm run typecheck
sudo npm test
sudo npm run build
test "$(readlink -f /var/www/readtrace)" = "/var/www/readtrace"
sudo rsync --archive --delete --chown=root:root --chmod=D755,F644 \
  /opt/readtrace/current/apps/web/dist/ /var/www/readtrace/
sudo install -o root -g root -m 0644 deploy/systemd/readtrace-api.service /etc/systemd/system/readtrace-api.service
sudo install -o root -g root -m 0644 deploy/nginx/readtrace.conf /etc/nginx/conf.d/readtrace.conf
sudo chown -R root:root /opt/readtrace/current
sudo chmod -R u=rwX,go=rX /opt/readtrace/current
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/readtrace-api.service
sudo nginx -t
sudo systemctl start readtrace-api.service
sudo systemctl is-active --quiet readtrace-api.service
sudo systemctl reload nginx
```

数据库迁移不自动回滚。只有确认旧应用兼容当前数据库结构时才能回退应用；需要恢复数据库时，按照已确认的RDS快照恢复流程执行，不得手工删除表或迁移记录。

回滚Nginx或systemd配置时，只恢复`readtrace.conf`和`readtrace-api.service`的上一版本。始终先执行`systemctl daemon-reload`、`systemd-analyze verify`和`nginx -t`，确认成功后再启动API并受控重载Nginx。不得改动ReadBookDashboard的配置或进程。

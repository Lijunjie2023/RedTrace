# 采集数据库配置与迁移

本阶段使用MySQL 8.0和只向前升级的SQL迁移。命令不会创建数据库，不会清理数据，也不会修改ReadTrace表以外的对象。

## 本地配置

复制`.env.example`为`.env.local`，只在本机填写真实配置。`.env.local`已经被Git忽略，不要把真实地址、账号、密码、连接串或SSL证书内容写入文档和日志。

密码不会被程序裁剪或改写。使用dotenv格式时请遵守以下写法：

```dotenv
# 包含#时必须加双引号，否则#之后会被当成注释
MYSQL_PASSWORD="demo#password"

# 需要保留首尾空格时也必须加双引号
MYSQL_PASSWORD="  demo password  "

# 密码包含双引号时改用单引号包裹，不要添加会进入密码值的反斜杠
MYSQL_PASSWORD='demo"quoted"password'
```

以上内容只是格式示例，不得替换为文档中的共享密码。`.env.local`中同一个字段只能保留一行。

连接池默认最多使用5个连接，可通过`DB_CONNECTION_LIMIT`调整，允许范围为1到10。业务时间字段统一使用`DATETIME(3)`，应用连接采用UTC语义和`utf8mb4`字符集。

## 执行顺序

```powershell
npm run db:health
npm run db:migrate
npm run db:status
npm run db:migrate
```

健康检查只输出数据库是否匹配、MySQL主版本、SSL是否启用、会话是否为UTC和连接池上限，不输出真实连接信息。连接池建立每个新连接时都会执行`SET SESSION time_zone = '+00:00'`。第一次迁移创建采集阶段表并写入迁移记录，第二次应返回没有待执行迁移。

`db:status`只读取`information_schema`、迁移记录和表清单。尚未迁移时不会创建迁移表，也不会修改数据库结构。

数据库存在程序无法识别的更高迁移版本，或者历史迁移文件的名称、内容与迁移记录不一致时，迁移命令会停止。项目不提供自动降级、删表或清库命令。

## 表范围

- 数据来源、品牌监控项和品牌搜索词
- 采集任务、帖子和评论
- 帖子与评论互动快照
- 脱敏原始字段快照
- 品牌帖子命中关系
- 采集游标与品牌租约锁

小红书数据来源由首个迁移以稳定代码`xiaohongshu`创建。只有处于启用状态且未归档的品牌允许创建采集任务。

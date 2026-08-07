# LIVE管理员登录实现工作日志

## 本次改动

- 正式MySQL模式要求独立配置`ADMIN_USERNAME`和`ADMIN_PASSWORD`，不再使用MOCK管理员凭据。
- MOCK模式继续使用现有`MOCK_ADMIN_USERNAME`和`MOCK_ADMIN_PASSWORD`默认值。
- 所有模式统一通过运行时配置完成恒定时间凭据比较。
- MySQL模式管理员密码至少需要8个字符，只校验长度，不要求特定字符组合，且不得回退到MOCK默认密码。
- MySQL模式强制启用`Secure`，不允许通过配置降级；MOCK模式默认关闭，保持本地HTTP开发可用。
- LIVE会话Cookie使用`__Host-readtrace_session`名称，并保持`Secure`、`Path=/`且不设置`Domain`；MOCK模式继续使用原Cookie名称。

## 安全边界

- 没有读取或修改`.env.local`。
- 没有把真实账号、密码或会话令牌写入代码、示例文件和日志。
- 没有增加多用户、注册、密码找回或数据库用户表。

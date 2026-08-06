# 小红书数据采集探针

该工具只用于低频、只读地验证真实数据链路。它不会点赞、收藏、关注、评论或发布内容，也不会连接MySQL。

## 首次运行

```powershell
npm install
npx playwright install chromium
npm run probe:xhs -- --keyword Leader
```

首次运行会打开可见的Chromium窗口。请在窗口中自行完成登录，程序检测到登录完成后会继续搜索。登录状态只保存在`.local/xhs-profile/`，该目录已经被Git忽略。不要复制或导出其中的Cookie、Token及其他凭证。

## 可选参数

```powershell
npm run probe:xhs -- --keyword Leader --search-limit 20 --detail-limit 3 --detail-delay-ms 2000
```

程序会把上限强制限制为20条搜索结果和3篇详情，并把详情访问间隔强制限制为至少2秒。结果写入`artifacts/xhs-probe/<运行标识>/`，其中包含`report.json`、`posts.json`、`comments.json`和脱敏后的`raw/`快照。

结果中的帖子来源统一写成`https://www.xiaohongshu.com/explore/<帖子ID>`格式。探针只在当前运行期间使用搜索结果中带临时参数的地址进行页面导航，不会把`xsec_token`写入输出。

页面要求验证码或提示访问频繁时，探针会停止当前任务并记录原因，不会尝试自动绕过。

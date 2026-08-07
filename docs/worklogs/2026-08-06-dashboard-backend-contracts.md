# 首页驾驶舱后端合同与筛选改造

## 本次范围

- 首页概览接口增加多品类筛选，并与日期、多品牌筛选共用同一数据范围。
- 主题证据接口增加日期、多品牌和多品类筛选，帖子与评论均返回可追溯来源。
- 新增数据管理汇总接口，统计帖子、评论、AI分类进度、分析任务状态和人工修正数量。
- 更新模拟仓储及模拟数据，保持正式模式和模拟模式合同一致。

## 接口合同

- `GET /api/v1/overview`
  - 支持：`from`、`to`、`brandIds`、`categoryIds`。
  - `brandIds`和`categoryIds`使用逗号分隔的多值并集筛选。
- `GET /api/v1/topics/:topicId/evidence`
  - 支持：`contentType`、`from`、`to`、`brandIds`、`categoryIds`。
  - 评论的日期筛选沿用所属帖子的发布时间；评论自身没有可靠的标准发布时间，响应中的`publishedAt`继续保持`null`。
- `GET /api/v1/data-management/summary`
  - 返回：`totalPosts`、`totalComments`、`aiClassifiedPosts`、`aiClassifiedComments`、`analysisRunningCount`、`analysisFailedCount`、`manualCorrectionCount`、`lastAnalysisAt`。

## 统计口径

- AI已分类数量按照内容去重，只统计至少存在一条成功AI分析记录的帖子或评论。
- 人工修正不计入AI已分类数量。
- 运行中和失败数量取每条内容最新一次分析状态，避免历史重试记录重复累加。
- 人工修正只统计尚未撤销的记录。
- `lastAnalysisAt`取最后一次成功分析的完成时间。
- 首页品类使用模型结果经过有效人工修正后的最终值。
- 问题热榜只统计有效情感为负向的内容，主题证据下钻采用相同负向口径。
- 品类排行同时承担筛选入口职责，因此忽略当前`categoryIds`，但继续遵守日期和品牌范围，避免选择一个品类后其他候选消失。
- 主题热榜返回`affectedPostCount`与`commentCount`。影响帖子按照`post_id`去重，因此只有评论命中时，其所属帖子也计入；评论数只统计直接命中主题的评论。
- 同时提供`from`和`to`时，主题热榜在一次聚合查询中统计当前自然日周期及紧邻的等长上期；上期为零时`changeRatio`返回`null`。缺少完整日期范围时不比较，Mock也暂时返回`null`。
- 同时提供`from`和`to`时，趋势按照`Asia/Shanghai`转换为自然日日期并补齐完整序列，没有内容的日期四种情感数量均为零；MySQL与Mock复用同一补零逻辑。
- MySQL连接使用UTC时区，趋势查询在`SELECT`和`GROUP BY`中统一把`bucket_at`从`+00:00`转换为`+08:00`；Mock也复用同一个上海日期转换函数，避免北京时间凌晨内容落入前一天。
- 概览自然日范围最多支持366天，MySQL查询或Mock聚合开始前即返回参数错误，避免生成过多日期桶。

## 验证结果

- API类型检查通过。
- Contracts类型检查通过。
- API构建通过。
- Contracts构建通过。
- 全量测试共104项，103项通过、1项因当前Windows环境无法创建文件符号链接而跳过，没有失败项。
- `npm run typecheck`和`npm run build`通过。

## 北京时间趋势修复验证

- `MySQL 概览使用真实聚合结果并保留健康状态`目标测试通过，SQL已经同时验证`SELECT`和`GROUP BY`使用UTC到`+08:00`的转换。
- `npm run typecheck`通过。
- 本切片完成时全量测试共105项，103项通过、1项跳过、1项失败。失败项为并行合同兼容改造尚未完成，旧版热榜响应缺少`affectedPostCount`和`commentCount`时仍被合同拒绝；本切片未越界修改合同。

### 2026-08-07 切片A收尾复核

- MySQL趋势查询继续在查询字段和分组字段中统一使用`CONVERT_TZ(bucket_at, '+00:00', '+08:00')`，避免北京时间凌晨内容被归到前一个自然日。
- Mock趋势继续复用`overview-trend.ts`中的`shanghaiDate`，MySQL与Mock采用同一自然日口径。
- 单独运行`MySQL 概览使用真实聚合结果并保留健康状态`通过：1项通过、0项失败。
- `npm run typecheck`通过。
- `npm test`完成：105项中103项通过、1项跳过、1项失败。唯一失败仍是并行处理中的旧版热榜合同兼容测试，与本切片的时区实现无关；本切片没有修改测试或合同。

## 建议由主控补充的测试

- `/overview`多品牌、多品类组合筛选的请求解析与MySQL参数顺序。
- 同一帖子命中多个选中品牌时不会重复计数。
- 品类人工修正优先于模型分类，并统一作用于所有首页统计模块。
- 主题证据在日期、品牌和品类组合筛选下只返回当前主题内容。
- 数据管理的AI分类数量按照内容去重，历史失败与重试记录不增加已分类数量。
- 已撤销人工修正不计入`manualCorrectionCount`。
# 2026-08-07 二次审查修复

- 概览日期范围现在要求`from`和`to`成对提供，避免单边日期绕过366天上限。
- Mock仓储的内容、概览和采集任务日期筛选改为按`Date.parse`后的时间点比较，避免不同时区偏移的等价时间被字符串顺序误判。
- MySQL概览测试补充热榜去重帖子、直接命中评论以及紧邻等长上期参数断言。
- 日期边界测试覆盖366天允许、367天拒绝及单边日期拒绝。

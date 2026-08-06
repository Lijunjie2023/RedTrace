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
- 主题热榜不伪造增长率，现阶段继续返回`null`。

## 验证结果

- API类型检查通过。
- Contracts类型检查通过。
- API构建通过。
- Contracts构建通过。
- 全量测试共98项，96项通过、1项跳过、1项失败。失败项是前端并行改造将主导航由五项改为四项后，旧测试仍断言五项；与本次后端合同和查询改动无关，需由主控按已确认的导航范围更新测试。

## 建议由主控补充的测试

- `/overview`多品牌、多品类组合筛选的请求解析与MySQL参数顺序。
- 同一帖子命中多个选中品牌时不会重复计数。
- 品类人工修正优先于模型分类，并统一作用于所有首页统计模块。
- 主题证据在日期、品牌和品类组合筛选下只返回当前主题内容。
- 数据管理的AI分类数量按照内容去重，历史失败与重试记录不增加已分类数量。
- 已撤销人工修正不计入`manualCorrectionCount`。

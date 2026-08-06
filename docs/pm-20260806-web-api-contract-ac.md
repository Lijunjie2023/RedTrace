# Web与API并行开发契约及验收标准

文档状态：可进入并行开发

确认日期：2026-08-06

参考需求：`tasks/prd-xiaohongshu-public-opinion-v1.md`

参考数据规格：`docs/pm-20260806-collection-persistence-ac.md`

运行模式：一口气模式

## 1. 结论与本轮边界

本轮固定前端、API、共享契约和模拟数据之间的边界，使前端能够用模拟数据完成七条页面路由，API能够独立实现MySQL读取与业务操作，二者通过`packages/contracts`中的同一份契约联调。

本轮只定义接口和可验收行为，不改变采集数据库结构。DeepSeek真实分析、分析结果持久化、Excel文件生成和正式登录凭据存储可以分批实现，但首批API必须保留稳定字段和明确的未实现状态，不能通过伪造真实证据填补缺口。

强制约束如下：

- API进程通过`DATA_MODE=mock|mysql`选择数据适配器，进程启动后不能按单个请求切换。
- `DATA_MODE=mock`时不得建立MySQL连接，不得读取、写入或清理云数据库。
- `DATA_MODE=mysql`时只读取或修改正式业务仓储，响应中的`meta.dataMode`固定为`LIVE`。
- 模拟响应中的`meta.dataMode`固定为`MOCK`，所有模拟分析和模拟证据必须在界面上显示模拟标识。
- 模拟证据不得使用可被误认为真实小红书证据的作者、正文、帖子ID或原帖链接。
- API字段使用`camelCase`，枚举值使用`UPPER_SNAKE_CASE`，数据库字段命名不得直接泄露给Web。
- 所有列表端点从第一版开始分页，不提供无限制全量列表。
- 七条页面路由中只有五条进入主导航。

## 2. 工程目录与责任边界

### 2.1 `apps/web`

负责：

- 七条页面路由、五项主导航、页面布局、筛选器、表格、图表、表单和状态反馈。
- 将筛选条件同步到URL查询参数，支持刷新、复制链接和图表跳转后恢复筛选。
- 只通过API客户端读取或修改数据，不直接导入数据库模块，不直接查询MySQL。
- 根据`meta.dataMode`和资源级`evidenceOrigin`展示数据来源标识。
- 将接口的加载中、尚未采集、筛选无结果、采集失败、网络失败分别渲染。
- 对API响应执行共享契约校验。契约不通过时显示结构错误，不猜测缺失字段。

禁止：

- 不得直接导入`fixtures`作为页面数据源。
- 不得把品牌、品类、问题类型、模型名称或枚举显示名称散落硬编码在页面组件中。
- 不得在页面中自行拼装确定性分析结论或伪造原帖链接。
- 不得读取`.env.local`中的数据库配置。

### 2.2 `apps/api`

负责：

- HTTP路由、登录会话校验、输入校验、统一响应封装、分页和错误映射。
- 根据`DATA_MODE`在`MockRepository`与`MysqlRepository`之间选择一个数据适配器。
- `mysql`模式调用现有数据库持久化和协调能力，保持帖子、评论、任务、租约锁和游标规则不变。
- 将数据库的`snake_case`字段映射为公共契约的`camelCase`字段。
- 将BIGINT主键序列化为字符串，将数据库UTC时间序列化为带`Z`的ISO 8601字符串。
- 对修改请求执行版本校验，对重复采集触发返回冲突结果。

禁止：

- 不得把MySQL连接对象、SQL、数据库错误消息、连接地址或凭据返回给Web。
- 不得在`mock`模式创建数据库连接池或调用迁移、清理、写入命令。
- 不得让路由处理器直接读取fixture文件。fixture只能由MockRepository读取。

### 2.3 `packages/contracts`

负责：

- API请求、响应、分页、错误包、筛选条件、枚举和DTO的唯一公共定义。
- 提供运行时校验schema和由schema推导的TypeScript类型。
- 提供API客户端需要的端点路径、查询参数序列化规则和响应解析规则。
- 对新增字段采用向后兼容的可选扩展。现有字段不得改名、改类型或静默删除。

禁止：

- 不依赖React、Web框架、MySQL驱动或Node文件系统。
- 不包含真实账号、Cookie、Token、连接串、原帖正文或真实作者信息。
- 不包含页面组件和数据库实体。

### 2.4 `fixtures`

建议首批目录为`fixtures/web-api/`，包含`manifest.json`和按资源拆分的JSON文件。

负责：

- 提供完全符合`packages/contracts`运行时schema的模拟响应原始数据。
- `manifest.json`记录`fixtureVersion`、生成时间、数据集说明和`isSimulated: true`。
- 提供有数据、尚未采集、筛选无结果、采集失败、高风险内容和分页边界样例。
- 使用`mock-brand-*`、`mock-post-*`、`mock-comment-*`等明显的模拟ID。

禁止：

- 不得包含真实小红书作者、帖子ID、评论ID、原文、Cookie、Token、手机号或可访问的原帖链接。
- 不得由`mysql`模式读取。
- 模拟操作不得回写fixture文件。MockRepository的修改只保存在当前API进程内存中，进程重启后恢复初始fixture。

## 3. 数据模式契约

### 3.1 环境变量

| 配置 | 允许值 | 行为 |
|---|---|---|
| `DATA_MODE` | `mock` | 只启动MockRepository，不要求MySQL配置，不允许创建数据库连接 |
| `DATA_MODE` | `mysql` | 启动MysqlRepository，要求MySQL配置完整并完成启动健康检查 |
| `DATA_MODE` | 缺失或其他值 | API启动失败，进程返回非零，不回显环境变量内容 |

`DATA_MODE`是API进程配置，不是请求参数。任何请求头、查询参数或请求体都不能覆盖该值。

### 3.2 统一成功包

```ts
interface ApiSuccess<T> {
  data: T;
  meta: {
    requestId: string;
    generatedAt: string;
    dataMode: "MOCK" | "LIVE";
    persistence: "EPHEMERAL" | "PERSISTED";
    fixtureVersion?: string;
    pagination?: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  };
}
```

约束：

- `mock`模式必须返回`dataMode: "MOCK"`、`persistence: "EPHEMERAL"`和`fixtureVersion`。
- `mysql`模式必须返回`dataMode: "LIVE"`、`persistence: "PERSISTED"`，不得返回`fixtureVersion`。
- `generatedAt`使用UTC ISO 8601格式，页面按`Asia/Shanghai`展示。
- 列表端点必须返回`meta.pagination`。非列表端点不得伪造分页字段。
- 缺失的互动数使用`null`，只有原始值明确为零时才返回`0`。

### 3.3 统一错误包

```ts
interface ApiFailure {
  error: {
    code:
      | "AUTH_REQUIRED"
      | "AUTH_FAILED"
      | "VALIDATION_ERROR"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "DUPLICATE_RESOURCE"
      | "COLLECTION_ALREADY_RUNNING"
      | "DEPENDENCY_UNAVAILABLE"
      | "NOT_IMPLEMENTED"
      | "INTERNAL_ERROR";
    message: string;
    retryable: boolean;
    fieldErrors?: Array<{ field: string; code: string }>;
  };
  meta: {
    requestId: string;
    generatedAt: string;
    dataMode: "MOCK" | "LIVE";
  };
}
```

HTTP状态映射：

| HTTP状态 | 错误代码 | 使用场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 查询参数格式错误、分页越界 |
| 401 | `AUTH_REQUIRED`、`AUTH_FAILED` | 未登录、登录失败 |
| 404 | `NOT_FOUND` | 资源不存在或已不可访问 |
| 409 | `VERSION_CONFLICT`、`DUPLICATE_RESOURCE`、`COLLECTION_ALREADY_RUNNING` | 乐观锁冲突、重复品牌、品牌采集已运行 |
| 422 | `VALIDATION_ERROR` | 字段格式正确但业务取值不允许 |
| 503 | `DEPENDENCY_UNAVAILABLE` | MySQL或下游依赖不可用 |
| 501 | `NOT_IMPLEMENTED` | 契约已保留但当前里程碑未实现 |
| 500 | `INTERNAL_ERROR` | 未分类服务端错误 |

错误响应不得包含SQL、堆栈、数据库主机、数据库账号、密码、Cookie、Token、模型密钥或完整内部异常文本。

### 3.4 分页与查询参数

- 分页参数：`page`默认`1`，最小`1`；`pageSize`默认`20`，允许`10|20|50|100`。
- 排序参数：`sortBy`只能使用端点声明的白名单字段；`sortOrder`允许`ASC|DESC`。
- 多选参数使用英文逗号分隔，例如`brandIds=1,2`、`sentiments=NEGATIVE,NEUTRAL`。
- 时间参数`from`、`to`使用带时区的ISO 8601字符串；`from`不得晚于`to`。
- 未传参数表示不限制。传空字符串属于`VALIDATION_ERROR`，不能静默解释为全部。

## 4. 七条页面路由与五项主导航

| 页面路由 | 页面名称 | 主导航 | 入口与职责 |
|---|---|---|---|
| `/login` | 登录 | 否 | 未登录访问业务页时跳转；登录成功进入`/overview` |
| `/overview` | 舆情总览 | 是 | 指标、趋势、排行、高风险内容和采集状态 |
| `/insights` | 原因与关键词 | 是 | 正负向主题、关键词、趋势和证据入口 |
| `/content` | 内容明细 | 是 | 帖子与评论分页、组合筛选和导出 |
| `/content/:contentType/:id` | 内容详情与人工修正 | 否 | 原文、上下文、模型结果、人工修正和证据回溯 |
| `/brands` | 品牌监控 | 是 | 品牌、搜索词、启停状态和手动采集 |
| `/data-status` | 数据状态 | 是 | 采集任务、失败摘要、重试和数据量异常 |

主导航顺序固定为：舆情总览、原因与关键词、内容明细、品牌监控、数据状态。登录页和内容详情页不得生成第六、第七个主导航项。分类配置保留API契约，首批不单独增加页面。

## 5. 共享枚举与核心字段

### 5.1 公共枚举

| 枚举 | 首批值 |
|---|---|
| `DataMode` | `MOCK`、`LIVE` |
| `PersistenceMode` | `EPHEMERAL`、`PERSISTED` |
| `ContentType` | `POST`、`COMMENT` |
| `Sentiment` | `POSITIVE`、`NEUTRAL`、`NEGATIVE`、`UNKNOWN` |
| `ContentNature` | `USAGE_SHARING`、`PURCHASE_INQUIRY`、`CUSTOMER_COMPLAINT`、`BRAND_REVIEW`、`MARKETING`、`OTHER` |
| `RiskLevel` | `NORMAL`、`WATCH`、`HIGH_RISK` |
| `ConfidenceLevel` | `HIGH`、`MEDIUM`、`LOW` |
| `BrandStatus` | `DRAFT`、`ENABLED`、`DISABLED`、`ARCHIVED` |
| `SearchTermType` | `ALIAS`、`MODEL`、`EXCLUDE` |
| `CollectionTaskStatus` | `QUEUED`、`RUNNING`、`SUCCESS`、`PARTIAL_SUCCESS`、`FAILED` |
| `CollectionHealth` | `NOT_COLLECTED`、`HEALTHY`、`PARTIAL`、`FAILED`、`STALE` |
| `EvidenceOrigin` | `ORIGINAL`、`SIMULATED` |
| `AnalysisOrigin` | `MODEL`、`HUMAN_OVERRIDE`、`SIMULATED`、`UNAVAILABLE` |

品类、问题类型、原因主题属于可配置资源，公共契约只定义ID和显示字段，不把业务词表固化为TypeScript枚举。

### 5.2 证据字段

```ts
interface EvidenceRef {
  contentType: "POST" | "COMMENT";
  contentId: string;
  evidenceOrigin: "ORIGINAL" | "SIMULATED";
  excerpt: string | null;
  authorDisplayName: string | null;
  publishedAt: string | null;
  likedCount: number | null;
  sourceUrl: string | null;
  canOpenOriginal: boolean;
}
```

证据不变量：

- `evidenceOrigin: "ORIGINAL"`时，`meta.dataMode`必须为`LIVE`，`sourceUrl`必须是允许的小红书HTTPS地址，`canOpenOriginal`必须为`true`。
- `evidenceOrigin: "SIMULATED"`时，`meta.dataMode`必须为`MOCK`，`sourceUrl`必须为`null`，`canOpenOriginal`必须为`false`。
- 模拟证据的`excerpt`和作者名称必须使用明显模拟内容，页面固定显示模拟数据标识。
- 没有原始证据时，分析可以返回`analysisOrigin: "UNAVAILABLE"`，不能返回确定性原因主题并伪装成有证据。

### 5.3 内容摘要与有效分析

```ts
interface EffectiveAnalysis {
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN";
  contentNature: string | null;
  problemTypeIds: string[];
  categoryId: string | null;
  productSeries: string | null;
  productModel: string | null;
  userStage: string | null;
  riskLevel: "NORMAL" | "WATCH" | "HIGH_RISK";
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  topicIds: string[];
  analysisOrigin: "MODEL" | "HUMAN_OVERRIDE" | "SIMULATED" | "UNAVAILABLE";
  modelName: string | null;
  analyzedAt: string | null;
  correctedAt: string | null;
}

interface ContentSummary {
  id: string;
  contentType: "POST" | "COMMENT";
  postId: string;
  title: string | null;
  excerpt: string | null;
  authorDisplayName: string | null;
  publishedAt: string | null;
  likedCount: number | null;
  collectedCount: number | null;
  commentCount: number | null;
  sourceUrl: string | null;
  brandIds: string[];
  effectiveAnalysis: EffectiveAnalysis;
  evidenceOrigin: "ORIGINAL" | "SIMULATED";
  canOpenOriginal: boolean;
  firstCollectedAt: string | null;
  lastCollectedAt: string | null;
}
```

### 5.4 品牌、分类和采集状态

```ts
interface Brand {
  id: string;
  name: string;
  status: "DRAFT" | "ENABLED" | "DISABLED" | "ARCHIVED";
  searchTerms: Array<{
    id: string;
    type: "ALIAS" | "MODEL" | "EXCLUDE";
    value: string;
    status: "ENABLED" | "DISABLED" | "ARCHIVED";
  }>;
  lastSuccessfulCollectionAt: string | null;
  latestTaskStatus: "QUEUED" | "RUNNING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ClassificationItem {
  id: string;
  classificationType: "CATEGORY" | "PROBLEM_TYPE" | "TOPIC";
  code: string;
  displayName: string;
  description: string | null;
  isEnabled: boolean;
  sortOrder: number;
  version: number;
}

interface CollectionTaskSummary {
  id: string;
  brandId: string;
  triggerType: "MANUAL" | "SCHEDULED" | "RETRY";
  status: "QUEUED" | "RUNNING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
  startedAt: string | null;
  finishedAt: string | null;
  succeededPostCount: number;
  failedPostCount: number;
  errorType: string | null;
  errorSummary: string | null;
  retryOfTaskId: string | null;
}
```

## 6. 首批API端点

本节所有API路径统一使用`/api/v1`前缀。表格中保留的`/api/...`写法按版本前缀解释为`/api/v1/...`，不提供无版本别名。

### 6.1 登录会话

| 方法与路径 | 输入 | 成功输出 | 失败 |
|---|---|---|---|
| `POST /api/session` | JSON：`username:string`、`password:string` | `ApiSuccess<{ isAuthenticated:true; expiresAt:string }>`，同时设置HttpOnly会话Cookie | `401 AUTH_FAILED`，不得指出账号或密码哪一项错误 |
| `GET /api/session` | 无 | `ApiSuccess<{ isAuthenticated:boolean; expiresAt:string|null }>` | 服务异常返回统一错误包 |
| `DELETE /api/session` | 无 | `ApiSuccess<{ isAuthenticated:false }>`，服务端会话立即失效 | 重复退出仍返回成功 |

Mock模式使用专用开发会话，不读取真实管理员密码；fixture不得保存登录密码。除`POST /api/session`和`GET /api/session`外，业务端点默认要求已登录。

### 6.2 舆情总览

`GET /api/overview`

查询参数：`from`、`to`、`brandIds`。

输出`data`：

```ts
interface OverviewData {
  metrics: {
    postCount: number | null;
    commentCount: number | null;
    negativeCount: number | null;
    negativeRatio: number | null;
  };
  sentimentTrend: Array<{ bucket: string; positive: number; neutral: number; negative: number; unknown: number }>;
  brandRanking: Array<{ brandId: string; brandName: string; contentCount: number; negativeCount: number }>;
  categoryRanking: Array<{ categoryId: string; categoryName: string; contentCount: number }>;
  problemTypeRanking: Array<{ problemTypeId: string; problemTypeName: string; contentCount: number }>;
  risingTopics: Array<{ topicId: string; topicName: string; changeRatio: number | null; evidenceCount: number }>;
  highRiskContents: ContentSummary[];
  collectionHealth: "NOT_COLLECTED" | "HEALTHY" | "PARTIAL" | "FAILED" | "STALE";
  lastSuccessfulCollectionAt: string | null;
}
```

尚未采集时，计数字段返回`null`、数组返回`[]`、`collectionHealth`返回`NOT_COLLECTED`。不得把计数返回为零。

### 6.3 原因主题与关键词

| 方法与路径 | 输入 | 成功输出 |
|---|---|---|
| `GET /api/topics` | `from`、`to`、`brandIds`、`categoryIds`、`problemTypeIds`、`sentiment`、`page`、`pageSize`、`sortBy`、`sortOrder` | 分页主题：`id`、`name`、`description`、`sentiment`、`contentCount`、`postCount`、`commentCount`、`userCount`、`likedCount`、`changeRatio`、`evidenceCount`、`analysisOrigin` |
| `GET /api/keywords` | 与主题列表相同，增加`topicId` | 分页关键词：`keyword`、`sentiment`、`occurrenceCount`、`postCount`、`commentCount`、`userCount`、`likedCount`、`changeRatio` |
| `GET /api/topics/{topicId}/evidence` | `contentType`、`page`、`pageSize`、`sortBy`、`sortOrder` | 分页`EvidenceRef` |

主题和关键词没有真实分析结果时，LIVE模式返回空列表和`analysisStatus: "NOT_AVAILABLE"`的页面级状态，不得由API临时编造主题。MOCK模式允许返回模拟分析，但每项`analysisOrigin`必须为`SIMULATED`。

### 6.4 内容明细、上下文与人工修正

`GET /api/contents`

查询参数：`contentType`为必填的`POST|COMMENT`，其余参数为`from`、`to`、`brandIds`、`categoryIds`、`productSeries`、`productModel`、`sentiments`、`contentNatures`、`problemTypeIds`、`riskLevels`、`keyword`、`topicId`、`page`、`pageSize`、`sortBy`、`sortOrder`。页面默认选择`POST`，帖子与评论分别分页，禁止把两个独立集合分别分页后再合并。

返回分页`ContentSummary`。允许排序字段为`publishedAt`、`likedCount`、`lastCollectedAt`、`riskLevel`。

| 方法与路径 | 输入 | 成功输出 | 备注 |
|---|---|---|---|
| `GET /api/contents/{contentType}/{contentId}` | 路径中的`contentType`为`POST|COMMENT` | `ContentDetail`，包含完整文本、所属帖子、父评论、上下文、模型原始标准化结果和有效分析 | 评论必须能返回所属帖子ID |
| `PATCH /api/contents/{contentType}/{contentId}/correction` | JSON：允许修改的分析字段；请求头`If-Match: {version}` | 最新`EffectiveAnalysis`和新`version` | MOCK模式只改内存并显示模拟标识；LIVE模式持久化后供汇总使用 |
| `DELETE /api/contents/{contentType}/{contentId}/correction` | 请求头`If-Match: {version}` | 删除人工修正后的有效分析和新`version` | 只撤销人工修正，不删除模型结果和原始内容 |
| `POST /api/exports` | JSON：与内容列表相同的筛选条件和`exportType` | `exportId`、`status: "QUEUED"` | 未实现时返回`501 NOT_IMPLEMENTED`，不得生成不完整文件 |
| `GET /api/exports/{exportId}` | 无 | `status`、`downloadUrl|null`、`expiresAt|null`、`errorSummary|null` | 下载地址只在`SUCCESS`时存在 |

### 6.5 品牌监控

| 方法与路径 | 输入 | 成功输出 | 并发与限制 |
|---|---|---|---|
| `GET /api/brands` | `status`、`keyword`、`page`、`pageSize`、`sortBy`、`sortOrder` | 分页`Brand` | 空列表返回`[]`和零分页总数 |
| `POST /api/brands` | JSON：`name`、`status`、`searchTerms[]` | `201 ApiSuccess<Brand>` | 同一来源品牌名称重复返回`409 DUPLICATE_RESOURCE` |
| `PATCH /api/brands/{brandId}` | 部分品牌字段；请求头`If-Match: {version}` | 最新`Brand`和递增后的`version` | 版本不符返回`409 VERSION_CONFLICT` |
| `PUT /api/brands/{brandId}/searchTerms` | 完整搜索词集合；请求头`If-Match: {version}` | 最新`Brand`和新`version` | 省略已有搜索词表示停用或归档，不能物理删除历史引用 |
| `POST /api/brands/{brandId}/collection-runs` | JSON：`triggerType: "MANUAL"` | `202 ApiSuccess<CollectionTaskSummary>` | 品牌未启用返回`422`；已有运行任务返回`409 COLLECTION_ALREADY_RUNNING` |

首批不提供品牌物理删除端点。停用、重新启用和归档通过`PATCH`完成，历史帖子、评论、命中和任务继续可查。

### 6.6 分类配置

| 方法与路径 | 输入 | 成功输出 |
|---|---|---|
| `GET /api/classifications` | `classificationType`、`isEnabled`、`page`、`pageSize` | 分页`ClassificationItem` |
| `POST /api/classifications` | `classificationType`、`code`、`displayName`、`description`、`sortOrder` | `201 ApiSuccess<ClassificationItem>` |
| `PATCH /api/classifications/{classificationId}` | 部分显示字段或`isEnabled`；请求头`If-Match` | 最新分类项和新`version` |

已经被历史内容引用的分类项只能停用，首批不提供分类物理删除端点。Mock模式的新增和修改只在当前进程内有效。

### 6.7 数据状态

| 方法与路径 | 输入 | 成功输出 |
|---|---|---|
| `GET /api/collection-runs` | `brandIds`、`statuses`、`from`、`to`、`page`、`pageSize`、`sortBy`、`sortOrder` | 分页`CollectionTaskSummary`和页面级`lastSuccessfulCollectionAt`、`consecutiveFailureCount`、`volumeAnomaly` |
| `POST /api/collection-runs/{taskId}/retries` | 空JSON对象 | `202 ApiSuccess<CollectionTaskSummary>`，新任务的`retryOfTaskId`指向原失败任务 |

只有`FAILED`和`PARTIAL_SUCCESS`任务可以重试。原任务保持不变。相同品牌存在运行任务时返回`409 COLLECTION_ALREADY_RUNNING`。

## 7. 实体生命周期与牵连关系

### 数据模式

生命周期：API启动读取配置 → 选择`MOCK`或`LIVE`适配器 → 进程运行期间保持固定 → 进程退出。

牵连关系：

- 模式决定仓储、响应`meta`、页面标识和操作持久性。
- 模式配置非法时API不能启动，不能回退到另一模式。
- MOCK模式不得因MySQL配置存在而创建连接。

### fixture数据集

生命周期：版本化JSON创建 → 契约校验 → MockRepository加载 → 内存派生状态 → 进程退出后丢弃派生状态。

牵连关系：

- fixture字段变化必须先更新`packages/contracts`或保持向后兼容。
- fixture不能成为LIVE模式的回退数据源。
- 模拟内容被主题、关键词和图表引用时，所有下钻证据继续保持`SIMULATED`。

### 筛选状态

生命周期：页面默认值 → 用户修改 → URL序列化 → API请求 → 页面刷新或分享链接恢复 → 用户清除。

牵连关系：

- 总览、原因关键词和内容明细共享同名筛选参数和枚举。
- 图表下钻只能增加或替换明确筛选条件，不能丢失时间和品牌条件。
- 清除筛选恢复页面默认值，不修改服务端数据。

### 可修改资源

品牌、分类项和人工修正的生命周期沿用PRD及数据规格。公共API额外引入`version`：读取版本 → 带`If-Match`修改 → 成功后版本递增；版本冲突时不写入并返回最新资源需要重新读取的提示。

### 采集任务

生命周期和牵连关系沿用`docs/pm-20260806-collection-persistence-ac.md`。页面只展示业务状态，不暴露租约令牌、游标值或数据库锁细节。

## 8. 五个必问

### Q1 空状态

- 没有品牌：总览显示尚未配置品牌，指标为`null`，提供进入品牌监控的入口；原因、关键词和内容页显示尚无可查询数据。
- 品牌已启用但从未成功采集：显示`NOT_COLLECTED`，不能显示零舆情或下降百分比。
- 已经采集但当前筛选没有命中：显示筛选无结果，同时保留筛选条件和清除按钮；计数允许为零。
- LIVE模式尚无分析结果：原始内容可以展示，分析字段使用`UNAVAILABLE`，原因主题和关键词为空。
- MOCK模式：页面顶栏和每个模拟证据区显示模拟数据，原帖按钮禁用。

### Q2 操作失败

- API网络中断：页面保留上一次成功内容并显示请求失败和重试按钮，不把旧内容清空成空状态。
- MySQL不可用：API返回`503 DEPENDENCY_UNAVAILABLE`，页面显示数据服务不可用，不显示零值。
- 契约校验失败：Web显示数据格式异常并记录`requestId`，不得用默认值补齐确定性结论。
- 品牌或分类版本冲突：API返回`409 VERSION_CONFLICT`，不写入；页面提示数据已变化并提供重新加载。
- 手动采集重复触发：API返回`409 COLLECTION_ALREADY_RUNNING`，页面显示当前运行任务入口，不创建重复任务。
- 导出失败：状态返回`FAILED`且`downloadUrl`为`null`，页面不得提供不完整文件。

### Q3 数据被引用

- 品牌被帖子命中、任务或搜索词引用时只能停用或归档，不能通过API物理删除。
- 分类项被分析结果引用时只能停用，历史内容继续返回当时的分类显示快照或可解析ID。
- 人工修正被汇总使用时，撤销修正后汇总恢复模型有效结果，模型原结果不删除。
- fixture被多个页面引用时，修改fixture必须通过共享契约校验，避免页面各自解释不同字段。

### Q4 并发

- 品牌、分类项和人工修正使用`version`与`If-Match`乐观锁。后提交的旧版本请求返回`409`。
- 手动采集使用现有品牌级租约锁。同一数据来源和品牌只允许一个运行任务，不同品牌可以并行。
- 列表读取不加业务锁。分页排序必须包含稳定的次级ID排序，避免同值项目跨页重复。
- MOCK模式并发修改同样使用内存版本号，不能因为数据不持久化而跳过冲突检测。

### Q5 后悔与撤销

- 品牌和分类项支持停用后重新启用，不删除历史数据。
- 人工修正通过`DELETE correction`撤销，只移除人工覆盖层，模型结果和原始证据保留。
- 采集任务触发后不能撤销已成功写入的数据；失败任务通过新重试任务处理，原任务保留。
- MOCK模式修改可通过重启API恢复fixture初始状态，页面必须提示修改不会持久保存。
- Excel导出生成后不回滚数据；过期下载地址失效，重新导出生成新任务。

## 9. 输入输出链

### 输入

- `DATA_MODE` → 配置缺失或非法时启动失败；不得自动回退。
- `fixtures/web-api` → 启动时按共享schema校验；任一必需fixture非法时Mock API启动失败并只报告fixture资源名和错误代码。
- MySQL标准化数据 → 连接失败返回依赖不可用；字段缺失保留`null`，不转换为零或空文本。
- 分析结果 → 只有通过固定字段校验的结果进入LIVE统计；没有结果时返回`UNAVAILABLE`。
- URL查询参数和表单输入 → 在API边界校验；非法输入不进入仓储层。
- 会话Cookie → 无效或过期时返回`401 AUTH_REQUIRED`，不泄露会话内部值。

### 输出

- `apps/web`页面 → 下游无法解析响应时显示结构错误和`requestId`，不猜测字段。
- 图表与排行下钻 → 统一转为`/contents`或`/insights`的URL筛选参数，保证刷新后可恢复。
- Excel导出 → 数据量过大时使用后台任务；失败不发布下载地址。
- 操作日志和服务日志 → 记录`requestId`、资源ID、阶段和错误类型，不记录密码、Cookie、Token、连接串或正文。
- MOCK演示 → 只能用于界面与契约联调，不参与真实统计、不写云数据库、不作为采集能力证据。

## 10. 子功能优先级

必须项和应该项合计17项，开发时拆成三个独立工作包：共享契约与数据模式、API资源与仓储适配、Web路由与页面状态。三个工作包以本文件的端点和DTO为共同边界并行推进。

### 必须在首批并行开发实现

1. 四个目录边界和单向依赖规则。
2. `packages/contracts`公共枚举、响应包、错误包、分页和核心DTO。
3. `DATA_MODE`启动校验及MockRepository、MysqlRepository隔离。
4. 每个响应的`meta.dataMode`和模拟持久性标识。
5. 七条页面路由和五项主导航。
6. 登录会话接口和业务路由鉴权边界。
7. 总览、主题关键词、内容、品牌、分类、采集任务首批读取接口。
8. 品牌、分类、人工修正、手动采集和重试的写接口契约。
9. 统一筛选、排序、分页和URL状态协议。
10. 模拟分析与模拟证据的显著标识及原帖链接禁用规则。
11. 统一错误包、空状态和依赖失败状态。
12. 可修改资源的版本冲突处理和采集并发冲突处理。

### 应该在首批并行开发实现

1. fixture启动校验和契约测试。
2. MOCK模式禁止创建MySQL连接的自动化测试。
3. 图表、排行、主题和关键词下钻URL的契约测试。
4. 请求`requestId`贯穿API响应和页面错误反馈。
5. 模拟修改的进程内版本号和重启恢复说明。

### 可以延后

1. Excel文件实际生成和下载存储，首批保留稳定端点并返回明确未实现状态。
2. DeepSeek真实分析写入和人工修正持久化，首批先完成契约与MOCK交互。
3. 复杂重复搬运内容识别和高级趋势算法。
4. 云部署、域名、HTTPS和多管理员权限。

## 11. 验收标准

### AC-1：目录边界

- 前置：四个开发目录已经创建。
- 操作：执行依赖检查并搜索跨目录导入。
- 期望：`apps/web`只依赖API客户端和`packages/contracts`；`apps/api`依赖`packages/contracts`、仓储和服务；`packages/contracts`不依赖Web、API框架、MySQL或文件系统；只有MockRepository读取`fixtures`。
- 关联子功能：必须1。

### AC-2：共享契约唯一来源

- 前置：Web和API分别完成一次构建。
- 操作：修改一个响应schema的可选字段并重新构建两端。
- 期望：两端都从`packages/contracts`获得同一类型和运行时校验；仓库中不存在第二份手写同名DTO。
- 关联子功能：必须2。

### AC-3：DATA_MODE配置

- 前置：分别设置`DATA_MODE=mock`、`DATA_MODE=mysql`、缺失和非法值。
- 操作：启动API。
- 期望：mock选择MockRepository；mysql选择MysqlRepository并校验MySQL配置；缺失和非法值均以非零状态退出且输出不包含环境变量值。
- 关联子功能：必须3。

### AC-4：MOCK数据库隔离

- 前置：设置`DATA_MODE=mock`，同时提供一个会在连接时失败的MySQL连接工厂假对象。
- 操作：启动API，读取总览并提交一次品牌修改。
- 期望：MySQL连接工厂调用次数为0；响应成功；修改只存在于当前MockRepository内存；云数据库没有新增或更新记录。
- 关联子功能：必须3、应该2。

### AC-5：数据模式元信息

- 前置：API分别运行在mock和mysql模式。
- 操作：调用成功、列表和失败端点。
- 期望：mock所有响应均含`meta.dataMode=MOCK`；mysql所有响应均含`meta.dataMode=LIVE`；列表同时含合法分页；错误包同样包含模式和`requestId`。
- 关联子功能：必须4。

### AC-6：七条路由和五项主导航

- 前置：Web启动且管理员已登录。
- 操作：逐一访问七条页面路由并统计主导航项。
- 期望：七条路由均匹配本文件第4节；主导航恰好五项，顺序一致；登录和内容详情不出现在主导航。
- 关联子功能：必须5。

### AC-7：登录与未登录访问

- 前置：无会话、错误凭据和有效会话三种状态。
- 操作：访问业务路由、提交登录并退出。
- 期望：无会话业务请求返回`401 AUTH_REQUIRED`并跳转登录；错误凭据返回`AUTH_FAILED`且不指出失败字段；有效会话进入总览；退出后原会话立即失效。
- 关联子功能：必须6。

### AC-8：总览尚未采集状态

- 前置：选中一个已启用但从未成功采集的品牌。
- 操作：调用`GET /api/overview`并打开总览。
- 期望：`collectionHealth=NOT_COLLECTED`，四个指标为`null`，趋势和排行为空数组，页面显示尚未采集，不显示零舆情或下降比例。
- 关联子功能：必须7、11。

### AC-9：筛选无结果与真实零值区分

- 前置：数据库已有成功采集数据；准备一个无命中的筛选和一条互动数明确为零的内容。
- 操作：调用内容列表。
- 期望：无命中时`data=[]`且`totalItems=0`，页面显示筛选无结果；明确零互动返回`likedCount=0`；原始字段缺失返回`likedCount=null`。
- 关联子功能：必须9、11。

### AC-10：列表分页和稳定排序

- 前置：准备101条发布时间相同的内容。
- 操作：明确指定`contentType=POST`，按`publishedAt DESC`依次请求三页，每页50条；再对评论单独验证。
- 期望：帖子分页分别返回50、50、1条；`totalItems=101`、`totalPages=3`；同一内容不跨页重复；帖子和评论不得混合分页；缺少`contentType`或`pageSize=101`返回`400 VALIDATION_ERROR`。
- 关联子功能：必须7、9。

### AC-11：筛选URL与下钻

- 前置：总览选择时间和两个品牌。
- 操作：点击负面趋势、问题类型排行、原因主题和关键词，再刷新目标页。
- 期望：目标URL保留`from`、`to`、`brandIds`并增加对应筛选；刷新后筛选器和请求参数一致；清除筛选后恢复默认值。
- 关联子功能：必须9、应该3。

### AC-12：模拟分析标识

- 前置：`DATA_MODE=mock`且fixture包含主题、关键词和模拟高风险内容。
- 操作：打开总览、原因与关键词、内容明细并查看证据。
- 期望：页面持续显示模拟数据；分析项`analysisOrigin=SIMULATED`；证据`evidenceOrigin=SIMULATED`、`sourceUrl=null`、`canOpenOriginal=false`；原帖按钮禁用；fixture中不存在可访问的小红书原帖链接。
- 关联子功能：必须10。

### AC-13：LIVE证据约束

- 前置：`DATA_MODE=mysql`且存在可追溯的真实帖子或评论。
- 操作：调用内容详情和主题证据端点。
- 期望：原始证据`evidenceOrigin=ORIGINAL`、`sourceUrl`为允许的小红书HTTPS地址、`canOpenOriginal=true`；没有证据的分析返回`UNAVAILABLE`，不能返回确定性主题证据。
- 关联子功能：必须7、10。

### AC-14：统一错误包与敏感信息

- 前置：分别制造参数错误、未登录、资源不存在、版本冲突、MySQL不可用和未分类异常。
- 操作：调用对应端点并检查响应及日志。
- 期望：所有错误符合`ApiFailure`；HTTP状态和错误代码符合第3.3节；响应和日志不包含SQL、连接地址、账号、密码、Cookie、Token、模型密钥、堆栈或完整正文。
- 关联子功能：必须11、应该4。

### AC-15：品牌新增、重复和版本冲突

- 前置：存在一个版本为3的品牌。
- 操作：新增同名品牌；分别带`If-Match: 3`和旧版本`If-Match: 2`修改品牌。
- 期望：同名新增返回`409 DUPLICATE_RESOURCE`；版本3修改成功且返回版本4；旧版本修改返回`409 VERSION_CONFLICT`且数据库或Mock内存状态不变。
- 关联子功能：必须8、12。

### AC-16：品牌停用与重新启用

- 前置：品牌已有历史帖子、命中关系和任务。
- 操作：通过PATCH停用，再重新启用。
- 期望：停用后不允许创建新计划采集任务；历史内容继续可查；重新启用后可以触发新任务；全过程不调用品牌物理删除。
- 关联子功能：必须8。

### AC-17：分类引用与撤销

- 前置：分类项已经被历史分析引用。
- 操作：尝试停用、重新启用并尝试调用不存在的删除端点。
- 期望：停用和重新启用成功且版本递增；历史内容仍返回分类信息；删除端点返回404或405，不删除历史引用。
- 关联子功能：必须8。

### AC-18：人工修正并发与撤销

- 前置：内容存在模型分析，人工修正版本为1。
- 操作：两个客户端均以版本1提交不同修正，再撤销成功的修正。
- 期望：一个请求成功并返回版本2，另一个返回`409 VERSION_CONFLICT`；汇总使用成功修正；撤销后模型结果重新成为有效分析，模型原结果和证据保持不变。
- 关联子功能：必须8、12。

### AC-19：手动采集并发

- 前置：同一品牌已有运行中的采集任务。
- 操作：连续两次调用品牌采集端点。
- 期望：第二次返回`409 COLLECTION_ALREADY_RUNNING`和当前任务可用标识；数据库只新增一个任务；不同品牌的请求可以同时返回202。
- 关联子功能：必须8、12。

### AC-20：失败任务重试

- 前置：存在一个失败任务和一个成功任务。
- 操作：分别调用重试端点。
- 期望：失败任务产生新的`QUEUED`任务，`retryOfTaskId`指向原任务，原任务不变；成功任务返回`422 VALIDATION_ERROR`且不创建任务。
- 关联子功能：必须8。

### AC-21：API失败时保留上次内容

- 前置：页面已经成功加载一页内容。
- 操作：使下一次请求返回网络失败或`503 DEPENDENCY_UNAVAILABLE`。
- 期望：页面保留上次成功内容并显示失败提示和重试按钮；不得把列表替换为空状态，不得把指标替换为零。
- 关联子功能：必须11。

### AC-22：fixture契约与安全

- 前置：准备完整fixture和一份故意缺字段的fixture。
- 操作：执行fixture契约测试及敏感信息扫描。
- 期望：完整fixture通过所有共享schema；缺字段fixture失败并指出资源名；fixture不含真实作者、手机号、Cookie、Token、真实帖子ID或可访问的小红书链接。
- 关联子功能：应该1。

### AC-23：MOCK修改的临时性

- 前置：API运行在mock模式，品牌版本为1。
- 操作：修改品牌得到版本2，重启API后重新读取。
- 期望：修改后的响应包含`persistence=EPHEMERAL`；重启后品牌恢复fixture初始值和版本1；全过程MySQL连接调用次数为0。
- 关联子功能：应该5。

### AC-24：导出未实现边界

- 前置：导出生成器尚未实现。
- 操作：调用`POST /api/exports`。
- 期望：返回`501 NOT_IMPLEMENTED`统一错误包，不创建下载地址、不生成空文件、不改变当前筛选或业务数据。
- 关联子功能：可以延后1。

## 12. 待确认项

一口气模式按以下假设完成契约，后续调整应通过增加字段或新增端点保持兼容：

1. 七条P0路由包含登录页，分类配置不进入主导航。主导航采用总览、原因与关键词、内容明细、品牌监控、数据状态五项。
2. Web不直接读取fixture，所有模拟页面也通过API请求，以保证MOCK与LIVE路径一致。
3. MOCK写操作采用进程内临时状态，不写fixture文件，也不提供跨重启持久化。
4. 首批保留人工修正和导出接口。人工修正可以先由MOCK实现完整交互；真实持久化和Excel生成允许按开发顺序后置。
5. 品牌、分类项和人工修正使用整数`version`与`If-Match`。如果后续采用ETag，仍需保持相同冲突语义和`409 VERSION_CONFLICT`错误代码。

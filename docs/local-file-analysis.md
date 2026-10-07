# 本地文件算数能力改造方案（问数 Agent × 用户上传文件）

> 目标：让问数 Agent 在**当前会话内**把用户上传的本地文件（CSV / XLS / XLSX）当作一等数据源，与指标查询结果、业务数据集结果一起做精确算数（对账、比例、拆分、套表、补充字段），并保持完整血缘与过程产物可追踪。
> 本文只描述改造方案，不含实现。

## 1. 结论先行

核心链路**不需要改沙箱**。现有 `CodeExecutionService.materializeArtifact()` 已经能把工作区产物落成沙箱 `input/` 下的真实文件，并写 `input/manifest.json`：

- `TABLE` 产物 → `<n>_<标题>.csv` + `.json`（含列名、bizName、showType、unit）
- `FILE` 产物 → 按 `payload.encoding`（`utf8` / `base64`）还原原始扩展名文件

因此改造的实质是：**把"用户上传的本地文件"变成一条合规的工作区产物**，再让它在 Agent 上下文里可见、可被 `execute_analysis_code` 引用。

## 2. 现有可复用资产（已核对源码）

| 能力 | 位置 | 复用方式 |
| --- | --- | --- |
| 产物表（用户隔离、session 维度、版本表） | `src/database.js` `workspace_artifacts` / `artifact_versions` | **零迁移**，直接复用 `artifact_type` + `metadata_json` + `payload_json` |
| 文件产物写入 | `src/workspace.js` `createFileArtifact()` | 上传原始字节直接落成 `FILE` 产物 |
| 沙箱输入物化 | `src/codeExecution.js` `materializeArtifact()` | 已支持 `FILE`（base64 还原）与 `TABLE`（转 csv+json） |
| 过程产物记录 | `src/processArtifacts.js` `createProcessArtifactRecorder()` | 每一步数据产出落 `PROCESS_STEP` 产物 |
| 字段语义识别（词典驱动） | `src/datasetProfiler.js` + `src/businessLexicon.js` | 识别上传文件的"时间字段/指标字段/维度字段"，**无需在代码里写死业务规则** |
| 路由表 + 鉴权中间件 | `src/http/router.js`、`src/http/routes/chat.js` | 新路由照 `artifacts.download` 的写法接入 |
| 编码回退 | Node 22 full-icu（已实测 `TextDecoder('gbk')` 可用） | 中文 CSV 的 GBK/GB18030 回退**不需要新增依赖** |

## 3. 必须先确认的冲突与前置阻塞（重要）

1. **沙箱在本机当前完全不可用（已实测）**
   - 默认 `pythonBin = 'python'`（`src/config.js`），本机只有 `python3` → `spawn python ENOENT`。
     （已修：`src/config.js` 改为按平台兜底 `python3`/`python`，`npm run setup` 会探测可用解释器并写回 `.env`。）
   - 设 `PYTHON_BIN=python3` 后沙箱可用，但 `pandas`、`openpyxl` **均未安装**（实测输出 `pandas MISSING openpyxl MISSING`）。
   - 影响：依赖 `pandas` 的图形化与旧版二进制 `.xls` 解析无法在当前环境验证；纯标准库（`csv`/`json`/`decimal`/`statistics`）仍可完成精确算数。
   - 最终结论（用户确认后）：上传入口只暴露 `csv/xls/xlsx`，**xlsx 由 YOLO 侧自研读取器解析（`src/xlsxReader.js`，只依赖 node:zlib），不依赖 `pandas`/`openpyxl`**；旧版二进制 `.xls` 仅保存原始文件并提示转换。
2. **与"正式业务数值只来自在线指标"的冲突**（`docs/theme-prompts` 最高原则 1/3 + 展示规范 5.2 节）
   - 上传文件的数值没有在线指标的 formatted 值，也没有指标来源 ID。
   - 处理原则：文件来源必须**显式标注来源**（如"来源：上传文件 `回款.xlsx`"），展示格式走 5.2 节"动态加工值"的继承/角色默认规则，**禁止**把文件口径表述为指标平台口径。
3. **与数据权限体系的冲突**（行级过滤、列级脱敏只作用于指标/数据集查询）
   - 上传文件天然绕过权限体系。定位为"**用户自有数据**"：仅本会话可用、不进入知识库/反馈沉淀、不跨用户共享；每次使用记录文件指纹与使用者审计。
4. **架构守卫的体积约束**（`config/size-baseline.json`，`GROWTH_TOLERANCE = 0`，新文件上限 800 行）
   - 已登记文件的基线**只降不升**：任何增长都是 error，`npm run lint:baseline` 也会拒绝静默抬高。
   - 结论：新逻辑必须落在**新模块**里；确需在已登记文件里增长时，必须显式承认
     `npm run lint:baseline -- --allow-growth=<file>`，让这次上调留在命令与提交记录里。
5. **请求体上限 2MB 且无 multipart 解析器**（`src/http/support.js` `readJson` 硬编码 2MB；仓库除 `mysql2` 外无依赖）
   - 建议 P0：上传走 **base64 JSON**，仅对上传路由放宽上限（原始文件 ≤ 8MB）。需你确认是否接受。
   - 代价：base64 内联进 SQLite 会让 `artifact_versions.payload_json` 膨胀；P1 可改磁盘存储 + 指纹去重（见 §6）。

## 4. 设计

### 4.1 数据模型（零迁移，全部复用现有两张表）

| 产物 | `artifact_type` | payload | metadata 关键字段 |
| --- | --- | --- | --- |
| 原始上传文件 | `FILE` | `{encoding:'base64'\|'utf8', content, format, mimeType}` | `source:{type:'UPLOAD', name, size, mimeType, uploadedAt, sha256, encoding, delimiter?}`, `purpose:'用户上传'` |
| 解析后的表格 | `TABLE` | `{data:{columns:[…], rows:[…]}}` | `source:{type:'UPLOAD_FILE', id}`, `derivedFromArtifactId`, `parentArtifactIds:[fileId]`, `rowCount`, `columnCount`, `truncated:boolean` |
| 识别与过程记录 | `PROCESS_STEP` | 编码探测 / 分隔符 / 表头 / 字段角色建议 | 复用 `processArtifacts.js` 的既有结构 |

- `columns` 沿用平台既有列契约：`{ name, bizName, showType, type, unit? }`，`showType` 为 `NUMBER` 时即"指标列"。
- 大文件策略：≤ 50k 行全量入 `TABLE`；超过则只存 profile + 前 1k 行抽样，`truncated: true`，并在上下文与回答中提示"需用代码在全量文件上计算"。

### 4.2 后端模块（新增为主）

- `src/fileParsing.js`（新，纯函数、可单测）
  - 编码探测：BOM → UTF-8 → GBK/GB18030 回退（`TextDecoder`，失败才报错）
  - 分隔符探测：`,` / `;` / `\t` / `|`；表头行探测；尾随空列、全空行清理
  - 类型推断：整数 / 小数 / 千分位 / 百分比 / 日期（多格式试探）/ 文本；**只做格式判断，不含任何业务词表**
  - 列名归一：trim、去重、空列名补 `列N`，生成稳定 `bizName`
- `src/uploads.js`（新，`UploadService`）
  - 校验：扩展名白名单（默认 `csv/xls/xlsx`，可用环境变量扩展其它文本格式）、大小上限、内容签名校验（`PK\x03\x04` 要求 xlsx、OLE 签名识别旧版 xls、`%PDF`/PNG/JPEG/RTF 与非文本内容一律拒绝）、拒绝可注入类型
  - 文件名净化与长度限制（沿用 `codeExecution.js` 的 `sanitizeFileName` 风格）
  - 落 `FILE` 产物 → 调 `fileParsing` → 落派生 `TABLE` 产物 → 调 `datasetProfiler.profileDataset()` 生成字段角色建议
  - 审计：`FILE_UPLOAD` / `FILE_REJECTED` / `FILE_DELETED`
  - 配额：每会话文件数、总字节上限（防 DB 膨胀）
- `src/http/routes/uploads.js`（新）
  - `POST /api/workspaces/:id/files`（`middleware:['auth']`，body `{name, mimeType, contentBase64}`，该路由单独放宽 body 上限）
  - `DELETE /api/artifacts/:artifactId`（软停用，保留版本与血缘）
  - 列表复用现有 `GET /api/workspaces/:id/artifacts`
- `src/agent.js`（薄接入，≤ 50 行）
  - 上下文产物清单：`workspaceArtifacts`（`agent.js:4709`）已经是"除 `PROCESS_STEP` 外的全部产物 + 取 `payload.data.columns` + 前 3 行样本"，因此上传文件**只要派生 TABLE 时写好 `columns` / `metadata.rowCount` / `metadata.columnCount`，就无需改上下文构建器**；否则会显示成 `0 行 / 0 列 / 无样例` 并误导模型。
  - 需要确认的上下文预算：该处硬编码 `.slice(0, 12)`，上传文件会与查询结果竞争这 12 个名额，需约定"最新上传优先"或单独统计文件数。
  - 系统提示新增文件治理条款（见 §4.4）
  - `list_workspace_artifacts` 返回值带上 profile，让模型知道"有哪些列可用"
- `src/config.js` + `.env.example`：`PYTHON_BIN=python3`、`UPLOAD_MAX_BYTES`、`UPLOAD_ALLOWED_EXTENSIONS`

**不新增 LLM 工具**（降低改动面）：文件清单/预览复用 `list_workspace_artifacts`，计算统一走 `execute_analysis_code`（其 `inputArtifactIds` 同时接受上传文件和查询结果产物）。

**提问附件绑定（已实现）**：前端把待提交文件随提问一并发送，服务端在 `src/chatAttachments.js` 中按
「当前用户 + 当前会话 + `FILE` 产物」校验后写入该条用户消息的 `result_json` 并绑定产物 `message_id`，
使用户提问气泡能回显本轮引用的文件，且刷新会话后仍可追溯。校验不通过的产物 ID 直接忽略。

### 4.3 前端

- `public/js/components/fileUpload.js`（新）：拖拽区 + 选择文件 + 前端预校验 + 上传进度 + 结果 chip（成功/失败原因）
- `public/js/pages/query.js`（薄接入）：在 `chat-input-shell` 上方增加附件行（与 `chat-example-row` 同层）；发问时携带 `fileArtifactIds`
- `public/js/components/workspaceArtifacts.js`：产物抽屉按"查询结果 / 本地文件 / 过程记录"分组，文件项支持下载（走 `/api/artifacts/:id/download`）
- 接入后要求：上传成功的文件在会话内**每轮**都作为可引用产物出现在上下文，但只有用户当轮明确引用或点名文件时才参与计算

### 4.4 Agent 治理条款（写进主题提示词/skill，不写进代码）

1. 文件数值只允许来自当轮用户上传文件或既有工作区产物，禁止用模型记忆补数。
2. 引用文件必须先读其 profile 列出实际列名；列名无法对应业务词时先澄清，不得猜测列语义。
3. 文件来源与指标来源同表呈现时，必须给出"来源"列或分组，口径说明中分别标注，禁止合并成一个不标注的合计。
4. 文件来源数值无在线指标格式时，按展示规范 5.2 节"动态加工值"处理（先继承可比指标格式，否则用角色默认格式），且**不得**声称来自指标平台。
5. 跨文件/跨来源的计算必须通过 `execute_analysis_code` 在原始精度上完成，禁止对已格式化展示值二次计算。
6. 大文件（`truncated: true`）的证据不足时，必须先说明只能用代码在全量文件上计算，再执行。

### 4.5 安全与治理清单

- 扩展名白名单 + MIME 嗅探 + magic number；拒绝可执行/可注入类型
- 不解析、不执行宏；xlsx 只做数据读取
- 沙箱 CODE-001 门禁不变：生成代码不得直接访问宿主机路径、网络、数据库驱动；文件只出现在 run 目录 `input/`
- 用户隔离：产物查询一律带 `userId`，跨用户/跨会话引用直接拒绝（复用现有 `getArtifact` 校验）
- 下载：沿用现有导出链路；CSV 导出保持公式注入防护（前导 `=`/`+`/`-`/`@` 转义需确认现状）

## 5. 分阶段实施（P0 已实现，见 §9）

**P0（最小可跑闭环，预计 4 新文件 + 4 处薄接入）**
1. `src/fileParsing.js` + 单测（含 GBK 样例）
2. `src/uploads.js` + `POST /api/workspaces/:id/files` + 审计
3. `agent.js` 上下文与提示词薄接入
4. 前端上传入口 + 产物抽屉分组
5. 端到端验证：上传 CSV × 上一轮指标结果 → 联合计算 → 结果标注来源 → 过程产物齐全
   - 仅支持 `csv/tsv/json`（不依赖 pandas）；沙箱需 `PYTHON_BIN=python3`

**P1**
多工作表选择与多文件合并（当前只解析第一个工作表）、`inspect_local_file` 预览工具、磁盘存储 + sha256 去重、会话内文件复用与删除、界面上的配额提示

**P2**
批量上传与大文件流式（multipart/分片）、文件级共享权限、把"文件 + 查询"沉淀为可复用分析模板

## 6. 验收标准

- 单测：编码探测（UTF-8/GBK）、分隔符与表头探测、类型推断、上传路由鉴权、超限与非法类型拒绝
- 端到端：上传 CSV + 指标结果 → "按上传表的客户编码补充回款率" → 表格含来源标注、口径说明分列来源、产物抽屉出现 3 类产物（查询结果、上传文件、过程记录）
- 反例：上传 `.exe` / 超大文件 / 引用他人 artifactId → 明确报错、不落库、有审计记录

## 7. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 沙箱 Python 依赖缺失 | 本机实测无 `pandas`/`openpyxl`，且默认 `pythonBin='python'` 不存在 | 配置 `PYTHON_BIN=python3`；表格解析已改为不依赖 Python；缺库时给出明确错误而非静默失败（当前 prelude 是静默 `except: pass`） |
| SQLite 膨胀 | base64 内联 + 版本表双写 | P0 限 ≤8MB、配额；P1 转磁盘存储 |
| 上下文过长 | 大文件行数多 | 只注入 profile + ≤20 行样本 |
| 治理边界模糊 | 文件数值与指标口径混算 | §4.4 条款 + 展示规范 5.2 节约束 |
| 与权限体系冲突 | 文件绕过行级/列级权限 | 定位为用户自有数据，会话内隔离 + 审计 |
| 上下文名额竞争 | `agent.js:4709` 硬编码 `.slice(0, 12)`，上传文件与查询结果共用名额 | P0 约定最新上传优先/单独计数；P1 改为按类型分组取样 |

## 8. 需要你确认的三个决策

1. **上传体积与存储**：接受 P0 用 base64 内联、单文件 ≤8MB 吗？还是必须直接上磁盘存储？
2. **xlsx 是否 P0 必须**：结论是上传入口只暴露 `csv/xls/xlsx`，xlsx 用 YOLO 侧自研读取器解析（不依赖 `pandas`/`openpyxl`）。
3. **文件结果与指标结果同表**：我建议允许同表，但必须带"来源"标注且口径说明分列来源；是否同意这条边界？

## 9. P0 实施记录（已落地）

已确认的决策：base64 内联 + 单文件 ≤8MB；上传入口只暴露 CSV/XLS/XLSX；文件结果允许与指标结果同表但必须标注来源。

| 文件 | 作用 |
| --- | --- |
| `src/fileParsing.js` | 通用解析：BOM/UTF-8/GB18030 探测、分隔符、表头、列名归一、列类型推断 |
| `src/xlsxReader.js` | 自研 XLSX 读取器（node:zlib）：ZIP 目录、stored/deflate、sharedStrings、inlineStr、日期样式还原 |
| `src/uploads.js` | 上传校验、配额、原始文件 + 解析表 + 过程文件落库、审计 |
| `src/http/routes/uploads.js` | `POST /api/workspaces/files`（按上限放宽读体限制） |
| `src/localFileGuidance.js` | 本地上传的提示词治理条款（不写业务规则） |
| `public/js/components/fileUpload.js` | 输入框上方附件行：选择/拖拽、base64 读取、结果 chip |
| `public/uploads.css` | 附件行样式（复用主题 token） |

薄接入：`src/agent.js`（注入治理条款）、`src/workspace.js`（`createTableArtifact`、文件产物 `source`、
CSV 公式前缀转义）、`src/config.js`（上传配置）、`src/server.js` / `src/application.js`（服务与路由）、
`public/js/pages/query.js`（附件行与绑定）、`public/js/components/workspaceArtifacts.js`（本地文件分组）。

验证：`tests/localFiles.test.js` 覆盖解析、GBK、配额与拒绝路径、上传落库链路、沙箱输入物化
（有可用 Python 时执行，否则跳过）；线上实测上传 UTF-8 CSV、GBK CSV 与真实 xlsx（deflate + sharedStrings +
日期样式）均解析正确，旧版二进制 xls 只保存并提示，非白名单扩展名被拒，解析表下载与按上传文件提问均正常。

已知限制：多工作表 xlsx 只解析第一个工作表；解析表默认只保留前 `uploads.maxTableRows` 行（截断时写入
warning 并标注文件真实总行数，全量数据需在代码计算里读取原始文件产物）；旧版二进制 `.xls` 只保存原文并提示转换；
上传产物体积与配额按配置项控制。ZIP 层按中央目录索引条目，因此兼容 Excel 默认写出的 data descriptor 归档。

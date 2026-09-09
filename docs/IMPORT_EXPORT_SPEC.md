# 导入、导出与备份协议

## 1. 目标

本协议定义三类不同用途的数据交换能力：

- CSV/Excel：面向人工查看、编辑和批量迁移岗位申请。
- ICS：面向系统日历的事件提醒。
- 完整备份 ZIP：面向可靠恢复和跨版本迁移。

三者不能互相冒充。CSV 不承诺保存完整关联关系，ICS 不承诺保存业务状态，单独的 JSON 不承诺包含附件。

## 2. CSV/Excel 导入

### 2.1 支持格式

- `.csv`：UTF-8，导入时兼容带 BOM 文件。
- `.xlsx`：读取首个工作表，或由用户在预览步骤选择工作表。
- 首行默认作为列名；空白行忽略。
- 日期解析必须在预览中显示最终结果，不得静默猜测歧义日期。

### 2.2 标准申请列

| 标准字段 | 必填 | 示例 | 规则 |
| --- | --- | --- | --- |
| `company` | 是 | 字节跳动 | 去除首尾空白；为空则该行阻塞导入 |
| `role` | 是 | 后端开发工程师 | 去除首尾空白；为空则该行阻塞导入 |
| `cycle` | 否 | 2027届秋招 | 缺省为空 |
| `stage` | 否 | 已投递 | 缺省为“机会池”；未知值要求映射 |
| `priority` | 否 | 高 | 缺省为“中” |
| `source` | 否 | 招聘会 | 空值映射为 `UNSPECIFIED`；支持标准值或明确的自定义值 |
| `source_detail` | 条件必填 | 学院群 | `source=自定义` 时必填，其他来源必须为空 |
| `source_fair` | 条件必填 | 2027 届秋招双选会 | `source=招聘会` 时用于映射招聘会实体 |
| `source_url` | 否 | `https://…` | 非法 URL 阻塞，需修正、置空或转入备注 |
| `location` | 否 | 上海 | 自由文本 |
| `deadline` | 否 | `2026-09-30 18:00` | 显式使用本地时区，预览后确认 |
| `next_action` | 否 | 完成在线测评 | 与 `review_at` 互斥；单独出现时导入为 `ACTION` |
| `review_at` | 否 | `2026-09-15` | 与 `next_action` 互斥；单独出现时导入为 `WAITING` |
| `waiting_for` | 否 | HR 回复 | 仅用于补充“在等待什么”；有 `review_at` 时仍可为空 |
| `tags` | 否 | 后端;重点 | 分隔符在预览中选择，默认分号 |
| `notes` | 否 | 内推人已确认 | 作为普通申请备注，不当作面试复盘 |

行动模式按以下顺序确定，不允许导入器自行猜测：

| `next_action` | `review_at` | 结果 |
| --- | --- | --- |
| 有值 | 空 | `ACTION` |
| 空 | 有值 | `WAITING`；创建对应复查事件，`waiting_for` 可为空 |
| 有值 | 有值 | 阻塞；用户必须清空其中一个 |
| 空 | 空 | `NEEDS_ACTION` |

URL 只接受协议和结构均有效的 `http:` / `https:` URL。非法 `source_url` 不得原样写入 URL 字段；预览必须让用户选择“修正”“置空”或“把原值追加到备注”，未选择时阻塞该行。

来源映射也不能靠猜测：空 `source` 映射为 `UNSPECIFIED`；无法识别的非空值必须由用户映射到内建来源或确认为 `CUSTOM`，后者写入 `source_detail`。`source=招聘会` 时，预览必须让用户把 `source_fair` 映射到现有招聘会，或先创建并确认一个招聘会实体；未建立实体关联前该行阻塞。若用户不希望创建招聘会，只能明确改成 `CUSTOM`，不能留下 `RECRUITMENT_FAIR` 与空外键的非法组合。

### 2.3 导入流程

1. 选择文件，不写入数据库。
2. 检测编码、工作表、表头和日期格式。
3. 用户将源列映射到标准字段。
4. 显示逐行预览、错误、警告和预计创建/更新/跳过数量。
5. 对“公司 + 岗位 + 批次”相同的记录发出重复警告，但允许用户逐项决定。
6. 用户确认后，在单个数据库事务中导入。
7. 任一不可恢复错误导致整体回滚；界面保留预览和错误报告。
8. 成功后创建一条导入批次记录，支持在当前会话中整体撤销。

原文件不得自动上传、长期缓存或写入日志。

### 2.4 XLSX 不可信输入与资源预算

- 解析器不得计算公式，不得使用缓存公式结果替代原始输入，也不得执行宏。
- 不抓取外部工作簿、图片、超链接目标或任何关系文件指向的网络资源；外链关系只可作为不可信文本候选进入预览。
- 对公式单元格默认显示“公式未执行”并阻塞其映射；用户可在预览中明确把公式源码当普通文本导入。
- 首版默认预算：压缩文件不超过 20 MiB、成员不超过 2,000、总解压大小不超过 100 MiB、压缩比不超过 100:1、工作表不超过 20、每表不超过 50,000 行和 256 列、总单元格不超过 2,000,000、单元格文本不超过 32,767 个 Unicode 字符、单次解析墙钟时间不超过 10 秒。
- 任一预算超限立即停止解析并给出可操作错误；限制只能由版本化配置调整，不能由工作簿内容覆盖。

## 3. CSV 导出

- 导出使用 UTF-8 BOM，确保常见 Windows 表格软件正确识别中文。
- 默认导出当前筛选结果；必须另提供“导出全部申请”。
- 每行代表一条岗位申请，复杂的面试轮次、资料和附件不展开到 CSV。
- 时间使用 ISO 8601，并额外输出用户可读的本地时间列时，应在列名注明时区。
- 所有文本单元格都执行公式注入防护，而不只处理备注。检测时跳过前导 Unicode 空白、BOM、零宽字符以及 C0/C1 控制字符；若首个有效字符为 `=`、`+`、`-` 或 `@`，就在原始值最前面添加单引号。
- CSV 保留必要的 RFC 4180 引号和 CRLF 行结束。导出器还应移除除制表、换行外不可显示的控制字符，并在预览中报告处理数量。首版不提供 XLSX 导出。

## 4. ICS 日历导出

### 4.1 范围

可导出面试、笔试/测评、招聘会、投递截止和复查日期。每个业务事件对应一个持久稳定的 `UID`。稳定 UID 只为兼容客户端提供识别同一事件的依据；客户端是否合并、更新或仍创建副本取决于其导入实现，产品不得承诺“重复导入必然去重”。

### 4.2 字段映射

- `UID`：由事件稳定 ID 和应用命名空间组成。
- `DTSTAMP`：每次导出时生成的 UTC 时间，格式为 `YYYYMMDDTHHmmssZ`。
- `SEQUENCE`：使用事件持久化的非负 `version`；任何日历可见字段变化必须至少递增一次。
- `DTSTART` / `DTEND`：首版所有定时事件转换为 UTC 并使用尾随 `Z`，禁止 floating time；全天事件使用 `VALUE=DATE` 和 exclusive 结束日期。首版不生成不完整的 `VTIMEZONE`。未来若改用 `TZID`，必须为导出涉及的区间生成完整 `VTIMEZONE`，并作为格式行为变更测试。
- `SUMMARY`：事件类型 + 公司/招聘会 + 岗位。
- `DESCRIPTION`：仅包含用户明确允许进入系统日历的非敏感摘要。
- `LOCATION`：线下地点或线上标识。
- `URL`：会议或招聘页面链接；导出前预览。
- `VALARM`：每个已启用且被选入 ICS 的提醒生成一个 `ACTION:DISPLAY` 子组件，使用相对开始时间的负 `TRIGGER` 和非空 `DESCRIPTION`。默认面试/招聘会为提前 24 小时和 1 小时，截止为提前 3 天和 1 天。

首版是单向导出，不实现系统日历对应用数据的反向修改。

### 4.3 RFC 5545 编码

- 整个文件使用 UTF-8、无 BOM；每条 content line 以 CRLF 结尾，文件末尾也有 CRLF。
- 未折叠 content line 超过 75 octets 时必须折行；续行以 CRLF 加一个 ASCII 空格开始。折行按 UTF-8 字节计数，禁止切断多字节码点。
- TEXT 值中的反斜杠、分号、逗号和换行分别编码为 `\\`、`\;`、`\,`、`\n`。属性名、参数名和组件结构由固定模板产生，绝不接受用户输入。
- 所有用户文本先拒绝或规范化裸 CR/LF，再按目标值类型转义；不得允许用户文本注入新属性、参数或 `BEGIN` / `END` 行。
- URI 值必须先通过 URL 校验并按 URI 规则序列化，不能套用 TEXT 转义后假定安全。
- 日历至少包含 `BEGIN:VCALENDAR`、`VERSION:2.0`、固定 `PRODID`、`CALSCALE:GREGORIAN` 和匹配的结束行；每个 `VEVENT` 必须结构完整。

### 4.4 更新、取消、删除与全量导出

- 默认“当前日程快照”使用 `METHOD:PUBLISH`，只包含所选范围内未删除且未取消的事件。事件未出现在快照中不代表要求日历客户端删除它。
- 编辑后再次导出沿用同一 `UID`，提高 `SEQUENCE` 并刷新 `DTSTAMP`；客户端是否应用更新仍由客户端决定。
- 用户明确导出取消记录时，另生成只含取消/软删除事件的 `METHOD:CANCEL` 文件；事件沿用原 `UID`，包含更高 `SEQUENCE`、`DTSTAMP` 和 `STATUS:CANCELLED`。硬清除前必须保留完成取消导出所需的 tombstone，或明确警告清除后无法通知外部日历。
- “全量导出”产生一份当前快照，并在存在取消 tombstone 时同时产生一份命名清晰的取消文件。由于 `METHOD` 属于整个 `VCALENDAR`，两类事件不能混在同一文件中冒充完整同步。
- 产品不维护日历订阅或客户端回执，因此不能确认外部日历已更新或删除；导出确认页必须说明这一限制。

## 5. 完整备份 v1

### 5.1 普通 ZIP 结构

```text
campus-hire-tracker-backup-YYYYMMDD-HHmmss.zip
├── manifest.json
├── data.json
├── checksums.json
└── attachments/
    └── <object-key>
```

ZIP 成员名一律使用 ASCII 正斜杠和相对路径。目录项可省略；不得包含额外根目录、绝对路径、反斜杠、`..`、空段、重复规范化路径、符号链接、硬链接或特殊文件。

`manifest.json` v1 只允许以下字段，缺一即无效：

- `formatVersion: 1`
- `dataSchema: "backup-v1"`，对应仓库内 [backup-v1.schema.json](schemas/backup-v1.schema.json)
- `createdAt`：UTC RFC 3339 时间
- `appVersion`
- `schemaVersion`：导出时最后应用的数据库迁移 ID
- `timezone`：工作区 IANA 时区
- `workspaceCount: 1`
- `attachmentCount`
- `encrypted`：是否还有外层加密 envelope
- `checksumAlgorithm: "SHA-256"`
- `includedTables` 与 `excludedTables`，均使用第 5.2 节的固定顺序

所有字段类型必须与上文含义一致：版本与计数是非负安全整数，其他标量为有长度上限的字符串或布尔值，表清单为无重复字符串数组；v1 拒绝未知字段。manifest 使用 UTF-8、无 BOM、ASCII 字段名升序、文件末尾一个 LF。`includedTables` 必须恰好等于第 5.2 节列出的 21 个 `tables` 成员；`excludedTables` 必须恰好为 `backup_runs, file_gc_jobs, outbox, __drizzle_migrations`。FTS 与其他可重建派生结构不属于备份协议的逻辑表，因此既不进入数组也不进入 ZIP。

`data.json` 必须通过仓库内的 [backup-v1.schema.json](schemas/backup-v1.schema.json)；JSON Schema 先检查容器结构，应用层再检查列白名单、主键、外键、枚举、领域不变量和附件一一对应关系。两层校验都成功才可恢复。

### 5.2 `data.json` v1 relational snapshot

顶层固定为 `formatVersion`、`exportedAtMs`、`sourceSchemaVersion`、`workspaceId`、`tables` 和 `excludedTables`，禁止未知顶层字段。`tables` 的每个成员是一个表快照；每行使用：

```json
{
  "key": ["opaque-primary-key"],
  "values": {
    "id": "opaque-primary-key",
    "workspace_id": "opaque-workspace-id",
    "created_at_ms": 1788796800000
  }
}
```

- `key` 按数据库主键列顺序保存字符串分量；单 ID 表为一个分量，`application_tags` 为 `workspace_id, application_id, tag_id`，`material_tags` 为 `workspace_id, material_id, tag_id`，`workspace_settings` 为 `workspace_id`。
- `values` 使用数据模型中的 snake_case 列名。恢复时保留所有 ID，不重新生成；所有关联仍使用原外键 ID，并在延迟外键检查或依赖顺序导入后统一验证。
- 已软删除但尚未永久清除的行、`deleted_at_ms`、`delete_operation_id` 与关联行全部包含，使回收站可恢复。
- `timeline_entries` 作为 append-only 事实完整包含，不从当前状态反推或重写。
- `workspace_settings` 和 `ai_provider_configs` 的非秘密字段包含在内；AI 配置不包含 `credential_target` 或任何秘密，恢复后生成新的本机凭据引用并强制 `enabled=0`，由用户重新配置 Key。
- `capture_drafts` 只指 SQLite 中的正式草稿表；浏览器 IndexedDB 离线草稿不属于完整备份。
- `attachments` 表保存元数据；`object_key` 已是包含规范小写扩展名的完整相对文件名。每个尚存在的附件行必须恰好对应 `attachments/<object_key>` 成员，缺失、额外、大小或哈希不符均使备份失败。

M1 即实现此 v1 契约，不另造临时备份格式。尚未开放的 M2/M3 业务表仍以空数组出现在 `tables` 中；对应数据库表可以由基础 schema 预建但不开放 UI。M2 只是开始写入资料、附件、招聘会等数组并增加自动轮换与加密入口，不改变 v1 的基本结构。

表级清单如下，名称必须精确匹配：

| 处理 | 表 |
| --- | --- |
| 包含 | `workspaces`, `workspace_settings`, `companies`, `positions`, `applications`, `tags`, `application_tags`, `material_tags` |
| 包含 | `events`, `event_reminders`, `interview_rounds`, `recruitment_fairs`, `recruitment_fair_targets` |
| 包含 | `materials`, `material_links`, `attachments`, `timeline_entries`, `capture_drafts`, `ai_provider_configs`, `import_runs`, `import_changes` |
| 排除 | `backup_runs`、`file_gc_jobs`、`outbox`、Drizzle 迁移运行表 |
| 排除 | Windows Credential Manager 内容、API Key、备份密码、浏览器 IndexedDB、日志、运行时锁/指针/journal、临时文件和其他备份文件 |

`backup_runs` 是本机文件生命周期审计，恢复它会产生不存在的路径和递归历史；`file_gc_jobs` 和 `outbox` 是当前 generation 的待执行本地副作用，不能跨 generation 回放。v1 明确排除三者。数据库迁移运行表由 `manifest.schemaVersion` 取代，并由恢复器在生成目标数据库时按目标版本重建。

### 5.3 时间、数字、排序与确定性编码

- 所有 `*_at_ms` 和 `exportedAtMs` 是 UTC Unix epoch 毫秒整数；日期字段保持 `YYYY-MM-DD`，时区字段保持 IANA 名称。不得把本地时间字符串当 UTC 猜测。
- JSON 数字只允许 `-(2^53-1)` 到 `2^53-1` 的十进制整数；禁止浮点、指数、`-0`、NaN 和 Infinity。SQLite 的 `0/1` 标志仍编码为整数，不改成布尔值。
- 文件为 UTF-8、无 BOM，字符串保持原码点序列，不执行 Unicode 归一化。只转义 JSON 强制字符和 U+0000–U+001F，非 ASCII 字符直接写 UTF-8，文件末尾恰有一个 LF。
- `tables` 按 schema 中的固定表顺序编码；每张表按 `key` 各分量的 UTF-8 字节升序排列；`values` 的 ASCII 列名按字节升序排列。不得使用区域设置排序。
- 给定相同导出元数据与数据库/附件状态，编码器必须产生逐字节相同的 `data.json` 和成员顺序。恢复器不得依赖 JSON 对象成员顺序。

### 5.4 校验值与信任边界

`checksums.json` v1 是严格对象，只有 `algorithm` 与 `entries` 两个字段；`algorithm` 必须为 `SHA-256`。`entries` 中每项也只允许三个字段：`path`（与 ZIP 成员名逐字节相同的 ASCII 相对路径）、`sizeBytes`（非负安全整数）和 `sha256`（64 位小写十六进制）。条目按 `path` 的 UTF-8 字节升序排列，不得重复；对象字段按 ASCII 名升序，UTF-8 无 BOM，末尾一个 LF。它只列出并覆盖：

- `data.json`
- 每个 `attachments/**` 文件成员

`checksums.json` 不覆盖自身，也不覆盖 `manifest.json`。恢复器分别验证以下集合关系，不能笼统要求四者“完全一致”：

- ZIP 文件成员集合必须恰好是 `{manifest.json, data.json, checksums.json}` 与全部 `attachments/<object_key>` 的并集；
- checksum 条目的 `path` 集合必须恰好是 `{data.json}` 与全部附件成员的并集；
- `data.json.tables.attachments` 中未永久清除的对象键集合必须与附件成员去掉 `attachments/` 前缀后的集合一一对应；
- `manifest.attachmentCount`、附件表行数、附件成员数和附件 checksum 条目数必须相等。

恢复器还必须核对每项 `sizeBytes` 与实际未压缩字节数，并使用常量时间比较哈希；这能发现传输错误和非协调损坏。

普通 ZIP 没有可信签名。攻击者可以同时替换内容、manifest 与 checksums，因此 SHA-256 清单不提供来源认证或抗恶意篡改信任。需要抵抗恶意篡改时必须使用下节的认证加密包，并通过独立渠道保护密码。

## 6. 密码加密包 v1

### 6.1 文件与二进制 envelope

加密导出使用 `.chtrbak` 扩展名，明文负载是第 5 节定义的完整 ZIP 字节。禁止 ZipCrypto，也不在 ZIP 内逐成员加密。

二进制布局按顺序为：

1. 8 字节 magic：ASCII `CHTRBAK\0`；
2. 2 字节无符号大端 envelope version，v1 为 `1`；
3. 4 字节无符号大端 header 长度；
4. 该长度的 UTF-8 JSON header；
5. XChaCha20-Poly1305 密文，末尾含 16 字节认证标签。

v1 header 只含 `kdf`、`argon2Version`、`salt`、`memoryKiB`、`iterations`、`parallelism`、`keyBytes`、`aead`、`nonce`、`tagBytes` 和 `contentType`。固定值分别为 `kdf="argon2id"`、`argon2Version=19`（Argon2 v1.3 / `0x13`）、`aead="xchacha20-poly1305-ietf"`、`contentType="application/vnd.campus-hire-tracker.backup+zip;version=1"`；salt 与 nonce 使用无填充 Base64url。header 禁止未知字段并按 ASCII 键名升序编码。AAD 是 magic、version、header 长度和原始 header 字节的完整拼接，因此任何算法参数修改都会认证失败。

### 6.2 固定算法与资源限制

- 密码按用户输入的原字符串编码为 UTF-8，不裁剪、不执行 Unicode 归一化。
- KDF 固定为 Argon2id v1.3（version `0x13`/十进制 19），随机 salt 16 字节，派生 key 32 字节；v1 写入默认参数为 `memoryKiB=65536`（64 MiB）、`iterations=3`、`parallelism=1`。
- v1 解密器在运行 KDF 前检查：salt 恰为 16 字节、key 恰为 32 字节、`8192 <= memoryKiB <= 262144`、`1 <= iterations <= 10`、`parallelism` 在 `1..4`，header 不超过 4096 字节。超限直接拒绝，防止恶意包造成资源耗尽。
- AEAD 固定为 libsodium 命名的 IETF 变体 `crypto_aead_xchacha20poly1305_ietf`，随机 nonce 24 字节，认证标签 16 字节；每次导出必须使用新的随机 salt 和 nonce。实现可使用兼容成熟库，但不得换成 secretstream、12 字节 nonce 的 ChaCha20-Poly1305 或其他同名近似变体。
- AEAD 认证完成前不得解压或解析明文。错误密码、header/密文篡改和标签错误统一返回“备份无法认证：密码错误或文件已损坏”，不得暴露区分 oracle。
- 密码和派生 key 只在本次操作内存中存在，不写入凭据管理器、数据库、日志、崩溃转储、命令行或剪贴板，也无法找回。

实现必须选用维护中的成熟 Argon2id 与 XChaCha20-Poly1305 依赖，锁定版本，并在全新 Windows + Node.js 24 LTS 上验证安装、往返、错误密码、篡改、资源上限和受控临时文件处理。仓库必须提交一组固定密码、salt、nonce、header 与短明文的跨实现测试向量；真实导出仍必须使用安全随机 salt/nonce。任何算法、参数编码、AAD 或二进制布局变更都必须使用新的 envelope version 并新增 ADR；不得静默改变 v1。决策记录见 [ADR-0004](adr/0004-backup-format-and-encryption.md)。

自动轮换备份留在本机受控目录，默认使用普通 ZIP 且不要求交互式密码；其机密性依赖 Windows 账户和设备加密。

## 7. 恢复与 generation 激活

恢复不会同时“原子切换两个路径”。数据库与附件先构成一个完整 generation，服务停止后只切换一个活动指针：

```text
%LOCALAPPDATA%\CampusHireTracker\
├── stores\<generation>\
│   ├── app.db
│   └── attachments\...
└── runtime\
    ├── active.json
    └── activation-journal.json
```

标准流程：

1. 在服务仍可正常使用时，只读解析 envelope/ZIP，先执行 header、成员路径、成员数、单项/总解压大小与压缩比预算；不修改当前 generation，也不把这一步称为恢复前快照。
2. 验证 manifest、data schema、所有哈希、附件集合、版本兼容性和领域关系；未知新格式直接拒绝，并展示备份摘要与替换范围。
3. 用户最终确认后，先阻止新请求、优雅停止本地服务、关闭数据库句柄并取得排他 `RESTORE` maintenance gate；从此直到提交或回退完成不得接受业务写入、附件发布、GC 或另一维护操作。
4. 在 gate 内为此刻的当前 generation 创建并校验 `pre-restore` 备份。该快照失败则退出，active 指针保持不变。
5. 继续持有 gate，在受控临时目录构建完整候选 generation，应用必要迁移，执行 `quick_check`、`foreign_key_check`、领域不变量和附件哈希检查，再同卷发布到新的 `stores/<generation>`。
6. 写入并刷盘 `runtime/activation-journal.json`，记录 previous/candidate release-generation 对和 `PREPARED`；恢复操作的 candidate 保持当前 `releaseId`，只使用新的 `generationId`。再把 candidate 对写入同目录临时文件、刷盘，以单文件替换方式更新 `runtime/active.json`，随后把 journal 记为 `ACTIVATED`。
7. candidate 只以健康检查维护模式启动，不开放普通 UI 写入。检查成功后把 journal 标为 `VERIFIED` 且 `outcome=COMMITTED`，释放 gate 并开放服务；失败则停止 candidate、把 active 指针切回 previous 对，验证旧组合后把 journal 标为 `VERIFIED` 且 `outcome=ROLLED_BACK`，再释放 gate 并启动旧版本。
8. 启动时若发现未完成 journal，启动 helper 必须先取得同一 gate，再按 `PREPARED → ACTIVATED → VERIFIED` 状态及 active 指向确定性地继续验证或回退。不得分别猜测 release、数据库或附件目录，也不得混搭两个 generation。

`active.json` 至少包含格式版本、`releaseId`、`generationId` 和激活时间，不接受绝对路径。两个 ID 都使用应用生成的受限字符集；解析后的 release 与 generation 路径必须分别仍位于 `runtime/releases` 和 `stores` 根下。旧 release-generation 对至少保留到一次成功重启和用户可见确认之后。

## 8. 兼容性与版本控制

- backup `formatVersion`、加密 `envelopeVersion` 与数据库 `schemaVersion` 分开演进。
- 应用必须导入当前备份格式及至少一个上一主版本格式；旧格式先迁移到新的候选 generation，不修改活动数据。
- v1 JSON Schema 允许行 `values` 中出现未来标量列，但应用层必须按源 schema 的列白名单处理：未知字段保留于迁移上下文或明确忽略，不得错位写入。
- 枚举值未知时进入兼容映射步骤，不得静默改为默认值。
- 每次格式升级都必须提供固定样例、确定性编码、往返、损坏包、资源耗尽与跨版本恢复测试。

## 9. 安全边界

- 解压前检查路径，拒绝绝对路径、`..`、反斜杠、重复规范化路径、链接、设备/特殊文件和超出资源预算的成员。
- 附件扩展名不能替代 MIME、内容签名、大小与 SHA-256 检查。
- 导入产生的 HTML/Markdown 在显示时仍需转义或净化。
- 备份、导入文件路径和内容不得写入遥测；错误日志只保留必要的技术摘要。
- AI API Key、Authorization、Cookie、Windows 凭据、备份密码和派生 key 永远不进入任何导出格式。

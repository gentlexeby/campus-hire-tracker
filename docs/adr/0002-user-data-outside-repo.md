# ADR-0002：用户数据必须存放在 Git 仓库之外

- 状态：已接受
- 日期：2026-09-08
- 决策者：产品所有者与开发者
- 关联：[ADR-0001](0001-local-first.md)、[导入、导出与备份协议](../IMPORT_EXPORT_SPEC.md)

## 背景

朋友将通过 GitHub 克隆和更新应用。如果数据库、附件或备份位于仓库目录中，`git add .`、重新克隆、切换分支或更新脚本都可能误提交、覆盖或遗失敏感求职资料。把这些文件仅加入 `.gitignore` 仍然不足：忽略规则可能被改坏，已跟踪文件不会因 `.gitignore` 自动停止跟踪，用户也可能把整个目录复制或清理。

数据库迁移还要求代码版本和数据版本独立演进。运行时数据必须在代码更新期间保持稳定，并能在迁移失败时恢复。

## 决策

所有运行时用户数据写入 Windows 的本地应用数据根目录：

```text
%LOCALAPPDATA%\CampusHireTracker\
├── stores\
│   └── <generation-id>\
│       ├── app.db
│       └── attachments\<object-key>
├── backups\
│   ├── daily\
│   ├── manual\
│   ├── pre-update\
│   └── pre-restore\
├── logs\
├── runtime\
│   ├── active.json
│   ├── activation-journal.json
│   ├── releases\<release-id>\
│   └── tmp\
└── tmp\
    ├── uploads\
    ├── backups\
    ├── restore\
    └── update\
```

约束如下：

1. 数据根目录由单一的 `DataDirectoryProvider` 解析；其他模块不得拼接 `%LOCALAPPDATA%`、仓库路径或用户输入路径。
2. 数据库、附件、正式 `CaptureDraft`、备份、导入暂存、生成的分享文件、日志和进程锁都不得放入 Git 仓库；M1 `EditorRecoveryDraft` 与 M3 `OfflineCaptureDraft` 只位于固定 origin 的浏览器 IndexedDB，同样不属于仓库文件且不进入完整备份。
3. `stores/<generation-id>` 是完整的数据 generation，内含 `app.db` 与其 `attachments`；更新和恢复构建新 generation，绝不原地迁移当前 generation。
4. 数据库只保存附件的对象键和元数据，不保存仓库相对路径，也不依赖原始文件位置；`object_key` 是已经包含规范小写扩展名的完整相对文件名，唯一目标是 `stores/<generation-id>/attachments/<object_key>`，任何组件不得再次拼接 `.<ext>`。附件对象不可变，内容变化必须生成新键，任何写入都不得覆盖既有对象。
5. API Key 存入 Windows 凭据管理器，凭据目标名可以写入普通设置，但秘密值不得进入数据库、配置文件、日志、备份或 Git。
6. 仓库仍必须通过 `.gitignore` 忽略常见数据库、备份、附件和本地环境文件，作为纵深防御，而不是主隔离机制。
7. 所有导入、恢复和附件写入先进入同一数据根目录下的 `tmp`，完成校验后再通过同卷原子发布；其中附件暂存固定为 `tmp/uploads/<operation-id>`，不得写入 generation、`runtime/tmp` 或系统公共临时目录。不得从压缩包成员直接决定目标路径。
8. 应用只存储附件对象键。读取、备份、恢复与 GC 都将 `generation_id + object_key` 解析到规范化绝对路径，并验证结果仍位于指定 generation 的 `attachments` 根目录内，以阻断路径穿越；GC worker 不依赖 active 指针猜 generation。
9. 自动备份采用版本化 `JSON + attachments` 包，而不是直接复制一个仍在 WAL 模式下打开的数据库文件；完整备份在全局 maintenance gate 下阻塞写入、永久删除与文件 GC，直到数据库和附件复制、自检完成。
10. 默认保留最近 14 份成功的每日备份；清理时先创建新备份并校验成功，再删除超出保留期的旧备份。该数量允许在设置中调整。
11. 软删除对象进入 30 天回收站；永久清除数据库关系时在同一事务写持久化 `file_gc_jobs`/outbox，物理删除由提交后可重试的 worker 完成。
12. `runtime/releases/<release-id>` 保存发布后不可修改的 active/candidate 和上一个已验证可用运行时；唯一的 `runtime/active.json` 必须以一次原子替换同时指向 releaseId 与 generationId。
13. 更新与恢复通过“同目录临时文件 → 刷盘 → 原子替换”的 `runtime/activation-journal.json` 记录 previous/candidate 对及 `PREPARED`、`ACTIVATED`、`VERIFIED`；最终状态同时记录 `COMMITTED` 或 `ROLLED_BACK` 结果和已验证 pair。启动维护 helper 先验证指针，再确定性完成或回退未完成切换，不按目录时间猜测版本；`PREPARED` 前遗留且超过宽限期的 staging/candidate，只有在不被 active、journal 或上一可用策略引用时才可清理。

## 数据路径与安全边界

- 所有路径操作使用规范化绝对路径和平台路径 API；禁止字符串拼接、`..`、绝对压缩包成员、符号链接或重解析点逃逸。
- 临时文件名由应用生成，不采用上传文件名。原文件名仅作为展示元数据，并进行长度和控制字符限制。
- 附件只接受图片和 PDF，必须同时校验大小、扩展名、声明 MIME 与内容签名。默认限制为单文件 `50 MiB`、单批 `20` 个、当前受管附件总量 `2 GiB`、图片解码 `40 MP`、PDF `500` 页。
- 附件发布顺序固定为：用户数据根同卷 `tmp/uploads/<operation-id>` 流式写入 → 对打开句柄 flush 并执行 `fsync`/`FlushFileBuffers` → 关闭句柄 → 校验并按真实格式生成已含规范小写扩展名的 `object_key` → no-replace 原子移动到 `stores/<generation-id>/attachments/<object_key>` → 短数据库事务登记。若目标键碰撞则换键重试，绝不覆盖，也绝不另拼扩展名。
- 启动 helper 在独占维护锁下清理过期 `tmp`；对“移动完成但事务未提交”的无引用孤儿，先确认 SQLite 恢复结果及无未完成操作，再写入 `file_gc_jobs`。有引用但文件缺失只报告完整性错误。
- `file_gc_jobs` worker 按 generation、对象键和预期哈希，将对象唯一定位到 `stores/<generation-id>/attachments/<object_key>`，完成根路径复核后幂等执行；删除失败保留任务重试，在删除文件后、标记完成前崩溃也能安全重放。maintenance gate 持有期间不得消费任务。
- `logs` 只记录错误代码、版本和必要堆栈；不记录 JD/面经正文、URL 查询参数、原始导入行、API Key 或用户选择发送给 AI 的内容。
- 首版不额外加密 `app.db`。保护依赖当前 Windows 账户目录权限以及用户自行启用的磁盘加密；加密备份使用现代加密格式，禁止 ZipCrypto。

## 更新和迁移规则

1. `update.cmd` 确认应用进程已停止并创建、校验 `pre-update` 完整备份；候选代码在临时 Git worktree 构建并发布到新的 `runtime/releases/<release-id>`，不覆盖当前 release。
2. 数据库模式由仓库内版本化 Drizzle/SQL 迁移定义；把当前 generation 复制为候选后，只在候选副本执行迁移，活动 generation 不做原地变更。
3. 迁移仅向前执行，不通过临时 `push` 猜测生产模式变更；通过 `quick_check`、`foreign_key_check`、领域一致性和附件检查后，候选 generation 才可发布。
4. helper 把 previous/candidate 两对写入 activation journal 并持久化为 `PREPARED`，再原子替换唯一 `active.json`，随后记录 `ACTIVATED`；候选健康检查通过后记录 `VERIFIED/COMMITTED`。
5. 候选只在固定 `http://127.0.0.1:3210` 启动；健康检查失败时自动停止候选并原子切回 previous release-generation 对，验证成功后记录 `VERIFIED/ROLLED_BACK`。端口由非匹配实例占用时失败提示，绝不静默换端口；`VERIFIED` 前 previous 对不得清理，且不得用 Git 命令覆盖用户未提交的代码修改。
6. 完整恢复由服务停止后的固定入口 `restore.cmd` 调用独立 helper 执行：先在 `tmp/restore/<operation-id>` 中验证并构建新 generation，再以“当前 release + 新 generation”为 candidate 走同一 journal/active 指针协议，绝不由运行中的服务替换已打开数据库。`setup.cmd --repair` 只做只读诊断和引导，不代替恢复。
7. 启动 helper 对比 journal 与 active 指针：`PREPARED` 未切换时保留 previous；指针已切换或处于 `ACTIVATED` 时完成验证或回退；`VERIFIED` 幂等收尾。指针不匹配两个已验证候选时停止，不猜测最新目录。

## 后果

### 正面

- `git pull`、切换分支、删除并重新克隆仓库不会直接触碰用户数据。
- 代码版本、数据库模式版本和备份格式版本可以独立记录与验证。
- 整体备份包含附件且可迁移到新克隆，不依赖旧绝对路径。
- 单一活动指针保证 release 与 generation 成对切换；中断更新/恢复可由持久化 journal 自动完成或回退。
- 不可变附件、事务 outbox 与备份 gate 使数据库引用、物理文件和备份清单之间的竞态可恢复。
- 敏感 API Key 与业务数据、备份和日志分离。

### 代价与限制

- 卸载或删除仓库不会自动删除个人数据；操作文档必须说明数据目录和安全清除方法。
- 开发者可能误以为“新克隆”是空环境，测试时必须显式使用隔离的数据根目录覆盖值。
- 数据目录可能占用较多磁盘，需提供附件占用和备份保留情况的可见性。
- 候选及上一可用 release/generation 会短期重复占用磁盘；只有 journal 达到 `VERIFIED` 后才可按保留策略清理。
- 完整备份持有 maintenance gate 时业务写入暂时只读；UI 必须显示进度并在失败后可靠释放 gate。
- 便携 U 盘模式不属于首版；若未来需要，必须重新定义密钥、路径和更新边界。

## 被否决的方案

### 把数据放在仓库的 `data/` 并加入 `.gitignore`

否决原因：无法抵御误提交、仓库清理、重新克隆和忽略规则变更，且把代码生命周期与个人数据生命周期耦合。

### 把附件原路径写入数据库

否决原因：原文件移动、重命名或删除后引用失效，完整备份也无法自包含。

### 把附件 BLOB 全部写入 SQLite

否决原因：大文件会放大数据库、迁移和备份成本。受控文件目录配合哈希校验更易维护。

### 直接复制活动中的 `app.db`

否决原因：WAL 模式还可能存在 `-wal` 和 `-shm` 状态；漏复制或不一致复制会产生不可恢复备份。正式备份必须走一致性导出流程。

### 原地迁移数据库，失败后再从备份覆盖

否决原因：迁移和恢复失败会直接破坏当前唯一可用数据，且运行时回退可能与已升级 schema 不兼容。候选 generation 让 previous 数据始终保持可启动。

### 分别保存“当前代码”和“当前数据”指针

否决原因：两次写入之间断电会产生不兼容的 release-generation 组合。两者必须存入同一个可原子替换的 `active.json`，并由持久化 journal 处理切换前后中断。

## 验证标准

- 自动化测试把数据根目录指向测试专用 `tmp` 目录，并证明仓库目录内没有新增运行时文件。
- 更新、重新克隆和不同分支构建后，仍能读取同一用户数据目录。
- 备份恢复后，数据库校验通过，附件数量和 SHA-256 与清单一致。
- 恶意 ZIP 路径、符号链接、超限成员和伪造图片/PDF 均被拒绝且不留下半成品。
- 在 `PREPARED`、active 指针替换后和 `ACTIVATED` 注入崩溃，启动 helper 均能确定性保留/完成/回退，并且 release-generation 不会交叉配对。
- 附件在用户数据根 `tmp/uploads` 写入、no-replace 原子移动到 `stores/<generation>/attachments/<object_key>` 和数据库提交各边界崩溃时，启动清理与 `file_gc_jobs` 重放不丢失被引用对象，也不保留永久孤儿。
- 备份并发夹具证明 maintenance gate 释放前业务写、永久删除与文件 GC 均被阻塞，所得 ZIP 中数据库引用和附件清单一致。
- 日志、完整备份和 CSV 导出中不存在 Windows 凭据管理器里的秘密值。

## 官方依据

- [Microsoft：已知文件夹 `FOLDERID_LocalAppData`](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Microsoft：处理密码时使用 Windows Credential Manager](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)
- [SQLite：WAL 模式及其伴随文件](https://www.sqlite.org/wal.html)
- [SQLite：数据库完整性与外键检查 PRAGMA](https://www.sqlite.org/pragma.html)

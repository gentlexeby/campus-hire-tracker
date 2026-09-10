# 本地运行、更新与恢复

## 1. 适用范围

本文定义 Windows 本地版的操作契约，供脚本实现、测试和朋友体验时使用。当前仅承诺 Windows 桌面浏览器；源码尽量保持跨平台，但未经验证不得宣称支持 macOS、Linux 或手机完整功能。

首版不需要管理员权限、Docker、数据库服务、云账号或邮件服务。应用是本地 Node.js Web 服务，固定使用 `http://127.0.0.1:3210`，数据保存在仓库外。

> 当前实现状态以根目录 README 为准。`update.cmd`、`restore.cmd`、正式 ZIP 备份、通用附件 staging/GC 和不可变 release 切换仍是后续目标，不应因为本页定义了契约就宣称已经可用。`codex/resume-library-mvp` 当前只新增本机简历版本文件和 schema v1 → v2 前向迁移。

## 2. 前置条件

- Windows 11；若发布说明明确验证过，可支持 Windows 10。
- Git。
- Node.js 24 LTS，包含 npm。
- 当前维护版 Edge 或 Chrome。
- 能访问 GitHub 公开仓库及 npm 包来源，仅用于克隆、安装和更新。

用户不应从来历不明的 ZIP、网盘镜像或别人打包的 `node_modules` 运行。首次安装和更新都应从项目的 GitHub 公开仓库及明确分支/发布标签开始。

## 3. 仓库与用户数据分离

代码可克隆到任意普通目录，例如：

```text
D:\Projects\campus-hire-tracker
```

所有持久化用户数据固定在：

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
│   ├── app.lock
│   ├── app.pid
│   ├── releases\
│   │   └── <release-id>\
│   └── tmp\
└── tmp\
    ├── uploads\
    ├── backups\
    ├── restore\
    └── update\
```

`runtime\active.json` 是唯一活动指针，单次、可原子替换地同时指定 `releaseId` 和 `generationId`；应用不得按目录时间或最大 ID 猜测当前版本。`runtime\releases\<release-id>` 保存发布后不可原地修改的 production 运行时，至少保留当前 active、更新中的 candidate 和上一个可用版本。`stores\<generation-id>` 保存匹配的数据代际；活动 generation 的数据库接受日常业务写入，但更新和恢复不能原地迁移它。SQLite 运行时可能在活动 generation 中产生 `app.db-wal` 和 `app.db-shm`。附件对象不可变，编辑内容会创建新对象而不是覆盖原文件。`object_key` 是包含规范小写扩展名的完整相对文件名，最终位置严格为 `stores\<generation-id>\attachments\<object_key>`；读取、备份、恢复和 GC 都不得再拼接 `.<ext>`。

`runtime\activation-journal.json` 持久化更新或恢复的 previous/candidate 对以及 `PREPARED`、`ACTIVATED`、`VERIFIED` 状态；每次状态写入也通过同目录临时文件、刷盘和原子替换完成。`VERIFIED` 同时记录 `COMMITTED` 或 `ROLLED_BACK` 结果及最终 pair。每次启动都先由维护 helper 在服务外处理未完成 journal，再允许 Node Server 打开数据库。非秘密设置保存在数据库或经架构明确的配置中；API Key 存在 Windows 凭据管理器，不在此目录。

三类草稿必须分开运维：SQLite `CaptureDraft` 属于正式本地 generation，进入完整备份；M1 长文本恢复用的 `EditorRecoveryDraft` 和 M3 断连快速创建用的 `OfflineCaptureDraft` 都只在固定 origin 的浏览器 IndexedDB，均不进入完整备份、不会随 generation 恢复。Service Worker 不缓存正式资料响应。

路径规则：

- 脚本通过 Windows API/Node 获取 LocalAppData，不依赖用户手工拼接路径。
- 不允许通过环境变量把数据目录指向仓库、根目录、网络共享或符号链接位置，测试模式除外。
- 测试使用显式的临时根目录，并显示明显的 `test` 标记。
- 应用不修改父目录 ACL，不与其他 Windows 用户共享数据。
- 用户数据根的 `tmp` 与 `stores` 必须位于同一卷，供附件和候选 generation 执行 no-replace 原子移动；附件暂存只使用 `tmp\uploads`，不得放入 `runtime\tmp`、generation 或系统公共临时目录。文档、脚本和日志统一使用目录名 `tmp`，不存在另一个 `temp` 目录。

因此，`git pull`、删除仓库或重新克隆不会删除个人数据；同样，删除仓库也不等于卸载数据。

### 3.1 附件发布与崩溃清理

附件写入的操作契约固定为：用户数据根同卷 `tmp\uploads\<operation-id>` 流式写入 → 对打开句柄 flush 并执行 `fsync`/`FlushFileBuffers` → 关闭句柄 → 校验大小、SHA-256、扩展名、MIME 与内容签名 → 生成已含规范小写扩展名的完整 `object_key` → no-replace 原子移动到活动 generation 的 `stores\<generation-id>\attachments\<object_key>` → 短数据库事务登记元数据和关联。目标已存在时换新对象键，绝不覆盖；任何步骤都不得再次追加扩展名，数据库提交前不得报告成功。

默认限制为：单文件 `50 MiB`、单批 `20` 个、当前受管附件总量 `2 GiB`、图片解码 `40 MP`、PDF `500` 页。上传前后都要检查可提前判断的预算，超限时保持既有对象和数据库不变。

上述是未来通用资料附件的目标预算。当前简历版本上传只接受 PDF/DOCX，单文件上限为 10 MiB；实现会把文件读入内存校验后，用 `wx` 和随机 UUID 文件名直接写入当前 generation 的 `attachments` 目录，不包含本节描述的后台 staging/GC 流程。

启动维护 helper 在取得维护锁后执行确定性清理：过宽限期的未完成 `tmp\uploads` 可删除；已经原子移动但没有任何数据库引用、也没有未完成操作记录的对象，进入持久化 `file_gc_jobs` 队列；有数据库引用但文件缺失只报告完整性错误。永久删除业务记录时，删除关系和写 `file_gc_jobs` 必须在同一数据库事务内完成。worker 在事务提交后，以任务中的 `generation_id + object_key` 唯一定位 `stores\<generation_id>\attachments\<object_key>`，复核规范化根路径和预期哈希后幂等删除并标记任务；它不拼扩展名，也不靠 active 指针猜位置。崩溃或访问失败时保留任务重试；完整备份的 maintenance gate 持有期间 worker 必须暂停。

previous generation 是更新/恢复的完整回退副本，可能仍含已在当前 generation 永久删除的数据。默认至少保留当前 pair 与上一个已验证 pair；设置页必须分别显示旧 generation 的来源、创建时间、占用空间和对应回退能力。只有 journal 已达 `VERIFIED`、该目录不被 active/journal/未完成操作引用且已有可验证备份时，维护 helper 才能在用户明确确认后整代清理；不得逐文件对旧 generation 运行当前数据库的 GC 规则。

## 4. 必需的项目命令契约

脚本实现应调用稳定的 npm 命令，而不复制业务逻辑：

| 命令 | 语义 |
| --- | --- |
| `npm run typecheck` | TypeScript 类型检查，不写业务数据 |
| `npm run lint` | 静态检查，不自动修改文件 |
| `npm test` | 单元与集成测试，只用临时数据目录 |
| `npm run test:e2e` | Playwright 测试，只用临时应用实例 |
| `npm run build` | 生产构建，不连接用户数据库 |
| `npm run db:check` | 只读检查 schema、SQLite 完整性和领域约束 |
| `npm run db:migrate` | 只对显式指定的非活动 candidate generation 执行版本化前向迁移；活动 generation 时拒绝 |
| `npm run backup:create` | 经全局 maintenance gate 创建并验证完整备份，成功后输出备份 ID |
| `npm run start:local` | 生产模式固定监听 `http://127.0.0.1:3210` 并提供健康检查 |

实际命令行不得包含 API Key、备份密码或资料原文。

面向用户的 Windows 入口固定为：

| 入口 | 语义 |
| --- | --- |
| `setup.cmd` | 初始化或幂等修复依赖；`--repair` 仅诊断安装、目录、指针与 journal，不恢复数据 |
| `start.cmd` | 在当前可见窗口以前台方式运行应用；关闭该窗口即优雅停止 |
| `update.cmd` | 在服务停止后构建并切换候选 release-generation 对 |
| `restore.cmd` | 应用无法启动时唯一受支持的数据恢复入口；构建新 generation 并复用 activation journal 切换 |

## 5. `setup.cmd` 语义

用途：全新 clone 后的一次性初始化，也可安全地重复运行用于修复依赖。双击即可执行。

要求按顺序执行：

1. 将工作目录切换到脚本自身所在的仓库根目录，并校验预期的 `package.json`。
2. 检查 Windows、Git、Node 24 LTS 和 npm；缺失时输出下载/修复指引并退出，不自动安装系统软件。
3. 确认当前进程不是管理员权限要求场景，不修改执行策略、注册表或系统 PATH。
4. 创建并校验用户数据根目录；如果已有 `active.json`，只读识别其 release-generation 对，不覆盖。
5. 获取单实例/维护锁；应用正在运行时提示先关闭。先由启动维护 helper 处理未完成的 `activation-journal.json`，禁止迁移正在写入的数据库。
6. 使用 `npm ci` 安装 lockfile 指定依赖。lockfile 缺失或不一致时失败，禁止自动执行 `npm install` 改写依赖。
7. 在 staging 中运行生产构建和最小自检，通过后以新 ID 发布到 `runtime\releases`；不得把仓库工作树当作活动 release。
8. 全新安装在 `tmp` 中创建初始数据库/附件目录并执行全部迁移，通过检查后发布为新 generation；已有安装需要升级时，转入第 7 节的候选 generation 流程，不原地迁移。
9. 首次安装将 releaseId-generationId 对作为一个 `active.json` 原子发布；重复运行保持既有活动对。运行 `db:check` 后写入非秘密安装状态。
10. 释放维护锁，调用 `start.cmd` 经固定 origin 打开浏览器；失败时窗口保持可读并给出日志 ID。

幂等要求：重复运行不得重置数据库、删除附件、覆盖设置、重新生成示例数据或修改 Git 跟踪文件。

`setup.cmd --repair` 只能执行依赖、目录、`active.json`、journal 和只读数据库检查并生成脱敏诊断；检测到需要数据恢复时必须明确引导运行 `restore.cmd`，不得自行选择备份或切换 generation。

失败语义：依赖/构建失败发生在活动指针切换前；候选 generation 迁移失败时丢弃候选并保持原 active 对。若指针切换后失败，按 activation journal 自动切回 previous 对。脚本返回非零退出码，并保留最后可用 release、generation 与备份。

## 6. `start.cmd` 语义

用途：日常启动本地应用。

要求：

1. 定位仓库根目录，检查已完成 setup、依赖与生产构建存在。
2. 获取单实例/维护锁，在 Node Server 打开数据库前运行启动维护 helper。helper 校验 `active.json` 引用的目录和元数据，并按 activation journal 幂等处理未完成更新/恢复：`PREPARED` 且仍指向 previous 时保留旧对；指针已切到 candidate 或 journal 为 `ACTIVATED` 时继续验证，失败则原子切回 previous；`VERIFIED` 时只完成延迟清理。对写入 `PREPARED` 前遗留的 staging/candidate，只有在超过宽限期且不被 active、journal 或上一可用保留策略引用时才可清理；任何时候都不得猜测“最新”目录。
3. 校验 active release 与 generation 的 schema 兼容性。数据库比应用新时必须拒绝启动，不尝试降级。
4. 检查固定的 `http://127.0.0.1:3210`。若健康检查确认该端口是同一安装且返回的 releaseId-generationId 与 `active.json` 一致，直接打开；若由其他程序或不匹配实例占用，输出可操作提示并失败退出，绝不静默换端口。
5. 仅以 active release 启动服务，等待有超时的健康检查成功并核对安装 ID、releaseId、generationId 与 schema 后，打开固定 origin。
6. `start.cmd` 保持可见并以前台子进程托管 Node Server；用户关闭命令窗口时转发停止信号，等待停止 worker、关闭数据库并清理自身锁后退出。异常退出保留轮换日志和可复制的诊断 ID。

启动脚本不得把数据库路径、用户资料、API Key 或完整异常打印到公共终端历史。关闭命令窗口就是停止应用的用户契约；首版不得注册 Windows 服务、计划任务或开机启动项，不提供托盘常驻，也不得在窗口关闭后留下脱离控制台的后台 Node 进程。固定 origin 是 M1 `EditorRecoveryDraft` 以及 M3 Service Worker、`OfflineCaptureDraft`、通知权限和已安装 PWA 身份稳定的契约，因此端口冲突只能修复占用后重试。

## 7. `update.cmd` 语义

用途：从当前 Git 上游安全更新代码、依赖和数据库。更新不是简单的 `git pull` 包装。

### 7.1 更新前置检查

1. 定位并校验仓库根目录、`.git` 和配置的上游分支。
2. 获取维护锁并确认应用已停止。
3. 运行 `git status`。存在已跟踪修改或会被更新覆盖的未跟踪文件时拒绝继续；绝不自动 stash、删除或覆盖朋友的改动。
4. 校验 `active.json` 和 activation journal，记录 previous releaseId-generationId 对、当前提交、应用版本、schema 版本和附件清单摘要。
5. `git fetch` 后验证目标是当前上游的快进后继；拒绝强制更新、历史改写和意外 remote。
6. 在修改数据库前验证新提交的 lockfile、支持的 Node 版本和更新元数据。

### 7.2 安全更新顺序

更新先构建候选，当前 release 和当前源码 checkout 都不是试验场：

1. 创建并校验 `backups\pre-update\<版本-时间>.zip`，内容遵循完整备份协议的 `data.json`、manifest、校验值和附件，不直接复制活动数据库冒充备份。
2. 在专用临时 Git worktree 检出目标提交；在那里执行 `npm ci`、类型检查、测试门禁和生产构建。通过后将自包含产物以新 ID 发布到 `runtime\releases\<candidate-release-id>`，不覆盖 previous release。
3. 在 `tmp\update\<operation-id>` 复制当前 generation。服务已经停止，helper 先 checkpoint/关闭 SQLite，再复制数据库及不可变附件；所有复制完成并刷盘后，以新 ID 发布为候选 generation。
4. 只对候选 generation 执行版本化前向迁移；把候选库内所有未完成 `file_gc_jobs.generation_id` 重绑定为 candidate ID，并把遗留 `PROCESSING` 租约重置为可重试状态。随后运行 `quick_check`、`foreign_key_check`、领域一致性检查和附件清单/哈希抽查。失败时移除或隔离候选，`active.json` 仍指向 previous 对。
5. 把 previous/candidate 两个 releaseId-generationId 对和操作类型写入 `activation-journal.json`，对已写入的文件句柄刷盘后关闭并发布为 `PREPARED`。
6. 在 `runtime` 同目录写入并刷盘新的 pointer 文件，以 no-torn-write 的平台原子替换操作一次性更新 `active.json`，随后将 journal 持久化为 `ACTIVATED`。禁止分别切代码和数据指针。
7. 只在固定 `http://127.0.0.1:3210` 启动 candidate，健康响应必须匹配 candidate releaseId、generationId、应用/schema 版本。通过后将 journal 写为 `VERIFIED`，再选择性快进主源码 checkout。
8. journal 达到 `VERIFIED` 后才允许按保留策略清理更旧版本；previous release/generation 和本次 `pre-update` 备份不得在同次更新中删除。

### 7.3 失败与回滚

- 获取/构建失败：活动指针和 previous release/generation 均未修改，当前版本继续可用。
- 候选复制、迁移或检查失败：停止并隔离候选，活动 generation 从未被迁移，无需对其执行逆迁移。
- 指针切换后的启动或健康检查失败：停止 candidate，helper 把 `active.json` 原子切回 journal 中的 previous release-generation 对并验证旧版本，再写 `VERIFIED/ROLLED_BACK`；候选和诊断现场保留，不用备份覆盖本来完好的 previous generation。
- 进程在任一 journal 边界崩溃：下次启动的 helper 对比 `active.json` 与 previous/candidate。`PREPARED` 且 active 仍是 previous 时保持旧版本；active 已是 candidate 时按 `ACTIVATED` 继续健康验证；`ACTIVATED` 失败则回退；`VERIFIED` 仅幂等完成清理。指针既不匹配 previous 也不匹配 candidate 时停止并提示人工恢复。
- 脚本不得执行 `git reset --hard`、自动 stash 或其他可能覆盖源码改动的代码回退。数据回退与代码版本处理必须分开报告。
- 任一失败均返回非零退出码，保存脱敏错误码和诊断 ID；不得删除失败前最后一份可用备份。

禁止在脚本中使用面向宽泛目录的递归删除。临时目录必须位于已解析并验证的应用 `tmp` 或专用临时 worktree 根下，清理前再次确认绝对路径。

## 8. 自动与手动备份

### 8.1 自动备份

- 每日首次成功启动或首次持久化写入后检查是否需要自动备份。
- 完整备份必须取得全局 maintenance gate：先等待已开始的写事务和 GC 完成，从建立数据库快照起到所有清单附件复制、ZIP 刷盘和自检完成为止，阻塞新业务写入、附件发布、永久删除和 `file_gc_jobs` worker；普通只读访问可以继续。不可在复制附件前提前释放 gate。
- 备份写入 `backups\daily`，先在同卷 `tmp\backups` 生成临时文件，校验可读、条目数和 SHA-256 后 no-replace 原子移动。
- 默认保留最近 14 份每日备份；保留数量可在设置页查看和修改，并显示磁盘占用说明。
- 清理只删除超过策略且已校验存在替代备份的文件；永不删除唯一一份已知可用备份。
- 磁盘空间不足时停止创建并提示用户，不删除当前数据库或未确认的附件。

### 8.2 手动完整备份

在设置中选择“创建完整备份”，按同一 maintenance gate 契约生成符合 `IMPORT_EXPORT_SPEC.md` 的 ZIP。默认普通 ZIP 必须提示敏感风险；需要发送给朋友或跨网络传输时选择密码加密。密码无法找回且不保存。

完成后界面显示文件位置、创建时间、版本、附件数和校验结果。不能只以“文件存在”判断成功。

## 9. 恢复操作

### 9.1 应用内标准恢复

1. 在设置中选择完整备份 ZIP；输入密码仅用于当前加密包。应用只读检查 manifest、版本、成员哈希、附件数量和安全限制。
2. 预览将恢复的版本、时间、记录/附件摘要和替换范围。用户确认后，应用记录不含秘密的恢复请求并优雅停止服务，再由固定 `restore.cmd` 入口消费该内部请求；恢复不能由仍打开当前数据库的 Node Server 自行切换。
3. `restore.cmd` 调用独立维护 helper 取得维护锁，确认服务和文件 GC 已停止，再为当前 generation 生成并验证“恢复前快照”。
4. helper 在 `%LOCALAPPDATA%\CampusHireTracker\tmp\restore\<operation-id>` 恢复完整数据库和附件、应用必要迁移并执行完整性/哈希检查；通过后同卷发布为 `stores\<new-generation-id>`，不覆盖 previous generation。
5. helper 将 previous 对与“同一 releaseId + 新 generationId”的 candidate 对写入 `activation-journal.json`，持久化为 `PREPARED`。
6. helper 以一次原子替换更新 `active.json`，随后把 journal 写为 `ACTIVATED`，启动 candidate 并核对健康响应。
7. 健康检查通过后 journal 进入 `VERIFIED/COMMITTED`；失败则停止 candidate、原子切回 previous 对并验证旧版本，写入 `VERIFIED/ROLLED_BACK`。中途断电由下一次启动 helper 根据 journal 和指针完成或回退。
8. 成功或失败均显示诊断 ID 和恢复前快照位置；previous generation 至少保留到 `VERIFIED` 和用户确认恢复结果之后。

不要手工解压备份覆盖活动 `stores\<generation-id>\app.db` 或其 `attachments`，这会绕过原子指针与 journal，并可能造成两者版本不一致。

### 9.2 应用无法启动时

1. 不要删除仓库或用户数据目录，不要反复运行迁移。
2. 复制最近错误码和应用/schema 版本；不要把完整日志公开上传。
3. 运行发布版固定入口 `restore.cmd`；它必须在服务停止后执行完整校验、构建新 generation 并走 activation journal，不得原地覆盖。`setup.cmd --repair` 只可诊断并引导到这里，不能代替恢复。
4. 优先恢复最近的 `pre-update` 备份，其次使用已校验的 `daily`/`manual` 备份。
5. 恢复成功后先导出新的手动完整备份，再继续更新。

`restore.cmd --help` 必须说明备份选择、预检、确认、退出码和脱敏诊断方式；密码不得作为命令行参数。在入口落地前，不得以手工操作 SQLite 文件作为替代方案。

## 10. 卸载与清除数据

三个动作必须分开：

- 删除源码：关闭应用后删除克隆的仓库；个人数据仍保留。
- 卸载个人数据：通过应用内“清空数据”分别确认当前数据库/附件、回收站、旧 generation 和备份；此操作不可恢复。
- 删除 AI 凭据：在应用设置删除连接并验证 Windows 凭据管理器条目已移除。

不得提供一个含义不清的“全部删除”按钮同时删除代码、数据和凭据。永久清除前应建议生成加密备份，但不能强制。

## 11. GitHub 分发流程

### 11.1 仓库所有者

1. 内测期保持私有仓库，只邀请 3–5 位体验者；每人使用自己的 GitHub 账号。
2. 主分支启用必需检查；发布从通过测试的标签产生。
3. 发布说明包含：支持环境、Node 版本、schema/备份格式变化、已知问题、更新前备份提醒和回退说明。
4. 提供 Bug 与建议 Issue 模板。模板明确禁止上传数据库、备份、附件、API Key、面试通知、完整日志和含真实信息的截图。
5. 每次发布前扫描 Git 历史与构建产物，确认没有 `.env`、数据库、WAL/SHM、附件、备份、日志或真实数据。

### 11.2 体验者首次安装

推荐流程：

```text
接受私有仓库邀请
→ git clone <仓库地址>
→ 双击 setup.cmd
→ 双击 start.cmd
```

README 应提供可复制的 clone 示例，但不能包含个人访问令牌。遇到 GitHub 权限问题时使用 GitHub 官方凭据流程，不把 token 写入 remote URL 或脚本。

### 11.3 体验者更新

关闭应用后双击 `update.cmd`。不要在数据目录内运行 Git，不要手工复制新仓库覆盖旧仓库。若体验者修改了源码，更新脚本会拒绝继续；其选择是先提交/备份改动，或重新克隆到新目录，而个人数据无需搬迁。

### 11.4 反馈

提交 Issue 时仅包含：应用版本、提交 SHA、Windows/Node 版本、脱敏错误码、复现步骤和期望/实际结果。若必须提供诊断文件，应先通过应用的“预览诊断信息”检查并私下发送；默认不上传任何内容。

## 12. 常见故障处理

| 现象 | 安全检查 | 操作 |
| --- | --- | --- |
| 双击一闪而过 | 不要重复安装或删数据 | 从终端运行对应 `.cmd` 查看错误码；检查 Node 24 与日志 ID |
| 3210 端口占用 | 核对健康响应是否为同一安装及 active release-generation 对 | 匹配则打开已有实例；其他程序或不匹配实例占用时失败提示，关闭占用后重试，绝不换端口 |
| 提示数据库版本过新 | 可能用旧代码打开新数据 | 切回匹配的应用版本；禁止手工改 schema 版本 |
| 更新检测到脏工作区 | 源码有个人改动 | 提交/复制改动或另行 clone；脚本不得自动清理 |
| 更新后无法启动 | 保留 activation journal、previous 对与 pre-update 备份 | 由启动 helper 原子切回 previous release-generation 对；不要再次迁移活动 generation |
| 应用无法启动且自动回退失败 | 保留 active 指针、journal、previous 对与备份 | 运行 `restore.cmd` 预检并恢复；`setup.cmd --repair` 只用于诊断 |
| 附件无法预览 | 检查文件是否仍在受控目录及哈希 | 运行只读数据检查；从备份恢复，不从陌生来源补文件 |
| 自动备份失败 | 检查磁盘空间与权限 | 释放空间后手动创建并验证备份；不要删除唯一可用备份 |
| 忘记加密备份密码 | 密码不保存也不能恢复 | 使用其他可读备份；不要尝试绕过加密 |
| API Key 可能泄漏 | 先停止 AI 调用 | 在供应商处撤销 Key，删除本机凭据并扫描日志/导出/备份 |

## 13. 运维验收清单

发布前必须在普通 Windows 用户、全新 clone 中完成：

- [ ] `setup.cmd` 首次运行和重复运行均成功，重复运行不改用户数据。
- [ ] `start.cmd` 只监听固定 `http://127.0.0.1:3210`；同一健康实例复用，其他端口占用失败且不静默换端口；关闭窗口会优雅停止且不留下服务、托盘或后台 Node 进程。
- [ ] `restore.cmd` 可在应用无法启动时独立预检并恢复；`setup.cmd --repair` 只诊断且不会切换 generation。
- [ ] `update.cmd` 从临时 worktree 构建 candidate release，只迁移 candidate generation；构建、迁移或健康检查失败时 previous 对仍可启动。
- [ ] 在 journal `PREPARED`、active 指针替换后和 `ACTIVATED` 三处注入断电，启动 helper 均能确定性完成或回退；`VERIFIED` 前 previous 对不会被清理。
- [ ] 数据、附件、日志、release 和备份均位于 LocalAppData；仓库内无用户数据，`active.json` 始终同时指向有效 releaseId 和 generationId。
- [ ] 附件从数据根 `tmp\uploads` no-replace 发布到 `stores\<generation>\attachments\<object_key>`，默认大小/数量/解码预算、崩溃孤儿清理和 `file_gc_jobs` 精确路径重放均已验证；复制候选代际会重绑定未完成 GC 作业并重置遗留租约，完整对象键不会被再次拼扩展名，不可变对象不会被覆盖。
- [ ] 自动备份、手动普通/加密备份、成功恢复和损坏包拒绝均已验证；maintenance gate 持有期间写入、永久删除和 GC 确实受阻。
- [ ] 删除仓库后用户数据仍存在；重新 clone 可重新连接并识别兼容数据。
- [ ] GitHub Issue 模板与诊断预览不会诱导用户公开敏感信息。
- [ ] 发布说明包含版本兼容、已知限制和准确的回退步骤。

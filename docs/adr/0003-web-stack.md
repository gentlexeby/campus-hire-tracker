# ADR-0003：采用 Next.js、React、TypeScript 与本地 SQLite/libSQL

- 状态：已接受
- 日期：2026-09-08
- 决策者：产品所有者与开发者
- 关联：[ADR-0001](0001-local-first.md)、[ADR-0002](0002-user-data-outside-repo.md)

## 背景

产品需要响应式网页界面、复杂表单、看板/表格、日历、富文本、附件上传、CSV/Excel 导入、ICS 与 ZIP 导出，同时需要在本机可靠访问 SQLite 和文件系统。首版以 Windows 为明确支持平台，朋友从 GitHub 克隆后通过双击脚本初始化和启动。

技术栈必须满足：

- 本地零成本运行，不要求 Docker 或云账号；
- 前后端使用同一类型系统，减少个人项目的上下文切换；
- 服务端代码可访问本机数据库、附件和系统凭据；
- 数据库模式可以生成并执行可审阅的版本化迁移；
- 具有单元、集成与真实浏览器测试路径；
- 未来可替换外部适配器，但不以“未来上云”牺牲首版简单性。

## 决策

采用以下基线：

| 层次 | 选择 | 约束 |
| --- | --- | --- |
| Web 框架 | Next.js 16 App Router | 日常运行使用生产构建的 Node.js Server，不使用静态导出 |
| UI | React 19 | Server/Client Component 边界必须显式；交互组件才进入客户端 |
| 语言 | TypeScript | 开启严格类型检查；领域类型不依赖 React 或数据库驱动 |
| 运行时 | Node.js 24 LTS | `setup.cmd`、CI 与文档使用同一主版本；以 lockfile 固定依赖 |
| ORM/迁移 | Drizzle ORM 稳定版 + Drizzle Kit | schema-as-code；提交生成的 SQL 迁移并审阅，不在用户库执行 `push` |
| 数据库驱动 | `@libsql/client` 的本地 `file:` 连接 | 只由 Node 侧基础设施层导入；不配置远程同步 URL |
| 数据库 | 本地 SQLite/libSQL 文件 | 启用外键、WAL、事务和完整性检查 |
| 测试 | Vitest + Playwright | Vitest 覆盖领域/服务/仓储，Playwright 覆盖关键真实流程 |
| 包管理 | npm + `package-lock.json` | 初始化和更新使用 `npm ci`，禁止未锁定安装 |

Next.js 16 的最低 Node.js 要求是 20.9；选择 Node.js 24 LTS 满足支持矩阵并提供较长维护窗口。具体小版本不写死在本文中，由仓库的版本约束、lockfile 和 CI 共同固定。

## 运行方式

- `setup.cmd` 检查 Node.js 24、安装锁定依赖并创建用户数据根；production build 发布到 `runtime/releases/<release-id>`，初始数据库与附件发布到 `stores/<generation-id>`，单一 `runtime/active.json` 同时指向两者。
- `start.cmd` 先调用启动维护 helper 处理 `activation-journal.json`，再从 active release 启动 production build；生产 origin 固定为 `http://127.0.0.1:3210`。端口若被同一安装的匹配健康实例占用就直接打开，否则失败提示，绝不静默换端口。服务以前台子进程绑定到该可见窗口；关闭窗口会优雅停止 Node Server、worker 和数据库连接。首版没有 Windows 服务、托盘常驻或窗口关闭后继续运行的后台进程。
- `update.cmd` 在干净工作树和停止服务的前提下，先验证备份，再从临时 Git worktree 构建 candidate release；复制当前 generation 并只在副本迁移/检查。候选 pair 通过原子 active 指针切换，健康失败自动切回 previous release-generation 对。
- 故障恢复的固定入口是 `restore.cmd`：它在服务停止后调用独立维护 helper，在 `tmp/restore/<operation-id>` 构建并验证新 generation 后走同一个 active 指针切换协议；运行中的 Node Server 不替换自己已打开的数据库。`setup.cmd --repair` 只提供只读诊断和引导，不能代替恢复。
- 开发时可以使用 `next dev`，但真实验收必须覆盖 `next build` + `next start`；用户日常使用不得依赖开发服务器。
- 数据访问、文件读写、备份、Windows 凭据和 AI 调用必须运行在 Node runtime，Client Component 不得导入这些模块。

`active.json` 至少包含 `formatVersion`、`releaseId`、`generationId` 与激活时间，必须通过同目录写入、刷盘和平台原子替换一次更新，不能拆成两个指针。`activation-journal.json` 的每次状态写入也使用临时文件、刷盘和原子替换，持久化 previous/candidate 对与 `PREPARED`、`ACTIVATED`、`VERIFIED`；最终状态同时记录 `COMMITTED` 或 `ROLLED_BACK` 结果与已验证 pair。helper 每次启动先校验指针及目录：未切换的 `PREPARED` 保留 previous，已经切到 candidate 或 `ACTIVATED` 的操作继续健康验证或回退，`VERIFIED` 幂等收尾；不得按时间戳猜测最新 release 或 generation。

Node 文件适配器还必须实现以下持久化语义：附件对象不可变，并按“用户数据根同卷 `tmp/uploads/<operation-id>` 写入 → 对打开句柄 flush/刷盘 → 关闭句柄 → 内容校验 → 生成已含规范小写扩展名的完整 `object_key` → no-replace 原子移动到 `stores/<generation-id>/attachments/<object_key>` → 短数据库事务登记”发布；任何组件不得再拼 `.<ext>`。默认预算为单文件 `50 MiB`、单批 `20` 个、当前受管附件总量 `2 GiB`、图片解码 `40 MP`、PDF `500` 页。永久删除关系与写 `file_gc_jobs`/outbox 在同一事务，worker 提交后按 `generation_id + object_key` 精确解析上述路径、复核根目录和哈希后幂等删除，不按 active 指针猜位置。启动 helper 清理过期 `tmp/uploads`，把移动后未登记的无引用孤儿加入 GC，并把有引用但缺文件视为完整性错误。完整备份取得全局 maintenance gate，从数据库快照开始直至所有附件复制、自检完成，阻塞业务写入、永久删除和 GC，保证 JSON 引用与附件清单来自同一状态。

## 分层约束

1. **Presentation**：Next.js 路由、页面、Route Handlers/Server Functions、React 组件和输入 DTO。
2. **Application**：用例编排、事务边界、权限/来源校验、审计时间线和幂等控制。
3. **Domain**：申请状态、下一步/等待规则、事件冲突和脱敏策略；保持纯 TypeScript。
4. **Infrastructure**：Drizzle 仓储、libSQL 连接、文件存储、备份、ICS、Windows Credential Manager 和 AI Provider。

依赖只能从外向内；Domain 不得依赖 Next.js、Drizzle、libSQL 或操作系统 API。Presentation 不得直接执行 SQL 或拼接附件路径。

## 版本与迁移策略

- `package.json` 声明受支持的 Node 主版本，`package-lock.json` 固定完整依赖图。
- Next.js、React、Drizzle、libSQL 或 Node 主版本升级必须单独提交，并通过构建、迁移、备份恢复和 Playwright 冒烟测试。
- Drizzle TypeScript schema 是代码侧模式事实源；生成的 SQL 迁移必须提交仓库、人工审阅并在固定样例数据库上测试。
- 用户数据只执行已经提交的前向迁移，而且只能作用于从当前 generation 复制出的非活动候选；应用启动时若发现数据库模式比 release 更新，应拒绝启动并由 helper 回退，不做逆迁移。
- `runtime/releases` 和 `stores` 至少保留 active 与上一个已验证可用的 pair，activation journal 达到 `VERIFIED` 前禁止回收 previous。
- 不利用 libSQL 的远程连接或同步能力。未来若采用远程数据库，必须新建 ADR，因为身份、授权和一致性模型都会改变。

## PWA 边界

Next.js 支持 Web App Manifest 和 Service Worker，但本项目到里程碑 3 才启用；IndexedDB 的长文本恢复能力从 M1 即可使用：

- 同一台 Windows 电脑上的固定 `127.0.0.1` loopback origin 在 M1 保存长文本 `EditorRecoveryDraft`，在 M3 提供安装体验、缓存静态应用壳并保存断连快速创建的 `OfflineCaptureDraft`；生产环境不同时接受 `localhost` 别名。
- M3 以固定 `http://127.0.0.1:3210` 作为唯一生产 origin，确保 Service Worker scope、IndexedDB、通知权限与 PWA 安装身份稳定；端口冲突不触发 origin 漂移。
- Service Worker 不缓存数据库响应作为第二事实源，不在离线时模拟完整服务端写入。
- `EditorRecoveryDraft` 和 `OfflineCaptureDraft` 都只在 IndexedDB，不进入完整备份；SQLite `CaptureDraft` 才是经过服务端校验、进入当前 generation 和备份的正式本地草稿。三者不得共享 ID、双写或在代码/界面中混称。
- 局域网 HTTP 手机访问、Web Push 服务、后台云通知和跨设备同步不属于首版。
- 浏览器通知是尽力而为；ICS 导出仍是应用关闭后的可靠提醒路径。

## 后果

### 正面

- 一个 TypeScript 代码库覆盖 UI、用例和本地服务，适合个人维护。
- Next.js Node Server 能直接承载动态页面、写入接口和文件响应，不需要另建 API 服务。
- Drizzle schema 与生成 SQL 都可审阅，便于验证升级和恢复。
- SQLite 文件与本地附件满足单用户规模，且无需常驻外部基础设施。
- Vitest 与 Playwright 分别覆盖快速逻辑反馈和端到端使用路径。

### 代价与风险

- `@libsql/client` 包含平台相关运行部分，必须在全新 Windows x64/arm64（若宣称支持）环境实际安装验证。
- Next.js 全栈能力容易造成 UI 直接访问数据库；必须通过模块边界和 lint 规则防止层次坍塌。
- 本地 Node Server 仍是服务端进程；PWA 缓存不能让数据库在服务停止时继续工作。
- release 与 generation 并存会增加磁盘占用，原子替换和刷盘语义必须通过 Windows 故障注入测试；不能以普通覆盖写冒充原子激活。
- 技术栈升级频繁，不能使用浮动版本或在用户启动时隐式升级。

## 被否决的方案

### SvelteKit + SQLite

可以满足大部分需求，但当前没有足以抵消 React/Next.js 组件、测试和团队熟悉度优势的必要收益。若实现阶段出现确定阻塞，可用新 ADR 重新评估。

### Electron 或 Tauri

能提供更深的系统集成，但会增加打包、签名、自动更新和平台桥接工作；首版通过浏览器和启动脚本已经满足目标。

### 纯静态 React/PWA + IndexedDB

无法直接使用本机 SQLite 和受控附件目录，会让浏览器存储成为核心数据库，并削弱完整备份、迁移和大附件管理。

### Python 后端 + 独立前端

技术上可行，但引入第二运行时、跨语言契约和额外安装步骤，不符合首版降低维护面的目标。

## 验证标准

- CI 和一台全新 Windows 环境均能以锁定依赖完成构建。
- 生产启动后仅监听固定 `http://127.0.0.1:3210`，健康检查必须返回匹配的 releaseId-generationId；重复启动复用匹配实例，非匹配端口占用则失败且不改端口。
- 关闭拥有服务的 `start.cmd` 窗口会优雅停止进程并释放数据库/作业锁，随后不存在服务、托盘或脱离控制台的后台 Node 进程；`restore.cmd` 可在应用无法启动时独立执行恢复，`setup.cmd --repair` 不会切换 generation。
- 客户端 bundle 不包含数据库驱动、文件系统模块、凭据访问或 API Key。
- 迁移 SQL 可从旧 generation 副本前向升级；失败时 active 对不变，候选健康失败时 helper 原子切回 previous 对。
- 在 journal `PREPARED`、active 指针替换后和 `ACTIVATED` 三处注入中断，重启后均能确定性完成或回退，且不会形成交叉配对。
- Vitest 覆盖领域不变量和仓储事务；Playwright 覆盖“创建申请 → 安排事件 → 今日出现 → 阶段变化 → 备份恢复”。

## 官方依据

- [Next.js 16：Node.js 20.9+ 与 TypeScript 5.1+ 要求](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Next.js：Node.js Server 支持完整功能](https://nextjs.org/docs/app/getting-started/deploying)
- [Next.js：App Router](https://nextjs.org/docs/app)
- [React：React 19 为稳定版本](https://react.dev/blog/2024/12/05/react-19)
- [Node.js：v24 下载与 LTS 状态](https://nodejs.org/en/download/archive/v24)
- [Drizzle：SQLite 支持 libSQL 驱动](https://orm.drizzle.team/docs/get-started/sqlite-new)
- [Drizzle：迁移基础](https://orm.drizzle.team/docs/migrations)
- [Turso：TypeScript SDK 本地 SQLite 文件连接](https://docs.turso.tech/sdk/ts/reference)
- [Next.js：Vitest 与 Playwright 测试指南](https://nextjs.org/docs/app/guides/testing)

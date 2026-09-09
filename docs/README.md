# 开发文档索引

本目录是秋招进度板的开发事实来源。代码、测试和界面若与文档冲突，应先确认需求是否改变，再同步修改文档与实现，避免二者长期分叉。

## 推荐阅读顺序

1. [PRD.md](PRD.md)：产品目标、范围、业务规则和验收标准。
2. [GLOSSARY.md](GLOSSARY.md)：统一业务术语。
3. [UX_SPEC.md](UX_SPEC.md)：导航、页面、交互、状态和响应式行为。
4. [DATA_MODEL.md](DATA_MODEL.md)：实体、关系、约束、状态机和索引。
5. [ARCHITECTURE.md](ARCHITECTURE.md)：运行架构、分层、存储和技术约束。
6. [SECURITY_PRIVACY.md](SECURITY_PRIVACY.md)：敏感数据边界与安全要求。
7. [IMPORT_EXPORT_SPEC.md](IMPORT_EXPORT_SPEC.md)：表格导入、完整备份和 ICS 契约。
8. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：三个里程碑与任务依赖。
9. [TEST_STRATEGY.md](TEST_STRATEGY.md)：自动化测试、迁移和恢复验证。
10. [LOCAL_OPERATIONS.md](LOCAL_OPERATIONS.md)：初始化、启动、更新、备份和故障恢复。

架构决策记录：

- [ADR-0001：本地优先](adr/0001-local-first.md)
- [ADR-0002：用户数据与仓库分离](adr/0002-user-data-outside-repo.md)
- [ADR-0003：Web 技术栈](adr/0003-web-stack.md)
- [ADR-0004：版本化备份格式与认证加密](adr/0004-backup-format-and-encryption.md)

机器可读契约：

- [完整备份 `data.json` v1 JSON Schema](schemas/backup-v1.schema.json)

## 文档优先级

发生冲突时按以下顺序判断：

1. 已确认的 ADR 决定架构边界。
2. PRD 决定产品范围和业务结果。
3. 数据模型决定持久化约束。
4. UX 规格决定用户可见行为。
5. 实施计划决定交付顺序，但不能改变以上约束。

## 变更规则

- 新增核心实体、修改申请状态机或改变数据目录前，必须新增或更新 ADR。
- 改变用户可见行为时，同时更新 PRD 的验收标准和 UX 规格。
- 数据库迁移必须附带前向迁移测试、失败回滚说明和备份恢复验证。
- 导入导出格式改变时递增格式版本，并继续支持至少一个旧版本的导入。
- 文档中的“必须”代表合并前强制满足；“应”代表默认要求，偏离时需说明原因；“可以”代表可选实现。

## 当前交付边界

当前只计划本地 Windows 版本。代码可保持跨平台，但未在 CI 与真实设备验证前，不得宣称支持 macOS、Linux 或手机完整使用。未来增加服务端、多用户或云同步属于新架构阶段，不能作为简单配置开关处理。

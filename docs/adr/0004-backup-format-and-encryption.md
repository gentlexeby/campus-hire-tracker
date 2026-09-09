# ADR-0004：版本化备份格式与认证加密 envelope

- 状态：Accepted
- 日期：2026-09-08
- 决策者：项目维护者
- 关联：[导入、导出与备份协议](../IMPORT_EXPORT_SPEC.md)、[安全与隐私](../SECURITY_PRIVACY.md)

## 背景

本产品把数据库、附件和求职隐私保存在本机。备份既要能在版本间可靠恢复，也要能由实现和测试精确判断“包含了什么”。直接复制活动 SQLite 文件无法稳定覆盖 WAL 与附件的一致时点；随意的 JSON 没有兼容契约；普通 ZIP 的 CRC 或自带密码不能提供足够的完整性与机密性。

同时，密码包是用户可能长期保存的恢复凭证。算法、参数、编码或依赖若隐式变化，会让新版本无法读取旧备份。恶意输入还可利用 KDF 参数、ZIP 解压或错误差异制造资源耗尽与密码判断 oracle。

## 决策

### 1. 明文备份格式

完整备份格式 v1 是一个普通 ZIP，固定包含 `manifest.json`、符合 [backup-v1.schema.json](../schemas/backup-v1.schema.json) 的确定性 `data.json`、`checksums.json` 和 `attachments/**`。

`data.json` 是版本化 relational snapshot，保留主键、外键、软删除、时间线和可迁移的非秘密设置。附件二进制独立存放。凭据秘密、备份密码、运行时状态、派生索引、浏览器 IndexedDB 与本机备份历史不进入包。

`checksums.json` 的 SHA-256 只覆盖 `data.json` 和 `attachments/**`，不覆盖自身或 `manifest.json`。它用于发现意外损坏，不被描述为签名或抗恶意篡改机制；普通 ZIP 的 manifest 和 checksum 可以被攻击者一并替换。

### 2. 密码包 envelope v1

密码加密备份使用自描述二进制 `.chtrbak` envelope；其认证后的明文是上述 ZIP 的完整字节。v1 固定：

- magic `CHTRBAK\0`、大端 envelope version 和受限长度 JSON header；header 固定声明 `argon2id`、Argon2 version 与 `xchacha20-poly1305-ietf` 及内部 ZIP content type；
- Argon2id v1.3（`0x13`/十进制 19），16 字节随机 salt、32 字节 key，写入默认 `m=64 MiB`、`t=3`、`p=1`；
- IETF XChaCha20-Poly1305 变体（libsodium `crypto_aead_xchacha20poly1305_ietf`），24 字节随机 nonce 和 16 字节 tag；
- magic、version、header 长度和原始 header 字节全部作为 AAD；
- 解密前限制 header 与 Argon2 参数上限，认证前不解析 ZIP；
- 错误密码和任何认证失败使用同一错误，不暴露原因差异。

密码按原样编码成 UTF-8，只在操作内存中使用，不保存、记录或代用户找回。实现只使用维护中的成熟密码学依赖并锁定版本，且必须通过全新 Windows + Node.js 24 LTS 验证。

任何 KDF、Argon2 version、AEAD 变体、参数编码、AAD、header 字段或二进制布局变更都创建新的 envelope version 和新的 ADR；v1 读取行为不得随依赖升级静默变化。仓库保存固定 password/salt/nonce/header/plaintext 测试向量以约束跨依赖兼容性；真实备份不得复用测试 salt 或 nonce。

### 3. 恢复提交模型

恢复先在 `stores/<generation>` 构建并验证数据库与附件。服务停止并关闭句柄后，通过 `runtime/activation-journal.json` 记录意图，只以单文件替换更新 `runtime/active.json`。不声称能同时原子切换数据库路径和附件路径。启动恢复逻辑根据 journal 和唯一 active 指针完成提交或回到上一已验证 generation。

## 结果

收益：

- 备份内容、排序和兼容边界可由 schema、固定夹具与逐字节测试验证；
- 数据与附件以一个 generation 激活，掉电时不会猜测两个路径应如何配对；
- 加密包同时提供机密性和整体认证，参数受限避免恶意 KDF 资源消耗；
- 普通 ZIP 仍便于本地自动备份和人工检查，其信任边界被明确表达。

代价：

- 需要维护格式迁移器、确定性编码器、envelope 解析器和跨版本测试夹具；
- Argon2id 会有预期的 CPU/内存成本，旧设备上导出与恢复较慢；
- 普通 ZIP 不提供真实性，用户若需要抗恶意篡改必须选择密码包；
- 认证加密依赖必须验证 Windows 原生安装/预编译支持，不能只在开发机通过。

## 被否决的方案

- 直接复制 `app.db` 和附件目录：无法自然得到同一一致性快照，也无法提供稳定跨 schema 格式。
- 传统 ZipCrypto 或只使用 ZIP CRC：不能提供现代密码保护与可信完整性。
- AES-CBC 加独立自制 MAC：组合和编码细节更容易出错，不如成熟 AEAD。
- 只加密 `data.json`：manifest、附件名或附件内容仍可能泄漏或被替换。
- 把算法参数写死且无 envelope version：不利于安全演进，也容易造成旧包不可读。
- 同时重命名数据库与附件两个活动路径：文件系统不提供跨两个独立路径的单一原子提交。

## 验证要求

- 固定 v1 ZIP、envelope 与损坏夹具；普通 ZIP 可重复编码，密码包可跨发布解密。
- 覆盖错误密码、AAD/header/ciphertext/tag 篡改、nonce/salt 长度、KDF 上限和截断输入。
- 覆盖附件缺失/额外/哈希不符、ZIP 路径逃逸、重复成员、压缩炸弹和资源预算。
- 在每个 generation journal/active 指针边界注入进程终止或掉电等效故障，证明只能启动完整的旧或新 generation。

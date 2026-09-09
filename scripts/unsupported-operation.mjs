const operation = process.argv[2];

if (operation === "update") {
  console.error("[update] 已拒绝：内部 alpha 暂不支持安全更新。");
  console.error(
    "[update] 本次没有执行 Git、依赖、数据库、附件或运行时修改。",
  );
  console.error(
    "[update] 请保留当前版本；待完整的候选版本、备份、校验与回退协议实现后再启用更新。",
  );
  process.exitCode = 50;
} else if (operation === "restore") {
  console.error("[restore] 已拒绝：内部 alpha 暂不支持安全恢复。");
  console.error(
    "[restore] 本次没有读取、解压、覆盖或删除数据库、附件、备份及运行时文件。",
  );
  console.error(
    "[restore] 请勿手工覆盖数据目录；待完整的预检、候选 generation、校验与回退协议实现后再启用恢复。",
  );
  process.exitCode = 51;
} else {
  console.error("Unsupported operation guard was invoked incorrectly.");
  process.exitCode = 64;
}

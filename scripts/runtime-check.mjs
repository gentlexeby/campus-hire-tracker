import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function assertSupportedRuntime() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

  if (process.platform !== "win32") {
    throw new Error(
      `This internal alpha supports Windows only (detected ${process.platform}).`,
    );
  }

  if (process.arch !== "x64") {
    throw new Error(
      `This internal alpha requires 64-bit x64 Windows (detected ${process.arch}).`,
    );
  }

  if (nodeMajor !== 24) {
    throw new Error(
      `Node.js 24 is required (detected ${process.version}). Install Node.js 24 LTS and retry.`,
    );
  }
}

export function assertProjectFile(relativePath) {
  const resolved = path.resolve(projectRoot, relativePath);
  const relation = path.relative(projectRoot, resolved);

  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }

  accessSync(resolved, constants.R_OK);
  return resolved;
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

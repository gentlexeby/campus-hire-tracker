import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPORARY_PREFIX = "campus-hire-tracker-";
const DATABASE_FILENAME = "真实 file smoke.db";

function assertSafeTemporaryDirectory(directory: string) {
  const temporaryRoot = path.resolve(tmpdir());
  const resolvedDirectory = path.resolve(directory);
  const relation = path.relative(temporaryRoot, resolvedDirectory);

  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation) ||
    !path.basename(resolvedDirectory).startsWith(TEMPORARY_PREFIX)
  ) {
    throw new Error(`Refusing to clean an unsafe temporary path: ${resolvedDirectory}`);
  }
}

function runWorker(databasePath: string) {
  const workerPath = fileURLToPath(
    new URL("./db-check-worker.mjs", import.meta.url),
  );

  return new Promise<void>((resolve, reject) => {
    const worker = spawn(process.execPath, [workerPath, databasePath], {
      stdio: "inherit",
      windowsHide: true,
    });

    worker.once("error", reject);
    worker.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `The isolated database worker failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}).`,
        ),
      );
    });
  });
}

async function removeTemporaryDirectory(directory: string) {
  assertSafeTemporaryDirectory(directory);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }

  throw lastError;
}

async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      `The internal alpha database check requires Windows x64; detected ${process.platform}/${process.arch}.`,
    );
  }

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (nodeMajor !== 24) {
    throw new Error(`The database check requires Node.js 24; detected ${process.version}.`);
  }

  const workingDirectory = await mkdtemp(
    path.join(path.resolve(tmpdir()), `${TEMPORARY_PREFIX}秋招 空格-`),
  );
  const databasePath = path.join(workingDirectory, DATABASE_FILENAME);

  try {
    await runWorker(databasePath);

    const databaseFile = await stat(databasePath);
    if (!databaseFile.isFile() || databaseFile.size === 0) {
      throw new Error("The file-backed libSQL database was not created correctly.");
    }

    console.log(
      `[db:check] OK - native libSQL + Drizzle file database (${process.platform}/${process.arch}, Node ${process.versions.node}).`,
    );
  } finally {
    await removeTemporaryDirectory(workingDirectory);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[db:check] FAILED: ${message}`);
  process.exitCode = 1;
});

import { spawnSync } from "node:child_process";
import {
  assertProjectFile,
  assertSupportedRuntime,
  formatError,
  projectRoot,
} from "./runtime-check.mjs";

function runNpm(args, label) {
  console.log(`\n[setup] ${label}`);

  const commandProcessor = process.env.ComSpec || "cmd.exe";
  const result = spawnSync(
    commandProcessor,
    ["/d", "/s", "/c", "npm.cmd", ...args],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "inherit",
      windowsHide: false,
    },
  );

  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

try {
  console.log("Campus Hire Tracker - internal alpha setup");
  assertSupportedRuntime();
  assertProjectFile("package.json");
  assertProjectFile("package-lock.json");

  console.log(
    `[setup] Runtime OK: ${process.platform} ${process.arch}, Node ${process.versions.node}`,
  );

  runNpm(
    ["ci", "--include=optional", "--no-audit", "--no-fund"],
    "Installing the locked dependency tree (including native optional packages)",
  );
  runNpm(["run", "db:check"], "Running the real file-backed libSQL/Drizzle check");
  runNpm(["run", "build"], "Creating the production build");

  assertProjectFile(".next/BUILD_ID");
  console.log("\n[setup] Setup completed. Run start.cmd to launch the app.");
} catch (error) {
  console.error(`\n[setup] FAILED: ${formatError(error)}`);
  console.error("[setup] No user database or attachment directory was removed.");
  process.exitCode = 1;
}

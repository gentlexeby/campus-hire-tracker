import { spawnSync } from "node:child_process";
import net from "node:net";
import {
  assertProjectFile,
  assertSupportedRuntime,
  formatError,
  projectRoot,
} from "./runtime-check.mjs";

const HOST = "127.0.0.1";
const PORT = 3210;

function portIsOccupied() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    let settled = false;

    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };

    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

try {
  assertSupportedRuntime();
  assertProjectFile("package.json");
  assertProjectFile(".next/BUILD_ID");
  const nextCliPath = assertProjectFile("node_modules/next/dist/bin/next");

  if (await portIsOccupied()) {
    console.error(
      `[start] Port ${HOST}:${PORT} is already in use. The app was not started.`,
    );
    console.error(
      `[start] Close the process using port ${PORT}, then run start.cmd again.`,
    );
    process.exitCode = 21;
  } else {
    console.log(`[start] Starting in the foreground at http://${HOST}:${PORT}`);
    console.log("[start] Keep this window open. Closing it stops the internal alpha.");

    const result = spawnSync(
      process.execPath,
      [nextCliPath, "start", "-H", HOST, "-p", String(PORT)],
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
      throw result.error;
    }

    if (result.status !== 0) {
      if (await portIsOccupied()) {
        console.error(
          `[start] Startup failed because ${HOST}:${PORT} is occupied. No fallback port was used.`,
        );
      }
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  console.error(`[start] FAILED: ${formatError(error)}`);
  console.error("[start] If the production build is missing, run setup.cmd first.");
  process.exitCode = 1;
}

import { link, open, rm } from "node:fs/promises";

type LinkOperation = (existingPath: string, newPath: string) => Promise<void>;

/**
 * Publishes a fully written temporary file as a brand-new target.
 * It never overwrites an existing target. `contents` is used only for the
 * fail-closed Windows fallback when hard links are unavailable.
 */
export async function publishPreparedInitialFile(
  temporaryPath: string,
  targetPath: string,
  contents: string,
  linkOperation: LinkOperation = link,
): Promise<"published" | "exists"> {
  try {
    await linkOperation(temporaryPath, targetPath);
    await rm(temporaryPath, { force: true });
    return "published";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await rm(temporaryPath, { force: true });
      return "exists";
    }
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  // First install has no previous pointer to preserve. Exclusive creation means
  // this path never overwrites a concurrent winner. If the host loses power
  // during the write, strict pointer validation fails closed on the next start.
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdTarget = false;
  try {
    handle = await open(targetPath, "wx");
    createdTarget = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return "published";
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await rm(temporaryPath, { force: true });
      return "exists";
    }
    if (createdTarget) await rm(targetPath, { force: true }).catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

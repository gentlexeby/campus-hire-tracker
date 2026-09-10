import { readResumeFile, ResumeFileError } from "@/lib/resume-files";
import { getStoredResumeFileRecord } from "@/lib/services";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ versionId: string; kind: string }> };

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { ...RESPONSE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function encodedFilename(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(filename: string, inline: boolean) {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 160) || "resume-file";
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodedFilename(filename)}`;
}

export async function GET(_request: Request, context: RouteContext) {
  const { versionId, kind: rawKind } = await context.params;
  if (rawKind !== "pdf" && rawKind !== "docx") {
    return errorResponse("文件类型无效", 404);
  }

  const record = await getStoredResumeFileRecord(versionId, rawKind);
  if (!record) return errorResponse("没有找到这个简历文件", 404);

  try {
    const stored = await readResumeFile(record.relativePath);
    if (
      stored.contentType !== record.mimeType
      || stored.sizeBytes !== record.sizeBytes
      || stored.sha256 !== record.sha256
    ) {
      return errorResponse("文件与本地记录不一致，请重新上传该版本", 409);
    }

    const body = new Uint8Array(stored.bytes.byteLength);
    body.set(stored.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        ...RESPONSE_HEADERS,
        "Content-Disposition": contentDisposition(record.originalName, rawKind === "pdf"),
        "Content-Length": String(record.sizeBytes),
        "Content-Type": record.mimeType,
      },
    });
  } catch (error) {
    if (error instanceof ResumeFileError && error.code === "FILE_NOT_FOUND") {
      return errorResponse("本地文件不存在，数据库记录仍然保留", 404);
    }
    return errorResponse("暂时无法读取这个简历文件", 500);
  }
}

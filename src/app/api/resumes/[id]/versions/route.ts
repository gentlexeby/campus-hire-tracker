import { addResumeVersion } from "@/lib/services";
import {
  cleanupResumeFormFiles,
  RESUME_UPLOAD_REQUEST_MAX_BYTES,
  resumeUploadErrorCode,
  storeResumeFormFiles,
  type StoredResumeFormFiles,
} from "@/lib/resume-form-upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const LOCAL_ORIGIN = "http://127.0.0.1:3210";

type RouteContext = { params: Promise<{ id: string }> };

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectTo(resumeId: string, key: string, value = "1") {
  const url = new URL(`/resumes/${encodeURIComponent(resumeId)}`, LOCAL_ORIGIN);
  url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}

function requestIsTooLarge(request: Request) {
  const rawLength = request.headers.get("content-length");
  if (!rawLength) return false;
  const length = Number(rawLength);
  return Number.isFinite(length) && length > RESUME_UPLOAD_REQUEST_MAX_BYTES;
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (requestIsTooLarge(request)) {
    return redirectTo(id, "error", "FILE_TOO_LARGE");
  }

  let stored: StoredResumeFormFiles | null = null;
  try {
    const formData = await request.formData();
    stored = await storeResumeFormFiles(formData);
    await addResumeVersion(id, {
      sourceDocx: stored.sourceDocx,
      deliveryPdf: stored.deliveryPdf,
      changeSummary: text(formData, "changeSummary") || null,
    });
    return redirectTo(id, "versionAdded");
  } catch (error) {
    if (stored) await cleanupResumeFormFiles(stored);
    return redirectTo(id, "error", resumeUploadErrorCode(error));
  }
}

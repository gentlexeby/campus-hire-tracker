import { createResumeWithVersion } from "@/lib/services";
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

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function redirectTo(path: string, key: string, value = "1") {
  const url = new URL(path, LOCAL_ORIGIN);
  url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}

function requestIsTooLarge(request: Request) {
  const rawLength = request.headers.get("content-length");
  if (!rawLength) return false;
  const length = Number(rawLength);
  return Number.isFinite(length) && length > RESUME_UPLOAD_REQUEST_MAX_BYTES;
}

export async function POST(request: Request) {
  if (requestIsTooLarge(request)) {
    return redirectTo("/resumes", "error", "FILE_TOO_LARGE");
  }

  let stored: StoredResumeFormFiles | null = null;
  try {
    const formData = await request.formData();
    stored = await storeResumeFormFiles(formData);
    const resume = await createResumeWithVersion(
      {
        name: text(formData, "name"),
        targetDirection: text(formData, "targetDirection") || null,
        language: text(formData, "language") || null,
      },
      {
        sourceDocx: stored.sourceDocx,
        deliveryPdf: stored.deliveryPdf,
        changeSummary: text(formData, "changeSummary") || null,
      },
    );
    return redirectTo(`/resumes/${encodeURIComponent(resume.id)}`, "created");
  } catch (error) {
    if (stored) await cleanupResumeFormFiles(stored);
    return redirectTo("/resumes", "error", resumeUploadErrorCode(error));
  }
}

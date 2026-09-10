import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

function uniqueValue(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function minimalPdf(marker: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>",
    `<< /Producer (Campus Hire Tracker E2E) /Title (${marker}) >>`,
  ];
  const offsets = [0];
  let body = "%PDF-1.4\n";

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

async function createApplication(page: Page, companyName: string, positionTitle: string) {
  await page.goto("/applications/new", { waitUntil: "networkidle" });
  await page.getByLabel("公司 *").fill(companyName);
  await page.getByLabel("岗位 *").fill(positionTitle);

  await Promise.all([
    page.waitForURL(/\/applications\/[0-9a-f-]+\?created=1$/),
    page.getByRole("button", { name: "创建申请", exact: true }).click(),
  ]);
  await expect(page.getByRole("heading", { level: 1, name: positionTitle })).toBeVisible();
  return new URL(page.url()).pathname;
}

test("creates and versions a PDF resume, links it to an application, and archives it safely", async ({
  page,
  request,
}) => {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const resumeName = uniqueValue("E2E 后端校招简历");
  const targetDirection = "后端开发 / 基础架构";
  const firstFilename = `e2e-resume-${runId}-v1.pdf`;
  const secondFilename = `e2e-resume-${runId}-v2.pdf`;
  const firstPdf = minimalPdf(`resume-${runId}-v1`);
  const secondPdf = minimalPdf(`resume-${runId}-v2`);

  await page.goto("/resumes", { waitUntil: "networkidle" });
  const createForm = page.locator("form.resume-upload-form");
  await createForm.getByLabel(/^简历名称/).fill(resumeName);
  await createForm.getByLabel(/^目标方向/).fill(targetDirection);
  await createForm.getByLabel(/^语言/).fill("中文");
  await createForm.getByLabel(/^初始版本说明/).fill("E2E 初始 PDF 版本");
  await createForm.getByLabel(/^PDF 投递文件/).setInputFiles({
    name: firstFilename,
    mimeType: "application/pdf",
    buffer: firstPdf,
  });

  await Promise.all([
    page.waitForURL((url) => /^\/resumes\/[0-9a-f-]+$/.test(url.pathname) && url.searchParams.get("created") === "1"),
    createForm.getByRole("button", { name: "创建简历", exact: true }).click(),
  ]);
  const resumePath = new URL(page.url()).pathname;
  await expect(page.getByText("简历已创建，首个文件版本已安全保存在本机。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: resumeName })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "版本 1" })).toBeVisible();
  await expect(page.getByText(firstFilename, { exact: true })).toBeVisible();

  const versionForm = page.locator("form.resume-upload-form");
  await versionForm.getByLabel(/^本次改动/).fill("补充项目量化结果，生成第二版 PDF");
  await versionForm.getByLabel(/^PDF 投递文件/).setInputFiles({
    name: secondFilename,
    mimeType: "application/pdf",
    buffer: secondPdf,
  });

  await Promise.all([
    page.waitForURL((url) => url.pathname === resumePath && url.searchParams.get("versionAdded") === "1"),
    versionForm.getByRole("button", { name: "保存新版本", exact: true }).click(),
  ]);
  await expect(page.getByText("新版本已保存，旧版本仍保留在版本历史中。", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "版本 2" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "版本 1" })).toBeVisible();
  await expect(page.getByText(firstFilename, { exact: true })).toBeVisible();
  await expect(page.getByText(secondFilename, { exact: true })).toBeVisible();

  const latestVersion = page.getByRole("article").filter({ hasText: secondFilename });
  await expect(latestVersion.getByText("当前最新", { exact: true })).toBeVisible();
  const pdfLink = latestVersion.getByRole("link", { name: /^预览 v2 PDF/ });
  const pdfHref = await pdfLink.getAttribute("href");
  expect(pdfHref).toMatch(/^\/api\/resume-files\/[0-9a-f-]+\/pdf$/);

  const pdfResponse = await request.get(pdfHref!);
  expect(pdfResponse.status()).toBe(200);
  expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
  expect(pdfResponse.headers()["content-disposition"]).toMatch(/^inline;/);
  expect(pdfResponse.headers()["cache-control"]).toContain("no-store");
  expect(Buffer.compare(await pdfResponse.body(), secondPdf)).toBe(0);
  await expect(pdfLink).toHaveAttribute("target", "_blank");
  await expect(pdfLink).toHaveAttribute("rel", /\b(?:noopener|noreferrer)\b/);

  const companyName = uniqueValue("E2E 简历关联公司");
  const positionTitle = uniqueValue("E2E 简历关联岗位");
  const applicationPath = await createApplication(page, companyName, positionTitle);
  const materials = page.locator("#materials");
  const resumeVersionSelect = materials.getByLabel(/^实际投递版本/);
  await resumeVersionSelect.selectOption({
    label: `${resumeName} · V2`,
  });
  const linkedVersionId = await resumeVersionSelect.inputValue();
  expect(linkedVersionId).not.toBe("");
  await materials.getByRole("button", { name: "保存关联", exact: true }).click();
  await expect(materials.getByText("已记录这次申请使用的简历版本。", { exact: true })).toBeVisible();
  await expect(materials.getByText(secondFilename, { exact: true })).toBeVisible();
  await expect(
    page.locator("#timeline").getByText(`关联投递简历：${resumeName} · V2`, { exact: true }),
  ).toBeVisible();

  await page.goto(resumePath, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "归档简历", exact: true }).click();
  await expect(page.getByText("简历已归档，历史版本仍然保留。", { exact: true })).toBeVisible();
  await expect(page.getByText("已归档", { exact: true })).toBeVisible();
  await expect(page.getByText("归档简历保持只读。", { exact: true })).toBeVisible();
  await expect(page.locator("form.resume-upload-form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存新版本", exact: true })).toHaveCount(0);
  await expect(page.getByText(secondFilename, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复简历", exact: true })).toBeVisible();

  await page.goto(applicationPath, { waitUntil: "networkidle" });
  await expect(page.locator("#materials").getByText(secondFilename, { exact: true })).toBeVisible();
  const archivedVersionSelect = page.locator("#materials").getByLabel(/^实际投递版本/);
  await expect(archivedVersionSelect).toHaveValue(linkedVersionId);
  await expect(archivedVersionSelect.locator("option:checked")).toHaveText(`${resumeName} · V2（已归档）`);

  await page.goto(resumePath, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "恢复简历", exact: true }).click();
  await expect(page.getByText("简历已恢复。", { exact: true })).toBeVisible();
  await expect(page.getByText("正在使用", { exact: true })).toBeVisible();
  await expect(page.locator("form.resume-upload-form")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存新版本", exact: true })).toBeVisible();
});

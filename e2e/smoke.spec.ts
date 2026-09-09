import { expect, test } from "@playwright/test";

test("fixed local origin exposes health and a usable shell", async ({
  page,
  request,
}) => {
  const healthResponse = await request.get("/api/health");
  expect(healthResponse.status()).toBe(200);
  expect(healthResponse.headers()["content-type"]).toContain("application/json");

  const healthBody: unknown = await healthResponse.json();
  expect(healthBody).not.toBeNull();
  expect(typeof healthBody).toBe("object");
  expect(Array.isArray(healthBody)).toBe(false);

  const navigationResponse = await page.goto("/", {
    waitUntil: "domcontentloaded",
  });
  expect(navigationResponse?.ok()).toBe(true);
  expect(new URL(page.url()).origin).toBe("http://127.0.0.1:3210");
  await expect(page.locator("main")).toBeVisible();

  const title = await page.title();
  expect(title.trim().length).toBeGreaterThan(0);
});

test("create an application and surface its missing next step on Today", async ({
  page,
}) => {
  const companyName = `E2E 验收公司 ${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const positionTitle = "产品开发工程师";

  await page.goto("/applications/new", { waitUntil: "networkidle" });
  await page.getByLabel("公司 *").fill(companyName);
  await page.getByLabel("岗位 *").fill(positionTitle);

  await Promise.all([
    page.waitForURL(/\/applications\/[0-9a-f-]+\?created=1$/),
    page.getByRole("button", { name: "创建申请" }).click(),
  ]);

  await expect(page.getByRole("heading", { level: 1, name: positionTitle })).toBeVisible();
  await expect(page.getByText("申请已创建。现在可以设置下一步或安排事件。")).toBeVisible();

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 2, name: "缺少下一步" })).toBeVisible();
  await expect(page.getByText(companyName, { exact: true })).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";

function uniqueValue(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createApplication(page: Page, companyName: string) {
  const positionTitle = uniqueValue("草稿测试岗位");

  await page.goto("/applications/new", { waitUntil: "networkidle" });
  await page.getByLabel("公司 *").fill(companyName);
  await page.getByLabel("岗位 *").fill(positionTitle);

  await Promise.all([
    page.waitForURL(/\/applications\/[0-9a-f-]+\?created=1$/),
    page.getByRole("button", { name: "创建申请" }).click(),
  ]);

  await expect(
    page.getByRole("heading", { level: 1, name: positionTitle }),
  ).toBeVisible();
  return page.url();
}

async function waitForBrowserDraft(page: Page) {
  await expect(
    page.getByText(/^草稿已保存在此浏览器/),
  ).toBeVisible();
}

async function expectRecoveryComparison(
  page: Page,
  {
    draft,
    saved,
    count = 1,
  }: { draft: string; saved?: string; count?: number },
) {
  await expect(
    page.getByRole("heading", { name: "发现未保存内容" }),
  ).toBeVisible();
  await expect(
    page.getByText(`发现 ${count} 份未保存草稿`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/已保存版本 #\d+/)).toBeVisible();
  await expect(
    page.getByText(/未保存草稿.*基于版本 #\d+/),
  ).toHaveCount(count);
  await expect(
    page.getByRole("button", { name: "恢复这份草稿", exact: true }),
  ).toHaveCount(count);
  await expect(
    page.getByRole("button", { name: "放弃这份草稿", exact: true }),
  ).toHaveCount(count);
  await expect(page.getByText(draft, { exact: true })).toBeVisible();
  if (saved !== undefined) {
    await expect(
      page.getByRole("article").filter({ hasText: /已保存版本 #\d+/ }),
    ).toContainText(saved);
  }
}

test("restores an IndexedDB recovery draft and clears it after a durable save", async ({
  page,
}) => {
  const companyName = uniqueValue("E2E 草稿恢复公司");
  const draftNote = uniqueValue("刷新前尚未正式保存的备注");

  await createApplication(page, companyName);

  const notes = page.getByLabel("申请备注", { exact: true });
  await notes.fill(draftNote);
  await waitForBrowserDraft(page);

  await page.reload({ waitUntil: "networkidle" });
  await expectRecoveryComparison(page, { draft: draftNote });

  await page
    .getByRole("button", { name: "恢复这份草稿", exact: true })
    .click();
  await expect(notes).toHaveValue(draftNote);

  await page.getByRole("button", { name: "保存备注", exact: true }).click();
  await expect(page.getByText("备注已保存。", { exact: true })).toBeVisible();
  await expect(
    page.getByText("备注已正式保存，浏览器草稿已清除。", { exact: true }),
  ).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "发现未保存内容" }),
  ).toHaveCount(0);
  await expect(notes).toHaveValue(draftNote);
  await expect(page.getByText(companyName, { exact: true })).toBeVisible();
});

test("clears a stored recovery draft when editing returns to the SQLite value", async ({
  page,
}) => {
  const companyName = uniqueValue("E2E 草稿回退公司");
  const abandonedChange = uniqueValue("最终撤销的临时备注");

  await createApplication(page, companyName);

  const notes = page.getByLabel("申请备注", { exact: true });
  await expect(notes).toHaveValue("");
  await notes.fill(abandonedChange);
  await waitForBrowserDraft(page);

  await notes.fill("");
  await expect(
    page.getByText("内容已回到已保存版本，浏览器草稿已清除。", { exact: true }),
  ).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "发现未保存内容" }),
  ).toHaveCount(0);
  await expect(notes).toHaveValue("");
});

test("keeps drafts from different tabs isolated while resolving and saving", async ({
  context,
  page,
}) => {
  const companyName = uniqueValue("E2E 多标签草稿公司");
  const firstTabDraft = uniqueValue("第一个标签页的草稿");
  const secondTabDraft = uniqueValue("第二个标签页的草稿");

  const applicationUrl = await createApplication(page, companyName);
  const secondTab = await context.newPage();
  const comparisonPage = await context.newPage();

  try {
    await secondTab.goto(applicationUrl, { waitUntil: "networkidle" });

    await page.getByLabel("申请备注", { exact: true }).fill(firstTabDraft);
    await waitForBrowserDraft(page);
    await secondTab
      .getByLabel("申请备注", { exact: true })
      .fill(secondTabDraft);
    await waitForBrowserDraft(secondTab);

    await comparisonPage.goto(applicationUrl, { waitUntil: "networkidle" });
    await expectRecoveryComparison(comparisonPage, {
      count: 2,
      draft: firstTabDraft,
    });
    await expect(
      comparisonPage.getByText(secondTabDraft, { exact: true }),
    ).toBeVisible();
    await expect(
      comparisonPage.getByRole("button", { name: "恢复这份草稿", exact: true }),
    ).toHaveCount(2);

    const firstCandidate = comparisonPage
      .getByRole("article")
      .filter({ hasText: firstTabDraft });
    const secondCandidate = comparisonPage
      .getByRole("article")
      .filter({ hasText: secondTabDraft });
    await expect(firstCandidate).toBeVisible();
    await expect(secondCandidate).toBeVisible();

    await firstCandidate
      .getByRole("button", { name: "放弃这份草稿", exact: true })
      .click();
    await expect(
      comparisonPage.getByText("发现 1 份未保存草稿", { exact: true }),
    ).toBeVisible();
    await expect(secondCandidate).toBeVisible();
    await expect(
      comparisonPage.getByText(firstTabDraft, { exact: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "保存备注", exact: true }).click();
    await expect(page.getByText("备注已保存。", { exact: true })).toBeVisible();
    await expect(
      page.getByText("备注已正式保存；另有 1 份不同草稿待处理。", {
        exact: true,
      }),
    ).toBeVisible();

    await comparisonPage.reload({ waitUntil: "networkidle" });
    await expectRecoveryComparison(comparisonPage, {
      draft: secondTabDraft,
      saved: firstTabDraft,
    });
    await expect(
      comparisonPage
        .getByRole("alert")
        .filter({ hasText: "保存版本已变化，请比较后再决定" }),
    ).toBeVisible();
    await expect(comparisonPage.getByText(/已保存版本 #2/)).toBeVisible();
    await expect(
      comparisonPage.getByText(/未保存草稿.*基于版本 #1/),
    ).toBeVisible();

    const remainingCandidate = comparisonPage
      .getByRole("article")
      .filter({ hasText: secondTabDraft });
    await remainingCandidate
      .getByRole("button", { name: "放弃这份草稿", exact: true })
      .click();
    await expect(
      comparisonPage.getByRole("heading", { name: "发现未保存内容" }),
    ).toHaveCount(0);
    await expect(
      comparisonPage.getByLabel("申请备注", { exact: true }),
    ).toHaveValue(firstTabDraft);

    await comparisonPage.reload({ waitUntil: "networkidle" });
    await expect(
      comparisonPage.getByRole("heading", { name: "发现未保存内容" }),
    ).toHaveCount(0);
    await expect(
      comparisonPage.getByLabel("申请备注", { exact: true }),
    ).toHaveValue(firstTabDraft);
  } finally {
    await comparisonPage.close();
    await secondTab.close();
  }
});

test("keeps every source candidate when one of several drafts is recovered", async ({
  context,
  page,
}) => {
  const companyName = uniqueValue("E2E 多候选恢复公司");
  const firstDraft = uniqueValue("恢复后仍需保留的第一份草稿");
  const secondDraft = uniqueValue("不能被第一份恢复误删的第二份草稿");

  const applicationUrl = await createApplication(page, companyName);
  const secondTab = await context.newPage();
  const recoveryPage = await context.newPage();

  try {
    await secondTab.goto(applicationUrl, { waitUntil: "networkidle" });
    await page.getByLabel("申请备注", { exact: true }).fill(firstDraft);
    await waitForBrowserDraft(page);
    await secondTab.getByLabel("申请备注", { exact: true }).fill(secondDraft);
    await waitForBrowserDraft(secondTab);

    await recoveryPage.goto(applicationUrl, { waitUntil: "networkidle" });
    await expectRecoveryComparison(recoveryPage, {
      count: 2,
      draft: firstDraft,
    });
    await expect(
      recoveryPage.getByText(secondDraft, { exact: true }),
    ).toBeVisible();

    await recoveryPage
      .getByRole("article")
      .filter({ hasText: firstDraft })
      .getByRole("button", { name: "恢复这份草稿", exact: true })
      .click();
    await expect(
      recoveryPage.getByText(
        "所选内容已复制到当前编辑器；其他候选仍安全保留，请先正式保存或继续编辑。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      recoveryPage.getByLabel("申请备注", { exact: true }),
    ).toHaveValue(firstDraft);
    await expect(
      recoveryPage.getByRole("heading", { name: "发现未保存内容" }),
    ).toHaveCount(0);

    await recoveryPage.reload({ waitUntil: "networkidle" });
    await expect(
      recoveryPage.getByRole("heading", { name: "发现未保存内容" }),
    ).toBeVisible();
    await expect(
      recoveryPage.getByRole("article").filter({ hasText: firstDraft }).first(),
    ).toBeVisible();
    await expect(
      recoveryPage.getByRole("article").filter({ hasText: secondDraft }).first(),
    ).toBeVisible();
    expect(
      await recoveryPage
        .getByRole("button", { name: "恢复这份草稿", exact: true })
        .count(),
    ).toBeGreaterThanOrEqual(2);
  } finally {
    await recoveryPage.close();
    await secondTab.close();
  }
});

test("keeps a failed stale-version draft and compares it with the newer SQLite value", async ({
  context,
  page,
}) => {
  const companyName = uniqueValue("E2E 草稿冲突公司");
  const savedInFirstTab = uniqueValue("第一个标签页正式保存的备注");
  const staleDraft = uniqueValue("第二个标签页未能保存的备注");

  const applicationUrl = await createApplication(page, companyName);
  const stalePage = await context.newPage();

  try {
    await stalePage.goto(applicationUrl, { waitUntil: "networkidle" });

    const firstTabNotes = page.getByLabel("申请备注", { exact: true });
    await firstTabNotes.fill(savedInFirstTab);
    await waitForBrowserDraft(page);
    await page
      .getByRole("button", { name: "保存备注", exact: true })
      .click();
    await expect(page.getByText("备注已保存。", { exact: true })).toBeVisible();
    await expect(
      page.getByText("备注已正式保存，浏览器草稿已清除。", { exact: true }),
    ).toBeVisible();

    const staleTabNotes = stalePage.getByLabel("申请备注", { exact: true });
    await staleTabNotes.fill(staleDraft);
    await waitForBrowserDraft(stalePage);
    await stalePage
      .getByRole("button", { name: "保存备注", exact: true })
      .click();

    await expect(
      stalePage
        .getByRole("alert")
        .filter({ hasText: "这条记录已在其他页面更新，请刷新后重试" }),
    ).toBeVisible();
    await expect(staleTabNotes).toHaveValue(staleDraft);

    await stalePage.reload({ waitUntil: "networkidle" });
    await expectRecoveryComparison(stalePage, {
      draft: staleDraft,
      saved: savedInFirstTab,
    });
    await expect(
      stalePage
        .getByRole("alert")
        .filter({ hasText: "保存版本已变化，请比较后再决定" }),
    ).toBeVisible();
    await expect(stalePage.getByText(/已保存版本 #2/)).toBeVisible();
    await expect(
      stalePage.getByText(/未保存草稿.*基于版本 #1/),
    ).toBeVisible();
    await expect(stalePage.getByLabel("申请备注", { exact: true })).toHaveValue(
      savedInFirstTab,
    );
  } finally {
    await stalePage.close();
  }
});

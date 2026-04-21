import { expect, test } from "@playwright/test";

test.describe("NameForMe MVP smoke", () => {
  test("search wizard → 对话与域名两栏出现（不等待真实生成完成）", async ({ page }) => {
    await page.goto(
      `/en/search?q=${encodeURIComponent("AI note-taking app for teams")}`,
    );
    await expect(page.getByTestId("wizard-continue")).toBeVisible();
    await page.getByTestId("wizard-continue").click();
    await expect(page.getByRole("heading", { name: /Chat with AI/i })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole("heading", { name: /Available domains/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("language switch keeps path", async ({ page }) => {
    await page.goto("/en/about");
    await page.getByRole("button", { name: /切换到中文/i }).click();
    await page.waitForURL(/\/zh\/about/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("关于");
  });
});

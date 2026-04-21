import { expect, test } from "@playwright/test";

test("home scenario 博客 navigates to localized search with query", async ({ page }) => {
  await page.goto("/zh");
  await page.getByRole("link", { name: /博客/ }).click();
  await expect(page).toHaveURL(/\/zh\/search\?/);
  await expect(page.locator("textarea").first()).toBeVisible();
});

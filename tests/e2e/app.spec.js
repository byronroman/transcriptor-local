const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.browserErrors = browserErrors;
});

test.afterEach(async ({ page }) => {
  expect(page.browserErrors).toEqual([]);
});

test("loads the modular app without console errors", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusLine")).not.toContainText("Cargando estado");

  const moduleScript = page.locator('script[type="module"]');
  await expect(moduleScript).toHaveAttribute("src", /\/static\/js\/app\.js/);
  await expect(page.locator("body")).not.toContainText("legacy-app");

  await expect(page.locator("#fileInput")).toBeAttached();
  await expect(page.locator("#modelSelect")).toBeAttached();
  await expect(page.locator("#profileSelect")).toBeAttached();
  await expect(page.locator("#packageInput")).toBeAttached();
  await expect(page.locator("#themeToggleBtn")).toBeAttached();
  await expect(page.locator("#projectList")).toBeAttached();
});

test("toggles the saved theme in place", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const initialTheme = await html.getAttribute("data-theme");

  await page.locator("#themeToggleBtn").click();
  await expect(html).not.toHaveAttribute("data-theme", initialTheme || "");
  await expect(html).toHaveAttribute("data-theme", /^(dark|light)$/);
});

test("renders project navigation controls inside the app shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#projectList")).toBeAttached();

  await expect(page.locator("#resumeJobBtn")).toHaveAttribute("type", "button");
  await expect(page.locator("#cancelJobBtn")).toHaveAttribute("type", "button");
});

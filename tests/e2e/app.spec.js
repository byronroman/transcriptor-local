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
  await expect(page.locator("#audioPlaybackRate")).toBeAttached();
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
  await expect(page.locator("#returnToTopBtn")).toHaveAttribute("type", "button");
  await expect(page.locator("#returnToAudioBtn")).toHaveAttribute("type", "button");
});

test("shows a quick action to return to the project start after scrolling", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const empty = document.querySelector("#emptyState");
    const editor = document.querySelector("#editor");
    const segments = document.querySelector("#segments");
    if (empty) empty.classList.add("hidden");
    if (editor) editor.classList.remove("hidden");
    if (segments) {
      segments.innerHTML = "";
      for (let index = 0; index < 30; index += 1) {
        const segment = document.createElement("div");
        segment.className = "segment";
        segment.textContent = `Segmento ${index + 1}`;
        segment.style.minHeight = "96px";
        segments.appendChild(segment);
      }
    }
    window.state.current = { id: "e2e-scroll", status: "done", segments: [] };
  });

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("#returnToTopBtn")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.state.audioFollow)).toBe(true);
  await page.locator("#returnToTopBtn").click();
  await expect.poll(() => page.evaluate(() => window.state.audioFollow)).toBe(false);
  await expect(page.locator("#audioFollowBtn")).toContainText("Seguir");
  await expect(page.locator("#audioFollowBtn")).not.toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(260);
});

test("persists audio playback speed preference", async ({ page }) => {
  await page.goto("/");
  const speed = page.locator("#audioPlaybackRate");
  await expect(speed).toHaveValue("1");

  await speed.evaluate((select) => {
    select.value = "1.5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect(speed).toHaveValue("1.5");
  await expect.poll(async () =>
    page.evaluate(() => localStorage.getItem("transcriptor.audioPlaybackRate"))
  ).toBe("1.5");
});

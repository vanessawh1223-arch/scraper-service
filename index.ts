import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createServer, IncomingMessage, ServerResponse } from "http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractRequest {
  url: string;
  proxy?: string;
  timeout?: number;
}

interface SemrushDomainRequest {
  domain: string;
  country?: string;
  loginUrl: string;
  cardNumber: string;
  password: string;
}

interface SemrushAdsRequest {
  domain: string;
  country?: string;
  loginUrl: string;
  cardNumber: string;
  password: string;
}

interface SemrushBatchRequest {
  domains: Array<{ domain: string; country?: string }>;
  loginUrl: string;
  cardNumber: string;
  password: string;
}

interface TopKeyword {
  keyword: string;
  traffic: number;
  position: number;
}

interface AdTitle {
  text: string;
  source: "scraped";
}

interface AdDescription {
  text: string;
  source: "scraped";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function parseProxy(proxyStr: string): { server: string; username?: string; password?: string } {
  const atIdx = proxyStr.indexOf("@");
  if (atIdx === -1) return { server: `http://${proxyStr}` };
  const credentials = proxyStr.slice(0, atIdx);
  const hostPort = proxyStr.slice(atIdx + 1);
  const [username, password] = credentials.split(":");
  return { server: `http://${hostPort}`, username, password };
}

function hasTrackingParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "gclid", "fbclid", "msclkid", "ref", "affiliate_id", "clickid", "subid",
    ];
    return trackingParams.some((param) => parsed.searchParams.has(param));
  } catch { return false; }
}

function isSubdomain(domain: string): boolean {
  const parts = domain.split(".");
  if (parts.length <= 2) return false;
  if (parts[0] === "www") return parts.length > 3;
  return true;
}

function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  return parts.slice(-2).join(".");
}

function formatNumber(str: string): number {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, "").replace(/\s/g, "").trim();
  if (cleaned.endsWith("K") || cleaned.endsWith("k")) return Math.round(parseFloat(cleaned) * 1000);
  if (cleaned.endsWith("M") || cleaned.endsWith("m")) return Math.round(parseFloat(cleaned) * 1_000_000);
  if (cleaned.endsWith("B") || cleaned.endsWith("b")) return Math.round(parseFloat(cleaned) * 1_000_000_000);
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function logStep(step: string, ...args: unknown[]) {
  const ts = new Date().toISOString().substr(11, 12);
  console.log(`[${ts}] [${step}]`, ...args);
}

function isSameUrl(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    urlA.hash = "";
    urlB.hash = "";
    return urlA.href.replace(/\/+$/, "") === urlB.href.replace(/\/+$/, "");
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

function isChromeError(url: string): boolean {
  return url.startsWith("chrome-error://") || url === "about:blank";
}

// ---------------------------------------------------------------------------
// Route Bypass - ONLY for extract endpoint, NOT for SEMrush
// ---------------------------------------------------------------------------

async function setupRouteBypass(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (request.resourceType() !== "document") {
      await route.continue();
      return;
    }
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const status = response.status();
      if (status >= 300 && status < 400) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers())) {
          if (["content-length", "content-encoding", "content-type"].includes(key.toLowerCase())) continue;
          headers[key] = value;
        }
        await route.fulfill({ status, headers, body: "" });
        return;
      }
      await route.fulfill({ response });
    } catch {
      try { await route.continue(); } catch {}
    }
  });
}

// ---------------------------------------------------------------------------
// Playwright Browser Helpers
// ---------------------------------------------------------------------------

// For extract endpoint - uses route bypass
async function launchBrowser(proxy?: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--disable-blink-features=AutomationControlled",
      "--disable-features=SubresourceFilter,SafeBrowsing",
      "--disable-web-security", "--disable-extensions", "--no-first-run",
    ],
  };
  if (proxy) launchOptions.proxy = parseProxy(proxy);

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  return { browser, context };
}

// For SEMrush - NO route bypass, NO single-process (causes issues in Docker)
async function launchSemrushBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--disable-extensions",
      "--disable-background-networking", "--no-first-run",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=SubresourceFilter,SafeBrowsing",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Anti-detection only — NO route bypass
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };
  });

  return { browser, context };
}

async function closeBrowser(browser: Browser): Promise<void> {
  try { await browser.close(); } catch (err) { console.error("Error closing browser:", err); }
}

// ---------------------------------------------------------------------------
// 5-Phase Extraction Strategy (for /api/extract only)
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string
): Promise<{ success: boolean; landingPageUrl: string | null; redirectChain: string[]; finalUrl: string | null }> {
  const { browser, context } = await launchBrowser(proxyUrl);
  await setupRouteBypass(context);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };
  });

  const page = await context.newPage();
  const redirectChain: string[] = [];
  let previousUrl = affiliateLink;

  page.on("response", (response) => {
    const url = response.url();
    const request = response.request();
    if (request.resourceType() !== "document") return;
    if (request.frame() !== page.mainFrame()) return;
    if (!isSameUrl(url, previousUrl)) {
      redirectChain.push(url);
      previousUrl = url;
    }
  });

  let currentUrl: string;
  try {
    await page.goto(affiliateLink, { waitUntil: "load", timeout: 60000 });
  } catch (navError) {
    console.warn("Phase 1 navigation warning:", navError instanceof Error ? navError.message : String(navError));
  }

  currentUrl = page.url();
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    await browser.close();
    return { success: !!currentUrl, landingPageUrl: currentUrl, redirectChain, finalUrl: currentUrl };
  }

  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try {
      await page.waitForURL((url) => !isSameUrl(url.toString(), affiliateLink) && !isChromeError(url.toString()), { timeout: 20000 });
      currentUrl = page.url();
    } catch {}
  }

  try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch {}
  currentUrl = page.url();

  // Phase 4: Parse page content for redirect URLs
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    const metaRefreshUrl = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      if (meta) { const match = (meta.getAttribute("content") || "").match(/url=(.+)/i); return match ? match[1].trim() : null; }
      return null;
    });
    if (metaRefreshUrl) { try { await page.goto(metaRefreshUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {} }

    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const jsRedirectUrl = await page.evaluate(() => {
        for (const script of document.querySelectorAll("script")) {
          const text = script.textContent || "";
          const match = text.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
          if (match) return match[1];
          const match2 = text.match(/location\.replace\(['"]([^'"]+)['"]\)/);
          if (match2) return match2[1];
        }
        return null;
      });
      if (jsRedirectUrl) { try { await page.goto(jsRedirectUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {} }
    }

    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const iframeUrl = await page.evaluate(() => { const iframe = document.querySelector("iframe[src]"); return iframe ? iframe.getAttribute("src") : null; });
      if (iframeUrl && iframeUrl.startsWith("http")) { try { await page.goto(iframeUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {} }
    }
  }

  // Phase 5: Retry
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try { await page.goto(affiliateLink, { waitUntil: "networkidle", timeout: 45000 }); currentUrl = page.url(); } catch {}
  }

  const landingPageUrl = isChromeError(currentUrl) || isSameUrl(currentUrl, affiliateLink) ? null : currentUrl;
  await browser.close();
  return { success: !!landingPageUrl, landingPageUrl, redirectChain, finalUrl: landingPageUrl };
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/extract
// ---------------------------------------------------------------------------

async function handleExtract(req: Request): Promise<Response> {
  let body: ExtractRequest;
  try { body = (await req.json()) as ExtractRequest; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { url, proxy } = body;
  if (!url) return jsonResponse({ success: false, error: "URL is required" }, 400);
  try { new URL(url); } catch { return jsonResponse({ success: false, error: "Invalid URL format" }, 400); }

  try {
    const result = await extractOnce(url, proxy);
    return jsonResponse({ success: result.success, landingPageUrl: result.landingPageUrl, redirectChain: result.redirectChain, finalUrl: result.finalUrl });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("proxy") || errMsg.includes("Proxy") || errMsg.includes("ERR_PROXY_CONNECTION_FAILED"))
      return jsonResponse({ success: false, error: "Proxy connection failed", details: errMsg }, 502);
    if (errMsg.includes("Timeout") || errMsg.includes("timeout"))
      return jsonResponse({ success: false, error: "Page navigation timed out", details: errMsg }, 504);
    return jsonResponse({ success: false, error: "Extraction failed", details: errMsg }, 500);
  }
}

// ---------------------------------------------------------------------------
// SEMrush Direct Login — for users with direct SEMrush accounts
// Navigates to semrush.com/login, enters email + password, waits for dashboard
// ---------------------------------------------------------------------------

async function semrushDirectLogin(
  context: BrowserContext,
  loginUrl: string,
  cardNumber: string,
  password: string
): Promise<{ page: Page; semrushBaseUrl: string }> {
  logStep("SEMrush-DirectLogin", "Starting direct SEMrush login, loginUrl:", loginUrl);

  const page = await context.newPage();

  // Navigate to login page
  try {
    logStep("SEMrush-DirectLogin", "Navigating to login page...");
    await page.goto(loginUrl, { waitUntil: "load", timeout: 60000 });
    logStep("SEMrush-DirectLogin", "Login page loaded, URL:", page.url());
  } catch (navError) {
    logStep("SEMrush-DirectLogin", "Navigation warning:", navError instanceof Error ? navError.message : String(navError));
  }

  await page.waitForTimeout(2000);

  // Handle cookie consent if present
  try {
    const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("接受"), button:has-text("I agree"), button:has-text("同意"), #onetrust-accept-btn-handler, [id*="accept"]').first();
    if ((await cookieBtn.count()) > 0 && (await cookieBtn.isVisible().catch(() => false))) {
      await cookieBtn.click();
      logStep("SEMrush-DirectLogin", "Dismissed cookie consent");
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Check if we're already logged in (redirected to dashboard)
  const currentUrl = page.url();
  if (!currentUrl.includes("login") && !currentUrl.includes("signup")) {
    logStep("SEmrush-DirectLogin", "Already logged in, current URL:", currentUrl);
    const semrushBaseUrl = new URL(currentUrl).protocol + "//" + new URL(currentUrl).host;
    return { page, semrushBaseUrl };
  }

  // Fill email - the cardNumber field is used as email for direct login
  logStep("SEMrush-DirectLogin", "Filling email...");
  const emailSelectors = [
    'input[name="email"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="Email" i]',
    'input[id*="email" i]',
    'input[autocomplete="email"]',
    'input[type="text"]:first-of-type',
  ];

  let emailFilled = false;
  for (const selector of emailSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click();
        await el.fill('');
        await el.fill(cardNumber); // cardNumber = email for direct login
        emailFilled = true;
        logStep("SEMrush-DirectLogin", "Filled email with selector:", selector);
        break;
      }
    } catch {}
  }

  if (!emailFilled) {
    // Fallback: try any visible text input on the page
    try {
      const inputs = await page.locator('input[type="text"]:not([type="hidden"]), input:not([type])').all();
      for (const input of inputs) {
        if (await input.isVisible().catch(() => false)) {
          await input.click();
          await input.fill('');
          await input.fill(cardNumber);
          emailFilled = true;
          logStep("SEMrush-DirectLogin", "Filled email via fallback input");
          break;
        }
      }
    } catch {}
  }

  if (!emailFilled) {
    throw new Error("Could not find email input on SEMrush login page");
  }

  await page.waitForTimeout(500);

  // Fill password
  logStep("SEMrush-DirectLogin", "Filling password...");
  let passwordFilled = false;
  try {
    const pwInput = page.locator('input[type="password"]').first();
    if ((await pwInput.count()) > 0 && (await pwInput.isVisible().catch(() => false))) {
      await pwInput.click();
      await pwInput.fill('');
      await pwInput.fill(password);
      passwordFilled = true;
      logStep("SEMrush-DirectLogin", "Filled password");
    }
  } catch {}

  if (!passwordFilled) {
    // SEMrush might have a 2-step login: email first, then password on next page
    logStep("SEMrush-DirectLogin", "No password field visible - might be 2-step login, clicking continue...");

    // Click the continue/next button
    const continueBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("继续"), button:has-text("Next"), button:has-text("Log in"), button:has-text("登录")').first();
    if ((await continueBtn.count()) > 0 && (await continueBtn.isVisible().catch(() => false))) {
      await continueBtn.click();
      logStep("SEMrush-DirectLogin", "Clicked continue button");
      await page.waitForTimeout(3000);

      // Now look for password field
      try {
        const pwInput2 = page.locator('input[type="password"]').first();
        if ((await pwInput2.count()) > 0 && (await pwInput2.isVisible().catch(() => false))) {
          await pwInput2.click();
          await pwInput2.fill('');
          await pwInput2.fill(password);
          passwordFilled = true;
          logStep("SEMrush-DirectLogin", "Filled password (2-step login)");
        }
      } catch {}
    }
  }

  // Click login/submit button
  logStep("SEMrush-DirectLogin", "Clicking login button...");
  const loginBtnSelectors = [
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("登录")',
    'button:has-text("Continue")',
    'input[type="submit"]',
  ];

  let loginClicked = false;
  for (const selector of loginBtnSelectors) {
    try {
      const btn = page.locator(selector).first();
      if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click();
        loginClicked = true;
        logStep("SEMrush-DirectLogin", "Clicked login button:", selector);
        break;
      }
    } catch {}
  }

  if (!loginClicked) {
    await page.keyboard.press("Enter");
    logStep("SEMrush-DirectLogin", "Pressed Enter to submit");
  }

  // Wait for login to complete
  logStep("SEMrush-DirectLogin", "Waiting for login to complete...");
  await page.waitForTimeout(5000);

  // Wait for navigation away from login page
  try {
    await page.waitForURL(
      (url) => {
        const urlStr = url.toString();
        return !urlStr.includes("login") && !urlStr.includes("signup") && !urlStr.includes("auth");
      },
      { timeout: 30000 }
    );
  } catch {
    // May have already navigated or may need more time
    logStep("SEMrush-DirectLogin", "Login redirect timeout, checking current URL...");
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const postLoginUrl = page.url();
  logStep("SEMrush-DirectLogin", "Post-login URL:", postLoginUrl);

  // Handle any post-login popups/modals
  try {
    const closeBtn = page.locator('button:has-text("Skip"), button:has-text("关闭"), button:has-text("Close"), button[aria-label="Close"], [class*="close"], [class*="dismiss"]').first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click();
      logStep("SEMrush-DirectLogin", "Closed post-login popup");
      await page.waitForTimeout(1000);
    }
  } catch {}

  // Determine base URL
  const semrushBaseUrl = new URL(postLoginUrl).protocol + "//" + new URL(postLoginUrl).host;
  logStep("SEMrush-DirectLogin", "SEMrush base URL:", semrushBaseUrl);

  // Verify we're actually logged in by checking the page
  const pageTitle = await page.title().catch(() => "");
  if (pageTitle.includes("登录") || pageTitle.includes("Login") || pageTitle.includes("Sign in")) {
    throw new Error("Direct SEMrush login failed - still on login page. Please check your credentials.");
  }

  return { page, semrushBaseUrl };
}

// ---------------------------------------------------------------------------
// SEMrush Login Helper — Gateway proxy login flow:
// Phase 1: Gateway page (gwt.tuanai.me) → auto-redirect to proxy dashboard
// Phase 2: Proxy login page → click 账号密码 tab, fill credentials
// Phase 3: Click "打开 Semrush" → opens new tab with SEMrush content
// ---------------------------------------------------------------------------

async function semrushLogin(
  context: BrowserContext,
  loginUrl: string,
  cardNumber: string,
  password: string
): Promise<{ page: Page; semrushBaseUrl: string }> {
  // Detect if this is a direct SEMrush login or a gateway proxy login
  const isDirectLogin = loginUrl.includes("semrush.com");

  if (isDirectLogin) {
    logStep("SEMrush-Login", "Detected direct SEMrush login URL, using direct login flow");
    return semrushDirectLogin(context, loginUrl, cardNumber, password);
  }

  logStep("SEMrush-Login", "Starting gateway proxy login flow, loginUrl:", loginUrl);

  const gatewayPage = await context.newPage();
  const loginHost = new URL(loginUrl).hostname;

  // ── Phase 1: Navigate to gateway page and wait for auto-redirect ──
  try {
    logStep("SEMrush-Login", "Phase 1: Navigating to gateway...");
    await gatewayPage.goto(loginUrl, { waitUntil: "load", timeout: 60000 });
    logStep("SEMrush-Login", "Gateway loaded, URL:", gatewayPage.url());
  } catch (navError) {
    logStep("SEMrush-Login", "Gateway nav warning:", navError instanceof Error ? navError.message : String(navError));
  }

  await gatewayPage.waitForTimeout(2000);

  // Poll for redirect — the gateway auto-tests nodes and redirects after ~3s
  // But sometimes it needs a click to trigger the redirect
  let currentUrl = gatewayPage.url();
  let currentHost: string;
  try { currentHost = new URL(currentUrl).hostname; } catch { currentHost = currentUrl; }

  if (currentHost === loginHost) {
    logStep("SEMrush-Login", "Waiting for gateway auto-redirect...");
    const maxWaitMs = 30000;  // Reduced from 90s — gateway should redirect quickly or not at all
    const startTime = Date.now();
    let clickAttempted = false;

    while (Date.now() - startTime < maxWaitMs) {
      currentUrl = gatewayPage.url();
      try { currentHost = new URL(currentUrl).hostname; } catch { currentHost = currentUrl; }

      if (currentHost !== loginHost && !isChromeError(currentUrl)) {
        logStep("SEMrush-Login", "Gateway redirected to:", currentUrl);
        break;
      }

      // After 5 seconds, try clicking on node cards/buttons to trigger redirect
      if (!clickAttempted && Date.now() - startTime > 5000) {
        clickAttempted = true;
        logStep("SEMrush-Login", "Auto-redirect not happening, trying to click node...");
        try {
          // The gateway page has clickable node cards for each proxy server
          const clickable = gatewayPage.locator('.node-card, [class*="node"], a[href*="http"], [class*="card"], button').first();
          if ((await clickable.count()) > 0 && (await clickable.isVisible())) {
            await clickable.click();
            logStep("SEMrush-Login", "Clicked first node card");
            await gatewayPage.waitForTimeout(3000);
            continue;
          }
        } catch {}

        // Alternative: try clicking the "立即跳转" (redirect now) link
        try {
          const redirectLink = gatewayPage.locator('text=立即跳转, text=跳转, a:has-text("跳转")').first();
          if ((await redirectLink.count()) > 0 && (await redirectLink.isVisible())) {
            await redirectLink.click();
            logStep("SEMrush-Login", "Clicked redirect link");
            await gatewayPage.waitForTimeout(3000);
            continue;
          }
        } catch {}

        // Alternative: try clicking any visible link that leads to a different host
        try {
          const links = gatewayPage.locator('a[href]');
          const linkCount = await links.count();
          for (let i = 0; i < Math.min(linkCount, 10); i++) {
            try {
              const link = links.nth(i);
              if (await link.isVisible()) {
                const href = await link.getAttribute('href') || '';
                if (href && !href.startsWith('#') && !href.startsWith('javascript')) {
                  await link.click();
                  logStep("SEMrush-Login", `Clicked link ${i}: ${href.substring(0, 80)}`);
                  await gatewayPage.waitForTimeout(3000);
                  break;
                }
              }
            } catch {}
          }
        } catch {}
      }

      await gatewayPage.waitForTimeout(2000);
    }
  }

  if (currentHost === loginHost) {
    throw new Error(`Gateway page did not redirect. Current URL: ${currentUrl}`);
  }

  // ── Phase 2: Login to the proxy dashboard ──
  logStep("SEMrush-Login", "Phase 2: Proxy login page, URL:", currentUrl);
  await gatewayPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await gatewayPage.waitForTimeout(2000);

  // Click the 账号密码 (Account/Password) tab
  logStep("SEMrush-Login", "Clicking 账号密码 tab...");
  try {
    const accTab = gatewayPage.locator('text=账号密码, [class*="tab"]:has-text("账号"), [role="tab"]:has-text("账号")').first();
    if ((await accTab.count()) > 0 && (await accTab.isVisible())) {
      await accTab.click();
      await gatewayPage.waitForTimeout(1000);
    }
  } catch {}

  // Fill username
  const userInput = gatewayPage.locator('input[placeholder*="用户名"], input[placeholder*="账号"], input[placeholder*="account" i]').first();
  if ((await userInput.count()) > 0 && (await userInput.isVisible())) {
    await userInput.click();
    await userInput.fill('');
    await userInput.fill(cardNumber);
    logStep("SEMrush-Login", "Filled username");
  } else {
    // Fallback: try any visible text input
    const anyInput = gatewayPage.locator('input[type="text"]:not([type="hidden"])').first();
    if ((await anyInput.count()) > 0) {
      await anyInput.click();
      await anyInput.fill('');
      await anyInput.fill(cardNumber);
      logStep("SEMrush-Login", "Filled username (fallback)");
    } else {
      throw new Error("Could not find username input on proxy login page");
    }
  }

  // Fill password
  const pwInput = gatewayPage.locator('input[type="password"], input[placeholder*="密码"], input[placeholder*="password" i]').first();
  if ((await pwInput.count()) > 0 && (await pwInput.isVisible())) {
    await pwInput.click();
    await pwInput.fill('');
    await pwInput.fill(password);
    logStep("SEMrush-Login", "Filled password");
  } else {
    logStep("SEMrush-Login", "No password field visible (activation code mode)");
  }

  // Click 登录 (Login) button
  const loginBtn = gatewayPage.locator('button:has-text("登录"), button:has-text("Login"), button[type="submit"]').first();
  if ((await loginBtn.count()) > 0 && (await loginBtn.isVisible())) {
    await loginBtn.click();
    logStep("SEMrush-Login", "Clicked login button");
  } else {
    await gatewayPage.keyboard.press("Enter");
    logStep("SEMrush-Login", "Pressed Enter to submit");
  }

  // Wait for login to complete
  await gatewayPage.waitForTimeout(3000);
  await gatewayPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const postLoginTitle = await gatewayPage.title().catch(() => "");
  logStep("SEMrush-Login", "After login, title:", postLoginTitle);

  // ── Phase 3: Click "打开 Semrush" to open the SEMrush interface ──
  logStep("SEMrush-Login", "Phase 3: Clicking 打开 Semrush button...");

  // Strategy: Try opening SEMrush via new tab first; if that fails, navigate in the same page
  let semrushPage: Page | null = null;
  let semrushBaseUrl = "";

  // Approach A: Click button that opens a new tab
  const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  try {
    const openBtn = gatewayPage.locator('text=打开 Semrush, text=打开 semrush, a:has-text("Semrush"), button:has-text("Semrush"), a:has-text("semrush"), [class*="semrush"]').first();
    if ((await openBtn.count()) > 0 && (await openBtn.isVisible())) {
      await openBtn.click();
      logStep("SEMrush-Login", "Clicked 打开 Semrush");
    } else {
      throw new Error("Could not find 打开 Semrush button on proxy dashboard");
    }
  } catch (e) {
    logStep("SEMrush-Login", "打开 Semrush button error:", e instanceof Error ? e.message : String(e));
    // Try alternative: look for any link/button that opens SEMrush
    try {
      const altBtn = gatewayPage.locator('a[href*="semrush"], button:has-text("Semrush"), a[href*="analytics"], [data-semrush]').first();
      if ((await altBtn.count()) > 0) {
        await altBtn.click();
        logStep("SEMrush-Login", "Clicked alternative Semrush button");
      } else {
        // Try clicking any link that might be SEMrush-related from HTML
        const html = await gatewayPage.content();
        const hrefMatch = html.match(/href=["']([^"']*semrush[^"']*)["']/i);
        if (hrefMatch) {
          const fullUrl = hrefMatch[1].startsWith('http') ? hrefMatch[1] : new URL(hrefMatch[1], gatewayPage.url()).href;
          logStep("SEMrush-Login", "Found SEMrush href in HTML, navigating to:", fullUrl);
          await gatewayPage.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
        } else {
          throw new Error("Could not find any Semrush launch button on proxy dashboard");
        }
      }
    } catch (e2) {
      throw new Error(`Could not find any Semrush launch button: ${e2 instanceof Error ? e2.message : String(e2)}`);
    }
  }

  const newPage = await newPagePromise;
  if (newPage) {
    // Wait for the new page to load
    await newPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await newPage.waitForTimeout(2000);

    // Wait for URL to stabilize (the new tab might redirect several times)
    let stableUrl = newPage.url();
    for (let attempt = 0; attempt < 3; attempt++) {
      await newPage.waitForTimeout(1500);
      const currentUrl = newPage.url();
      if (currentUrl === stableUrl && !isChromeError(currentUrl) && currentUrl !== "about:blank") {
        break;
      }
      stableUrl = currentUrl;
    }

    logStep("SEMrush-Login", "New tab URL after stabilization:", stableUrl);

    // Check if the URL looks like a SEMrush proxy page
    const newPageHost = new URL(stableUrl).hostname;
    if (newPageHost.includes("semrush") || newPageHost.includes("taobao-seo") || stableUrl.includes("/analytics/") || stableUrl.includes("/dashboard/")) {
      semrushPage = newPage;
      semrushBaseUrl = new URL(stableUrl).protocol + "//" + new URL(stableUrl).host;
      logStep("SEMrush-Login", "Using new tab as SEMrush page, base URL:", semrushBaseUrl);
    } else {
      logStep("SEMrush-Login", "New tab URL doesn't look like SEMrush:", stableUrl);
      await newPage.close().catch(() => {});
    }
  }

  // Approach B: If new tab didn't work, try navigating in the same gateway page
  if (!semrushPage) {
    logStep("SEMrush-Login", "New tab approach failed, trying to navigate in same page...");

    // Look for SEMrush link on the dashboard
    let semrushHref = "";
    try {
      const linkEl = gatewayPage.locator('a[href*="semrush"], a[href*="analytics"]').first();
      if ((await linkEl.count()) > 0) {
        semrushHref = await linkEl.getAttribute('href') || "";
        logStep("SEMrush-Login", "Found SEMrush link href:", semrushHref);
      }
    } catch {}

    // Also try to find the link from the page HTML
    if (!semrushHref) {
      try {
        const html = await gatewayPage.content();
        const hrefMatch = html.match(/href=["']([^"']*semrush[^"']*)["']/i);
        if (hrefMatch) {
          semrushHref = hrefMatch[1];
          logStep("SEMrush-Login", "Found SEMrush href in HTML:", semrushHref);
        }
      } catch {}
    }

    if (semrushHref) {
      // Navigate the gateway page to the SEMrush URL
      const fullUrl = semrushHref.startsWith("http") ? semrushHref : new URL(semrushHref, gatewayPage.url()).href;
      logStep("SEMrush-Login", "Navigating gateway page to:", fullUrl);
      await gatewayPage.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await gatewayPage.waitForTimeout(3000);
    }

    // Use the gateway page as the SEMrush page
    semrushPage = gatewayPage;
    const currentUrl = semrushPage.url();
    semrushBaseUrl = new URL(currentUrl).protocol + "//" + new URL(currentUrl).host;
    logStep("SEMrush-Login", "Using gateway page as SEMrush page, base URL:", semrushBaseUrl);
  }

  // Verify we have a valid SEMrush base URL
  if (!semrushBaseUrl || semrushBaseUrl === "about:blank") {
    throw new Error("Could not determine SEMrush base URL after login");
  }

  logStep("SEMrush-Login", "Final SEMrush base URL:", semrushBaseUrl);

  // Close the gateway page only if we're using a different page
  if (semrushPage !== gatewayPage) {
    await gatewayPage.close().catch(() => {});
  }

  return { page: semrushPage, semrushBaseUrl };
}

// ---------------------------------------------------------------------------
// SEMrush Data Extraction Helpers
// ---------------------------------------------------------------------------

async function extractOrganicTraffic(page: Page): Promise<number> {
  let organicTraffic = 0;

  // Strategy 0: Look for the Chinese proxy accessibility link text pattern
  // Pattern: "自然流量是 117,697,336，前往自然搜索研究"
  try {
    const linkTexts = await page.evaluate(() => {
      const results: string[] = [];
      document.querySelectorAll('a, [role="link"]').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text.includes('自然流量') || text.includes('organic traffic')) {
          results.push(text);
        }
      });
      // Also check aria-label attributes
      document.querySelectorAll('[aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label') || '';
        if (label.includes('自然流量') || label.includes('organic traffic')) {
          results.push(label);
        }
      });
      return results;
    });

    for (const text of linkTexts) {
      // Match patterns like "自然流量是 117,697,336" or "自然流量 117,697,336"
      const match = text.match(/自然流量(?:是)?\s*([\d,]+\.?\d*)/);
      if (match) {
        organicTraffic = formatNumber(match[1]);
        if (organicTraffic > 0) {
          logStep("OrganicTraffic", `Found by Chinese proxy link text: ${match[1]} → ${organicTraffic}`);
          return organicTraffic;
        }
      }
    }
  } catch {}

  // Strategy 1: Comprehensive page.evaluate to find all metric values
  try {
    const pageInfo = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';

      // Find all elements that look like traffic metrics
      const allElements = document.querySelectorAll('*');
      const metricCandidates: { tag: string; text: string; className: string }[] = [];

      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        const cls = el.className || '';
        // Look for elements with traffic-related class names or data attributes
        if (
          cls.includes('traffic') || cls.includes('organic') || cls.includes('metric') ||
          cls.includes('overview') || cls.includes('summary') ||
          (el instanceof HTMLElement && el.dataset.at?.includes('traffic'))
        ) {
          metricCandidates.push({
            tag: el.tagName,
            text: text.substring(0, 200),
            className: typeof cls === 'string' ? cls.substring(0, 100) : '',
          });
        }
      }

      // Also look for any number that looks like traffic (e.g. "489.1M", "15,234")
      const numberPatterns = bodyText.match(/[\d,]+\.?\d*\s*[KMB]?/g) || [];

      return {
        title: document.title,
        url: location.href,
        bodyTextPreview: bodyText.substring(0, 1000),
        metricCandidates: metricCandidates.slice(0, 20),
        numberPatterns: numberPatterns.slice(0, 30),
      };
    });

    logStep("OrganicTraffic", `Page evaluate: title="${pageInfo.title}", url=${pageInfo.url}`);
    logStep("OrganicTraffic", `Body text (first 300): ${pageInfo.bodyTextPreview.substring(0, 300)}`);
    logStep("OrganicTraffic", `Metric candidates: ${JSON.stringify(pageInfo.metricCandidates.slice(0, 5))}`);
    logStep("OrganicTraffic", `Number patterns: ${JSON.stringify(pageInfo.numberPatterns.slice(0, 10))}`);

    // Try to extract from metric candidates
    for (const candidate of pageInfo.metricCandidates) {
      if (candidate.text.includes('organic') || candidate.text.includes('自然')) {
        const numMatch = candidate.text.match(/([\d,.]+\s*[KMB]?)/);
        if (numMatch) {
          const val = formatNumber(numMatch[1]);
          if (val > 0) {
            logStep("OrganicTraffic", `Found in metric candidate: ${numMatch[1]} → ${val}`);
            return val;
          }
        }
      }
    }
  } catch (e) {
    logStep("OrganicTraffic", "Strategy 0 (page.evaluate) failed:", e instanceof Error ? e.message : String(e));
  }

  // Strategy 1: Look for the "自然流量" (Organic Traffic) label in Chinese or English
  try {
    const organicLabel = page.locator('text=自然流量, text=Organic Traffic').first();
    if ((await organicLabel.count()) > 0) {
      // Walk up to find the number
      let parent = organicLabel;
      for (let i = 0; i < 5; i++) {
        parent = parent.locator('..');
        const text = await parent.textContent();
        if (text) {
          // Match number patterns like 489.1K, 15.2M, 1,234
          const numMatch = text.match(/([\d,.]+\s*[KMB]?)/);
          if (numMatch) {
            const val = formatNumber(numMatch[1]);
            if (val > 0) {
              organicTraffic = val;
              logStep("OrganicTraffic", `Found by label walk-up: ${numMatch[1]} → ${organicTraffic}`);
              return organicTraffic;
            }
          }
        }
      }
    }
  } catch {}

  // Strategy 2: SEMrush data-at selectors
  const organicSelectors = [
    '[data-at="organic-traffic"] .traffic-value',
    '[data-at="overview-traffic"]',
    '.overview-organic .traffic-value',
    '[data-at="organic-traffic"]',
  ];

  for (const selector of organicSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0) {
        const text = await el.textContent();
        if (text && text.trim()) {
          organicTraffic = formatNumber(text);
          if (organicTraffic > 0) {
            logStep("OrganicTraffic", `Found with selector ${selector}: ${text.trim()} → ${organicTraffic}`);
            return organicTraffic;
          }
        }
      }
    } catch { continue; }
  }

  // Strategy 3: Regex from page HTML content
  try {
    const pageContent = await page.content();
    const organicPatterns = [
      /自然流量[^]*?([\d,.]+\s*[KMB]?)/,
      /organic\s*(?:search\s*)?traffic[^]*?([\d,.]+\s*[KMB]?)/i,
      /([\d,.]+\s*[KMB]?)\s*(?:organic\s*)?(?:visits|traffic)/i,
    ];
    for (const pattern of organicPatterns) {
      const match = pageContent.match(pattern);
      if (match) {
        organicTraffic = formatNumber(match[1]);
        if (organicTraffic > 0) {
          logStep("OrganicTraffic", `Found by regex: ${match[1]} → ${organicTraffic}`);
          return organicTraffic;
        }
      }
    }
  } catch {}

  // Strategy 4: DOM evaluation for metric cards
  try {
    const metrics = await page.evaluate(() => {
      const results: { label: string; value: string }[] = [];
      const cards = document.querySelectorAll('[class*="metric"], [class*="card"], [class*="summary"], [class*="overview"]');
      cards.forEach(card => {
        const text = card.textContent || '';
        if (text.includes('自然流量') || text.includes('Organic Traffic') || text.includes('organic')) {
          const numbers = text.match(/[\d,.]+\s*[KMB]?/g);
          if (numbers && numbers.length > 0) {
            results.push({ label: text.substring(0, 50), value: numbers[0] });
          }
        }
      });
      return results;
    });
    if (metrics.length > 0) {
      organicTraffic = formatNumber(metrics[0].value);
      if (organicTraffic > 0) {
        logStep("OrganicTraffic", `Found by DOM evaluation: ${metrics[0].value} → ${organicTraffic}`);
      }
    }
  } catch {}

  // Strategy 5: Brute force - look for any large number in the page that could be traffic
  try {
    const bodyText = await page.locator('body').innerText().catch(() => "");
    // Look for patterns like "489.1M" or "15,234,567" that are typical for traffic values
    const bigNumberMatches = bodyText.match(/\b[\d,]+\.?\d*\s*[KMB]\b/g) || [];
    // Find the largest K/M/B number that's likely traffic
    for (const numStr of bigNumberMatches) {
      const val = formatNumber(numStr);
      // Traffic values for SEMrush are typically in thousands or more
      if (val >= 1000 && val > organicTraffic) {
        organicTraffic = val;
        logStep("OrganicTraffic", `Found large number (brute force): ${numStr} → ${val}`);
      }
    }
  } catch {}

  return organicTraffic;
}

async function extractPaidTraffic(page: Page): Promise<number> {
  let paidTraffic = 0;

  // Strategy 0: Look for the Chinese proxy accessibility link text pattern
  // Pattern: "付费流量是 2,745,681，前往广告研究"
  try {
    const linkTexts = await page.evaluate(() => {
      const results: string[] = [];
      document.querySelectorAll('a, [role="link"]').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text.includes('付费流量') || text.includes('paid traffic')) {
          results.push(text);
        }
      });
      document.querySelectorAll('[aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label') || '';
        if (label.includes('付费流量') || label.includes('paid traffic')) {
          results.push(label);
        }
      });
      return results;
    });

    for (const text of linkTexts) {
      const match = text.match(/付费流量(?:是)?\s*([\d,]+\.?\d*)/);
      if (match) {
        paidTraffic = formatNumber(match[1]);
        if (paidTraffic > 0) {
          logStep("PaidTraffic", `Found by Chinese proxy link text: ${match[1]} → ${paidTraffic}`);
          return paidTraffic;
        }
      }
    }
  } catch {}

  // Strategy 1: Look for "付费流量" (Paid Traffic) label
  try {
    const paidLabel = page.locator('text=付费流量, text=Paid Traffic').first();
    if ((await paidLabel.count()) > 0) {
      let parent = paidLabel;
      for (let i = 0; i < 5; i++) {
        parent = parent.locator('..');
        const text = await parent.textContent();
        if (text) {
          const numMatch = text.match(/([\d,.]+\s*[KMB]?)/);
          if (numMatch) {
            const val = formatNumber(numMatch[1]);
            if (val > 0) {
              paidTraffic = val;
              logStep("PaidTraffic", `Found by label walk-up: ${numMatch[1]} → ${paidTraffic}`);
              return paidTraffic;
            }
          }
        }
      }
    }
  } catch {}

  // Strategy 2: SEMrush data-at selectors
  const paidSelectors = [
    '[data-at="adwords-traffic"] .traffic-value',
    '[data-at="paid-traffic"]',
    '.overview-paid .traffic-value',
  ];

  for (const selector of paidSelectors) {
    try {
      const el = page.locator(selector).first();
      if ((await el.count()) > 0) {
        const text = await el.textContent();
        if (text && text.trim()) {
          paidTraffic = formatNumber(text);
          if (paidTraffic > 0) {
            logStep("PaidTraffic", `Found with selector ${selector}: ${text.trim()} → ${paidTraffic}`);
            return paidTraffic;
          }
        }
      }
    } catch { continue; }
  }

  // Strategy 3: Regex from page content
  try {
    const pageContent = await page.content();
    const paidPatterns = [
      /付费流量[^]*?([\d,.]+\s*[KMB]?)/,
      /paid\s*(?:traffic|search)[^]*?([\d,.]+\s*[KMB]?)/i,
    ];
    for (const pattern of paidPatterns) {
      const match = pageContent.match(pattern);
      if (match) {
        paidTraffic = formatNumber(match[1]);
        if (paidTraffic > 0) {
          logStep("PaidTraffic", `Found by regex: ${match[1]} → ${paidTraffic}`);
          return paidTraffic;
        }
      }
    }
  } catch {}

  return paidTraffic;
}

async function extractTopKeywords(page: Page, maxPages: number = 10): Promise<TopKeyword[]> {
  const topKeywords: TopKeyword[] = [];
  const MAX_KEYWORDS = 200; // Safety cap

  // ── Scroll down to trigger lazy loading ──
  logStep("TopKeywords", "Scrolling down to trigger lazy loading...");
  try {
    await page.evaluate(async () => {
      // Scroll down in increments to trigger any lazy-loaded content
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, 500);
        await new Promise(r => setTimeout(r, 300));
      }
      // Scroll back to top so table is visible
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);
  } catch {}

  // ── Wait for table with more selectors ──
  const tableSelectors = [
    "table",
    ".table",
    "[data-at='positions-table']",
    "[class*='Table']",
    "[class*='table']",
    "[data-test='positions-table']",
    ".data-table",
    "#positions-table",
    "[class*='list']",
    "[role='table']",
    "[class*='grid']",
    "[class*='row']",
  ];

  let tableFound = false;
  for (const selector of tableSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      logStep("TopKeywords", `Table element found with selector: ${selector}`);
      tableFound = true;
      break;
    } catch { continue; }
  }

  if (!tableFound) {
    logStep("TopKeywords", "No table element found with any selector, trying page.evaluate to find any table-like structure...");
    // Try to find ANY table-like structure via page.evaluate
    try {
      const tableInfo = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        const divTables = document.querySelectorAll('[class*="table"], [class*="Table"], [class*="grid"], [class*="Grid"], [role="table"]');
        const allRows = document.querySelectorAll('tr, [role="row"], [class*="row"], [class*="Row"]');
        return {
          tableCount: tables.length,
          divTableCount: divTables.length,
          rowCount: allRows.length,
          bodyTextPreview: document.body?.innerText?.substring(0, 500) || '',
        };
      });
      logStep("TopKeywords", `Page table scan: HTML tables=${tableInfo.tableCount}, div tables=${tableInfo.divTableCount}, rows=${tableInfo.rowCount}`);
      logStep("TopKeywords", `Body text (first 300): ${tableInfo.bodyTextPreview.substring(0, 300)}`);

      if (tableInfo.rowCount === 0 && tableInfo.tableCount === 0 && tableInfo.divTableCount === 0) {
        logStep("TopKeywords", "No table structures found at all on page, returning empty");
        return [];
      }
    } catch {}
  }

  // ── Parse table header to determine column indices ──
  // SEMrush column short codes (in table header or data-at attributes):
  //   Ph = Keyword/Phrase, Po = Position, Pp = Previous Position,
  //   Sv = Search Volume, Tr = Traffic %, Tr_ = Traffic (absolute),
  //   Ur = URL, Cp = Cost per click, Co = Competition, Nr = Number of results
  let keywordCol = 0;   // default: first column
  let positionCol = 1;  // default: second column
  let trafficCol = -1;  // -1 means not found yet

  // Try multiple header selector patterns
  const headerSelectors = [
    "table thead th",
    ".table__header th",
    "[data-at='positions-table'] th",
    "table th",
    "[role='table'] [role='columnheader']",
    "[class*='header'] [class*='cell']",
    "[class*='Header'] [class*='Cell']",
  ];

  for (const headerSelector of headerSelectors) {
    try {
      const headerCells = await page.locator(headerSelector).all();
      if (headerCells.length > 0) {
        logStep("TopKeywords", `Found ${headerCells.length} header cells with selector: ${headerSelector}`);
        for (let i = 0; i < headerCells.length; i++) {
          const headerText = (await headerCells[i].textContent())?.trim().toLowerCase() || "";
          const dataAt = await headerCells[i].getAttribute("data-at") || "";
          const ariaLabel = await headerCells[i].getAttribute("aria-label") || "";

          const allText = `${headerText} ${dataAt} ${ariaLabel}`.toLowerCase();

          if (i < 8) {
            logStep("TopKeywords", `  Header[${i}]: text="${headerText.substring(0,30)}", data-at="${dataAt}", aria="${ariaLabel.substring(0,30)}"`);
          }

          if (allText.includes("keyword") || allText.includes("phrase") || allText === "ph" || dataAt.includes("phrase") || allText.includes("关键词")) {
            keywordCol = i;
          } else if (allText.includes("position") || allText === "po" || allText.includes("pos") || dataAt.includes("position") || allText.includes("排名") || allText.includes("位置")) {
            // Make sure it's "position" not "previous position"
            if (!allText.includes("previous") && !allText.includes("prev") && !allText.includes("pp") && !allText.includes("之前")) {
              positionCol = i;
            }
          } else if (allText.includes("traffic") || allText === "tr" || dataAt.includes("traffic") || allText.includes("流量")) {
            if (!allText.includes("traffic%") && !allText.includes("traffic percent") && !allText.includes("流量%")) {
              trafficCol = i;
            }
          } else if (allText.includes("volume") || allText === "sv" || allText.includes("search volume") || dataAt.includes("volume") || allText.includes("搜索量") || allText.includes("搜索量")) {
            // Use search volume as traffic if traffic column not found
            if (trafficCol === -1) trafficCol = i;
          }
        }
        logStep("TopKeywords", `Column mapping: keyword=${keywordCol}, position=${positionCol}, traffic=${trafficCol} (from ${headerCells.length} headers via ${headerSelector})`);
        break; // Found headers, stop trying selectors
      }
    } catch { continue; }
  }

  // If we couldn't find a traffic column, try common SEMrush layouts:
  // Layout 1: Keyword(0), Position(1), Prev Position(2), Search Volume(3), Traffic%(4)
  // Layout 2: Keyword(0), Position(1), Search Volume(2), Traffic%(3)
  if (trafficCol === -1) {
    // Try to determine by examining the first row's cell count and content
    try {
      const firstRow = await page.locator("table tbody tr, .table__row, [role='row']").first();
      const cells = await firstRow.locator("td, .table__cell, [role='cell'], [role='gridcell']").all();
      if (cells.length >= 5) {
        // Likely layout 1: Keyword, Position, Prev Pos, Volume, Traffic
        trafficCol = 3; // Search Volume
        logStep("TopKeywords", `Fallback: 5+ columns detected, using col 3 (Search Volume) for traffic`);
      } else if (cells.length >= 3) {
        // Likely layout 2: Keyword, Position, Volume
        trafficCol = 2;
        logStep("TopKeywords", `Fallback: 3 columns detected, using col 2 for traffic`);
      }
    } catch {}
  }

  // If still not found, default to column 2
  if (trafficCol === -1) trafficCol = 2;

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    // Use multiple row selectors
    const rowSelectors = [
      "table tbody tr",
      ".table__row",
      "[data-at='positions-table'] tbody tr",
      "[role='row']",
      "[class*='row']",
      "table tr",
    ];

    let rows: any[] = [];
    for (const rowSelector of rowSelectors) {
      try {
        const candidateRows = await page.locator(rowSelector).all();
        if (candidateRows.length > 0) {
          rows = candidateRows;
          logStep("TopKeywords", `Page ${pageNum + 1}: Found ${rows.length} rows with selector: ${rowSelector}`);
          break;
        }
      } catch { continue; }
    }

    if (rows.length === 0) {
      logStep("TopKeywords", `Page ${pageNum + 1}: No rows found with any selector`);
      break;
    }

    let foundNonPosition1 = false;
    let pageKeywordCount = 0;
    let allKeywordsCount = 0; // Count ALL keywords found (not just position 1)

    for (let i = 0; i < rows.length; i++) {
      if (topKeywords.length >= MAX_KEYWORDS) break;
      try {
        const row = rows[i];
        // Use multiple cell selectors
        const cellSelectors = ["td, .table__cell", "td, [role='cell']", "td, [role='gridcell']", "td", ".table__cell"];
        let cells: any[] = [];
        for (const cellSelector of cellSelectors) {
          try {
            const candidateCells = await row.locator(cellSelector).all();
            if (candidateCells.length > 0) {
              cells = candidateCells;
              break;
            }
          } catch { continue; }
        }

        if (cells.length > Math.max(keywordCol, positionCol, trafficCol)) {
          const keywordText = (await cells[keywordCol].textContent())?.trim() || "";
          const positionText = (await cells[positionCol].textContent())?.trim() || "";
          const trafficText = (await cells[trafficCol].textContent())?.trim() || "";
          const position = parseInt(positionText, 10);

          // Count all keywords for debugging
          if (keywordText && !isNaN(position)) allKeywordsCount++;

          // Debug first few rows on first page — log ALL cell contents
          if (pageNum === 0 && i < 5) {
            const cellContents = await Promise.all(cells.slice(0, 6).map(async (c: any) => ((await c.textContent())?.trim() || "").substring(0, 30)));
            logStep("TopKeywords", `Row ${i} (${cells.length} cols): [${cellContents.map((c: string) => `"${c}"`).join(', ')}]`);
          }

          if (position === 1 && keywordText) {
            topKeywords.push({ keyword: keywordText, traffic: formatNumber(trafficText), position: 1 });
            pageKeywordCount++;
          } else if (position > 1) {
            foundNonPosition1 = true;
          }
        }
      } catch { continue; }
    }

    logStep("TopKeywords", `Page ${pageNum + 1}: found ${pageKeywordCount} position-1 keywords (of ${allKeywordsCount} total rows with keywords), total=${topKeywords.length}`);

    if (foundNonPosition1 || topKeywords.length >= MAX_KEYWORDS) {
      break;
    }

    // Try to click "next page" / pagination button — with more selectors
    let paginated = false;
    const paginationSelectors = [
      "[data-at='pagination-next']",
      ".pagination__next",
      "button[aria-label='Next page']",
      "a[rel='next']",
      ".pager__item--next",
      "[class*='next']",
      "[class*='Next']",
      "button:has-text('下一页')",
      "a:has-text('下一页')",
      "button:has-text('Next')",
      "a:has-text('Next')",
      "[aria-label*='next' i]",
      "[data-test*='next']",
    ];

    for (const pagSelector of paginationSelectors) {
      try {
        const nextButton = page.locator(pagSelector).first();
        const isVisible = await nextButton.isVisible().catch(() => false);
        if (isVisible) {
          await nextButton.click();
          logStep("TopKeywords", `Clicked next page with selector: ${pagSelector}`);
          await page.waitForTimeout(1500);
          // Re-scroll after pagination
          try {
            await page.evaluate(async () => {
              for (let j = 0; j < 3; j++) {
                window.scrollBy(0, 500);
                await new Promise(r => setTimeout(r, 200));
              }
              window.scrollTo(0, 0);
            });
          } catch {}
          try {
            await page.waitForSelector("table, .table, [data-at='positions-table'], [class*='Table'], [class*='table']", { timeout: 8000 });
          } catch {
            logStep("TopKeywords", "Table not found after pagination, stopping");
            paginated = false;
            break;
          }
          paginated = true;
          break;
        }
      } catch { continue; }
    }

    if (!paginated) {
      logStep("TopKeywords", "No more pages available or pagination button not found");
      break;
    }
  }

  logStep("TopKeywords", `Extracted ${topKeywords.length} position-1 keywords total`);

  // ── FALLBACK: If no keywords found with column-based parsing, try generic table extraction ──
  if (topKeywords.length === 0) {
    logStep("TopKeywords", "Column-based extraction found 0 keywords, trying generic table extraction...");
    try {
      const genericKeywords = await page.evaluate(() => {
        const results: { keyword: string; position: number; traffic: number }[] = [];
        // Find ALL tables on the page
        const tables = document.querySelectorAll('table, [role="table"]');
        for (const table of tables) {
          const rows = table.querySelectorAll('tr, [role="row"]');
          let localKeywordCol = 0;
          let localPositionCol = -1;
          let localTrafficCol = -1;

          // Parse headers
          const headers = table.querySelectorAll('th, [role="columnheader"]');
          if (headers.length > 0) {
            headers.forEach((h, i) => {
              const txt = (h.textContent || '').toLowerCase() + ' ' + (h.getAttribute('data-at') || '').toLowerCase();
              if (txt.includes('keyword') || txt.includes('phrase') || txt.includes('ph') || txt.includes('关键词')) localKeywordCol = i;
              else if ((txt.includes('position') || txt.includes('po') || txt.includes('排名') || txt.includes('位置')) && !txt.includes('prev')) localPositionCol = i;
              else if (txt.includes('volume') || txt.includes('sv') || txt.includes('搜索量') || txt.includes('traffic') || txt.includes('tr') || txt.includes('流量')) {
                if (localTrafficCol === -1) localTrafficCol = i;
              }
            });
          }

          if (localPositionCol === -1) localPositionCol = 1;
          if (localTrafficCol === -1) localTrafficCol = Math.min(2, headers.length > 0 ? headers.length - 1 : 2);

          // Parse body rows
          for (const row of rows) {
            const cells = row.querySelectorAll('td, [role="cell"], [role="gridcell"]');
            if (cells.length <= Math.max(localKeywordCol, localPositionCol)) continue;
            const kw = (cells[localKeywordCol]?.textContent || '').trim();
            const posStr = (cells[localPositionCol]?.textContent || '').trim();
            const pos = parseInt(posStr, 10);
            const trafficStr = localTrafficCol < cells.length ? (cells[localTrafficCol]?.textContent || '').trim() : '0';
            if (kw && pos === 1 && kw.length > 1 && kw.length < 200) {
              results.push({ keyword: kw, position: 1, traffic: parseInt(trafficStr.replace(/[,%]/g, ''), 10) || 0 });
            }
          }
        }
        return results;
      });

      if (genericKeywords.length > 0) {
        logStep("TopKeywords", `Generic table extraction found ${genericKeywords.length} position-1 keywords`);
        const seen = new Set(topKeywords.map(k => k.keyword.toLowerCase()));
        for (const kw of genericKeywords) {
          if (!seen.has(kw.keyword.toLowerCase()) && topKeywords.length < MAX_KEYWORDS) {
            seen.add(kw.keyword.toLowerCase());
            topKeywords.push(kw);
          }
        }
      }
    } catch (err) {
      logStep("TopKeywords", `Generic table extraction failed: ${err}`);
    }
  }

  return topKeywords;
}

/**
 * Try to extract keywords from inline <script> tags on the page.
 * Many SEMrush proxy pages embed data in script tags (e.g., __NEXT_DATA__, window.__INITIAL_STATE__, etc.)
 */
async function extractKeywordsFromScripts(page: Page): Promise<TopKeyword[]> {
  const topKeywords: TopKeyword[] = [];
  const MAX_KEYWORDS = 200;
  const seenKeywords = new Set<string>();

  logStep("TopKeywords-Scripts", "Attempting to extract keywords from inline <script> tags...");

  try {
    const scriptData = await page.evaluate(() => {
      const results: { src: string; content: string }[] = [];
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        // Only look at inline scripts (no src attribute or src is empty)
        const src = script.getAttribute('src') || '';
        const content = script.textContent || '';
        // Skip tiny scripts and known non-data scripts
        if (content.length < 50) continue;
        if (content.includes('document.createElement') && !content.includes('keyword')) continue;
        // Look for scripts that contain keyword-like data patterns
        if (
          content.includes('"Ph"') || content.includes('"Po"') ||
          content.includes('"keyword"') || content.includes('"Keyword"') ||
          content.includes('"position"') || content.includes('"Position"') ||
          content.includes('__NEXT_DATA__') || content.includes('__INITIAL_STATE__') ||
          content.includes('__NUXT__') || content.includes('window.__data') ||
          content.includes('"organic"') || content.includes('"positions"') ||
          // Chinese proxy might embed data differently
          content.includes('关键词') || content.includes('排名') || content.includes('搜索量')
        ) {
          results.push({ src, content: content.substring(0, 50000) }); // Cap at 50KB per script
        }
      }
      return results;
    });

    logStep("TopKeywords-Scripts", `Found ${scriptData.length} potentially relevant inline scripts`);

    for (const script of scriptData) {
      if (topKeywords.length >= MAX_KEYWORDS) break;

      const content = script.content;

      // Try parsing as __NEXT_DATA__ JSON
      if (content.includes('__NEXT_DATA__')) {
        try {
          const jsonMatch = content.match(/__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/) ||
                           content.match(/__NEXT_DATA__\s*=\s*({[\s\S]*})/);
          if (jsonMatch) {
            const jsonData = JSON.parse(jsonMatch[1]);
            // Deep search for keyword arrays in Next.js data
            const searchForKeywords = (obj: any, depth = 0): TopKeyword[] => {
              const found: TopKeyword[] = [];
              if (depth > 8 || !obj || typeof obj !== 'object') return found;
              if (Array.isArray(obj)) {
                for (const entry of obj) {
                  if (entry && typeof entry === 'object') {
                    const keyword = entry.Ph || entry.Keyword || entry.keyword || entry.kw || "";
                    const position = parseInt(entry.Po || entry.Position || entry.position || entry.pos || entry.rank || "0", 10);
                    const trafficRaw = entry.Sv || entry.Tr || entry.volume || entry.traffic || entry.search_volume || "0";
                    const traffic = typeof trafficRaw === 'number' ? trafficRaw : formatNumber(String(trafficRaw));
                    if (position === 1 && keyword && !seenKeywords.has(String(keyword).toLowerCase())) {
                      seenKeywords.add(String(keyword).toLowerCase());
                      found.push({ keyword: String(keyword), traffic, position: 1 });
                    }
                  }
                }
                return found;
              }
              for (const key of Object.keys(obj)) {
                found.push(...searchForKeywords(obj[key], depth + 1));
              }
              return found;
            };
            const found = searchForKeywords(jsonData);
            topKeywords.push(...found.slice(0, MAX_KEYWORDS - topKeywords.length));
            if (found.length > 0) {
              logStep("TopKeywords-Scripts", `Found ${found.length} keywords from __NEXT_DATA__`);
            }
          }
        } catch (e) {
          logStep("TopKeywords-Scripts", `Failed to parse __NEXT_DATA__: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Try parsing as __INITIAL_STATE__ or __NUXT__
      if (content.includes('__INITIAL_STATE__') || content.includes('__NUXT__') || content.includes('__data')) {
        try {
          const jsonMatch = content.match(/(?:__INITIAL_STATE__|__NUXT__|__data)\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/) ||
                           content.match(/(?:__INITIAL_STATE__|__NUXT__|__data)\s*=\s*({[\s\S]*})/);
          if (jsonMatch) {
            const jsonData = JSON.parse(jsonMatch[1]);
            const searchForKeywords = (obj: any, depth = 0): TopKeyword[] => {
              const found: TopKeyword[] = [];
              if (depth > 8 || !obj || typeof obj !== 'object') return found;
              if (Array.isArray(obj)) {
                for (const entry of obj) {
                  if (entry && typeof entry === 'object') {
                    const keyword = entry.Ph || entry.Keyword || entry.keyword || entry.kw || "";
                    const position = parseInt(entry.Po || entry.Position || entry.position || entry.pos || entry.rank || "0", 10);
                    const trafficRaw = entry.Sv || entry.Tr || entry.volume || entry.traffic || entry.search_volume || "0";
                    const traffic = typeof trafficRaw === 'number' ? trafficRaw : formatNumber(String(trafficRaw));
                    if (position === 1 && keyword && !seenKeywords.has(String(keyword).toLowerCase())) {
                      seenKeywords.add(String(keyword).toLowerCase());
                      found.push({ keyword: String(keyword), traffic, position: 1 });
                    }
                  }
                }
                return found;
              }
              for (const key of Object.keys(obj)) {
                found.push(...searchForKeywords(obj[key], depth + 1));
              }
              return found;
            };
            const found = searchForKeywords(jsonData);
            topKeywords.push(...found.slice(0, MAX_KEYWORDS - topKeywords.length));
            if (found.length > 0) {
              logStep("TopKeywords-Scripts", `Found ${found.length} keywords from initial state data`);
            }
          }
        } catch (e) {
          logStep("TopKeywords-Scripts", `Failed to parse initial state: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Try regex patterns on script content (same patterns as API extraction)
      if (topKeywords.length < MAX_KEYWORDS) {
        // Pattern: Ph/Po/Sv in any order
        const patterns = [
          /\{[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Sv"\s*:\s*([\d,.]+)[^{}]*\}/g,
          /\{[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Tr"\s*:\s*([\d,.]+)[^{}]*\}/g,
          /\{[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Sv"\s*:\s*([\d,.]+)[^{}]*\}/g,
          /\{[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Tr"\s*:\s*([\d,.]+)[^{}]*\}/g,
          /\{[^{}]*"keyword"\s*:\s*"([^"]+)"[^{}]*"position"\s*:\s*(\d+)[^{}]*"volume"\s*:\s*([\d,.]+)[^{}]*\}/gi,
          /\{[^{}]*"keyword"\s*:\s*"([^"]+)"[^{}]*"pos"\s*:\s*(\d+)[^{}]*"sv"\s*:\s*([\d,.]+)[^{}]*\}/gi,
        ];

        for (const pattern of patterns) {
          if (topKeywords.length >= MAX_KEYWORDS) break;
          let match;
          while ((match = pattern.exec(content)) !== null && topKeywords.length < MAX_KEYWORDS) {
            // For patterns 3 and 4 (Po before Ph), the capture groups are in different order
            const isPoFirst = pattern.source.startsWith('"Po"') || pattern.source.startsWith('Po');
            const keyword = isPoFirst ? match[2] : match[1];
            const position = parseInt(isPoFirst ? match[1] : match[2], 10);
            const traffic = formatNumber(match[3]);
            if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
              seenKeywords.add(keyword.toLowerCase());
              topKeywords.push({ keyword, traffic, position: 1 });
            }
          }
        }
      }
    }

    if (topKeywords.length > 0) {
      logStep("TopKeywords-Scripts", `Extracted ${topKeywords.length} position-1 keywords from inline scripts`);
    } else {
      logStep("TopKeywords-Scripts", `No keywords found in inline scripts`);
    }
  } catch (err) {
    logStep("TopKeywords-Scripts", `Script extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return topKeywords;
}

/**
 * Try to extract top keywords from captured SEMrush API responses.
 * SEMrush API typically returns keyword data with fields like:
 *   Ph = keyword phrase, Po = position, Tr = traffic (percentage), Sv = search volume
 * Also tries to parse the full API response body as a structured object.
 */
function extractKeywordsFromApiData(capturedApiData: { url: string; body: any }[]): TopKeyword[] {
  const topKeywords: TopKeyword[] = [];
  const MAX_KEYWORDS = 200;
  const seenKeywords = new Set<string>();

  // Log all captured API URLs for debugging
  logStep("TopKeywords-API", `Processing ${capturedApiData.length} captured API responses`);
  for (const apiResponse of capturedApiData) {
    logStep("TopKeywords-API", `  URL: ${apiResponse.url.substring(0, 150)} | body preview: ${JSON.stringify(apiResponse.body).substring(0, 200)}`);
  }

  // Also try ALL API responses (not just organic/positions/analytics)
  // Some proxy versions may use different URL patterns
  for (const apiResponse of capturedApiData) {
    try {
      const url = apiResponse.url;
      // Relaxed URL filter — also try responses that don't match the usual keywords
      const isRelevantUrl = url.includes('organic') || url.includes('positions') || url.includes('analytics') ||
                            url.includes('keyword') || url.includes('search') || url.includes('report');

      const body = apiResponse.body;
      const bodyStr = JSON.stringify(body);

      // ── Strategy 1: Try structured parsing of the API response ──
      // SEMrush API responses often have a top-level array or nested "data" arrays
      const tryParseEntries = (entries: any[]) => {
        for (const entry of entries) {
          if (topKeywords.length >= MAX_KEYWORDS) break;
          if (!entry || typeof entry !== 'object') continue;

          // Try many keyword field name variants
          const keyword = entry.Ph || entry.Keyword || entry.keyword || entry.keyword_phrase ||
                          entry.kw || entry.Kw || entry.query || entry.Query || entry.term || entry.search_term || "";
          const position = parseInt(entry.Po || entry.Position || entry.position || entry.pos || entry.Pos || entry.rank || entry.Rank || "0", 10);
          // Traffic can be Tr (traffic %), Sv (search volume), Tc (traffic cost), or other names
          const trafficRaw = entry.Sv || entry.Tr || entry.Tc || entry.volume || entry.traffic || entry.Traffic ||
                             entry.search_volume || entry.SearchVolume || entry.sv || entry.tr || entry.Vol || entry.vol || "0";
          const traffic = typeof trafficRaw === 'number' ? trafficRaw : formatNumber(String(trafficRaw));

          // Log every entry found for debugging (first 10 only)
          if (topKeywords.length < 10 && keyword) {
            logStep("TopKeywords-API", `  Entry: keyword="${String(keyword).substring(0,40)}", position=${position}, traffic=${traffic}, fields=${Object.keys(entry).join(',')}`);
          }

          if (position === 1 && keyword && !seenKeywords.has(String(keyword).toLowerCase())) {
            seenKeywords.add(String(keyword).toLowerCase());
            topKeywords.push({ keyword: String(keyword), traffic, position: 1 });
          }
        }
      };

      // Try if body itself is an array
      if (Array.isArray(body)) {
        tryParseEntries(body);
      }

      // Try nested data arrays — increased depth and more key names
      const tryNested = (obj: any, depth = 0) => {
        if (depth > 5 || topKeywords.length >= MAX_KEYWORDS) return;
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          tryParseEntries(obj);
          return;
        }
        for (const key of Object.keys(obj)) {
          // Look for known data container keys and any key containing arrays of objects
          if (key === 'data' || key === 'results' || key === 'rows' || key === 'items' ||
              key === 'records' || key === 'list' || key === 'entries' || key === 'keywords') {
            if (Array.isArray(obj[key])) {
              tryParseEntries(obj[key]);
            }
          }
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            tryNested(obj[key], depth + 1);
          }
        }
      };

      if (typeof body === 'object' && !Array.isArray(body)) {
        tryNested(body);
      }

      if (topKeywords.length >= MAX_KEYWORDS) break;

      // ── Strategy 2: Regex-based parsing for stringified API responses ──
      // Pattern 1: Ph/Po/Sv (most common in SEMrush API - Sv = search volume)
      // Allow fields in ANY order within the JSON object
      const makeFlexiblePattern = (kwField: string, posField: string, volField: string) =>
        new RegExp(`\\{[^{}]*"${kwField}"\\s*:\\s*"([^"]+)"[^{}]*"${posField}"\\s*:\\s*(\\d+)[^{}]*"${volField}"\\s*:\\s*([\\d,.]+)[^{}]*\\}`, 'g');

      // Try Ph/Po/Sv in original order
      let match;
      const svPattern1 = makeFlexiblePattern('Ph', 'Po', 'Sv');
      while ((match = svPattern1.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1], position = parseInt(match[2], 10), traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 2: Ph/Po/Tr (Tr = traffic percentage)
      const trPattern1 = makeFlexiblePattern('Ph', 'Po', 'Tr');
      while ((match = trPattern1.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1], position = parseInt(match[2], 10), traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 3: lowercase "keyword"/"position"/"volume" fields
      const lcPattern = /\{[^{}]*"keyword"\s*:\s*"([^"]+)"[^{}]*"position"\s*:\s*(\d+)[^{}]*"volume"\s*:\s*([\d,.]+)[^{}]*\}/gi;
      while ((match = lcPattern.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1], position = parseInt(match[2], 10), traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 4: lowercase "keyword"/"pos"/"sv" fields
      const lcPattern2 = /\{[^{}]*"keyword"\s*:\s*"([^"]+)"[^{}]*"pos"\s*:\s*(\d+)[^{}]*"sv"\s*:\s*([\d,.]+)[^{}]*\}/gi;
      while ((match = lcPattern2.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1], position = parseInt(match[2], 10), traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 5: Very relaxed — just find any object with a "Ph" field that also has a "Po" field
      // This catches cases where the field order is unusual
      const relaxedPattern = /\{[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*\}[^{}]*\{[^{}]*"Po"\s*:\s*(\d+)[^{}]*\}/g;
      // Skip this pattern if we already found keywords — it's too loose

      // Pattern 6: "Ph" and "Po" in any order within the same object — flexible regex
      const flexPhPo = /\{"[^"]*"\s*:\s*"[^"]*"(?:,"[^"]*"\s*:\s*[^,}]+)*"Ph"\s*:\s*"([^"]+)"(?:,"[^"]*"\s*:\s*[^,}]+)*"Po"\s*:\s*(\d+)/g;
      while ((match = flexPhPo.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1], position = parseInt(match[2], 10);
        // Try to find Sv or Tr in the same object
        const fullObj = match[0];
        const svMatch = fullObj.match(/"Sv"\s*:\s*([\d,.]+)/);
        const trMatch = fullObj.match(/"Tr"\s*:\s*([\d,.]+)/);
        const traffic = svMatch ? formatNumber(svMatch[1]) : trMatch ? formatNumber(trMatch[1]) : 0;
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 7: Po comes BEFORE Ph in the JSON object
      const poPhPattern = /\{[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Sv"\s*:\s*([\d,.]+)[^{}]*\}/g;
      while ((match = poPhPattern.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const position = parseInt(match[1], 10), keyword = match[2], traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Pattern 8: Po comes before Ph, with Tr instead of Sv
      const poPhTrPattern = /\{[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Tr"\s*:\s*([\d,.]+)[^{}]*\}/g;
      while ((match = poPhTrPattern.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const position = parseInt(match[1], 10), keyword = match[2], traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Even try non-relevant URLs if we still have 0 keywords
      if (!isRelevantUrl && topKeywords.length === 0 && bodyStr.includes('Po') && bodyStr.includes('Ph')) {
        logStep("TopKeywords-API", `Trying non-standard URL that contains Po/Ph: ${url.substring(0, 120)}`);
        // Re-run the regex patterns on this response
        const reSv = /\{[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Sv"\s*:\s*([\d,.]+)/g;
        while ((match = reSv.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
          const keyword = match[1], position = parseInt(match[2], 10), traffic = formatNumber(match[3]);
          if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
            seenKeywords.add(keyword.toLowerCase());
            topKeywords.push({ keyword, traffic, position: 1 });
          }
        }
      }
    } catch { continue; }
  }

  if (topKeywords.length > 0) {
    logStep("TopKeywords-API", `Extracted ${topKeywords.length} position-1 keywords from API data`);
  } else {
    logStep("TopKeywords-API", `No keywords found in ${capturedApiData.length} API responses`);
  }
  return topKeywords;
}

async function navigateToSemrushPage(
  page: Page,
  baseUrl: string,
  path: string,
  domain: string,
  countryDb: string
): Promise<boolean> {
  const url = `${baseUrl}${path}?q=${encodeURIComponent(domain)}&db=${countryDb}`;
  logStep("Navigate", `Navigating to: ${url}`);

  // Retry logic: try up to 2 times
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt > 1) {
        logStep("Navigate", `Retry attempt ${attempt}...`);
      }
      await page.goto(url, { waitUntil: "load", timeout: 90000 });
      logStep("Navigate", "Page loaded, URL:", page.url());

      // Wait for the page to settle (proxy pages can be slow)
      await page.waitForTimeout(5000);
      try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch {}

      const pageTitle = await page.title().catch(() => "");
      logStep("Navigate", `Page title: "${pageTitle}"`);

      // Check for login redirect (session expired)
      const currentUrl = page.url();
      if (pageTitle === "登录" || pageTitle === "Login" || currentUrl.includes("login")) {
        logStep("Navigate", "WARNING: On login page - session may have expired");
        return false;
      }

      // Check if page loaded with actual content (not a blank/error page)
      const bodyText = await page.locator('body').textContent().catch(() => "");
      if (bodyText && bodyText.trim().length > 50) {
        logStep("Navigate", "Page has content, navigation successful");
        return true;
      }

      logStep("Navigate", "Page appears empty, waiting more...");
      await page.waitForTimeout(3000);
      return true;  // Return true anyway, let extraction handle empty pages
    } catch (err) {
      logStep("Navigate", `Attempt ${attempt} failed:`, err instanceof Error ? err.message : String(err));
      if (attempt === 2) {
        return false;
      }
      // Wait before retrying
      await page.waitForTimeout(3000);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Batch Query Helper — Queries a single domain using an already-logged-in page
// ---------------------------------------------------------------------------

async function querySingleDomain(
  page: Page,
  semrushBaseUrl: string,
  domain: string,
  country: string
): Promise<{
  success: boolean;
  domain: string;
  country: string;
  isSubdomain: boolean;
  organicTraffic: number;
  paidTraffic: number;
  topKeywords: TopKeyword[];
  rootDomainData: { domain: string; organicTraffic: number; paidTraffic: number } | null;
  error?: string;
}> {
  const countryDb = country.toUpperCase();
  logStep("BatchQuery", `Querying domain: ${domain} (${countryDb})`);

  try {
    // Clear previous API captures by setting up fresh interceptor
    const capturedApiData: { url: string; body: any }[] = [];
    const responseListener = async (response: any) => {
      try {
        const url = response.url();
        // Broadened matching — proxy versions may use different URL patterns
        if (url.includes('/analytics/') || url.includes('/api/') || url.includes('overview') || url.includes('organic') || url.includes('adwords') || url.includes('paid') || url.includes('keyword') || url.includes('search') || url.includes('report') || url.includes('positions')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            const jsonBody = await response.json().catch(() => null);
            if (jsonBody) capturedApiData.push({ url, body: jsonBody });
          }
        }
      } catch {}
    };
    page.on('response', responseListener);

    // Step 1: Navigate to domain overview
    const overviewOk = await navigateToSemrushPage(page, semrushBaseUrl, "/analytics/overview/", domain, countryDb);
    if (!overviewOk) {
      page.off('response', responseListener);
      return { success: false, domain, country: countryDb, isSubdomain: false, organicTraffic: 0, paidTraffic: 0, topKeywords: [], rootDomainData: null, error: "Failed to load domain overview page" };
    }

    // Step 2: Extract traffic from API data
    let organicTraffic = 0;
    let paidTraffic = 0;
    for (const apiResponse of capturedApiData) {
      try {
        const bodyStr = JSON.stringify(apiResponse.body);
        const organicMatch = bodyStr.match(/"organic[^"]*traffic[^"]*":\s*"?([\d,.]+[KMB]?)"?/i) || bodyStr.match(/"organic_search_traffic[^"]*":\s*(\d+)/i) || bodyStr.match(/"Ot[^"]*":\s*(\d+)/i);
        if (organicMatch) { const val = formatNumber(organicMatch[1]); if (val > organicTraffic) organicTraffic = val; }
        const paidMatch = bodyStr.match(/"paid[^"]*traffic[^"]*":\s*"?([\d,.]+[KMB]?)"?/i) || bodyStr.match(/"adwords[^"]*traffic[^"]*":\s*(\d+)/i) || bodyStr.match(/"Ad[^"]*":\s*(\d+)/i) || bodyStr.match(/"paid_search_traffic[^"]*":\s*(\d+)/i);
        if (paidMatch) { const val = formatNumber(paidMatch[1]); if (val > paidTraffic) paidTraffic = val; }
      } catch {}
    }

    if (organicTraffic === 0) organicTraffic = await extractOrganicTraffic(page);
    if (paidTraffic === 0) paidTraffic = await extractPaidTraffic(page);

    // Step 3: Extract top keywords
    let topKeywords: TopKeyword[] = [];
    const positionsUrl = `${semrushBaseUrl}/analytics/organic/positions/?q=${encodeURIComponent(domain)}&db=${countryDb}&display_sort=pos_num&display_direction=asc`;
    let positionsOk = false;
    try {
      await page.goto(positionsUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch {}
      positionsOk = true;
    } catch {}
    
    if (positionsOk) {
      // Extra wait + scroll to ensure table is fully loaded
      await page.waitForTimeout(2000);
      try {
        await page.evaluate(async () => {
          for (let i = 0; i < 8; i++) {
            window.scrollBy(0, 600);
            await new Promise(r => setTimeout(r, 400));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1000);
      } catch {}

      // Strategy 1: API extraction
      topKeywords = extractKeywordsFromApiData(capturedApiData);
      // Strategy 2: DOM scraping
      if (topKeywords.length === 0) topKeywords = await extractTopKeywords(page);
      // Strategy 3: Inline script extraction
      if (topKeywords.length === 0) topKeywords = await extractKeywordsFromScripts(page);

      // Debug dump when keywords = 0
      if (topKeywords.length === 0) {
        logStep("BatchQuery", `KEYWORD DEBUG for ${domain}: 0 keywords found. API responses=${capturedApiData.length}`);
        for (let i = 0; i < Math.min(capturedApiData.length, 5); i++) {
          logStep("BatchQuery", `  API[${i}] URL: ${capturedApiData[i].url.substring(0, 120)} | body: ${JSON.stringify(capturedApiData[i].body).substring(0, 300)}`);
        }
        try {
          const tableInfo = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            return { tableCount: tables.length, bodyPreview: document.body?.innerText?.substring(0, 300) || '' };
          });
          logStep("BatchQuery", `  Tables: ${tableInfo.tableCount}, body: ${tableInfo.bodyPreview}`);
        } catch {}
      }
    }

    // Step 4: Root domain data for subdomains
    let rootDomainData: { domain: string; organicTraffic: number; paidTraffic: number } | null = null;
    if (isSubdomain(domain)) {
      const rootDomain = getRootDomain(domain);
      const rootOk = await navigateToSemrushPage(page, semrushBaseUrl, "/analytics/overview/", rootDomain, countryDb);
      if (rootOk) {
        rootDomainData = { domain: rootDomain, organicTraffic: await extractOrganicTraffic(page), paidTraffic: await extractPaidTraffic(page) };
      }
    }

    page.off('response', responseListener);

    logStep("BatchQuery", `Completed: ${domain} organic=${organicTraffic}, paid=${paidTraffic}, keywords=${topKeywords.length}`);
    return { success: true, domain, country: countryDb, isSubdomain: isSubdomain(domain), organicTraffic, paidTraffic, topKeywords, rootDomainData };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("BatchQuery", `FAILED: ${domain} - ${errMsg}`);
    return { success: false, domain, country: countryDb, isSubdomain: false, organicTraffic: 0, paidTraffic: 0, topKeywords: [], rootDomainData: null, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/domain
// ---------------------------------------------------------------------------

async function handleSemrushDomain(req: Request): Promise<Response> {
  let body: SemrushDomainRequest;
  try { body = (await req.json()) as SemrushDomainRequest; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { domain, country = "US", loginUrl, cardNumber, password } = body;
  if (!domain || !loginUrl || !cardNumber || !password) {
    return jsonResponse({ success: false, error: "domain, loginUrl, cardNumber, and password are required" }, 400);
  }

  logStep("SemrushDomain", `Starting domain query: ${domain} (${country})`);
  let browser: Browser | null = null;

  try {
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    // Step 1: Login (3-phase: gateway → proxy → SEMrush)
    logStep("SemrushDomain", "Step 1: Logging in...");
    const { page, semrushBaseUrl } = await semrushLogin(context, loginUrl, cardNumber, password);
    logStep("SemrushDomain", `Using SEMrush base URL: ${semrushBaseUrl}`);

    const countryDb = country.toUpperCase();

    // ── Network interception: capture SEMrush API responses ──
    const capturedApiData: { url: string; body: any }[] = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        // Broadened SEMrush API endpoint matching — proxy versions may use different URL patterns
        if (
          url.includes('/analytics/') ||
          url.includes('/api/') ||
          url.includes('overview') ||
          url.includes('organic') ||
          url.includes('adwords') ||
          url.includes('paid') ||
          url.includes('keyword') ||
          url.includes('search') ||
          url.includes('report') ||
          url.includes('positions')
        ) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json')) {
            const jsonBody = await response.json().catch(() => null);
            if (jsonBody) {
              capturedApiData.push({ url, body: jsonBody });
              logStep("SemrushDomain", `Captured API response: ${url.substring(0, 120)}`);
            }
          }
        }
      } catch {}
    });

    // Step 2: Navigate to domain overview
    logStep("SemrushDomain", "Step 2: Navigating to domain overview...");
    const overviewOk = await navigateToSemrushPage(page, semrushBaseUrl, "/analytics/overview/", domain, countryDb);

    if (!overviewOk) {
      throw new Error("Failed to load domain overview page (session may have expired)");
    }

    // Collect debug info from the page
    let debugInfo: { pageUrl: string; pageTitle: string; bodyTextPreview: string; semrushBaseUrl: string; capturedApiCount: number } | undefined;
    try {
      const pageText = await page.locator('body').innerText().catch(() => "");
      const pageTitle = await page.title().catch(() => "");
      const pageUrl = page.url();
      debugInfo = { pageUrl, pageTitle, bodyTextPreview: pageText.substring(0, 1000), semrushBaseUrl, capturedApiCount: capturedApiData.length };
      logStep("SemrushDomain", `Page title: "${pageTitle}", URL: ${pageUrl}`);
      logStep("SemrushDomain", `Captured ${capturedApiData.length} API responses`);
      logStep("SemrushDomain", `Page text (first 300): ${pageText.substring(0, 300)}`);
    } catch {}

    // Step 3: Try extracting from captured API data first (most reliable)
    logStep("SemrushDomain", "Step 3: Extracting data from captured API responses...");
    let organicTraffic = 0;
    let paidTraffic = 0;

    for (const apiResponse of capturedApiData) {
      try {
        const bodyStr = JSON.stringify(apiResponse.body);
        // Look for organic traffic data in API responses
        const organicMatch = bodyStr.match(/"organic[^"]*traffic[^"]*":\s*"?([\d,.]+[KMB]?)"?/i) ||
                            bodyStr.match(/"organic_search_traffic[^"]*":\s*(\d+)/i) ||
                            bodyStr.match(/"Ot[^"]*":\s*(\d+)/i);
        if (organicMatch) {
          const val = formatNumber(organicMatch[1]);
          if (val > organicTraffic) {
            organicTraffic = val;
            logStep("SemrushDomain", `Found organic traffic in API: ${organicMatch[1]} → ${val} (from ${apiResponse.url.substring(0, 80)})`);
          }
        }
        // Look for paid traffic data
        const paidMatch = bodyStr.match(/"paid[^"]*traffic[^"]*":\s*"?([\d,.]+[KMB]?)"?/i) ||
                         bodyStr.match(/"adwords[^"]*traffic[^"]*":\s*(\d+)/i) ||
                         bodyStr.match(/"Ad[^"]*":\s*(\d+)/i) ||
                         bodyStr.match(/"paid_search_traffic[^"]*":\s*(\d+)/i);
        if (paidMatch) {
          const val = formatNumber(paidMatch[1]);
          if (val > paidTraffic) {
            paidTraffic = val;
            logStep("SemrushDomain", `Found paid traffic in API: ${paidMatch[1]} → ${val} (from ${apiResponse.url.substring(0, 80)})`);
          }
        }
      } catch {}
    }

    // Step 4: If API data didn't work, fall back to DOM extraction
    if (organicTraffic === 0) {
      logStep("SemrushDomain", "Step 4: API extraction found nothing, trying DOM extraction...");
      organicTraffic = await extractOrganicTraffic(page);
      logStep("SemrushDomain", `Organic traffic (DOM): ${organicTraffic}`);
    } else {
      logStep("SemrushDomain", `Organic traffic (API): ${organicTraffic}`);
    }

    if (paidTraffic === 0) {
      paidTraffic = await extractPaidTraffic(page);
      logStep("SemrushDomain", `Paid traffic (DOM): ${paidTraffic}`);
    } else {
      logStep("SemrushDomain", `Paid traffic (API): ${paidTraffic}`);
    }

    // Step 5: Navigate to organic positions for top keywords (sorted by position ascending)
    logStep("SemrushDomain", "Step 5: Extracting top keywords...");
    let topKeywords: TopKeyword[] = [];
    // Navigate with sort by position ascending so position-1 keywords appear first
    const positionsUrl = `${semrushBaseUrl}/analytics/organic/positions/?q=${encodeURIComponent(domain)}&db=${countryDb}&display_sort=pos_num&display_direction=asc`;
    logStep("SemrushDomain", `Navigating to positions page with sort: ${positionsUrl}`);
    let positionsOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(positionsUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3000);
        try { await page.waitForLoadState("networkidle", { timeout: 20000 }); } catch {}
        const pageTitle = await page.title().catch(() => "");
        const currentUrl = page.url();
        if (pageTitle === "登录" || pageTitle === "Login" || currentUrl.includes("login")) {
          logStep("SemrushDomain", "WARNING: On login page during positions navigation - session expired");
          break;
        }
        positionsOk = true;
        break;
      } catch (err) {
        logStep("SemrushDomain", `Positions page attempt ${attempt} failed: ${err}`);
      }
    }
    if (positionsOk) {
      // Extra wait + scroll to ensure table is fully loaded (proxy pages can be slow / use lazy loading)
      await page.waitForTimeout(2000);
      logStep("SemrushDomain", "Scrolling positions page to trigger lazy loading...");
      try {
        await page.evaluate(async () => {
          for (let i = 0; i < 8; i++) {
            window.scrollBy(0, 600);
            await new Promise(r => setTimeout(r, 400));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1000);
      } catch {}

      // Strategy 1: Try API extraction first (most reliable)
      topKeywords = extractKeywordsFromApiData(capturedApiData);
      if (topKeywords.length > 0) {
        logStep("SemrushDomain", `Got ${topKeywords.length} keywords from API data`);
      } else {
        // Strategy 2: Fall back to DOM scraping with pagination support
        logStep("SemrushDomain", "API extraction yielded no keywords, falling back to DOM scraping...");
        topKeywords = await extractTopKeywords(page);
      }

      // Strategy 3: Try inline script extraction if still no keywords
      if (topKeywords.length === 0) {
        logStep("SemrushDomain", "DOM scraping also yielded no keywords, trying inline script extraction...");
        topKeywords = await extractKeywordsFromScripts(page);
      }

      // ── Comprehensive debug dump when keywords = 0 ──
      if (topKeywords.length === 0) {
        logStep("SemrushDomain", "=== KEYWORD EXTRACTION DEBUG DUMP (0 keywords found) ===");

        // Dump captured API URLs and their structure
        logStep("SemrushDomain", `Captured API responses: ${capturedApiData.length}`);
        for (let i = 0; i < Math.min(capturedApiData.length, 10); i++) {
          const apiResp = capturedApiData[i];
          const bodyPreview = JSON.stringify(apiResp.body).substring(0, 500);
          logStep("SemrushDomain", `  API[${i}] URL: ${apiResp.url.substring(0, 150)}`);
          logStep("SemrushDomain", `  API[${i}] Body (first 500): ${bodyPreview}`);
        }
        if (capturedApiData.length === 0) {
          logStep("SemrushDomain", "  No API responses were captured at all — proxy may use SSR instead of API calls");
        }

        // Dump table HTML
        try {
          const tableHtml = await page.evaluate(() => {
            const tables = document.querySelectorAll('table');
            if (tables.length > 0) return tables[0].outerHTML.substring(0, 2000);
            const divTables = document.querySelectorAll('[class*="table"], [class*="Table"], [role="table"]');
            if (divTables.length > 0) return divTables[0].outerHTML.substring(0, 2000);
            return 'NO TABLE FOUND';
          });
          logStep("SemrushDomain", `Table HTML (first 2000): ${tableHtml}`);
        } catch {}

        // Dump page body text
        try {
          const bodyText = await page.locator('body').innerText().catch(() => "");
          logStep("SemrushDomain", `Page body text (first 500): ${bodyText.substring(0, 500)}`);
        } catch {}

        // Dump page URL and title
        logStep("SemrushDomain", `Current page URL: ${page.url()}`);
        logStep("SemrushDomain", `Current page title: ${await page.title().catch(() => "")}`);

        // Check for inline scripts containing keyword data
        try {
          const scriptSummary = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script');
            const summary: string[] = [];
            for (const script of scripts) {
              const content = script.textContent || '';
              if (content.includes('Ph') || content.includes('keyword') || content.includes('position') || content.includes('organic')) {
                summary.push(`Script (len=${content.length}, has_Ph=${content.includes('"Ph"')}, has_keyword=${content.includes('keyword')}, has_position=${content.includes('position')}): ${content.substring(0, 200)}`);
              }
            }
            return summary;
          });
          logStep("SemrushDomain", `Relevant inline scripts: ${scriptSummary.length}`);
          for (const s of scriptSummary.slice(0, 5)) {
            logStep("SemrushDomain", `  ${s}`);
          }
        } catch {}

        logStep("SemrushDomain", "=== END DEBUG DUMP ===");
      }
    } else {
      logStep("SemrushDomain", "Could not load positions page, skipping keyword extraction");
    }

    // Step 6: Check if domain is a subdomain
    let rootDomainData: { domain: string; organicTraffic: number; paidTraffic: number } | null = null;
    if (isSubdomain(domain)) {
      logStep("SemrushDomain", "Step 6: Domain is subdomain, fetching root domain data...");
      const rootDomain = getRootDomain(domain);
      const rootOk = await navigateToSemrushPage(page, semrushBaseUrl, "/analytics/overview/", rootDomain, countryDb);
      if (rootOk) {
        rootDomainData = {
          domain: rootDomain,
          organicTraffic: await extractOrganicTraffic(page),
          paidTraffic: await extractPaidTraffic(page),
        };
        logStep("SemrushDomain", `Root domain data: organic=${rootDomainData.organicTraffic}, paid=${rootDomainData.paidTraffic}`);
      }
    }

    await closeBrowser(browser);
    logStep("SemrushDomain", `SUCCESS: organic=${organicTraffic}, paid=${paidTraffic}, keywords=${topKeywords.length}`);

    return jsonResponse({
      success: true, domain, country: countryDb, isSubdomain: isSubdomain(domain),
      organicTraffic, paidTraffic, topKeywords, rootDomainData,
      debug: debugInfo,
    });
  } catch (err) {
    if (browser) await closeBrowser(browser);
    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushDomain", `FAILED: ${errMsg}`);

    if (errMsg.includes("login") || errMsg.includes("Login") || errMsg.includes("Could not find")) {
      return jsonResponse({ success: false, error: "SEMrush login failed", details: errMsg }, 401);
    }
    if (errMsg.includes("Gateway page did not redirect")) {
      return jsonResponse({ success: false, error: "SEMrush gateway redirect failed", details: errMsg }, 502);
    }
    return jsonResponse({ success: false, error: "SEMrush domain scraping failed", details: errMsg }, 500);
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/ads
// ---------------------------------------------------------------------------

async function handleSemrushAds(req: Request): Promise<Response> {
  let body: SemrushAdsRequest;
  try { body = (await req.json()) as SemrushAdsRequest; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { domain, country = "US", loginUrl, cardNumber, password } = body;
  if (!domain || !loginUrl || !cardNumber || !password) {
    return jsonResponse({ success: false, error: "domain, loginUrl, cardNumber, and password are required" }, 400);
  }

  logStep("SemrushAds", `Starting ad copies query: ${domain} (${country})`);
  let browser: Browser | null = null;

  try {
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    logStep("SemrushAds", "Step 1: Logging in...");
    const { page, semrushBaseUrl } = await semrushLogin(context, loginUrl, cardNumber, password);

    const countryDb = country.toUpperCase();

    // Navigate to ad copies
    logStep("SemrushAds", "Step 2: Navigating to ad copies...");
    const adCopiesUrl = `${semrushBaseUrl}/advertising/copies/?q=${encodeURIComponent(domain)}&db=${countryDb}&display_type=text`;
    await page.goto(adCopiesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);

    try {
      await page.waitForSelector("table, .table, [data-at='ad-copies-table'], .ad-copy", { timeout: 15000 });
    } catch {}

    const titles: AdTitle[] = [];
    const descriptions: AdDescription[] = [];

    // Strategy 1: Table rows
    const rows = await page.locator("table tbody tr, .table__row").all();
    for (let i = 0; i < rows.length && titles.length < 15; i++) {
      try {
        const cells = await rows[i].locator("td, .table__cell").all();
        if (cells.length >= 2) {
          const titleText = (await cells[0].textContent())?.trim() || "";
          if (titleText && titles.length < 15) titles.push({ text: titleText, source: "scraped" });
          if (cells.length >= 2 && descriptions.length < 4) {
            const descText = (await cells[1].textContent())?.trim() || "";
            if (descText && descText !== titleText) descriptions.push({ text: descText, source: "scraped" });
          }
        }
      } catch { continue; }
    }

    // Strategy 2: SEMrush ad copy selectors
    if (titles.length === 0) {
      const adCopySelectors = [".ad-copy__title", ".ad-copy__headline", "[data-at='ad-title']", "h3[class*='ad']", "h4[class*='ad']"];
      for (const selector of adCopySelectors) {
        try {
          const elements = await page.locator(selector).all();
          for (let i = 0; i < elements.length && titles.length < 15; i++) {
            const text = (await elements[i].textContent())?.trim() || "";
            if (text) titles.push({ text, source: "scraped" });
          }
          if (titles.length > 0) break;
        } catch { continue; }
      }
    }

    // Strategy 3: Generic headings
    if (titles.length === 0) {
      try {
        const headings = await page.locator("h3, h4, [class*='title'], [class*='headline']").all();
        for (let i = 0; i < headings.length && titles.length < 15; i++) {
          try {
            const text = (await headings[i].textContent())?.trim() || "";
            if (text && text.length > 10 && text.length < 200) titles.push({ text, source: "scraped" });
          } catch { continue; }
        }
      } catch {}
    }

    // Extract descriptions
    if (descriptions.length === 0) {
      const descSelectors = [".ad-copy__description", "[data-at='ad-description']", "[class*='description']"];
      for (const selector of descSelectors) {
        try {
          const elements = await page.locator(selector).all();
          for (let i = 0; i < elements.length && descriptions.length < 4; i++) {
            const text = (await elements[i].textContent())?.trim() || "";
            if (text && text.length > 20) descriptions.push({ text, source: "scraped" });
          }
          if (descriptions.length > 0) break;
        } catch { continue; }
      }
    }

    await closeBrowser(browser);
    logStep("SemrushAds", `SUCCESS: ${titles.length} titles, ${descriptions.length} descriptions`);

    return jsonResponse({ success: true, domain, country: countryDb, titles, descriptions });
  } catch (err) {
    if (browser) await closeBrowser(browser);
    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushAds", `FAILED: ${errMsg}`);

    if (errMsg.includes("login") || errMsg.includes("Login") || errMsg.includes("Could not find")) {
      return jsonResponse({ success: false, error: "SEMrush login failed", details: errMsg }, 401);
    }
    return jsonResponse({ success: false, error: "SEMrush ad scraping failed", details: errMsg }, 500);
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/batch (NDJSON streaming)
// ---------------------------------------------------------------------------

async function handleSemrushBatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: SemrushBatchRequest;
  try {
    const rawBody = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => { resolve(data); });
    });
    body = JSON.parse(rawBody) as SemrushBatchRequest;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ success: false, error: "Invalid JSON body" }));
    return;
  }

  const { domains, loginUrl, cardNumber, password } = body;
  if (!domains || !Array.isArray(domains) || domains.length === 0 || !loginUrl || !cardNumber || !password) {
    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ success: false, error: "domains (non-empty array), loginUrl, cardNumber, and password are required" }));
    return;
  }

  // Set up NDJSON streaming response
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const sendLine = (data: object) => {
    res.write(JSON.stringify(data) + "\n");
  };

  let browser: Browser | null = null;

  try {
    // Step 1: Login ONCE
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    logStep("SemrushBatch", `Logging in for batch of ${domains.length} domains...`);
    sendLine({ type: "progress", step: "login", message: "Logging in to SEMrush..." });

    const { page, semrushBaseUrl } = await semrushLogin(context, loginUrl, cardNumber, password);
    logStep("SemrushBatch", `Login successful, base URL: ${semrushBaseUrl}`);

    sendLine({ type: "progress", step: "login_complete", message: "Login successful" });

    // Step 2: Query each domain in sequence, reusing the same page
    let completed = 0;
    let succeeded = 0;
    for (const item of domains) {
      const domain = item.domain;
      const country = item.country || "US";

      sendLine({ type: "progress", step: "querying", domain, completed, total: domains.length, message: `Querying ${domain}...` });

      const result = await querySingleDomain(page, semrushBaseUrl, domain, country);
      completed++;
      if (result.success) succeeded++;

      sendLine({ type: "result", ...result, completed, total: domains.length });

      // Brief pause between domains to avoid rate limiting
      if (completed < domains.length) {
        await page.waitForTimeout(1000);
      }
    }

    sendLine({ type: "complete", total: domains.length, succeeded, failed: domains.length - succeeded });

    await closeBrowser(browser);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushBatch", `FAILED: ${errMsg}`);
    sendLine({ type: "error", error: errMsg });
    if (browser) await closeBrowser(browser);
  }

  res.end();
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/debug — Diagnostic endpoint
// ---------------------------------------------------------------------------

async function handleSemrushDebug(req: Request): Promise<Response> {
  let body: { loginUrl?: string; cardNumber?: string; password?: string };
  try { body = (await req.json()) as typeof body; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { loginUrl, cardNumber, password } = body;
  if (!loginUrl || !cardNumber || !password) {
    return jsonResponse({ success: false, error: "loginUrl, cardNumber, and password are required" }, 400);
  }

  logStep("SemrushDebug", "Starting debug session...");
  let browser: Browser | null = null;
  const screenshots: { phase: string; url: string; title: string; screenshot: string; bodyText: string }[] = [];

  try {
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    const page = await context.newPage();

    // Phase 1: Load gateway
    logStep("SemrushDebug", "Phase 1: Loading gateway...");
    try {
      await page.goto(loginUrl, { waitUntil: "load", timeout: 30000 });
    } catch (navErr) {
      logStep("SemrushDebug", "Gateway nav error:", navErr instanceof Error ? navErr.message : String(navErr));
    }
    await page.waitForTimeout(3000);

    const phase1Url = page.url();
    const phase1Title = await page.title().catch(() => "");
    const phase1Screenshot = (await page.screenshot({ type: "jpeg", quality: 50 }).catch(() => Buffer.alloc(0))).toString("base64");
    const phase1Body = await page.locator('body').innerText().catch(() => "").then(t => t.substring(0, 500));
    screenshots.push({ phase: "1-gateway-load", url: phase1Url, title: phase1Title, screenshot: phase1Screenshot, bodyText: phase1Body });

    // Check for auto-redirect
    const loginHost = new URL(loginUrl).hostname;
    let currentHost = "";
    try { currentHost = new URL(phase1Url).hostname; } catch { currentHost = phase1Url; }

    if (currentHost === loginHost) {
      // Try clicking elements
      logStep("SemrushDebug", "Still on gateway, trying to click elements...");
      try {
        const clickable = page.locator('.node-card, [class*="node"], a[href*="http"], [class*="card"], button').first();
        if ((await clickable.count()) > 0) {
          await clickable.click();
          await page.waitForTimeout(5000);
        }
      } catch {}

      const phase2Url = page.url();
      const phase2Title = await page.title().catch(() => "");
      const phase2Screenshot = (await page.screenshot({ type: "jpeg", quality: 50 }).catch(() => Buffer.alloc(0))).toString("base64");
      const phase2Body = await page.locator('body').innerText().catch(() => "").then(t => t.substring(0, 500));
      screenshots.push({ phase: "2-after-click", url: phase2Url, title: phase2Title, screenshot: phase2Screenshot, bodyText: phase2Body });
    }

    // Phase 2: Try login
    logStep("SemrushDebug", "Phase 2: Trying login...");
    try {
      const accTab = page.locator('text=账号密码, [class*="tab"]:has-text("账号"), [role="tab"]:has-text("账号")').first();
      if ((await accTab.count()) > 0 && (await accTab.isVisible())) {
        await accTab.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Fill username
    const userInput = page.locator('input[placeholder*="用户名"], input[placeholder*="账号"], input[placeholder*="account" i], input[type="text"]').first();
    if ((await userInput.count()) > 0) {
      await userInput.click();
      await userInput.fill('');
      await userInput.fill(cardNumber);
      logStep("SemrushDebug", "Filled username");
    }

    // Fill password
    const pwInput = page.locator('input[type="password"], input[placeholder*="密码"], input[placeholder*="password" i]').first();
    if ((await pwInput.count()) > 0) {
      await pwInput.click();
      await pwInput.fill('');
      await pwInput.fill(password);
      logStep("SemrushDebug", "Filled password");
    }

    // Click login
    const loginBtn = page.locator('button:has-text("登录"), button:has-text("Login"), button[type="submit"]').first();
    if ((await loginBtn.count()) > 0) {
      await loginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(5000);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const phase3Url = page.url();
    const phase3Title = await page.title().catch(() => "");
    const phase3Screenshot = (await page.screenshot({ type: "jpeg", quality: 50 }).catch(() => Buffer.alloc(0))).toString("base64");
    const phase3Body = await page.locator('body').innerText().catch(() => "").then(t => t.substring(0, 500));
    screenshots.push({ phase: "3-after-login", url: phase3Url, title: phase3Title, screenshot: phase3Screenshot, bodyText: phase3Body });

    // Phase 3: Look for SEMrush button
    logStep("SemrushDebug", "Phase 3: Looking for SEMrush button...");
    const semrushElements = await page.evaluate(() => {
      const elements: string[] = [];
      document.querySelectorAll('a, button, [role="button"]').forEach(el => {
        const text = el.textContent?.trim() || '';
        const href = el.getAttribute('href') || '';
        if (text.toLowerCase().includes('semrush') || href.toLowerCase().includes('semrush')) {
          elements.push(`${el.tagName}: text="${text.substring(0, 50)}" href="${href.substring(0, 100)}"`);
        }
      });
      return elements;
    });
    logStep("SemrushDebug", "SEMrush elements found:", JSON.stringify(semrushElements));

    await closeBrowser(browser);
    return jsonResponse({ success: true, screenshots, semrushElements });
  } catch (err) {
    if (browser) await closeBrowser(browser);
    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushDebug", `FAILED: ${errMsg}`);
    return jsonResponse({ success: false, error: errMsg, screenshots });
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const PORT = 3001;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // Helper to read request body
    const readBody = (): Promise<string> => {
      return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => { resolve(body); });
      });
    };

    // Helper to send JSON response
    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(JSON.stringify(data));
    };

    // Create a Request-like object for handlers
    const makeRequest = async (): Promise<Request> => {
      const body = await readBody();
      return new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body || undefined,
      });
    };

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        sendJson({ status: "ok", timestamp: Date.now() });
      } else if (url.pathname === "/api/extract" && req.method === "POST") {
        const request = await makeRequest();
        const response = await handleExtract(request);
        const body = await response.text();
        sendJson(JSON.parse(body), response.status);
      } else if (url.pathname === "/api/semrush/domain" && req.method === "POST") {
        const request = await makeRequest();
        const response = await handleSemrushDomain(request);
        const body = await response.text();
        sendJson(JSON.parse(body), response.status);
      } else if (url.pathname === "/api/semrush/batch" && req.method === "POST") {
        await handleSemrushBatch(req, res);
        return; // Already handled response directly
      } else if (url.pathname === "/api/semrush/ads" && req.method === "POST") {
        const request = await makeRequest();
        const response = await handleSemrushAds(request);
        const body = await response.text();
        sendJson(JSON.parse(body), response.status);
      } else if (url.pathname === "/api/semrush/debug" && req.method === "POST") {
        // Debug endpoint: takes a screenshot at each login phase
        const request = await makeRequest();
        const response = await handleSemrushDebug(request);
        const body = await response.text();
        sendJson(JSON.parse(body), response.status);
      } else {
        sendJson({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error("Request handler error:", err);
      sendJson({ error: "Internal server error" }, 500);
    }
  });

server.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`);
});

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
// SEMrush Login Helper — Three-phase login flow:
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
  logStep("SEMrush-Login", "Starting 3-phase login flow, loginUrl:", loginUrl);

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

  await gatewayPage.waitForTimeout(5000);

  // Poll for redirect — the gateway auto-tests nodes and redirects after ~3s
  // But sometimes it needs a click to trigger the redirect
  let currentUrl = gatewayPage.url();
  let currentHost: string;
  try { currentHost = new URL(currentUrl).hostname; } catch { currentHost = currentUrl; }

  if (currentHost === loginHost) {
    logStep("SEMrush-Login", "Waiting for gateway auto-redirect...");
    const maxWaitMs = 90000;
    const startTime = Date.now();
    let clickAttempted = false;

    while (Date.now() - startTime < maxWaitMs) {
      currentUrl = gatewayPage.url();
      try { currentHost = new URL(currentUrl).hostname; } catch { currentHost = currentUrl; }

      if (currentHost !== loginHost && !isChromeError(currentUrl)) {
        logStep("SEMrush-Login", "Gateway redirected to:", currentUrl);
        break;
      }

      // After 15 seconds, try clicking on node cards/buttons to trigger redirect
      if (!clickAttempted && Date.now() - startTime > 15000) {
        clickAttempted = true;
        logStep("SEMrush-Login", "Auto-redirect not happening, trying to click node...");
        try {
          // The gateway page has clickable node cards for each proxy server
          const clickable = gatewayPage.locator('.node-card, [class*="node"], a[href*="http"], [class*="card"]').first();
          if ((await clickable.count()) > 0 && (await clickable.isVisible())) {
            await clickable.click();
            logStep("SEMrush-Login", "Clicked first node card");
            await gatewayPage.waitForTimeout(5000);
            continue;
          }
        } catch {}

        // Alternative: try clicking the "立即跳转" (redirect now) link
        try {
          const redirectLink = gatewayPage.locator('text=立即跳转, text=跳转, a:has-text("跳转")').first();
          if ((await redirectLink.count()) > 0 && (await redirectLink.isVisible())) {
            await redirectLink.click();
            logStep("SEMrush-Login", "Clicked redirect link");
            await gatewayPage.waitForTimeout(5000);
            continue;
          }
        } catch {}
      }

      await gatewayPage.waitForTimeout(3000);
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
    const accTab = gatewayPage.locator('text=账号密码').first();
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
  await gatewayPage.waitForTimeout(5000);
  await gatewayPage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const postLoginTitle = await gatewayPage.title().catch(() => "");
  logStep("SEMrush-Login", "After login, title:", postLoginTitle);

  // ── Phase 3: Click "打开 Semrush" to open the SEMrush interface ──
  logStep("SEMrush-Login", "Phase 3: Clicking 打开 Semrush button...");

  // Strategy: Try opening SEMrush via new tab first; if that fails, navigate in the same page
  let semrushPage: Page | null = null;
  let semrushBaseUrl = "";

  // Approach A: Click button that opens a new tab
  const newPagePromise = context.waitForEvent('page', { timeout: 20000 }).catch(() => null);

  try {
    const openBtn = gatewayPage.locator('text=打开 Semrush, text=打开 semrush, a:has-text("Semrush")').first();
    if ((await openBtn.count()) > 0 && (await openBtn.isVisible())) {
      await openBtn.click();
      logStep("SEMrush-Login", "Clicked 打开 Semrush");
    } else {
      throw new Error("Could not find 打开 Semrush button on proxy dashboard");
    }
  } catch (e) {
    logStep("SEMrush-Login", "打开 Semrush button error:", e instanceof Error ? e.message : String(e));
    // Try alternative: look for any link/button that opens SEMrush
    const altBtn = gatewayPage.locator('a[href*="semrush"], button:has-text("Semrush"), [class*="semrush"]').first();
    if ((await altBtn.count()) > 0) {
      await altBtn.click();
      logStep("SEMrush-Login", "Clicked alternative Semrush button");
    } else {
      throw new Error("Could not find any Semrush launch button on proxy dashboard");
    }
  }

  const newPage = await newPagePromise;
  if (newPage) {
    // Wait for the new page to load
    await newPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await newPage.waitForTimeout(5000);

    // Wait for URL to stabilize (the new tab might redirect several times)
    let stableUrl = newPage.url();
    for (let attempt = 0; attempt < 5; attempt++) {
      await newPage.waitForTimeout(3000);
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
      await gatewayPage.waitForTimeout(5000);
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

  try {
    await page.waitForSelector("table, .table, [data-at='positions-table']", { timeout: 10000 });
  } catch {}

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    const rows = await page.locator("table tbody tr, .table__row").all();
    let foundNonPosition1 = false;
    let pageKeywordCount = 0;

    for (let i = 0; i < rows.length; i++) {
      if (topKeywords.length >= MAX_KEYWORDS) break;
      try {
        const row = rows[i];
        const cells = await row.locator("td, .table__cell").all();
        if (cells.length >= 3) {
          const keywordText = (await cells[0].textContent())?.trim() || "";
          const positionText = (await cells[1].textContent())?.trim() || "";
          const trafficText = (await cells[2].textContent())?.trim() || "";
          const position = parseInt(positionText, 10);
          if (position === 1 && keywordText) {
            topKeywords.push({ keyword: keywordText, traffic: formatNumber(trafficText), position: 1 });
            pageKeywordCount++;
          } else if (position > 1) {
            // If we encounter a non-position-1 keyword, note it
            foundNonPosition1 = true;
          }
        }
      } catch { continue; }
    }

    logStep("TopKeywords", `Page ${pageNum + 1}: found ${pageKeywordCount} position-1 keywords, total=${topKeywords.length}`);

    // If we found non-position-1 keywords on this page, no need to paginate further
    // (keywords are sorted by position ascending, so once we see position > 1, we're done)
    if (foundNonPosition1 || topKeywords.length >= MAX_KEYWORDS) {
      break;
    }

    // Try to click "next page" / pagination button
    try {
      const nextButton = page.locator("[data-at='pagination-next'], .pagination__next, button[aria-label='Next page'], a[rel='next'], .pager__item--next").first();
      const isVisible = await nextButton.isVisible().catch(() => false);
      if (!isVisible) {
        logStep("TopKeywords", "No more pages available");
        break;
      }
      await nextButton.click();
      await page.waitForTimeout(2000); // Wait for new data to load
      try {
        await page.waitForSelector("table, .table, [data-at='positions-table']", { timeout: 8000 });
      } catch {
        logStep("TopKeywords", "Table not found after pagination, stopping");
        break;
      }
    } catch {
      logStep("TopKeywords", "Could not find or click next page button, stopping");
      break;
    }
  }

  logStep("TopKeywords", `Extracted ${topKeywords.length} position-1 keywords total`);
  return topKeywords;
}

/**
 * Try to extract top keywords from captured SEMrush API responses.
 * SEMrush API typically returns keyword data with fields like:
 *   Ph = keyword phrase, Po = position, Tr = traffic
 * This is more reliable than DOM scraping when API responses are available.
 */
function extractKeywordsFromApiData(capturedApiData: { url: string; body: any }[]): TopKeyword[] {
  const topKeywords: TopKeyword[] = [];
  const MAX_KEYWORDS = 200;
  const seenKeywords = new Set<string>();

  for (const apiResponse of capturedApiData) {
    try {
      // Only look at responses that might contain position/keyword data
      const url = apiResponse.url;
      if (!url.includes('organic') && !url.includes('positions') && !url.includes('analytics')) continue;

      const bodyStr = JSON.stringify(apiResponse.body);

      // Try to find keyword data arrays in the API response
      // SEMrush API format: data arrays with Ph (phrase), Po (position), Tr (traffic) fields
      const dataMatch = bodyStr.match(/"data"\s*:\s*\[([\s\S]*?)\]/);
      if (!dataMatch) continue;

      // Parse individual entries looking for Ph/Po/Tr pattern
      const entryPattern = /\{[^{}]*"Ph"\s*:\s*"([^"]+)"[^{}]*"Po"\s*:\s*(\d+)[^{}]*"Tr"\s*:\s*([\d,.]+)/g;
      let match;
      while ((match = entryPattern.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1];
        const position = parseInt(match[2], 10);
        const traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }

      // Alternative format: "Keyword"/"keyword"/"Ph" with different field names
      const altPattern = /\{[^{}]*"(?:Ph|Keyword|keyword|keyword_phrase)"\s*:\s*"([^"]+)"[^{}]*"(?:Po|Position|position|pos)"\s*:\s*(\d+)[^{}]*"(?:Tr|Traffic|traffic|volume)"\s*:\s*([\d,.]+)/g;
      while ((match = altPattern.exec(bodyStr)) !== null && topKeywords.length < MAX_KEYWORDS) {
        const keyword = match[1];
        const position = parseInt(match[2], 10);
        const traffic = formatNumber(match[3]);
        if (position === 1 && keyword && !seenKeywords.has(keyword.toLowerCase())) {
          seenKeywords.add(keyword.toLowerCase());
          topKeywords.push({ keyword, traffic, position: 1 });
        }
      }
    } catch { continue; }
  }

  if (topKeywords.length > 0) {
    logStep("TopKeywords-API", `Extracted ${topKeywords.length} position-1 keywords from API data`);
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
      await page.waitForTimeout(10000);
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
      await page.waitForTimeout(5000);
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
        // SEMrush API endpoints that return domain analytics data
        if (
          url.includes('/analytics/') ||
          url.includes('/api/') ||
          url.includes('overview') ||
          url.includes('organic') ||
          url.includes('adwords') ||
          url.includes('paid')
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
        await page.goto(positionsUrl, { waitUntil: "load", timeout: 90000 });
        await page.waitForTimeout(10000);
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
      await page.waitForTimeout(3000);
      // Try API extraction first (more reliable)
      topKeywords = extractKeywordsFromApiData(capturedApiData);
      if (topKeywords.length > 0) {
        logStep("SemrushDomain", `Got ${topKeywords.length} keywords from API data`);
      } else {
        // Fall back to DOM scraping with pagination support
        logStep("SemrushDomain", "API extraction yielded no keywords, falling back to DOM scraping...");
        topKeywords = await extractTopKeywords(page);
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
    await page.waitForTimeout(8000);

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
      } else if (url.pathname === "/api/semrush/ads" && req.method === "POST") {
        const request = await makeRequest();
        const response = await handleSemrushAds(request);
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

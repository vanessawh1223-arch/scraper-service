import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

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
  // Format: user:pass@host:port
  const atIdx = proxyStr.indexOf("@");
  if (atIdx === -1) {
    return { server: `http://${proxyStr}` };
  }
  const credentials = proxyStr.slice(0, atIdx);
  const hostPort = proxyStr.slice(atIdx + 1);
  const [username, password] = credentials.split(":");
  return {
    server: `http://${hostPort}`,
    username,
    password,
  };
}

function hasTrackingParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "msclkid",
      "ref",
      "affiliate_id",
      "clickid",
      "subid",
    ];
    return trackingParams.some((param) => parsed.searchParams.has(param));
  } catch {
    return false;
  }
}

function isSubdomain(domain: string): boolean {
  const parts = domain.split(".");
  // e.g. blog.vevor.com → 3 parts, vevor.com → 2 parts
  if (parts.length <= 2) return false;
  // Exclude www
  if (parts[0] === "www") return parts.length > 3;
  return true;
}

function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  // Return last two parts (e.g. blog.vevor.com → vevor.com)
  return parts.slice(-2).join(".");
}

function formatNumber(str: string): number {
  if (!str) return 0;
  // Remove commas, spaces, K/M/B suffixes
  const cleaned = str.replace(/,/g, "").replace(/\s/g, "").trim();
  if (cleaned.endsWith("K") || cleaned.endsWith("k")) {
    return Math.round(parseFloat(cleaned) * 1000);
  }
  if (cleaned.endsWith("M") || cleaned.endsWith("m")) {
    return Math.round(parseFloat(cleaned) * 1_000_000);
  }
  if (cleaned.endsWith("B") || cleaned.endsWith("b")) {
    return Math.round(parseFloat(cleaned) * 1_000_000_000);
  }
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

// Timestamp prefix for logs
function logStep(step: string, ...args: unknown[]) {
  const ts = new Date().toISOString().substr(11, 12);
  console.log(`[${ts}] [${step}]`, ...args);
}

// ---------------------------------------------------------------------------
// URL Comparison Helpers
// ---------------------------------------------------------------------------

// Compare URLs ignoring trailing slash and hash
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

// Check if URL is a chrome error page
function isChromeError(url: string): boolean {
  return url.startsWith("chrome-error://") || url === "about:blank";
}

// ---------------------------------------------------------------------------
// Route Bypass - ONLY for extract endpoint, NOT for SEMrush
// Bypasses Chromium's SubresourceFilter blocking
// ---------------------------------------------------------------------------

async function setupRouteBypass(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();

    // Only intercept document (navigation) requests
    // Non-navigation requests (images/scripts) won't be blocked by SubresourceFilter
    if (request.resourceType() !== "document") {
      await route.continue();
      return;
    }

    try {
      // route.fetch() uses Playwright's HTTP client, NOT Chromium's network stack
      // This completely bypasses SubresourceFilter!
      // maxRedirects: 0 makes browser follow redirects step by step
      const response = await route.fetch({ maxRedirects: 0 });
      const status = response.status();

      if (status >= 300 && status < 400) {
        // 3xx redirect: fulfill as redirect response
        // Browser will automatically request the Location URL (which gets intercepted again)
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers())) {
          if (["content-length", "content-encoding", "content-type"].includes(key.toLowerCase())) continue;
          headers[key] = value;
        }
        await route.fulfill({ status, headers, body: "" });
        return;
      }

      // Non-3xx: fulfill complete response (browser renders HTML, executes JS)
      await route.fulfill({ response });
    } catch {
      // If route.fetch fails, fall back to route.continue()
      try {
        await route.continue();
      } catch {}
    }
  });
}

// ---------------------------------------------------------------------------
// Playwright Browser Helpers
// ---------------------------------------------------------------------------

async function launchBrowser(proxy?: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=SubresourceFilter,SafeBrowsing,OptimizationGuideModelDownloading,OptimizationHints,OptimizationTargetPrediction,PrivacySandboxSettings4",
      "--disable-web-security",
      "--disable-extensions",
      "--no-first-run",
    ],
  };

  if (proxy) {
    const proxyConfig = parseProxy(proxy);
    launchOptions.proxy = proxyConfig;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  return { browser, context };
}

// Launch a browser specifically for SEMrush — NO route bypass, just anti-detection
async function launchSemrushBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const { browser, context } = await launchBrowser();

  // Anti-detection only — NO route bypass for SEMrush
  // Route bypass breaks proxy authentication by intercepting cookies/sessions
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };
  });

  return { browser, context };
}

async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (err) {
    console.error("Error closing browser:", err);
  }
}

// ---------------------------------------------------------------------------
// 5-Phase Extraction Strategy (for /api/extract only)
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string
): Promise<{ success: boolean; landingPageUrl: string | null; redirectChain: string[]; finalUrl: string | null }> {
  const { browser, context } = await launchBrowser(proxyUrl);

  // CRITICAL: Setup route bypass BEFORE creating page — only for extract!
  await setupRouteBypass(context);

  // Anti-detection initScript - must be before newPage()
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };
  });

  const page = await context.newPage();
  const redirectChain: string[] = [];
  let previousUrl = affiliateLink;

  // Track redirects via response events (only main frame document requests)
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
    // Phase 1: Navigate to affiliate link, waitUntil: 'load'
    // (not 'domcontentloaded' - we need JS to execute)
    await page.goto(affiliateLink, { waitUntil: "load", timeout: 60000 });
  } catch (navError) {
    // Navigation may fail but the page might have still loaded enough
    const errMsg = navError instanceof Error ? navError.message : String(navError);
    console.warn("Phase 1 navigation warning:", errMsg);
  }

  currentUrl = page.url();

  // If URL already changed, we might be done
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    const landingPageUrl = currentUrl;
    await browser.close();
    return {
      success: !!landingPageUrl,
      landingPageUrl,
      redirectChain,
      finalUrl: landingPageUrl,
    };
  }

  // Phase 2: Wait for URL change (20 seconds) - handles JS delayed redirects
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try {
      await page.waitForURL(
        (url) => {
          const urlStr = url.toString();
          return !isSameUrl(urlStr, affiliateLink) && !isChromeError(urlStr);
        },
        { timeout: 20000 }
      );
      currentUrl = page.url();
    } catch {
      // URL didn't change, might be on the same page
    }
  }

  // Phase 3: Wait for network idle
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {}

  currentUrl = page.url();

  // Phase 4: Parse page content for redirect URLs
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    // Check for meta refresh
    const metaRefreshUrl = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      if (meta) {
        const content = meta.getAttribute("content") || "";
        const match = content.match(/url=(.+)/i);
        return match ? match[1].trim() : null;
      }
      return null;
    });

    if (metaRefreshUrl) {
      try {
        await page.goto(metaRefreshUrl, { waitUntil: "load", timeout: 60000 });
        currentUrl = page.url();
      } catch (navError) {
        console.warn("Phase 4 meta refresh navigation warning:", navError instanceof Error ? navError.message : String(navError));
      }
    }

    // Check for JS redirects
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const jsRedirectUrl = await page.evaluate(() => {
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
          const text = script.textContent || "";
          const match = text.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
          if (match) return match[1];
          const match2 = text.match(/location\.replace\(['"]([^'"]+)['"]\)/);
          if (match2) return match2[1];
        }
        return null;
      });

      if (jsRedirectUrl) {
        try {
          await page.goto(jsRedirectUrl, { waitUntil: "load", timeout: 60000 });
          currentUrl = page.url();
        } catch (navError) {
          console.warn("Phase 4 JS redirect navigation warning:", navError instanceof Error ? navError.message : String(navError));
        }
      }
    }

    // Check for iframe redirects
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const iframeUrl = await page.evaluate(() => {
        const iframe = document.querySelector("iframe[src]");
        return iframe ? iframe.getAttribute("src") : null;
      });

      if (iframeUrl && iframeUrl.startsWith("http")) {
        try {
          await page.goto(iframeUrl, { waitUntil: "load", timeout: 60000 });
          currentUrl = page.url();
        } catch (navError) {
          console.warn("Phase 4 iframe redirect navigation warning:", navError instanceof Error ? navError.message : String(navError));
        }
      }
    }
  }

  // Phase 5: Second navigation with networkidle as fallback
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try {
      await page.goto(affiliateLink, { waitUntil: "networkidle", timeout: 45000 });
      currentUrl = page.url();
    } catch {}
  }

  // Final URL
  const landingPageUrl = isChromeError(currentUrl) || isSameUrl(currentUrl, affiliateLink) ? null : currentUrl;

  await browser.close();

  return {
    success: !!landingPageUrl,
    landingPageUrl,
    redirectChain,
    finalUrl: landingPageUrl,
  };
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/extract
// ---------------------------------------------------------------------------

async function handleExtract(req: Request): Promise<Response> {
  let body: ExtractRequest;
  try {
    body = (await req.json()) as ExtractRequest;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { url, proxy } = body;

  if (!url) {
    return jsonResponse({ success: false, error: "URL is required" }, 400);
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return jsonResponse({ success: false, error: "Invalid URL format" }, 400);
  }

  try {
    const result = await extractOnce(url, proxy);

    return jsonResponse({
      success: result.success,
      landingPageUrl: result.landingPageUrl,
      redirectChain: result.redirectChain,
      finalUrl: result.finalUrl,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes("proxy") || errMsg.includes("Proxy") || errMsg.includes("ERR_PROXY_CONNECTION_FAILED")) {
      return jsonResponse(
        {
          success: false,
          error: "Proxy connection failed",
          details: errMsg,
        },
        502
      );
    }

    if (errMsg.includes("Timeout") || errMsg.includes("timeout")) {
      return jsonResponse(
        {
          success: false,
          error: "Page navigation timed out",
          details: errMsg,
        },
        504
      );
    }

    return jsonResponse(
      {
        success: false,
        error: "Extraction failed",
        details: errMsg,
      },
      500
    );
  }
}

// ---------------------------------------------------------------------------
// SEMrush Login Helper
// Supports two types of login pages:
// 1. Gateway/proxy pages (like gwt.tuanai.me) — JS auto-redirects, no input fields
// 2. Traditional login forms — has username/password input fields
//
// IMPORTANT: This function must be used with a context that does NOT have
// setupRouteBypass applied. Route bypass breaks proxy authentication.
// ---------------------------------------------------------------------------

async function semrushLogin(
  context: BrowserContext,
  loginUrl: string,
  cardNumber: string,
  password: string
): Promise<{ page: Page; proxyBaseUrl: string | null }> {
  logStep("SEMrush-Login", "Starting login flow, loginUrl:", loginUrl);

  const page = await context.newPage();

  // Navigate to login URL — use 'load' to ensure JS executes
  try {
    logStep("SEMrush-Login", "Navigating to login URL...");
    await page.goto(loginUrl, { waitUntil: "load", timeout: 60000 });
    logStep("SEMrush-Login", "Login page loaded, URL:", page.url());
  } catch (navError) {
    // Navigation might timeout but page could still be loaded enough
    logStep("SEMrush-Login", "Navigation warning:", navError instanceof Error ? navError.message : String(navError));
  }

  // Wait for JS to execute (node selector pages need time to test nodes)
  await page.waitForTimeout(5000);

  // Check if we already got redirected to SEMrush (gateway auto-redirect)
  let currentUrl = page.url();
  logStep("SEmrush-Login", "Current URL after initial load:", currentUrl);

  // Check if the URL has changed from the login URL (meaning we've been redirected)
  const loginHost = new URL(loginUrl).hostname;
  let currentHost: string;
  try {
    currentHost = new URL(currentUrl).hostname;
  } catch {
    currentHost = currentUrl;
  }

  if (currentHost !== loginHost && !isChromeError(currentUrl)) {
    logStep("SEMrush-Login", "Already redirected after initial navigation to:", currentUrl);
    // We've been redirected — likely to a proxy domain serving SEMrush
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    return { page, proxyBaseUrl: extractProxyBaseUrl(currentUrl) };
  }

  // Check if this page has input fields (traditional login form)
  const hasVisibleInputs = await page.locator('input:not([type="hidden"])').count() > 0;
  logStep("SEMrush-Login", "Has visible inputs:", hasVisibleInputs);

  if (hasVisibleInputs) {
    // ── Traditional Login Flow ──
    logStep("SEMrush-Login", "Detected traditional login form, filling credentials...");

    // Try to find and fill the card number / username field
    const usernameSelectors = [
      'input[name="card"]',
      'input[name="cardNumber"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[type="text"]',
      'input[placeholder*="card" i]',
      'input[placeholder*="number" i]',
      'input[placeholder*="account" i]',
      'input:not([type="password"]):not([type="hidden"])',
    ];

    let filledUsername = false;
    for (const selector of usernameSelectors) {
      try {
        const el = page.locator(selector).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click();
          await el.fill(cardNumber);
          filledUsername = true;
          logStep("SEMrush-Login", "Filled username with selector:", selector);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!filledUsername) {
      throw new Error("Could not find username/card number input field on login page");
    }

    // Find and fill the password field
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[placeholder*="password" i]',
    ];

    let filledPassword = false;
    for (const selector of passwordSelectors) {
      try {
        const el = page.locator(selector).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click();
          await el.fill(password);
          filledPassword = true;
          logStep("SEMrush-Login", "Filled password with selector:", selector);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!filledPassword) {
      throw new Error("Could not find password input field on login page");
    }

    // Click login/submit button
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Submit")',
      "form button",
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        const el = page.locator(selector).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          await el.click();
          submitted = true;
          logStep("SEMrush-Login", "Clicked submit with selector:", selector);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!submitted) {
      logStep("SEMrush-Login", "No submit button found, pressing Enter");
      await page.keyboard.press("Enter");
    }

    // Wait for navigation after login — check if URL changes from login page
    try {
      await page.waitForURL(
        (url) => {
          try {
            return new URL(url.toString()).hostname !== loginHost;
          } catch {
            return false;
          }
        },
        { timeout: 30000 }
      );
      logStep("SEMrush-Login", "URL changed after login to:", page.url());
    } catch {
      // Give extra time
      logStep("SEMrush-Login", "URL change timeout, waiting more...");
      await page.waitForTimeout(5000);
    }
  } else {
    // ── Gateway/Proxy Page Flow ──
    // Pages like gwt.tuanai.me auto-select nodes and redirect to SEMrush
    // No input fields needed — just wait for the JS redirect
    logStep("SEMrush-Login", "Detected gateway/proxy page (no input fields), waiting for auto-redirect...");

    // Take a screenshot for debugging (only in development)
    try {
      const screenshot = await page.screenshot({ fullPage: true });
      logStep("SEMrush-Login", `Gateway page screenshot size: ${screenshot.length} bytes`);
    } catch {}

    // Log the page content for debugging
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || "empty");
      logStep("SEMrush-Login", "Gateway page text:", bodyText);
    } catch {}

    // Wait for the JS to complete node testing and redirect
    // Strategy: Poll the URL every few seconds to detect domain change
    const maxWaitMs = 90000; // 90 seconds total for gateway redirect
    const pollIntervalMs = 3000;
    const startTime = Date.now();
    let redirected = false;

    while (Date.now() - startTime < maxWaitMs) {
      currentUrl = page.url();
      try {
        currentHost = new URL(currentUrl).hostname;
      } catch {
        currentHost = currentUrl;
      }

      if (currentHost !== loginHost && !isChromeError(currentUrl)) {
        logStep("SEMrush-Login", "Gateway redirected to:", currentUrl);
        redirected = true;
        break;
      }

      // Also check if the page has navigated away (some redirects are pushState)
      try {
        const currentHref = await page.evaluate(() => window.location.href);
        if (currentHref !== currentUrl) {
          logStep("SEMrush-Login", "Detected pushState navigation to:", currentHref);
          currentUrl = currentHref;
          try {
            currentHost = new URL(currentHref).hostname;
          } catch {
            currentHost = currentHref;
          }
          if (currentHost !== loginHost) {
            redirected = true;
            break;
          }
        }
      } catch {}

      // Check for auto-clicking opportunities (node selection buttons)
      try {
        const clickableNodes = page.locator('.node-card, [class*="node"], a[href*="http"], button:has-text("Go"), button:has-text("Enter"), button:has-text("Connect")');
        if ((await clickableNodes.count()) > 0) {
          logStep("SEMrush-Login", "Found clickable nodes, clicking first...");
          await clickableNodes.first().click();
          await page.waitForTimeout(5000);
        }
      } catch {}

      await page.waitForTimeout(pollIntervalMs);
    }

    if (!redirected) {
      // Final check
      currentUrl = page.url();
      try {
        currentHost = new URL(currentUrl).hostname;
      } catch {
        currentHost = currentUrl;
      }

      if (currentHost === loginHost) {
        // Try to get more diagnostic info
        const pageTitle = await page.title().catch(() => "unknown");
        const bodySnippet = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || "empty").catch(() => "error");
        throw new Error(
          `Gateway page did not redirect within ${maxWaitMs / 1000}s. Title: "${pageTitle}", URL: ${currentUrl}, Body: ${bodySnippet}`
        );
      }
    }

    // We've left the gateway — we're on a SEMrush proxy
    logStep("SEMrush-Login", "Gateway redirect successful, waiting for page to settle...");
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Final: verify we're on a SEMrush-like page
  currentUrl = page.url();
  logStep("SEMrush-Login", "Final URL after login:", currentUrl);

  // Wait for the page to be interactive
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Verify the page has SEMrush-like content
  const isSemrushLike = await isPageSemrushLike(page);
  logStep("SEMrush-Login", "Page is SEMrush-like:", isSemrushLike);

  return { page, proxyBaseUrl: extractProxyBaseUrl(currentUrl) };
}

// Extract the base URL from a proxy page URL
// e.g., https://seo-abc.example.com/dashboard → https://seo-abc.example.com
function extractProxyBaseUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // If on semrush.com, no proxy base needed
    if (urlObj.hostname.includes("semrush.com")) {
      return null;
    }
    // Otherwise, return the protocol + host as the base URL
    return `${urlObj.protocol}//${urlObj.host}`;
  } catch {
    return null;
  }
}

// Check if a page has SEMrush-like content
async function isPageSemrushLike(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes("semrush")) return true;

    // Check for SEMrush-specific elements in the page
    const hasSemrushElements = await page.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      return html.includes("semrush") || html.includes("organic traffic") || html.includes("domain overview");
    });
    return hasSemrushElements;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SEMrush Data Extraction Helpers
// ---------------------------------------------------------------------------

async function extractOrganicTraffic(page: Page): Promise<number> {
  let organicTraffic = 0;

  // Strategy 1: Try SEMrush data-at selectors
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
    } catch {
      continue;
    }
  }

  // Strategy 2: Find by text content "Organic Traffic"
  try {
    const organicLabel = page.locator('text=Organic Traffic').first();
    if ((await organicLabel.count()) > 0) {
      // Walk up to find the nearest number
      const parent = organicLabel.locator('..');
      const numberText = await parent.textContent();
      if (numberText) {
        const numMatch = numberText.match(/([\d,.KMB]+)\s*(?:visits|traffic)?/i);
        if (numMatch) {
          organicTraffic = formatNumber(numMatch[1]);
          if (organicTraffic > 0) {
            logStep("OrganicTraffic", `Found by text label: ${numMatch[1]} → ${organicTraffic}`);
            return organicTraffic;
          }
        }
      }
    }
  } catch {}

  // Strategy 3: Regex from page HTML content
  try {
    const pageContent = await page.content();
    const organicPatterns = [
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
        if (text.toLowerCase().includes('organic') || text.toLowerCase().includes('traffic')) {
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

  return organicTraffic;
}

async function extractPaidTraffic(page: Page): Promise<number> {
  let paidTraffic = 0;

  // Strategy 1: SEMrush data-at selectors
  const paidSelectors = [
    '[data-at="adwords-traffic"] .traffic-value',
    '[data-at="paid-traffic"]',
    '.overview-paid .traffic-value',
    '[data-at="paid-traffic"]',
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
    } catch {
      continue;
    }
  }

  // Strategy 2: Find by text "Paid Traffic"
  try {
    const paidLabel = page.locator('text=Paid Traffic').first();
    if ((await paidLabel.count()) > 0) {
      const parent = paidLabel.locator('..');
      const numberText = await parent.textContent();
      if (numberText) {
        const numMatch = numberText.match(/([\d,.KMB]+)/i);
        if (numMatch) {
          paidTraffic = formatNumber(numMatch[1]);
          if (paidTraffic > 0) {
            logStep("PaidTraffic", `Found by text label: ${numMatch[1]} → ${paidTraffic}`);
            return paidTraffic;
          }
        }
      }
    }
  } catch {}

  // Strategy 3: Regex from page content
  try {
    const pageContent = await page.content();
    const paidMatch = pageContent.match(/paid\s*(?:traffic|search)[^]*?([\d,.]+\s*[KMB]?)/i);
    if (paidMatch) {
      paidTraffic = formatNumber(paidMatch[1]);
      if (paidTraffic > 0) {
        logStep("PaidTraffic", `Found by regex: ${paidMatch[1]} → ${paidTraffic}`);
      }
    }
  } catch {}

  return paidTraffic;
}

async function extractTopKeywords(page: Page): Promise<TopKeyword[]> {
  const topKeywords: TopKeyword[] = [];

  // Try to wait for the table
  try {
    await page.waitForSelector("table, .table, [data-at='positions-table']", { timeout: 10000 });
  } catch {
    // Table may have different selector
  }

  // Extract keywords from the table
  const rows = await page.locator("table tbody tr, .table__row").all();
  const keywordLimit = Math.min(rows.length, 20);

  for (let i = 0; i < keywordLimit && topKeywords.length < 5; i++) {
    try {
      const row = rows[i];
      const cells = await row.locator("td, .table__cell").all();

      if (cells.length >= 3) {
        const keywordText = (await cells[0].textContent())?.trim() || "";
        const positionText = (await cells[1].textContent())?.trim() || "";
        const trafficText = (await cells[2].textContent())?.trim() || "";

        const position = parseInt(positionText, 10);

        if (position === 1 && keywordText) {
          topKeywords.push({
            keyword: keywordText,
            traffic: formatNumber(trafficText),
            position: 1,
          });
        }
      }
    } catch {
      continue;
    }
  }

  logStep("TopKeywords", `Extracted ${topKeywords.length} position-1 keywords`);
  return topKeywords;
}

// Navigate to a SEMrush page with robust error handling
async function navigateToSemrushPage(
  page: Page,
  baseUrl: string,
  path: string,
  domain: string,
  countryDb: string
): Promise<boolean> {
  const url = `${baseUrl}${path}?q=${encodeURIComponent(domain)}&db=${countryDb}`;
  logStep("Navigate", `Navigating to: ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    logStep("Navigate", "Page domcontentloaded, URL:", page.url());

    // Wait for the page to fully render
    await page.waitForTimeout(5000);

    // Wait for content to appear (with timeout)
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}

    const pageTitle = await page.title();
    logStep("Navigate", `Page title: "${pageTitle}"`);

    // Check if we got redirected to a login page (session expired)
    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("signin")) {
      logStep("Navigate", "WARNING: Redirected to login page - session may have expired");
      return false;
    }

    return true;
  } catch (err) {
    logStep("Navigate", "Navigation failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/domain
// ---------------------------------------------------------------------------

async function handleSemrushDomain(req: Request): Promise<Response> {
  let body: SemrushDomainRequest;
  try {
    body = (await req.json()) as SemrushDomainRequest;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { domain, country = "US", loginUrl, cardNumber, password } = body;

  if (!domain || !loginUrl || !cardNumber || !password) {
    return jsonResponse(
      { success: false, error: "domain, loginUrl, cardNumber, and password are required" },
      400
    );
  }

  logStep("SemrushDomain", `Starting domain query: ${domain} (${country})`);

  let browser: Browser | null = null;

  try {
    // Use SEMrush-specific browser launch (NO route bypass!)
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    // Step 1: Login to SEMrush
    logStep("SemrushDomain", "Step 1: Logging in to SEMrush...");
    const { page, proxyBaseUrl } = await semrushLogin(context, loginUrl, cardNumber, password);

    // Determine the base URL for SEMrush navigation
    const semrushBaseUrl = proxyBaseUrl || "https://www.semrush.com";
    logStep("SemrushDomain", `Using base URL: ${semrushBaseUrl}`);

    const countryDb = country.toUpperCase();

    // Step 2: Navigate to domain overview
    logStep("SemrushDomain", "Step 2: Navigating to domain overview...");
    const overviewOk = await navigateToSemrushPage(
      page, semrushBaseUrl, "/analytics/overview/", domain, countryDb
    );

    if (!overviewOk) {
      throw new Error("Failed to load domain overview page (session may have expired or page redirected to login)");
    }

    // Wait for overview metrics to appear
    try {
      await page.waitForSelector(
        '[data-at="overview-traffic"], .overview-metric, .traffic-value, [class*="traffic"], [class*="overview"], [class*="metric"]',
        { timeout: 15000 }
      );
      logStep("SemrushDomain", "Overview metrics found on page");
    } catch {
      logStep("SemrushDomain", "Overview selector wait timed out, proceeding with extraction...");
      await page.waitForTimeout(5000);
    }

    // Step 3: Extract organic traffic
    logStep("SemrushDomain", "Step 3: Extracting organic traffic...");
    const organicTraffic = await extractOrganicTraffic(page);
    logStep("SemrushDomain", `Organic traffic: ${organicTraffic}`);

    // Step 4: Extract paid traffic
    logStep("SemrushDomain", "Step 4: Extracting paid traffic...");
    const paidTraffic = await extractPaidTraffic(page);
    logStep("SemrushDomain", `Paid traffic: ${paidTraffic}`);

    // Step 5: Navigate to organic positions for top keywords
    logStep("SemrushDomain", "Step 5: Extracting top keywords...");
    let topKeywords: TopKeyword[] = [];
    const positionsOk = await navigateToSemrushPage(
      page, semrushBaseUrl, "/analytics/organic/positions/", domain, countryDb
    );

    if (positionsOk) {
      await page.waitForTimeout(3000);
      topKeywords = await extractTopKeywords(page);
    } else {
      logStep("SemrushDomain", "Could not load positions page, skipping keyword extraction");
    }

    // Step 6: Check if domain is a subdomain and get root domain data
    let rootDomainData: {
      domain: string;
      organicTraffic: number;
      paidTraffic: number;
    } | null = null;

    if (isSubdomain(domain)) {
      logStep("SemrushDomain", "Step 6: Domain is subdomain, fetching root domain data...");
      const rootDomain = getRootDomain(domain);
      const rootOk = await navigateToSemrushPage(
        page, semrushBaseUrl, "/analytics/overview/", rootDomain, countryDb
      );

      if (rootOk) {
        const rootOrganicTraffic = await extractOrganicTraffic(page);
        const rootPaidTraffic = await extractPaidTraffic(page);

        rootDomainData = {
          domain: rootDomain,
          organicTraffic: rootOrganicTraffic,
          paidTraffic: rootPaidTraffic,
        };
        logStep("SemrushDomain", `Root domain data: organic=${rootOrganicTraffic}, paid=${rootPaidTraffic}`);
      }
    } else {
      logStep("SemrushDomain", "Step 6: Not a subdomain, skipping root domain lookup");
    }

    await closeBrowser(browser);

    logStep("SemrushDomain", `SUCCESS: organic=${organicTraffic}, paid=${paidTraffic}, keywords=${topKeywords.length}`);

    return jsonResponse({
      success: true,
      domain,
      country: countryDb,
      isSubdomain: isSubdomain(domain),
      organicTraffic,
      paidTraffic,
      topKeywords,
      rootDomainData,
    });
  } catch (err) {
    if (browser) await closeBrowser(browser);

    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushDomain", `FAILED: ${errMsg}`);

    // Categorize the error for better user feedback
    if (errMsg.includes("login") || errMsg.includes("Login") || errMsg.includes("Could not find")) {
      return jsonResponse(
        {
          success: false,
          error: "SEMrush login failed",
          details: errMsg,
        },
        401
      );
    }

    if (errMsg.includes("Gateway page did not redirect")) {
      return jsonResponse(
        {
          success: false,
          error: "SEMrush gateway redirect failed",
          details: errMsg,
        },
        502
      );
    }

    if (errMsg.includes("session may have expired")) {
      return jsonResponse(
        {
          success: false,
          error: "SEMrush session expired",
          details: errMsg,
        },
        401
      );
    }

    return jsonResponse(
      {
        success: false,
        error: "SEMrush domain scraping failed",
        details: errMsg,
      },
      500
    );
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/semrush/ads
// ---------------------------------------------------------------------------

async function handleSemrushAds(req: Request): Promise<Response> {
  let body: SemrushAdsRequest;
  try {
    body = (await req.json()) as SemrushAdsRequest;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { domain, country = "US", loginUrl, cardNumber, password } = body;

  if (!domain || !loginUrl || !cardNumber || !password) {
    return jsonResponse(
      { success: false, error: "domain, loginUrl, cardNumber, and password are required" },
      400
    );
  }

  logStep("SemrushAds", `Starting ad copies query: ${domain} (${country})`);

  let browser: Browser | null = null;

  try {
    // Use SEMrush-specific browser launch (NO route bypass!)
    const { browser: launchedBrowser, context } = await launchSemrushBrowser();
    browser = launchedBrowser;

    // Step 1: Login to SEMrush
    logStep("SemrushAds", "Step 1: Logging in to SEMrush...");
    const { page, proxyBaseUrl } = await semrushLogin(context, loginUrl, cardNumber, password);

    // Determine the base URL for SEMrush navigation
    const semrushBaseUrl = proxyBaseUrl || "https://www.semrush.com";
    logStep("SemrushAds", `Using base URL: ${semrushBaseUrl}`);

    const countryDb = country.toUpperCase();

    // Step 2: Navigate to ad copies page
    logStep("SemrushAds", "Step 2: Navigating to ad copies page...");
    const adCopiesUrl = `${semrushBaseUrl}/advertising/copies/?q=${encodeURIComponent(domain)}&db=${countryDb}&display_type=text`;

    await page.goto(adCopiesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(8000);

    // Wait for the table or ad listings to appear
    try {
      await page.waitForSelector("table, .table, [data-at='ad-copies-table'], .ad-copy", {
        timeout: 15000,
      });
    } catch {
      // May have different layout
    }

    // Extract ad titles and descriptions
    const titles: AdTitle[] = [];
    const descriptions: AdDescription[] = [];

    // Strategy 1: Look for structured table rows
    const rows = await page.locator("table tbody tr, .table__row").all();
    for (let i = 0; i < rows.length && titles.length < 15; i++) {
      try {
        const row = rows[i];
        const cells = await row.locator("td, .table__cell").all();

        if (cells.length >= 2) {
          const titleText = (await cells[0].textContent())?.trim() || "";
          if (titleText && titles.length < 15) {
            titles.push({ text: titleText, source: "scraped" });
          }

          if (cells.length >= 2 && descriptions.length < 4) {
            const descText = (await cells[1].textContent())?.trim() || "";
            if (descText && descText !== titleText) {
              descriptions.push({ text: descText, source: "scraped" });
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Strategy 2: Specific SEMrush ad copy selectors
    if (titles.length === 0) {
      const adCopySelectors = [
        ".ad-copy__title",
        ".ad-copy__headline",
        "[data-at='ad-title']",
        ".AdCopy__title",
        "h3[class*='ad']",
        "h4[class*='ad']",
        ".copy-title",
      ];

      for (const selector of adCopySelectors) {
        try {
          const elements = await page.locator(selector).all();
          for (let i = 0; i < elements.length && titles.length < 15; i++) {
            const text = (await elements[i].textContent())?.trim() || "";
            if (text) {
              titles.push({ text, source: "scraped" });
            }
          }
          if (titles.length > 0) break;
        } catch {
          continue;
        }
      }
    }

    // Strategy 3: Look for heading elements with ad-like content
    if (titles.length === 0) {
      try {
        const headings = await page.locator("h3, h4, [class*='title'], [class*='headline']").all();
        for (let i = 0; i < headings.length && titles.length < 15; i++) {
          try {
            const text = (await headings[i].textContent())?.trim() || "";
            // Filter out navigation headings and very short text
            if (text && text.length > 10 && text.length < 200) {
              titles.push({ text, source: "scraped" });
            }
          } catch {
            continue;
          }
        }
      } catch {}
    }

    // Extract descriptions from specific elements if not found in table
    if (descriptions.length === 0) {
      const descSelectors = [
        ".ad-copy__description",
        ".ad-copy__text",
        "[data-at='ad-description']",
        ".AdCopy__description",
        "[class*='description']",
      ];

      for (const selector of descSelectors) {
        try {
          const elements = await page.locator(selector).all();
          for (let i = 0; i < elements.length && descriptions.length < 4; i++) {
            const text = (await elements[i].textContent())?.trim() || "";
            if (text && text.length > 20) {
              descriptions.push({ text, source: "scraped" });
            }
          }
          if (descriptions.length > 0) break;
        } catch {
          continue;
        }
      }
    }

    await closeBrowser(browser);

    logStep("SemrushAds", `SUCCESS: ${titles.length} titles, ${descriptions.length} descriptions`);

    return jsonResponse({
      success: true,
      domain,
      country: countryDb,
      titles,
      descriptions,
    });
  } catch (err) {
    if (browser) await closeBrowser(browser);

    const errMsg = err instanceof Error ? err.message : String(err);
    logStep("SemrushAds", `FAILED: ${errMsg}`);

    if (errMsg.includes("login") || errMsg.includes("Login") || errMsg.includes("Could not find")) {
      return jsonResponse(
        {
          success: false,
          error: "SEMrush login failed",
          details: errMsg,
        },
        401
      );
    }

    if (errMsg.includes("Gateway page did not redirect")) {
      return jsonResponse(
        {
          success: false,
          error: "SEMrush gateway redirect failed",
          details: errMsg,
        },
        502
      );
    }

    return jsonResponse(
      {
        success: false,
        error: "SEMrush ad scraping failed",
        details: errMsg,
      },
      500
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const PORT = 3001;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      return jsonResponse({ status: "ok", timestamp: Date.now() });
    }

    // Extract endpoint
    if (url.pathname === "/api/extract" && req.method === "POST") {
      return handleExtract(req);
    }

    // SEMrush domain endpoint
    if (url.pathname === "/api/semrush/domain" && req.method === "POST") {
      return handleSemrushDomain(req);
    }

    // SEMrush ads endpoint
    if (url.pathname === "/api/semrush/ads" && req.method === "POST") {
      return handleSemrushAds(req);
    }

    // 404
    return jsonResponse({ error: "Not found" }, 404);
  },
});

console.log(`Scraper service running on port ${PORT}`);

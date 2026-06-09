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
// Route Bypass - Bypasses Chromium's SubresourceFilter blocking
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

async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (err) {
    console.error("Error closing browser:", err);
  }
}

// ---------------------------------------------------------------------------
// 5-Phase Extraction Strategy
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string
): Promise<{ success: boolean; landingPageUrl: string | null; redirectChain: string[]; finalUrl: string | null }> {
  const { browser, context } = await launchBrowser(proxyUrl);

  // CRITICAL: Setup route bypass BEFORE creating page
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
// ---------------------------------------------------------------------------

async function semrushLogin(
  context: BrowserContext,
  loginUrl: string,
  cardNumber: string,
  password: string
): Promise<Page> {
  const page = await context.newPage();

  // Navigate to login URL
  await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 60000 });

  // Wait for the page to fully load
  await page.waitForTimeout(2000);

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
        break;
      }
    } catch {
      continue;
    }
  }

  if (!submitted) {
    // Try pressing Enter
    await page.keyboard.press("Enter");
  }

  // Wait for navigation after login
  await page.waitForTimeout(5000);

  // Check if we're now on SEMrush
  const currentUrl = page.url();
  if (!currentUrl.includes("semrush") && !currentUrl.includes("tu")) {
    // Give it more time
    await page.waitForTimeout(5000);
  }

  return page;
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

  let browser: Browser | null = null;

  try {
    const { browser: launchedBrowser, context } = await launchBrowser(); // No proxy for SEMrush
    browser = launchedBrowser;

    // Login to SEMrush
    const page = await semrushLogin(context, loginUrl, cardNumber, password);

    // Navigate to domain overview
    const countryDb = country.toUpperCase();
    const semrushDomainUrl = `https://www.semrush.com/analytics/overview/?q=${encodeURIComponent(domain)}&db=${countryDb}`;

    await page.goto(semrushDomainUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for data to load
    await page.waitForTimeout(8000);

    // Wait for the overview metrics to appear
    try {
      await page.waitForSelector('[data-at="overview-traffic"], .overview-metric, .traffic-value', {
        timeout: 15000,
      });
    } catch {
      // Try alternative selectors
    }

    // Extract organic traffic
    let organicTraffic = 0;
    try {
      const organicSelectors = [
        '[data-at="organic-traffic"] .traffic-value',
        '[data-at="overview-traffic"]',
        '.overview-organic .traffic-value',
        'text=Organic Traffic',
      ];

      for (const selector of organicSelectors) {
        try {
          const el = page.locator(selector).first();
          if ((await el.count()) > 0) {
            const text = await el.textContent();
            if (text) {
              organicTraffic = formatNumber(text);
              break;
            }
          }
        } catch {
          continue;
        }
      }

      // Fallback: look for traffic numbers in the page
      if (organicTraffic === 0) {
        const pageContent = await page.content();
        const organicMatch = pageContent.match(/organic[^]*?([\d,.KMB]+)\s*(?:visits|traffic)/i);
        if (organicMatch) {
          organicTraffic = formatNumber(organicMatch[1]);
        }
      }
    } catch (err) {
      console.error("Error extracting organic traffic:", err);
    }

    // Extract paid traffic
    let paidTraffic = 0;
    try {
      const paidSelectors = [
        '[data-at="adwords-traffic"] .traffic-value',
        '[data-at="paid-traffic"]',
        '.overview-paid .traffic-value',
        'text=Paid Traffic',
      ];

      for (const selector of paidSelectors) {
        try {
          const el = page.locator(selector).first();
          if ((await el.count()) > 0) {
            const text = await el.textContent();
            if (text) {
              paidTraffic = formatNumber(text);
              break;
            }
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      console.error("Error extracting paid traffic:", err);
    }

    // Navigate to organic research for top keywords
    const topKeywords: TopKeyword[] = [];
    try {
      const positionsUrl = `https://www.semrush.com/analytics/organic/positions/?q=${encodeURIComponent(domain)}&db=${countryDb}`;
      await page.goto(positionsUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(5000);

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
    } catch (err) {
      console.error("Error extracting top keywords:", err);
    }

    // Check if domain is a subdomain and get root domain data
    let rootDomainData: {
      domain: string;
      organicTraffic: number;
      paidTraffic: number;
    } | null = null;

    if (isSubdomain(domain)) {
      try {
        const rootDomain = getRootDomain(domain);
        const rootDomainUrl = `https://www.semrush.com/analytics/overview/?q=${encodeURIComponent(rootDomain)}&db=${countryDb}`;

        await page.goto(rootDomainUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(5000);

        let rootOrganicTraffic = 0;
        let rootPaidTraffic = 0;

        try {
          const organicSelectors = [
            '[data-at="organic-traffic"] .traffic-value',
            '[data-at="overview-traffic"]',
          ];
          for (const selector of organicSelectors) {
            try {
              const el = page.locator(selector).first();
              if ((await el.count()) > 0) {
                const text = await el.textContent();
                if (text) {
                  rootOrganicTraffic = formatNumber(text);
                  break;
                }
              }
            } catch {
              continue;
            }
          }

          const paidSelectors = [
            '[data-at="adwords-traffic"] .traffic-value',
            '[data-at="paid-traffic"]',
          ];
          for (const selector of paidSelectors) {
            try {
              const el = page.locator(selector).first();
              if ((await el.count()) > 0) {
                const text = await el.textContent();
                if (text) {
                  rootPaidTraffic = formatNumber(text);
                  break;
                }
              }
            } catch {
              continue;
            }
          }
        } catch (err) {
          console.error("Error extracting root domain data:", err);
        }

        rootDomainData = {
          domain: rootDomain,
          organicTraffic: rootOrganicTraffic,
          paidTraffic: rootPaidTraffic,
        };
      } catch (err) {
        console.error("Error fetching root domain data:", err);
      }
    }

    await closeBrowser(browser);

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

  let browser: Browser | null = null;

  try {
    const { browser: launchedBrowser, context } = await launchBrowser();
    browser = launchedBrowser;

    // Login to SEMrush
    const page = await semrushLogin(context, loginUrl, cardNumber, password);

    // Navigate to Advertising Research → Ad Copies
    const countryDb = country.toUpperCase();
    const adCopiesUrl = `https://www.semrush.com/advertising/copies/?q=${encodeURIComponent(domain)}&db=${countryDb}&display_type=text`;

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

    try {
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

      if (descriptions.length === 0) {
        const descSelectors = [
          ".ad-copy__description",
          ".ad-copy__text",
          "[data-at='ad-description']",
          ".AdCopy__description",
          ".copy-description",
          "p[class*='ad']",
        ];

        for (const selector of descSelectors) {
          try {
            const elements = await page.locator(selector).all();
            for (let i = 0; i < elements.length && descriptions.length < 4; i++) {
              const text = (await elements[i].textContent())?.trim() || "";
              if (text) {
                descriptions.push({ text, source: "scraped" });
              }
            }
            if (descriptions.length > 0) break;
          } catch {
            continue;
          }
        }
      }
    } catch (err) {
      console.error("Error extracting ad copies:", err);
    }

    await closeBrowser(browser);

    return jsonResponse({
      success: true,
      titles: titles.slice(0, 15),
      descriptions: descriptions.slice(0, 4),
    });
  } catch (err) {
    if (browser) await closeBrowser(browser);

    const errMsg = err instanceof Error ? err.message : String(err);

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
// Router (Node.js HTTP server - compatible with Docker/Node.js runtime)
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from "http";

const PORT = parseInt(process.env.PORT || "3001", 10);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res: ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function toFetchRequest(req: IncomingMessage, body: string): Request {
  const protocol = (req.headers["x-forwarded-proto"] as string) || "http";
  const host = req.headers.host || "localhost";
  const url = `${protocol}://${host}${req.url}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const method = req.method || "GET";

  // Handle CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    // Health check
    if (url.pathname === "/health" && method === "GET") {
      sendJson(res, { status: "ok", timestamp: Date.now() });
      return;
    }

    // Read body for POST requests
    let fetchReq: Request;
    if (method === "POST") {
      const body = await readBody(req);
      fetchReq = toFetchRequest(req, body);
    } else {
      fetchReq = toFetchRequest(req, "");
    }

    // Extract landing page URL
    if (url.pathname === "/api/extract" && method === "POST") {
      const response = await handleExtract(fetchReq);
      const responseBody = await response.text();
      sendJson(res, JSON.parse(responseBody), response.status);
      return;
    }

    // SEMrush domain overview
    if (url.pathname === "/api/semrush/domain" && method === "POST") {
      const response = await handleSemrushDomain(fetchReq);
      const responseBody = await response.text();
      sendJson(res, JSON.parse(responseBody), response.status);
      return;
    }

    // SEMrush ad copies
    if (url.pathname === "/api/semrush/ads" && method === "POST") {
      const response = await handleSemrushAds(fetchReq);
      const responseBody = await response.text();
      sendJson(res, JSON.parse(responseBody), response.status);
      return;
    }

    // 404
    sendJson(res, { error: "Not found" }, 404);
  } catch (err) {
    console.error("Unhandled error in request handler:", err);
    sendJson(res, {
      success: false,
      error: "Internal server error",
      details: err instanceof Error ? err.message : String(err),
    }, 500);
  }
}

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  server.close(() => process.exit(0));
});

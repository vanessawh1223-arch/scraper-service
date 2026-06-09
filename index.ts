import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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
// Playwright Browser Helpers
// ---------------------------------------------------------------------------

async function launchBrowser(proxy?: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
    ],
  };

  if (proxy) {
    const proxyConfig = parseProxy(proxy);
    launchOptions.proxy = proxyConfig;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
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
// Endpoint: POST /api/extract
// ---------------------------------------------------------------------------

async function handleExtract(req: Request): Promise<Response> {
  let body: ExtractRequest;
  try {
    body = (await req.json()) as ExtractRequest;
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { url, proxy, timeout = 30000 } = body;

  if (!url) {
    return jsonResponse({ success: false, error: "URL is required" }, 400);
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return jsonResponse({ success: false, error: "Invalid URL format" }, 400);
  }

  let browser: Browser | null = null;

  try {
    const { browser: launchedBrowser, context } = await launchBrowser(proxy);
    browser = launchedBrowser;

    const page = await context.newPage();
    const redirectChain: string[] = [url];
    let landingPageUrl = url;

    // Track redirects via response events
    page.on("response", (response) => {
      const responseUrl = response.url();
      const status = response.status();
      // 3xx redirects and navigations
      if (
        (status >= 300 && status < 400) ||
        (responseUrl !== redirectChain[redirectChain.length - 1] && status < 400)
      ) {
        if (!redirectChain.includes(responseUrl)) {
          redirectChain.push(responseUrl);
        }
      }
    });

    // Track URL changes via framenavigated
    page.on("framenavigated", (frame) => {
      const frameUrl = frame.url();
      if (frame === page.mainFrame() && !redirectChain.includes(frameUrl)) {
        redirectChain.push(frameUrl);
      }
    });

    // Navigate to the URL
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });
    } catch (navError) {
      const errMsg = navError instanceof Error ? navError.message : String(navError);
      // If it's a timeout but we have some redirects, we can still return partial data
      if (errMsg.includes("Timeout") && redirectChain.length > 1) {
        const finalUrl = page.url();
        if (finalUrl && finalUrl !== "about:blank" && !redirectChain.includes(finalUrl)) {
          redirectChain.push(finalUrl);
        }
        landingPageUrl = finalUrl || redirectChain[redirectChain.length - 1];
        await closeBrowser(browser);
        return jsonResponse({
          success: true,
          landingPageUrl,
          redirectChain,
          finalUrl: landingPageUrl,
          warning: "Page timed out but partial redirect chain was captured",
        });
      }
      throw navError;
    }

    // Wait a moment for any additional client-side redirects
    await page.waitForTimeout(2000);

    // Get the current URL after any JS redirects
    const currentUrl = page.url();
    if (currentUrl && currentUrl !== "about:blank" && !redirectChain.includes(currentUrl)) {
      redirectChain.push(currentUrl);
    }

    // Determine landing page: find URL with tracking params or use final URL
    landingPageUrl = currentUrl;

    // Check if any URL in the chain has tracking parameters
    for (let i = redirectChain.length - 1; i >= 0; i--) {
      if (hasTrackingParams(redirectChain[i])) {
        landingPageUrl = redirectChain[i];
        break;
      }
    }

    // Wait up to 5 more seconds for additional redirects if we found tracking params
    if (hasTrackingParams(landingPageUrl)) {
      try {
        const navigationPromise = page.waitForNavigation({ timeout: 5000 });
        await navigationPromise;
        const newerUrl = page.url();
        if (newerUrl && newerUrl !== "about:blank" && newerUrl !== currentUrl) {
          if (!redirectChain.includes(newerUrl)) {
            redirectChain.push(newerUrl);
          }
          landingPageUrl = newerUrl;
        }
      } catch {
        // No further navigation happened, that's fine
      }
    }

    await closeBrowser(browser);

    return jsonResponse({
      success: true,
      landingPageUrl,
      redirectChain,
      finalUrl: page.url() || landingPageUrl,
    });
  } catch (err) {
    if (browser) await closeBrowser(browser);

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
// Router
// ---------------------------------------------------------------------------

const PORT = 3001;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      const url = new URL(req.url);
      const method = req.method;

      // Handle CORS preflight
      if (method === "OPTIONS") {
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
      if (url.pathname === "/health" && method === "GET") {
        return jsonResponse({ status: "ok", timestamp: Date.now() });
      }

      // Extract landing page URL
      if (url.pathname === "/api/extract" && method === "POST") {
        return await handleExtract(req);
      }

      // SEMrush domain overview
      if (url.pathname === "/api/semrush/domain" && method === "POST") {
        return await handleSemrushDomain(req);
      }

      // SEMrush ad copies
      if (url.pathname === "/api/semrush/ads" && method === "POST") {
        return await handleSemrushAds(req);
      }

      // 404
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      console.error("Unhandled error in fetch handler:", err);
      return jsonResponse(
        {
          success: false,
          error: "Internal server error",
          details: err instanceof Error ? err.message : String(err),
        },
        500
      );
    }
  },
  error(error) {
    console.error("Bun server error:", error);
    return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },
});

console.log(`Scraper service running on port ${PORT}`);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down...");
  server.stop();
  process.exit(0);
});

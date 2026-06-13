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
  // Handle multi-part TLDs (e.g. co.uk, com.au)
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo) && parts.length <= 3) return false;
  return true;
}

const TWO_PART_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za', 'com.mx',
  'org.uk', 'net.au', 'co.nz', 'com.sg', 'co.kr', 'com.hk', 'co.id'
]);

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
// Route Bypass - for extract endpoint redirect interception
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

async function launchBrowser(proxy?: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const launchOptions: Record<string, unknown> = {
    headless: true,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--disable-blink-features=AutomationControlled",
      "--disable-features=SubresourceFilter,SafeBrowsing",
      "--disable-web-security", "--disable-extensions", "--no-first-run",
      "--js-flags=--max-old-space-size=256", "--disable-soft-reload",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-ipc-flooding-protection",
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

async function closeBrowser(browser: Browser): Promise<void> {
  try { await browser.close(); } catch (err) { console.error("Error closing browser:", err); }
  // Force garbage collection if available (requires --expose-gc flag)
  try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch {}
}

// ---------------------------------------------------------------------------
// 5-Phase Extraction Strategy (for /api/extract)
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
  // Force garbage collection if available (requires --expose-gc flag)
  try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch {}
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
      } else {
        sendJson({ error: "Not found" }, 404);
      }
    } catch (err) {
      console.error("Request handler error:", err);
      sendJson({ error: "Internal server error" }, 500);
    }
  });

// Prevent the process from dying on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

server.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`);
});

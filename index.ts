import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createServer, IncomingMessage, ServerResponse } from "http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractRequest {
  url: string;
  proxy?: string;
  timeout?: number;
  affiliateNetwork?: string;
}

interface ValidationResult {
  valid: boolean;
  isEncodingError: boolean;
  error?: string;
  warning?: string;
}

interface ExtractResult {
  success: boolean;
  landingPageUrl: string | null;
  redirectChain: string[];
  finalUrl: string | null;
  validation?: ValidationResult;
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Affiliate Tracking Parameters Dictionary
// ---------------------------------------------------------------------------

const AFFILIATE_TRACKING_PARAMS: Record<string, string[]> = {
  CJ:           ['cjevent', 'cjsku', 'sid'],
  Impact:       ['irclickid', 'irmpname', 'shareasale_id'],
  ShareASale:   ['sscid', 'afftrack'],
  Awin:         ['awc', 'clickref'],
  Rakuten:      ['ranMID', 'ranEAID', 'ranSiteID'],
  PartnerStack: ['ir_clickid'],
  TradeDoubler: ['tduid'],
  Linkhaitao:   ['kwkuniv', 'clickref', 'awc', 'sid'],
};

const ALL_KNOWN_TRACKING_PARAMS = [...new Set(Object.values(AFFILIATE_TRACKING_PARAMS).flat())];

const GENERIC_ANALYTICS_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gclsrc', 'dclid', 'ref', 'lang', 'locale',
]);

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

function isSubdomain(domain: string): boolean {
  const parts = domain.split(".");
  if (parts.length <= 2) return false;
  if (parts[0] === "www") return parts.length > 3;
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

/** Derive a Referer URL from the affiliate link's origin */
function deriveReferer(affiliateLink: string): string {
  try {
    const url = new URL(affiliateLink);
    return url.origin + '/';
  } catch {
    return '';
  }
}

/** Count digit<->letter transitions in a string (for heuristic tracking param detection) */
function countDigitLetterTransitions(val: string): number {
  let transitions = 0;
  for (let i = 1; i < val.length; i++) {
    const prevIsDigit = /\d/.test(val[i - 1]);
    const currIsDigit = /\d/.test(val[i]);
    if (prevIsDigit !== currIsDigit) transitions++;
  }
  return transitions;
}

// ---------------------------------------------------------------------------
// Layer 1: normalizeTrackingParams — Input-side encoding fix
// ---------------------------------------------------------------------------

/**
 * Fix tracking parameter values that have been incorrectly encoded.
 * Rule: if a param value contains %3A (encoded colon) but NOT %2F (encoded slash),
 * the colon was part of a tracking ID, not a URL -> restore it.
 * If both %3A and %2F are present, it's a legitimate encoded URL -> leave it.
 */
function normalizeTrackingParams(url: string): string {
  try {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return url;

    const base = url.substring(0, qIdx);
    const query = url.substring(qIdx + 1);
    const hashIdx = query.indexOf('#');
    const queryString = hashIdx === -1 ? query : query.substring(0, hashIdx);
    const hash = hashIdx === -1 ? '' : query.substring(hashIdx);

    const params = queryString.split('&');
    const fixedParams = params.map(param => {
      const eqIdx = param.indexOf('=');
      if (eqIdx === -1) return param;
      const key = param.substring(0, eqIdx);
      const value = param.substring(eqIdx + 1);

      if (value.includes('%3A') || value.includes('%3a')) {
        const hasEncodedSlash = value.includes('%2F') || value.includes('%2f');
        if (!hasEncodedSlash) {
          return key + '=' + value.replace(/%3A/gi, ':').replace(/%3a/gi, ':');
        }
      }
      return param;
    });

    return base + '?' + fixedParams.join('&') + hash;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Layer 3: validateTrackingParams — Final validation before accepting
// ---------------------------------------------------------------------------

/**
 * Validate tracking parameters in a URL using a 4-level check:
 * 1. General encoding error check (%3A without %2F -> hard block)
 * 2a. Has known tracking param for the given affiliate network -> pass
 * 2b. Has known tracking param from another network -> pass + warning
 * 2c. Heuristic detection of unknown tracking params -> pass + warning
 * 2d. None of the above -> hard block (dead link)
 */
function validateTrackingParams(url: string, affiliateNetwork?: string): ValidationResult {
  try {
    const parsed = new URL(url);
    const paramEntries = Array.from(parsed.searchParams.entries());

    // No params at all -> pass with warning (tracking may be cookie-based)
    if (paramEntries.length === 0) {
      return { valid: true, isEncodingError: false, warning: 'URL无查询参数，可能缺少追踪参数' };
    }

    // Check 1: General encoding error — check raw URL string for %3A without %2F
    const rawQuery = url.includes('?') ? url.substring(url.indexOf('?') + 1) : '';
    const rawHashIdx = rawQuery.indexOf('#');
    const rawQueryString = rawHashIdx === -1 ? rawQuery : rawQuery.substring(0, rawHashIdx);

    for (const param of rawQueryString.split('&')) {
      const eqIdx = param.indexOf('=');
      if (eqIdx === -1) continue;
      const value = param.substring(eqIdx + 1);
      if (value.includes('%3A') || value.includes('%3a')) {
        const hasEncodedSlash = value.includes('%2F') || value.includes('%2f');
        if (!hasEncodedSlash) {
          return {
            valid: false,
            isEncodingError: true,
            error: `编码错误: 参数"${param.substring(0, eqIdx)}"值含%3A但不含%2F，追踪ID可能被误编码`,
          };
        }
      }
    }

    // Check 2a: Has known tracking param for the given affiliate network
    if (affiliateNetwork && AFFILIATE_TRACKING_PARAMS[affiliateNetwork]) {
      const networkParams = AFFILIATE_TRACKING_PARAMS[affiliateNetwork];
      for (const param of networkParams) {
        if (parsed.searchParams.has(param)) {
          return { valid: true, isEncodingError: false };
        }
      }
    }

    // Check 2b: Has known tracking param from another network
    for (const param of ALL_KNOWN_TRACKING_PARAMS) {
      if (parsed.searchParams.has(param)) {
        return {
          valid: true,
          isEncodingError: false,
          warning: `URL包含其他联盟的已知追踪参数(${param})，可能是子联盟转链`,
        };
      }
    }

    // Check 2c: Heuristic detection of unknown tracking params
    const nonGenericEntries = paramEntries.filter(([k]) => !GENERIC_ANALYTICS_PARAMS.has(k.toLowerCase()));
    const genericEntries = paramEntries.filter(([k]) => GENERIC_ANALYTICS_PARAMS.has(k.toLowerCase()));

    // Non-generic param: len>=8 + contains both digits and letters -> potential Click ID
    for (const [key, value] of nonGenericEntries) {
      if (value.length >= 8 && /\d/.test(value) && /[a-zA-Z]/.test(value)) {
        return {
          valid: true,
          isEncodingError: false,
          warning: `启发式检测: 参数"${key}"可能是追踪ID(len=${value.length})`,
        };
      }
    }

    // Multiple non-generic params -> likely tracking param combo
    if (nonGenericEntries.length >= 2) {
      return {
        valid: true,
        isEncodingError: false,
        warning: `启发式检测: URL含${nonGenericEntries.length}个非通用参数，可能是追踪参数组合`,
      };
    }

    // Generic/UTM param: len>=16 + digit<->letter transitions>=3 -> hash value
    for (const [key, value] of genericEntries) {
      if (value.length >= 16 && countDigitLetterTransitions(value) >= 3) {
        return {
          valid: true,
          isEncodingError: false,
          warning: `启发式检测: UTM参数"${key}"的值看起来像哈希值`,
        };
      }
    }

    // Check 2d: Hard block — no tracking params detected
    return {
      valid: false,
      isEncodingError: false,
      error: '废链拦截: URL未包含任何已知的追踪参数，归因可能断裂',
    };
  } catch {
    return { valid: false, isEncodingError: false, error: 'URL解析失败，无法验证追踪参数' };
  }
}

// ---------------------------------------------------------------------------
// URL Scoring — Select best URL from redirect chain
// ---------------------------------------------------------------------------

/**
 * Score a URL based on tracking parameter completeness.
 * Higher score = more likely to be the correct landing page URL.
 */
function scoreUrl(url: string, affiliateLink: string, affiliateNetwork?: string): number {
  let score = 0;
  try {
    const parsed = new URL(url);
    const affiliateParsed = new URL(affiliateLink);

    // Penalty: URL is on the same domain as the affiliate link (tracking redirect, not landing page)
    if (parsed.hostname === affiliateParsed.hostname || parsed.hostname.endsWith('.' + affiliateParsed.hostname)) {
      score -= 100;
    }

    // Bonus: URL has known tracking params for the given network
    if (affiliateNetwork && AFFILIATE_TRACKING_PARAMS[affiliateNetwork]) {
      const networkParams = AFFILIATE_TRACKING_PARAMS[affiliateNetwork];
      for (const param of networkParams) {
        if (parsed.searchParams.has(param)) {
          score += 50;
          break;
        }
      }
    }

    // Bonus: URL has known tracking params from any network
    for (const param of ALL_KNOWN_TRACKING_PARAMS) {
      if (parsed.searchParams.has(param)) {
        score += 30;
        break;
      }
    }

    // Bonus: number of query parameters
    score += parsed.searchParams.size * 5;

    // Bonus: URL length (slight, more chars = more info)
    score += Math.min(url.length / 100, 10);
  } catch {
    return 0;
  }
  return score;
}

// ---------------------------------------------------------------------------
// HTTP Fallback — Follow redirects without browser
// ---------------------------------------------------------------------------

/**
 * Follow HTTP redirects using Node.js fetch (no browser needed).
 * This is a fallback when Playwright times out or crashes.
 * Does NOT handle JS-based redirects.
 */
async function nodeJsFollowRedirects(
  startUrl: string,
  maxRedirects = 10,
): Promise<{ url: string | null; redirectChain: string[] }> {
  const redirectChain: string[] = [];
  let currentUrl = startUrl;

  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) break;
        currentUrl = new URL(location, currentUrl).href;
        currentUrl = normalizeTrackingParams(currentUrl);
        redirectChain.push(currentUrl);
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  const finalUrl = currentUrl !== startUrl ? currentUrl : null;
  return { url: finalUrl, redirectChain };
}

// ---------------------------------------------------------------------------
// Route Bypass - intercept redirects and capture Location headers
// ---------------------------------------------------------------------------

async function setupRouteBypass(context: BrowserContext, redirectChain: string[]): Promise<void> {
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
        // Capture redirect Location header into the chain
        const location = response.headers()['location'];
        if (location) {
          try {
            const redirectUrl = new URL(location, request.url()).href;
            if (!redirectChain.includes(redirectUrl)) {
              redirectChain.push(redirectUrl);
            }
          } catch {}
        }
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

async function launchBrowser(proxy?: string, referer?: string): Promise<{ browser: Browser; context: BrowserContext }> {
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
  const extraHeaders: Record<string, string> = { "Accept-Language": "en-US,en;q=0.9" };
  if (referer) extraHeaders["Referer"] = referer;

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    extraHTTPHeaders: extraHeaders,
  });
  return { browser, context };
}

async function closeBrowser(browser: Browser): Promise<void> {
  try { await browser.close(); } catch (err) { console.error("Error closing browser:", err); }
  try { if (typeof globalThis.gc === 'function') globalThis.gc(); } catch {}
}

// ---------------------------------------------------------------------------
// Build best result from redirect chain using scoring
// ---------------------------------------------------------------------------

function buildBestResult(
  currentUrl: string,
  redirectChain: string[],
  affiliateLink: string,
  affiliateNetwork?: string,
  usedFallback = false,
): ExtractResult {
  // Layer 1: Normalize all redirect chain URLs
  const normalizedChain = redirectChain.map(u => normalizeTrackingParams(u));
  const normalizedCurrent = normalizeTrackingParams(currentUrl);

  // Build candidate URLs (deduplicated, excluding affiliate link and chrome errors)
  const candidateUrls = new Map<string, number>();
  for (const url of normalizedChain) {
    if (!isSameUrl(url, affiliateLink) && !isChromeError(url) && !candidateUrls.has(url)) {
      candidateUrls.set(url, scoreUrl(url, affiliateLink, affiliateNetwork));
    }
  }
  if (!isSameUrl(normalizedCurrent, affiliateLink) && !isChromeError(normalizedCurrent) && !candidateUrls.has(normalizedCurrent)) {
    candidateUrls.set(normalizedCurrent, scoreUrl(normalizedCurrent, affiliateLink, affiliateNetwork));
  }

  // Pick the best URL (highest score), fallback to currentUrl if no candidates
  let bestUrl = normalizedCurrent;
  let bestScore = candidateUrls.get(normalizedCurrent) ?? -Infinity;

  for (const [url, score] of candidateUrls) {
    if (score > bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  // Layer 2: Re-apply normalization (in case new URL() re-encoded colons internally)
  bestUrl = normalizeTrackingParams(bestUrl);

  // Layer 3: Validate tracking params
  const validation = validateTrackingParams(bestUrl, affiliateNetwork);

  return {
    success: true,
    landingPageUrl: bestUrl,
    redirectChain: normalizedChain,
    finalUrl: bestUrl,
    validation,
    usedFallback,
  };
}

// ---------------------------------------------------------------------------
// 5-Phase Extraction Strategy (improved)
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string,
  affiliateNetwork?: string,
): Promise<ExtractResult> {
  const referer = deriveReferer(affiliateLink);
  const { browser, context } = await launchBrowser(proxyUrl, referer);

  const redirectChain: string[] = [];
  await setupRouteBypass(context, redirectChain);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };
  });

  const page = await context.newPage();
  let previousUrl = affiliateLink;

  // Track URL changes via response events (supplementary to route bypass)
  page.on("response", (response) => {
    const url = response.url();
    const request = response.request();
    if (request.resourceType() !== "document") return;
    if (request.frame() !== page.mainFrame()) return;
    if (!isSameUrl(url, previousUrl) && !redirectChain.includes(url)) {
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
    await closeBrowser(browser);
    return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, false);
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

  await closeBrowser(browser);

  // If Playwright found a landing page, score and validate
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, false);
  }

  // Playwright failed -> try HTTP fallback
  console.log("[Extract] Playwright failed, trying HTTP fallback...");
  try {
    const fallbackResult = await nodeJsFollowRedirects(affiliateLink);
    if (fallbackResult.url) {
      const mergedChain = [...redirectChain, ...fallbackResult.redirectChain];
      const normalizedUrl = normalizeTrackingParams(fallbackResult.url);
      const validation = validateTrackingParams(normalizedUrl, affiliateNetwork);
      return {
        success: true,
        landingPageUrl: normalizedUrl,
        redirectChain: mergedChain.map(u => normalizeTrackingParams(u)),
        finalUrl: normalizedUrl,
        validation,
        usedFallback: true,
      };
    }
  } catch (fallbackErr) {
    console.warn("[Extract] HTTP fallback also failed:", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
  }

  // All methods failed
  return {
    success: false,
    landingPageUrl: null,
    redirectChain: redirectChain.map(u => normalizeTrackingParams(u)),
    finalUrl: null,
    usedFallback: false,
  };
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/extract
// ---------------------------------------------------------------------------

async function handleExtract(req: Request): Promise<Response> {
  let body: ExtractRequest;
  try { body = (await req.json()) as ExtractRequest; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { url, proxy, affiliateNetwork } = body;
  if (!url) return jsonResponse({ success: false, error: "URL is required" }, 400);
  try { new URL(url); } catch { return jsonResponse({ success: false, error: "Invalid URL format" }, 400); }

  try {
    const result = await extractOnce(url, proxy, affiliateNetwork);
    return jsonResponse({
      success: result.success,
      landingPageUrl: result.landingPageUrl,
      redirectChain: result.redirectChain,
      finalUrl: result.finalUrl,
      validation: result.validation,
      usedFallback: result.usedFallback,
    });
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
        req.on("data", (chunk: string) => { body += chunk; });
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

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createServer, IncomingMessage, ServerResponse } from "http";

// Apply stealth plugin to playwright-extra (covers 30+ fingerprint vectors:
// webdriver, chrome runtime, permissions, navigator plugins, languages,
// WebGL vendor, Canvas noise, AudioContext, hardwareConcurrency, etc.)
chromiumExtra.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractRequest {
  url: string;
  proxy?: string;
  timeout?: number;
  affiliateNetwork?: string;
  referer?: string; // Preset Referer from Settings (overrides deriveReferer)
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
// Configuration Constants
// ---------------------------------------------------------------------------

// Browser pool: reuse browser instances per proxy to avoid cold-start overhead.
// Default 3 (covers batch CONCURRENCY=3 with different proxies). Configurable
// via BROWSER_POOL_MAX env var. Each Chromium instance ~150-300MB; 512MB
// container should not exceed 3-4 instances.
const BROWSER_POOL_MAX = parseInt(process.env.BROWSER_POOL_MAX || '3', 10);

// Idle timeout: close browser after 60s of no use to free memory
const BROWSER_IDLE_TIMEOUT_MS = 60_000;

// Leak detection: if inUse > 0 and idle > 5min, force-reset the counter
// (handles cases where tasks crashed without releasing)
const BROWSER_LEAK_THRESHOLD_MS = 5 * 60_000;

// Watchdog: hard kill the process after 6 minutes to let Railway restart
// (prevents drift from accumulated leaks)
const WATCHDOG_TIMEOUT_MS = 6 * 60_000;

// Extractor timeout: single extraction attempt must complete in 90s
const EXTRACTOR_TIMEOUT_MS = 90_000;

// Dynamic domain list for route.fetch() bypass — domains that fail under
// browser native stack (Chromium SubresourceFilter block or HTTP/2 errors)
// get re-fetched via Playwright HTTP client (HTTP/1.1).
const SUBRESOURCE_BLOCKED_DOMAINS = new Set<string>([
  // Category 1: Affiliate redirect middle domains (Chromium blocks these)
  'linksynergy.com', 'click.linksynergy.com',
  'pxf.io', 'impact.com', 'impactradius.com',
  'tkqlhce.com', 'apmebf.com', 'jdoqocy.com', 'kqzyfj.com',
  'anrdoezrs.net', 'emjcd.com',
  'shareasale.com', 'shareasale-analytics.com',
  'awin1.com', 'awin.com',
  'avantlink.com', 'avantmetrics.com',
  'prf.hn', 'partnerize.com',
  'redirectingat.com', 'go.redirectingat.com',
  't.cfjump.com',
  // Category 2: Known HTTP/2 + proxy incompatible landing pages
  'frenchbee.com',
]);

// Domains learned at runtime (added when ERR_HTTP2_PROTOCOL_ERROR detected)
const runtimeBlockedDomains = new Set<string>();

function isSubresourceBlockedDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const blocked of SUBRESOURCE_BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) return true;
    }
    for (const blocked of runtimeBlockedDomains) {
      if (hostname === blocked || hostname.endsWith('.' + blocked)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function addRuntimeBlockedDomain(url: string): void {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname && !SUBRESOURCE_BLOCKED_DOMAINS.has(hostname)) {
      runtimeBlockedDomains.add(hostname);
      console.log(`[RouteBypass] Added runtime blocked domain: ${hostname}`);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Browser Pool (P0-1: reuse browser instances per proxy)
// ---------------------------------------------------------------------------

interface BrowserInstance {
  browser: Browser;
  proxyUrl: string;
  inUse: number;
  lastUsedAt: number;
}

class BrowserPool {
  private pool = new Map<string, BrowserInstance>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every 30s
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
    // Don't keep process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async acquire(proxyUrl: string): Promise<BrowserInstance> {
    const key = proxyUrl || '__no_proxy__';

    let instance = this.pool.get(key);
    if (instance) {
      // Reuse existing instance — wait if currently in use (serialize same-proxy requests)
      while (instance.inUse > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
        // Re-check (instance might have been closed by cleanup)
        instance = this.pool.get(key);
        if (!instance) {
          // Was cleaned up; create a new one
          return this.acquire(proxyUrl);
        }
      }
      instance.inUse = 1;
      instance.lastUsedAt = Date.now();
      return instance;
    }

    // At pool capacity? Evict the oldest idle instance
    if (this.pool.size >= BROWSER_POOL_MAX) {
      this.evictOldestIdle();
    }

    // Launch new browser
    const browser = await this.launchBrowserInternal(proxyUrl);
    instance = {
      browser,
      proxyUrl,
      inUse: 1,
      lastUsedAt: Date.now(),
    };
    this.pool.set(key, instance);
    return instance;
  }

  release(instance: BrowserInstance): void {
    instance.inUse = Math.max(0, instance.inUse - 1);
    instance.lastUsedAt = Date.now();
  }

  private async launchBrowserInternal(proxyUrl: string): Promise<Browser> {
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
    if (proxyUrl) launchOptions.proxy = parseProxy(proxyUrl);
    // Use playwright-extra (with stealth plugin) instead of vanilla chromium
    return await chromiumExtra.launch(launchOptions);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, instance] of this.pool) {
      const idleMs = now - instance.lastUsedAt;
      if (instance.inUse > 0) {
        // Leak detection: inUse>0 but idle for too long → force reset
        if (idleMs > BROWSER_LEAK_THRESHOLD_MS) {
          console.warn(`[BrowserPool] Leak detected: ${key} inUse=${instance.inUse} idle=${idleMs}ms, force-resetting`);
          instance.inUse = 0;
        }
        continue;
      }
      // Idle and not in use → close after timeout
      if (idleMs > BROWSER_IDLE_TIMEOUT_MS) {
        console.log(`[BrowserPool] Closing idle browser: ${key} (idle ${idleMs}ms)`);
        instance.browser.close().catch(() => {});
        this.pool.delete(key);
      }
    }
  }

  private evictOldestIdle(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, instance] of this.pool) {
      if (instance.inUse === 0 && instance.lastUsedAt < oldestTime) {
        oldestTime = instance.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const instance = this.pool.get(oldestKey);
      if (instance) {
        console.log(`[BrowserPool] Evicting oldest idle: ${oldestKey}`);
        instance.browser.close().catch(() => {});
        this.pool.delete(oldestKey);
      }
    }
  }

  getStats() {
    let inUse = 0;
    let idle = 0;
    for (const instance of this.pool.values()) {
      if (instance.inUse > 0) inUse++;
      else idle++;
    }
    return { poolSize: this.pool.size, inUse, idle, max: BROWSER_POOL_MAX };
  }
}

const browserPool = new BrowserPool();

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

async function setupRouteBypass(context: BrowserContext, redirectChain: string[], allRequestUrls: string[]): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const rt = request.resourceType();

    // P0-6: Resource blocking — abort image/media/font to speed up extraction 50%+
    // Attribution is JS+cookie based, doesn't need these resources
    if (rt === "image" || rt === "media" || rt === "font") {
      try { await route.abort(); } catch {}
      return;
    }

    // Non-document requests (script, xhr, fetch, stylesheet, websocket) — pass through
    if (rt !== "document") {
      try { await route.continue(); } catch {}
      return;
    }

    const url = request.url();
    // Track all document requests for URL salvage (P0-2: URL防抖 fallback)
    if (!allRequestUrls.includes(url)) {
      allRequestUrls.push(url);
    }

    // P0-4: Domain-aware route.fetch — for known problematic domains, use
    // Playwright HTTP client (HTTP/1.1) instead of browser native stack.
    // This bypasses (1) Chromium SubresourceFilter affiliate domain block
    // and (2) HTTP/2 + proxy incompatibility.
    if (!isSubresourceBlockedDomain(url)) {
      try { await route.continue(); } catch {}
      return;
    }

    // route.fetch() path — manual redirect handling
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
            if (!allRequestUrls.includes(redirectUrl)) {
              allRequestUrls.push(redirectUrl);
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

// Context creation helper — used by BrowserPool-managed instances.
// Each extraction creates a fresh BrowserContext (isolated cookies/storage)
// but reuses the underlying Browser instance for performance.
async function createContext(browser: Browser, referer?: string): Promise<BrowserContext> {
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
  return context;
}

async function closeContext(context: BrowserContext): Promise<void> {
  try { await context.close(); } catch (err) { console.error("Error closing context:", err); }
}

// ---------------------------------------------------------------------------
// P0-2: URL防抖 (waitForRedirectSettle)
// ---------------------------------------------------------------------------

/**
 * Wait for the page URL to stabilize (stop changing) for stableTime ms.
 * Returns the settled URL if it differs from fromUrl, or null if URL kept
 * changing or never settled within maxWait.
 *
 * This addresses the "抓到中间页" problem: affiliate redirect chains are
 * multi-hop (联盟→归因回传→第一方cookie→落地页) and URL changes rapidly.
 * Without settling, we'd sample the URL mid-redirect and capture an
 * intermediate page (e.g. adservice.google.com instead of real landing).
 */
async function waitForRedirectSettle(
  page: Page,
  fromUrl: string,
  options: { maxWait?: number; stableTime?: number } = {}
): Promise<string | null> {
  const maxWait = options.maxWait ?? 8000;
  const stableTime = options.stableTime ?? 2500;
  const deadline = Date.now() + maxWait;
  let lastUrl = page.url();
  let lastChangeAt = Date.now();

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    let current: string;
    try { current = page.url(); } catch { continue; }

    if (!isSameUrl(current, lastUrl)) {
      // URL changed — reset the stability timer
      lastUrl = current;
      lastChangeAt = Date.now();
      continue;
    }
    // URL has been stable for stableTime → check if it's a valid landing
    if (Date.now() - lastChangeAt >= stableTime) {
      if (isSameUrl(lastUrl, fromUrl) || isChromeError(lastUrl)) {
        return null; // Still on affiliate link or chrome error page
      }
      return lastUrl;
    }
  }
  return null; // Never settled within maxWait
}

// ---------------------------------------------------------------------------
// P0-3: AbortController true cancellation
// ---------------------------------------------------------------------------

interface CancellationHandle {
  signal: AbortSignal;
  cleanup: () => void;
}

function createExtractorTimeout(timeoutMs: number = EXTRACTOR_TIMEOUT_MS): CancellationHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => {
    // Force cleanup will be done by the caller via try/finally
    console.warn(`[Extractor] Aborted after ${timeoutMs}ms timeout`);
  };
  controller.signal.addEventListener('abort', onAbort);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
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
// 5-Phase Extraction Strategy (improved with BrowserPool + URL防抖 + AbortController)
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string,
  affiliateNetwork?: string,
  presetReferer?: string,
): Promise<ExtractResult> {
  // Referer priority: explicit preset > derived from affiliate link origin
  const referer = presetReferer && presetReferer.trim() ? presetReferer.trim() : deriveReferer(affiliateLink);

  // P0-3: AbortController — true cancellation on timeout (90s default)
  const cancelHandle = createExtractorTimeout();
  const { signal } = cancelHandle;

  // P0-2: Track ALL document request URLs for URL salvage fallback
  const redirectChain: string[] = [];
  const allRequestUrls: string[] = [];

  // P0-1: Acquire browser from pool (reuses instance per proxy)
  const instance = await browserPool.acquire(proxyUrl || '');
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    throwIfAborted(signal);
    context = await createContext(instance.browser, referer);
    await setupRouteBypass(context, redirectChain, allRequestUrls);

    // Stealth plugin handles navigator.webdriver + window.chrome + 30+ other
    // fingerprint vectors, so we don't need manual addInitScript anymore.
    // (Keeping the import for fallback if stealth plugin fails to load.)

    throwIfAborted(signal);
    page = await context.newPage();
    let previousUrl = affiliateLink;

    // Track URL changes via response events (supplementary to route bypass)
    page.on("response", (response) => {
      const url = response.url();
      const request = response.request();
      if (request.resourceType() !== "document") return;
      if (request.frame() !== page!.mainFrame()) return;
      if (!isSameUrl(url, previousUrl) && !redirectChain.includes(url)) {
        redirectChain.push(url);
        if (!allRequestUrls.includes(url)) allRequestUrls.push(url);
        previousUrl = url;
      }
    });

    // ── Phase 1: Navigate to affiliate link (waitUntil: load, 60s) ──
    // Must use "load" (not "domcontentloaded") because affiliate attribution
    // JS (Impact first-party cookie, Google adservice beacon) runs AFTER
    // domcontentloaded. Using domcontentloaded samples mid-redirect and
    // captures intermediate pages (e.g. adservice.google.com).
    throwIfAborted(signal);
    try {
      await page.goto(affiliateLink, { waitUntil: "load", timeout: 60000 });
    } catch (navError) {
      const navMsg = navError instanceof Error ? navError.message : String(navError);
      console.warn("Phase 1 navigation warning:", navMsg);
      // P0-4: Detect HTTP/2 protocol errors → add domain to runtime blocked list
      if (navMsg.includes('ERR_HTTP2_PROTOCOL_ERROR')) {
        addRuntimeBlockedDomain(affiliateLink);
      }
      // P0-4: Detect tunnel connection failures (proxy IP blocked)
      if (navMsg.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
        throw new Error(`ERR_TUNNEL_CONNECTION_FAILED: 代理IP无法建立到目标域名的HTTPS隧道，可能IP段被封: ${navMsg}`);
      }
    }

    throwIfAborted(signal);
    let currentUrl = page.url();

    // ── Phase 1.5: URL防抖 (P0-2) — wait for URL to stabilize 2.5s ──
    // This is the KEY fix for "抓到中间页" problem. Affiliate redirect chains
    // are multi-hop and URL changes rapidly. Without settling, we'd capture
    // intermediate pages.
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      console.log("[Extract] Phase 1.5: Waiting for URL to settle...");
      const settledUrl = await waitForRedirectSettle(page, affiliateLink, { maxWait: 8000, stableTime: 2500 });
      if (settledUrl) {
        console.log("[Extract] Phase 1.5: URL settled →", settledUrl);
        currentUrl = settledUrl;
      }
    }

    // Early exit if Phase 1.5 found a landing page
    if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
      return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, false);
    }

    throwIfAborted(signal);

    // ── Phase 2: waitForURL fallback (20s) ──
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      try {
        await page.waitForURL(
          (url) => !isSameUrl(url.toString(), affiliateLink) && !isChromeError(url.toString()),
          { timeout: 20000 }
        );
        currentUrl = page.url();
      } catch {}
    }

    throwIfAborted(signal);

    // ── Phase 3: networkidle (15s) ──
    try { await page.waitForLoadState("networkidle", { timeout: 15000 }); } catch {}
    currentUrl = page.url();

    throwIfAborted(signal);

    // ── Phase 4: Parse page content for redirect URLs ──
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const metaRefreshUrl = await page.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="refresh"]');
        if (meta) { const match = (meta.getAttribute("content") || "").match(/url=(.+)/i); return match ? match[1].trim() : null; }
        return null;
      });
      if (metaRefreshUrl) {
        throwIfAborted(signal);
        try { await page.goto(metaRefreshUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {}
      }

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
        if (jsRedirectUrl) {
          throwIfAborted(signal);
          try { await page.goto(jsRedirectUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {}
        }
      }

      if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
        const iframeUrl = await page.evaluate(() => { const iframe = document.querySelector("iframe[src]"); return iframe ? iframe.getAttribute("src") : null; });
        if (iframeUrl && iframeUrl.startsWith("http")) {
          throwIfAborted(signal);
          try { await page.goto(iframeUrl, { waitUntil: "load", timeout: 60000 }); currentUrl = page.url(); } catch {}
        }
      }
    }

    throwIfAborted(signal);

    // ── Phase 5: Retry with networkidle (45s) ──
    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      try { await page.goto(affiliateLink, { waitUntil: "networkidle", timeout: 45000 }); currentUrl = page.url(); } catch {}
    }

    // If Playwright found a landing page, score and validate
    if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
      return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, false);
    }

    // ── URL Salvage (P0-2 fallback) ──
    // 5 phases all failed but page.url() still on affiliate link. Don't give up —
    // salvage from allRequestUrls (browser may have actually visited the landing
    // page but URL rebound due to HTTP/2 load failure). Attribution is preserved
    // (browser visited the URL, cookies written).
    if (allRequestUrls.length > 0) {
      console.log(`[Extract] URL salvage: trying ${allRequestUrls.length} captured request URLs`);
      const salvageSkipDomains = [
        'sjv.io', 'ojrq.net', 'linksynergy.com', 'awin1.com', 'awin.com',
        'shareasale.com', 'avantlink.com', 'prf.hn', 'partnerize.com',
        'flexlinkspro.com', 'chinesean.com', 'doubleclick.net',
        'googleadservices.com', 'adservice.google.com', 'googlesyndication.com',
        'google-analytics.com', 'googletagmanager.com', 'facebook.com',
      ];
      const validCandidates = allRequestUrls.filter(u =>
        !isSameUrl(u, affiliateLink) &&
        !isChromeError(u) &&
        (() => {
          try {
            const host = new URL(u).hostname.toLowerCase();
            return !salvageSkipDomains.some(d => host === d || host.endsWith('.' + d));
          } catch { return false; }
        })()
      );
      if (validCandidates.length > 0) {
        // Take the last valid candidate (deepest in redirect chain = real landing)
        const salvagedUrl = validCandidates[validCandidates.length - 1];
        console.log(`[Extract] URL salvage success: ${salvagedUrl}`);
        return buildBestResult(salvagedUrl, redirectChain, affiliateLink, affiliateNetwork, false);
      }
    }

    // Playwright failed -> try HTTP fallback
    console.log("[Extract] Playwright + salvage failed, trying HTTP fallback...");
    throwIfAborted(signal);
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
  } catch (err) {
    // If aborted, treat as timeout
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.warn('[Extract] Extraction aborted due to timeout');
      return {
        success: false,
        landingPageUrl: null,
        redirectChain: redirectChain.map(u => normalizeTrackingParams(u)),
        finalUrl: null,
        usedFallback: false,
      };
    }
    throw err; // Re-throw other errors for handleExtract to classify
  } finally {
    // P0-3: Always cleanup — close page + context, release browser back to pool
    try { if (page) await page.close(); } catch {}
    try { if (context) await closeContext(context); } catch {}
    browserPool.release(instance);
    cancelHandle.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Endpoint: POST /api/extract
// ---------------------------------------------------------------------------

async function handleExtract(req: Request): Promise<Response> {
  let body: ExtractRequest;
  try { body = (await req.json()) as ExtractRequest; } catch { return jsonResponse({ success: false, error: "Invalid JSON body" }, 400); }

  const { url, proxy, affiliateNetwork, referer } = body;
  if (!url) return jsonResponse({ success: false, error: "URL is required" }, 400);
  try { new URL(url); } catch { return jsonResponse({ success: false, error: "Invalid URL format" }, 400); }

  const startTime = Date.now();
  try {
    const result = await extractOnce(url, proxy, affiliateNetwork, referer);
    const elapsed = Date.now() - startTime;
    console.log(`[Extract] Completed in ${elapsed}ms — success=${result.success}, usedFallback=${result.usedFallback}, redirectChain=${result.redirectChain.length} hops`);
    return jsonResponse({
      success: result.success,
      landingPageUrl: result.landingPageUrl,
      redirectChain: result.redirectChain,
      finalUrl: result.finalUrl,
      validation: result.validation,
      usedFallback: result.usedFallback,
      elapsed,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - startTime;
    console.error(`[Extract] Failed in ${elapsed}ms:`, errMsg);

    // P0-4: Specific error classification for HTTP/2 and tunnel errors
    if (errMsg.includes("ERR_TUNNEL_CONNECTION_FAILED"))
      return jsonResponse({
        success: false,
        error: "Tunnel connection failed (代理IP段可能被封)",
        details: errMsg,
        errorCode: "TUNNEL_FAILED",
      }, 502);
    if (errMsg.includes("ERR_HTTP2_PROTOCOL_ERROR"))
      return jsonResponse({
        success: false,
        error: "HTTP/2 protocol error (域名已加入route.fetch名单，重试可成功)",
        details: errMsg,
        errorCode: "HTTP2_ERROR",
      }, 502);
    if (errMsg.includes("proxy") || errMsg.includes("Proxy") || errMsg.includes("ERR_PROXY_CONNECTION_FAILED"))
      return jsonResponse({ success: false, error: "Proxy connection failed", details: errMsg, errorCode: "PROXY_FAILED" }, 502);
    if (errMsg.includes("Timeout") || errMsg.includes("timeout") || errMsg.includes("AbortError"))
      return jsonResponse({ success: false, error: "Page navigation timed out", details: errMsg, errorCode: "TIMEOUT" }, 504);
    return jsonResponse({ success: false, error: "Extraction failed", details: errMsg, errorCode: "UNKNOWN" }, 500);
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
        sendJson({
          status: "ok",
          timestamp: Date.now(),
          pool: browserPool.getStats(),
          runtimeBlockedDomains: Array.from(runtimeBlockedDomains),
        });
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

// P0-3: Watchdog — hard kill after WATCHDOG_TIMEOUT_MS (6min) to let Railway
// restart the container. This prevents drift from accumulated leaks that
// survive the per-request AbortController cleanup.
// The watchdog only triggers if the process has been running for the full
// duration without restart — normal short-lived operations never see it.
let lastActivityAt = Date.now();
function bumpActivity() { lastActivityAt = Date.now(); }
setInterval(() => {
  const idle = Date.now() - lastActivityAt;
  // Only exit if process has been continuously running (not idle) for too long
  // We track "running" as: HTTP server has handled a request recently OR
  // browser pool has active instances. If both idle, no need to restart.
  const poolStats = browserPool.getStats();
  if (poolStats.inUse > 0 && idle > WATCHDOG_TIMEOUT_MS) {
    console.error(`[Watchdog] Process has been busy for ${idle}ms with ${poolStats.inUse} active browsers — forcing restart`);
    process.exit(1);
  }
}, 60_000).unref?.();

// Bump activity on every request so watchdog knows we're alive
server.on('request', () => bumpActivity());

server.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`);
  console.log(`[Config] BROWSER_POOL_MAX=${BROWSER_POOL_MAX}, EXTRACTOR_TIMEOUT=${EXTRACTOR_TIMEOUT_MS}ms, WATCHDOG=${WATCHDOG_TIMEOUT_MS}ms`);
});

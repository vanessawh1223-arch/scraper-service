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
  referer?: string;
}

type FailureType = 'hijacked' | 'incompleteExtraction' | 'noAttributionParams';
type Confidence = 'high' | 'medium' | 'low';

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
  failureType?: FailureType;
  hijackedDomain?: string;
  confidence?: Confidence;
  signature?: string;
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
// Domain classification tables (hard filter for noise URLs)
// ---------------------------------------------------------------------------

/** Category 0 — Browser extension hijack domains (permanent failure trigger) */
const HIJACK_DOMAINS = new Set([
  'fatcoupon.com', 'www.fatcoupon.com',
  'couponfollow.com', 'www.couponfollow.com',
  'honey.com', 'www.honey.com', 'joinhoney.com',
  'wikibuy.com', 'www.wikibuy.com',
  'paypal-hero.com', 'www.paypal-hero.com',
  'pandadl.com', 'www.pandadl.com',
  'c2d.to', 'www.c2d.to',
  'couponcinema.com', 'www.couponcinema.com',
]);

/** Category A — Affiliate redirect middle pages */
const AFFILIATE_REDIRECT_DOMAINS = new Set([
  'sjv.io', 'www.svj.io',
  'ojrq.net', 'www.ojrq.net',
  'pxf.io', 'www.pxf.io',
  'avantlink.com', 'www.avantlink.com',
  'flexlinkspro.com', 'www.flexlinkspro.com',
  'go.skimresources.com', 'skimresources.com',
  'tkqlhce.com', 'www.tkqlhce.com',
  'anrdoezrs.net', 'www.anrdoezrs.net',
  'kqzyfj.com', 'www.kqzyfj.com',
  'jdoqocy.com', 'www.jdoqocy.com',
  'dpbolvw.net', 'www.dpbolvw.net',
  'linksynergy.com', 'www.linksynergy.com',
  'commission-junction.com',
]);

/** Category B — Third-party iframe / SDK / beacon domains */
const IFRAME_SDK_DOMAINS = new Set([
  'youtube.com', 'www.youtube.com',
  'accounts.google.com', 'accounts.gstatic.com',
  'hsforms.net', 'www.hsforms.net',
  'jst.ai', 'www.jst.ai',
  'shop.app', 'www.shop.app',
  'cookiebot.com', 'www.cookiebot.com',
  'doubleclick.net', 'www.doubleclick.net',
  'googletagmanager.com', 'www.googletagmanager.com',
  'connect.facebook.net', 'www.facebook.net',
  'facebook.net',
  'google-analytics.com', 'www.google-analytics.com',
  'bat.bing.com',
  'pinterest.com', 'www.pinterest.com',
]);

/** Category C — Noise path patterns (any domain) */
const NOISE_PATH_PATTERNS = [
  /\/assets\//i,
  /\/embed\//i,
  /\/pixel\b/i,
  /\/track\b/i,
  /\/web-pixels@/i,
  /\/services\/login_with_shop\//i,
  /\/api\//i,
  /\/_next\//i,
  /\/static\//i,
  /\/cdn-cgi\//i,
  /\.js(\?|$)/i,
  /\.css(\?|$)/i,
  /\.png(\?|$)/i,
  /\.gif(\?|$)/i,
  /\.svg(\?|$)/i,
  /\.woff2?(\?|$)/i,
];

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

const TWO_PART_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.za', 'com.mx',
  'org.uk', 'net.au', 'co.nz', 'com.sg', 'co.kr', 'com.hk', 'co.id'
]);

function getRootDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function isSameOrSubdomain(host: string, baseDomain: string): boolean {
  if (host === baseDomain) return true;
  const hostRoot = getRootDomain(host);
  const baseRoot = getRootDomain(baseDomain);
  return hostRoot === baseRoot;
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
// Noise URL classification (hard filter)
// ---------------------------------------------------------------------------

interface NoiseCheck {
  noise: boolean;
  category: 'hijack' | 'affiliate' | 'iframe' | 'path' | null;
  domain?: string;
}

function isNoiseUrl(url: string): NoiseCheck {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return { noise: true, category: 'path' };
  }

  // Category 0: Hijack domains (browser extension)
  for (const hijack of HIJACK_DOMAINS) {
    if (hostname === hijack || hostname.endsWith('.' + hijack)) {
      return { noise: true, category: 'hijack', domain: hostname };
    }
  }

  // Category A: Affiliate redirect middle pages
  for (const aff of AFFILIATE_REDIRECT_DOMAINS) {
    if (hostname === aff || hostname.endsWith('.' + aff)) {
      return { noise: true, category: 'affiliate', domain: hostname };
    }
  }

  // Category B: Third-party iframe / SDK / beacon
  for (const sdk of IFRAME_SDK_DOMAINS) {
    if (hostname === sdk || hostname.endsWith('.' + sdk)) {
      return { noise: true, category: 'iframe', domain: hostname };
    }
  }

  // Category C: Noise path patterns
  try {
    const pathname = new URL(url).pathname;
    for (const pattern of NOISE_PATH_PATTERNS) {
      if (pattern.test(pathname)) {
        return { noise: true, category: 'path' };
      }
    }
  } catch {}

  return { noise: false, category: null };
}

// ---------------------------------------------------------------------------
// Attribution param detection
// ---------------------------------------------------------------------------

/** Check if URL has any attribution tracking param (known or heuristic) */
function hasAttributionParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    const paramEntries = Array.from(parsed.searchParams.entries());
    if (paramEntries.length === 0) return false;

    // Known tracking param
    for (const param of ALL_KNOWN_TRACKING_PARAMS) {
      if (parsed.searchParams.has(param)) return true;
    }

    // Heuristic: non-generic param with value >= 8 chars + mixed digits/letters
    for (const [key, value] of paramEntries) {
      if (GENERIC_ANALYTICS_PARAMS.has(key.toLowerCase())) continue;
      if (value.length >= 8 && /\d/.test(value) && /[a-zA-Z]/.test(value)) {
        return true;
      }
    }

    // Multiple non-generic params (likely tracking combo)
    const nonGeneric = paramEntries.filter(([k]) => !GENERIC_ANALYTICS_PARAMS.has(k.toLowerCase()));
    if (nonGeneric.length >= 2) return true;

    return false;
  } catch {
    return false;
  }
}

/** Check if URL has known tracking param (for confidence boost) */
function hasKnownTrackingParam(url: string, affiliateNetwork?: string): boolean {
  try {
    const parsed = new URL(url);
    if (affiliateNetwork && AFFILIATE_TRACKING_PARAMS[affiliateNetwork]) {
      for (const param of AFFILIATE_TRACKING_PARAMS[affiliateNetwork]) {
        if (parsed.searchParams.has(param)) return true;
      }
    }
    for (const param of ALL_KNOWN_TRACKING_PARAMS) {
      if (parsed.searchParams.has(param)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Count query params */
function paramCount(url: string): number {
  try {
    return new URL(url).searchParams.size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Layer 1: normalizeTrackingParams — Input-side encoding fix
// ---------------------------------------------------------------------------

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

function validateTrackingParams(url: string, affiliateNetwork?: string): ValidationResult {
  try {
    const parsed = new URL(url);
    const paramEntries = Array.from(parsed.searchParams.entries());

    if (paramEntries.length === 0) {
      return { valid: true, isEncodingError: false, warning: 'URL无查询参数，可能缺少追踪参数' };
    }

    // Check 1: General encoding error — %3A without %2F
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

    for (const [key, value] of nonGenericEntries) {
      if (value.length >= 8 && /\d/.test(value) && /[a-zA-Z]/.test(value)) {
        return {
          valid: true,
          isEncodingError: false,
          warning: `启发式检测: 参数"${key}"可能是追踪ID(len=${value.length})`,
        };
      }
    }

    if (nonGenericEntries.length >= 2) {
      return {
        valid: true,
        isEncodingError: false,
        warning: `启发式检测: URL含${nonGenericEntries.length}个非通用参数，可能是追踪参数组合`,
      };
    }

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
// Confidence & signature computation
// ---------------------------------------------------------------------------

function computeConfidence(
  url: string,
  landingDomain: string | null,
  hasKnownParam: boolean,
): Confidence {
  if (!landingDomain) return 'low';
  let onLanding = false;
  try {
    const host = new URL(url).hostname;
    onLanding = isSameOrSubdomain(host, landingDomain);
  } catch {}

  if (onLanding && hasKnownParam) return 'high';
  if (onLanding && hasAttributionParams(url)) return 'medium';
  if (hasKnownParam || hasAttributionParams(url)) return 'medium';
  return 'low';
}

function computeSignature(url: string): string {
  try {
    const parsed = new URL(url);
    return Array.from(parsed.searchParams.keys()).sort().join(',');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// HTTP Fallback — Follow redirects without browser
// ---------------------------------------------------------------------------

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
// stabilizeAddressBarUrl — full-scan __urlChanges + poll page.url()
// ---------------------------------------------------------------------------

/**
 * Stabilize the address bar URL after a navigation phase.
 * Step 1: Read window.__urlChanges (full scan), filter noise, pick the URL with
 *         the most params (NOT the last one — replaceState can overwrite pushState params).
 * Step 2: Poll page.url() every 500ms; if it changes to a non-noise URL, adopt it;
 *         if same host but more params, adopt the richer version.
 */
async function stabilizeAddressBarUrl(
  page: Page,
  currentUrl: string,
  maxWaitMs: number,
): Promise<string> {
  let best = currentUrl;

  // Step 1: Full scan __urlChanges
  try {
    const changes = await page.evaluate(() => {
      return (window as any).__urlChanges as string[] | undefined;
    });
    if (Array.isArray(changes)) {
      const normalized = changes
        .map(u => normalizeTrackingParams(u))
        .filter(u => !isChromeError(u));
      // Prefer non-noise URLs with most params
      let bestChange: string | null = null;
      let bestParams = -1;
      for (const u of normalized) {
        const noise = isNoiseUrl(u);
        if (noise.noise && noise.category !== 'affiliate') continue; // allow affiliate (may carry params)
        const pc = paramCount(u);
        if (pc > bestParams) {
          bestParams = pc;
          bestChange = u;
        }
      }
      if (bestChange && paramCount(bestChange) > paramCount(best)) {
        best = bestChange;
      }
    }
  } catch {}

  // Step 2: Poll page.url() for stability
  const startTime = Date.now();
  let lastUrl = best;
  let stableCount = 0;
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 500));
    let pageUrl: string;
    try {
      pageUrl = page.url();
    } catch {
      break;
    }
    if (isChromeError(pageUrl)) {
      continue;
    }
    const normalized = normalizeTrackingParams(pageUrl);
    if (!isSameUrl(normalized, lastUrl)) {
      // URL changed — check if it's noise
      const noise = isNoiseUrl(normalized);
      if (!noise.noise || noise.category === 'affiliate') {
        lastUrl = normalized;
        stableCount = 0;
      }
    } else {
      // Same URL — but maybe params got richer (same host)
      if (paramCount(normalized) > paramCount(lastUrl)) {
        try {
          const host1 = new URL(normalized).hostname;
          const host2 = new URL(lastUrl).hostname;
          if (host1 === host2) {
            lastUrl = normalized;
          }
        } catch {}
      }
      stableCount++;
      if (stableCount >= 2) break; // stable for 1s
    }
  }

  // Pick the richer of (lastUrl, best) if same host
  if (paramCount(lastUrl) > paramCount(best)) {
    best = lastUrl;
  } else if (paramCount(best) === 0 && paramCount(lastUrl) > 0) {
    best = lastUrl;
  }

  return best;
}

// ---------------------------------------------------------------------------
// waitForRedirectSettle — wait for URL to stabilize after initial nav
// ---------------------------------------------------------------------------

async function waitForRedirectSettle(
  page: Page,
  initialUrl: string,
  stableMs: number,
  maxWaitMs: number,
): Promise<string> {
  const startTime = Date.now();
  let lastUrl = initialUrl;
  let stableSince = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 500));
    let pageUrl: string;
    try {
      pageUrl = page.url();
    } catch {
      continue;
    }
    if (isChromeError(pageUrl)) continue;
    const normalized = normalizeTrackingParams(pageUrl);
    if (!isSameUrl(normalized, lastUrl)) {
      lastUrl = normalized;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return lastUrl;
    }
  }
  return lastUrl;
}

// ---------------------------------------------------------------------------
// Build best result — domain-anchored selection + 5% fallback
// ---------------------------------------------------------------------------

function buildBestResult(
  currentUrl: string,
  redirectChain: string[],
  affiliateLink: string,
  affiliateNetwork: string | undefined,
  pageChanges: string[],
  usedFallback = false,
): ExtractResult {
  // Layer 1: Normalize all URLs
  const normalizedChain = redirectChain.map(u => normalizeTrackingParams(u));
  const normalizedCurrent = normalizeTrackingParams(currentUrl);
  const normalizedChanges = pageChanges.map(u => normalizeTrackingParams(u));

  // Collect observed URLs (deduplicated, order-preserved)
  const observed: string[] = [];
  const seen = new Set<string>();
  const pushObserved = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    observed.push(u);
  };
  for (const u of normalizedChain) pushObserved(u);
  if (!isSameUrl(normalizedCurrent, affiliateLink) && !isChromeError(normalizedCurrent)) {
    pushObserved(normalizedCurrent);
  }
  for (const u of normalizedChanges) {
    if (!isChromeError(u)) pushObserved(u);
  }

  // Classify each URL
  let hijackedDomain: string | null = null;
  for (const u of observed) {
    const noise = isNoiseUrl(u);
    if (noise.category === 'hijack') {
      hijackedDomain = noise.domain || hijackedDomain;
    }
  }
  if (hijackedDomain) {
    return {
      success: false,
      landingPageUrl: null,
      redirectChain: normalizedChain,
      finalUrl: normalizedCurrent,
      usedFallback,
      failureType: 'hijacked',
      hijackedDomain: hijackedDomain,
    };
  }

  // Build clean candidates (exclude affiliate link itself, chrome errors, noise)
  let affiliateHost = '';
  try { affiliateHost = new URL(affiliateLink).hostname; } catch {}

  const cleanCandidates = observed.filter(u => {
    if (isSameUrl(u, affiliateLink)) return false;
    if (isChromeError(u)) return false;
    const noise = isNoiseUrl(u);
    if (noise.noise) return false;
    // Exclude URLs on the same domain as affiliate link (still on tracking domain)
    if (affiliateHost) {
      try {
        const uHost = new URL(u).hostname;
        if (isSameOrSubdomain(uHost, affiliateHost)) return false;
      } catch {}
    }
    return true;
  });

  if (cleanCandidates.length === 0) {
    return {
      success: false,
      landingPageUrl: null,
      redirectChain: normalizedChain,
      finalUrl: normalizedCurrent,
      usedFallback,
      failureType: 'incompleteExtraction',
    };
  }

  // Infer landing domain = hostname of the LAST clean candidate
  let landingDomain: string | null = null;
  try {
    landingDomain = new URL(cleanCandidates[cleanCandidates.length - 1]).hostname;
  } catch {}

  // Main selection (95%): on landing domain + has attribution params
  const onLandingWithParams = cleanCandidates
    .filter(u => {
      if (!landingDomain) return false;
      try {
        const host = new URL(u).hostname;
        if (!isSameOrSubdomain(host, landingDomain)) return false;
      } catch { return false; }
      return hasAttributionParams(u);
    })
    .sort((a, b) => {
      // Most params first, then later chain position
      const pcDiff = paramCount(b) - paramCount(a);
      if (pcDiff !== 0) return pcDiff;
      return observed.indexOf(b) - observed.indexOf(a);
    });

  let winner: string | null = onLandingWithParams[0] || null;

  // Fallback (5%): landing page lost params, backtrace to find last URL with attribution
  if (!winner) {
    const backtraceCandidates = observed.filter(u => {
      if (isSameUrl(u, affiliateLink)) return false;
      if (isChromeError(u)) return false;
      const noise = isNoiseUrl(u);
      // Exclude only iframe/path noise, allow affiliate middle pages (they may carry params)
      if (noise.noise && (noise.category === 'iframe' || noise.category === 'path')) return false;
      return hasAttributionParams(u);
    });
    if (backtraceCandidates.length > 0) {
      // Pick the LAST one in chain (closest to landing)
      winner = backtraceCandidates[backtraceCandidates.length - 1];
    }
  }

  if (!winner) {
    // Reached landing domain but no attribution params anywhere
    return {
      success: false,
      landingPageUrl: null,
      redirectChain: normalizedChain,
      finalUrl: normalizedCurrent,
      usedFallback,
      failureType: 'noAttributionParams',
    };
  }

  // Winner found — validate & compute confidence
  const validation = validateTrackingParams(winner, affiliateNetwork);
  const knownParam = hasKnownTrackingParam(winner, affiliateNetwork);
  const confidence = computeConfidence(winner, landingDomain, knownParam);
  const signature = computeSignature(winner);

  return {
    success: true,
    landingPageUrl: winner,
    redirectChain: normalizedChain,
    finalUrl: winner,
    validation,
    usedFallback,
    confidence,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Extraction Strategy (6 phases + fallback)
// ---------------------------------------------------------------------------

async function extractOnce(
  affiliateLink: string,
  proxyUrl?: string,
  affiliateNetwork?: string,
  customReferer?: string,
): Promise<ExtractResult> {
  const referer = customReferer || deriveReferer(affiliateLink);
  const { browser, context } = await launchBrowser(proxyUrl, referer);

  const redirectChain: string[] = [];
  await setupRouteBypass(context, redirectChain);

  // Init script: anti-headless + pushState/replaceState hook
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {}, app: {} };

    // Hook pushState/replaceState to capture JS-modified address bar URLs
    (window as any).__urlChanges = [];
    try {
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);
      const record = (kind: string, urlArg: any) => {
        try {
          if (!urlArg) return;
          let abs: string;
          if (typeof urlArg === 'string') {
            abs = new URL(urlArg, location.href).href;
          } else {
            abs = location.href;
          }
          (window as any).__urlChanges.push(abs);
        } catch {}
      };
      history.pushState = function (...args: any[]) {
        record('push', args[2]);
        return origPush(...(args as [any, string, string?]));
      };
      history.replaceState = function (...args: any[]) {
        record('replace', args[2]);
        return origReplace(...(args as [any, string, string?]));
      };
    } catch {}
  });

  const page = await context.newPage();
  let previousUrl = affiliateLink;

  // Track URL changes via response events (supplementary)
  page.on("response", (response) => {
    const url = response.url();
    const request = response.request();
    if (request.resourceType() !== "document") return;
    if (request.frame() !== page.mainFrame()) return;
    const normalized = normalizeTrackingParams(url);
    if (!isSameUrl(normalized, previousUrl) && !redirectChain.includes(normalized)) {
      redirectChain.push(normalized);
      previousUrl = normalized;
    }
  });

  let currentUrl: string;

  // Phase 1: Initial navigation
  try {
    await page.goto(affiliateLink, { waitUntil: "load", timeout: 30000 });
  } catch (navError) {
    console.warn("Phase 1 navigation warning:", navError instanceof Error ? navError.message : String(navError));
  }

  currentUrl = normalizeTrackingParams(page.url());

  // Quick win: if URL already changed away from affiliate link
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    currentUrl = await stabilizeAddressBarUrl(page, currentUrl, 2500);
    const changes = await collectUrlChanges(page);
    await closeBrowser(browser);
    return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, changes, false);
  }

  // Phase 1.5: waitForRedirectSettle (URL stable 2s, max 8s)
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    const settled = await waitForRedirectSettle(page, currentUrl, 2000, 8000);
    if (!isSameUrl(settled, affiliateLink) && !isChromeError(settled)) {
      currentUrl = settled;
    }
  }

  // Phase 2: waitForURL
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try {
      await page.waitForURL(
        (url) => !isSameUrl(url.toString(), affiliateLink) && !isChromeError(url.toString()),
        { timeout: 10000 },
      );
      currentUrl = normalizeTrackingParams(page.url());
    } catch {}
  }

  // Phase 3: networkidle
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  currentUrl = normalizeTrackingParams(page.url());
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    currentUrl = await stabilizeAddressBarUrl(page, currentUrl, 2500);
  }

  // Phase 4: Parse page content for redirect URLs (meta refresh / JS redirect / iframe)
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    const metaRefreshUrl = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      if (meta) {
        const match = (meta.getAttribute("content") || "").match(/url=(.+)/i);
        return match ? match[1].trim() : null;
      }
      return null;
    });
    if (metaRefreshUrl) {
      try { await page.goto(metaRefreshUrl, { waitUntil: "load", timeout: 30000 }); } catch {}
      currentUrl = normalizeTrackingParams(page.url());
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
        try { await page.goto(jsRedirectUrl, { waitUntil: "load", timeout: 30000 }); } catch {}
        currentUrl = normalizeTrackingParams(page.url());
      }
    }

    if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
      const iframeUrl = await page.evaluate(() => {
        const iframe = document.querySelector("iframe[src]");
        return iframe ? iframe.getAttribute("src") : null;
      });
      if (iframeUrl && iframeUrl.startsWith("http")) {
        try { await page.goto(iframeUrl, { waitUntil: "load", timeout: 30000 }); } catch {}
        currentUrl = normalizeTrackingParams(page.url());
      }
    }
  }

  // Phase 5: Retry goto
  if (isSameUrl(currentUrl, affiliateLink) || isChromeError(currentUrl)) {
    try { await page.goto(affiliateLink, { waitUntil: "networkidle", timeout: 30000 }); } catch {}
    currentUrl = normalizeTrackingParams(page.url());
    if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
      currentUrl = await stabilizeAddressBarUrl(page, currentUrl, 2500);
    }
  }

  const changes = await collectUrlChanges(page);
  await closeBrowser(browser);

  // If Playwright found a landing page, build best result
  if (!isSameUrl(currentUrl, affiliateLink) && !isChromeError(currentUrl)) {
    return buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, changes, false);
  }

  // Even if currentUrl is stuck, try building from chain (may have salvageable URLs)
  const salvageResult = buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, changes, false);
  if (salvageResult.success) {
    return salvageResult;
  }

  // Playwright failed -> try HTTP fallback
  console.log("[Extract] Playwright failed, trying HTTP fallback...");
  try {
    const fallbackResult = await nodeJsFollowRedirects(affiliateLink);
    if (fallbackResult.url) {
      const mergedChain = [...redirectChain, ...fallbackResult.redirectChain];
      const fallbackChanges: string[] = [];
      const fbResult = buildBestResult(fallbackResult.url, mergedChain, affiliateLink, affiliateNetwork, fallbackChanges, true);
      if (fbResult.success) {
        return fbResult;
      }
      // If buildBestResult failed but we have a URL, return it with raw validation
      const normalizedUrl = normalizeTrackingParams(fallbackResult.url);
      const validation = validateTrackingParams(normalizedUrl, affiliateNetwork);
      if (validation.valid) {
        return {
          success: true,
          landingPageUrl: normalizedUrl,
          redirectChain: mergedChain.map(u => normalizeTrackingParams(u)),
          finalUrl: normalizedUrl,
          validation,
          usedFallback: true,
          confidence: 'medium',
          signature: computeSignature(normalizedUrl),
        };
      }
    }
  } catch (fallbackErr) {
    console.warn("[Extract] HTTP fallback also failed:", fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr));
  }

  // All methods failed — determine failure type
  const fallbackChanges: string[] = [];
  const failResult = buildBestResult(currentUrl, redirectChain, affiliateLink, affiliateNetwork, fallbackChanges, false);
  return failResult;
}

/** Collect window.__urlChanges from page */
async function collectUrlChanges(page: Page): Promise<string[]> {
  try {
    const changes = await page.evaluate(() => {
      return (window as any).__urlChanges as string[] | undefined;
    });
    return Array.isArray(changes) ? changes : [];
  } catch {
    return [];
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

  try {
    const result = await extractOnce(url, proxy, affiliateNetwork, referer);
    return jsonResponse({
      success: result.success,
      landingPageUrl: result.landingPageUrl,
      redirectChain: result.redirectChain,
      finalUrl: result.finalUrl,
      validation: result.validation,
      usedFallback: result.usedFallback,
      failureType: result.failureType,
      hijackedDomain: result.hijackedDomain,
      confidence: result.confidence,
      signature: result.signature,
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

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const readBody = (): Promise<string> => {
      return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk: string) => { body += chunk; });
        req.on("end", () => { resolve(body); });
      });
    };

    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end(JSON.stringify(data));
    };

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

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});

server.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`);
});

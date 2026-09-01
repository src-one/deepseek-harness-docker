/**
 * Playwright-backed Google Search. Searches either own isolated browser
 * contexts or separate pages in one persistent Chromium profile.
 * @module dsh-web-search-playwright/provider
 */

import { chromium } from 'playwright'
import { isAbsolute } from 'node:path'
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const PLAYWRIGHT_PROVIDER_ID = 'playwright-google'

/** Default keyless search page. */
export const PLAYWRIGHT_DEFAULT_SEARCH_URL = 'https://www.google.com/search?hl=en'

/** Default browser presentation. */
export const PLAYWRIGHT_DEFAULT_HEADLESS = true

/** Default browser-context locale. */
export const PLAYWRIGHT_DEFAULT_LOCALE = 'en-US'

/** Default page-navigation deadline. */
export const PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/** Default deadline for a person to complete a visible Google bot check. */
export const PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS = 300_000

/** Browser launcher used by the provider; injectable for programmatic compositions. */
export type LaunchSearchBrowser = (options: LaunchOptions) => Promise<Browser>

/** Persistent-context launcher used by programmatic compositions. */
export type LaunchPersistentSearchContext = (
  userDataDir: string,
  options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>,
) => Promise<BrowserContext>

/** Resolved provider options. */
export interface PlaywrightSearchProviderOptions {
  /** Google Search endpoint. The provider sets its `q` query parameter. */
  searchURL: string
  /** Whether Chromium runs without a visible window. */
  headless: boolean
  /** Optional Chromium-family executable instead of Playwright's managed binary. */
  executablePath?: string
  /** Optional absolute directory for a dedicated persistent Chromium profile. */
  userDataDir?: string
  /** Locale assigned to browser contexts. */
  locale: string
  /** Upper bound for one page navigation in milliseconds. */
  navigationTimeoutMs: number
  /** Upper bound for manually completing a visible Google bot check. */
  botCheckTimeoutMs: number
  /** Browser launcher supplied by a programmatic composition. */
  launchBrowser?: LaunchSearchBrowser
  /** Persistent-context launcher supplied by a programmatic composition. */
  launchPersistentContext?: LaunchPersistentSearchContext
}

type SearchRuntime =
  | { readonly mode: 'isolated'; readonly browser: Browser }
  | { readonly mode: 'persistent'; readonly context: BrowserContext }

/** Provider-private row extracted from one Google result element. */
export interface GoogleResultRow {
  readonly href: string
  readonly title: string
  readonly snippet?: string
}

/**
 * Normalize Google result rows into portable Web sources.
 * @param rows - extracted result links, titles, and optional snippets.
 * @param searchURL - configured endpoint used to resolve relative links.
 * @param maxResults - optional request limit applied before returning.
 * @returns deduplicated HTTP(S) sources in provider order.
 */
export function mapGoogleRows(
  rows: readonly GoogleResultRow[],
  searchURL: string,
  maxResults?: number,
): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const url = resultUrl(row.href, searchURL)
    const title = row.title.trim()
    if (url === undefined || title.length === 0 || seen.has(url)) continue
    seen.add(url)
    const snippet = row.snippet?.trim()
    sources.push({
      url,
      title,
      ...snippet === undefined || snippet.length === 0 ? {} : { snippet },
    })
    if (maxResults !== undefined && sources.length >= maxResults) break
  }
  return sources
}

/** Keyless Google search through a lazily launched Chromium process. */
export class PlaywrightSearchProvider implements WebSearchProvider {
  readonly id = PLAYWRIGHT_PROVIDER_ID
  private runtimePromise: Promise<SearchRuntime> | undefined
  private readonly active = new Set<Promise<void>>()
  private closePromise: Promise<void> | undefined

  constructor(private readonly options: PlaywrightSearchProviderOptions) {}

  available(): boolean {
    return isHttpUrl(this.options.searchURL)
      && isPositiveInteger(this.options.navigationTimeoutMs)
      && isPositiveInteger(this.options.botCheckTimeoutMs)
      && (this.options.executablePath === undefined || this.options.executablePath.length > 0)
      && (this.options.userDataDir === undefined || isAbsolute(this.options.userDataDir))
      && this.options.locale.length > 0
      && this.closePromise === undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (this.closePromise !== undefined) {
      throw new WebError('Playwright search provider is closing', 'WEB_PROVIDER_ERROR')
    }
    const operation = this.runSearch(request, signal)
    const settlement = operation.then(() => {}, () => {})
    this.active.add(settlement)
    try {
      return await operation
    } finally {
      this.active.delete(settlement)
    }
  }

  /** Close the shared browser runtime and wait until every active search settles. */
  async close(): Promise<void> {
    this.closePromise ??= this.closeBrowser()
    await this.closePromise
  }

  private async closeBrowser(): Promise<void> {
    await Promise.all(this.active)
    const runtimePromise = this.runtimePromise
    if (runtimePromise !== undefined) {
      try {
        const runtime = await runtimePromise
        await (runtime.mode === 'isolated' ? runtime.browser.close() : runtime.context.close())
      } catch (_runtimeLaunchOrCloseFailure) {
        // A failed launch owns no runtime; a disconnected runtime is already closed.
      }
    }
  }

  private async runSearch(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal)
    let context: BrowserContext | undefined
    let page: Page | undefined
    let ownsContext = false
    let removeAbortListener: (() => void) | undefined
    try {
      const runtime = await abortable(this.runtime(), signal)
      if (runtime.mode === 'isolated') {
        context = await abortable(runtime.browser.newContext({ locale: this.options.locale }), signal, lateContext => lateContext.close())
        ownsContext = true
      } else {
        context = runtime.context
      }
      page = await abortable(context.newPage(), signal, latePage => latePage.close())
      if (signal !== undefined) {
        const ownedResource = ownsContext ? context : page
        const onAbort = (): void => { void ownedResource.close() }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = (): void => { signal.removeEventListener('abort', onAbort) }
      }
      const target = new URL(this.options.searchURL)
      target.searchParams.set('q', request.query)
      await abortable(page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeoutMs,
      }), signal)
      await dismissGoogleConsent(page, this.options.navigationTimeoutMs, signal)
      await this.waitForManualBotCheck(page, signal)
      await dismissGoogleConsent(page, this.options.navigationTimeoutMs, signal)
      const rows = await abortable(page.locator('#search a').evaluateAll((elements): GoogleResultRow[] =>
        elements.flatMap((element) => {
          const link = element.tagName === 'A' ? element as HTMLAnchorElement : undefined
          if (link === undefined) return []
          const heading = link.querySelector<HTMLHeadingElement>('h3')
          if (heading === null) return []
          const result = link.closest<HTMLElement>('.MjjYud, .g') ?? link.parentElement
          const snippet = result?.querySelector<HTMLElement>('.VwiC3b, [data-sncf]')
          return {
            href: link.getAttribute('href') ?? '',
            title: heading.textContent,
            ...snippet?.textContent == null ? {} : { snippet: snippet.textContent },
          }
        })), signal)
      if (rows.length === 0) {
        const hasNoResultsMarker = await abortable(page.locator('#topstuff, [data-attrid="no-results"]').count(), signal)
        if (hasNoResultsMarker === 0) {
          throw await googlePageError(page, signal)
        }
      }
      const sources = mapGoogleRows(rows, this.options.searchURL)
      const truncated = request.maxResults !== undefined && sources.length > request.maxResults
      return {
        sources: truncated ? sources.slice(0, request.maxResults) : sources,
        truncated,
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      if (error instanceof WebError) throw error
      throw new WebError(`Playwright search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    } finally {
      removeAbortListener?.()
      if (ownsContext && context !== undefined) {
        await context.close().catch((_contextAlreadyClosed: unknown) => {})
      } else if (page !== undefined) {
        await page.close().catch((_pageAlreadyClosed: unknown) => {})
      }
    }
  }

  private runtime(): Promise<SearchRuntime> {
    const current = this.runtimePromise
    if (current !== undefined) {
      return current.then((runtime) => {
        if (runtimeConnected(runtime)) return runtime
        this.runtimePromise = undefined
        return this.runtime()
      })
    }
    const created = this.launchRuntime()
    const observed = created.catch((error: unknown) => {
      if (this.runtimePromise === observed) this.runtimePromise = undefined
      throw error
    })
    this.runtimePromise = observed
    return observed
  }

  private async launchRuntime(): Promise<SearchRuntime> {
    const launchOptions = {
      headless: this.options.headless,
      ...this.options.executablePath === undefined ? {} : { executablePath: this.options.executablePath },
    }
    if (this.options.userDataDir === undefined) {
      const launch = this.options.launchBrowser ?? (options => chromium.launch(options))
      return { mode: 'isolated', browser: await launch(launchOptions) }
    }
    const launch = this.options.launchPersistentContext
      ?? ((userDataDir, options) => chromium.launchPersistentContext(userDataDir, options))
    const context = await launch(this.options.userDataDir, { ...launchOptions, locale: this.options.locale })
    try {
      await Promise.all(context.pages().map(page => page.close()))
      return { mode: 'persistent', context }
    } catch (error: unknown) {
      await context.close().catch((_contextAlreadyClosed: unknown) => {})
      throw error
    }
  }

  private async waitForManualBotCheck(page: Page, signal?: AbortSignal): Promise<void> {
    if (!await hasGoogleBotCheck(page, signal)) return
    const location = googlePageLocation(page.url())
    if (this.options.headless || this.options.userDataDir === undefined) {
      throw new WebError(
        `Google returned a bot-check page at ${location}; configure headless false and an absolute userDataDir to solve it manually and retain the profile`,
        'WEB_PROVIDER_ERROR',
      )
    }
    try {
      await abortable(page.waitForFunction(() => (
        !globalThis.location.pathname.startsWith('/sorry/')
        && document.querySelector('form#captcha-form, iframe[src*="recaptcha"], #recaptcha') === null
      ), undefined, { timeout: this.options.botCheckTimeoutMs }), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      throw new WebError(
        `Google bot check at ${location} was not completed within ${this.options.botCheckTimeoutMs}ms`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

/** True while a launched browser runtime can accept another page. */
function runtimeConnected(runtime: SearchRuntime): boolean {
  const browser = runtime.mode === 'isolated' ? runtime.browser : runtime.context.browser()
  return browser?.isConnected() === true
}

/** Reject Google's English/German optional-consent page before reading results. */
async function dismissGoogleConsent(page: import('playwright').Page, timeout: number, signal?: AbortSignal): Promise<void> {
  const controls = page.locator('button, [role="button"], input[type="submit"]')
  const index = await abortable(controls.evaluateAll((elements): number => {
    const labels = elements.map(element => (
      element.getAttribute('aria-label') ?? element.getAttribute('value') ?? element.textContent
    ).trim().toLocaleLowerCase())
    const preferred = ['reject all', 'alle ablehnen']
    return labels.findIndex(label => preferred.includes(label))
  }), signal)
  if (index < 0) return
  await abortable(controls.nth(index).click({ timeout }), signal)
}

/** Classify the non-result page without copying its query or content into diagnostics. */
async function googlePageError(page: import('playwright').Page, signal?: AbortSignal): Promise<WebError> {
  const location = googlePageLocation(page.url())
  if (await hasGoogleBotCheck(page, signal)) {
    return new WebError(`Google returned a bot-check page at ${location}`, 'WEB_PROVIDER_ERROR')
  }
  const consent = await abortable(page.locator('form[action*="consent"]').count(), signal)
  if (consent > 0 || location.startsWith('consent.google.')) {
    return new WebError(
      `Google consent remained at ${location}; configure locale en-US or de-DE, or run Chromium visibly to inspect the page`,
      'WEB_PROVIDER_ERROR',
    )
  }
  return new WebError(
    `Google result markup was not recognized at ${location}; run Chromium visibly to inspect the delivered page`,
    'WEB_PROVIDER_ERROR',
  )
}

/** Detect Google's CAPTCHA page without reading query or page text. */
async function hasGoogleBotCheck(page: Page, signal?: AbortSignal): Promise<boolean> {
  const location = googlePageLocation(page.url())
  const challenge = await abortable(page.locator(
    'form#captcha-form, iframe[src*="recaptcha"], #recaptcha',
  ).count(), signal)
  return challenge > 0 || location.endsWith('/sorry/')
}

/** Render only a page's host and path, excluding its search query. */
function googlePageLocation(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname}`
  } catch (_invalidPageUrl) {
    return 'an unknown location'
  }
}

/** Resolve one result href and unwrap Google's redirect link. */
function resultUrl(href: string, searchURL: string): string | undefined {
  if (href.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(href, searchURL)
  } catch (_invalidResultUrl) {
    return undefined
  }
  if (isGoogleHost(parsed.hostname) && parsed.pathname === '/url') {
    const destination = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
    if (destination === null) return undefined
    try {
      parsed = new URL(destination)
    } catch (_invalidRedirectDestination) {
      return undefined
    }
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
}

/** True for Google hosts which may carry redirect links. */
function isGoogleHost(hostname: string): boolean {
  return hostname === 'google.com' || hostname.endsWith('.google.com')
}

/** Race one Playwright operation against caller cancellation. */
function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  disposeLateValue?: (value: T) => Promise<unknown>,
): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) {
    void operation.then(
      (value) => { void disposeLateValue?.(value) },
      (_operationFailure: unknown) => {},
    )
    return Promise.reject(searchAborted(signal))
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      reject(searchAborted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (aborted) {
          void disposeLateValue?.(value)
          return
        }
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (!aborted) reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Reject when the caller cancelled before work starts. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Construct the provider's stable cancellation error. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Playwright search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a valid configured search endpoint. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (_invalidUrl) {
    return false
  }
}

/** True for page-navigation deadlines. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

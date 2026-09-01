import { JSDOM } from 'jsdom'
import type { Browser, BrowserContext, LaunchOptions, Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  mapGoogleRows,
  PlaywrightSearchProvider,
  PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_LOCALE,
  PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_SEARCH_URL,
  PLAYWRIGHT_PROVIDER_ID,
  type GoogleResultRow,
  type LaunchPersistentSearchContext,
  type PlaywrightSearchProviderOptions,
} from '../src/index.ts'
import * as playwrightPlugin from '../src/index.ts'

interface FakeBrowserHarness {
  readonly browser: Browser
  readonly closeBrowser: ReturnType<typeof vi.fn>
  readonly closeContext: ReturnType<typeof vi.fn>
  readonly closePage: ReturnType<typeof vi.fn>
  readonly context: BrowserContext
  readonly goto: ReturnType<typeof vi.fn>
  readonly launch: ReturnType<typeof vi.fn<(options: LaunchOptions) => Promise<Browser>>>
  readonly launchPersistent: ReturnType<typeof vi.fn<LaunchPersistentSearchContext>>
  readonly newContext: ReturnType<typeof vi.fn>
  readonly waitForFunction: ReturnType<typeof vi.fn>
}

const DEFAULT_OPTIONS: PlaywrightSearchProviderOptions = {
  searchURL: PLAYWRIGHT_DEFAULT_SEARCH_URL,
  headless: true,
  locale: PLAYWRIGHT_DEFAULT_LOCALE,
  navigationTimeoutMs: PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS,
  botCheckTimeoutMs: PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS,
}

function resultHtml(rows: readonly GoogleResultRow[], noResults = false): string {
  return `<!doctype html><main>${noResults ? '<div id="topstuff">No results</div>' : ''}<div id="search">${rows.map(row => `
    <div class="MjjYud">
      <a href="${row.href.replaceAll('&', '&amp;')}"><h3>${row.title}</h3></a>
      ${row.snippet === undefined ? '' : `<div class="VwiC3b">${row.snippet}</div>`}
    </div>`).join('')}</div></main>`
}

function fakeBrowser(html: string, overrides: {
  connected?: boolean
  goto?: () => Promise<unknown>
  newContext?: () => Promise<BrowserContext>
  pageURL?: string | (() => string)
  click?: (element: Element, document: Document) => void
  waitForFunction?: (document: Document) => Promise<unknown>
} = {}): FakeBrowserHarness {
  const dom = new JSDOM(html)
  const closeContext = vi.fn(async () => {})
  const goto = vi.fn(overrides.goto ?? (async () => null))
  const closePage = vi.fn(async () => {})
  const waitForFunction = vi.fn(async () => overrides.waitForFunction?.(dom.window.document))
  const page = {
    close: closePage,
    goto,
    url: () => typeof overrides.pageURL === 'function'
      ? overrides.pageURL()
      : overrides.pageURL ?? PLAYWRIGHT_DEFAULT_SEARCH_URL,
    waitForFunction,
    locator: (selector: string) => {
      const elements = [...dom.window.document.querySelectorAll(selector)]
      return {
        count: async () => elements.length,
        evaluateAll: async <T>(callback: (values: Element[]) => T): Promise<T> => callback(elements),
        nth: (index: number) => ({
          click: async () => { overrides.click?.(elements[index]!, dom.window.document) },
        }),
      }
    },
  } as unknown as Page
  const browserRef: { current?: Browser } = {}
  const context = {
    browser: () => browserRef.current ?? null,
    close: closeContext,
    newPage: vi.fn(async () => page),
    pages: () => [],
  } as unknown as BrowserContext
  const newContext = vi.fn(overrides.newContext ?? (async () => context))
  const closeBrowser = vi.fn(async () => {})
  const browser = {
    close: closeBrowser,
    isConnected: () => overrides.connected ?? true,
    newContext,
  } as unknown as Browser
  browserRef.current = browser
  const launchPersistent = vi.fn<LaunchPersistentSearchContext>(async () => context)
  return {
    browser,
    closeBrowser,
    closeContext,
    closePage,
    context,
    goto,
    launch: vi.fn(async () => browser),
    launchPersistent,
    newContext,
    waitForFunction,
  }
}

function provider(harness: FakeBrowserHarness, options: Partial<PlaywrightSearchProviderOptions> = {}): PlaywrightSearchProvider {
  return new PlaywrightSearchProvider({
    ...DEFAULT_OPTIONS,
    ...options,
    launchBrowser: harness.launch,
    launchPersistentContext: harness.launchPersistent,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Google result mapping', () => {
  it('normalizes direct and redirect links, trims fields, deduplicates, and caps results', () => {
    expect(mapGoogleRows([
      { href: 'https://docs.example/a', title: ' A ', snippet: ' first ' },
      { href: '/url?q=https%3A%2F%2Fdocs.example%2Fb', title: 'B' },
      { href: 'https://docs.example/a', title: 'duplicate', snippet: 'ignored' },
      { href: '/url?url=https%3A%2F%2Fdocs.example%2Fc', title: 'C', snippet: '   ' },
    ], PLAYWRIGHT_DEFAULT_SEARCH_URL, 3)).toEqual([
      { url: 'https://docs.example/a', title: 'A', snippet: 'first' },
      { url: 'https://docs.example/b', title: 'B' },
      { url: 'https://docs.example/c', title: 'C' },
    ])
  })

  it('drops blank, malformed, non-HTTP, and malformed redirect rows', () => {
    expect(mapGoogleRows([
      { href: '', title: 'empty' },
      { href: 'https://docs.example/a', title: '   ' },
      { href: 'mailto:test@example.com', title: 'mail' },
      { href: 'http://[', title: 'invalid' },
      { href: '/url', title: 'missing redirect' },
      { href: '/url?q=not-a-url', title: 'bad redirect' },
    ], PLAYWRIGHT_DEFAULT_SEARCH_URL)).toEqual([])
  })
})

describe('PlaywrightSearchProvider', () => {
  it('reports only locally valid configuration as available', async () => {
    const harness = fakeBrowser(resultHtml([], true))
    expect(provider(harness).available()).toBe(true)
    expect(provider(harness, { searchURL: 'not a url' }).available()).toBe(false)
    expect(provider(harness, { searchURL: 'file:///tmp/search' }).available()).toBe(false)
    expect(provider(harness, { navigationTimeoutMs: 0 }).available()).toBe(false)
    expect(provider(harness, { navigationTimeoutMs: 1.5 }).available()).toBe(false)
    expect(provider(harness, { botCheckTimeoutMs: 0 }).available()).toBe(false)
    expect(provider(harness, { executablePath: '' }).available()).toBe(false)
    expect(provider(harness, { userDataDir: 'relative-profile' }).available()).toBe(false)
    expect(provider(harness, { locale: '' }).available()).toBe(false)
    const closing = provider(harness)
    await closing.close()
    expect(closing.available()).toBe(false)
  })

  it('launches Chromium once and maps isolated-page results', async () => {
    const harness = fakeBrowser(resultHtml([
      { href: 'https://docs.example/a', title: 'A', snippet: 'one' },
      { href: 'https://docs.example/b', title: 'B', snippet: 'two' },
    ]))
    const search = provider(harness, {
      headless: false,
      executablePath: '/opt/chromium',
      locale: 'de-DE',
      navigationTimeoutMs: 1234,
    })
    await expect(search.search({ query: 'a & b', maxResults: 1 })).resolves.toEqual({
      sources: [{ url: 'https://docs.example/a', title: 'A', snippet: 'one' }],
      truncated: true,
    })
    await expect(search.search({ query: 'second' })).resolves.toMatchObject({ sources: [{ title: 'A' }, { title: 'B' }] })
    expect(harness.launch).toHaveBeenCalledOnce()
    expect(harness.launch).toHaveBeenCalledWith({ headless: false, executablePath: '/opt/chromium' })
    expect(harness.newContext).toHaveBeenCalledTimes(2)
    expect(harness.newContext).toHaveBeenCalledWith({ locale: 'de-DE' })
    expect(harness.goto).toHaveBeenNthCalledWith(1, 'https://www.google.com/search?hl=en&q=a+%26+b', {
      waitUntil: 'domcontentloaded',
      timeout: 1234,
    })
    expect(harness.closeContext).toHaveBeenCalledTimes(2)
    await search.close()
    expect(harness.closeBrowser).toHaveBeenCalledOnce()
    await search.close()
  })

  it('reuses one persistent profile context and closes only each search page', async () => {
    const harness = fakeBrowser(resultHtml([{ href: 'https://docs.example/a', title: 'A' }]))
    const search = provider(harness, {
      headless: false,
      executablePath: '/opt/chromium',
      userDataDir: '/tmp/dsh-google-profile',
      locale: 'de-DE',
    })

    await search.search({ query: 'first' })
    await search.search({ query: 'second' })

    expect(harness.launch).not.toHaveBeenCalled()
    expect(harness.launchPersistent).toHaveBeenCalledOnce()
    expect(harness.launchPersistent).toHaveBeenCalledWith('/tmp/dsh-google-profile', {
      headless: false,
      executablePath: '/opt/chromium',
      locale: 'de-DE',
    })
    expect(harness.newContext).not.toHaveBeenCalled()
    expect(harness.closePage).toHaveBeenCalledTimes(2)
    expect(harness.closeContext).not.toHaveBeenCalled()
    await search.close()
    expect(harness.closeContext).toHaveBeenCalledOnce()
  })

  it('returns an explicit no-results page as an empty result', async () => {
    const harness = fakeBrowser(resultHtml([], true))
    await expect(provider(harness).search({ query: 'nothing' })).resolves.toEqual({ sources: [], truncated: false })
  })

  it('maps heading links when Google changes the result wrapper', async () => {
    const harness = fakeBrowser(`<!doctype html><div id="search"><section class="new-result">
      <a href="https://docs.example/new"><h3>New wrapper</h3></a>
      <div data-sncf>New snippet</div>
    </section></div>`)
    await expect(provider(harness).search({ query: 'q' })).resolves.toEqual({
      sources: [{ url: 'https://docs.example/new', title: 'New wrapper', snippet: 'New snippet' }],
      truncated: false,
    })
  })

  it('rejects Google consent and then reads the navigated result page', async () => {
    const results = new JSDOM(resultHtml([{ href: 'https://docs.example/a', title: 'A' }]))
    const harness = fakeBrowser('<html><body><form action="https://consent.google.com/save"><button>Alle ablehnen</button></form></body></html>', {
      pageURL: 'https://consent.google.com/m?continue=https://www.google.com/search',
      click: (_element, document) => { document.body.innerHTML = results.window.document.body.innerHTML },
    })
    await expect(provider(harness).search({ query: 'q' })).resolves.toMatchObject({ sources: [{ title: 'A' }] })
  })

  it('distinguishes persistent consent, unattended bot checks, and unknown markup', async () => {
    const consent = fakeBrowser('<html><body><form action="https://consent.google.com/save"></form></body></html>', {
      pageURL: 'https://consent.google.com/m',
    })
    await expect(provider(consent).search({ query: 'q' }))
      .rejects.toThrow('Google consent remained at consent.google.com/m')

    const challenge = fakeBrowser('<html><body><form id="captcha-form"></form></body></html>', {
      pageURL: 'https://www.google.com/sorry/index',
    })
    await expect(provider(challenge).search({ query: 'q' }))
      .rejects.toThrow('configure headless false and an absolute userDataDir')

    const harness = fakeBrowser('<html><body>unexpected</body></html>')
    await expect(provider(harness).search({ query: 'q' }))
      .rejects.toThrow('Google result markup was not recognized at www.google.com/search')
  })

  it('waits for a person to complete a bot check in a visible persistent profile', async () => {
    let pageURL = 'https://www.google.com/sorry/index'
    const results = new JSDOM(resultHtml([{ href: 'https://docs.example/a', title: 'A' }]))
    const harness = fakeBrowser('<html><body><form id="captcha-form"></form></body></html>', {
      pageURL: () => pageURL,
      waitForFunction: async (document) => {
        pageURL = PLAYWRIGHT_DEFAULT_SEARCH_URL
        document.body.innerHTML = results.window.document.body.innerHTML
      },
    })
    const search = provider(harness, {
      headless: false,
      userDataDir: '/tmp/dsh-google-profile',
      botCheckTimeoutMs: 123_000,
    })

    await expect(search.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ title: 'A' }] })
    expect(harness.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 123_000 },
    )
    await search.close()
  })

  it('reports a visible bot check that exceeds the manual deadline', async () => {
    const harness = fakeBrowser('<html><body><form id="captcha-form"></form></body></html>', {
      pageURL: 'https://www.google.com/sorry/index',
      waitForFunction: async () => { throw new Error('timeout') },
    })
    const search = provider(harness, {
      headless: false,
      userDataDir: '/tmp/dsh-google-profile',
      botCheckTimeoutMs: 42,
    })

    await expect(search.search({ query: 'q' }))
      .rejects.toThrow('Google bot check at www.google.com/sorry/index was not completed within 42ms')
    await search.close()
  })

  it('maps launch and page failures to provider errors and retries a failed launch', async () => {
    const harness = fakeBrowser(resultHtml([], true))
    harness.launch.mockRejectedValueOnce(new Error('browser missing'))
    const search = provider(harness)
    await expect(search.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Playwright search failed: Error: browser missing' }))
    await expect(search.search({ query: 'retry' })).resolves.toMatchObject({ sources: [] })
    expect(harness.launch).toHaveBeenCalledTimes(2)

    const navigation = fakeBrowser(resultHtml([], true), { goto: () => Promise.reject(new Error('navigation failed')) })
    await expect(provider(navigation).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('relaunches after the cached browser disconnects', async () => {
    const disconnected = fakeBrowser(resultHtml([], true), { connected: false })
    const connected = fakeBrowser(resultHtml([], true))
    const launch = vi.fn()
      .mockResolvedValueOnce(disconnected.browser)
      .mockResolvedValueOnce(connected.browser)
    const search = new PlaywrightSearchProvider({ ...DEFAULT_OPTIONS, launchBrowser: launch })
    await expect(search.search({ query: 'q' })).resolves.toMatchObject({ sources: [] })
    await expect(search.search({ query: 'again' })).resolves.toMatchObject({ sources: [] })
    expect(launch).toHaveBeenCalledTimes(2)
    await search.close()
  })

  it('rejects preflight and in-flight cancellation as WEB_ABORTED', async () => {
    const harness = fakeBrowser(resultHtml([], true))
    const preflight = new AbortController()
    preflight.abort(new Error('before'))
    await expect(provider(harness).search({ query: 'q' }, preflight.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(harness.launch).not.toHaveBeenCalled()

    let releaseNavigation: (() => void) | undefined
    const navigation = fakeBrowser(resultHtml([], true), {
      goto: () => new Promise<void>((resolve) => { releaseNavigation = resolve }),
    })
    const controller = new AbortController()
    const running = provider(navigation).search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(navigation.goto).toHaveBeenCalledOnce() })
    controller.abort(new Error('during navigation'))
    await expect(running).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(navigation.closeContext).toHaveBeenCalled()
    releaseNavigation?.()
  })

  it('closes only the active page when a persistent search is cancelled', async () => {
    let releaseNavigation: (() => void) | undefined
    const harness = fakeBrowser(resultHtml([], true), {
      goto: () => new Promise<void>((resolve) => { releaseNavigation = resolve }),
    })
    const search = provider(harness, { userDataDir: '/tmp/dsh-google-profile' })
    const controller = new AbortController()
    const running = search.search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(harness.goto).toHaveBeenCalledOnce() })

    controller.abort()

    await expect(running).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(harness.closePage).toHaveBeenCalled()
    expect(harness.closeContext).not.toHaveBeenCalled()
    releaseNavigation?.()
    await search.close()
    expect(harness.closeContext).toHaveBeenCalledOnce()
  })

  it('closes a context created after cancellation won its race', async () => {
    let releaseContext: ((context: BrowserContext) => void) | undefined
    const lateContext = fakeBrowser(resultHtml([], true))
    const harness = fakeBrowser(resultHtml([], true), {
      newContext: () => new Promise<BrowserContext>((resolve) => { releaseContext = resolve }),
    })
    const controller = new AbortController()
    const running = provider(harness).search({ query: 'q' }, controller.signal)
    await vi.waitFor(() => { expect(harness.newContext).toHaveBeenCalledOnce() })
    controller.abort()
    await expect(running).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    releaseContext?.(lateContext.browser.newContext === undefined
      ? {} as BrowserContext
      : await lateContext.browser.newContext())
    await vi.waitFor(() => { expect(lateContext.closeContext).toHaveBeenCalledOnce() })
  })

  it('fails new searches while closing and waits for active settlement', async () => {
    let releaseNavigation: (() => void) | undefined
    const harness = fakeBrowser(resultHtml([], true), {
      goto: () => new Promise<void>((resolve) => { releaseNavigation = resolve }),
    })
    const search = provider(harness)
    const running = search.search({ query: 'q' })
    await vi.waitFor(() => { expect(harness.goto).toHaveBeenCalledOnce() })
    const closing = search.close()
    await expect(search.search({ query: 'late' }))
      .rejects.toThrow('Playwright search provider is closing')
    releaseNavigation?.()
    await running
    await closing
  })

  it('shares one quiescent close across concurrent disposal calls', async () => {
    let releaseClose: (() => void) | undefined
    const harness = fakeBrowser(resultHtml([], true))
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve })
    harness.closeBrowser.mockReturnValue(closeBarrier)
    const search = provider(harness)
    await search.search({ query: 'q' })
    const first = search.close()
    const second = search.close()
    await vi.waitFor(() => { expect(harness.closeBrowser).toHaveBeenCalledOnce() })
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    releaseClose?.()
    await Promise.all([first, second])
  })
})

describe('web-search-playwright plugin registration', () => {
  it('registers HMR-safely and closes the browser on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PLAYWRIGHT_PROVIDER_ID })
    const close = vi.spyOn(PlaywrightSearchProvider.prototype, 'close').mockResolvedValue()
    const fiber = await ctx.plugin(playwrightPlugin, {})
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.web.search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await fiber.dispose()
    expect(close).toHaveBeenCalledOnce()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
    await ctx.fiber.dispose()
  })

  it('has the Loader-safe namespace export and validates config', async () => {
    expect('default' in playwrightPlugin).toBe(false)
    expect(playwrightPlugin.name).toBe('web-search-playwright')
    expect(playwrightPlugin.inject).toEqual(['web'])
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PLAYWRIGHT_PROVIDER_ID })
    await expect(ctx.plugin(playwrightPlugin, { navigationTimeoutMs: 0 }))
      .rejects.toThrow(/navigationTimeoutMs expected number >= 1/)
    await expect(ctx.plugin(playwrightPlugin, { locale: '' }))
      .rejects.toThrow(/locale expected string length >= 1/)
    await ctx.fiber.dispose()
  })
})

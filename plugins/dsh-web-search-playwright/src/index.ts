/**
 * Register the keyless Playwright-backed Google search provider in
 * `ctx.web`.
 * @module dsh-web-search-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_HEADLESS,
  PLAYWRIGHT_DEFAULT_LOCALE,
  PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_SEARCH_URL,
  PLAYWRIGHT_PROVIDER_ID,
  PlaywrightSearchProvider,
  type PlaywrightSearchProviderOptions,
} from './provider.ts'

export {
  PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_HEADLESS,
  PLAYWRIGHT_DEFAULT_LOCALE,
  PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS,
  PLAYWRIGHT_DEFAULT_SEARCH_URL,
  PLAYWRIGHT_PROVIDER_ID,
  PlaywrightSearchProvider,
  mapGoogleRows,
} from './provider.ts'
export type {
  GoogleResultRow,
  LaunchPersistentSearchContext,
  LaunchSearchBrowser,
  PlaywrightSearchProviderOptions,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-playwright'

/** The web service this provider registers into. */
export const inject = ['web']

/** Plugin configuration. */
export interface Config {
  /** Google Search endpoint. The provider sets its `q` query parameter. */
  searchURL?: string
  /** Whether Chromium runs without a visible window. */
  headless?: boolean
  /** Optional Chromium-family executable instead of Playwright's managed binary. */
  executablePath?: string
  /** Optional absolute directory for a dedicated persistent Chromium profile. */
  userDataDir?: string
  /** Locale assigned to browser contexts. */
  locale?: string
  /** Upper bound for one page navigation in milliseconds. */
  navigationTimeoutMs?: number
  /** Upper bound for manually completing a visible Google bot check. */
  botCheckTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  searchURL: z.string().min(1).default(PLAYWRIGHT_DEFAULT_SEARCH_URL),
  headless: z.boolean().default(PLAYWRIGHT_DEFAULT_HEADLESS),
  executablePath: z.string().min(1),
  userDataDir: z.string().min(1),
  locale: z.string().min(1).default(PLAYWRIGHT_DEFAULT_LOCALE),
  navigationTimeoutMs: z.number().step(1).min(1).default(PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS),
  botCheckTimeoutMs: z.number().step(1).min(1).default(PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS),
})

/** Settings namespace carrying the Playwright Google provider's browser configuration. */
export const WEB_SEARCH_PLAYWRIGHT_SETTINGS_NAMESPACE = 'web-search-playwright'

/** Resolve one schema-valid section into complete provider options. */
function resolveOptions(config: Config): PlaywrightSearchProviderOptions {
  return {
    searchURL: config.searchURL ?? PLAYWRIGHT_DEFAULT_SEARCH_URL,
    headless: config.headless ?? PLAYWRIGHT_DEFAULT_HEADLESS,
    locale: config.locale ?? PLAYWRIGHT_DEFAULT_LOCALE,
    navigationTimeoutMs: config.navigationTimeoutMs ?? PLAYWRIGHT_DEFAULT_NAVIGATION_TIMEOUT_MS,
    botCheckTimeoutMs: config.botCheckTimeoutMs ?? PLAYWRIGHT_DEFAULT_BOT_CHECK_TIMEOUT_MS,
    ...config.executablePath === undefined ? {} : { executablePath: config.executablePath },
    ...config.userDataDir === undefined ? {} : { userDataDir: config.userDataDir },
  }
}

/** Refuse endpoint protocols the provider cannot navigate as Web search. */
function validateConfig(config: Config): void {
  let url: URL
  try {
    url = new URL(resolveOptions(config).searchURL)
  } catch (_invalidSearchUrl) {
    throw new Error('searchURL must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('searchURL must be an absolute HTTP(S) URL')
  }
  const { userDataDir } = resolveOptions(config)
  if (userDataDir !== undefined && !isAbsolute(userDataDir)) {
    throw new Error('userDataDir must be an absolute path')
  }
}

/** Register one live-configured Playwright search provider and close every browser generation at teardown. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  let source: () => Config = () => config
  let provider = new PlaywrightSearchProvider(resolveOptions(config))
  const retiring = new Set<Promise<void>>()
  const replaceProvider = (): void => {
    const previous = provider
    provider = new PlaywrightSearchProvider(resolveOptions(source()))
    const closing = previous.close()
    retiring.add(closing)
    void closing.then(
      () => { retiring.delete(closing) },
      () => { retiring.delete(closing) },
    )
  }
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SEARCH_PLAYWRIGHT_SETTINGS_NAMESPACE, Config, config, {
      validate: validateConfig,
      setSource: (current) => {
        source = current
      },
      onChange: replaceProvider,
    })
  })
  const registered: WebSearchProvider = {
    id: PLAYWRIGHT_PROVIDER_ID,
    available: () => provider.available(),
    search: async (request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> => {
      await Promise.all(retiring)
      return provider.search(request, signal)
    },
  }
  ctx.effect(function* () {
    yield async () => {
      await provider.close()
      await Promise.all(retiring)
    }
  }, 'web-search-playwright.browser')
  ctx.web.registerSearchProvider(registered)
}

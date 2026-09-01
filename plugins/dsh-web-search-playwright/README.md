# dsh-web-search-playwright

Keyless Google search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The plugin registers a `WebSearchProvider` on `ctx.web` and pins the composed `web` row to `playwright-google`. The model-facing `web_search` tool stays owned by `@deepseek-ai/dsh-tool-web`.

Chromium runs locally through Playwright. No search API key is required. The browser does not receive Harness credentials and does not open result links; it only extracts titles, URLs, and snippets from the configured Google results page.

## Install

From any directory, into the profile you actually boot (usually `web`):

```sh
dsh plugin --profile web add github:src-one/dsh-web-search-playwright
```

pnpm ≥10 blocks the git `prepare` build until you allow it. Copy the package key from the first failed `add` into `$DSH_HOME/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-web-search-playwright: true
```

Then re-run the `add`. Restart the profile afterwards (`dsh web` or `dsh --profile web`). Bundle membership is applied at start, not through live patch reload.

From a local checkout (no build allowance):

```sh
pnpm --dir /path/to/dsh-web-search-playwright run build
dsh plugin --profile web add /path/to/dsh-web-search-playwright
```

Install Playwright's Chromium once per machine unless you set `executablePath`:

```sh
pnpm --dir /path/to/dsh-web-search-playwright exec playwright install chromium
```

Removing the bundle restores DeepSeek's shipped search provider:

```sh
dsh plugin --profile web remove dsh-web-search-playwright
```

## What the bundle changes

The patch replaces the `web` row's complete config (patches do not merge keys) and inserts the provider:

```yaml
- id: web
  config:
    searchProvider: playwright-google
    fetchProvider: http
- insert:
    - id: web-search-playwright
      name: dsh-web-search-playwright
```

Your profile's `cordis.patch.yml` can override the provider row after this layer. `$DSH_HOME/settings.yaml` already wins for live values once the plugin is mounted.

## Config

| Key | Default | Meaning |
|---|---|---|
| `searchURL` | `https://www.google.com/search?hl=en` | Google-compatible page. Existing query parameters are kept; `q` is set per request. |
| `headless` | `true` | Launch Chromium without a window. Set `false` to inspect the page or complete a bot check. |
| `executablePath` | Playwright-managed Chromium | Optional Chromium-family executable. |
| `userDataDir` | none | Absolute path to a dedicated persistent Chromium profile. |
| `locale` | `en-US` | Locale for browser contexts. |
| `navigationTimeoutMs` | `30000` | Page-navigation deadline. |
| `botCheckTimeoutMs` | `300000` | Deadline to complete a visible Google bot check by hand. |

Example profile overlay:

```yaml
- id: web-search-playwright
  config:
    headless: false
    userDataDir: /var/lib/dsh/playwright-google-profile
```

Use a dedicated, access-restricted directory for `userDataDir`. Do not point it at a regular Chrome profile, and do not share it across concurrent Chromium processes.

When `ctx.settings` is mounted, the plugin registers the live `web-search-playwright` section. A committed change replaces the browser generation: in-flight searches finish, then Chromium closes, then later searches use the new values. Invalid `searchURL` values and relative `userDataDir` paths are rejected without replacing the last good section.

## Browser lifecycle

Without `userDataDir`, one Chromium process is shared and each search gets a fresh context (no cookie reuse). With `userDataDir`, one persistent context is reused and each search gets its own page, so Google cookies survive later searches and process restarts. Caller cancellation closes only that search's context or page. Plugin disposal waits for active searches, then closes Chromium.

Before extraction, the provider clicks **Reject all** / **Alle ablehnen** on Google's optional-consent page. It never accepts optional consent. A bot-check page fails in headless or isolated mode. A visible persistent browser waits up to `botCheckTimeoutMs` for a person to complete the check, then continues. The provider never solves the check automatically.

## Development

```sh
pnpm install
pnpm test
pnpm run build
```

Tests fake Playwright; they do not download Chromium.

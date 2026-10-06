<p align="center">
  <img src="https://raw.githubusercontent.com/doubleagent-so/cli/main/assets/doubleagent.svg" width="80" height="80" alt="Double Agent">
</p>

<h1 align="center">Double Agent CLI</h1>

<p align="center"><code>@doubleagent-so/cli</code></p>

<p align="center">Install the Double Agent SDK, manage sites and keys, and check a live site from your terminal.</p>

<p align="center">
  <strong><a href="https://lab.doubleagent.dev">Live demo</a></strong> ·
  <a href="https://doubleagent.so/docs/cli/">Docs</a> ·
  <a href="https://doubleagent.so">Website</a> ·
  <a href="https://www.npmjs.com/package/@doubleagent-so/cli">npm</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/doubleagent-so/cli/issues">Report an issue</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/LICENSE">MIT license</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@doubleagent-so/cli"><img src="https://img.shields.io/npm/v/@doubleagent-so/cli.svg" alt="npm"></a>
  <a href="https://github.com/doubleagent-so/cli/actions/workflows/ci.yml"><img src="https://github.com/doubleagent-so/cli/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/doubleagent-so/cli/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

Installs the Double Agent SDK into a project, manages sites and keys, and checks a live site. Installation commands need Node 18+ and no runtime dependencies. Website simulation needs Node 20+, the optional Playwright dependency and its Chromium browser.

```sh
npx @doubleagent-so/cli init                            # keyless install (no account), prints the claim URL
npx @doubleagent-so/cli init --email you@example.com    # create account + site, install its pk
npx @doubleagent-so/cli init --key pk_live_xxx          # install with an existing public key
npx @doubleagent-so/cli init --yes --json               # for coding agents: no prompt, machine-readable
npx @doubleagent-so/cli verify https://your-site.example
npx @doubleagent-so/cli login                           # device flow; then:
npx @doubleagent-so/cli sites
npx @doubleagent-so/cli keys [list|create|rotate|revoke] [key_id] [--site st_…] [--kind pk|sk] [--env live|test]
npx @doubleagent-so/cli verify-domain shop.example.com --method dns|meta|file|script [--site st_…]
```

## Agent Skill

For coding agents, the recommended path is the Agent Skill: `npx skills add doubleagent-so/skills`
([github.com/doubleagent-so/skills](https://github.com/doubleagent-so/skills)). Its helper scripts (verify,
create-account, snippet, simulate and agents) are bundled from this package's sources, so the skill and the CLI behave
the same. The same commands are available here as well:

```sh
npx @doubleagent-so/cli snippet <stack> [--key pk_…] [--json]   # html vite next-app next-pages astro nuxt sveltekit remix wordpress wix squarespace webflow shopify
npx @doubleagent-so/cli create-account --email you@x.com [--domain host] [--json]   # keys printed once
```

## Simulate website traffic

From any directory, install Chromium once and run an isolated behavioral observation or explicit marker test:

```sh
npx @doubleagent-so/cli simulate --install-browser
npx @doubleagent-so/cli simulate https://your-site.example --scenario observe
npx @doubleagent-so/cli simulate https://your-site.example --scenario agent --pause 2200 --duration 20 --headed
npx @doubleagent-so/cli simulate --list
npx @doubleagent-so/cli simulate --help
```

Runs use a fresh Chromium context. Bot and agent scenarios click/type on temporary
test controls added to the page, with short or quiet pauses; they leave site forms
alone. No marker is supplied unless `--evidence marker` is selected. Default runs block Double Agent telemetry; the independent detector
does not alter SDK storage. Add `--report` only to allow the website's existing SDK
to send synthetic traffic to its configured account. It requires a working SDK
and consent, and does not automatically mark visits as tests in the dashboard.

Set `--delay` (first action/marker delay in ms), `--pause` (between actions), `--profile`, `--scroll` (pixels), `--interval`
(ms), or `--user-agent` to reproduce a case. `--output` selects the JSON report path
(default `doubleagent-simulation.json`); `--json` also prints the report without
progress messages. Reports include both local and installed SDK verdicts, their
models, a behavior-only diagnostic, supplied evidence, collected signals and reporting status. A fixture pass
checks the evidence, not real-agent identity or a guaranteed class. Playwright can
be classified as a bot in Observe mode; real human controls need a normal browser.

Exit `0`: completed observation or collected fixture. Exit `1`: invalid arguments,
browser/navigation error, missing fixture evidence, or requested reporting not
confirmed. Target-page JavaScript errors appear in the report's `errors`.

The skill's [simulation guide](https://github.com/doubleagent-so/skills/blob/main/skills/doubleagent/references/simulate.md)
covers interpreting bot-versus-agent results.

### Confirm a simulation

Startup output states browser visibility and reporting mode. Each completed action
and collection response is printed, followed by the installed SDK session ID for
dashboard lookup. Reports retain `actions` and `reporting.receipts` without request
bodies, keys or URL queries. The `--json` option suppresses progress output.
Use `--headed` to watch Chromium and `--report` to allow the site's SDK to collect
this synthetic visit.

## ERC-8004 registry identities

Read-only lookup of an agent in the ERC-8004 identity registry, through an Ethereum RPC you choose:

```sh
export DOUBLEAGENT_ETHEREUM_RPC_URL=https://ethereum-rpc.publicnode.com
npx @doubleagent-so/cli agents resolve --agent-name erc8004.agent-1 --token-id 1 --output agent-identity.json
```

Names use `operator.agent-name`; the independent `agent_ref` string includes chain, contract
and token ID. `--reviewers` opts into selected reputation; `--site` resolves and
saves a mapping using your login and the API's configured RPC. List/remove site
mappings with `agents list` / `agents remove` and `--site`.

To attach a lookup to an isolated simulation:

```sh
npx @doubleagent-so/cli simulate https://your-site.example --scenario agent --agent-name erc8004.agent-1 --token-id 1 --resolve-identity --output simulation.json
```

Token 1 and its chosen alias are lookup examples, not an assertion that its owner
controls this browser. The snapshot remains `visit_binding: unverified` and local
to the report. The name/reference also travel as a User-Agent declaration; add
`--report` to associate them with SDK visits. Omit `--resolve-identity` to declare
without an RPC. Ethereum-signed telemetry (ERC-8128) is opt-in with `--sign-requests` and
`--sign-api`, with the key in `DOUBLEAGENT_ETHEREUM_PRIVATE_KEY`; wallet and registry badges stay separate from
behavior. The skill's [identity guide](https://github.com/doubleagent-so/skills/blob/main/skills/doubleagent/references/erc8004.md)
covers the rest.

## init

- **Keyless (default).** With no key, init installs the bare script tag and prints `Claim <domain> at <portal>/claim?domain=<domain>`. The domain comes from `--domain`, else the `package.json` `homepage`, else a `CNAME` file.
- **Existing key.** `--key pk_…` (or `$DOUBLEAGENT_KEY`) adds the key. Running init again with a key on a keyless install adds `data-key` in place, and a different key replaces the old one.
  - Secret keys (`sk_…`) are refused.
  - Keys must match the API's `pk_(live|test)_[A-Za-z0-9]{1,64}`.
- **New account.** `--email you@x.com [--domain host] [--name …] [--test]` calls `POST /v1/accounts`.
  - The CLI sends `DA-PoW: <unix_seconds>:<solution>`, solved up front at the API's default difficulty (18 bits; about 0.3 s), with SHA-256(`da-accounts|<email>|<ts>|<solution>`). If a 428 `pow_required` names a higher `difficulty`, it solves again and retries once.
  - It installs the new `pk_live` (or `pk_test` with `--test`).
  - It prints the `sk_test` once, along with the domain-verification token.
  - `--dry-run` never creates an account.

Each run prints a unified diff of what it changes. It asks before writing only in an interactive terminal: `--yes` skips the prompt, and so does `--json` or a non-TTY run. Running it again on an installed project changes nothing.

| Stack | Where the snippet goes |
|---|---|
| Next.js app router | `app/layout.*` (or `src/app/`): `next/script` `strategy="beforeInteractive"` in `<head>`, or the start of `<body>` |
| Next.js pages router | `pages/_document.*` `<Head>`. The file is created if missing. |
| Vite / React / Vue (Lovable, Bolt, v0) | `index.html` `<head>`, before the first script |
| Static HTML | every root `*.html` file, or `public/index.html` |
| Astro | `src/layouts/*.astro` `<head>`, as `is:inline` scripts |
| Nuxt | `nuxt.config` `app.head.script`. If the config already has an `app:` block, `plugins/doubleagent.client.*` is used instead. |
| SvelteKit | `src/app.html`, before `%sveltekit.head%` |
| Remix / React Router | `app/root.*` `<head>` |
| WordPress theme | `header.php`, before `wp_head()` |
| Shopify theme | No files are edited. Use the app embed (Theme editor → App embeds). |

init also lists the integrations that `integrations: 'auto'` will turn on (ga4, gtm, meta, tiktok, gads, klaviyo, mixpanel, segment, posthog, amplitude, hubspot, intercom, clarity, hotjar, stripe, mailchimp, shopify). It finds them from dependencies and source snippets.

`--json` prints `{ stack, stack_label, platform, status, dry_run, keyless, key, domain, claim_url, files_changed, planned_changes, account, integrations, warnings, notes, next_steps, diff }`. `account` holds the `POST /v1/accounts` response, or `null` when no account was created. `status` is one of `install`, `installed`, `update-key`, `advice` or `unsupported`.

Exit codes: `0` ok, `1` error or aborted, `2` stack not supported (the snippet to add by hand is in `next_steps`).

## login, sites, keys, verify-domain

- **`login`** uses the device flow:
  - It calls `POST /v1/auth/device` and shows the code and URL to approve in the portal.
  - It polls `/v1/auth/device/token`, honouring `authorization_pending`, `slow_down` and `expired`.
  - It saves `{ api, session, email }` to `~/.config/doubleagent/credentials.json` with mode `0600`. The location follows `$XDG_CONFIG_HOME`, and `$DOUBLEAGENT_CONFIG_DIR` overrides it.
  - `$DOUBLEAGENT_SESSION` can supply a session instead.
  - `logout [--all]` revokes the session and deletes the file.
- **`sites`** lists accounts and sites from `GET /v1/me`.
- **`keys`** works on the site given by `--site`, or on your only site. A new or rotated `sk` is printed once.
- **`verify-domain <host> --method dns|meta|file|script`** adds the domain (a 409 for an existing one is fine), then asks the API to verify it.
  - On success it prints the number of claimed sessions.
  - Otherwise it prints what to publish, such as a TXT record at `_doubleagent.<host>` = `da-verify=<token>`, the meta tag, or `/.well-known/doubleagent.txt`, and exits `1`.

API origin: `--api`, then `$DOUBLEAGENT_API`, then the one saved at login, then `https://api.doubleagent.so`. Portal: `--portal`, then `$DOUBLEAGENT_PORTAL`, then `https://app.doubleagent.so`.

## verify

`verify <url>` fetches the page and checks for three things: the SDK script, the queue stub, and a `data-key` that looks like a real key. It then calls `{api}/v1/install-check?url=` and prints the answer. A script with no `data-key` counts as a valid keyless install. The API is the page's `data-endpoint`, or `--api`, or `https://api.doubleagent.so` by default.

The install check answers with `{ ok, script_found, script_src, key, key_valid, profile_attr, stub_before_script, integrations_detected, last_beacon_at, problems: [{ code, message, fix }] }`.

- The human-readable output prints each problem followed by its `fix`.
- `--json` returns the raw answer as `installCheck.body` and a parsed version as `installCheck.check`.
- Any field may be missing.

It exits `0` only if all three checks pass. A tag injected client side (for example by the Nuxt plugin fallback) is not in the server HTML, so verify can't see it.

## Development

```sh
npm ci
npm test                # vitest
npm run test:coverage   # ≥ 90% lines and branches on src/
npm run typecheck
npm run build           # dist/doubleagent.mjs and dist/simulation-probe.js
```

The simulation tests drive a real Chromium: run `npx playwright install chromium` once. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## Support

- Questions and bugs: [open an issue](https://github.com/doubleagent-so/cli/issues/new/choose).
- Private account or billing questions: [support@doubleagent.so](mailto:support@doubleagent.so). Never post secret keys or session tokens in a public issue.
- Security problems: report them privately as described in [SECURITY.md](https://github.com/doubleagent-so/cli/blob/main/SECURITY.md).

<p align="center">
  Maintained by <a href="https://doubleagent.so">Double Agent</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/CODE_OF_CONDUCT.md">Code of conduct</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/SECURITY.md">Security</a> ·
  <a href="https://github.com/doubleagent-so/cli/blob/main/LICENSE">MIT license</a>
</p>

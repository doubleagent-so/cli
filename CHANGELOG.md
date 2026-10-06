# Changelog

## 0.2.1 — 2026-10-06

- **Detection engine 0.4.1:** built with `@doubleagent-so/agent-detector` 0.4.1, a docs and tooling release, so
  `simulate` verdicts are the same as with 0.2.0.
- **Security:** API and portal URLs trim trailing slashes with a linear scan, and `verify-domain` cuts the host at the
  first slash, instead of regular expressions that crafted input could stall (ReDoS). The install snippet's CDN URL is
  escaped with a full regular-expression escape that covers backslashes. Both were CodeQL findings.
- **Fix:** `verify-domain` now discards a path that contains a line break, instead of keeping it in the host.
- **Docs:** shared Double Agent README header, top links, footer and badges, with links on doubleagent.so.
- **Maintenance:** dev dependency updates (#1). The release workflow now also creates the GitHub Release, with this
  changelog section as its notes.

## 0.2.0 — 2026-10-04

- **Detection engine 0.4.0:** `simulate` scores with `@doubleagent-so/agent-detector` 0.4.0 (fewer false positives from
  three behaviour codes, frustration cues, the verdict's `evidence` field), so its verdicts can differ from 0.1.0.
- **Standalone:** the CLI owns its ERC-8004 identity code (agent names and references, User-Agent declarations,
  registry lookups and ERC-8128 request signing) and builds, typechecks and tests on its own: `npm ci`,
  `npm run test:coverage`, `npm run build`. It uses `@doubleagent-so/agent-detector` from npm. No command or output
  changes.

## 0.1.0 — 2026-09-27

First public release.

- **`init`** installs the Double Agent SDK in Next.js (app and pages router), Vite, static HTML, Astro, Nuxt,
  SvelteKit, Remix / React Router and WordPress projects: keyless with a claim URL, with an existing public key, or
  with a new account (`--email`, proof of work solved up front). It prints a diff, asks before writing in a
  terminal, refuses secret keys and changes nothing on a second run. `--json` for coding agents.
- **`verify`** checks a live page for the SDK script, the queue stub and a valid key, and prints the API's install
  check with a fix for each problem.
- **`login`** (device flow), **`logout`**, **`sites`**, **`keys`** and **`verify-domain`** for accounts, sites, keys
  and domain verification.
- **`snippet`** and **`create-account`**: the commands behind the Agent Skill helpers.
- **`simulate`** runs an isolated Chromium visit (observe, bot or agent scenarios, optional marker evidence) and
  reports local and installed SDK verdicts; telemetry is blocked unless `--report`.
- **`agents`** resolves ERC-8004 registry identities read-only and manages site associations; simulations can
  declare an identity in the User-Agent and sign telemetry with ERC-8128.

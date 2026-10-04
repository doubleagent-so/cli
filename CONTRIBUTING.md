# Contributing

Thanks for helping sites install Double Agent. The most useful contributions are:

- **A project `init` gets wrong.** A stack it does not detect, a file it edits in the wrong place, or an edit that
  breaks the build. Open a bug with the smallest project that shows it (the relevant files, keys removed).
- **A new stack or platform** for `init` and `snippet`.
- **A simulation that misbehaves:** the command, the report (`--json`) and what you expected.

## Workflow

```sh
npm ci
npx playwright install chromium   # once, for the simulation tests
npm test                          # vitest
npm run test:coverage             # ≥ 90% lines and branches on src/
npm run typecheck
npm run build                     # dist/, as published
```

## Project layout

| Path | |
|---|---|
| `src/main.ts`, `src/bin.ts` | Process entry: argv, stdin/stdout and exit codes |
| `src/cli.ts` | Argument parsing and the command table |
| `src/project.ts`, `src/detect.ts` | Reads a project and decides its stack |
| `src/install.ts`, `src/edit.ts`, `src/diff.ts`, `src/snippet.ts` | What `init` writes, where, and the diff it prints |
| `src/analytics.ts` | Integrations `init` and `verify` detect |
| `src/verify.ts` | `verify`: page checks and the API's install check |
| `src/account.ts`, `src/api.ts`, `src/config.ts`, `src/pow.ts` | Accounts, login, sites, keys and domains; the API client; saved credentials; proof of work |
| `src/skill.ts` | `snippet` and `create-account`, the commands behind the Agent Skill helpers |
| `src/agents.ts`, `src/identity/` | `agents`: ERC-8004 names, references, registry lookups and request signing |
| `src/simulation/` | `simulate`: options, the Playwright run, the browser probe and telemetry receipts |
| `test/` | Vitest suites |
| `scripts/build.mjs` | Builds `dist/doubleagent.mjs` and `dist/simulation-probe.js` |

## Rules

1. **Test first.** Write the failing test, then the change.
2. **Never break a project.** `init` edits only what it prints in its diff, asks before writing in a terminal, and
   changes nothing on a second run. Secret keys (`sk_…`) are never written into client code.
3. **No runtime dependencies.** Everything except the optional Playwright is bundled into `dist/`; the installation
   commands run on Node 18+.
4. **Wire formats are shared with the Double Agent API.** The install snippet, proof of work, User-Agent identity
   declarations and request signatures must stay what the API accepts; say in the pull request when one changes.
5. **JSON output is an interface.** Coding agents read `--json`; add fields, do not rename or remove them.
6. async/await only, no `.then` chains. `npm run typecheck` must pass.

## Releases

Maintainers bump `version` in `package.json`, update `CHANGELOG.md`, and push a `v<version>` tag. The release
workflow tests, builds and publishes the package to npm with provenance.

Security issues go to [Security](SECURITY.md), not public issues.

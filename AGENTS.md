# Agent instructions

`@doubleagent-so/cli`: installs the Double Agent SDK into a project, manages accounts, sites and keys, verifies a live
site, simulates agent traffic and resolves ERC-8004 identities. Public, MIT. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before changing what `init` writes or what the CLI sends.

## Commands

```sh
npm ci
npx playwright install chromium   # once, for the simulation tests
npm test                          # vitest
npm run test:coverage             # ≥ 90% lines and branches on src/
npm run typecheck
npm run build                     # dist/doubleagent.mjs and dist/simulation-probe.js
```

## Rules

- Test first. Every behaviour change starts with a failing test.
- `init` edits only what its diff shows, asks before writing in a terminal, is idempotent and never writes a secret
  key into client code.
- No runtime dependencies: everything but the optional Playwright is bundled into `dist/`. Installation commands run
  on Node 18+.
- The install snippet, proof of work, identity declarations and request signatures are wire formats the Double Agent
  API accepts. Changing one is a coordinated change with the server.
- `--json` output is read by coding agents: add fields, never rename or remove them.
- async/await, no `.then` chains.
- Nothing private: no internal hosts, keys or customer data. Security reports go to SECURITY.md, not issues.

## Used as a submodule

The Double Agent monorepo checks this repo out at `packages/cli` as a git submodule. When working from there, commit
and push here first (a submodule starts on a detached HEAD: `git switch main && git pull` before editing), then bump
the pointer in the monorepo. Its CI fails if the pinned commit is not on this repo's `main`.

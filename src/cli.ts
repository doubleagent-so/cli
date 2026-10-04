import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createAccount, keys, login, logout, sites, verifyDomain, type CreatedAccount } from './account';
import { detectIntegrations } from './analytics';
import { ApiError } from './api';
import { detectStack, type Stack } from './detect';
import { unifiedDiff } from './diff';
import { InstallError, planInstall, type Plan } from './install';
import { CliError, portalBase, str, type Args, type Io } from './io';
import { openProject, type Project } from './project';
import { htmlSnippet, KEY_RE, SECRET_KEY_RE } from './snippet';
import { createAccountCmd, snippetCmd } from './skill';
import { verify, type InstallCheck } from './verify';
import { simulateCmd, SIMULATE_HELP } from './simulation/command';
import { agentsCmd, AGENTS_HELP } from './agents';

export type { Io } from './io';

const HELP = `doubleagent: install Double Agent, manage sites and keys

Usage
  npx @doubleagent-so/cli init [--key pk_… | --email you@example.com [--domain host] [--test]]
                       [--profile auto] [--dry-run] [--yes] [--json] [--cwd dir]
  npx @doubleagent-so/cli verify <url> [--api origin] [--json]
  npx @doubleagent-so/cli simulate <url> [--scenario observe|bot|agent] [--headed] [--json]
  npx @doubleagent-so/cli agents resolve|list|remove [--site st_…] [--json]
  npx @doubleagent-so/cli login | logout [--all]
  npx @doubleagent-so/cli sites [--json]
  npx @doubleagent-so/cli keys [list|create|rotate|revoke] [key_id] [--site st_…] [--kind pk|sk] [--env live|test] [--json]
  npx @doubleagent-so/cli verify-domain <host> --method dns|meta|file|script [--site st_…] [--json]
  npx @doubleagent-so/cli snippet <stack> [--key pk_…] [--json]
  npx @doubleagent-so/cli create-account --email you@example.com [--domain host] [--json]

init           Installs the snippet. Without a key it installs keyless (claim the domain later to see data).
               --key sets a public key (or $DOUBLEAGENT_KEY); --email creates an account + site and uses its pk.
verify         Fetches <url>, checks the script tag, stub and key, and asks the API's install check.
login          Device-flow login; the session is saved to ~/.config/doubleagent/credentials.json (0600).
sites, keys    List sites; list, create, rotate or revoke keys (needs login).
verify-domain  Adds <host> to the site and verifies it (needs login).`;

const BOOL_FLAGS = new Set(['dry-run', 'yes', 'y', 'json', 'help', 'h', 'test', 'all', 'headed', 'report', 'list', 'install-browser', 'resolve-identity', 'sign-requests']);
/** Flags that need a value: `--email` with nothing after it must fail, not silently fall back. */
const VALUE_FLAGS = ['key', 'email', 'domain', 'name', 'profile', 'site', 'kind', 'env', 'method', 'api', 'portal', 'cwd'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseArgs(argv: string[]): Args {
  const out: Args = { pos: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || /^-[a-z]$/.test(a)) {
      const [k, v] = a.replace(/^-+/, '').split(/=(.*)/s, 2);
      if (v !== undefined) out.flags[k] = v;
      else if (BOOL_FLAGS.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('-')) out.flags[k] = true;
      else out.flags[k] = argv[++i];
    } else if (!out.cmd) out.cmd = a;
    else out.pos.push(a);
  }
  return out;
}

const COMMANDS: Record<string, (args: Args, io: Io) => Promise<number>> = {
  init, verify: verifyCmd, login, logout, sites, keys, 'verify-domain': verifyDomain,
  snippet: snippetCmd, 'create-account': createAccountCmd,
  simulate: simulateCmd,
  agents: agentsCmd,
};

const COMMAND_HELP: Record<string, string> = { simulate: SIMULATE_HELP, agents: AGENTS_HELP };
const wantsHelp = (args: Args): boolean => !!(args.flags.help || args.flags.h) || !args.cmd || args.cmd === 'help';

/** Prints a failed command's error (with a stack only when it is unexpected) and returns its exit code. */
function reportError(args: Args, io: Io, e: unknown): number {
  const known = e instanceof InstallError || e instanceof CliError || e instanceof ApiError;
  const msg = known ? (e as Error).message : (e as Error).stack ?? String(e);
  if (args.flags.json) io.out(JSON.stringify({ error: msg, ...(e instanceof ApiError ? { code: e.code, status: e.status } : {}) }, null, 2));
  else io.err(`error: ${msg}`);
  return e instanceof CliError ? e.exitCode : 1;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (wantsHelp(args)) { io.out(COMMAND_HELP[args.cmd ?? ''] ?? HELP); return 0; }
  const cmd = COMMANDS[args.cmd!];
  if (!cmd) { io.err(`unknown command "${args.cmd}"\n\n${HELP}`); return 1; }
  try {
    const bare = VALUE_FLAGS.find((f) => args.flags[f] === true);
    if (bare) throw new CliError(`invalid --${bare}: expected a value`);
    return await cmd(args, io);
  } catch (e) {
    return reportError(args, io, e);
  }
}

// ---- init -------------------------------------------------------------------------------------

/** Best guess at the production hostname: --domain, package.json homepage, or a GitHub Pages CNAME. */
function guessDomain(p: Project): string | undefined {
  const home = (p.pkg as { homepage?: string } | null)?.homepage;
  try { if (home) return new URL(home).hostname; } catch { /* not a URL */ }
  return p.read('CNAME')?.trim().split(/\s/)[0] || p.read('public/CNAME')?.trim().split(/\s/)[0] || undefined;
}

interface InitContext { stack: Stack; plan: Plan; profile: string; key?: string; keyless: boolean; domain?: string; claimUrl: string; account?: CreatedAccount; email?: string }

function nextSteps(c: InitContext): string[] {
  const { stack, plan } = c;
  if (stack.id === 'shopify-theme') {
    return [
      'Add these tags once inside the head of layout/theme.liquid, before other scripts:',
      ...htmlSnippet({ key: c.key, profile: c.profile }).map((l) => `  ${l}`),
      'Save and publish the theme, then visit the storefront with a cart to check the _da_* cart attributes.',
    ];
  }
  if (plan.status === 'unsupported') {
    return ['Paste this into the <head> of every page, before other scripts:', ...htmlSnippet({ key: c.key, profile: c.profile }).map((l) => `  ${l}`)];
  }
  const site = c.domain ?? '<your-domain>';
  const steps: string[] = [];
  if (c.keyless) {
    steps.push(`Installed without a key. Claim ${site} at ${c.claimUrl} to see retained data. Retention and collection limits apply.`);
  }
  steps.push(`Deploy, then run: npx @doubleagent-so/cli verify https://${site}`);
  if (c.account) {
    const v = c.account.verify;
    steps.push(`Confirm your email: check ${c.email} for the login link${c.account.login_url ? ` (or open ${c.account.login_url})` : ''}.`);
    if (v?.token) steps.push(`Verify ${v.hostname ?? site} to see data: DNS TXT _doubleagent.${v.hostname ?? site} "da-verify=${v.token}" (then run: npx @doubleagent-so/cli login && npx @doubleagent-so/cli verify-domain ${v.hostname ?? site} --method dns)`);
  } else if (!c.keyless) {
    steps.push(`Unlock the dashboard: npx @doubleagent-so/cli login, then npx @doubleagent-so/cli verify-domain ${site} --method dns`);
  } else {
    steps.push('Optional: npx @doubleagent-so/cli init --email you@example.com adds an account and key (live view, check()/tokens, webhooks).');
  }
  if (!c.keyless) steps.push('Server side: verify tokens from doubleagent.getToken(action) with @doubleagent-so/node (createDoubleAgent().verifyToken) before trusting them.');
  return steps;
}

function readKey(args: Args, io: Io): string | undefined {
  const given = str(args.flags.key) ?? io.env.DOUBLEAGENT_KEY;
  if (given === undefined) return undefined;
  if (SECRET_KEY_RE.test(given)) throw new InstallError('that is a secret key (sk_…): it must never be put in client code. Use the site\'s public key (pk_…).');
  if (!KEY_RE.test(given)) throw new InstallError(`"${given}" is not a public key (expected pk_live_… or pk_test_…)`);
  return given;
}

interface InitOptions {
  asJson: boolean;
  cwd: string;
  email?: string;
  /** The public key from --key or $DOUBLEAGENT_KEY. */
  given?: string;
  env: 'test' | 'live';
  profile: string;
  dryRun: boolean;
  yes: boolean;
}

/** init's flags, checked: a public key or an email, never both. */
function initOptions(args: Args, io: Io): InitOptions {
  const cwd = resolve(io.cwd, str(args.flags.cwd) ?? '.');
  const email = str(args.flags.email);
  const given = readKey(args, io);
  if (email && given) throw new InstallError('use either --email (creates a key) or --key, not both');
  if (email !== undefined && !EMAIL_RE.test(email)) throw new InstallError(`"${email}" is not an email address`);
  return {
    asJson: !!args.flags.json, cwd, email, given,
    env: args.flags.test ? 'test' : 'live',
    profile: str(args.flags.profile) ?? 'auto',
    dryRun: !!args.flags['dry-run'],
    yes: !!(args.flags.yes || args.flags.y),
  };
}

/** Asks before writing, unless there is nothing to write, no prompt, or --yes / --json. */
async function confirmInit(io: Io, o: InitOptions, plan: Plan): Promise<boolean> {
  if (!plan.changes.length || o.asJson || o.yes || !io.confirm) return true;
  return io.confirm(`Apply ${plan.changes.length} change(s)${o.email ? ` and create an account for ${o.email}` : ''}? [Y/n] `);
}

/** The new account's public key for the chosen environment, else whichever it has. */
function publicKeyOf(account: CreatedAccount, env: InitOptions['env']): string {
  const key = account.keys?.[`pk_${env}`] ?? account.keys?.pk_live ?? account.keys?.pk_test;
  if (!key) throw new CliError('the account was created but the API returned no public key');
  return key;
}

/** Writes the planned files; with a new account, its key replaces the placeholder the plan was made with. */
function writeChanges(cwd: string, plan: Plan, replace: { pending: string; key: string } | null): void {
  for (const c of plan.changes) {
    const abs = join(cwd, c.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, replace ? c.after.split(replace.pending).join(replace.key) : c.after);
  }
}

interface Applied { applied: boolean; account?: CreatedAccount; key?: string }

/** Creates the account for --email, then writes the files. Null when the user declines. */
async function applyInit(args: Args, io: Io, o: InitOptions, plan: Plan, place: { domain?: string; pending: string }): Promise<Applied | null> {
  if (o.dryRun) return { applied: false, key: o.given };
  if (!(await confirmInit(io, o, plan))) return null;
  const account = o.email ? await createAccount(args, io, { email: o.email, domain: place.domain, name: str(args.flags.name) }) : undefined;
  const key = account ? publicKeyOf(account, o.env) : o.given;
  writeChanges(o.cwd, plan, account && key ? { pending: place.pending, key } : null);
  return { applied: plan.changes.length > 0, account, key };
}

interface InitReport {
  ctx: InitContext;
  applied: boolean;
  dryRun: boolean;
  integrations: ReturnType<typeof detectIntegrations>;
  diffs: string[];
  warnings: string[];
  steps: string[];
}

function printInitJson(io: Io, r: InitReport): void {
  const { ctx } = r;
  const { plan } = ctx;
  io.out(JSON.stringify({
    stack: ctx.stack.id, stack_label: ctx.stack.label, platform: ctx.stack.platform ?? null, status: plan.status, dry_run: r.dryRun,
    keyless: ctx.keyless, key: ctx.key ?? null, domain: ctx.domain ?? null, claim_url: ctx.keyless ? ctx.claimUrl : null,
    files_changed: r.applied ? plan.changes.map((c) => c.path) : [],
    planned_changes: plan.changes.map((c) => ({ path: c.path, created: c.before === null })),
    account: ctx.account ? { ...ctx.account, warning: 'keys.sk_test is shown once: store it server-side, never in client code' } : null,
    integrations: r.integrations.map((i) => i.name), warnings: r.warnings, notes: plan.notes, next_steps: r.steps, diff: r.diffs.join('\n'),
  }, null, 2));
}

function printInitSummary(io: Io, r: InitReport): void {
  const { plan, account } = r.ctx;
  if (r.applied) io.out(`\nWrote ${plan.changes.map((c) => c.path).join(', ')}.`);
  else if (r.dryRun && plan.changes.length) io.out('\nDry run: nothing written.');
  if (account) {
    io.out(`\nCreated account ${account.account_id} with site ${account.site_id}; installed ${r.ctx.key}.`);
    if (account.keys?.sk_test) io.out(`Test secret key (shown once, server-side only, never in client code):\n  ${account.keys.sk_test}`);
  }
  io.out(`\nNext steps:\n${r.steps.map((s) => (s.startsWith('  ') ? s : `  - ${s}`)).join('\n')}`);
}

const claimUrlOf = (args: Args, io: Io, domain: string | undefined): string =>
  `${portalBase(args, io)}/claim${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`;

async function init(args: Args, io: Io): Promise<number> {
  const o = initOptions(args, io);
  const project = openProject(o.cwd);
  const stack = detectStack(project);
  const domain = str(args.flags.domain)?.toLowerCase() ?? guessDomain(project);
  // With --email the key only exists once the account is created: plan with a marker, fill it in on apply.
  const pending = `pk_${o.env}_PENDING`;
  const plan = planInstall(project, stack, { key: o.email ? pending : o.given, profile: o.profile });
  const integrations = detectIntegrations(project);
  const warnings = o.email && o.dryRun ? ['dry run: no account is created; the diff shows a placeholder key'] : [];
  const diffs = plan.changes.map((c) => unifiedDiff(c.path, c.before, c.after));
  if (!o.asJson) printHuman(io, stack, plan, integrations, diffs, warnings);

  const done = await applyInit(args, io, o, plan, { domain, pending });
  if (!done) { io.out('Aborted, nothing written.'); return 1; }
  const ctx: InitContext = {
    stack, plan, profile: o.profile, key: done.key, keyless: !o.email && !o.given, domain, claimUrl: claimUrlOf(args, io, domain), account: done.account, email: o.email,
  };
  const report: InitReport = { ctx, applied: done.applied, dryRun: o.dryRun, integrations, diffs, warnings, steps: nextSteps(ctx) };
  if (o.asJson) printInitJson(io, report);
  else printInitSummary(io, report);
  return plan.status === 'unsupported' ? 2 : 0;
}

function printHuman(io: Io, stack: Stack, plan: Plan, integrations: ReturnType<typeof detectIntegrations>, diffs: string[], warnings: string[]): void {
  io.out(`Stack: ${stack.label}${stack.platform ? ` (${stack.platform})` : ''}`);
  io.out(integrations.length
    ? `Integrations that will auto-activate: ${integrations.map((i) => `${i.name} (${i.evidence})`).join(', ')}`
    : 'Integrations that will auto-activate: none detected');
  for (const w of warnings) io.err(`warning: ${w}`);
  for (const n of plan.notes) io.out(`note: ${n}`);
  if (plan.status === 'installed') io.out('Already installed: nothing to do.');
  if (plan.status === 'unsupported') io.out('Could not detect a supported stack.');
  if (diffs.length) io.out(`\n${diffs.join('\n')}`);
}

// ---- verify -----------------------------------------------------------------------------------

async function verifyCmd(args: Args, io: Io): Promise<number> {
  const url = args.pos[0];
  if (!url || !/^https?:\/\//.test(url)) throw new InstallError('verify needs an http(s) URL, e.g. npx @doubleagent-so/cli verify https://example.com');
  const r = await verify(url, { api: str(args.flags.api), fetch: io.fetch });
  if (args.flags.json) { io.out(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  const mark = (b: boolean) => (b ? 'ok  ' : 'FAIL');
  io.out(`${mark(r.script)} script tag (cdn.doubleagent.so/v1/doubleagent.js)`);
  io.out(`${mark(r.stub)} queue stub`);
  io.out(r.keyless && r.script ? 'ok   keyless install (claim the domain to see its data)' : `${mark(r.keyValid)} key ${r.key ?? '(none)'}`);
  if (r.integrations.length) io.out(`     integrations on page: ${r.integrations.join(', ')}`);
  printInstallCheckResult(io, r.installCheck);
  for (const p of r.problems) io.err(`problem: ${p}`);
  io.out(r.ok ? '\nInstalled correctly.' : '\nNot installed correctly.');
  return r.ok ? 0 : 1;
}

/** The API's install check: its findings, or why there are none. */
function printInstallCheckResult(io: Io, ic: Awaited<ReturnType<typeof verify>>['installCheck']): void {
  if (!ic.reachable) io.out(`     install check: API unreachable (${ic.error})`);
  else if (ic.status === 404) io.out('     install check: not available on this API yet');
  else if (ic.check) printInstallCheck(io, ic.check);
  else io.out(`     install check (${ic.status}): ${typeof ic.body === 'string' ? ic.body : JSON.stringify(ic.body)}`);
}

function verdictText(ok: boolean | undefined): string {
  if (ok === undefined) return 'no verdict';
  return ok ? 'ok' : 'NOT ok';
}

const yn = (b?: boolean) => {
  if (b === undefined) return '?';
  return b ? 'yes' : 'no';
};

/** The key line: keyless (with where to claim it) or the key and whether it is valid. */
function keyLine(c: InstallCheck): string | undefined {
  if (c.keyless) return `       keyless: yes${c.claim_url ? ` (claim at ${c.claim_url})` : ''}`;
  if (c.key !== undefined || c.key_valid !== undefined) return `       key: ${c.key ?? '?'} (valid: ${yn(c.key_valid)})`;
  return undefined;
}

/** One line per fact the install check reported; facts it left out print nothing. */
function installFacts(c: InstallCheck): (string | undefined)[] {
  return [
    c.script_found === undefined ? undefined : `       script found: ${yn(c.script_found)}${c.script_src ? ` (${c.script_src})` : ''}`,
    keyLine(c),
    c.profile_attr === undefined ? undefined : `       data-profile: ${c.profile_attr}`,
    c.stub_before_script === undefined ? undefined : `       stub before script: ${yn(c.stub_before_script)}`,
    c.integrations_detected?.length ? `       integrations: ${c.integrations_detected.join(', ')}` : undefined,
    c.last_beacon_at === undefined ? undefined : `       last beacon: ${c.last_beacon_at ?? 'never'}`,
  ];
}

function printInstallCheck(io: Io, c: InstallCheck): void {
  io.out(`     install check: ${verdictText(c.ok)}`);
  for (const line of installFacts(c)) if (line) io.out(line);
  for (const p of c.problems ?? []) {
    io.out(`       problem: ${p.message ?? p.code ?? 'unknown'}${p.code && p.message ? ` [${p.code}]` : ''}`);
    if (p.fix) io.out(`         fix: ${p.fix}`);
  }
}

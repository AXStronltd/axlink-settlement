#!/usr/bin/env node
/**
 * npm run simulate
 *
 * Drives the settlement engine through every scenario and prints what held and
 * what did not. Exits non-zero on any failure so CI can gate on it.
 *
 *   npm run simulate                          all scenarios
 *   npm run simulate -- --only rpc-unreachable
 *   npm run simulate -- --verbose             show journal postings
 *   npm run simulate -- --keep                leave the data for inspection
 *   npm run simulate -- --cleanup             remove data from an interrupted run
 *   npm run simulate -- --list                list scenarios and exit
 */

import dotenv from 'dotenv';
dotenv.config();

import { run, cleanupOrphans, SCENARIOS, SimulatorRefused } from './runner';
import type { RunReport, ScenarioResult } from './runner';

// Minimal ANSI. Disabled when not a TTY, so CI logs stay readable.
const tty = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  amber: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
};

const PASS = () => c.green('  ok  ');
const FAIL = () => c.red(' FAIL ');

function parseArgs(argv: string[]) {
  const only: string[] = [];
  let verbose = false, keep = false, cleanup = false, list = false, json = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') only.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--keep') keep = true;
    else if (a === '--cleanup') cleanup = true;
    else if (a === '--list') list = true;
    else if (a === '--json') json = true;
  }
  return { only, verbose, keep, cleanup, list, json };
}

function printScenario(r: ScenarioResult, verbose: boolean): void {
  const mark = r.passed ? c.green('●') : c.red('●');
  console.log(`\n${mark} ${c.bold(r.title)}  ${c.dim(`[${r.id}] ${r.durationMs}ms`)}`);
  console.log(`  ${c.dim(r.proves)}`);

  for (const note of r.notes) console.log(`    ${c.cyan('·')} ${c.dim(note)}`);

  for (const a of r.assertions) {
    console.log(`  ${a.passed ? PASS() : FAIL()} ${a.claim}${a.detail ? c.dim(`  — ${a.detail}`) : ''}`);
  }

  // Invariants print only when they fail, or in verbose mode: eight passing
  // lines per scenario is noise that hides the one that matters.
  const brokenInvariants = r.invariants.filter(i => !i.passed);
  if (brokenInvariants.length) {
    console.log(`  ${c.red('invariants broken:')}`);
    for (const i of brokenInvariants) {
      console.log(`  ${FAIL()} ${c.bold(i.id)} ${i.name}${i.detail ? c.dim(`  — ${i.detail}`) : ''}`);
    }
  } else if (verbose) {
    for (const i of r.invariants) {
      console.log(`  ${PASS()} ${c.dim(`${i.id} ${i.name}`)}${i.detail ? c.dim(`  — ${i.detail}`) : ''}`);
    }
  } else {
    console.log(`  ${PASS()} ${c.dim(`${r.invariants.length} invariants hold`)}`);
  }

  if (verbose && r.postings?.length) {
    console.log(`  ${c.dim('journal:')}`);
    for (const p of r.postings) {
      console.log(`    ${c.cyan(p.postingKey)}`);
      for (const l of p.lines) {
        const amount = l.amount.padStart(16);
        console.log(`      ${l.account.padEnd(34)} ${amount} ${l.currency}`);
      }
    }
  }

  if (r.error) console.log(`  ${c.red('error:')} ${r.error}`);
}

function printSummary(report: RunReport): void {
  const line = '─'.repeat(64);
  console.log(`\n${c.dim(line)}`);

  if (report.passed) {
    console.log(
      `${c.green(c.bold('All scenarios passed'))} ` +
      `${c.dim(`— ${report.total} scenarios in ${report.durationMs}ms`)}`,
    );
    console.log(
      c.dim('The engine that ran is the engine that runs in production; only the\n' +
             'converter, custodian and RPC node were stubbed.'),
    );
  } else {
    console.log(`${c.red(c.bold(`${report.failed} of ${report.total} scenarios failed`))}`);
    for (const r of report.results.filter(x => !x.passed)) {
      const why = [
        ...r.assertions.filter(a => !a.passed).map(a => a.claim),
        ...r.invariants.filter(i => !i.passed).map(i => `${i.id} ${i.name}`),
      ];
      console.log(`  ${c.red('●')} ${r.id}: ${why.join('; ') || r.error}`);
    }
  }
  console.log(c.dim(line));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    console.log(c.bold('\nScenarios\n'));
    for (const s of SCENARIOS) {
      console.log(`  ${c.cyan(s.id.padEnd(24))} ${s.title}`);
      console.log(`  ${' '.repeat(24)} ${c.dim(s.proves)}\n`);
    }
    return;
  }

  if (args.cleanup) {
    const removed = await cleanupOrphans();
    console.log(
      `Removed ${removed.users} simulated user(s), ${removed.deposits} deposit(s), ${removed.withdrawals} withdrawal(s).`,
    );
    return;
  }

  console.log(c.bold('\nAxLink settlement harness'));
  console.log(
    c.dim(`database: ${maskUrl(process.env.DATABASE_URL)}  ·  ports: stubbed converter, custody, chain`),
  );

  const report = await run({ only: args.only, keepData: args.keep });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report.results) printScenario(r, args.verbose);
    printSummary(report);
    if (args.keep) console.log(c.amber('\n--keep: simulated data left in place. Remove it with --cleanup.'));
  }

  process.exitCode = report.passed ? 0 : 1;
}

/** Never print credentials, even from a local run — logs get pasted into tickets. */
function maskUrl(url?: string): string {
  if (!url) return '(DATABASE_URL unset)';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

main()
  .catch(err => {
    if (err instanceof SimulatorRefused) {
      // A guard tripping is not a crash — say what to change, without a stack.
      console.error(`\n${c.red('Refused:')} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The Prisma client holds the process open otherwise.
    void import('../core/ledger.service').then(m => (m.prisma as { $disconnect?: () => Promise<void> }).$disconnect?.());
  });

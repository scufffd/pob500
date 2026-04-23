#!/usr/bin/env node
'use strict';

/**
 * Basket CLI — manual ops against the airdrop basket.
 *
 *   npm run basket:show           # pretty-print current basket
 *   npm run basket:refresh        # force refresh + register new mints
 *   npm run basket:refresh -- --dry-run  # compute next basket, don't write / no on-chain calls
 *   npm run basket:spend          # one-shot spend cycle
 *   npm run basket:spend -- --dry-run    # preview allocations without swapping
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const {
  loadCurrentBasket,
  refreshBasket,
  minutesUntilRefresh,
  basketRefreshIntervalMin,
} = require('../src/basket');
const { runSpendCycle } = require('../src/spend-cycle');

function fmtPct(n) { return `${(n * 100).toFixed(2)}%`; }

function showBasket() {
  const b = loadCurrentBasket();
  if (!b) {
    console.log('(no basket yet — run `npm run basket:refresh`)');
    return;
  }
  console.log(`Basket v${b.version}  ·  created ${b.createdAt}`);
  console.log(`Refresh interval     : ${b.refreshIntervalMin}m  (next in ~${minutesUntilRefresh(b)}m)`);
  console.log(`Size                 : ${b.entries.length}`);
  if ((b.pinned || []).length) console.log(`Pinned               : ${b.pinned.join(', ')}`);
  if ((b.newcomers || []).length) console.log(`Newcomers this ver   : ${b.newcomers.join(', ')}`);
  if ((b.dropped || []).length) console.log(`Dropped this ver     : ${b.dropped.join(', ')}`);
  console.log('');
  console.log('Entries:');
  console.log('  rank | pobScore | weight  | reg | tokenProgram  | mint                                        | symbol');
  console.log('  -----+----------+---------+-----+---------------+---------------------------------------------+-------');
  b.entries.forEach((e, i) => {
    const reg = e.registered ? 'yes' : 'no ';
    const prog = (e.tokenProgram || '?').padEnd(13);
    console.log(
      `   ${String(i + 1).padStart(2)}  | ${String(e.pobScore).padStart(7)}  | ${fmtPct(e.weight).padStart(6)}  | ${reg} | ${prog} | ${e.mint.padEnd(44)} | ${e.symbol || ''}`
    );
  });
}

async function doRefresh(argv) {
  const dryRun = argv.includes('--dry-run');
  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const admin = process.env.ADMIN_PRIVATE_KEY
    ? config.parsePrivateKey(process.env.ADMIN_PRIVATE_KEY)
    : treasury;
  const b = await refreshBasket({ adminKeypair: admin, dryRun });
  console.log(JSON.stringify({
    version: b.version,
    createdAt: b.createdAt,
    entries: b.entries,
    newcomers: b.newcomers,
    dropped: b.dropped,
    registrationResults: b.registrationResults,
    dryRun: b.dryRun,
  }, null, 2));
}

async function doSpend(argv) {
  const dryRun = argv.includes('--dry-run');
  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const r = await runSpendCycle({ treasury, dryRun });
  // BigInt-safe JSON print
  const clean = JSON.parse(JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  console.log(JSON.stringify(clean, null, 2));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === 'show' || !cmd) showBasket();
    else if (cmd === 'refresh') await doRefresh(rest);
    else if (cmd === 'spend') await doSpend(rest);
    else {
      console.error('Usage: basket {show|refresh [--dry-run]|spend [--dry-run]}');
      process.exit(2);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();

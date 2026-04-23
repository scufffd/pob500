#!/usr/bin/env node
'use strict';

/**
 * Unit tests for basket allocation math — runs offline, no RPC calls.
 *   node scripts/test-basket-math.js
 */

const { allocateBudgets, MIN_SPEND_LAMPORTS } = require('../src/spend-cycle');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function sum(arr, k) { return arr.reduce((s, x) => s + x[k], 0); }
const SOL = 1e9;

function group(label, fn) {
  console.log(`\n${label}`);
  fn();
}

group('1) Happy path — 5 equal-weight entries, 1 SOL budget', () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map((m) => ({
    mint: m, symbol: m.toUpperCase(), weight: 0.2,
  }));
  const out = allocateBudgets(entries, 1 * SOL);
  assert(out.length === 5, 'all 5 survive');
  assert(sum(out, 'lamports') === 1 * SOL, 'total equals budget exactly (no dust lost)');
  assert(out.every((b) => b.lamports >= MIN_SPEND_LAMPORTS), 'every budget ≥ min');
});

group('2) Tiny budget — drops all entries', () => {
  const entries = [{ mint: 'a', symbol: 'A', weight: 0.5 }, { mint: 'b', symbol: 'B', weight: 0.5 }];
  const out = allocateBudgets(entries, MIN_SPEND_LAMPORTS / 2);
  assert(out.length === 0, 'returns [] when below global floor');
});

group('3) Skewed weights — low-weight entry dropped, budget redistributed', () => {
  const entries = [
    { mint: 'a', symbol: 'A', weight: 0.90 },
    { mint: 'b', symbol: 'B', weight: 0.08 },
    { mint: 'c', symbol: 'C', weight: 0.02 },
  ];
  // Budget small enough that B + C fall below MIN
  const budget = 0.05 * SOL;
  const out = allocateBudgets(entries, budget);
  assert(sum(out, 'lamports') === budget, 'still sums to budget');
  assert(out.every((b) => b.lamports >= MIN_SPEND_LAMPORTS), 'survivors all ≥ min');
  assert(!out.find((b) => b.mint === 'c'), 'dust entry C was dropped');
});

group('4) Exact boundary — entry right at MIN survives', () => {
  const entries = [
    { mint: 'a', symbol: 'A', weight: 0.5 },
    { mint: 'b', symbol: 'B', weight: 0.5 },
  ];
  const out = allocateBudgets(entries, MIN_SPEND_LAMPORTS * 2);
  assert(out.length === 2, 'both survive at min*2 with equal weights');
  assert(out.every((b) => b.lamports >= MIN_SPEND_LAMPORTS), 'min floor respected');
});

group('5) Single entry, full budget', () => {
  const entries = [{ mint: 'a', symbol: 'A', weight: 1.0 }];
  const out = allocateBudgets(entries, 5 * SOL);
  assert(out.length === 1 && out[0].lamports === 5 * SOL, 'single entry takes entire budget');
});

group('6) Weights ignore pinned flag (pinned weight still honored)', () => {
  // The allocator doesn't check pinned; it just uses weights. That's correct
  // because pinning is a selection concern, not a weighting one.
  const entries = [
    { mint: 'a', symbol: 'A', weight: 0.10, pinned: true },
    { mint: 'b', symbol: 'B', weight: 0.90, pinned: false },
  ];
  const out = allocateBudgets(entries, 1 * SOL);
  const byMint = Object.fromEntries(out.map((b) => [b.mint, b.lamports]));
  assert(byMint.b > byMint.a, 'higher weight gets bigger share regardless of pin');
});

console.log('');
if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('All allocation tests passed.');

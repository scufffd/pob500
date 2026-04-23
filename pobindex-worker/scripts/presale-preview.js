#!/usr/bin/env node
'use strict';

/**
 * Dry-run: given the current `contributions.json` + presale env config,
 * compute the pro-rata POB500 allocation per contributor and print a report.
 *
 * Also prints an estimated SOL cost to distribute (position rent + prime
 * checkpoint rent + priority fees).
 *
 * Usage:
 *   node scripts/presale-preview.js
 *   node scripts/presale-preview.js --top 50
 *   node scripts/presale-preview.js --csv > presale-preview.csv
 */

const path = require('path');
const fs = require('fs');
const { PublicKey, Connection } = require('@solana/web3.js');
const config = require('../src/config');
const {
  resolvePresaleConfig,
  getPresaleStateDir,
  loadContributions,
  loadDistributed,
  allocateAllocations,
  formatSol,
  formatTokens,
} = require('../src/presale');

const POSITION_RENT_LAMPORTS = 2_040_000;   // rough — Anchor fills actual rent at tx time
const CHECKPOINT_RENT_LAMPORTS = 1_670_000;
const TX_FEE_LAMPORTS = 5_000;

function parseArgs(argv) {
  const args = { top: 25, csv: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') args.top = parseInt(argv[++i], 10);
    else if (a === '--csv') args.csv = true;
  }
  return args;
}

async function fetchMintDecimals(connection, mint) {
  const info = await connection.getParsedAccountInfo(mint);
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (typeof d !== 'number') throw new Error(`Could not read decimals for mint ${mint.toBase58()}`);
  return d;
}

async function fetchRewardMintCount(programId, stakeMint) {
  try {
    const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
    const anchor = require('@coral-xyz/anchor');
    const provider = new anchor.AnchorProvider(
      config.stakeConnection,
      { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t },
      { commitment: 'confirmed' },
    );
    const program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);
    const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), stakeMint.toBuffer()], programId);
    const all = await program.account.rewardMint.all([
      { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
    ]);
    return all.length;
  } catch (e) {
    return 0;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = resolvePresaleConfig();
  console.log('Presale state dir:', getPresaleStateDir());
  const data = loadContributions();
  if (!data) {
    console.error('No contributions file found. Run `npm run presale:scan` first.');
    process.exit(1);
  }

  const programIdStr = process.env.POB_STAKE_PROGRAM_ID;
  const stakeMintStr = process.env.POB_STAKE_MINT;

  // Decimals: prefer on-chain; fall back to POBINDEX_PRESALE_DECIMALS.
  let decimals = parseInt(process.env.POBINDEX_PRESALE_DECIMALS || '', 10);
  if (!decimals && stakeMintStr) {
    try {
      decimals = await fetchMintDecimals(config.stakeConnection, new PublicKey(stakeMintStr));
    } catch (e) {
      console.warn('Could not fetch stake mint decimals:', e.message);
    }
  }
  if (!decimals) {
    console.warn('No decimals resolved. Showing raw token units.');
    decimals = 0;
  }

  const rewardMintCount = programIdStr && stakeMintStr
    ? await fetchRewardMintCount(new PublicKey(programIdStr), new PublicKey(stakeMintStr))
    : 0;

  const allocations = allocateAllocations(data.contributors, cfg.tokenTotal);
  const distState = loadDistributed();
  const alreadyDistributed = new Set(Object.keys(distState.entries || {}));

  const remaining = allocations.filter((a) => !alreadyDistributed.has(a.wallet));

  const rentPerContributor =
    POSITION_RENT_LAMPORTS + rewardMintCount * CHECKPOINT_RENT_LAMPORTS;
  const feePerContributor = TX_FEE_LAMPORTS * (1 + Math.ceil(rewardMintCount / 8));
  const estimatedDistributeLamports =
    BigInt(remaining.length) * BigInt(rentPerContributor + feePerContributor);

  if (args.csv) {
    console.log('wallet,lamports,sol,share_bps,tokens_raw,tokens_display,already_distributed');
    for (const a of allocations) {
      const tokensDisplay = formatTokens(a.tokens, decimals);
      console.log([
        a.wallet,
        a.lamports.toString(),
        formatSol(a.lamports.toString()),
        a.shareBps,
        a.tokens.toString(),
        tokensDisplay,
        alreadyDistributed.has(a.wallet) ? '1' : '0',
      ].join(','));
    }
    return;
  }

  console.log('Presale preview');
  console.log('─────────────────────────────────────────────');
  console.log('  contributions file :', data.updatedAt, `(${data.contributorCount} wallets, ${data.totalSol} SOL)`);
  console.log('  token pool         :', formatTokens(cfg.tokenTotal, decimals), 'POB500');
  console.log('  lock tier          :', cfg.lockDays, 'day(s)');
  console.log('  reward mint count  :', rewardMintCount);
  console.log('  already distributed:', alreadyDistributed.size);
  console.log('  remaining          :', remaining.length);
  console.log('  est. rent + fees   :', formatSol(estimatedDistributeLamports.toString()), 'SOL');
  console.log('');

  const showRows = allocations.slice(0, args.top);
  console.log(`Top ${showRows.length} allocations:`);
  console.log(
    '  '
    + 'WALLET'.padEnd(46)
    + 'SOL'.padStart(12)
    + 'SHARE%'.padStart(10)
    + 'POB500'.padStart(18)
    + '  STATUS',
  );
  for (const a of showRows) {
    const tokensDisplay = formatTokens(a.tokens, decimals);
    const status = alreadyDistributed.has(a.wallet) ? '✔ sent' : '· pending';
    console.log(
      '  '
      + a.wallet.padEnd(46)
      + formatSol(a.lamports.toString()).padStart(12)
      + (a.shareBps / 100).toFixed(2).padStart(10)
      + tokensDisplay.padStart(18)
      + `  ${status}`,
    );
  }
  if (allocations.length > showRows.length) {
    console.log(`  … and ${allocations.length - showRows.length} more. Use --top to see more, or --csv to export.`);
  }

  console.log('');
  console.log('Next step: `npm run presale:distribute -- --dry-run` to simulate, then drop --dry-run to ship.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

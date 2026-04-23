#!/usr/bin/env node
'use strict';

/**
 * Compute the pro-rata presale plan for the "dev buy + airdrop" distribution
 * model (as opposed to the `stake_for` model in presale-preview/distribute).
 *
 * Inputs:
 *   - `data/presale/contributions.json` from `npm run presale:scan`
 *   - env: POBINDEX_DEVBUY_RESERVE_SOL, POBINDEX_DEVBUY_DEV_EXTRA_SOL
 *   - flag:  --tokens <raw-units>  (required to write the plan file; optional
 *            for preview mode, which just shows percentages)
 *   - flag:  --decimals <n>        (overrides env / on-chain decimals)
 *   - flag:  --mint <MINT>         (only needed to auto-fetch decimals)
 *
 * Outputs:
 *   - pretty table on stdout
 *   - `--csv` for machine-readable export
 *   - `data/presale/devbuy-plan.json` when --tokens is supplied
 *
 * Examples:
 *   # preview only — no --tokens, no plan file written
 *   npm run presale:devbuy-plan
 *
 *   # plan after dev-buy: 500,000,000,000 raw units, 6 decimals → 500k tokens
 *   npm run presale:devbuy-plan -- --tokens 500000000000 --decimals 6
 *
 *   # csv export
 *   npm run presale:devbuy-plan -- --tokens 500000000000 --decimals 6 --csv
 */

const path = require('path');
const fs = require('fs');
const { PublicKey } = require('@solana/web3.js');

const config = require('../src/config');
const {
  getPresaleStateDir,
  loadContributions,
  computeDevBuyAllocations,
  formatSol,
  formatTokens,
} = require('../src/presale');

const DEFAULT_RESERVE_SOL = 2;
const DEFAULT_DEV_EXTRA_SOL = 1;

function parseArgs(argv) {
  const args = {
    tokens: null,
    decimals: null,
    mint: null,
    csv: false,
    top: 50,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tokens') args.tokens = argv[++i];
    else if (a === '--decimals') args.decimals = parseInt(argv[++i], 10);
    else if (a === '--mint') args.mint = argv[++i];
    else if (a === '--csv') args.csv = true;
    else if (a === '--top') args.top = parseInt(argv[++i], 10);
  }
  return args;
}

function solToLamports(n) {
  return BigInt(Math.round(parseFloat(n) * 1e9));
}

async function fetchMintDecimals(connection, mintStr) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mintStr));
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (typeof d !== 'number') throw new Error(`Could not read decimals for mint ${mintStr}`);
  return d;
}

async function main() {
  const args = parseArgs(process.argv);

  const reserveSol = parseFloat(
    process.env.POBINDEX_DEVBUY_RESERVE_SOL || DEFAULT_RESERVE_SOL,
  );
  const devExtraSol = parseFloat(
    process.env.POBINDEX_DEVBUY_DEV_EXTRA_SOL || DEFAULT_DEV_EXTRA_SOL,
  );
  const reserveLamports = solToLamports(reserveSol);
  const devExtraLamports = solToLamports(devExtraSol);

  const data = loadContributions();
  if (!data) {
    console.error('No contributions file found. Run `npm run presale:scan` first.');
    process.exit(1);
  }

  const totalLamports = BigInt(data.totalLamports);
  if (totalLamports === 0n) {
    console.error('Contributions file has totalLamports == 0. Nothing to plan.');
    process.exit(1);
  }
  if (reserveLamports > totalLamports) {
    console.error(
      `Reserve (${formatSol(reserveLamports)} SOL) > total contributed (${formatSol(totalLamports)} SOL). Aborting.`,
    );
    process.exit(2);
  }

  // Decimals — only needed when --tokens is supplied so we can pretty-print.
  let decimals = args.decimals;
  if (decimals == null && args.mint) {
    try {
      decimals = await fetchMintDecimals(config.connection, args.mint);
    } catch (e) {
      console.warn('Could not fetch mint decimals:', e.message);
    }
  }
  if (decimals == null) decimals = 0;

  const devBuyTokensRaw = args.tokens ? BigInt(String(args.tokens).replace(/_/g, '')) : 0n;

  const plan = computeDevBuyAllocations({
    contributors: data.contributors,
    totalContributedLamports: totalLamports,
    devBuyTokensRaw,
    reserveLamports,
    devExtraLamports,
  });

  if (args.csv) {
    console.log('wallet,lamports,sol,contrib_pct,pool_pct,tokens_raw,tokens_display');
    for (const a of plan.allocations) {
      const contribPct = (a.shareBps / 100).toFixed(2);
      const poolPct = ((a.shareBps * plan.presalePoolShareBps) / (10_000 * 100)).toFixed(2);
      console.log([
        a.wallet,
        a.lamports,
        formatSol(a.lamports),
        contribPct,
        poolPct,
        a.tokens,
        devBuyTokensRaw > 0n ? formatTokens(BigInt(a.tokens), decimals) : '—',
      ].join(','));
    }
    return;
  }

  console.log('Presale dev-buy plan');
  console.log('─────────────────────────────────────────────');
  console.log('  contributions file :', data.updatedAt, `(${data.contributorCount} wallets)`);
  console.log('  total contributed  :', formatSol(plan.totalContributedLamports), 'SOL');
  console.log('  reserve (held back):', formatSol(plan.reserveLamports), 'SOL');
  console.log('  → sent to dev wallet:', formatSol(plan.fromPresaleLamports), 'SOL');
  console.log('  + dev tops up with :', formatSol(plan.devExtraLamports), 'SOL');
  console.log('  = dev-buy size     :', formatSol(plan.devBuySolLamports), 'SOL');
  console.log('  presale pool share :', (plan.presalePoolShareBps / 100).toFixed(2) + '%');
  console.log('  dev retained share :', (plan.devRetainedShareBps / 100).toFixed(2) + '%');
  if (devBuyTokensRaw > 0n) {
    console.log('  dev-buy tokens (T) :', formatTokens(devBuyTokensRaw, decimals));
    console.log('  → presale pool     :', formatTokens(BigInt(plan.presalePoolTokens), decimals));
    console.log('  → dev retained     :', formatTokens(BigInt(plan.devRetainedTokens), decimals));
  } else {
    console.log('  dev-buy tokens     : (pass --tokens <raw-units> to materialise plan)');
  }
  console.log('');

  const rows = plan.allocations.slice(0, args.top);
  console.log(`Top ${rows.length} of ${plan.allocations.length} allocations:`);
  console.log(
    '  '
    + 'WALLET'.padEnd(46)
    + 'SOL'.padStart(10)
    + 'CONTRIB%'.padStart(10)
    + 'POOL%'.padStart(8)
    + 'TOKENS'.padStart(22),
  );
  for (const a of rows) {
    const contribPct = (a.shareBps / 100).toFixed(2);
    const poolPct = ((a.shareBps * plan.presalePoolShareBps) / (10_000 * 100)).toFixed(2);
    const tokensDisplay = devBuyTokensRaw > 0n
      ? formatTokens(BigInt(a.tokens), decimals)
      : '—';
    console.log(
      '  '
      + a.wallet.padEnd(46)
      + formatSol(a.lamports).padStart(10)
      + contribPct.padStart(10)
      + poolPct.padStart(8)
      + tokensDisplay.padStart(22),
    );
  }
  if (plan.allocations.length > rows.length) {
    console.log(`  … and ${plan.allocations.length - rows.length} more. Use --csv to export all.`);
  }

  if (devBuyTokensRaw > 0n) {
    const planPath = path.join(getPresaleStateDir(), 'devbuy-plan.json');
    fs.mkdirSync(getPresaleStateDir(), { recursive: true });
    const tmp = `${planPath}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          contributionsUpdatedAt: data.updatedAt,
          source: data.wallet,
          mint: args.mint || null,
          decimals,
          ...plan,
        },
        null,
        2,
      ),
      'utf8',
    );
    fs.renameSync(tmp, planPath);
    console.log('');
    console.log('Wrote plan →', planPath);
    console.log('Next step: `npm run presale:devbuy-send -- --dry-run` to simulate airdrop.');
  } else {
    console.log('');
    console.log('Preview only. Re-run with `--tokens <raw-units>` after the dev buy to write the plan file.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

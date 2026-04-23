#!/usr/bin/env node
'use strict';

/**
 * Scan all inbound SOL transfers to the presale wallet and write an aggregated
 * contributors file to `data/presale/contributions.json`.
 *
 * Usage:
 *   node scripts/presale-scan.js                   # scan (incremental)
 *   node scripts/presale-scan.js --full            # rescan full history
 *   node scripts/presale-scan.js --limit 500       # page size
 *   node scripts/presale-scan.js --end-ts 1735000  # stop scan at timestamp
 *   node scripts/presale-scan.js --sequential-parsed  # one tx/RPC call (devnet public RPC)
 *
 * The script is safe to re-run: it picks up from the last scanned signature
 * stored in the contributions file so subsequent runs only fetch new txs.
 */

const config = require('../src/config');
const {
  resolvePresaleConfig,
  loadContributions,
  saveContributions,
  extractInboundTransfers,
  aggregateContributions,
  formatSol,
} = require('../src/presale');

function parseArgs(argv) {
  const args = {
    full: false,
    limit: 1000,
    endTs: null,
    maxPages: 200,
    rpcDelayMs: 400,
    /** One RPC call per tx — slow but survives public-devnet 429 on batch getParsedTransactions */
    sequentialParsed: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--end-ts') args.endTs = parseInt(argv[++i], 10);
    else if (a === '--max-pages') args.maxPages = parseInt(argv[++i], 10);
    else if (a === '--rpc-delay') args.rpcDelayMs = parseInt(argv[++i], 10);
    else if (a === '--sequential-parsed') args.sequentialParsed = true;
  }
  return args;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  const cfg = resolvePresaleConfig({ requireTokenTotal: false });
  const conn = config.presaleConnection;
  const walletStr = cfg.presaleWallet.toBase58();

  console.log('Presale scan', {
    wallet: walletStr,
    rpc: config.PRESALE_RPC_URL,
    mode: args.full ? 'full' : 'incremental',
    minLamports: cfg.minLamports.toString(),
    exclude: [...cfg.excludeWallets],
  });

  const existing = args.full ? null : loadContributions();
  const seenSigs = new Set();
  let existingRaw = [];
  if (existing && Array.isArray(existing.rawTransfers)) {
    existingRaw = existing.rawTransfers.map((r) => ({
      signature: r.signature,
      source: r.source,
      lamports: BigInt(r.lamports),
      blockTime: r.blockTime,
    }));
    for (const r of existingRaw) seenSigs.add(r.signature);
  }

  // Page signatures newest → oldest until we hit either `before = null`, the
  // previously-scanned head, or `endTs`.
  const untilSig = existing?.headSignature || null;
  const rawTransfers = [...existingRaw];
  let before = undefined;
  let fetchedPages = 0;
  let headSignature = null;
  let earliestBlockTime = null;

  let consecutive429 = 0;
  while (fetchedPages < args.maxPages) {
    const opts = { limit: args.limit };
    if (before) opts.before = before;
    if (untilSig && !args.full) opts.until = untilSig;
    let sigs;
    try {
      sigs = await conn.getSignaturesForAddress(cfg.presaleWallet, opts);
      consecutive429 = 0;
    } catch (e) {
      const is429 = /429|max usage|rate/i.test(e.message || '');
      consecutive429 = is429 ? consecutive429 + 1 : 0;
      console.error(`getSignaturesForAddress failed (${is429 ? '429' : 'err'}):`, e.message);
      if (consecutive429 >= 3) {
        console.error('Hit RPC rate limit 3×. Bailing — either wait and re-run, or set RPC_URL to a wallet-scanning-friendly endpoint and try again.');
        break;
      }
      await sleep(2000 * Math.max(1, consecutive429));
      continue;
    }
    fetchedPages += 1;
    if (sigs.length === 0) break;
    if (!headSignature) headSignature = sigs[0].signature;

    const filtered = sigs.filter((s) => !s.err);
    if (filtered.length === 0) {
      before = sigs[sigs.length - 1].signature;
      if (sigs.length < args.limit) break;
      continue;
    }

    async function fetchOneParsed(sig) {
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          return await conn.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
        } catch (e) {
          const is429 = /429|Too many requests|rate/i.test(e.message || '');
          if (!is429 || attempt === 8) throw e;
          await sleep(600 * attempt);
        }
      }
      return null;
    }

    if (args.sequentialParsed) {
      for (const s of filtered) {
        const sig = s.signature;
        if (seenSigs.has(sig)) continue;
        const tx = await fetchOneParsed(sig);
        const blockTime = s.blockTime || tx?.blockTime || null;
        if (args.endTs && blockTime && blockTime > args.endTs) continue;
        if (cfg.startTs && blockTime && blockTime < cfg.startTs) continue;
        if (cfg.endTs && blockTime && blockTime > cfg.endTs) continue;
        if (!tx) continue;
        const rows = extractInboundTransfers(tx, walletStr);
        for (const row of rows) {
          rawTransfers.push({ ...row, signature: sig, blockTime });
        }
        seenSigs.add(sig);
        if (blockTime && (!earliestBlockTime || blockTime < earliestBlockTime)) {
          earliestBlockTime = blockTime;
        }
        await sleep(250);
      }
    } else {
      // Fetch parsed txs in small batches (premium RPCs); public devnet often 429s batches.
      const CHUNK = 10;
      for (let i = 0; i < filtered.length; i += CHUNK) {
        const chunk = filtered.slice(i, i + CHUNK);
        let parsed;
        for (let attempt = 1; attempt <= 6; attempt++) {
          try {
            parsed = await conn.getParsedTransactions(
              chunk.map((s) => s.signature),
              { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
            );
            break;
          } catch (e) {
            const is429 = /429|Too many requests|rate/i.test(e.message || '');
            if (!is429 || attempt === 6) throw e;
            await sleep(800 * attempt);
          }
        }
        for (let j = 0; j < chunk.length; j++) {
          const sig = chunk[j].signature;
          const blockTime = chunk[j].blockTime || parsed[j]?.blockTime || null;
          if (args.endTs && blockTime && blockTime > args.endTs) continue;
          if (cfg.startTs && blockTime && blockTime < cfg.startTs) continue;
          if (cfg.endTs && blockTime && blockTime > cfg.endTs) continue;
          if (seenSigs.has(sig)) continue;
          const tx = parsed[j];
          if (!tx) continue;
          const rows = extractInboundTransfers(tx, walletStr);
          for (const row of rows) {
            rawTransfers.push({ ...row, signature: sig, blockTime });
          }
          seenSigs.add(sig);
          if (blockTime && (!earliestBlockTime || blockTime < earliestBlockTime)) {
            earliestBlockTime = blockTime;
          }
        }
        await sleep(150);
      }
    }

    before = sigs[sigs.length - 1].signature;
    console.log(`  scanned ${fetchedPages} page(s), ${rawTransfers.length} raw transfer(s) so far…`);
    if (sigs.length < args.limit) break;
    await sleep(args.rpcDelayMs); // gentle rate-limit
  }
  if (fetchedPages >= args.maxPages) {
    console.warn(`  hit --max-pages=${args.maxPages}; re-run to continue past this point`);
  }

  const contributors = aggregateContributions(rawTransfers, {
    excludeWallets: cfg.excludeWallets,
    minLamports: cfg.minLamports,
  });

  const totalLamports = contributors.reduce(
    (acc, c) => acc + BigInt(c.totalLamports),
    0n,
  );

  const out = {
    updatedAt: new Date().toISOString(),
    wallet: walletStr,
    headSignature: headSignature || existing?.headSignature || null,
    earliestBlockTime,
    totalLamports: totalLamports.toString(),
    totalSol: formatSol(totalLamports),
    contributorCount: contributors.length,
    rawTransferCount: rawTransfers.length,
    rawTransfers: rawTransfers.map((r) => ({
      signature: r.signature,
      source: r.source,
      lamports: r.lamports.toString(),
      blockTime: r.blockTime,
    })),
    contributors,
  };
  const out2 = saveContributions(out);

  console.log('');
  console.log('Presale contributions written →', out2);
  console.log('  wallet             :', walletStr);
  console.log('  unique contributors:', contributors.length);
  console.log('  total raw transfers:', rawTransfers.length);
  console.log('  total SOL raised   :', out.totalSol);
  if (contributors.length > 0) {
    console.log('');
    console.log('Top 10 contributors:');
    for (const c of contributors.slice(0, 10)) {
      const sol = formatSol(c.totalLamports);
      console.log(`  ${c.wallet}  ${sol.padStart(12)} SOL   ${c.txCount} tx`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

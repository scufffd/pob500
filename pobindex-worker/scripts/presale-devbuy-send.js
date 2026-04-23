#!/usr/bin/env node
'use strict';

/**
 * Airdrop the dev-buy allocation plan to contributors via plain SPL transfers.
 *
 *   devbuy-plan.json  →  signed SPL transfers from dev wallet  →  devbuy-sent.json
 *
 * Guarantees:
 *   - Defaults to `--dry-run`. Must pass `--live` to actually send txs.
 *   - Idempotent: each success is recorded in `data/presale/devbuy-sent.json`
 *     keyed by wallet; re-runs skip already-sent entries.
 *   - Batches `transfer` ixs into the fewest transactions that fit under 1200
 *     bytes packet budget (≈10–14 transfers per tx with priority-fee ix).
 *   - Ensures recipient ATA exists by attaching `createAssociatedTokenAccountIdempotent`
 *     as the first ix per recipient. Dev wallet pays ATA rent.
 *
 * Env:
 *   POBINDEX_DEVBUY_WALLET_PRIVATE_KEY  JSON array or bs58 string (required for --live)
 *   POBINDEX_DEVBUY_MINT                Mint pubkey (overrides plan file / --mint)
 *
 * Usage:
 *   npm run presale:devbuy-send -- --dry-run
 *   npm run presale:devbuy-send -- --live
 *   npm run presale:devbuy-send -- --live --only <WALLET>
 *   npm run presale:devbuy-send -- --live --limit 10
 */

const path = require('path');
const fs = require('fs');
const {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} = require('@solana/spl-token');

const config = require('../src/config');
const { getPresaleStateDir, formatSol, formatTokens } = require('../src/presale');

const TX_PACKET_BUDGET = 1200;
const DEFAULT_CONFIRM_RETRIES = 3;

function parseArgs(argv) {
  const args = {
    live: false,
    dryRun: true,
    only: null,
    limit: null,
    start: 0,
    iReallyMeanIt: false,
    mint: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') { args.live = true; args.dryRun = false; }
    else if (a === '--dry-run') { args.dryRun = true; args.live = false; }
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--start') args.start = parseInt(argv[++i], 10);
    else if (a === '--i-really-mean-it') args.iReallyMeanIt = true;
    else if (a === '--mint') args.mint = argv[++i];
  }
  return args;
}

function planPath() {
  return path.join(getPresaleStateDir(), 'devbuy-plan.json');
}
function sentPath() {
  return path.join(getPresaleStateDir(), 'devbuy-sent.json');
}

function loadPlan() {
  const p = planPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p}. Run \`npm run presale:devbuy-plan -- --tokens <raw> --mint <MINT>\` first.`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadSent() {
  const p = sentPath();
  if (!fs.existsSync(p)) return { updatedAt: null, entries: {} };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveSent(state) {
  state.updatedAt = new Date().toISOString();
  const p = sentPath();
  fs.mkdirSync(getPresaleStateDir(), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on cluster`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} not owned by a token program (owner=${info.owner.toBase58()})`);
}

/**
 * Pack (ix, ownerWallet) pairs into the fewest txs that each fit under
 * TX_PACKET_BUDGET. Returns `[{ tx, wallets: Set<string> }, ...]` so the
 * caller knows which recipient wallets each tx covers (for idempotency
 * bookkeeping).
 */
function packTransfers(ixPairs, feePayer, recentBlockhash, priorityFeeIx) {
  const out = [];
  const trySerialize = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch (_) {
      return Infinity;
    }
  };

  const fresh = () => {
    const t = new Transaction();
    t.feePayer = feePayer;
    t.recentBlockhash = recentBlockhash;
    if (priorityFeeIx) t.add(priorityFeeIx);
    return { tx: t, wallets: new Set() };
  };

  let current = fresh();
  for (const { ix, wallet } of ixPairs) {
    current.tx.add(ix);
    const size = trySerialize(current.tx);
    if (size > TX_PACKET_BUDGET) {
      current.tx.instructions.pop();
      if (current.tx.instructions.length === (priorityFeeIx ? 1 : 0)) {
        throw new Error(`Instruction too large to fit a single tx (size=${size})`);
      }
      out.push(current);
      current = fresh();
      current.tx.add(ix);
    }
    if (wallet) current.wallets.add(wallet);
  }
  if (current.tx.instructions.length > (priorityFeeIx ? 1 : 0)) out.push(current);
  return out;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  const plan = loadPlan();

  const mintStr = process.env.POBINDEX_DEVBUY_MINT || args.mint || plan.mint;
  if (!mintStr) {
    throw new Error('No mint — set POBINDEX_DEVBUY_MINT or pass --mint <MINT> (or regenerate the plan with --mint).');
  }
  const mint = new PublicKey(mintStr);

  const connection = config.connection; // mainnet / wherever Printr launch lives
  const tokenProgram = await detectTokenProgram(connection, mint);

  let dev = null;
  if (args.live) {
    const rawKey = process.env.POBINDEX_DEVBUY_WALLET_PRIVATE_KEY
      || config.requireEnv('POBINDEX_DEVBUY_WALLET_PRIVATE_KEY');
    dev = config.parsePrivateKey(rawKey);
  }

  const cluster = config.RPC_URL;
  const isDevnet = /devnet|localhost|127\.0\.0\.1/i.test(cluster);

  console.log('— POB500 presale dev-buy airdrop —');
  console.log('  cluster    :', cluster);
  console.log('  mint       :', mint.toBase58());
  console.log('  dev wallet :', dev ? dev.publicKey.toBase58() : '(dry-run, unsigned)');
  console.log('  mode       :', args.live ? 'LIVE' : 'dry-run');
  if (args.live && !isDevnet && !args.iReallyMeanIt) {
    console.log('  (mainnet — priority-fee ix attached, will send real tokens)');
  }
  console.log('  plan file  :', planPath());
  console.log('  presale pool tokens:', plan.presalePoolTokens);
  console.log('  dev retained tokens:', plan.devRetainedTokens);
  console.log('');

  const sentState = loadSent();
  const allAllocs = plan.allocations.filter((a) => BigInt(a.tokens) > 0n);
  const pending = allAllocs.filter((a) => {
    if (sentState.entries[a.wallet]) return false;
    if (args.only && a.wallet !== args.only) return false;
    return true;
  });
  const slice = pending.slice(
    args.start,
    args.limit ? args.start + args.limit : undefined,
  );

  const totalNeeded = slice.reduce((acc, a) => acc + BigInt(a.tokens), 0n);
  console.log(`Pending: ${pending.length}  |  batch: ${slice.length}  |  tokens to send: ${totalNeeded}`);

  if (args.live) {
    const devAta = getAssociatedTokenAddressSync(mint, dev.publicKey, false, tokenProgram);
    const devAcc = await getAccount(connection, devAta, 'confirmed', tokenProgram)
      .catch(() => null);
    if (!devAcc) {
      throw new Error(`Dev wallet ATA ${devAta.toBase58()} does not exist — has the dev buy landed?`);
    }
    const devBal = BigInt(devAcc.amount.toString());
    if (devBal < totalNeeded) {
      throw new Error(`Dev wallet short on tokens: has ${devBal}, needs ${totalNeeded} raw units.`);
    }
    console.log('  dev balance:', devBal.toString(), '(sufficient)');
  }
  console.log('');

  if (slice.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (args.dryRun) {
    for (const a of slice) {
      console.log(
        '  [dry]', a.wallet.padEnd(46),
        formatTokens(BigInt(a.tokens), plan.decimals || 0).padStart(18),
      );
    }
    console.log('');
    console.log('Re-run with `--live` to actually send.');
    return;
  }

  const priorityFeeLamportsPerCu = Math.max(
    1,
    Math.round((config.ONE_TIME_PRIORITY_FEE || 0.000001) * 1e9 * 1000),
  );
  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: priorityFeeLamportsPerCu,
  });

  const devAta = getAssociatedTokenAddressSync(mint, dev.publicKey, false, tokenProgram);

  // Build (ix, wallet) pairs — idempotent ATA create + transfer per recipient.
  const ixPairs = [];
  for (const a of slice) {
    const owner = new PublicKey(a.wallet);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    ixPairs.push({
      ix: createAssociatedTokenAccountIdempotentInstruction(
        dev.publicKey,
        ata,
        owner,
        mint,
        tokenProgram,
      ),
      wallet: a.wallet,
    });
    ixPairs.push({
      ix: createTransferInstruction(
        devAta,
        ata,
        dev.publicKey,
        BigInt(a.tokens),
        [],
        tokenProgram,
      ),
      wallet: a.wallet,
    });
  }

  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const packed = packTransfers(ixPairs, dev.publicKey, blockhash, priorityFeeIx);
  console.log(`Packed ${ixPairs.length} ixs into ${packed.length} tx(s).`);

  const walletToTokens = new Map(slice.map((a) => [a.wallet, a.tokens]));
  for (let i = 0; i < packed.length; i++) {
    const { tx, wallets } = packed[i];
    tx.feePayer = dev.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;

    let sig = null;
    let err = null;
    for (let attempt = 1; attempt <= DEFAULT_CONFIRM_RETRIES; attempt++) {
      try {
        sig = await sendAndConfirmTransaction(connection, tx, [dev], {
          commitment: 'confirmed',
          preflightCommitment: 'confirmed',
          skipPreflight: false,
        });
        break;
      } catch (e) {
        err = e;
        await sleep(1000 * attempt);
        tx.recentBlockhash = (await connection.getLatestBlockhash('finalized')).blockhash;
      }
    }

    if (!sig) {
      console.error(`  tx ${i + 1}/${packed.length} FAILED after retries:`, err?.message || err);
      break;
    }

    for (const w of wallets) {
      if (!walletToTokens.has(w)) continue;
      sentState.entries[w] = {
        signature: sig,
        tokens: walletToTokens.get(w),
        sentAt: new Date().toISOString(),
      };
    }
    saveSent(sentState);
    console.log(`  tx ${i + 1}/${packed.length} ok → ${sig}  (${wallets.size} wallet(s))`);
  }

  const done = Object.keys(sentState.entries).length;
  console.log('');
  console.log(`Done. ${done}/${allAllocs.length} wallets delivered overall.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * End-to-end presale + stake_for rehearsal on Solana devnet.
 *
 * Flow:
 *   1. setup   — generate presale receiver + 3 contributor keypairs (saved locally).
 *   2. fund    — treasury airdrops if needed, funds contributors, each sends tiny SOL → presale (scaled “mainnet” amounts).
 *   3. mint    — create a fresh SPL mint, mint supply to treasury ATA.
 *   4. pool    — initialize stake pool + register stake mint as reward line.
 *   5. print-env — show exports for presale:scan / preview / distribute.
 *   6. all     — runs setup → fund → mint → pool → print-env (idempotent where possible).
 *
 * Requires:
 *   - STAKE_RPC_URL pointing at devnet (Helius devnet URL recommended).
 *   - TREASURY_PRIVATE_KEY (same wallet used for stake:* scripts).
 *   - Deployed pob-index-stake program on devnet that includes `stake_for`.
 *     If `presale:distribute` fails with `InstructionFallbackNotFound` (0x65),
 *     upgrade devnet from `staking-program/` (treasury `AdPq…` is upgrade authority):
 *       anchor upgrade target/deploy/pob_index_stake.so \\
 *         --program-id J1efjPS48ee1xwCAx4aXBoUvp9pwG78M4M2SVqqo44gQ \\
 *         --provider.cluster devnet --provider.wallet <treasury-keypair.json>
 *
 * Usage (from pobindex-worker):
 *   POBINDEX_PRESALE_STATE_DIR=data/presale-devnet \\
 *   POBINDEX_PRESALE_RPC_URL=$STAKE_RPC_URL \\
 *   npm run presale:devnet-drill -- --all
 *
 * Then follow the printed `export …` lines and run:
 *   npm run presale:scan -- --full
 *   npm run presale:preview
 *   npm run presale:distribute -- --live
 */

const fs = require('fs');
const path = require('path');
const {
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
} = require('@solana/web3.js');
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const config = require('../src/config');

const DRILL_DIR = path.join(__dirname, '..', 'data', 'presale-devnet');
const KEYS_PATH = path.join(DRILL_DIR, 'drill-keys.json');
const STATE_PATH = path.join(DRILL_DIR, 'drill-state.json');

const DECIMALS = 6;
// 1_000_000 display tokens minted; 90% earmarked for presale distribution math.
const MINT_RAW_TOTAL = 1_000_000n * 10n ** BigInt(DECIMALS);
const PRESALE_TOKEN_TOTAL_RAW = 900_000n * 10n ** BigInt(DECIMALS);
// Tiny SOL “contributions” (lamports) — same ratios as 10 / 25 / 15 SOL.
const CONTRIBUTOR_LAMPORTS = [1_000_000n, 2_500_000n, 1_500_000n];

function parseArgs(argv) {
  const out = { cmd: 'help' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--setup') out.cmd = 'setup';
    else if (a === '--fund') out.cmd = 'fund';
    else if (a === '--mint') out.cmd = 'mint';
    else if (a === '--pool') out.cmd = 'pool';
    else if (a === '--print-env') out.cmd = 'print-env';
    else if (a === '--all') out.cmd = 'all';
  }
  return out;
}

function assertDevnet() {
  const u = String(config.STAKE_RPC_URL || '');
  if (!/devnet|localhost|127\.0\.0\.1/i.test(u)) {
    throw new Error(
      'Refusing: STAKE_RPC_URL must be devnet (or localhost) for this drill. Current: ' + u,
    );
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function kpFromJson(arr) {
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function loadKeys() {
  if (!fs.existsSync(KEYS_PATH)) return null;
  const j = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
  return {
    presale: kpFromJson(j.presale.secretKey),
    contributors: j.contributors.map((c) => kpFromJson(c.secretKey)),
  };
}

function saveKeys(presale, contributors) {
  ensureDir(DRILL_DIR);
  const payload = {
    network: 'devnet',
    createdAt: new Date().toISOString(),
    presale: {
      publicKey: presale.publicKey.toBase58(),
      secretKey: [...presale.secretKey],
    },
    contributors: contributors.map((k) => ({
      publicKey: k.publicKey.toBase58(),
      secretKey: [...k.secretKey],
    })),
    note: 'Import contributor secretKey arrays into Phantom (Settings → Import private key) to test claim/unstake as each contributor.',
  };
  fs.writeFileSync(KEYS_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log('Wrote', KEYS_PATH);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(obj) {
  ensureDir(DRILL_DIR);
  const merged = { ...loadState(), ...obj, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log('Wrote', STATE_PATH);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function airdropIfLow(connection, pubkey, minSol = 0.5) {
  const bal = await connection.getBalance(pubkey);
  const need = Math.round(minSol * LAMPORTS_PER_SOL);
  if (bal >= need) {
    console.log('Balance OK', pubkey.toBase58(), (bal / LAMPORTS_PER_SOL).toFixed(3), 'SOL');
    return;
  }
  const want = Math.max(need - bal, Math.round(1 * LAMPORTS_PER_SOL));
  console.log('Requesting airdrop', want / LAMPORTS_PER_SOL, 'SOL →', pubkey.toBase58());
  const sig = await connection.requestAirdrop(pubkey, want);
  await connection.confirmTransaction(sig, 'confirmed');
  await sleep(500);
}

async function sendSol(connection, from, to, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Number(lamports) }),
  );
  await sendAndConfirmTransaction(connection, tx, [from], { commitment: 'confirmed' });
}

function loadIdl(programId) {
  const idlPath = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  return { ...idl, address: programId.toBase58() };
}

async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error('Mint owner is not SPL / Token-2022');
}

function buildProvider(connection, signer) {
  const anchor = require('@coral-xyz/anchor');
  const wallet = {
    publicKey: signer.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(signer);
      return tx;
    },
    signAllTransactions: async (txs) => txs.map((tx) => {
      tx.partialSign(signer);
      return tx;
    }),
  };
  return new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
}

async function phaseSetup() {
  assertDevnet();
  ensureDir(DRILL_DIR);
  if (fs.existsSync(KEYS_PATH)) {
    console.log('Keys already exist at', KEYS_PATH, '— delete to regenerate.');
    return;
  }
  const presale = Keypair.generate();
  const contributors = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  saveKeys(presale, contributors);
  console.log('\nPresale receiver (SOL lands here):', presale.publicKey.toBase58());
  contributors.forEach((k, i) => {
    console.log(`Contributor ${i + 1}:`, k.publicKey.toBase58());
  });
}

async function phaseFund() {
  assertDevnet();
  const keys = loadKeys();
  if (!keys) throw new Error('Run --setup first');
  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const conn = config.stakeConnection;

  await airdropIfLow(conn, treasury.publicKey, 1.5);

  const fundEach = 30_000_000n; // 0.03 SOL per contributor for fees + tiny transfer
  for (let i = 0; i < keys.contributors.length; i++) {
    const c = keys.contributors[i];
    await sendSol(conn, treasury, c.publicKey, fundEach);
    console.log('Funded contributor', i + 1, c.publicKey.toBase58());
  }

  for (let i = 0; i < keys.contributors.length; i++) {
    const c = keys.contributors[i];
    const lamports = CONTRIBUTOR_LAMPORTS[i];
    await sendSol(conn, c, keys.presale.publicKey, lamports);
    console.log(
      'Contributor',
      i + 1,
      'sent',
      Number(lamports),
      'lamports → presale',
      keys.presale.publicKey.toBase58(),
    );
  }
  console.log('\nFund phase done. Presale wallet received scaled “contributions”.');
}

async function phaseMint() {
  assertDevnet();
  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const conn = config.stakeConnection;
  await airdropIfLow(conn, treasury.publicKey, 1.0);

  const mintKeypair = Keypair.generate();
  console.log('Creating mint', mintKeypair.publicKey.toBase58(), `decimals=${DECIMALS}`);
  await createMint(
    conn,
    treasury,
    treasury.publicKey,
    null,
    DECIMALS,
    mintKeypair,
    { commitment: 'confirmed' },
    TOKEN_PROGRAM_ID,
  );

  const mint = mintKeypair.publicKey;
  const ata = await getOrCreateAssociatedTokenAccount(
    conn,
    treasury,
    mint,
    treasury.publicKey,
    false,
    'confirmed',
    { commitment: 'confirmed' },
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await mintTo(
    conn,
    treasury,
    mint,
    ata.address,
    treasury,
    Number(MINT_RAW_TOTAL),
    [],
    { commitment: 'confirmed' },
    TOKEN_PROGRAM_ID,
  );

  saveState({
    mint: mint.toBase58(),
    mintAuthority: treasury.publicKey.toBase58(),
    treasuryAta: ata.address.toBase58(),
    mintedRaw: MINT_RAW_TOTAL.toString(),
    presaleTokenTotalRaw: PRESALE_TOKEN_TOTAL_RAW.toString(),
  });
  console.log('Minted', MINT_RAW_TOTAL.toString(), 'raw units to treasury ATA', ata.address.toBase58());
}

async function phasePool() {
  assertDevnet();
  const state = loadState();
  if (!state.mint) throw new Error('Run --mint first');

  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const programId = new PublicKey(config.requireEnv('POB_STAKE_PROGRAM_ID'));
  const stakeMint = new PublicKey(state.mint);
  const conn = config.stakeConnection;

  const stakeTokenProgram = await detectTokenProgram(conn, stakeMint);
  const anchor = require('@coral-xyz/anchor');
  const provider = buildProvider(conn, treasury);
  const program = new anchor.Program(loadIdl(programId), provider);

  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), stakeMint.toBuffer()],
    programId,
  );

  const existing = await program.account.stakePool.fetchNullable(pool);
  if (!existing) {
    const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, stakeTokenProgram);
    const sig = await program.methods
      .initializePool()
      .accounts({
        authority: treasury.publicKey,
        stakeMint,
        pool,
        stakeVault,
        tokenProgram: stakeTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log('initializePool', sig);
  } else {
    console.log('Pool already exists for this mint — skipping init.');
  }

  const [rewardMintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward'), pool.toBuffer(), stakeMint.toBuffer()],
    programId,
  );
  const rewardVault = getAssociatedTokenAddressSync(stakeMint, pool, true, stakeTokenProgram);
  const rmExisting = await program.account.rewardMint.fetchNullable(rewardMintPda);
  if (!rmExisting) {
    const sig2 = await program.methods
      .addRewardMint()
      .accounts({
        pool,
        authority: treasury.publicKey,
        rewardTokenMint: stakeMint,
        rewardMint: rewardMintPda,
        rewardVault,
        tokenProgram: stakeTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log('addRewardMint (stake line)', sig2);
  } else {
    console.log('Stake-mint reward line already registered — skipping.');
  }
}

function phasePrintEnv() {
  const keys = loadKeys();
  const state = loadState();
  if (!keys || !state.mint) {
    console.log('Run --setup, --mint first (or --all).');
    return;
  }
  const presalePk = keys.presale.publicKey.toBase58();
  const stakeRpc = config.STAKE_RPC_URL;
  console.log('\n─── Copy / paste for your shell (devnet drill) ───\n');
  console.log(`export POB_STAKE_MINT=${state.mint}`);
  console.log(`export POBINDEX_PRESALE_WALLET=${presalePk}`);
  console.log(`export POBINDEX_PRESALE_TOKEN_TOTAL=${state.presaleTokenTotalRaw || PRESALE_TOKEN_TOTAL_RAW.toString()}`);
  console.log('export POBINDEX_PRESALE_LOCK_DAYS=7');
  console.log('export POBINDEX_PRESALE_MIN_SOL=0');
  console.log('export POBINDEX_PRESALE_STATE_DIR=data/presale-devnet');
  console.log(`export POBINDEX_PRESALE_RPC_URL="${stakeRpc}"`);
  console.log('\nThen from pobindex-worker:');
  console.log('  npm run presale:scan -- --full');
  console.log('  npm run presale:preview');
  console.log('  npm run presale:distribute -- --live');
  console.log('\nContributor wallets (import secretKey in Phantom to test UI):');
  keys.contributors.forEach((k, i) => {
    console.log(`  C${i + 1}: ${k.publicKey.toBase58()}`);
  });
  console.log(`\nKeys file: ${KEYS_PATH}`);
  console.log('\nSite (Vite): set in POBINDEX/.env.local then restart `npm run dev`:');
  console.log(`  VITE_POB_STAKE_MINT=${state.mint}`);
  console.log(`  VITE_SOLANA_RPC=<same devnet RPC as above>`);
  console.log('  Phantom → Settings → Developer Settings → Testnet mode → Devnet.');
  console.log('  Staked tokens never appear in the wallet SPL balance — they live in the pool vault;');
  console.log('  the Stake tab lists them under “Your positions”.');
  console.log('\nOptional: deposit a few reward tokens with stake-admin add-reward + worker deposit,');
  console.log('then connect as each contributor in the site Stake tab → claim / unstake_early.\n');
}

async function phaseAll() {
  if (!loadKeys()) await phaseSetup();
  else console.log('Using existing', KEYS_PATH);
  await phaseFund();
  if (!loadState().mint) await phaseMint();
  else console.log('Mint already in drill-state — skipping --mint');
  await phasePool();
  phasePrintEnv();
}

async function main() {
  const { cmd } = parseArgs(process.argv);
  assertDevnet();
  if (cmd === 'help' || cmd === '--help') {
    console.log(`Usage:
  node scripts/presale-devnet-drill.js --setup
  node scripts/presale-devnet-drill.js --fund
  node scripts/presale-devnet-drill.js --mint
  node scripts/presale-devnet-drill.js --pool
  node scripts/presale-devnet-drill.js --print-env
  node scripts/presale-devnet-drill.js --all
`);
    process.exit(0);
  }
  if (cmd === 'setup') await phaseSetup();
  else if (cmd === 'fund') await phaseFund();
  else if (cmd === 'mint') await phaseMint();
  else if (cmd === 'pool') await phasePool();
  else if (cmd === 'print-env') phasePrintEnv();
  else if (cmd === 'all') await phaseAll();
  else {
    console.error('Unknown command');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * Build the list of wallets affected by the commingled stake/reward vault
 * drain on the pob-index-stake pool.
 *
 * For every OPEN position it reports the owner, staked principal, effective
 * weight, lock window, and whether the principal is currently backed by the
 * vault. It then aggregates by owner and writes:
 *   - affected-wallets.json  (machine-readable)
 *   - affected-wallets.csv   (spreadsheet-friendly)
 *
 * RPC: pass RPC via AFFECTED_RPC env, else falls back to public mainnet.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Connection, PublicKey } = require('@solana/web3.js');
const { getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const anchor = require('@coral-xyz/anchor');

const SDK_IDL_PATH = path.join(__dirname, '..', '..', 'staking-sdk', 'src', 'idl.json');

function findPda(seedParts, programId) {
  return PublicKey.findProgramAddressSync(seedParts, programId)[0];
}

async function main() {
  const rpc = process.env.AFFECTED_RPC || 'https://api.mainnet-beta.solana.com';
  const programId = new PublicKey(
    process.env.POB_STAKE_PROGRAM_ID || '65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA',
  );
  const stakeMint = new PublicKey(
    process.env.POB_STAKE_MINT || 'XscZkQn3cFj1t9Ym4LNtEMrsi6eeeCTCtb6bTPrpump',
  );
  const pool = findPda([Buffer.from('pool'), stakeMint.toBuffer()], programId);

  console.error(`RPC:        ${rpc}`);
  console.error(`Program:    ${programId.toBase58()}`);
  console.error(`Stake mint: ${stakeMint.toBase58()}`);
  console.error(`Pool:       ${pool.toBase58()}`);

  const connection = new Connection(rpc, 'confirmed');
  const wallet = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync(SDK_IDL_PATH, 'utf8'));
  const program = new anchor.Program({ ...idl, address: programId.toBase58() }, provider);

  const poolAcc = await program.account.stakePool.fetch(pool);
  const stakeVault = poolAcc.stakeVault;
  const totalStaked = BigInt(poolAcc.totalStaked.toString());

  // Vault balance (commingled stake + stake-mint reward vault).
  let vaultBal = 0n;
  for (const tp of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const acc = await getAccount(connection, stakeVault, 'confirmed', tp);
      vaultBal = BigInt(acc.amount.toString());
      break;
    } catch (_) { /* try next program */ }
  }

  console.error('Fetching all positions (getProgramAccounts)...');
  const positions = await program.account.stakePosition.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  console.error(`Total position accounts: ${positions.length}`);

  const open = positions.filter((p) => !p.account.closed);

  // Aggregate by owner.
  const byOwner = new Map();
  for (const p of open) {
    const owner = p.account.owner.toBase58();
    const amount = BigInt(p.account.amount.toString());
    const eff = BigInt(p.account.effective.toString());
    const rec = byOwner.get(owner) || {
      owner,
      openPositions: 0,
      stakedRaw: 0n,
      effectiveRaw: 0n,
      earliestLockStart: null,
      latestLockEnd: null,
      positions: [],
    };
    rec.openPositions += 1;
    rec.stakedRaw += amount;
    rec.effectiveRaw += eff;
    const ls = Number(p.account.lockStart);
    const le = Number(p.account.lockEnd);
    rec.earliestLockStart = rec.earliestLockStart === null ? ls : Math.min(rec.earliestLockStart, ls);
    rec.latestLockEnd = rec.latestLockEnd === null ? le : Math.max(rec.latestLockEnd, le);
    rec.positions.push({
      position: p.publicKey.toBase58(),
      amountRaw: amount.toString(),
      lockDays: Number(p.account.lockDays),
      lockStart: ls,
      lockEnd: le,
    });
    byOwner.set(owner, rec);
  }

  const owners = [...byOwner.values()].sort((a, b) => (b.stakedRaw > a.stakedRaw ? 1 : -1));
  const totalOpenStaked = owners.reduce((s, o) => s + o.stakedRaw, 0n);

  // Decimals for UI formatting.
  const mintInfo = await connection.getParsedAccountInfo(stakeMint);
  const decimals = mintInfo?.value?.data?.parsed?.info?.decimals ?? 6;
  const div = 10 ** decimals;
  const ui = (raw) => (Number(raw) / div);

  // Pro-rata recoverable fraction if vault were distributed across open principal.
  const backedFraction = totalOpenStaked > 0n ? Number(vaultBal) / Number(totalOpenStaked) : 0;

  const summary = {
    generatedAt: new Date().toISOString(),
    pool: pool.toBase58(),
    stakeMint: stakeMint.toBase58(),
    stakeVault: stakeVault.toBase58(),
    decimals,
    vaultBalanceRaw: vaultBal.toString(),
    vaultBalanceUi: ui(vaultBal),
    poolTotalStakedRaw: totalStaked.toString(),
    poolTotalStakedUi: ui(totalStaked),
    sumOpenPositionsRaw: totalOpenStaked.toString(),
    sumOpenPositionsUi: ui(totalOpenStaked),
    shortfallRaw: (totalOpenStaked - vaultBal).toString(),
    shortfallUi: ui(totalOpenStaked - vaultBal),
    backedFractionPct: +(backedFraction * 100).toFixed(4),
    affectedOwnerCount: owners.length,
    openPositionCount: open.length,
  };

  const rows = owners.map((o) => {
    const proRataRecoverableRaw = BigInt(Math.floor(Number(o.stakedRaw) * backedFraction));
    return {
      owner: o.owner,
      openPositions: o.openPositions,
      stakedRaw: o.stakedRaw.toString(),
      stakedUi: ui(o.stakedRaw),
      effectiveRaw: o.effectiveRaw.toString(),
      proRataRecoverableUi: ui(proRataRecoverableRaw),
      unbackedUi: ui(o.stakedRaw - proRataRecoverableRaw),
      earliestLockStart: o.earliestLockStart,
      latestLockEnd: o.latestLockEnd,
      latestLockEndIso: o.latestLockEnd ? new Date(o.latestLockEnd * 1000).toISOString() : null,
      positions: o.positions,
    };
  });

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'affected-wallets.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, wallets: rows }, null, 2));

  const csvHeader = 'owner,open_positions,staked_ui,effective_raw,pro_rata_recoverable_ui,unbacked_ui,latest_lock_end_iso';
  const csvLines = rows.map((r) =>
    [r.owner, r.openPositions, r.stakedUi, r.effectiveRaw, r.proRataRecoverableUi, r.unbackedUi, r.latestLockEndIso || ''].join(','),
  );
  const csvPath = path.join(outDir, 'affected-wallets.csv');
  fs.writeFileSync(csvPath, [csvHeader, ...csvLines].join('\n'));

  console.error('\n=== SUMMARY ===');
  console.error(JSON.stringify(summary, null, 2));
  console.error(`\nWrote:\n  ${jsonPath}\n  ${csvPath}`);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});

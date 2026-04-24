#!/usr/bin/env node
'use strict';

/**
 * One-shot: transfer the presale contributor pool (raw units from
 * POBINDEX_PRESALE_TOKEN_TOTAL) from Brr (dev-buy wallet) to Bank (treasury)
 * so `presale-distribute.js` can stake_for out of the treasury ATA.
 *
 * After this runs:
 *   - Brr keeps POBINDEX_PRESALE_TOKEN_TOTAL subtracted from total buy → 1 SOL-worth dev bag
 *   - Bank holds exactly POBINDEX_PRESALE_TOKEN_TOTAL POB500, ready for airdrop staking
 *
 * Safe to re-run: if Bank already holds ≥ the required amount, this exits
 * without sending any tx.
 */
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
  createTransferCheckedInstruction,
  getMint,
} = require('@solana/spl-token');

const config = require('../src/config');

(async () => {
  const brr  = config.parsePrivateKey(config.requireEnv('POBINDEX_DEVBUY_WALLET_PRIVATE_KEY'));
  const bank = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const mint = new PublicKey(config.requireEnv('POB_STAKE_MINT'));
  const amount = BigInt(config.requireEnv('POBINDEX_PRESALE_TOKEN_TOTAL'));
  const conn = config.stakeConnection;

  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found on stake cluster`);
  const tp = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintAcc = await getMint(conn, mint, 'confirmed', tp);

  console.log('[debug] mint        :', mint.toBase58());
  console.log('[debug] mint owner  :', info.owner.toBase58());
  console.log('[debug] tp selected :', tp.toBase58());
  console.log('[debug] Brr pubkey  :', brr.publicKey.toBase58());
  console.log('[debug] Bank pubkey :', bank.publicKey.toBase58());
  const brrAta  = getAssociatedTokenAddressSync(mint, brr.publicKey,  false, tp);
  const bankAta = getAssociatedTokenAddressSync(mint, bank.publicKey, false, tp);
  console.log('[debug] Brr  ATA    :', brrAta.toBase58());
  console.log('[debug] Bank ATA    :', bankAta.toBase58());

  const brrBal = await getAccount(conn, brrAta, 'confirmed', tp).catch(() => null);
  if (!brrBal) throw new Error(`Brr POB500 ATA ${brrAta.toBase58()} missing or empty`);
  const brrRaw = BigInt(brrBal.amount.toString());

  const bankBal = await getAccount(conn, bankAta, 'confirmed', tp).catch(() => null);
  const bankRaw = bankBal ? BigInt(bankBal.amount.toString()) : 0n;

  console.log('Brr POB500 balance :', brrRaw.toString(),  '(' + (Number(brrRaw)  / 10 ** mintAcc.decimals).toLocaleString() + ')');
  console.log('Bank POB500 balance:', bankRaw.toString(), '(' + (Number(bankRaw) / 10 ** mintAcc.decimals).toLocaleString() + ')');
  console.log('Transfer amount    :', amount.toString(),  '(' + (Number(amount)  / 10 ** mintAcc.decimals).toLocaleString() + ')');

  if (bankRaw >= amount) {
    console.log('Bank already holds ≥ required amount — nothing to do.');
    return;
  }
  const needed = amount - bankRaw;
  if (brrRaw < needed) {
    throw new Error(`Brr short — have ${brrRaw} raw, need to send ${needed}`);
  }

  const ix = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    createAssociatedTokenAccountIdempotentInstruction(brr.publicKey, bankAta, bank.publicKey, mint, tp),
    createTransferCheckedInstruction(brrAta, mint, bankAta, brr.publicKey, needed, mintAcc.decimals, [], tp),
  ];
  const tx = new Transaction().add(...ix);
  tx.feePayer = brr.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  if (process.argv.includes('--dry-run')) {
    const sim = await conn.simulateTransaction(tx, [brr], { commitment: 'confirmed', sigVerify: false });
    console.log('\n[dry-run] simulation err:', sim.value.err);
    console.log('[dry-run] logs:');
    for (const l of sim.value.logs || []) console.log('  ' + l);
    return;
  }

  console.log('\nSending transfer …');
  const sig = await sendAndConfirmTransaction(conn, tx, [brr], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  console.log('  sig:', sig);

  const bankAfter = await getAccount(conn, bankAta, 'confirmed', tp);
  console.log('Bank POB500 after :', bankAfter.amount.toString(),
    '(' + (Number(bankAfter.amount) / 10 ** mintAcc.decimals).toLocaleString() + ')');
})().catch((e) => { console.error(e); process.exit(1); });

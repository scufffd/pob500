import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

const enc = (s) => new TextEncoder().encode(s);

export function findPoolPda(programId, stakeMint) {
  return PublicKey.findProgramAddressSync(
    [enc('pool'), stakeMint.toBuffer()],
    programId,
  );
}

export function findRewardMintPda(programId, pool, mint) {
  return PublicKey.findProgramAddressSync(
    [enc('reward'), pool.toBuffer(), mint.toBuffer()],
    programId,
  );
}

export function findPositionPda(programId, pool, owner, nonce) {
  const nonceBn = BN.isBN(nonce) ? nonce : new BN(nonce);
  return PublicKey.findProgramAddressSync(
    [enc('position'), pool.toBuffer(), owner.toBuffer(), nonceBn.toArrayLike(Buffer, 'le', 8)],
    programId,
  );
}

export function findCheckpointPda(programId, position, rewardMint) {
  return PublicKey.findProgramAddressSync(
    [enc('checkpoint'), position.toBuffer(), rewardMint.toBuffer()],
    programId,
  );
}

export const LOCK_TIERS = [
  { days: 1, multiplierBps: 10_000, label: '1 day · 1.00×' },
  { days: 3, multiplierBps: 12_500, label: '3 days · 1.25×' },
  { days: 7, multiplierBps: 15_000, label: '7 days · 1.50×' },
  { days: 14, multiplierBps: 20_000, label: '14 days · 2.00×' },
  { days: 21, multiplierBps: 25_000, label: '21 days · 2.50×' },
  { days: 30, multiplierBps: 30_000, label: '30 days · 3.00×' },
];

/** Flat early-unstake penalty in basis points (1000 = 10.00%). Must match
 * `EARLY_UNSTAKE_PENALTY_BPS` in the on-chain program's state.rs. */
export const EARLY_UNSTAKE_PENALTY_BPS = 1_000;

export function multiplierForDays(days) {
  const tier = LOCK_TIERS.find((t) => t.days === days);
  return tier ? tier.multiplierBps : null;
}

/** @returns {{ penalty: bigint, refund: bigint }} */
export function computeEarlyUnstakePenalty(amount) {
  const a = typeof amount === 'bigint' ? amount : BigInt(String(amount));
  const penalty = (a * BigInt(EARLY_UNSTAKE_PENALTY_BPS)) / 10_000n;
  const refund = a - penalty;
  return { penalty, refund };
}

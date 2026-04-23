import { AnchorProvider, Program, BN } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import idl from './idl.json';
import {
  findCheckpointPda,
  findPoolPda,
  findPositionPda,
  findRewardMintPda,
  multiplierForDays,
  computeEarlyUnstakePenalty,
} from './pda.js';

export const DEFAULT_PROGRAM_ID = new PublicKey(idl.address);

/**
 * Resolve the SPL token program (legacy vs Token-2022) that owns a given mint.
 *
 * We deliberately throw when the mint account is missing or owned by anything
 * other than the two known token programs. Silently defaulting to legacy was a
 * long-standing footgun: if an RPC blip returned `null`, or the reward mint
 * was Token-2022 but not yet in a caller's cache, we'd build ATA-create ixs
 * against the wrong token program and the ATA program would fail instruction 0
 * with `IncorrectProgramId` (see the unstake-early regression).
 */
export async function detectMintTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`Mint ${mint.toBase58()} not found on-chain (cannot detect token program)`);
  }
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(
    `Mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not a known SPL token program`,
  );
}

/**
 * Build an Anchor Program instance bound to the given provider.
 */
export function getStakeProgram(provider, programId = DEFAULT_PROGRAM_ID) {
  const customIdl = { ...idl, address: programId.toBase58() };
  return new Program(customIdl, provider);
}

export function makeProvider(connection, wallet, opts = {}) {
  return new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
    ...opts,
  });
}

/**
 * Detects whether a mint is legacy SPL or Token-2022 by looking at its
 * on-chain owner. Returns the token program pubkey.
 */
export async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not owned by a token program (owner=${info.owner.toBase58()})`);
}

export class StakeClient {
  /**
   * @param {object} opts
   * @param {Program} opts.program       Anchor Program instance
   * @param {PublicKey} [opts.programId] Program ID (defaults to program.programId)
   * @param {PublicKey} opts.stakeMint   Native POB stake mint
   * @param {PublicKey} [opts.stakeTokenProgram] Token program that owns stakeMint.
   *                                     Default: legacy TOKEN_PROGRAM_ID.
   *                                     The native POB mint is expected to be
   *                                     classic SPL; Printr reward mints pass
   *                                     their own tokenProgram to reward-ix
   *                                     builders.
   */
  constructor({ program, programId, stakeMint, stakeTokenProgram }) {
    this.program = program;
    this.programId = programId || program.programId;
    this.stakeMint = stakeMint;
    this.stakeTokenProgram = stakeTokenProgram || TOKEN_PROGRAM_ID;
    const [pool] = findPoolPda(this.programId, stakeMint);
    this.pool = pool;
    this.stakeVault = getAssociatedTokenAddressSync(
      stakeMint,
      pool,
      true,
      this.stakeTokenProgram,
    );
  }

  static async build(connection, wallet, { programId, stakeMint, stakeTokenProgram }) {
    const provider = makeProvider(connection, wallet);
    const program = getStakeProgram(provider, programId);
    let stp = stakeTokenProgram;
    if (!stp) {
      try {
        stp = await detectTokenProgram(connection, stakeMint);
      } catch {
        stp = TOKEN_PROGRAM_ID;
      }
    }
    return new StakeClient({ program, programId, stakeMint, stakeTokenProgram: stp });
  }

  rewardMintPda(mint) {
    return findRewardMintPda(this.programId, this.pool, mint)[0];
  }

  rewardVaultAddress(mint, tokenProgram = TOKEN_PROGRAM_ID) {
    return getAssociatedTokenAddressSync(mint, this.pool, true, tokenProgram);
  }

  positionPda(owner, nonce) {
    return findPositionPda(this.programId, this.pool, owner, nonce)[0];
  }

  checkpointPda(position, rewardMintPda) {
    return findCheckpointPda(this.programId, position, rewardMintPda)[0];
  }

  async fetchPool() {
    try {
      return await this.program.account.stakePool.fetch(this.pool);
    } catch (e) {
      return null;
    }
  }

  async fetchAllPositionsByOwner(owner) {
    const all = await this.program.account.stakePosition.all([
      // discriminator(8) + bump(1) + pool(32) = 41
      { memcmp: { offset: 8 + 1 + 32, bytes: owner.toBase58() } },
    ]);
    return all
      .map((a) => ({ publicKey: a.publicKey, account: a.account }))
      .filter((a) => a.account.pool.equals(this.pool) && !a.account.closed);
  }

  async fetchAllRewardMints() {
    const all = await this.program.account.rewardMint.all([
      { memcmp: { offset: 8 + 1, bytes: this.pool.toBase58() } },
    ]);
    return all;
  }

  /**
   * Fetch every open `StakePosition` on this pool (no owner filter). Used by
   * the worker when a new reward mint is registered, so it can prime one
   * RewardCheckpoint per position before any `deposit_rewards` lands. Without
   * that prime step, existing positions baseline at the post-deposit
   * `acc_per_share` on their first claim and never see the pre-baseline
   * deposit — see `claim.rs`'s baseline-safe init branch.
   */
  async fetchAllPositions() {
    const all = await this.program.account.stakePosition.all([
      // discriminator(8) + bump(1) = 9
      { memcmp: { offset: 8 + 1, bytes: this.pool.toBase58() } },
    ]);
    return all
      .map((a) => ({ publicKey: a.publicKey, account: a.account }))
      .filter((a) => a.account.pool.equals(this.pool) && !a.account.closed);
  }

  async fetchCheckpoint(position, rewardMintPda) {
    try {
      return await this.program.account.rewardCheckpoint.fetch(
        this.checkpointPda(position, rewardMintPda),
      );
    } catch (e) {
      return null;
    }
  }

  // --- ix builders -------------------------------------------------------

  async initializePoolIx(authority) {
    return this.program.methods
      .initializePool()
      .accounts({
        authority,
        stakeMint: this.stakeMint,
        pool: this.pool,
        stakeVault: this.stakeVault,
        tokenProgram: this.stakeTokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  /**
   * @param {PublicKey} authority
   * @param {PublicKey} rewardTokenMint
   * @param {PublicKey} [tokenProgram] Token program that owns rewardTokenMint.
   *                                   Caller should pass TOKEN_2022_PROGRAM_ID
   *                                   for Printr / Token-2022 mints.
   */
  async addRewardMintIx(authority, rewardTokenMint, tokenProgram = TOKEN_PROGRAM_ID) {
    return this.program.methods
      .addRewardMint()
      .accounts({
        pool: this.pool,
        authority,
        rewardTokenMint,
        rewardMint: this.rewardMintPda(rewardTokenMint),
        rewardVault: this.rewardVaultAddress(rewardTokenMint, tokenProgram),
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  async stakeIx({ owner, amount, lockDays, nonce, userTokenAccount }) {
    if (multiplierForDays(lockDays) == null) {
      throw new Error(`Invalid lock tier: ${lockDays}`);
    }
    const position = this.positionPda(owner, nonce);
    return this.program.methods
      .stake(new BN(amount), lockDays, new BN(nonce))
      .accounts({
        pool: this.pool,
        stakeMint: this.stakeMint,
        stakeVault: this.stakeVault,
        owner,
        userTokenAccount,
        position,
        tokenProgram: this.stakeTokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  /**
   * Snapshot a fresh `RewardCheckpoint` at the reward line's current
   * `acc_per_share`. MUST be called once per (position, reward_mint) pair
   * immediately after staking to baseline that position — without a
   * checkpoint, the first `claim` on an existing reward line would
   * retroactively include deposits made before the staker joined the pool.
   *
   * No-op if the checkpoint already exists.
   */
  /**
   * Snapshot a fresh `RewardCheckpoint` at the reward line's current
   * `acc_per_share`. Permissionless — `payer` is whoever funds the rent, not
   * necessarily the position owner. Used both by stakers themselves (where
   * payer == owner) and by the treasury during presale distribution (where
   * payer == treasury, position.owner == contributor).
   *
   * No-op if the checkpoint already exists.
   */
  async primeCheckpointIx({ payer, position, rewardTokenMint }) {
    const rewardMintPda = this.rewardMintPda(rewardTokenMint);
    return this.program.methods
      .primeCheckpoint()
      .accounts({
        pool: this.pool,
        rewardMint: rewardMintPda,
        position,
        checkpoint: this.checkpointPda(position, rewardMintPda),
        payer,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  /**
   * Build `prime_checkpoint` ixs for every reward mint that doesn't yet have
   * a checkpoint for this position. Safe to batch with `stake` / `stake_for`
   * so new stakers are correctly baselined in a single approval.
   *
   * @param {object} opts
   * @param {PublicKey} opts.payer         Rent payer & signer
   * @param {PublicKey} opts.position
   * @param {Array<{publicKey: PublicKey, account: {mint: PublicKey}}>} opts.rewardMints
   */
  async buildPrimeCheckpointIxs({ payer, position, rewardMints, owner }) {
    // Back-compat: earlier callers passed `owner` (self-stake case). Fall back
    // to that if `payer` wasn't supplied.
    const actualPayer = payer || owner;
    const ixs = [];
    for (const rm of rewardMints) {
      ixs.push(
        await this.primeCheckpointIx({
          payer: actualPayer,
          position,
          rewardTokenMint: rm.account.mint,
        }),
      );
    }
    return ixs;
  }

  /**
   * Stake-for: payer (typically treasury / presale wallet) funds tokens + rent
   * for a position whose `owner` is `beneficiary`. Beneficiary can later
   * call `claim`, `unstake`, `unstake_early` directly with their own wallet.
   *
   * @param {object} opts
   * @param {PublicKey} opts.payer              Treasury / presale signer
   * @param {PublicKey} opts.payerTokenAccount  Payer's POB500 ATA
   * @param {PublicKey} opts.beneficiary        Contributor wallet — written to position.owner
   * @param {BN|number|string} opts.amount      Raw token amount (mint decimals)
   * @param {number} opts.lockDays              Must be one of LOCK_TIERS
   * @param {BN|number|string} opts.nonce       Unique nonce per (beneficiary, pool)
   */
  async stakeForIx({ payer, payerTokenAccount, beneficiary, amount, lockDays, nonce }) {
    if (multiplierForDays(lockDays) == null) {
      throw new Error(`Invalid lock tier: ${lockDays}`);
    }
    const position = this.positionPda(beneficiary, nonce);
    return this.program.methods
      .stakeFor(new BN(amount), lockDays, new BN(nonce), beneficiary)
      .accounts({
        pool: this.pool,
        stakeMint: this.stakeMint,
        stakeVault: this.stakeVault,
        payer,
        payerTokenAccount,
        position,
        tokenProgram: this.stakeTokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  async depositRewardsIx({ funder, rewardTokenMint, funderTokenAccount, amount, tokenProgram = TOKEN_PROGRAM_ID }) {
    return this.program.methods
      .depositRewards(new BN(amount))
      .accounts({
        pool: this.pool,
        rewardMint: this.rewardMintPda(rewardTokenMint),
        mint: rewardTokenMint,
        vault: this.rewardVaultAddress(rewardTokenMint, tokenProgram),
        funder,
        funderTokenAccount,
        tokenProgram,
      })
      .instruction();
  }

  async claimIx({ owner, position, rewardTokenMint, userTokenAccount, tokenProgram = TOKEN_PROGRAM_ID }) {
    return this.program.methods
      .claim()
      .accounts({
        pool: this.pool,
        rewardMint: this.rewardMintPda(rewardTokenMint),
        mint: rewardTokenMint,
        vault: this.rewardVaultAddress(rewardTokenMint, tokenProgram),
        position,
        owner,
        checkpoint: this.checkpointPda(position, this.rewardMintPda(rewardTokenMint)),
        userTokenAccount,
        tokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  /**
   * Pool authority pushes accrued rewards to `position.owner`'s ATA (same math
   * as `claim`). Used by the worker for auto-payout each cycle.
   */
  async claimPushIx({ authority, position, rewardTokenMint, userTokenAccount, tokenProgram = TOKEN_PROGRAM_ID }) {
    return this.program.methods
      .claimPush()
      .accounts({
        pool: this.pool,
        authority,
        rewardMint: this.rewardMintPda(rewardTokenMint),
        mint: rewardTokenMint,
        vault: this.rewardVaultAddress(rewardTokenMint, tokenProgram),
        position,
        checkpoint: this.checkpointPda(position, this.rewardMintPda(rewardTokenMint)),
        userTokenAccount,
        tokenProgram,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
  }

  async unstakeIx({ owner, position, userTokenAccount }) {
    return this.program.methods
      .unstake()
      .accounts({
        pool: this.pool,
        stakeMint: this.stakeMint,
        stakeVault: this.stakeVault,
        position,
        owner,
        userTokenAccount,
        tokenProgram: this.stakeTokenProgram,
      })
      .instruction();
  }

  /**
   * Early unstake. Caller pays a flat 10% penalty on principal; the penalty is
   * redistributed to remaining stakers through the stake-mint reward line.
   *
   * Pre-requisites:
   *   - Admin has called `add_reward_mint(stakeMint)` once to register the
   *     stake mint as its own reward line (creates the `stakeRewardVault`).
   *   - Caller has claimed (or is about to claim in the same tx) any pending
   *     rewards — closing the position will forfeit unclaimed accruals.
   */
  async unstakeEarlyIx({ owner, position, userTokenAccount }) {
    const stakeRewardMintPda = this.rewardMintPda(this.stakeMint);
    return this.program.methods
      .unstakeEarly()
      .accounts({
        pool: this.pool,
        stakeMint: this.stakeMint,
        stakeVault: this.stakeVault,
        stakeRewardMint: stakeRewardMintPda,
        position,
        owner,
        userTokenAccount,
        tokenProgram: this.stakeTokenProgram,
      })
      .instruction();
  }

  /**
   * Build a list of `claim` ixs for every reward mint the position has a
   * non-zero pending balance against. Used by `unstakeEarlyTx` to settle
   * rewards atomically with the unstake.
   *
   * `rewardTokenPrograms` is an optional map (rewardMintPda.toBase58() → PublicKey)
   * of pre-detected token programs. Any reward mint missing from the map is
   * resolved on-the-fly via `connection` — which MUST be supplied. We never
   * silently default to the legacy SPL program, because Token-2022 reward mints
   * (which is all of our basket) would then get ATA-creates pointed at the
   * wrong program and fail simulation at instruction 0.
   */
  async buildAutoClaimIxs({
    owner,
    position,
    rewardMints,
    rewardTokenPrograms,
    connection,
    ensureAtas,
    checkpoints = {},
  }) {
    const ixs = [];
    for (const rm of rewardMints) {
      const rewardMintPda = rm.publicKey;
      const rewardTokenMint = rm.account.mint;
      let tokenProgram = rewardTokenPrograms?.[rewardMintPda.toBase58()];
      if (!tokenProgram) {
        if (!connection) {
          throw new Error(
            `buildAutoClaimIxs: missing token program for reward mint ${rewardTokenMint.toBase58()} ` +
              `and no connection supplied for on-the-fly detection`,
          );
        }
        tokenProgram = await detectMintTokenProgram(connection, rewardTokenMint);
      }
      const userAta = getAssociatedTokenAddressSync(
        rewardTokenMint,
        owner,
        false,
        tokenProgram,
      );
      const checkpointKey = `${position.toBase58()}|${rewardMintPda.toBase58()}`;
      const ck = checkpoints[checkpointKey];

      // Skip reward lines with zero pending — saves tx space.
      const accDelta = BigInt(String(rm.account.accPerShare)) -
        BigInt(String(ck?.accPerShare || 0));
      if (accDelta === 0n && (!ck || BigInt(String(ck.claimable || 0)) === 0n)) {
        continue;
      }

      if (typeof ensureAtas === 'function') {
        await ensureAtas({ mint: rewardTokenMint, ata: userAta, tokenProgram });
      }
      ixs.push(
        await this.claimIx({
          owner,
          position,
          rewardTokenMint,
          userTokenAccount: userAta,
          tokenProgram,
        }),
      );
    }
    return ixs;
  }
}

/**
 * Compute the projected early-unstake penalty for a position.
 * Mirrors the on-chain math in `compute_early_unstake_penalty`.
 */
export function quoteEarlyUnstake(positionAccount) {
  const amount = BigInt(String(positionAccount.amount));
  return computeEarlyUnstakePenalty(amount);
}

/**
 * Compute the projected pending payout (u64 amount) for a position against a
 * given reward-mint accumulator state, matching the on-chain math.
 */
export function computePending({ accPerShare, effective, checkpointAcc, claimable }) {
  const ACC = new BN('1000000000000000000');
  const delta = new BN(String(accPerShare)).sub(new BN(String(checkpointAcc || 0)));
  const accrued = delta.mul(new BN(String(effective))).div(ACC);
  return new BN(String(claimable || 0)).add(accrued);
}

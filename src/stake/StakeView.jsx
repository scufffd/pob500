import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnchorWallet, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
} from '@solana/spl-token';
import BN from 'bn.js';

import {
  computePending,
  detectMintTokenProgram,
  quoteEarlyUnstake,
} from '../../staking-sdk/src/client.js';
import { LOCK_TIERS, EARLY_UNSTAKE_PENALTY_BPS } from '../../staking-sdk/src/pda.js';
import { useStakingClient } from './useStakingClient.js';

// Thin alias so the rest of this file keeps its old name, but every call now
// goes through the strict SDK helper that throws on unknown/unowned mints
// instead of silently pretending Token-2022 mints are legacy SPL.
const detectTokenProgram = (connection, mint) => detectMintTokenProgram(connection, mint);

const C = { cyan: '#00F5FF', violet: '#BF5AF2', green: '#14F195', yellow: '#FFD60A', red: '#FF6B6B' };

const glass = (extra = {}) => ({
  background: 'rgba(255,255,255,0.035)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 16,
  boxShadow: '0 8px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.05)',
  ...extra,
});

function fmtTokens(raw, decimals) {
  if (raw == null) return '—';
  const bn = BN.isBN(raw) ? raw : new BN(String(raw));
  const d = decimals ?? 9;
  const s = bn.toString();
  if (s.length <= d) {
    return `0.${s.padStart(d, '0').slice(0, 4)}`;
  }
  const whole = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d, s.length - d + 4);
  return `${Number(whole).toLocaleString()}${frac ? '.' + frac : ''}`;
}

// Convert a decimal human string (e.g. "1234.5") to a raw BN at the given
// token decimals without ever going through Number. Using `human *
// 10**decimals` loses precision past 2^53 (~9×10^15), which for a 9-decimal
// token means anything over ~9,000,000 tokens overflows and the resulting
// `new BN(nonSafeInt)` throws "Assertion failed". This helper stays in
// string-land so it works for any realistic supply.
function parseAmountToRaw(input, decimals) {
  if (input == null) throw new Error('Enter a valid amount');
  let s = String(input).trim();
  if (!s) throw new Error('Enter a valid amount');
  // Allow common locale commas, strip them.
  s = s.replace(/,/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) throw new Error('Amount must be positive');
  if (!/^\d*(?:\.\d*)?$/.test(s) || s === '.' || s === '') {
    throw new Error('Enter a valid amount');
  }
  const [wholePart = '0', fracRaw = ''] = s.split('.');
  // Truncate fractional part to `decimals` places (Solana has no sub-atomic
  // units). Pad with zeros if shorter, so "1.5" with d=9 becomes
  // "1" + "500000000".
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, '0');
  const combined = (wholePart + frac).replace(/^0+(?=\d)/, '') || '0';
  const raw = new BN(combined, 10);
  if (raw.isZero()) throw new Error('Amount must be greater than zero');
  return raw;
}

// Compute `raw * percent / 100` in pure BN, then format the result as a
// decimal human string suitable for the amount input.
function percentOfBalance(rawBalance, percent, decimals) {
  if (!rawBalance) return '';
  const bn = BN.isBN(rawBalance) ? rawBalance : new BN(String(rawBalance));
  const slice = bn.muln(percent).divn(100);
  const s = slice.toString();
  if (s === '0') return '0';
  if (s.length <= decimals) {
    return `0.${s.padStart(decimals, '0').replace(/0+$/, '') || '0'}`;
  }
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function timeLeft(lockEnd) {
  const now = Math.floor(Date.now() / 1000);
  const end = Number(lockEnd);
  if (!Number.isFinite(end)) return '—';
  const secs = end - now;
  if (secs <= 0) return 'Unlocked';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

export default function StakeView() {
  const { publicKey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const { client, ready, notConfigured, programId, stakeMint, stakeTokenProgram } = useStakingClient();

  const [pool, setPool] = useState(null);
  const [positions, setPositions] = useState([]);
  const [rewardMints, setRewardMints] = useState([]);
  const [checkpoints, setCheckpoints] = useState({}); // position|rewardMint -> ckpt
  // Sentinel set once the full snapshot (pool+positions+rewardMints+checkpoints)
  // has loaded at least once. While false the UI skips pending-reward math so we
  // don't flash "claim everything since inception" values between partial state
  // updates — a race where rewardMints would land before checkpoints and
  // `ck?.accPerShare || 0` would momentarily default to 0, inflating pending.
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [stakeBalance, setStakeBalance] = useState(null);
  const [stakeDecimals, setStakeDecimals] = useState(9);
  const [rewardDecimals, setRewardDecimals] = useState({}); // rewardMintPda -> decimals
  const [rewardTokenPrograms, setRewardTokenPrograms] = useState({}); // rewardMintPda -> PublicKey
  // mintBase58 -> BN wallet balance; surfaced as "in wallet" next to each reward
  // so users can see tokens the worker has already auto-pushed via claim_push
  // (without this counter, pending=0 after every push makes the UI look idle).
  const [rewardWalletBalances, setRewardWalletBalances] = useState({});
  // mintBase58 -> { symbol, name } pulled from the Token-2022 metadata
  // extension. Keyed by the underlying SPL mint (not the RewardMint PDA) so it
  // can be shared between the reward cards and any future stake-mint display.
  const [tokenInfo, setTokenInfo] = useState({});
  // Mirror of `tokenInfo` keys — used by `refresh` (a useCallback) to skip
  // already-resolved mints without having to include `tokenInfo` in its dep
  // list (which would re-create the callback every time a new symbol lands).
  const tokenInfoRef = useRef({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [amount, setAmount] = useState('');
  const [lockDays, setLockDays] = useState(30);

  const refresh = useCallback(async () => {
    if (!ready || !client || !publicKey) return;
    try {
      const [p, positionList, rewardList] = await Promise.all([
        client.fetchPool(),
        client.fetchAllPositionsByOwner(publicKey),
        client.fetchAllRewardMints(),
      ]);

      // Resolve token programs + decimals concurrently so we have a full picture
      // before any setState. This is the key fix for the "pending briefly shows
      // huge numbers" flicker: we only commit state once the matching checkpoints
      // (below) have also loaded.
      const decimalsMap = {};
      const progMap = {};
      await Promise.all(
        rewardList.map(async (rm) => {
          const progId = await detectTokenProgram(connection, rm.account.mint);
          progMap[rm.publicKey.toBase58()] = progId;
          try {
            const m = await getMint(connection, rm.account.mint, 'confirmed', progId);
            decimalsMap[rm.publicKey.toBase58()] = m.decimals;
          } catch {
            decimalsMap[rm.publicKey.toBase58()] = 9;
          }
        }),
      );

      // Resolve on-chain ticker/name from the Token-2022 metadata pointer
      // extension for every reward mint (and the stake mint). Printr tokens
      // embed the metadata in the mint itself, so one RPC per mint is enough.
      // Legacy SPL mints are silently skipped — they don't use this extension
      // and the UI will fall back to the truncated mint string.
      const infoUpdates = {};
      const mintsToResolve = [
        ...rewardList.map((rm) => ({ mint: rm.account.mint, prog: progMap[rm.publicKey.toBase58()] })),
        { mint: stakeMint, prog: stakeTokenProgram },
      ];
      await Promise.all(
        mintsToResolve.map(async ({ mint, prog }) => {
          const key = mint.toBase58();
          if (tokenInfoRef.current[key] || infoUpdates[key]) return;
          if (!prog || !prog.equals(TOKEN_2022_PROGRAM_ID)) return;
          try {
            const md = await getTokenMetadata(connection, mint, 'confirmed', prog);
            if (md && (md.symbol || md.name)) {
              infoUpdates[key] = { symbol: md.symbol || null, name: md.name || null };
            }
          } catch {
            // Metadata extension absent or RPC hiccup — not fatal, UI will
            // render the truncated mint instead.
          }
        }),
      );

      // Load every (position × reward mint) checkpoint BEFORE any setState so
      // the first render using the new rewardMints always has matching ck data.
      const ckMap = {};
      await Promise.all(
        positionList.flatMap((pos) =>
          rewardList.map(async (rm) => {
            const ck = await client.fetchCheckpoint(pos.publicKey, rm.publicKey);
            if (ck) ckMap[`${pos.publicKey.toBase58()}|${rm.publicKey.toBase58()}`] = ck;
          }),
        ),
      );

      // Stake-mint wallet balance (for the "Your wallet" metric + stake form).
      const mintInfo = await getMint(connection, stakeMint, 'confirmed', stakeTokenProgram);
      const newStakeDecimals = mintInfo.decimals;
      const stakeAta = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeTokenProgram);
      let newStakeBalance;
      try {
        const acc = await getAccount(connection, stakeAta, 'confirmed', stakeTokenProgram);
        newStakeBalance = new BN(acc.amount.toString());
      } catch {
        newStakeBalance = new BN(0);
      }

      // Wallet balances for every reward-mint ATA so the UI can surface what
      // the worker's claim_push has already delivered. After a push, pending
      // always returns to 0 (correct on-chain state) — showing "In wallet"
      // prevents users from thinking nothing is happening.
      const walletBalancesByMint = {};
      await Promise.all(
        rewardList.map(async (rm) => {
          const mintB58 = rm.account.mint.toBase58();
          const prog = progMap[rm.publicKey.toBase58()];
          if (!prog) return;
          const ata = getAssociatedTokenAddressSync(rm.account.mint, publicKey, false, prog);
          try {
            const acc = await getAccount(connection, ata, 'confirmed', prog);
            walletBalancesByMint[mintB58] = new BN(acc.amount.toString());
          } catch {
            walletBalancesByMint[mintB58] = new BN(0);
          }
        }),
      );

      // Commit everything in one pass. React 18 batches these synchronous sets
      // into a single render, so consumers never see positions/rewardMints
      // without the corresponding checkpoints.
      setPool(p);
      setPositions(positionList);
      setRewardMints(rewardList);
      setRewardDecimals(decimalsMap);
      setRewardTokenPrograms(progMap);
      setCheckpoints(ckMap);
      setStakeDecimals(newStakeDecimals);
      setStakeBalance(newStakeBalance);
      setRewardWalletBalances(walletBalancesByMint);
      if (Object.keys(infoUpdates).length > 0) {
        tokenInfoRef.current = { ...tokenInfoRef.current, ...infoUpdates };
        setTokenInfo((prev) => ({ ...prev, ...infoUpdates }));
      }
      setSnapshotReady(true);
    } catch (e) {
      console.error('refresh failed', e);
    }
  }, [ready, client, publicKey, connection, stakeMint, stakeTokenProgram]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleStake = useCallback(async () => {
    if (!client || !publicKey || !anchorWallet) return;
    try {
      setBusy(true);
      setMsg(null);
      const raw = parseAmountToRaw(amount, stakeDecimals);
      if (stakeBalance && raw.gt(stakeBalance)) throw new Error('Amount exceeds wallet balance');

      const userAta = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeTokenProgram);
      const nonce = new BN(Date.now());

      const stakeIxs = [];
      try {
        await getAccount(connection, userAta, 'confirmed', stakeTokenProgram);
      } catch {
        stakeIxs.push(
          createAssociatedTokenAccountInstruction(publicKey, userAta, publicKey, stakeMint, stakeTokenProgram),
        );
      }
      stakeIxs.push(
        await client.stakeIx({
          owner: publicKey,
          amount: raw,
          lockDays,
          nonce,
          userTokenAccount: userAta,
        }),
      );

      const TX_LIMIT = 1200;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const txFits = (t) => {
        try {
          const buf = t.serialize({ requireAllSignatures: false, verifySignatures: false });
          return buf.length <= TX_LIMIT;
        } catch {
          return false;
        }
      };

      // Keep the user stake transaction focused on staking only. Reward
      // checkpoint PDAs are rent-bearing accounts and can cost more SOL than
      // some user wallets keep on hand; the worker primes them with Bank before
      // the next reward spend instead.
      const allIxs = stakeIxs;
      const txs = [];
      let cur = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
      for (const ix of allIxs) {
        const test = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
        test.add(...cur.instructions, ix);
        if (txFits(test)) {
          cur.add(ix);
        } else {
          if (cur.instructions.length === 0) throw new Error('Single ix exceeds tx size limit');
          txs.push(cur);
          cur = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey });
          cur.add(ix);
        }
      }
      if (cur.instructions.length > 0) txs.push(cur);

      let sig;
      if (txs.length === 1) {
        sig = await client.program.provider.sendAndConfirm(txs[0]);
      } else {
        const signed = await anchorWallet.signAllTransactions(txs);
        for (const t of signed) {
          sig = await connection.sendRawTransaction(t.serialize(), { skipPreflight: false });
          await connection.confirmTransaction(sig, 'confirmed');
        }
      }
      setMsg({ kind: 'ok', text: `Staked · ${sig.slice(0, 8)}… Reward checkpoints will be prepared automatically.` });
      setAmount('');
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [client, publicKey, anchorWallet, amount, lockDays, stakeBalance, stakeDecimals, stakeMint, stakeTokenProgram, connection, refresh]);

  const handleClaim = useCallback(
    async (position, rewardMintAcc) => {
      if (!client || !publicKey) return;
      try {
        setBusy(true);
        setMsg(null);
        const rewardTokenMint = rewardMintAcc.account.mint;
        const tokenProgram =
          rewardTokenPrograms[rewardMintAcc.publicKey.toBase58()]
          || (await detectTokenProgram(connection, rewardTokenMint));
        const ata = getAssociatedTokenAddressSync(rewardTokenMint, publicKey, false, tokenProgram);
        const tx = new Transaction();
        try {
          await getAccount(connection, ata, 'confirmed', tokenProgram);
        } catch {
          tx.add(
            createAssociatedTokenAccountInstruction(
              publicKey,
              ata,
              publicKey,
              rewardTokenMint,
              tokenProgram,
            ),
          );
        }
        tx.add(
          await client.claimIx({
            owner: publicKey,
            position: position.publicKey,
            rewardTokenMint,
            userTokenAccount: ata,
            tokenProgram,
          }),
        );
        const sig = await client.program.provider.sendAndConfirm(tx);
        setMsg({ kind: 'ok', text: `Claim sent · ${sig.slice(0, 8)}…` });
        await refresh();
      } catch (e) {
        setMsg({ kind: 'err', text: e.message || String(e) });
      } finally {
        setBusy(false);
      }
    },
    [client, publicKey, connection, refresh, rewardTokenPrograms],
  );

  // Compound: claims every pending reward on `position` (incl. any POB500
  // reward line, e.g. from early-unstake penalty redistribution), then stakes
  // the user's current POB500 wallet balance (post-claim) into a NEW position
  // at the same `lockDays` as the source position. Multiplier and unlock
  // horizon match, so effective weight compounds without changing the lock
  // tier the user originally chose. Two wallet approvals: one batched claim
  // sign + one stake sign — we have to wait for claims to land before we can
  // read the fresh POB500 balance for the stake amount.
  const handleCompound = useCallback(
    async (position) => {
      if (!client || !publicKey || !anchorWallet) return;
      try {
        setBusy(true);
        setMsg(null);

        const provider = client.program.provider;
        const positionLockDays = position.account.lockDays;
        if (!LOCK_TIERS.find((t) => t.days === positionLockDays)) {
          throw new Error(`Unsupported lock tier on source position (${positionLockDays}d)`);
        }

        // -------- Phase 1: claim every pending reward on the source position
        const claimAtaIxs = [];
        const ensureAtas = async ({ mint, ata, tokenProgram }) => {
          try {
            await getAccount(connection, ata, 'confirmed', tokenProgram);
          } catch {
            claimAtaIxs.push(
              createAssociatedTokenAccountInstruction(
                publicKey,
                ata,
                publicKey,
                mint,
                tokenProgram,
              ),
            );
          }
        };
        const claimIxs = await client.buildAutoClaimIxs({
          owner: publicKey,
          position: position.publicKey,
          rewardMints,
          rewardTokenPrograms,
          connection,
          checkpoints,
          ensureAtas,
        });

        const { blockhash: claimBlockhash, lastValidBlockHeight: claimLVBH } =
          await connection.getLatestBlockhash('confirmed');

        const TX_LIMIT = 1200;
        const buildTx = (ixs, blockhash) => {
          const t = new Transaction();
          t.feePayer = publicKey;
          t.recentBlockhash = blockhash;
          for (const ix of ixs) t.add(ix);
          return t;
        };
        const txFits = (t) => {
          try {
            const len = t.serialize({ verifySignatures: false, requireAllSignatures: false }).length;
            return len <= TX_LIMIT;
          } catch {
            return false;
          }
        };

        const claimAllIxs = [...claimAtaIxs, ...claimIxs];
        const claimTxs = [];
        if (claimAllIxs.length > 0) {
          let cur = [];
          for (const ix of claimAllIxs) {
            const candidate = buildTx([...cur, ix], claimBlockhash);
            if (txFits(candidate) || cur.length === 0) {
              cur.push(ix);
            } else {
              claimTxs.push(buildTx(cur, claimBlockhash));
              cur = [ix];
            }
          }
          if (cur.length > 0) claimTxs.push(buildTx(cur, claimBlockhash));
        }

        if (claimTxs.length > 0) {
          setMsg({ kind: 'ok', text: `Step 1/2 — claiming (${claimTxs.length} tx${claimTxs.length > 1 ? 's' : ''})…` });
          const signedClaims = await anchorWallet.signAllTransactions(claimTxs);
          for (let i = 0; i < signedClaims.length; i += 1) {
            const sig = await connection.sendRawTransaction(signedClaims[i].serialize(), {
              skipPreflight: false,
            });
            await connection.confirmTransaction(
              { signature: sig, blockhash: claimBlockhash, lastValidBlockHeight: claimLVBH },
              'confirmed',
            );
          }
        }

        // -------- Phase 2: read fresh POB500 balance and restake at same tier
        const stakeProg = await detectTokenProgram(connection, stakeMint);
        const userAta = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeProg);
        let freshBalance = new BN(0);
        try {
          const acc = await getAccount(connection, userAta, 'confirmed', stakeProg);
          freshBalance = new BN(acc.amount.toString());
        } catch {
          freshBalance = new BN(0);
        }

        if (freshBalance.isZero()) {
          setMsg({
            kind: 'ok',
            text:
              claimTxs.length > 0
                ? 'Claimed — no POB500 in wallet to restake. Sell basket rewards → buy POB500 → click Compound again.'
                : 'Nothing to compound (no pending rewards, no POB500 balance).',
          });
          await refresh();
          return;
        }

        const nonce = new BN(Date.now());
        const stakeIxList = [];
        try {
          await getAccount(connection, userAta, 'confirmed', stakeProg);
        } catch {
          stakeIxList.push(
            createAssociatedTokenAccountInstruction(publicKey, userAta, publicKey, stakeMint, stakeProg),
          );
        }
        stakeIxList.push(
          await client.stakeIx({
            owner: publicKey,
            amount: freshBalance,
            lockDays: positionLockDays,
            nonce,
            userTokenAccount: userAta,
          }),
        );

        const { blockhash: stakeBlockhash, lastValidBlockHeight: stakeLVBH } =
          await connection.getLatestBlockhash('confirmed');
        // As with normal staking, Bank/worker primes reward checkpoints. This
        // prevents low-SOL wallets from seeing a scary "insufficient lamports"
        // error after the actual restake succeeds.
        const stakeAllIxs = stakeIxList;
        const stakeTxs = [];
        let curStake = [];
        for (const ix of stakeAllIxs) {
          const candidate = buildTx([...curStake, ix], stakeBlockhash);
          if (txFits(candidate) || curStake.length === 0) {
            curStake.push(ix);
          } else {
            stakeTxs.push(buildTx(curStake, stakeBlockhash));
            curStake = [ix];
          }
        }
        if (curStake.length > 0) stakeTxs.push(buildTx(curStake, stakeBlockhash));

        setMsg({
          kind: 'ok',
          text: `Step 2/2 — restaking ${fmtTokens(freshBalance, stakeDecimals)} POB at ${positionLockDays}d (${(position.account.multiplierBps / 10_000).toFixed(2)}×)…`,
        });

        let lastSig;
        if (stakeTxs.length === 1) {
          lastSig = await provider.sendAndConfirm(stakeTxs[0]);
        } else {
          const signedStake = await anchorWallet.signAllTransactions(stakeTxs);
          for (let i = 0; i < signedStake.length; i += 1) {
            const sig = await connection.sendRawTransaction(signedStake[i].serialize(), {
              skipPreflight: false,
            });
            await connection.confirmTransaction(
              { signature: sig, blockhash: stakeBlockhash, lastValidBlockHeight: stakeLVBH },
              'confirmed',
            );
            lastSig = sig;
          }
        }

        setMsg({
          kind: 'ok',
          text: `Compounded · ${fmtTokens(freshBalance, stakeDecimals)} POB restaked at ${positionLockDays}d · ${String(lastSig).slice(0, 8)}… Checkpoints will be prepared automatically.`,
        });
        await refresh();
      } catch (e) {
        setMsg({ kind: 'err', text: e.message || String(e) });
      } finally {
        setBusy(false);
      }
    },
    [
      client,
      publicKey,
      anchorWallet,
      connection,
      stakeMint,
      stakeDecimals,
      rewardMints,
      rewardTokenPrograms,
      checkpoints,
      refresh,
    ],
  );

  const handleUnstake = useCallback(
    async (position) => {
      if (!client || !publicKey) return;
      try {
        setBusy(true);
        setMsg(null);
        // Re-detect on click rather than trusting cached state. Token-2022
        // mints were previously mis-bucketed as legacy when a transient RPC
        // miss tripped the old silent fallback, which made instruction 0
        // (`createAssociatedTokenAccount`) fail with `IncorrectProgramId`.
        const stakeProg = await detectTokenProgram(connection, stakeMint);
        const ata = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeProg);
        const tx = new Transaction();
        try {
          await getAccount(connection, ata, 'confirmed', stakeProg);
        } catch {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, ata, publicKey, stakeMint, stakeProg));
        }
        tx.add(
          await client.unstakeIx({
            owner: publicKey,
            position: position.publicKey,
            userTokenAccount: ata,
          }),
        );
        const sig = await client.program.provider.sendAndConfirm(tx);
        setMsg({ kind: 'ok', text: `Unstaked · ${sig.slice(0, 8)}…` });
        await refresh();
      } catch (e) {
        setMsg({ kind: 'err', text: e.message || String(e) });
      } finally {
        setBusy(false);
      }
    },
    [client, publicKey, connection, stakeMint, refresh],
  );

  const handleUnstakeEarly = useCallback(
    async (position) => {
      if (!client || !publicKey) return;
      const { penalty, refund } = quoteEarlyUnstake(position.account);
      const penaltyUi = fmtTokens(penalty.toString(), stakeDecimals);
      const refundUi = fmtTokens(refund.toString(), stakeDecimals);
      const confirmMsg =
        `Early unstake applies a ${(EARLY_UNSTAKE_PENALTY_BPS / 100).toFixed(0)}% penalty ` +
        `on principal. You will receive ${refundUi} POB (penalty ${penaltyUi} POB goes to ` +
        `remaining stakers). Any unclaimed rewards are auto-claimed in the same transaction. ` +
        `Continue?`;
      if (typeof window !== 'undefined' && !window.confirm(confirmMsg)) return;

      try {
        setBusy(true);
        setMsg(null);

        // We collect ATA-create ixs (for reward mint ATAs) and claim ixs
        // separately so we can split them across transactions if the combined
        // payload exceeds Solana's 1232-byte limit.
        const claimAtaIxs = [];
        const ensureAtas = async ({ mint, ata, tokenProgram }) => {
          try {
            await getAccount(connection, ata, 'confirmed', tokenProgram);
          } catch {
            claimAtaIxs.push(
              createAssociatedTokenAccountInstruction(
                publicKey,
                ata,
                publicKey,
                mint,
                tokenProgram,
              ),
            );
          }
        };

        const claimIxs = await client.buildAutoClaimIxs({
          owner: publicKey,
          position: position.publicKey,
          rewardMints,
          rewardTokenPrograms,
          connection, // enables on-the-fly token-program detection for any
                      // reward mint missing from `rewardTokenPrograms` (avoids
                      // legacy-SPL silent fallback on Token-2022 rewards)
          checkpoints,
          ensureAtas,
        });

        // Re-detect stake mint's token program at click time for the same
        // reason we do it in `handleUnstake` — defensive against stale state.
        const stakeProg = await detectTokenProgram(connection, stakeMint);
        const stakeAta = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeProg);
        let stakeAtaCreateIx = null;
        try {
          await getAccount(connection, stakeAta, 'confirmed', stakeProg);
        } catch {
          stakeAtaCreateIx = createAssociatedTokenAccountInstruction(
            publicKey,
            stakeAta,
            publicKey,
            stakeMint,
            stakeProg,
          );
        }

        const unstakeIx = await client.unstakeEarlyIx({
          owner: publicKey,
          position: position.publicKey,
          userTokenAccount: stakeAta,
        });

        const provider = client.program.provider;
        const { blockhash } = await connection.getLatestBlockhash('confirmed');

        const buildTx = (ixs) => {
          const t = new Transaction();
          t.feePayer = publicKey;
          t.recentBlockhash = blockhash;
          for (const ix of ixs) t.add(ix);
          return t;
        };

        // Solana caps packets at 1232 bytes; we keep a 32-byte safety margin.
        // `Transaction.serialize` throws when the message > 1232 bytes, so a
        // catch means "does NOT fit" (return false), NOT "unknown size".
        const TX_LIMIT = 1200;
        const txFits = (t) => {
          try {
            const len = t.serialize({ verifySignatures: false, requireAllSignatures: false }).length;
            return len <= TX_LIMIT;
          } catch {
            return false;
          }
        };

        // Greedy-pack instructions into transactions: append an ix to the
        // current tx if it still fits; otherwise start a new one. Preserves
        // global ordering so `unstake_early` always lands after every claim.
        const allIxs = [
          ...claimAtaIxs,
          ...claimIxs,
          ...(stakeAtaCreateIx ? [stakeAtaCreateIx] : []),
          unstakeIx,
        ];
        const txs = [];
        let currentIxs = [];
        for (const ix of allIxs) {
          const candidate = buildTx([...currentIxs, ix]);
          if (txFits(candidate) || currentIxs.length === 0) {
            currentIxs.push(ix);
          } else {
            txs.push(buildTx(currentIxs));
            currentIxs = [ix];
          }
        }
        if (currentIxs.length > 0) txs.push(buildTx(currentIxs));

        let sig;
        if (txs.length === 1) {
          setMsg({ kind: 'ok', text: 'Sending (claims + unstake-early)…' });
          sig = await provider.sendAndConfirm(txs[0]);
        } else {
          // Oversize: request one batched approval for all txs, then send
          // sequentially, confirming each before releasing the next so the
          // final unstake_early only runs if every prior claim landed.
          setMsg({
            kind: 'ok',
            text: `Batched approval: ${txs.length} transactions (${claimIxs.length} claims + unstake-early)…`,
          });
          const signed = await provider.wallet.signAllTransactions(txs);
          for (let i = 0; i < signed.length; i += 1) {
            const s = await connection.sendRawTransaction(signed[i].serialize(), {
              skipPreflight: false,
            });
            await connection.confirmTransaction(s, 'confirmed');
            sig = s;
            setMsg({
              kind: 'ok',
              text: `Confirmed tx ${i + 1}/${signed.length} · ${s.slice(0, 8)}…`,
            });
          }
        }

        setMsg({
          kind: 'ok',
          text: `Unstaked early · refund ${refundUi} · penalty ${penaltyUi} · ${sig.slice(0, 8)}…`,
        });
        await refresh();
      } catch (e) {
        const msg = e.message || String(e);
        if (/StakeMintRewardNotRegistered/i.test(msg)) {
          setMsg({
            kind: 'err',
            text:
              'Early unstake unavailable — admin has not registered the stake mint as a reward line yet. ' +
              'Run `npm run stake:register-stake-reward` on the worker.',
          });
        } else {
          setMsg({ kind: 'err', text: msg });
        }
      } finally {
        setBusy(false);
      }
    },
    [
      client,
      publicKey,
      connection,
      stakeMint,
      stakeTokenProgram,
      stakeDecimals,
      rewardMints,
      rewardTokenPrograms,
      checkpoints,
      refresh,
    ],
  );

  const totalStakedUi = pool ? fmtTokens(pool.totalStaked, stakeDecimals) : '—';
  const totalEffective = pool ? pool.totalEffective?.toString?.() || '0' : '0';
  const mySelected = useMemo(() => LOCK_TIERS.find((t) => t.days === lockDays) || LOCK_TIERS[2], [lockDays]);

  if (notConfigured) {
    return (
      <div style={{ ...glass(), padding: 28, maxWidth: 560, margin: '36px auto' }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10 }}>Staking not configured</div>
        <div className="mono" style={{ fontSize: 12, color: 'rgba(255,255,255,.55)', lineHeight: 1.7 }}>
          Set <code>VITE_POB_STAKE_PROGRAM_ID</code> and <code>VITE_POB_STAKE_MINT</code> in your
          <code> .env.local</code> (or pass them into your Vite build) before loading the stake
          view. See <code>POBINDEX/staking-program/README.md</code> for the boot sequence.
        </div>
      </div>
    );
  }

  return (
    <div className="stake-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...glass(), padding: 24 }}>
          <div className="stake-pool-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 14, flexWrap: 'wrap' }}>
            <div>
              <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 5 }}>Pool</div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em' }}>POB500 · Proof of Belief Stake</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.28)', marginTop: 4 }}>
                {stakeMint?.toBase58?.() || '—'}
              </div>
            </div>
            <WalletMultiButton />
          </div>

          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 20 }}>
            <Metric label="Total staked" value={totalStakedUi} accent={C.cyan} />
            <Metric label="Effective stake" value={totalEffective} accent={C.violet} />
            <Metric label="Reward mints" value={pool ? String(pool.rewardMintCount) : '—'} accent={C.green} />
            <Metric label="Your wallet" value={stakeBalance ? fmtTokens(stakeBalance, stakeDecimals) : (connected ? '0' : '—')} />
          </div>
          <div
            className="mono"
            style={{
              marginTop: -8,
              marginBottom: 16,
              padding: '10px 12px',
              borderRadius: 10,
              fontSize: 11,
              lineHeight: 1.65,
              color: 'rgba(255,255,255,.48)',
              background: 'rgba(0,245,255,.04)',
              border: '1px solid rgba(0,245,255,.12)',
            }}
          >
            <b style={{ color: 'rgba(255,255,255,.72)' }}>Wallet vs staked.</b> Tokens you stake — including presale{" "}
            <code style={{ color: C.cyan }}>stake_for</code> — move from your SPL account into the{" "}
            <b style={{ color: 'rgba(255,255,255,.72)' }}>pool vault</b> (program-controlled). Your wallet balance here can read{" "}
            <b>0</b> while <b>Your positions</b> below still shows the lock. Solscan → <i>Token balances</i> only lists your
            wallet ATAs, not vault custody, so you will not see incoming yMWEB transfers for staked amounts.
          </div>

          <div className="stake-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <div>
              <label className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.3)', textTransform: 'uppercase' }}>Amount</label>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={!connected || busy}
                style={{
                  width: '100%', marginTop: 8, background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.09)',
                  borderRadius: 10, padding: '10px 14px', fontSize: 14, color: '#fff', fontFamily: 'JetBrains Mono, monospace',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={!stakeBalance || busy}
                    onClick={() => {
                      if (!stakeBalance) return;
                      setAmount(percentOfBalance(stakeBalance, p, stakeDecimals));
                    }}
                    style={{
                      flex: 1, padding: '6px 0', background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.08)',
                      borderRadius: 8, color: 'rgba(255,255,255,.6)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5,
                      cursor: 'pointer',
                    }}
                  >{p === 100 ? 'MAX' : `${p}%`}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.3)', textTransform: 'uppercase' }}>Lock tier</label>
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {LOCK_TIERS.map((t) => {
                  const on = t.days === lockDays;
                  return (
                    <button
                      key={t.days}
                      type="button"
                      onClick={() => setLockDays(t.days)}
                      disabled={busy}
                      style={{
                        padding: '10px 0', borderRadius: 8, cursor: 'pointer',
                        background: on ? 'rgba(0,245,255,.08)' : 'rgba(255,255,255,.04)',
                        border: on ? '1px solid rgba(0,245,255,.45)' : '1px solid rgba(255,255,255,.08)',
                        color: on ? C.cyan : 'rgba(255,255,255,.55)',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700,
                        boxShadow: on ? '0 0 16px rgba(0,245,255,.2)' : 'none',
                      }}
                    >
                      <div>{t.days}d</div>
                      <div style={{ fontSize: 9.5, marginTop: 2, opacity: .7 }}>{(t.multiplierBps / 10_000).toFixed(2)}×</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="stake-action-row" style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="mono" style={{ fontSize: 11, color: 'rgba(255,255,255,.45)' }}>
              Effective weight · {(mySelected.multiplierBps / 10_000).toFixed(2)}× · unlock ~{lockDays}d
            </div>
            <button
              onClick={handleStake}
              disabled={!connected || busy || !amount}
              style={{
                padding: '10px 26px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)',
                background: connected ? 'linear-gradient(135deg,rgba(191,90,242,.85),rgba(0,245,255,.85))' : 'rgba(255,255,255,.05)',
                color: '#fff', fontSize: 13, fontWeight: 800, letterSpacing: '.04em', cursor: connected ? 'pointer' : 'not-allowed',
                boxShadow: connected ? '0 0 22px rgba(191,90,242,.28)' : 'none',
              }}
            >{busy ? 'Working…' : connected ? 'Stake' : 'Connect wallet'}</button>
          </div>

          {msg && (
            <div
              className="mono"
              style={{
                marginTop: 14, padding: 10, borderRadius: 10,
                background: msg.kind === 'ok' ? 'rgba(20,241,149,.08)' : 'rgba(255,80,80,.08)',
                border: msg.kind === 'ok' ? '1px solid rgba(20,241,149,.25)' : '1px solid rgba(255,80,80,.25)',
                fontSize: 11.5, color: msg.kind === 'ok' ? '#b6ffd9' : '#ffb4b4',
              }}
            >{msg.text}</div>
          )}
        </div>

        <div style={{ ...glass(), padding: 24 }}>
          <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 14 }}>
            Your positions
          </div>
          {positions.length === 0 && (
            <div className="mono" style={{ padding: 20, textAlign: 'center', color: 'rgba(255,255,255,.3)', fontSize: 12 }}>
              {connected ? 'No active positions.' : 'Connect a wallet to view your positions.'}
            </div>
          )}
          {positions.map((p) => {
            const unlocked = Number(p.account.lockEnd) <= Math.floor(Date.now() / 1000);
            return (
              <div key={p.publicKey.toBase58()} style={{ borderTop: '1px solid rgba(255,255,255,.05)', padding: '14px 0' }}>
                <div className="position-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 14, fontWeight: 800 }}>
                    {fmtTokens(p.account.amount, stakeDecimals)} POB · {(p.account.multiplierBps / 10_000).toFixed(2)}×
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: unlocked ? C.green : 'rgba(255,255,255,.4)' }}>
                    {timeLeft(p.account.lockEnd)}
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.25)', marginBottom: 8 }}>
                  {p.publicKey.toBase58().slice(0, 10)}…{p.publicKey.toBase58().slice(-6)} · {p.account.lockDays}d lock
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                  {rewardMints.map((rm) => {
                    const key = `${p.publicKey.toBase58()}|${rm.publicKey.toBase58()}`;
                    const ck = checkpoints[key];
                    // Only compute pending once the full snapshot is loaded AND
                    // we have a real checkpoint. Before prime, the user's
                    // baseline doesn't exist on-chain yet — showing a computed
                    // delta against a 0 accPerShare would lie (over-state). The
                    // worker primes missing checkpoints on the next cycle, and
                    // then pending will surface correctly.
                    const hasCheckpoint = ck != null;
                    const pending = snapshotReady && hasCheckpoint
                      ? computePending({
                          accPerShare: rm.account.accPerShare,
                          effective: p.account.effective,
                          checkpointAcc: ck.accPerShare,
                          claimable: ck.claimable,
                        })
                      : null;
                    const rewardDec = rewardDecimals[rm.publicKey.toBase58()] ?? 9;
                    const mintB58 = rm.account.mint.toBase58();
                    const info = tokenInfo[mintB58];
                    const ticker = info?.symbol || info?.name || null;
                    const walletBal = rewardWalletBalances[mintB58];
                    const hasWalletBal = walletBal && !walletBal.isZero();
                    return (
                      <div key={rm.publicKey.toBase58()} style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 10, padding: 12 }}>
                        {ticker && (
                          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '-0.01em', color: 'rgba(255,255,255,.85)', marginBottom: 2 }}>
                            {ticker}
                          </div>
                        )}
                        <div
                          className="mono"
                          title={mintB58}
                          style={{ fontSize: 10, color: 'rgba(255,255,255,.35)', marginBottom: 4 }}
                        >
                          {mintB58.slice(0, 6)}…{mintB58.slice(-4)}
                        </div>
                        <div
                          className="mono"
                          title="Pending rewards accrued since your last checkpoint. The worker usually auto-claims these every ~10 min — see 'In wallet' below."
                          style={{ fontSize: 13, fontWeight: 700, color: C.cyan, marginBottom: 2 }}
                        >
                          {pending ? fmtTokens(pending, rewardDec) : (snapshotReady ? '0.0000' : '…')}
                        </div>
                        <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.4)', marginBottom: 6 }}>
                          pending {pending ? `raw: ${pending.toString()}` : (snapshotReady && !hasCheckpoint ? '(awaiting prime)' : '…')}
                        </div>
                        <div
                          className="mono"
                          title="Your current wallet balance of this reward token. Rewards that the worker has already claim_push'd land here directly — so a high 'In wallet' + 0 'pending' is normal."
                          style={{
                            fontSize: 10.5,
                            color: hasWalletBal ? C.green : 'rgba(255,255,255,.32)',
                            marginBottom: 8,
                            paddingTop: 6,
                            borderTop: '1px solid rgba(255,255,255,.04)',
                          }}
                        >
                          in wallet · {walletBal ? fmtTokens(walletBal, rewardDec) : '—'}
                        </div>
                        <button
                          onClick={() => handleClaim(p, rm)}
                          disabled={busy || !pending || pending.isZero()}
                          style={{
                            width: '100%', padding: '6px 0', borderRadius: 8, border: '1px solid rgba(0,245,255,.3)',
                            background: 'rgba(0,245,255,.08)', color: C.cyan,
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, fontWeight: 800, cursor: busy ? 'not-allowed' : 'pointer',
                          }}
                        >Claim</button>
                      </div>
                    );
                  })}
                  {rewardMints.length === 0 && (
                    <div className="mono" style={{ fontSize: 11, color: 'rgba(255,255,255,.25)' }}>
                      No reward mints registered yet.
                    </div>
                  )}
                </div>

                <div className="position-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => handleCompound(p)}
                    disabled={busy}
                    title={`Claims every pending reward on this position, then restakes your full POB500 wallet balance at ${p.account.lockDays}d (${(p.account.multiplierBps / 10_000).toFixed(2)}×) — same tier as this position. Sell basket rewards & buy POB500 between clicks to maximise compound.`}
                    style={{
                      padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(191,90,242,.45)',
                      background: 'rgba(191,90,242,.12)', color: C.violet,
                      fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: 12, letterSpacing: '.04em',
                      cursor: busy ? 'not-allowed' : 'pointer',
                    }}
                  >Compound</button>
                  {!unlocked && (
                    <button
                      onClick={() => handleUnstakeEarly(p)}
                      disabled={busy}
                      title={`Exit now with a ${(EARLY_UNSTAKE_PENALTY_BPS / 100).toFixed(0)}% penalty on principal. The penalty is redistributed to remaining stakers via the POB reward line.`}
                      style={{
                        padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(255,107,107,.35)',
                        background: 'rgba(255,107,107,.08)', color: C.red,
                        fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: 12, letterSpacing: '.04em',
                        cursor: busy ? 'not-allowed' : 'pointer',
                      }}
                    >Unstake early (−{(EARLY_UNSTAKE_PENALTY_BPS / 100).toFixed(0)}%)</button>
                  )}
                  <button
                    onClick={() => handleUnstake(p)}
                    disabled={!unlocked || busy}
                    style={{
                      padding: '8px 18px', borderRadius: 10, border: '1px solid rgba(255,255,255,.12)',
                      background: unlocked ? 'rgba(20,241,149,.15)' : 'rgba(255,255,255,.04)',
                      color: unlocked ? C.green : 'rgba(255,255,255,.35)',
                      fontFamily: 'Outfit, sans-serif', fontWeight: 700, fontSize: 12, letterSpacing: '.04em',
                      cursor: unlocked && !busy ? 'pointer' : 'not-allowed',
                    }}
                  >{unlocked ? 'Unstake' : 'Locked'}</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...glass({ boxShadow: `0 0 0 1px rgba(191,90,242,.2), 0 8px 40px rgba(0,0,0,.45)` }), padding: 22 }}>
          <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 14 }}>
            How it works
          </div>
          <ul style={{ fontSize: 12.5, lineHeight: 1.7, color: 'rgba(255,255,255,.55)', paddingLeft: 16 }}>
            <li>Lock POB500 for 1–30 days.</li>
            <li>Longer lock ⇒ bigger multiplier (up to 3.00×).</li>
            <li>Treasury deposits creator-fee rewards into the pool as the Printr tokens picked by the POB500 worker.</li>
            <li><strong>Rewards are auto-pushed</strong> to your wallet every ~10 min — pending usually reads <b>0</b> because it already landed. Check <em>in wallet</em> under each token to see what you've received.</li>
            <li><strong style={{ color: C.violet }}>Compound</strong> per position: claims all rewards then restakes your POB500 wallet balance at the <em>same</em> lock tier, preserving your multiplier. Sell rewards & top up POB500 between clicks for max effect.</li>
            <li>Early unstake: <strong>{(EARLY_UNSTAKE_PENALTY_BPS / 100).toFixed(0)}% penalty</strong> on principal, redistributed to remaining stakers. Accrued rewards are always yours.</li>
          </ul>
        </div>
        <div style={{ ...glass(), padding: 22 }}>
          <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 14 }}>
            Diagnostics
          </div>
          <DiagRow label="Program" value={programId?.toBase58?.()} />
          <DiagRow label="Stake mint" value={stakeMint?.toBase58?.()} />
          <DiagRow label="Pool" value={client?.pool?.toBase58?.()} />
          <DiagRow
            label="Token prog"
            value={
              stakeTokenProgram
                ? stakeTokenProgram.equals(TOKEN_2022_PROGRAM_ID)
                  ? 'Token-2022'
                  : 'Legacy SPL'
                : 'detecting…'
            }
          />
        </div>
      </div>
    </div>
  );
}

function DiagRow({ label, value }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mono" style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.32)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.55)', wordBreak: 'break-all' }}>
        {value || '—'}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.22)', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 800, color: accent || '#fff', textShadow: accent ? `0 0 16px ${accent}55` : 'none' }}>{value}</div>
    </div>
  );
}

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
  const [stakeBalance, setStakeBalance] = useState(null);
  const [stakeDecimals, setStakeDecimals] = useState(9);
  const [rewardDecimals, setRewardDecimals] = useState({}); // rewardMintPda -> decimals
  const [rewardTokenPrograms, setRewardTokenPrograms] = useState({}); // rewardMintPda -> PublicKey
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
      setPool(p);
      setPositions(positionList);
      setRewardMints(rewardList);
      const decimalsMap = {};
      const progMap = {};
      for (const rm of rewardList) {
        const progId = await detectTokenProgram(connection, rm.account.mint);
        progMap[rm.publicKey.toBase58()] = progId;
        try {
          const m = await getMint(connection, rm.account.mint, 'confirmed', progId);
          decimalsMap[rm.publicKey.toBase58()] = m.decimals;
        } catch {
          decimalsMap[rm.publicKey.toBase58()] = 9;
        }
      }
      setRewardDecimals(decimalsMap);
      setRewardTokenPrograms(progMap);

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
      for (const { mint, prog } of mintsToResolve) {
        const key = mint.toBase58();
        if (tokenInfoRef.current[key] || infoUpdates[key]) continue; // already cached
        if (!prog || !prog.equals(TOKEN_2022_PROGRAM_ID)) continue;
        try {
          const md = await getTokenMetadata(connection, mint, 'confirmed', prog);
          if (md && (md.symbol || md.name)) {
            infoUpdates[key] = { symbol: md.symbol || null, name: md.name || null };
          }
        } catch (e) {
          // Metadata extension absent or RPC hiccup — not fatal, UI will
          // render the truncated mint instead.
        }
      }
      if (Object.keys(infoUpdates).length > 0) {
        tokenInfoRef.current = { ...tokenInfoRef.current, ...infoUpdates };
        setTokenInfo((prev) => ({ ...prev, ...infoUpdates }));
      }

      const ckMap = {};
      for (const pos of positionList) {
        for (const rm of rewardList) {
          const ck = await client.fetchCheckpoint(pos.publicKey, rm.publicKey);
          if (ck) ckMap[`${pos.publicKey.toBase58()}|${rm.publicKey.toBase58()}`] = ck;
        }
      }
      setCheckpoints(ckMap);

      const mintInfo = await getMint(connection, stakeMint, 'confirmed', stakeTokenProgram);
      setStakeDecimals(mintInfo.decimals);
      const ata = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeTokenProgram);
      try {
        const acc = await getAccount(connection, ata, 'confirmed', stakeTokenProgram);
        setStakeBalance(new BN(acc.amount.toString()));
      } catch {
        setStakeBalance(new BN(0));
      }
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
      const human = Number(amount);
      if (!Number.isFinite(human) || human <= 0) throw new Error('Enter a valid amount');
      const raw = new BN(Math.floor(human * 10 ** stakeDecimals));
      if (stakeBalance && raw.gt(stakeBalance)) throw new Error('Amount exceeds wallet balance');

      const userAta = getAssociatedTokenAddressSync(stakeMint, publicKey, false, stakeTokenProgram);
      const nonce = new BN(Date.now());
      const position = client.positionPda(publicKey, nonce);

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

      // Prime one RewardCheckpoint per existing reward mint in the same tx so
      // the new staker is baselined at the current acc_per_share and can't
      // retroactively claim deposits made before they joined. If we overflow
      // the 1232-byte packet budget we split into multiple txs, signed at
      // once via signAllTransactions.
      const primeIxs = await client.buildPrimeCheckpointIxs({
        owner: publicKey,
        position,
        rewardMints,
      });

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

      const allIxs = [...stakeIxs, ...primeIxs];
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
      setMsg({ kind: 'ok', text: `Staked · ${sig.slice(0, 8)}…` });
      setAmount('');
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }, [client, publicKey, anchorWallet, amount, lockDays, stakeBalance, stakeDecimals, stakeMint, stakeTokenProgram, connection, refresh, rewardMints]);

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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 14, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ ...glass(), padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
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
                      const human = Number(stakeBalance.toString()) / 10 ** stakeDecimals;
                      setAmount((human * (p / 100)).toString());
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

          <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
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
                    const pending = computePending({
                      accPerShare: rm.account.accPerShare,
                      effective: p.account.effective,
                      checkpointAcc: ck?.accPerShare || 0,
                      claimable: ck?.claimable || 0,
                    });
                    const rewardDec = rewardDecimals[rm.publicKey.toBase58()] ?? 9;
                    const mintB58 = rm.account.mint.toBase58();
                    const info = tokenInfo[mintB58];
                    const ticker = info?.symbol || info?.name || null;
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
                        <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: C.cyan, marginBottom: 2 }}>
                          {fmtTokens(pending, rewardDec)}
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', marginBottom: 8 }}>
                          raw: {pending.toString()}
                        </div>
                        <button
                          onClick={() => handleClaim(p, rm)}
                          disabled={busy || pending.isZero()}
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

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
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
            <li>You claim each reward mint independently; tokens never leave custody of the pool PDA until you claim.</li>
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

import { useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
} from '@solana/spl-token';
import BN from 'bn.js';

import {
  StakeClient,
  computePending,
  detectMintTokenProgram,
  getStakeProgram,
  makeProvider,
} from '../../staking-sdk/src/client.js';

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

function debugStatusUrl() {
  return import.meta.env.VITE_REWARD_DEBUG_JSON || '/reward-debug.json';
}

function parsePk(value, fallback = null) {
  if (!value) return fallback;
  try {
    return new PublicKey(value);
  } catch {
    return fallback;
  }
}

function readOnlyWallet() {
  return {
    publicKey: PublicKey.default,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
}

function fmtAmount(raw, decimals = 9, maxFrac = 4) {
  if (raw == null) return '—';
  const bn = BN.isBN(raw) ? raw : new BN(String(raw));
  const s = bn.toString();
  if (s === '0') return '0';
  const d = decimals ?? 9;
  const padded = s.padStart(d + 1, '0');
  const whole = padded.slice(0, -d) || '0';
  const frac = padded.slice(-d).replace(/0+$/, '').slice(0, maxFrac);
  const wholeFmt = Number(whole).toLocaleString();
  return frac ? `${wholeFmt}.${frac}` : wholeFmt;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString();
}

function short(pk) {
  const s = String(pk || '');
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function Stat({ label, value, color = 'rgba(255,255,255,.82)' }) {
  return (
    <div style={glass({ padding: 16 })}>
      <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.28)', textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function StatusPill({ children, tone = 'neutral' }) {
  const color = tone === 'good' ? C.green : tone === 'warn' ? C.yellow : tone === 'bad' ? C.red : C.cyan;
  return (
    <span className="mono" style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: '.06em',
      color,
      padding: '5px 9px',
      borderRadius: 999,
      background: `${color}12`,
      border: `1px solid ${color}38`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
      {children}
    </span>
  );
}

function explainWallet(report, status) {
  if (!report) return null;
  if (report.activePositions === 0) {
    return {
      tone: 'warn',
      text: 'No active staking positions were found for this wallet.',
    };
  }
  if (report.missingCheckpoints > 0) {
    return {
      tone: 'warn',
      text: `${report.missingCheckpoints} reward checkpoint(s) are missing. The worker should prime these before the next deposit so future rewards accrue normally.`,
    };
  }
  const hasPending = report.rewards.some((r) => !new BN(r.pendingRaw || '0').isZero());
  if (hasPending) {
    return {
      tone: 'good',
      text: 'This wallet has pending rewards waiting to be pushed or claimed.',
    };
  }
  if (status?.spend?.skipped === 'below_min_spend') {
    return {
      tone: 'warn',
      text: 'Your staking setup is healthy, but new reward buys are currently paused globally because the Bank treasury is below reserve.',
    };
  }
  return {
    tone: 'good',
    text: 'Your staking setup is healthy. Pending is 0 because currently available rewards have already been pushed into your token accounts.',
  };
}

export default function RewardDebugView() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [walletText, setWalletText] = useState(publicKey?.toBase58() || '');
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);

  const programId = useMemo(() => parsePk(import.meta.env.VITE_POB_STAKE_PROGRAM_ID), []);
  const stakeMint = useMemo(() => parsePk(import.meta.env.VITE_POB_STAKE_MINT), []);

  useEffect(() => {
    if (publicKey && !walletText) setWalletText(publicKey.toBase58());
  }, [publicKey, walletText]);

  useEffect(() => {
    let cancelled = false;
    async function loadStatus() {
      try {
        const res = await fetch(debugStatusUrl(), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!cancelled) {
          setStatus(j);
          setStatusErr(null);
        }
      } catch (e) {
        if (!cancelled) setStatusErr(e.message || 'status unavailable');
      }
    }
    loadStatus();
    const id = setInterval(loadStatus, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function inspectWallet() {
    setErr(null);
    setReport(null);
    const owner = parsePk(walletText?.trim());
    if (!owner) {
      setErr('Enter a valid Solana wallet address.');
      return;
    }
    if (!programId || !stakeMint) {
      setErr('Staking is not configured for this deployment.');
      return;
    }

    setLoading(true);
    try {
      const stakeTokenProgram = await detectMintTokenProgram(connection, stakeMint);
      const provider = makeProvider(connection, readOnlyWallet());
      const program = getStakeProgram(provider, programId);
      const client = new StakeClient({ program, programId, stakeMint, stakeTokenProgram });

      const [pool, positions, rewardMints] = await Promise.all([
        client.fetchPool(),
        client.fetchAllPositionsByOwner(owner),
        client.fetchAllRewardMints(),
      ]);

      if (!pool) throw new Error('Staking pool not found.');

      let walletEffective = new BN(0);
      let walletAmount = new BN(0);
      for (const pos of positions) {
        walletEffective = walletEffective.add(new BN(pos.account.effective.toString()));
        walletAmount = walletAmount.add(new BN(pos.account.amount.toString()));
      }
      const totalEffective = new BN(pool.totalEffective.toString());
      const poolSharePct = totalEffective.isZero()
        ? 0
        : Number(walletEffective.muln(1_000_000).div(totalEffective).toString()) / 10_000;

      const rewards = [];
      let missingCheckpoints = 0;

      for (const rm of rewardMints) {
        const mint = rm.account.mint;
        const tokenProgram = await detectMintTokenProgram(connection, mint);
        let decimals = 9;
        let symbol = short(mint.toBase58());
        try {
          const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgram);
          decimals = mintInfo.decimals;
        } catch {
          decimals = 9;
        }
        if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
          try {
            const md = await getTokenMetadata(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
            if (md?.symbol) symbol = md.symbol;
          } catch {
            // Fall back to shortened mint.
          }
        }

        let pending = new BN(0);
        let missingForMint = 0;
        for (const pos of positions) {
          const ck = await client.fetchCheckpoint(pos.publicKey, rm.publicKey);
          if (!ck) {
            missingForMint += 1;
            continue;
          }
          pending = pending.add(computePending({
            accPerShare: rm.account.accPerShare,
            effective: pos.account.effective,
            checkpointAcc: ck.accPerShare,
            claimable: ck.claimable,
          }));
        }
        missingCheckpoints += missingForMint;

        const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
        let walletBal = new BN(0);
        let lastActivity = null;
        try {
          const acc = await getAccount(connection, ata, 'confirmed', tokenProgram);
          walletBal = new BN(acc.amount.toString());
        } catch {
          walletBal = new BN(0);
        }
        try {
          const sigs = await connection.getSignaturesForAddress(ata, { limit: 1 }, 'confirmed');
          lastActivity = sigs?.[0]
            ? { signature: sigs[0].signature, blockTime: sigs[0].blockTime, err: sigs[0].err || null }
            : null;
        } catch {
          lastActivity = null;
        }

        if (!pending.isZero() || !walletBal.isZero() || missingForMint > 0) {
          rewards.push({
            symbol,
            mint: mint.toBase58(),
            decimals,
            pendingRaw: pending.toString(),
            pendingFmt: fmtAmount(pending, decimals),
            walletRaw: walletBal.toString(),
            walletFmt: fmtAmount(walletBal, decimals),
            missingCheckpoints: missingForMint,
            lastActivity,
          });
        }
      }

      rewards.sort((a, b) => {
        const ap = new BN(a.pendingRaw || '0');
        const bp = new BN(b.pendingRaw || '0');
        if (!ap.eq(bp)) return bp.cmp(ap);
        return new BN(b.walletRaw || '0').cmp(new BN(a.walletRaw || '0'));
      });

      setReport({
        wallet: owner.toBase58(),
        activePositions: positions.length,
        rewardMintCount: rewardMints.length,
        amountRaw: walletAmount.toString(),
        amountFmt: fmtAmount(walletAmount, 9),
        effectiveRaw: walletEffective.toString(),
        effectiveFmt: fmtAmount(walletEffective, 9),
        poolSharePct,
        missingCheckpoints,
        rewards,
        positions: positions.map((p) => ({
          publicKey: p.publicKey.toBase58(),
          amountFmt: fmtAmount(p.account.amount, 9),
          effectiveFmt: fmtAmount(p.account.effective, 9),
          multiplierBps: Number(p.account.multiplierBps || 0),
        })),
      });
    } catch (e) {
      setErr(e.message || 'Failed to inspect wallet.');
    } finally {
      setLoading(false);
    }
  }

  const walletExplanation = explainWallet(report, status);
  const statusTone = status?.spend?.skipped === 'below_min_spend' || status?.spend?.skipped === 'admin_sol_too_low'
    ? 'warn'
    : status?.worker?.healthy
      ? 'good'
      : 'neutral';

  return (
    <div className="fadeup" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        ...glass({
          padding: 24,
          background: 'linear-gradient(135deg, rgba(0,245,255,.09), rgba(191,90,242,.06))',
          border: '1px solid rgba(0,245,255,.18)',
        }),
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div className="mono" style={{ fontSize: 10.5, color: C.cyan, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 8 }}>
              Reward Debugger
            </div>
            <h2 style={{ fontSize: 28, letterSpacing: '-.02em', marginBottom: 8 }}>Check staking rewards for any wallet.</h2>
            <p style={{ color: 'rgba(255,255,255,.56)', fontSize: 14, lineHeight: 1.65, maxWidth: 760 }}>
              Paste a wallet to see active positions, pool share, pending rewards, tokens already pushed to wallet,
              checkpoint health, and the current global worker status.
            </p>
          </div>
          <StatusPill tone={statusTone}>
            {status?.spend?.skipped ? `SPEND: ${String(status.spend.skipped).toUpperCase()}` : status?.worker?.healthy ? 'WORKER HEALTHY' : 'STATUS LOADING'}
          </StatusPill>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <input
            className="mono"
            value={walletText}
            onChange={(e) => setWalletText(e.target.value)}
            placeholder="Paste Solana wallet address…"
            onKeyDown={(e) => { if (e.key === 'Enter') inspectWallet(); }}
            style={{
              flex: '1 1 420px',
              minWidth: 0,
              background: 'rgba(0,0,0,.22)',
              border: '1px solid rgba(255,255,255,.10)',
              borderRadius: 12,
              color: '#fff',
              padding: '12px 14px',
              outline: 'none',
              fontSize: 12,
            }}
          />
          {publicKey && (
            <button
              onClick={() => setWalletText(publicKey.toBase58())}
              style={{
                background: 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.14)',
                color: '#fff',
                borderRadius: 12,
                padding: '0 14px',
                fontWeight: 800,
                cursor: 'pointer',
                fontFamily: "'Outfit',sans-serif",
              }}
            >
              Use connected
            </button>
          )}
          <button
            onClick={inspectWallet}
            disabled={loading}
            style={{
              background: `linear-gradient(135deg,${C.violet},${C.cyan})`,
              border: '1px solid rgba(255,255,255,.14)',
              color: '#fff',
              borderRadius: 12,
              padding: '0 18px',
              minHeight: 44,
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: '.04em',
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
              fontFamily: "'Outfit',sans-serif",
            }}
          >
            {loading ? 'Checking…' : 'Check wallet'}
          </button>
        </div>

        {(err || statusErr) && (
          <div className="mono" style={{ marginTop: 12, color: err ? '#ffb4b4' : 'rgba(255,255,255,.36)', fontSize: 11.5 }}>
            {err || `Global status unavailable (${statusErr}). Wallet inspection still works.`}
          </div>
        )}
      </div>

      <div className="debug-grid" style={{ display: 'grid', gridTemplateColumns: '1.1fr .9fr', gap: 14 }}>
        <div style={glass({ padding: 18 })}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <div>
              <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.25)', fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 5 }}>
                Wallet Health
              </div>
              <div style={{ fontSize: 16, fontWeight: 800 }}>{report ? short(report.wallet) : 'Run a check'}</div>
            </div>
            {walletExplanation && <StatusPill tone={walletExplanation.tone}>{walletExplanation.tone === 'good' ? 'OK' : 'CHECK'}</StatusPill>}
          </div>
          {walletExplanation ? (
            <div style={{
              padding: 14,
              borderRadius: 12,
              background: `${walletExplanation.tone === 'good' ? C.green : C.yellow}10`,
              border: `1px solid ${walletExplanation.tone === 'good' ? C.green : C.yellow}35`,
              color: 'rgba(255,255,255,.76)',
              fontSize: 13,
              lineHeight: 1.65,
              marginBottom: 14,
            }}>
              {walletExplanation.text}
            </div>
          ) : (
            <div style={{ color: 'rgba(255,255,255,.34)', fontSize: 13, lineHeight: 1.65 }}>
              Enter a wallet address above to generate a reward report.
            </div>
          )}

          {report && (
            <>
              <div className="debug-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 14 }}>
                <Stat label="Active Positions" value={report.activePositions} color={C.cyan} />
                <Stat label="Staked" value={report.amountFmt} />
                <Stat label="Effective" value={report.effectiveFmt} color={C.violet} />
                <Stat label="Pool Share" value={`${report.poolSharePct.toFixed(4)}%`} color={C.green} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {report.positions.map((p) => (
                  <div key={p.publicKey} style={{ padding: 12, borderRadius: 12, background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)' }}>
                    <div className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.36)', marginBottom: 6 }}>{short(p.publicKey)}</div>
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      <span className="mono" style={{ fontSize: 11.5, color: 'rgba(255,255,255,.72)' }}>Stake: {p.amountFmt}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: C.violet }}>Effective: {p.effectiveFmt}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: C.cyan }}>Multiplier: {(p.multiplierBps / 10000).toFixed(2)}x</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={glass({ padding: 18 })}>
          <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.25)', fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 12 }}>
            Global Reward Engine
          </div>
          {status ? (
            <>
              <div style={{ color: 'rgba(255,255,255,.68)', fontSize: 13, lineHeight: 1.65, marginBottom: 14 }}>
                {status.explanation || 'Worker status loaded.'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Stat label="Bank SOL" value={status.wallets?.treasury?.sol?.toFixed?.(3) ?? '—'} color={C.cyan} />
                <Stat label="Reserve" value={status.reserve?.effectiveReserveSol != null ? status.reserve.effectiveReserveSol.toFixed(3) : '—'} color={C.yellow} />
                <Stat label="Brr SOL" value={status.wallets?.authority?.sol?.toFixed?.(3) ?? '—'} color={C.violet} />
                <Stat label="Last Push TXs" value={status.rewardPush?.txsSent ?? 0} color={C.green} />
              </div>
              <div className="mono" style={{ marginTop: 12, fontSize: 10.5, color: 'rgba(255,255,255,.25)' }}>
                Updated {status.updatedAt ? new Date(status.updatedAt).toLocaleString() : '—'}
              </div>
            </>
          ) : (
            <div style={{ color: 'rgba(255,255,255,.34)', fontSize: 13, lineHeight: 1.65 }}>
              Loading global worker status…
            </div>
          )}
        </div>
      </div>

      {report && (
        <div style={glass()}>
          <div style={{ padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,.05)', display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.25)', fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 5 }}>
                Reward Tokens
              </div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                Pending vs already in wallet
              </div>
            </div>
            <StatusPill tone={report.missingCheckpoints === 0 ? 'good' : 'warn'}>
              {report.missingCheckpoints === 0 ? 'CHECKPOINTS OK' : `${report.missingCheckpoints} MISSING`}
            </StatusPill>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div className="mono" style={{ minWidth: 760 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 1.3fr .8fr', gap: 12, padding: '11px 18px', borderBottom: '1px solid rgba(255,255,255,.04)', color: 'rgba(255,255,255,.22)', fontSize: 9.5, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase' }}>
                <div>Token</div>
                <div>Pending</div>
                <div>In Wallet</div>
                <div>Last ATA Activity</div>
                <div>Checkpoint</div>
              </div>
              {report.rewards.length === 0 ? (
                <div style={{ padding: 28, color: 'rgba(255,255,255,.28)', fontSize: 12 }}>
                  No reward balances or pending rewards found yet.
                </div>
              ) : report.rewards.map((r) => (
                <div key={r.mint} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 1.3fr .8fr', gap: 12, padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,.035)', alignItems: 'center', fontSize: 11.5 }}>
                  <div>
                    <div style={{ color: '#fff', fontWeight: 800 }}>{r.symbol}</div>
                    <div style={{ color: 'rgba(255,255,255,.25)', marginTop: 3 }}>{short(r.mint)}</div>
                  </div>
                  <div style={{ color: new BN(r.pendingRaw || '0').isZero() ? 'rgba(255,255,255,.38)' : C.green }}>{r.pendingFmt}</div>
                  <div style={{ color: new BN(r.walletRaw || '0').isZero() ? 'rgba(255,255,255,.38)' : C.cyan }}>{r.walletFmt}</div>
                  <div style={{ color: 'rgba(255,255,255,.45)' }}>{fmtDate(r.lastActivity?.blockTime)}</div>
                  <div style={{ color: r.missingCheckpoints ? C.yellow : C.green }}>{r.missingCheckpoints ? `${r.missingCheckpoints} missing` : 'OK'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

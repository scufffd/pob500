import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAnchorWallet, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import BN from 'bn.js';

import { computePending } from '../../staking-sdk/src/client.js';
import { LOCK_TIERS } from '../../staking-sdk/src/pda.js';
import { useStakingClient } from '../stake/useStakingClient.js';

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

const label = {
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: '.1em',
  color: 'rgba(255,255,255,.25)',
  textTransform: 'uppercase',
};

const mono = { fontFamily: "'JetBrains Mono', monospace" };

/* ------------------------------------------------------------- formatters */

function fmtNumber(n, maxDec = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(maxDec)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(maxDec)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(maxDec)}K`;
  return n.toFixed(maxDec);
}

function fmtRawToUi(rawStr, decimals) {
  if (rawStr == null) return null;
  try {
    const big = BigInt(String(rawStr));
    if (big === 0n) return 0;
    const d = BigInt(10) ** BigInt(decimals || 0);
    const whole = Number(big / d);
    const frac = Number(big % d) / Number(d);
    return whole + frac;
  } catch {
    return null;
  }
}

function ago(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortMint(m) {
  if (!m) return '—';
  return `${m.slice(0, 4)}…${m.slice(-4)}`;
}

/* --------------------------------------------------------- hero stat tile */

export function StatTile({ label: l, value, sub, accent, tooltip }) {
  return (
    <div
      style={{ ...glass(), padding: '18px 22px', flex: 1, minWidth: 0 }}
      title={tooltip || undefined}
    >
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,.28)', marginBottom: 10 }}>
        {l}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 800,
          letterSpacing: '-.03em',
          lineHeight: 1,
          color: accent || '#fff',
          textShadow: accent ? `0 0 24px ${accent}55` : 'none',
          fontFamily: "'Outfit',sans-serif",
        }}
      >
        {value}
      </div>
      {sub != null && (
        <div style={{ ...mono, marginTop: 8, fontSize: 10.5, color: 'rgba(255,255,255,.35)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- HERO STATS ROW */

export function HeroStatsRow({ payload, extras = {} }) {
  const pool = payload?.pool;
  const feesSwept = payload?.feesSwept;
  const feesSwept7d = payload?.feesSwept7d;

  const tvlUi = pool?.initialized
    ? fmtRawToUi(pool.totalStaked, pool.stakeDecimals || 9)
    : null;

  const tvlDisplay = tvlUi != null ? `${fmtNumber(tvlUi, 2)} POB500` : '—';
  const tvlSub = pool?.initialized ? `${pool.rewardMintCount ?? 0} reward mints` : 'pool not live';

  const yield7d = feesSwept7d?.sol ?? null;
  const yield7dDisplay = yield7d != null ? `${yield7d.toFixed(3)} SOL` : '—';
  const yield7dSub = feesSwept7d?.cycles
    ? `${feesSwept7d.cycles} cycle${feesSwept7d.cycles === 1 ? '' : 's'} · last 7d`
    : 'last 7d';

  const sweptTotal = feesSwept?.totalSol ?? null;
  const sweptDisplay = sweptTotal != null
    ? `${sweptTotal < 10 ? sweptTotal.toFixed(3) : fmtNumber(sweptTotal, 2)} SOL`
    : '—';
  const sweptSub = feesSwept?.totalCycles
    ? `${feesSwept.totalCycles} total cycles`
    : 'lifetime';

  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
      <StatTile
        label="TVL (Staked)"
        value={tvlDisplay}
        sub={tvlSub}
        accent={C.cyan}
        tooltip="Total POB500 staked across all positions"
      />
      <StatTile
        label="Yield · 7d"
        value={yield7dDisplay}
        sub={yield7dSub}
        accent={C.green}
        tooltip="SOL swept from creator fees and swapped into basket rewards over the last 7 days"
      />
      <StatTile
        label="Fees Swept"
        value={sweptDisplay}
        sub={sweptSub}
        accent={C.violet}
        tooltip="Running lifetime total of SOL the worker has swept and distributed to stakers"
      />
      <StatTile
        label="Avg POB Score"
        value={extras.avgPob || '—'}
        sub="across watchlist"
        accent={extras.avgPob >= 70 ? C.green : C.yellow}
      />
      <StatTile
        label="Watchlist"
        value={`${extras.rowCount ?? 0}`}
        sub="Printr tokens tracked"
      />
    </div>
  );
}

/* ----------------------------------------------------------- YOUR POSITION */

function fmtTok(rawBn, decimals) {
  try {
    const raw = BN.isBN(rawBn) ? rawBn : new BN(String(rawBn));
    const d = decimals ?? 9;
    const s = raw.toString();
    if (s.length <= d) return `0.${s.padStart(d, '0').slice(0, 4)}`;
    const whole = s.slice(0, s.length - d);
    const frac = s.slice(s.length - d, s.length - d + 4);
    return `${Number(whole).toLocaleString()}${frac ? '.' + frac : ''}`;
  } catch {
    return '—';
  }
}

function tierLabel(days) {
  const match = LOCK_TIERS.find((t) => t.days === days);
  if (!match) return `${days}d`;
  return `${days}d · ${(match.multiplierBps / 10_000).toFixed(2)}×`;
}

export function YourPosition({ onGoStake }) {
  const { publicKey, connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const { client, ready, stakeMint } = useStakingClient();

  const [positions, setPositions] = useState([]);
  const [rewardMints, setRewardMints] = useState([]);
  const [checkpoints, setCheckpoints] = useState({});
  const [rewardMeta, setRewardMeta] = useState({}); // rewardMintPda -> { decimals, symbol }
  const [stakeDecimals, setStakeDecimals] = useState(9);
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!ready || !client || !publicKey) return;
    setLoading(true);
    try {
      const [p, posList, rewardList] = await Promise.all([
        client.fetchPool(),
        client.fetchAllPositionsByOwner(publicKey),
        client.fetchAllRewardMints(),
      ]);
      setPool(p);
      setPositions(posList);
      setRewardMints(rewardList);
      const rm = {};
      for (const r of rewardList) {
        try {
          const info = await getMint(connection, r.account.mint);
          rm[r.publicKey.toBase58()] = { decimals: info.decimals };
        } catch {
          rm[r.publicKey.toBase58()] = { decimals: 9 };
        }
      }
      setRewardMeta(rm);

      const ckMap = {};
      for (const pos of posList) {
        for (const r of rewardList) {
          const ck = await client.fetchCheckpoint(pos.publicKey, r.publicKey);
          if (ck) ckMap[`${pos.publicKey.toBase58()}|${r.publicKey.toBase58()}`] = ck;
        }
      }
      setCheckpoints(ckMap);

      try {
        const info = await getMint(connection, stakeMint);
        setStakeDecimals(info.decimals);
      } catch {}
    } finally {
      setLoading(false);
    }
  }, [ready, client, publicKey, connection, stakeMint]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 45_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!connected) return null;
  // Staking not configured in this environment — hide the panel.
  if (!ready && !loading) return null;

  const hasStake = positions.length > 0;

  // Totals
  const totalStakedRaw = positions.reduce((s, pos) => s.add(pos.account.amount || new BN(0)), new BN(0));
  const totalEffectiveRaw = positions.reduce((s, pos) => s.add(pos.account.effective || new BN(0)), new BN(0));

  // Pool share %
  let sharePct = null;
  if (pool && pool.totalEffective && !pool.totalEffective.isZero()) {
    const nums = totalEffectiveRaw.mul(new BN(10_000)).div(pool.totalEffective);
    sharePct = nums.toNumber() / 100;
  }

  // Pending rewards aggregated across positions × reward mints.
  const pendingByMint = {}; // mintPda -> { amount (BN), mint: string }
  for (const pos of positions) {
    for (const rm of rewardMints) {
      const ck = checkpoints[`${pos.publicKey.toBase58()}|${rm.publicKey.toBase58()}`];
      const pending = computePending({
        accPerShare: rm.account.accPerShare,
        effective: pos.account.effective,
        checkpointAcc: ck?.accPerShare || 0,
        claimable: ck?.claimable || 0,
      });
      if (pending.isZero()) continue;
      const key = rm.publicKey.toBase58();
      if (!pendingByMint[key]) pendingByMint[key] = { amount: new BN(0), mint: rm.account.mint.toBase58() };
      pendingByMint[key].amount = pendingByMint[key].amount.add(pending);
    }
  }
  const pendingRows = Object.entries(pendingByMint).map(([pda, v]) => ({
    rewardMintPda: pda,
    mint: v.mint,
    amount: v.amount,
    decimals: rewardMeta[pda]?.decimals ?? 9,
  }));

  if (!hasStake) {
    return (
      <div style={{ ...glass(), padding: '18px 22px', marginBottom: 22, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={label}>Your Position</div>
          <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6 }}>
            Connected — no active stake yet.
          </div>
          <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.48)', marginTop: 4, lineHeight: 1.55 }}>
            Lock POB500 for 1–30 days to earn rebased creator fees in basket tokens.
          </div>
        </div>
        <button
          onClick={onGoStake}
          style={{
            background: `linear-gradient(135deg,${C.violet},${C.cyan})`,
            border: 'none',
            color: '#fff',
            borderRadius: 10,
            padding: '10px 20px',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '.04em',
            cursor: 'pointer',
            fontFamily: "'Outfit',sans-serif",
            boxShadow: `0 6px 26px ${C.violet}40`,
          }}
        >
          Stake POB500 →
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...glass({ boxShadow: `0 0 0 1px ${C.cyan}14, 0 8px 40px rgba(0,0,0,.45)` }), padding: '18px 22px', marginBottom: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <div style={label}>Your Position</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 6 }}>
            {fmtTok(totalStakedRaw, stakeDecimals)} POB500{' '}
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,.38)', fontWeight: 600 }}>
              staked across {positions.length} position{positions.length === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,.38)', marginTop: 6 }}>
            Effective {fmtTok(totalEffectiveRaw, stakeDecimals)} ·{' '}
            {sharePct != null ? `${sharePct.toFixed(3)}% of pool` : 'first staker'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={onGoStake}
            style={{
              background: 'rgba(0,245,255,.08)',
              border: '1px solid rgba(0,245,255,.38)',
              color: C.cyan,
              borderRadius: 10,
              padding: '9px 16px',
              fontSize: 11.5,
              fontWeight: 800,
              letterSpacing: '.04em',
              cursor: 'pointer',
              fontFamily: "'Outfit',sans-serif",
            }}
          >
            Manage · Claim →
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16, marginTop: 16 }}>
        <div>
          <div style={{ ...label, marginBottom: 8 }}>Positions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {positions.slice(0, 5).map((pos) => {
              const secsLeft = Number(pos.account.lockEnd) - Math.floor(Date.now() / 1000);
              const unlocked = secsLeft <= 0;
              return (
                <div
                  key={pos.publicKey.toBase58()}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 10px',
                    background: 'rgba(255,255,255,.025)',
                    border: '1px solid rgba(255,255,255,.05)',
                    borderRadius: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {fmtTok(pos.account.amount, stakeDecimals)} POB500
                    </div>
                    <div style={{ ...mono, fontSize: 10, color: 'rgba(255,255,255,.38)', marginTop: 2 }}>
                      {tierLabel(Number(pos.account.lockDays))}
                    </div>
                  </div>
                  <div style={{ ...mono, fontSize: 11, fontWeight: 700, color: unlocked ? C.green : C.cyan }}>
                    {unlocked
                      ? 'Unlocked'
                      : (() => {
                        const d = Math.floor(secsLeft / 86400);
                        const h = Math.floor((secsLeft % 86400) / 3600);
                        return d > 0 ? `${d}d ${h}h` : `${h}h`;
                      })()}
                  </div>
                </div>
              );
            })}
            {positions.length > 5 && (
              <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.28)', marginTop: 4 }}>
                +{positions.length - 5} more · manage in Stake tab
              </div>
            )}
          </div>
        </div>

        <div>
          <div style={{ ...label, marginBottom: 8 }}>Pending rewards</div>
          {pendingRows.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.38)', padding: '6px 0' }}>
              No rewards accrued yet. New deposits from creator fees will show up here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {pendingRows.slice(0, 6).map((r) => (
                <div
                  key={r.rewardMintPda}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 10px',
                    background: `${C.green}08`,
                    border: `1px solid ${C.green}22`,
                    borderRadius: 8,
                  }}
                >
                  <span style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,.58)' }}>
                    {shortMint(r.mint)}
                  </span>
                  <span style={{ ...mono, fontSize: 11.5, fontWeight: 800, color: C.green }}>
                    {fmtTok(r.amount, r.decimals)}
                  </span>
                </div>
              ))}
              {pendingRows.length > 6 && (
                <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.28)', marginTop: 4 }}>
                  +{pendingRows.length - 6} more mints accruing
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------- TOKEN DETAIL DRAWER */

export function TokenDrawer({ token, recentSwaps }) {
  if (!token) return null;
  const mint = token.mint || token.id;
  const swaps = (recentSwaps && recentSwaps[mint]) || [];

  const links = [
    { label: 'Solscan', href: `https://solscan.io/token/${mint}` },
    { label: 'DexScreener', href: `https://dexscreener.com/solana/${mint}` },
    { label: 'Printr', href: `https://app.printr.money/token/${mint}` },
  ];

  return (
    <div className="fadeup" style={{ padding: '18px 22px', background: 'rgba(0,245,255,.025)', borderTop: '1px solid rgba(0,245,255,.07)', borderBottom: '1px solid rgba(0,245,255,.07)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 22, alignItems: 'flex-start' }}>
        <div>
          <div style={{ ...label, marginBottom: 7 }}>Description</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,.55)', lineHeight: 1.65 }}>
            {token.desc || '—'}
          </div>
          <div style={{ ...mono, marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,.25)' }}>
            Mint · {mint}
          </div>

          <div style={{ display: 'flex', gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
            {[
              ['24h Vol', token.vol24h != null ? fmtNumber(token.vol24h, 2) : '—', null],
              ['Mcap', token.mcapFmt || '—', null],
              ['Staked %', token.stakedPct != null ? `${token.stakedPct}%` : '—', C.cyan],
              ['POB Score', String(token.pobScore ?? '—'), C.violet],
            ].map(([l, v, a]) => (
              <div key={l}>
                <div style={{ ...label, marginBottom: 6 }}>{l}</div>
                <div style={{ ...mono, fontSize: 18, fontWeight: 800, color: a || '#fff', textShadow: a ? `0 0 16px ${a}55` : 'none' }}>
                  {v}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  background: 'rgba(255,255,255,.04)',
                  border: '1px solid rgba(255,255,255,.12)',
                  color: '#fff',
                  borderRadius: 8,
                  padding: '6px 12px',
                  fontSize: 11.5,
                  fontWeight: 700,
                  textDecoration: 'none',
                  letterSpacing: '.03em',
                }}
              >
                {l.label} ↗
              </a>
            ))}
            <a
              href={`https://app.printr.money/token/${mint}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: `linear-gradient(135deg,${C.violet},${C.cyan})`,
                color: '#fff',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 11.5,
                fontWeight: 800,
                textDecoration: 'none',
                letterSpacing: '.04em',
                boxShadow: `0 4px 18px ${C.violet}38`,
                border: '1px solid rgba(255,255,255,.08)',
              }}
            >
              Trade {token.symbol || token.name} →
            </a>
          </div>
        </div>

        <div>
          <div style={{ ...label, marginBottom: 7 }}>
            Bought for stakers · last {swaps.length || 0} cycle{swaps.length === 1 ? '' : 's'}
          </div>
          {swaps.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.38)', lineHeight: 1.6 }}>
              Not yet purchased by the worker — either new to the basket or waiting for the next
              rebalance.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 230, overflowY: 'auto', paddingRight: 4 }}>
              {swaps.map((s, i) => (
                <div
                  key={`${s.ts}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: 10,
                    alignItems: 'center',
                    padding: '7px 10px',
                    background: 'rgba(255,255,255,.02)',
                    border: '1px solid rgba(255,255,255,.05)',
                    borderRadius: 8,
                  }}
                >
                  <span style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.4)' }}>
                    {ago(s.ts)} · v{s.basketVersion ?? '—'}
                  </span>
                  <span style={{ ...mono, fontSize: 11, color: C.cyan, fontWeight: 700 }}>
                    {(s.sol || 0).toFixed(4)} SOL
                  </span>
                  {s.depositSignature ? (
                    <a
                      href={`https://solscan.io/tx/${s.depositSignature}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ ...mono, fontSize: 10.5, color: C.violet, textDecoration: 'none' }}
                      title={s.depositSignature}
                    >
                      tx ↗
                    </a>
                  ) : (
                    <span style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.2)' }}>—</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- BASKET HISTORY */

export function BasketHistory({ history }) {
  const list = Array.isArray(history) ? history : [];
  const [open, setOpen] = useState(null);
  // Default to newest version once history arrives.
  useEffect(() => {
    if (open == null && list.length > 0) setOpen(list[0].version);
  }, [list, open]);
  if (list.length === 0) return null;
  const sel = list.find((h) => h.version === open) || list[0];

  return (
    <div style={{ ...glass(), marginTop: 22, padding: '20px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.01em' }}>Basket history</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,.4)', marginTop: 3 }}>
            Every rebalance the worker has executed, and what it paid stakers.
          </div>
        </div>
        <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.3)' }}>
          {list.length} rebalance{list.length === 1 ? '' : 's'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 360, overflowY: 'auto' }}>
          {list.map((h) => {
            const active = h.version === sel.version;
            return (
              <button
                key={h.version}
                onClick={() => setOpen(h.version)}
                style={{
                  textAlign: 'left',
                  background: active ? 'rgba(0,245,255,.06)' : 'rgba(255,255,255,.02)',
                  border: `1px solid ${active ? 'rgba(0,245,255,.35)' : 'rgba(255,255,255,.06)'}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                  cursor: 'pointer',
                  color: 'inherit',
                  fontFamily: "'Outfit',sans-serif",
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 800 }}>v{h.version}</span>
                  <span style={{ ...mono, fontSize: 10, color: active ? C.cyan : 'rgba(255,255,255,.35)' }}>
                    {ago(h.createdAt)}
                  </span>
                </div>
                <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.45)', marginTop: 4, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{h.entries?.length || 0} tokens</span>
                  <span style={{ color: (h.paidOut?.sol || 0) > 0 ? C.green : 'rgba(255,255,255,.25)' }}>
                    {(h.paidOut?.sol || 0).toFixed(3)} SOL
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ ...glass({ boxShadow: 'none' }), padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800 }}>Basket v{sel.version}</div>
              <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.35)', marginTop: 3 }}>
                Created {new Date(sel.createdAt).toLocaleString()} · {ago(sel.createdAt)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...label }}>SOL swept</div>
                <div style={{ ...mono, fontSize: 16, fontWeight: 800, color: C.green }}>
                  {(sel.paidOut?.sol || 0).toFixed(4)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...label }}>Cycles</div>
                <div style={{ ...mono, fontSize: 16, fontWeight: 800, color: C.cyan }}>
                  {sel.paidOut?.cycles ?? 0}
                </div>
              </div>
            </div>
          </div>

          <div style={{ ...label, marginBottom: 8 }}>Composition</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {(sel.entries || []).map((e) => {
              const paid = (sel.paidOut?.perMint || []).find((p) => p.mint === e.mint);
              const w = ((e.weight || 0) * 100).toFixed(1);
              return (
                <div
                  key={e.mint}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '22px 1fr 70px 80px',
                    gap: 10,
                    alignItems: 'center',
                    padding: '6px 8px',
                    background: 'rgba(255,255,255,.02)',
                    borderRadius: 7,
                  }}
                >
                  <div style={{ width: 22, height: 22, borderRadius: 6, background: `${C.cyan}14`, border: `1px solid ${C.cyan}38`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ ...mono, fontSize: 9, fontWeight: 800, color: C.cyan }}>
                      {(e.symbol || e.name || '?').slice(0, 2)}
                    </span>
                  </div>
                  <div>
                    <span style={{ fontSize: 12.5, fontWeight: 700 }}>{e.symbol || e.name}</span>
                    {e.pinned && (
                      <span style={{ ...mono, marginLeft: 6, fontSize: 8.5, padding: '1px 5px', borderRadius: 4, background: `${C.violet}22`, color: C.violet, border: `1px solid ${C.violet}40` }}>
                        PIN
                      </span>
                    )}
                  </div>
                  <span style={{ ...mono, fontSize: 11, color: 'rgba(255,255,255,.5)' }}>{w}%</span>
                  <span style={{ ...mono, fontSize: 11, color: paid ? C.green : 'rgba(255,255,255,.2)', textAlign: 'right' }}>
                    {paid ? `${paid.sol.toFixed(4)} SOL` : '—'}
                  </span>
                </div>
              );
            })}
          </div>

          {(sel.newcomers?.length > 0 || sel.dropped?.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ ...label, marginBottom: 5, color: `${C.green}C0` }}>New in</div>
                <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.55)', lineHeight: 1.55 }}>
                  {sel.newcomers?.length ? sel.newcomers.map(shortMint).join(', ') : '—'}
                </div>
              </div>
              <div>
                <div style={{ ...label, marginBottom: 5, color: `${C.red}B0` }}>Rolled off</div>
                <div style={{ ...mono, fontSize: 10.5, color: 'rgba(255,255,255,.55)', lineHeight: 1.55 }}>
                  {sel.dropped?.length ? sel.dropped.map(shortMint).join(', ') : '—'}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

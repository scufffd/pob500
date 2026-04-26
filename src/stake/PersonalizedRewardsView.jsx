import { useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

const C = {
  cyan: '#00F5FF',
  violet: '#BF5AF2',
  green: '#14F195',
  yellow: '#FFD60A',
  red: '#FF6B6B',
};

const glass = (extra = {}) => ({
  background: 'rgba(255,255,255,0.035)',
  backdropFilter: 'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 16,
  boxShadow: '0 8px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.05)',
  ...extra,
});

const SOL_MINT = 'So11111111111111111111111111111111111111112';

function apiBase() {
  return import.meta.env.VITE_POBINDEX_API_BASE || '';
}

function shortMint(value) {
  if (!value) return '—';
  return value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function shortSig(value) {
  if (!value) return '—';
  return value.length <= 10 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function fmtSol(lamports) {
  if (lamports == null) return '—';
  const n = Number(lamports) / 1e9;
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(6)} SOL`;
}

function fmtTokens(amount, decimals) {
  if (amount == null) return '—';
  const n = typeof amount === 'number' ? amount : Number(amount) / Math.pow(10, decimals || 0);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(4);
}

export default function PersonalizedRewardsView() {
  const { publicKey, connected } = useWallet();
  const wallet = publicKey ? publicKey.toBase58() : null;
  const [pref, setPref] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [loadErr, setLoadErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet) {
        setPref(null);
        setPayouts([]);
        setLoadErr(null);
        return;
      }
      setLoading(true);
      try {
        const base = apiBase();
        const [prefRes, payoutsRes] = await Promise.all([
          fetch(`${base}/api/reward-pref/${wallet}`).then((r) => r.json()),
          fetch(`${base}/api/reward-pref/${wallet}/payouts?limit=200`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        setPref(prefRes);
        setPayouts(Array.isArray(payoutsRes?.payouts) ? payoutsRes.payouts : []);
        setLoadErr(null);
      } catch (e) {
        if (!cancelled) setLoadErr(e.message || 'Failed to load personalized rewards');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wallet]);

  const totals = useMemo(() => {
    const byMint = new Map();
    let totalLamports = 0;
    for (const row of payouts) {
      const mint = row.mint;
      if (!byMint.has(mint)) {
        byMint.set(mint, {
          mint,
          symbol: row.symbol,
          decimals: row.decimals,
          tokenAmountUi: 0,
          lamportsSpent: 0,
        });
      }
      const rec = byMint.get(mint);
      const amt = Number(row.tokenAmountUi || 0);
      rec.tokenAmountUi += Number.isFinite(amt) ? amt : 0;
      const lam = Number(row.lamportsSpent || row.lamports || 0);
      rec.lamportsSpent += Number.isFinite(lam) ? lam : 0;
      totalLamports += Number(row.lamportsSpent || row.lamports || 0);
    }
    return {
      totalLamports,
      perMint: Array.from(byMint.values()).sort((a, b) => b.lamportsSpent - a.lamportsSpent),
    };
  }, [payouts]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...glass(), padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div>
            <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 6 }}>
              Personalized rewards
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' }}>
              Cycle-by-cycle airdrops to your wallet
            </div>
            <div className="mono" style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,.45)', maxWidth: 620, lineHeight: 1.55 }}>
              When you opt into custom rewards, each spend cycle takes your share of the cycle pot, swaps SOL into your chosen tokens, and sends them to your wallet directly.
              They never enter the pool.
            </div>
          </div>
          {!connected && <WalletMultiButton />}
        </div>

        {!connected && (
          <div className="mono" style={{ padding: 14, color: 'rgba(255,255,255,.5)', textAlign: 'center', fontSize: 12 }}>
            Connect a wallet to view its personalized payout history.
          </div>
        )}

        {connected && (
          <>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
              <Stat label="Mode" value={pref?.mode === 'custom' ? 'Custom' : 'Auto basket'} accent={pref?.mode === 'custom' ? C.violet : C.cyan} />
              <Stat label="Allocations" value={pref?.allocations?.length ?? 0} accent={C.green} />
              <Stat label="Cycles paid" value={payouts.length} />
              <Stat label="Total spent" value={fmtSol(totals.totalLamports)} accent={C.cyan} />
              <Stat label="Updated" value={pref?.updatedAt ? new Date(pref.updatedAt).toLocaleString() : '—'} small />
            </div>

            {pref?.lastFailure && (
              <div className="mono" style={{ marginBottom: 14, padding: 10, borderRadius: 10, background: 'rgba(255,171,74,.08)', border: '1px solid rgba(255,171,74,.25)', fontSize: 11.5, color: '#ffe1b8' }}>
                Auto-reverted on {new Date(pref.lastFailure.revertedAt).toLocaleString()} — token <code>{shortMint(pref.lastFailure.mint)}</code> failed re-validation ({pref.lastFailure.reason}).
              </div>
            )}

            {totals.perMint.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
                <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', letterSpacing: '.08em', textTransform: 'uppercase' }}>By token</div>
                {totals.perMint.map((row) => (
                  <div key={row.mint} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: 10, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.05)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{row.symbol || shortMint(row.mint)}</div>
                      <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.4)' }}>{shortMint(row.mint)}</div>
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: 'rgba(255,255,255,.7)' }}>
                      {row.mint === SOL_MINT
                        ? `${(row.lamportsSpent / 1e9).toFixed(6)} SOL`
                        : `${fmtTokens(row.tokenAmountUi, 0)} ${row.symbol || ''}`}
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: C.cyan }}>
                      spent {fmtSol(row.lamportsSpent)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.45)', letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>Cycle history</div>
            {loading && payouts.length === 0 && (
              <div className="mono" style={{ padding: 14, color: 'rgba(255,255,255,.4)', fontSize: 12 }}>Loading…</div>
            )}
            {!loading && payouts.length === 0 && (
              <div className="mono" style={{ padding: 14, color: 'rgba(255,255,255,.4)', fontSize: 12 }}>
                No personalized payouts yet. Save a custom preference and Faith will airdrop them here every cycle.
              </div>
            )}
            {payouts.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {payouts.map((row, i) => (
                  <div key={`${row.signature || i}_${row.cycleStartedAt || ''}`} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 110px', gap: 12, padding: 10, borderRadius: 10, background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.05)', alignItems: 'center' }}>
                    <span className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.5)' }}>
                      {row.postedAt ? new Date(row.postedAt).toLocaleString() : '—'}
                    </span>
                    <div>
                      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{row.symbol || shortMint(row.mint)}</div>
                      <div className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.35)' }}>{shortMint(row.mint)}</div>
                    </div>
                    <div className="mono" style={{ fontSize: 11.5, color: C.cyan, textAlign: 'right' }}>
                      {row.mint === SOL_MINT
                        ? fmtSol(row.lamports)
                        : `${fmtTokens(row.tokenAmountUi, 0)} ${row.symbol || ''}`}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, textAlign: 'right' }}>
                      {row.signature ? (
                        <a href={`https://solscan.io/tx/${row.signature}`} target="_blank" rel="noreferrer" style={{ color: C.violet, textDecoration: 'none' }}>
                          {shortSig(row.signature)}
                        </a>
                      ) : <span style={{ color: 'rgba(255,255,255,.3)' }}>{row.dryRun ? 'dry-run' : '—'}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {loadErr && (
              <div className="mono" style={{ marginTop: 12, padding: 10, borderRadius: 10, background: 'rgba(255,80,80,.08)', border: '1px solid rgba(255,80,80,.28)', color: '#ffb4b4', fontSize: 11.5 }}>
                {loadErr}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent, small = false }) {
  return (
    <div style={{ minWidth: 140 }}>
      <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.22)', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div className="mono" style={{ fontSize: small ? 11.5 : 16, fontWeight: 800, color: accent || '#fff', textShadow: accent ? `0 0 16px ${accent}55` : 'none' }}>{value}</div>
    </div>
  );
}

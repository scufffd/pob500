import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';

const C = {
  cyan: '#00F5FF',
  violet: '#BF5AF2',
  green: '#14F195',
  yellow: '#FFD60A',
  red: '#FF6B6B',
  amber: '#FFAB4A',
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
const STAKE_MINT = import.meta.env.VITE_POB_STAKE_MINT || '';
const COMPOUND_LOCK_TIERS = [
  { days: 1, multiplier: '1.00×' },
  { days: 3, multiplier: '1.25×' },
  { days: 7, multiplier: '1.50×' },
  { days: 14, multiplier: '2.00×' },
  { days: 21, multiplier: '2.50×' },
  { days: 30, multiplier: '3.00×' },
];

function apiBase() {
  return import.meta.env.VITE_POBINDEX_API_BASE || '';
}

async function api(pathname, init = {}) {
  const base = apiBase();
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (!res.ok) {
    const e = new Error(json?.message || res.statusText);
    e.code = json?.error || `http_${res.status}`;
    e.detail = json?.detail || null;
    throw e;
  }
  return json;
}

function shortMint(value) {
  if (!value) return '—';
  return value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function fmtUsd(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function makeAlloc(mint = '', pct = 100) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mint,
    pct,
    state: 'idle', // idle | validating | ok | error
    info: null, // populated after a successful validate call
    error: null,
  };
}

function balanceWeights(allocations) {
  const filled = allocations.filter((a) => a.mint && a.state === 'ok');
  if (filled.length === 0) return allocations;
  const evenly = Math.floor(100 / filled.length);
  let remainder = 100 - evenly * filled.length;
  return allocations.map((a) => {
    if (a.state !== 'ok') return a;
    const extra = remainder > 0 ? 1 : 0;
    if (extra) remainder -= 1;
    return { ...a, pct: evenly + extra };
  });
}

export default function RewardPrefsView() {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey ? publicKey.toBase58() : null;

  const [mode, setMode] = useState('auto');
  const [allocations, setAllocations] = useState([makeAlloc()]);
  const [compound, setCompound] = useState({ enabled: false, lockDays: 7 });
  const [pref, setPref] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Load existing preference whenever the wallet or refreshKey changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet) {
        setPref(null);
        setMode('auto');
        setAllocations([makeAlloc()]);
        return;
      }
      try {
        const next = await api(`/api/reward-pref/${wallet}`);
        if (cancelled) return;
        setPref(next);
        setMode(next.mode || 'auto');
        if (next.compound && typeof next.compound === 'object') {
          setCompound({
            enabled: !!next.compound.enabled,
            lockDays: Number(next.compound.lockDays) || 7,
          });
        } else {
          setCompound({ enabled: false, lockDays: 7 });
        }
        if (next.mode === 'custom' && Array.isArray(next.allocations) && next.allocations.length > 0) {
          setAllocations(next.allocations.map((a) => ({
            id: `${a.mint}_${Math.random().toString(36).slice(2, 8)}`,
            mint: a.mint,
            pct: a.pct,
            state: 'ok',
            info: {
              symbol: a.symbol,
              name: a.name,
              decimals: a.decimals,
              tokenProgram: a.tokenProgram,
              isStakeMint: STAKE_MINT && a.mint === STAKE_MINT,
            },
            error: null,
          })));
        } else {
          setAllocations([makeAlloc()]);
        }
      } catch (e) {
        if (!cancelled) setMsg({ kind: 'err', text: `Could not load prefs: ${e.message}` });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [wallet, refreshKey]);

  const totalPct = useMemo(
    () => allocations.reduce((s, a) => s + (Number.isFinite(a.pct) ? Number(a.pct) : 0), 0),
    [allocations],
  );

  const hasStakeAlloc = useMemo(
    () => STAKE_MINT && allocations.some((a) => a.mint === STAKE_MINT),
    [allocations],
  );

  const customReady = useMemo(() => (
    mode === 'custom'
    && allocations.length > 0
    && allocations.every((a) => a.state === 'ok' && a.mint)
    && totalPct === 100
    && (!compound.enabled || hasStakeAlloc)
  ), [mode, allocations, totalPct, compound.enabled, hasStakeAlloc]);

  const setAllocAt = useCallback((id, patch) => {
    setAllocations((rows) => rows.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const addAlloc = useCallback(() => {
    setAllocations((rows) => (rows.length >= 3 ? rows : [...rows, makeAlloc()]));
  }, []);

  const removeAlloc = useCallback((id) => {
    setAllocations((rows) => (rows.length === 1 ? rows : rows.filter((a) => a.id !== id)));
  }, []);

  const validateAlloc = useCallback(async (id) => {
    const target = allocations.find((a) => a.id === id);
    if (!target) return;
    if (!target.mint) {
      setAllocAt(id, { state: 'error', error: 'Enter a mint address' });
      return;
    }
    setAllocAt(id, { state: 'validating', error: null, info: null });
    try {
      const result = await api('/api/reward-pref/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint: target.mint }),
      });
      setAllocAt(id, {
        state: 'ok',
        error: null,
        info: result,
      });
    } catch (e) {
      setAllocAt(id, {
        state: 'error',
        error: e.message,
        info: null,
      });
    }
  }, [allocations, setAllocAt]);

  const evenlyDistribute = useCallback(() => {
    setAllocations((rows) => balanceWeights(rows));
  }, []);

  const quickPick = useCallback((mint) => {
    if (!mint) return;
    setAllocations((rows) => {
      const dupe = rows.find((r) => r.mint === mint);
      if (dupe) return rows; // already in the list
      const idleIdx = rows.findIndex((r) => !r.mint);
      if (idleIdx >= 0) {
        return rows.map((r, i) => (i === idleIdx
          ? { ...r, mint, state: 'idle', info: null, error: null }
          : r));
      }
      // No empty slots: drop the last row and replace it with the picked mint.
      return rows.map((r, i) => (i === rows.length - 1
        ? { ...r, mint, state: 'idle', info: null, error: null }
        : r));
    });
  }, []);

  const save = useCallback(async () => {
    if (!wallet || !signMessage) {
      setMsg({ kind: 'err', text: 'Connect a wallet that supports message signing.' });
      return;
    }
    if (mode === 'custom') {
      if (!customReady) {
        setMsg({ kind: 'err', text: 'Validate every token and make sure the % adds to 100.' });
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      const compoundPayload = (mode === 'custom' && compound.enabled && hasStakeAlloc)
        ? { enabled: true, lockDays: Number(compound.lockDays) }
        : { enabled: false, lockDays: 0 };
      const payload = {
        wallet,
        mode,
        allocations: mode === 'custom'
          ? allocations.map((a) => ({ mint: a.mint, pct: Number(a.pct) }))
          : [],
        compound: compoundPayload,
      };
      const nonceRes = await api('/api/reward-pref/nonce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const messageBytes = new TextEncoder().encode(nonceRes.message);
      const signatureBytes = await signMessage(messageBytes);
      const signature = bs58.encode(signatureBytes);
      const saveRes = await api('/api/reward-pref/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet,
          mode,
          allocations: payload.allocations,
          compound: compoundPayload,
          message: nonceRes.message,
          signature,
          nonce: nonceRes.nonce,
          issuedAt: nonceRes.issuedAt,
        }),
      });
      setPref(saveRes.preference);
      setMsg({
        kind: 'ok',
        text: mode === 'custom'
          ? (compoundPayload.enabled
            ? `Saved. Faith will auto-stake your POB500 share for ${compoundPayload.lockDays} day(s) every cycle.`
            : 'Saved. Future cycles will route your share into your chosen tokens.')
          : 'Reset to auto-basket. You will receive the standard reward distribution.',
      });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }, [allocations, mode, customReady, signMessage, wallet]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...glass(), padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 6 }}>
              Reward preferences
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em' }}>
              Pick how Faith pays your stake
            </div>
            <div className="mono" style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,.45)', maxWidth: 620, lineHeight: 1.55 }}>
              Default is the auto-basket — every cycle you receive the rotated set of Printr tokens.
              Switch to custom to redirect <i>your</i> share of the cycle into up to 3 tokens of your choice.
            </div>
          </div>
          {!connected && <WalletMultiButton />}
        </div>

        {pref?.lastFailure && (
          <div className="mono" style={{ marginBottom: 14, padding: 10, borderRadius: 10, background: 'rgba(255,171,74,.08)', border: '1px solid rgba(255,171,74,.25)', fontSize: 11.5, color: '#ffe1b8' }}>
            Faith auto-reverted you to the auto-basket on {new Date(pref.lastFailure.revertedAt).toLocaleString()} — token <code>{shortMint(pref.lastFailure.mint)}</code> failed re-validation ({pref.lastFailure.reason}). Pick a new token below or stay on auto.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            { id: 'auto', label: 'Auto basket', sub: 'Receive whatever the worker rotates' },
            { id: 'custom', label: 'Custom (1–3 tokens)', sub: 'Route your share into chosen tokens' },
          ].map((opt) => {
            const on = mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMode(opt.id)}
                disabled={!connected}
                style={{
                  flex: '1 1 220px',
                  textAlign: 'left',
                  padding: '12px 14px',
                  borderRadius: 12,
                  cursor: connected ? 'pointer' : 'not-allowed',
                  background: on ? 'rgba(0,245,255,.08)' : 'rgba(255,255,255,.04)',
                  border: on ? '1px solid rgba(0,245,255,.45)' : '1px solid rgba(255,255,255,.08)',
                  color: '#fff',
                  boxShadow: on ? '0 0 16px rgba(0,245,255,.18)' : 'none',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 800, color: on ? C.cyan : '#fff' }}>{opt.label}</div>
                <div className="mono" style={{ marginTop: 4, fontSize: 10, color: 'rgba(255,255,255,.5)' }}>{opt.sub}</div>
              </button>
            );
          })}
        </div>

        {mode === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {allocations.map((alloc, idx) => (
              <AllocationRow
                key={alloc.id}
                index={idx}
                allocation={alloc}
                onChange={(patch) => setAllocAt(alloc.id, patch)}
                onValidate={() => validateAlloc(alloc.id)}
                onRemove={() => removeAlloc(alloc.id)}
                canRemove={allocations.length > 1}
              />
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div className="mono" style={{ fontSize: 11, color: totalPct === 100 ? C.green : C.amber }}>
                Total: {totalPct}% {totalPct === 100 ? '✓' : '(must be 100)'}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {STAKE_MINT && (
                  <button
                    type="button"
                    disabled={!connected}
                    onClick={() => quickPick(STAKE_MINT)}
                    title="Auto-compound: each cycle Faith buys POB500 for you"
                    style={{
                      padding: '7px 14px',
                      borderRadius: 9,
                      border: '1px solid rgba(191,90,242,.35)',
                      background: 'rgba(191,90,242,.10)',
                      color: C.violet,
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: connected ? 'pointer' : 'not-allowed',
                    }}
                  >+ POB500 (compound)</button>
                )}
                <button
                  type="button"
                  disabled={!connected}
                  onClick={() => quickPick(SOL_MINT)}
                  title="Receive SOL directly each cycle"
                  style={{
                    padding: '7px 14px',
                    borderRadius: 9,
                    border: '1px solid rgba(0,245,255,.32)',
                    background: 'rgba(0,245,255,.06)',
                    color: C.cyan,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: connected ? 'pointer' : 'not-allowed',
                  }}
                >+ SOL</button>
                <button
                  type="button"
                  disabled={!connected || allocations.length >= 3}
                  onClick={addAlloc}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 9,
                    border: '1px solid rgba(255,255,255,.12)',
                    background: 'rgba(255,255,255,.04)',
                    color: 'rgba(255,255,255,.85)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    cursor: connected && allocations.length < 3 ? 'pointer' : 'not-allowed',
                  }}
                >+ add token</button>
                <button
                  type="button"
                  disabled={!connected}
                  onClick={evenlyDistribute}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 9,
                    border: '1px solid rgba(255,255,255,.12)',
                    background: 'rgba(255,255,255,.04)',
                    color: 'rgba(255,255,255,.85)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    cursor: connected ? 'pointer' : 'not-allowed',
                  }}
                >split evenly</button>
              </div>
            </div>
          </div>
        )}

        {mode === 'custom' && hasStakeAlloc && (
          <div style={{
            marginTop: 14,
            padding: 14,
            borderRadius: 12,
            background: compound.enabled ? 'rgba(191,90,242,.08)' : 'rgba(255,255,255,.025)',
            border: compound.enabled ? '1px solid rgba(191,90,242,.35)' : '1px solid rgba(255,255,255,.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: connected ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={compound.enabled}
                disabled={!connected}
                onChange={(e) => setCompound((c) => ({ ...c, enabled: e.target.checked }))}
                style={{ marginTop: 4, accentColor: C.violet, cursor: 'inherit' }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: compound.enabled ? C.violet : '#fff' }}>
                  Auto-stake POB500 rewards
                </div>
                <div className="mono" style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,.55)', lineHeight: 1.55 }}>
                  Each cycle Faith stakes your POB500 share directly via <code>stake_for</code> with the lock tier you pick below — no extra approval needed.
                  Position owner is your wallet, so you keep full custody and can claim or unstake any time from the Stake tab.
                  Other allocations (basket tokens, SOL) still airdrop to your wallet as normal.
                </div>
              </div>
            </label>

            {compound.enabled && (
              <div>
                <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.4)', textTransform: 'uppercase', marginBottom: 8 }}>
                  Lock tier for compound positions
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                  {COMPOUND_LOCK_TIERS.map((tier) => {
                    const on = tier.days === compound.lockDays;
                    return (
                      <button
                        key={tier.days}
                        type="button"
                        disabled={!connected}
                        onClick={() => setCompound((c) => ({ ...c, lockDays: tier.days }))}
                        style={{
                          padding: '10px 0',
                          borderRadius: 8,
                          cursor: connected ? 'pointer' : 'not-allowed',
                          background: on ? 'rgba(191,90,242,.14)' : 'rgba(255,255,255,.04)',
                          border: on ? '1px solid rgba(191,90,242,.55)' : '1px solid rgba(255,255,255,.08)',
                          color: on ? C.violet : 'rgba(255,255,255,.55)',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11,
                          fontWeight: 800,
                          boxShadow: on ? '0 0 14px rgba(191,90,242,.22)' : 'none',
                        }}
                      >
                        <div>{tier.days}d</div>
                        <div style={{ fontSize: 9.5, marginTop: 2, opacity: .8 }}>{tier.multiplier}</div>
                      </button>
                    );
                  })}
                </div>
                <div className="mono" style={{ marginTop: 8, fontSize: 10.5, color: 'rgba(255,255,255,.42)' }}>
                  Each cycle creates a fresh on-chain position at this tier. Compound forever, or unstake whenever the lock expires.
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'custom' && compound.enabled && !hasStakeAlloc && (
          <div className="mono" style={{ marginTop: 14, padding: 10, borderRadius: 10, background: 'rgba(255,171,74,.08)', border: '1px solid rgba(255,171,74,.25)', fontSize: 11.5, color: '#ffe1b8' }}>
            Auto-stake is on, but no POB500 allocation is set. Click <b>+ POB500 (compound)</b> above, validate, then save — or untick auto-stake.
          </div>
        )}

        <div style={{ marginTop: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={save}
            disabled={busy || !connected || (mode === 'custom' && !customReady)}
            style={{
              padding: '10px 26px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,.1)',
              background: connected ? `linear-gradient(135deg,${C.violet}D9,${C.cyan}D9)` : 'rgba(255,255,255,.05)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: '.04em',
              cursor: busy ? 'wait' : (connected ? 'pointer' : 'not-allowed'),
              boxShadow: connected ? '0 0 18px rgba(191,90,242,.28)' : 'none',
            }}
          >{busy ? 'Working…' : (mode === 'custom' ? 'Save preference' : 'Use auto basket')}</button>
          <span className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.4)' }}>
            Saving requires a wallet signature; no transaction or fee is sent on-chain.
          </span>
        </div>

        {msg && (
          <div className="mono" style={{
            marginTop: 14, padding: 10, borderRadius: 10,
            background: msg.kind === 'ok' ? 'rgba(20,241,149,.08)' : 'rgba(255,80,80,.08)',
            border: msg.kind === 'ok' ? '1px solid rgba(20,241,149,.28)' : '1px solid rgba(255,80,80,.28)',
            fontSize: 11.5,
            color: msg.kind === 'ok' ? '#b6ffd9' : '#ffb4b4',
          }}>{msg.text}</div>
        )}
      </div>

      <div style={{ ...glass(), padding: 18 }}>
        <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', color: 'rgba(255,255,255,.25)', textTransform: 'uppercase', marginBottom: 10 }}>
          How custom rewards work
        </div>
        <ul style={{ paddingLeft: 18, fontSize: 12.5, lineHeight: 1.65, color: 'rgba(255,255,255,.55)' }}>
          <li>Faith snapshots your effective stake every spend cycle.</li>
          <li>Your slice of the cycle is swapped into your chosen tokens and airdropped to your wallet.</li>
          <li>Auto-basket stakers continue to receive the rotated basket via the staking pool.</li>
          <li>Tokens are re-validated each cycle. If liquidity disappears or RugCheck risk spikes, you’re reverted to auto and notified here.</li>
          <li><b style={{ color: C.violet }}>POB500 itself is allowed</b> — pick it to auto-compound. Each cycle Faith buys POB500 for you on the open market and sends it to your wallet, which you can restake any time.</li>
          <li>SOL is a valid choice too — useful when Jupiter has no route for a tiny slice, the worker also auto-falls-back to SOL in that case.</li>
        </ul>
      </div>
    </div>
  );
}

function AllocationRow({ index, allocation, onChange, onValidate, onRemove, canRemove }) {
  const { mint, pct, state, info, error } = allocation;
  const showInfo = state === 'ok' && info;
  const isError = state === 'error';
  const isValidating = state === 'validating';

  return (
    <div style={{
      padding: 12,
      borderRadius: 12,
      background: 'rgba(255,255,255,.025)',
      border: `1px solid ${isError ? 'rgba(255,107,107,.35)' : showInfo ? 'rgba(20,241,149,.25)' : 'rgba(255,255,255,.08)'}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="mono" style={{ fontSize: 9.5, color: 'rgba(255,255,255,.32)', letterSpacing: '.1em', textTransform: 'uppercase' }}>
          Slot {index + 1}
        </span>
        <input
          type="text"
          spellCheck={false}
          value={mint}
          onChange={(e) => onChange({ mint: e.target.value.trim(), state: 'idle', info: null, error: null })}
          placeholder="Paste a Solana mint address"
          style={{
            flex: '2 1 320px',
            background: 'rgba(255,255,255,.05)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 9,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fff',
            fontFamily: 'JetBrains Mono, monospace',
            outline: 'none',
          }}
        />
        <input
          type="number"
          min={1}
          max={100}
          value={pct}
          onChange={(e) => {
            const next = Math.max(1, Math.min(100, parseInt(e.target.value || '0', 10) || 0));
            onChange({ pct: next });
          }}
          style={{
            width: 90,
            background: 'rgba(255,255,255,.05)',
            border: '1px solid rgba(255,255,255,.08)',
            borderRadius: 9,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fff',
            fontFamily: 'JetBrains Mono, monospace',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={onValidate}
          disabled={isValidating}
          style={{
            padding: '7px 14px',
            borderRadius: 9,
            background: 'rgba(0,245,255,.08)',
            border: '1px solid rgba(0,245,255,.32)',
            color: C.cyan,
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            fontWeight: 800,
            cursor: isValidating ? 'wait' : 'pointer',
          }}
        >{isValidating ? 'Checking…' : 'Validate'}</button>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            style={{
              padding: '7px 12px',
              borderRadius: 9,
              background: 'rgba(255,107,107,.08)',
              border: '1px solid rgba(255,107,107,.28)',
              color: C.red,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >×</button>
        )}
      </div>

      {showInfo && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{info.symbol || '—'}</span>
            <span className="mono" style={{ fontWeight: 500, color: 'rgba(255,255,255,.45)' }}>{info.name || ''}</span>
            {info.isStakeMint && (
              <span className="mono" style={{ padding: '2px 7px', borderRadius: 6, background: 'rgba(191,90,242,.16)', border: '1px solid rgba(191,90,242,.35)', color: C.violet, fontSize: 9, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>auto-compound</span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.55)' }}>
            liq <span style={{ color: '#fff' }}>{fmtUsd(info.liquidityUsd)}</span> · 24h vol <span style={{ color: '#fff' }}>{fmtUsd(info.volume24hUsd)}</span> · price <span style={{ color: '#fff' }}>{info.priceUsd ? `$${Number(info.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '—'}</span> · 24h <span style={{ color: info.change24h >= 0 ? C.green : C.red }}>{info.change24h != null ? `${info.change24h.toFixed(2)}%` : '—'}</span>
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: 'rgba(255,255,255,.5)' }}>
            program <span style={{ color: '#fff' }}>{info.tokenProgram}</span> · decimals <span style={{ color: '#fff' }}>{info.decimals}</span>
            {info.rugcheckScore != null && (<>
              {' '}· RugCheck <span style={{ color: info.rugcheckScore >= 20000 ? C.amber : C.green }}>{info.rugcheckScore}</span>
            </>)}
          </div>
          {info.probe && (
            <div className="mono" style={{ fontSize: 10, color: 'rgba(255,255,255,.4)' }}>
              probe {info.probe.probeSol} SOL → {Number(info.probe.buyOutUi).toLocaleString(undefined, { maximumFractionDigits: 4 })} {info.symbol} · sell-back {Number(info.probe.sellSolUi).toFixed(4)} SOL ({(info.probe.recoveryRatio * 100).toFixed(1)}% round-trip)
            </div>
          )}
          {Array.isArray(info.warnings) && info.warnings.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
              {info.warnings.map((w, i) => (
                <div key={i} className="mono" style={{ fontSize: 10, color: C.amber }}>
                  ⚠ {w.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isError && (
        <div className="mono" style={{ fontSize: 11, color: C.red }}>
          ✕ {error}
        </div>
      )}
    </div>
  );
}

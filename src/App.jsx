import { useState, useEffect } from "react";
import StakeView from "./stake/StakeView.jsx";
import DocsView from "./docs/DocsView.jsx";
import {
  HeroStatsRow,
  YourPosition,
  TokenDrawer,
  BasketHistory,
} from "./dashboard/panels.jsx";

const SORT_OPTIONS = ["POB Score", "Market Cap", "Price Perf.", "24h Vol", "Staked %"];
const TABS = ["Index", "Stake", "Docs"];

const CHAIN_CLR = { Solana: "#14F195" };
const C = { cyan: "#00F5FF", violet: "#BF5AF2", green: "#14F195", yellow: "#FFD60A", red: "#FF6B6B" };

const glass = (extra = {}) => ({
  background: "rgba(255,255,255,0.035)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 16,
  boxShadow: "0 8px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.05)",
  ...extra,
});

function dataUrl() {
  if (import.meta.env.VITE_POBINDEX_JSON) return import.meta.env.VITE_POBINDEX_JSON;
  if (import.meta.env.VITE_USE_API === "1") return "/api/pobindex";
  return "/pobindex-data.json";
}

function Spark({ up }) {
  const pts = up ? "0,16 9,12 18,9 27,11 36,5 45,7 54,2 63,4" : "0,3 9,5 18,8 27,4 36,10 45,13 54,11 63,17";
  const c = up ? C.green : C.red;
  return (
    <svg width="63" height="18" viewBox="0 0 63 18" fill="none">
      <defs>
        <linearGradient id={"g" + up} x1="0" y1="0" x2="63" y2="0" gradientUnits="userSpaceOnUse">
          <stop stopColor={c} stopOpacity="0.2" />
          <stop offset="1" stopColor={c} />
        </linearGradient>
      </defs>
      <polyline points={pts} stroke={"url(#g" + up + ")"} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Ring({ value }) {
  const v = value == null ? 0 : value;
  const c = v >= 85 ? C.green : v >= 65 ? C.yellow : C.red;
  const r = 13, circ = 2 * Math.PI * r;
  const dash = (v / 100) * circ;
  return (
    <div style={{ position: "relative", width: 34, height: 34, flexShrink: 0 }}>
      <svg width="34" height="34" viewBox="0 0 34 34" style={{ transform: "rotate(-90deg)" }}>
        <circle cx="17" cy="17" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="2.5" />
        <circle cx="17" cy="17" r={r} fill="none" stroke={c} strokeWidth="2.5"
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 4px ${c}90)` }} />
      </svg>
      <span style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 8.5, fontWeight: 800, color: c, fontFamily: "monospace"
      }}>{v}</span>
    </div>
  );
}

function NeonBar({ val, color, h = 3 }) {
  const n = Math.min(100, Math.max(0, val || 0));
  return (
    <div style={{ height: h, background: "rgba(255,255,255,0.06)", borderRadius: h, overflow: "hidden", width: "100%" }}>
      <div style={{
        width: `${n}%`, height: "100%",
        background: `linear-gradient(90deg, ${color}60, ${color})`,
        boxShadow: `0 0 8px ${color}70`,
        borderRadius: h, transition: "width 0.6s cubic-bezier(.16,1,.3,1)"
      }} />
    </div>
  );
}

export default function App() {
  const [sort, setSort] = useState("POB Score");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [on, setOn] = useState(false);
  const [payload, setPayload] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "Index";
    const hash = window.location.hash.replace("#", "").toLowerCase();
    if (hash === "stake") return "Stake";
    if (hash === "docs") return "Docs";
    return "Index";
  });

  useEffect(() => { setTimeout(() => setOn(true), 60); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (tab === "Stake") window.location.hash = "#stake";
    else if (tab === "Docs") window.location.hash = "#docs";
    else window.location.hash = "";
  }, [tab]);

  useEffect(() => {
    let cancel = false;
    const pollMs = Number(import.meta.env.VITE_DASHBOARD_POLL_MS ?? 90000);

    async function load() {
      try {
        const res = await fetch(dataUrl(), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!cancel) {
          setPayload(j);
          setLoadErr(null);
        }
      } catch (e) {
        if (!cancel) setLoadErr(e.message || "load failed");
      }
    }

    load();
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      return () => { cancel = true; };
    }
    const id = setInterval(load, pollMs);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  const rawTokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  const rows = rawTokens
    .filter(t => (t.name || "").toLowerCase().includes(q.toLowerCase()) || (t.symbol || "").toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (sort === "POB Score") return (b.pobScore || 0) - (a.pobScore || 0);
      if (sort === "Market Cap") return (b.mcap || 0) - (a.mcap || 0);
      if (sort === "Price Perf.") return (b.change24h || 0) - (a.change24h || 0);
      if (sort === "24h Vol") return (b.vol24h || 0) - (a.vol24h || 0);
      if (sort === "Staked %") return (b.stakedPct || 0) - (a.stakedPct || 0);
      return 0;
    });

  const top5 = [...rows].sort((a, b) => (b.pobScore || 0) - (a.pobScore || 0)).slice(0, 5);
  const totalPob = top5.reduce((s, t) => s + (t.pobScore || 0), 0);
  const avgPob = rows.length ? Math.round(rows.reduce((s, t) => s + (t.pobScore || 0), 0) / rows.length) : 0;
  const selT = sel ? rows.find(t => t.id === sel || t.mint === sel) : null;

  const updated = payload?.updatedAt ? new Date(payload.updatedAt).toLocaleString() : "—";

  return (
    <div style={{ fontFamily: "'Outfit',sans-serif", background: "#060A12", minHeight: "100vh", color: "#fff", opacity: on ? 1 : 0, transition: "opacity 0.5s", position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:4px}
        @keyframes float1{0%,100%{transform:translate(0,0) scale(1)}40%{transform:translate(-30px,25px) scale(1.04)}70%{transform:translate(15px,-15px) scale(.97)}}
        @keyframes float2{0%,100%{transform:translate(0,0)}55%{transform:translate(40px,-25px) scale(1.06)}}
        @keyframes float3{0%,100%{transform:translate(0,0)}30%{transform:translate(-20px,30px)}70%{transform:translate(25px,-20px)}}
        @keyframes fadeup{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulsedot{0%,100%{opacity:1;box-shadow:0 0 6px #14F195}50%{opacity:.4;box-shadow:0 0 2px #14F195}}
        .tr{cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);transition:background .15s}
        .tr:hover{background:rgba(0,245,255,0.03)!important}
        .stab{background:transparent;border:none;padding:9px 0;font-size:11.5px;font-weight:700;color:rgba(255,255,255,.28);cursor:pointer;font-family:'Outfit',sans-serif;border-bottom:2px solid transparent;transition:all .15s;letter-spacing:.04em}
        .stab:hover{color:rgba(255,255,255,.6)}
        .stab.on{color:#00F5FF;border-bottom-color:#00F5FF;text-shadow:0 0 14px rgba(0,245,255,.5)}
        .fadeup{animation:fadeup .35s ease both}
        .dot{animation:pulsedot 2.5s ease-in-out infinite;width:7px;height:7px;border-radius:50%;background:#14F195;box-shadow:0 0 6px #14F195}
        .mono{font-family:'JetBrains Mono',monospace}
      `}</style>

      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle,rgba(191,90,242,.16) 0%,transparent 68%)", top: -250, right: -150, animation: "float1 14s ease-in-out infinite" }} />
        <div style={{ position: "absolute", width: 550, height: 550, borderRadius: "50%", background: "radial-gradient(circle,rgba(0,245,255,.11) 0%,transparent 68%)", bottom: -180, left: -120, animation: "float2 18s ease-in-out infinite" }} />
        <div style={{ position: "absolute", width: 320, height: 320, borderRadius: "50%", background: "radial-gradient(circle,rgba(20,241,149,.07) 0%,transparent 68%)", top: "38%", left: "42%", animation: "float3 22s ease-in-out infinite" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,.012) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.012) 1px,transparent 1px)", backgroundSize: "52px 52px" }} />
      </div>

      <div style={{ position: "relative", zIndex: 1 }}>
        <div style={{ background: "rgba(6,10,18,.82)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.055)", padding: "0 32px", position: "sticky", top: 0, zIndex: 100 }}>
          <div style={{ maxWidth: 1280, margin: "0 auto", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <div style={{ width: 34, height: 34, borderRadius: "50%", overflow: "hidden", flexShrink: 0, boxShadow: "0 0 22px rgba(191,90,242,.45), 0 0 0 1.5px rgba(0,245,255,.4)", background: "#060A12" }}>
                <img
                  src="/pob-coin.png"
                  alt="POB500 — Proof of Belief"
                  width={34}
                  height={34}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
                <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>POB500</span>
                <span className="mono" style={{ fontSize: 8.5, fontWeight: 700, color: "rgba(255,255,255,.32)", letterSpacing: ".14em", marginTop: 3, textTransform: "uppercase" }}>Proof of Belief</span>
              </div>
              <div style={{ width: 1, height: 18, background: "rgba(255,255,255,.07)", margin: "0 4px" }} />
              <span style={{ fontSize: 11, color: "rgba(255,255,255,.28)", letterSpacing: ".04em" }}>Solana · Printr</span>
              <div style={{ width: 1, height: 18, background: "rgba(255,255,255,.07)", margin: "0 4px" }} />
              <div style={{ display: "flex", gap: 4 }}>
                {TABS.map((name) => {
                  const active = tab === name;
                  return (
                    <button
                      key={name}
                      onClick={() => setTab(name)}
                      style={{
                        background: active ? "rgba(0,245,255,.08)" : "transparent",
                        border: active ? "1px solid rgba(0,245,255,.38)" : "1px solid transparent",
                        borderRadius: 8,
                        padding: "5px 12px",
                        fontSize: 11.5,
                        fontWeight: 800,
                        letterSpacing: ".06em",
                        color: active ? "#00F5FF" : "rgba(255,255,255,.42)",
                        cursor: "pointer",
                        fontFamily: "'Outfit',sans-serif",
                        textShadow: active ? "0 0 12px rgba(0,245,255,.45)" : "none",
                      }}
                    >{name.toUpperCase()}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div className="dot" />
                <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,.38)" }}>DATA · {updated}</span>
              </div>
              <a href="https://app.printr.money" target="_blank" rel="noopener noreferrer" style={{ background: "linear-gradient(135deg,rgba(191,90,242,.85),rgba(0,245,255,.85))", color: "#fff", borderRadius: 10, padding: "8px 18px", fontSize: 12, fontWeight: 700, textDecoration: "none", letterSpacing: ".04em", border: "1px solid rgba(255,255,255,.1)", boxShadow: "0 0 22px rgba(191,90,242,.28)" }}>
                Trade on Printr →
              </a>
            </div>
          </div>
        </div>

        <div style={{ maxWidth: 1280, margin: "0 auto", padding: "28px 32px" }}>
          {tab === "Stake" ? (
            <StakeView />
          ) : tab === "Docs" ? (
            <DocsView payload={payload} />
          ) : (<>
          {loadErr && (
            <div className="mono" style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: "rgba(255,80,80,.08)", border: "1px solid rgba(255,80,80,.25)", fontSize: 12, color: "#ffb4b4" }}>
              Could not load POB500 data ({loadErr}). Place <code style={{ color: "#fff" }}>pobindex-data.json</code> in public/ or set VITE_POBINDEX_JSON.
            </div>
          )}

          <div
            style={{
              marginBottom: 22,
              padding: "28px 30px",
              borderRadius: 18,
              background: "linear-gradient(135deg, rgba(191,90,242,.11), rgba(0,245,255,.05))",
              border: "1px solid rgba(191,90,242,.22)",
              boxShadow: "0 0 0 1px rgba(191,90,242,.05), 0 12px 52px rgba(191,90,242,.10), inset 0 1px 0 rgba(255,255,255,.05)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: -80,
                right: -60,
                width: 280,
                height: 280,
                borderRadius: "50%",
                background: "radial-gradient(circle, rgba(0,245,255,.15) 0%, transparent 65%)",
                pointerEvents: "none",
              }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 32, alignItems: "center", position: "relative" }}>
              <div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".08em", padding: "3px 9px", borderRadius: 6, background: "rgba(191,90,242,.14)", border: "1px solid rgba(191,90,242,.38)", color: C.violet }}>
                    THE PROOF OF BELIEF INDEX
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: ".08em", padding: "3px 9px", borderRadius: 6, background: "rgba(20,241,149,.12)", border: "1px solid rgba(20,241,149,.38)", color: C.green }}>
                    LIVE ON SOLANA
                  </span>
                </div>
                <h1
                  style={{
                    fontSize: 34,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.12,
                    marginBottom: 14,
                    background: "linear-gradient(135deg, #fff 0%, rgba(0,245,255,.75) 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                  }}
                >
                  POB500 — one token, the whole Printr ecosystem.
                </h1>
                <div style={{ fontSize: 14.5, lineHeight: 1.7, color: "rgba(255,255,255,.62)", maxWidth: 620, marginBottom: 18 }}>
                  POB500 is the Proof of Belief index — an auto-rebalancing basket of the strongest
                  tokens launched on Printr, like an index ETF for the Printr ecosystem. Stake POB500,
                  and creator fees are swapped every 10 minutes into the current top performers,
                  then distributed to stakers as real token rewards. Skip the hunt, own the winners.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => setTab("Stake")}
                    style={{
                      background: `linear-gradient(135deg,${C.violet},${C.cyan})`,
                      border: "1px solid rgba(255,255,255,.14)",
                      color: "#fff",
                      borderRadius: 10,
                      padding: "10px 20px",
                      fontSize: 13,
                      fontWeight: 800,
                      letterSpacing: ".04em",
                      cursor: "pointer",
                      fontFamily: "'Outfit',sans-serif",
                      boxShadow: "0 6px 26px rgba(191,90,242,.35)",
                    }}
                  >
                    Stake POB500 →
                  </button>
                  <button
                    onClick={() => setTab("Docs")}
                    style={{
                      background: "rgba(255,255,255,.04)",
                      border: "1px solid rgba(255,255,255,.16)",
                      color: "#fff",
                      borderRadius: 10,
                      padding: "10px 20px",
                      fontSize: 13,
                      fontWeight: 700,
                      letterSpacing: ".04em",
                      cursor: "pointer",
                      fontFamily: "'Outfit',sans-serif",
                    }}
                  >
                    How it works
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
                  {[
                    ["Auto-rebalanced · 1–2h", C.cyan],
                    ["Real fee yield", C.green],
                    ["1–30d locks · up to 3×", C.violet],
                  ].map(([t, c]) => (
                    <span
                      key={t}
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        fontWeight: 800,
                        letterSpacing: ".06em",
                        color: c,
                        padding: "5px 10px",
                        borderRadius: 999,
                        background: `${c}10`,
                        border: `1px solid ${c}35`,
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div
                  style={{
                    position: "absolute",
                    inset: "-8%",
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(0,245,255,.28) 0%, rgba(191,90,242,.18) 45%, transparent 72%)",
                    filter: "blur(24px)",
                    pointerEvents: "none",
                  }}
                />
                <img
                  src="/pob-coin.png"
                  alt="POB — Proof of Belief"
                  style={{
                    position: "relative",
                    width: "100%",
                    maxWidth: 320,
                    height: "auto",
                    borderRadius: "50%",
                    border: "1.5px solid rgba(0,245,255,.25)",
                    boxShadow: "0 20px 80px rgba(191,90,242,.35), 0 0 0 1px rgba(255,255,255,.04) inset",
                    background: "#060A12",
                  }}
                />
              </div>
            </div>
          </div>

          <HeroStatsRow
            payload={payload}
            extras={{ avgPob, rowCount: rows.length }}
          />

          <YourPosition onGoStake={() => setTab("Stake")} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 286px", gap: 14, alignItems: "start" }}>

            <div style={glass()}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span className="mono" style={{ fontSize: 11, color: "rgba(255,255,255,.35)", flex: 1 }}>Solana only · Printr + DexScreener · POB score includes staked % (on-chain)</span>
                <div style={{ position: "relative" }}>
                  <input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.09)", borderRadius: 9, padding: "6px 12px 6px 30px", fontSize: 12, fontFamily: "inherit", color: "#fff", outline: "none", width: 130 }} />
                  <svg style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", opacity: .28 }} width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="5" cy="5" r="4" stroke="white" strokeWidth="1.5" /><path d="M8.5 8.5L11 11" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </div>
              </div>

              <div style={{ padding: "0 20px", borderBottom: "1px solid rgba(255,255,255,.05)", display: "flex", gap: 22 }}>
                {SORT_OPTIONS.map(s => <button key={s} className={`stab${sort === s ? " on" : ""}`} onClick={() => setSort(s)}>{s}</button>)}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "28px 1.8fr 86px 84px 78px 72px 68px 46px", padding: "10px 20px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                {["#", "Token", "24h", "Mcap", "Stake", "Lock", "APY", ""].map((h, i) => (
                  <div key={i} className="mono" style={{ fontSize: 9.5, fontWeight: 700, color: "rgba(255,255,255,.2)", letterSpacing: ".1em", textTransform: "uppercase" }}>{h}</div>
                ))}
              </div>

              {rows.map((t, i) => {
                const chain = t.chain || "Solana";
                const cc = CHAIN_CLR[chain] || CHAIN_CLR.Solana;
                const id = t.id || t.mint;
                const chg = t.change24h ?? 0;
                return (
                  <div key={id}>
                    <div className="tr fadeup" onClick={() => setSel(sel === id ? null : id)}
                      style={{ display: "grid", gridTemplateColumns: "28px 1.8fr 86px 84px 78px 72px 68px 46px", padding: "13px 20px", background: sel === id ? "rgba(0,245,255,.04)" : "transparent", animationDelay: `${i * .035}s`, alignItems: "center" }}>

                      <span className="mono" style={{ fontSize: 10.5, color: "rgba(255,255,255,.17)", fontWeight: 500 }}>{i + 1}</span>

                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 10, background: `${cc}13`, border: `1.5px solid ${cc}32`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 10px ${cc}18`, flexShrink: 0 }}>
                          <span className="mono" style={{ fontSize: 9.5, fontWeight: 800, color: cc }}>{(t.symbol || t.name || "?").slice(0, 2)}</span>
                        </div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: ".02em" }}>{t.name}</span>
                            {t.graduated && <span className="mono" style={{ fontSize: 7.5, fontWeight: 800, background: `${C.green}16`, color: C.green, border: `1px solid ${C.green}38`, borderRadius: 4, padding: "2px 5px", letterSpacing: ".06em", boxShadow: `0 0 8px ${C.green}20` }}>GRAD</span>}
                          </div>
                          <div className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,.28)", marginTop: 1 }}>{t.symbol} · {chain}</div>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: chg >= 0 ? C.green : C.red, textShadow: `0 0 10px ${chg >= 0 ? C.green : C.red}55` }}>
                          {chg >= 0 ? "+" : ""}{chg}%
                        </span>
                        <Spark up={chg >= 0} />
                      </div>

                      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,.78)" }}>{t.mcapFmt || "—"}</span>

                      <div>
                        <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: C.cyan, marginBottom: 4 }}>{t.stakedPct != null ? `${t.stakedPct}%` : "—"}</div>
                        {t.stakedPct != null ? <NeonBar val={t.stakedPct} color={cc} /> : <div style={{ height: 3 }} />}
                      </div>

                      <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,.45)" }}>{t.avgLock != null ? `${t.avgLock}d` : "—"}</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: C.green, textShadow: `0 0 10px ${C.green}45` }}>{t.feeYield != null ? `${t.feeYield}%` : "—"}</span>
                      <Ring value={t.pobScore} />
                    </div>

                    {sel === id && selT && (
                      <TokenDrawer token={selT} recentSwaps={payload?.recentSwaps} />
                    )}
                  </div>
                );
              })}

              {rows.length === 0 && (
                <div className="mono" style={{ padding: 48, textAlign: "center", color: "rgba(255,255,255,.18)", fontSize: 13 }}>No tokens in snapshot. Run the worker cycle to populate.</div>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

              <div style={{ ...glass({ boxShadow: `0 0 0 1px rgba(0,245,255,.13), 0 8px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05)` }), padding: "20px 22px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <div>
                    <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 5 }}>Airdrop Basket</div>
                    <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-.02em" }}>POB Top 5</div>
                  </div>
                  <div style={{ background: `${C.green}18`, border: `1px solid ${C.green}40`, borderRadius: 8, padding: "4px 10px", boxShadow: `0 0 12px ${C.green}18` }}>
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 800, color: C.green, letterSpacing: ".06em" }}>LIVE</span>
                  </div>
                </div>

                <div style={{ borderTop: "1px solid rgba(255,255,255,.05)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 0 }}>
                  {top5.map((t, i) => {
                    const w = totalPob ? ((t.pobScore || 0) / totalPob * 100).toFixed(1) : "0";
                    const c = CHAIN_CLR[t.chain] || CHAIN_CLR.Solana;
                    return (
                      <div key={t.mint || t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                        <div style={{ width: 22, height: 22, borderRadius: 6, background: `${c}18`, border: `1px solid ${c}38`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <span className="mono" style={{ fontSize: 9, fontWeight: 800, color: c }}>{i + 1}</span>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ fontSize: 12, fontWeight: 700 }}>{t.symbol || t.name}</span>
                            <span className="mono" style={{ fontSize: 10.5, color: "rgba(255,255,255,.38)" }}>{w}%</span>
                          </div>
                          <NeonBar val={parseFloat(w)} color={c} h={2} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 9.5, color: "rgba(255,255,255,.2)" }}>Worker rebalance</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.cyan, boxShadow: `0 0 6px ${C.cyan}` }} />
                    <span className="mono" style={{ fontSize: 9.5, fontWeight: 700, color: C.cyan }}>Score-weighted</span>
                  </div>
                </div>
              </div>

              <div style={{ ...glass(), padding: "20px 22px" }}>
                <div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: "rgba(255,255,255,.25)", textTransform: "uppercase", marginBottom: 14 }}>Score Formula</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                  {[["Market Cap", "33%", "#4F8EF7", 33], ["Liquidity + Vol", "54%", C.violet, 54], ["Price 24h", "13%", C.green, 13]].map(([l, p, c, v]) => (
                    <div key={l}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          <div style={{ width: 7, height: 7, borderRadius: 2, background: c, boxShadow: `0 0 6px ${c}` }} />
                          <span style={{ fontSize: 12, color: "rgba(255,255,255,.48)" }}>{l}</span>
                        </div>
                        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: c }}>{p}</span>
                      </div>
                      <NeonBar val={v} color={c} h={3} />
                    </div>
                  ))}
                </div>
                <div className="mono" style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.05)", fontSize: 10.5, color: "rgba(255,255,255,.2)", lineHeight: 1.65 }}>
                  On-chain rewards use tenure multipliers (see pobindex-worker). Experimental software.
                </div>
              </div>

              <div style={{ background: "linear-gradient(135deg,rgba(191,90,242,.14),rgba(0,245,255,.07))", border: "1px solid rgba(191,90,242,.24)", borderRadius: 16, padding: "20px 22px", boxShadow: "0 0 32px rgba(191,90,242,.09)" }}>
                <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-.01em", marginBottom: 6 }}>New to POB500?</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.38)", lineHeight: 1.65, marginBottom: 16 }}>How the Proof of Belief index works, how staking pays, and how to earn from the airdrop basket.</div>
                <button
                  onClick={() => setTab("Docs")}
                  style={{ display: "block", width: "100%", textAlign: "center", background: `linear-gradient(135deg,${C.violet},${C.cyan})`, color: "#fff", borderRadius: 10, padding: "10px 0", fontSize: 12, fontWeight: 800, textDecoration: "none", letterSpacing: ".04em", boxShadow: `0 4px 22px rgba(191,90,242,.32)`, border: "none", cursor: "pointer", fontFamily: "'Outfit',sans-serif" }}
                >
                  Read the docs →
                </button>
              </div>

            </div>
          </div>

          <BasketHistory history={payload?.basketHistory} />

          <div style={{ marginTop: 22, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "rgba(255,255,255,.13)" }}>
              POB500 · Proof of Belief · Solana · {payload?.sources?.candidates || "—"} · {payload?.sources?.metricsNote || ""}
            </span>
            <div className="mono" style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 10.5, color: "rgba(255,255,255,.35)" }}>
              <a
                href="https://github.com/scufffd/pob500"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="POB500 on GitHub"
                style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(255,255,255,.85)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "inherit"; }}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
                GitHub
              </a>
              <a
                href="https://x.com/scufffd"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="@scufffd on X"
                style={{ color: "inherit", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "rgba(255,255,255,.85)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "inherit"; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231L18.244 2.25Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
                </svg>
                @scufffd
              </a>
              <span style={{ color: "rgba(255,255,255,.13)" }}>Not financial advice</span>
            </div>
          </div>
          </>)}
        </div>
      </div>
    </div>
  );
}

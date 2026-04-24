import { useMemo } from "react";

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

const H = ({ children, accent = C.cyan }) => (
  <div
    className="mono"
    style={{
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: ".12em",
      textTransform: "uppercase",
      color: accent,
      marginBottom: 8,
      textShadow: `0 0 12px ${accent}55`,
    }}
  >
    {children}
  </div>
);

const Title = ({ children, size = 22 }) => (
  <h2
    style={{
      fontSize: size,
      fontWeight: 800,
      letterSpacing: "-.02em",
      marginBottom: 12,
      lineHeight: 1.15,
    }}
  >
    {children}
  </h2>
);

const P = ({ children }) => (
  <p
    style={{
      fontSize: 13.5,
      lineHeight: 1.75,
      color: "rgba(255,255,255,.62)",
      marginBottom: 10,
    }}
  >
    {children}
  </p>
);

const Pill = ({ children, color = C.cyan }) => (
  <span
    className="mono"
    style={{
      display: "inline-block",
      padding: "3px 8px",
      borderRadius: 6,
      background: `${color}14`,
      border: `1px solid ${color}40`,
      color,
      fontSize: 10.5,
      fontWeight: 800,
      letterSpacing: ".04em",
    }}
  >
    {children}
  </span>
);

const Code = ({ children }) => (
  <code
    className="mono"
    style={{
      fontSize: 11.5,
      background: "rgba(0,245,255,.05)",
      border: "1px solid rgba(0,245,255,.14)",
      color: C.cyan,
      padding: "1px 6px",
      borderRadius: 4,
      wordBreak: "break-all",
    }}
  >
    {children}
  </code>
);

const Card = ({ children, accent, pad = 24 }) => (
  <div
    style={{
      ...glass(accent ? { boxShadow: `0 0 0 1px ${accent}2c, 0 8px 40px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.05)` } : {}),
      padding: pad,
    }}
  >
    {children}
  </div>
);

const Step = ({ n, title, body, accent = C.cyan }) => (
  <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
    <div
      style={{
        flexShrink: 0,
        width: 34,
        height: 34,
        borderRadius: 10,
        background: `${accent}16`,
        border: `1px solid ${accent}42`,
        color: accent,
        fontWeight: 800,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'JetBrains Mono',monospace",
        boxShadow: `0 0 12px ${accent}22`,
      }}
    >
      {n}
    </div>
    <div style={{ flex: 1, paddingTop: 4 }}>
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-.01em", marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,.55)" }}>{body}</div>
    </div>
  </div>
);

const Row = ({ cells }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: cells.map((c) => (c.w || "1fr")).join(" "),
      padding: "12px 16px",
      borderBottom: "1px solid rgba(255,255,255,.05)",
      alignItems: "center",
      fontSize: 12.5,
    }}
  >
    {cells.map((c, i) => (
      <div
        key={i}
        className={c.mono ? "mono" : ""}
        style={{
          color: c.color || "rgba(255,255,255,.68)",
          fontWeight: c.bold ? 800 : 500,
          letterSpacing: c.mono ? ".02em" : "normal",
        }}
      >
        {c.value}
      </div>
    ))}
  </div>
);

const LOCK_TIERS = [
  { days: "1 day", mult: "1.00×", note: "Quick in/out" },
  { days: "3 days", mult: "1.25×" },
  { days: "7 days", mult: "1.50×", note: "Starter tier" },
  { days: "14 days", mult: "2.00×" },
  { days: "21 days", mult: "2.50×" },
  { days: "30 days", mult: "3.00×", note: "Maximum boost" },
];

export default function DocsView({ payload }) {
  const mint = payload?.stakeMint || import.meta.env.VITE_POB_STAKE_MINT || "—";
  const program = payload?.stakeProgram || import.meta.env.VITE_POB_STAKE_PROGRAM_ID || "65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA";

  const toc = useMemo(
    () => [
      { id: "what", label: "What is POB500?" },
      { id: "how", label: "How it works" },
      { id: "stake", label: "Staking" },
      { id: "tiers", label: "Lock tiers" },
      { id: "rewards", label: "Rewards & basket" },
      { id: "early", label: "Early unstake" },
      { id: "presale", label: "Presale" },
      { id: "score", label: "POB score" },
      { id: "security", label: "Security" },
      { id: "contracts", label: "Contracts" },
      { id: "faq", label: "FAQ" },
    ],
    [],
  );

  const scroll = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="docs-grid" style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 20, alignItems: "start" }}>
      <div className="docs-toc" style={{ position: "sticky", top: 80 }}>
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: ".12em",
            color: "rgba(255,255,255,.25)",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Contents
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {toc.map((t) => (
            <button
              key={t.id}
              onClick={() => scroll(t.id)}
              style={{
                background: "transparent",
                border: "none",
                borderLeft: "2px solid rgba(255,255,255,.06)",
                padding: "6px 12px",
                fontSize: 12.5,
                color: "rgba(255,255,255,.48)",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "'Outfit',sans-serif",
                letterSpacing: ".01em",
                transition: "all .15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = C.cyan;
                e.currentTarget.style.borderLeftColor = C.cyan;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "rgba(255,255,255,.48)";
                e.currentTarget.style.borderLeftColor = "rgba(255,255,255,.06)";
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          className="docs-hero"
          style={{
            ...glass({
              boxShadow: `0 0 0 1px rgba(191,90,242,.22), 0 12px 60px rgba(191,90,242,.12), inset 0 1px 0 rgba(255,255,255,.05)`,
              background: "linear-gradient(135deg, rgba(191,90,242,.10), rgba(0,245,255,.05))",
            }),
            padding: "32px 30px",
          }}
        >
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <Pill color={C.violet}>DOCS</Pill>
            <Pill color={C.green}>LIVE ON SOLANA</Pill>
          </div>
          <Title size={30}>POB500 — the Proof of Belief index.</Title>
          <div style={{ fontSize: 15, lineHeight: 1.7, color: "rgba(255,255,255,.68)", maxWidth: 720 }}>
            <b style={{ color: "#fff" }}>POB500</b> is a single token that gives you diversified,
            auto-rebalancing exposure to the top-performing tokens launched on{" "}
            <b style={{ color: "#fff" }}>Printr</b>. Stake it, earn real rewards in those tokens,
            skip the work of picking winners.
          </div>
        </div>

        <section id="what">
          <Card>
            <H accent={C.cyan}>Overview</H>
            <Title>What is POB500?</Title>
            <P>
              Printr ships dozens of new tokens per week. Picking the right ones — and timing entry and
              exit — is hard. <b style={{ color: "#fff" }}>POB500</b> — the Proof of Belief index — is
              the lazy-genius version of that: you hold and stake one token, we score every Printr coin
              by real on-chain performance, and the top performers get auto-bought with the fees our
              stakers generated and distributed back to stakers as rewards.
            </P>
            <P>
              Think of it like <b style={{ color: "#fff" }}>SPY for Printr</b>: instead of single-bet risk
              on one newly-launched memecoin, you get a rolling basket of the strongest performers,
              rebalanced every 10 minutes. You capture the upside of the ecosystem as a whole without
              having to trade every launch yourself.
            </P>

            <div className="docs-3col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
              {[
                { t: "One token, many exposures", b: "Stake POB500, earn a rotating basket of top Printr tokens.", c: C.violet },
                { t: "Auto-rebalancing", b: "The basket refreshes every 10 minutes based on live metrics.", c: C.cyan },
                { t: "Real fee yield", b: "Creator fees from our own Printr token pay the rewards — not emissions.", c: C.green },
              ].map((x) => (
                <div
                  key={x.t}
                  style={{
                    padding: 16,
                    borderRadius: 12,
                    background: `${x.c}08`,
                    border: `1px solid ${x.c}28`,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6, color: x.c }}>{x.t}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "rgba(255,255,255,.55)" }}>{x.b}</div>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section id="how">
          <Card>
            <H accent={C.cyan}>The loop</H>
            <Title>How it works</Title>
            <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 16 }}>
              <Step
                n="1"
                accent={C.violet}
                title="Discovery"
                body="The worker pulls every active Printr token from the official API and verifies each one on-chain by looking for interactions with the Printr launch program. Only tokens actually minted on Printr show up in the index."
              />
              <Step
                n="2"
                accent={C.cyan}
                title="Scoring"
                body="Every token gets a POB Score (0–100) built from market cap, liquidity, 24h volume, 24h price change, and the percentage of supply actively staked on Printr. Higher score = more weight in the basket."
              />
              <Step
                n="3"
                accent={C.green}
                title="Basket rebalance"
                body="The top scorers form the airdrop basket. Every rebalance cycle (default every 10 minutes), the worker allocates freshly-claimed SOL across these tokens — higher scorers get proportionally more budget, with a minimum spend floor to make the swap economical."
              />
              <Step
                n="4"
                accent={C.yellow}
                title="Swap & deposit"
                body="SOL is swapped into each basket token via Jupiter (with Raydium fallback), then deposited into the staking pool's reward vaults using a MasterChef-style accumulator. Every staker's pending balance updates proportionally to their share."
              />
              <Step
                n="5"
                accent={C.violet}
                title="Claim"
                body="Rewards accrue continuously. Connect your wallet, hit Claim, and the tokens flow to your wallet. You can claim as often as you like — no minimum, no cooldown."
              />
            </div>
          </Card>
        </section>

        <section id="stake">
          <Card accent="rgba(0,245,255,.28)">
            <H accent={C.cyan}>The vault</H>
            <Title>Staking</Title>
            <P>
              To earn rewards, lock your POB500 tokens into the staking pool for a tier of your
              choice (1 to 30 days). Your <b style={{ color: "#fff" }}>effective stake</b> — the number
              that determines your share of future rewards — is your amount times the lock multiplier.
              Longer locks = bigger share.
            </P>
            <P>
              Your stake is held by a pool-owned associated token account. The program is the only
              thing that can move those tokens, and only via instructions you sign. No admin keys,
              no upgradable vault balance.
            </P>
            <P>
              When you stake, the UI also creates a <Code>RewardCheckpoint</Code> for every reward mint
              in the pool. This snapshots the pool's current accumulator so you can never retroactively
              claim rewards that were deposited before you joined — you only earn your fair share from
              the moment of stake forward.
            </P>
          </Card>
        </section>

        <section id="tiers">
          <Card>
            <H accent={C.violet}>Lock tiers</H>
            <Title>Choose your commitment</Title>
            <P>
              Six tiers, from one-day testing the waters to a full month. The multiplier boosts your
              share of every reward deposited during your lock. Old positions staked under previous
              tier schedules keep their original multipliers — new stakes use this ladder.
            </P>
            <div
              style={{
                marginTop: 14,
                border: "1px solid rgba(255,255,255,.06)",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              <Row
                cells={[
                  { value: "Lock", mono: true, color: "rgba(255,255,255,.28)", bold: true, w: "120px" },
                  { value: "Multiplier", mono: true, color: "rgba(255,255,255,.28)", bold: true, w: "140px" },
                  { value: "Use case", mono: true, color: "rgba(255,255,255,.28)", bold: true },
                ]}
              />
              {LOCK_TIERS.map((t) => (
                <Row
                  key={t.days}
                  cells={[
                    { value: t.days, bold: true, color: "#fff", w: "120px" },
                    { value: t.mult, mono: true, color: C.cyan, bold: true, w: "140px" },
                    { value: t.note || "—", color: "rgba(255,255,255,.55)" },
                  ]}
                />
              ))}
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: "rgba(255,255,255,.4)" }}>
              Example: staking 1,000 POB500 at 30 days gives you the same share of rewards as 3,000
              POB500 staked at 1 day — but your principal is locked for the full month unless you
              unstake early (see below).
            </div>
          </Card>
        </section>

        <section id="rewards">
          <Card accent="rgba(20,241,149,.24)">
            <H accent={C.green}>The basket</H>
            <Title>Rewards & airdrop basket</Title>
            <P>
              The airdrop basket is the heart of POB500. Instead of paying stakers in inflationary
              emissions of the POB500 token itself, we pay them in <b style={{ color: "#fff" }}>actual
              Printr tokens</b> bought from real fee income.
            </P>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
              <Step
                n="→"
                accent={C.violet}
                title="Fees in"
                body="Our POB500 token is itself a Printr launch, so creator fees accrue on every trade. The worker sweeps these automatically."
              />
              <Step
                n="→"
                accent={C.cyan}
                title="Basket formed"
                body="Top-5 POB tokens by score are selected each cycle. Allocation is score-weighted with a minimum spend floor per token so each swap is efficient."
              />
              <Step
                n="→"
                accent={C.green}
                title="Swap via Jupiter"
                body="SOL → each basket token at best route. Slippage is capped per swap. Failed routes fall back to Raydium."
              />
              <Step
                n="→"
                accent={C.yellow}
                title="Deposited to pool"
                body="The program's deposit_rewards instruction transfers the tokens into the matching reward vault and bumps acc_per_share. Every staker's pending balance updates atomically."
              />
            </div>
            <P>
              <b style={{ color: "#fff" }}>Yield is real, not printed.</b> The pool can never pay out
              more than it actually received. If creator fees go up, yield goes up; if Printr has a
              quiet day, yield is smaller that cycle. Nothing is diluted.
            </P>
          </Card>
        </section>

        <section id="early">
          <Card accent="rgba(255,214,10,.24)">
            <H accent={C.yellow}>Exit early</H>
            <Title>Early unstake</Title>
            <P>
              Changed your mind before your lock ends? You can unstake early at a flat{" "}
              <b style={{ color: C.yellow }}>10% principal penalty</b>. The 10% stays in the pool and
              is redistributed to remaining stakers via the stake-mint reward line — it rewards the
              people who kept their commitment.
            </P>
            <div
              style={{
                marginTop: 12,
                padding: 16,
                borderRadius: 12,
                background: "rgba(255,214,10,.05)",
                border: "1px solid rgba(255,214,10,.22)",
              }}
            >
              <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "rgba(255,255,255,.7)" }}>
                <b style={{ color: C.yellow }}>Example.</b> You stake 10,000 POB at 30 days, then
                unstake on day 9. You receive 9,000 POB back immediately. The 1,000 POB penalty is
                proportionally distributed to every remaining staker — the longer others stay locked,
                the larger their share of that penalty.
              </div>
            </div>
            <P>
              Already-accrued rewards are unaffected — they're claimed atomically with the unstake in
              the same bundle of transactions.
            </P>
          </Card>
        </section>

        <section id="presale">
          <Card accent="rgba(0,245,255,.28)">
            <H accent={C.cyan}>Launch</H>
            <Title>Presale → automatic staking</Title>
            <P>
              To fund the mainnet deployment + seed the basket, we ran a SOL presale. Everything
              raised after deployment costs is used to buy POB500 and{" "}
              <b style={{ color: C.cyan }}>auto-stake it for contributors</b> at the 7-day lock
              (1.50× multiplier). You don't need to do anything — your position shows up in the
              Stake tab as soon as the distribution script runs.
            </P>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
              {[
                ["1", "Contribute", "Send SOL to the presale wallet during the window. Any amount above dust counts."],
                ["2", "We index", "The worker scans every inbound transfer and aggregates per-wallet totals."],
                ["3", "We buy + stake", "Dev wallet buys POB500 from the pool, then calls stake_for on your behalf — you're written in as the on-chain owner."],
                ["4", "You benefit", "Your position accrues rewards from the very first basket rebalance after your stake. Claim or unstake from the Stake tab whenever you want."],
              ].map(([n, title, body]) => (
                <div
                  key={n}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 1fr",
                    gap: 14,
                    alignItems: "start",
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "rgba(0,245,255,.04)",
                    border: "1px solid rgba(0,245,255,.15)",
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: "rgba(0,245,255,.15)",
                      color: C.cyan,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      fontSize: 13,
                    }}
                  >
                    {n}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{title}</div>
                    <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.6)", lineHeight: 1.65 }}>{body}</div>
                  </div>
                </div>
              ))}
            </div>
            <P>
              <b style={{ color: C.cyan }}>Allocation math.</b> Each contributor's POB500 share is
              strictly proportional to the SOL they sent: <code>tokens_i = (sol_i / total_sol) × presale_supply</code>.
              Rounding dust is absorbed by the largest contributors so totals match exactly.
            </P>
            <P>
              <b style={{ color: C.cyan }}>Early exit.</b> Need to unstake before the 7 days are up?
              Same rules as public stakers: flat 10% principal penalty, instant refund of the rest.
              After the lock ends: 0% penalty.
            </P>
            <P>
              <b style={{ color: C.cyan }}>Custody.</b> Your position is owned by{" "}
              <i>your</i> wallet from the instant <code>stake_for</code> lands — the treasury can
              never claim, move, or unstake it. Your Phantom / Solflare is the sole authority.
            </P>
          </Card>
        </section>

        <section id="score">
          <Card>
            <H accent={C.violet}>Methodology</H>
            <Title>POB score, explained</Title>
            <P>Each Printr token gets a POB score (0–100) built from five weighted signals:</P>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
              {[
                ["Liquidity + 24h Volume", "54%", C.violet, "Can you actually trade in and out at size? The biggest single factor."],
                ["Market Cap", "33%", "#4F8EF7", "Real organic demand beats vanity charts. Bigger mcap = more stable constituent."],
                ["24h Price Change", "13%", C.green, "Momentum input — rewards tokens that are performing right now."],
                ["Supply Staked %", "bonus", C.cyan, "A high % of supply staked on Printr is a strong conviction signal and reduces sell pressure."],
              ].map(([l, p, c, d]) => (
                <div
                  key={l}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.5fr 70px 2.5fr",
                    gap: 14,
                    alignItems: "center",
                    padding: "10px 0",
                    borderBottom: "1px solid rgba(255,255,255,.05)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <div style={{ width: 7, height: 7, borderRadius: 2, background: c, boxShadow: `0 0 6px ${c}` }} />
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{l}</span>
                  </div>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 800, color: c }}>{p}</span>
                  <span style={{ fontSize: 12.5, color: "rgba(255,255,255,.5)", lineHeight: 1.6 }}>{d}</span>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section id="security">
          <Card>
            <H accent={C.green}>Trust model</H>
            <Title>Security</Title>
            <div className="docs-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 6 }}>
              {[
                ["Non-custodial", "Your stake lives in a pool-owned PDA. Only program instructions (which you sign) can move it."],
                ["No mint authority", "The POB500 token mint authority is revoked after launch — no rug, no inflation, no surprise prints."],
                ["Open-source", "The staking program, the worker, and this frontend are all open-source. Everything you see on-chain is what you see in the repo."],
                ["Token-2022 ready", "The program uses Anchor's TokenInterface so it handles both legacy SPL and Token-2022 mints, including transfer hooks & fee extensions."],
                ["Time-locked admin", "Reward mint registration and pool config changes require the treasury signer. Upgrade authority can be frozen once stable."],
                ["Baselined checkpoints", "Late stakers can never claim rewards that were deposited before they joined — enforced at the instruction level."],
              ].map(([t, b]) => (
                <div
                  key={t}
                  style={{
                    padding: 14,
                    borderRadius: 10,
                    background: "rgba(20,241,149,.04)",
                    border: "1px solid rgba(20,241,149,.18)",
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: C.green, marginBottom: 4 }}>{t}</div>
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: "rgba(255,255,255,.55)" }}>{b}</div>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <section id="contracts">
          <Card>
            <H accent={C.cyan}>On-chain</H>
            <Title>Contracts</Title>
            <div
              style={{
                border: "1px solid rgba(255,255,255,.06)",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              <Row
                cells={[
                  { value: "Component", mono: true, color: "rgba(255,255,255,.28)", bold: true, w: "180px" },
                  { value: "Address", mono: true, color: "rgba(255,255,255,.28)", bold: true },
                ]}
              />
              <Row cells={[{ value: "Network", w: "180px", bold: true, color: "#fff" }, { value: "Solana · Mainnet + Devnet", color: "rgba(255,255,255,.68)" }]} />
              <Row cells={[{ value: "Stake program", w: "180px", bold: true, color: "#fff" }, { value: <Code>{program}</Code> }]} />
              <Row cells={[{ value: "POB500 mint", w: "180px", bold: true, color: "#fff" }, { value: <Code>{mint}</Code> }]} />
              <Row cells={[{ value: "Pool PDA seeds", w: "180px", bold: true, color: "#fff" }, { value: <Code>[&quot;pool&quot;, stake_mint]</Code> }]} />
              <Row cells={[{ value: "Checkpoint PDA", w: "180px", bold: true, color: "#fff" }, { value: <Code>[&quot;checkpoint&quot;, position, reward_mint]</Code> }]} />
            </div>
          </Card>
        </section>

        <section id="faq">
          <Card>
            <H accent={C.violet}>FAQ</H>
            <Title>Frequently asked</Title>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
              {[
                [
                  "Do I need to manage the basket myself?",
                  "No. The worker discovers, scores, buys, and distributes automatically. You just stake and claim.",
                ],
                [
                  "What tokens can end up in the basket?",
                  "Any token minted on Printr that clears the minimum floors (market cap, liquidity, volume). The top 5 by POB score at each rebalance are funded.",
                ],
                [
                  "What if I'm early to the pool with nothing yet in the reward vaults?",
                  "Your checkpoint is baselined at the current accumulator. You start earning on the next deposit. You never miss out on future fees.",
                ],
                [
                  "How often can I claim?",
                  "As often as you like. Rewards accrue continuously; claiming is just a token transfer from the reward vault to your wallet.",
                ],
                [
                  "If someone claims twice before I claim once, do they take my share?",
                  "No. Each staker’s owed amount is computed on-chain from your own checkpoint and the global accumulator (MasterChef-style math). Claim order does not reallocate tokens between wallets — you cannot lose someone else’s accrued rewards by being “slow,” and nobody can claim “your” portion by going first.",
                ],
                [
                  "Can rewards be sent to my wallet automatically?",
                  "Yes, optionally. The worker can call an on-chain `claim_push` instruction each cycle: the pool authority settles your accrued rewards into your SPL account using the same math as a normal claim — you do not sign, and payouts still must go to your ATA (enforced by the program). Manual Claim in the UI always works too.",
                ],
                [
                  "What happens if a basket token goes to zero?",
                  "You still hold whatever you've already claimed. The worker will simply stop allocating to that token on the next rebalance once its score falls out of the top five.",
                ],
                [
                  "Can the team change rules after the fact?",
                  "Instruction logic (multipliers, penalty %, scoring) is on-chain. Changes require a program upgrade, which is visible on-chain and — once we freeze upgrade authority — impossible.",
                ],
                [
                  "Is there a minimum stake?",
                  "No strict minimum at the program level, but very small stakes earn rounding-level rewards. Pick an amount that's meaningful to you.",
                ],
                [
                  "Do I need SOL to claim?",
                  "Yes, a small amount for rent + network fees. Claims create an associated token account for each reward the first time you claim it.",
                ],
              ].map(([q, a]) => (
                <div key={q}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: "#fff", marginBottom: 5 }}>{q}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "rgba(255,255,255,.55)" }}>{a}</div>
                </div>
              ))}
            </div>
          </Card>
        </section>

        <div
          className="mono"
          style={{
            padding: "16px 6px",
            fontSize: 10.5,
            color: "rgba(255,255,255,.22)",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <span>POB500 docs · subject to updates</span>
          <span>Not financial advice</span>
        </div>
      </div>
    </div>
  );
}

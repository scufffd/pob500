/**
 * POB500 public staking widget — safe to embed on any site.
 * Fetches read-only aggregates from https://pob500.com/api/stake-public (no keys).
 *
 * Usage:
 *   <div id="pob500-stake-embed"></div>
 *   <script src="https://pob500.com/embed/pob500-stake-snippet.js" defer></script>
 *
 * Optional attributes on the script tag:
 *   data-api-base="https://pob500.com"   — override API host
 *   data-target="#pob500-stake-embed"    — CSS selector for mount node (default #pob500-stake-embed)
 */
(function () {
  var sc = document.currentScript;
  if (!sc) return;
  var base = (sc.getAttribute('data-api-base') || 'https://pob500.com').replace(/\/$/, '');
  var targetSel = sc.getAttribute('data-target') || '#pob500-stake-embed';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDays(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    return (Math.round(n * 10) / 10) + 'd';
  }

  function lockLine(rows) {
  function uiAmount(rawStr, decimals) {
    try {
      var d = decimals || 9;
      var neg = false;
      var s = String(rawStr || '0').replace(/^-/, function () { neg = true; return ''; });
      if (!/^\d+$/.test(s)) return '—';
      while (s.length <= d) s = '0' + s;
      var whole = s.slice(0, s.length - d) || '0';
      var frac = s.slice(s.length - d).replace(/0+$/, '');
      var out = whole.replace(/^0+(?=\d)/, '') || '0';
      if (frac) out += '.' + frac.slice(0, 4);
      return (neg ? '-' : '') + out;
    } catch (e) {
      return '—';
    }
  }

  function lockLine(rows) {
    if (!rows || !rows.length) return '—';
    return rows
      .map(function (r) {
        return esc(r.pct.toFixed(1)) + '% @' + esc(r.lockDays) + 'd';
      })
      .join(' · ');
  }

  var el = document.querySelector(targetSel);
  if (!el) return;

  el.innerHTML =
    '<div class="pob500-stake-widget" style="font-family:system-ui,sans-serif;font-size:14px;color:#e8e8e8;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px 16px;max-width:420px;">' +
    '<div style="opacity:.75;font-size:12px;margin-bottom:6px;">POB500 · on-chain stake</div>' +
    '<div style="opacity:.6;">Loading…</div></div>';

  fetch(base + '/api/stake-public', { credentials: 'omit' })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      var wrap = el.querySelector('.pob500-stake-widget') || el;
      if (!data || !data.ok || !data.pool || !data.pool.initialized) {
        wrap.innerHTML =
          '<div style="opacity:.75;font-size:12px;margin-bottom:6px;">POB500 · on-chain stake</div>' +
          '<div style="opacity:.85;">Staking data unavailable.</div>' +
          '<a href="' +
          esc(data && data.stakeUrl ? data.stakeUrl : 'https://pob500.com/#stake') +
          '" style="color:#5cf;margin-top:8px;display:inline-block;">Open pob500.com</a>';
        return;
      }
      var p = data.pool;
      var dec = p.stakeDecimals != null ? p.stakeDecimals : 9;
      var stakedUi = uiAmount(p.totalStaked, dec);
      var pct = p.approxPctSupplyStaked != null ? p.approxPctSupplyStaked.toFixed(1) + '% of mint supply' : null;
      var avg = p.avgLockDaysAmountWeighted != null ? fmtDays(p.avgLockDaysAmountWeighted) + ' avg lock (by amount)' : null;
      var dist = lockLine(p.lockDistributionByAmount);

      var html = '';
      html += '<div style="opacity:.75;font-size:12px;margin-bottom:8px;">POB500 · on-chain stake</div>';
      html += '<div style="font-weight:700;font-size:18px;margin-bottom:4px;">' + esc(stakedUi) + ' <span style="opacity:.65;font-weight:500;font-size:13px;">staked</span></div>';
      if (pct) html += '<div style="opacity:.85;margin-bottom:6px;">' + esc(pct) + '</div>';
      html += '<div style="opacity:.8;font-size:13px;margin-bottom:4px;">' + esc(String(p.uniqueStakers)) + ' wallets · ' + esc(String(p.activePositions)) + ' open positions</div>';
      if (avg) html += '<div style="opacity:.75;font-size:12px;margin-bottom:8px;">' + esc(avg) + '</div>';
      html += '<div style="font-size:12px;opacity:.85;line-height:1.45;margin-bottom:10px;"><span style="opacity:.6">By lock: </span>' + dist + '</div>';
      html +=
        '<a href="' +
        esc(data.stakeUrl || 'https://pob500.com/#stake') +
        '" style="color:#5cf;font-size:13px;font-weight:600;">Stake on pob500.com →</a>';
      html +=
        '<div style="margin-top:10px;font-size:10px;opacity:.45;">Updated ' +
        esc(data.updatedAt || p.snapshotAt || '') +
        '</div>';
      wrap.innerHTML = html;
    })
    .catch(function () {
      var wrap = el.querySelector('.pob500-stake-widget') || el;
      wrap.innerHTML =
        '<div style="opacity:.75;font-size:12px;margin-bottom:6px;">POB500 · on-chain stake</div>' +
        '<div style="opacity:.85;">Could not load stats.</div>' +
        '<a href="https://pob500.com/#stake" style="color:#5cf;margin-top:8px;display:inline-block;">Open pob500.com</a>';
    });
})();

'use strict';

/**
 * Lightweight static server for POBINDEX build + last JSON snapshot API.
 */

const path = require('path');
const express = require('express');
const fs = require('fs');
const config = require('./config');
const {
  BASKET_FILE,
  loadCurrentBasket,
  minutesUntilRefresh,
} = require('./basket');
const { validateRewardMint } = require('./token-validator');
const {
  newNonce,
  buildSignableMessage,
  getPreference,
  savePreference,
  MAX_ALLOCATIONS,
  MESSAGE_PREFIX,
  COMPOUND_LOCK_TIERS,
} = require('./reward-prefs');
const { readPayoutLedger } = require('./personalized-distribute');

const PORT = parseInt(process.env.POBINDEX_SERVER_PORT || '3050', 10);
const HOST = process.env.LISTEN_HOST || '0.0.0.0';

// Worker now lives at POBINDEX/pobindex-worker/src — UI_ROOT is POBINDEX/.
const UI_ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(UI_ROOT, 'dist');
const PUBLIC = path.join(UI_ROOT, 'public');

const app = express();
app.use(express.json({ limit: '32kb' }));

/** CORS for public partner endpoints (no secrets — on-chain addresses + aggregates only). */
function allowPartnerCors(_req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
}

app.options('/api/stake-public', allowPartnerCors, (_req, res) => res.sendStatus(204));

app.get('/api/stake-public', allowPartnerCors, (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(config.POBINDEX_DATA_JSON, 'utf8'));
    const pool = raw.pool;
    const out = {
      ok: true,
      updatedAt: raw.updatedAt || null,
      tokenSymbol: 'POB500',
      stakeUrl: 'https://pob500.com/#stake',
      programId: raw.stakeProgramId || pool?.programId || null,
      stakeMint: raw.stakeMintAddress || pool?.stakeMint || null,
      stakingPool: raw.stakingPool || pool?.pool || null,
      pool,
      links: {
        stakeApp: 'https://pob500.com/#stake',
        github: 'https://github.com/scufffd/pob500',
      },
    };
    if (!pool || pool.initialized === false) {
      out.ok = false;
      out.reason = 'pool_not_initialized';
    }
    res.type('json').send(JSON.stringify(out));
  } catch (e) {
    res.status(500).json({ ok: false, error: 'read_failed', message: e.message });
  }
});

app.get('/api/pobindex', (req, res) => {
  const p = config.POBINDEX_DATA_JSON;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    res.type('json').send(raw);
  } catch (_) {
    res.status(404).json({ error: 'snapshot_not_found', path: p });
  }
});

app.get('/api/basket', (_req, res) => {
  try {
    const raw = fs.readFileSync(BASKET_FILE, 'utf8');
    res.type('json').send(raw);
  } catch (_) {
    res.status(404).json({ error: 'basket_not_found', path: BASKET_FILE });
  }
});

// ── Personalized reward preferences ──────────────────────────────────────────
app.get('/api/reward-pref/:wallet', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    res.json(getPreference(wallet));
  } catch (e) {
    res.status(400).json({ error: e.code || 'lookup_failed', message: e.message });
  }
});

app.get('/api/reward-pref/:wallet/payouts', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    const limit = Math.min(500, parseInt(String(req.query.limit || '100'), 10) || 100);
    res.json({ wallet, payouts: readPayoutLedger({ wallet, limit }) });
  } catch (e) {
    res.status(500).json({ error: 'payouts_failed', message: e.message });
  }
});

app.post('/api/reward-pref/nonce', (req, res) => {
  try {
    const wallet = String(req.body?.wallet || '').trim();
    const nonce = newNonce(wallet);
    const issuedAt = Date.now();
    const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
    const mode = req.body?.mode === 'custom' ? 'custom' : 'auto';
    const compound = req.body?.compound && typeof req.body.compound === 'object'
      ? {
        enabled: req.body.compound.enabled === true,
        lockDays: Number(req.body.compound.lockDays) || 0,
      }
      : { enabled: false, lockDays: 0 };
    const message = buildSignableMessage({
      wallet,
      mode,
      allocations: allocations.map((a) => ({ mint: a.mint, pct: Number(a.pct) })),
      compound,
      nonce,
      issuedAt,
    });
    res.json({
      wallet,
      nonce,
      issuedAt,
      message,
      messagePrefix: MESSAGE_PREFIX,
      maxAllocations: MAX_ALLOCATIONS,
      compoundLockTiers: COMPOUND_LOCK_TIERS,
    });
  } catch (e) {
    res.status(400).json({ error: e.code || 'nonce_failed', message: e.message });
  }
});

app.post('/api/reward-pref/validate', async (req, res) => {
  try {
    const mint = String(req.body?.mint || '').trim();
    const result = await validateRewardMint(mint);
    res.json(result);
  } catch (e) {
    res.status(400).json({
      error: e.code || 'validation_failed',
      message: e.message,
      detail: e.detail || null,
    });
  }
});

app.post('/api/reward-pref/save', async (req, res) => {
  try {
    const compound = req.body?.compound && typeof req.body.compound === 'object'
      ? {
        enabled: req.body.compound.enabled === true,
        lockDays: Number(req.body.compound.lockDays) || 0,
      }
      : { enabled: false, lockDays: 0 };
    const result = await savePreference({
      wallet: String(req.body?.wallet || '').trim(),
      mode: req.body?.mode === 'custom' ? 'custom' : 'auto',
      allocations: Array.isArray(req.body?.allocations) ? req.body.allocations : [],
      compound,
      message: String(req.body?.message || ''),
      signature: String(req.body?.signature || ''),
      nonce: String(req.body?.nonce || ''),
      issuedAt: req.body?.issuedAt,
    });
    res.json({ ok: true, preference: result });
  } catch (e) {
    res.status(400).json({
      error: e.code || 'save_failed',
      message: e.message,
      detail: e.detail || null,
    });
  }
});

app.get('/api/health', (_req, res) => {
  const basket = loadCurrentBasket();
  let snapshotAgeSec = null;
  try {
    const stat = fs.statSync(config.POBINDEX_DATA_JSON);
    snapshotAgeSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
  } catch { /* no snapshot yet */ }
  res.json({
    ok: true,
    time: new Date().toISOString(),
    snapshotAgeSec,
    basket: basket
      ? {
        version: basket.version,
        createdAt: basket.createdAt,
        entries: basket.entries.length,
        minutesUntilRefresh: minutesUntilRefresh(basket),
      }
      : null,
  });
});

app.use(express.static(DIST, { index: 'index.html' }));
app.use('/pobindex-data.json', express.static(PUBLIC));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.sendFile(path.join(DIST, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`POBINDEX server http://${HOST}:${PORT} (dist: ${DIST})`);
});

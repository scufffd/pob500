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

const PORT = parseInt(process.env.POBINDEX_SERVER_PORT || '3050', 10);
const HOST = process.env.LISTEN_HOST || '0.0.0.0';

// Worker now lives at POBINDEX/pobindex-worker/src — UI_ROOT is POBINDEX/.
const UI_ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(UI_ROOT, 'dist');
const PUBLIC = path.join(UI_ROOT, 'public');

const app = express();

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

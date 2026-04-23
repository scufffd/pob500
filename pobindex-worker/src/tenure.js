'use strict';

/**
 * SQLite-backed tenure: first cycle a wallet appears above min balance starts
 * the clock. Wallets absent from the qualifying set are removed (reset on re-entry).
 *
 * Multiplier tiers (env TENURE_TIERS as JSON optional):
 *   default: <30d 1.0, <90d 1.25, <180d 1.5, >=180d 2.0
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { logEvent } = require('./utils');

function defaultTiers() {
  const raw = process.env.TENURE_TIERS;
  if (raw) return JSON.parse(raw);
  return [
    { minDays: 0, mult: 1.0 },
    { minDays: 30, mult: 1.25 },
    { minDays: 90, mult: 1.5 },
    { minDays: 180, mult: 2.0 },
  ];
}

function multiplierForDays(days, tiers) {
  let m = tiers[0].mult;
  for (const t of tiers) {
    if (days >= t.minDays) m = t.mult;
  }
  return m;
}

class TenureDb {
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS holder_tenure (
        wallet TEXT PRIMARY KEY,
        first_seen_at INTEGER NOT NULL,
        last_balance TEXT NOT NULL
      );
    `);
    this.tiers = defaultTiers();
  }

  /**
   * Sync DB to current qualifying holder set; return holders with rewardWeight.
   * @param {Array<{ address: string, balance: bigint }>} holders
   */
  applyTenure(holders) {
    const now = Math.floor(Date.now() / 1000);
    const qualifying = new Set(holders.map(h => h.address));

    const del = this.db.prepare('DELETE FROM holder_tenure WHERE wallet = ?');
    const allRows = this.db.prepare('SELECT wallet FROM holder_tenure').all();
    for (const { wallet } of allRows) {
      if (!qualifying.has(wallet)) del.run(wallet);
    }

    const insNew = this.db.prepare(`
      INSERT INTO holder_tenure (wallet, first_seen_at, last_balance)
      VALUES (?, ?, ?)
    `);
    const updBal = this.db.prepare(
      'UPDATE holder_tenure SET last_balance = ? WHERE wallet = ?'
    );
    const sel = this.db.prepare('SELECT first_seen_at FROM holder_tenure WHERE wallet = ?');

    const out = [];
    for (const h of holders) {
      const row0 = sel.get(h.address);
      if (!row0) insNew.run(h.address, now, h.balance.toString());
      else updBal.run(h.balance.toString(), h.address);
      const row = sel.get(h.address);
      const firstSeen = row.first_seen_at;
      const tenureDays = (now - firstSeen) / 86400;
      const mult = multiplierForDays(tenureDays, this.tiers);
      const multBps = Math.round(mult * 10_000);
      const rewardWeight = (h.balance * BigInt(multBps)) / 10_000n;
      if (rewardWeight <= 0n) continue;
      out.push({
        address: h.address,
        balance: h.balance,
        rewardWeight,
        tenureDays: Math.floor(tenureDays * 10) / 10,
        tenureMultiplier: mult,
      });
    }

    logEvent('info', 'Tenure weights applied', {
      holders: holders.length,
      weighted: out.length,
    });

    return out;
  }

  close() {
    this.db.close();
  }
}

module.exports = { TenureDb, multiplierForDays };

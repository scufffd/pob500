'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? LOG_LEVELS.info;

function logEvent(level, message, data = {}) {
  if ((LOG_LEVELS[level] ?? 0) < MIN_LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const dataStr = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}${dataStr}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

function isNonRetryable(err) {
  const msg = err.message || '';
  return /401|403|Unauthorized|forbidden|Missing required environment variable/i.test(msg);
}

async function retry(fn, { retries = 3, baseDelayMs = 1000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (isNonRetryable(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (attempt < retries) {
        logEvent('warn', `${label} failed (${attempt}/${retries}), retry in ${delay}ms`, { error: err.message });
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

function lamportsToSol(lamports) {
  return Number(lamports) / 1e9;
}

function formatSol(lamports, decimals = 6) {
  return lamportsToSol(lamports).toFixed(decimals) + ' SOL';
}

module.exports = {
  logEvent,
  sleep,
  withTimeout,
  retry,
  lamportsToSol,
  formatSol,
};

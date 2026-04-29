'use strict';

const { PublicKey } = require('@solana/web3.js');

/**
 * Printr Solana program (see mint txs on Solscan — "print" suffix).
 * SPL balances whose *authority* account is this program are protocol custody:
 * bonding reserves, AMM/DBC vaults, and POB staking escrows, all in one bucket.
 * We use this as a proxy for "% showing belief" in the absence of a public
 * Printr API field that splits stake-only from curve inventory.
 */
const PRINTR_SVM_PROGRAM_ID = 'T8HsGYv7sMk3kTnyaRqZrbRPuntYzdh12evXBkprint';

function _chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * % of total mint supply held in token accounts whose owner authority is
 * a PDA owned by the Printr program, among the 20 largest accounts (RPC).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} mintStr
 * @returns {Promise<{ stakedPct: number|null, printrLargestHolders: number, error?: string }>}
 */
async function fetchPrintrCustodyStakePct(connection, mintStr) {
  let mint;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    return { stakedPct: null, printrLargestHolders: 0, error: 'invalid_mint' };
  }
  if ((process.env.POB_STAKE_FETCH || 'on').toLowerCase() === '0') {
    return { stakedPct: null, printrLargestHolders: 0, error: 'disabled' };
  }

  let supply;
  let largest;
  try {
    [supply, largest] = await Promise.all([
      connection.getTokenSupply(mint),
      connection.getTokenLargestAccounts(mint),
    ]);
  } catch (e) {
    return { stakedPct: null, printrLargestHolders: 0, error: e.message || 'rpc' };
  }

  const total = BigInt(supply.value.amount);
  if (total <= 0n) return { stakedPct: 0, printrLargestHolders: 0 };

  const ownerToProgram = new Map();
  const rows = largest.value || [];

  /** @type {{ amount: string, owner: string }[]} */
  const parsedRows = [];
  for (const part of _chunk(rows, 10)) {
    const pas = await Promise.all(part.map((v) => connection.getParsedAccountInfo(v.address)));
    for (let j = 0; j < part.length; j++) {
      const v = part[j];
      const p = pas[j].value;
      const owner = p?.data?.parsed?.info?.owner;
      if (!owner) continue;
      parsedRows.push({ amount: String(v.amount), owner: String(owner) });
    }
  }

  const ownerList = [...new Set(parsedRows.map((r) => r.owner))].map((s) => new PublicKey(s));
  const OWNER_CHUNK = 99;
  for (let i = 0; i < ownerList.length; i += OWNER_CHUNK) {
    const slice = ownerList.slice(i, i + OWNER_CHUNK);
    const infos = await connection.getMultipleAccountsInfo(slice, 'confirmed');
    for (let k = 0; k < slice.length; k++) {
      const id = infos[k]?.owner?.toBase58() || '';
      ownerToProgram.set(slice[k].toBase58(), id);
    }
  }

  let staked = 0n;
  let printrLargestHolders = 0;
  for (const row of parsedRows) {
    if ((ownerToProgram.get(row.owner) || '') !== PRINTR_SVM_PROGRAM_ID) continue;
    staked += BigInt(row.amount);
    printrLargestHolders++;
  }

  const bps = Number((staked * 10_000n) / total) / 100;
  const stakedPct = Math.min(100, Math.round(bps * 10) / 10);
  return { stakedPct, printrLargestHolders };
}

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('./printr').PrintrCandidate[]} candidates
 * @param {{ delayMs?: number }} [opts]
 */
async function attachStakingToCandidates(connection, candidates, opts = {}) {
  const delayMs = opts.delayMs ?? 60;
  const out = [];
  for (const c of candidates) {
    const m = c.mint;
    const { stakedPct, printrLargestHolders } = await fetchPrintrCustodyStakePct(connection, m);
    out.push({
      ...c,
      stakedPct: stakedPct == null || Number.isNaN(stakedPct) ? null : stakedPct,
      printrLargestHolders: printrLargestHolders || 0,
    });
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}

module.exports = {
  PRINTR_SVM_PROGRAM_ID,
  fetchPrintrCustodyStakePct,
  attachStakingToCandidates,
};

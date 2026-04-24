#!/usr/bin/env node
'use strict';

/**
 * One-shot: push accrued pool rewards to every staker's wallet (claim_push).
 * Same logic as the worker when POB_STAKE_AUTO_PUSH_CLAIMS=1.
 *
 *   npm run stake:push-rewards
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const config = require('../src/config');
const { pushRewardClaims } = require('../src/stake-push-rewards');

async function main() {
  // Treasury (Bank) pays tx fees + ATA rent. Authority (pool.authority, set at
  // initialize_pool) only signs the claim_push ix. Falls back to a single-wallet
  // setup if ADMIN_PRIVATE_KEY is unset.
  const treasury = config.parsePrivateKey(config.requireEnv('TREASURY_PRIVATE_KEY'));
  const authority = process.env.ADMIN_PRIVATE_KEY
    ? config.parsePrivateKey(process.env.ADMIN_PRIVATE_KEY)
    : treasury;
  const out = await pushRewardClaims({ treasury, authority });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

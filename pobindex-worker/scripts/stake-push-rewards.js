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
  // `claim_push` requires the pool authority (set at initialize_pool). We use
  // ADMIN_PRIVATE_KEY when present, otherwise fall back to TREASURY_PRIVATE_KEY
  // for the single-wallet setup where the treasury is also the pool authority.
  const authority = config.parsePrivateKey(
    process.env.ADMIN_PRIVATE_KEY || config.requireEnv('TREASURY_PRIVATE_KEY'),
  );
  const out = await pushRewardClaims({ treasury: authority });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

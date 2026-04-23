#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { runCycle } = require('../src/runCycle');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const discoverOnly = process.argv.includes('--discover-only');
  try {
    const out = await runCycle({ dryRun, discoverOnly });
    console.log(JSON.stringify({ ok: true, dryRun, discoverOnly, ...out.snapshot }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();

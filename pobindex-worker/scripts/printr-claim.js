#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { claimViaPrintrTemplate } = require('../src/creator-sweep');

async function main() {
  try {
    const res = await claimViaPrintrTemplate();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(res, null, 2));
    if (res.attempted && res.simulation && res.simulation.err) process.exit(2);
    if (res.attempted === false) process.exit(3);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  }
}

main();

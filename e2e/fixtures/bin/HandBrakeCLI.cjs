#!/usr/bin/env node
// Test stand-in for HandBrakeCLI used by the e2e tests.
const fs = require('fs');
const a = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (a[0] === '--scan') {
    console.error('+ title 1:\n  + duration: 01:45:12');
    return;
  }
  const out = a[a.indexOf('-o') + 1];
  for (let i = 0; i <= 20; i++) {
    process.stdout.write(`\rEncoding: task 1 of 1, ${(i * 5).toFixed(2)} % (90 fps)`);
    await sleep(60);
  }
  fs.writeFileSync(out, Buffer.alloc(2_000_000));
})();

#!/usr/bin/env node
// Test stand-in for MakeMKV's makemkvcon (robot mode) used by the e2e tests.
const fs = require('fs'),
  path = require('path');
const a = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (a.includes('disc:9999')) {
    console.log('DRV:0,2,999,1,"USB DVD","YOUNG_FRANKENSTEIN","/dev/rdisk4"');
    return;
  }
  if (a.includes('info')) {
    console.log(
      'CINFO:2,0,"YOUNG_FRANKENSTEIN"\nTCOUNT:2\nTINFO:0,8,0,"24"\nTINFO:0,9,0,"1:45:12"\nTINFO:0,11,0,"4939726848"\nTINFO:1,9,0,"0:02:10"\nTINFO:1,11,0,"80000000"',
    );
    return;
  }
  if (a.includes('mkv')) {
    const dir = a[a.length - 1];
    for (let i = 0; i <= 20; i++) {
      console.log(`PRGV:${i},${i * 3276},65536`);
      await sleep(60);
    }
    fs.writeFileSync(path.join(dir, 'title_t00.mkv'), 'x');
    console.log('MSG:5036,0,1,"Copy complete. 1 titles saved."');
  }
})();

import test from 'node:test';
import assert from 'node:assert/strict';
import {PlatformClient} from '../client/platform-client.mjs';

test('default fetch retains the global receiver required by Window', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = function (url) {
      assert.equal(this, globalThis, 'native browser fetch must not receive PlatformClient as this');
      assert.equal(url, '/api/v1/session');
      return Promise.resolve(new Response(JSON.stringify({authenticated:false,capabilities:[],csrf:'a'.repeat(64)}), {status:200,headers:{'Content-Type':'application/json'}}));
    };
    const client = new PlatformClient();
    assert.deepEqual(await client.refreshSession(), {authenticated:false,user:null,capabilities:[]});
  } finally {globalThis.fetch = original;}
});

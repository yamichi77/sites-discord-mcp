import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
await build({entryPoints:['entry.ts'],outfile:'.local/public-worker.mjs',bundle:true,packages:'external',platform:'node',format:'esm'});
const {default:worker}=await import('./.local/public-worker.mjs');
test('public entry excludes owner enrollment and identity endpoints even without DB',async()=>{
  for(const path of ['/setup','/setup/identity','/setup/enroll','/setup/status']){
    const response=await worker.fetch(new Request('https://fixture.example'+path),{});
    assert.equal(response.status,404);
  }
});

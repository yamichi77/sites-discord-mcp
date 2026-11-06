import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const manifest=await readJson('.openai/hosting.json');
assert.deepEqual(await readJson('dist/.openai/hosting.json'),manifest);
assert.equal(manifest.d1,'DB');assert.equal(manifest.r2,null);
assert.equal(manifest.static,undefined);
assert.equal(manifest.capabilities,undefined); // /api/mcp, not managed /mcp.
const journal=await readJson('drizzle/meta/_journal.json');
assert.deepEqual(await readJson('dist/.openai/drizzle/meta/_journal.json'),journal);
assert.equal(journal.dialect,'sqlite');
const sqlFiles=(await readdir('drizzle')).filter(x=>x.endsWith('.sql')).sort();
assert.deepEqual(journal.entries.map(x=>`${x.tag}.sql`).sort(),sqlFiles);
for(const [idx,entry] of journal.entries.entries()) {
  assert.equal(entry.idx,idx);assert.ok(Number.isSafeInteger(entry.when));
  const filename=`${entry.tag}.sql`;
  const sql=await readFile(`drizzle/${filename}`,'utf8');
  assert.equal(await readFile(`dist/.openai/drizzle/${filename}`,'utf8'),sql);
  assert.ok(sql.trim());
}
const source=await readFile('dist/server/index.js','utf8');
assert.ok(source.includes('https://example.invalid'));
const bundle=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
assert.equal(typeof bundle.default?.fetch,'function');
console.log(`Local artifact verified; project_id ${manifest.project_id?'present':'absent (registration required before publication)'}`);

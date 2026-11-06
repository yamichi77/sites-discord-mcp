import { build } from 'esbuild';
import { mkdir, readdir, copyFile, cp, readFile } from 'node:fs/promises';
// No deployment, registration, secret generation or migration execution.
// Match the Sites Worker ESM starter's dist/server/index.js output contract.
const files=await readdir('drizzle').catch(()=>[]);
if(!files.some(name=>name.endsWith('.sql')))throw Error('Provider-generated D1 migrations are missing; do not package/deploy');
await mkdir('dist/server',{recursive:true});
// The package's workerd password export selects node:crypto. Use its published
// Web/browser fallback instead; password authentication is disabled. No Node
// module is silently externalized and nodejs_compat is not required by this build.
const {stage}=JSON.parse(await readFile('deployment-stage.json','utf8'));
if(!['owner-enrollment','oauth'].includes(stage))throw Error('Unknown deployment stage');
await build({entryPoints:[stage==='owner-enrollment'?'enrollment-entry.ts':'entry.ts'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',conditions:['browser'],sourcemap:false});
await mkdir('dist/.openai',{recursive:true});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
await import('./validate-artifact.mjs');

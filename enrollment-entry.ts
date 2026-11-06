import './zod-bootstrap.js';
import worker from './worker.js';
import {setup,SITE_ORIGIN} from './owner-store.js';
import {BoundaryError,limitBody} from './policy.mjs';
import type {Env} from './auth.js';
// Private-only staging entry. Public build uses entry.ts, with no setup handler.
export default {async fetch(request:Request,env:Env){
  try{const path=new URL(request.url).pathname;
    if(path==='/setup/identity')return new Response(null,{status:404});
    if(path==='/setup'||path.startsWith('/setup/'))return await setup(await limitBody(request),env.DB,env.APP_URL||SITE_ORIGIN);
    return await worker.fetch(request,env);
  }catch(e){return Response.json({error:e instanceof BoundaryError?e.message:'Request unavailable'},{status:e instanceof BoundaryError?e.status:503,headers:{'cache-control':'no-store'}});}
}};

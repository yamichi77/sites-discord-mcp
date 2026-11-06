export class BoundaryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function canonicalOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.username || u.password) throw new BoundaryError(503,'Invalid origin configuration');
  return u.origin;
}
export function ownerId(configured) {
  if (typeof configured !== 'string' || !configured.trim() || configured !== configured.trim() || configured.length > 2048) throw new BoundaryError(503,'Owner configuration required');
  return `sites:${configured}`;
}
export function dispatchOwner(headers, configured) {
  const expected = ownerId(configured);
  const id = headers.get('oai-authenticated-user-id');
  if (!id) throw new BoundaryError(401,'Sign in with ChatGPT');
  if (`sites:${id}` !== expected) throw new BoundaryError(403,'Owner only');
  const email = headers.get('oai-authenticated-user-email');
  if (!email) throw new BoundaryError(401,'Verified identity required');
  return { id: expected, email };
}
export function checkOwnerSubject(subject, configured) {
  if (subject !== ownerId(configured)) throw new BoundaryError(403,'Owner only');
}
export function sameOriginRequest(request, origin, requireOrigin = false) {
  if (new URL(request.url).origin !== origin) throw new BoundaryError(400,'Invalid host');
  const supplied = request.headers.get('origin');
  if ((requireOrigin || supplied) && supplied !== origin) throw new BoundaryError(403,'Invalid origin');
}
export function signedQuery(search) {
  const p = new URLSearchParams(search);
  const embedded = p.get('oauth_query');
  if (embedded !== null) { if (p.getAll('oauth_query').length !== 1) throw new BoundaryError(400,'Ambiguous query'); return embedded; }
  const allowed = new Set(['sig','ba_param',...p.getAll('ba_param')]);
  return new URLSearchParams([...p].filter(([key])=>allowed.has(key))).toString();
}
export function checkConsentScope(params, origin) {
  const scopes = (params.get('scope') || '').split(' ').filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== 'discord' || params.get('resource') !== `${origin}/api/mcp` || params.getAll('resource').length !== 1) throw new BoundaryError(400,'Only this Discord resource is available');
  if (!params.get('client_id') || !params.get('redirect_uri')) throw new BoundaryError(400,'Incomplete authorization');
}
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export async function limitBody(request, maximum = 65536) {
  if (!request.body) return request;
  const reader=request.body.getReader(); const chunks=[]; let size=0;
  while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>maximum){await reader.cancel();throw new BoundaryError(413,'Body too large');} chunks.push(value); }
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return new Request(request.url,{method:request.method,headers:request.headers,body:bytes});
}

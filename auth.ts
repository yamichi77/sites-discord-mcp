import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { canonicalOrigin, ownerId, dispatchOwner, checkConsentScope } from './policy.mjs';

export interface Env { APP_URL: string; OWNER_SITES_ID: string; BETTER_AUTH_SECRET: string; DB: D1Database; DISCORD_CONFIG_KEY?: string }
export function createAuth(env: Env) {
  const origin = canonicalOrigin(env.APP_URL);
  ownerId(env.OWNER_SITES_ID);
  if (!env.DB || !env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw Error('Runtime configuration missing');
  return betterAuth({
    appName: 'Owner-only Discord', baseURL: origin, basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET, database: env.DB,
    trustedOrigins: [origin], emailAndPassword: { enabled: false },
    disabledPaths: ['/token','/delete-user','/update-user','/change-email'],
    advanced: { useSecureCookies: true, defaultCookieAttributes: { secure:true,httpOnly:true,sameSite:'lax' } },
    session: { expiresIn: 3600, cookieCache: { enabled:false } },
    rateLimit: { enabled:true,window:60,max:30,storage:'database' },
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage:'/sign-in',consentPage:'/consent',resource:`${origin}/api/mcp`,
        scopes:['discord'],grantTypes:['authorization_code'],accessTokenExpiresIn:300,
        allowDynamicClientRegistration:false,allowUnauthenticatedClientRegistration:false,
        storeClientSecret:'hashed',
        clientRegistrationDefaultScopes:['discord'],clientRegistrationDefaultApplicationType:'infer',
        clientPrivileges:async({user,action})=>user?.id===ownerId(env.OWNER_SITES_ID)&&['create','list','rotate','update'].includes(action),
      }),
      {
        id:'sites-owner-bridge',
        endpoints: {
          sitesAdminSession: createAuthEndpoint('/sites-admin-session',{method:'POST'},async ctx=>{
            const identity=dispatchOwner(ctx.request!.headers,env.OWNER_SITES_ID);
            let user=await ctx.context.internalAdapter.findUserById(identity.id);
            if(!user)user=await ctx.context.internalAdapter.createUser({id:identity.id,email:identity.email,emailVerified:true,name:'Owner'},{method:'sites'});
            const session=await ctx.context.internalAdapter.createSession(user.id);
            if(!session)throw new APIError('INTERNAL_SERVER_ERROR',{message:'Session unavailable'});
            await setSessionCookie(ctx,{session,user});
            return ctx.redirect('/manage');
          }),
          sitesOwnerSession: createAuthEndpoint('/sites-owner-session',{method:'GET'},async ctx=>{
            // Trusted ONLY when deployed behind Sites dispatch. There is no public
            // development server or alternative identity/bypass query parameter.
            const identity=dispatchOwner(ctx.request!.headers,env.OWNER_SITES_ID);
            const query=new URL(ctx.request!.url).searchParams.get('oauth_query') || '';
            if (!await verifyOAuthQueryParams(query,(await ctx.context).secret)) throw new APIError('BAD_REQUEST',{message:'Invalid authorization request'});
            checkConsentScope(new URLSearchParams(query),origin);
            let user=await ctx.context.internalAdapter.findUserById(identity.id);
            if(!user) user=await ctx.context.internalAdapter.createUser({id:identity.id,email:identity.email,emailVerified:true,name:'Owner'},{method:'sites'});
            const session=await ctx.context.internalAdapter.createSession(user.id);
            if(!session)throw new APIError('INTERNAL_SERVER_ERROR',{message:'Session unavailable'});
            await setSessionCookie(ctx,{session,user});
            // Re-enter the provider after login so it creates its pending consent
            // transaction. Sending the user straight to consent skips that state.
            const resume=new URLSearchParams(query);
            resume.delete('sig');resume.delete('ba_param');
            if(resume.get('prompt')==='login')resume.delete('prompt');
            return ctx.redirect(`/api/auth/oauth2/authorize?${resume}`);
          })
        }
      }
    ]
  });
}

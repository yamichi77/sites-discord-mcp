create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
--> statement-breakpoint
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date, "alg" text, "crv" text);
--> statement-breakpoint
create table "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" integer, "skipConsent" integer, "enableEndSession" integer, "subjectType" text, "scopes" text, "clientCredentialsScopes" text, "userId" text references "user" ("id") on delete cascade, "createdAt" date, "updatedAt" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" text not null, "postLogoutRedirectUris" text, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" integer, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" text, "responseTypes" text, "requirePKCE" integer, "dpopBoundAccessTokens" integer, "referenceId" text, "metadata" text);
--> statement-breakpoint
create table "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" text, "customClaims" text, "dpopBoundAccessTokensRequired" integer, "disabled" integer, "createdAt" date, "updatedAt" date, "policyVersion" integer, "metadata" text);
--> statement-breakpoint
create table "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" text, "createdAt" date);
--> statement-breakpoint
create table "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "rotatedAt" date, "rotationReplayResponse" text, "rotationReplayExpiresAt" date, "authTime" date, "confirmation" text, "scopes" text not null);
--> statement-breakpoint
create table "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" text, "requestedUserInfoClaims" text, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" date not null, "createdAt" date not null, "revoked" date, "confirmation" text, "scopes" text not null);
--> statement-breakpoint
create table "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" text, "requestedUserInfoClaims" text, "scopes" text not null, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table "oauthClientAssertion" ("id" text not null primary key, "expiresAt" date not null);
--> statement-breakpoint
create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
--> statement-breakpoint
create index "session_userId_idx" on "session" ("userId");
--> statement-breakpoint
create index "account_userId_idx" on "account" ("userId");
--> statement-breakpoint
create index "verification_identifier_idx" on "verification" ("identifier");
--> statement-breakpoint
create index "oauthClient_userId_idx" on "oauthClient" ("userId");
--> statement-breakpoint
create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");
--> statement-breakpoint
create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");
--> statement-breakpoint
create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");
--> statement-breakpoint
create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");
--> statement-breakpoint
create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");
--> statement-breakpoint
create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");
--> statement-breakpoint
create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");
--> statement-breakpoint
create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");
--> statement-breakpoint
create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");
--> statement-breakpoint
create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");
--> statement-breakpoint
create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");
--> statement-breakpoint
create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");
--> statement-breakpoint
create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");
--> statement-breakpoint
create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");
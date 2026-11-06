# Sites Discord MCP

An owner-only Discord REST MCP server implemented as a Sites Worker with D1 and Better Auth. This is a sanitized source snapshot, not a downloadable ChatGPT plugin package and not a configured service.

## License

MIT License. Copyright (c) 2026 yamichi77. See [LICENSE](LICENSE). Dependencies retain their own licenses; dependency binaries and bundled output are not included.

## Configuration

Create your own Site and retain its new project identity in `.openai/hosting.json`. The supplied manifest declares only the `DB` D1 binding. No production project ID, credentials, database contents, or existing Git history are included.

Set `APP_URL` to your own exact HTTPS origin. `https://example.invalid` is a deliberate non-operational fallback. Configure a new `BETTER_AUTH_SECRET` and a new 32-byte hexadecimal `DISCORD_CONFIG_KEY` in runtime secret storage; never commit them. The owner identity is enrolled in D1, not copied from this repository.

The initial build stage is `owner-enrollment`. Keep the Site owner-private while setting up schema migrations and enrolling the owner at `/setup`. After enrollment and runtime configuration, change `deployment-stage.json` to `oauth`, build again, and verify setup endpoints are unavailable. Decide external access separately. This source assumes trusted Sites identity headers and is not safe to expose behind a host that accepts forged identity headers.

Enter your own Discord Bot token, guild, Bot user, permitted channels and human IDs in the authenticated settings page. Saving settings does not validate Discord connectivity. The enable checkbox explicitly enables access. Do not use another person's live endpoint or credentials.

## OAuth and clients

MCP endpoint: `/api/mcp`. Authorization endpoint: `/api/auth/oauth2/authorize`. Token endpoint: `/api/auth/oauth2/token`. Scope: `discord`; resource: your origin followed by `/api/mcp`.

Manual client registration only. The Muse preset creates a public client with authentication method `none`, no secret, PKCE S256, and callback `https://agent.meta.ai/api/hatch/oauth/callback`. Actual Muse interoperability is unverified. The Claude preset is a separate confidential client with callback `https://claude.ai/api/mcp/auth_callback`. Access tokens last five minutes without refresh. Do not invent secrets for public clients or bypass authorization checks.

## Tools and limits

Six tools support history, individual message reads, sending, replies, and restricted reactions. Writes require an explicit caller instruction. Guild/channel allowlists, owner checks, idempotency, rate limits, and freshness checks apply. Returned Discord text is untrusted data. This server has no Gateway notifications or peer-Bot automation.

## Development

Use `npm ci`, `npm run typecheck`, and `npm run build`. Run `node --test policy.test.mjs setup.test.mjs discord.test.mjs` and `npm run test:integration`. Integration tests use synthetic identities, ephemeral credentials, local D1, and mocked Discord. A workerd variant uses `FIXTURE_RUNTIME=workerd` after building.

Preparation checks passed: TypeScript reported zero diagnostics; owner-enrollment and OAuth builds passed artifact validation; six policy checks and one public-entry check passed. These checks reused the original checkout's installed dependencies through external verification helpers; a clean install was not established. `npm ci` was blocked by an OS directory-creation denial, and the Discord/D1 test was blocked by a localhost connection denial. The full integration suite remains unverified in this preparation environment.

Re-run `npm ci`, the standard typecheck/build commands, and the complete test suite in a permitted clean environment before release. The external verification helpers are not part of this source package. Never include `dist`, `.local`, caches, logs, `.env*`, database dumps, dependency binaries, or old Git history in the public source archive.

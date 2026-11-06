CREATE TABLE discord_config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), guild_id TEXT NOT NULL, bot_id TEXT NOT NULL, channels TEXT NOT NULL, authors TEXT NOT NULL, encrypted_token TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE discord_writes (key_hash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE discord_budget (window INTEGER PRIMARY KEY, count INTEGER NOT NULL);

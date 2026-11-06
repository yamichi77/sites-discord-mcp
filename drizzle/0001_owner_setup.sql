CREATE TABLE site_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), sites_id TEXT NOT NULL, created_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE action_nonce (digest TEXT PRIMARY KEY, sites_id TEXT NOT NULL, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL);

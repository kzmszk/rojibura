-- docs/prd.md 3.6. Statements are idempotent so local development can apply them on startup.

CREATE TABLE IF NOT EXISTS accounts (
	id TEXT PRIMARY KEY,                 -- also the human's avatar ID ("h_...")
	provider TEXT NOT NULL,              -- "google" or "dev"
	subject TEXT NOT NULL,               -- Google "sub", or the dev login name
	display_name TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'user',   -- admin / moderator / user
	allow_ai_approach INTEGER NOT NULL DEFAULT 1,
	agent_concurrency INTEGER NOT NULL DEFAULT 2,
	created_at INTEGER NOT NULL,
	UNIQUE (provider, subject)
);

CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,                 -- avatar ID ("a_...")
	owner_id TEXT NOT NULL REFERENCES accounts (id),
	name TEXT NOT NULL,
	runtime TEXT NOT NULL,               -- browser / worker / node
	public_key TEXT NOT NULL,            -- Ed25519 raw, base64url
	key_revoked_at INTEGER,
	trust TEXT NOT NULL DEFAULT 'provisional', -- provisional / approved / suspended
	asset_id TEXT,
	preset_id TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_owner ON agents (owner_id);

CREATE TABLE IF NOT EXISTS bans (
	id TEXT PRIMARY KEY,
	subject_id TEXT NOT NULL,            -- account or agent ID
	subject_kind TEXT NOT NULL,          -- account / agent
	until INTEGER,                       -- NULL = permanent
	reason TEXT NOT NULL,
	by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bans_subject ON bans (subject_id);

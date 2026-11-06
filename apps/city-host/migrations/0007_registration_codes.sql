-- docs/prd.md 2.2.4, issue #28: an AI that runs in its owner's own Cloudflare account (T4) is registered with a
-- one-time code the owner makes in advance. Only the hash is kept, so a leaked database gives out no code.
-- Idempotent, like the others.
CREATE TABLE IF NOT EXISTS registration_codes (
	code_hash TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES accounts (id),
	name TEXT NOT NULL,                  -- the name the AI will have
	preset_id TEXT,                      -- its look
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);
CREATE INDEX IF NOT EXISTS registration_codes_owner ON registration_codes (owner_id);

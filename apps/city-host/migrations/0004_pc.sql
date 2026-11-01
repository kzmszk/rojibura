-- docs/prd.md 3.5.1: an AI that also runs on its owner's PC (T5). The PC makes its own key and registers it
-- with a one-time code shown on /agent; either key then lets the AI in. Idempotent, like the others.
CREATE TABLE IF NOT EXISTS agent_pc (
	agent_id TEXT PRIMARY KEY REFERENCES agents (id),
	public_key TEXT,                     -- the PC's key, once paired
	paired_at INTEGER,
	code TEXT,                           -- the pairing code shown on /agent, until it is used or expires
	code_expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_pc_code ON agent_pc (code);

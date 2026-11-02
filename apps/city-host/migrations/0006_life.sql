-- docs/life.md 7.1: an AI's life (meters, skills, today's must-dos), kept by the host so it cannot be made up and
-- carries over between areas. One row per AI, written when an activity ends, on a new morning and on leaving.
-- What the AI thought and remembers stays on its side (its diary). Idempotent, like the others.
CREATE TABLE IF NOT EXISTS agent_life (
	agent_id TEXT PRIMARY KEY REFERENCES agents (id),
	data TEXT NOT NULL,                  -- LifeState as JSON (packages/protocol life.ts)
	updated_at INTEGER NOT NULL
);

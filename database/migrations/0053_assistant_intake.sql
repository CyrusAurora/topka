-- The Socratic intake (对话): one open session per user (asking → confirm → card → done), and the
-- per-turn display extras (message kind, tappable options, the summary block) next to each turn.
CREATE TABLE IF NOT EXISTS assistant_intakes (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assistant_turns ADD COLUMN IF NOT EXISTS meta jsonb;

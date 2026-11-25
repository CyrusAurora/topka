-- Per-account sign-in lockout (on top of the per-address rate limit). One row per attempted address,
-- known or not, so that a lock reveals nothing about whether an account exists. The address is stored
-- as its SHA-256, never in the clear. An attempt is counted before the password is checked, so
-- concurrent guesses from many addresses cannot slip past the threshold.
CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash          text PRIMARY KEY,
  -- Attempts since window_started_at that did not succeed (reset by a successful sign-in).
  attempts          integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  -- While in the future, every attempt is refused without checking the password.
  locked_until      timestamptz,
  -- Locks so far; each doubles the next lock's length (reset by success or a quiet day).
  lock_count        integer NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_throttle_updated_idx ON login_throttle (updated_at);

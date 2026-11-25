-- The reader's day turns itself: when every card of the day carries a mark, the server freezes the window
-- (day_since / day_until) until fresh_at, the next 08:00 Beijing (00:00 UTC), and then starts fresh there.
ALTER TABLE user_read_checkpoints ALTER COLUMN read_through DROP NOT NULL,
  ADD COLUMN day_since timestamptz,
  ADD COLUMN day_until timestamptz,
  ADD COLUMN fresh_at timestamptz;

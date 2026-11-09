-- The accounts the server made for companion-app identities that opened the app for the first time:
-- one signup request, one account, bound once. The signup id is the hash of the app identity, so
-- the identity itself never leaves the app's own backend.
CREATE TABLE mp_signups (
  signup_id  text PRIMARY KEY,
  user_id    text NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  bound_at   timestamptz
);

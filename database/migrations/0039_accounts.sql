-- Accounts and multi-tenancy ground work (master design 3.2, 3.4): users, invitations, server-side
-- sessions (only the SHA-256 of the token is stored) and email verifications. Email verification
-- rows are written by a later step (no mail is sent yet); new users start active.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id             text PRIMARY KEY,
  email          citext UNIQUE NOT NULL,
  password_hash  text NOT NULL,
  display_name   text,
  locale         text NOT NULL DEFAULT 'zh-CN',
  role           text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE invitations (
  code         text PRIMARY KEY,
  created_by   text,
  max_uses     integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count   integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at   timestamptz NOT NULL,
  note         text
);

CREATE TABLE sessions (
  id           text PRIMARY KEY, -- SHA-256 of the random token; the token itself is never stored.
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           inet
);

CREATE TABLE email_verifications (
  user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id)
);

CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

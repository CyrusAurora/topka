-- Per-user model keys (byok-self-host §3): each user's own OpenAI-compatible key for the
-- interactive/assistant path, encrypted at rest with the instance master key
-- (KEY_ENCRYPTION_SECRET, AES-256-GCM). Only the last four characters are kept in the clear;
-- the API never echoes the plaintext. One key per user per provider label (default "llm").
CREATE TABLE user_provider_keys (
  user_id          text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'llm',
  base_url         text,
  model            text,
  key_ciphertext   bytea NOT NULL,
  key_last4        text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

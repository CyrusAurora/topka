-- Companion app v1 (an optional client maintained outside this repository): one today view per user across all their projects, with the reader's
-- marks (看过了/稍后看) and a user-level checkpoint; the project assistant's chat turns and the proposals
-- it makes, which change nothing until the user confirms; and one-time codes that link a WeChat
-- identity to an existing account (only their hash is stored).
CREATE TABLE user_read_checkpoints (
  user_id      text PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  read_through timestamptz NOT NULL,
  acks         integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_item_marks (
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  article_id text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  mark       text NOT NULL CHECK (mark IN ('seen', 'later')),
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);

CREATE TABLE assistant_turns (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel     text NOT NULL DEFAULT 'mp',
  client_id   text,                      -- the client's message id: a resent message is answered once
  user_text   text NOT NULL,
  reply_text  text,
  action      text,
  proposal_id uuid,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'deferred', 'failed')),
  calls       integer NOT NULL DEFAULT 0,
  receipt_ids bigint[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX assistant_turns_user_idx ON assistant_turns (user_id, created_at);

CREATE TABLE project_proposals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
  project_id  text,                      -- update/delete: the project as it was proposed (no FK: delete removes it)
  payload     jsonb NOT NULL,            -- {target, purpose, focus, exclusions, sourceIds}
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'cancelled', 'superseded', 'failed')),
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX project_proposals_user_idx ON project_proposals (user_id, created_at);

CREATE TABLE mp_bind_codes (
  code_hash  text PRIMARY KEY,           -- sha256 of the code; the code itself is shown once and never stored
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  pushed_at  timestamptz,                -- handed to the companion app's bridge (which checks codes there)
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Companion-app identities bound to accounts, as the bridge reports them (audit; the app holds the live list).
CREATE TABLE mp_identities (
  openid     text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bound_at   timestamptz NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now()
);

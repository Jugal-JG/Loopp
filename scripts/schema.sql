CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS policy_chunks (
  id text NOT NULL, version text NOT NULL, tier text NOT NULL, title text NOT NULL, body text NOT NULL,
  embedding vector(768) NOT NULL, PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS demo_sessions (
  id uuid PRIMARY KEY, pending jsonb, active_turn uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_turns (
  session_id uuid REFERENCES demo_sessions(id) ON DELETE CASCADE, id uuid, message text NOT NULL,
  mode text NOT NULL, profile text NOT NULL, reply jsonb, traces jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,id)
);
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS auth_kind text;
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS account_profile text;
CREATE TABLE IF NOT EXISTS refunds (
  session_id uuid REFERENCES demo_sessions(id) ON DELETE CASCADE, profile text, reference text NOT NULL UNIQUE,
  turn_id uuid NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY(session_id,profile)
);
CREATE TABLE IF NOT EXISTS tickets (
  session_id uuid REFERENCES demo_sessions(id) ON DELETE CASCADE, turn_id uuid, reference text NOT NULL UNIQUE,
  reason text NOT NULL, profile text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(session_id,turn_id)
);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected'));
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS request_text text;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS ticket_messages (
  id uuid PRIMARY KEY, reference text NOT NULL REFERENCES tickets(reference),
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticket_email (
  id text PRIMARY KEY, reference text NOT NULL REFERENCES tickets(reference), recipient text NOT NULL,
  subject text NOT NULL, body text NOT NULL, sent_at timestamptz,
  send_until timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
UPDATE tickets AS t SET request_text=s.message FROM support_turns AS s
  WHERE t.session_id=s.session_id AND t.turn_id=s.id AND t.request_text IS NULL;
CREATE TABLE IF NOT EXISTS demo_limits (
  scope text, bucket timestamptz, hits int NOT NULL, PRIMARY KEY(scope,bucket)
);

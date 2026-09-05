BEGIN;

-- 심사 기록 대장 (서버 저장) — 브라우저 localStorage 대장의 서버 사본. 같은 대상의 재심사는 round로 이어진다.
CREATE TABLE review_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  commit_sha text,
  fingerprint text,
  round integer NOT NULL CHECK (round >= 1),
  status text NOT NULL CHECK (status IN ('pass_candidate', 'hold', 'fail_candidate')),
  rubric_version text NOT NULL,
  protection_level text NOT NULL,
  profile text NOT NULL DEFAULT '',
  record_json jsonb NOT NULL,
  recorded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_records_target_idx ON review_records (target, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('002_review_records')
ON CONFLICT (version) DO NOTHING;

COMMIT;

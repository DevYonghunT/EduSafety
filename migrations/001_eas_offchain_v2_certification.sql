BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certification_criteria (
  criterion_id text NOT NULL,
  criterion_version text NOT NULL,
  name text NOT NULL,
  public_description text NOT NULL,
  category text NOT NULL,
  evaluator_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  available boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (criterion_id, criterion_version),
  UNIQUE (evaluator_key, criterion_version)
);

CREATE TABLE certification_safety_controls (
  blocker_id text NOT NULL,
  blocker_version text NOT NULL,
  name text NOT NULL,
  evaluator_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (blocker_id, blocker_version)
);

CREATE SEQUENCE certification_policy_version_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE certification_policies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  policy_version integer NOT NULL UNIQUE CHECK (policy_version > 0),
  policy_hash char(66) NOT NULL UNIQUE CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  ruleset_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  snapshot_json jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  archived_at timestamptz,
  CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND archived_at IS NULL)
    OR (status = 'ACTIVE' AND published_at IS NOT NULL AND archived_at IS NULL)
    OR (status = 'ARCHIVED' AND published_at IS NOT NULL AND archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX certification_policies_one_active_idx
  ON certification_policies ((true))
  WHERE status = 'ACTIVE';

CREATE TABLE certification_policy_criteria (
  policy_id uuid NOT NULL REFERENCES certification_policies(id) ON DELETE RESTRICT,
  criterion_id text NOT NULL,
  criterion_version text NOT NULL,
  display_order integer NOT NULL CHECK (display_order >= 0),
  PRIMARY KEY (policy_id, criterion_id),
  UNIQUE (policy_id, display_order),
  FOREIGN KEY (criterion_id, criterion_version)
    REFERENCES certification_criteria(criterion_id, criterion_version) ON DELETE RESTRICT
);

CREATE TABLE certification_policy_safety_controls (
  policy_id uuid NOT NULL REFERENCES certification_policies(id) ON DELETE RESTRICT,
  blocker_id text NOT NULL,
  blocker_version text NOT NULL,
  evaluator_key text NOT NULL,
  PRIMARY KEY (policy_id, blocker_id),
  FOREIGN KEY (blocker_id, blocker_version)
    REFERENCES certification_safety_controls(blocker_id, blocker_version) ON DELETE RESTRICT
);

CREATE TABLE certification_analyses (
  id uuid PRIMARY KEY,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  canonical_repository_url text NOT NULL,
  commit_sha char(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  policy_id uuid NOT NULL REFERENCES certification_policies(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_hash char(66) NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  ruleset_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('PASS', 'FAIL')),
  report_hash char(66) NOT NULL CHECK (report_hash ~ '^0x[0-9a-f]{64}$'),
  report_snapshot_json jsonb NOT NULL,
  analyzed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certification_analyses_subject_idx
  ON certification_analyses (repository_id, commit_sha, created_at DESC);

CREATE TABLE certification_analysis_criteria (
  analysis_id uuid NOT NULL REFERENCES certification_analyses(id) ON DELETE RESTRICT,
  criterion_id text NOT NULL,
  criterion_version text NOT NULL,
  evaluator_key text NOT NULL,
  result text NOT NULL CHECK (
    result IN ('PASS', 'FAIL', 'ERROR', 'NOT_RUN', 'NOT_APPLICABLE', 'UNKNOWN')
  ),
  summary text NOT NULL,
  findings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (analysis_id, criterion_id),
  FOREIGN KEY (criterion_id, criterion_version)
    REFERENCES certification_criteria(criterion_id, criterion_version) ON DELETE RESTRICT
);

CREATE INDEX certification_analysis_criteria_result_idx
  ON certification_analysis_criteria (criterion_id, result);

CREATE TABLE certification_analysis_safety_blockers (
  analysis_id uuid NOT NULL REFERENCES certification_analyses(id) ON DELETE RESTRICT,
  blocker_id text NOT NULL,
  blocker_version text NOT NULL,
  triggered boolean NOT NULL,
  summary text NOT NULL,
  PRIMARY KEY (analysis_id, blocker_id)
);

CREATE TABLE certification_badges (
  uid char(66) PRIMARY KEY CHECK (uid ~ '^0x[0-9a-f]{64}$'),
  analysis_id uuid NOT NULL UNIQUE REFERENCES certification_analyses(id) ON DELETE RESTRICT,
  repository_id bigint NOT NULL CHECK (repository_id > 0),
  canonical_repository_url text NOT NULL,
  commit_sha char(40) NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  policy_id uuid NOT NULL REFERENCES certification_policies(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_hash char(66) NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  ruleset_version text NOT NULL,
  criteria_hash char(66) NOT NULL CHECK (criteria_hash ~ '^0x[0-9a-f]{64}$'),
  report_hash char(66) NOT NULL CHECK (report_hash ~ '^0x[0-9a-f]{64}$'),
  signature text NOT NULL CHECK (signature ~ '^0x[0-9a-f]{130}$'),
  attester char(42) NOT NULL CHECK (attester ~ '^0x[0-9a-fA-F]{40}$'),
  salt char(66) NOT NULL UNIQUE CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  schema_uid char(66) NOT NULL CHECK (
    schema_uid = '0xf58b8b212ef75ee8cd7e8d803c37c03e0519890502d5e99ee2412aae1456cafe'
  ),
  domain_name text NOT NULL CHECK (domain_name = 'EAS Attestation'),
  domain_version text NOT NULL CHECK (domain_version = '1.2.0'),
  chain_id bigint NOT NULL CHECK (chain_id = 84532),
  verifying_contract char(42) NOT NULL CHECK (
    verifying_contract = '0x4200000000000000000000000000000000000021'
  ),
  offchain_version smallint NOT NULL CHECK (offchain_version = 2),
  primary_type text NOT NULL CHECK (primary_type = 'Attest'),
  recipient char(42) NOT NULL CHECK (recipient = '0x0000000000000000000000000000000000000000'),
  ref_uid char(66) NOT NULL CHECK (
    ref_uid = '0x0000000000000000000000000000000000000000000000000000000000000000'
  ),
  attestation_time bigint NOT NULL CHECK (attestation_time > 0),
  expiration_time bigint NOT NULL CHECK (expiration_time >= 0),
  revocable boolean NOT NULL CHECK (revocable),
  encoded_data text NOT NULL CHECK (encoded_data ~ '^0x[0-9a-f]+$'),
  payload_canonical text NOT NULL,
  payload_json jsonb NOT NULL,
  typed_data_json jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz,
  CHECK (payload_canonical::jsonb = payload_json),
  CONSTRAINT certification_badges_issuance_uq
    UNIQUE (repository_id, commit_sha, policy_hash, ruleset_version)
);

CREATE INDEX certification_badges_issued_idx ON certification_badges (issued_at DESC);

CREATE TABLE certification_badge_revocations (
  uid char(66) PRIMARY KEY REFERENCES certification_badges(uid) ON DELETE RESTRICT,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text NOT NULL,
  reason text NOT NULL CHECK (
    reason IN (
      'ISSUED_IN_ERROR',
      'POLICY_REPLACED',
      'REPOSITORY_UNAVAILABLE',
      'SECURITY_REVIEW',
      'OTHER'
    )
  )
);

CREATE TABLE certification_audit_logs (
  id uuid PRIMARY KEY,
  administrator_id text NOT NULL,
  action text NOT NULL CHECK (
    action IN ('POLICY_CREATED', 'POLICY_UPDATED', 'POLICY_PUBLISHED', 'POLICY_ARCHIVED', 'BADGE_REVOKED')
  ),
  target_type text NOT NULL CHECK (target_type IN ('POLICY', 'BADGE')),
  target_id text NOT NULL,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certification_audit_logs_target_idx
  ON certification_audit_logs (target_type, target_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_published_policy_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NOT (
      OLD.status = 'ACTIVE'
      AND NEW.status = 'ARCHIVED'
      AND NEW.archived_at IS NOT NULL
      AND NEW.id = OLD.id
      AND NEW.name = OLD.name
      AND NEW.policy_version = OLD.policy_version
      AND NEW.policy_hash = OLD.policy_hash
      AND NEW.ruleset_version = OLD.ruleset_version
      AND NEW.snapshot_json = OLD.snapshot_json
      AND NEW.created_by = OLD.created_by
      AND NEW.created_at = OLD.created_at
      AND NEW.published_at = OLD.published_at
    ) THEN
      RAISE EXCEPTION 'Published certification policies are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER certification_policies_immutable_trigger
  BEFORE UPDATE ON certification_policies
  FOR EACH ROW EXECUTE FUNCTION guard_published_policy_immutability();

CREATE OR REPLACE FUNCTION guard_policy_criteria_draft_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_policy_id uuid;
  selected_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    selected_policy_id := OLD.policy_id;
  ELSE
    selected_policy_id := NEW.policy_id;
  END IF;
  SELECT status INTO selected_status
  FROM certification_policies
  WHERE id = selected_policy_id
  FOR UPDATE;
  IF selected_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Only draft certification policy criteria may be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER certification_policy_criteria_draft_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON certification_policy_criteria
  FOR EACH ROW EXECUTE FUNCTION guard_policy_criteria_draft_only();

CREATE TRIGGER certification_policy_safety_draft_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON certification_policy_safety_controls
  FOR EACH ROW EXECUTE FUNCTION guard_policy_criteria_draft_only();

CREATE OR REPLACE FUNCTION reject_immutable_row_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'This certification history row is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION guard_badge_issuance_results()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  analysis_row certification_analyses%ROWTYPE;
  selected_criteria_count integer;
  passed_criteria_count integer;
  analysis_criteria_count integer;
  selected_safety_count integer;
  passed_safety_count integer;
  analysis_safety_count integer;
BEGIN
  SELECT * INTO analysis_row
  FROM certification_analyses
  WHERE id = NEW.analysis_id;

  IF analysis_row.id IS NULL
    OR analysis_row.decision <> 'PASS'
    OR analysis_row.repository_id <> NEW.repository_id
    OR analysis_row.canonical_repository_url <> NEW.canonical_repository_url
    OR analysis_row.commit_sha <> NEW.commit_sha
    OR analysis_row.policy_id <> NEW.policy_id
    OR analysis_row.policy_version <> NEW.policy_version
    OR analysis_row.policy_hash <> NEW.policy_hash
    OR analysis_row.ruleset_version <> NEW.ruleset_version
    OR analysis_row.report_hash <> NEW.report_hash
  THEN
    RAISE EXCEPTION 'Badge issuance analysis snapshot mismatch';
  END IF;

  SELECT count(*) INTO selected_criteria_count
  FROM certification_policy_criteria
  WHERE policy_id = NEW.policy_id;

  SELECT count(*) INTO analysis_criteria_count
  FROM certification_analysis_criteria
  WHERE analysis_id = NEW.analysis_id;

  SELECT count(*) INTO passed_criteria_count
  FROM certification_policy_criteria pc
  JOIN certification_analysis_criteria ac
    ON ac.analysis_id = NEW.analysis_id
    AND ac.criterion_id = pc.criterion_id
    AND ac.criterion_version = pc.criterion_version
    AND ac.result = 'PASS'
  WHERE pc.policy_id = NEW.policy_id;

  SELECT count(*) INTO selected_safety_count
  FROM certification_policy_safety_controls
  WHERE policy_id = NEW.policy_id;

  SELECT count(*) INTO analysis_safety_count
  FROM certification_analysis_safety_blockers
  WHERE analysis_id = NEW.analysis_id;

  SELECT count(*) INTO passed_safety_count
  FROM certification_policy_safety_controls ps
  JOIN certification_analysis_safety_blockers ab
    ON ab.analysis_id = NEW.analysis_id
    AND ab.blocker_id = ps.blocker_id
    AND ab.blocker_version = ps.blocker_version
    AND ab.triggered = false
  WHERE ps.policy_id = NEW.policy_id;

  IF selected_criteria_count = 0
    OR selected_criteria_count <> analysis_criteria_count
    OR selected_criteria_count <> passed_criteria_count
    OR selected_safety_count = 0
    OR selected_safety_count <> analysis_safety_count
    OR selected_safety_count <> passed_safety_count
  THEN
    RAISE EXCEPTION 'Badge issuance requires complete PASS results';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER certification_badges_pass_results_trigger
  BEFORE INSERT ON certification_badges
  FOR EACH ROW EXECUTE FUNCTION guard_badge_issuance_results();

CREATE TRIGGER certification_badges_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_badges
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER certification_analyses_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_analyses
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER certification_analysis_criteria_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_analysis_criteria
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER certification_analysis_safety_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_analysis_safety_blockers
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER certification_revocations_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_badge_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

CREATE TRIGGER certification_audits_immutable_trigger
  BEFORE UPDATE OR DELETE ON certification_audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_row_change();

INSERT INTO certification_criteria (
  criterion_id,
  criterion_version,
  name,
  public_description,
  category,
  evaluator_key,
  active,
  available,
  display_order
)
VALUES
  (
    'no-hardcoded-secrets', '1.0.0', '하드코딩된 비밀정보 없음',
    '지원되는 소스와 설정 파일에서 고신뢰도 비밀정보 패턴이 발견되지 않아야 합니다.',
    'Secrets', 'secrets.static.v1', true, true, 10
  ),
  (
    'no-dangerous-code-execution', '1.0.0', '위험한 동적 코드 실행 없음',
    '정적 분석 범위에서 eval, 동적 함수 생성 및 명령 실행 패턴이 발견되지 않아야 합니다.',
    'Code execution', 'execution.static.v1', true, true, 20
  ),
  (
    'dependency-lockfile-present', '1.0.0', '의존성 잠금 파일 사용',
    '의존성 선언이 있는 프로젝트는 지원되는 잠금 파일을 함께 커밋해야 합니다.',
    'Dependencies', 'lockfile.static.v1', true, true, 30
  ),
  (
    'no-unsafe-html-sinks', '1.0.0', '안전하지 않은 HTML 주입 없음',
    '지원되는 웹 소스에서 직접적인 HTML 주입 sink가 발견되지 않아야 합니다.',
    'Web', 'html-sinks.static.v1', true, true, 40
  ),
  (
    'restricted-cors-policy', '1.0.0', '제한된 CORS 정책',
    '지원되는 서버 설정에서 무제한 CORS 허용 패턴이 발견되지 않아야 합니다.',
    'Configuration', 'cors.static.v1', true, true, 50
  )
ON CONFLICT (criterion_id, criterion_version) DO UPDATE SET
  name = EXCLUDED.name,
  public_description = EXCLUDED.public_description,
  category = EXCLUDED.category,
  evaluator_key = EXCLUDED.evaluator_key,
  display_order = EXCLUDED.display_order;

INSERT INTO certification_safety_controls (
  blocker_id, blocker_version, name, evaluator_key, active
)
VALUES
  ('critical_finding', '1.0.0', 'Critical finding', 'safety.critical.v1', true),
  ('secret_detected', '1.0.0', 'Secret detected', 'safety.secrets.v1', true),
  ('partial_analysis', '1.0.0', 'Partial analysis', 'safety.partial.v1', true),
  ('coverage_incomplete', '1.0.0', 'Coverage incomplete', 'safety.coverage.v1', true),
  ('exact_commit_unverified', '1.0.0', 'Exact commit verification', 'safety.commit.v1', true),
  ('analyzer_error', '1.0.0', 'Analyzer errors', 'safety.analyzer.v1', true),
  ('required_files_missing', '1.0.0', 'Required files collected', 'safety.files.v1', true)
ON CONFLICT (blocker_id, blocker_version) DO UPDATE SET
  name = EXCLUDED.name,
  evaluator_key = EXCLUDED.evaluator_key;

INSERT INTO schema_migrations (version) VALUES ('001_eas_offchain_v2_certification')
ON CONFLICT (version) DO NOTHING;

COMMIT;

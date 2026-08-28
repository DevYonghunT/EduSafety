import { canonicalHash } from "../lib/canonical-json.js";
import type {
  CriterionEvaluation,
  FindingSeverity,
  PolicyCriterionSnapshot,
  SafeFinding,
} from "../domain/types.js";
import type { SourceFile } from "../github/client.js";

interface PatternRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: FindingSeverity;
  readonly description: string;
}

const SECRET_RULES: readonly PatternRule[] = [
  {
    id: "SECRET_GITHUB_TOKEN",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    severity: "CRITICAL",
    description: "GitHub credential과 일치하는 고신뢰도 패턴이 발견됐습니다.",
  },
  {
    id: "SECRET_PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    severity: "CRITICAL",
    description: "개인키 자료와 일치하는 고신뢰도 패턴이 발견됐습니다.",
  },
  {
    id: "SECRET_CLOUD_KEY",
    pattern: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9A-Za-z]{16,})\b/g,
    severity: "CRITICAL",
    description: "클라우드 credential과 일치하는 고신뢰도 패턴이 발견됐습니다.",
  },
  {
    id: "SECRET_ASSIGNED_VALUE",
    pattern:
      /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|private[_-]?key|password|passwd|secret)\b\s*[:=]\s*["'][A-Za-z0-9_./+\-=]{20,}["']/gi,
    severity: "CRITICAL",
    description: "소스에 직접 할당된 credential 의심 값이 발견됐습니다.",
  },
];

const EXECUTION_RULES: readonly PatternRule[] = [
  {
    id: "EXEC_EVAL",
    pattern: /\beval\s*\(/g,
    severity: "CRITICAL",
    description: "동적 코드 평가 호출이 발견됐습니다.",
  },
  {
    id: "EXEC_FUNCTION_CONSTRUCTOR",
    pattern: /\bnew\s+Function\s*\(/g,
    severity: "CRITICAL",
    description: "동적 함수 생성 호출이 발견됐습니다.",
  },
  {
    id: "EXEC_OS_COMMAND",
    pattern:
      /\b(?:child_process\s*\.\s*(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)|os\s*\.\s*system|subprocess\s*\.\s*(?:run|Popen|call)|shell_exec|passthru)\s*\(/g,
    severity: "CRITICAL",
    description: "운영체제 명령 실행 호출이 발견됐습니다.",
  },
];

const HTML_RULES: readonly PatternRule[] = [
  {
    id: "WEB_UNSAFE_HTML_SINK",
    pattern: /\b(?:innerHTML\s*=|outerHTML\s*=|dangerouslySetInnerHTML\s*=)/g,
    severity: "HIGH",
    description: "직접적인 HTML 주입 sink가 발견됐습니다.",
  },
];

const CORS_RULES: readonly PatternRule[] = [
  {
    id: "CONFIG_WILDCARD_CORS",
    pattern:
      /(?:Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*|\bcors\s*\(\s*\{[^}]*origin\s*:\s*["']\*)/gis,
    severity: "HIGH",
    description: "무제한 origin을 허용하는 CORS 설정이 발견됐습니다.",
  },
];
const MAX_MATCHES_PER_FILE_RULE = 1_000;
const MAX_FINDINGS_PER_SCAN = 2_000;

function safeLocation(filePath: string, line?: number): string {
  const pathHash = canonicalHash({ path: filePath }).slice(2, 18);
  return line === undefined ? `file:${pathHash}` : `file:${pathHash}:L${line}`;
}

function scanPatterns(files: readonly SourceFile[], rules: readonly PatternRule[]): SafeFinding[] {
  const aggregated = new Map<string, SafeFinding>();
  let totalMatches = 0;
  let limitReached = false;
  scan: for (const file of files) {
    for (const rule of rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let line = 1;
      let lastOffset = 0;
      let matchCount = 0;
      for (const match of file.content.matchAll(pattern)) {
        const offset = match.index ?? 0;
        for (let index = lastOffset; index < offset; index += 1) {
          if (file.content.charCodeAt(index) === 10) line += 1;
        }
        lastOffset = offset;
        const location = safeLocation(file.path, line);
        const key = `${rule.id}\0${location}`;
        const current = aggregated.get(key);
        aggregated.set(key, {
          ruleId: rule.id,
          severity: rule.severity,
          description: rule.description,
          fileType: file.extension || "no-extension",
          count: (current?.count ?? 0) + 1,
          location,
          evidenceHash: canonicalHash({ ruleId: rule.id, location }),
        });
        matchCount += 1;
        totalMatches += 1;
        if (totalMatches >= MAX_FINDINGS_PER_SCAN) {
          limitReached = true;
          break scan;
        }
        if (matchCount >= MAX_MATCHES_PER_FILE_RULE) break;
      }
    }
  }
  if (limitReached) {
    const location = "analysis:finding-limit";
    aggregated.set("ANALYSIS_FINDING_LIMIT_REACHED", {
      ruleId: "ANALYSIS_FINDING_LIMIT_REACHED",
      severity: "CRITICAL",
      description: "안전한 finding 처리 한도에 도달해 분석을 완결할 수 없습니다.",
      fileType: "analysis",
      count: 1,
      location,
      evidenceHash: canonicalHash({ ruleId: "ANALYSIS_FINDING_LIMIT_REACHED", location }),
    });
  }
  return [...aggregated.values()].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId) || left.location.localeCompare(right.location),
  );
}

export function scanFixedSafetyFindings(files: readonly SourceFile[]): {
  readonly secretFindings: readonly SafeFinding[];
  readonly criticalFindings: readonly SafeFinding[];
} {
  const secretFindings = scanPatterns(files, SECRET_RULES);
  const executionFindings = scanPatterns(files, EXECUTION_RULES);
  return {
    secretFindings,
    criticalFindings: [...secretFindings, ...executionFindings].filter(
      (finding) => finding.severity === "CRITICAL",
    ),
  };
}

function evaluation(
  criterion: PolicyCriterionSnapshot,
  findings: readonly SafeFinding[],
  passSummary: string,
): CriterionEvaluation {
  return {
    criterionId: criterion.criterionId,
    criterionVersion: criterion.criterionVersion,
    evaluatorKey: criterion.evaluatorKey,
    result: findings.length === 0 ? "PASS" : "FAIL",
    summary: findings.length === 0 ? passSummary : `${findings.length}개 안전한 finding 요약이 생성됐습니다.`,
    findings,
  };
}

function evaluateLockfile(
  criterion: PolicyCriterionSnapshot,
  files: readonly SourceFile[],
): CriterionEvaluation {
  const paths = new Set(files.map((file) => file.path));
  const packagePaths = [...paths].filter((filePath) => filePath.endsWith("package.json"));
  if (packagePaths.length === 0) {
    return {
      criterionId: criterion.criterionId,
      criterionVersion: criterion.criterionVersion,
      evaluatorKey: criterion.evaluatorKey,
      result: "NOT_APPLICABLE",
      summary: "지원되는 JavaScript 의존성 선언 파일이 없습니다.",
      findings: [],
    };
  }

  const lockNames = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
  const missing = packagePaths.filter((packagePath) => {
    const prefix = packagePath.slice(0, Math.max(0, packagePath.length - "package.json".length));
    return !lockNames.some((name) => paths.has(`${prefix}${name}`));
  });
  const findings = missing.map((packagePath): SafeFinding => ({
    ruleId: "DEPENDENCY_LOCKFILE_MISSING",
    severity: "MEDIUM",
    description: "의존성 선언과 같은 경로에 지원되는 잠금 파일이 없습니다.",
    fileType: ".json",
    count: 1,
    location: safeLocation(packagePath),
    evidenceHash: canonicalHash({ ruleId: "DEPENDENCY_LOCKFILE_MISSING", pathHash: canonicalHash({ path: packagePath }) }),
  }));
  return evaluation(criterion, findings, "각 JavaScript 의존성 선언에 대응하는 잠금 파일이 있습니다.");
}

export function evaluateCriterion(
  criterion: PolicyCriterionSnapshot,
  files: readonly SourceFile[],
): CriterionEvaluation {
  try {
    switch (criterion.evaluatorKey) {
      case "secrets.static.v1":
        return evaluation(criterion, scanPatterns(files, SECRET_RULES), "고신뢰도 비밀정보 패턴이 없습니다.");
      case "execution.static.v1":
        return evaluation(
          criterion,
          scanPatterns(files, EXECUTION_RULES),
          "위험한 동적 코드 또는 명령 실행 패턴이 없습니다.",
        );
      case "lockfile.static.v1":
        return evaluateLockfile(criterion, files);
      case "html-sinks.static.v1":
        return evaluation(criterion, scanPatterns(files, HTML_RULES), "직접적인 HTML 주입 sink가 없습니다.");
      case "cors.static.v1":
        return evaluation(criterion, scanPatterns(files, CORS_RULES), "무제한 CORS 허용 패턴이 없습니다.");
      default:
        return {
          criterionId: criterion.criterionId,
          criterionVersion: criterion.criterionVersion,
          evaluatorKey: criterion.evaluatorKey,
          result: "ERROR",
          summary: "등록된 서버 evaluator를 찾을 수 없습니다.",
          findings: [],
        };
    }
  } catch {
    return {
      criterionId: criterion.criterionId,
      criterionVersion: criterion.criterionVersion,
      evaluatorKey: criterion.evaluatorKey,
      result: "ERROR",
      summary: "정적 evaluator 실행 중 오류가 발생했습니다.",
      findings: [],
    };
  }
}

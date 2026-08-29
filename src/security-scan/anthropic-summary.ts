import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import type { SecurityScanSummarizer, SecuritySummaryOutput } from "./service.js";

export const ANTHROPIC_MODEL_IDS = [
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-5",
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODEL_IDS)[number];

export const DEFAULT_ANTHROPIC_MODEL: AnthropicModelId = "claude-sonnet-5";

export const ANTHROPIC_MODELS: readonly {
  readonly id: AnthropicModelId;
  readonly label: string;
}[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 · 균형형" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 · 빠른 분석" },
  { id: "claude-opus-5", label: "Claude Opus 5 · 정밀 분석" },
];

export const ANTHROPIC_SUMMARY_TIMEOUT_MS = 20_000;

const structuredSummarySchema = z.strictObject({
  overview: z.string(),
  priority_actions: z.array(z.string()).max(3),
});

const validatedSummarySchema = z.strictObject({
  overview: z.string().trim().min(1).max(700),
  priority_actions: z.array(z.string().trim().min(1).max(300)).max(3),
});

export interface AnthropicSecuritySummarizerOptions {
  readonly apiKey: string;
  readonly model: AnthropicModelId;
  readonly fetch?: typeof globalThis.fetch;
}

export function createAnthropicSecuritySummarizer(
  options: AnthropicSecuritySummarizerOptions,
): SecurityScanSummarizer {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: ANTHROPIC_SUMMARY_TIMEOUT_MS,
    maxRetries: 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return async (input, signal): Promise<SecuritySummaryOutput> => {
    const activeFindings = input.findings.filter(({ status }) => status !== "pass");
    const allowedActions = new Set(activeFindings.map(({ remediation }) => remediation));
    const evidence = {
      deterministicRiskLevel: input.riskLevel,
      activeFindings: activeFindings.map(({ id, severity, remediation }) => ({
        id,
        severity,
        remediation,
      })),
    };

    const response = await client.messages.parse(
      {
        model: options.model,
        max_tokens: 600,
        thinking: { type: "disabled" },
        metadata: { user_id: input.safetyIdentifier },
        system:
          "당신은 방어 목적의 웹 보안 검토자입니다. 제공된 결정론적 개선 항목만 설명하고 새로운 취약점을 추측하지 마세요. 공격 절차나 페이로드를 제공하지 말고 한국어로 간결하게 작성하세요. priority_actions의 각 항목은 입력의 remediation 문자열 중 하나를 수정 없이 그대로 복사하세요.",
        messages: [{ role: "user", content: JSON.stringify(evidence) }],
        output_config: {
          format: zodOutputFormat(structuredSummarySchema),
        },
      },
      signal === undefined ? undefined : { signal },
    );

    if (response.stop_reason !== "end_turn" || response.parsed_output === null) {
      throw new Error("Anthropic summary did not complete with structured output");
    }
    const generated = validatedSummarySchema.parse(response.parsed_output);
    if (generated.priority_actions.some((action) => !allowedActions.has(action))) {
      throw new Error("Anthropic summary returned an action outside the deterministic remediation set");
    }
    return {
      overview: generated.overview,
      priorityActions: generated.priority_actions,
    };
  };
}

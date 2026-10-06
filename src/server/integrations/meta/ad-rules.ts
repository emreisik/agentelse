import "server-only";

import { metaFetch } from "./graph";
import { GRAPH_BASE } from "./version";

// Ad Rules istemcisi (docs/meta-ads-plan.md §3.9, F7, isteğe bağlı sigorta).
// Kural her zaman kimlik filtresiyle kurulur (yalnız Agentelse'in kampanyası;
// tek başına entity_type hesaba eklenen her nesneye uygulanırdı) ve SCHEDULE
// tipindedir (yarım saatte bir, Ads Manager'da görünür). "spent" eşiği
// hesabın para biriminin alt birimindedir.

export type SafetyRuleSpec = {
  campaignId: string;
  thresholdMinor: number;
};

export function safetyRuleName(campaignName: string): string {
  return `Agentelse safety · ${campaignName}`.slice(0, 200);
}

export function safetyEvaluationSpec(spec: SafetyRuleSpec) {
  return {
    evaluation_type: "SCHEDULE",
    filters: [
      { field: "campaign.id", operator: "IN", value: [spec.campaignId] },
      { field: "entity_type", operator: "EQUAL", value: "CAMPAIGN" },
      { field: "time_preset", operator: "EQUAL", value: "TODAY" },
      { field: "spent", operator: "GREATER_THAN", value: spec.thresholdMinor },
    ],
  };
}

export async function createSafetyRule(input: {
  adAccountId: string;
  accessToken: string;
  name: string;
  spec: SafetyRuleSpec;
}): Promise<string> {
  const body = new URLSearchParams({
    name: input.name,
    evaluation_spec: JSON.stringify(safetyEvaluationSpec(input.spec)),
    execution_spec: JSON.stringify({ execution_type: "PAUSE" }),
    schedule_spec: JSON.stringify({ schedule_type: "SEMI_HOURLY" }),
    status: "ENABLED",
    access_token: input.accessToken,
  });
  const result = await metaFetch<{ id?: string }>(
    `${GRAPH_BASE}/${input.adAccountId}/adrules_library`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  if (!result.id) throw new Error("Meta didn't return the rule id");
  return result.id;
}

export async function updateSafetyRule(input: {
  ruleId: string;
  accessToken: string;
  spec: SafetyRuleSpec;
}): Promise<void> {
  const body = new URLSearchParams({
    evaluation_spec: JSON.stringify(safetyEvaluationSpec(input.spec)),
    access_token: input.accessToken,
  });
  await metaFetch<{ success?: boolean }>(`${GRAPH_BASE}/${input.ruleId}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export async function deleteSafetyRule(
  ruleId: string,
  accessToken: string,
): Promise<void> {
  const params = new URLSearchParams({ access_token: accessToken });
  await metaFetch<{ success?: boolean }>(
    `${GRAPH_BASE}/${ruleId}?${params.toString()}`,
    {
      method: "DELETE",
    },
  );
}

// Test hesabında denemek için (§3.9): kuralın şu an hangi nesnelere
// uygulanacağı.
export async function previewSafetyRule(
  ruleId: string,
  accessToken: string,
): Promise<unknown> {
  const params = new URLSearchParams({ access_token: accessToken });
  return metaFetch<unknown>(
    `${GRAPH_BASE}/${ruleId}/preview?${params.toString()}`,
  );
}

export type RuleHistoryEntry = {
  ruleId: string;
  timestamp: string | null;
  objectIds: string[];
};

// adrules_history: yanıt biçimi belgede kesin değil; kural kimliği, zaman ve
// sonuçlardaki nesne kimlikleri toleranslı okunur.
export async function readSafetyRuleHistory(
  adAccountId: string,
  accessToken: string,
): Promise<RuleHistoryEntry[]> {
  const params = new URLSearchParams({
    access_token: accessToken,
    limit: "100",
  });
  const body = await metaFetch<{
    data?: {
      rule_id?: string | number;
      timestamp?: string;
      results?: { object_id?: string | number; id?: string | number }[];
    }[];
  }>(`${GRAPH_BASE}/${adAccountId}/adrules_history?${params.toString()}`);
  return (body.data ?? [])
    .map((row) => ({
      ruleId: row.rule_id === undefined ? "" : String(row.rule_id),
      timestamp: typeof row.timestamp === "string" ? row.timestamp : null,
      objectIds: (row.results ?? [])
        .map((result) => result.object_id ?? result.id)
        .filter((id): id is string | number => id !== undefined && id !== null)
        .map(String),
    }))
    .filter((row) => row.ruleId && row.objectIds.length > 0);
}

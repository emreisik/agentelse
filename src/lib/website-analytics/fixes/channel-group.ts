import { AI_ASSISTANTS } from "@/lib/website-analytics/analysis/ai-sources";
import type { GaChannelGroupCreate } from "./resources";

// doğrulanmalı: API Explorer ile gerçek mülkte denenmeli. Kanal grubu
// kuralında kaynak alanının adı v1alpha belgesinde 'eachScopeSource'
// (oturum, kullanıcı ve olay kapsamlarının hepsine bakar).
export const GA_AI_CHANNEL_FIELD = "eachScopeSource";

export const GA_AI_CHANNEL_GROUP_NAME = "AI assistants";
export const GA_AI_CHANNEL_GROUP_DESCRIPTION = "Created by Agentelse";
// Google ifade uzunluğu sınırının altında kalmak için üst sınır.
export const GA_AI_CHANNEL_REGEX_MAX = 800;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

// Alan adları tam ya da alt alan adı olarak, kısa adlar birebir eşleşir:
// ^((.*\.)?(a|b)|(x|y))$ . Google ve Bing arama kaynağı eşleşmez.
export function aiAssistantsRegex(): string {
  const domains = sortedUnique(
    AI_ASSISTANTS.flatMap((assistant) =>
      assistant.domains.map((domain) => escapeRegex(domain.toLowerCase())),
    ),
  );
  const aliases = sortedUnique(
    AI_ASSISTANTS.flatMap((assistant) =>
      assistant.aliases.map((alias) => escapeRegex(alias.toLowerCase())),
    ),
  );
  const parts: string[] = [];
  if (domains.length > 0) parts.push(`(.*\\.)?(${domains.join("|")})`);
  if (aliases.length > 0) parts.push(`(${aliases.join("|")})`);
  return `^(${parts.join("|")})$`;
}

export function buildAiChannelGroup(): GaChannelGroupCreate {
  const value = aiAssistantsRegex();
  if (value.length > GA_AI_CHANNEL_REGEX_MAX) {
    throw new Error("ai_channel_regex_too_long");
  }
  return {
    displayName: GA_AI_CHANNEL_GROUP_NAME,
    description: GA_AI_CHANNEL_GROUP_DESCRIPTION,
    groupingRule: [
      {
        displayName: GA_AI_CHANNEL_GROUP_NAME,
        expression: {
          filter: {
            fieldName: GA_AI_CHANNEL_FIELD,
            stringFilter: { matchType: "PARTIAL_REGEXP", value },
          },
        },
      },
    ],
  };
}

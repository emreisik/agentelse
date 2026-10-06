// Meta reklam hesabı kimliği: "123" ve "act_123" aynı hesaptır.
export function normalizeAdAccountId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

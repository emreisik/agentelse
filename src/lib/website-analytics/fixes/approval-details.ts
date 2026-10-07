// Onay kartında gösterilen ayrıntı satırları: Task yükündeki `details`
// savunmacı okunur (en çok 6 satır, her metin 200 karaktere kırpılır).

const MAX_ROWS = 6;
const MAX_TEXT = 200;

function clip(value: string): string {
  const chars = Array.from(value.trim());
  return chars.length <= MAX_TEXT ? chars.join("") : chars.slice(0, MAX_TEXT).join("");
}

export function gaFixApprovalDetails(
  payload: unknown,
): { label: string; value: string }[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const details = (payload as { details?: unknown }).details;
  if (!Array.isArray(details)) return undefined;
  const rows: { label: string; value: string }[] = [];
  for (const item of details) {
    if (rows.length >= MAX_ROWS) break;
    if (typeof item !== "object" || item === null) continue;
    const { label, value } = item as { label?: unknown; value?: unknown };
    if (typeof label !== "string" || typeof value !== "string") continue;
    const cleanLabel = clip(label);
    const cleanValue = clip(value);
    if (!cleanLabel || !cleanValue) continue;
    rows.push({ label: cleanLabel, value: cleanValue });
  }
  return rows.length > 0 ? rows : undefined;
}

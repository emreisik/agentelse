// ExecutionJob.rawResult şekli provider'a göre değişir — sabit bir şema
// yok, bu yüzden okunabilir bir özet en iyi çabayla çıkarılır. Hem İşler
// panelindeki (isler-panel.tsx) görev detayında hem de fikir sohbetindeki
// "task-result" kartında (task.repository.ts postTaskChatEvent) aynı
// mantıkla kullanılır — tek kaynak, iki yerde kopya değil.
export function extractResultText(rawResult: unknown): string | null {
  if (!rawResult || typeof rawResult !== "object") return null;
  const result = rawResult as Record<string, unknown>;
  if (typeof result.text === "string" && result.text.trim()) {
    return result.text;
  }
  const parts = [result.caption, result.copy].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (parts.length > 0) return parts.join("\n\n");
  return JSON.stringify(rawResult, null, 2);
}

// Haftalık taslak yanıtına eklenen cümle (SC-F7): bu hafta vadesi gelen aylık
// plan makaleleri sosyal haftalık taslağın parçası olmaz, yalnız anılır.
// Saf ve izomorfik.

export function weeklySeoNoteText(count: number): string {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return "";
  if (n === 1) {
    return "One SEO article from this month's plan is also due this week.";
  }
  return `${n} SEO articles from this month's plan are also due this week.`;
}

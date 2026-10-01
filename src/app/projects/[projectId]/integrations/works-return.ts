// The single "Back to <Work>" link of ?from=<workId> on the integrations page.
// It is dropped when a per-channel back row already leads to the same Work, so
// the page never shows two identical "Back to <Work>" buttons.
export function singleReturnTarget(
  fromWork: { id: string; title: string; status: string } | null,
  back: readonly { workId: string }[],
): { id: string; title: string } | null {
  if (!fromWork || fromWork.status !== "ACTIVE") return null;
  if (back.some((link) => link.workId === fromWork.id)) return null;
  return { id: fromWork.id, title: fromWork.title };
}

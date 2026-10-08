// The colours the bar may take when the template names none, best first: the
// brand's accent colours, then its primary and secondary ones (what Visual
// Identity and Brand Brain show as "the colors"). Only after all of them does
// applyBrandTemplate fall back to the legacy dossier colours, so a colour
// edited in Visual Identity is never shadowed by an older dossier entry.
export function barColorCandidates(
  identity:
    | {
        accentColors: { hex: string; name?: string }[];
        primaryColors: { hex: string; name?: string }[];
        secondaryColors: { hex: string; name?: string }[];
      }
    | null
    | undefined,
): { hex: string; name?: string }[] {
  if (!identity) return [];
  return [
    ...identity.accentColors,
    ...identity.primaryColors,
    ...identity.secondaryColors,
  ];
}

// Whether the main chat composer may grab focus when the page mounts (spec 4).
//
// Pure and IMPORT-FREE on purpose: the static ProjectChat bundle imports this
// file, and it must not pull the reducer, the steps, the plan or the sanitizer
// regexes that the lazily loaded sheet owns.
//
// ProjectChat latches the answer ONCE at mount (useState initializer). Never
// derive it from a live prop: `requested` is recomputed on every server render,
// so a router.refresh() would flip it and focus the composer over the sheet.
export function composerAutoFocus({
  requested,
  coarsePointer,
  hasHost,
}: {
  // ?guide=setup was on the URL: the sheet opens by itself.
  requested: boolean;
  // A touch-first device: a keyboard at load is never wanted.
  coarsePointer: boolean;
  // GUIDED_SETUP is on (the page passed a host).
  hasHost: boolean;
}): boolean {
  // Flag off: exactly today's behaviour.
  if (!hasHost) return true;
  if (requested) return false;
  if (coarsePointer) return false;
  return true;
}

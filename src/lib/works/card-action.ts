// Card-kit vocabulary: what a card button can do and how a button row is
// kept sane. Pure and isomorphic (no React, no server-only imports).

export type CardAction =
  | { kind: "send"; text: string }
  | { kind: "link"; href: string }
  | { kind: "tab"; tab: "outputs" | "calendar" }
  | { kind: "server"; id: string };

export type CardEmphasis = "primary" | "secondary" | "quiet";

export type CardButton = {
  id: string;
  label: string;
  emphasis: CardEmphasis;
  action: CardAction;
  disabledReason?: string;
};

export const MAX_CARD_BUTTONS = 3;
export const MAX_SEND_TEXT = 600;

export type CardActionResult =
  // refresh: true for steps that do not revalidate the page themselves (a
  // Route Handler step); a plain Server Action already returns the new page.
  | { ok: true; message?: string; refresh?: boolean }
  | { ok: false; message: string; code?: string };

export function isSendAction(
  action: CardAction,
): action is Extract<CardAction, { kind: "send" }> {
  return action.kind === "send";
}

// Same-origin paths only: a stored or model-derived string must never become
// an external href.
export function isSameOriginPath(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  if (href.includes("\\") || /\s/.test(href)) return false;
  // A scheme can only appear after the first slash in a query; reject "://".
  return !href.includes("://");
}

// Control characters other than newline are refused (the starter plan message
// is multi-line on purpose).
function isPlainSendText(text: string): boolean {
  if (text.length === 0 || text.length > MAX_SEND_TEXT) return false;
  return !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text);
}

function isAllowed(action: CardAction): boolean {
  if (action.kind === "link") return isSameOriginPath(action.href);
  if (action.kind === "send") return isPlainSendText(action.text);
  return true;
}

export function normalizeButtons(buttons: readonly CardButton[]): CardButton[] {
  const seen = new Set<string>();
  const out: CardButton[] = [];
  let hasPrimary = false;
  for (const button of buttons) {
    if (out.length >= MAX_CARD_BUTTONS) break;
    if (seen.has(button.id) || !isAllowed(button.action)) continue;
    seen.add(button.id);
    let emphasis = button.emphasis;
    if (emphasis === "primary") {
      if (hasPrimary) emphasis = "secondary";
      hasPrimary = true;
    }
    out.push(emphasis === button.emphasis ? button : { ...button, emphasis });
  }
  return out;
}

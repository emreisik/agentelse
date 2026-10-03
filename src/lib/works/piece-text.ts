// The text of one produced piece, shared by the plan pane (it shows and edits
// it) and the server (it reads and writes it). A picture post keeps its words in
// the caption; a written piece (script, LinkedIn or X post) in the copy.

export type PieceVersionText = {
  assetId?: string | null;
  caption?: string | null;
  copy?: string | null;
};

export const PIECE_TEXT_MAX = 3000;

export type PieceTextField = "caption" | "copy";

// The field the piece's words live in.
export function pieceTextField(version: PieceVersionText): PieceTextField {
  return version.assetId ? "caption" : "copy";
}

// What the person reads and edits: the field above, the other one when it is
// empty. Undefined without any text.
export function pieceTextOf(
  version: PieceVersionText | null | undefined,
): string | undefined {
  if (!version) return undefined;
  const own = pieceTextField(version);
  const other = own === "caption" ? "copy" : "caption";
  const text = [version[own], version[other]]
    .map((value) => value?.trim())
    .find(Boolean);
  return text ? text.slice(0, PIECE_TEXT_MAX) : undefined;
}

// What a person typed: line breaks kept (at most one blank line in a row), no
// control characters, no padding. Null when nothing is left or it is too long.
export function normalizePieceText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || text.length > PIECE_TEXT_MAX) return null;
  return text;
}

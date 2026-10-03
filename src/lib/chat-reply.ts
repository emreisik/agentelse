// How a chat turn's stored reply reads on screen. Shared by the server (the
// agent, the run routes, the project page) and the chat client, so both agree
// on the placeholders. The full list of reply statuses is CommandReplyStatus
// (src/server/repositories/command.repository.ts).

// What a turn is saved with when it ends without text of its own: stopped
// (the person pressed Stop, or the run hit its deadline) before a word was
// written, or cut off by a process that died mid-turn. The model's history
// keeps it as the assistant's answer; the chat shows the status note instead.
export const STOPPED_REPLY = "(stopped)";
export const INTERRUPTED_REPLY = "(interrupted)";

// True when the reply has no words of its own (a placeholder, or empty).
export function isPlaceholderReply(text: string | null | undefined): boolean {
  const trimmed = text?.trim() ?? "";
  return (
    trimmed === "" || trimmed === STOPPED_REPLY || trimmed === INTERRUPTED_REPLY
  );
}

// A WEB turn still marked RUNNING whose run is gone from this process (a
// restart or deploy ended it mid-turn) reads as interrupted. Display only: the
// next message sent in that chat writes the same state to the row.
export function presentTurnReply(
  row: { source: string; replyText: string | null; replyStatus: string | null },
  runIsLive: boolean,
): { reply: string | null; replyStatus: string | null } {
  if (row.source !== "WEB" || row.replyStatus !== "RUNNING" || runIsLive) {
    return { reply: row.replyText, replyStatus: row.replyStatus };
  }
  return {
    reply: row.replyText ?? INTERRUPTED_REPLY,
    replyStatus: "INTERRUPTED",
  };
}

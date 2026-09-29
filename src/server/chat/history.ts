import type {
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import { AgentelseError } from "@/server/security/errors";

// A persisted Command row as loaded by chat-service's buildContext. SYSTEM
// rows are pipeline events (empty rawText, the event note in replyText); WEB
// rows are a client message plus the assistant's reply.
export type HistoryRow = {
  id: string;
  source: string;
  rawText: string;
  replyText: string | null;
  attachments: unknown;
};

function attachmentNote(attachments: unknown): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const names = (attachments as { filename?: string }[])
    .map((attachment) => attachment.filename ?? "file")
    .join(", ");
  return ` [attached: ${names}]`;
}

// Real role-tagged messages instead of the legacy flattened
// "Client: … / You: … / System: …" string: the model reads its own earlier
// replies as assistant turns and pipeline events as developer notes.
// `excludeId` drops the current turn's own (already created) Command row.
export function buildHistoryInput(
  rows: readonly HistoryRow[],
  excludeId: string,
  // Bodies of recent attachments (history-files.ts), keyed by assetId. Rows
  // whose files are here carry the real image/PDF; the rest keep the note.
  files: ReadonlyMap<string, { mimeType: string; data: string }> = new Map(),
): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const row of rows) {
    if (row.id === excludeId) continue;
    if (row.source === "SYSTEM") {
      if (row.replyText) {
        items.push({
          role: "developer",
          content: `[Agency event] ${row.replyText}`,
        });
      }
      continue;
    }
    const text = `${row.rawText}${attachmentNote(row.attachments)}`;
    const loaded = Array.isArray(row.attachments)
      ? (row.attachments as { assetId?: string }[]).flatMap((a) => {
          const file = a.assetId ? files.get(a.assetId) : undefined;
          return file ? [file] : [];
        })
      : [];
    items.push(
      loaded.length > 0
        ? {
            role: "user",
            content: [
              ...attachmentParts(loaded),
              { type: "input_text", text },
            ],
          }
        : { role: "user", content: text },
    );
    if (row.replyText) {
      items.push({ role: "assistant", content: row.replyText });
    }
  }
  return items;
}

// Long chats must not silently overflow the context window. Older turns are
// dropped from the FRONT until the history fits the character budget (a rough
// but model-agnostic stand-in for tokens), never leaving an orphan assistant
// reply at the start. Recent turns and the live pipeline events matter most;
// older facts stay reachable through the read tools and the brand profile.
export function trimHistory(
  items: ResponseInputItem[],
  maxChars: number,
): ResponseInputItem[] {
  const size = (item: ResponseInputItem) =>
    "content" in item && typeof item.content === "string"
      ? item.content.length
      : 0;
  let total = items.reduce((sum, item) => sum + size(item), 0);
  let start = 0;
  while (total > maxChars && start < items.length) {
    total -= size(items[start]!);
    start += 1;
  }
  while (
    start < items.length &&
    "role" in items[start]! &&
    (items[start] as { role: string }).role === "assistant"
  ) {
    start += 1;
  }
  return items.slice(start);
}

// Attachments map onto Responses API input parts: images as data-URI
// input_image, PDFs as input_file, text/* inlined as text. Anything else
// fails loudly — silently dropping a file would make the model answer
// without context the user believes it has.
function attachmentParts(
  attachments: { mimeType: string; data: string }[],
): ResponseInputContent[] {
  return attachments.map((attachment): ResponseInputContent => {
    if (attachment.mimeType.startsWith("image/")) {
      return {
        type: "input_image",
        detail: "auto",
        image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
      };
    }
    if (attachment.mimeType === "application/pdf") {
      return {
        type: "input_file",
        filename: "attachment.pdf",
        file_data: `data:application/pdf;base64,${attachment.data}`,
      };
    }
    if (attachment.mimeType.startsWith("text/")) {
      return {
        type: "input_text",
        text: Buffer.from(attachment.data, "base64").toString("utf-8"),
      };
    }
    throw new AgentelseError(
      "INVALID_PROVIDER_RESULT",
      `Attachment type is not supported: ${attachment.mimeType}`,
    );
  });
}

export function buildUserInput(
  message: string,
  attachments: { mimeType: string; data: string }[] | undefined,
): ResponseInputItem {
  return {
    role: "user",
    content: [
      // Attachments BEFORE the text: models reference them more reliably
      // when the instruction comes last in multi-modal input.
      ...attachmentParts(attachments ?? []),
      { type: "input_text", text: message || "(see attached files)" },
    ],
  };
}

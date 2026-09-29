import type { ChatStreamEvent } from "./types";

// One event per SSE frame: `event: <type>` + a JSON `data:` line. The JSON
// keeps every field of the event (including `type`), so the client can parse
// a frame without depending on the `event:` line.
export function encodeSseEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// Incremental parser for the client side: feed it raw text chunks as they
// arrive from the fetch body and it returns the complete events found so far,
// keeping any trailing partial frame buffered for the next chunk.
export function createSseParser(): (chunk: string) => ChatStreamEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const events: ChatStreamEvent[] = [];
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (dataLine) {
        try {
          events.push(JSON.parse(dataLine.slice(6)) as ChatStreamEvent);
        } catch {
          // A malformed frame is dropped rather than killing the stream.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    return events;
  };
}

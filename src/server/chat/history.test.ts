import { describe, expect, it } from "vitest";

import { buildHistoryInput, buildUserInput, trimHistory } from "./history";

describe("buildHistoryInput", () => {
  it("maps rows to real roles and skips the current turn's own row", () => {
    const items = buildHistoryInput(
      [
        {
          id: "a",
          source: "WEB",
          rawText: "Merhaba",
          replyText: "Selam!",
          attachments: null,
        },
        {
          id: "b",
          source: "SYSTEM",
          rawText: "",
          replyText: "Creative hazır",
          attachments: null,
        },
        {
          id: "c",
          source: "WEB",
          rawText: "Logoyu incele",
          replyText: null,
          attachments: [{ filename: "logo.png" }],
        },
        {
          id: "current",
          source: "WEB",
          rawText: "yeni mesaj",
          replyText: null,
          attachments: null,
        },
      ],
      "current",
    );

    expect(items).toEqual([
      { role: "user", content: "Merhaba" },
      { role: "assistant", content: "Selam!" },
      { role: "developer", content: "[Agency event] Creative hazır" },
      { role: "user", content: "Logoyu incele [attached: logo.png]" },
    ]);
  });
});

describe("buildHistoryInput with loaded files", () => {
  it("attaches the real image to the turn that sent it", () => {
    const items = buildHistoryInput(
      [
        {
          id: "a",
          source: "WEB",
          rawText: "Logoyu incele",
          replyText: null,
          attachments: [{ assetId: "a1", filename: "logo.png" }],
        },
      ],
      "cur",
      new Map([["a1", { mimeType: "image/png", data: "AAA" }]]),
    );
    expect(items).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            detail: "auto",
            image_url: "data:image/png;base64,AAA",
          },
          { type: "input_text", text: "Logoyu incele [attached: logo.png]" },
        ],
      },
    ]);
  });
});

describe("buildUserInput", () => {
  it("puts attachments before the text and inlines text files", () => {
    const item = buildUserInput("Bunu özetle", [
      { mimeType: "image/png", data: "AAA" },
      { mimeType: "text/plain", data: Buffer.from("not").toString("base64") },
    ]);
    expect(item).toEqual({
      role: "user",
      content: [
        {
          type: "input_image",
          detail: "auto",
          image_url: "data:image/png;base64,AAA",
        },
        { type: "input_text", text: "not" },
        { type: "input_text", text: "Bunu özetle" },
      ],
    });
  });

  it("rejects unsupported attachment types loudly", () => {
    expect(() =>
      buildUserInput("x", [{ mimeType: "application/zip", data: "AA" }]),
    ).toThrow(/not supported/);
  });
});

describe("trimHistory", () => {
  const msg = (role: "user" | "assistant", content: string) =>
    ({ role, content }) as const;

  it("keeps everything that fits", () => {
    const items = [msg("user", "aaa"), msg("assistant", "bbb")];
    expect(trimHistory(items, 100)).toEqual(items);
  });

  it("drops the oldest turns and never starts on an orphan assistant reply", () => {
    const items = [
      msg("user", "x".repeat(50)),
      msg("assistant", "y".repeat(50)),
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
    ];
    // Budget fits the last two plus a bit: the first user message goes, and
    // so does the assistant reply that would now be orphaned.
    const trimmed = trimHistory(items, 60);
    expect(trimmed).toEqual([
      msg("user", "recent question"),
      msg("assistant", "recent answer"),
    ]);
  });
});

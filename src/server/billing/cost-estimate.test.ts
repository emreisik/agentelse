import { describe, expect, it } from "vitest";

import { priceReasoningCall } from "@/server/reasoning/reasoning-pricing";

import {
  ASSUMED_SEARCH_CALLS,
  PROMPT_OVERHEAD_CHARS,
  conversationChars,
  estimateChatRoundMicros,
  estimateTextCallCostUsd,
  estimateTextCallMicros,
} from "./cost-estimate";

describe("estimateTextCallCostUsd", () => {
  it("prices the whole output budget plus the estimated input", () => {
    const usd = estimateTextCallCostUsd({
      model: "gpt-5.6-luna",
      inputChars: 3_000,
      maxOutputTokens: 4_096,
    });
    // 1_000 input tokens x $1/M + 4_096 output tokens x $6/M.
    expect(usd).toBeCloseTo(0.001 + 4_096 * 6e-6, 9);
  });

  it("adds the assumed web searches", () => {
    const base = { model: "gpt-5.6-luna", inputChars: 0, maxOutputTokens: 0 };
    expect(
      estimateTextCallCostUsd({ ...base, searchCalls: ASSUMED_SEARCH_CALLS }) -
        estimateTextCallCostUsd(base),
    ).toBeCloseTo(ASSUMED_SEARCH_CALLS * 0.01, 9);
  });

  it("is never below what a typical real call costs", () => {
    // A 4k-token answer to an 8k-token prompt, no cache.
    const real = priceReasoningCall({
      model: "gpt-5.6-luna",
      inputTokens: 8_000,
      outputTokens: 4_000,
    }).costUsd;
    const estimate = estimateTextCallCostUsd({
      model: "gpt-5.6-luna",
      inputChars: PROMPT_OVERHEAD_CHARS,
      maxOutputTokens: 4_096,
    });
    expect(estimate).toBeGreaterThanOrEqual(real);
  });

  it("prices an unknown model at the flagship rate (over-, not under-estimate)", () => {
    const unknown = estimateTextCallCostUsd({
      model: "some-future-model",
      inputChars: 3_000,
      maxOutputTokens: 1_000,
    });
    const flagship = estimateTextCallCostUsd({
      model: "gpt-5.6-sol",
      inputChars: 3_000,
      maxOutputTokens: 1_000,
    });
    expect(unknown).toBeCloseTo(flagship, 9);
  });

  it("clamps nonsense input instead of going negative", () => {
    expect(
      estimateTextCallCostUsd({
        model: "gpt-5.6-luna",
        inputChars: -5,
        maxOutputTokens: -5,
      }),
    ).toBe(0);
  });
});

describe("estimateTextCallMicros", () => {
  it("returns whole micro-dollars", () => {
    expect(
      estimateTextCallMicros({
        model: "gpt-5.6-luna",
        inputChars: 3_000,
        maxOutputTokens: 4_096,
      }),
    ).toBe(BigInt(Math.round((0.001 + 4_096 * 6e-6) * 1_000_000)));
  });
});

// An attachment travels in the conversation as a base64 data URL. It must count
// as ONE fixed amount (about a picture's tokens), never by its size: counted as
// text, a single 8 MB photo would be millions of "tokens", the round's hold would
// exceed nearly any plan's allowance and every chat with a picture would be
// refused.
const FILE_CHARS = 6_000;
const EIGHT_MB = 8 * 1024 * 1024;
const dataUrl = (payloadChars: number) =>
  `data:image/png;base64,${"A".repeat(payloadChars)}`;

describe("conversationChars", () => {
  it("counts plain text by its length", () => {
    expect(conversationChars("")).toBe(0);
    expect(conversationChars("Merhaba")).toBe(7);
  });

  it("counts a data: URL as one fixed amount, whatever its size", () => {
    expect(conversationChars(dataUrl(10))).toBe(FILE_CHARS);
    expect(conversationChars(dataUrl(EIGHT_MB))).toBe(FILE_CHARS);
  });

  it("only a string that STARTS with data: is a file", () => {
    const quoted = `look at ${dataUrl(2_000)}`;
    expect(conversationChars(quoted)).toBe(quoted.length);
  });

  it("adds up every string in nested arrays and objects; keys and non-text values do not count", () => {
    expect(
      conversationChars([
        { note: "abc", more: ["de", { deep: "f" }] },
        "gggg",
        42,
        true,
        null,
        undefined,
      ]),
    ).toBe(3 + 2 + 1 + 4);
  });

  it("counts what a chat turn really carries: text, a picture, a tool call and its output", () => {
    const turn = (picture: string, toolOutput: string) => [
      { role: "developer", content: "x".repeat(100) },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: picture },
          { type: "input_text", text: "y".repeat(40) },
        ],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "create_task",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call-1", output: toolOutput },
    ];
    const base = conversationChars(turn(dataUrl(10), "{}"));

    // The picture is worth the fixed amount, not its size ...
    expect(conversationChars(turn(dataUrl(EIGHT_MB), "{}"))).toBe(base);
    expect(base - conversationChars(turn("", "{}"))).toBe(FILE_CHARS);
    // ... while a tool's output (a JSON string) counts by its length.
    const output = JSON.stringify({ ok: true, rows: ["a".repeat(500)] });
    expect(conversationChars(turn(dataUrl(10), output))).toBe(
      base - "{}".length + output.length,
    );
  });

  it("stops descending below the depth cap, so a self-referencing structure ends", () => {
    const nested = (levels: number, leaf: string): unknown =>
      levels === 0 ? leaf : [nested(levels - 1, leaf)];
    expect(conversationChars(nested(3, "x".repeat(100)))).toBe(100);
    expect(conversationChars(nested(50, "x".repeat(100)))).toBe(0);

    const loop: Record<string, unknown> = { text: "abc" };
    loop.self = loop;
    const counted = conversationChars(loop);
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThan(1_000);
  });
});

describe("estimateChatRoundMicros", () => {
  const empty = {
    model: "gpt-5.6-luna",
    instructions: "",
    conversation: [] as unknown,
    maxOutputTokens: 0,
    webSearch: false,
  };
  const typed = (chars: number) => [{ content: "y".repeat(chars) }];

  it("prices the instructions, the conversation and the whole output budget", () => {
    // 3_000 + 6_000 characters = 3_000 input tokens x $1/M, plus 1_000 output
    // tokens x $6/M.
    expect(
      estimateChatRoundMicros({
        ...empty,
        instructions: "x".repeat(3_000),
        conversation: typed(6_000),
        maxOutputTokens: 1_000,
      }),
    ).toBe(BigInt(3_000 + 6_000));
  });

  it("prices the round at the model it runs on, and an unknown model at the flagship rate", () => {
    const priced = (model: string) =>
      estimateChatRoundMicros({
        ...empty,
        model,
        instructions: "x".repeat(3_000),
        maxOutputTokens: 1_000,
      });

    // A cheaper model holds less, a dearer one holds more ...
    expect(priced("gpt-5.4-mini")).toBeLessThan(priced("gpt-5.6-luna"));
    expect(priced("gpt-5.6-luna")).toBeLessThan(priced("gpt-5.6-sol"));
    // ... and a name the price list does not know is held at the flagship rate,
    // so a hold is never too small.
    expect(priced("some-future-model")).toBe(priced("gpt-5.6-sol"));
  });

  it("grows with the length of the conversation", () => {
    const short = estimateChatRoundMicros({
      ...empty,
      conversation: typed(3_000),
    });
    const long = estimateChatRoundMicros({
      ...empty,
      conversation: typed(30_000),
    });
    expect(long).toBeGreaterThan(short);
    // 27_000 more characters = 9_000 more input tokens at $1/M.
    expect(long - short).toBe(BigInt(9_000));
  });

  it("stays bounded when the conversation holds an 8 MB attachment: it costs what a 6000-character text would", () => {
    const withPicture = (url: string) => [
      { role: "user", content: [{ type: "input_image", image_url: url }] },
    ];
    const asText = estimateChatRoundMicros({
      ...empty,
      conversation: withPicture("x".repeat(FILE_CHARS)),
    });
    const withAttachment = estimateChatRoundMicros({
      ...empty,
      conversation: withPicture(dataUrl(EIGHT_MB)),
    });
    expect(withAttachment).toBe(asText);
    // Read as text, 8 MB would be about 2.8 million tokens (millions of micro-USD).
    expect(withAttachment).toBeLessThan(BigInt(10_000));
  });

  it("adds the assumed web searches when search is on", () => {
    const off = estimateChatRoundMicros(empty);
    const on = estimateChatRoundMicros({ ...empty, webSearch: true });
    // $0.01 per search = 10_000 micro-USD.
    expect(on - off).toBe(BigInt(ASSUMED_SEARCH_CALLS * 10_000));
  });
});

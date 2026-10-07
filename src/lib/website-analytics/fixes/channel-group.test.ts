import { describe, expect, it } from "vitest";
import {
  GA_AI_CHANNEL_FIELD,
  aiAssistantsRegex,
  buildAiChannelGroup,
} from "./channel-group";

describe("buildAiChannelGroup", () => {
  const group = buildAiChannelGroup();
  const rule = group.groupingRule[0];
  const filter = rule?.expression.filter;
  const regex = new RegExp(filter?.stringFilter.value ?? "(", "");

  it("şekil", () => {
    expect(group.displayName).toBe("AI assistants");
    expect(group.description).toBe("Created by Agentelse");
    expect(group.groupingRule).toHaveLength(1);
    expect(rule?.displayName).toBe("AI assistants");
    expect(filter?.fieldName).toBe(GA_AI_CHANNEL_FIELD);
    expect(GA_AI_CHANNEL_FIELD).toBe("eachScopeSource");
    expect(filter?.stringFilter.matchType).toBe("PARTIAL_REGEXP");
  });

  it("ifade derlenir ve yapay zekâ kaynaklarını eşler", () => {
    for (const source of [
      "chatgpt.com",
      "chat.openai.com",
      "perplexity.ai",
      "gemini.google.com",
      "copilot.microsoft.com",
      "claude.ai",
      "www.perplexity.ai",
      "chatgpt",
      "perplexity",
      "claude",
      "poe.com",
    ]) {
      expect(regex.test(source), source).toBe(true);
    }
  });

  it("arama motorlarını ve benzer adları eşlemez", () => {
    for (const source of [
      "google",
      "bing",
      "google.com",
      "instagram.com",
      "facebook.com",
      "(direct)",
      "notchatgpt.com",
      "perplexity.ai.evil.example",
      "chatgptx",
      "xclaude.ai",
    ]) {
      expect(regex.test(source), source).toBe(false);
    }
  });

  it("değer uzunluğu en çok 800 ve çıktı belirleyici", () => {
    expect((filter?.stringFilter.value ?? "").length).toBeLessThanOrEqual(800);
    expect(JSON.stringify(buildAiChannelGroup())).toBe(JSON.stringify(group));
    expect(aiAssistantsRegex()).toBe(filter?.stringFilter.value);
  });

  it("alan adlarındaki noktalar kaçırılır", () => {
    expect(aiAssistantsRegex()).toContain("chatgpt\\.com");
    expect(regex.test("chatgptXcom")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { AI_ASSISTANTS, aiAssistantOf } from "./ai-sources";

// Bu dosyanın kanıtladığı: asistan alan adları, alt alan adları ve kısa
// adlar eşleşir; arama motorları ve sıradan siteler eşleşmez.

describe("aiAssistantOf", () => {
  it("matches assistant domains, subdomains and aliases", () => {
    expect(aiAssistantOf("chatgpt.com")).toBe("ChatGPT");
    expect(aiAssistantOf("chat.openai.com")).toBe("ChatGPT");
    expect(aiAssistantOf("www.perplexity.ai")).toBe("Perplexity");
    expect(aiAssistantOf("gemini.google.com")).toBe("Gemini");
    expect(aiAssistantOf("chatgpt")).toBe("ChatGPT");
    expect(aiAssistantOf("ChatGPT")).toBe("ChatGPT");
    expect(aiAssistantOf("copilot.microsoft.com")).toBe("Copilot");
    expect(aiAssistantOf("claude.ai")).toBe("Claude");
    expect(aiAssistantOf("meta.ai")).toBe("Meta AI");
    expect(aiAssistantOf("https://chatgpt.com/c/abc")).toBe("ChatGPT");
  });

  it("does not match search engines or other sites", () => {
    expect(aiAssistantOf("google")).toBeNull();
    expect(aiAssistantOf("google.com")).toBeNull();
    expect(aiAssistantOf("bing")).toBeNull();
    expect(aiAssistantOf("bing.com")).toBeNull();
    expect(aiAssistantOf("example.com")).toBeNull();
    expect(aiAssistantOf("notchatgpt.com")).toBeNull();
    expect(aiAssistantOf("(direct)")).toBeNull();
    expect(aiAssistantOf("")).toBeNull();
  });

  it("names are unique", () => {
    const names = AI_ASSISTANTS.map((assistant) => assistant.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

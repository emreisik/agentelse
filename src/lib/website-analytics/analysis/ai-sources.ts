// GA-F4 AN7: yapay zekâ asistanlarından gelen ziyaretler
// (docs/google-analytics-plan.md §6.2 AN7; ayrıntı docs/website-insights.md).
// sessionSource değeri alan adı ya da kısa addır ("chatgpt.com",
// "perplexity"). Asistan adları sinyal metninde görünebilen tek kaynak
// adlarıdır. Saf ve izomorfik.

export const AI_ASSISTANTS: readonly {
  name: string;
  domains: readonly string[];
  aliases: readonly string[];
}[] = [
  {
    name: "ChatGPT",
    domains: ["chatgpt.com", "chat.openai.com", "openai.com"],
    aliases: ["chatgpt"],
  },
  { name: "Perplexity", domains: ["perplexity.ai"], aliases: ["perplexity"] },
  {
    name: "Gemini",
    domains: ["gemini.google.com", "bard.google.com"],
    aliases: ["gemini"],
  },
  { name: "Copilot", domains: ["copilot.microsoft.com"], aliases: ["copilot"] },
  { name: "Claude", domains: ["claude.ai"], aliases: ["claude"] },
  {
    name: "DeepSeek",
    domains: ["chat.deepseek.com", "deepseek.com"],
    aliases: ["deepseek"],
  },
  { name: "Meta AI", domains: ["meta.ai"], aliases: [] },
  { name: "Grok", domains: ["grok.com"], aliases: [] },
  { name: "Mistral", domains: ["chat.mistral.ai"], aliases: [] },
  { name: "You.com", domains: ["you.com"], aliases: [] },
  { name: "Poe", domains: ["poe.com"], aliases: [] },
  { name: "Phind", domains: ["phind.com"], aliases: [] },
];

// Küçük harf, "www." ve varsa şema/yol/port atılır; alan adı tam ya da alt
// alan adı olarak, kısa ad birebir eşleşir. Google ve Bing arama asistan
// sayılmaz.
export function aiAssistantOf(source: string): string | null {
  if (typeof source !== "string") return null;
  let host = source.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split(":")[0] ?? "";
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host) return null;
  for (const assistant of AI_ASSISTANTS) {
    if (assistant.aliases.includes(host)) return assistant.name;
    for (const domain of assistant.domains) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        return assistant.name;
      }
    }
  }
  return null;
}

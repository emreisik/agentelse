export const OPENAI_CREDIT_REFRESH_EVENT = "openai-credit:refresh";

// Spend lands the moment an AI call finishes, so whoever just finished one
// (a chat turn, a creative card) asks the header pill to re-read the balance
// now instead of waiting for its next poll.
export function requestOpenAiCreditRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPENAI_CREDIT_REFRESH_EVENT));
}

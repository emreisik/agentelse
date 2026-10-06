// Politika lint'i (docs/meta-ads-plan.md §6 P6). Meta'nın en sık reddettiği
// metin kalıplarını lansmandan önce işaretler; engellemez, Review'da uyarır.
// Kişisel özellik iması ("Are you overweight?"), kesin sonuç vaadi, öncesi /
// sonrası ve büyük harf bağırması.

export type PolicyFlag = {
  rule: "personal_attributes" | "guaranteed_results" | "before_after" | "shouting" | "sensational";
  text: string;
  message: string;
};

const PERSONAL = [
  /\b(are you|do you have|you(?:'re| are))\s+(over\s?weight|fat|depressed|diabetic|in debt|broke|divorced|single|gay|lesbian|pregnant|bald|sick|anxious|addicted)\b/i,
  /\b(şişman|kilolu|depresyonda|borçlu|bekar|hamile)\s+(misin|mısın|musun|müsün)\b/i,
];

const GUARANTEED = [
  /\b(guaranteed|guarantee|100%\s*(?:results|success|safe|free)|risk[- ]free|no risk|instant(?:ly)? (?:cure|results))\b/i,
  /\b(garantili|kesin sonuç|%100 (?:sonuç|başarı|güvenli)|risksiz)\b/i,
];

const BEFORE_AFTER = [/\bbefore\s*(?:&|and|\/)\s*after\b/i, /\böncesi\s*(?:ve|\/)\s*sonrası\b/i];

const SENSATIONAL = [/\b(shocking|you won'?t believe|miracle|doctors hate)\b/i, /\b(şok|inanamayacaksınız|mucize)\b/i];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function policyLint(text: string): PolicyFlag[] {
  const flags: PolicyFlag[] = [];
  const personal = firstMatch(text, PERSONAL);
  if (personal) {
    flags.push({
      rule: "personal_attributes",
      text: personal,
      message: "Meta rejects ads that imply they know a personal trait of the reader. Speak about the offer instead.",
    });
  }
  const guaranteed = firstMatch(text, GUARANTEED);
  if (guaranteed) {
    flags.push({
      rule: "guaranteed_results",
      text: guaranteed,
      message: "Promised or guaranteed results are often rejected. Describe what the offer is.",
    });
  }
  const beforeAfter = firstMatch(text, BEFORE_AFTER);
  if (beforeAfter) {
    flags.push({
      rule: "before_after",
      text: beforeAfter,
      message: "Before-and-after claims are restricted for health and beauty ads.",
    });
  }
  const sensational = firstMatch(text, SENSATIONAL);
  if (sensational) {
    flags.push({
      rule: "sensational",
      text: sensational,
      message: "Sensational wording lowers ad quality and can be rejected.",
    });
  }
  const letters = text.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, "");
  const upper = text.replace(/[^A-ZÇĞİÖŞÜ]/g, "");
  if (letters.length >= 20 && upper.length / letters.length > 0.6) {
    flags.push({
      rule: "shouting",
      text: text.slice(0, 40),
      message: "Mostly capital letters reads as shouting and can be limited.",
    });
  }
  return flags;
}

import { createHash } from "node:crypto";

// Deterministic dedup fingerprints for signals/insights/opportunities/tasks.
// Normalization keeps trivially-different phrasings ("New iPhone!" vs
// "new iphone") on the same fingerprint while staying cheap and predictable.
// Pure module — safe to unit test without server-only.

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s.-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprintOf(
  ...parts: Array<string | undefined | null>
): string {
  const joined = parts
    .filter((p): p is string => Boolean(p && p.trim()))
    .map(normalize)
    .join("|");
  return createHash("sha256").update(joined).digest("hex").slice(0, 32);
}

export function signalFingerprint(input: {
  category: string;
  source: string;
  externalRef?: string | null;
  title: string;
}): string {
  return fingerprintOf(
    input.category,
    input.source,
    input.externalRef ?? input.title,
  );
}

export function insightFingerprint(input: {
  category?: string | null;
  title: string;
}): string {
  return fingerprintOf("insight", input.category ?? "general", input.title);
}

export function opportunityFingerprint(input: {
  category?: string | null;
  title: string;
}): string {
  return fingerprintOf("opportunity", input.category ?? "general", input.title);
}

export function taskFingerprint(input: {
  capability: string;
  department?: string | null;
  subject: string;
}): string {
  return fingerprintOf(
    "task",
    input.capability,
    input.department ?? "-",
    input.subject,
  );
}

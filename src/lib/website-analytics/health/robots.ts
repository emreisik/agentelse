// GA-F3 site taraması (docs/measurement-health.md "Site taraması"): küçük
// robots.txt ayrıştırıcısı. Yalnız user-agent / allow / disallow satırları
// okunur (büyük-küçük harf duyarsız, # yorumları atılır). Ardışık
// user-agent satırları tek grup kurar. Eşleşme Google'ın kuralıyla: en uzun
// eşleşen kalıp kazanır, eşitlikte allow; `*` joker, sondaki `$` çapa; boş
// Disallow yok sayılır. Bozuk metin istisna atmaz, yalnız daha az kural verir.
// Eşleştirme SC-F3'ün elle yazılmış eşleştiricisiyle yapılır: robots.txt
// içeriğinden RegExp kurulmaz (ReDoS yok), O(desen × yol).

import { robotsPatternMatches } from "@/lib/seo/robots-parser";

export type RobotsRules = {
  groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[];
};

const MAX_ROBOTS_CHARS = 500_000;

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  if (typeof text !== "string" || text.length === 0) return { groups };

  let current: RobotsRules["groups"][number] | null = null;
  // Son satır user-agent miydi: ardışık user-agent'lar aynı grubu büyütür.
  let collectingAgents = false;

  const lines = text
    .slice(0, MAX_ROBOTS_CHARS)
    .replace(/^﻿/, "")
    .split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      // Grup öncesi kural sahipsizdir.
      if (!current) continue;
      current.rules.push({ allow: key === "allow", path: value });
      continue;
    }
    // Sitemap, crawl-delay vb. grubu bölmez ama ajan listesini kapatır.
    collectingAgents = false;
  }
  return { groups };
}

export function robotsAllows(
  rules: RobotsRules,
  token: string,
  path: string,
): boolean {
  const wanted = token.toLowerCase();
  let groups = rules.groups.filter((group) => group.agents.includes(wanted));
  if (groups.length === 0) {
    groups = rules.groups.filter((group) => group.agents.includes("*"));
  }
  if (groups.length === 0) return true;

  let best: { length: number; allow: boolean } | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      // Boş Disallow "her şeye izin" demektir; boş Allow da bir şey seçmez.
      if (rule.path === "") continue;
      if (!robotsPatternMatches(rule.path, path)) continue;
      const length = rule.path.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow)
      ) {
        best = { length, allow: rule.allow };
      }
    }
  }
  return best ? best.allow : true;
}

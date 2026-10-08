import "server-only";

import { adTextsOf, literalRuleHits } from "@/lib/ads/brand-gate";
import type { AdsLaunchSpec, LaunchIssue } from "@/lib/ads/launch-spec";
import { shortHash } from "@/lib/ads/mirror";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import { creativeClaimCheckDef } from "@/server/reasoning/prompts/creative-claim-check";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// Marka kapısı (docs/meta-ads-autonomy.md): reklam Meta'ya gitmeden önce
// markanın "asla yapma" kurallarına ve onaylı iddia listesine karşı denetlenir.
// Kesin kural ihlali her zaman engeller. Anlamsal denetim (onaysız iddia) insan
// onaylı lansmanda uyarıdır, çünkü onaylayan kişi zaten görüyor; insansız
// çalışacak otonomide (strict) engeldir ve denetim yapılamazsa da engeldir.

export type BrandGateResult = { issues: LaunchIssue[]; notes: string[] };

const MEMO_MS = 10 * 60_000;
const memo = new Map<string, { at: number; safe: boolean; reason?: string }>();

export async function brandGate(input: {
  workspaceId: string;
  projectId: string;
  spec: AdsLaunchSpec;
  strict?: boolean;
}): Promise<BrandGateResult> {
  const result: BrandGateResult = { issues: [], notes: [] };
  const texts = adTextsOf(input.spec);
  if (texts.length === 0) return result;

  const twin = await getBrandTwin(input.projectId, { memory: false }).catch(
    () => null,
  );
  if (!twin) return result;
  const rules = twin.negativeRules;
  const claims = twin.approvedClaims;
  if (rules.length === 0 && claims.length === 0) return result;

  const hits = literalRuleHits(texts, rules);
  for (const hit of hits) {
    result.issues.push({
      rule: "BRAND",
      field: hit.field,
      severity: "block",
      message: `This text breaks a brand rule ("${hit.rule}"). Edit the post's words.`,
    });
  }
  if (hits.length > 0) return result;

  // Anlamsal denetim: tek sınırlı çağrı; aynı metin ve kurallar için kısa süre
  // saklanır (Review her açılışta yeniden kontrol eder).
  const description = texts.map((t) => t.text).join("\n");
  const key = shortHash(
    JSON.stringify([description, rules, claims, input.spec.campaignName]),
  );
  const now = Date.now();
  let verdict = memo.get(key);
  if (!verdict || now - verdict.at > MEMO_MS) {
    try {
      const { output } = await ReasoningService.run(creativeClaimCheckDef, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: twin.brandId,
        context: {
          title: input.spec.campaignName,
          description,
          approvedClaims: claims,
          negativeRules: rules,
        },
      });
      verdict = { at: now, safe: output.safe, reason: output.reason };
      memo.set(key, verdict);
      if (memo.size > 100) memo.delete(memo.keys().next().value as string);
    } catch (error) {
      console.warn(
        `[ads] brand claim check unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (input.strict) {
        result.issues.push({
          rule: "BRAND",
          field: "ads.0.creative.message",
          severity: "block",
          message: "The brand check couldn't run, so this can't go out unattended.",
        });
      } else {
        result.notes.push("The brand check couldn't run; read the text once more before approving.");
      }
      return result;
    }
  }
  if (!verdict.safe) {
    const message = `Brand check: ${verdict.reason ?? "this text may state something the brand hasn't approved."}`;
    if (input.strict) {
      result.issues.push({
        rule: "BRAND",
        field: "ads.0.creative.message",
        severity: "block",
        message,
      });
    } else {
      result.issues.push({
        rule: "BRAND",
        field: "ads.0.creative.message",
        severity: "warn",
        message,
      });
    }
  }
  return result;
}

import "server-only";

import { SeoActionEvaluator } from "./evaluate";
import { SeoLearnings } from "./learnings";
import { SeoActionRetention } from "./retention";
import { SeoActionVerifier } from "./verify";

// Tick adımlarının girişi (seo-action-verify ve seo-action-evaluate). Her
// parça ayrı yakalanır: biri düşse diğerleri çalışır, tick hiç fırlatılmaz.
// Bayrak kapalıyken koşucular veritabanına gitmeden 0 döner; saklama kendi
// kapısını kendisi taşır (bayrak kapandıktan sonra da 36 aylık süreyi işler).

const RUN_LIMIT = 10;

async function guarded(
  label: string,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch {
    console.warn(`[seo-actions] ${label} failed`);
    return 0;
  }
}

export const SeoActionJobs = {
  async verify(now: Date = new Date()): Promise<number> {
    return guarded("verify", () => SeoActionVerifier.runDue(RUN_LIMIT, now));
  },

  async evaluate(now: Date = new Date()): Promise<number> {
    const evaluated = await guarded("evaluate", () =>
      SeoActionEvaluator.runDue(RUN_LIMIT, now),
    );
    const learned = await guarded("learnings", () =>
      SeoLearnings.writeDue(now),
    );
    const retained = await guarded("retention", () =>
      SeoActionRetention.runDue(now),
    );
    return evaluated + learned + retained;
  },
};

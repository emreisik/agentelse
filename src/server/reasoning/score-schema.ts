import { z } from "zod";

// A 0-1 score field for reasoning-def output schemas. reasoning-service.ts
// passes `z.toJSONSchema(def.schema)` to the provider as a structured-output
// constraint, but neither Gemini's nor OpenAI's structured-output modes
// actually enforce JSON Schema's numeric `minimum`/`maximum` keywords — only
// type/required/enum/properties are. A model asked for a "score" with no
// worked example routinely answers on a 0-100 scale instead, which used to
// crash the plain `.min(0).max(1)` field at `def.schema.parse(result.raw)`
// with a bare Zod "too_big" error surfaced verbatim to the setup UI.
// This normalizes two out-of-range-but-plausible mistakes before the final
// bounds check, instead of only ever rejecting them: a percentage-scale
// answer (>2 and <=100, e.g. 85 meaning 0.85) is divided down; a small
// overshoot (>1 and <=2, e.g. 1.2 — a rounding slip, not a percentage) is
// clamped to 1 rather than divided, which would otherwise produce a tiny,
// nonsensical fraction (1.5 -> 0.015).
export function zScoreFraction() {
  return z
    .number()
    .transform((value) => {
      if (value > 2 && value <= 100) return value / 100;
      if (value > 1 && value <= 2) return 1;
      return value;
    })
    .pipe(z.number().min(0).max(1));
}

// A bounded score field for scales other than 0-1 (0-10 rubrics, 0-100
// percentages, etc). Two corrections, same rationale as zScoreFraction
// above: providers don't enforce numeric min/max, so a model can return
// out-of-range numbers.
//   - A value strictly between 0 and 1 is essentially never an intentional
//     near-zero score on a scale that goes well above 1 — it's almost
//     always the 0-1 fraction convention leaking in from elsewhere in the
//     same reasoning pass (e.g. 0.72 meant as "72" on a 0-100 scale, or 0.85
//     meant as "8.5" on a 0-10 scale). Rescaled onto this field's own range
//     instead of silently kept as a near-zero value that reads as
//     "irrelevant"/"terrible" when the model meant high.
//   - Anything else out of range is clamped rather than crashed on: unlike
//     the 0-1 case, there's no single reliable guess for which OTHER scale
//     a stray big number came from (a stray 85 on a 0-10 field could be a
//     /10 slip, a /100 slip, or noise) — clamping is directionally safe
//     without inventing a specific, possibly-wrong rescaled number.
export function zBoundedScore(min: number, max: number) {
  return z
    .number()
    .transform((value) => {
      if (value > 0 && value < 1 && max > 1) return value * max;
      return Math.min(max, Math.max(min, value));
    })
    .pipe(z.number().min(min).max(max));
}

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

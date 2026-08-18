import { z } from "zod";

// Loose on purpose: `result.meta` carries dozens of internal fields (prompt
// reports, tool schemas, token budgets, ...) that vary by OpenClaw version
// and flags. We validate only the path we actually read and let everything
// else pass through unvalidated rather than re-encoding OpenClaw's entire
// internal shape here.
export const openClawRawAgentResponseSchema = z.object({
  runId: z.string(),
  status: z.string(),
  summary: z.string().optional(),
  result: z
    .object({
      payloads: z
        .array(z.object({ text: z.string().optional() }).passthrough())
        .optional(),
      meta: z
        .object({
          finalAssistantVisibleText: z.string().optional(),
          agentMeta: z
            .object({
              sessionId: z.string().optional(),
              provider: z.string().optional(),
              model: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

// `openclaw agents list --json` — only the id matters here; everything else
// (workspace, model, bindings) is ignored on purpose so a CLI upgrade that
// adds fields doesn't break agent resolution.
export const openClawAgentListSchema = z.array(
  z.object({ id: z.string() }).passthrough(),
);

import "server-only";

import type { PostStyleAnalysis } from "@/lib/post-style";
import { postStyleExampleDef } from "@/server/reasoning/prompts/post-style";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

export type PostStyleScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Reads one example post into its design recipe. Best-effort: a failed analysis
// is null and the example is kept anyway (the pictures still guide the model;
// the recipe can be run again from the Brand Brain).
export async function analyzePostStyleImage(input: {
  scope: PostStyleScope;
  image: { mimeType: string; data: string };
  label?: string;
}): Promise<PostStyleAnalysis | null> {
  try {
    const result = await ReasoningService.run(postStyleExampleDef, {
      workspaceId: input.scope.workspaceId,
      projectId: input.scope.projectId,
      brandId: input.scope.brandId,
      attachments: [input.image],
      context: { label: input.label ?? "" },
    });
    return result.output;
  } catch (error) {
    console.error(
      "[post-style] analysis failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

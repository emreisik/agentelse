import { exampleSummary } from "@/lib/post-style";
import { loadPostStyle } from "@/server/brand/post-style-store";

import { PostStyleCard, type PostStyleExampleView } from "./post-style-card";

// The Brand Brain's Post style card, read from the brand's Post Style Kit
// (lib/post-style.ts). Sits under the Visual Identity card: the identity says what
// the brand looks like, the kit says how its posts are laid out.
export async function PostStyleSection({
  projectId,
  brandId,
}: {
  projectId: string;
  brandId: string;
}) {
  const kit = await loadPostStyle(brandId);
  const examples: PostStyleExampleView[] = [...kit.examples]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .map((example) => ({
      assetId: example.assetId,
      label: example.label,
      enabled: example.enabled,
      source: example.source,
      summary: example.analysis ? exampleSummary(example) : null,
      recipe: example.analysis?.recipe.trim() || null,
    }));
  return (
    <PostStyleCard
      projectId={projectId}
      examples={examples}
      directives={kit.directives}
    />
  );
}

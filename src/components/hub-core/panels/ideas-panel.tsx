import { IdeasBoard } from "@/components/ideas/ideas-board";
import { loadIdeaBoard } from "@/server/ideas/idea-board";
import type { PanelProps } from "./panel-props";

// The Ideas board (docs/ideas.md): the idea pool as the posts, articles and
// ads it can become, kept full by the Brand Brain loop and filled on demand.
// An idea link (entity=idea:<id>, from the Brand Brain or the daily brief)
// opens that idea's detail.
export async function IdeasPanel({ projectId, entity }: PanelProps) {
  const data = await loadIdeaBoard(projectId);
  const selected = entity && entity.kind === "idea" ? entity.id : null;
  return <IdeasBoard data={data} initialSelected={selected} />;
}

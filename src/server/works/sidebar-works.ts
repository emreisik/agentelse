import "server-only";

import type { RecentRow } from "@/lib/works/recents-announcer";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isWorksEnabled } from "@/server/works/flag";

// The sidebar's Recents (docs/works.md): the project's chats, newest first.
// Undefined when Works is off, or when the read fails (e.g. the migration is not
// applied yet): the sidebar then renders exactly as it did before Works.
export async function loadSidebarWorks(
  projectId: string,
): Promise<RecentRow[] | undefined> {
  if (!isWorksEnabled()) return undefined;
  try {
    const works = await WorkRepository.recents(projectId);
    return works.map(({ id, title, summary, status }) => ({
      id,
      title,
      summary,
      status,
    }));
  } catch {
    return undefined;
  }
}

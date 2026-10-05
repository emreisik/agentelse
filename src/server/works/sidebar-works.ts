import "server-only";

import type { SidebarWorks } from "@/components/layout/work-list";
import { WorkRepository } from "@/server/repositories/work.repository";
import { isModulesEnabled, isWorksEnabled } from "@/server/works/flag";

// The sidebar's Recents (docs/works.md): the project's chats, newest first, and
// whether modules are on (MODULES_UI: the Modules group, each chat's module).
// Undefined when Works is off, or when the read fails (e.g. the migration is not
// applied yet): the sidebar then renders exactly as it did before Works.
export async function loadSidebarWorks(
  projectId: string,
): Promise<SidebarWorks | undefined> {
  if (!isWorksEnabled()) return undefined;
  try {
    const works = await WorkRepository.recents(projectId);
    // Off, no row carries its module: the sidebar is as before modules.
    const modulesUi = isModulesEnabled();
    return {
      recents: works.map(({ id, title, summary, status, module }) => ({
        id,
        title,
        summary,
        status,
        module: modulesUi ? module : null,
      })),
      modulesUi,
    };
  } catch {
    return undefined;
  }
}

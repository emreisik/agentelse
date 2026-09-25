"use client";

import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarNav, type SidebarFlow } from "@/components/layout/sidebar-nav";

// Brand Workspace shell (docs/brand-workspace-migration.md paragraph 7): the
// workspace root view hides the docked sidebar, which is the only place
// Ideas/Work/Connectors/Ads Manager/the "Initiatives" jump
// list are reachable from. This reuses SidebarNav completely unmodified,
// same component, same data, just shown on demand in an overlay instead
// of docked, so nothing is recreated or newly hidden.
export function WorkspaceNavSheet({
  activeProjectId,
  flows,
}: {
  activeProjectId: string;
  flows?: SidebarFlow[] | null;
}) {
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More navigation"
            title="More"
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </SheetTrigger>
      <SheetContent side="left" className="w-64 gap-0 p-0 sm:max-w-64">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full flex-col overflow-hidden">
          <SidebarNav activeProjectId={activeProjectId} flows={flows} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

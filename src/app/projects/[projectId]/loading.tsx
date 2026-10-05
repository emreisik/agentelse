import { Skeleton } from "@/components/ui/skeleton";
import { DockedSidebarSkeleton } from "@/components/layout/sidebar-collapse";

// The loading boundary for everything under a project — the chat root and,
// since the redirect-only legacy segments (ayarlar, fikirler, isler...) have
// no loading file of their own anymore, those too. Deliberately NOT built on
// AppShell: loading.tsx boundaries never receive route params, so an
// AppShell here would render the shared sidebar in workspace mode ("Select
// brand", workspace-wide counts, no project tools) and then switch to the
// project sidebar once the real page lands. A hand-rolled skeleton that
// approximates the real shell's shape (sidebar with the brand switcher and
// account row, no top bar, right panel) avoids that flash. Below md the real
// shell shows a slim bar instead of the sidebar.
export default function Loading() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <DockedSidebarSkeleton />
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 md:hidden">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{ background: "var(--ws-bg)" }}
      >
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col gap-5 px-5 pt-8 sm:px-9">
            <Skeleton className="h-9 w-2/3 max-w-md" />
            <Skeleton className="h-4 w-1/2 max-w-sm" />
            <Skeleton className="h-16 w-full rounded-[13px]" />
            <div className="mt-6 flex flex-col gap-4">
              <Skeleton className="h-20 w-3/4 rounded-2xl" />
              <Skeleton className="ml-auto h-12 w-1/2 rounded-2xl" />
            </div>
          </div>
          <div
            className="hidden w-[367px] shrink-0 border-l lg:block"
            style={{
              borderColor: "var(--ws-border)",
              background: "var(--ws-surface)",
            }}
          >
            <div
              className="flex h-[55px] items-center gap-2 border-b px-3"
              style={{ borderColor: "var(--ws-border)" }}
            >
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-14 rounded-[6px]" />
              ))}
            </div>
            <div className="space-y-3 p-5">
              <Skeleton className="h-32 w-full rounded-[9px]" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

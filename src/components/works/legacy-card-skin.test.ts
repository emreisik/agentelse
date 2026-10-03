import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CreativeCardData } from "@/types/creative-card";
import type { IdeaEventCardData } from "@/types/idea-event-card";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useParams: () => ({ projectId: "proj-1" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/server/actions/content-plan-actions", () => ({
  saveContentPlanAction: vi.fn(),
}));
vi.mock("@/server/actions/plan-progress-actions", () => ({
  approvePlanItemsAction: vi.fn(),
}));
vi.mock("@/server/actions/approval-actions", () => ({
  approveApprovalAction: vi.fn(),
  rejectApprovalAction: vi.fn(),
}));
vi.mock("@/server/actions/creative-actions", () => ({
  reviseCreativeAction: vi.fn(),
}));
vi.mock("@/server/actions/publish-actions", () => ({
  getCreativePublishTargetsAction: vi.fn(),
  publishCreativeToInstagramAction: vi.fn(),
  publishCreativeToSocialAction: vi.fn(),
}));
vi.mock("@/server/actions/facebook-share-actions", () => ({
  getFacebookShareAction: vi.fn(),
  shareCreativeToFacebookAction: vi.fn(),
  editFacebookPostAction: vi.fn(),
  deleteFacebookPostAction: vi.fn(),
}));
vi.mock("@/components/workspace/output-preview-dialog", () => ({
  OutputPreviewDialog: () => null,
}));

const { ContentPlanCard } =
  await import("@/components/commands/content-plan-card");
const { CreativeCard } = await import("@/components/commands/creative-card");
const { ChatPackageProvider } =
  await import("@/components/commands/chat-package-context");
const { WorkCardHostProvider } = await import("./work-card-host");

import type { WorkCardHostInput } from "./work-card-host";

// Goldens: the exact renderToStaticMarkup of the two legacy cards WITHOUT a
// provider, captured from the sources as they were before the Works skin
// (git HEAD of content-plan-card.tsx / creative-card.tsx).
const GOLDEN = {
  planDraftChat:
    '<div class="mt-1 w-full max-w-xl space-y-3 rounded-2xl border p-3.5" style="border-color:var(--ws-border);background:var(--ws-surface);box-shadow:var(--ws-card-shadow);opacity:1"><div class="flex items-center gap-2.5"><span class="flex size-7 shrink-0 items-center justify-center rounded-lg" style="background:var(--ws-hover)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-clock size-3.5" aria-hidden="true" style="color:var(--ws-text)"><path d="M16 14v2.2l1.6 1"></path><path d="M16 2v3"></path><path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"></path><path d="M3 9h5.859"></path><path d="M8 2v3"></path><circle cx="16" cy="16" r="6"></circle></svg></span><p class="min-w-0 flex-1 truncate text-sm font-semibold" style="color:var(--ws-text)">Launch week</p><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">Leads &amp; bookings</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">3 posts</span></div><ul class="flex flex-wrap gap-1.5"><li><span class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px]" style="border-color:var(--ws-border);color:var(--ws-text)"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#d6249f" title="Instagram">IG</span><span class="font-medium">Instagram</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-approved)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">@acme</span></span></li><li><a class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px] hover:bg-[var(--ws-hover)]" style="border-color:var(--ws-border);color:var(--ws-text)" href="/projects/proj-1/integrations"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#0a66c2" title="LinkedIn">in</span><span class="font-medium">LinkedIn</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-pending)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">Connect</span></a></li><li><span class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px]" style="border-color:var(--ws-border);color:var(--ws-text)"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#059669" title="Blog / SEO">SEO</span><span class="font-medium">Blog / SEO</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-text-3)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">You publish</span></span></li></ul><div data-orientation="horizontal" data-activation-direction="none" data-slot="tabs" class="group/tabs flex gap-2 data-horizontal:flex-col"><div data-orientation="horizontal" data-activation-direction="none" role="tablist" data-slot="tabs-list" data-variant="default" class="group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none bg-muted"><button type="button" data-active="" data-orientation="horizontal" data-activation-direction="none" aria-disabled="false" tabindex="-1" role="tab" aria-selected="true" id="base-ui-_R_1b_" data-composite-item-active="" data-slot="tabs-trigger" class="relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100">Week</button><button type="button" data-orientation="horizontal" data-activation-direction="none" aria-disabled="false" tabindex="-1" role="tab" aria-selected="false" id="base-ui-_R_2b_" data-slot="tabs-trigger" class="relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100">List</button></div><div data-orientation="horizontal" data-activation-direction="none" id="base-ui-_R_j_" role="tabpanel" tabindex="0" data-index="-1" data-slot="tabs-content" class="flex-1 text-sm outline-none space-y-2.5"><div class="flex items-center justify-between gap-2"><span class="text-xs font-medium" style="color:var(--ws-text-2)">5 Oct \u2013 11 Oct</span></div><div class="grid grid-cols-7 gap-1"><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Mon <span class="font-semibold">5</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="Behind the scenes, Mon 5 Oct 10:00" aria-pressed="true" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-accent);background:var(--ws-hover)"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#d6249f" title="Instagram">IG</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image shrink-0 size-3" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Tue <span class="font-semibold">6</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="What we learned this year, Tue 6 Oct 09:30" aria-pressed="false" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-border);background:transparent"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#0a66c2" title="LinkedIn">in</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-type shrink-0 size-3" aria-hidden="true"><path d="M12 4v16"></path><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"></path><path d="M9 20h6"></path></svg></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Wed <span class="font-semibold">7</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="Pricing guide, Wed 7 Oct 11:00" aria-pressed="false" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-border);background:transparent"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#059669" title="Blog / SEO">SEO</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text shrink-0 size-3" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path><path d="M14 2v5a1 1 0 0 0 1 1h5"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Thu <span class="font-semibold">8</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Fri <span class="font-semibold">9</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Sat <span class="font-semibold">10</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Sun <span class="font-semibold">11</span></p><div class="flex flex-col gap-1"></div></div></div><div class="rounded-xl border p-2.5" style="border-color:var(--ws-border)"><div class="flex flex-wrap items-center gap-1.5"><span class="text-xs font-semibold" style="color:var(--ws-text)">Mon 5 Oct \u00b7 10:00</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">Instagram \u00b7 Post</span><span class="text-[11px]" style="color:var(--ws-text-2)">Publishes itself</span></div><p class="mt-1 text-sm font-medium" style="color:var(--ws-text)">Behind the scenes</p><p class="mt-0.5 text-xs leading-relaxed" style="color:var(--ws-text-2)">A look at the studio</p></div></div></div><div class="flex flex-wrap items-center justify-between gap-2"><p class="text-xs" style="color:var(--ws-text-2)">1 auto-publish \u00b7 2 you publish</p><span class="flex items-center gap-1.5"><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5">Save only</button><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles size-3.5" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg>Save &amp; produce (3)</button></span></div></div>',
  planSaved:
    '<div class="mt-1 w-full max-w-xl space-y-3 rounded-2xl border p-3.5" style="border-color:var(--ws-border);background:var(--ws-surface);box-shadow:var(--ws-card-shadow);opacity:1"><div class="flex items-center gap-2.5"><span class="flex size-7 shrink-0 items-center justify-center rounded-lg" style="background:var(--ws-hover)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calendar-clock size-3.5" aria-hidden="true" style="color:var(--ws-text)"><path d="M16 14v2.2l1.6 1"></path><path d="M16 2v3"></path><path d="M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338"></path><path d="M3 9h5.859"></path><path d="M8 2v3"></path><circle cx="16" cy="16" r="6"></circle></svg></span><p class="min-w-0 flex-1 truncate text-sm font-semibold" style="color:var(--ws-text)">Launch week</p><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">Leads &amp; bookings</span><span class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap" style="border-color:var(--ws-border);color:var(--ws-text-2)"><span class="size-1.5 shrink-0 rounded-full" style="background:var(--ws-approved)"></span>Saved</span></div><ul class="flex flex-wrap gap-1.5"><li><span class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px]" style="border-color:var(--ws-border);color:var(--ws-text)"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#d6249f" title="Instagram">IG</span><span class="font-medium">Instagram</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-approved)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">@acme</span></span></li><li><a class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px] hover:bg-[var(--ws-hover)]" style="border-color:var(--ws-border);color:var(--ws-text)" href="/projects/proj-1/integrations"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#0a66c2" title="LinkedIn">in</span><span class="font-medium">LinkedIn</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-pending)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">Connect</span></a></li><li><span class="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-[11px]" style="border-color:var(--ws-border);color:var(--ws-text)"><span class="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[10px] leading-none font-bold text-white" style="background:#059669" title="Blog / SEO">SEO</span><span class="font-medium">Blog / SEO</span><span class="inline-block size-1.5 shrink-0 rounded-full" style="background:var(--ws-text-3)" aria-hidden="true"></span><span style="color:var(--ws-text-2)">You publish</span></span></li></ul><div data-orientation="horizontal" data-activation-direction="none" data-slot="tabs" class="group/tabs flex gap-2 data-horizontal:flex-col"><div data-orientation="horizontal" data-activation-direction="none" role="tablist" data-slot="tabs-list" data-variant="default" class="group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none bg-muted"><button type="button" data-active="" data-orientation="horizontal" data-activation-direction="none" aria-disabled="false" tabindex="-1" role="tab" aria-selected="true" id="base-ui-_R_1b_" data-composite-item-active="" data-slot="tabs-trigger" class="relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100">Week</button><button type="button" data-orientation="horizontal" data-activation-direction="none" aria-disabled="false" tabindex="-1" role="tab" aria-selected="false" id="base-ui-_R_2b_" data-slot="tabs-trigger" class="relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100">List</button></div><div data-orientation="horizontal" data-activation-direction="none" id="base-ui-_R_j_" role="tabpanel" tabindex="0" data-index="-1" data-slot="tabs-content" class="flex-1 text-sm outline-none space-y-2.5"><div class="flex items-center justify-between gap-2"><span class="text-xs font-medium" style="color:var(--ws-text-2)">5 Oct \u2013 11 Oct</span></div><div class="grid grid-cols-7 gap-1"><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Mon <span class="font-semibold">5</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="Behind the scenes, Mon 5 Oct 10:00" aria-pressed="true" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-accent);background:var(--ws-hover)"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#d6249f" title="Instagram">IG</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image shrink-0 size-3" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg><span class="absolute -top-0.5 -right-0.5"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full" style="background:var(--ws-accent)"></span></span></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Tue <span class="font-semibold">6</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="What we learned this year, Tue 6 Oct 09:30" aria-pressed="false" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-border);background:transparent"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#0a66c2" title="LinkedIn">in</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-type shrink-0 size-3" aria-hidden="true"><path d="M12 4v16"></path><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"></path><path d="M9 20h6"></path></svg><span class="absolute -top-0.5 -right-0.5"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full" style="background:var(--ws-text-3)"></span></span></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:transparent"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Wed <span class="font-semibold">7</span></p><div class="flex flex-col gap-1"><button type="button" aria-label="Pricing guide, Wed 7 Oct 11:00" aria-pressed="false" class="relative flex items-center justify-center gap-0.5 rounded-md border px-0.5 py-0.5 transition-colors" style="border-color:var(--ws-border);background:transparent"><span class="inline-flex shrink-0 items-center justify-center rounded-md px-1 font-bold text-white h-4 min-w-4 text-[9px]" style="background:#059669" title="Blog / SEO">SEO</span><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text shrink-0 size-3" aria-hidden="true"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path><path d="M14 2v5a1 1 0 0 0 1 1h5"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg><span class="absolute -top-0.5 -right-0.5"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full" style="background:var(--destructive)"></span></span></button></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Thu <span class="font-semibold">8</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Fri <span class="font-semibold">9</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Sat <span class="font-semibold">10</span></p><div class="flex flex-col gap-1"></div></div><div class="min-h-[60px] rounded-lg border p-1" style="border-color:var(--ws-border);background:var(--ws-hover)"><p class="mb-1 text-center text-[10px] leading-none" style="color:var(--ws-text-2)">Sun <span class="font-semibold">11</span></p><div class="flex flex-col gap-1"></div></div></div><div class="rounded-xl border p-2.5" style="border-color:var(--ws-border)"><div class="flex flex-wrap items-center gap-1.5"><span class="text-xs font-semibold" style="color:var(--ws-text)">Mon 5 Oct \u00b7 10:00</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">Instagram \u00b7 Post</span><span class="text-[11px]" style="color:var(--ws-text-2)">Publishes itself</span></div><p class="mt-1 text-sm font-medium" style="color:var(--ws-text)">Behind the scenes</p><p class="mt-0.5 text-xs leading-relaxed" style="color:var(--ws-text-2)">A look at the studio</p><div class="mt-2 flex items-center gap-2"><img src="/api/assets/asset-1?w=320" alt="" loading="lazy" decoding="async" class="size-12 shrink-0 rounded-md object-cover"/><span class="flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><span aria-hidden="true" class="size-1.5 shrink-0 rounded-full" style="background:var(--ws-accent)"></span>Waiting for your decision</span><a class="ml-auto text-xs underline underline-offset-2" style="color:var(--ws-text-2)" href="/projects/proj-1/takvim?creative=c0">Open</a></div></div></div></div><div class="space-y-2"><p class="text-xs" style="color:var(--ws-text-2)">1 failed \u00b7 1 in review \u00b7 1 need content</p><div class="flex flex-wrap items-center gap-2"><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5">Approve all (1)</button><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-sparkles size-3.5" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"></path><path d="M20 2v4"></path><path d="M22 4h-4"></path><circle cx="4" cy="20" r="2"></circle></svg>Try again (2)</button><a class="group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4 border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5" href="/projects/proj-1/takvim">Open calendar</a></div></div></div>',
  creativeReview:
    '<div data-creative-id="cr-1" class="mt-1 w-full max-w-2xl overflow-hidden rounded-2xl border transition-shadow" style="border-color:var(--ws-border);background:var(--ws-surface);box-shadow:var(--ws-card-shadow)"><div class="grid sm:grid-cols-[39%_61%]"><div class="relative w-full overflow-hidden" style="background:var(--ws-accent)"><button type="button" tabindex="0" data-base-ui-click-trigger="" id="base-ui-_R_7l_" aria-haspopup="dialog" aria-expanded="false" data-slot="dialog-trigger" class="cursor-zoom-in block h-full"><img src="/api/assets/asset-1?w=768" alt="A look at the studio" loading="lazy" decoding="async" style="aspect-ratio:1080 / 1350" class="w-full object-cover"/></button></div><div class="flex flex-col p-4"><div class="flex items-center justify-between gap-2"><span class="flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image size-3.5" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>Instagram Post (3:4)</span><span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style="background:var(--ws-surface-2);color:var(--ws-text-2)">v1</span></div><p class="mt-2 text-lg leading-tight font-semibold" style="color:var(--ws-text)">A look at the studio</p><p class="mt-1.5 text-sm leading-snug" style="color:var(--ws-text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">Come see how we work.</p><div class="mt-3 flex flex-wrap gap-1.5"><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">1080 \u00d7 1350</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">3:4</span></div><div class="mt-3 flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><span class="size-1.5 rounded-full" style="background:var(--ws-pending)"></span>In Review</div><div class="mt-4 flex flex-wrap items-center gap-2"><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/80 h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5 rounded-[10px]" style="background:var(--ws-accent);color:var(--ws-on-accent)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check size-3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>Approve</button><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5 rounded-[10px]" style="border-color:var(--ws-border);color:var(--ws-text)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line size-3.5" aria-hidden="true"><path d="M13 21h8"></path><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path></svg>Revise</button><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5 rounded-[10px]" style="color:var(--ws-text-3)">Reject</button></div></div></div><div class="flex items-center justify-between border-t px-4 py-2.5 text-[11px]" style="border-color:var(--ws-border);background:var(--ws-bg);color:var(--ws-text-3)"><span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check size-3" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>On-brand</span><button type="button" class="flex items-center gap-1 font-medium transition-colors hover:opacity-70">View details<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right size-3" aria-hidden="true"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></button></div></div>',
  creativeApproved:
    '<div data-creative-id="cr-1" class="mt-1 w-full max-w-2xl overflow-hidden rounded-2xl border transition-shadow" style="border-color:var(--ws-border);background:var(--ws-surface);box-shadow:var(--ws-card-shadow)"><div class="grid sm:grid-cols-[39%_61%]"><div class="relative w-full overflow-hidden" style="background:var(--ws-accent)"><button type="button" tabindex="0" data-base-ui-click-trigger="" id="base-ui-_R_7l_" aria-haspopup="dialog" aria-expanded="false" data-slot="dialog-trigger" class="cursor-zoom-in block h-full"><img src="/api/assets/asset-1?w=768" alt="A look at the studio" loading="lazy" decoding="async" style="aspect-ratio:1080 / 1350" class="w-full object-cover"/></button></div><div class="flex flex-col p-4"><div class="flex items-center justify-between gap-2"><span class="flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image size-3.5" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>Instagram Post (3:4)</span><span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style="background:var(--ws-surface-2);color:var(--ws-text-2)">v1</span></div><p class="mt-2 text-lg leading-tight font-semibold" style="color:var(--ws-text)">A look at the studio</p><p class="mt-1.5 text-sm leading-snug" style="color:var(--ws-text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">Come see how we work.</p><div class="mt-3 flex flex-wrap gap-1.5"><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">1080 \u00d7 1350</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">3:4</span></div><div class="mt-3 flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><span class="size-1.5 rounded-full" style="background:var(--ws-approved)"></span>Approved</div><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5 mt-4 w-fit rounded-[10px]" style="border-color:var(--ws-border);color:var(--ws-text)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line size-3.5" aria-hidden="true"><path d="M13 21h8"></path><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path></svg>Revise</button><div class="mt-3"></div></div></div><div class="flex items-center justify-between border-t px-4 py-2.5 text-[11px]" style="border-color:var(--ws-border);background:var(--ws-bg);color:var(--ws-text-3)"><span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check size-3" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>On-brand</span><button type="button" class="flex items-center gap-1 font-medium transition-colors hover:opacity-70">View details<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right size-3" aria-hidden="true"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></button></div></div>',
  creativeQueued:
    '<div data-creative-id="cr-1" class="mt-1 w-full max-w-2xl overflow-hidden rounded-2xl border transition-shadow" style="border-color:var(--ws-border);background:var(--ws-surface);box-shadow:var(--ws-card-shadow)"><div class="grid sm:grid-cols-[39%_61%]"><div class="relative w-full overflow-hidden" style="background:var(--ws-accent)"><button type="button" tabindex="0" data-base-ui-click-trigger="" id="base-ui-_R_7l_" aria-haspopup="dialog" aria-expanded="false" data-slot="dialog-trigger" class="cursor-zoom-in block h-full"><img src="/api/assets/asset-1?w=768" alt="A look at the studio" loading="lazy" decoding="async" style="aspect-ratio:1080 / 1350" class="w-full object-cover"/></button></div><div class="flex flex-col p-4"><div class="flex items-center justify-between gap-2"><span class="flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image size-3.5" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>Instagram Post (3:4)</span><span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium" style="background:var(--ws-surface-2);color:var(--ws-text-2)">v1</span></div><p class="mt-2 text-lg leading-tight font-semibold" style="color:var(--ws-text)">A look at the studio</p><p class="mt-1.5 text-sm leading-snug" style="color:var(--ws-text-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">Come see how we work.</p><div class="mt-3 flex flex-wrap gap-1.5"><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">1080 \u00d7 1350</span><span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style="border-color:var(--ws-border);color:var(--ws-text-2)">3:4</span></div><div class="mt-3 flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><span class="size-1.5 rounded-full" style="background:var(--ws-approved)"></span>Approved</div><button type="button" tabindex="0" data-slot="button" class="group/button inline-flex shrink-0 items-center justify-center border bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&amp;_svg]:pointer-events-none [&amp;_svg]:shrink-0 border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-7 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-3.5 mt-4 w-fit rounded-[10px]" style="border-color:var(--ws-border);color:var(--ws-text)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line size-3.5" aria-hidden="true"><path d="M13 21h8"></path><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path></svg>Revise</button><div class="mt-3 flex items-center gap-1.5 text-xs" style="color:var(--ws-text-2)"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock size-3.5" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>Queued to publish</div></div></div><div class="flex items-center justify-between border-t px-4 py-2.5 text-[11px]" style="border-color:var(--ws-border);background:var(--ws-bg);color:var(--ws-text-3)"><span class="flex items-center gap-1"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check size-3" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>On-brand</span><button type="button" class="flex items-center gap-1 font-medium transition-colors hover:opacity-70">View details<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up-right size-3" aria-hidden="true"><path d="M7 7h10v10"></path><path d="M7 17 17 7"></path></svg></button></div></div>',
} as const;

type PlanCard = Extract<IdeaEventCardData, { kind: "content-plan-draft" }>;
type ReadyCard = Extract<CreativeCardData, { kind: "creative-ready" }>;

const draftPlan: PlanCard = {
  kind: "content-plan-draft",
  title: "Launch week",
  timezone: "Europe/Istanbul",
  state: "draft",
  goal: "leads",
  connections: {
    instagram: { connected: true, accountLabel: "@acme" },
    linkedin: { connected: false },
  },
  items: [
    {
      date: "2026-10-05",
      time: "10:00",
      platform: "INSTAGRAM",
      channel: "instagram",
      formatKey: "instagram.post",
      topic: "Behind the scenes",
      captionIdea: "A look at the studio",
    },
    {
      date: "2026-10-06",
      time: "09:30",
      platform: "LINKEDIN",
      channel: "linkedin",
      formatKey: "linkedin.post",
      topic: "What we learned this year",
      captionIdea: "Three lessons from clients",
    },
    {
      date: "2026-10-07",
      time: "11:00",
      channel: "seo",
      formatKey: "seo.article",
      topic: "Pricing guide",
      captionIdea: "Target keyword: pricing",
    },
  ],
};

const savedPlan: PlanCard = {
  ...draftPlan,
  state: "saved",
  slots: [
    { id: "c0", stage: "IN_REVIEW", assetId: "asset-1" },
    { id: "c1", stage: "PLANNED" },
    { id: "c2", stage: "FAILED" },
  ],
};

const textOnlyPlan: PlanCard = {
  ...draftPlan,
  items: draftPlan.items.slice(1),
};

const reviewCard: ReadyCard = {
  kind: "creative-ready",
  title: "Behind the scenes",
  creativeId: "cr-1",
  assetId: "asset-1",
  mimeType: "image/png",
  caption: "A look at the studio",
  copy: "Come see how we work.",
  status: "IN_REVIEW",
  assetWidth: 1080,
  assetHeight: 1350,
  platform: "INSTAGRAM",
  contentFormat: "FEED_PORTRAIT",
  approvalId: "ap-1",
  versionNumber: 1,
};

const approvedCard: ReadyCard = {
  ...reviewCard,
  status: "APPROVED",
  approvalId: undefined,
};

const queuedCard: ReadyCard = { ...approvedCard, publishState: "queued" };

// base-ui draws its ids from a counter that depends on how many renders ran
// before in the process; everything else in the markup is compared as is.
const norm = (html: string) =>
  html.replace(/base-ui-_R_[0-9a-z]+_/g, "base-ui-ID");

const HOST: WorkCardHostInput = {
  projectId: "proj-1",
  workId: "w1",
  workTitle: "Launch week",
  active: true,
  busy: false,
  producing: new Set<string>(),
  channels: [],
  openTab: () => undefined,
  runNextStep: () => undefined,
};

const chat = { start: vi.fn(), startPlan: vi.fn(), runs: {} };

// With a host (inside a Work) or without (flag off); the plan card always sits
// in a chat package so its buttons are live.
function planHtml(card: PlanCard, options: { host?: boolean } = {}): string {
  const element = createElement(
    ChatPackageProvider,
    { value: chat },
    createElement(ContentPlanCard, { card, commandId: "cmd-1" }),
  );
  return norm(
    renderToStaticMarkup(
      options.host
        ? createElement(WorkCardHostProvider, { value: HOST }, element)
        : element,
    ),
  );
}

function creativeHtml(card: ReadyCard, host = false): string {
  const element = createElement(CreativeCard, { card });
  return norm(
    renderToStaticMarkup(
      host
        ? createElement(WorkCardHostProvider, { value: HOST }, element)
        : element,
    ),
  );
}

// The opening tag of the button (or link) whose text contains `label`.
function tagOf(html: string, label: string): string {
  const match = [
    ...html.matchAll(/<(button|a)\b[^>]*>(?:(?!<\/\1>)[\s\S])*<\/\1>/g),
  ].find((m) => m[0].includes(label));
  if (!match) throw new Error(`no button with "${label}"`);
  return match[0].slice(0, match[0].indexOf(">") + 1);
}

// The same publish line the Work's live overlay puts on a creative-ready card
// (the field is render-time only and not on the type until the card types land).
function withLine(card: ReadyCard): ReadyCard {
  return Object.assign({}, card, {
    publishLine: { kind: "scheduled", released: false },
  });
}

describe("legacy-card-skin: flag-off markup is byte-identical (W80)", () => {
  it("ContentPlanCard, draft with a LinkedIn item", () => {
    expect(planHtml(draftPlan)).toBe(norm(GOLDEN.planDraftChat));
  });

  it("ContentPlanCard, saved with slots", () => {
    expect(planHtml(savedPlan)).toBe(norm(GOLDEN.planSaved));
  });

  it("CreativeCard, in review", () => {
    expect(creativeHtml(reviewCard)).toBe(norm(GOLDEN.creativeReview));
  });

  it("CreativeCard, approved", () => {
    expect(creativeHtml(approvedCard)).toBe(norm(GOLDEN.creativeApproved));
  });

  it("CreativeCard, approved and queued", () => {
    expect(creativeHtml(queuedCard)).toBe(norm(GOLDEN.creativeQueued));
  });

  it("a publishLine without a host changes nothing (flag off)", () => {
    expect(creativeHtml(withLine(queuedCard))).toBe(
      norm(GOLDEN.creativeQueued),
    );
    expect(creativeHtml(withLine(approvedCard))).toBe(
      norm(GOLDEN.creativeApproved),
    );
  });

  it("the goldens say 'Publishes itself'", () => {
    expect(GOLDEN.planDraftChat).toContain("Publishes itself");
  });
});

describe("ContentPlanCard with a Work host", () => {
  // LinkedIn connected: the catalog says "auto" and the old card claims it.
  const linkedinFirst: PlanCard = {
    ...draftPlan,
    connections: {
      instagram: { connected: true, accountLabel: "@acme" },
      linkedin: { connected: true, accountLabel: "Acme" },
    },
    items: [draftPlan.items[1]!, draftPlan.items[0]!, draftPlan.items[2]!],
  };

  it("buttons are at least 44 px tall with the kit radius", () => {
    const html = planHtml(draftPlan, { host: true });
    for (const label of ["Save only", "Save &amp; produce"]) {
      expect(tagOf(html, label)).toContain("min-h-11");
      expect(tagOf(html, label)).toContain("rounded-lg");
    }
    const saved = planHtml(savedPlan, { host: true });
    for (const label of ["Approve all", "Try again", "Open calendar"]) {
      expect(tagOf(saved, label)).toContain("min-h-11");
    }
    const toMake: PlanCard = {
      ...savedPlan,
      slots: savedPlan.slots?.map((slot) =>
        slot?.stage === "FAILED"
          ? { id: slot.id, stage: "PLANNED" as const }
          : slot,
      ),
    };
    expect(tagOf(planHtml(toMake, { host: true }), "Produce")).toContain(
      "min-h-11",
    );
    // Without a host none of them is.
    expect(planHtml(draftPlan)).not.toContain("min-h-11");
    expect(planHtml(savedPlan)).not.toContain("min-h-11");
  });

  it("never says a LinkedIn or X item publishes itself", () => {
    const html = planHtml(linkedinFirst, { host: true });
    expect(html).not.toContain("Publishes itself");
    expect(html).not.toContain("auto-publish");
    expect(html).toContain("You post it yourself");
    // The same plan without a host keeps the old claim.
    expect(planHtml(linkedinFirst)).toContain("Publishes itself");
  });

  it("an Instagram item keeps its auto line", () => {
    expect(planHtml(draftPlan, { host: true })).toContain(
      "Posts to Instagram once you approve it",
    );
  });

  it("summarises what really happens to the pieces", () => {
    expect(planHtml(draftPlan, { host: true })).toContain(
      "1 on Instagram, posted once approved · 2 you post yourself",
    );
  });

  it("does not ask to be revised in words", () => {
    const unknown: PlanCard = {
      ...draftPlan,
      items: [
        {
          date: "2026-10-05",
          time: "10:00",
          platform: "FACEBOOK",
          topic: "Open day",
          captionIdea: "Come and see us",
        },
      ],
    };
    // No item resolves to a catalog channel: the old card fills the gap with
    // the sentence, the Works card leaves it out.
    expect(planHtml(unknown)).toContain("Ask me to change anything");
    expect(planHtml(unknown, { host: true })).not.toContain(
      "Ask me to change anything",
    );
    expect(planHtml(draftPlan, { host: true })).not.toContain(
      "Ask me to change anything",
    );
  });

  it("shows the cost line for an Instagram batch and not for a text-only one", () => {
    const line = "Making the first week costs about $0.08 in pictures.";
    expect(planHtml(draftPlan, { host: true })).toContain(line);
    expect(planHtml(draftPlan)).not.toContain("costs about");
    expect(planHtml(textOnlyPlan, { host: true })).not.toContain("costs about");

    // Saved: the cost line sits under Produce, for the pieces still to make.
    const planned: PlanCard = {
      ...savedPlan,
      slots: [
        { id: "c0", stage: "PLANNED" },
        { id: "c1", stage: "PLANNED" },
        { id: "c2", stage: "PLANNED" },
      ],
    };
    const html = planHtml(planned, { host: true });
    expect(html).toContain(line);
    expect(html.indexOf(line)).toBeGreaterThan(html.indexOf("Produce"));
    // Only a text piece is left to make: nothing to paint, no line.
    const textLeft: PlanCard = {
      ...savedPlan,
      slots: [
        { id: "c0", stage: "APPROVED" },
        { id: "c1", stage: "PLANNED" },
        { id: "c2", stage: "PLANNED" },
      ],
    };
    expect(planHtml(textLeft, { host: true })).not.toContain("costs about");
  });

  it("no stale line before a save has been refused", () => {
    expect(planHtml(draftPlan, { host: true })).not.toContain(
      "Some days in this plan have passed",
    );
  });
});

describe("CreativeCard with a Work host", () => {
  it("Approve, Revise and Reject are 44 px tall and Reject sits apart", () => {
    const html = creativeHtml(reviewCard, true);
    for (const label of ["Approve", "Revise", "Reject"]) {
      expect(tagOf(html, label)).toContain("min-h-11");
      expect(tagOf(html, label)).toContain("rounded-lg");
    }
    expect(tagOf(html, "Reject")).toContain("ml-auto");
    expect(tagOf(html, "Approve")).not.toContain("ml-auto");
    expect(tagOf(html, "Revise")).not.toContain("ml-auto");
    expect(creativeHtml(reviewCard)).not.toContain("min-h-11");
  });

  it("Revise on an approved piece is 44 px tall too", () => {
    expect(tagOf(creativeHtml(approvedCard, true), "Revise")).toContain(
      "min-h-11",
    );
  });

  it("without a publishLine it keeps its own publish surfaces", () => {
    // The Share section is an empty wrapper in the server render (its targets
    // load in an effect); the status row is visible.
    const approved = creativeHtml(approvedCard, true);
    expect(approved).toContain('<div class="mt-3"></div>');
    const queued = creativeHtml(queuedCard, true);
    expect(queued).toContain("Queued to publish");
    const failed = creativeHtml(
      Object.assign({}, approvedCard, {
        publishState: "failed",
        publishError: "Token expired",
      }),
      true,
    );
    expect(failed).toContain("Failed to publish");
    expect(failed).toContain('<div class="mt-3"></div>');
  });

  it("with a publishLine it renders no second publish surface", () => {
    const approved = creativeHtml(withLine(approvedCard), true);
    expect(approved).not.toContain('<div class="mt-3"></div>');
    expect(approved).not.toContain("Share on Social Accounts");

    const queued = creativeHtml(withLine(queuedCard), true);
    expect(queued).not.toContain("Queued to publish");
    expect(queued).not.toContain('<div class="mt-3"></div>');

    const failed = creativeHtml(
      withLine(
        Object.assign({}, approvedCard, {
          publishState: "failed",
          publishError: "Token expired",
        }),
      ),
      true,
    );
    expect(failed).not.toContain("Failed to publish");
    expect(failed).not.toContain("Token expired");
  });

  it("the rest of the card is untouched by the publishLine", () => {
    const html = creativeHtml(withLine(approvedCard), true);
    expect(html).toContain("A look at the studio");
    expect(html).toContain("On-brand");
    expect(html).toContain("View details");
  });
});

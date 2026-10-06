import { notFound } from "next/navigation";
import { CalendarClock, ExternalLink } from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-time-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SeoFlags } from "@/lib/seo/health-flags";
import {
  SEARCH_UPDATE_KINDS,
  type SearchUpdateKind,
} from "@/lib/seo/search-updates";
import {
  addSearchUpdateAction,
  removeSearchUpdateAction,
} from "@/server/actions/search-updates-actions";
import { isPlatformOperator } from "@/server/security/operator";
import { requireUser } from "@/server/security/tenant-context";
import { SearchUpdates } from "@/server/seo/health/updates";

// Google arama güncellemeleri takvimi (docs/search-health.md "Google
// güncellemeleri"): yalnız platform operatörü. Status Dashboard'dan gelen
// satırlar listelenir; dashboard'da olmayan bir güncelleme elle eklenir
// (tarih seçimi tek seçiciyle: DatePicker). Proje verisi yoktur. SEO_HEALTH
// kapalıyken sayfa yoktur (404).

const KIND_LABEL: Readonly<Record<SearchUpdateKind, string>> = {
  CORE: "Core update",
  SPAM: "Spam update",
  DISCOVER: "Discover",
  REVIEWS: "Reviews update",
  HELPFUL_CONTENT: "Helpful content",
  OTHER_RANKING: "Other ranking",
  SERVING: "Serving",
  CRAWLING: "Crawling",
  INDEXING: "Indexing",
  OTHER: "Other",
};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-sm";

function kindLabel(kind: string): string {
  return (KIND_LABEL as Readonly<Record<string, string>>)[kind] ?? kind;
}

function dayText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function SearchUpdatesPage() {
  if (!SeoFlags.health()) notFound();
  const { userId } = await requireUser();
  if (!isPlatformOperator(userId)) notFound();

  const now = new Date();
  const updates = await SearchUpdates.recent(now, 365);

  return (
    <AppShell>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Google Search updates
          </h1>
          <p className="text-sm text-muted-foreground">
            Updates from the Google Search Status Dashboard, synced daily. Add
            an update by hand when it is missing there.
          </p>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 space-y-0">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent">
              <CalendarClock className="size-4" />
            </span>
            <CardTitle className="text-base">Last 12 months</CardTitle>
          </CardHeader>
          <CardContent>
            {updates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No updates yet. The first sync runs within a day.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Update</th>
                      <th className="py-2 pr-3 font-medium">Kind</th>
                      <th className="py-2 pr-3 font-medium">Started</th>
                      <th className="py-2 pr-3 font-medium">Ended</th>
                      <th className="py-2 pr-3 font-medium">Source</th>
                      <th className="py-2 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {updates.map((update) => (
                      <tr key={update.id} className="border-t border-border">
                        <td className="py-2 pr-3">
                          {update.url ? (
                            <a
                              href={update.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {update.name}
                              <ExternalLink className="size-3" />
                            </a>
                          ) : (
                            update.name
                          )}
                        </td>
                        <td className="py-2 pr-3">{kindLabel(update.kind)}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {dayText(update.startedAt)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {update.endedAt ? dayText(update.endedAt) : "Ongoing"}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {update.source === "MANUAL"
                            ? "Added by hand"
                            : "Google"}
                        </td>
                        <td className="py-2 text-right">
                          {update.source === "MANUAL" ? (
                            <ActionForm
                              action={removeSearchUpdateAction}
                              successMessage="Update removed"
                            >
                              <input
                                type="hidden"
                                name="id"
                                value={update.id}
                              />
                              <SubmitButton size="sm" variant="ghost">
                                Remove
                              </SubmitButton>
                            </ActionForm>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add an update</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm
              action={addSearchUpdateAction}
              successMessage="Update added"
              className="grid gap-4 sm:grid-cols-2"
            >
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="search-update-name">Name</Label>
                <Input
                  id="search-update-name"
                  name="name"
                  required
                  maxLength={200}
                  placeholder="October 2026 core update"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="search-update-kind">Kind</Label>
                <select
                  id="search-update-kind"
                  name="kind"
                  defaultValue="CORE"
                  className={selectClass}
                >
                  {SEARCH_UPDATE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="search-update-url">Link (optional)</Label>
                <Input
                  id="search-update-url"
                  name="url"
                  type="url"
                  maxLength={500}
                  placeholder="https://status.search.google.com/…"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="search-update-start">Started</Label>
                <DatePicker
                  id="search-update-start"
                  name="startedAt"
                  timezone="UTC"
                  aria-label="Started"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="search-update-end">Ended (optional)</Label>
                <DatePicker
                  id="search-update-end"
                  name="endedAt"
                  timezone="UTC"
                  clearable
                  placeholder="Still rolling out"
                  aria-label="Ended"
                />
              </div>
              <div className="sm:col-span-2">
                <SubmitButton size="sm">Add update</SubmitButton>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

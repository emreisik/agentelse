"use client";

import { useState } from "react";

import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { BrandTile } from "@/components/integrations/brand-icons";
import { EntityDialog } from "@/components/shared/entity-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/dates";
import {
  ADMIN_ROLE_WARNING,
  EDITOR_RECOMMENDATION,
} from "@/lib/seo/apply/copy";
import type { WpCapabilities } from "@/lib/seo/apply/types";
import type { StatusTone } from "@/lib/labels/types";
import type { WordPressConnectionView } from "@/lib/seo/apply/view-types";
import { saveApplySettingsAction } from "@/server/actions/seo-apply-actions";
import {
  connectWordPressAction,
  disconnectWordPressAction,
  testWordPressAction,
} from "@/server/actions/wordpress-actions";

// WordPress bağlantı penceresi (SC-F8). Ne değiştiğini düz İngilizceyle söyler,
// her değişikliğin önce onaylandığını belirtir, ayrı bir Editor kullanıcısı
// önerir ve yönetici hesabı uyarısını gösterir. Şifre alanı yalnız bellekte
// durur (sessionStorage'a yazılmaz) ve başarıda temizlenir.

export const WORDPRESS_APPROVAL_NOTICE =
  "Agentelse changes your site only after an owner or admin approves each change. New articles are saved as drafts.";

export const WORDPRESS_PASSWORD_HELP =
  "In WordPress open Users > Profile > Application Passwords, add a new one called Agentelse and paste it here.";

const PLUGIN_LABEL: Record<WordPressConnectionView["seoPlugin"], string> = {
  YOAST: "Yoast SEO",
  RANK_MATH: "Rank Math",
  NONE: "No SEO plugin found",
};

const CAPABILITY_CHIPS: { key: keyof WpCapabilities; label: string }[] = [
  { key: "draftPosts", label: "Create drafts" },
  { key: "publishPosts", label: "Publish" },
  { key: "editPublishedPosts", label: "Edit published posts" },
  { key: "editPublishedPages", label: "Edit published pages" },
  { key: "editOthers", label: "Edit others' content" },
];

const DAILY_LIMIT_OPTIONS = [1, 3, 5, 10, 15, 20, 25];

function toneOf(view: WordPressConnectionView): StatusTone {
  if (view.health === "OK") return "positive";
  if (view.health === "LIMITED" || view.health === "UNKNOWN") return "waiting";
  return "danger";
}

function ConnectForm({
  projectId,
  reconnect,
}: {
  projectId: string;
  reconnect: boolean;
}) {
  const [siteUrl, setSiteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  return (
    <ActionForm
      action={connectWordPressAction}
      successMessage="WordPress connected"
      onSuccess={() => setAppPassword("")}
      className="space-y-2.5"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <p className="text-[11px] text-muted-foreground">
        {EDITOR_RECOMMENDATION} {WORDPRESS_PASSWORD_HELP}
      </p>
      <div className="space-y-1">
        <label
          htmlFor="wp-site-url"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Site address
        </label>
        <Input
          id="wp-site-url"
          name="siteUrl"
          placeholder="https://example.com"
          autoComplete="off"
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="wp-username"
            className="text-[11px] font-medium text-muted-foreground"
          >
            WordPress username
          </label>
          <Input
            id="wp-username"
            name="username"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="wp-app-password"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Application Password
          </label>
          <Input
            id="wp-app-password"
            name="appPassword"
            type="password"
            autoComplete="new-password"
            placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            value={appPassword}
            onChange={(event) => setAppPassword(event.target.value)}
            className="h-8 text-xs"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <SubmitButton size="xs">{reconnect ? "Connect again" : "Connect"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function CapabilityChips({ capabilities }: { capabilities: WpCapabilities }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What this WordPress user can do">
      {CAPABILITY_CHIPS.map((chip) => (
        <li
          key={chip.key}
          className={
            capabilities[chip.key]
              ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400"
              : "rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground line-through"
          }
        >
          {chip.label}
        </li>
      ))}
    </ul>
  );
}

export function WordPressDialog({
  projectId,
  view,
  closeHref,
  settings,
  indexNowSlot,
  error,
}: {
  projectId: string;
  view: WordPressConnectionView | null;
  closeHref: string;
  settings: { dailyLimit: number } | null;
  indexNowSlot?: React.ReactNode;
  error?: string | null;
}) {
  const connected = view?.connected === true;
  const canManage = view?.canManage === true;
  const limitOptions = settings
    ? [...new Set([...DAILY_LIMIT_OPTIONS, settings.dailyLimit])].sort((a, b) => a - b)
    : [];

  return (
    <EntityDialog
      closeHref={closeHref}
      title="WordPress"
      header={
        <div className="flex items-center gap-2.5">
          <BrandTile brand="wordpress" className="size-8" iconClassName="size-[18px]" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">WordPress</p>
            <p className="text-xs text-muted-foreground">
              Publish articles and edit pages on your site
            </p>
          </div>
        </div>
      }
      size="md"
      bodyClassName="space-y-4 overflow-y-auto p-4"
    >
      {error ? (
        <p className="rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <p className="rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
        {WORDPRESS_APPROVAL_NOTICE}
      </p>

      {view && connected ? (
        <div className="space-y-3 rounded-lg p-3 ring-1 ring-foreground/10">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {view.host ?? "WordPress site"}
              </p>
              {view.accountLabel ? (
                <p className="truncate text-[11px] text-muted-foreground">
                  {view.accountLabel}
                </p>
              ) : null}
            </div>
            <StatusBadge meta={{ label: view.healthLabel, tone: toneOf(view) }} />
          </div>

          {view.healthReason ? (
            <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              {view.healthReason}
            </p>
          ) : null}

          {view.adminWarning ? (
            <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              {ADMIN_ROLE_WARNING}
            </p>
          ) : null}

          {view.capabilities ? (
            <CapabilityChips capabilities={view.capabilities} />
          ) : null}

          <p className="text-[11px] text-muted-foreground">
            {PLUGIN_LABEL[view.seoPlugin]}
            {view.seoPlugin !== "NONE" && !view.descriptionWritable
              ? ". Meta descriptions cannot be changed with this setup."
              : ""}
            {view.lastCheckedAt
              ? ` Last checked ${timeAgo(view.lastCheckedAt)}.`
              : ""}
          </p>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {canManage ? (
              <ActionForm
                action={disconnectWordPressAction}
                successMessage="Disconnected"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <SubmitButton variant="outline" size="xs">
                  Disconnect
                </SubmitButton>
              </ActionForm>
            ) : null}
            {canManage && view.canRebind ? (
              <ActionForm
                action={testWordPressAction}
                successMessage="Site re-checked"
              >
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="rebind" value="1" />
                <SubmitButton variant="outline" size="xs">
                  Re-check the site
                </SubmitButton>
              </ActionForm>
            ) : null}
            <ActionForm
              action={testWordPressAction}
              successMessage="Connection checked"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <SubmitButton size="xs">Test</SubmitButton>
            </ActionForm>
          </div>

          {canManage && settings ? (
            <ActionForm
              action={saveApplySettingsAction}
              successMessage="Saved"
              className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/10 pt-3"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <label
                htmlFor="wp-daily-limit"
                className="text-[11px] text-muted-foreground"
              >
                Changes per day. Approved changes beyond this wait for room.
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  id="wp-daily-limit"
                  name="dailyLimit"
                  defaultValue={String(settings.dailyLimit)}
                  className="h-7 rounded-lg border border-input bg-transparent px-2 text-xs"
                >
                  {limitOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <SubmitButton variant="outline" size="xs">
                  Save
                </SubmitButton>
              </div>
            </ActionForm>
          ) : null}
        </div>
      ) : (
        <EmptyState
          media={
            <BrandTile brand="wordpress" className="size-10 rounded-xl" iconClassName="size-5" />
          }
          title="Not connected yet"
          hint={
            canManage
              ? "Connect your WordPress site to send article drafts and approved page changes."
              : "Ask a workspace owner or admin to connect WordPress."
          }
          className="py-8"
        />
      )}

      {canManage ? (
        connected ? (
          <details
            open={view?.health === "AUTH"}
            className="rounded-lg p-3 ring-1 ring-foreground/10"
          >
            <summary className="cursor-pointer text-xs font-medium">
              Connect with a different password or site
            </summary>
            <div className="pt-3">
              <ConnectForm projectId={projectId} reconnect />
            </div>
          </details>
        ) : (
          <div className="border-t border-foreground/10 pt-4">
            <ConnectForm projectId={projectId} reconnect={false} />
          </div>
        )
      ) : null}

      {connected ? indexNowSlot : null}
    </EntityDialog>
  );
}

"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { APPLY_LABEL } from "@/lib/seo/apply/copy";
import type { ApplyOffer } from "@/lib/seo/apply/view-types";
import { proposeApplyAction } from "@/server/actions/seo-apply-actions";

// "Apply with approval" düğmesi (SC-F8, docs/website-apply.md "Fırsatlar"):
// fırsat kartlarında, Actions & results satırlarında ve snippet teslim adımında.
// Ne değişeceğini gösterir; düğme yalnız değişikliği ÖNERİR ve onay bir sonraki
// adımda (Website changes bölümü ya da sohbet kartı) verilir. Bayrak kapalıyken
// ebeveyn bunu hiç çizmez. İç bağlantılarda her kaynak sayfa için bir düğme
// vardır ve her biri en çok 3 bağlantı önerir.

const LINKS_PER_CHANGE = 3;

export type ApplyDefaultText = {
  title: string | null;
  metaDescription: string | null;
};

type FieldMap = Record<string, string>;

function changesHref(projectId: string, changeId: string | null): string {
  return `/projects/${projectId}/arama#${changeId ? `change-${changeId}` : "website-changes"}`;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

// Tek öneri düğmesi: alanları FormData'ya koyup eylemi çağırır, sonucu
// düğmenin altında gösterir.
function ProposeButton({
  projectId,
  fields,
  label,
}: {
  projectId: string;
  fields: FieldMap;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="xs"
        disabled={pending || result?.ok === true}
        onClick={() => {
          startTransition(async () => {
            const formData = new FormData();
            formData.set("projectId", projectId);
            for (const [name, value] of Object.entries(fields)) {
              formData.set(name, value);
            }
            try {
              const response = await proposeApplyAction(formData);
              setResult({
                ok: response.ok,
                message:
                  response.message ??
                  (response.ok
                    ? "Sent for approval."
                    : "Something went wrong."),
              });
              if (response.ok) router.refresh();
            } catch {
              setResult({
                ok: false,
                message: "The change could not be proposed. Try again.",
              });
            }
          });
        }}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : null}
        {label}
      </Button>
      {result ? (
        <p
          role="status"
          className={
            result.ok
              ? "text-xs text-muted-foreground"
              : "text-xs text-rose-700 dark:text-rose-400"
          }
        >
          {result.message}
          {result.ok ? (
            <>
              {" "}
              <Link
                href={changesHref(projectId, null)}
                className="text-primary underline-offset-4 hover:underline"
              >
                Open Website changes
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function baseFields(offer: ApplyOffer): FieldMap {
  const fields: FieldMap = { kind: offer.kind };
  if (offer.actionId) fields.actionId = offer.actionId;
  else if (offer.findingId) fields.findingId = offer.findingId;
  return fields;
}

function approvalHint(isManager: boolean): string {
  return isManager
    ? "You approve it in the next step."
    : "An owner or admin approves it in the next step.";
}

type PageGroup = {
  fromUrl: string;
  chunks: { toUrl: string; anchor: string }[][];
};

// Bağlantılar kaynak sayfaya göre gruplanır; her grup 3'lük dilimlere bölünür.
export function groupLinksByPage(links: ApplyOffer["links"]): PageGroup[] {
  const order: string[] = [];
  const byPage = new Map<string, { toUrl: string; anchor: string }[]>();
  for (const link of links) {
    const list = byPage.get(link.fromUrl);
    if (list) list.push({ toUrl: link.toUrl, anchor: link.anchor });
    else {
      order.push(link.fromUrl);
      byPage.set(link.fromUrl, [{ toUrl: link.toUrl, anchor: link.anchor }]);
    }
  }
  return order.map((fromUrl) => {
    const all = byPage.get(fromUrl) ?? [];
    const chunks: { toUrl: string; anchor: string }[][] = [];
    for (let index = 0; index < all.length; index += LINKS_PER_CHANGE) {
      chunks.push(all.slice(index, index + LINKS_PER_CHANGE));
    }
    return { fromUrl, chunks };
  });
}

function StateLine({
  projectId,
  offer,
}: {
  projectId: string;
  offer: ApplyOffer;
}) {
  const text =
    offer.state === "pending" ? "Waiting for approval" : "Applied on your site";
  return (
    <p className="text-xs text-muted-foreground">
      {text}
      {" · "}
      <Link
        href={changesHref(projectId, offer.changeId)}
        className="text-primary underline-offset-4 hover:underline"
      >
        See the change
      </Link>
    </p>
  );
}

export function ApplyWithApprovalButton({
  projectId,
  offer,
  defaultText,
  isManager = false,
}: {
  projectId: string;
  offer: ApplyOffer;
  defaultText?: ApplyDefaultText;
  isManager?: boolean;
}): React.JSX.Element | null {
  if (offer.state === "pending" || offer.state === "applied") {
    return <StateLine projectId={projectId} offer={offer} />;
  }
  if (offer.state === "needs_text" || offer.state === "blocked") {
    return offer.hint ? (
      <p className="text-xs text-muted-foreground">{offer.hint}</p>
    ) : null;
  }

  if (offer.kind === "TITLE_META") {
    const fields = baseFields(offer);
    if (defaultText?.title) fields.title = defaultText.title;
    if (defaultText?.metaDescription) {
      fields.metaDescription = defaultText.metaDescription;
    }
    return (
      <div className="space-y-1.5" data-apply-kind="TITLE_META">
        <p className="text-xs text-muted-foreground">
          Changes the page title and description on your WordPress site.
        </p>
        {defaultText?.title || defaultText?.metaDescription ? (
          <dl className="space-y-0.5 text-xs">
            {defaultText.title ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">Title</dt>
                <dd className="min-w-0 break-words">{defaultText.title}</dd>
              </div>
            ) : null}
            {defaultText.metaDescription ? (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">
                  Description
                </dt>
                <dd className="min-w-0 break-words">
                  {defaultText.metaDescription}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        <ProposeButton
          projectId={projectId}
          fields={fields}
          label={APPLY_LABEL}
        />
        <p className="text-xs text-muted-foreground">
          {approvalHint(isManager)}
        </p>
      </div>
    );
  }

  // INTERNAL_LINKS
  const groups = groupLinksByPage(offer.links);
  if (groups.length === 0) {
    // Eylem henüz kurulmadı: düğme ilk sayfanın bağlantılarını kendisi çözer.
    return (
      <div className="space-y-1.5" data-apply-kind="INTERNAL_LINKS">
        <p className="text-xs text-muted-foreground">
          Adds internal links to the text of your page on WordPress.
        </p>
        <ProposeButton
          projectId={projectId}
          fields={baseFields(offer)}
          label={APPLY_LABEL}
        />
        <p className="text-xs text-muted-foreground">
          {approvalHint(isManager)}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-apply-kind="INTERNAL_LINKS">
      <p className="text-xs text-muted-foreground">
        Adds internal links to the text of your pages on WordPress.
      </p>
      {groups.map((group) =>
        group.chunks.map((chunk, index) => (
          <div
            key={`${group.fromUrl}-${index}`}
            className="space-y-1 rounded-lg p-2 ring-1 ring-foreground/10"
          >
            <p className="text-xs font-medium break-all">
              {pathOf(group.fromUrl)}
            </p>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {chunk.map((link) => (
                <li
                  key={`${link.toUrl}-${link.anchor}`}
                  className="break-words"
                >
                  {`“${link.anchor}” → ${pathOf(link.toUrl)}`}
                </li>
              ))}
            </ul>
            <ProposeButton
              projectId={projectId}
              fields={{
                ...baseFields(offer),
                url: group.fromUrl,
                links: JSON.stringify(chunk),
              }}
              label={APPLY_LABEL}
            />
          </div>
        )),
      )}
      <p className="text-xs text-muted-foreground">{approvalHint(isManager)}</p>
    </div>
  );
}

// Snippet teslim adımı: seçilen başlık ve açıklamayı sitede uygular. Yalnız
// sunucunun hesapladığı applyReady ile çizilir (bayrak kapalıyken null).
export function SnippetApplyPanel({
  projectId,
  actionId,
  title,
  metaDescription,
  applyReady,
  isManager = false,
}: {
  projectId: string;
  actionId: string;
  title: string | null;
  metaDescription: string | null;
  applyReady: boolean;
  isManager?: boolean;
}): React.JSX.Element | null {
  if (!applyReady) return null;
  if (!title && !metaDescription) return null;
  return (
    <ApplyWithApprovalButton
      projectId={projectId}
      isManager={isManager}
      offer={{
        state: "ready",
        changeId: null,
        actionId,
        findingId: null,
        kind: "TITLE_META",
        links: [],
        hint: null,
      }}
      defaultText={{ title, metaDescription }}
    />
  );
}

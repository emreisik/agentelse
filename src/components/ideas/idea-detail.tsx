"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

import { LayoutPreview } from "@/components/brand/layout-preview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { kitLayoutPalette } from "@/lib/brand-kit";
import { boardStatusOf, type BoardIdea } from "@/lib/ideas/board";
import {
  HEADLINE_MAX_WORDS,
  type SocialIdeaConcept,
} from "@/lib/ideas/concept";
import {
  pickableLayouts,
  previewFormatOf,
  previewFormatsFor,
  previewLogosOf,
} from "@/lib/ideas/preview";
import { cn } from "@/lib/utils";
import type { IdeaDraftPatch } from "@/server/actions/idea-board-actions";
import { IDEAS_COPY as COPY } from "./copy";
import {
  IdeaCardView,
  IdeaPostPreview,
  type IdeaCardContext,
  type IdeaCardHandlers,
} from "./idea-card";

// The detail of one idea (docs/ideas.md): the post large, in each of its
// formats; the layout it is made with; its words, editable; why it is here.

function wordsIn(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span
          className="text-[12px] font-medium"
          style={{ color: "var(--ws-text)" }}
        >
          {label}
        </span>
        {hint ? (
          <span className="text-[11px]" style={{ color: "var(--ws-text-3)" }}>
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function SocialDetail({
  idea,
  concept,
  ctx,
  handlers,
  onSaveDraft,
}: {
  idea: BoardIdea;
  concept: SocialIdeaConcept;
  ctx: IdeaCardContext;
  handlers: IdeaCardHandlers;
  onSaveDraft: (id: string, patch: IdeaDraftPatch) => Promise<boolean>;
}) {
  const draft = concept.draft;
  const editable = ["fresh", "saved", "expired"].includes(
    boardStatusOf(idea, ctx.now),
  );
  const formats = previewFormatsFor(draft.channels, draft.formatKey);
  const [format, setFormat] = useState(formats[0]!);
  const [hook, setHook] = useState(draft.hook);
  const [headline, setHeadline] = useState(draft.headline);
  const [highlight, setHighlight] = useState(draft.highlight ?? "");
  const [caption, setCaption] = useState(draft.caption);
  const [visual, setVisual] = useState(draft.visual);
  const [layoutId, setLayoutId] = useState(draft.layoutId ?? "");
  const [saving, setSaving] = useState(false);


  const dirty =
    hook !== draft.hook ||
    headline !== draft.headline ||
    highlight !== (draft.highlight ?? "") ||
    caption !== draft.caption ||
    visual !== draft.visual ||
    layoutId !== (draft.layoutId ?? "");

  // The preview follows the form as it is typed.
  const live: SocialIdeaConcept = {
    ...concept,
    draft: {
      ...draft,
      hook,
      headline: headline.trim() || draft.headline,
      ...(highlight.trim()
        ? { highlight: highlight.trim() }
        : { highlight: undefined }),
      caption,
      visual,
      ...(layoutId ? { layoutId } : { layoutId: undefined }),
    },
  };
  const kit = ctx.kit;
  const layouts = kit ? pickableLayouts(kit, draft.layoutId) : [];
  const words = wordsIn(headline);

  async function save() {
    setSaving(true);
    const ok = await onSaveDraft(idea.id, {
      hook,
      headline,
      highlight,
      caption,
      visual,
      layoutId,
    });
    setSaving(false);
    return ok;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <div className="flex flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
        <div
          className="overflow-hidden rounded-2xl border"
          style={{ borderColor: "var(--ws-border)" }}
        >
          <IdeaPostPreview
            concept={live}
            kit={kit}
            formatKey={format}
            fontFamily={ctx.fontFamily}
          />
        </div>
        {formats.length > 1 ? (
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="tablist"
            aria-label={COPY.formats}
          >
            {formats.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={key === format}
                onClick={() => setFormat(key)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  key === format ? "" : "hover:bg-[var(--ws-hover)]",
                )}
                style={
                  key === format
                    ? {
                        background: "var(--ws-accent)",
                        color: "var(--ws-on-accent)",
                      }
                    : { color: "var(--ws-text-2)" }
                }
              >
                {COPY.formatLabel[key] ?? key}
              </button>
            ))}
          </div>
        ) : null}
        {concept.why ? (
          <div
            className="rounded-xl p-3"
            style={{ background: "var(--ws-surface-2)" }}
          >
            <p
              className="text-[11px] font-medium"
              style={{ color: "var(--ws-text-2)" }}
            >
              {COPY.why}
            </p>
            <p
              className="mt-1 text-[12.5px] leading-snug"
              style={{ color: "var(--ws-text)" }}
            >
              {concept.why}
            </p>
            {concept.evidence?.map((entry) => (
              <a
                key={entry.url}
                href={entry.url}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 flex items-center gap-1 text-[11.5px] underline-offset-2 hover:underline"
                style={{ color: "var(--ws-text-2)" }}
              >
                <ExternalLink aria-hidden className="size-3" />
                {COPY.evidence}: {entry.title}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-4">
        <Field label={COPY.hook}>
          <Textarea
            value={hook}
            onChange={(e) => setHook(e.target.value)}
            rows={2}
            disabled={!editable}
          />
        </Field>
        <Field
          label={COPY.headline}
          hint={COPY.headlineCount(words, HEADLINE_MAX_WORDS)}
        >
          <Input
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            disabled={!editable}
            aria-invalid={words > HEADLINE_MAX_WORDS || undefined}
          />
        </Field>
        <Field label={COPY.highlight}>
          <Input
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
            disabled={!editable}
          />
        </Field>
        <Field label={COPY.caption}>
          <Textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={4}
            disabled={!editable}
          />
        </Field>
        <Field label={COPY.visual}>
          <Textarea
            value={visual}
            onChange={(e) => setVisual(e.target.value)}
            rows={3}
            disabled={!editable}
          />
        </Field>
        {kit && layouts.length > 0 ? (
          <Field label={COPY.layout} hint={COPY.layoutHint}>
            <div className="flex flex-wrap gap-2">
              {[
                { id: "", name: COPY.layoutDefault },
                ...layouts.map((layout) => ({
                  id: layout.id,
                  name: layout.name,
                })),
              ].map((option) => {
                const layout =
                  option.id === ""
                    ? null
                    : (layouts.find((entry) => entry.id === option.id) ?? null);
                const fmt = previewFormatOf(format);
                return (
                  <button
                    key={option.id || "default"}
                    type="button"
                    disabled={!editable}
                    aria-pressed={layoutId === option.id}
                    onClick={() => setLayoutId(option.id)}
                    className={cn(
                      "flex w-[84px] flex-col gap-1 rounded-xl p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
                      layoutId === option.id
                        ? "ring-2"
                        : "hover:bg-[var(--ws-hover)]",
                    )}
                    style={
                      layoutId === option.id
                        ? { boxShadow: "0 0 0 2px var(--ws-accent)" }
                        : undefined
                    }
                  >
                    {layout ? (
                      <LayoutPreview
                        layout={layout}
                        colors={kitLayoutPalette(kit)}
                        logos={previewLogosOf(kit)}
                        aspect={fmt.aspect}
                        ratio={fmt.ratio}
                        showLogo={Boolean(kit.logos.light || kit.logos.dark)}
                      />
                    ) : (
                      <span
                        className="flex aspect-[3/4] items-center justify-center rounded-xl text-[10px]"
                        style={{
                          background: "var(--ws-surface-2)",
                          color: "var(--ws-text-2)",
                        }}
                      >
                        {COPY.layoutDefault}
                      </span>
                    )}
                    <span
                      className="truncate text-[10.5px]"
                      style={{ color: "var(--ws-text-2)" }}
                    >
                      {option.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {editable && dirty ? (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {saving ? COPY.savingChanges : COPY.saveChanges}
            </Button>
          ) : null}
          {editable && handlers.onMake ? (
            <Button
              size="sm"
              disabled={saving}
              onClick={async () => {
                if (dirty && !(await save())) return;
                handlers.onMake?.(idea.id);
              }}
            >
              {idea.link?.workId && !idea.link.scheduledFor
                ? COPY.openDraft
                : COPY.make}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function IdeaDetailSheet({
  idea,
  ctx,
  handlers,
  onSaveDraft,
  onClose,
}: {
  idea: BoardIdea | null;
  ctx: IdeaCardContext;
  handlers: IdeaCardHandlers;
  onSaveDraft: (id: string, patch: IdeaDraftPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const concept = idea?.concept;
  return (
    <Sheet
      open={idea !== null}
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <SheetContent
        side="right"
        className="w-full overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[760px]"
      >
        <SheetHeader>
          <SheetTitle>{COPY.detailTitle}</SheetTitle>
        </SheetHeader>
        <div className="px-4 pb-6">
          {idea && concept?.module === "social" ? (
            <SocialDetail
              key={idea.id}
              idea={idea}
              concept={concept}
              ctx={ctx}
              handlers={handlers}
              onSaveDraft={onSaveDraft}
            />
          ) : idea ? (
            <div className="mx-auto max-w-[360px]">
              <IdeaCardView
                idea={idea}
                ctx={ctx}
                handlers={{ ...handlers, onOpen: undefined }}
              />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { Check, ChevronDown, ImagePlus, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_DIRECTIVES_CHARS,
  MAX_EXAMPLES,
  type PostStyleFidelity,
} from "@/lib/post-style";
import { cn } from "@/lib/utils";
import {
  addPostStyleExamplesAction,
  reanalyzePostStyleExampleAction,
  removePostStyleExampleAction,
  setPostStyleExampleAction,
  updatePostStyleDirectivesAction,
} from "@/server/actions/post-style-actions";

import { POST_STYLE_COPY as COPY } from "./post-style-copy";
import { assetUrl } from "@/lib/asset-url";

// The Brand Brain's Post style card: the example posts every new post is designed
// like, and the standing instructions every post obeys. The page reads the kit;
// this card edits it through the Post Style actions.

export type PostStyleExampleView = {
  assetId: string;
  label: string;
  enabled: boolean;
  source: "upload" | "link" | "chat" | "liked";
  summary: string | null;
  recipe: string | null;
};

const PER_REQUEST = 6;

export function PostStyleCard({
  projectId,
  examples,
  directives,
}: {
  projectId: string;
  examples: PostStyleExampleView[];
  directives: { text: string; fidelity: PostStyleFidelity };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState("");
  const [adding, setAdding] = useState(false);
  const [failures, setFailures] = useState<{ name: string; reason: string }[]>([]);

  const [text, setText] = useState(directives.text);
  const [fidelity, setFidelity] = useState<PostStyleFidelity>(directives.fidelity);
  const [saved, setSaved] = useState(false);
  const dirty = text.trim() !== directives.text.trim() || fidelity !== directives.fidelity;

  // Switches answer at once; the action's revalidation brings the stored state.
  const [switches, setSwitches] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);

  const add = async () => {
    const linkCount = links.split(/\s+/).filter((entry) => /^https?:\/\//i.test(entry)).length;
    if (files.length + linkCount === 0) {
      toast.info(COPY.nothingToAdd);
      return;
    }
    if (files.length + linkCount > PER_REQUEST) {
      toast.info(COPY.limit(PER_REQUEST));
      return;
    }
    setAdding(true);
    setFailures([]);
    try {
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("links", links);
      for (const file of files) form.append("files", file);
      const result = await addPostStyleExamplesAction(form);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setFailures(result.failed);
      if (result.added > 0) toast.success(COPY.addedSummary(result.added, result.failed.length));
      setFiles([]);
      setLinks("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch {
      toast.error(COPY.failed);
    } finally {
      setAdding(false);
    }
  };

  const run = (call: () => Promise<{ ok: boolean; message?: string }>) => {
    startTransition(async () => {
      try {
        const result = await call();
        if (!result.ok) toast.error(result.message ?? COPY.failed);
      } catch {
        toast.error(COPY.failed);
      }
      router.refresh();
    });
  };

  const saveDirectives = () => {
    setSaved(false);
    startTransition(async () => {
      try {
        const result = await updatePostStyleDirectivesAction({
          projectId,
          text,
          fidelity,
        });
        if (result.ok) {
          setSaved(true);
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error(COPY.failed);
      }
    });
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{COPY.title}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {COPY.exampleCount(examples.length)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{COPY.intro}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {examples.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            {COPY.noExamples}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {examples.map((example) => {
              const on = switches[example.assetId] ?? example.enabled;
              const name = example.label || COPY.untitled;
              const expanded = open === example.assetId;
              return (
                <li
                  key={example.assetId}
                  className={cn(
                    "overflow-hidden rounded-xl border bg-card transition-opacity",
                    !on && "opacity-60",
                  )}
                >
                  <div className="relative aspect-[3/4] bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element -- source is /api/assets/<id>, next/image cannot optimize it */}
                    <img
                      src={assetUrl(example.assetId, "thumb")}
                      alt={name}
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  </div>
                  <div className="space-y-2 p-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        defaultValue={example.label}
                        placeholder={COPY.untitled}
                        aria-label={COPY.labelAria}
                        maxLength={60}
                        className="h-8 min-w-0 flex-1 border-transparent px-1.5 text-sm font-medium shadow-none hover:border-input focus-visible:border-ring"
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (next === example.label) return;
                          run(() =>
                            setPostStyleExampleAction({
                              projectId,
                              assetId: example.assetId,
                              label: next,
                            }),
                          );
                        }}
                      />
                      <Switch
                        size="sm"
                        checked={on}
                        aria-label={COPY.switchAria(name)}
                        onCheckedChange={(next) => {
                          setSwitches((current) => ({
                            ...current,
                            [example.assetId]: next,
                          }));
                          run(() =>
                            setPostStyleExampleAction({
                              projectId,
                              assetId: example.assetId,
                              enabled: next,
                            }),
                          );
                        }}
                      />
                    </div>
                    <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                      {example.summary ?? COPY.notRead}
                      {example.source !== "upload" ? (
                        <span className="ml-1 text-[10px] uppercase tracking-wide">
                          {example.source === "link"
                            ? COPY.fromLink
                            : example.source === "chat"
                              ? COPY.fromChat
                              : COPY.fromLiked}
                        </span>
                      ) : null}
                    </p>
                    {expanded && example.recipe ? (
                      <p className="rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
                        {example.recipe}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between">
                      {example.recipe ? (
                        <button
                          type="button"
                          onClick={() => setOpen(expanded ? null : example.assetId)}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          <ChevronDown
                            className={cn("size-3 transition-transform", expanded && "rotate-180")}
                          />
                          {expanded ? COPY.hideDetails : COPY.details}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(() =>
                              reanalyzePostStyleExampleAction({
                                projectId,
                                assetId: example.assetId,
                              }),
                            )
                          }
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          <RefreshCw className="size-3" />
                          {COPY.reread}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() =>
                            removePostStyleExampleAction({
                              projectId,
                              assetId: example.assetId,
                            }),
                          )
                        }
                        aria-label={`${COPY.remove}: ${name}`}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                        {COPY.remove}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-3 border-t border-border/60 pt-5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {COPY.addTitle}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              id="post-style-files"
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={adding || examples.length >= MAX_EXAMPLES}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-4" />
              {COPY.choosePictures}
            </Button>
            {files.length > 0 ? (
              <span className="text-xs text-muted-foreground">
                {COPY.picturesChosen(files.length)}
              </span>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="post-style-links" className="text-xs text-muted-foreground">
              {COPY.linksLabel}
            </label>
            <Textarea
              id="post-style-links"
              value={links}
              onChange={(event) => setLinks(event.target.value)}
              placeholder={COPY.linksPlaceholder}
              rows={2}
              disabled={adding}
            />
            <p className="text-[11px] text-muted-foreground">{COPY.linksHint}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={add} disabled={adding}>
              {adding ? <Loader2 className="size-4 animate-spin" /> : null}
              {adding ? COPY.adding : COPY.addButton}
            </Button>
            {adding ? (
              <span className="text-xs text-muted-foreground">{COPY.addingHint}</span>
            ) : null}
          </div>
          {failures.length > 0 ? (
            <ul className="space-y-1 text-xs text-destructive">
              {failures.map((failure, index) => (
                <li key={`${failure.name}-${index}`}>
                  <span className="font-medium">{failure.name}</span>
                  {": "}
                  {failure.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="space-y-3 border-t border-border/60 pt-5">
          <div className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {COPY.fidelityLabel}
            </p>
            <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label={COPY.fidelityLabel}>
              {(["match", "inspired"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={fidelity === value}
                  onClick={() => {
                    setFidelity(value);
                    setSaved(false);
                  }}
                  className={cn(
                    "min-h-8 rounded-md px-3 text-xs font-medium transition-colors",
                    fidelity === value
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "match" ? COPY.fidelityMatch : COPY.fidelityInspired}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {fidelity === "match" ? COPY.fidelityHintMatch : COPY.fidelityHintInspired}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="post-style-directives" className="text-sm font-medium">
              {COPY.directivesTitle}
            </label>
            <p className="text-xs text-muted-foreground">{COPY.directivesHint}</p>
            <Textarea
              id="post-style-directives"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSaved(false);
              }}
              placeholder={COPY.directivesPlaceholder}
              rows={5}
              maxLength={MAX_DIRECTIVES_CHARS}
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {COPY.chars(text.length, MAX_DIRECTIVES_CHARS)}
              </span>
              <div className="flex items-center gap-2">
                {saved && !dirty ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Check className="size-3.5" />
                    {COPY.saved}
                  </span>
                ) : null}
                <Button type="button" size="sm" disabled={pending || !dirty} onClick={saveDirectives}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {COPY.save}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

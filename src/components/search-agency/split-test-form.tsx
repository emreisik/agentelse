"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  SPLIT_ERROR_TEXT,
  SPLIT_MAX_GROUPS,
  SPLIT_MAX_PAGES,
  SPLIT_MIN_GROUP_PAGES,
  type SplitEligibility,
} from "@/lib/seo/agency/split/assign";
import { SPLIT_KIND_LABEL } from "@/lib/seo/agency/split/copy";
import {
  SPLIT_CHANGE_KINDS,
  isSplitChangeKind,
  type SplitChangeKind,
} from "@/lib/seo/agency/split/types";
import {
  createSplitTestAction,
  previewSplitPopulationAction,
} from "@/server/actions/gsc-split-test-actions";

import {
  HINT_CLASS,
  INPUT_CLASS,
  SELECT_CLASS,
  parsePatternPreview,
  splitFormToFormData,
} from "./form-helpers";

// "New split test" formu (SC-F9). Sayfa grupları seçilince nüfus önizlemesi
// sunucudan gelir; "Create" yalnız uygun bir önizleme varken açılır. İstemci
// denetimleri yalnız kullanıcı deneyimi içindir; sunucu yetkilidir.

const PREVIEW_DEBOUNCE_MS = 300;
const TITLE_MAX = 120;
const META_MAX = 320;

export type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | {
      state: "ready";
      eligibility: SplitEligibility;
      pages: number;
      capped: boolean;
      groups: { group: string; pages: number }[];
    }
  | { state: "error"; message: string };

export function PopulationPreview({ preview }: { preview: PreviewState }) {
  if (preview.state === "idle") {
    return (
      <p className={HINT_CLASS} data-state="idle">
        Choose 1 to {SPLIT_MAX_GROUPS} page groups to see how the pages would be
        split.
      </p>
    );
  }
  if (preview.state === "loading") {
    return (
      <p className={HINT_CLASS} role="status" data-state="loading">
        Checking pages...
      </p>
    );
  }
  if (preview.state === "error") {
    return (
      <p className="text-sm text-destructive" data-state="error">
        {preview.message}
      </p>
    );
  }
  const { eligibility } = preview;
  if (!eligibility.ok) {
    return (
      <p className="text-sm text-destructive" data-state="not-eligible">
        {SPLIT_ERROR_TEXT[eligibility.reason]}
      </p>
    );
  }
  return (
    <div className="space-y-1 text-sm" data-state="eligible">
      <p>
        <span className="font-medium tabular-nums">{preview.pages}</span> pages
        split into two groups: {eligibility.arms.test} test and{" "}
        {eligibility.arms.control} control.
      </p>
      <ul className={`${HINT_CLASS} space-y-0.5`}>
        {eligibility.perGroup.map((group) => (
          <li key={group.group} className="tabular-nums">
            {group.group}: {group.test} test, {group.control} control
          </li>
        ))}
      </ul>
      {preview.capped ? (
        <p className={HINT_CLASS}>
          Only the {SPLIT_MAX_PAGES} pages with the most clicks are used.
        </p>
      ) : null}
      <p className={HINT_CLASS}>
        {eligibility.recommended
          ? "Recommended size: results can be significant."
          : "Smaller than recommended: results will be directional at best."}
      </p>
    </div>
  );
}

export function SplitTestForm({
  projectId,
  linkId,
  groups,
}: {
  projectId: string;
  linkId: string;
  groups: { group: string; pages: number }[];
}) {
  const router = useRouter();
  const [creating, startCreate] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SplitChangeKind>("TITLE_META");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [titlePattern, setTitlePattern] = useState("");
  const [metaPattern, setMetaPattern] = useState("");
  const [schemaType, setSchemaType] = useState("");
  const [note, setNote] = useState("");
  // Önizleme hangi grup seçimi için geldiyse anahtarıyla saklanır; seçim
  // değişince eski sonuç yok sayılır (yükleniyor görünür). Efekt içinde
  // eşzamanlı setState yoktur.
  const selectionKey = selected.join("\n");
  const [result, setResult] = useState<{
    key: string;
    preview: PreviewState;
  } | null>(null);
  const preview: PreviewState =
    selected.length === 0
      ? { state: "idle" }
      : result?.key === selectionKey
        ? result.preview
        : { state: "loading" };

  useEffect(() => {
    if (selected.length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      let next: PreviewState;
      try {
        const response = await previewSplitPopulationAction({
          projectId,
          linkId,
          pageGroups: selected,
        });
        next = response.ok
          ? {
              state: "ready",
              eligibility: response.eligibility,
              pages: response.pages,
              capped: response.capped,
              groups: response.groups,
            }
          : { state: "error", message: response.message };
      } catch {
        next = {
          state: "error",
          message: "Couldn't check the pages. Try again.",
        };
      }
      if (!cancelled) setResult({ key: selectionKey, preview: next });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selected, selectionKey, projectId, linkId]);

  const titleCheck = parsePatternPreview(titlePattern, undefined, TITLE_MAX);
  const metaCheck = parsePatternPreview(metaPattern, undefined, META_MAX);
  const schemaOk = schemaType === "" || /^[A-Za-z]{1,40}$/.test(schemaType);
  const changeReady =
    kind === "TITLE_META"
      ? (titlePattern.trim() !== "" || metaPattern.trim() !== "") &&
        titleCheck.ok &&
        metaCheck.ok
      : kind === "SCHEMA"
        ? schemaType !== "" && schemaOk
        : true;
  const eligible = preview.state === "ready" && preview.eligibility.ok;
  const canCreate = !creating && eligible && name.trim() !== "" && changeReady;

  function toggle(group: string) {
    setSelected((current) =>
      current.includes(group)
        ? current.filter((item) => item !== group)
        : current.length >= SPLIT_MAX_GROUPS
          ? current
          : [...current, group],
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    const data = splitFormToFormData({
      projectId,
      linkId,
      name,
      changeKind: kind,
      description,
      pageGroups: selected,
      titlePattern: kind === "TITLE_META" ? titlePattern : "",
      metaPattern: kind === "TITLE_META" ? metaPattern : "",
      schemaType: kind === "SCHEMA" ? schemaType : "",
      note,
    });
    startCreate(async () => {
      try {
        const result = await createSplitTestAction(data);
        if (result.ok) {
          toast.success("Split test created");
          setName("");
          setDescription("");
          setSelected([]);
          setTitlePattern("");
          setMetaPattern("");
          setSchemaType("");
          setNote("");
          router.refresh();
        } else {
          toast.error(result.message || "Couldn't create the test");
        }
      } catch {
        toast.error("Couldn't create the test");
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" data-card="split-test-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            placeholder="Shorter product titles"
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span className="block">What you will change</span>
          <select
            value={kind}
            onChange={(event) => {
              if (isSplitChangeKind(event.target.value)) {
                setKind(event.target.value);
              }
            }}
            className={`${SELECT_CLASS} w-full`}
          >
            {SPLIT_CHANGE_KINDS.map((item) => (
              <option key={item} value={item}>
                {SPLIT_KIND_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span className="block">Description (optional)</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={300}
          className={`${INPUT_CLASS} w-full`}
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-xs text-muted-foreground">
          Page groups ({selected.length} of {SPLIT_MAX_GROUPS} chosen)
        </legend>
        {groups.length > 0 ? (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {groups.map((group) => {
              const checked = selected.includes(group.group);
              const blocked = !checked && selected.length >= SPLIT_MAX_GROUPS;
              return (
                <li key={group.group}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={blocked}
                      onChange={() => toggle(group.group)}
                      className="size-4"
                    />
                    <span className="min-w-0 truncate">{group.group}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {group.pages} pages
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No page groups yet. They appear once pages have been synced.
          </p>
        )}
        <p className={HINT_CLASS}>
          Each group needs at least {SPLIT_MIN_GROUP_PAGES} pages with search
          traffic. Pages are split at random into a test half and a control half
          inside every group.
        </p>
      </fieldset>

      {kind === "TITLE_META" ? (
        <div className="space-y-3">
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span className="block">Title pattern</span>
            <input
              value={titlePattern}
              onChange={(event) => setTitlePattern(event.target.value)}
              placeholder="{title} | {site}"
              spellCheck={false}
              aria-invalid={titleCheck.ok ? undefined : true}
              className={`${INPUT_CLASS} w-full`}
            />
            <PatternLine check={titleCheck} />
          </label>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span className="block">Meta description pattern (optional)</span>
            <input
              value={metaPattern}
              onChange={(event) => setMetaPattern(event.target.value)}
              placeholder="{h1} - free delivery"
              spellCheck={false}
              aria-invalid={metaCheck.ok ? undefined : true}
              className={`${INPUT_CLASS} w-full`}
            />
            <PatternLine check={metaCheck} />
          </label>
          <p className={HINT_CLASS}>
            Tokens: {"{title}"} {"{h1}"} {"{site}"} {"{year}"}. Pages where a
            result would be empty or too long are skipped, never cut short.
          </p>
        </div>
      ) : null}
      {kind === "SCHEMA" ? (
        <label className="block space-y-1 text-xs text-muted-foreground">
          <span className="block">Schema type to add</span>
          <input
            value={schemaType}
            onChange={(event) => setSchemaType(event.target.value)}
            maxLength={40}
            placeholder="FAQPage"
            spellCheck={false}
            aria-invalid={schemaOk ? undefined : true}
            className={`${INPUT_CLASS} w-full sm:w-64`}
          />
          {!schemaOk ? (
            <span className="block text-destructive">
              Use letters only, like FAQPage.
            </span>
          ) : null}
        </label>
      ) : null}
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span className="block">Notes (optional)</span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={400}
          className={`${INPUT_CLASS} w-full`}
        />
      </label>

      <PopulationPreview preview={preview} />

      <Button type="submit" size="sm" disabled={!canCreate}>
        {creating ? "Creating..." : "Create test"}
      </Button>
    </form>
  );
}

function PatternLine({
  check,
}: {
  check: ReturnType<typeof parsePatternPreview>;
}) {
  if (!check.ok) {
    return <span className="block text-destructive">{check.message}</span>;
  }
  if (!check.preview) return null;
  return (
    <span className="block">
      Example: <span className="text-foreground">{check.preview}</span>
    </span>
  );
}

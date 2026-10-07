"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import { PAGE_GROUP_MATCH_LABEL } from "@/lib/seo/agency/copy";
import type {
  PageGroupMatch,
  PageGroupPreview,
  PageGroupRule,
} from "@/lib/seo/agency/page-groups";
import {
  previewPageGroupRulesAction,
  savePageGroupRulesAction,
} from "@/server/actions/gsc-sites-actions";

import {
  HINT_CLASS,
  INPUT_CLASS,
  MAX_EDITABLE_RULES,
  SELECT_CLASS,
  buildRulePayload,
  buildRulesJson,
  newRowKey,
  ruleProblem,
  type EditableRule,
} from "./form-helpers";

// Sayfa grubu kural düzenleyicisi (SC-F9). Kurallar yerel durumda tutulur,
// satırların kararlı anahtarı vardır, en çok 40 kural gider. İstemci denetimi
// yalnız kullanıcı deneyimi içindir; sunucu yetkilidir. Önizleme düzenlemeden
// 400 ms sonra ya da "Preview" ile çalışır; eski yanıtlar yok sayılır.

const PREVIEW_DEBOUNCE_MS = 400;
const MATCH_ORDER: PageGroupMatch[] = ["PREFIX", "GLOB", "EXACT"];

function rowsFrom(rules: readonly PageGroupRule[]): EditableRule[] {
  return rules.map((rule) => ({
    key: newRowKey(),
    group: rule.group,
    match: rule.match,
    pattern: rule.pattern,
  }));
}

export function PreviewTable({ preview }: { preview: PageGroupPreview }) {
  return (
    <div data-card="page-group-preview" className="space-y-2">
      <p className="text-sm">
        <span className="font-medium tabular-nums">{preview.changed}</span>{" "}
        {preview.changed === 1 ? "page would move" : "pages would move"}
        <span className={`${HINT_CLASS} ml-2`}>
          from {preview.sampled} sampled
          {preview.unmatched > 0
            ? `, ${preview.unmatched} not matched by a rule`
            : ""}
        </span>
      </p>
      {preview.groups.length > 0 ? (
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Group
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Pages
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Examples
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.groups.map((group) => (
                <tr key={group.group} className="border-t border-foreground/10">
                  <td className="px-3 py-2 font-medium">{group.group}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {group.pages}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {group.samples.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={HINT_CLASS}>No pages to preview yet.</p>
      )}
    </div>
  );
}

export function PageGroupsEditor({
  projectId,
  linkId,
  initialRules,
}: {
  projectId: string;
  linkId: string;
  initialRules: readonly PageGroupRule[];
}) {
  const [rows, setRows] = useState<EditableRule[]>(() =>
    rowsFrom(initialRules),
  );
  const [preview, setPreview] = useState<PageGroupPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const touched = useRef(false);
  const sequence = useRef(0);

  const atCap = rows.length >= MAX_EDITABLE_RULES;
  const problems = rows.map((row) => ruleProblem(row));
  const hasProblem = problems.some((problem) => problem !== null);
  const payload = buildRulePayload(rows);

  function runPreview() {
    if (hasProblem) return;
    const ticket = (sequence.current += 1);
    startTransition(async () => {
      try {
        const response = await previewPageGroupRulesAction({
          projectId,
          linkId,
          rules: buildRulePayload(rows),
        });
        if (ticket !== sequence.current) return;
        if (response.ok) {
          setPreview(response.preview);
          setPreviewError(null);
        } else {
          setPreviewError(response.message);
        }
      } catch {
        if (ticket === sequence.current) {
          setPreviewError("Couldn't preview these rules. Try again.");
        }
      }
    });
  }

  useEffect(() => {
    if (!touched.current) return;
    const timer = window.setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // runPreview okuduğu satırlar `rows` ile birlikte değişir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  function update(next: EditableRule[]) {
    touched.current = true;
    setRows(next);
  }

  function change(key: string, patch: Partial<EditableRule>) {
    update(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const current = rows[index];
    const other = rows[target];
    if (!current || !other) return;
    const next = [...rows];
    next[index] = other;
    next[target] = current;
    update(next);
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules yet. Pages are grouped by their first path segment.
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Page group rules">
          {rows.map((row, index) => (
            <li key={row.key} className="space-y-1">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,1.4fr)_auto] sm:items-center">
                <input
                  aria-label={`Rule ${index + 1} group name`}
                  aria-invalid={problems[index] ? true : undefined}
                  value={row.group}
                  onChange={(event) =>
                    change(row.key, { group: event.target.value })
                  }
                  placeholder="/reviews"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT_CLASS} w-full`}
                />
                <select
                  aria-label={`Rule ${index + 1} match type`}
                  value={row.match}
                  onChange={(event) =>
                    change(row.key, { match: event.target.value })
                  }
                  className={`${SELECT_CLASS} w-full`}
                >
                  {MATCH_ORDER.map((match) => (
                    <option key={match} value={match}>
                      {PAGE_GROUP_MATCH_LABEL[match]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Rule ${index + 1} path pattern`}
                  aria-invalid={problems[index] ? true : undefined}
                  value={row.pattern}
                  onChange={(event) =>
                    change(row.key, { pattern: event.target.value })
                  }
                  placeholder="/shop/*/reviews"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT_CLASS} w-full`}
                />
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move rule ${index + 1} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Move rule ${index + 1} down`}
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove rule ${index + 1}`}
                    onClick={() =>
                      update(rows.filter((item) => item.key !== row.key))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {problems[index] ? (
                <p className="text-xs text-destructive">{problems[index]}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <p className={HINT_CLASS}>
        The first matching rule wins. Matching ignores letter case.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={atCap}
          onClick={() =>
            update([
              ...rows,
              { key: newRowKey(), group: "", match: "PREFIX", pattern: "" },
            ])
          }
        >
          <Plus />
          Add rule
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || hasProblem || payload.length === 0}
          onClick={() => {
            touched.current = true;
            runPreview();
          }}
        >
          {pending ? "Previewing..." : "Preview"}
        </Button>
        {atCap ? (
          <span className={HINT_CLASS}>Up to {MAX_EDITABLE_RULES} rules.</span>
        ) : null}
      </div>
      {previewError ? (
        <p className="text-sm text-destructive">{previewError}</p>
      ) : null}
      {preview ? <PreviewTable preview={preview} /> : null}
      <ActionForm
        action={savePageGroupRulesAction}
        successMessage="Page groups saved"
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="linkId" value={linkId} />
        <input type="hidden" name="rules" value={buildRulesJson(rows)} />
        <SubmitButton size="sm" disabled={hasProblem}>
          Save
        </SubmitButton>
        <span className={HINT_CLASS}>
          Saved rules reach existing pages within a few minutes.
        </span>
      </ActionForm>
    </div>
  );
}

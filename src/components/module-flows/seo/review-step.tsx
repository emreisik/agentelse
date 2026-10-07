"use client";

import { CircleAlert, CircleCheck } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Textarea } from "@/components/ui/textarea";
import { CardActions } from "@/components/works/card-actions";
import { siteLabel } from "@/lib/module-flows/seo/brief";
import { articleStats } from "@/lib/module-flows/seo/markdown";
import { checkOnPage } from "@/lib/module-flows/seo/on-page";
import { refreshDiff } from "@/lib/module-flows/seo/refresh-diff";
import {
  SEO_LIMITS,
  seoModeOf,
  type SeoArticle,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  rewriteSeoArticleAction,
} from "@/server/actions/seo-flow-actions";

import { ArticleView } from "./article-view";
import { SEO_FLOW_COPY as COPY } from "./copy";
import { RefreshDiffView } from "./refresh-diff-view";
import {
  Field,
  RunNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Step 4, Review: the article as it reads (with its search snippet), and the
// on-page checks, each a pass or one line on what to fix. "Rewrite" takes
// optional notes and stays here; "Publish" moves on to the hand-off.
// SC-F6: when a page is being refreshed, a summary of what changes on the page
// sits above the checks.

const PUBLISH = "goto:deliver";
const OPEN_REWRITE = "open-rewrite";
const REWRITE = "rewrite";
const CANCEL = "cancel";
const BACK = "goto:plan";

type Props = {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  running: boolean;
  blocked: string | null;
  onMoving?: OnMoving;
};

function SearchPreview({
  siteUrl,
  title,
  metaDescription,
}: {
  siteUrl: string;
  title: string;
  metaDescription: string;
}) {
  return (
    <Field label={COPY.preview}>
      <div
        className="space-y-0.5 rounded-xl border px-3 py-2.5"
        style={{ borderColor: "var(--ws-border)" }}
      >
        <p
          className="truncate text-[11px]"
          style={{ color: "var(--ws-text-2)" }}
        >
          {siteUrl ? siteLabel(siteUrl) : COPY.previewSite}
        </p>
        <p
          className="text-[15px] leading-5 font-medium break-words"
          style={{ color: "var(--ws-accent)" }}
        >
          {title}
        </p>
        <p
          className="line-clamp-2 text-xs leading-5"
          style={{ color: "var(--ws-text-2)" }}
        >
          {metaDescription}
        </p>
      </div>
    </Field>
  );
}

export function ReviewStep(props: Props) {
  const { article } = props.state;
  if (!article) return null;
  return <ReviewBody {...props} article={article} />;
}

function ReviewBody({
  projectId,
  commandId,
  state,
  running,
  blocked,
  onMoving,
  article,
}: Props & { article: SeoArticle }) {
  const ids = useId();
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const keyword = state.plan?.primaryKeyword ?? "";
  const checks = useMemo(
    () =>
      checkOnPage({
        title: article.title,
        metaDescription: article.metaDescription,
        markdown: article.markdown,
        primaryKeyword: keyword,
      }),
    [article, keyword],
  );
  const stats = useMemo(
    () => articleStats(article.markdown),
    [article.markdown],
  );
  const passed = checks.filter((check) => check.status === "pass").length;
  const { target } = state;
  const diff = useMemo(
    () =>
      state.features?.modes && seoModeOf(state) === "refresh" && target
        ? refreshDiff({
            target,
            article,
            outline: state.plan?.outline ?? [],
          })
        : null,
    [state, target, article],
  );

  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [PUBLISH]: "deliver", [BACK]: "plan" },
    local: {
      [OPEN_REWRITE]: () => setRewriteOpen(true),
      [CANCEL]: () => setRewriteOpen(false),
    },
    server: async (id, card) => {
      if (id !== REWRITE) {
        return goToSeoStepAction(
          card.projectId,
          card.commandId,
          id === PUBLISH ? "deliver" : "plan",
        );
      }
      const result = await rewriteSeoArticleAction(
        card.projectId,
        card.commandId,
        notes,
      );
      if (result.ok) {
        setRewriteOpen(false);
        setNotes("");
      }
      return result;
    },
  });
  const rewriting = running || busyId === REWRITE;
  const limitReached = article.rewrites >= SEO_LIMITS.rewrites;
  const buttons: CardButton[] = rewriteOpen
    ? [
        serverButton(
          REWRITE,
          busyId === REWRITE ? COPY.rewriting : COPY.rewriteNow,
          "primary",
          blocked,
        ),
        serverButton(CANCEL, COPY.cancel, "quiet", null),
      ]
    : [
        serverButton(PUBLISH, COPY.publish, "primary", blocked),
        serverButton(
          OPEN_REWRITE,
          COPY.rewrite,
          "secondary",
          blocked ?? (limitReached ? COPY.rewriteLimit : null),
        ),
        serverButton(BACK, COPY.backToPlan, "quiet", blocked),
      ];

  return (
    <div className="space-y-4">
      <SearchPreview
        siteUrl={state.brief?.siteUrl ?? ""}
        title={article.title}
        metaDescription={article.metaDescription}
      />

      <Field
        label={COPY.article}
        aside={
          <span
            className="text-[11px] tabular-nums"
            style={{ color: "var(--ws-text-3)" }}
          >
            {COPY.stats(stats.words, stats.h2.length)}
          </span>
        }
      >
        <div
          tabIndex={0}
          role="region"
          aria-label={COPY.article}
          className="max-h-[28rem] overflow-y-auto rounded-xl border px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{
            borderColor: "var(--ws-border)",
            opacity: rewriting ? 0.6 : 1,
          }}
        >
          <ArticleView title={article.title} markdown={article.markdown} />
        </div>
      </Field>

      {diff ? <RefreshDiffView diff={diff} /> : null}

      <Field
        label={COPY.checks}
        aside={
          <span
            className="text-[11px] tabular-nums"
            style={{ color: "var(--ws-text-3)" }}
          >
            {COPY.checksSummary(passed, checks.length)}
          </span>
        }
      >
        <ul className="space-y-1.5">
          {checks.map((check) => (
            <li
              key={check.id}
              className="flex items-start gap-2 text-xs leading-5"
            >
              {check.status === "pass" ? (
                <CircleCheck
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                  style={{ color: "var(--ws-approved)" }}
                />
              ) : (
                <CircleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                  style={{ color: "var(--ws-pending)" }}
                />
              )}
              <span className="min-w-0">
                <span className="sr-only">
                  {check.status === "pass" ? COPY.pass : COPY.warn}:{" "}
                </span>
                <span
                  className="font-medium"
                  style={{ color: "var(--ws-text)" }}
                >
                  {check.label}
                </span>{" "}
                <span style={{ color: "var(--ws-text-2)" }}>{check.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </Field>

      {rewriteOpen && !rewriting ? (
        <Field label={COPY.rewriteLabel} htmlFor={`${ids}-notes`}>
          <Textarea
            id={`${ids}-notes`}
            value={notes}
            rows={2}
            maxLength={SEO_LIMITS.notes}
            placeholder={COPY.rewritePlaceholder}
            onChange={(event) => setNotes(event.target.value)}
          />
          {passed < checks.length ? (
            <p className="text-xs" style={{ color: "var(--ws-text-3)" }}>
              {COPY.rewriteHint}
            </p>
          ) : null}
        </Field>
      ) : null}

      {rewriting ? (
        <RunNote text={COPY.rewriteNote} />
      ) : (
        <CardActions
          buttons={buttons}
          onAct={onAct}
          busyId={busyId}
          error={error}
        />
      )}
    </div>
  );
}

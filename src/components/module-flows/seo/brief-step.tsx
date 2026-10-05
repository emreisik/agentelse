"use client";

import { startTransition, useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { CardActions } from "@/components/works/card-actions";
import { SEO_LANGUAGES, validateSeoBrief } from "@/lib/module-flows/seo/brief";
import { SEO_LIMITS, type SeoState } from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  researchSeoAction,
  seoBriefDefaultsAction,
} from "@/server/actions/seo-flow-actions";

import { SEO_FLOW_COPY as COPY } from "./copy";
import {
  Field,
  NATIVE_SELECT_CLASS,
  WorkingNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";

// Step 1, Brief: the topic (required), the site, the article's language and,
// optionally, who it is for. A brief never filled starts from the project's
// website and the brand's language; "Find keywords" saves it and researches.

const RESEARCH = "research";
const KEEP_PLAN = "goto:plan";

export function BriefStep({
  projectId,
  commandId,
  state,
  blocked,
  onMoving,
}: {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  // Why nothing on the card can change right now, or null.
  blocked: string | null;
  onMoving?: OnMoving;
}) {
  const stored = state.brief;
  const [topic, setTopic] = useState(stored?.topic ?? "");
  const [siteUrl, setSiteUrl] = useState(stored?.siteUrl ?? "");
  const [language, setLanguage] = useState(stored?.language ?? "");
  const [audience, setAudience] = useState(stored?.audience ?? "");
  // A field the person changed is never overwritten by a late default.
  const edited = useRef({ siteUrl: false, language: false });
  const ids = useId();

  useEffect(() => {
    if (stored || !projectId) return;
    let cancelled = false;
    startTransition(async () => {
      const result = await seoBriefDefaultsAction(projectId);
      if (cancelled || !result.ok) return;
      startTransition(() => {
        if (!edited.current.siteUrl && result.siteUrl) {
          setSiteUrl(result.siteUrl);
        }
        if (!edited.current.language && result.language) {
          setLanguage(result.language);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [stored, projectId]);

  const brief = { topic, siteUrl, language, audience };
  const check = validateSeoBrief(brief);
  const { onAct, busyId, error } = useSeoStepAction({
    projectId,
    commandId,
    onMoving,
    moves: { [RESEARCH]: "plan", [KEEP_PLAN]: "plan" },
    server: (id, card) =>
      id === KEEP_PLAN
        ? goToSeoStepAction(card.projectId, card.commandId, "plan")
        : researchSeoAction(card.projectId, card.commandId, brief),
  });
  const researching = busyId === RESEARCH;

  const buttons: CardButton[] = [
    serverButton(
      RESEARCH,
      researching
        ? COPY.researching
        : state.plan
          ? COPY.researchAgain
          : COPY.research,
      "primary",
      blocked ?? (check.ok ? null : check.message),
    ),
    ...(state.plan
      ? [serverButton(KEEP_PLAN, COPY.keepPlan, "quiet", blocked)]
      : []),
  ];

  return (
    <div className="space-y-3">
      <fieldset disabled={researching} className="space-y-3">
        <Field label={COPY.topic} htmlFor={`${ids}-topic`}>
          <Input
            id={`${ids}-topic`}
            value={topic}
            maxLength={SEO_LIMITS.topic}
            placeholder={COPY.topicPlaceholder}
            aria-invalid={
              !check.ok && check.field === "topic" && topic.length > 0
            }
            onChange={(event) => setTopic(event.target.value)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_11rem]">
          <Field label={COPY.site} htmlFor={`${ids}-site`}>
            <Input
              id={`${ids}-site`}
              value={siteUrl}
              inputMode="url"
              autoComplete="url"
              maxLength={SEO_LIMITS.siteUrl}
              placeholder={COPY.sitePlaceholder}
              aria-invalid={!check.ok && check.field === "siteUrl"}
              onChange={(event) => {
                edited.current.siteUrl = true;
                setSiteUrl(event.target.value);
              }}
            />
          </Field>
          <Field label={COPY.language} htmlFor={`${ids}-language`}>
            <select
              id={`${ids}-language`}
              value={language}
              className={NATIVE_SELECT_CLASS}
              style={{ color: "var(--ws-text)" }}
              onChange={(event) => {
                edited.current.language = true;
                setLanguage(event.target.value);
              }}
            >
              <option value="" disabled>
                {COPY.languagePlaceholder}
              </option>
              {SEO_LANGUAGES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={COPY.audience} htmlFor={`${ids}-audience`}>
          <Input
            id={`${ids}-audience`}
            value={audience}
            maxLength={SEO_LIMITS.audience}
            placeholder={COPY.audiencePlaceholder}
            onChange={(event) => setAudience(event.target.value)}
          />
        </Field>
      </fieldset>
      {researching ? <WorkingNote>{COPY.researchNote}</WorkingNote> : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

"use client";

import { startTransition, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CardActions } from "@/components/works/card-actions";
import { SEO_LANGUAGES, validateSeoBrief } from "@/lib/module-flows/seo/brief";
import {
  SEO_LIMITS,
  seoModeOf,
  type SeoState,
} from "@/lib/module-flows/seo/state";
import type { CardButton } from "@/lib/works/card-action";
import {
  goToSeoStepAction,
  researchSeoAction,
  seoBriefDefaultsAction,
} from "@/server/actions/seo-flow-actions";

import { cardStatusView } from "./card-status";
import { SEO_FLOW_COPY as COPY } from "./copy";
import { ModePicker } from "./mode-picker";
import {
  Field,
  NATIVE_SELECT_CLASS,
  RunNote,
  serverButton,
  useSeoStepAction,
  type OnMoving,
} from "./parts";
import { TargetPicker } from "./target-picker";
import { useCardStatus } from "./use-card-status";

// Step 1, Brief: the topic (required), the site, the article's language and,
// optionally, who it is for. A brief never filled starts from the project's
// website and the brand's language; "Find keywords" saves it and researches.
// SC-F6 (state.features.modes): a mode picker on top; "Refresh a page" and
// "Fix a snippet" ask for a page instead of a topic (TargetPicker); in article
// mode an empty topic can adopt the topic Search Console suggested.

const RESEARCH = "research";
const KEEP_PLAN = "goto:plan";

type Props = {
  projectId?: string;
  commandId?: string;
  state: SeoState;
  // Why nothing on the card can change right now, or null.
  blocked: string | null;
  onMoving?: OnMoving;
  // The topic of the idea the flow was started from (docs/ideas.md).
  defaultTopic?: string;
  // A model call holds the card (only read when the card streams live).
  running?: boolean;
};

export function BriefStep(props: Props) {
  const { state } = props;
  const modes = state.features?.modes === true;
  if (!modes) return <ArticleBrief {...props} modes={false} />;
  const mode = seoModeOf(state);
  const picker =
    !state.plan && !state.snippet ? (
      <ModePicker
        projectId={props.projectId}
        commandId={props.commandId}
        mode={mode}
        blocked={props.blocked}
      />
    ) : null;
  if (mode === "article") {
    return (
      <div className="space-y-4">
        {picker}
        <ArticleBrief {...props} modes />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {picker}
      <TargetPicker
        projectId={props.projectId}
        commandId={props.commandId}
        state={state}
        mode={mode}
        running={props.running === true && state.features?.live === true}
        blocked={props.blocked}
        onMoving={props.onMoving}
      />
    </div>
  );
}

function ArticleBrief({
  projectId,
  commandId,
  state,
  blocked,
  onMoving,
  defaultTopic,
  running = false,
  modes,
}: Props & { modes: boolean }) {
  const stored = state.brief;
  const [topic, setTopic] = useState(stored?.topic ?? defaultTopic ?? "");
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
  // Canlı kartta koşu arka planda sürer: eylem hemen döner, kart çalışıyor
  // notunu state.run'dan gösterir.
  const researching =
    busyId === RESEARCH || (state.features?.live === true && running);

  // Search Console'un önerdiği konu: yalnız modlar açıkken, konu boşken.
  const { status } = useCardStatus({
    projectId,
    commandId,
    enabled: modes && topic.trim().length === 0,
    version: "brief",
  });
  const suggestion = cardStatusView(status, { modes })?.suggestion ?? null;

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
          {suggestion && topic.trim().length === 0 ? (
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-dashed px-3 py-1.5"
              style={{ borderColor: "var(--ws-border)" }}
            >
              <p
                className="min-w-0 flex-1 text-xs leading-5 break-words"
                style={{ color: "var(--ws-text-2)" }}
              >
                {COPY.suggestedTopic}: “{suggestion}”
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setTopic(suggestion.slice(0, SEO_LIMITS.topic))}
              >
                {COPY.useSuggestion}
              </Button>
            </div>
          ) : null}
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
      {researching ? <RunNote text={COPY.researchNote} /> : null}
      <CardActions
        buttons={buttons}
        onAct={onAct}
        busyId={busyId}
        error={error}
      />
    </div>
  );
}

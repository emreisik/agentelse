"use client";

import {
  useCallback,
  useId,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isValidDomain } from "@/lib/domain";
import { type IntakeOffer, intakeCopyFor } from "@/lib/intake-offer";
import type { LocaleDefault } from "@/lib/locale-defaults";
import {
  SUPPORTED_LANGUAGES,
  isSupportedCountry,
  languageLabel,
  countryLabel,
  type CountryCode,
} from "@/lib/locales";
import {
  createGuidedProjectAction,
  type CreateProjectFailure,
} from "@/server/actions/project-actions";
import { MarketMultiSelect } from "./market-controls";
import {
  DEFAULT_LOCALE_NOTE,
  LOCALE_SOURCE_LABEL,
  initialNewProjectState,
  languageFallbackNote,
  newProjectReducer,
  toNewProjectFormData,
  validateNewProject,
  type NewProjectFocusTarget,
} from "./new-project-state";

// The one-screen creation form (guided setup on). It keeps the two typed
// fields no button can replace (name, website) and turns the rest into taps:
// the market is a row of chips and the content language is derived from it.
// Every rule lives in new-project-state.ts; this file renders and forwards.

// Chips shown up front; anything else is one of "More markets…".
const QUICK_MARKETS: readonly CountryCode[] = [
  "TR",
  "MK",
  "AL",
  "XK",
  "RS",
  "BG",
];

const CHIP_CLASS =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function Chip({
  selected,
  onClick,
  children,
  ...aria
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & Pick<React.ComponentProps<"button">, "aria-expanded" | "aria-controls">) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        CHIP_CLASS,
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-foreground hover:bg-muted",
      )}
      {...aria}
    >
      {children}
    </button>
  );
}

export function NewProjectForm({
  initialLocale,
  offer,
}: {
  initialLocale: LocaleDefault;
  // What the tap can start, decided by the server (see lib/intake-offer.ts).
  offer: IntakeOffer;
}) {
  const [state, dispatch] = useReducer(
    newProjectReducer,
    initialLocale,
    initialNewProjectState,
  );
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<CreateProjectFailure | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [changing, setChanging] = useState(false);

  const ids = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const domainRef = useRef<HTMLInputElement | null>(null);
  const marketRef = useRef<HTMLDivElement | null>(null);
  const languageRef = useRef<HTMLDivElement | null>(null);

  // On a phone the keyboard would open on load and cover the market chips, so
  // the name field is focused only with a fine pointer. A callback ref runs
  // once on mount: no effect and no state.
  const setNameRef = useCallback((element: HTMLInputElement | null) => {
    nameRef.current = element;
    if (element && window.matchMedia("(pointer: fine)").matches) {
      element.focus();
    }
  }, []);

  function focusTarget(target: NewProjectFocusTarget) {
    const refs = {
      name: nameRef,
      domain: domainRef,
      market: marketRef,
      language: languageRef,
    };
    refs[target].current?.focus();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const checked = validateNewProject(state);
    dispatch({ type: "submit" });
    if (checked.focus) {
      focusTarget(checked.focus);
      return;
    }
    setFailure(null);
    startTransition(async () => {
      // The action only returns on failure; success redirects.
      const result = await createGuidedProjectAction(
        toNewProjectFormData(state),
      );
      setFailure(result);
      if (result.field === "name") focusTarget("name");
      else if (result.field === "domain") focusTarget("domain");
      else if (result.field === "country") focusTarget("market");
    });
  }

  const primary = state.countries[0];
  const chipCodes: CountryCode[] =
    primary && !QUICK_MARKETS.includes(primary)
      ? [...QUICK_MARKETS, primary]
      : [...QUICK_MARKETS];
  const fallbackNote = languageFallbackNote(state);
  // An error inside the market or language controls forces them open so the
  // focus target exists.
  const marketOpen =
    changing || Boolean(state.errors.country || state.errors.language);
  const sourceNote = state.localeSource
    ? LOCALE_SOURCE_LABEL[state.localeSource]
    : state.defaulted
      ? DEFAULT_LOCALE_NOTE
      : null;

  const nameErrorId = `${ids}-name-error`;
  const noteId = `${ids}-intake-note`;
  // The button and its note come from the function the server's start decision
  // uses, so the screen promises exactly what the tap does.
  const intake = intakeCopyFor(offer, isValidDomain(state.domain.trim()));
  const domainErrorId = `${ids}-domain-error`;
  const domainHelpId = `${ids}-domain-help`;
  const marketLabelId = `${ids}-market-label`;
  const marketErrorId = `${ids}-market-error`;
  const marketProvenanceId = `${ids}-market-source`;
  const moreId = `${ids}-more`;
  const marketPanelId = `${ids}-market-panel`;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Create New Project"
      className="w-full max-w-xl space-y-6 rounded-2xl bg-card p-6 shadow-sm ring-1 ring-foreground/10 sm:p-8"
    >
      <div className="space-y-2">
        <label htmlFor={`${ids}-name`} className="text-sm font-medium">
          Brand name
        </label>
        <Input
          id={`${ids}-name`}
          ref={setNameRef}
          value={state.name}
          onChange={(event) =>
            dispatch({ type: "name", value: event.target.value })
          }
          placeholder="e.g. Qr Hub Menu"
          autoComplete="off"
          aria-required="true"
          aria-invalid={state.errors.name ? true : undefined}
          aria-describedby={state.errors.name ? nameErrorId : undefined}
          className="h-11"
        />
        {state.errors.name ? (
          <p id={nameErrorId} role="alert" className="text-sm text-destructive">
            {state.errors.name}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label htmlFor={`${ids}-domain`} className="text-sm font-medium">
          Website (optional)
        </label>
        <Input
          id={`${ids}-domain`}
          ref={domainRef}
          value={state.domain}
          onChange={(event) =>
            dispatch({ type: "domain", value: event.target.value })
          }
          placeholder="example.com"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={state.errors.domain ? true : undefined}
          aria-describedby={
            state.errors.domain
              ? `${domainErrorId} ${domainHelpId}`
              : domainHelpId
          }
          className="h-11"
        />
        <p id={domainHelpId} className="text-xs text-muted-foreground">
          We only read it, we never change your site.
        </p>
        {state.errors.domain ? (
          <p
            id={domainErrorId}
            role="alert"
            className="text-sm text-destructive"
          >
            {state.errors.domain}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <div className="flex min-h-11 items-center justify-between gap-3">
          <p id={marketLabelId} className="text-sm">
            <span className="font-medium">Customers in </span>
            <span>
              {primary ? countryLabel(primary) : "—"}
              {" · "}
              {state.language ? languageLabel(state.language) : "—"}
            </span>
          </p>
          <Button
            type="button"
            variant="ghost"
            aria-expanded={marketOpen}
            aria-controls={marketPanelId}
            onClick={() => setChanging((open) => !open)}
            className="min-h-11 px-3"
          >
            Change
          </Button>
        </div>
        {sourceNote ? (
          <p id={marketProvenanceId} className="text-xs text-muted-foreground">
            {sourceNote}
          </p>
        ) : null}
        {fallbackNote ? (
          <p className="text-xs text-muted-foreground">{fallbackNote}</p>
        ) : null}
        {state.errors.country ? (
          <p
            id={marketErrorId}
            role="alert"
            className="text-sm text-destructive"
          >
            {state.errors.country}
          </p>
        ) : null}
        {state.errors.language ? (
          <p role="alert" className="text-sm text-destructive">
            {state.errors.language}
          </p>
        ) : null}
        {marketOpen ? (
          <div id={marketPanelId} className="space-y-4">
            <div
              ref={marketRef}
              role="group"
              tabIndex={-1}
              aria-labelledby={marketLabelId}
              aria-describedby={
                state.errors.country ? marketErrorId : undefined
              }
              className="flex flex-wrap gap-2 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {chipCodes.map((code) => (
                <Chip
                  key={code}
                  selected={primary === code}
                  onClick={() => dispatch({ type: "tapMarket", code })}
                >
                  {countryLabel(code)}
                </Chip>
              ))}
              <Chip
                selected={showMore}
                aria-expanded={showMore}
                aria-controls={moreId}
                onClick={() => setShowMore((open) => !open)}
              >
                More markets…
              </Chip>
            </div>
            {showMore ? (
              <div id={moreId} className="space-y-2">
                <MarketMultiSelect
                  value={state.countries}
                  onChange={(codes) =>
                    dispatch({
                      type: "setMarkets",
                      codes: codes.filter(isSupportedCountry),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  The first market is the main one.
                </p>
              </div>
            ) : null}
            <div
              ref={languageRef}
              role="group"
              tabIndex={-1}
              aria-label="Content language"
              className="flex flex-wrap gap-2 outline-none"
            >
              {SUPPORTED_LANGUAGES.map((language) => (
                <Chip
                  key={language.code}
                  selected={state.language === language.code}
                  onClick={() =>
                    dispatch({ type: "setLanguage", code: language.code })
                  }
                >
                  {language.label}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      ) : null}

      <div className="space-y-2">
        {intake.note ? (
          <p id={noteId} className="text-xs text-muted-foreground">
            {intake.note}
          </p>
        ) : null}
        <div className="flex justify-end">
          {/* Never disabled: a disabled button is skipped by keyboard and screen
            readers and could not show its own error. The note above it is tied
            to it with aria-describedby. */}
          <Button
            type="submit"
            size="lg"
            aria-disabled={pending}
            aria-describedby={intake.note ? noteId : undefined}
            className="h-11 min-w-40 px-4"
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" /> Creating…
              </>
            ) : (
              intake.button
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}

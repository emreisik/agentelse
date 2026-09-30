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
}: {
  initialLocale: LocaleDefault;
}) {
  const [state, dispatch] = useReducer(
    newProjectReducer,
    initialLocale,
    initialNewProjectState,
  );
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<CreateProjectFailure | null>(null);
  const [showBrand, setShowBrand] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [changingLanguage, setChangingLanguage] = useState(false);

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
  const showLanguageRow = state.language !== null || state.errors.language;
  const languageOpen = changingLanguage || Boolean(state.errors.language);

  const nameErrorId = `${ids}-name-error`;
  const domainErrorId = `${ids}-domain-error`;
  const domainHelpId = `${ids}-domain-help`;
  const marketLabelId = `${ids}-market-label`;
  const marketErrorId = `${ids}-market-error`;
  const marketProvenanceId = `${ids}-market-source`;
  const moreId = `${ids}-more`;
  const brandId = `${ids}-brand`;

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
          We read it to suggest ideas when you ask. We never change your site.
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
        <p id={marketLabelId} className="text-sm font-medium">
          Where are your customers?
        </p>
        <div
          ref={marketRef}
          role="group"
          tabIndex={-1}
          aria-labelledby={marketLabelId}
          aria-describedby={
            state.errors.country
              ? marketErrorId
              : state.localeSource
                ? marketProvenanceId
                : undefined
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
        {state.localeSource ? (
          <p id={marketProvenanceId} className="text-xs text-muted-foreground">
            {LOCALE_SOURCE_LABEL[state.localeSource]}
          </p>
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
      </div>

      {showLanguageRow ? (
        <div className="space-y-2">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-medium">Content language: </span>
              <span>
                {state.language ? languageLabel(state.language) : "—"}
              </span>
            </p>
            <Button
              type="button"
              variant="ghost"
              aria-expanded={languageOpen}
              onClick={() => setChangingLanguage((open) => !open)}
              className="min-h-11 px-3"
            >
              Change
            </Button>
          </div>
          {fallbackNote ? (
            <p className="text-xs text-muted-foreground">{fallbackNote}</p>
          ) : null}
          {languageOpen ? (
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
          ) : null}
          {state.errors.language ? (
            <p role="alert" className="text-sm text-destructive">
              {state.errors.language}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={showBrand}
          aria-controls={brandId}
          onClick={() => setShowBrand((open) => !open)}
          className="min-h-11 px-3"
        >
          Different brand name?
        </Button>
        {showBrand ? (
          <div id={brandId} className="space-y-2">
            <label
              htmlFor={`${ids}-brand-name`}
              className="text-sm font-medium"
            >
              Brand name (if different from the project)
            </label>
            <Input
              id={`${ids}-brand-name`}
              value={state.brandName}
              onChange={(event) =>
                dispatch({ type: "brandName", value: event.target.value })
              }
              autoComplete="off"
              className="h-11"
            />
          </div>
        ) : null}
      </div>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
        </p>
      ) : null}

      <div className="flex justify-end">
        {/* Never disabled: a disabled button is skipped by keyboard and screen
            readers and could not show its own error. */}
        <Button
          type="submit"
          size="lg"
          aria-disabled={pending}
          className="h-11 min-w-40 px-4"
        >
          {pending ? (
            <>
              <Loader2 className="animate-spin" /> Creating…
            </>
          ) : (
            "Create and continue"
          )}
        </Button>
      </div>
    </form>
  );
}

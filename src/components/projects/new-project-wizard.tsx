"use client";

import { useState, useTransition } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronsUpDown,
  Globe,
  Languages,
  Loader2,
  Pencil,
  Rocket,
  Sparkles,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormDescription,
  FormMessage,
} from "@/components/ui/form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_COUNTRIES,
  COUNTRY_CONTINENTS,
  languageLabel,
  countryLabel,
} from "@/lib/locales";
import { createProjectAction } from "@/server/actions/project-actions";

const DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalizeDomain(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "");
}

const schema = z.object({
  name: z
    .string()
    .max(120, "En fazla 120 karakter")
    .refine((value) => value.trim().length > 0, "Proje adı gerekli"),
  domain: z
    .string()
    .optional()
    .refine((value) => !value || DOMAIN_PATTERN.test(normalizeDomain(value)), {
      message: "Geçerli bir web adresi girin (örn: ornek.com)",
    }),
  brandName: z.string().max(120, "En fazla 120 karakter").optional(),
  language: z
    .string()
    .refine(
      (value) => SUPPORTED_LANGUAGES.some((lang) => lang.code === value),
      "Bir dil seçin",
    ),
  country: z
    .array(z.string())
    .min(1, "En az bir pazar seçin")
    .refine(
      (codes) =>
        codes.every((code) => SUPPORTED_COUNTRIES.some((c) => c.code === code)),
      "Geçersiz pazar seçimi",
    ),
});

type FormValues = z.infer<typeof schema>;
type StepId = "name" | "brand" | "locale" | "review";

const STEPS: { id: StepId; title: string }[] = [
  { id: "name", title: "Proje" },
  { id: "brand", title: "Marka" },
  { id: "locale", title: "Dil & Pazar" },
  { id: "review", title: "Onay" },
];

const STEP_FIELDS: Record<StepId, (keyof FormValues)[]> = {
  name: ["name"],
  brand: ["domain"],
  locale: ["language", "country"],
  review: [],
};

export function NewProjectWizard() {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      domain: "",
      brandName: "",
      language: "tr",
      // Kasıtlı olarak boş: sabit bir varsayılan ("TR") burada olsaydı,
      // kullanıcı yeni pazarlar EKLEDİĞİNDE (ki toggleCountry/toggleContinent
      // sadece ekler/çıkarır, asla sıfırlamaz) o sessiz varsayılan dizinin
      // başında kalır ve handleCreate() her zaman onu "birincil" sanıp
      // gönderirdi — kullanıcının gerçekte seçtiği pazarlar hiç kaydedilmez.
      country: [],
    },
  });

  // stepIndex is only ever set to a value within [0, STEPS.length - 1) via
  // goTo()/handleContinue(), so this index access always hits.
  const step = STEPS[stepIndex]!;
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === STEPS.length - 1;

  function goTo(index: number) {
    setDirection(index > stepIndex ? 1 : -1);
    setStepIndex(index);
  }

  function handleCreate() {
    const values = form.getValues();
    setSubmitError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("name", values.name.trim());
      formData.set(
        "domain",
        values.domain ? normalizeDomain(values.domain) : "",
      );
      formData.set("brandName", values.brandName?.trim() ?? "");
      formData.set("language", values.language);
      // Her seçili pazar ayrı bir "country" girişi olarak eklenir (ilki
      // birincil pazar) — server formData.getAll("country") ile hepsini okur.
      for (const code of values.country) formData.append("country", code);
      await createProjectAction(formData);
      setSubmitError("Proje oluşturulamadı. Lütfen tekrar deneyin.");
    });
  }

  async function handleContinue() {
    const fields = STEP_FIELDS[step.id];
    if (fields.length) {
      const valid = await form.trigger(fields, { shouldFocus: true });
      if (!valid) return;
    }
    if (isLastStep) {
      handleCreate();
      return;
    }
    goTo(stepIndex + 1);
  }

  return (
    <div className="w-full max-w-xl">
      <ol className="mb-8 flex items-center justify-center">
        {STEPS.map((s, index) => {
          const state =
            index < stepIndex
              ? "done"
              : index === stepIndex
                ? "current"
                : "upcoming";
          return (
            <li key={s.id} className="flex items-center">
              <button
                type="button"
                onClick={() => index < stepIndex && goTo(index)}
                disabled={index > stepIndex || pending}
                className={cn(
                  "flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-xs font-medium transition-colors",
                  state === "current" && "text-primary",
                  state === "done" &&
                    "cursor-pointer text-foreground hover:opacity-80",
                  state === "upcoming" &&
                    "cursor-default text-muted-foreground/50",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors",
                    state === "done" &&
                      "border-primary bg-primary text-primary-foreground",
                    state === "current" && "border-primary text-primary",
                    state === "upcoming" &&
                      "border-border text-muted-foreground/50",
                  )}
                >
                  {state === "done" ? (
                    <Check className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="hidden sm:inline">{s.title}</span>
              </button>
              {index < STEPS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px w-6 shrink-0 sm:w-10",
                    index < stepIndex ? "bg-primary" : "bg-border",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/10">
        <Form {...form}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleContinue();
            }}
          >
            <div
              key={step.id}
              className={cn(
                "flex min-h-[300px] flex-col justify-center p-8 sm:p-10",
                direction === 1
                  ? "animate-in fade-in slide-in-from-right-3 duration-300"
                  : "animate-in fade-in slide-in-from-left-3 duration-300",
              )}
            >
              {step.id === "name" ? <NameStep form={form} /> : null}
              {step.id === "brand" ? <BrandStep form={form} /> : null}
              {step.id === "locale" ? <LocaleStep form={form} /> : null}
              {step.id === "review" ? (
                <ReviewStep form={form} onEdit={goTo} />
              ) : null}
            </div>

            {submitError ? (
              <p className="px-8 pb-4 text-sm text-destructive sm:px-10">
                {submitError}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-8 py-5 sm:px-10">
              <Button
                type="button"
                variant="ghost"
                onClick={() => goTo(stepIndex - 1)}
                disabled={pending}
                className={cn(isFirstStep && "invisible")}
              >
                <ArrowLeft /> Geri
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={pending}
                className="h-11 min-w-40 px-4"
              >
                {pending ? (
                  <>
                    <Loader2 className="animate-spin" /> Oluşturuluyor…
                  </>
                ) : isLastStep ? (
                  <>
                    <Rocket /> Oluştur ve Kuruluma Başla
                  </>
                ) : (
                  <>
                    Devam Et <ArrowRight />
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}

function StepHeading({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6 text-center">
      <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        {icon}
      </div>
      <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
        {title}
      </h1>
      <p className="mt-1.5 text-sm text-balance text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function NameStep({ form }: { form: UseFormReturn<FormValues> }) {
  return (
    <div>
      <StepHeading
        icon={<Sparkles className="size-5" />}
        title="Yeni projene bir isim ver"
        description="Bu isim, marka için oluşturacağımız çalışma alanının başlığı olacak."
      />
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem className="mx-auto w-full max-w-sm">
            <FormLabel className="sr-only">Proje / Marka Adı</FormLabel>
            <FormControl>
              <Input
                {...field}
                autoFocus
                placeholder="Örn: Biduniq"
                className="h-12 text-center text-base sm:text-lg"
              />
            </FormControl>
            <FormMessage className="text-center" />
          </FormItem>
        )}
      />
    </div>
  );
}

function BrandStep({ form }: { form: UseFormReturn<FormValues> }) {
  return (
    <div>
      <StepHeading
        icon={<Globe className="size-5" />}
        title="Markanı tanıyalım"
        description="Web siteni verirsen markanı otomatik analiz etmeyi deneriz. İkisi de opsiyonel."
      />
      <div className="mx-auto w-full max-w-sm space-y-4">
        <FormField
          control={form.control}
          name="domain"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Web sitesi</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  autoFocus
                  placeholder="ornek.com"
                  className="h-11"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="brandName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Marka adı (proje adından farklıysa)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="Boş bırakabilirsin"
                  className="h-11"
                />
              </FormControl>
              <FormDescription>
                Boş bırakırsan proje adı marka adı olarak kullanılır.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

function ComboboxField({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { code: string; label: string }[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full justify-between font-normal"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-64 p-0">
        <Command>
          <CommandInput placeholder="Ara…" />
          <CommandList>
            <CommandEmpty>Sonuç bulunamadı.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.code}
                  value={option.label}
                  data-checked={option.code === value}
                  onSelect={() => {
                    onChange(option.code);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function summarizeMarketSelection(codes: string[]): string {
  const labels = codes.map((code) => countryLabel(code));
  if (labels.length === 0) return "Pazar seç";
  if (labels.length === 1) return labels[0] ?? "Pazar seç";
  if (labels.length === 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function MarketMultiSelect({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggleCountry(code: string) {
    onChange(
      value.includes(code) ? value.filter((c) => c !== code) : [...value, code],
    );
  }

  function toggleContinent(continent: (typeof COUNTRY_CONTINENTS)[number]) {
    const fullySelected = continent.countryCodes.every((code) =>
      value.includes(code),
    );
    onChange(
      fullySelected
        ? value.filter(
            (code) => !continent.countryCodes.some((c) => c === code),
          )
        : Array.from(new Set([...value, ...continent.countryCodes])),
    );
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full justify-between font-normal"
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {summarizeMarketSelection(value)}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-(--anchor-width) min-w-64 p-0"
        >
          <Command>
            <CommandInput placeholder="Ara…" />
            <CommandList>
              <CommandEmpty>Sonuç bulunamadı.</CommandEmpty>
              <CommandGroup heading="Kıtalar">
                {COUNTRY_CONTINENTS.map((continent) => (
                  <CommandItem
                    key={continent.id}
                    value={continent.label}
                    data-checked={continent.countryCodes.every((code) =>
                      value.includes(code),
                    )}
                    onSelect={() => toggleContinent(continent)}
                  >
                    {continent.label}
                    <CommandShortcut>
                      {continent.countryCodes.length} ülke
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Ülkeler">
                {SUPPORTED_COUNTRIES.map((option) => (
                  <CommandItem
                    key={option.code}
                    value={option.label}
                    data-checked={value.includes(option.code)}
                    onSelect={() => toggleCountry(option.code)}
                  >
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
          {value.map((code, index) => (
            <span
              key={code}
              className={cn(
                "flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs font-medium",
                index === 0
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {countryLabel(code)}
              {index === 0 ? (
                <span className="text-[10px] opacity-70">· birincil</span>
              ) : null}
              <button
                type="button"
                onClick={() => toggleCountry(code)}
                className="flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-foreground/10"
                aria-label={`${countryLabel(code)} kaldır`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LocaleStep({ form }: { form: UseFormReturn<FormValues> }) {
  return (
    <div>
      <StepHeading
        icon={<Languages className="size-5" />}
        title="Dil ve pazarını seç"
        description="Tüm AI araştırmaları ve içerik üretimi bu dilde ve bu pazarlara odaklı yapılır."
      />
      <div className="mx-auto w-full max-w-sm space-y-5">
        <FormField
          control={form.control}
          name="language"
          render={({ field, fieldState }) => (
            <div className="space-y-2">
              <span className="text-sm font-medium leading-none">
                Araştırma dili
              </span>
              <ComboboxField
                value={field.value}
                onChange={field.onChange}
                options={SUPPORTED_LANGUAGES.map((l) => ({
                  code: l.code,
                  label: l.label,
                }))}
                placeholder="Dil seç"
              />
              {fieldState.error ? (
                <p className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              ) : null}
            </div>
          )}
        />
        <FormField
          control={form.control}
          name="country"
          render={({ field, fieldState }) => (
            <div className="space-y-2">
              <span className="text-sm font-medium leading-none">
                Hedef pazar(lar)
              </span>
              <MarketMultiSelect
                value={field.value}
                onChange={field.onChange}
              />
              <p className="text-xs text-muted-foreground">
                Birden fazla pazar seçebilir, kıta kısayollarını
                kullanabilirsin. İlk seçtiğin pazar birincil olur — AI
                araştırmaları ona odaklanır, diğerleri de projene kaydedilir.
              </p>
              {fieldState.error ? (
                <p className="text-sm text-destructive">
                  {fieldState.error.message}
                </p>
              ) : null}
            </div>
          )}
        />
      </div>
    </div>
  );
}

function ReviewStep({
  form,
  onEdit,
}: {
  form: UseFormReturn<FormValues>;
  onEdit: (index: number) => void;
}) {
  const values = form.watch();
  const rows: { label: string; value: string; stepIndex: number }[] = [
    {
      label: "Proje / Marka Adı",
      value: values.name.trim() || "—",
      stepIndex: 0,
    },
    {
      label: "Web Sitesi",
      value: values.domain ? normalizeDomain(values.domain) : "Belirtilmedi",
      stepIndex: 1,
    },
    {
      label: "Marka Adı",
      value: values.brandName?.trim() || values.name.trim() || "—",
      stepIndex: 1,
    },
    {
      label: "Araştırma Dili",
      value: languageLabel(values.language),
      stepIndex: 2,
    },
    {
      label: "Hedef Pazar(lar)",
      value: values.country
        .map(
          (code, index) =>
            countryLabel(code) + (index === 0 ? " (birincil)" : ""),
        )
        .join(", "),
      stepIndex: 2,
    },
  ];

  return (
    <div>
      <StepHeading
        icon={<Rocket className="size-5" />}
        title="Her şey hazır"
        description="Onayladığında projeyi oluşturup 12 aşamalı Ajans Kurulumu'nu başlatacağız."
      />
      <dl className="mx-auto w-full max-w-sm divide-y divide-border/60 overflow-hidden rounded-xl ring-1 ring-foreground/10">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-2.5"
          >
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="truncate text-sm font-medium">{row.value}</dd>
            </div>
            <button
              type="button"
              onClick={() => onEdit(row.stepIndex)}
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Pencil className="size-3" /> Düzenle
            </button>
          </div>
        ))}
      </dl>
      {values.country.length > 1 ? (
        <p className="mx-auto mt-3 w-full max-w-sm text-center text-xs text-muted-foreground">
          AI araştırmaları birincil pazara odaklanır; diğer pazarlar da projene
          kaydedilir.
        </p>
      ) : null}
    </div>
  );
}

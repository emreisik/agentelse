"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Info,
  Loader2,
  Pencil,
  Rocket,
  Target,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { countryLabel } from "@/lib/locales";
import { GENDER_OPTIONS, META_LOCALES } from "@/lib/meta-ad-targeting-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WizardSteps } from "@/components/shared/wizard-steps";
import { GeoTargetSelect } from "@/components/ads/geo-target-select";
import { CitySearchCommand } from "@/components/ads/city-search-command";
import { GenderToggle } from "@/components/ads/gender-toggle";
import { LocaleMultiSelect } from "@/components/ads/locale-multi-select";
import { createMetaAdSetWithAdAction } from "@/server/actions/meta-ads-actions";

const BILLING_EVENTS = ["IMPRESSIONS", "LINK_CLICKS"] as const;
const OPTIMIZATION_GOALS = [
  "LINK_CLICKS",
  "IMPRESSIONS",
  "REACH",
  "LANDING_PAGE_VIEWS",
  "POST_ENGAGEMENT",
] as const;
const CALL_TO_ACTIONS = [
  "LEARN_MORE",
  "SHOP_NOW",
  "SIGN_UP",
  "DOWNLOAD",
  "CONTACT_US",
  "GET_OFFER",
] as const;
const CTA_LABEL: Record<(typeof CALL_TO_ACTIONS)[number], string> = {
  LEARN_MORE: "Learn More",
  SHOP_NOW: "Shop Now",
  SIGN_UP: "Sign Up",
  DOWNLOAD: "Download",
  CONTACT_US: "Contact Us",
  GET_OFFER: "Get Offer",
};

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const schema = z
  .object({
    name: z
      .string()
      .max(120, "120 characters max")
      .refine((v) => v.trim().length > 0, "Ad set name is required"),
    dailyBudget: z
      .string()
      .refine((v) => Number(v) > 0, "Enter a daily budget greater than 0"),
    billingEvent: z.enum(BILLING_EVENTS),
    optimizationGoal: z.enum(OPTIMIZATION_GOALS),
    countries: z.array(z.string()).min(1, "Select at least one country"),
    cities: z.array(z.object({ key: z.string(), name: z.string() })),
    ageMin: z.string().refine((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 13 && n <= 65;
    }, "Enter an age between 13 and 65"),
    ageMax: z.string().refine((v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 13 && n <= 65;
    }, "Enter an age between 13 and 65"),
    gender: z.string(),
    locales: z.array(z.number()),
    adName: z
      .string()
      .max(120, "120 characters max")
      .refine((v) => v.trim().length > 0, "Ad name is required"),
    message: z
      .string()
      .max(500, "500 characters max")
      .refine((v) => v.trim().length > 0, "Primary text is required"),
    link: z.string().refine((v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    }, "Enter a valid URL"),
    callToActionType: z.enum(CALL_TO_ACTIONS),
  })
  .refine((v) => Number(v.ageMin) <= Number(v.ageMax), {
    message: "Min age must be less than or equal to max age",
    path: ["ageMax"],
  });

type FormValues = z.infer<typeof schema>;
type StepId = "budget" | "targeting" | "content" | "review";

const STEPS: { id: StepId; title: string }[] = [
  { id: "budget", title: "Budget" },
  { id: "targeting", title: "Targeting" },
  { id: "content", title: "Ad" },
  { id: "review", title: "Review" },
];

const STEP_FIELDS: Record<StepId, (keyof FormValues)[]> = {
  budget: ["name", "dailyBudget", "billingEvent", "optimizationGoal"],
  targeting: ["countries", "ageMin", "ageMax"],
  content: ["adName", "message", "link", "callToActionType"],
  review: [],
};

function validateImage(file: File | null): string | null {
  if (!file) return "An image is required";
  if (!ALLOWED_IMAGE_TYPES.includes(file.type))
    return "Image must be JPEG, PNG or WebP";
  if (file.size > MAX_IMAGE_BYTES) return "Image must be 8MB or smaller";
  return null;
}

// Combined "ad set + ad" wizard — mirrors Meta Ads Manager's single "New ad
// set or ad" screen (targeting + budget + one ad's creative, all in one
// flow) while preserving this app's existing two-Task/two-Approval
// architecture underneath: submit calls createMetaAdSetWithAdAction, which
// plans only ONE Task (the ad set) with the ad's data embedded as
// `pendingAd`. MetaAdSetChainRelay plans the second Task automatically once
// the ad set Task completes (see meta-adset-chain-relay.ts) — the review
// step below tells the user this explicitly so the single form doesn't
// read as producing only one approval.
export function AdSetAdWizard({
  projectId,
  campaignId,
  closeHref,
}: {
  projectId: string;
  campaignId: string;
  closeHref: string;
}) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const imagePreviewUrl = useMemo(
    () => (image ? URL.createObjectURL(image) : null),
    [image],
  );
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      dailyBudget: "",
      billingEvent: "IMPRESSIONS",
      optimizationGoal: "LINK_CLICKS",
      countries: [],
      cities: [],
      ageMin: "18",
      ageMax: "65",
      gender: "",
      locales: [],
      adName: "",
      message: "",
      link: "",
      callToActionType: "LEARN_MORE",
    },
  });

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
      formData.set("projectId", projectId);
      formData.set("campaignId", campaignId);
      formData.set("name", values.name.trim());
      formData.set("dailyBudget", values.dailyBudget);
      formData.set("billingEvent", values.billingEvent);
      formData.set("optimizationGoal", values.optimizationGoal);
      values.countries.forEach((c) => formData.append("countries", c));
      if (values.cities.length) {
        formData.set("cities", JSON.stringify(values.cities));
      }
      formData.set("ageMin", values.ageMin);
      formData.set("ageMax", values.ageMax);
      if (values.gender) formData.set("gender", values.gender);
      values.locales.forEach((id) => formData.append("locales", String(id)));
      formData.set("adName", values.adName.trim());
      formData.set("message", values.message.trim());
      formData.set("link", values.link.trim());
      formData.set("callToActionType", values.callToActionType);
      if (image) formData.set("image", image);

      const result = await createMetaAdSetWithAdAction(formData);
      if (result.ok) {
        toast.success("Ad set + ad submitted for approval");
        router.push(closeHref);
        router.refresh();
      } else {
        setSubmitError(result.message);
      }
    });
  }

  async function handleContinue() {
    const fields = STEP_FIELDS[step.id];
    if (fields.length) {
      const valid = await form.trigger(fields, { shouldFocus: true });
      if (!valid) return;
    }
    if (step.id === "content") {
      const err = validateImage(image);
      setImageError(err);
      if (err) return;
    }
    if (isLastStep) {
      handleCreate();
      return;
    }
    goTo(stepIndex + 1);
  }

  return (
    <div className="w-full">
      <WizardSteps
        steps={STEPS}
        currentIndex={stepIndex}
        onStepClick={goTo}
        disabled={pending}
      />
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
              "min-h-[320px]",
              direction === 1
                ? "animate-in fade-in slide-in-from-right-3 duration-300"
                : "animate-in fade-in slide-in-from-left-3 duration-300",
            )}
          >
            {step.id === "budget" ? <BudgetStep form={form} /> : null}
            {step.id === "targeting" ? (
              <TargetingStep form={form} projectId={projectId} />
            ) : null}
            {step.id === "content" ? (
              <ContentStep
                form={form}
                image={image}
                onImageChange={setImage}
                imagePreviewUrl={imagePreviewUrl}
                imageError={imageError}
              />
            ) : null}
            {step.id === "review" ? (
              <ReviewStep
                form={form}
                imagePreviewUrl={imagePreviewUrl}
                onEdit={goTo}
              />
            ) : null}
          </div>

          {submitError ? (
            <p className="mt-3 text-sm text-destructive">{submitError}</p>
          ) : null}

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => goTo(stepIndex - 1)}
              disabled={pending}
              className={cn(isFirstStep && "invisible")}
            >
              <ArrowLeft /> Back
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="animate-spin" /> Submitting…
                </>
              ) : isLastStep ? (
                <>
                  <Rocket /> Create Ad Set + Ad
                </>
              ) : (
                <>
                  Continue <ArrowRight />
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

function BudgetStep({ form }: { form: UseFormReturn<FormValues> }) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Ad set name</FormLabel>
            <FormControl>
              <Input {...field} autoFocus placeholder="US — 25-45, traffic" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="dailyBudget"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Daily budget</FormLabel>
            <FormControl>
              <Input
                {...field}
                type="number"
                min="1"
                step="0.01"
                placeholder="10.00"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="billingEvent"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Billing event</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {BILLING_EVENTS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="optimizationGoal"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Optimization goal</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {OPTIMIZATION_GOALS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}

function TargetingStep({
  form,
  projectId,
}: {
  form: UseFormReturn<FormValues>;
  projectId: string;
}) {
  return (
    <div className="space-y-4">
      <div className="mb-1 flex items-center gap-2 text-muted-foreground">
        <Target className="size-4" />
        <p className="text-xs">Who should see this ad set&apos;s ads?</p>
      </div>
      <FormField
        control={form.control}
        name="countries"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Countries</FormLabel>
            <FormControl>
              <GeoTargetSelect value={field.value} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="cities"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Cities{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </FormLabel>
            <FormControl>
              <CitySearchCommand
                projectId={projectId}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormField
          control={form.control}
          name="ageMin"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Min age</FormLabel>
              <FormControl>
                <Input {...field} type="number" min="13" max="65" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="ageMax"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Max age</FormLabel>
              <FormControl>
                <Input {...field} type="number" min="13" max="65" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <FormField
        control={form.control}
        name="gender"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Gender</FormLabel>
            <FormControl>
              <GenderToggle value={field.value} onChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="locales"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Languages{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </FormLabel>
            <FormControl>
              <LocaleMultiSelect
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}

function ContentStep({
  form,
  image,
  onImageChange,
  imagePreviewUrl,
  imageError,
}: {
  form: UseFormReturn<FormValues>;
  image: File | null;
  onImageChange: (file: File | null) => void;
  imagePreviewUrl: string | null;
  imageError: string | null;
}) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="adName"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Ad name</FormLabel>
            <FormControl>
              <Input {...field} autoFocus placeholder="Ad — variant A" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="message"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Primary text</FormLabel>
            <FormControl>
              <Textarea
                {...field}
                rows={3}
                placeholder="Discover the new collection"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="link"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Destination link</FormLabel>
            <FormControl>
              <Input
                {...field}
                type="url"
                placeholder="https://example.com/sale"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="callToActionType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Call to action</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {CALL_TO_ACTIONS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {CTA_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Image</label>
        <div className="flex items-center gap-3">
          {imagePreviewUrl ? (
            // Local blob: preview of a not-yet-uploaded File — next/image
            // can't optimize a client-only object URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imagePreviewUrl}
              alt=""
              className="size-16 shrink-0 rounded-lg object-cover ring-1 ring-foreground/10"
            />
          ) : (
            <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ImagePlus className="size-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) =>
                onImageChange(event.target.files?.[0] ?? null)
              }
              className="w-full text-xs"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {image ? image.name : "JPEG, PNG or WebP — max 8MB."}
            </p>
          </div>
        </div>
        {imageError ? (
          <p className="text-sm text-destructive">{imageError}</p>
        ) : null}
      </div>
    </div>
  );
}

function ReviewStep({
  form,
  imagePreviewUrl,
  onEdit,
}: {
  form: UseFormReturn<FormValues>;
  imagePreviewUrl: string | null;
  onEdit: (index: number) => void;
}) {
  const values = form.watch();
  const genderLabel =
    GENDER_OPTIONS.find((g) => g.value === values.gender)?.label ?? "All";
  const localeLabels = values.locales
    .map((id) => META_LOCALES.find((l) => l.id === id)?.label ?? String(id))
    .join(", ");

  const rows: { label: string; value: string; stepIndex: number }[] = [
    { label: "Ad set name", value: values.name.trim() || "—", stepIndex: 0 },
    {
      label: "Daily budget",
      value: values.dailyBudget ? `${values.dailyBudget} / day` : "—",
      stepIndex: 0,
    },
    {
      label: "Billing / Optimization",
      value: `${values.billingEvent} / ${values.optimizationGoal}`,
      stepIndex: 0,
    },
    {
      label: "Countries",
      value: values.countries.map(countryLabel).join(", ") || "—",
      stepIndex: 1,
    },
    ...(values.cities.length
      ? [
          {
            label: "Cities",
            value: values.cities.map((c) => c.name).join(", "),
            stepIndex: 1,
          },
        ]
      : []),
    {
      label: "Age range",
      value: `${values.ageMin}–${values.ageMax}`,
      stepIndex: 1,
    },
    { label: "Gender", value: genderLabel, stepIndex: 1 },
    ...(localeLabels
      ? [{ label: "Languages", value: localeLabels, stepIndex: 1 }]
      : []),
    { label: "Ad name", value: values.adName.trim() || "—", stepIndex: 2 },
    {
      label: "Destination link",
      value: values.link.trim() || "—",
      stepIndex: 2,
    },
    {
      label: "Call to action",
      value: CTA_LABEL[values.callToActionType],
      stepIndex: 2,
    },
    { label: "Status", value: "Paused (draft)", stepIndex: 2 },
  ];

  return (
    <div>
      <div className="mb-4 text-center">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Review your ad set + ad
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This creates a draft ad set and ad — both require approval before they
          go live on Meta.
        </p>
      </div>
      <div className="mb-4 flex items-start gap-3 rounded-xl bg-muted/30 p-3 ring-1 ring-foreground/10">
        {imagePreviewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imagePreviewUrl}
            alt=""
            className="size-14 shrink-0 rounded-lg object-cover"
          />
        ) : null}
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {values.message.trim() || "—"}
        </p>
      </div>
      <dl className="divide-y divide-border/60 overflow-hidden rounded-xl ring-1 ring-foreground/10">
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
              <Pencil className="size-3" /> Edit
            </button>
          </div>
        ))}
      </dl>
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-primary/5 p-3 text-xs text-muted-foreground ring-1 ring-primary/20">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
        Approving the ad set opens a second, separate approval for the ad
        automatically, once Meta confirms the ad set was created.
      </p>
    </div>
  );
}

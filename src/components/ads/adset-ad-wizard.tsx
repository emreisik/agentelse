"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  GalleryHorizontal,
  ImagePlus,
  Info,
  Loader2,
  Pencil,
  Rocket,
  Target,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { countryLabel } from "@/lib/locales";
import { GENDER_OPTIONS } from "@/lib/meta-ad-targeting-data";
import { useObjectUrl, useObjectUrls } from "@/lib/use-object-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-time-picker";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { WizardSteps } from "@/components/shared/wizard-steps";
import { GeoTargetSelect } from "@/components/ads/geo-target-select";
import { CitySearchCommand } from "@/components/ads/city-search-command";
import { GenderToggle } from "@/components/ads/gender-toggle";
import { LocaleSearchCommand } from "@/components/ads/locale-search-command";
import { CarouselCardEditor } from "@/components/ads/carousel-card-editor";
import { VideoUploadField } from "@/components/ads/video-upload-field";
import {
  AdPreviewCard,
  type AdPreviewMedia,
} from "@/components/ads/ad-preview-card";
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
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MIN_CARDS = 2;
const MAX_CARDS = 10;

const urlField = z.string().refine((v) => {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}, "Enter a valid URL");

const adNameField = z
  .string()
  .max(120, "120 characters max")
  .refine((v) => v.trim().length > 0, "Ad name is required");
const messageField = z
  .string()
  .max(500, "500 characters max")
  .refine((v) => v.trim().length > 0, "Primary text is required");
const callToActionField = z.enum(CALL_TO_ACTIONS);

const adSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("SINGLE_IMAGE"),
    adName: adNameField,
    callToActionType: callToActionField,
    message: messageField,
    link: urlField,
  }),
  z.object({
    format: z.literal("CAROUSEL"),
    adName: adNameField,
    callToActionType: callToActionField,
    message: messageField,
    cards: z
      .array(
        z.object({
          link: urlField,
          name: z
            .string()
            .max(80, "80 characters max")
            .refine((v) => v.trim().length > 0, "Card headline is required"),
          description: z.string().max(200, "200 characters max").optional(),
        }),
      )
      .min(MIN_CARDS, `At least ${MIN_CARDS} cards are required`)
      .max(MAX_CARDS, `At most ${MAX_CARDS} cards allowed`),
  }),
  z.object({
    format: z.literal("VIDEO"),
    adName: adNameField,
    callToActionType: callToActionField,
    message: messageField,
    link: urlField,
  }),
]);

const schema = z
  .object({
    name: z
      .string()
      .max(120, "120 characters max")
      .refine((v) => v.trim().length > 0, "Ad set name is required"),
    dailyBudget: z
      .string()
      .refine((v) => Number(v) > 0, "Enter a daily budget greater than 0"),
    // Zorunlu bitiş: ad set Meta tarafında bu gün biter, sunucumuz düşse de
    // harcama süresiz devam etmez (docs/meta-ads-plan.md F0b).
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the day the ads should stop"),
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
    locales: z.array(
      z.object({ id: z.number(), label: z.string().optional() }),
    ),
    ad: adSchema,
  })
  .refine((v) => Number(v.ageMin) <= Number(v.ageMax), {
    message: "Min age must be less than or equal to max age",
    path: ["ageMax"],
  });

export type FormValues = z.infer<typeof schema>;
type StepId = "budget" | "targeting" | "format" | "content" | "review";

const STEPS: { id: StepId; title: string }[] = [
  { id: "budget", title: "Budget" },
  { id: "targeting", title: "Targeting" },
  { id: "format", title: "Format" },
  { id: "content", title: "Ad" },
  { id: "review", title: "Review" },
];

const STEP_FIELDS: Record<StepId, (keyof FormValues)[]> = {
  budget: [
    "name",
    "dailyBudget",
    "endDate",
    "billingEvent",
    "optimizationGoal",
  ],
  targeting: ["countries", "ageMin", "ageMax"],
  format: [],
  // Triggering the top-level "ad" key validates its whole nested subtree
  // (whichever branch of the discriminated union is currently selected) —
  // simpler and more robust than enumerating per-format dot-paths here.
  content: ["ad"],
  review: [],
};

function validateImage(file: File | null): string | null {
  if (!file) return "An image is required";
  if (!ALLOWED_IMAGE_TYPES.includes(file.type))
    return "Image must be JPEG, PNG or WebP";
  if (file.size > MAX_IMAGE_BYTES) return "Image must be 8MB or smaller";
  return null;
}

function validateVideo(file: File | null): string | null {
  if (!file) return "A video is required";
  if (!ALLOWED_VIDEO_TYPES.includes(file.type))
    return "Video must be MP4, MOV or WebM";
  if (file.size > MAX_VIDEO_BYTES) return "Video must be 50MB or smaller";
  return null;
}

function defaultAdForFormat(
  format: FormValues["ad"]["format"],
  carry: {
    adName: string;
    callToActionType: (typeof CALL_TO_ACTIONS)[number];
    message: string;
  },
): FormValues["ad"] {
  if (format === "CAROUSEL") {
    return {
      format,
      ...carry,
      cards: [
        { link: "", name: "", description: "" },
        { link: "", name: "", description: "" },
      ],
    };
  }
  return { format, ...carry, link: "" };
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
  pageName,
}: {
  projectId: string;
  campaignId: string;
  closeHref: string;
  pageName: string;
}) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Every creative File lives here, outside react-hook-form — same
  // reasoning throughout this file: a File isn't a zod-validated text
  // field, and keeping it out of the form avoids re-render churn.
  const [image, setImage] = useState<File | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [cardImages, setCardImages] = useState<(File | null)[]>([null, null]);
  const [cardImagesError, setCardImagesError] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  const imagePreviewUrl = useObjectUrl(image);
  const cardPreviewUrls = useObjectUrls(cardImages);
  const thumbnailPreviewUrl = useObjectUrl(thumbnail);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      dailyBudget: "",
      endDate: "",
      billingEvent: "IMPRESSIONS",
      optimizationGoal: "LINK_CLICKS",
      countries: [],
      cities: [],
      ageMin: "18",
      ageMax: "65",
      gender: "",
      locales: [],
      ad: {
        format: "SINGLE_IMAGE",
        adName: "",
        callToActionType: "LEARN_MORE",
        message: "",
        link: "",
      },
    },
  });

  const step = STEPS[stepIndex]!;
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === STEPS.length - 1;
  const ad = form.watch("ad");

  function goTo(index: number) {
    setDirection(index > stepIndex ? 1 : -1);
    setStepIndex(index);
  }

  function handleFormatChange(format: FormValues["ad"]["format"]) {
    const current = form.getValues("ad");
    form.setValue(
      "ad",
      defaultAdForFormat(format, {
        adName: current.adName,
        callToActionType: current.callToActionType,
        message: current.message,
      }),
      { shouldValidate: false },
    );
    // Every creative File is format-specific local state, kept in sync by
    // hand with the form's `ad` field — defaultAdForFormat above always
    // rebuilds CAROUSEL's `cards` as a fresh 2-entry array, so leaving a
    // longer/shorter `cardImages` behind from a PRIOR carousel session
    // permanently desyncs the two arrays' lengths (CarouselCardEditor's
    // add/remove only ever moves them together by ±1, so an existing
    // offset can never close through the UI) and permanently fails the
    // content step's "every card needs an image" check. Resetting all four
    // pieces of creative state on every format switch — not just
    // cardImages — also means switching formats never carries forward an
    // image/video that no longer belongs to the newly selected format.
    setImage(null);
    setImageError(null);
    setCardImages([null, null]);
    setCardImagesError(null);
    setVideo(null);
    setThumbnail(null);
    setVideoError(null);
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
      formData.set("endDate", values.endDate);
      formData.set("billingEvent", values.billingEvent);
      formData.set("optimizationGoal", values.optimizationGoal);
      values.countries.forEach((c) => formData.append("countries", c));
      if (values.cities.length) {
        formData.set("cities", JSON.stringify(values.cities));
      }
      formData.set("ageMin", values.ageMin);
      formData.set("ageMax", values.ageMax);
      if (values.gender) formData.set("gender", values.gender);
      if (values.locales.length) {
        formData.set("locales", JSON.stringify(values.locales));
      }

      formData.set("format", values.ad.format);
      formData.set("adName", values.ad.adName.trim());
      formData.set("callToActionType", values.ad.callToActionType);
      formData.set("message", values.ad.message.trim());

      if (values.ad.format === "SINGLE_IMAGE") {
        formData.set("link", values.ad.link.trim());
        if (image) formData.set("image", image);
      } else if (values.ad.format === "CAROUSEL") {
        formData.set(
          "cards",
          JSON.stringify(
            values.ad.cards.map((c) => ({
              link: c.link.trim(),
              name: c.name.trim(),
              ...(c.description?.trim()
                ? { description: c.description.trim() }
                : {}),
            })),
          ),
        );
        cardImages.forEach((file) => {
          if (file) formData.append("cardImage", file);
        });
      } else if (values.ad.format === "VIDEO") {
        formData.set("link", values.ad.link.trim());
        if (video) formData.set("video", video);
        if (thumbnail) formData.set("thumbnail", thumbnail);
      }

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
      const values = form.getValues();
      let err: string | null = null;
      if (values.ad.format === "SINGLE_IMAGE") {
        err = validateImage(image);
        setImageError(err);
      } else if (values.ad.format === "CAROUSEL") {
        const missing =
          cardImages.length !== values.ad.cards.length
            ? "Every card needs an image"
            : cardImages.some((f) => !f)
              ? "Every card needs an image"
              : cardImages.map(validateImage).find(Boolean) || null;
        err = missing;
        setCardImagesError(err);
      } else if (values.ad.format === "VIDEO") {
        err =
          validateVideo(video) ??
          (() => {
            const thumbErr = validateImage(thumbnail);
            return thumbErr ? `Thumbnail: ${thumbErr}` : null;
          })();
        setVideoError(err);
      }
      if (err) return;
    }
    if (isLastStep) {
      handleCreate();
      return;
    }
    goTo(stepIndex + 1);
  }

  const previewMedia: AdPreviewMedia =
    ad.format === "CAROUSEL"
      ? {
          kind: "carousel",
          cards: ad.cards.map((c, i) => ({
            imageUrl: cardPreviewUrls[i] ?? null,
            name: c.name,
          })),
        }
      : ad.format === "VIDEO"
        ? { kind: "video", thumbnailUrl: thumbnailPreviewUrl }
        : { kind: "single", imageUrl: imagePreviewUrl };

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_320px]">
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
              {step.id === "format" ? (
                <FormatStep value={ad.format} onChange={handleFormatChange} />
              ) : null}
              {step.id === "content" ? (
                <ContentStep
                  form={form}
                  format={ad.format}
                  image={image}
                  onImageChange={setImage}
                  imagePreviewUrl={imagePreviewUrl}
                  imageError={imageError}
                  cardImages={cardImages}
                  onCardImagesChange={setCardImages}
                  cardImagesError={cardImagesError}
                  video={video}
                  onVideoChange={setVideo}
                  thumbnail={thumbnail}
                  onThumbnailChange={setThumbnail}
                  videoError={videoError}
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
      <div className="hidden md:sticky md:top-0 md:block md:self-start">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Preview
        </p>
        <AdPreviewCard
          pageName={pageName}
          message={ad.message}
          link={ad.format !== "CAROUSEL" ? ad.link : ""}
          callToActionLabel={CTA_LABEL[ad.callToActionType]}
          media={previewMedia}
        />
      </div>
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
      <FormField
        control={form.control}
        name="endDate"
        render={({ field }) => (
          <FormItem>
            <FormLabel>End date</FormLabel>
            <FormControl>
              <DatePicker
                value={field.value}
                onChange={field.onChange}
                disablePast
                placeholder="The day the ads stop"
                aria-label="End date"
              />
            </FormControl>
            <p className="text-[11px] text-muted-foreground">
              Meta stops the ad set at the end of this day, even if nobody
              pauses it.
            </p>
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
              <LocaleSearchCommand
                projectId={projectId}
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

const FORMAT_META: Record<
  FormValues["ad"]["format"],
  { icon: typeof ImagePlus; title: string; description: string }
> = {
  SINGLE_IMAGE: {
    icon: ImagePlus,
    title: "Single image",
    description: "One image, one destination link — the classic feed ad.",
  },
  CAROUSEL: {
    icon: GalleryHorizontal,
    title: "Carousel",
    description:
      "2-10 scrollable cards, each with its own image, headline and link.",
  },
  VIDEO: {
    icon: Video,
    title: "Video",
    description: "A video with a cover thumbnail shown before it plays.",
  },
};

function FormatStep({
  value,
  onChange,
}: {
  value: FormValues["ad"]["format"];
  onChange: (format: FormValues["ad"]["format"]) => void;
}) {
  return (
    <div>
      <div className="mb-4 text-center">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Choose an ad format
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This decides what creative you&apos;ll upload next.
        </p>
      </div>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as FormValues["ad"]["format"])}
        className="mx-auto max-w-sm gap-2"
      >
        {(Object.keys(FORMAT_META) as (keyof typeof FORMAT_META)[]).map(
          (format) => {
            const meta = FORMAT_META[format];
            const Icon = meta.icon;
            const isSelected = format === value;
            return (
              <label
                key={format}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition-colors",
                  isSelected
                    ? "bg-primary/5 ring-primary/30"
                    : "ring-foreground/10 hover:bg-muted/50",
                )}
              >
                <RadioGroupItem value={format} />
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {meta.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {meta.description}
                  </span>
                </span>
              </label>
            );
          },
        )}
      </RadioGroup>
    </div>
  );
}

function ContentStep({
  form,
  format,
  image,
  onImageChange,
  imagePreviewUrl,
  imageError,
  cardImages,
  onCardImagesChange,
  cardImagesError,
  video,
  onVideoChange,
  thumbnail,
  onThumbnailChange,
  videoError,
}: {
  form: UseFormReturn<FormValues>;
  format: FormValues["ad"]["format"];
  image: File | null;
  onImageChange: (file: File | null) => void;
  imagePreviewUrl: string | null;
  imageError: string | null;
  cardImages: (File | null)[];
  onCardImagesChange: (images: (File | null)[]) => void;
  cardImagesError: string | null;
  video: File | null;
  onVideoChange: (file: File | null) => void;
  thumbnail: File | null;
  onThumbnailChange: (file: File | null) => void;
  videoError: string | null;
}) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="ad.adName"
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
        name="ad.message"
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
      {format !== "CAROUSEL" ? (
        <FormField
          control={form.control}
          name="ad.link"
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
      ) : null}
      <FormField
        control={form.control}
        name="ad.callToActionType"
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

      {format === "SINGLE_IMAGE" ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Image</label>
          <div className="flex items-center gap-3">
            {imagePreviewUrl ? (
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
      ) : null}

      {format === "CAROUSEL" ? (
        <CarouselCardEditor
          form={form}
          images={cardImages}
          onImagesChange={onCardImagesChange}
          imagesError={cardImagesError}
        />
      ) : null}

      {format === "VIDEO" ? (
        <VideoUploadField
          video={video}
          onVideoChange={onVideoChange}
          thumbnail={thumbnail}
          onThumbnailChange={onThumbnailChange}
          error={videoError}
        />
      ) : null}
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
    .map((l) => l.label ?? `Locale #${l.id}`)
    .join(", ");
  const formatValue = FORMAT_META[values.ad.format].title;

  const rows: { label: string; value: string; stepIndex: number }[] = [
    { label: "Ad set name", value: values.name.trim() || "—", stepIndex: 0 },
    {
      label: "Daily budget",
      value: values.dailyBudget
        ? `${values.dailyBudget} / day${values.endDate ? `, until ${values.endDate}` : ""}`
        : "—",
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
    { label: "Format", value: formatValue, stepIndex: 2 },
    { label: "Ad name", value: values.ad.adName.trim() || "—", stepIndex: 3 },
    ...(values.ad.format !== "CAROUSEL"
      ? [
          {
            label: "Destination link",
            value: values.ad.link.trim() || "—",
            stepIndex: 3,
          },
        ]
      : [
          {
            label: "Cards",
            value: `${values.ad.cards.length} card${values.ad.cards.length === 1 ? "" : "s"}`,
            stepIndex: 3,
          },
        ]),
    {
      label: "Call to action",
      value: CTA_LABEL[values.ad.callToActionType],
      stepIndex: 3,
    },
    { label: "Status", value: "Paused (draft)", stepIndex: 3 },
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
      {values.ad.format === "SINGLE_IMAGE" ? (
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
            {values.ad.message.trim() || "—"}
          </p>
        </div>
      ) : null}
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

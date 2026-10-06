"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Pencil,
  Rocket,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { WizardSteps } from "@/components/shared/wizard-steps";
import {
  ObjectivePicker,
  OBJECTIVES,
  type Objective,
} from "@/components/ads/objective-picker";
import { createMetaCampaignAction } from "@/server/actions/meta-ads-actions";

const schema = z.object({
  name: z
    .string()
    .max(120, "120 characters max")
    .refine((value) => value.trim().length > 0, "Campaign name is required"),
  objective: z.enum(OBJECTIVES),
});

type FormValues = z.infer<typeof schema>;
// Bütçe kampanyada değil ad set'tedir (ABO): Meta ikisini birden almaz ve
// bitiş tarihi de ad set'e yazılır (docs/meta-ads-plan.md F0b).
type StepId = "objective" | "review";

const STEPS: { id: StepId; title: string }[] = [
  { id: "objective", title: "Objective" },
  { id: "review", title: "Review" },
];

const STEP_FIELDS: Record<StepId, (keyof FormValues)[]> = {
  objective: ["name", "objective"],
  review: [],
};

const OBJECTIVE_LABEL: Record<Objective, string> = {
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_LEADS: "Leads",
  OUTCOME_APP_PROMOTION: "App promotion",
  OUTCOME_SALES: "Sales",
};

// Same multi-step shape as new-project-wizard.tsx (single useForm shared
// across steps, per-step partial validation via form.trigger(), a Review
// step with per-field Edit links) — applied here to Meta's campaign
// creation, in place of the old single-screen native-<select> form. Submits
// through the EXISTING createMetaCampaignAction unchanged (same FormData
// shape: projectId/name/objective), so the Approval/ExecutionJob
// pipeline behind it is untouched.
export function CampaignWizard({
  projectId,
  closeHref,
  prefillName,
}: {
  projectId: string;
  closeHref: string;
  prefillName?: string;
}) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: prefillName ?? "",
      objective: "OUTCOME_TRAFFIC",
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
      formData.set("name", values.name.trim());
      formData.set("objective", values.objective);
      const result = await createMetaCampaignAction(formData);
      if (result.ok) {
        toast.success("Campaign submitted for approval");
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
              "min-h-[280px]",
              direction === 1
                ? "animate-in fade-in slide-in-from-right-3 duration-300"
                : "animate-in fade-in slide-in-from-left-3 duration-300",
            )}
          >
            {step.id === "objective" ? <ObjectiveStep form={form} /> : null}
            {step.id === "review" ? (
              <ReviewStep form={form} onEdit={goTo} />
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
                  <Rocket /> Create Campaign
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

function ObjectiveStep({ form }: { form: UseFormReturn<FormValues> }) {
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Campaign name</FormLabel>
            <FormControl>
              <Input {...field} autoFocus placeholder="Summer sale — traffic" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="objective"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Campaign objective</FormLabel>
            <FormControl>
              <ObjectivePicker value={field.value} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
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
    { label: "Campaign name", value: values.name.trim() || "—", stepIndex: 0 },
    {
      label: "Objective",
      value: OBJECTIVE_LABEL[values.objective],
      stepIndex: 0,
    },
    {
      label: "Budget",
      value: "Set on the ad set, with its end date",
      stepIndex: 0,
    },
    { label: "Status", value: "Paused (draft)", stepIndex: 0 },
  ];

  return (
    <div>
      <div className="mb-4 text-center">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          Review your campaign
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          This creates a draft campaign and requires approval before it goes
          live on Meta.
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
    </div>
  );
}

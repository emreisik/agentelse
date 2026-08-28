"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Target } from "lucide-react";
import { toast } from "sonner";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GeoTargetSelect } from "@/components/ads/geo-target-select";
import { CitySearchCommand } from "@/components/ads/city-search-command";
import { GenderToggle } from "@/components/ads/gender-toggle";
import { LocaleSearchCommand } from "@/components/ads/locale-search-command";
import { updateMetaAdSetAction } from "@/server/actions/meta-ads-actions";
import type { MetaAdSetSummary } from "@/server/integrations/meta-client";

const schema = z
  .object({
    dailyBudget: z
      .string()
      .refine((v) => Number(v) > 0, "Enter a daily budget greater than 0"),
    status: z.enum(["ACTIVE", "PAUSED"]),
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
  })
  .refine((v) => Number(v.ageMin) <= Number(v.ageMax), {
    message: "Min age must be less than or equal to max age",
    path: ["ageMax"],
  });

type FormValues = z.infer<typeof schema>;

// Single-screen edit form for an EXISTING ad set — a smaller cousin of
// TargetingStep in adset-ad-wizard.tsx (same leaf components: GeoTargetSelect,
// CitySearchCommand, GenderToggle, LocaleSearchCommand), prefilled from Meta's
// current values instead of starting blank. No multi-step chrome: editing a
// handful of already-familiar fields doesn't need the same step-by-step
// onboarding a first-time creation flow does.
export function AdSetEditWizard({
  projectId,
  adSet,
  closeHref,
}: {
  projectId: string;
  adSet: MetaAdSetSummary;
  closeHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const targeting = adSet.targeting;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      dailyBudget:
        adSet.dailyBudgetCents !== undefined
          ? (adSet.dailyBudgetCents / 100).toFixed(2)
          : "",
      status: adSet.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
      countries: targeting?.countries ?? [],
      cities: (targeting?.cities ?? []).map((c) => ({
        key: c.key,
        name: c.name ?? c.key,
      })),
      ageMin: String(targeting?.ageMin ?? 18),
      ageMax: String(targeting?.ageMax ?? 65),
      gender:
        targeting?.genders?.length === 1 ? String(targeting.genders[0]) : "",
      locales: targeting?.locales ?? [],
    },
  });

  function handleSubmit(values: FormValues) {
    setSubmitError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("adSetId", adSet.adSetId);
      formData.set("dailyBudget", values.dailyBudget);
      formData.set("status", values.status);
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

      const result = await updateMetaAdSetAction(formData);
      if (result.ok) {
        toast.success("Ad set update submitted for approval");
        router.push(closeHref);
        router.refresh();
      } else {
        setSubmitError(result.message);
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="dailyBudget"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Daily budget</FormLabel>
              <FormControl>
                <Input {...field} type="number" min="1" step="0.01" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                  <SelectItem value="PAUSED">PAUSED</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center gap-2 border-t border-border/60 pt-4 text-muted-foreground">
          <Target className="size-4" />
          <p className="text-xs">Targeting</p>
        </div>
        <TargetingFields form={form} projectId={projectId} />

        {submitError ? (
          <p className="text-sm text-destructive">{submitError}</p>
        ) : null}
        <div className="flex justify-end pt-1">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="animate-spin" /> Saving…
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}

function TargetingFields({
  form,
  projectId,
}: {
  form: UseFormReturn<FormValues>;
  projectId: string;
}) {
  return (
    <div className="space-y-4">
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

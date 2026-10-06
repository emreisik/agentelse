import { BarChart3 } from "lucide-react";

import { ActionForm } from "@/components/shared/action-form";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { gaReportsEnabledFor } from "@/lib/website-analytics/reports/flags";
import {
  GA_REPORT_LOCAL_TIME,
} from "@/lib/website-analytics/reports/schedule";
import {
  weekdayLabel,
  type GaReportPulseMode,
} from "@/lib/website-analytics/reports/settings";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { updateGaReportSettingsAction } from "@/server/actions/website-report-actions";
import { loadGaReportSettings } from "@/server/website-analytics/reports/settings";

// Settings → Autonomy → "Website reports" (GA-F5): haftalık/aylık rapor,
// günlük nabız ve kritik ölçüm uyarısı tercihleri. Kendi ActionForm'u var;
// bayrak (ve geliştirme kapsamı) kapalıyken sorgusuz null döner. Giriş
// denetimi eylemde yapılır, burada requireUser çağrılmaz (üst panel zaten
// proje erişimini doğruladı).

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
  value: String(day),
  label: weekdayLabel(day),
}));
const MONTH_DAYS = Array.from({ length: 28 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));
const PULSE_OPTIONS: { value: GaReportPulseMode; label: string }[] = [
  { value: "notable", label: "Only when something stands out" },
  { value: "off", label: "Off" },
];

function DaySelect({
  id,
  name,
  value,
  items,
}: {
  id: string;
  name: string;
  value: number;
  items: { value: string; label: string }[];
}) {
  return (
    <Select name={name} defaultValue={String(value)} items={items}>
      <SelectTrigger id={id} size="sm" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SwitchRow({
  id,
  name,
  checked,
  label,
  children,
}: {
  id: string;
  name: string;
  checked: boolean;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        key={`${name}-${checked}`}
        id={id}
        name={name}
        defaultChecked={checked}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <Label htmlFor={id} className="leading-snug">
          {label}
        </Label>
        {children}
      </div>
    </div>
  );
}

export async function WebsiteReportSettingsCard({
  projectId,
}: {
  projectId: string;
}) {
  if (!gaReportsEnabledFor(projectId)) return null;
  const [settings, timeZone] = await Promise.all([
    loadGaReportSettings(projectId),
    getProjectTimezone(projectId),
  ]);

  return (
    <ActionForm
      action={updateGaReportSettingsAction}
      successMessage="Report settings saved"
      className="space-y-4"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <Card size="sm" id="website-reports">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
            <BarChart3 className="size-4 text-primary" />
          </span>
          <CardTitle className="text-base">Website reports</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <SwitchRow
            id="ga-reports-weekly"
            name="weeklyEnabled"
            checked={settings.weeklyEnabled}
            label="Weekly report"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Label
                htmlFor="ga-reports-weekday"
                className="text-xs font-normal text-muted-foreground"
              >
                Day of the week
              </Label>
              <DaySelect
                id="ga-reports-weekday"
                name="weeklyWeekday"
                value={settings.weeklyWeekday}
                items={WEEKDAYS}
              />
            </div>
          </SwitchRow>

          <div className="border-t pt-5">
            <SwitchRow
              id="ga-reports-monthly"
              name="monthlyEnabled"
              checked={settings.monthlyEnabled}
              label="Monthly report and next month plan"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Label
                  htmlFor="ga-reports-month-day"
                  className="text-xs font-normal text-muted-foreground"
                >
                  Day of the month
                </Label>
                <DaySelect
                  id="ga-reports-month-day"
                  name="monthlyDay"
                  value={settings.monthlyDay}
                  items={MONTH_DAYS}
                />
              </div>
            </SwitchRow>
          </div>

          <div className="space-y-2 border-t pt-5">
            <p className="text-sm font-medium">Daily pulse</p>
            <RadioGroup
              name="pulse"
              defaultValue={settings.pulse}
              key={`pulse-${settings.pulse}`}
            >
              {PULSE_OPTIONS.map((option) => (
                <div key={option.value} className="flex items-center gap-2">
                  <RadioGroupItem
                    id={`ga-reports-pulse-${option.value}`}
                    value={option.value}
                  />
                  <Label
                    htmlFor={`ga-reports-pulse-${option.value}`}
                    className="font-normal"
                  >
                    {option.label}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-5 border-t pt-5">
            <SwitchRow
              id="ga-reports-alert-chat"
              name="alertChat"
              checked={settings.alertChat}
              label="Post critical tracking alerts in the Website analytics chat"
            />
            <SwitchRow
              id="ga-reports-alert-telegram"
              name="alertTelegram"
              checked={settings.alertTelegram}
              label="Send a short Telegram message for critical tracking alerts (never includes numbers or page addresses)"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Reports are sent at {GA_REPORT_LOCAL_TIME} in the project time zone (
            {timeZone}). Archiving the Website analytics chat does not stop
            them; turn them off here.
          </p>
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </CardContent>
      </Card>
    </ActionForm>
  );
}

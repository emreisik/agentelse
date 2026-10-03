"use client";

import { useState } from "react";
import { CalendarX2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { splitDateTime } from "@/lib/date-picker";

import { ScheduleField } from "./schedule-field";

// Detay panelindeki gün/saat düzenleyicisi. Alan, sitenin TEK tarih/saat
// seçicisidir (ui/date-time-picker): tarihe tıklayınca açılır, gün ve saat aynı
// panelde seçilir, planlı günler noktayla görünür. Yazma işini pano yapar
// (anında yerel güncelleme, arkada tek bir yazma); bu bileşen yalnız seçimi
// toplar, bu yüzden Kaydet'e basınca hiçbir şey beklemez.
export function SchedulePicker({
  projectId,
  creativeId,
  timezone,
  day,
  time,
  onSave,
}: {
  projectId?: string;
  creativeId: string;
  timezone: string;
  // Mevcut gün ("YYYY-MM-DD") ve saat ("HH:mm"); atanmamışsa null.
  day: string | null;
  time: string | null;
  // localDateTime "YYYY-MM-DDTHH:mm", ya da null: günü kaldır.
  onSave: (localDateTime: string | null) => void;
}) {
  const saved = day && time ? `${day}T${time}` : "";
  const [value, setValue] = useState(saved);

  const canSave = value !== saved && splitDateTime(value) !== null;

  return (
    <div className="space-y-2.5">
      <ScheduleField
        value={value}
        onChange={setValue}
        timezone={timezone}
        projectId={projectId}
        creativeId={creativeId}
        align="start"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[11px] text-muted-foreground">
          Times in {timezone}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {day ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onSave(null)}
              title="Take it off the calendar"
            >
              <CalendarX2 aria-hidden />
              Remove
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            disabled={!canSave}
            onClick={() => onSave(value)}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import type { ComponentProps } from "react";

import { DateTimePicker } from "@/components/ui/date-time-picker";

import { useDayMarks } from "./use-day-marks";

// Bir parçanın yayın gün+saatini seçtiren alan: sitenin standart
// DateTimePicker'ı + geçmişi kapatma + planlı gün noktaları. FormData ile
// gönderilen formlar için `name` verilir (gizli alan "YYYY-MM-DDTHH:mm" yazar).
// Sunucu bileşenlerinden de kullanılabilsin diye ayrı bir istemci bileşeni:
// planlı gün sayılarını okuyan kanca burada.
export function ScheduleField({
  projectId,
  creativeId,
  ...picker
}: {
  projectId?: string;
  // Düzenlenen parça: kendi günü "dolu" görünmesin.
  creativeId?: string;
} & ComponentProps<typeof DateTimePicker>) {
  const { marks, onViewChange } = useDayMarks(projectId, creativeId);
  return (
    <DateTimePicker
      disablePast
      marks={marks}
      onViewChange={onViewChange}
      aria-label="Day and time"
      {...picker}
    />
  );
}

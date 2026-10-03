# Tarih/saat seçici (tek standart)

Sitede **tek** tarih/saat seçici var: `src/components/ui/date-time-picker.tsx`. Hiçbir yerde yerel `<input type="date|time|datetime-local">` kullanılmaz; eslint (`no-restricted-syntax`, `eslint.config.mjs`) JSX'te bunları hata sayar. Alan, takvim, saat paneli ve gösterim biçimi her yerde aynıdır.

## Bileşenler

- `DateTimePicker` — gün + saat (`"YYYY-MM-DDTHH:mm"`, eski `datetime-local` ile aynı değer).
- `DatePicker` — gün (`"YYYY-MM-DD"`).
- `TimePicker` — saat (`"HH:mm"`, 24 saat). `onCommit`: panel kapanırken değer değiştiyse bir kez çağrılır.
- `DateTimePanel` — yalnız açılır panel (takvim + saat + alt çubuk). Kendi popover'ı olan yerler için (`plan-pane/move-day.tsx`).

Ortak props: `id`, `name` (verilirse gizli `<input>` ile forma yazılır, `FormData` formları eskisiyle aynı değeri alır), `disabled`, `readOnly` (aynı görünüm, açılmaz), `placeholder`, `timezone` ("bugün" o dilimde hesaplanır, panelde "Times in …" yazar), `aria-label`, `align`.
Gün seçenekleri: `min`, `max`, `disablePast`, `marks` (gün başına planlı parça sayısı → takvimde noktalar), `onViewChange` (görünen ızgara aralığı; planlı sayıları yüklemek için). Saat: `step` (dakika sütunu adımı, varsayılan 5), `timePresets`. `clearable`: Clear düğmesi.

## Davranış

- **Alanın kendisi tetikleyicidir** (tarih metni); ikon tek başına düğme değil.
- Panel: Today / Tomorrow / Next Mon / In a week kısayolları, aylık takvim (6 hafta sabit, Pazartesi başlar), başlığa tıklayınca ay/yıl atlama, ok tuşları + Home/End + PageUp/PageDown (Shift: yıl) ile klavye, bugün halkası, geçmiş gün kapatma, planlı gün noktaları. Saat: yazma alanı (`930`, `9:30`, `21.30` kabul), saat ve dakika sütunları, hızlı saat çipleri.
- Gün seçilince saat korunur (yoksa 10:00), saat seçilince gün korunur (yoksa bugün / izin verilen ilk gün). DatePicker günde kapanır; diğerleri Done ile.
- Bir `datetime-local` değeri saat dilimsizdir. `scheduledFor` (UTC anı) ile çalışırken `utcToZonedDateTimeLocal` / `zonedDateTimeToUtc` ve proje saat dilimi kullanılır.

## Parçalar

- `src/lib/date-picker.ts` — saf mantık (biçimler, ayrıştırma, gösterim, 6 haftalık ızgara, kısayollar, gün+saat birleştirme). Testli.
- `src/components/ui/date-time-panels.tsx` — `CalendarPanel`, `TimePanel`.
- `src/components/calendar/schedule-field.tsx` — `DateTimePicker` + `disablePast` + planlı gün noktaları (`use-day-marks.ts`, `/api/projects/[id]/calendar`). Bir parçanın yayın zamanı seçilen her yerde (takvim detayı, önizleme penceresi) bu kullanılır.

## Kullanıldığı yerler

Takvim detayı (`SchedulePicker`), önizleme penceresi "Add to calendar", ayarlar paneli yayın slotları ve otomatik plan saati, plan panelinde gönderi saati (`TimeRow`) ve gün/saat taşıma (`MoveDay`).

## Not

Önizleme penceresi `scheduledFor.slice(0, 16)` ile UTC saatini yerel saat gibi gösteriyordu (her kayıtta saat kayardı); artık `CreativePreview.timezone` ile proje diliminde gösterilir.

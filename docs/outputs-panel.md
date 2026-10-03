# Outputs sekmesi (sağ panel)

Sohbet ekranının sağ panelindeki Outputs sekmesi projenin ürettiği her parçayı (arşiv hariç, en yeni 400) gösterir ve üzerinde iş yapılmasını sağlar.

## Parçalar

- `src/components/workspace/outputs-panel.tsx` — istemci paneli. Sekme açılınca okur, 30 sn'de bir (sekme görünürken) yoklar; proje sayfası Outputs için sorgu yapmaz.
- `src/app/api/projects/[projectId]/outputs/route.ts` + `src/server/outputs/load-outputs.ts` — hafif okuma ucu: son sürüm (görsel, metin, sürüm no), bekleyen onay, yayın zamanı (proje saat diliminde), platform kimliği (`sourceOf`, takvimle aynı).
- `src/lib/outputs/panel.ts` — saf mantık: durum (`phaseOf`: onaylı + günü var = Scheduled), biçim türü (`kindOf`: plan glyph'i > sürüm biçimi > tür), arama, süzgeçler, sıralama.
- `OutputPreviewDialog` — kart tıklanınca açılan önizleme; `onChanged` ile paneli tazeler.

## Özellikler

- **Durum şeridi** (çoklu): Needs review / Draft / Approved / Scheduled / Published / Rejected, sayılarla. Bekleyen onay varsa üstte "N outputs are waiting for your review · Review".
- **Platform şeridi** (çoklu, marka simgeli), **arama** (başlık, metin, platform), **biçim** (Post/Carousel/Story/Reel/Video/Ad/Text) ve **sıralama** (Newest / Recently changed / Needs me first / Publish date / Oldest; tarayıcıda hatırlanır).
- **Kart**: görsel (ya da metin parçalarında metnin başı), platform rozeti, sürüm (v2+), durum + yayın zamanı ("Tomorrow · 10:00"); bekleyen onayda kart üstünde Approve / Reject; fare üstünde Copy text, Download, Show in calendar.
- **Select** modu: çoklu seçim, toplu Approve ve toplu Download.
- 24'erli "Show more".

Arşivleme/silme bilerek yok: onay ve yayın kuyruğuyla etkileşimi ayrı bir karar ister.

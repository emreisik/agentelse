# Content Calendar (`/projects/[id]/takvim`)

Projenin içeriklerini gün gün gösterir, sürükle-bırakla günlerini değiştirir ve her parçanın **ne durumda olduğunu** tek bakışta söyler.

## Parçalar

- `src/app/projects/[projectId]/takvim/page.tsx` — RSC, YALNIZ ilk yüklemede: erişim, ilk veri, Suspense ile akan "sıradaki adım" şeridi.
- `src/components/calendar/calendar-board.tsx` — istemci panosu: ay ızgarası ve "2 weeks" görünümü (URL'de `view=week`; iki hafta alt alta, her hafta kendi satırında "This week / Next week" başlığıyla; ±1 hafta kayan pencere), süzgeçler, sürükle-bırak, iyimser güncelleme (yerel durum + anında yazım, hata olursa geri döner), 30 sn'de bir hafif JSON yoklaması (sürüklerken durur). `calendar-day.tsx`: memo'lu gün hücresi.
- `src/components/calendar/creative-detail.tsx` + `detail-sheet.tsx` — sağdan açılan detay paneli (aşağıda).
- `src/components/calendar/schedule-picker.tsx` — panelde gün/saat düzenleyici (`rescheduleCreativeAction`).
- `src/app/api/projects/[projectId]/calendar/route.ts` (+ `[creativeId]/route.ts`) — hafif okuma uçları: pano verisi ve tembel detay.
- `src/lib/calendar/item.ts` — durumu ham olgulardan yeniden türetme (`rescheduleItem`), `mergeFresh`, `reuseUnchanged`.
- `src/server/calendar/load-calendar.ts` — parçaları, yayın görevlerini ve bağlı hesapları okuyup `CalendarItem` listesine çevirir.
- `src/lib/calendar/` — saf mantık: `stage.ts` (durum), `grid.ts` (ızgara), `move.ts` (bırakma kuralları), `source.ts` (platform kimliği), `types.ts`.
- `rescheduleCreativeAction` (`src/server/actions/creative-calendar-actions.ts`) — sürükle-bırakın yazma yolu.

## Durumlar (`deriveStage`)

Tek kaynak: `Creative.status` + son yayın görevi + planlanan zaman + hesap bağlantısı + zamanlı yayın ayarı. Zaman/format/bağlantı kuralları `publish-guard.ts`'teki `describePublishLine`'dan gelir, ikinci kopya yok.

| Durum          | Anlamı                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Failed         | Yayın görevi hata verdi (nedeni gösterilir)                                         |
| Missed         | Zamanı geçti (24 saatten eski) ve paylaşılmadı                                      |
| On hold        | Onaylı ama çıkamıyor: hesap bağlı değil / zamanlı yayın kapalı / günü yok           |
| Needs approval | İncelemede ya da içeriği hazır taslak                                               |
| Needs content  | Plan yuvası, içerik henüz yok                                                       |
| Scheduled      | Onaylı, kendiliğinden çıkacak                                                       |
| Publishing     | Yayın görevi çalışıyor (taşınamaz)                                                  |
| Post manually  | Onaylı ama otomatik çıkmayan format/platform (Reel, carousel, LinkedIn, X, Blog...) |
| Published      | Yayınlandı (taşınamaz)                                                              |
| Rejected       | Reddedildi                                                                          |

Hata, o yayın denemesine aittir: parça hatadan sonra gelecekte yeni bir zamana taşındıysa "Failed" sayılmaz (`replannedAfterFailure`).

## Sürükle-bırak kuralları (`resolveDrop`)

- Gün değişir, **saat korunur**; saati olmayan parçaya 10:00 verilir.
- **Geçmiş güne bırakılamaz**: onaylı bir parça geçmiş zamana yazılırsa yayın kuyruğu onu hemen vadesi gelmiş sayıp paylaşır.
- Bugüne bırakılan parçanın saati geçmişse bir sonraki çeyrek saate ertelenir; gün bitmişse reddedilir.
- Yayınlanmış/yayınlanan parça sürüklenemez.
- "Unscheduled" tepsisine bırakmak günü kaldırır. Her taşımada "Undo" bildirimi vardır (geri alma geçmiş zamanı da yazabilir: `restore`).
- Dokunmatik ekranda tarayıcı sürüklemeyi desteklemeyebilir; yedek yol detay panelindeki gün/saat alanıdır.

## Performans mimarisi
Eskiden kart açmak (`?creative=` gezintisi), her tarih kaydı (`revalidatePath`) ve 30 sn'lik `router.refresh()` **sayfayı komple sunucuda yeniden render** ediyordu: AppShell (kenar çubuğu rozetleri, dead-letter, OpenAI bakiyesi...), 300 satırlık journey snapshot'ı ve takvim sorguları, ~30 sorgu, çoğu seri, uzak Neon'a. Şimdi:
- **Kart açmak sunucuya gitmez**: panel pano verisiyle anında açılır; tam metin/künye/bekleyen onay `GET .../calendar/[creativeId]` ile tembel gelir (iskelet), fare 120 ms bir kartta durursa önceden çekilir. Adres `history.replaceState` ile `?creative=` olur (Next yönlendiricisini tetiklemez).
- **Taşıma/kaydetme sayfayı render ettirmez**: `rescheduleCreativeAction` `revalidatePath` çağırmaz; yeni durum istemcide `rescheduleItem` ile aynı kurallarla yeniden türetilir (`CalendarItem.facts` ham olguları taşır). Eylemin kendisi 4 seri tur (kullanıcı+parça, erişim+saat dilimi, yaz, denetim).
- **Tazeleme** hafif uçtan (`GET .../calendar?from&to`, ~8 paralel sorgu). Yazmadan ÖNCE okunmaya başlayan yanıt, kullanıcının yerel değişikliğini ezmez (`loadedAt` ↔ yazma damgası).
- **Sayfa**: erişim kontrolü kabuktan önce, ama takvim verisi ve "sıradaki adım" şeridi Suspense ile akar (banner için 52 px yer tutucu).
- **İstemci**: hücreler ve kartlar `memo`; sunucudan gelen içeriği değişmemiş öğeler eski nesneyle değiştirilir (`reuseUnchanged`); sürükleme yalnız ilgili hücreleri yeniden render eder; tepsi ilk 30 kartı gösterir.
- **Panel**: `backdrop-blur` yok (altta yüzlerce kartlı ızgara varken her boyamada bulanıklığı baştan hesaplatıyordu), yalnız `transform` geçişi; "Live" noktasındaki sonsuz `animate-ping` kaldırıldı.
- Bilinen kalan: "Mark as posted" (`markCreativePublishedAction`) takvim yolunu `revalidatePath` ettiği için bir kez tam render tetikler (seyrek).

## Detay paneli
Karta tıklayınca sağdan açılan modal sheet (mobilde tam genişlik). Üst kimlik (platform simgesi, başlık, durum, zaman) ve alt ana eylem **sabit**, ortası kaydırılır. Kartlar: görsel (büyütülebilir), durum cümlesi (nedeniyle), **Schedule** (gün + saat + Today/Tomorrow/Next week kısayolları + Remove + Save), Caption/Copy (kopyala düğmeli), Details (platform, biçim, hedef, tarih, sürüm). Alt çubuk duruma göre: onay bekleyende Reject/Approve, elle paylaşılanda "Mark as posted". Yayınlanmış/yayınlanan parçada tarih alanı salt okunur. Image Studio takvimden kaldırıldı (görsel üretimi/düzenleme sohbet kartında).

## Sağ panel Calendar sekmesi (`calendar-panel.tsx`)

Sohbet ekranının sağ panelindeki Calendar sekmesi aynı veriyi (`GET .../calendar?from&to`, aynı `stage`, aynı `CreativeDetail` paneli, aynı `rescheduleCreativeAction`) 400 px'e sığdırır. Tamamen istemcide: sekme açılınca okur, 30 sn'de bir yoklar; ay/hafta gezintisi ve süzgeçler proje sayfasını yeniden render ETMEZ (eski `?calMonth=` / `?calItem=` kalktı, sayfa artık sağ panel için takvim sorgusu yapmıyor; yalnız saat dilimini verir).

- **Özet kutucukları**: Planned / Needs you / Scheduled / Published; tıklamak hızlı durum süzgecidir.
- **Görünümler**: Month (platform renginde noktalı ızgara, sorunlu günde kırmızı işaret, güne tıklayınca o günün listesi; komşu ayın gününe tıklamak o aya geçer), Week (7 gün alt alta, her gün bırakma alanı), List (aya ait tüm parçalar).
- **Platform şeridi**: bağlı hesaplar + aralıkta parçası olan her kanal, çoklu seçim, bağlantı noktası (yeşil/sarı), sayılar diğer süzgeçlere göre.
- **Filters**: durum (çoklu), biçim (Post/Reel/Story/Carousel...), sıralama (Soonest / Latest / Needs me first / By platform; listede başlıklar sıralamaya uyar: gün, durum ya da platform), "Clear all".
- **Arama**: başlık, metin önizlemesi ve platform adında, kelime kelime.
- **Uyarılar**: hata/kaçan parça sayısı ("Show"), bağlı olmayan platforma giden parçalar ("Connect"), zamanlı yayın kapalı ("Turn on").
- **Sürükle-bırak**: satırlar ay ızgarasındaki günlere, hafta günlerine ve "Unscheduled" tepsisine sürüklenir (kurallar `resolveDrop`; Undo'lu bildirim).
- Görünüm, sıralama ve seçili platformlar tarayıcıda proje başına hatırlanır (`localStorage`, `ws-calendar:<projectId>`).
- Saf mantık: `src/lib/calendar/panel-view.ts` (süzme, sıralama, gruplama, gün noktaları).

## Bilinen sınırlar

- Facebook çapraz paylaşımının (FACEBOOK_PUBLISH) durumu takvimde yok; o durum Facebook'tan canlı okunuyor (bkz. `facebook-share.ts`).
- Tazeleme `LiveRefresh` (router.refresh) değil, hafif JSON yoklamasıdır.
- Tarayıcıda görülmedi: render testleri (`calendar-board.test.ts`) ve tsc/eslint ile doğrulandı.

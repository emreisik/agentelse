# Website raporları ve planlama (GA-F5)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §3.7, §9 GA-F5, GK9, GK17. İlgili: ambar [website-analytics.md](website-analytics.md); ölçüm sağlığı [measurement-health.md](measurement-health.md); analiz motoru [website-insights.md](website-insights.md); bağlantı [google-connections.md](google-connections.md). Search Console tarafının karşılığı [search-reports.md](search-reports.md).

## Durum (6 Ekim 2026)

Kodlandı. `GA_REPORTS=true` ve `GA_SYNC=true` ile açılır. Canlıda denenmedi; tarayıcıda görülmedi.

Migration: `20261006215000_add_ga_reports`. Yeni tablolar: `GaReportSettings`, `GaReportRun`, `GaGoalProgress`.

## 1. Ne yapar

Projede "Website analytics" adlı bir sohbet (`wkga_<projectId>`, modül `analytics`) açılır ve Agentelse oraya değişmeyen rapor kartları yazar: günlük nabız, haftalık rapor, aylık rapor, "Next month plan" ve kritik ölçüm uyarısı. Ayrıca `web.*` hedeflerinin güncel değerini her gün yazar, ay sonu tahmini ve hedef temposu hesaplar, ve Website sayfasında bir "Reports" arşivi gösterir.

Google'a hiç çağrı yapılmaz: her sayı yerel ambardan (GaDailyTotal, GaMonthlySummary, haftalık dilimler, GA-F3 ve GA-F4 tabloları) okunur.

## 2. Bayrak ve devreye alma

- `GA_REPORTS=true` (okuma anında; yalnız tam `true`). `GA_SYNC=true` de gerekir: `gaReportsEnabled() = GA_REPORTS==='true' && GA_SYNC==='true'`.
- Bölümler mevcut bayraklara bağlıdır:
  - `GA_INSIGHTS`: "What changed" ve "Opportunities" bölümleri, Accept/Dismiss, haftalık raporun ve nabzın GA-F4'ü beklemesi. Kapalıyken bölümler yoktur.
  - `GA_HEALTH`: ölçüm sağlığı bölümü; kapalıyken yok.
  - `GA_WEEKLY`: haftalık "Site search" tablosu; kapalıyken ve aylık raporlarda yok.
  - `GA_WEBSITE_PAGE`: bağlantılar `/projects/<id>/site`'a gider; kapalıyken Integrations GA penceresine.
- Geliştirme koruması: `GA_SYNC_DEV_PROJECTS`. Canlı veritabanını paylaşan bir geliştirme süreci yalnız listedeki projeleri işler (`gaReportsDevProjectScope()` sorguya girer), süreç içi 5 dakikalık kısıtlama kullanır (`claimPeriodic` yok), saklama temizliğini çalıştırmaz ve `ga.reports` heartbeat'ini yazmaz.
- Kapalıyken: `GaReports.runDue` sorgusuz 0 döner; `loadGoalPaceMap`, `loadWebsiteReportArchive`, `GaGoals.loadProgress`, ayar kartı sorgu atmaz; `gaAlertTelegramAllowed` sorgusuz `true` döner; `projects/[projectId]/page.tsx` sohbet sorgusuna yeni OR koşulu eklemez. Disconnect temizliği bayraktan bağımsız çalışır.
- Açılış adımları:
  1. Sahip yeni bir terminal sekmesinde (dev sunucu sekmesinde değil) tek satır çalıştırır: `npx prisma migrate deploy`; çıktıyı yapıştırır.
  2. Deploy.
  3. Railway'de `GA_REPORTS=true`.
  4. Sonraki Pazartesi öğleden sonra projeyi aç → Recents → "Website analytics".
- İlk "Next month plan" 56 günlük geçmiş olunca gelir: aylık gün ya da sonrası; ayın 10'undan sonrası ise gelecek ay içindir.
- Geri alma: `GA_REPORTS=false`. Veri kalır; kartlar artık listelenmez.
- `.env.example` bu oturumda yazılamadı. Eklenecek (GA bayrakları bloğunda, `GA_INSIGHTS` satırlarından sonra):

```
# GA-F5 raporlama ve planlama (docs/website-reports.md): Website analytics sohbeti, haftalık/aylık rapor, hedef temposu; GA_SYNC=true gerektirir
GA_REPORTS=false
```

## 3. Zamanlama

Zamanlama proje saatiyle (`getProjectTimezone`), dönemler ve hedefler mülk günleriyle yapılır. Yakın gece yarısı plan ayı ile hedef ayı birkaç saat ayrışabilir.

Tek tick adımı `ga-reports` (`GaReports.runDue(5)`). Her birincil bağın `GaReportRun` satırı 3 dakikalık CAS kilidi tutar. Aşamalar sırayla: hedefler → uyarı kartları → nabız → haftalık → aylık → plan. Aday seçimi sorguda yapılır: önce hiç `GaReportRun`'ı olmayan bağlar, sonra `lastCheckedAt` artan sırayla; bellek içi sınır yok, hiçbir proje aç kalmaz. Üretimde `claimPeriodic('ga.reports.tick', 5 dk)`; bir tick'te en çok 5 bağ ve en çok 2 LLM çağrısı.

- **Haftalık:** `<hafta günü> 08:00`'dan itibaren (varsayılan Pazartesi), önceki ISO haftası için. Pazar verisi gelene kadar (`completeThrough ≥ Pazar`) bekler. GA Pazar'ı mülk saatiyle Pazartesi öğleden sonra yayımladığı için pratikte rapor Pazartesi öğleden sonra ya da akşam çıkar (16:00–21:00 civarı). `GA_INSIGHTS` açıkken GA-F4'ün haftalık analizini (`GaAnalysisRun.lastWeek ≥ Pazartesi`) en çok 24 saat bekler; sonra "insights pending" ile yazar. Vade tarihinden 6 gün sonra hafta bayat sayılıp atlanır.
- **Aylık:** ayın 2'si 08:00 (ayar: 1–28), önceki takvim ayı için, `completeThrough ≥ ay sonu` olunca. 10 gün sonra bayat.
- **Plan:** aylık gün 08:00'dan önce hiç yazılmaz. Proje saatine göre gün ≤ 10 ise hedef ay içinde bulunulan aydır, değilse gelecek ay. Güncel ayı hedeflediğinde aylık rapor vadesi gelmişse ya da veri bekliyorsa bekler. Aylık rapor ve plan aynı `monthlyEnabled` anahtarını paylaşır. Aylık durum aşama (e)'den sonra plana geçirilir; yani aynı `runLink`'te hem aylık rapor hem plan çıkabilir. Plan en az 56 gün geçmiş ister.
- **Nabız:** yalnız yeni bir `completeThrough` görüldüğünde ve `completeThrough` mülk "dün"üne eşitken değerlendirilir. `GA_INSIGHTS` açıkken GA-F4'ün günlük analizini (`lastDailyDay`) ilk görüşten itibaren en çok 3 saat bekler. LLM yok, şablon metin. Yalnız dikkat çekiciyse yazılır:
  - son nabızdan (`lastPulseAt`) beri yeni bir uyarı açıldıysa;
  - oturum, key event, etkileşim oranı ya da gelirde |sağlam z| ≥ 3 ve |değişim| ≥ %20 (8 haftalık aynı hafta günü tabanına göre, hacim kapılarıyla);
  - o güne ait canlı bir AN1 bulgusu varsa.
    Tatil ve şüpheli günlerde "olağandışı metrik" nedenleri bastırılır. Nabız yazılırken hâlâ açık GA4 WARN/CRITICAL uyarılarının başlıkları (en çok 5) da sıralanır; tek başına eski açık uyarı nabız doğurmaz. Nabız arşivlenmiş sohbeti yeniden açmaz.
- **Uyarı kartları:** `alertChat` açıkken, son taramadan sonra `firstSeenAt` ya da `updatedAt` değişmiş her OPEN CRITICAL GA4 uyarısı için bir kart; WARN → CRITICAL yükselişi de yakalanır (kimlik anahtarı önem derecesini taşır).
- **Hedefler:** yeni bir `completeThrough` geldikçe günde bir; tek işlemde, önce bağın hâlâ var olduğu kontrol edilerek.
- **Bir dönem bir kez:** deterministik Command kimlikleri (`garep_<variant>_<projectId>_<periodKey>`) ve `GaReportRun` işaretçileri. `websiteReportExists(id)` ambar yükünden ve LLM çağrısından önce bakılır; `P2002` `exists` döner.
- **Hata kuralı:** `GaReportRun.attempts` (`<variant>:<periodKey>` → sayı, en çok 12 anahtar) haftalık, aylık ya da plan aşaması hata atınca artar. 2 başarısız denemeden sonra rapor yapay zekâ olmadan yazılır (not `narrativeFailed`); 5'te dönem bitmiş sayılır ve "failed" olarak atlanır. Böylece yazılamayan bir gönderi 6–10 gün boyunca LLM harcamasını tekrarlamaz.

## 4. Kart içeriği

Her rapor `Command` kartıdır (`kind: "website-report"`, `variant`: pulse | weekly | monthly | plan | alert); `parsedIntent = { card: WebsiteReportCardData }`. Renderer yalnız karta bakar; toleranslı bir zod okuyucudur (`readWebsiteReportCard`). Okunamayan ya da gelecekteki sürümden bir kart sohbeti çökertmez, "This report can't be shown." satırı gösterir. Kartın altında "This report keeps the numbers as they were when it was sent." yazar.

- **Haftalık:** KPI'lar (önceki hafta ve geçen yıl ile; Users satırı `rolling_users`'tan, geçen yıl Users yok çünkü o satırlar 95 günde silinir), kanallar, açılış sayfası yükselen/düşenler, key event'ler, AI asistan trafiği, site içi arama (`GA_WEEKLY`), ölçüm sağlığı (`GA_HEALTH`), "What changed" ve "Opportunities" (en çok 5; `GA_INSIGHTS` açık), hedefler ve tahmin, sonraki adımlar, notlar. Anlatı (özet, öne çıkanlar, dikkat edilecekler, sonraki adımlar).
- **Aylık:** haftalıktakilere ek olarak en çok bakılan sayfalar, ücretli trafik ve sonuçlar. Users satırı yok: `GaMonthlySummary` atıf penceresinden sonra yazıldığı için ayın 2'sinde yoktur. Site içi arama yok. Aylık hedef sonuçları devam eden tempo satırlarından değil, biten ayın `GaDailyTotal` toplamından hesaplanır.
- **Plan ("Next month plan"):** hedef ay, önerilen hedefler (bkz. §7), "For content and ads", notlar.
- **Nabız:** KPI sapmaları, nedenler, açık uyarı başlıkları.
- **Uyarı:** GA-F3 başlığı (rakamsız) ve "Open" bağlantısı; `GA_MH24` (erişim kaybı) için Integrations GA penceresi ve "Reconnect", diğerleri için ölçüm sağlığı. Susturma düğmesi ("Mute for 7 days", `muteMeasurementAlertAction`) yeniden bağlama dışı uyarılarda vardır.
- **"Preliminary":** dönemin son günü ambarda henüz kesinleşmemişse (`isFinal` değil; GA son 7 günün sayılarını biraz değiştirebilir) kartta "Preliminary" etiketi ve notu çıkar: "Numbers from the last 7 days may still change slightly as Google finalizes them."
- **Demo:** mock bağ kartı `isMock` taşır ve "Demo data" etiketi alır.
- **Sohbette:** haftalık, aylık ve plan kartları kompakt kart olarak görünür ve sağ panelde açılır (ikon `BarChart3`); nabız ve uyarı satır içi kalır.

## 5. Sayıların dürüstlüğü

- Toplamlar `GaDailyTotal`'dan; yüzdeler yüzde birimindedir; biçim aynı yardımcılarla (`lib/module-flows/analytics/format`).
- **Anlatı:** haftalık ya da aylık rapor başına bir LLM çağrısı (`purpose 'ga.report.narrative'`, tier default, `maxTokens 2500`), projenin içerik dilinde (GK17; `ReasoningService` dili ekler). Gerçekler yalnız toplulaştırılmış, arayüzdeki gibi biçimlenmiş sayılar ve en çok 20 maskeli Google dizgesidir (maskeli sayfa yolları, olay adları, bulgu konuları). Site içi arama terimleri ve kampanya adları LLM'e hiç gitmez. Çıktı `cleanSummary` ve `checkSummaryNumbers(…, allowedNumbersOf(facts))`'ten geçer; desteksiz cümle atılır. Başka sayı biçimleri (mk/tr: "1.234", "1 234") en-US gerçeği "1,234" ile eşleşir (`facts.test`).
- **Mock ve demo:** `AGENTELSE_REASONING_MODE=mock` iken anlatı yazılmaz, not "AI summary is not available in demo mode."; mock bağda not "AI summary is skipped for demo data."; sahte yanıt asla saklanmaz. `AGENTELSE_PROVIDER_MODE=mock` iken Google'a zaten çağrı yoktur.
- **Sohbet özeti (digest):** `Command.replyText` sonraki sohbet turlarında '[Agency event]' geliştirici mesajı olarak modele gider; `server/chat/context.ts` SYSTEM satırlarını proje genelinde de okuduğundan Website analytics sohbeti dışındaki genel sohbet bağlamına da girer. Bu yüzden `websiteReportChatDigest(card)` yalnız İngilizce KPI sayıları, GA varsayılan kanal grubu adları, adetler ve genel bulgu başlıkları taşır (`operatorFindingTitle`; bilinmeyen kural anahtarı → "Finding"). Sayfa yolu, arama terimi, kampanya adı, olay adı ya da anlatı asla girmez (`text.test.ts` bekçidir). Kartın kendisi modele gitmez.
- **Loglar:** `console.error` satırları ve `GaReportRun.lastError` yalnız `error.name` ya da Prisma kodu (`P2028`, `ZodError`…) tutar; `error.message` asla (ReasoningService ve zod hataları Google dizgesi yankılayabilir). `GaReportRun.stats` yalnız sayaçtır.

## 6. Hedefler ve tempo

- Hedef anahtarları GA-F4'ün `WEBSITE_GOAL_KEYS`'i: `web.sessions`, `web.key_events`, `web.revenue`. `targetValue` mülk saatiyle takvim ayı hedefidir. Kullanıcı bir hedefin metrik anahtarına elle bir `web.*` anahtarı yazarak izlemeyi kendisi de ekleyebilir.
- `ProjectGoal.currentValue` = mülk saatiyle ay başından bugüne; PROPOSED, APPROVED, ACTIVE ve PAUSED `web.*` hedefleri için yuvarlanıp yeni `completeThrough`'ta bir kez yazılır; yalnız değişen değer yazılır.
- `GaGoalProgress`: ay başından bugüne, tahmin ve aralığı, `expectedShare` (ayın `through`'a kadar beklenen hafta günü ağırlıklı payı). Tempo saklanmaz, okuma anında hedefin güncel değeriyle hesaplanır (`expectedToDate = expectedShare × target`); yani Brand Brain → Goals'ta hedef değişince hemen yansır.
- **Tempo durumları:** "achieved" (`monthToDate ≥ target`); "early" (ayın 5. gününden önce); aksi halde oran = tahmin/hedef, tahmin yoksa `monthToDate/expectedToDate`: ≥ 0,9 "on_track", ≥ 0,7 "at_risk", < 0,7 "behind". Oran yuvarlanmamış tahminle hesaplanır (4 ondalık).
- **AN15 ile ilişki:** nokta tahmini AN15'in formülüdür; ikisi çoğunlukla uyumlu ama eşdeğerlik iddia edilmez. Farklar: AN15 şüpheli günü olan ayları atlar, yalnız APPROVED/ACTIVE ve mock olmayan hedefleri okur, 56 gün alt sınırı yoktur; tempo her izlenen hedefi kapsar, 56 gün ister ve tahmin yoksa doğrusal pay yedeğine düşer. Bu yüzden bir hedef Goals'ta "At risk" görünüp AN15 bulgusu üretmeyebilir.
- **Tahmin yöntemi:** `monthToDate + kalan her gün için son 8 haftanın aynı hafta günü medyanı` (şüpheli ve tatil günleri hariç, en az 3 değer; yoksa o gün 0). Hiçbir kalan günün tabanı yoksa `no_baseline` (tahmin yok). Aralık: ±1,96·sd(son 28 günün artıkları)·√kalanGün, en az 14 artık gerekir; alt sınır `monthToDate`'ten küçük olamaz. 56 günden az geçmişle tahmin gösterilmez. Eğilim terimi ve yıllık mevsimsellik yoktur (plan §3.7 ikisini istiyordu; bkz. §11).
- **Geriye dönük test:** `backtestForecast` ve `prisma/ga-forecast-backtest.ts`; çalıştırma: `npm run db:report:ga-forecast <projectId>`. Ay sonu hatası ≤ %20 hedefi sahibin mülkünde **doğrulanmalı**; senaryo yalnız sentetik veride gösterildi. Betik canlı veritabanını yalnız okur ve yalnız ay anahtarları, kontrol noktaları ve hata yüzdelerini basar.
- Ertelenenler: oran hedefleri ve olay başına hedefler.

## 7. Next month plan

- Taban: hedef aydan önceki son en çok 3 tam ayın (en az 2) günlük ortalaması × hedef ayın gün sayısı.
- Gerçekçi = taban × mevsim katsayısı (geçen yılın hedef ayı / ondan önceki 3 ay; 0,7–1,4 aralığına sıkıştırılır).
- Önerilen aralık: gerçekçi × 1,10 ile × 1,15; önerilen = `niceTarget(gerçekçi × 1,10)`.
- Taban çok küçükse metrik atlanır: oturum < 30/ay, key event < 10, gelir ≤ 0.
- Hedef ay kuralı: proje saatinde gün ≤ 10 → içinde bulunulan ay; aksi halde gelecek ay. Aylık günü 10'dan büyük olan bir proje hep gelecek ay planı alır.
- "Use these targets" seçili önerileri `ProjectGoal`'a yazar (metricKey'e göre upsert; ACTIVE, `approvedByType` USER, öncelik 2) ve yalnız SAKLANAN kartın önerilerinden: istemciden yalnız `metricKey` seçimi okunur ve kartın önerileriyle kesiştirilir. Geçmiş aya ait planı reddeder ("This plan is for a past month."). Yazılan hedefler GA-F4'ün AN15'ini o proje için etkinleştirir; `ProjectGoal`'da dönem sütunu olmadığından "takvim ayı" bir kuraldır, ve Goals'ta düzenlenen hedef sonraki aylar için de geçerlidir.
- "For content and ads" bölümü plan kartında durur. `idea-context.ts` içindeki "Best converting topics" satırı ertelendi.

## 8. Ayarlar

Settings → Autonomy → "Website reports" kartı (yalnız `gaReportsEnabledFor(projectId)` iken; kendi `ActionForm`'u var). Proje başına tek `GaReportSettings` satırı; satır yoksa varsayılanlar geçerli. Aralık dışı değer sıkıştırılmaz, varsayılana döner.

| Alan                             | Varsayılan      | Açıklama                                                                                                                                 |
| -------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `weeklyEnabled`, `weeklyWeekday` | açık, Pazartesi | Haftalık rapor ve günü                                                                                                                   |
| `monthlyEnabled`, `monthlyDay`   | açık, 2 (1–28)  | Aylık rapor ve "Next month plan"                                                                                                         |
| `pulse`                          | `notable`       | `notable` ya da `off`                                                                                                                    |
| `alertChat`                      | açık            | Kritik GA uyarısını sohbete kart olarak yaz                                                                                              |
| `alertTelegram`                  | açık            | "Send a short Telegram message…" anahtarı; `SiteAlerts.notifyIfDue` yalnız `source: "GA4"` için okur (GA-F5 Telegram'ı kendisi çağırmaz) |

Sohbeti arşivlemek raporları durdurmaz; haftalık, aylık, plan ve uyarı gönderileri ARCHIVED/DONE `wkga_` sohbetini yeniden açar (ACTIVE), nabız kapalı sohbeti atlar. Raporlar Settings'ten kapatılır; kart bunu söyler.

## 9. Yüzeyler

- **Recents → "Website analytics"**: kartlar "Weekly website report · Sep 28 – Oct 4", "Website pulse · Mon, Oct 5", "Monthly website report · September 2026", "Next month plan · October 2026", "Tracking alert: …". Sohbet ilk kartla birlikte, gönderi işleminin içinde oluşur; kullanıcının başlattığı Analytics modülü sohbetlerine hiçbir zaman yazılmaz.
- Haftalık, aylık ve plan kartı sohbette kompakt kart; tıklayınca sağ panelde tam açılır. "Show full report" haftalıkta kapalı, aylıkta açık; "Next steps" ve notlar her zaman görünür.
- **Düğmeler:** Copy / Markdown / "Print / PDF" (haftalık, aylık, plan; nabız ve uyarı yalnız kopyalanır); "Use these targets"; bulgularda Accept / Dismiss (sonra "Saved"; yalnız `insights` açık ve anlık görüntüde durum OPEN iken); "Mute for 7 days"; "Reconnect".
- **`/projects/[id]/site` → "Reports"**: son 12 haftalık, aylık ve plan kartı; her birinde "Open in chat" ve dışa aktarma. Yalnız `GA_REPORTS` açıkken.
- **Brand Brain → Goals:** `web.*` hedeflerinde tempo hapı; ayrıntıda "Progress this month".
- **Settings → Autonomy:** "Website reports" kartı.
- **Dışa aktarma:** `lib/website-analytics/reports/export.ts` (Markdown, düz metin, `<header>` içeren bağımsız yazdırma HTML'i; tek blok listesinden, ikisi ayrışmaz; Markdown'da `|` kaçışlanır, `<` `\<` yazılır, yazdırmada her dize `escapeHtml`'den geçer). İstemci yardımcıları `copyToClipboard` / `downloadText` / `printHtml`.

## 10. Limited Use ve gizlilik

- Operatör rapor içeriğini görmez ve `/health`'te kart yoktur; yalnız `ga.reports` heartbeat'i, sayaçlar ve hata kodları.
- Telegram'a Google verisi gitmez (uyarı metni sabit ve rakamsızdır; GA-F3).
- LLM sınırları: toplu sayılar ve en çok 20 maskeli dizge; anlatı ve çıktı saklama dışında sağlayıcıda tutulmaz ve model eğitiminde kullanılmaz.
- **Saklama** (gizlilik metniyle uyumlu): nabız ve uyarı kartları 95 gün; haftalık, aylık ve plan kartları 400 gün. Kartlar açılış sayfası, olay adı, maskeli kampanya satırı, kaynak ve site içi arama terimi taşır; açıklanan saklama süresi 400 gündür. Yalnız toplamlar, kanallar ve ilk 50 açılış sayfası 36 ay için açıklanmıştır. Temizlik günlük çalışır: `claimPeriodic('ga.reports.retention', 24 sa)`, yalnız `GA_REPORTS` açık ve `gaGlobalWorkAllowedHere()` iken; `command.deleteMany` ile SYSTEM + kimlik öneki + `createdAt`.
- **Disconnect ve yetim bağ süpürmesi** (`deleteGaReportDataForCredential`, `deleteGaReportData`; bayraktan bağımsız): `wkga_` sohbetindeki `garep_*` SYSTEM komutlarını siler, kullanıcının mesajı ya da gönderisi kalmadıysa sohbetin kendisini de siler, `web.*` hedeflerinin `currentValue`'sunu boşaltır, `GaGoalProgress`'i siler. `GaReportRun` ve `GaGoalProgress` bağla birlikte cascade ile de gider. Kullanıcının kendi mesajları (ve varsa sohbet), hedeflerin kendisi ve hedef değerleri ile `GaReportSettings` kalır. Kullanıcının sohbet turlarında modelin GA sayılarını aktardığı yanıtlar silinmez; bu GA-F4 ile aynıdır, hukuki inceleme gerektirirse tüm Work silinmelidir.
- Gizlilik sayfasındaki yeni paragraf ve veri silme sayfasındaki yeni paragraf buna karşılık gelir (testli).

## 11. Kararlar ve sapmalar

- **Migration var:** plan "Migration: Yok" diyordu; ayar, deneme sayacı, işaretçiler ve tahmin için uygun JSON alanı yoktu (`ProjectGoal`'da JSON ya da dönem sütunu yok, değiştirilmedi).
- **`web.*` anahtarları** (`ga.*` yerine): GA-F4 AN15 var olan sözleşmedir ve GA-F5'in yarattığı hedefleri görmelidir.
- **Pazartesi öğleden sonra gerçeği:** "Pazartesi 08:00" rapor pratikte Pazar verisi gelince çıkar; GA-F4'ü beklerken 24 saat kadar geç olabilir. Günlük senkron bir hafta bozuksa hafta 6 gün sonra bayat olarak atlanır; senkron sorununu GA-F3 MH24 bildirir.
- **Google YoY çağrısı yok:** geçen yıl karşılaştırması yalnız ambardan (GaDailyTotal 400 gün, ay yedeği GaMonthlySummary). Plandaki isteğe bağlı YoY doğrulama çağrıları kaldırıldı.
- **Tek tick adımı** `ga-reports` (plandaki ayrı işler birleşti).
- **GK17 yalnız anlatıya uygulanır** (sahip onayı gerekir): anlatı projenin içerik dilinde; kart bölümleri, etiketler, sohbet özeti ve dışa aktarma İngilizce arayüz metni kalır, yerelleştirilmiş dışa aktarma etiketleri ertelendi.
- **Tahmin:** eğilim terimi ve yıllık mevsimsellik yok; mevsimsellik yalnız plan hedef önerisinde.
- **Saklama:** aylık ve plan kartları 36 ay değil 400 gün (kartlar ayrıntı taşır; gizlilik paragrafı bunu söyler; sahip onaylamalı).
- **Plan hedef ayı kuralı** (gün ≤ 10 → içinde bulunulan ay).
- **Ertelenenler:** `idea-context.ts` "Best converting topics" satırı; Signal, fikir ya da BrandLearning yazılmaz (GA-F4 sahibidir); `/health` kartı yok.
- Ayar kartı Autonomy sekmesinde, çünkü yeni sekme `SETTINGS_SUB_KEYS` ve yönlendirme testlerini değiştirirdi; SC-F5 de Search ayarlarını getirirse ikisi ortak bir sekmeye taşınabilir.
- Nabız GA-F3'ün şüpheli gün işaretlemesini beklemez; bir takip kesintisi gününde GA-F3 çalışmadan nabız "olağandışı" diyebilir, sonraki haftalık raporun ölçüm bölümü tabloyu düzeltir.

## 12. Testler

Kabul ölçütleri ve karşılıkları:

| Ölçüt                              | Test                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Haftalık rapor Pazartesi çıkar     | `server/website-analytics/reports/runner.integration.test.ts`                |
| Her sayı ambara dayanır            | `runner.integration.test.ts` + `lib/website-analytics/reports/facts.test.ts` |
| Gönderilmiş kart değişmez          | `runner.integration.test.ts`                                                 |
| `currentValue` her gün güncellenir | `goals.integration.test.ts`                                                  |
| Tahmin ≤ %20                       | `forecast.test.ts` + betik (sahibin mülkünde **doğrulanmalı**)               |
| Aylık rapor dışa aktarılır         | `export.test.ts` + `website-report-card.test.ts`                             |
| Yükselen uyarı kartı               | `runner.integration.test.ts`                                                 |

Birim: bayrak, zamanlama, ayar, kart okuyucu, bölümler, nabız, gerçekler ve sohbet özeti, tahmin, tempo, plan, dışa aktarma, anlatı, runner, kart ve arşiv çizimi, eylemler. Entegrasyon testleri (website-chat, inputs, goals, cleanup, runner) gerçek Postgres ister ve CI ya da tek kullanımlık veritabanında koşar.

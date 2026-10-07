# Website içgörüleri: Google Analytics analiz motoru (GA-F4)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §3.6, §6.2, §6.3, §9 GA-F4. Ambar: [website-analytics.md](website-analytics.md). Ölçüm sağlığı (şüpheli günler, kritik sorun kapısı): [measurement-health.md](measurement-health.md). Bağlantı ve Disconnect: [google-connections.md](google-connections.md). Arama tarafının eşi: [search-opportunities.md](search-opportunities.md).

## Durum (6 Ekim 2026)

Kodlandı, hepsi bayraklı (`GA_INSIGHTS`), canlıda denenmedi. Tablolar: `GaFinding`, `GaAnalysisRun` (migration `20261006213000_add_ga_finding`).

## 1. Ne yapar

GA-F4, GA-F2 ambarının üstünde çalışan deterministik bir analiz motorudur. AN1–AN12 ve AN15 kuralları kodda, istatistik kapılarından geçerek "ne değişti" (anomali, ayrıştırılmış değişim, AI asistan trafiği) ve "nerede daha iyi olabilir" (açılış sayfası, kanal, mobil, kampanya, site araması, 404, içerik, mağaza hunisi, hedef temposu) bulgularını üretir; AN16 (tatiller ve mevsimsellik) bulgu üretmez, diğerlerini düzeltir. Her bulgu tarihli bir `GaFinding` satırıdır ve tam bir yaşam döngüsü vardır: Accept → Mark done → önce/sonra ölçümü (WORKED / DIDNT / INCONCLUSIVE). Yapay zekâ sayı üretmez: yalnız en önemli bulguları açıklar, fikir önerir ve sohbette soruları yanıtlar; yazdığı her sayı number-check'ten geçer.

## 2. Bayraklar ve açılış

- `GA_INSIGHTS=off|shadow|on` (çağrı anında okunur; eksik ya da bilinmeyen değer `off`). `GA_SYNC=true` şarttır, yoksa etkin kip `off`'tur.
  - `off`: hiçbir yeni sorgu yok, sohbet araçları yok, eski `google-analytics-scanner` GA kısmı aynen çalışır.
  - `shadow`: `ga-analyze` ve `ga-finding-evaluate` çalışır, bulgular `mode: "shadow"` ile saklanır. Sinyal, fikir, LLM çağrısı, öğrenme yok; kullanıcıya hiçbir şey görünmez. Operatör /health kartını ve Website sayfasının inceleme kipini (`?insights=review`) görür.
  - `on`: hepsi; tarayıcı GA kimliklerini atlar.
- `GA_INSIGHTS_PROJECTS` (virgüllü proje kimlikleri): `GA_INSIGHTS=shadow` iken bu projeler `on` gibi davranır (tarayıcı atlaması dahil). Liste doluyken sohbet araçları genel olarak listelenir ama listede olmayan projede `execute` `status: "off"` döner.
- Yararlandığı bayraklar:
  - `GA_WEEKLY`: AN8 (site_search haftalık dilimleri) ve 95 günden eski pencereler. Kapalıyken AN8 hiç çalışmaz; landing_page DAY dilimlerinde boşluk varsa kapsam kapısı AN3'ü DIRECTIONAL'a indirir.
  - `GA_HEALTH`: şüpheli günler ve kritik sorun kapısı; kapalıyken ikisi de boş / yanlış.
  - `GA_WEBSITE_PAGE`: listeleri ve inceleme kipini taşıyan Website sayfası.
- Geliştirme koruması `GA_SYNC_DEV_PROJECTS` (var olan): canlı veritabanını paylaşan dev süreci yalnız bu projeleri analiz eder, değerlendirir, açıklar ve fikir üretir; kısıt sorgunun `where` koşulundadır. Paylaşılan kilit (`claimPeriodic`) almaz, `ga.analyze` / `ga.findings.*` heartbeat'lerini yazmaz, saklama çalıştırmaz; değerlendirici dev'de süreç içi 30 dakikalık sınırla çalışır.
- Mock: `AGENTELSE_PROVIDER_MODE=mock`'ta canlı sohbet sorguları `mockGaReport`'a gider, Google çağrılmaz. `isMock` bağlar `isMock=true` bulgu üretir; sinyal, fikir ve öğrenme üretmez. `AGENTELSE_REASONING_MODE=mock`'ta açıklama saklanmaz; website fikirleri `buildMock` ile `isMock` kaydedilir.

`.env.example` satırları (GA bayrakları bloğunun altına, `# GA-F4 analiz motoru (docs/website-insights.md): off | shadow | on; GA_SYNC=true gerektirir`):

```
GA_INSIGHTS=off
GA_INSIGHTS_PROJECTS=
```

Açılış sırası:

1. Sahip `20261006213000_add_ga_finding` için `prisma migrate deploy`'u yeni bir terminal sekmesinde tek satırla çalıştırır.
2. Deploy.
3. Railway'de `GA_INSIGHTS=shadow` (inceleme kipi için `GA_WEBSITE_PAGE=true` gerekir).
4. Sahip, inceleme projelerinin workspace üyesi olur: GK16 agentelse.com mülkü ve izin veren 1–2 müşteri projesi. İnceleme bağlantıları yalnız orada çalışır (`requireProjectAccess`'te operatör istisnası yok).
5. 2 hafta sonra /health → "Website insights (Google Analytics)" → "Review" ile 30 bulgu işaretlenir ("Useful" / "Not useful").
6. İsabet ≥ %70 → `GA_INSIGHTS=on`, ya da önce yalnız `GA_INSIGHTS_PROJECTS`.

Geri alma: `GA_INSIGHTS=off`; veri kaybı yok (satırlar kalır, okunmaz; saklama bayraktan bağımsız sürer: `GaFindingRetention.runWhileOff`).

## 3. Kurallar

Kaynak: `src/lib/website-analytics/analysis/registry.ts` (başlık, liste, yineleme, değerlendirilebilirlik, TTL, sürüm, sinyal, kapsam raporu). Kural dosyaları saftır (`anomaly.ts`, `changes.ts`, `landing-pages.ts`, `channels.ts`, `devices.ts`, `audience.ts`, `ai-referrals.ts`, `site-search.ts`, `content.ts`, `ecommerce.ts`, `goals.ts`); kapılar merkezde (`run-rules.ts`). W28 = Pazar'da biten 28 günlük pencere (şüpheli günler yükleyicide çıkarılır). "rest" = site toplamı eksi konu. Haftalık değer = 28 günlük sayı / 4.

| Kural                    | Girdi (ambar, pencere)                                                 | Eşik ve kapılar (özet)                                                                                                                                                                                                                                                   | Tür                               | Yineleme                 | Değerlendirilir | Sinyal                                                             | Liste         | Etki / impactShare                                                |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------ | --------------- | ------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------- |
| AN1 Anomali              | GaDailyTotal, kanal DAY dilimleri; hedef gün (ve hafta kipi)           | Aynı hafta günü, 8 hafta, şüpheli/tatil hariç ≥ 4 değer; robust z ≥ 3 SIGNIFICANT, 2–3 DIRECTIONAL; medyan oturum ≥ 20, KE ≥ 3, gelir için işlem ≥ 3; tatil/şüpheli hedefte bulgu yok; geçen yılın (−364) aynı yönlü sapması bastırır; son 3 gün her gün yeniden bakılır | ANOMALY                           | event                    | hayır           | —                                                                  | What changed  | etki yok; `                                                       | değer − medyan | / max(1, 7·medyan)`(hafta:`/ max(1, medyan)`) |
| AN2 Değişim ayrıştırma   | Kanal ve site geneli ilk 10 açılış sayfası; WoW, YoY, MoM (gün başına) | Metrik: max(KE) ≥ 30 ise keyEvents, değilse sessions; Poisson p < 0.05 ve \|Δ%\| ≥ 10; iki aralıkta tatil/şüpheli gün yok; WoW'da mevsimsel eşleşme yok; yalnız SIGNIFICANT saklanır                                                                                     | CHANGE                            | event                    | hayır           | var (en büyük bileşen Organic Search ise SEO, değilse PERFORMANCE) | What changed  | etki yok; `                                                       | Δ              | / max(1, önceki)`; düşüş ≥ %25 WARN           |
| AN3 Açılış sayfası       | W28 landing                                                            | Eşik = max(100, p75 oturum). CRO: oturum ≥ eşik ve oran < 0,5·rest. Promote: KE ≥ 10, 100 ≤ oturum < eşik, oran ≥ 1,5·rest. SIGNIFICANT: p < 0.05, BH kabul, oturum ≥ 200, restKE ≥ 10. Tur başına 3 CRO + 2 promote                                                     | OPPORTUNITY (CRO) / WIN (promote) | condition                | evet            | yalnız promote (PERFORMANCE)                                       | Opportunities | haftalık KE farkı (Byar aralığı); `perWeek / max(1, haftalık KE)` |
| AN4 Kanal kalitesi       | W28 channel, oturum ≥ 200 (Unassigned hariç)                           | Etkileşim (iki oran testi) ya da KE oranı (rate-ratio, restKE ≥ 10); oran ≤ 0,70 altında RISK, ≥ 1,30 üstünde WIN; BH tüm kanal testlerinde; en çok 3                                                                                                                    | RISK / WIN                        | condition                | yalnız "below"  | —                                                                  | Opportunities | haftalık engagedSessions ya da KE farkı                           |
| AN5 Mobil açığı          | W28 device mobile/desktop                                              | İkisi de oturum ≥ 200, desktop KE ≥ 10; mobil/desktop oran < 0,6; p < 0.05 SIGNIFICANT                                                                                                                                                                                   | OPPORTUNITY                       | condition                | evet            | —                                                                  | Opportunities | `(0,8·desktop − mobil)·mobil oturum` haftalık                     |
| AN6 Geri dönen ziyaretçi | new_returning DAY dilimleri, 8 hafta                                   | Her hafta ≥ 500 oturum; ilk 2 ile son 2 hafta payı farkı ≥ 5 puan; p < 0.05 SIGNIFICANT                                                                                                                                                                                  | RISK                              | condition                | hayır           | —                                                                  | What changed  | etki yok; `düşüş puanı / 100`                                     |
| AN7 AI asistan trafiği   | W28 ve önceki W28 sourceMedium                                         | Asistan oturumu ≥ 10; önceki < 3 ise ilk görülme (DIRECTIONAL); değilse büyüme ≥ %50 ve p < 0.05                                                                                                                                                                         | WIN                               | event                    | hayır           | SEO                                                                | What changed  | etki yok; `asistan / max(1, site oturumu)`                        |
| AN8 Site araması         | site_search WEEK dilimleri (≤ 4 hafta, `GA_WEEKLY`)                    | Maskeli terimler; arama ≥ 5, ilk 10                                                                                                                                                                                                                                      | OPPORTUNITY, DIRECTIONAL          | condition                | hayır           | —                                                                  | Opportunities | etki null (karar); `min(1, arama / oturum)`                       |
| AN9 Eksik sayfalar       | Geçen haftanın pages tablosu                                           | 404 başlık/yol kalıpları (TR/MK/EN/…); görüntülenme ≥ 10, ≥ 30 SIGNIFICANT                                                                                                                                                                                               | RISK                              | condition                | evet            | —                                                                  | Opportunities | haftalık görüntülenme                                             |
| AN10 İlgi çeken içerik   | Ayın landing tablosu                                                   | İçerik yolu kalıbı, oturum ≥ 50; etkileşim oranı ≥ 1,2·site olan ≥ 2 satır; ilk 5                                                                                                                                                                                        | WIN, DIRECTIONAL                  | condition (aylık)        | hayır           | —                                                                  | Opportunities | etki null (karar); 0,1                                            |
| AN11 Mağaza hunisi       | events haftalık, 4 temiz taban haftası (≥ 2)                           | Adıma giren ≥ 50 (iki tarafta); düşüş ≥ %20 ve p < 0.05; purchase adımında WARN; AOV yalnız kanıtta                                                                                                                                                                      | RISK, SIGNIFICANT                 | event                    | evet            | —                                                                  | Opportunities | haftalık kayıp satın alma; `min(1, düşüş% / 100)`                 |
| AN12 Kampanya kalitesi   | W28 campaign, oturum ≥ 50                                              | KE oranı ≤ 0,5 altında RISK, ≥ 1,5 ve KE ≥ 5 üstünde WIN; BH kampanyalarda; SIGNIFICANT için oturum ≥ 200, restKE ≥ 10; `agx-` Agentelse kampanyası işaretlenir; en çok 3                                                                                                | RISK / WIN                        | condition                | yalnız "below"  | —                                                                  | Opportunities | haftalık KE farkı                                                 |
| AN15 Hedef temposu       | ProjectGoal (`web.*`), GaDailyTotal                                    | Ayın ≥ 5. günü, ayda şüpheli gün yok; tahmin = ay başından beri + kalan günlerin aynı gün medyanı; tempo < 0,9 (< 0,8 SIGNIFICANT, < 0,75 WARN)                                                                                                                          | RISK                              | event (ay sonunda biter) | hayır           | —                                                                  | Opportunities | eksik hedefin haftalık payı; `(hedef − tahmin) / hedef`           |

Ortak kapılar (`run-rules.ts`, `applyQualityGates`):

- Pencere kuralları (AN3, AN4, AN5, AN7, AN12) `window28.usedDays ≥ 21` ister; yoksa aday yok.
- Kuralın raporunun kapsamı `usedDays`'ten azsa (örneğin `GA_WEEKLY` kapalı ve landing_page gün dilimleri eksik) aday DIRECTIONAL'a iner.
- GA-F3 özetinde kritik sorun varsa (`loadMeasurementSummaryForLink(...).critical > 0`) her aday DIRECTIONAL'a iner. Kapı SIGNIFICANT'ı indirdiyse WARN de INFO olur.
- Canlı kipte haftalık çalışmada "Opportunities" listesinden bağ başına en çok 3 yeni satır açılır (önceliğe göre; plan §1.1 "en fazla 3 öneri"). Gölge kip hepsini (genel tavan 20) saklar.

Ertelenenler (`GA_DEFERRED_RULES`): AN16 ve AN11 sepet değeri (AOV) değişimi; AOV kanıtta tutulur, değerlendirilmez. AN13 (Meta çapraz kontrolü) ve AN14 (Google Ads) GA-F6'da gerçek kural oldu ve `GA_UTM` açıkken koşar: [website-attribution.md](website-attribution.md).

AN16 bir değiştiricidir: tatil günlerini tabanlardan çıkarır, tatil haftasında SIGNIFICANT AN2'yi engeller, pencere bulgularına sabit "Includes a public holiday." cümlesini ekler; mevsimsellik AN1 ve AN2'de geçen yılın aynı dönemine bakar.

Tatil ülkesi (`holidayCountryOf`): `Project.countries` doluysa ya da `Project.country` 'US' değilse `Project.country`; aksi hâlde null (migration varsayılanı 'US' sessizce ABD tatillerini düşürmesin). Desteklenen ülkeler: TR, MK, RS, AL, BA, XK, BG, GR, DE, GB, US. Sabit tarihler ve iki Paskalya hesabı elle yazılıdır; bayram (Ramazan/Kurban) tablosu 2024–2028 içindir (doğrulanmalı). Gözlemlenen yerine-tatil yalnız GB'de vardır.

## 4. İstatistik (`stats.ts`, `baseline.ts`, `decompose.ts`)

- **Robust z:** `(x − medyan) / max(1,4826·MAD, taban)`. Poisson tabanı: sayılarda `√max(medyan, 1)`; KE oranında `√max(medKE, 1) / max(medOturum, 1)`; gelirde `medGelir / √max(medİşlem, 1)`.
- **KE oranları:** Poisson rate-ratio testi (oturum maruziyet), çünkü key event sayısı oturumdan büyük olabilir (AN3, AN4 KE oranı, AN5, AN12 ve sonuçları).
- **İki oran z-testi** (havuzlanmış) yalnız isabet ≤ deneme olan yerlerde: engagedSessions/sessions (AN4 etkileşim), geri dönen payı (AN6), huni adımları (AN11).
- **Benjamini-Hochberg** FDR %10: aileler sayfa (AN3 varyant başına), kanal (AN4 tüm testler), kampanya (AN12). SIGNIFICANT = ham p < 0.05 VE BH kabul VE hacim kapıları.
- **Poisson oran testi:** AN2, AN7, AN3 promote sonucu (sayılar ve gün sayıları).
- **Aralıklar:** Wilson (oranlar, [0, 1]'e kıstırılır); Poisson için k ≤ 4'te kesin tablo (alt 0, 0.0253, 0.2422, 0.6186, 1.0899; üst 3.6889, 5.5716, 7.2247, 8.7673, 10.2416), k ≥ 5'te Byar.
- **Ayrıştırma (AN2):** satır başına `rb = vB/sB`, `ra = vA/sA`; hacim etkisi `(sA − sB)·rb`, oran etkisi `sA·(ra − rb)` (sessions metriğinde oran 0). |toplam|'a göre ilk 10, kalan `other`. Değişmez: `Σbileşen + other + residual = toplam değişim` (`residual = delta − Σilk10 − other`). MoM'da önce gün başına bölünür.

## 5. Veri modeli

`GaFinding` alanları: kural (`ruleKey`, `ruleVersion`), `kind`, konu (`subject`, `subjectKey`), dönem (`periodGrain`, `periodKey`, `periodStart`, `periodEnd`), `severity`, `confidence`, `status`, `mode` (shadow | live), `isMock`, `priority`, `evidence` (Json, sürümlü, `stored.ts` ile okunur), `impact`, `explanation` / `explainedAt` / `rank`, `fingerprint` (unique), `previousId`, `occurrences`, `signalId`, `ideaIds`, karar alanları (`acceptedAt/By`, `dismissedAt/By`, `doneAt`), değerlendirme (`evaluateAfter`, `evaluatedAt`, `outcome`, `outcomeEvidence`), kapanış (`closedReason`, `closedAt`), operatör incelemesi (`reviewVerdict`, `reviewedAt/By`).

Yaşam döngüsü (her kapanış `closedAt` + `closedReason` yazar):

```
OPEN ──Accept──▶ ACCEPTED ──Mark done (yalnız evaluable)──▶ DONE ──değerlendirme──▶ EVALUATED ('evaluated')
 │                  │
 │                  ├─Dismiss──▶ DISMISSED ('dismissed')
 │                  └─60 gün Done yok──▶ EXPIRED ('ttl')
 ├─Dismiss──▶ DISMISSED ('dismissed')
 ├─TTL──▶ EXPIRED ('ttl')          (AN15 ay sonunda)
 ├─yeni hafta (condition)──▶ SUPERSEDED ('newer')
 ├─canlı koşu gölge satırı alır──▶ SUPERSEDED ('shadow')
 └─RESOLVED ('measurement' | 'revised' | 'recovered')
```

- Parmak izi: `${linkId}:${ruleKey}:${subjectKey}:${periodKey}`. `subjectKey` konunun FNV-1a 64 bit özetidir (16 hex); parmak izi ve sinyal `externalRef`'i sayfa yolu taşımaz. linkId içerdiği için birincil GA mülkü değişince yineleme sayımı baştan başlar.
- Yineleme:
  - Condition kuralları (AN3, AN4, AN5, AN6, AN8, AN9, AN10, AN12): yeni satır aynı bağ+kural+konunun son OPEN satırını SUPERSEDED yapar, `previousId` ve `occurrences + 1` alır. Reddetme 56 gün bastırır (önem daha yüksekse bastırmaz).
  - Event kuralları (AN1, AN2, AN7, AN11, AN15): her dönem kendi satırı; asla supersede edilmez, reddetme yalnız o dönemin parmak izini etkiler; eskiler TTL ile kapanır.
  - Değerlendirilebilir bir kuralda ACCEPTED ya da DONE satır, kullanıcı üzerinde çalışırken aynı konunun yeni adaylarını bastırır.
- Sıra güvenliği: adaylar `periodStart` artan sırada işlenir; condition kuralında son satırdan eski dönem `stale` döner ve atlanır; daha yeni satır eski dönemle kapanmaz.
- Gölge → canlı: canlı koşu OPEN gölge satırla aynı parmak izine denk gelirse onu tek işlemde kapatır (SUPERSEDED 'shadow', parmak izi `…#shadow:<id>`) ve canlı satırı açar. Gölge satır hiç kullanıcıya görünmez.
- RESOLVED 'measurement' yalnız OPEN satırlarda ve şüpheli günleri kendisi dışlamayan kurallarda (AN1, AN2, AN9, AN15): sonradan şüpheli olan gün çözülür. 'revised' (AN1 günü yeniden bakıldığında normal) ve 'recovered' (AN15 tempo düzeldi) yalnız günlük kısım o çağrıda çalıştıysa.
- Değerlendirme pencereleri: önce `[doneGün − 28, doneGün − 1]`, sonra `[doneGün + 7, doneGün + 34]` (Done'dan sonraki 7 gün dışarıda), şüpheli günler hariç. `evaluateAfter = doneAt + 36 gün` ve `completeThrough ≥ after.to`; veri yetmezse `doneAt + 50 gün`e kadar bekler, sonra INCONCLUSIVE. Kontrol sitenin geri kalanıdır (AN3 promote'ta site oturum artışı). > 7 şüpheli gün → INCONCLUSIVE `tracking_issue`. Yalnız WORKED öğrenme yazar.
- `GaAnalysisRun` (bağ başına bir satır): CAS kilidi (`leaseUntil`, `leaseOwner`), `lastCheckedAt` (adil sıra), `lastDailyDay/At`, `lastWeek/At`, `lastMonth`, `lastExplainedWeek`, `lastError` (yalnız hata sınıfı), `stats` (kural başına aday/yazılan/atlanan).

## 6. İşler

- **`ga-analyze`** (`GaInsights.runDue(5)`, `runner.ts`): tick başına ≤ 5 bağ, bağ başına CAS kilidi.
  - Adaylar `where`'de süzülür: birincil, `lastDailyDate` dolu, sağlığı AUTH/NEEDS_PERMISSION/ACCESS_LOST/GONE/API_DISABLED olmayan, proje PAUSED/CLOSED değil, dev kapsamı. `GaAnalysisRun.lastCheckedAt` artan (null önce); bakılan her bağ `lastCheckedAt = now` alır, hiçbir bağ aç kalmaz.
  - Günlük: `completeThrough` günü için AN1 ve AN15, son 3 gün yeniden.
  - Haftalık: mülk saatiyle Pazartesi 06:30'dan sonra VE `completeThrough ≥ geçen Pazar` olunca AN2–AN12; kaçan hafta atlanır. Aylık: AN2 MoM ve AN10.
  - Ardından (yalnız `on`) açıklama, sinyaller.
- **`ga-finding-evaluate`** (`GaFindingEvaluator.runDue(20)`, `evaluator.ts`): günlük değerlendirme + kapanıştan 24 ay (730 gün) sonra silme; ayrıca `createdAt < now − 760 gün` her şeyi siler (`retention.ts`).
- Heartbeat anahtarları: `ga.analyze`, `ga.findings.evaluate`, `ga.findings.retention`. Yalnız üretimde yazılır (dev süreci yazmaz).
- Bayrak kapalıyken iki adım da sorgusuz 0 döner; odak ayarı kapatmaz; legacy-loop listelerinde yoktur.

## 7. LLM

- **Açıklama** (`explain.ts`, istem `ga-findings-explain.ts`): haftada bir, en önemli 5 bulgu, projenin dilinde, tek çağrı. Her cümle number-check'ten geçer; geçmeyen atılır. Mock modda hiçbir şey saklanmaz.
- **Website fikirleri** (`website-ideas.ts`, istem `idea-website.ts`, purpose `idea.website`): en çok haftada bir lite çağrı; marka dilinde makale fikri gerektiği için modelsiz değil (GK17). En çok 3 fikir bekler, istemde ≤ 11 maskeli dizge.
- **Limited Use:**
  - Her çağrıya toplu sayılar ve en çok 20 maskeli yol ya da terim gider (testli).
  - Sinyal ve öğrenme metni yol, terim, kampanya ve sayı taşımaz; yalnız GA varsayılan kanal adı ya da AI asistan adı olabilir (sinyaller ajans bulgusu/görev olur, görev başlıkları Telegram'a gidebilir).
  - GA-F4 uyarı (SiteAlerts) üretmez, Telegram'a hiçbir şey göndermez.
  - Operatör /health'te genel sayaçları ve yalnız üyesi olduğu projelerde genel başlıkları görür.

## 8. Yüzeyler (nereden bakılır)

- **`/projects/[id]/site`** (Explore → "Website", `GA_WEBSITE_PAGE`): rapor gövdesinin altında, ölçüm sağlığı panelinin üstünde "Insights" bölümü: "What changed" ve "Opportunities" listeleri (≤ 6, önceliğe göre). Satırda güven çipi ("Passed the statistical check" / "A likely pattern, not proven" ipucu), son 7 gün için "Preliminary" çipi ("Google Analytics may still update these days"), etki metni ve "Why this matters". Düğmeler: OPEN'da Accept / Dismiss; ACCEPTED ve değerlendirilebilirse Mark done ("Marked done. We'll measure the results.") / Dismiss.
- **İnceleme kipi** `?insights=review`: yalnız workspace üyesi olan platform operatörü; her satırda Useful / Not useful ve "Shadow" çipi; gölge satırlarda kullanıcı eylemi yok.
- **/health** → "Website insights (Google Analytics)" kartı: kip, Open (shadow) / Open (live), Reviewable, Reviewed, isabet, Links analyzed / Links due / Last run, kural başına açık sayılar ve "Review" bağlantıları (yalnız üye projeler).
- **Ideas panosu**: kaynak çipi "From your website" (küre ikonu).
- **Sohbet**: Analytics ve SEO modül sohbetlerinde ve genel sohbette dört araç: `get_website_overview`, `query_website_analytics`, `explain_website_change`, `get_measurement_health` ([chat-engine.md](chat-engine.md)). Hepsi okuma ve `external: true`; sonuçlar ≤ 20 satır; `explain_website_change` number-check'li belirlenimci İngilizce "answer" döndürür (modelin kendi metni ayrıca denetlenmez). Ambar yetmezse P1 canlı sorgu: proje başına günde ≤ 20, yalnız temel metrikler, yol boyutları maskeli, saklanmaz.

## 9. Disconnect ve silme

- Cascade (bağla birlikte): `GaFinding`, `GaAnalysisRun`.
- `deleteGaInsightDerivedDataForCredential` (`cleanup.ts`, `google-disconnect.ts`'te GA bağı silinmeden önce; Search Console kimliğinde no-op) hemen siler:
  - ga-insights sinyallerini;
  - onlardan doğan ajans bulgularını, sinyal ya da bulgusu örtüşen içgörüleri ve bu içgörülerin kullanıcının dokunmadığı fırsatlarını (NEW, REVIEWING, EVALUATED, DUPLICATE, EXPIRED, DISMISSED);
  - GA4 öğrenmelerini;
  - havuzda bekleyen (APPROVED olmayan) `website` fikirlerini.
- Kalanlar: kullanılmış fikirler (SC-F4 forget kuralıyla aynı: onaylanmış APPROVED fikir de kullanılmış sayılır, yalnız `concept.evidence` bağlantısı çıkarılır), kabul edilmiş ya da dönüştürülmüş fırsatlar. Metinleri sayı ve yol taşımaz.
- Temizlik Disconnect'i durdurmaz (hata loglanır); yarım kalan türevleri günlük `ga-retention` canlı GA bağlantısı olmayan projelerde siler (`sweepOrphanGaInsightData`).
- GA dışı sinyalleri de karıştıran bir içgörü, GA kökenli bir sinyale ya da bulguya dokunuyorsa bütünüyle silinir (Limited Use; Brand Brain'de görünür).

## 10. Yerine geçen eski kod

`google-analytics-scanner.ts`'in GA kısmı (`DECLINING_TRAFFIC`, `seo-rules.ts` `evaluateTrafficFinding`) `GA_INSIGHTS=on` iken bütünüyle, gölge kipte `GA_INSIGHTS_PROJECTS` projelerinde atlanır (`scanner-gate.ts`). Kapalıyken bugünkü davranış. Search Console kısmının kendi kapısı SC-F4'tedir ([search-opportunities.md](search-opportunities.md)); iki kapı bağımsızdır.

## 11. Testler

| Kabul ölçütü          | Test                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kural başına sınırlar | B: `anomaly`, `changes`, `audience`, `ai-referrals`, `goals`, `answer` · C: `landing-pages`, `channels`, `devices`, `site-search`, `content`, `ecommerce`, `outcomes` (`src/lib/website-analytics/analysis/*.test.ts`) |
| Ayrıştırma toplamı    | `decompose.test.ts`, `changes.test.ts`                                                                                                                                                                                 |
| İki hafta → iki bulgu | `runner.integration.test.ts` (1)                                                                                                                                                                                       |
| Tatiller              | `anomaly.test.ts`, `holidays.test.ts`, `runner.integration.test.ts` (2)                                                                                                                                                |
| Reddetme anlamı       | `lifecycle.integration.test.ts`, `lifecycle.test.ts`                                                                                                                                                                   |
| Disconnect            | `cleanup.integration.test.ts`, `google-disconnect.test.ts`                                                                                                                                                             |
| Sohbet number-check   | `website-read.integration.test.ts`, `website-read.test.ts`                                                                                                                                                             |
| Araç görünürlüğü      | `website-tools.test.ts`                                                                                                                                                                                                |
| Gölge isabeti         | Elle, /health kartı üzerinden                                                                                                                                                                                          |

Entegrasyon testleri gerçek Postgres ister (`TEST_DATABASE_URL`); CI'da koşar.

## Açık konular

- Haftalık analiz Pazar verisini bekler (mülk saatiyle Pazartesi ~16:00); günlük senkron bütün hafta bozuksa o hafta atlanır (MH24 bildirir).
- Son 7 günün verisi ön veridir: AN1 3 günü yeniden değerlendirir; AN2 yeniden koşmaz, "Preliminary" çipi taşır.
- İsabet hedefi (30'da ≥ %70) eşiklere ve sahibin yeterli projeye üye olmasına bağlı; küçük sitelerde AN1, AN3, AN4 DIRECTIONAL bulguları gürültülü olabilir. Ayar sürüm artırımıdır, migration değil.
- Tatil tablosu elle yazılı; yanlış ya da eksik tatil o gün yanlış AN1 anomalisi üretir.
- AN15, GA-F5 `web.*` hedefleri oluşturana kadar uyur.
- Katalogda kanal×açılış ya da kaynak×açılış raporu yok: AN2'nin ikinci düzeyi site geneli açılış sayfalarıdır, AN7 asistan açılış sayfalarını adlandıramaz.
- P1 canlı sohbet sorgusu müşterinin GA kotasını kullanır (günde 20 + kota yöneticisi).
- Event kuralları supersede etmediği için birkaç AN1 satırı 7 güne kadar birlikte açık kalabilir.

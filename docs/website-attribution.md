# Kapalı döngü ve reklam ölçümü: UTM, atıf, AN13/AN14, MH25 (GA-F6)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §3.8, §4, §9 GA-F6. Ambar: [website-analytics.md](website-analytics.md). Bulgular: [website-insights.md](website-insights.md). Raporlar: [website-reports.md](website-reports.md). Ölçüm sağlığı: [measurement-health.md](measurement-health.md). Bu dosya GA-F6'nın uygulanmış hâlini anlatır.

## Durum (7 Ekim 2026)

Kodlandı, bayraklı (`GA_UTM`), migration `20261006217000_add_tracked_link`. Canlıda ve tarayıcıda denenmedi; DB entegrasyon testleri tek kullanımlık Postgres'te koşturulacak.

## 1. Amaç ve bayraklar

Agentelse'in dış linklerine (Meta reklamları, Instagram bio linki) standart UTM ekler, GA4'ün kampanya dilimlerini bu linklerle Agentelse varlığına geri bağlar ve sonucu ürünün içinde gösterir. Yeni Google tablosu yoktur: atıf, MH25, çapraz kontrol ve Google Ads tablosu okuma anında `GaReportSlice` (campaign, google_ads) ve Meta aynasından hesaplanır.

| Bayrak                                      | Ne açar                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GA_UTM=true` (yeni; tam "true")            | Dış link etiketleme, "Link tracking" kartı. Atıf yüzeyleri için `GA_SYNC` de gerekir                                                                                                 |
| `GA_SYNC=true` (var)                        | Ambarı okuyan her şey: "From Agentelse", "Your ads on your website", MH25, AN13/AN14 girdisi, çıktı API'si, optimizer kanıtı, öğrenmeler. `gaAttributionEnabled = GA_UTM && GA_SYNC` |
| `GA_HEALTH` (var)                           | MH25 yalnız ölçüm sağlığı paneli çizildiğinde (onun altında) görünür                                                                                                                 |
| `GA_INSIGHTS` (var)                         | AN13/AN14 `ga-analyze` içinde koşar; off/shadow/on kipine uyar                                                                                                                       |
| `GA_REPORTS` (var)                          | Haftalık rapordaki "From Agentelse" bölümü                                                                                                                                           |
| `GA_CATALOG_CHECKS` (var)                   | `google_ads` raporu, dolayısıyla AN14 ve Google Ads tablosu                                                                                                                          |
| `META_ADS_LAUNCH_V2`, `META_ADS_SYNC` (var) | Meta reklam etiketleme yalnız lansman v2 yolunda; AD düzeyi Meta sayıları aynadan gelir                                                                                              |
| `GA_SYNC_DEV_PROJECTS` (var)                | Yerel süreç canlı veritabanını paylaşırken yalnız listedeki projeler okunur/öğrenilir                                                                                                |

Bayraklar çağrı anında okunur. `GA_UTM` kapalıyken davranış baytı baytına aynıdır ve yeni sorgu yoktur:

- `adLaunchUrlTags` sorgusuz `undefined` döner (Review spec'i `DEFAULT_URL_TAGS` kalır);
- "Link tracking" kartı, "From Agentelse", MH25 ve `loadAdsCrossCheckInput` sorgusuz null döner;
- `loadWeeklyAnalysisInput` `ads` anahtarı eklemez, haftalık rapor `agentelse` alanını yazmaz;
- optimizer kanıt okuyucusu null döner, öğrenme işi 0 döner.

Disconnect temizliği bayraktan bağımsız çalışır. Mock modda (`AGENTELSE_PROVIDER_MODE=mock`) hiçbir şey Google'a, Meta'ya ya da bir siteye gitmez; yalnız ambar, ayna ve DB okunur. Mock GA bağları öğrenme, optimizer kanıtı ve çıktı üretmez.

Flag listesi (`.env.example` sandbox'ta yazılamadığı için burada): `GA_UTM=false` (varsayılan kapalı; açmak için `GA_UTM=true`, atıf ayrıca `GA_SYNC` ister).

## 2. UTM standardı (`src/lib/utm.ts`, saf)

| Bağlam                           | source / medium            | campaign                  | content     | Not                                                                   |
| -------------------------------- | -------------------------- | ------------------------- | ----------- | --------------------------------------------------------------------- |
| Meta reklamı                     | `facebook` / `paid_social` | `agx-<plan kampanya adı>` | `agx_<kod>` | `utm_term={{site_source_name}}` (Meta makrosu; doğrulanmalı)          |
| Instagram bio linki              | `instagram` / `social`     | `agx-bio`                 | `agx_<kod>` | Hedefteki mevcut `utm_*` önce silinir (`stripUtm`), kod hep ulaşsın   |
| Facebook / LinkedIn / X / TikTok | kanal adı / `social`       | `agx-<ad>`                | `agx_<kod>` | Gelecek: `tagOutboundLink` hazır, bugün bu kanallar link yayınlamıyor |
| SEO makalesi, iç linkler         |                            |                           |             | Sitenin kendi iç linkleri ASLA etiket almaz (oturumu böler)           |

Kurallar:

- Yalnız projenin kendi alan adlarına giden linkler etiketlenir: `Project.domain` ve birincil GA bağının akış adresinin alan adı (alt alan adları sayılır). Alan adı yoksa hiçbir şey etiketlenmez.
- Var olan `utm_*` değeri asla ezilmez; yalnız eksik anahtarlar eklenir.
- Yalnız `http(s)`; Türkçe karakterler `foldForMatch` ile sadeleşir. Kampanya adı: `[^a-z0-9]+` tire olur, ≤ 40 karakter (tireden kesilir), boşsa `agx-campaign`.
- Meta linki zaten `utm_content` taşıyorsa bizim kodumuz GA'ya hiç ulaşamaz: o reklam bugünkü `DEFAULT_URL_TAGS` ile kalır (`url_tags` asla boş olmaz).

## 3. `TrackedLink` ve ayar

`TrackedLink`: etiketli her link için bir satır. `code` 6 karakter `[a-z0-9]`, bütün projelerde benzersiz (aynı GA4 mülkü iki projeye bağlı olabilir). `@@unique([projectId, entityType, entityId])` `ensureTrackedLink`'i tekrarlanabilir yapar (satır kodunu korur; çakışmada 5 yeniden deneme). `carriesCode` türetilmiştir: `parseUtm(taggedUrl).utm_content === agx_<kod>`; mevcut bir `utm_content` kazanmışsa false olur ve link koda göre atfedilemez.

Varlık anahtarları: `meta_ad` için `<commandId>:<adIndex>` (Review anında `AdsLaunch` satırı henüz yok), `instagram_bio` için `bio`. `campaignExternalId` ve `adExternalId` tembel çözülür (`AdsLaunch.campaignExternalId` ve `progress.ads[i]`) ve satıra önbelleklenir.

Ayar: `LinkTrackingSetting` (proje başına bir satır, `utmEnabled` varsayılan AÇIK; satır yoksa açık sayılır, GK10). Settings → Publishing → "Link tracking" kartı: "Add tracking (UTM) to links" anahtarı yalnız OWNER/ADMIN; Instagram bio linki üretici kartta, her proje üyesine açık. Alan adı yoksa form çıkmaz ("Add your website in the project settings to create a bio link.").

Saklama: ikisi de Google verisi taşımadığı için GA Disconnect'te KALIR; proje silinince gider ("kept until the project is deleted"). Bio linki yerinde değiştirilir.

## 4. Meta lansmanı

- Etiketler yalnız Review'da (`prepareAdsLaunchAction`) hesaplanır; Meta `validate_only` bunları sınar (`validate.ts:334`). Review "Tracking: UTM added" notunu gösterir.
- Approve (`launchAdsV2Action`) yeniden hesaplamaz: doğrulanmış spec'in kendi `urlTags`'ini kullanır. `specHash` `urlTags`'i içermez, bu yüzden Review ile Approve arasında ayar değişse bile uyuşmazlık çıkmaz.
- Mesaj reklamı, boş ya da yabancı link, `utm_content`'li link, 2048'den uzun link ve hata durumunda `DEFAULT_URL_TAGS` kalır.
- Bilinen ufak nokta: carousel reklamda tek reklam vardır ama `adLaunchUrlTags` ek postlar için de satır açar (kullanılmayan kod); atıfı bozmaz.
- Ajans zincirinin eski `META_AD_CREATE` yolu etiketlemez (`META_ADS_LAUNCH_V2`'den bağımsız erişilebilir; kreatifler `url_tags` taşımaz). "Her reklam linki UTM taşır" yalnız lansman v2 için doğrudur; MH25 bu açığı görünür kılar.

## 5. Atıf: "From Agentelse"

- Kaynak: GA `campaign` raporu (`sessionCampaignName`, `sessionSource`, `sessionMedium`, `sessionManualAdContent`), günde en çok 250 satır (sıraya göre) kırpılır; `truncated` bayrağı ve not çıkar.
- Eşleşme sırası: (1) `utm_content = agx_<kod>` bir proje linkinin kodu; (2) eski Meta `{{ad.id}}` (bugünkü `DEFAULT_URL_TAGS`) ve Meta benzeri kaynak, projede Agentelse'in açtığı bir AD satırına eşleşir; (3) bütün proje linkleri tek gruba ait olan `agx-` kampanyası; (4) kalan `agx-` kampanyaları "Other tagged links". `agx-` olmayan satırlar yok sayılır.
- Gruplar: Meta kampanyası başına bir ve diğer link başına bir.
- Başlık altı metin: "Only visits through links Agentelse tagged are counted. People who reach your site from your profile without a tagged link show up under Organic Social."
- Yerleşim: Website sayfası (`FromAgentelseSection`, rapor gövdesinin hemen altı) ve haftalık rapor (Markdown, yazdırma, Copy). LLM olgularına ve sohbet özetine ASLA girmez; kampanya adı anlatıya, sohbete, Telegram'a gitmez. Aylık raporlar değişmez.

## 6. Reklam ölçümü: "Your ads on your website"

- Karşılaştırma reklam (AD) düzeyindedir ve yalnız Agentelse'in açıp etiketlediği reklamlar için (`adExternalIds`): Meta tarafı bu reklamların AD düzeyi `AdsInsightDaily` satırlarının, projeye bağlı HER reklam hesabı üzerinden toplamıdır (180 gün saklama); GA tarafı yalnız kodla (ya da eski reklam kimliğiyle) eşleşen satırlardır (`adMetrics`). Ads Manager'da eklenen ya da F5b'nin mevcut ad set'e koyduğu reklamlar iki tarafta da yoktur.
- Her sütun kaynağını başlıkta taşır: "Spend (Meta)", "Link clicks (Meta)", "Clicks → sessions", "Results (Meta)", "Cost per result (Meta)", "Sessions (GA4)", "Key events (GA4)", "Cost per key event (GA4)". Notlar: Meta atıf penceresi (7 gün tıklama / 1 gün görüntüleme), gün ve saat dilimi farkı, yalnız etiketli reklamlar.
- "Cost per key event (GA4)" = etiketli reklamların Meta harcaması / aynı reklamların GA4 key event'leri; Meta'nın kendi "cost per result"ının yanında durur.
- Meta penceresi yalnız GA kampanya ayrıntısının okunduğu günleri sayar (şüpheli günler, HAFTA dilimi düşen günler ve dilimi olmayan günler Meta tarafında da düşer); Website sayfası kapsanan gün sayısını not eder. AN13 girdisi, GA kampanya ayrıntısı dışarıda tutulmayan günlerin %90'ından azını kapsıyorsa Meta karşılaştırması üretmez.
- `adExternalIds` boş grup "Meta numbers appear once these ads have run and synced." gösterir, bayrak yok, AN13 dışı.
- Para birimi: haftalık raporda para sütunları yalnız Meta ve GA para birimi aynıysa çıkar; değilse iki birimi söyleyen not çıkar. Aynı projede karışık Meta para birimi harcamayı null yapar ve not düşer.
- Google Ads tablosu (`google_ads` raporu): maliyet, tıklama, oturum, key event, gelir ve ROAS (yalnız Website sayfasında; haftalık raporda ROAS sütunu yok çünkü `ReportValueFormat`'ta oran yok). Gelir 0 ise ROAS null.

## 7. AN13 / AN14 (GA-F4 motorunda gerçek kurallar)

İkisi de haftalık koşul kuralı, `WINDOW28`, sinyalsiz, evaluable değil. `GA_DEFERRED_RULES` yalnız AN16 ve AN11-AOV'yi tutar.

AN13, Meta çapraz kontrolü (liste "opportunities", tür RISK, başlık "Ad clicks and website visits don't line up"):

- Yalnız kodlu reklamlarda; Meta link tıklaması ≥ 100 ve aktif gün ≥ 7.
- Tıklama→oturum kaybı > %40 ve oturum/tıklama oranının Wilson üst sınırı < 0,60 ise SIGNIFICANT.
- Sonuç farkı (> %30) yalnız web sonuçlarında (`offsite_conversion.*`), max(sonuç, key event) ≥ 10 ve Poisson p < 0,05 ile.
- Önem WARN yalnız anlamlı > %60 kayıpta, diğer INFO. Her iki pencerenin şüpheli GA günleri iki taraftan da çıkarılır. En çok 3 aday.

AN14, Google Ads maliyet/key event (liste "changed", kötüleşirse CHANGE, iyileşirse WIN, başlık "Google Ads results changed"):

- `google_ads` DAY dilimleri: window28 ve window28Previous, kampanya başına. Kapı: iki pencerede tıklama ≥ 100, key event ≥ 10, maliyet > 0.
- Test: key event/maliyet oranına `rateRatioTest`, p < 0,05, BH q = 0,10 ve |Δ maliyet/key event| ≥ %20. En çok 3. ROAS yalnız kanıttır.
- Kampanya adları Google dizgisidir: `maskGoogleText` + 80 karakter sınırı, kanıta, konu anahtarına, ayrıntıya ve olgulara girer; explain sayı denetimi bunları otomatik sayar.

Yaşam döngüsü, Accept/Dismiss, insights listesi ve rapor anlık görüntüsü GA-F4/F5 ile aynıdır. Gölge kipte yalnız gölge bulgu saklanır. AN13/AN14 operatör `byRule` sayaçlarında yalnız `gaAttributionEnabled()` iken görünür. Not: `applyQualityGates` 21 temiz gün şartını artık `report`'u olmayan kurallara (AN14) da uygular.

## 8. MH25: Agentelse UTM kapsamı

GA-F3'ün GA-F6'ya bıraktığı kontrol. UZANTI kontrolü: yalnız INFO, okuma anında hesaplanır, ASLA saklanmaz, puanlanmaz, uyarı üretmez ve Telegram'a/operatöre gitmez. Ölçüm sağlığı panelinin altında "Code MH25" kartı (PASS'ta tek soluk satır "MH25 · Agentelse links carry tracking").

- `low_coverage` (WARN): son 28 günde link tıklaması olan, Agentelse'in açtığı web sitesi reklamlarının < %90'ı agx kodu taşıyor (eski `META_AD_CREATE` reklamları etiketsiz sayılır).
- `not_seen` (WARN): kodlu bir reklam ≥ 20 link tıklaması aldı ve ilk tıklama günü son kesin GA gününden ≥ 2 gün önce, ama ne kodu ne `agx-` kampanyası kampanya dilimlerinde görünmüyor.
- Diğer nedenler: `ok`, `no_ads`, `no_data` (PASS ya da UNKNOWN).
- `GA_CHECK_KEYS`'e EKLENMEZ: `evaluateGaChecks` her anahtar için tam bir sonuç döner, `checks.ts` anahtar dışı satırları siler ve puan `GA_CHECK_KEYS.length` ister; anahtar eklemek bayrak kapalıyken saklanan satırı, puanı ve kontrol listesini değiştirirdi.

## 9. Meta optimizasyonuna kanıt

- `getGaOutcomesForCampaign(projectId, campaignExternalId, range)`: GA4'ün kampanya için gördüğü oturum, etkileşimli oturum, key event, gelir (mülk günleri). Yalnız okur; bayrak, birincil bağ, mock değil ve kampanya o projede eşlenmişse döner, aksi null.
- `createGaCampaignEvidenceReader({ now })`: optimizer `evaluateAccount` içinde karar kanıtına düz `ga4_*` anahtarları ekler (`ga4_source`, `ga4_from`, `ga4_to`, `ga4_sessions`, `ga4_engaged_sessions`, `ga4_key_events`, `ga4_covered_days`). Son 7 mülk günü; kapsanan gün < 5 ise yok. Okuyucu kararın kendi projesiyle (`object.projectId ?? link.projectId`) çağrılır: paylaşılan reklam hesabı A projesinin GA sayılarını B'nin kararına sokmaz. Proje ve kampanya başına bellekte önbellek. Kurallar ve `explainDecision` bu anahtarları okumaz; yalnız kanıttır. Bayrak kapalıyken null, kanıt nesnesi aynı referans.

## 10. Öğrenmeler

Kapı (`ATTRIBUTION_LEARNING_GATE`): 28 gün, grup ≥ 200 oturum, geri kalan site ≥ 200 oturum, beklenen key event ≥ 10, p < 0,05, oran ≥ 1,25× (WORKS) ya da ≤ 0,8× (AVOID).

- Metin GA-F4 kuralına uyar: yol, terim ve SAYI içermez; yalnız bizim etiketimizi (plan kampanya adı ya da Meta kampanya adı) adlandırır. Oran ve p yalnız yönü ve güven katmanını belirler. Örnekler: "Visitors from <etiket> took a key action clearly more often than other website visitors." ve "… clearly less often than other website visitors; check that the ad or post matches the page it opens."
- `sourceType` `GA4`, `sourceRef` `ga-utm:<groupKey>`; Brand Brain'de "Source: ga-utm:…" görünür (yalnız bizim anahtarımızı ya da Meta kimliğini taşır, Google verisi değil). Grup başına en çok bir öğrenme, bir kez yazılır; sonradan tersine dönse metin güncellenmez. Kullanıcı öğrenmeyi Brand Brain'den silerse "bir kez" kuralının tutacağı kalıcı bir işaret yoktur (şema değişikliği gerekirdi): grup koşulu hâlâ sağlıyorsa sonraki günlük koşu aynı öğrenmeyi yeniden yazabilir. Bilinen ve kabul edilmiş davranış.
- İş günde bir (`claimPeriodic`, `ga.attribution.learnings`); adaylar etiketli linki ve canlı, mock olmayan birincil GA bağı olan projeler, projectId sırasında ve güne göre döner (offset = gün × limit mod sayı); koşu başına ≤ 200 proje, 120 sn bütçe. Yerelde süreç içi 30 dk kısıtlaması ve `GA_SYNC_DEV_PROJECTS`.
- Ölçüm sağlığında kritik uyarı açıksa (`MeasurementSummary.critical > 0`) ya da bağ mock ise proje atlanır.

## 11. Limited Use ve Disconnect

- Telegram'a ve operatörlere hiçbir şey gitmez (MH25 ve AN13/AN14 sayıları dahil; operatör yalnız `byRule` sayaçlarını görür).
- LLM yalnız GA-F4 explain olgularını (≤ 20 dizgi, AN14 maskeli) görür; atıf bölümü LLM olgularında yoktur.
- GA Disconnect (`deleteGaAttributionDataForCredential`) `ga-utm:` öğrenmelerini hemen siler ve projenin HER `AdsDecision` satırından `ga4_*` anahtarlarını söker (JSON yol süzgeci `evidence.ga4_source = 'GA4'`, 500'lük parti döngüsü, sınır yok; 200 parti güvenlik durdurması hata loglar). Otopilot takip kararlarına kopyalanan kanıt da gider. AN13/AN14 bulguları GA-F4'ün cascade'iyle gider. Bağlantısız kalan projeler için `GaRetention` yetim taraması aynısını yapar: bağ silmeye bakan adım ve proje tabanlı `sweepOrphanGaAttributionData` (Disconnect temizliği hata verip yarıda kalsa bile canlı GA bağı/kimliği olmayan projelerin kalanlarını siler). `TrackedLink` ve `LinkTrackingSetting` kalır.
- Gizlilik ve veri silme sayfaları buna göre güncellendi.

## 12. Bilinen boşluklar

- Eski `META_AD_CREATE` (ajans zinciri) yolu etiketlemez; MH25 görünür kılar. Eski `DEFAULT_URL_TAGS` reklamları reklam kimliğiyle yine atfedilir.
- Facebook, LinkedIn, X, TikTok bugün link yayınlamıyor (`publishFacebookPagePost`'ta link alanı yok): `tagOutboundLink` hazır ama çağıran yok. Instagram'da yalnız bio linki; story linkleri ertelendi.
- Ertelendi: kanal bütçesi önerisi (plan §3.8, "Shift 10–20% of budget…") ve kampanya başına açılış sayfası/cihaz kalitesi (campaign raporunda landingPage ve cihaz boyutu yok).
- `{{site_source_name}}` makrosunun Meta'nın güncel dinamik URL parametre listesine göre doğrulanması gerekir (doğrulanmalı). Meta reddederse Review'da görünür (validate_only); düzeltme `utmFor`'da tek satır.
- Saat dilimi: Meta günleri reklam hesabının, GA günleri mülkün saat dilimine göre; sınır günlerinde küçük kayma olur.
- Sıfır GA oturumu olan eski reklamlar karşılaştırmada bilinmez.
- GA günde 250 kampanya satırı tutar; yoğun sitelerde küçük `agx_` satırları kırpılıp "From Agentelse", AN13 ve MH25 `not_seen` eksik sayabilir (`truncated` notu).
- Meta AD düzeyi insights 180 gün saklanır; daha uzun Website aralıkları eski reklamlar için kısmi Meta sayısı gösterir.
- İki proje aynı GA mülkünü paylaşabilir: kodlar küresel olduğundan kodla yanlış atıf olmaz; başka projenin `agx-` kampanyası "Other tagged links"e düşer.

## 13. Doğrulama

1. `GA_UTM=true` (ve `GA_SYNC=true`) aç; Settings → Publishing → "Link tracking" kartı görünür.
2. Ads modülünde kendi alan adına giden bir reklamı Review'a getir: "Tracking: UTM added" notu çıkar; Ads Manager'da reklamın `url_tags` alanında `utm_source=facebook&utm_medium=paid_social&utm_campaign=agx-…&utm_content=agx_…&utm_term={{site_source_name}}` görünür.
3. Bio linkini oluştur, Instagram bio'ya yapıştır.
4. GA verisi gelince Website sayfasında "From Agentelse" ve "Your ads on your website" bölümlerini ve ölçüm sağlığı altındaki MH25 kartını kontrol et.

## Testler

`src/lib/utm.test.ts`, `src/lib/tracked-links/*.test.ts`, `src/lib/website-analytics/attribution/*.test.ts`, `src/lib/website-analytics/analysis/{ads-cross-check,google-ads,registry,keys,stored,describe,run-rules}.test.ts`, `src/lib/website-analytics/health/utm-coverage.test.ts`, `src/lib/website-analytics/reports/*.test.ts` (agentelse alanı), `src/server/tracked-links/*.integration.test.ts`, `src/server/website-analytics/attribution/*.test.ts` ve `*.integration.test.ts`, `src/server/actions/link-tracking-actions.test.ts`, `src/server/integrations/google-disconnect.test.ts`, `src/lib/module-flows/ads/launch.test.ts` (urlTags).

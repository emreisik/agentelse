# Google bağlantı katmanı (Google Analytics + Search Console)

Planlar: [google-analytics-plan.md](google-analytics-plan.md), [google-search-console-plan.md](google-search-console-plan.md). Bu dosya iki entegrasyonun **ortak bağlantı katmanının** uygulanmış hâlini anlatır (GA-F0/F1, SC-F0/F1). Ambar, sağlık kontrolleri ve analiz gibi entegrasyona özgü fazlar geldikçe kendi notlarına yazılır.

## Durum (6 Ekim 2026)

| Parça                                                                                                                                                                                                            | Durum             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| GA-F0 / SC-F0: koparılmış bağlantı Test ile geri gelmiyor                                                                                                                                                        | Yapıldı (9b5794c) |
| GA-F1 / SC-F1 bölüm 1: çekirdek, izin doğrulama, PKCE, hesap kimliği, gerçek Disconnect + akıllı iptal, roller, kiracıya özel sağlık, günlük bağlantı sağlığı, gizlilik ve veri silme metni                      | Yapıldı           |
| GA-F1 / SC-F1 bölüm 2: "Use existing connection" (100 token sınırı; `GoogleGrant` tablosu yerine token kopyalama), Connectors diyaloğunda yeni durumlar ve mesajlar, site/alan adı uyarısı, bağlı hesaplar kartı | Yapıldı           |
| GA-F7: isteğe bağlı `analytics.edit` yükseltmesi, düzeltme eylemleri ([website-fixes.md](website-fixes.md)) | Kodlandı, `GA_FIXES` arkasında, kapalı |

Ayrı entegrasyon ilkesi: iki ayrı kutucuk, iki ayrı onay ekranı (her biri yalnız kendi izni), ayrı token, seçim, Disconnect ve veri. Tek Google Cloud projesi ve tek doğrulama; sitemap gönderimi yok. Search Console her zaman salt okunur; Google Analytics isteğe bağlı GA-F7 yükseltmesi dışında salt okunur.

## Ortak çekirdek (`src/server/integrations/google/`)

- `services.ts`: servisler, provider adları, izinler (`analytics.readonly`, `webmasters.readonly` + `userinfo.email`), verilen izinlerin okunması.
- `error-catalog.ts`: hata sınıfları (TRANSIENT, SERVER_ERROR, RATE_LIMIT, QUOTA_DAILY, AUTH, SCOPE_MISSING, PERMISSION, NOT_FOUND, VALIDATION, API_DISABLED, UNKNOWN). Karar HTTP durumu, Google `status` ve `reason` ile verilir. Paylaşılan sağlığı yalnız Google'ın kendi arızası düşürür; kullanıcı metinleri buradadır.
- `errors.ts`: `GoogleApiError` (eski `googleErrorCode` alanı korunur; `httpStatus`, `reason`, `errorClass`, `retryAfterMs` eklendi) ve hata gövdesi ayrıştırma (OAuth, yeni API biçimi, Search Console'un eski `errors[]` biçimi).
- `http.ts`: tek ağ kapısı. İşe göre zaman aşımı (token 10 sn, Admin/okuma 15 sn, rapor 30 sn). TRANSIENT hatada 2, SERVER_ERROR'da 1 tekrar yapılır (GA4 saatlik sunucu hatası kotası); diğerlerinde tekrar yok. Kısa `Retry-After`'a uyulur. Kod değişimi asla tekrarlanmaz.
- `oauth.ts`: yetkilendirme adresi (`prompt=consent select_account`, PKCE, `include_granted_scopes` yok), kod değişimi (verilen izinler döner), refresh, revoke, hesap kimliği (`userinfo` `id` + e-posta).
- `access-token.ts`: access token süreç belleğinde, bitişe 5 dk kalana kadar yeniden kullanılır; aynı anda gelen istekler tek yenilemeyi bekler. Anahtar şifreli token'ın özetini içerir; yeniden bağlanınca eski token kullanılmaz.
- `revoke-policy.ts`: Google'da iptal kararı (aşağıda).

`google-client.ts` GA ve Search Console REST fonksiyonlarını tutar ve çekirdeği yeniden dışa aktarır; eski import'lar değişmedi. GA mülk listesi (`accountSummaries`) artık sayfalı okunuyor (en çok 10 × 200).

## Bağlanma

- Start: PKCE doğrulayıcısı imzalı state'te taşınır (TikTok/X deseni). State oturum kullanıcısına bağlı olduğu için çalınan bir kod başka oturumda kullanılamaz.
- Callback: token yanıtındaki `scope` alanında servisin izni yoksa (kullanıcı onay ekranında kutuyu kaldırdıysa) bağlantı kurulmaz; `googleError=scope_missing` ile dönülür. Token iptal edilmez, çünkü iptal Cloud projesi düzeyindedir ve aynı hesabın diğer bağlantısını koparırdı. Yanıtta `scope` hiç yoksa bağlantı kurulur.
- Metadata'ya hesap kimliği (`googleSub`) ve e-posta yazılır. Metadata'yı `google-connection-metadata.ts` kurar (OAuth dönüşü ve "Use existing connection" ortak): liste tazelenir, hâlâ erişilebilen seçim ve tarama kayıtları korunur, `disconnectedAt` işareti ve eski token'ın `googleHealth` kaydı düşer.
- Connectors diyaloğu `scope_missing` için açık mesaj gösterir: "Google access wasn't allowed. Connect again and tick the box to allow it."

**İsteğe bağlı GA-F7 yükseltmesi** (`GA_FIXES`, varsayılan kapalı; ayrıntı [website-fixes.md](website-fixes.md)): yalnız analytics servisi için ikinci bir onay ekranı. İzinler açıkça listelenir (`analytics.readonly` + `analytics.edit` + `userinfo.email`), `include_granted_scopes` YOK, aynı Google hesabı zorunlu, hibe `metadata.gaEdit` olarak saklanır. Eski refresh token asla iptal edilmez; callback Search Console izni de taşıyan token'ı reddeder (`edit_not_available`, hiçbir şey saklanmaz). "Turn off editing" yazmayı hemen durdurur; izin Google'da kalır. Normal yeniden bağlanma ve "Use existing connection" `gaEdit`i düşürür.

## Use existing connection (`google-reuse.ts`, `reuseGoogleConnectionAction`)

Google, bir Google hesabı × OAuth istemcisi için en çok 100 canlı refresh token tutar; aşılınca en eskisi uyarısız düşer. Ajans aynı hesapla çok projeye bağlanınca bu sınır dolardı. Planın `GoogleGrant` tablosu yerine şema değiştirmeyen bir yol uygulandı:

- Bağlı olmayan (ya da süresi dolmuş) Google diyaloğunda, aynı workspace'te başka projelere bağlı **aynı servisin** canlı bağlantıları listelenir ("Or use a Google account already connected in this workspace"). Her Google hesabı bir kez görünür (önce `googleSub`, yoksa e-posta), yanında hangi projede bağlı olduğu yazar; en çok 20.
- "Use" şifreli refresh token'ı ve hesap etiketini kopyalar, Google onay ekranına gidilmez, yeni token üretilmez. Seçim kaynaktan kopyalanmaz: her proje kendi mülkünü ya da sitesini seçer (bu projenin eski seçimi hâlâ erişilebilirse korunur).
- Kaynak aynı workspace'te, aynı serviste, ACTIVE, token'lı ve başka projede olmalı; bu projede canlı bağlantı varsa üzerine yazılmaz ("Disconnect it first"). Kopyalamadan önce token yenilenir: geçersizse kaynak EXPIRED olur ve hata döner.
- Yalnız OWNER/ADMIN: liste başka projelerin Google e-postalarını gösterdiği için de yalnız onlara hesaplanır. Denetim kaydı `integration_credential.connected` + `reusedFromCredentialId`.
- Aynı token'ı paylaşan satırları akıllı iptal zaten tanır (aynı şifreli token): birini koparmak diğerlerini bozmaz, Google'da iptal yapılmaz. Token'ı yenilenen satırlardan biri `invalid_grant` alırsa yalnız o satır EXPIRED olur; diğerleri kendi ilk çağrılarında aynı sonuca varır.

## Disconnect (`google-disconnect.ts`)

- Yalnız workspace OWNER/ADMIN (`isWorkspaceManager`, `tenant-context.ts`).
- Refresh token ve Google'dan okunan bütün metadata (liste, seçim, test sonucu, e-posta, kimlik) hemen silinir; satır REVOKED olur, metadata yalnız `{ disconnectedAt }` tutar. Bu değişiklikten önce koparılmış ve token'ı hâlâ duran satırlar, Disconnect yeniden çağrılınca temizlenir. Google Analytics ambarı (bağ, günlük toplamlar, dilimler, ay özetleri; [website-analytics.md](website-analytics.md)) ve Search Console ambarı (bağ, günlük toplamlar, kırılımlar, sözlükler, haftalık ve aylık özetler; [search-analytics.md](search-analytics.md)) da aynı anda silinir.
- Connectors > Google Search Console > Delete stored data: bağlantıyı koparmadan Search Console ambarını siler; son 16 ay Google'dan yeniden yüklenir (OWNER/ADMIN, denetim kaydı `search_console.data_deleted`).
- SC-F3 (bkz. [search-health.md](search-health.md)), hepsi bayraktan bağımsız:
  - Search Console Disconnect URL Inspection sonuçlarını, Search Console sitemap durumunu ve kapsam tahminlerini de siler (`GscUrlInspection`, `GscSitemap`, `GscCoverageWeek`, bağla cascade), ayrıca GSC kaynaklı arama uyarılarını (`source: "GSC"`).
  - Denetimdeki GSC kökenli durumu temizler (inceleme kuyruğu, puan, yalnız GSC'den bilinen sayfalar).
  - Denetim kapsamı Search Console'dan gelen sitelerin tarama verisini sıfırlar; Agentelse alan adı doğrulaması korunur.
  - "Delete stored data" GSC uyarılarını ve GSC kökenli denetim durumunu da siler (tarama verisi kalır).
- GA-F3: Google Analytics Disconnect projenin GA4 ölçüm uyarılarını hemen siler; kontrol sonuçları ve denetim durumu bağla cascade gider (bkz. [measurement-health.md](measurement-health.md)).
- GA-F4: Google Analytics Disconnect analiz motorunun türevlerini hemen siler (`deleteGaInsightDerivedDataForCredential`): ga-insights sinyalleri, onlardan doğan ajans bulguları, içgörüler ve dokunulmamış fırsatlar, GA4 öğrenmeleri, havuzdaki "website" fikirleri. `GaFinding` ve `GaAnalysisRun` bağla cascade gider (bkz. [website-insights.md](website-insights.md)).
- SC-F4: Search Console Disconnect, "Delete stored data" ve W1 bağ temizliği (sahipsiz ve seçimi değişmiş bağlar) SEO fırsat motorunun verisini de siler:
  - `SeoFinding`, `SeoCluster`, `SeoQueryEmbedding` ve `SeoEngineState` bağla cascade gider.
  - Motorun sinyalleri ve bulgulardan yapılmış, kullanılmamış havuz fikirleri silinir; kullanılmış fikirlerin kanıtı çıkarılır.
  - Hiçbiri bayrağa bağlı değildir. Bkz. [search-opportunities.md](search-opportunities.md).
- SC-F6: Search Console Disconnect, "Delete stored data" ve W1 bağ temizliği (seçimi değişmiş, sahipsiz ve mock bağlar) şunları da siler, bayraktan bağımsız: SEO eylemleri (`SeoAction`, Search Console bağına ait olanlar), SEO öğrenmeleri (`BrandLearning` `sourceType` SEO; öğrenme kimliği ya da `sourceRef` ile) ve SEO Manager kartlarındaki Search Console verisi (quick wins, sorgu sayısı). Bkz. [search-actions.md](search-actions.md).
- GA-F6: Google Analytics Disconnect "ga-utm:" GA4 öğrenmelerini hemen siler ve projenin bütün `AdsDecision` kanıtlarından `ga4_*` anahtarlarını söker (`deleteGaAttributionDataForCredential`). `TrackedLink` ve link izleme ayarı Google verisi olmadığı için kalır. Bkz. [website-attribution.md](website-attribution.md).
- **Akıllı iptal:** Google'a iptal (`oauth2.googleapis.com/revoke`) yalnız şu durumda gider: aynı Google hesabını kullanan, koparılmamış başka bir Google bağlantısı yoksa (hangi workspace ya da servis olursa olsun). Eşleşme sırası: aynı şifreli token (29 Eylül'den kalan GA/GSC çiftleri), aynı `googleSub`, kimliği olmayan eski satırlarda aynı e-posta. Hesap tanınamıyorsa iptal edilmez. İptal başarısız olsa da silme yapılır.
- Denetim kaydında `revokedAtGoogle` tutulur.

## Roller

- Connect ve ilk mülk/site seçimi: her üye (bağlayan üye seçimini de yapabilsin diye).
- Seçili mülkü ya da siteyi değiştirmek, Disconnect ve "Use existing connection": OWNER/ADMIN. Diğer üyeler "Only workspace owners and admins can change this." görür.

## Site ve alan adı (Search Console)

- Site listesinde projenin web sitesini (`Project.domain`) kapsayan mülkler önce, onların içinde Domain mülkü önce gelir (`src/lib/search-console-site.ts`).
- Seçili site projenin sitesini kapsamıyorsa diyalog uyarır: "This site doesn't cover the project's website (…). Reports will describe a different site." Domain mülkü alan adını ve alt alan adlarını, URL önekli mülk yalnız kendi host'unu kapsar; "www." farkı eşleşme sayılır.
- GA4 için alan adı uyarısı yok: mülk listesi alan adı taşımıyor (veri akışlarının `defaultUri`'si okunmuyor). GA-F2'de veri akışları okununca eklenebilir.

## Sağlık

- **Kiracıya özel sağlık:** `GoogleApiProvider` başarısızlıkta `GOOGLE:<SINIF>` kodu döndürür. `provider-health.service.ts` → `failureDegrades` bu koda bakar: bir müşterinin AUTH, SCOPE_MISSING, PERMISSION ya da NOT_FOUND hatası paylaşılan `google-api` sağlığını düşürmez; yalnız TRANSIENT, SERVER_ERROR ve API_DISABLED düşürür.
- **Günlük bağlantı sağlığı** (`google-connection-health.ts`, tick adımı `google-connection-health`, odak ayarından bağımsız): her ACTIVE Google bağlantısı günde bir kez kontrol edilir. Token yenilenir (süresi dolmuşsa satır EXPIRED olur), liste okunur (izin ve erişim sınanır) ve seçili mülk/site hâlâ listede mi bakılır. Sonuç metadata'nın `googleHealth` anahtarına `jsonb_set` ile yazılır: `OK`, `NEEDS_RECONNECT`, `NEEDS_PERMISSION`, `ACCESS_LOST`, `GONE`, `RATE_LIMITED`, `CHECK_FAILED`. Seçim kendiliğinden değiştirilmez. Connectors diyaloğu bağlı bağlantıda `NEEDS_PERMISSION`, `ACCESS_LOST` ve `GONE` için uyarı gösterir; `NEEDS_RECONNECT` zaten "Needs reconnection" rozetiyle görünür, `RATE_LIMITED` ve `CHECK_FAILED` kullanıcının sorunu olmadığı için gösterilmez.
- Süresi dolan token: `invalid_grant` → bağlantı EXPIRED; REVOKED bir satır EXPIRED'a düşmez.
- **Bağlı hesaplar kartı** (sağ panel, `brand-overview-cards.tsx`): süresi dolan GA4 / Search Console bağlantısı kaybolmaz, amber noktalı ikonla ve "yeniden bağlanmalı" ipucuyla görünür (`ConnectedAccountState` = `reconnect`). Plan metni İngilizceye çevirmeyi öneriyordu; sağ panelin tamamı Türkçe olduğu için kart Türkçe kaldı.

## Anahtar sürümleme (`GOOGLE_TOKEN_KEYS`)

`decryptGoogleSecret` / `encryptGoogleSecret` (`google/secret.ts`) Google token şifrelemesinin TEK giriş noktasıdır: `google-token.ts`, `google-disconnect.ts` ve OAuth callback bunları kullanır. Anahtar kimliği şifreli metnin önekindedir (`gk1:<keyId>:...`); env boşken çıktı eski biçimle aynıdır. Önce kod, sonra env (iki deploy). Ayrıntı: [website-agency.md](website-agency.md) bölüm 9.

## RISC (Cross-Account Protection)

`POST /api/webhooks/google-risc` (`GOOGLE_RISC`): Google hesabın erişimi iptal edildiğinde bağlantıyı hemen EXPIRED yapar, bağları `AUTH`'a çeker ve kritik uyarı açar; veri silinmez. Ayrıntı ve kayıt adımları: [website-agency.md](website-agency.md) bölüm 8 ve 10.

## Gizlilik

- `privacy/page.tsx`'te yeni "Google Analytics and Search Console connections" bölümü var: iki izin ve amaçları, saklananlar, AI işleme, satılmaz, eğitimde kullanılmaz, insanlar okumaz, Disconnect ve Google hesabından kaldırma. Google'ın kalıbıyla Limited Use beyanı da burada. Sayfa tarihi 6 Ekim 2026.
- `data-deletion/page.tsx`'te Google için silme yolu var.
- GA-F7 ile (7 Ekim 2026) gizlilik sayfası isteğe bağlı `analytics.edit` iznini ayrı bir madde olarak anlatır (kullanım amacı, günlük değişiklik geçmişi okumasının liste saklamadığı, 24 aylık değişiklik kaydı, izni Google Hesabı ayarlarından kaldırma). Sayfa tarihi 7 Ekim 2026.

## Testler

`src/server/integrations/google/*.test.ts` (hata kataloğu, ağ kapısı ve tekrarlar, OAuth, iptal kuralı, token önbelleği, servisler), `google-disconnect.test.ts`, `google-connection-health.test.ts`, `google-reuse.test.ts`, `google-connection-metadata.test.ts`, `google-actions.test.ts` ("Use existing connection" dahil), `api/integrations/google/callback/route.test.ts`, `lib/search-console-site.test.ts`, `connected-accounts` testleri ve `brand-summary-panel.test.ts` (yeniden bağlanma işareti), `privacy/page.test.ts` (Google bölümü ve Limited Use cümlesi).

## Sahip adımları (kod dışı)

1. Google Cloud Console → OAuth consent screen: yayın durumu "In production" olmalı ("Testing"te refresh token'lar 7 günde düşer).
2. Data Access'te `analytics.readonly` ve `webmasters.readonly` görünmeli. Doğrulama başvurusu tek: iki izin aynı başvuruda (GA planı §7). Doğrulanmamış uygulamaya projenin ömrü boyunca en çok 100 yeni kullanıcı bağlanabilir.
3. Gizlilik sayfası canlıya çıkınca Limited Use beyanı başvuruda gösterilebilir.

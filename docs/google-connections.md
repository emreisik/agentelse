# Google bağlantı katmanı (Google Analytics + Search Console)

Planlar: [google-analytics-plan.md](google-analytics-plan.md), [google-search-console-plan.md](google-search-console-plan.md). Bu dosya iki entegrasyonun **ortak bağlantı katmanının** uygulanmış hâlini anlatır (GA-F0/F1, SC-F0/F1). Ambar, sağlık kontrolleri ve analiz gibi entegrasyona özgü fazlar geldikçe kendi notlarına yazılır.

## Durum (6 Ekim 2026)

| Parça                                                                                                                                                                                       | Durum                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GA-F0 / SC-F0: koparılmış bağlantı Test ile geri gelmiyor                                                                                                                                   | Yapıldı (9b5794c)                                                                  |
| GA-F1 / SC-F1 bölüm 1: çekirdek, izin doğrulama, PKCE, hesap kimliği, gerçek Disconnect + akıllı iptal, roller, kiracıya özel sağlık, günlük bağlantı sağlığı, gizlilik ve veri silme metni | Yapıldı                                                                            |
| GA-F1 / SC-F1 bölüm 2: `GoogleGrant` tablosu + "Use existing connection" (100 token sınırı), Connectors diyaloğunda yeni durumlar ve mesajlar, bağlı hesaplar kartı                         | Bekliyor: `integrations/page.tsx`'te başka bir oturumun commit'siz değişikliği var |

Ayrı entegrasyon ilkesi: iki ayrı kutucuk, iki ayrı onay ekranı (her biri yalnız kendi izni), ayrı token, seçim, Disconnect ve veri. Tek Google Cloud projesi ve tek doğrulama; sitemap gönderimi yok, iki entegrasyon da salt okunur.

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
- Metadata'ya hesap kimliği (`googleSub`) ve e-posta yazılır; yeniden bağlanınca `disconnectedAt` işareti düşer.
- Arayüz notu: Connectors diyaloğu `scope_missing` kodunu henüz tanımıyor ve genel "Something went wrong" mesajını gösteriyor. Özel mesaj, bölüm 2'de diyalogla birlikte gelecek.

## Disconnect (`google-disconnect.ts`)

- Yalnız workspace OWNER/ADMIN (`isWorkspaceManager`, `tenant-context.ts`).
- Refresh token ve Google'dan okunan bütün metadata (liste, seçim, test sonucu, e-posta, kimlik) hemen silinir; satır REVOKED olur, metadata yalnız `{ disconnectedAt }` tutar. Bu değişiklikten önce koparılmış ve token'ı hâlâ duran satırlar, Disconnect yeniden çağrılınca temizlenir.
- **Akıllı iptal:** Google'a iptal (`oauth2.googleapis.com/revoke`) yalnız şu durumda gider: aynı Google hesabını kullanan, koparılmamış başka bir Google bağlantısı yoksa (hangi workspace ya da servis olursa olsun). Eşleşme sırası: aynı şifreli token (29 Eylül'den kalan GA/GSC çiftleri), aynı `googleSub`, kimliği olmayan eski satırlarda aynı e-posta. Hesap tanınamıyorsa iptal edilmez. İptal başarısız olsa da silme yapılır.
- Denetim kaydında `revokedAtGoogle` tutulur.

## Roller

- Connect ve ilk mülk/site seçimi: her üye (bağlayan üye seçimini de yapabilsin diye).
- Seçili mülkü ya da siteyi değiştirmek ve Disconnect: OWNER/ADMIN. Diğer üyeler "Only workspace owners and admins can change this." görür.

## Sağlık

- **Kiracıya özel sağlık:** `GoogleApiProvider` başarısızlıkta `GOOGLE:<SINIF>` kodu döndürür. `provider-health.service.ts` → `failureDegrades` bu koda bakar: bir müşterinin AUTH, SCOPE_MISSING, PERMISSION ya da NOT_FOUND hatası paylaşılan `google-api` sağlığını düşürmez; yalnız TRANSIENT, SERVER_ERROR ve API_DISABLED düşürür.
- **Günlük bağlantı sağlığı** (`google-connection-health.ts`, tick adımı `google-connection-health`, odak ayarından bağımsız): her ACTIVE Google bağlantısı günde bir kez kontrol edilir. Token yenilenir (süresi dolmuşsa satır EXPIRED olur), liste okunur (izin ve erişim sınanır) ve seçili mülk/site hâlâ listede mi bakılır. Sonuç metadata'nın `googleHealth` anahtarına `jsonb_set` ile yazılır: `OK`, `NEEDS_RECONNECT`, `NEEDS_PERMISSION`, `ACCESS_LOST`, `GONE`, `RATE_LIMITED`, `CHECK_FAILED`. Seçim kendiliğinden değiştirilmez. Bu durumlar bölüm 2'de Connectors diyaloğunda gösterilecek.
- Süresi dolan token: `invalid_grant` → bağlantı EXPIRED; REVOKED bir satır EXPIRED'a düşmez.

## Gizlilik

- `privacy/page.tsx`'te yeni "Google Analytics and Search Console connections" bölümü var: iki izin ve amaçları, saklananlar, AI işleme, satılmaz, eğitimde kullanılmaz, insanlar okumaz, Disconnect ve Google hesabından kaldırma. Google'ın kalıbıyla Limited Use beyanı da burada. Sayfa tarihi 6 Ekim 2026.
- `data-deletion/page.tsx`'te Google için silme yolu var.

## Testler

`src/server/integrations/google/*.test.ts` (hata kataloğu, ağ kapısı ve tekrarlar, OAuth, iptal kuralı, token önbelleği, servisler), `google-disconnect.test.ts`, `google-connection-health.test.ts`, `google-actions.test.ts`, `api/integrations/google/callback/route.test.ts`, `privacy/page.test.ts` (Google bölümü ve Limited Use cümlesi).

## Sahip adımları (kod dışı)

1. Google Cloud Console → OAuth consent screen: yayın durumu "In production" olmalı ("Testing"te refresh token'lar 7 günde düşer).
2. Data Access'te `analytics.readonly` ve `webmasters.readonly` görünmeli. Doğrulama başvurusu tek: iki izin aynı başvuruda (GA planı §7). Doğrulanmamış uygulamaya projenin ömrü boyunca en çok 100 yeni kullanıcı bağlanabilir.
3. Gizlilik sayfası canlıya çıkınca Limited Use beyanı başvuruda gösterilebilir.

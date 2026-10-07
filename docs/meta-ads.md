# Meta Ads sistemi

Plan: [meta-ads-plan.md](meta-ads-plan.md). Bu dosya, planın uygulanmış hâlini anlatır ve her fazdan sonra güncellenir.

## Durum

| Faz                         | Durum    | Bayrak |
| --------------------------- | -------- | ------ |
| F0a — Birikim kapısı        | Kodlandı | —      |
| F0b — Temel ve acil yamalar | Kodlandı | —      |
| F1 — Erişim katmanı ve hesap modeli | Kodlandı | — |
| F2 — Ayna ve sürekli denetim | Kodlandı | `META_ADS_SYNC=true` |
| F3 — Güvenli lansman v2 | Kodlandı | `META_ADS_LAUNCH_V2=true` |
| F5a — Mesaj ve trafik amaçları | Kodlandı | `META_ADS_PLANNER=true` (+ v2) |
| F4 — Optimizasyon v2 | Kodlandı | `META_ADS_OPTIMIZER=shadow` → `on` |
| F5b — Planlama ve formlar | Kodlandı (Leads izin bekliyor) | `META_ADS_PLANNER=true` (+ v2) |
| F6 — Raporlama ve öğrenme | Kodlandı | `META_ADS_REPORTS=true` (+ ayna) |
| F7 — Webhook ve otonomi | Kodlandı | `META_ADS_WEBHOOKS=true`, `META_ADS_AUTOPILOT=true`, isteğe bağlı `META_ADS_RULES=true` |
| F8 — Ajans ölçeği ve token modeli | Kodlandı (FLfB App Review bekliyor) | `META_ADS_AGENCY=true` |

Kod dışı adımlar sahipte (aşağıda "Sahip adımları").

## F0a — Birikim kapısı

İşçi uzun süre durup yeniden açıldığında kuyrukta bekleyen işler, onaylandıkları andaki değil bugünkü bağlamla çalışırdı.

- **Claim kapısı** (`src/server/execution/backlog-gate.ts`, kurallar `src/lib/execution-backlog.ts`): `ExecutionService.startExecution`, harcama yazan bir Meta işini (META_CAMPAIGN/ADSET/AD_CREATE/UPDATE) sağlayıcıya göndermeden önce denetler. Onayı 24 saatten ya da görevi 72 saatten eskiyse iş ve görev CANCELLED olur (`errorCode: STALE_AFTER_OUTAGE`, "Stale after worker outage"). Ads kartında halka "failed" görünür, gerekçe yazar; kart "Edit and launch again" sunar.
- **Self-healing**: Meta harcama yazmalarının ölü mektupları yeniden kuyruğa alınmaz; Meta nesneyi kurmuş ama yanıt kaybolmuş olabilir. Ayrıca kuyruğa geri alınan işin FAILED görevi de QUEUED'a döner (FAILED→RUNNING geçişi yasak olduğu için eskiden yeniden çalışmıyordu). Aynı düzeltme /health "Retry" eyleminde de var.
- **Zamanlı yayın**: Saati 24 saatten fazla geçmiş parça kendiliğinden çıkmaz; takvimde "Missed" kalır (eski yol ve Works'teki eski adaylar).
- **Birikim raporu** (salt okunur): `npm run db:report:backlog`.

## F0b — Temel ve acil yamalar

### İşçi nabzı ve "izleyeni kim izler"

- `SystemHeartbeat` tablosu (migration `20261006120000_add_system_heartbeat`). `ExecutionWorker.tick` başında `lastBeatAt`, sonunda `lastOkAt` yazar (en fazla dakikada bir); `data.gaps` son 24 saatin en uzun boşluklarını tutar (`src/lib/heartbeat.ts`, `src/server/observability/heartbeat.ts`).
- `GET /api/health`: süreç ve veritabanı canlı mı (Railway healthcheck, `railway.json`). `GET /api/health?worker=1`: son tick 10 dakikadan eskiyse ya da hiç yoksa **503** — harici monitör bunu izler. Oturum istemez, yalnız durum döner.
- **Uygulama içi şerit**: nabız 5 dakikadan eskiyse OWNER/ADMIN her sayfanın üstünde "Background jobs paused since 10:42" görür (`src/components/layout/worker-strip.tsx`, AppShell).
- İşçi aşamaları birbirinden yalıtıldı: dispatch, poll ve verify artık birbirini düşürmez. Tek bozuk doğrulama satırı döngüyü durdurmaz; iptal edilmiş ya da düşmüş görevler onarım sorgusuna her dakika yeniden girmez.
- Açılış logu: `[boot] worker=on|off META=on|skipped-locally`.

### Yerel geliştirme güvenliği (K19)

Yerel `next dev` canlı veritabanını paylaşırken (`DATABASE_URL` localhost ya da Unix soketi değilse):

- İşçi Meta işlerini (META_*) hiç claim etmez; canlı işçi yürütür.
- Telegram mesajı gitmez ve canlı onay güncellemeleri (`getUpdates`) tüketilmez. Açmak için `ALLOW_DEV_NOTIFICATIONS=true`.

### Para birimi (tek kaynak)

`src/lib/ads/money.ts`: minor unit ↔ ana birim, Meta'nın para birimi ofsetiyle (çoğunda 100, JPY/HUF/KRW… 1). Sabit `×100` / `/100` kaldırıldı: eski sihirbaz, düzenleme formları, detay sayfaları, kural motoru ve onay kartı. Para birimi bilinmiyorsa tutar "(account currency)" notuyla yazılır.

### Bitiş tarihi, kitle ve DSA

- **Modül akışı**: Launch yükü `durationDays` taşır; ad set kurulurken `start_time` = şimdi, `end_time` = şimdi + gün (UNIX saniyesi) yazılır. Zincir rölesi alanı ad set görevine taşır. Review: "Runs 7 days from creation, then Meta stops it by itself. Turning it on later does not move the end date."
- **Eski sihirbaz**: Kampanya bütçesiz kurulur (ABO); ad set sihirbazında **End date zorunlu** (tek tarih seçici), projenin saat diliminde günün sonu.
- `targeting_automation.advantage_audience=0` her yeni ad set'te açıkça gönderilir (Brief'teki yaş/cinsiyet sert sınırdır).
- **AB/AEA**: Brief'te AB ülkesi seçilince "Who benefits from this ad?" ve "Who pays for it?" istenir; ad set'e `dsa_beneficiary` / `dsa_payor` gider.

### Hesap güvenliği

- Brief, yazıldığı reklam hesabını (`adAccountId`) saklar; Launch başka bir hesap seçiliyse reddedilir. Zincirin her halkası hesabı ve para birimini taşır.
- Sağlayıcı: onaydan sonra seçili hesap değiştiyse yazma yapılmaz ("Ad account changed since approval"). Kampanya / ad set / reklam güncellemesinde hedef nesnenin hesabı `GET /{id}?fields=account_id` ile okunur (10 dk önbellek); başka hesaba aitse iş FAILED olur.

### Onay güvenliği

- Meta harcama onayları **72 saat** geçerlidir (`TaskPlanner.requestApproval`). Süre karar anında da denetlenir ("This approval expired. Ask again.").
- Süresi dolan onayın görevi CANCELLED olur ("Approval expired"); Ads kartı "The approval ran out after 72 hours…" der.
- **L4 (harcama) onayını yalnız workspace OWNER/ADMIN verir.** Kapı, web/Telegram/Works/plan/post ve sohbet yollarının hepsinin geçtiği `ApprovalRepository.decide`'dadır.
- Telegram'da L4 için Approve/Reject düğmesi yok; "Review in Agentelse" bağlantısı gider ve mesaj yalnız Agentelse'in kendi verisini taşır.
- Sohbetteki `decide_approval` para harcatan bir onayı vermez: "Approve it on the card above."
- Eski bekleyen onaylara süre: `npm run db:backfill:approval-expiry` (kuru), `-- --apply` (yazar).

### Tarayıcı ve öneriler

- Bütçesi ad set'te olan (ABO) kampanyalar artık atlanmaz; ad set düzeyinde değerlendirilir, öneri `META_ADSET_UPDATE` olarak ad set'e gider.
- Sonuç, ad set'in optimizasyon hedefinden sayılır (`src/lib/ads/results.ts`: LINK_CLICKS→link_click, REACH→reach, POST_ENGAGEMENT→post_engagement…).
- PAUSE ve REDUCE önerileri günlük görev kotasından muaftır; kotadan düşen öneri AuditLog'a `ads.proposal_dropped` olarak yazılır. Bütçe artırma (SCALE) F2'ye kadar kapalı.
- Metadata anahtar anahtar yazılır (`jsonb_set`); tarama sırasında yapılan hesap seçimi artık geri yazılmaz.
- Yorgunluk (AD_FATIGUE) yalnız öneridir (Signal); onaysız görsel üretimi başlatmaz.

### Token ve hatalar

- 190 (token süresi doldu / iptal) her okuma ve yazma yolunda bağlantıyı EXPIRED yapar (`src/server/integrations/meta-credential-health.ts`). İstisna 190/492: yalnız o Sayfaya bağlı özellik durur.
- Integrations → Meta Ads kutucuğu: "Access expires in N days" (7 günden azsa vurgulu).
- `isMetaRateLimit` 80000 (ads insights) kodunu da tanır.

### Kapatılan riskli yollar

- Yayından sonra LLM'in otomatik ACTIVE kampanya önerisi (`maybeProposeMetaCampaign`) artık çağrılmıyor (K11); kod F3'te silinir.
- Ölçüm motorunda sağlayıcısı olmayan META_CAMPAIGN_CREATE şablonu kaldırıldı.

## F1 — Meta erişim katmanı ve hesap modeli

### Tek Graph çekirdeği (`src/server/integrations/meta/`)

- `version.ts`: tek sürüm sabiti (v26.0). `graph.ts` → `metaFetch`: meta-client.ts'teki `request()` buraya delege eder; her çağrı:
  - hesap başına **kota yöneticisinden** izin alır (`governor.ts`). Durum `AdsAccount.lastUsage` / `rateLimitedUntil` satırlarındadır (5 sn bellek önbelleği). Karar Meta'nın başlıklarından verilir (`usage.ts`: X-Ad-Account-Usage, X-Business-Use-Case-Usage, X-FB-Ads-Insights-Throttle, X-App-Usage).
  - üç şerit: **P0** güvenlik (yalnız Meta'nın blokuna uyar), **P1** kullanıcı (%90'da bekler), **P2** arka plan (%75'te bekler). Şerit ve hesap `withMetaCallContext` ile verilir (`call-context.ts`).
  - `appsecret_proof` ekler (sorgu, urlencoded gövde ya da FormData; ham URL kodlaması bozulmaz). Meta panelinde "Require App Secret" artık açılabilir (K21).
  - kota hatasında hesabı Meta'nın tahmini ya da sabit blok süresi kadar bekletir; kısa tekrar yapılmaz.
  - `[meta-usage] site=… app=…` logu: platform kotasının asıl tüketicisi çağrı noktasıyla görünür (dakikada bir satır).
- `errors.ts`: `MetaApiError` artık `type`, `userMessage` (Meta'nın `error_user_msg`'i), `blameFieldSpecs`, `fbtraceId`, `isTransient`, `httpStatus` taşır.
- `error-catalog.ts`: alt kod → kod → çağrı ailesi sırasıyla 16 sınıf (TRANSIENT, RATE_LIMIT, CHANGE_LIMIT, VOLUME_LIMIT, AUTH, PERMISSION, APP_ACCESS, VALIDATION, POLICY, ACCOUNT, STATE, CREATIVE_SOURCE_GONE, TERMS_REQUIRED, INSIGHTS_SIZE, VERSION, UNKNOWN), eylem ve kullanıcı mesajı. 33 hata gövdesi fikstürü: `__fixtures__/graph-errors.json`.
- Sağlayıcı başarısızlıkta `errorCode = META:<SINIF>:<kod>/<alt kod>` yazar. **Devre kesici** (`provider-health.service.ts`) yalnız Meta genelindeki geçici arızalarda düşer; bir kiracının token, izin, doğrulama ya da hesap hatası başka müşterilerin Meta işini durdurmaz.

### Niyet günlüğü (idempotency)

- `AdsOperation` tablosu (migration `20261006130000_add_ads_account_and_operation`), `src/server/ads/operations.ts`.
- Kampanya / ad set / reklam oluşturma yazmadan önce bir satır açar; ada `[agx:xxxxxx]` etiketi eklenir (`src/lib/ads/operation-tag.ts`, K16).
- Aynı iş aynı yazmayı yeniden başlatırsa (takılan dispatch kurtarması, süreç ölümü) **ikinci nesne kurulmaz**: satır SUCCEEDED ise sonucu döner, SENT/UNKNOWN ise uzlaştırmaya geçer.
- Yanıt kaybolursa (ağ, zaman aşımı, 5xx) iş RUNNING kalır; 30 sn sonra Meta'da etiketle aranır (`findMetaObjectsByTag`), bulunursa tamamlanır, 150 sn'de bulunmazsa "Nothing was created: launch again." ile kapanır. **Kör tekrar yapılmaz** (planın "tek tekrar" maddesi bilinçli olarak uygulanmadı: geç tutarlılıkta çift nesne riski).
- Sağlayıcı sonuçları artık süreç belleğinde değil `ExecutionJob.rawResult.providerResult`'tadır (`provider-results.ts`): yeniden başlatmada Meta'da kurulmuş nesnenin kimliği kaybolmaz. Instagram ve Facebook yayınları da bu yoldan geçer. (Video reklamın bekleme kaydı zaten kalıcıydı; onun önbelleği kaldı.)

### Hesap modeli

- `AdsAccount` (workspace'te Meta hesabı başına tek satır) + `AdsAccountProject` (proje bağı, seçili hesap). `src/server/ads/accounts.ts` → `AdsAccounts.resolve` / `resolveWithToken`: Ads modülü, Ads sayfası, analiz okumaları ve sohbet aracı buradan okur. Satır ilk okumada bağlantı metadata'sından tembelce kurulur; güncelse yazım yapılmaz.
- Hesap listesi sayfalı okunur, `account_status` ve `timezone_name` ile; kapalı / devre dışı hesap seçilemez.
- Hesap ve Sayfa seçimi anahtar anahtar yazılır (`jsonb_set`).
- Sohbetin `get_connected_platforms` aracı Meta Ads hazırlığını da söyler (`metaAds.status`, hesap, para birimi, sağlık).

### Token sağlığı ve bağlantı yaşam döngüsü

- Callback, Facebook yolunda kişinin uygulamaya özgü kimliğini (`appScopedUserId`) saklar ve token'ı hemen denetler.
- Günlük `meta-token-health` tick adımı (`src/server/ads/token-health.ts`): `debug_token` + `/me/permissions` → `metadata.tokenHealth` (geçerlilik, bitiş, veri erişim bitişi, eksik izinler, izin verilen reklam hesapları). Geçersiz token bağlantıyı EXPIRED yapar.
- Integrations → Meta Ads kutucuğu: süre, eksik izin, hesabın Meta'daki durumu ve "Agentelse'e bu hesaba erişim verilmedi" uyarısı.
- **Disconnect (K18)**: token ve reklam metadata'sı hemen silinir, proje bağı kalkar; Meta'da **yalnız** `ads_management` ve `ads_read` geri alınır, o da yalnız aynı kişinin başka bir ACTIVE Meta Ads bağlantısı yoksa. Facebook / Instagram bağlantıları kopmaz.
- Meta'nın deauthorize / veri silme istekleri artık Facebook yolu bağlantılarını da (`appScopedUserId`) eşler.

### Diğer

- `/health` ve eylemleri yalnız platform operatörüne açık (`OPERATOR_USER_IDS`).
- Ajans tetikleri: sahipsiz kalan PROCESSING kayıt 15 dk sonra devralınır; başarısızlıkta 2-4-8… dk (en çok 1 sa) geri çekilme.
- Zamanlayıcı: `nextRunAt` üzerinde CAS claim; deploy örtüşmesinde aynı slot iki kez çalışmaz.
- Telegram poller: bot başına 30 sn kira; aynı `getUpdates` iki kez işlenmez.

## F2 — Ayna ve sürekli denetim

Bayrak: `META_ADS_SYNC=true` (kapalıyken her şey eski canlı yolla çalışır; bayrak kapatılınca geri dönülür).

### Senkron (`src/server/ads/sync/`)

- **Tick adımı `meta-ads-sync`** (agency-wiring, heartbeat'ten hemen sonra): tick başına en çok 3 hesap; hesap başına CAS kilidi (`AdsAccount.syncLeaseUntil`, 5 dk). Kilit aynı zamanda "şu zamana kadar deneme" alanıdır: hata alan hesap 5 dk → 6 sa geri çekilir, kota bloğunda Meta'nın blok süresi kadar bekler; 190'da bağlantı EXPIRED olur ve senkron durur. Senkron P2 şeridinde koşar (hesap kotası %75'i aşınca bekler).
- **Zamanlama** (`src/lib/ads/sync-plan.ts`): sağlık 6 sa; yapı teslimat sürerken 60 dk, boştayken 6 sa; bugünkü insights teslimat sürerken 30 dk, boştayken 6 sa; son 28 günün geri doldurması hesap saatiyle 04:00'ten sonra günde bir; ilk bağlanışta 90 gün (30 günlük parçalarla).
- **Sağlık** (`health.ts`): `account_status`, `disable_reason`, ödeme (okunabiliyorsa), harcama tavanı, asgari bütçeler, DSA varsayılanları ve pikseller. Uyarılar: ACCOUNT_BLOCKED, PAYMENT_ISSUE, SPEND_CAP_NEAR/REACHED, TRACKING_STALE (yalnız dönüşüm hedefli teslimat sürerken piksel 24 saattir sessizse).
- **Yapı** (`structure.ts`): kampanya / ad set / reklam listeleri `AdsObject`'e. Etiket (`[agx:…]`) niyet günlüğüyle eşleşirse nesne "Agentelse kurdu" sayılır ve projesi oradan gelir; Ads Manager'daki kopyası (aynı etiket, farklı kimlik) sayılmaz. Listede görünmeyen nesne `goneAt` alır; Agentelse'in kurduğu nesne önce kimlikle okunur (ARCHIVED / DELETED). Kırpılmış listede bu adım atlanır. 7/28 günlük erişim ve sıklık `windowStats`'a yazılır.
- **Drift**: izlenen alanlar (durum, bütçeler, bitiş, harcama tavanı, teklif stratejisi, hedefleme özeti, kreatif) değişip bizim yazmamızla (`AdsOperation`, bütün projeler) açıklanmıyorsa "Changed in Ads Manager" uyarısı. Bütçe artışı, bitişin ya da tavanın kaldırılması, duraklatılmışın açılması WARN; diğerleri INFO. Otomatik geri alma yok. Agentelse'in güncellemeleri de artık niyet günlüğüne yazılıyor (UPDATE_CAMPAIGN / UPDATE_ADSET / UPDATE_AD, SET_STATUS).
- **Insights** (`insights.ts`): para kararlarının kaynağı hesap satırı ve kimlikle okunan kampanya toplamlarıdır (arşivlenen ve silinen alt nesneler dahil). Ad set ve reklam listeleri ARCHIVED dahil okunur. Silinen Agentelse nesneleri son teslimattan sonra 28 gün kimlikle doldurulur. Sonuç Meta'nın `results` alanından; desteklenmezse ad set hedefinden (`src/lib/ads/results.ts`); ikisi de yoksa "Results unknown". Satırlar toplu `INSERT … ON CONFLICT` ile yazılır; 28 günden eskiler `isFinal`.
- **Bilinçli sapma**: yapı listeleri ARCHIVED nesneleri istemiyor (büyük hesaplarda liste şişmesin). Arşivlenen nesnelerin harcaması yine de hesap ve kampanya toplamlarında, ad set / reklam insights listelerinde var.

### Bekçiler ve uyarılar (`src/server/ads/guard/`)

- Her başarılı senkrondan sonra aynadan (Meta çağrısı yok): **G1** kaçak harcama (bugün > 2 × günlük bütçe ya da Pazar'dan beri > 7,35 ×; bugün düşürülen bütçe hesaba katılır; ömür boyu bütçede uygulanmaz), **G5** ret / sorunlu nesne / ödeme beklemesi / 24 saati aşan inceleme, **G8** teslimat yok (yalnız gerçekten çalışması gereken ad set), "Project paused in Agentelse, ads still running in Meta".
- `meta-ads-guard` (15 dk, süreçler arası kilitli): senkron nabzı (teslimat sürerken 2 saatten eski → SYNC_FAILING), token (geçersiz → TOKEN_INVALID, teslimat varsa CRITICAL; ≤ 7 gün; eksik izin; hesap izin kapsamı dışında), takılan yazma (CHAIN_STUCK), hiç çalışmamış duraklatılmış Agentelse kampanyası (INFO).
- `AdsAlert`: (proje, dedupeKey) başına tek satır; tekrar ederse yeniden açılır, düzelince kendiliğinden RESOLVED, "Mute" 7 gün. CRITICAL Telegram'a gider (CAS ile tek sefer, 24 saatte bir hatırlatma); mesaj Meta verisi taşımaz: "Ads alert for Acme: spending above plan. Open Agentelse: …".
- **Günlük özet** (`ads-daily-digest`, 08:30 proje saati): projenin Ads sohbetine (module "ads" olan en yeni Work; yoksa `ads_<projectId>`) SYSTEM mesajı: dünkü harcama ve planla farkı, çalışan kampanya sayısı, acil / kontrol edilecek uyarılar, bekleyen onaylar, tazelik. Söylenecek bir şey yoksa yazılmaz; gün başına tek.
- **Saklama** (`ads-retention`, günde bir): reklam düzeyi günlük veri 180 gün, diğerleri 400 gün; Meta'da olmayan nesne 90 gün; çözülen uyarı 180 gün. Gizlilik ve veri silme sayfaları buna göre güncellendi; Meta'nın veri silme isteği aynayı da siler.

### Okuyucular

`META_ADS_SYNC` açık ve hesap en az bir kez senkronlanmışken:

- **Ads sayfası** (`/projects/[id]/ads`): kampanya listesi ve rakamlar aynadan; ad set ve reklam envanteri düzenleme formları için canlı, rakamları aynadan. Başlıkta hesap sağlığı, "Updated 12 min ago · Account time (…)", **Refresh** (P1, hesap başına 5 dk'da bir), **Pause all** (onay sorusuyla) ve açık uyarılar (Mute). Durum sütunu "Completed / Paused by you / Stopped by Meta / Archived" yazar, Agentelse'in kurduğu kampanyada "Agentelse" etiketi.
- **Works Meta Ads kartı**: rakamlar aynadan (son 7 gün), açık CRITICAL/WARN uyarılar ve "Pause all"; "Check performance" aynayı tazeler. Teslimat sürerken 2 saatten eski rakam "stale".
- **Analytics** Meta bölümü ve sağlayıcının `META_ADS_ANALYSIS`'i aynadan. Çok günlük aralıkta tekil erişim günlük satırlardan toplanamadığı için gösterilmez (7 günlük ad set / reklam erişimi `windowStats`'tan).
- **Sohbet**: `get_ads_overview` ve `get_ad_performance` okuma araçları (her modülde açık).

### Pause all (`META_SAFETY_ACTION`)

- Yeni yetenek (migration `20261006140100_add_meta_safety_action_capability`, `20261006150000_add_ads_launch`, `20261006150100_add_meta_launch_capability`, `20261006160000_add_ads_decision`). Kullanıcının tıklaması onaydır (L0); sistemin önerdiği duraklatma L4. İş satır içinde sürülür (`driveJobInline`), P0 şeridinde koşar.
- "PAUSE_ALL": açık her kampanya tek yazmayla durur (alt nesneler durumu miras alır); "PAUSE": verilen nesneler. Her yazma `SET_STATUS` olarak niyet günlüğüne düşer; ayna hemen güncellenir.
- **Acil durdurma** `META_ADS_WRITES_DISABLED=true`: reklam yazmaları durur, yalnız duraklatma ve okumalar geçer.

## F3 — Güvenli lansman v2

Bayrak: `META_ADS_LAUNCH_V2=true` (kapalıyken Ads kartı eski üç onaylı zinciri kullanır).

### Akış (Ads kartı)

- **Review**: kart açılınca ön kontrol (`prepareAdsLaunchAction` → `src/server/ads/launch/validate.ts`): hesap gerçekleri (15 dk'dan tazeyse aynadan, değilse canlı), yerel P kuralları (`src/lib/ads/launch-spec.ts`: asgari bütçe, amaç kombinasyonu, Advantage+ yaş kuralı, AB DSA, bölgesel kimlik isteyen ülkeler BR/TW/TH/SG engelli, politika lint'i uyarısı), görsel yükleme (harcamasız), kampanya ve kreatif için Meta `validate_only`, ve Meta'nın kendi önizlemeleri (Facebook feed, Instagram feed / story / reels). Sonuç `AdsLaunch` (VALIDATED ya da DRAFT) satırına yazılır.
- Review'da görünenler: sorunlar (engelleyici kırmızı, uyarı gri), önizlemeler, "You approve up to X (net…)", Meta'nın gün içi temposu, kampanya harcama tavanı, bitiş tarihi (hesap saatiyle).
- **UTM etiketi (GA-F6, `GA_UTM=true`)**: lansman v2 reklamlarından linki projenin kendi sitesine giden ve `utm_content` taşımayanlar `DEFAULT_URL_TAGS` yerine agx UTM şablonunu kullanır: `utm_source=facebook`, `utm_medium=paid_social`, `utm_campaign=agx-<kampanya>`, `utm_content=agx_<kod>`, `utm_term={{site_source_name}}`. Linkte zaten olan diğer `utm_*` anahtarları korunur. Etiketler Review'da hesaplanır (Meta `validate_only` bunları sınar) ve Approve aynısını kullanır; Review "Tracking: UTM added" notunu gösterir. Optimizer karar kanıtına düz `ga4_*` anahtarları ekler (GA-F6); GA Disconnect'te bunlar silinir. Eski `META_AD_CREATE` zinciri etiketlemez. Ayrıntı: [website-attribution.md](website-attribution.md).
- **Approve & launch** (ya da **Create paused**): tek `META_LAUNCH` görevi (L4). Tıklayan OWNER/ADMIN ise aynı dokunuşta onaylanır ve iş `after()` ile istek beklemeden sürülür (`src/server/ads/launch/drive.ts`); MEMBER ise onay yöneticiyi bekler ("Approve launch" düğmesi kartta). Onay, kontrol edilen spec'e verilir: Brief/Plan sonradan değiştiyse yeniden kontrol gerekir (`specHash`).
- **Launch**: Campaign / Ad set / Ad halkaları lansman kaydından okunur; durum "Live", "Created, paused", "Stopped", "Discarded". Düğmeler: **Try again** (aynı lansman, yeni görev; başarılı adımlar atlanır), **Turn on** (duraklatılmış oluşturmada ayrı L4), **Discard** (güvenlik eylemi, L0).

### Yürütücü (`src/server/ads/launch/executor.ts`)

- Asenkron adım makinesi: `execute()` lansmanı işe bağlayıp döner; her `getStatus()` en çok 3 yazma ilerler (governor kotası tick'i bloklamaz). Sıra: görseller → kreatifler → kampanya (PAUSED, `spend_cap`) → ad set'ler (ACTIVE, `end_time` = başlangıç + gün, hesap saatiyle 23:59) → reklamlar (ACTIVE) → geri okuma → aktifleştirme (kampanya ACTIVE, tek yazma). Kampanya kapalıyken teslimat olmaz: yarıda kesilen lansman harcama yapmaz.
- Her yazma niyet günlüğünde (`AdsOperation.launchId` + `stepKey`): başarılı adım bir daha gönderilmez; yanıtı kaybolan yazma 60 sn sonra etiketle aranır, bulunamazsa bir kez daha gönderilir; iki kez doğrulanamazsa lansman durur. Meta'nın doğrulama hatası adımıyla ve Meta'nın metniyle kartta görünür.
- **Frenler**: kampanya `spend_cap` = max(hesabın asgari kampanya tavanı, zarf × 1,1); ad set `end_time` her lansmanda. Geri okumada `end_time` yoksa kampanya açılmaz.
- **Meta AI dönüşümleri** (K14): içerik üreten / metni değiştiren özellikler OPT_OUT, yerleşime uyarlama OPT_IN, çok reklamverenli reklam OPT_OUT. Meta listeyi reddederse kreatif onsuz kurulur ve Review'da not düşülür.
- **Discard**: hiç gösterim almamış kampanya DELETED, almış olan ARCHIVED.
- Kilit: `AdsLaunch.leaseUntil` (işçinin yoklaması ile satır içi sürüş aynı anda yazmaz). Bekçi `meta-launch-watchdog` (10 dk): 30 dakikadan uzun süren lansman işi ölmüşse FAILED, sürüyorsa CHAIN_STUCK uyarısı; onayı reddedilen / süresi dolan lansman CANCELLED / EXPIRED.

### Diğer

- `AdsLaunch` tablosu (migration `20261006150000_add_ads_launch`) ve `META_LAUNCH` yeteneği (`20261006150100_add_meta_launch_capability`); onay kartı net zarfı, bitişi, harcama tavanını, kitleyi ve tempoyu yazar.
- Modüller ve v2 açıkken sohbetteki "kampanya kur" isteği ve Ads sayfasının "Create an ad" düğmesi Ads kartını açar; eski oluşturma formları gizlenir. Ölü `maybeProposeMetaCampaign` silindi.
- **Henüz yok**: Instagram kimliği seçimi (P9; IG yerleşimleri Sayfa kimliğiyle çalışır), marka düzeyinde UTM / Meta AI / DSA ayarları (varsayılanlar kullanılıyor), video kreatif (F5b).

## F5a — Mesaj ve trafik amaçları

Bayrak: `META_ADS_PLANNER=true` ve `META_ADS_LAUNCH_V2=true` (mesaj hedefi eski zincirde yok).

- **Amaç tablosu** (`src/lib/ads/objectives.ts`): Traffic (link tıklaması / açılış sayfası görüntüleme), Awareness, Engagement, Messages (WhatsApp, Messenger, Instagram Direct; CONVERSATIONS), F5b için Leads ve Sales. P2 doğrulayıcısı bu tablodan okur.
- **Brief**: "Messages" kartı; nereden yazılacağı (WhatsApp / Messenger / Instagram), WhatsApp'ta Sayfanın kullandığı numara, ortalama yanıt süresi (kullanıcının beyanı). Mesaj hedefinde bağlantı ve buton sorulmaz. Traffic'te son 7 günde olay gönderen piksel varsa açılış sayfası görüntüleme seçilir; yoksa "Meta optimizes for link clicks…" uyarısı.
- **Kurulum**: mesaj ad set'i `promoted_object.page_id` (+ WhatsApp numarası) ile; kreatif CTA'sı WHATSAPP_MESSAGE / MESSAGE_PAGE / INSTAGRAM_MESSAGE (`app_destination`; test hesabında doğrulanmalı).
- **Instagram kimliği (P9, kısmi)**: reklam hesabının kullanabildiği Instagram hesabı (`act_x/instagram_accounts`) varsa reklama `instagram_user_id` olarak gider; Instagram Direct yalnız o varken sunulur. Hesap başına 15 dk önbellek (`src/server/ads/account-assets.ts`).
- Review notu: mesaj hedefinde "Instant Reply ve Away message kurun".
- **Bilinçli sapma**: mesai saatleriyle zamanlama (`adset_schedule`) sunulmuyor; akış günlük bütçeyle kurulduğu için Meta'nın kuralı (yalnız `lifetime_budget`) gereği.

## F4 — Optimizasyon v2

Bayrak: `META_ADS_OPTIMIZER` = `off` (varsayılan) / `shadow` / `on`. Ayna (`META_ADS_SYNC`) açık olmalı.

- **Kurallar** (`src/lib/ads/rules/`, saf ve testli): pencere özellikleri (bugün, dün, 3 / 7 gün, önceki 7 gün, 28 gün taban; sıklık `windowStats`'tan), G3 sonuçsuz harcama (≥ 1.000 gösterim; site dışı dönüşümde son gün hariç), O2 yüksek CPA (−%25, bugünkü harcamanın %110'u ve asgari bütçe tabanı), O3 ölçek (+%20; sıklık < 2,5, ≥ 10 sonuç), O4 yorgunluk (en az iki sinyal), O5 kaybeden reklam (Meta harcamayı zaten çekiyorsa önerilmez), O6 düşük CTR, O7 zayıf açılış, O8 learning limited, O13 zayıf izlenme, O14 kreatif ritmi. Birden çok bulgu birlikte döner.
- **Hedef CPA**: lansmanın KPI'ı (F5b) → ad set'in kendi 28 günlük tabanı (≥ 10 sonuç) → hesabın tabanı. Hedef yoksa hedef isteyen kurallar susar.
- **Kapılar**: öğrenme koruması (LEARNING ya da son anlamlı düzenlemeden 72 sa; acil G kuralları hariç), 24 saatte bir bütçe değişikliği, haftada iki anlamlı düzenleme, reddedilen karar 14 gün susar (sorguyla).
- **Kayıt** (`AdsDecision`, migration `20261006160000_add_ads_decision`): parmak izi kural + nesne + ISO haftası. `shadow`'da yalnız SHADOW kaydı. `on`'da para / durum kararı sistem önerisi olarak META_*_UPDATE görevi (L4), yorgunluk ve ritim fikir havuzuna 3 konsept isteği (otomatik görsel yok), bilgi kararı Ads sayfasında "SUGGESTION" uyarısı.
- **Uygulama**: CAS — önerildiği andaki bütçe / durum Meta'da değiştiyse yazılmaz, karar SUPERSEDED. Görev kancaları kararı APPLIED / REJECTED / EXPIRED / FAILED yapar; 3 dk sonra geri okuma → VERIFIED.
- **Değerlendirme** (`ads-decision-lifecycle`, 30 dk): uygulamadan 7 gün sonra + olgunluk (site dışı dönüşüm 7, platform içi 2 gün); önce / sonra 7'şer gün, Poisson kapısı → WORKED / DIDNT / INCONCLUSIVE. İşe yaramayan bütçe artışına geri alma önerisi.
- **Kart**: önerinin "Why" satırı (kanıttaki sayılarla şablon metin); son 7 günde uygulanan değişikliğe tek dokunuşla **Undo** (OWNER/ADMIN'in tıklaması onaydır).
- **Bilinçli sapmalar**: açıklamalar şablon metindir (LLM katmanı bağlanmadı; sayılar kanıttan gelir). `ProjectGoal.currentValue` güncellenmiyor (hedef anahtarları yalnız reklam sayısına denk gelmiyor). Eski `performance-optimizer` / `meta-performance-rules` / `meta-performance-scanner` dosyaları, bayraklar canlıda açılıp en az iki hafta sorunsuz çalışana kadar silinmedi (ayna açıkken zaten atlanıyorlar).

## F5b — Planlama motoru ve formlar

Bayrak: `META_ADS_PLANNER=true` ve `META_ADS_LAUNCH_V2=true`. Her amaç ayrıca kod düzeyindeki hazır listesiyle açılır (`READY_RECIPES`, `src/lib/ads/objectives.ts`).

- **KPI hedefi** (`src/lib/ads/kpi.ts`): Brief'te "Your target": "From my numbers" (ortalama satış değeri × 10'da kaçı müşteri olur × %30 pazarlama payı = başabaş; hedef başabaşın %70'i) ya da "Max cost". Hedef spec'in `kpi`'ına gider, F4 kuralları önce bunu kullanır; onaylanan lansmanda `ProjectGoal` (`ads.cpl` / `ads.cpa` / `ads.cost_per_conversation` / `ads.cost_per_click`) ACTIVE + USER onaylı yazılır, güncel değeri haftada bir aynadan güncellenir.
- **Öğrenme fizibilitesi**: günlük bütçe < hedef × 50/7 ise Brief'te ve Review'da "learning limited" uyarısı ve önerilen bütçe.
- **Kitle**: "Suggest to Meta" (varsayılan; Advantage+ audience açık, yaş en çok 25 ile başlar ve 65+'ya açılır, Brief'in yaşları öneridir) ya da "Limit to these" (sert sınır).
- **Bütçe**: "Per day" ya da "In total" (FIXED: `lifetime_budget`, Meta iyi günlerde daha çok harcar; bitiş yine ad set `end_time`).
- **Kreatif çeşitliliği**: en çok 2 ek post aynı ad set'te ayrı reklam olur (metni kendi açıklamasından).
- **Mevcut ad set'e ekleme**: "Where: Add to an ad set" — kampanya ve ad set kurulmaz, bütçe değişmez; reklamlar ACTIVE eklenir, incelemeden sonra yayına girer.
- **Tahmin** (Review): `reachestimate` kitle aralığı ("About 120,000–150,000 people", 100 binin altı "dar kitle" notu) ve hesabın 28 günlük maliyetinden "Expected: 25–40 … a week (directional)".
- **Ücret** (`src/lib/ads/fees.ts`, tarihli): konum ücretiyle tahmini fatura ("plus VAT where it applies"; KDV hesaplanmaz).
- **Leads** (anında form): spec, yürütücü adımı (`/{page_id}/leadgen_forms`, Sayfa token'ı, Higher intent), CTA ve günlük "New leads today: N — open Leads Center" bildirimi kodlandı; `pages_manage_ads` App Review'dan geçene kadar `READY_RECIPES.leads_instant_form = false` (Brief'te görünmez). Lead'lerin kişisel verisi okunmaz ve saklanmaz (gizlilik metni güncellendi).
- **Önerilen hedef**: piksel varsa Traffic, yoksa Messages (gerekçesiyle).
- **Henüz yok**: iki oranlı `asset_feed_spec` (test hesabında doğrulanana kadar tek görsel + `adapt_to_placement`), içerik planındaki metin-tabanlı `ads.campaign` parçasına "Make this ad" köprüsü (görselli postlar için "Boost with an ad" zaten var).

## F6 — Raporlama ve öğrenme

Bayrak: `META_ADS_REPORTS=true` (ayna açık olmalı).

- **Haftalık rapor** (`src/server/ads/reports/weekly.ts`): Pazartesi 08:00 (proje saati), geçen Pazartesi–Pazar (hesap günü), Ads sohbetine SYSTEM mesajı: harcama ve önceki haftaya göre fark, sonuç ve maliyet, KPI hedefiyle karşılaştırma, dönem erişimi ve sıklığı (tek Meta okuması; günlük satırlardan toplanmaz), teşhis ("Cost per result +37%: CPM +30% (auction or season), link CTR flat, conversion −5%"), haftayı taşıyan 3 reklam (yönlendirici), alınan kararlar ve sonuçları, bekleyen öneriler, "Meta suggests…" (ikinci görüş, asla otomatik uygulanmaz), atıf etiketi ve "Recent days may still change". Brand Brain için haftada tek özet Signal (PERFORMANCE).
- **Aylık müşteri raporu**: ayın 1'i 09:00: ay toplamları, erişim, hedefler, işe yarayan karar oranı, yeni öğrenmeler, bugünkü bütçelerle gelecek ayın tutarı, mutabakat sorusu ("How many new customers did you get from ads last month?"), Ad Library bağlantısı (ülke dolu). Markdown / PDF için Analytics modülünün Share adımı (Meta bölümü artık aynadan).
- **Teşhis ağacı** (`src/lib/ads/reports/diagnose.ts`): Δln CPA = Δln CPM − Δln CTR − Δln CVR (testli).
- **Öğrenmeler** (`src/server/ads/reports/learnings.ts`): değerlendirilmiş ve en az 10 sonuçlu kararlardan `BrandLearning` (`sourceType = META_ADS`, WORKS / AVOID); metin n'yi içerir, n < 25 "directional".
- **Brand sekmesi "Ads" kartı** (K22): sağ dok → Brand: son 7 gün harcama, sonuç, maliyet, çalışan kampanya, dikkat isteyen uyarı sayısı ve tazelik; "Open" Ads sayfasına götürür. Ayna kapalıysa görünmez.
- **Bilinçli sapma**: rapor metinleri şablondur (LLM özeti bağlanmadı; her sayı aynadan).

## F7 — Webhook ve koruma raylı otonomi

Migration: `20261006180000_add_ads_autonomy_and_webhook_events` (`AutonomyPolicy.adsAutonomy` + `adsMonthlyCapMinor`, `AdsAccount` webhook alanları, `AdsWebhookEvent`).

### Webhook (`META_ADS_WEBHOOKS=true`)

- **Uç** `src/app/api/webhooks/meta-ads/route.ts` (oturumsuz, `public-paths.ts`'te): GET yalnız `META_ADS_WEBHOOK_VERIFY_TOKEN` tutarsa `hub.challenge` döner; POST ham gövdenin `X-Hub-Signature-256` HMAC'i `META_APP_SECRET` ile tutmazsa 401. Olaylar `AdsWebhookEvent`'e yazılır ve hemen 200 dönülür (bayrak kapalıyken de 200: Meta başarısız teslimatta aboneliği düşürür). Gövde en çok 512 KB.
- **Tekilleştirme**: gövdede olay kimliği yok; `dedupeKey` = sha256(hesap + zaman + alan + nesne + değerin anahtar sırasından bağımsız JSON'u) (`src/lib/ads/webhooks.ts`, testli). Yük anahtarları belgede kesin değil: nesne kimliği `ad_object_id` / `object_id` / `id`… sırasıyla okunur; yeni değer hiçbir zaman gövdeden alınmaz.
- **İşleyici** (`src/server/ads/webhooks.ts`, tick adımı `meta-ads-webhooks`): olaylar 2 dk bekletilir (art arda olaylar tek okumada birleşir), her nesne hedefli okunur ve aynanın yalnız durum alanları (effective status, issues, review feedback, delivery checks) tazelenir; ardından o hesabın bekçileri hemen koşar: ret ve teslimat sorunu uyarısı yoklamayı beklemeden gelir. Bütçe / durum gibi izlenen alanlar yazılmaz (drift kararı yapı senkronunda kalır). `creative_fatigue` → INFO uyarı. 5 denemeden sonra DEAD (/health "Meta Ads clean-up"). 14 gün saklanır.
- **Abonelik** (`src/server/ads/webhook-subscriptions.ts`, tick adımı `meta-ads-webhook-subscriptions`): uygulama aboneliği (object `ad_account`, alanlar `effective_status`, `with_issues_ad_objects`, `in_process_ad_objects`, `creative_fatigue`, `ad_recommendations`) günde bir doğrulanır, yoksa kurulur; her hesap günde bir `subscribed_apps` ile denetlenir, düşmüşse yeniden abone olunur. Hesapta MANAGE görevi yoksa "polling only": Ads sayfası başlığı "Real-time alerts need an admin of this ad account" der (abone olunca "Real-time alerts on"). Yoklama her durumda yedektir.

### Otomatik pilot (`META_ADS_AUTOPILOT=true`)

- **Ayar**: Settings → Autonomy → "Ads autopilot" kartı: Suggest only (varsayılan) / Guarded auto / Full auto, aylık harcama tavanı ve onay kutusu. Yalnız workspace OWNER/ADMIN kaydeder; Suggest dışı seviye onay kutusu ister; her değişiklik AuditLog'a (`ads_autopilot.updated`).
- **Guarded auto** (`src/lib/ads/autopilot.ts`, testli): kendiliğinden yalnız riski azaltanlar: kaçak harcamada (G1) ve onaylı zarf / aylık tavan dolunca (G2) kampanyayı, platform içi sonuçta (mesaj, anında form) sonuçsuz harcamada (G3) ad set'i duraklatma; yüksek CPA'da (O2) bütçeyi en çok %30 düşürme (aynı nesnede 72 saatte bir). Bütçe artışı, etkinleştirme, hedefleme / kreatif değişikliği, yeni kampanya asla. Kural listesi dışındaki kararlar (O5 kaybeden reklam, kreatif yenileme…) öneri kalır.
- **Full auto**: ek olarak O3'te en çok %20 bütçe artışı (72 saatte bir, hesap saatiyle 18:00'den sonra yok, ay sonuna kadarki ek maliyetle aylık tavanı aşmıyorsa). Önkoşullar kartta satır satır: standard access, süresi dolmayan (system user) token, sağlıklı hesap ve izleme, en az 30 günlük geçmiş, aylık tavan. Önkoşullar tutmadan seçilemez.
- **Kapılar**: bayrak, sağlıklı token, taze ayna (2 saat), acil durdurma (yalnız duraklatma), proje başına 24 saatte en çok 5 otomatik eylem (aşılırsa karar insan onayına düşer). Otomatik olmayan kararın gerekçesi kanıtına yazılır (`evidence.autopilot`).
- **Yol**: riski azaltan eylem `META_SAFETY_ACTION` görevidir (`PAUSE` ya da yeni `BUDGET_DOWN`), Full artışı `META_ADSET_UPDATE` / `META_CAMPAIGN_UPDATE`; görev hemen satır içinde sürülür. Karar `autonomy = GUARDED|FULL`, `status = APPLYING` olur; uygulanınca Ads kartında "Auto-paused · <reklam>" / "Budget lowered automatically · <reklam>" uyarısı ve Ads sohbetinde mesaj; kartın Undo'su geri alır (geri alınınca uyarı kapanır, 3 günde kendiliğinden kapanır). Başarısız otomatik eylem CRITICAL (Telegram).
- **Onay politikası istisnası** (`approval-policy.ts`, testli): "yalnız yükseltir" kuralının yazılı tek istisnası: SYSTEM + `META_SAFETY_ACTION` + GUARDED/FULL + `riskReducing` → L1; SYSTEM + FULL + `autoBudgetRaise` → yalnız kampanya / ad set güncellemesinde L1. Proje override'ı yine yükseltir.
- **Savunma derinliği** (`meta-api-provider.ts`, testli): güvenlik eylemi yalnız `PAUSE`, `PAUSE_ALL`, `BUDGET_DOWN`, `DISCARD_LAUNCH`; `ACTIVE` hiçbir zaman. `BUDGET_DOWN` Meta'daki güncel bütçeyi geri okur (CAS; değiştiyse SUPERSEDED), yalnız düşüşü ve sistemde en çok %30'u yazar. İnsansız (sistemin açtığı, onaysız) kampanya / ad set yazması yalnız `autopilot: "FULL"`, yalnız bütçe, en çok %20 ve proje o an FULL ise geçer.
- **Arşivleme otomatik değil** (bilinçli sapma): Meta'da arşiv geri alınamaz, her otomatik eylem ise geri alınabilir olmalı. Yetim kampanya uyarısı öneri kalır.
- **G2** (`watchdogs.ts`): lansmanın etkinleştirmeden bu yana harcaması onaylı zarfa ulaşınca `ENVELOPE_REACHED` (CRITICAL); ay içi harcama projenin aylık tavanına ulaşınca ve Agentelse kampanyası hâlâ açıksa `MONTHLY_CAP_REACHED` (CRITICAL). Guarded / Full'de ikisi de kampanyayı duraklatır. Tavan her seviyede uyarı üretir.

### Ad Rules sigortası (`META_ADS_RULES=true`, isteğe bağlı)

- `src/server/ads/insurance.ts` + `src/server/integrations/meta/ad-rules.ts`: çalışan her lansman kampanyasına "Agentelse safety · <kampanya>" adlı SCHEDULE kuralı (yarım saatte bir; kimlik filtreli: `campaign.id IN [..]`; "bugünkü harcama > eşik → PAUSE"). Eşik = 2 × bugün yürürlükte olmuş en yüksek günlük bütçe (`src/lib/ads/insurance.ts`, testli): düşürmede o gün eski değer kalır, gece yarısından sonra iner; artışta hemen yükselir. Kural kimliği `AdsLaunch.guards.ruleId`'de.
- Lansman bitince / kampanya gidince kural silinir; Disconnect'te izinlerden önce silinir, silinemeyen /health "Meta Ads clean-up"ta listelenir.
- Kural yürütmeleri yapı senkronunun başında `adrules_history`'den okunur, RULE aktörlü `AdsOperation` olur (drift sayılmaz) ve "Paused by Agentelse safety rule: …" uyarısı açılır.

## F8 — Ajans ölçeği ve token modeli

Bayrak: `META_ADS_AGENCY=true`. Migration: `20261006200000_add_ads_connection` (`AdsConnection`, `AdsAccount.connectionId` + `asyncInsights`, `AdsObject.targeting`, `AutonomyPolicy.adsSpendApproverIds`).

- **Workspace bağlantısı (FLfB + BISU)**: `/ads` sayfasındaki "Connect a business" (yalnız OWNER/ADMIN) Facebook Login for Business'ı `config_id` ile açar (`src/server/integrations/meta/business-login.ts`, uçlar `/api/integrations/meta-business/{start,callback}`; state imzalı, oturumdaki kullanıcıyla eşleşmeli). Dönen token `debug_token` ile denetlenir: süresizse `BISU` (business'lı) / `SYSTEM_USER`, süreliyse `USER`. `/me?fields=client_business_id` ile business bulunur; aynı business'ı yeniden bağlamak aynı satırı günceller ve atanmış projelerin kopyalarını yeniler (`src/server/ads/connections.ts`). Günde bir `debug_token` denetimi: geçersizse bağlantı ve kopyaları EXPIRED.
- **Projelere atama**: `/ads` → "Not in a project yet": business uçlarından (`owned_ad_accounts` + `client_ad_accounts`, Sayfalar için `owned_pages` + `client_pages`) gelen hesap bir projeye (ve isteğe bağlı Sayfaya) atanır. Atama projenin Meta Ads bağlantısını bu token'ın kopyasıyla kurar: ayna, lansman, kararlar ve bekçiler değişmeden çalışır. Bir bağlantı birden çok projeye hesap atar. Yalnız bağlantının kendi hesabı ve workspace'in projesi kabul edilir (testli).
- **Ajans görünümü** `/ads`: workspace'in bütün hesapları (sağlık, son 7 gün harcama, çalışan kampanya, kritik / kontrol edilecek uyarı, tazelik, gerçek zamanlı uyarı, projeler ve otomatik pilot seviyeleri). Projenin Ads sayfası başlığında "All ad accounts" bağlantısı.
- **Sürümlü anahtar** (`src/server/security/key-ring.ts`, testli): bağlantı token'ı `META_TOKEN_KEYS="k2:<64 hex>,k1:<64 hex>"` ile (ilk anahtar yazmada, hepsi okumada) şifrelenir, `keyId` satırda; tanımlı değilse ortak anahtar (`legacy`). Anahtar değişince günlük denetim eski kayıtları yeni anahtarla yeniden yazar. Proje kopyaları mevcut yolların okuduğu ortak anahtarla kalır.
- **Müşteri onaylayıcısı**: Settings → Autonomy → "Spend approvers": OWNER/ADMIN olmayan üyeler (ör. müşteri) yalnız o projenin L4 harcama onayını verebilir (`ApprovalRepository.decide` kapısı, testli). Telegram L4 eşlemesi yapılmadı (gerek olunca).
- **Batch okuma** (`src/server/integrations/meta/batch.ts`, testli): en çok 50 GET tek istekte; webhook işleyicisi nesneleri tek batch'te okur.
- **Async insights** (`src/server/ads/sync/async-insights.ts`): reklam düzeyi liste okuması "çok fazla veri" (100/1504018, 2/1504038, 100/1487534) verirse rapor Meta'da arka planda hazırlanır; tick hesap başına tek durum kontrolü yapar, "Job Completed"ta satırlar yazılır, "Job Skipped" yeniden gönderilir. Hesap başına günde min(10, açık reklam) iş; dolunca bilgi uyarısı ("Some ad-level numbers arrive tomorrow"). Bayrak kapalıyken eski davranış (hata yükselir).
- **Metrik anomalisi** (`src/lib/ads/anomaly.ts`, testli): günde bir hesap başına dünün CPM, CPA ve link CTR'ı, haftanın gününe göre düzeltilmiş 14 günlük tabana göre z-skoru (|z| ≥ 3, yalnız kötü yön, asgari hacim) → `METRIC_ANOMALY` uyarısı.
- **Kitle çakışması** (`src/lib/ads/overlap.ts`, testli): aynada ad set hedeflemesinin özeti tutulur (konum, yaş, cinsiyet, kitle kimlikleri); aynı amaçla çalışan iki ad set aynı insanları kapsıyorsa `AUDIENCE_OVERLAP` önerisi.
- **Bilinçli sapmalar**: proje başına çok hesap şemada var (AdsAccountProject) ama arayüz ve lansman v1'de tek seçili hesapla çalışır; ajans system user + partner erişimi ve Meta'da bağlantının uzaktan kaldırılması yok (müşteri Business Settings → Integrations'tan kaldırır).

## Carousel reklam (modül akışı)

Brief'te ana posta ek post seçilince "How should they show?" çıkar: **Separate ads** (varsayılan; en çok 3 post, her biri ayrı reklam) ya da **One carousel** (2-10 post, hepsi tek reklamın kartı). Yalnız bağlantılı hedeflerde (trafik, erişim, etkileşim); mesaj ve anında form carousel olmaz (şema, Brief ve yerel kurallar bunu üç yerde engeller).

- Spec: `ads[].creative.cards[]` (2-10; `imageAssetId`, `headline`, `description`, `link`); ilk kart `imageAssetId` ile aynıdır. `specHash` yalnız carousel'de kartları katar: eski spec'lerin özeti değişmedi.
- Görseller (`src/lib/ads/launch-images.ts`): her kart ayrı yuva (ilk kart reklamın kendi anahtarı, sonrakiler `index:kart`); Review'da ve yürütücüde bir kez yüklenir, yeniden denemede tekrar yüklenmez.
- Meta yazısı: eski sihirbazda canlıda kanıtlanmış `link_data.child_attachments` biçimi (`objectStorySpec`). Review'da `validate_only` ile Meta ön kontrolü ve önizleme carousel'i de kapsar; kart başlıkları politika denetiminden geçer.
- Kartın başlığı post başlığından (40 karaktere kısaltılır). Görseller 1:1 değilse Meta kırpar; test lansmanında önizlemeden kontrol et.
- Doğrulanmadı: Meta'nın carousel `ON_POST` etkileşim hedefindeki davranışı. İlk gerçek denemede Review'daki Meta ön kontrolü sorunu gösterir.

## Mesai saatlerinde yayın (modül akışı)

Brief'te bütçe **toplam (in total)** seçiliyken "When should the ad run?": **Business hours** (başlangıç ve bitiş saati, yalnız hafta içi ya da her gün; hesap saatine göre). Meta `adset_schedule`'ı yalnız toplam bütçeli ad set'te kabul eder; günlük bütçede ve mevcut ad set'e eklemede seçenek çıkmaz, şema ve spec de bunu reddeder.

- Spec: `adSets[].schedule` ({days 0=Pazar…6, startMinute, endMinute; saat başı}). `src/lib/ads/day-parting.ts` (testli) Meta'nın alanını üretir; ad set yazısı `pacing_type=["day_parting"]` + `adset_schedule` (`timezone_type=ADVERTISER`) gönderir. `specHash` yalnız zamanlama varken değişir.
- Review notu: "Ads run Mon–Fri 09:00–18:00 (account time)…".
- Doğrulanmadı: ad set için `validate_only` kullanılmıyor, yani zamanlama hatası lansman sırasında ad set adımında çıkar (kampanya o noktada kapalı: harcama olmaz, "Fix and retry"). İlk denemeyi `socialmedia` test hesabında yap.

## Instagram profil ziyareti (kapalı gelir)

Trafik amacının ek hedefi: Brief'te "Instagram profile visits" kartı (yalnız hesapta Instagram varsa ve tarif açıksa). Tarif `traffic_instagram_profile`: `OUTCOME_TRAFFIC` + `optimization_goal=PROFILE_VISIT` + `destination_type=INSTAGRAM_PROFILE` (iki enum Meta'nın ad set referansında doğrulandı). Reklamın bağlantısı hesabın Instagram profilidir (`https://www.instagram.com/<kullanıcı>/`, sunucu kurar); Brief'te web bağlantısı sorulmaz.

- **Kapalı**: `READY_RECIPES` içinde `false`. Açmak için Railway'de `META_ADS_READY_RECIPES=traffic_instagram_profile` (kodsuz). Kapalıyken yerel kurallar lansmanı engeller ("… isn't open yet") ve kart Brief'te görünmez.
- Sonuç sayısı Meta'nın `results` alanından gelir; `PROFILE_VISIT` için yedek eşleme yoktur (bilinmeyen hedef "unknown", optimizer yanlış "sonuçsuz" kararı üretmez).
- Doğrulanmadı: ad set için `promoted_object` gerekip gerekmediği ve profil reklamının CTA'sı. Ad set için `validate_only` kullanılmadığından sorun lansmanın ad set adımında çıkar (kampanya o noktada kapalıdır). İlk denemeyi `socialmedia` test hesabında yap.

## Video reklam (`META_ADS_VIDEO=true`, kapalı gelir)

Brief'te "Video (optional)": projenin Library'sindeki videolardan biri seçilir; ana postun görseli kapağı olur. Video **tek reklamdır**: ek post, carousel, mesaj ve anında formla olmaz (Brief şeması, spec ve yerel kurallar üç yerde engeller). Yalnız bayrak açıkken ve Library'de video varken bölüm görünür; sunucu seçilen videonun bu projeye ait olduğunu yeniden doğrular.

- **Yükleme ve işleme** (`src/server/ads/launch/video.ts`, testli): Review'da video Meta'ya bir kez yüklenir (`advideos`, eski sihirbazın yolu; Library sınırı 200 MB), Meta onu arka planda işler (dakikalar sürebilir). Her çağrı en çok bir yükleme yapar ve slot başına tek durum sorgusu atar, hiçbir yerde uyunmaz. İşleme sürerken Review "Meta is still processing your video…" der, **Approve & launch kapalı** kalır ve kart 15 sn'de bir sessizce yeniler; hazır olunca Meta ön kontrolü (validate_only + önizleme) çalışır. İşleme hatası ya da Library'den silinen video Review'da engeller.
- **Yürütücü**: aynı yardımcı kreatiften önce videonun hazır olmasını bekler (`RUNNING`, işçi turları arasında); hata Meta'nın sözleriyle durdurur. Aynı video yeniden denemede tekrar yüklenmez (`progress.videos`).
- **Kreatif**: eski sihirbazda canlıda kanıtlanmış `video_data` biçimi: adres CTA'nın içinde, kapak `image_url` ile herkese açık adresten (video_data hash kabul etmez). Cloud depolama (R2) kapalıysa kapağın adresi yoktur ve Review bunu söyler.
- Doğrulanmadı: çok büyük videoda tek istekli yükleme sınırı (Meta parçalı yükleme önerir; 200 MB'a kadar eski sihirbazda çalışıyor). İlk denemeyi `socialmedia` test hesabında kısa bir videoyla yap.

## Sahip adımları (kod dışı)

1. **Birikim raporunu oku**: yeni bir terminal sekmesinde, repo klasöründe `npm run db:report:backlog`. Çıktıyı Claude'a yapıştır.
2. **İşçiyi aç (K1)**: Railway → `@agentelse` web servisi → Variables → `ENABLE_INPROCESS_WORKER=true` (yalnız bu serviste).
3. **CRON_SECRET'i eşitle**: yeni bir değer üret; aynı değeri Railway web servisine ve GitHub → Settings → Secrets → `CRON_SECRET`'e yaz. `PROD_WORKER_URL`'i kontrol et.
4. **Bozuk Railway `cron-worker` servisini sil.**
5. **Harici monitör (K23)**: GitHub dışı ücretsiz bir uptime servisi 5 dakikada bir `https://<uygulama>/api/health?worker=1` adresini çağırsın; 503'te e-posta/Telegram göndersin.
6. **Migration**: deploy'da `prisma migrate deploy` otomatik çalışır (`20261006120000_add_system_heartbeat`, `20261006130000_add_ads_account_and_operation`, `20261006140000_add_ads_mirror_and_alerts`, `20261006140100_add_meta_safety_action_capability`).
8. **Operatör**: Railway web servisine `OPERATOR_USER_IDS=<kendi kullanıcı kimliğin>` (kimliği /health sayfası gösterir).
9. **"Require App Secret" (K21)**: Meta App Dashboard → Settings → Advanced → "Require App Secret" açılabilir (bütün çağrılar artık `appsecret_proof` taşıyor). Önce canlıda bir gün izle.
7. **Onay süresi backfill'i**: deploy'dan sonra `npm run db:backfill:approval-expiry` (kuru) → çıktıyı kontrol et → `npm run db:backfill:approval-expiry -- --apply`.
10. **F2'yi aç**: önce test reklam hesabıyla Railway web servisine `META_ADS_SYNC=true`. İlk senkron hesabın 90 gününü çeker; Ads sayfasında "Updated … ago" görünmeli. Gerçek müşteri hesaplarında açmak Full tier onayına bağlı (plan §7).
11. **F3'ü aç**: `META_ADS_LAUNCH_V2=true` (modüller açıkken eski formlar gizlenir). Önce test reklam hesabında bir lansman: Review'da önizlemeler ve "Meta checked…" görünmeli; Launch'ta üç halka "Created", ardından "Live". Uygulama dev moddayken reklam adımı 1885183 ile düşer (plan §7): gerçek müşteri öncesi Live mod + Full tier.
12. **F5a**: `META_ADS_PLANNER=true` (v2 açıkken). Brief'te "Messages" kartı görünmeli; test hesabında bir WhatsApp ve bir Messenger lansmanı.
13. **F4 gölge mod**: `META_ADS_OPTIMIZER=shadow`; en az 30 karar ya da 4 hafta sonra kararları birlikte inceleyin (kabul ≥ %60 → `on`).
14. **Leads**: Meta App Review'da `pages_manage_ads` onaylanınca `src/lib/ads/objectives.ts` → `READY_RECIPES.leads_instant_form = true` (tek satır); test hesabında bir form lansmanı.
15. **F6**: `META_ADS_REPORTS=true`; ilk haftalık rapor Pazartesi 08:00'de Ads sohbetinde.
16. **F7 webhook**: Railway web servisine `META_ADS_WEBHOOK_VERIFY_TOKEN=<rastgele uzun değer>` ve `META_ADS_WEBHOOKS=true`. Uygulama aboneliği ertesi tick'te kendiliğinden kurulur (Meta, `https://<uygulama>/api/webhooks/meta-ads` adresini doğrular); istersen App Dashboard → Webhooks → Ad Account'tan kontrol et. Ads sayfası başlığında "Real-time alerts on" görünmeli; admin olmayan hesapta "Real-time alerts need an admin of this ad account". Webhook'lar uygulama Live moddayken gelir (plan §7).
17. **F7 otomatik pilot**: önce Meta App Review'daki `ads_management` kullanım açıklamasına otomatik koruma eylemlerini ekle (gizlilik metni güncellendi: "If a workspace owner or admin turns on Ads autopilot…"). Sonra `META_ADS_AUTOPILOT=true` ve Settings → Autonomy → Ads autopilot → "Guarded auto" + onay kutusu. Full auto, önkoşullar tutunca (F8'in system user bağlantısı dahil) açılabilir.
18. **F7 Ad Rules (isteğe bağlı)**: önce test reklam hesabında `META_ADS_RULES=true` ile bir lansman; Ads Manager → Automated rules'da "Agentelse safety · …" kuralını gör, Graph Explorer'da `/{rule_id}/preview` ile hangi nesnelere uygulandığını kontrol et ve token iptalinden sonra kuralın çalışıp çalışmadığını not et (plan §3.9). Sonra canlıda aç.
19. **F8 Facebook Login for Business**: Meta App Dashboard → Facebook Login for Business → Configurations → "System-user access token" türünde bir yapılandırma oluştur (izinler: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`; varlıklar: reklam hesapları ve Sayfalar). Kimliği Railway'e `META_FLFB_CONFIG_ID=...`. "Valid OAuth Redirect URIs"e `https://<uygulama>/api/integrations/meta-business/callback` ekle. Business tipi uygulama + Advanced Access (App Review) gerekir.
20. **F8 anahtar**: Railway'e `META_TOKEN_KEYS=k1:<openssl rand -hex 32 çıktısı>` (yeni terminal sekmesinde `openssl rand -hex 32`). Döndürmek için yeni anahtarı başa ekle: `k2:<yeni>,k1:<eski>`; eski anahtarı ancak /ads'teki bağlantılar bir gün sonra yeniden yazıldıktan sonra çıkar.
21. **F8'i aç**: `META_ADS_AGENCY=true`. `/ads` sayfasında "Connect a business" → müşteri business'ını seç → "Not in a project yet" listesinden hesabı projeye ata. Projenin Ads sayfası "All ad accounts" bağlantısı gösterir; Settings → Autonomy'de "Spend approvers" kartı çıkar.
22. **Carousel ve mesai saatleri**: ek bayrak yok (`META_ADS_LAUNCH_V2` + `META_ADS_PLANNER` açıkken Brief'te görünür). Test hesabında bir lansman: 3 postla "One carousel" ve toplam bütçeyle "Business hours"; Review'daki Meta ön kontrolü sorunu gösterir.
23. **Video reklam**: Railway'e `META_ADS_VIDEO=true`; Library'ye kısa bir mp4 yükle (Files paneli); Brief'te "Video (optional)" çıkar. Meta işlerken Review birkaç dakika "processing" der; kapak için bulut depolamanın (R2) açık olması gerekir.
24. **Kapalı amaçlar**: Railway'e `META_ADS_READY_RECIPES=traffic_instagram_profile` (profil ziyareti), Meta'dan `pages_manage_ads` gelince `leads_instant_form`, piksel olayları doğrulanınca `sales_purchase` (virgülle birlikte yazılabilir). Önce test hesabında dene.


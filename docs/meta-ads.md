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
- **Henüz yok**: carousel ve video modülde (eski sihirbazda duruyor), iki oranlı `asset_feed_spec` (test hesabında doğrulanana kadar tek görsel + `adapt_to_placement`), Instagram profil hedefi, içerik planındaki `ads.campaign` parçasına "Make this ad" köprüsü, mesai saatleriyle zamanlama.

## F6 — Raporlama ve öğrenme

Bayrak: `META_ADS_REPORTS=true` (ayna açık olmalı).

- **Haftalık rapor** (`src/server/ads/reports/weekly.ts`): Pazartesi 08:00 (proje saati), geçen Pazartesi–Pazar (hesap günü), Ads sohbetine SYSTEM mesajı: harcama ve önceki haftaya göre fark, sonuç ve maliyet, KPI hedefiyle karşılaştırma, dönem erişimi ve sıklığı (tek Meta okuması; günlük satırlardan toplanmaz), teşhis ("Cost per result +37%: CPM +30% (auction or season), link CTR flat, conversion −5%"), haftayı taşıyan 3 reklam (yönlendirici), alınan kararlar ve sonuçları, bekleyen öneriler, "Meta suggests…" (ikinci görüş, asla otomatik uygulanmaz), atıf etiketi ve "Recent days may still change". Brand Brain için haftada tek özet Signal (PERFORMANCE).
- **Aylık müşteri raporu**: ayın 1'i 09:00: ay toplamları, erişim, hedefler, işe yarayan karar oranı, yeni öğrenmeler, bugünkü bütçelerle gelecek ayın tutarı, mutabakat sorusu ("How many new customers did you get from ads last month?"), Ad Library bağlantısı (ülke dolu). Markdown / PDF için Analytics modülünün Share adımı (Meta bölümü artık aynadan).
- **Teşhis ağacı** (`src/lib/ads/reports/diagnose.ts`): Δln CPA = Δln CPM − Δln CTR − Δln CVR (testli).
- **Öğrenmeler** (`src/server/ads/reports/learnings.ts`): değerlendirilmiş ve en az 10 sonuçlu kararlardan `BrandLearning` (`sourceType = META_ADS`, WORKS / AVOID); metin n'yi içerir, n < 25 "directional".
- **Brand sekmesi "Ads" kartı** (K22): sağ dok → Brand: son 7 gün harcama, sonuç, maliyet, çalışan kampanya, dikkat isteyen uyarı sayısı ve tazelik; "Open" Ads sayfasına götürür. Ayna kapalıysa görünmez.
- **Bilinçli sapma**: rapor metinleri şablondur (LLM özeti bağlanmadı; her sayı aynadan).

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

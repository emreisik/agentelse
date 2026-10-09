# Görev bütçe kontrolü (Faz 3)

Plan: `~/.claude/plans/billing-usage-plan.md`. Ölçüm: `docs/billing-metering.md`. Defter ve hak kararı: `docs/billing-quota.md`. Bu faz defteri ücretli çağrılara bağlar: her ücretli iş başlamadan **azami maliyet kadar hak ayırır (rezerve)**, bitince **gerçek tüketimi mahsup eder**, kullanılmayanı **iade eder**; hak yoksa iş **hata vermez, bekler** ve hak gelince kendiliğinden devam eder.

Varsayılan `BILLING_MODE=off`: bu fazın hiçbir kodu kapalıyken veritabanına dokunmaz, tahmin hesaplamaz, ücretli çağrıyı kesmez. `shadow` hiçbir şeyi engellemez/park etmez. Engelleme, park ve devam yalnız `enforce`'ta çalışır; `enforce` Faz 4 (Stripe) + Faz 6 (ekranlar) bitmeden AÇILAMAZ (aşağıda "enforce'a geçmeden önce").

## Kavramlar

- **Operasyon** (`src/server/billing/operation.ts`): bir ücretli işin yaşam döngüsü. `beginOperation(spec)` hakkı ayırır (yetmezse `QuotaExceededError`, plan yoksa `NoPlanError`), `op.run(fn)` ücretli çağrıları bu işin kapsamında koşturur, `op.finish(sonuç)` mahsup/iade eder. `finish` asla fırlatmaz, idempotenttir; mahsup ERROR dönerse 3 kez dener.
- **Sayaç** (`usage-meter.ts`): operasyonun gerçek maliyeti. `recordUsage` her ücretli sağlayıcı çağrısını `UsageEntry`'ye yazmadan ÖNCE sayaca ekler (kayıt hatası mahsubu bozmaz). Başka workspace'in sayacına asla eklenmez. Mahsup edildikten sonra gelen çağrı (yarışı kaybedip arkada sürmüş iş) mahsup edilmiş sonuca karışmaz, ayrı sayılır ve loglanır.
- **Sınıflar** (sağlayıcı kendisi beyan eder: `ExecutionProvider.usageEstimate`; yanında durduğu kodla birlikte kayar):
  - **content**: sonucu "görselli içerik" olan iş. Rezerve edilen: çizilen görsel sayısı (`IMAGE`). İçindeki metin/arama/art direction maliyeti hakka DAHİLDİR. Fotoğraflı gönderi ve uyarlama (mevcut görselin başka formatı) 0 hak, ama geçerli plan ister.
  - **ai**: "diğer AI" bütçesinden harcayan iş. Rezerve edilen: azami maliyet tahmini (`AI_MICROS`).
  - **free**: yayın / reklam yazması (Meta, Google, TikTok, LinkedIn, X) ve mock. Beyan yok → rezervasyon yok, plan sorgusu yok, yalnız ölçülür.
- **Anahtar disiplini**: rezervasyon anahtarı `${operationId}#${attemptToken}`. Jeton DENEMEYE özgü ve yeniden teslimde SABİTtir (worker: `${olayId}.${deneme sırası}`), yeni deneme yeni jeton alır. Aynı jeton RESERVED bulunursa devralınır (çökmüş denemenin hakkı çift düşmez); SETTLED/RELEASED bulunursa yeni koşudur (taze anahtar, bedava çalışmaz).

## Sonuç → mahsup kuralı

| Sonuç       | Ne zaman                                                                                     | Görsel (`IMAGE`)                                                     | AI (`AI_MICROS`)                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `delivered` | sonuç teslim edildi (`pollOnce` COMPLETED/VERIFYING döndü; sayfa kaydedildi; yanıt akıtıldı) | çizilen adet, REZERVE EDİLENİ AŞMAZ (tekrar render iki hak yedirmez) | ölçülen gerçek maliyet                                                                                                      |
| `failed`    | iş koştu, başarısız                                                                          | iade                                                                 | faturalı çağrı yapıldıysa en çok rezervasyon kadar mahsup (başarısızlık bedava hesaplama kapısı olmasın); maliyetsizse iade |
| `aborted`   | hiç koşmadı / istisna / sonuç belirsiz                                                       | iade                                                                 | iade (teslim edilmemiş çıktıya ücret yazılmaz; teslim eden yeniden deneme öder)                                             |
| `pending`   | sonuç henüz belli değil (RUNNING)                                                            | rezervasyon açık                                                     | rezervasyon açık                                                                                                            |

Görselsiz tamamlanan içerik işi (ör. görsel moderasyona takıldı, metin tamam): hak yenmez, ama ödenmiş metin çalışması AI bütçesine yazılır (en çok $0,10; bütçe yoksa yazılmaz, en iyi çaba).

`finish` kararı **iş durumundan** (`pollOnce`'un döndürdüğü), yürütme sırasında bir istisnadan değil verilir: `execute` döndükten sonra bir DB hatası (`referencePersisted`, `pollOnce`, kartı oluşturma) olsa bile sonuç teslim edilmediyse iade edilir; deneme yeniden koşar ve o ödeme yapar.

## Giriş noktaları

| Nerede                                               | Birim                    | Not                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionService.startExecution` (`job-billing.ts`) | sağlayıcının beyanı      | worker, sohbet (inline) ve reklam sürücüsü aynı yoldan. Rezerve claim'den ÖNCE (reddedilen iş hiçbir yan etki üretmez); `try/finally` rezervasyondan hemen sonra başlar. Hak yoksa iş park edilip DÖNDÜRÜLÜR (worker olayı normal şekilde kapatır; yetim iş doğmaz). |
| `ReasoningService.run` (`call-gate.ts`)              | `AI_MICROS`              | rezervasyonlu bir işin içindeyse ona katılır, yoksa kendi azami maliyetini rezerve eder. Günlük proje sayaçlarından (`AutonomyPolicyRepository`) ÖNCE: reddedilen çağrı günlük sayacı yemez. Mock kipte kapıya gelmez.                                               |
| Sohbet turu (`chat-gate.ts`, `chat-agent.ts`)        | `AI_MICROS`              | HER model turu (round) için ayrı: yetmezse ilk turda `limit-notice` kartı, sonraki turda temiz durma ("elde edilenler kayıtlı"). Stop/hata: iade. Ek dosyalar sabit token sayılır (base64 metin sayılmaz).                                                           |
| `performCreativeRevision`                            | `IMAGE`                  | revizyon politikası aşağıda.                                                                                                                                                                                                                                         |
| Logo üretimi (`generateLogoAction`)                  | `IMAGE` 1                | hak yoksa hiçbir şey çizilmez, kart eskisi gibi sessiz kalır (açıklama Faz 6 Usage ekranında).                                                                                                                                                                       |
| Haftalık planlayıcı (`instagram-week-planner.ts`)    | gönderi başına `IMAGE` 1 | hak bitince parti günlük sınır gibi biter (`cappedForToday`); günlük görev sayacı reddedilen gönderiyi saymaz.                                                                                                                                                       |
| SEO gömmeleri (`embeddings.ts`)                      | `AI_MICROS` (küçük)      | hak yoksa `budgetHit` döner (çağıran zaten işler).                                                                                                                                                                                                                   |

## Revizyon politikası (`plans.ts: REVISION_POLICY`)

Bir gönderinin görselini düzenlemek ya da yeniden üretmek bir görsel modeli çağırır. Kural: gönderinin **ilk görseli** ana görseldir ve 1 hak yer; sonraki **ilk 2 revizyon (düzenle ya da yeniden üret) ücretsiz**, 3. revizyondan itibaren her biri 1 hak; markanın **kendi fotoğrafından kesilmiş** görsel hiç ücretlenmez. Sayaç Creative'in sürüm numarasıdır (bir Creative = bir format). Kalite varsayılanı DEĞİŞMEZ.

## Görev başına azami maliyet (`plans.ts: TASK_CEILING`)

Rezervasyondan bağımsız emniyet kemeri: bir işin gerçek maliyeti tavanı aşarsa SONRAKİ ücretli çağrı başlamaz (`assertTaskRoom`, her ücretli istemcinin çağrıdan önceki ilk satırı; aşan çağrı yapılmıştır, ücreti sayaçta). Tavan: görsel hakkı başına $0,75; hak yemeyen içerik işi $0,50; AI işinde rezervasyonun 3 katı. Yalnız faturalama açıkken konur. Aşım `BUDGET_EXCEEDED` (`meta.limit = "taskCeiling"`).

## Park (`WAITING_BUDGET`) ve devam (`park.ts`)

- Hak yoksa iş HATA OLMAZ: `QUEUED → WAITING_BUDGET` (CAS), `errorCode = QUOTA_EXCEEDED | NO_PLAN`, görev QUEUED kalır (BLOCKED'a çekilmez: bağımlı görevler iptal edilmesin), iş açık kalan eski tutuşlarını bırakır, görev `updatedAt`'i dürtülür (ilerleme yoklaması uyanır), `billing.job.parked` denetim kaydı yazılır. Üretilmiş içerik ve tamamlanan aşamalar yerinde kalır.
- **Devam** (`resumeParkedWork`, bakım adımında ≥5 dk'da bir; ek paket/ödeme işleyicisi workspace vererek doğrudan çağırır): yalnız durumu değişmiş workspace'ler incelenir (park sonrası bakiyesi/aboneliği güncellenen, bekleme sınırını aşan iş taşıyan, görevi bitmiş iş taşıyan). Her iş sırayla GERÇEK rezervasyonla denenir; yetenler aynı transaction'da `QUEUED` + yeni dispatch olayı olur ve olayın payload'ı rezervasyon jetonunu taşır (`startExecution` aynı anahtarı devralır). Böylece "sığar" tahmini ile gerçek hakem ayrışmaz (her tick yeniden park yok), paralel işler aynı bakiyeyi iki kez tüketemez.
- **Sıra**: Task.priority (URGENT→LOW), sonra kullanıcının kendi isteği (arka plan işinden önce), sonra son tarih (Task.dueAt, yoksa takvim slotunun planlı zamanı: `Task.payload.planCreativeId → Creative.scheduledFor`), sonra oluşturulma. Not: `Task.priority` ve `Task.dueAt` bugün hiçbir yerde yazılmıyor (hepsi MEDIUM/boş); yazılırsa kendiliğinden öne geçerler.
- **Sıkı öncelik**: bir iş sığmazsa onun birimi bu süpürmede kapanır; küçük, düşük öncelikli iş büyük, yüksek öncelikliyi aç bırakmaz. İki birim birbirinden bağımsız. Plan yoksa workspace'in kalanı denenmez.
- **Devam hiçbir onay üretmez ve atlamaz**: iş zaten onaydan geçip dispatch edilmişti; payload'ı, riskLevel'i ve onayları işte durur ("önceki yetkiler geçerli"). Görevi iptal/bitmiş iş diriltilmez (CAS görevin durumunu da koşul yapar; `startExecution` ayrıca başlamadan önce kapatır ve devam adımının ayırdığı hakkı adıyla iade eder). Duraklatılmış/kapatılmış projenin işi bekler.
- **Bekleme sınırı 45 gün** (`MAX_PARK_AGE_MS`, kota penceresi ≤31 gün + pay): aşan iş ve görevi iptal edilir (`billing.job.park_expired`).
- **Kill-switch**: `enforce`'tan çıkılınca (shadow/off) parklı işler hakka bakmadan kuyruğa döner (shadow her tick; off saatte bir tek ucuz sorgu, `billing.drain`). Geri alma runbook'u: Prisma istemcisi bilinmeyen `WAITING_BUDGET` değerini okuyamaz; ESKİ koda dönmeden önce modu kapatıp parklı işleri boşalt (`SELECT count(*) FROM "ExecutionJob" WHERE status='WAITING_BUDGET'` = 0 olmalı).
- **Çökme uzlaştırması** (`reconcile.ts`): süreç `finish`'ten önce ölürse (deploy) teslim edilmiş işin rezervasyonu süpürücüyle iade edilmesin diye süresi dolan `exec:*` rezervasyonları ÖNCE kontrol edilir: iş COMPLETED/VERIFYING ise mahsup edilir (görsel: rezerve edilen; AI: o işe ait ölçülen maliyet, en çok rezervasyon kadar), değilse süpürücü iade eder. Yürütme işi rezervasyonu TTL'i 90 dk (`JOB_RESERVATION_TTL_MS`).

## Hatalar ve görünüm

- `QUOTA_EXCEEDED` / `NO_PLAN`: BEKLEME'dir (worker yeniden denemez, dead-letter yapmaz). Mesajları error-classifier'ın BILLING/AUTH/NETWORK desenlerine ASLA uymaz (aksi halde bir kiracının kotası OpenAI sağlayıcısını TÜM kiracılar için devre kesiciyle kapatırdı); `provider-health` ayrıca kodla da dışlar. Test: `quota-errors.test.ts`.
- `BILLING_UNAVAILABLE` (enforce'ta defter okunamadı): deneme YAKMADAN 60 sn sonra yeniden denenir; yoksa 1 dakikalık aksaklık kuyruğu dead-letter'a çekerdi. Sohbet (inline) yolunda olay worker'a geri verilir.
- Motor çağrıları (`ReasoningService.run`) hakkı bitince `BUDGET_EXCEEDED` (`meta.limit = "planAllowance" | "noPlan"`) fırlatır: 17 tüketicisi (sinyal/fikir/medya analizi/SEO/tick adımı) bütçe duruşunu zaten zarifçe işler (ertele, atla, "limit"). Reddedilen çağrı `ReasoningCall{status:"BLOCKED"}` bırakır (proje+amaç başına 10 dk'da en çok bir): tarayıcı adımlar (içgörü sentezi, fikir doldurma) son ReasoningCall'a bakarak kısılır; satır yoksa aynı kiracıyı her tick seçip sırayı işgal ederlerdi. Sağlık ekranı yalnız `ERROR` okur.
- Sinyal işleme kiracılar arası adildir (`fairShare`): bir kiracının bütçesi yeni sinyalleri işlemekten alıkoymaz, bütçesi biten kiracı o koşuda atlanır.
- Sohbet/arayüz: `limit-notice` kartı yeni nedenler `allowance-used` (birim + yenilenme tarihi) ve `no-plan`. Metinde token/dolar yok. Park edilen iş sohbette "hazır" ya da "hâlâ üretiliyor" denmez (`parked-job.ts: isParked`, `PAUSED_NOTE`).

## Bilinen sınırlar ve sahip kararları

1. **Uyarlama maliyeti emilir**: uyarlama hak yemez (sahip kararı) ama gerçek bir görsel düzenleme çağrısı + metin adımı yapar (≈$0,08–0,12). Maliyet `UsageEntry`'de görünür, tahsil edilmez; gönderi başına en çok Instagram post + Story (2 format) görsel üretir. `db:report:cost` ile izlenir; marj varsayımı ($0,15/hak) bunu içerir ya da içermez, gerçek veriyle doğrulanmalıdır.
2. **Revizyon kalitesi**: revizyonlar bugün varsayılan kaliteyle (yüksek) çizilir; ücretsiz 2 revizyon + yüksek kalite, %100 kullanımda Business/Agency marjını %70'in altına çekebilir (kötü senaryo hesabı). Plan "Edit/Studio varsayılan medium" diyordu; kalite düşürmenin kontrollü bir karar olması şartnameden dolayı sahibe bırakıldı (ücretsiz revizyonlar `medium`, açıkça seçilen yüksek kalite 1 hak gibi).
3. **Zamanlanmış yayın**: yayın "free" sınıf. Plan/abonelik bitse de zamanlanmış postlar ve canlı Meta kampanyaları sürer (Faz 2'den açık sahip kararı).
4. **Kuyruk kilidi (lease)**: `claimBatch` 10 olaya claim anında 15 dk lease verir; sağlayıcı çok yavaşsa ikinci dalga olayları başlamadan lease biter ve yeniden teslim olur. Aynı jeton tek hold'u devralır ve ilk `finish` kazanır (çift ücret yok), ama sağlayıcıya iki kez ödenir. Heartbeat yok (bu faz öncesi var olan durum).
5. **Sohbette Stop**: tur Stop ile kesilince model kullanım raporu gelmez, tur iade edilir (sağlayıcı o ana kadar akıtılan token'ı faturalayabilir; emilir).
6. **Parklı SYSTEM görevleri** `countActiveSystemTasks`'ı (eşzamanlılık kotası) 45 güne kadar tutabilir: hak yokken yeni otonom görev üretilmemesi istenen geri basınçtır.
7. **Master görsel değişince** format uyarlamalarını yeniden üretme politikası yok; lead görsel parklıysa kanal parçaları "Try again" der (lead bitince uyarlamaları üreten otomatik bir şey yok).
8. `readPictureForAdapting` projeye göre süzmez (yalnız plan-run yazar); 0 haklı yol olduğu için ayrı bir güvenlik işi olarak süzülmeli.
9. Faz 3C (sonraki): yüksek maliyetli otonom işlem için `approveAboveUsd` onay eşiği, kullanıcının plan sınırları içinde ayarı, `autonomy: "limited"` paketlerde arka plan döngülerinin sınırlanması ve arka plan/etkileşimli ayrımı.

## enforce'a geçmeden önce

1. Faz 4 (Stripe + webhook), Faz 5 (kayıtta deneme), Faz 6 (plan seçimi + Usage/Tasks ekranları + park mesajlaşması) tamam.
2. Migration'lar uygulandı: `20261009110000_add_billing_core`, `20261009120000_add_waiting_budget_status`.
3. **Canary**: shadow `QuotaExceededError` fırlatmaz (BYPASS/OVERDRAFT_SHADOW), yani park/devam/hak kartı ilk kez canlı enforce'ta çalışır; 2–4 hafta shadow bunu kanıtlamaz. Önce küçük gerçek planlı iç bir workspace'te enforce, sonra kohort.
4. Ek paket / ödeme webhook'u `resumeParkedWork({ workspaceId })` çağırmalı (≥5 dk beklemeden devam).
5. `db:report:cost` birim maliyetleri `economics.ts` varsayımlarıyla uyumlu; fiyat kilitlendi.
6. Motor tüketicileri: bu fazda sinyal işleme adil hale getirildi; diğer çok kiracılı tick adımları (GA/SEO/Ads) hak bitince `BLOCKED` satırıyla kısılır ama enforce öncesi gerçek veriyle bir tur gözden geçirilmeli.

## Testler

`operation.integration.test.ts` (yaşam döngüsü, yarışlar, devralma, sonuç kuralları), `park.integration.test.ts` (park, sıra, devam, süzgeç, bekleme sınırı, kill-switch), `execution-billing.integration.test.ts` (gerçek `startExecution` + gerçek defter: park→devam→başlat), `call-gate.integration.test.ts`, `period-tick.integration.test.ts` (uzlaştırma, devam, boşaltma), `reasoning-service.allowance.test.ts`, `chat-agent.test.ts` ("plan allowance"), `creative-actions.allowance.test.ts`, `instagram-week-planner.test.ts`, `embeddings.allowance.test.ts`, `provider-usage-declarations.test.ts` (ücretli sağlayıcı beyan etmek ZORUNDA; resume ile sağlayıcı aynı tutarı hesaplar), `quota-errors.test.ts`.

# Abonelik hakları ve kota defteri (Faz 2)

Plan: `~/.claude/plans/billing-usage-plan.md`. Ölçüm (Faz 1): `docs/billing-metering.md`. Bu faz kota ilkellerini kurar; ücretli çağrılara bağlanışı Faz 3'tedir (`docs/billing-tasks.md`). Varsayılan `BILLING_MODE=off`: hiçbir kullanıcı davranışı değişmez ve canlı yola tek sorgu eklenmez.

## Modlar

| `BILLING_MODE`     | Davranış                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (varsayılan) | Hak kararı, rezervasyon, marka limiti ve kullanıcı yolları veritabanına HİÇ dokunmaz. Tek istisna bakım adımındaki kill-switch: saatte bir tek ucuz sorgu (`billing.drain`, aşağıda). Yazım hatası da `off` okunur. |
| `shadow`           | Karar hesaplanır, **hiçbir şey engellenmez**; "enforce olsaydı engellenirdi" kararları `AuditLog`'a (`billing.shadow.*`, workspace düzeyinde, saatte en çok bir satır) yazılır. |
| `enforce`          | Engeller. Okuma hatasında fail-closed (`ERROR`/`DEGRADED`), `off`/`shadow`'da fail-open.                                                                                        |

Diğer ayarlar (hepsi opsiyonel): `BILLING_LEGACY_BEFORE` (ISO tarih: bundan önce açılmış ve aboneliği olmayan workspace'ler mevcut müşteri = LEGACY sayılır, sınırsız), `BILLING_LEGACY_UNTIL` (LEGACY tam erişimin bittiği an = 7 günlük ücretsiz geçişin sonu; boşsa süresiz).

**Kohort veriyle yönetilir** (izin listesi yok): LEGACY sınırsızdır; kohort, LEGACY'den TRIALING/ACTIVE'e geçen workspace'lerdir.

**Kapılar `off` iken nasıl davranır:** `reserveUsage`, `getEntitlements`, `ensurePeriod` ve marka limiti kontrolü veritabanına HİÇ dokunmaz; `runBillingTick` defter işlerine dokunmaz, yalnız SAATTE BİR (süreç başına ilk çağrıda ve sonra saat başı) `billing.drain` kilidini alır (`SystemHeartbeat` yazımı) ve park edilmiş iş var mı diye `ExecutionJob`'u okur (docs/billing-tasks.md, kill-switch) (tutar doğrulaması bile yapılmaz: hatalı bir tahmin kapalıyken ücretli çağrıyı düşüremez). `settleUsage`/`releaseUsage` `NOT_FOUND`, `getUsageView` `[]` döner. `grantUsage` (ödeme olayı: para alındıysa hak verilir) modtan BAĞIMSIZDIR.

**Ücretli çağrının önünde hiçbir şey fırlatmaz:** `reserveUsage` geçersiz tutarda ya da altyapı hatasında `enforce`'ta `{ok:false, reason:"ERROR"}`, `shadow`'da `BYPASS(ERROR_OPEN)` döner; `settleUsage`/`releaseUsage` hatada `{status:"ERROR"}` döner (loglanır; süpürücü rezervasyonu zamanla iade eder). Yalnız `grantUsage` çelişen anahtarda `GrantKeyConflictError` fırlatır (webhook işleyicisi bilmeli).

**Ayar doğrulaması:** `BILLING_LEGACY_BEFORE/UNTIL` yalnız ISO 8601 (`YYYY-MM-DD` ya da tam zaman damgası) kabul edilir. Geçersiz bir değer `enforce`'u `shadow`'a DÜŞÜRÜR ve yüksek sesle loglar: bir yazım hatası (ör. `15.11.2026`) mevcut müşterileri engelleyemez. Tutarsız bir abonelik satırı (ACTIVE ama plan/çapa/ödenmiş süre eksik, bilinmeyen durum) `INCOMPLETE_SUBSCRIPTION` ile salt-okunur olur ve loglanır; ödeyen biri sessizce hak almadan kalmaz.

## Kaynak dosyalar

- `src/lib/billing/plans.ts` — paketler, fiyatlar, kotalar, ek paketler, deneme, sabitler (TEK doğruluk kaynağı, sürümlü kod; veritabanında plan tablosu yok).
- `src/lib/billing/economics.ts` — varsayım maliyetler ve marj hesabı; `plans.test.ts` "pazarlık koruması": satılan teklifte (normal, ilk ay, yıllık) brüt marj ≥ %70 değilse test kırılır.
- `src/lib/billing/windows.ts` — aylık kota pencereleri (UTC, ay sonu kelepçeli, doğrudan çapadan).
- `src/lib/billing/entitlements-core.ts` — saf hak kararı (`resolveEntitlements`) ve pencere planı (`planWindow`).
- `src/server/billing/` — `entitlements.ts` (DB sarmalayıcı, asla fırlatmaz), `ledger.ts` + `ledger-sql.ts` (defter), `subscription.ts` (`startTrial`), `brand-limit.ts`, `period-tick.ts`, `shadow-log.ts`.

## Hak kararı

`access`: **FULL** (yeni ücretli AI, marka, otonom döngü serbest) | **READ_ONLY** (görüntüleme, dışa aktarma, silme, bağlantı kesme açık; yeni ücretli AI/marka yok). Satırsız/eşik sonrası workspace → `NO_SUBSCRIPTION`. Karar ÖDEME olaylarının yazdığı alanlardan verilir (`paidThrough`, `trialEndsAt`, `graceUntil`, `legacyUntil`), sağlayıcı dönem alanlarından değil.

- ACTIVE: ödenmiş süre + 6 saat yenileme payı (iptal edilmişse pay yok). **Pay yalnız ERİŞİM toleransıdır**: ödeme gelene kadar yeni aylık pencere AÇILMAZ (`windowHorizon`), bedava ay yok.
- TRIALING: 7 gün, tek pencere, 5 görsel + 1 USD AI, 1 marka, sınırlı otonomi. `trialEndsAt` bir kez yazılır (ikinci deneme yok).
- PAST_DUE: `graceUntil`'e kadar mevcut kalan harcanır, yeni pencere yok. CANCELED: `paidThrough`'a kadar (yıllıkta kalan aylar dahil).
- Marka limiti: plana göre (1 / 1 / 3 / 10); READ_ONLY'de 0.

## Defter

İki havuz: **PERIOD** (plan kotası, aylık sıfırlanır, `periodEnd`'de söner; süreli promosyonlar da buraya) ve **EXTRA** (YALNIZ satın alınan ek paket; süresiz, iptalde silinmez, tam erişimde harcanır). Tüketim sırası PERIOD → EXTRA. Kota **her zaman aylık** verilir (yıllık fatura aralığında da); pencereler `quotaAnchor`'dan sayılır.

- **reserve** `reservationKey` ile (iş değil DENEME bazlı: `${operationId}#${deneme}`). Tek SQL ifadesi: kilit (`FOR UPDATE`) + bölüştürme + idempotent INSERT + sayaç artışı. Yinelenen teslim bakiye tam sınırdayken bile `REUSED` döner (yetersiz sayılmaz). Yetersizlik `INSUFFICIENT{available, resetsAt}`.
- **settle** gerçekleşen tutarı alır (rezervasyondan önce kendi havuz payları, fazlası dönem ve extra BOŞLUĞUNDAN, kalan borç dönem havuzuna yazılır; pencere sıfırlamasında affedilir). Süpürücü iade etmiş olsa da (`RELEASED`) geç settle used'a yazılır. Bilinmeyen anahtar fırlatmaz (`NOT_FOUND`).
- **release** kullanılmayanı iade eder. Süresi dolan (çökmüş iş) rezervasyonları `billing-maintenance` tick adımı iade eder.
- **grant** idempotent (`workspaceId, idempotencyKey, unit, reason`); bakiye satırı yoksa oluşturur (ödenen hak kaybolmaz); aynı anahtar farklı tutarla `GrantKeyConflictError`. PERIOD hibesi yalnız çağıranın bildiği açık pencereye yazılır.
- **ensurePeriod** abonelik penceresini bakiyeye yansıtır: yön kontrollü (bayat `now` pencereyi geri saramaz), PLAN/TRIAL hibesi deftere yazılır, uçuştaki rezervasyonlar yeni pencerede de tutulu kalır. Abonelik workspace kilidi içinde okunur.

**Değişmezler** (her test sonrası kontrol edilir): `reserved = Σ RESERVED from*`; sayaçlar ≥ 0 (DB `CHECK`); `used` yalnız settle ile artar. Sayaçlar türev veridir; sapmayı süpürücü onarır.

**Kilit sırası** her yerde bakiye satırı → rezervasyon satırı (ölü kilit yok). `ensurePeriod`, deneme ve Faz 4 webhook işleyicisi ayrıca workspace advisory kilidini (`usage:<workspaceId>`) alır.

## Marka limiti

`createProjectWithinBrandLimit` (`brand-limit.ts`): `off` → eski yol, faturalama sorgusu yok. `shadow` → yine oluşturur, "engellenirdi"yi loglar. `enforce` → `ProjectRepository.createWithinLimit`: sayma + oluşturma tek işlemde advisory kilit altında (eşzamanlı N istek limiti aşamaz); limit 0 "sınırsız" değil "yasak"; sayım durumdan bağımsız. İki eylem de (`createProjectAction`, `createGuidedProjectAction`) tipli `CreateProjectFailure{code: BRAND_LIMIT | PLAN_REQUIRED}` döner.

## enforce'a geçmeden önce (önkoşullar)

1. Faz 3 (rezervasyon bağlantısı), Faz 4 (Stripe + webhook), Faz 5 (kayıtta deneme: `startTrial`), Faz 6 (plan seçimi ekranı) tamam. **Faz 4 + 6 bitmeden yeni kayıtlar için `enforce` açılamaz** (satırsız yeni kullanıcı READ_ONLY olur ve ilk markayı açamaz).
2. Migration'lar uygulandı (`20261009110000_add_billing_core`).
3. Mevcut müşteriler için `BILLING_LEGACY_BEFORE` ayarlı; 7 günlük geçiş `BILLING_LEGACY_UNTIL` ile başlatılır (Faz 4 checkout + Faz 6 ekranı yayında olmadan başlatılmaz).
4. `db:report:cost` birim maliyetleri `economics.ts` varsayımlarıyla uyumlu; fiyat kilitlendi.

## Yerelde DB testleri

`describeIntegration` testleri `TEST_DATABASE_URL` yoksa SESSİZCE atlanır: billing'in en riskli testleri push'tan önce koşmuş olmayabilir. Tek kullanımlık UTC Postgres (hafıza: `reference_sandbox_test_and_npm`) kurup `AGENTELSE_REQUIRE_TEST_DATABASE=1` ve `&connection_limit=40&pool_timeout=60` ile `src/server/billing`, `src/server/projects` altını koşturun. Eşzamanlılık testi "tutucu" kalıbını kullanır (dış işlem bakiye satırını tutar, N istek başlar, hepsinin beklediği doğrulanır, kilit bırakılır); **olumsuz kontrol** aynı kapı altında `FOR UPDATE`'siz ifadenin kapasiteyi AŞTIĞINI kanıtlar (kapı güçsüzse test kırılır).

Testler **saat diliminden bağımsız** olmalıdır: tüm tarih parametreleri SQL'de `$n::timestamptz AT TIME ZONE 'UTC'` ile çevrilir (UTC dışı oturumda `::timestamp` değerleri kaydırıyordu). Yerelde `ALTER DATABASE ... SET timezone TO 'Europe/Istanbul'` yapıp testleri bir kez de öyle koşturun. Olumsuz kontrol kendi geniş havuzlu `PrismaClient`'ını kullanır (CI'ın 2 vCPU'lu runner'ında varsayılan havuz 3 bağlantıdır); pozitif kapı testleri varsayılan havuzla da kesin toplam verir (havuz 2-3 ile denendi). Beklenen kotalar `plans.ts`'ten türetilir, rakamlar gömülü değildir.

## Sonraki fazlara devir

- **Faz 3** (yapıldı, `docs/billing-tasks.md`): rezervasyon yürütme işlerine, motor çağrılarına, sohbet turlarına, revizyon/logo/haftalık planlayıcı/gömmelere bağlandı; hak yoksa iş `WAITING_BUDGET`'e park edilir ve hak gelince öncelik+son tarih sırasıyla gerçek rezervasyonla devam eder. Motor çağrıları hakkı bitince `BUDGET_EXCEEDED` (`meta.limit = planAllowance`) görür, yürütme işleri `QUOTA_EXCEEDED`/`NO_PLAN` (bekleme, `PERMANENT_ERROR_CODES`'a konmadı). 3C de yapıldı (arka plan payı = `autonomy: limited`, onay eşiği, plana bağlı kullanıcı sınırları; `docs/billing-tasks.md`).
- **Faz 4** (yapıldı, `docs/billing-payments.md`): `paidThrough` yalnız ödenmiş fatura ile ilerler (asla geri); `PAST_DUE` için `graceUntil` (yeniden denemede uzamaz); tüm durum yazımı tek workspace kilidi altında tek işlemde (satır + hibe birlikte); yükseltme = ORANTILI delta `PERIOD` hibesi (`upgradeDelta`, anahtar `plan-change:<fatura>:<eski>><yeni>`); düşürme `pendingPlanKey` ile ödenmiş dönemin sonunda; iade/chargeback `revokeUsage` (işaretli ters kayıt, taban `used+reserved`). Canlıda kapalıdır: Stripe anahtarları girilene kadar satın alma yok, `BILLING_MODE` değişmedi.
- **Faz 5**: BONUS havuzu gerekirse (60 günlük) additive migration; ilk abonelik %25 bonus ve referans ödülleri şimdilik PERIOD'a (pencereyle söner).
- **Açık sahip kararları**: erişim bitince zamanlı postlar / canlı Meta kampanyaları; marka limiti aşımında kalacak markalar; deneme kartlı mı kartsız mı; iade politikası.

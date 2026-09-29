# Yayın sırası: agent motoru, Quick Discovery ve legacy döngü

Bu belge, sadeleştirme çalışmasının canlıya nasıl alınacağını anlatır. Kodun **varsayılanları eski davranıştadır**; her geçiş bir env değişkeniyle, deploy gerektirmeden açılır ve geri alınır. Sıra önemlidir.

> Bu adımlardan hiçbiri kodun kendisi tarafından uygulanmaz. Railway env'ini ve deploy'u sen yönetirsin.

## 0. Deploy öncesi

- Branch'te iki **eklemeli** migration var (`20260930000000_add_creative_plan_fields`, `20260930100000_add_brand_layout_templates`: nullable kolonlar, indeks). `railway.json` başlangıç komutu `prisma migrate deploy` çalıştırdığı için deploy edildiğinde otomatik uygulanırlar. Yıkıcı bir migration yoktur; bu çalışma **yeni migration eklemedi**.
- CI (`.github/workflows/ci.yml`) tek gerçek doğrulamadır: disposable Postgres, DB entegrasyon testleri ve `next build` orada koşar (bu makinede `next build` Turbopack hatası veriyor, yerelde doğrulanamadı).
- Kod ile birlikte **hiçbir env değişmez**: `CHAT_ENGINE` varsayılanı hâlâ `legacy`, `LEGACY_AGENCY_LOOP` varsayılanı `on`.

## 1. Agent motorunu aç

`CHAT_ENGINE=agent` (Railway env). Geri alma: `legacy`.

Doğrula (önce atılabilir bir proje ile):

1. Yeni proje oluştur. Proje anında `ACTIVE` olur (kurulum beklemez).
2. İlk mesajı yaz. Cevaptan önce **"Getting to know your brand…"** göstergesi çıkmalı (site + web arama, en çok 75 sn). Sonra Brand Brain'de v1 constitution görünmeli; `approvedClaims` boş olmalı.
3. Bir metin işi iste (caption, e-posta): sonuç worker'ı beklemeden aynı turda gelmeli.
4. Bir görsel iste ve format sorusunu kartla cevapla: cevap **agent'a** gitmeli (eskiden legacy motora düşüyordu).
5. "Create a content plan" kısayolunu dene: plan sihirbazı açılmalı, görsel üretimi başlamamalı.

Maliyet notu: Quick Discovery proje başına bir kez, ~1 model çağrısı + birkaç web araması (arama başına ~0,01 USD, `ReasoningCall` maliyetine eklenir). Tarama sonuçsuz kalırsa 10 dakika boyunca yeniden denenmez.

## 2. Legacy ajans döngüsünü kapat (`LEGACY_AGENCY_LOOP`)

Üç değer, `process.env`'den her çağrıda okunur (yeniden başlatmak yeter):

| Değer | Ne olur |
| --- | --- |
| `on` (varsayılan) | Her şey eskisi gibi çalışır. |
| `drain` | **Jeneratörler** yeni iş üretmeyi bırakır; **drainer**'lar açık kalanları bitirmeye devam eder. |
| `off` | İkisi de kapalı. Yalnızca açık satır kalmadığında. |

Birimler (adla süzülür, `src/server/agency/legacy-loop.ts`):

| Grup | Birimler | `drain` | `off` |
| --- | --- | --- | --- |
| Jeneratör | `signal-scans`, `council-evaluation`, `director-decisions`, `measurement-planning` (işleyici) | kapalı | kapalı |
| Drainer | `handoff-progression`, `work-plan-stale-sweep`, `measurement-checks`, `learning`, `strategy-synthesis`, `work-plan-progression`, `work-plan-terminal`, `handoff-close-out`, `measurement-check-result`, `measurement-check-terminal` | **açık** | kapalı |
| Her zaman açık | `agency-loop-heartbeat`, `meta-ads-performance-scan`, `google-analytics-scan`, `signal-processing`, `insight-synthesis`, `opportunity-evaluation`, `telegram-approval-polling`, `creative-publish-completion`, `meta-adset-chain`, `meta-campaign-chain` | açık | açık |

Yani hiçbir modda kapanmayanlar gerçek ürün özellikleridir: yayın tamamlama (Creative → PUBLISHED), Meta reklam zinciri, metrik tarayıcıları, Telegram onayları ve signal → insight → opportunity zekâsı.

`drain` iken yeni fikirler Council beklemeden **council-lite** ile doğrudan `SHORTLISTED` olur (LLM'siz); böylece Ideas panelindeki onay ve Autopilot'un haftalık planlayıcısı (yalnızca `SHORTLISTED` fikir alır) çalışmaya devam eder. `start_strategic_project` aracı ajana sunulmaz; geniş işi ajan kendisi somut çıktılara böler.

### Adımlar

1. `LEGACY_AGENCY_LOOP=drain`.
2. Aşağıdaki **sayım sorgularını** çalıştır (salt-okunur). Açık satırlar bitene kadar bekle. Bir süre sonra sıfırlanmazsa aşağıdaki "Takılanlar" bölümüne bak.
3. Hepsi sıfırsa `LEGACY_AGENCY_LOOP=off`.
4. Geri alma her adımda: `LEGACY_AGENCY_LOOP=on`.

### Sayım sorguları (salt-okunur)

Tablo ve kolon adları Prisma modelleriyle aynıdır, tırnaklı yazılır.

```sql
-- Süren iş planları
SELECT status, count(*) FROM "WorkPlan"
WHERE status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','IN_PROGRESS')
GROUP BY status;

-- Sonuçlanmamış devirler
SELECT status, count(*) FROM "WorkHandoff"
WHERE status IN ('PROPOSED','ACCEPTED','TASK_CREATED')
GROUP BY status;

-- Süren ölçüm planları ve bekleyen kontrolleri
SELECT count(*) AS active_measurement_plans FROM "MeasurementPlan" WHERE status = 'ACTIVE';
SELECT status, count(*) FROM "MeasurementCheck"
WHERE status IN ('PENDING','SCHEDULED','RUNNING')
GROUP BY status;

-- Süren bir iş planına bağlı, bitmemiş görevler (planı ilerleten şey bunların tamamlanması)
SELECT count(*) AS open_plan_tasks
FROM "Task" t JOIN "WorkPlan" w ON w.id = t."workPlanId"
WHERE w.status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','IN_PROGRESS')
  AND t.status NOT IN ('COMPLETED','FAILED','CANCELLED');

-- İşlenmemiş trigger'lar (birikiyorsa tick çalışmıyordur)
SELECT status, count(*) FROM "AgencyTrigger"
WHERE status IN ('PENDING','PROCESSING','FAILED')
GROUP BY status;
```

Council'in henüz değerlendirmediği fikirler (bilgi amaçlı):

```sql
SELECT status, count(*) FROM "Idea"
WHERE status IN ('RAW','RESEARCHING','VALIDATED','CONCEPT')
GROUP BY status;
```

`drain`'e geçmeden **önce** oluşmuş `RAW` fikirleri artık kimse `SHORTLISTED` yapmaz (Council kapalı, council-lite yalnızca yeni fikirlere uygulanır). Kalabilirler; istersen bunları toplu terfi ettirmek için ham SQL yerine `IdeaRepository.promoteToShortlist` ile küçük bir betik yazdırmak daha güvenlidir (durum makinesinden geçer).

### Takılanlar

- **Süren iş planı bitmiyor:** planın düğüm görevlerinden biri `FAILED`/takılı olabilir; `drain` iken `work-plan-terminal` işleyicisi planı `FAILED`'a çeker. Görev kalıcı takılıysa iş planını panelden (Work) iptal et.
- **`AgencyTrigger` `FAILED` birikiyor:** artık her işleyicinin hatası `AuditLog`'a `agency.trigger.handler_failed.<ad>` olarak yazılır; hangisinin patladığı oradan görülür. Bir işleyicinin hatası diğerlerini engellemez (öncesinde engelliyordu).
- **`off`'a geçtikten sonra eski bir plan takılırsa:** `drain`'e geri dön; drainer'lar kaldığı yerden devam eder.

## 3. Etkiyi ölç

Kapatmadan önce ve bir gün sonra karşılaştır (kapanan jeneratörler LLM çağrısı azaltır):

```sql
SELECT purpose, count(*) AS calls, round(sum("costUsd")::numeric, 4) AS usd
FROM "ReasoningCall"
WHERE "createdAt" > now() - interval '24 hours'
GROUP BY purpose
ORDER BY calls DESC;
```

`drain`/`off`'tan sonra `council.evaluate` çağrılarının kaybolması, `idea.generate` (yalnızca istek üzerine/zamanlanmış üretim kalır) ve `research.extract-findings` (yalnızca araştırma/tarama görevleri için kalır; kopya, caption, brief, e-posta ve rapor görevleri artık bulgu çıkarımı için model çağırmaz) çağrılarının düşmesi; `brand.quickDiscovery` çağrılarının görünmesi beklenir. `chat.turn` çağrıları chat kullanımıyla orantılıdır. Günlük `maxReasoningCallsPerDay` (200) kotası chat ile arka plan motorları arasında paylaşılır; jeneratörler kapanınca chat için yer açılır.

## 4. `off`'tan sonra ne bayatlar

| Yüzey | Durum |
| --- | --- |
| Signals / Insights / Opportunities panelleri | Meta, GA ve webhook sinyalleri gelir ve işlenir; genel OpenClaw taraması zaten sinyal üretmiyordu. |
| Ideas | `save_idea` ve isteğe bağlı üretim, council-lite ile `SHORTLISTED`. Onay çalışır. |
| Autopilot (Auto content planning) | Çalışır; Meta Track 2 etkilenmez. |
| Work / Handoff / Measurement panelleri | Yeni satır yok; mevcutlar `drain` ile bittikten sonra arşiv niteliğinde. |
| Brand Brain strategy sekmesi | v1'den sonra yenilenmez; `BrandLearning` artık ajanın hafızasından beslenir. |
| Header "active work" göstergesi | Heartbeat açık kalır; fikir/sinyal sayaçları 0 kalabilir. |

Setup aşamaları (`INITIAL_*`) tick adımlarından bağımsızdır; bayrak onlara uygulanmaz. Derin marka araştırması bunları zaten atlar.

## 5. Son adım (senin onayınla)

`CHAT_ENGINE=agent` bir süre sorunsuz çalıştıktan sonra legacy `ChatService` + `chat-turn` prompt'u + `submitChatMessageAction` silinebilir. Kod tarafında bu **henüz yapılmadı**; canlı doğrulama sen onaylayana kadar geri dönüş yolu olarak duruyor.

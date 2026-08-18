# Agentelse

**Your AI Growth Team.** Agentelse, birden fazla marka için araştırma, planlama, onay, yürütme, doğrulama ve öğrenme akışlarını tek yerde yöneten çok kiracılı bir **AI ajans işletim sistemidir**. Kod tabanı mikroservis değil; sınırları belirgin bir **modüler monolit** olarak kurulmuştur.

## Workspace yapısı

Bu kök dizin aynı zamanda bir npm workspace root'udur. Uygulamanın kendisi (bu README'nin anlattığı her şey) kök dizinde kalmaya devam ediyor. `apps/` altında ayrı domain'lere deploy edilecek bağımsız uygulamalar var:

- `apps/marketing` — **agentelse.com**, pazarlama/tanıtım sitesi. Kendi `package.json`'ı, kendi bağımsız Next.js uygulaması; `npm run dev -w apps/marketing` ile çalıştırılır.
- `apps/docs` — **agentelse.io** için ayrılmış, henüz iskeleti kurulmamış yer tutucu.

Bu kök uygulama ise **agentelse.ai** (asıl ürün/dashboard) olarak konumlanıyor.

## Mimari

```text
Next.js UI / Server Actions / API
                 |
          Auth + tenant kontrolü
                 |
       Command ve Agency servisleri
                 |
        TaskPlanner + ApprovalPolicy
                 |
    ExecutionJob + OutboxEvent (transaction)
                 |
          PostgreSQL worker
                 |
       CapabilityRouter + ProviderRegistry
          /              |              \
     OpenClaw         Gemini           Mock fleet
                 |
    Verification -> Measurement -> Learning
```

Temel tasarım kararları:

- **Modüler monolit:** UI, domain servisleri, worker ve veri erişimi aynı uygulamada; modül sınırları `src/server` altında korunur.
- **Capability-first routing:** İşler bir sağlayıcı adına değil `CapabilityKey` değerine göre planlanır. Uygun sağlayıcıyı `CapabilityRouter` seçer.
- **Transactional outbox:** `ExecutionJob` ile `OutboxEvent` aynı Prisma transaction'ında yazılır. Provider çağrısı HTTP isteğinin içinde yapılmaz.
- **Onay ve doğrulama:** Riskli işler yürütmeden önce onaya alınır. Doğrulama gereken bir provider sonucu doğrudan görevi tamamlamaz; önce bağımsız `ExecutionVerification` kaydı oluşur.
- **Tenant izolasyonu:** Her erişim `Workspace -> Project -> Brand` sınırında kontrol edilir. İlgili kimliklerin tablolarda tekrar tutulması bilinçli bir sorgu ve güvenlik tercihidir.
- **Ölçüm döngüsü:** Tamamlanan işler sinyal, ölçüm ve öğrenme akışlarına geri beslenebilir.

### Ana yürütme akışı

1. Web, API, sistem veya zamanlayıcı bir komut/görev üretir.
2. `TaskPlanner` execution politikasını ve gereken onay seviyesini hesaplar.
3. Onay gerekmiyorsa `ExecutionService`, job ve outbox event'ini atomik olarak kaydeder.
4. `ExecutionWorker` eventi claim eder, uygun provider'ı seçer ve sonucu takip eder.
5. OTP, MFA, giriş veya CAPTCHA gerekirse görev `WAITING_HUMAN` durumuna geçer.
6. Harici etkisi olan sonuçlar doğrulanır; ardından görev tamamlanır.
7. Sürekli ajans motoru ölçüm ve öğrenme adımlarını işler.

### Tenant hiyerarşisi

```text
Workspace (ajans)
└── Project (müşteri/proje)
    └── Brand (marka; çoğunlukla bir adet varsayılan marka)
```

Yetki kontrollerinin merkezi giriş noktası `src/server/security/tenant-context.ts` dosyasıdır. Server Action ve route'lar client tarafından gelen tenant kimliklerine tek başına güvenmemelidir.

## Teknoloji yığını

- Next.js 16.3 App Router ve React 19
- TypeScript (`strict`, `noUncheckedIndexedAccess`)
- Prisma 6 ve PostgreSQL
- Auth.js v5 Credentials + JWT session
- Tailwind CSS 4 ve shadcn/ui bileşenleri
- Vitest 2

## Dizin yapısı

```text
src/
  app/                    Sayfalar, route handler'lar ve layout'lar
  components/             Uygulama ve ortak UI bileşenleri
  lib/                    Auth, Prisma, env ve genel yardımcılar
  server/
    actions/              Next.js Server Action adaptörleri
    agency/               Setup, intelligence, opportunity, idea, council,
                          work-plan, measurement ve learning motorları
    commands/             CommandService, intent routing ve task planning
    context/              Brand context policy ve immutable snapshot üretimi
    execution/            Policy, routing, provider registry ve execution
      providers/          OpenClaw, Gemini ve açık test modu mock'ları
    reasoning/            Gemini destekli yapılandırılmış reasoning
    repositories/         Tenant-scoped Prisma veri erişimi
    scheduler/            CRON, interval ve one-off proje zamanlayıcıları
    security/             Tenant doğrulama, hata ve geçici sır şifreleme
    state-machine/        Domain durum geçişleri
    workers/              PostgreSQL outbox worker
prisma/
  schema.prisma           Domain veri modeli
  migrations/             Sürümlenmiş PostgreSQL migration'ları
  seed.ts                 Yerel demo verisi
```

## Yerel kurulum

Önerilen gereksinimler: Node.js 22.22+ ve PostgreSQL 16. OpenClaw kullanılmayacaksa Next.js'in desteklediği Node.js 20.9+ da yeterlidir.

```bash
npm ci
cp .env.example .env
npx prisma generate
npx prisma migrate dev
npm run db:seed
npm run dev
```

Uygulama `http://localhost:3000` adresinde açılır. Demo seed giriş bilgileri:

```text
admin@agentelse.dev / agentelse-dev
```

Neon kullanılıyorsa `DATABASE_URL` pooled, `DIRECT_URL` ise doğrudan bağlantı URL'si olmalıdır. Yerel PostgreSQL'de iki değer aynı olabilir.

## Provider ve reasoning modları

Execution provider'ları ile Agency OS iç reasoning çağrıları ayrı katmanlardır:

- `OPENCLAW_CLI_PATH` ayarlıysa OpenClaw provider gerçek `openclaw` CLI süreci üzerinden çalışır. HTTP tabanlı `OPENCLAW_BASE_URL` entegrasyonu yoktur.
- `GEMINI_API_KEY`, metin/analiz ve yaratıcı metin execution provider'larını etkinleştirir.
- `AGENTELSE_PROVIDER_MODE=mock`, yalnızca geliştirme ve test için mock provider filosunu zorlar.
- Provider modu `mock` değilse registry yalnız gerçek provider'ları değerlendirir. Yapılandırılmış gerçek provider yoksa iş açıkça `PROVIDER_UNAVAILABLE` ile başarısız olur; sessiz mock fallback yapılmaz.
- `AGENTELSE_REASONING_MODE=auto` varsayılanında (tek gerçek arka uç) Gemini kullanılır.
- `AGENTELSE_REASONING_MODE=mock`, test ve seed senaryoları için deterministik reasoning üretir.

OpenClaw iki farklı biçimde kullanılır:

- Browser/research/publish işleri `openclaw agent --agent ... --message ... --json` üzerinden yürütülür.
- Görsel üretme eylemi `openclaw infer image generate` çağrısını kullanır ve sonucu geliştirme ortamında `storage/assets` altında saklar.

OpenClaw'ın insan müdahalesi ihtiyacını bildiren yapılandırılmış bir alanı olmadığı için OTP/MFA/CAPTCHA algısı provider metnindeki işaretlere dayanır. Bu entegrasyonun bilinen bir sınırıdır.

## Agency OS

Sürekli çalışan çekirdek akış:

```text
Signal
  -> Finding / Insight
  -> Opportunity
  -> multi-lens Idea
  -> CouncilEvaluation
  -> AgencyDecision
  -> WorkPlan / Task
  -> Execution / Verification
  -> Measurement / BrandLearning
```

Kurulum motoru 12 aşamayı yönetir: intake, deep discovery, brand constitution, signal profile, baseline audits, goal generation, department/autonomy configuration, ilk opportunity/idea/work plan üretimi ve project activation.

Web arayüzünde şu alanlar bulunur:

- Çalışma alanı dashboard'u
- Proje/ajans paneli ve kurulum
- Marka Beyni, istihbarat, fırsatlar ve fikirler
- İşler ve handoff/work plan görünümü
- Departman ve otonomi ayarları
- Onay merkezi ve insan müdahalesi merkezi
- Creative detay görünümü

## Güvenlik

- Auth.js Credentials oturumları JWT stratejisini kullanır.
- Tenant ilişkileri server tarafında yeniden doğrulanır.
- OTP/MFA değerleri AES-256-GCM ile şifrelenir, kısa TTL ile tutulur ve tek kullanımlıktır.
- Yerel asset route'u kullanıcı ve proje erişimini doğrular; yalnız uygulamanın ürettiği güvenli dosya adlarını kabul eder.
- OpenClaw ve provider yanıtları Zod şemalarıyla doğrulanır.
- Worker cron endpoint'i `Authorization: Bearer $CRON_SECRET` ister; secret tanımlı değilse de erişime izin vermez.

## Testler

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Vitest koleksiyonu iki gruptur:

- Saf birim testleri: state machine, execution/approval policy, intent parser, fingerprint, department registry ve next-best-action puanlama.
- PostgreSQL entegrasyon testleri: tenant izolasyonu, geçici sır yaşam döngüsü, 12 aşamalı setup ve signal-to-work-plan/SEO handoff senaryoları.

Entegrasyon testlerinde geliştirme veritabanı kullanılmamalıdır. `TEST_DATABASE_URL`, adı/hostu/şeması açıkça test ortamı olduğunu gösteren ayrı bir PostgreSQL veritabanına işaret etmelidir. Neon gibi pooled/direct ayrımı olan ortamlarda `TEST_DIRECT_URL` ayrıca verilebilir. Değişken yoksa DB gerektiren suite'ler atlanır; güvenli olmayan veya geliştirme URL'siyle aynı bir test URL'si reddedilir.

Örnek yerel akış:

```bash
createdb agentelse_test

DATABASE_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
DIRECT_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
npx prisma migrate deploy

TEST_DATABASE_URL='postgresql://localhost:5432/agentelse_test?schema=public' \
npm test
```

Test fixture'ları rastgele çalışma kimliğiyle namespace edilir ve kendi verilerini temizler. Bu izolasyon yine de ayrı test veritabanı kullanma zorunluluğunun yerini tutmaz.

## CI

`.github/workflows/ci.yml` her push ve pull request'te şu kalite kapılarını çalıştırır:

1. `npm ci`
2. Prisma Client üretimi
3. Migration'ların boş ve geçici PostgreSQL test veritabanına uygulanması
4. TypeScript kontrolü
5. ESLint
6. Tüm Vitest suite'i
7. Next.js production build

CI hiçbir Neon/development secret'ı kullanmaz. GitHub Actions job'una bağlı geçici PostgreSQL service'i iş bitince tamamen silinir.

## Worker ve deployment

Development sunucusu `src/instrumentation.ts` üzerinden üç saniyelik yerel worker döngüsü başlatır. `DISABLE_LOCAL_WORKER=true` ile kapatılabilir.

Production'da uzun ömürlü interval'e güvenilmemelidir. Harici scheduler şu endpoint'i çağırmalıdır:

```text
POST /api/cron/worker
Authorization: Bearer <CRON_SECRET>
```

Worker tick'i scheduler, outbox dispatch, çalışan job polling, verification, Continuous Agency Engine ve süresi dolan kayıtların temizliğini kapsar.

## Güncel sınırlamalar

- Telegram entegrasyonu kaldırılmıştır: kaynak kodda Telegram service/webhook'u ve `CommandSource.TELEGRAM` bulunmaz.
- Gemini creative provider metni ve görsel istemini üretir; gerçek görsel ayrıca OpenClaw image action ile üretilir.
- Competitor modelleri vardır; düzenli research -> snapshot -> diff pipeline'ı tamamlanmamıştır.
- `Skill` ve `ProjectSkill` modelleri vardır; skill discovery/review/sandbox/approval hattı tamamlanmamıştır.
- Local disk asset servisi vardır. Cloudflare R2 değişkenleri şema için ayrılmıştır ancak R2 storage adapter henüz yoktur.
- `SENTRY_DSN` okunabilir durumdadır ancak doğrudan Sentry başlangıç entegrasyonu yoktur.
- OpenClaw'ın CLI çağrısı worker içinde bloklayıcıdır; uzun browser görevleri için ayrı process/queue modeli henüz uygulanmamıştır.

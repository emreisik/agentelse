# DB deprecation defteri

Bu belge **hiçbir şeyi düşürmez.** Refactor'un DB tarafı "önce işaretle, sonra doğrula, en son kaldır" kuralıyla yürütüldü: tabloların hepsi yerinde, yeni migration yok (Work Session, hafıza ve araştırma önbelleği mevcut tablolarla kuruldu). Bu defter neyin ne durumda olduğunu ve bir gün kaldırılacaksa nasıl kaldırılacağını kaydeder.

> **DROP SQL'i yalnızca bu belgede durur; `prisma/migrations/` altına asla konmaz.** Railway'in başlangıç komutu `prisma migrate deploy` çalıştırır ve o klasördeki her dosya deploy'da paylaşımlı canlı Neon veritabanına kendiliğinden uygulanır. Bir tabloyu gerçekten düşürmek kullanıcının kararıdır (aşağıdaki "Nasıl kaldırılır").

## Nasıl ölçüldü

75 modelin her biri için `src/` (test hariç) içinde `prisma|tx|db|client|p .<model>.<yöntem>` çağrıları sayıldı (okuma: `find*`, `count`, `aggregate`, `groupBy`; yazma: `create*`, `update*`, `upsert`, `delete*`). Tabloda **oku/yaz** sütunu bu sayılardır. Sayıma girmeyen kullanımlar elle tarandı: ilişki alanları (`include`/`select`), tip kullanımı, `scripts/` ve `prisma/`, NextAuth adaptörü (`auth.ts`). Sınırı: iç içe yazma (`create: { ... }` başka bir modelin çağrısında) ve ham SQL sayıma girmez; "kullanılmıyor" dediklerimiz için ayrıca ilişki/tip taraması yapıldı. Tarih: 2026-09-30, `feat/brand-workspace-v2`.

## Sınıflar

| Sınıf | Anlamı | Model sayısı |
| --- | --- | --- |
| `CANLI` | Okunuyor ve yazılıyor; dokunulmaz. | 57 |
| `DÖNGÜ` | Yeni satırı yalnızca eski ajans döngüsü üretir. `LEGACY_AGENCY_LOOP=off` olunca yeni satır gelmez; paneller eski satırları okumaya devam eder. Silinmez, beslenmesi durur. | 7 |
| `ADAPTÖR` | NextAuth `PrismaAdapter` sözleşmesi. Şu an boşta (Credentials + JWT) ama adaptör satırı `auth.ts`'te durduğu sürece **tablolar kalmalı**. | 3 |
| `YAZ-OKUMA` | Yazılıyor, hiçbir kod okumuyor. Önce yazımı bırakma kararı, sonra düşürme. | 4 |
| `KULLANILMIYOR` | Ne yazan ne okuyan var. Düşürme adayı. | 4 |

Toplam 75 model.

## Defter

Oku/yaz: `src/` içindeki (test hariç) doğrudan çağrı sayısı.


### Kimlik ve çok kiracılık

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `User` | `CANLI` | 7/3 | Credentials girişi (`auth.ts`) ve profil. |
| `Account` | `ADAPTÖR` | 0/0 | `auth.ts` `PrismaAdapter` kullanıyor. Yalnızca Credentials + JWT yapılandırıldığı için şu an yazılmıyor; OAuth sağlayıcısı eklenirse dolar. |
| `Session` | `ADAPTÖR` | 0/0 | Oturum stratejisi JWT; adaptör bu tabloya yazmaz. |
| `VerificationToken` | `ADAPTÖR` | 0/0 | E-posta sağlayıcısı yok; adaptör sözleşmesi gereği duruyor. |
| `Workspace` | `CANLI` | 1/2 |  |
| `WorkspaceMember` | `CANLI` | 6/2 |  |

### Proje ve marka çekirdeği

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `Project` | `CANLI` | 35/7 | `status` artık işin tek kapısı (`ensureProjectActive`). |
| `Brand` | `CANLI` | 13/2 |  |
| `BrandDossier` | `CANLI` | 9/9 | `approvedColors` / `approvedFonts` sütunları ölü yedek (görsel kimlik `BrandVisualIdentity`'den okunur); sütun bazında izleme listesinde. |
| `BrandVisualIdentity` | `CANLI` | 3/6 |  |
| `BrandConstitution` | `CANLI` | 11/5 | Sürümlü Brand Core; Quick Discovery v1'i yazar. |
| `BrandFact` | `CANLI` | 3/2 |  |
| `BrandAssumption` | `CANLI` | 3/2 |  |
| `ApprovedClaim` | `CANLI` | 4/2 | Web/site kaynaklı iddia asla `active` yazılmaz. |
| `NegativeBriefRule` | `CANLI` | 5/2 |  |
| `BrandDecision` | `CANLI` | 2/1 |  |
| `BrandEvidence` | `CANLI` | 2/1 |  |
| `BrandStrategyVersion` | `CANLI` | 8/1 | Yeniden sentezi `strategy-synthesis` drainer'ı yapar; `LEGACY_AGENCY_LOOP=off`'ta v1'den sonra yenilenmez. |
| `BrandLearning` | `CANLI` | 11/6 | Brand Memory deposu (`MemoryService`): `sourceType`, `confidence`, `evidenceCount`, `polarity`. |
| `UserDecision` | `CANLI` | 2/1 | `remember_preference` hem buraya (ham mesajla) hem `BrandLearning`'e yazar; okuma birleşiktir. |
| `ProjectSetupState` | `CANLI` | 8/4 | Derin marka araştırmasının (Enrichment) durumu. |
| `ProjectSetupStageRecord` | `CANLI` | 1/2 |  |
| `ProjectSignalProfile` | `CANLI` | 5/5 |  |
| `ProjectGoal` | `CANLI` | 19/5 |  |
| `ProjectDepartment` | `CANLI` | 4/5 | `mode` sütunu etkisiz (yalnız `WorkHandoffEngine.accept` okuyor); sütun bazında izleme listesinde. |
| `ProjectSchedule` | `CANLI` | 15/10 |  |
| `AutonomyPolicy` | `CANLI` | 4/4 |  |
| `AgencyDailyStat` | `CANLI` | 5/3 | Günlük çağrı ve maliyet sayaçları (bütçe kapısı). |

### Sohbet, yürütme ve onay

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `Command` | `CANLI` | 21/20 | Sohbet satırları ve `topic: "WORK_SESSION"` kontrol noktaları (yeni tablo yok). |
| `Task` | `CANLI` | 54/4 |  |
| `TaskDependency` | `CANLI` | 2/2 |  |
| `ExecutionContextSnapshot` | `CANLI` | 1/2 |  |
| `ExecutionJob` | `CANLI` | 44/17 | `skillId` / `skillVersion` sütunları hep NULL (aşağıya bak). |
| `ExecutionVerification` | `CANLI` | 1/4 | İçerik `ExecutionJob.rawResult`'ın kopyası; sadeleştirme adayı, tablo düşürme adayı değil. |
| `OutboxEvent` | `CANLI` | 2/7 |  |
| `DeadLetterJob` | `CANLI` | 7/9 |  |
| `ProviderDefinition` | `CANLI` | 3/1 |  |
| `ProviderHealth` | `CANLI` | 1/2 |  |
| `ProviderIncident` | `CANLI` | 1/3 |  |
| `HumanInterventionRequest` | `CANLI` | 12/5 |  |
| `TemporarySecret` | `CANLI` | 1/3 |  |
| `Approval` | `CANLI` | 16/5 |  |
| `Asset` | `CANLI` | 20/14 |  |
| `Creative` | `CANLI` | 29/8 |  |
| `CreativeVersion` | `CANLI` | 3/3 |  |
| `BrowserProfile` | `CANLI` | 6/5 | Standart profiller ilk ihtiyaçta tembel oluşur (`ensureStandardBrowserProfiles`). |
| `IntegrationCredential` | `CANLI` | 35/38 |  |
| `AuditLog` | `CANLI` | 3/2 |  |
| `ReasoningCall` | `CANLI` | 6/2 |  |

### İstihbarat ve araştırma

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `Evidence` | `CANLI` | 2/5 | Araştırma önbelleği: `sourceUrl`, `contentHash`, `accessedAt` (site metni 7 gün taze sayılır). |
| `Finding` | `CANLI` | 12/2 |  |
| `Signal` | `CANLI` | 17/4 |  |
| `Insight` | `CANLI` | 13/4 |  |
| `Opportunity` | `CANLI` | 17/4 |  |
| `Competitor` | `CANLI` | 3/1 |  |
| `CompetitorSnapshot` | `CANLI` | 1/1 | Tek okuyucu `competitor-materializer` kendi diff'i için. |
| `CompetitorInsight` | `CANLI` | 1/1 | Tek okuyucu eski Council motoru (`council-engine.ts`). |
| `CompetitorChange` | `YAZ-OKUMA` | 0/1 | `competitor-materializer` yazıyor; hiçbir kod okumuyor (`CompetitorInsight.changeId` ile bağlı). |
| `CompetitorSource` | `KULLANILMIYOR` | 0/0 | Ne yazan ne okuyan var; `Competitor`'a bağlı yaprak tablo. |
| `Product` | `YAZ-OKUMA` | 0/1 | Yalnız `/api/webhooks/product-offers` yazar; okuyan yok. |
| `ProductOffer` | `YAZ-OKUMA` | 1/1 | Aynı webhook; tek okuma rotanın kendi idempotency sorgusu. Rota `public-paths`'te olmadığı için dışarıdan gelen çağrı proxy'de 307 ile `/login`'e yönlenir; kendi token doğrulaması hiç devreye girmez. |

### Fikir ve eski ajans döngüsü

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `Idea` | `CANLI` | 21/3 | `save_idea` ve isteğe bağlı üretimle beslenir; council-lite `SHORTLISTED`'a taşır. |
| `CouncilEvaluation` | `DÖNGÜ` | 1/2 | Yalnız eski Council motoru yazar; council-lite satır yazmaz. |
| `AgencyDecision` | `DÖNGÜ` | 9/2 | Director kararları (ve `WorkHandoffEngine.accept` kaydı); Karar paneli okumaya devam eder. |
| `BaselineAudit` | `DÖNGÜ` | 5/2 | Yalnız tam kurulum yazar; Enrichment bu aşamayı atlar. Departmanlar paneli okur. |
| `WorkPlan` | `DÖNGÜ` | 15/3 | Tek üretici `WorkPlanBuilder.buildForIdea`, o da yalnız Director'dan çağrılır. |
| `WorkHandoff` | `DÖNGÜ` | 9/3 | Yeni satır üreten tek yöntem `WorkHandoffEngine.propose` ve hiçbir yerden çağrılmıyor; yani yeni satır zaten gelmiyor. Var olan satırları yalnız döngü ilerletir (`progressPending`, `onTaskCompleted`). Work paneli okur. |
| `MeasurementPlan` | `DÖNGÜ` | 5/3 | `measurement-planning` (jeneratör) üretir. |
| `MeasurementCheck` | `DÖNGÜ` | 4/2 | `measurement-checks` (drainer) üretir. |
| `AgencyTrigger` | `CANLI` | 6/6 | Olay veri yolu (TASK_COMPLETED / FAILED); açık kalır. |
| `AgencyLoopState` | `CANLI` | 4/8 | Heartbeat; açık kalır. |
| `AgencyCycle` | `YAZ-OKUMA` | 1/2 | Tetikleyici döngüsü `start`/`complete` yazar. Okuma yöntemi `listRecentForProject` var ama hiçbir yerden çağrılmıyor (tek okuma o). |

### Hiç kullanılmayanlar

| Model | Sınıf | Oku/yaz | Not |
| --- | --- | --- | --- |
| `SocialAccount` | `KULLANILMIYOR` | 0/0 | Kodda kullanım yok (ilişki alanı ve tip taraması da boş). `BrowserProfile` ve `IntegrationCredential`'a FK verir, kendisine FK veren yok. |
| `Skill` | `KULLANILMIYOR` | 0/0 | Kod yok (skill'ler artık kod içi `SkillRegistry`). `ProjectSkill` ve `ExecutionJob.skillId` FK verir. |
| `ProjectSkill` | `KULLANILMIYOR` | 0/0 | Kod yok; `Skill`'e FK verir, kendisine FK veren yok. |

## İzleme listesi (sütun ve davranış bazında; tablo düşürme adayı değil)

- `ExecutionJob.skillId`, `skillVersion`: kodda `execution-service.ts` / `execution-job.repository.ts` / `execution/types.ts` üzerinden taşınıyor ama hiçbir çağıran değer vermiyor; sütunlar hep NULL. `Skill` düşürülmeden önce bu taşıma koddan kaldırılmalı.
- `ProjectDepartment.mode`: etkisiz ayar (yalnız `WorkHandoffEngine.accept` okuyor); UI'da görünür ama sonuç doğurmaz.
- `BrandDossier.approvedColors`, `approvedFonts`: görsel kimlik `BrandVisualIdentity`'den okunuyor; bunlar yalnız boş kimlikte yedek.
- `ExecutionVerification`: `ExecutionJob.rawResult`'ın aynısını kopyalıyor (doğrulama totoloji). Sadeleştirme adayı.
- `CompetitorInsight` / `CompetitorSnapshot` zinciri: tek gerçek okuyucusu eski Council motoru ve kendi materializer'ı. `LEGACY_AGENCY_LOOP=off` sonrası okuyucu kalmayabilir.

## Nasıl kaldırılır (kullanıcı kararı; bu turda çalıştırılmadı)

Sıra önemlidir: **önce kod, sonra şema, en son SQL.**

1. Yeni bir Neon **branch**'inde dene; satır sayılarını aşağıdaki kontrolle doğrula.
2. Kodda kalan bağlantıyı sök (Skill için: `ExecutionJob.skillId` taşıması; `CompetitorChange` için: materializer'ın yazımı ve `CompetitorInsight.changeId`).
3. Aynı commit'te modelleri `schema.prisma`'dan kaldır ve SQL'i **yeni bir migration klasörüne** koy (`prisma/migrations/<tarih>_drop_unused_tables/migration.sql`). Bu adım bilinçli bir kullanıcı eylemidir: klasör oluştuğu an bir sonraki deploy SQL'i canlıya uygular.
4. Deploy öncesi yedek/branch noktası al. Geri dönüş yolu bu noktadır; `DROP` geri alınamaz.

Yalnızca `KULLANILMIYOR` sınıfı için (kod tarafında söküm gerektirmeyen tablolar önce):

```sql
-- 0) Kontrol: hepsinin 0 satır (ya da vazgeçilebilir) olduğunu gör.
SELECT 'CompetitorSource' AS tablo, count(*) FROM "CompetitorSource"
UNION ALL SELECT 'SocialAccount', count(*) FROM "SocialAccount"
UNION ALL SELECT 'ProjectSkill', count(*) FROM "ProjectSkill"
UNION ALL SELECT 'Skill', count(*) FROM "Skill";
SELECT count(*) AS dolu_skill_baglantisi FROM "ExecutionJob"
 WHERE "skillId" IS NOT NULL OR "skillVersion" IS NOT NULL;

-- 1) Yaprak tablolar: kendilerine FK veren yok (DROP TABLE kendi FK ve indekslerini de kaldırır).
DROP TABLE "CompetitorSource";
DROP TABLE "SocialAccount";
DROP TABLE "ProjectSkill";

-- 2) Skill: önce ExecutionJob'daki bağlantı, sonra tablo.
ALTER TABLE "ExecutionJob" DROP CONSTRAINT "ExecutionJob_skillId_fkey";
ALTER TABLE "ExecutionJob" DROP COLUMN "skillId", DROP COLUMN "skillVersion";
DROP TABLE "Skill";

-- 3) Yalnız bu tablolarca kullanılan enum'lar (başka model kullanmıyor; ExecutionProviderType kalır).
DROP TYPE "SocialAccountStatus";
DROP TYPE "SkillStatus";
DROP TYPE "SkillSecurityStatus";
DROP TYPE "SkillTrustLevel";
DROP TYPE "SkillPermissionType";
```

`YAZ-OKUMA` sınıfı için SQL **verilmedi**: bunlar hâlâ yazılıyor, önce yazan kod bırakılmalı (`CompetitorChange`, `Product`/`ProductOffer` webhook'u, `AgencyCycle`). `ADAPTÖR` sınıfı (`Account`, `Session`, `VerificationToken`) ancak `auth.ts`'ten `PrismaAdapter` satırı çıkarılırsa ve OAuth/e-posta girişi hiç planlanmıyorsa düşürülebilir; Credentials + JWT çalışmaya bu satır olmadan da devam eder, ama ileride Google ile giriş eklenirse tablolar gerekir.

## `LEGACY_AGENCY_LOOP` ile ilişki

`DÖNGÜ` sınıfındaki tablolar için kaldırma sırası: `drain` (açık satırlar bitsin) → sayım SQL'i sıfır → `off` → en az bir sürüm boyunca izle → ancak panellerin okuması bilinçli bırakıldıktan sonra tabloyu düşünmek. Sayım sorguları `docs/architecture/legacy-loop-rollout.md`'de.

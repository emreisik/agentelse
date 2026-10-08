# AI kullanım ölçümü (Faz 1)

Her ücretli dış çağrının gerçek kullanımı ve USD maliyeti `UsageEntry` tablosuna yazılır. Bu, abonelik/kota/kârlılık sisteminin temelidir (plan: `~/.claude/plans/billing-usage-plan.md`). Faz 1'de davranış değişmez: yalnız ölçülür, hiçbir çağrı engellenmez.

## Neden ayrı bir tablo (ReasoningCall değil)

- `ReasoningCall` tanı kaydıdır: purpose başına bir satır, `projectId` kolonu var, marka silinince `ProjectDeletionService` onu da siler.
- `UsageEntry` faturalama kaydıdır: **çağrı başına** bir satır (yeniden denemeler, kesik yanıtla ikinci istek, zaman aşımı dahil), workspace düzeyinde ve kalıcı. Kolon adı bilerek `projectRef` (FK'sız): `projectId` adlı kolonu olan her tablo marka silinirken silinir.

## Nasıl çalışır

1. **Kapsam** (`src/server/billing/usage-context.ts`): giriş noktaları `runWithUsageScope({workspaceId, projectId, ...}, fn)` ile kimin ve hangi işin adına harcandığını belirler. İçteki çağrı dıştakinin `operationId`'sini miras alır.
2. **Yazıcı** (`usage-recorder.ts`): alt seviye istemciler (`openai-client`, `openai-search-client`, `openai-image-client`, `fal-image-client`, `embeddings`, sohbet turu) gerçek kullanımı `recordUsage()` ile yazar. Yazım hatası çağrıyı bozmaz. Kapsam yoksa satır `workspaceId = "unattributed"` olarak yazılır.
3. **Fiyat** (`src/server/reasoning/reasoning-pricing.ts`): liste fiyatları, `PRICE_TABLE_VERSION` damgalı. Önbellekli girdi tokenı %10 fiyatlanır, yalnız API `cached_tokens` döndürdüyse. Kullanım döndürmeyen sağlayıcılar (fal.ai, kalite başına sabit görsel fiyatı, bilinmeyen model) `costEstimated = true` ile işaretlenir; bu gerçek maliyet değildir.

## Kapsam kuran giriş noktaları

| Yer | Kapsam |
| --- | --- |
| `ReasoningService.run` | workspace + proje + purpose (≈45 çağıranı kapsar) |
| `ExecutionService.startExecution` | workspace + proje + capability, `operationId = exec:<jobId>` (execution sağlayıcıları, art-director, copywriter dahil) |
| Sohbet turu (`chat-agent.ts`) | model turu başına satır, `operationId = chat:<uuid>` |
| Edit/Studio (`creative-actions.ts`) | kullanıcı + workspace + proje; art-director ve görsel aynı işlem (`operationId = revise:<creativeId>:<zaman>`) |
| Hafta planlayıcı (`instagram-week-planner.ts`) | workspace + proje; her fikir için copywriter + art-director + görsel tek işlem (`week:<ideaId>`) |
| Logo üretimi (`project-actions.ts`) | kullanıcı + workspace + proje |
| SEO embedding | workspace + proje |

Yeni bir ücretli çağrı eklerken: ya `ReasoningService.run` üzerinden geç ya da çağrıyı `runWithUsageScope` içine al ve istemcinin `recordUsage` çağırdığından emin ol. Kapsamsız çağrılar rapordaki "unattributed" bölümünde görünür; orası sıfır olmalıdır.

## Rapor

```
npm run db:report:cost                      # son 30 gün
npm run db:report:cost -- --days 7
npm run db:report:cost -- --workspace <id>
```

Özet, modül/sağlayıcı/tür kırılımı, en pahalı amaçlar, görsel birim maliyeti (kalite bazında), sohbet mesaj başına maliyet, workspace bazında aylığa çevrilmiş maliyet ve kapsamı bulunamayan çağrılar.

## Bütçe sayaçları ile fark (bilinçli)

Faz 1'de davranış değişmez. `ReasoningCall.costUsd`, `AgencyDailyStat` ve sohbetteki oturum/mesaj maliyet korumaları (`RunGuard`) ESKİ formülle hesaplanmaya devam eder: önbellek indirimi yok, sohbette web arama ücreti yok (kasıtlı fazla tahmin). Yalnız `UsageEntry` gerçek fiyatı (önbellekli token %10, arama ücreti dahil) yazar. İki sayı aynı çağrı için biraz farklı olabilir; kota/rezervasyon Faz 3'te `UsageEntry`'ye geçecek.

## Saklama ve silme

`UsageEntry` içerik taşımaz (yalnız kimlik, model, token sayıları, maliyet); `workspaceId` ve isteğe bağlı `userId` içerir. Marka (proje) silinince kalır, çünkü faturalama ve kârlılık kaydıdır. Şimdilik otomatik silme/saklama süresi yok (workspace silme özelliği de yok). Workspace silme veya kullanıcı verisi silme özelliği eklendiğinde bu tablo da kapsama alınmalı (kullanıcı silinirse `userId` boşaltılır, satır faturalama kaydı olarak kalır).

## Bilinen ölçülemeyen boşluklar

- Sohbette Stop/hata anında yarım kalan turun tokenları (OpenAI akış bitmeden kullanım döndürmez).
- Zaman aşımı/bağlantı kopması: sağlayıcı işi yapıp faturalamış olabilir; kullanım bilinmediği için 0 USD ve tahmini işaretli satır yazılır (`success = false`). Sayısı mutabakatta şüpheli ücret adayıdır.
- fal.ai fiyatları liste tahminidir; fal.ai/pricing ile doğrulanmalıdır.
- `ExecutionJob.estimatedCost/actualCost` bilerek doldurulmaz: Task log paneli bu alanları kullanıcıya ham gösterir. İş bazında maliyet `operationId = exec:<jobId>` ile `UsageEntry`'den okunur.
- X (Twitter) API ile gönderi yayınlama gönderi başına ücretlidir (≈$0.01) ve ölçülmez; AI çağrısı değildir, kota kapsamı dışındadır.
- Sohbet modeli `incomplete` ve boş çıktıyla biterse (token tavanı) o turun kullanımı yazılmaz.
- fal.ai işi COMPLETED olduktan sonra sonuç indirilemezse harcama satırı yazılmaz (fal faturalamış olabilir).
- Kapsamsız çağrılar `workspaceId = "unattributed"` ile yazılır; yeni bir giriş noktası eklendiğinde raporun son bölümünden fark edilir.

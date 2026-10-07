# Uygulama katmanı: onaylı WordPress değişiklikleri (SC-F8)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.9, §9 SC-F8. Bağlayıcı: [wordpress-plan.md](wordpress-plan.md). Öneri döngüsü: [search-actions.md](search-actions.md). Fırsatlar: [search-opportunities.md](search-opportunities.md). İçerik planı: [search-content-plan.md](search-content-plan.md). GA tarafındaki aynı desen: [website-fixes.md](website-fixes.md). AI arama görünürlüğü (aynı fazın ikinci yarısı): [ai-search-visibility.md](ai-search-visibility.md).

## Durum (7 Ekim 2026)

Kodlandı, bayrakla kapalı, canlıda denenmedi. Migration `20261006221000_add_seo_apply` (sahibin `migrate deploy`'u bekliyor).

| Ekran                                                             | Ne değişti (rota, kart, metin, bayrak)                                                                                                                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connectors > WordPress (yeni "Website" kategorisi)                | Bağlan / Test / Re-check the site / Disconnect, günlük sınır seçici, IndexNow kartı. `SEO_APPLY`; kategori yalnız WordPress kutucuğu listelendiğinde görünür                                                                 |
| Search > Website changes (`/projects/{id}/arama#website-changes`) | Değişiklik listesi: onay/ret, Undo, Make it live, durum çipleri. `SEO_APPLY`                                                                                                                                                 |
| SEO Manager > Publish adımı                                       | "Publish to WordPress (draft)" bloğu. Makale takvime konduktan sonra çıkar; önce "Schedule the article first; then you can send a draft to WordPress." der. `SEO_APPLY` + bağlı ve sağlıklı site (kart açılırken damgalanır) |
| SEO Manager > "Fix the snippet" Publish adımı                     | Seçilen metin için "Apply with approval". `features.apply` damgası; `features.live`'a bağlı değildir                                                                                                                         |
| Search > Opportunities ve Actions & results                       | `INTERNAL_LINKS` ve metni seçilmiş `TITLE_META` için "Apply with approval". `SEO_APPLY` + `SEO_ACTIONS` (döngü) + sağlıklı site                                                                                              |
| Search > This month's articles (SC-F7 satırları)                  | Yazılmış makalesi olan yuvada "Publish to WordPress (draft)". `SEO_APPLY`; DRAFT yuvalarda yok                                                                                                                               |
| /health                                                           | "Website changes" sayaç kartı (yalnız sayılar; müşteri verisi yok)                                                                                                                                                           |
| /privacy ve /data-deletion                                        | Yeni "WordPress connection and website changes" bölümü; "How to delete your WordPress connection data" bloğu (aynı sürümde yayınlanmalı)                                                                                     |

## Bayraklar ve açılış sırası

Bayraklar çağrı anında okunur ve yalnız tam `true` açar. `.env.example` bu çalışmada yazılamadı; sahip şu üç satırı ekler (docs'a işaret eden yorumla): `SEO_APPLY=false`, `SEO_INDEXNOW=false`, `SEO_GEO=false`.

- `SEO_APPLY=true`: uygulama katmanının ana şalteri (WordPress kutucuğu, öneri, onay kancası, uygula/geri al motoru, tick adımı `seo-apply`, Search sayfası "Website changes", düğmeler). `SEO_HEALTH=true` ister. Proje başına `seoApplyEnabledFor(projectId)`: `seoWorkAllowedFor` ekler (yerel gelişmede `SEO_DEV_PROJECTS`, kademeli açılışta `SEO_ROLLOUT_PROJECTS`).
- `SEO_INDEXNOW=true`: IndexNow alt bayrağı. `SEO_APPLY` ister. Plan'ın bayrak listesinde yoktu (yeni; kayıt altında).
- `SEO_GEO=true`: [ai-search-visibility.md](ai-search-visibility.md). `SEO_HEALTH` + `SEO_CRAWL` ister.
- Yeniden kullanılanlar: `SEO_ACTIONS` (yalnız SeoAction bağı ve fırsat/eylem düğmeleri için; makale yayını onsuz da çalışır), `SEO_CONTENT_PLAN`, `GA_SYNC`, `AGENTELSE_PROVIDER_MODE=mock`, `AGENTELSE_REASONING_MODE=mock`, `META_TOKEN_KEYS` (isteğe bağlı anahtar halkası; yoksa `legacy`).
- Dev koruması: paylaşılan canlı DB'ye bağlı bir geliştirme süreci yalnız `SEO_DEV_PROJECTS` içindeki projeleri işler (runner'lar listeyi WHERE'e koyar), global kilit, kalp atışı ve saklama çalıştırmaz. İzinli bir projede dev süreci `SEO_APPLY` ile o müşterinin GERÇEK WordPress'ine yazar; geliştirmede yalnız sahibin kendi test sitesi için açılmalıdır. Süreç kipi `CmsSite.isMock` ile eşleşmelidir (`mockMatchesSite`).
- Bayrak kapalıyken motor uyur: tick adımı, saklama ve görünümler veritabanına gitmeden döner; APPROVED satırlar bekler, 14 gün ve 24 ay temizliği bayrak açılınca sürer. Disconnect'in kendi temizliği bayraktan bağımsızdır, fakat kutucuk gizli olduğundan bayrak kapalıyken bağlantıyı kesmek için önce bayrağı o proje için açın.

Açılış sırası:

1. `migrate deploy` (4 tablo).
2. Kodu yayınla; gizlilik ve veri silme metni aynı sürümde gider.
3. `SEO_GEO=true` sahibin projesinde (salt okunur denetim, en güvenlisi).
4. `SEO_APPLY=true` izinli projelerde, mock ya da test WordPress'iyle.
5. Gerçek bir test WordPress'i bağla (özel Editor kullanıcısı), taslak, yayına alma ve geri almayı dene; [wordpress-plan.md](wordpress-plan.md) "Doğrulanmalı" listesini yürüt.
6. `SEO_INDEXNOW=true` en son.

## Kapasite seçimi: WEBSITE_UPDATE yeniden kullanıldı

Yeni `CapabilityKey` eklenmedi (enum migration'ı gerekmezdi, ama gerek de yoktu). `WEBSITE_UPDATE` bugün `APPROVAL_REQUIRED`, `HIGH_RISK`, `VERIFICATION_REQUIRED`, `WEB_PRODUCT` departmanının ve hiçbir gerçek sağlayıcısı yok (yürütme işçisi yönlendirilmemiş `WEBSITE_UPDATE`'i dead-letter yapar). SC-F8 görevleri `Task.payload.seoApply = { v: 1, changeId, kind }` ile ayırt edilir (saf yardımcı `isSeoApplyPayload`, `src/lib/seo/apply/approval-details.ts`). İşaretsiz genel `WEBSITE_UPDATE` görevleri eskisi gibi davranır.

`ExecutionProvider`/`ExecutionJob` yok: sağlayıcı arayüzü (`execute -> {executionReference}`) CAS kilidi, canlı ön okuma, geri okuma, anlık görüntü ve geri almayı ifade edemez. GA-F7 gibi onay kancası `SeoApply.onTaskApproved`'ı doğrudan çağırır. Reuse'un üç yan etkisi dar paylaşılan düzenlemelerle kapatıldı:

- `TaskPlanner.dispatchApprovedTask`: işaretli görev için `SeoApply.onTaskApproved`'a yönlenir (dinamik import; bayrak kapalıyken modül grafiği değişmez), ExecutionJob oluşturmaz.
- `TaskRepository.transition`: işaretli görev Telegram'a "Task completed/failed" göndermez.
- `MeasurementEngine.planForCompletedTask`: işaretli görev için ölçüm planı açmaz (SC-F6 ölçer).
- `buildApprovalDetails`: işaretli yükün satırlarını `payload.details`'ten okur.
- AgencyTrigger yelpazesi doğrulandı (varsayılmadı): `TASK_COMPLETED/FAILED/CANCELLED` tüketicileri (`WorkPlanProgressor`, `WorkHandoffEngine`, `AdsDecisions`, `ResultMaterializer`, zincir röleleri) `workPlanId` boş ve `ExecutionJob`'suz bu görevde hiçbir şey yapmaz; `seo-apply-task-consumers.test.ts` bunu pinler.

## Onay akışı

- `Task` (WEBSITE_UPDATE, işaretli yük) + `Approval` (tip `CRITICAL_CHANGE_APPROVAL`, seviye `LEVEL_3_CLIENT`, `entityType: "Task"`, `notify: false`). GA-F7 ile aynı onay tipi; kapı tipe bağlıdır (`ApprovalRepository.decide`): yalnız workspace OWNER/ADMIN onaylar, reddeder ya da revizyon ister. Telegram sözde kullanıcısı (`userId` içinde `:`) sorgusuz reddedilir. İptal (`CANCELLED`) sistem yoludur ve kapıya girmez. Hata metni ortaktır: "Only a workspace owner or admin can approve this change."
- Herhangi bir üye öneri yapabilir. Üyenin önerisi OWNER/ADMIN bakmazsa 7 günde sona erer; panel "Waiting for an owner or admin" der. SC-F8'de SYSTEM önerisi yoktur.
- Süre: `Approval.expiresAt = şimdi + 7 gün` ve `SeoChange.expiresAt` AYNI değerdir (bir kez hesaplanır). `decide` süre dolunca onaylamayı reddeder; fakat zaten APPROVED bir değişiklik `Approval.expiresAt` geçse de uygulanır. Onaylanıp 14 gün uygulanmayan APPROVED satır EXPIRED olur. PROPOSED satırın EXPIRED'a geçişi kendi tarihine değil Approval satırına (EXPIRED/CANCELLED) bakarak olur.
- Sürtünmeyi arayüz azaltır: önerdikten sonra OWNER/ADMIN satır içinde "Approve and create the draft" / "Approve and make it live" görür (normal onay kararı, `reviewedByUserId` ile). Üyeler "Waiting for an owner or admin" görür.
- Kapı olmadan onay yolları: Telegram'a hiçbir şey gitmez (`notifyApprovalDecision` CRITICAL_CHANGE_APPROVAL için erken döner); sohbette düz "onayla" bu onayı VERMEZ: `findLatestPendingApproval` en son bekleyen onayı seçtiğinden `command-service` bu tipte `APPROVAL_ON_CARD` döndürür ("onay kartını kullanın", `spendsMoney` ile aynı kural; reddetmek serbest). İki toplu onay yolu (`plan-progress-actions`, `work-approve-actions`) `entityType: "Creative"` süzer, Task onaylarına dokunmaz; `write-guard.test.ts` üçünü de pinler.
- Kancalar: onay bir kararla (web, sohbet kartı, Telegram dışı) `APPROVED` olunca `onSeoApplyTaskApproved` satırı hizalar ve uygulamayı satır içi başlatır (20 sn bütçe); gecikenleri tick adımı toplar. `syncSeoChangeApprovalState` Approval satırını okur (ret, revizyon, sohbet kararı dahil). Çift çağrı güvenlidir: uygulama kilidi CAS'tır.

## Yaşam döngüsü (ENGINE TRANSITIONS)

Tüm yazmalar beklenen durumla `updateMany` (CAS). Her terminal geçiş `openKey = null` yapar. Task: VERIFIED > COMPLETED, FAILED > FAILED (`failureReason` sabit metin), yeniden deneme RUNNING kalır, ret/süre dolumu CANCELLED.

| Olay                                                                                                        | Nereden                                 | Nereye                                                                                          | Not                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| onaylandı (kanca / senk)                                                                                    | PROPOSED                                | APPROVED                                                                                        | `approvedAt`, `approvedByUserId` Approval'dan; Task WAITING_APPROVAL > RUNNING                                                               |
| yazma için sahiplen                                                                                         | APPROVED                                | APPLYING                                                                                        | kilit boş/süresi geçmiş ve `nextAttemptAt` boş/geçmiş; `attempts+1`; kilit 2 dk. Bayrak kapalı ya da kip uyuşmuyorsa sahiplenmez (`skipped`) |
| devam / geri okuma yeniden denemesi için sahiplen                                                           | APPLIED                                 | APPLIED                                                                                         | yalnız kilit ve `nextAttemptAt` CAS; `attempts+1`; kalan yazmalarla devam ya da doğrudan geri okuma                                          |
| hız penceresi dolu                                                                                          | APPROVED                                | APPROVED (`nextAttemptAt` = pencere çıkışı)                                                     | `attempts` değişmez, kilit bırakılır, `waiting`                                                                                              |
| kapı başarısız (onay APPROVED değil, site yok/sağlıksız, kapsam değişti, yetenek yok, kip uyuşmuyor)        | APPLYING                                | FAILED (`failedAt`, hata)                                                                       | yazıcı ASLA çağrılmaz; onay kapısı yalnız `status === "APPROVED"`, `expiresAt`'e bakmaz. APPLIED satırda `appliedAt` korunur                 |
| noop (zaten sağlanmış, bizden bir şey işlemedi)                                                             | APPLYING                                | VERIFIED (`noop=true`, before=after)                                                            | yazma yok; sayılmaz, geri alınmaz                                                                                                            |
| noop + `landedEarlier`                                                                                      | APPLYING                                | VERIFIED (`noop=false`, `appliedAt=şimdi`)                                                      | sayılır, geri alınabilir, bağlanabilir; son adımlar çalışır                                                                                  |
| plan reddi (`page_changed`, `builder_page`, `anchor_not_found`, `seo_plugin_unsupported`, `page_not_found`) | APPLYING                                | FAILED                                                                                          | devam eden APPLIED satır reddedilirse `appliedAt` korunarak FAILED                                                                           |
| ilk yazma döndü                                                                                             | APPLYING                                | APPLIED (`appliedAt`, `wpId`, `liveUrl`)                                                        | before ilk sahiplenmede (`attempts==1`) saklanır, bir daha ezilmez                                                                           |
| aynı değişikliğin sonraki yazması yeniden denenebilir hata verdi                                            | APPLIED                                 | APPLIED (`nextAttemptAt` = şimdi + geri çekilme)                                                | yalnız kalan yazmalar gönderilir                                                                                                             |
| geri okuma tamam                                                                                            | APPLIED                                 | VERIFIED (`after`, `verifiedAt`)                                                                | sonra: taslak zinciri güncellemesi (PUBLISH_LIVE), SeoAction bağı, IndexNow kuyruğu, Task COMPLETED, audit                                   |
| geri okuma uyuşmadı                                                                                         | APPLIED                                 | FAILED `readback_mismatch` (`appliedAt` korunur)                                                | ikinci yazma yok; GERİ ALINABİLİR                                                                                                            |
| yazmadan ÖNCE yeniden denenebilir hata, deneme < 3                                                          | APPLYING                                | APPROVED (`nextAttemptAt` = şimdi + geri çekilme)                                               | taslak oluşturma bir sonraki denemede `searchDrafts` ile benimsenir                                                                          |
| 3. denemede aynı hata                                                                                       | APPLYING / APPLIED                      | FAILED                                                                                          | APPLIED `appliedAt`'i korur, geri alınabilir                                                                                                 |
| geri okuma ÇAĞRISINDA hata                                                                                  | APPLIED                                 | APPLIED; 3 sahiplenmeden sonra FAILED `site_unavailable` (`appliedAt` korunur, geri alınabilir) | ikinci yazma yok                                                                                                                             |
| yeniden denenemez hata                                                                                      | APPLYING / APPLIED                      | FAILED                                                                                          | 401 ayrıca `CmsSite.health = AUTH`, kod `reconnect`                                                                                          |
| kilit süresi doldu (reconcile)                                                                              | APPLYING                                | APPROVED (`appliedAt` yoksa) / APPLIED                                                          |                                                                                                                                              |
| kilit süresi doldu (reconcile)                                                                              | UNDOING                                 | VERIFIED (`verifiedAt` varsa) / FAILED                                                          |                                                                                                                                              |
| geri al                                                                                                     | VERIFIED veya FAILED (`appliedAt` dolu) | UNDOING > UNDONE (`rolledBackAt`, `undoneByUserId`)                                             | başarısızsa geldiği duruma döner, `error.undo=true`                                                                                          |
| ret / revizyon (her yol, `syncApprovalState`)                                                               | PROPOSED                                | REJECTED                                                                                        | Task CANCELLED                                                                                                                               |
| onay CANCELLED/EXPIRED                                                                                      | PROPOSED                                | EXPIRED                                                                                         | Approval PENDING süresi geçmişse EXPIRED; Task CANCELLED                                                                                     |
| onaylı ama 14 gündür uygulanmadı                                                                            | APPROVED                                | EXPIRED                                                                                         | Task CANCELLED                                                                                                                               |

## Uygulama sırası

Kapı (bayrak, kip, onay `APPROVED`, site sağlıklı, kimlik okunur, kapsam ve alan adı) > kilit (CAS) > canlı okuma > plan (`planChange`) > yazma > geri okuma > VERIFIED > yan adımlar. Plan sırası TITLE_META / INTERNAL_LINKS için: (1) canlı yok > `page_not_found`; (2) hedef zaten sağlanmış > noop (`landedEarlier`: `prior` var ve bunu sağlamıyorsa); (3) bayatlık: taban `prior ? prior.modified : params.expectModified`, farklıysa `prior` ile yalnız "ilk yazının alanları sağlanmış, kalanlar değil" durumunda devam, yoksa `page_changed`; (4) desteklenmeyen açıklama > ret; (5) yazma. `PUBLISH_LIVE`: canlı zaten `publish` ise noop. `PUBLISH_ARTICLE`: benimsenen taslak (aynı başlık, metin özeti, 30 dk) noop + `landedEarlier`. Yetenek denetimi yalnız gerçek yazma olacaksa, noop ve bayatlık sonrasında çalışır. Hız sınırı: [wordpress-plan.md](wordpress-plan.md).

Motor dosyaları: `src/server/seo/apply/` (`propose.ts`, `approval-hook.ts`, `apply.ts`, `undo.ts`, `reconcile.ts`, `settings.ts`, `indexnow.ts`, `cleanup.ts`, `retention.ts`, `read.ts`, `counters.ts`, `offers.ts`, `action-link.ts`, `seo-apply.ts` bileşimi); saf kütüphane `src/lib/seo/apply/` ve `src/lib/seo/apply/wp/`; bağlayıcı `src/server/integrations/wordpress/`.

## Geri alma

Ayrıntı [wordpress-plan.md](wordpress-plan.md) "Geri alma". Özet: açık OWNER/ADMIN tıklaması (`undoneByUserId` + AuditLog), VERIFIED ve yazılmış FAILED satırlardan, `noop=false`, 90 gün içinde. Koşullar canlı `modified === after.modified`, `PUBLISH_LIVE` için canlı durum `publish`. 404 = zaten gitmiş. `cannot_undo` metni sabittir. SC-F6 ölçümü başladıktan sonra geri alma eylemi geri sarmaz (değerlendirme büyük olasılıkla INCONCLUSIVE/DIDNT).

## SC-F6 bağlantısı

Tüm SC-F6 bağı TEK adaptör dosyasındadır: `src/server/seo/apply/action-link.ts`, `SeoActionFlags.loop()` ile korunur.

- `SeoChange.seoActionId` + `SeoChange.creativeId` düz kimliklerdir (JSON yolu süzgeci yok).
- `TITLE_META` VERIFIED: son metin eylem önerisine yazılır, `APPLY` ile `appliedVia = CMS` ve `approvalId`. (Bunun için `transitionAction` yamasına `appliedVia` ve `approvalId` eklendi.)
- `INTERNAL_LINKS` fan-out: W5 eylemi birden çok sayfaya yayılmış 5 bağlantı taşıyabilir; bir değişiklik tek sayfa ve en çok 3 bağlantıdır. Eylem yalnız önerinin HER bağlantısı, eylemin VERIFIED (noop dahil) değişikliklerinin `params.links` birleşimiyle kapsandığında APPLIED olur. Sayfa başına bir düğme, 3'lük parçalar; kalan bağlantılar listelenmeye devam eder. Kapsama anahtarı kaynak sayfa + hedef sayfadır, bağlantı metni önemsizdir.
- `PUBLISH_LIVE` (noop olmayan, VERIFIED) makale döngüsünü kapatır: `creativeId` ile bulunan `NEW_CONTENT`/`LOCALIZE` eylemi `proposal.liveUrl` alır ve `APPLY` (`appliedVia = CMS`) olur; Creative, ilgili çekirdek yoluyla `APPROVED > PUBLISHED` yapılır (`creative.marked_published` audit, `via: "seo_apply"`). İkisi de idempotenttir; sonradan elle "Mark as published" zararsızdır.
- Geri alma yalnız eylem hâlâ APPLIED iken `UNDO_APPLY` çağırır.
- Döngü kapalıyken (`SEO_ACTIONS` yok) taslak ve yayın adımları yine çalışır, ama Creative işaretlenmez ve eylem bağlanmaz.

## IndexNow (isteğe bağlı, `SEO_INDEXNOW`)

WordPress REST kök dizine dosya yazamaz; bu yüzden kullanıcı kendi `{anahtar}.txt` dosyasını oluşturur (anahtar bizce üretilir, 32 onaltılık karakter, gizli değildir). "Check the file" `https://host/{anahtar}.txt`'yi alır ve gövde anahtara eşitse `indexNowVerifiedAt` yazar. Pingler `https://api.indexnow.org/indexnow` adresine gider (Bing, Yandex ve katılan diğerleri; Google hiç), yalnız VERIFIED/UNDONE `TITLE_META` / `INTERNAL_LINKS` / `PUBLISH_LIVE` değişikliklerinin herkese açık adresleri için (taslak asla), değişiklik başına en çok 5 URL, proje başına en çok 10 dakikada bir. Sıklık kilidi `SeoApplySetting.indexNowLastPingAt` üzerinde CAS'tır. 429 ve ağ hataları satırı PENDING bırakır; 24 saatten uzun bekleyen FAILED olur. Mock kipte hiç çağrılmaz. Not bir site yazması değil bir bildirimdir; gizlilik metni hangi motorların adresleri alabileceğini söyler.

## Arayüz

- Connectors > WordPress ("Website" kategorisi): kutucuk "WordPress"; diyalogda Connect / Test / Re-check the site / Disconnect, günlük sınır (1-25), yetenek çipleri, yönetici uyarısı, IndexNow kartı. Hata metinleri sabittir.
- Search > Website changes (`#website-changes`): "Changes Agentelse makes on your WordPress site. Every change needs an owner or admin to approve it first, and you can undo it." Satırlar: durum çipi, sabit başlık, önizleme satırları, bağlantı, hata. Düğmeler: onay/ret (yalnız `canDecide`), Undo (yalnız yönetici ve `canUndo`), "Make it live (needs approval)" (`canMakeLive`).
- SEO Manager > Deliver: `PublishToWordPress` bloğu ("Publish to WordPress (draft)"). Taslak notu: "Nothing is created on WordPress until an owner or admin approves. The draft is not visible to visitors." Takvim notu: "Scheduling this article on the calendar does not schedule the WordPress post." Yayındayken blokta yalnız canlının Undo'su görünür ("Undo makes the article a draft again.").
- Fırsat kartı ve Actions & results: "Apply with approval" (veri sunucuda `loadApplyOffersForFindings/Actions` ile hesaplanır, kapalıyken sorgu yok). Metni seçilmemiş TITLE_META bulgusu "Fix this" ile kalır; Deliver adımı seçilen metin için düğme sunar.
- Düğmeler yalnız sunucu hesaplı bir booleanla çizilir (`features.apply`, slot `applyReady`): bayrak kapalıyken ölü düğme ve istemci isteği yoktur. SEO Manager kartının `features.apply` damgası kart AÇILIRKEN yazılır; WordPress bundan sonra bağlandıysa yeni kart açmak gerekir (bilinen sınır).
- Durum ucu: `GET /api/projects/{id}/seo/apply/status?creativeId=` (üye kapısı; `PublishStatusView`).
- /health: "Website changes" kartı (sayaçlar).

## Gizlilik ve Limited Use

`SeoChange.before/after/params` müşterinin kendi sayfa içeriğini taşır (başlık, açıklama, bağlantı metni, iç bağlantı için ham içerik). 24 ay saklanır; `params.markdown` terminal durumdan 30 gün sonra boşaltılır; `before.contentRaw` 90 gün sonra silinir (retention günlük, global, yalnız izinli işlem). Onaylanan metin Search Console önerisinden türese bile müşterinin kendi içeriğidir: Google verisi değildir ve Search Console bağlantısı kesilince silinmez (gizlilik metni bunu söyler). Disconnect hepsini siler, bekleyen onayları iptal eder, Task ve kart metinlerini temizler. Task `failureReason` her zaman sabit metindir. AuditLog `{changeId, kind, source?, code?, dailyLimit?}` taşır. Telegram hiçbir şey almaz. Operatör yalnız sayaç görür.

## Testler (kabul ölçütleri)

- Onaysız yazma yok: `src/server/seo/apply/write-guard.test.ts`: yazıcı yöntemler yalnız `apply.ts` ve `undo.ts` (ve istemci/mock/test) içinde; `propose` hiç yazmaz; PROPOSED, onaysız ya da PENDING/REJECTED/EXPIRED/CANCELLED onayla `applySeoChange` yazıcı çağırmaz; toplu onay yolları `entityType: "Creative"` süzer.
- Her yazma geri alınabilir: 90 gün, noop hariç (`undo.test.ts`, `apply.integration.test.ts`).
- Taslak varsayılanı: `plan.test.ts` (`status: "draft"` sabit).
- Search Console istemcisi yalnız okur: `src/server/integrations/search-console/read-only.test.ts` (yalnız GET ve `searchAnalytics/query` / `urlInspection/index:inspect` POST'u, `webmasters.readonly` kapsamı, `searchconsole.googleapis.com` yalnız izin listesindeki dosyalarda).
- İşçi grafiği: `worker-graph.test.ts`: `seo-apply.ts`, `reconcile.ts` ve GEO runner'ın içe aktarma kapanışında `tenant-context`, `next-auth`, `next/navigation`, React `cache` yok.
- Paylaşılan düzenleme testleri: `approval.repository.test.ts` (MEMBER onaylayamaz, `telegram:` sorgusuz reddedilir), `command-service.test.ts` (`APPROVAL_ON_CARD`), `task-planner.test.ts`, `task.repository.test.ts`, `measurement-engine.test.ts`, `telegram-approval-notifier.test.ts`, `seo-apply-task-consumers.test.ts`.
- DB entegrasyon testleri (`apply.integration.test.ts`, `connect.integration.test.ts`, `geo.integration.test.ts`) tek kullanımlık Postgres ister.

## Sahip adımları

1. `migrate deploy` (`20261006221000_add_seo_apply`).
2. Gizlilik ve veri silme metni ile aynı sürümde yayınla.
3. `.env.example`'a üç bayrağı ekle (yukarıdaki sıra).
4. Önce sahibin kendi test WordPress'inde dene; "Doğrulanmalı" listesini yürüt.
5. `SEO_ROLLOUT_PROJECTS` ile kademeli aç.

## Ertelenenler

Uygulama için sohbet araçları, `CONTENT_REFRESH` ve `CONSOLIDATE` için WordPress yolu, şema (JSON-LD) enjeksiyonu, sitemap'i CMS üzerinden düzeltme, yönlendirmeler, zamanlı yayın (`future`), medya yükleme, kategori/etiket/yazar, özel yazı türleri, alt klasör kurulumları, WordPress.com'da barındırılan siteler, Shopify ve Webflow, sonuçları Search & SEO sohbetine yazma, GEO bulgularını Signal/fikre çevirme.

## Doğrulanmalı

[wordpress-plan.md](wordpress-plan.md) "Doğrulanmalı" listesi. Ayrıca: `SEO_APPLY` kapalıyken Connectors sayfasının ek sorgu yapmadığı, bayrak açıkken kategori ve kutucuğun doğru çıktığı, SEO Manager kartındaki `features.apply` damgasının kart açılırken yazıldığı tarayıcıda görülmedi.

## Riskler

- Zaman aşımına uğrayan yazma gerçekte işlemiş olabilir: oluşturma yeniden denenmez (benimseme), güncellemeler yeniden okunur (tanıma). Katı `modified` eşitliği zararsız düzenlemeyi de reddedebilir; kullanıcı yeniden önerir.
- Kısmi çok yazmalı değişiklikte kullanıcı geri almazsa sayfa yarım değişmiş kalır; FAILED satır sabit metinle bunu söyler.
- Sayfa önbelleği/CDN halka açık değişikliği geciktirir; SC-F6 doğrulayıcısı günlük yeniden dener. Çekirdek yazı başlığı üzerinden başlık değişikliği çoğu temada H1'i de değiştirir; onay kartı bunu söyler.
- `INTERNAL_LINKS` ham içeriği düzenler; `kses` öznitelikleri silebilir (geri okuma yakalar). Bilinmeyen sayfa oluşturucular işaretle yakalanamayabilir (düşük risk).
- Dev koruması izinli bir projeyi gerçek sitesine yazdırabilir (yukarıda).
- Application Password bir taşıyıcı sırdır ve kullanıcının tüm yeteneklerini taşır; şifreli, asla loglanmaz, yalnız https ve yönlendirmesiz gider. `META_TOKEN_KEYS`'ten eski anahtar kimliğini silmek saklı sırrı okunamaz yapar (yeniden bağlanmak gerekir).
- Onay yüzeyleri: kart proje sohbet akışına ve "waiting on you" listelerine gider, Telegram'a asla; sohbette "onayla" kısayolu bu onay için reddedilir.
- Paylaşılan sıcak yollar (`dispatchApprovedTask`, `decide`, `command-service`, `transition`) yalnız işaretli yük ya da `CRITICAL_CHANGE_APPROVAL` ile anahtarlıdır; işaretsiz davranış testlerle pinlidir.

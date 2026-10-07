# Google Analytics düzeltme eylemleri (GA-F7)

Plan: [google-analytics-plan.md](google-analytics-plan.md) §9 GA-F7, GK13, §3.11. Bağlantı katmanı: [google-connections.md](google-connections.md). Ölçüm sağlığı kontrolleri ve rehberleri: [measurement-health.md](measurement-health.md). Bu dosya GA-F7'nin uygulanmış hâlini anlatır: Agentelse, kullanıcı isterse ve bir workspace OWNER/ADMIN'i tek tek onaylarsa Google Analytics mülkünde küçük yapılandırma düzeltmeleri yapar.

## Durum (7 Ekim 2026)

Kodlandı; **dört bayrağın arkasında, varsayılan KAPALI**. Canlıda denenmedi. Google tarafı (`analytics.edit` izninin doğrulama başvurusuna eklenmesi, v1alpha uçlarının gerçek mülkte denenmesi) sahip adımlarıdır (aşağıda).

| Parça                                                                                        | Durum    | Hangi ekran değişti                                                                      |
| -------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| İsteğe bağlı ikinci onay ekranı (`analytics.edit`), düzenleme izni kartı, "Turn off editing" | Kodlandı | Connectors > Google Analytics diyaloğu: "Let Agentelse make approved changes (optional)" |
| 5 düzeltme türü: öneri → onay → uygulama → geri okuma → geri alma                            | Kodlandı | Website sayfası (`/projects/[projectId]/site`): "Changes Agentelse made" bölümü          |
| "Fix it for me (needs approval)" düğmesi                                                     | Kodlandı | Website sayfası, Measurement health panelinde MH5, MH14, MH17 rehberlerinin altı         |
| Değişiklik geçmişi izleme (GA'da Agentelse dışında yapılan değişiklik uyarısı)               | Kodlandı | GA4 kaynaklı uyarılar (Website sayfası, Today)                                           |
| Otomatik not (annotation) önerileri (kampanya başlatıldı, haftalık "yeni gönderiler")        | Kodlandı | Aynı bölümde onay bekleyen öneri olarak                                                  |
| Operatör sayaçları                                                                           | Kodlandı | `/health`: "Google Analytics fixes" kartı (yalnız sayılar)                               |
| Gizlilik ve veri silme metni                                                                 | Kodlandı | `privacy/page.tsx`, `data-deletion/page.tsx` (testleri aynı sürümde)                     |

Migration'lar: `20261006218900_add_analytics_edit_capability` (yalnız `CapabilityKey` enum değeri `ANALYTICS_EDIT`; ayrı klasör, META_LAUNCH emsali) ve `20261006219000_add_ga_config_change` (`GaConfigChange`, `GaChangeWatch`). `migrate deploy` bayrak açılmadan önce üretime ulaşmış olmalı.

## Bayraklar ve açılış sırası

Hepsi çağrı anında okunur; yalnız tam `true` değeri açar. Kapalıyken davranış değişmez: tick adımları sorgusuz hemen 0 döner, OAuth yükseltmesi reddedilir ve `analytics.edit` asla istenmez, arayüz hiçbir şey çizmez, Disconnect ek sorgu atmaz, Integrations ve Website sayfaları ek sorgu atmaz.

| Bayrak                              | Etki                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GA_FIXES=true`                     | Ana anahtar (`gaFixesEnabled()`); `GA_SYNC` de açık olmalı. v1beta türleri (key event, saklama süresi) ve değişiklik geçmişi izleme yalnız buna bağlıdır.                                                                                                                                                                                 |
| `GA_FIXES_ALPHA=true`               | v1alpha ailesi için isteğe bağlı kill switch: ENHANCED_MEASUREMENT, CHANNEL_GROUP_AI, ANNOTATION_CREATE. Kapalıyken bu türler önerilmez, `propose` `alpha_off` ile reddeder, zaten ONAYLANMIŞ alpha satırı **yazmak için talep edilmez** (APPROVED kalır, arayüz "Approved, switched off right now" der; FAILED yapılmaz; 14 gün sonra süresi dolar). Yazması dönmüş (APPLIED) satır bu anahtardan etkilenmez: yalnız geri okunur, böylece sonsuza dek bekleyip `openKey`'i tutmaz. |
| `GA_FIXES_ANNOTATIONS=true`         | `ga-annotations` adımının kampanya başlatıldı notlarını ÖNERMESİ. `GA_FIXES` ve `GA_FIXES_ALPHA` ister. Panelden elle not yalnız `GA_FIXES_ALPHA` ister.                                                                                                                                                                                  |
| `GA_FIXES_ANNOTATIONS_PUBLISH=true` | Haftalık "yeni gönderiler yayınlandı" notu önerisi. `GA_FIXES_ANNOTATIONS` ister.                                                                                                                                                                                                                                                         |

Yeniden kullanılan bayraklar: `GA_SYNC` (şart), `GA_WEBSITE_PAGE` (Website sayfası ve panel), `GA_HEALTH` (rehberlerin altındaki teklifler ve "Mute 7 days"), `AGENTELSE_PROVIDER_MODE=mock` (bellek içi Admin istemcisi, Google çağrısı yok, düzenleme izni verilmiş sayılır, yalnız `isMock` bağlar için), `GA_SYNC_DEV_PROJECTS` (dev koruması: `gaSyncAllowedFor` öneri, uygulama ve izlemeyi korur; her aday sorgusu `gaSyncProjectAllowList` ile süzülür, izinli olmayan satırlar izinlileri LIMIT başında aç bırakmaz).

**Açma sırası:** `migrate deploy` (iki migration) → kodu yayınla → sahip `analytics.edit`'i AYNI Google Cloud projesinin Data Access'ine ve mevcut doğrulama başvurusuna ekler → `GA_FIXES=true` yalnız izin listesindeki projelerde (`GA_SYNC_DEV_PROJECTS`) → v1alpha şekillerini API Explorer'da test mülkünde doğrula (aşağıdaki liste) → `GA_FIXES_ALPHA=true` → isteğe bağlı `GA_FIXES_ANNOTATIONS=true` → isteğe bağlı `GA_FIXES_ANNOTATIONS_PUBLISH=true`. Dört ad `.env.example`'a da eklenmeli (sandbox o dosyayı yazamadı; sahip ekler): `GA_FIXES=false`, `GA_FIXES_ALPHA=false`, `GA_FIXES_ANNOTATIONS=false`, `GA_FIXES_ANNOTATIONS_PUBLISH=false`.

**Dev uyarısı:** İzin listesindeki bir proje, dev süreçte `GA_FIXES` açıkken müşterinin GERÇEK mülküne yazar. Dev'de `GA_FIXES`'i yalnız sahibin kendi test mülkü için aç.

## İkinci onay ekranı (`analytics.edit`)

- Servis ayrımı korunur: Search Console **asla** edit izni almaz (`googleScopesFor('search_console', …)` `edit`i yok sayar, `buildGoogleAuthorizeUrl` fırlatır, start rotası 400 verir, callback Search Console izni de taşıyan token'ı reddeder).
- İstek izinleri AÇIKÇA listeler: `analytics.readonly` + `analytics.edit` + `userinfo.email`. `include_granted_scopes` hiçbir adreste YOK (mevcut karar ve test korunur; gizlilik cümlesi "each one asks Google only for its own permission" doğru kalır). Normal adresten farkı: ek izin, `prompt=consent` (`select_account` yok), `login_hint` (bağlı e-posta) ve imzalı state'te `upgrade: 'edit'`.
- Start (`?projectId&service=analytics&upgrade=edit`): `GA_FIXES` + dev koruması, workspace OWNER/ADMIN, token'ı olan ACTIVE analytics bağlantısı ve seçili mülk ister. Hatalar `googleError=edit_not_available | edit_manager_only | edit_connect_first` (metinler `consent-copy.ts`).
- Callback yükseltme dalı kod değişiminden SONRA, genel `scope_missing`/`no_refresh_token` denetimlerinden ÖNCE çalışır; bayrak ve yönetici denetimleri kod değişiminden önce yapılır (reddedilen istek kodu kullanmaz). Şunları ister: iki izin birden (`edit_scope_missing`), Search Console izni YOK (`edit_not_available`, hiçbir şey saklanmaz), refresh token, ACTIVE kimlik ve seçili mülk (`edit_connect_first`), AYNI Google hesabı (`googleSub`, yoksa e-posta büyük/küçük harfsiz; karşılaştırılamıyorsa `edit_account_mismatch`). Başarıda yalnız şifreli token değiştirilir, mülk seçimi dokunulmaz, `gaEdit` yazılır, önbellekteki access token'lar unutulur, `integration_credential.edit_access_granted` denetim kaydı yazılır ve `googleEdit=granted` ile dönülür.
- **Hibe saklama:** `IntegrationCredential.metadata.gaEdit = { grantedAt, grantedByUserId }` (`jsonb_set`). Her yazmanın kapısıdır. `markGaEditGranted` ayrıca kimliğin bağlarının `GaChangeWatch.cursorAt` değerini sıfırlar (yeniden verilen izin, düzenleme kapalıyken geçen süre için uyarı üretmez). Mock modda düzenleme izni verilmiş sayılır.
- **`buildGoogleConnectionMetadata` `gaEdit`i siler:** normal yeniden bağlanma ve "Use existing connection" (başka projenin `analytics.edit` taşıyabilen token'ını kopyalar) düzenleme izni OLMADAN başlar. Tasarım gereği; test edilir.
- **Eski refresh token ASLA iptal edilmez.** Google'da iptal kullanıcı+istemci+proje düzeyindedir; yeni token'ı ve aynı hesabın Search Console bağlantısını da öldürürdü.
- **"Turn off editing" ve Disconnect:** Agentelse'in yazmasını HEMEN durdurur, ama izin Google'da kalır; kullanıcı Agentelse'i Google Hesabı ayarlarından (Security, third-party access) kaldırana kadar, özellikle aynı hesapla Search Console bağlıysa. Arayüz, gizlilik sayfası, veri silme sayfası ve bu doküman aynı sözlerle söyler.

## Düzeltme türleri

| Tür                    | API     | Uç                                                                            | Geri okuma                           | Geri alma                                                                          |
| ---------------------- | ------- | ----------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `KEY_EVENT_CREATE`     | v1beta  | `properties/{id}/keyEvents` POST                                              | `listKeyEvents`, olay adı var        | `deleteKeyEvent` (yerleşik `purchase` silinemez)                                   |
| `RETENTION_14M`        | v1beta  | `properties/{id}/dataRetentionSettings` PATCH `updateMask=eventDataRetention` | `getDataRetention` = FOURTEEN_MONTHS | Eski değere döner; kısaltma uyarısı taşır; canlı durum kayıtlı "after" ile aynıysa |
| `ENHANCED_MEASUREMENT` | v1alpha | `properties/{id}/dataStreams/{stream}/enhancedMeasurementSettings` PATCH      | `getEnhancedMeasurement`             | Yalnız değişen anahtarlar eski değerine döner                                      |
| `CHANNEL_GROUP_AI`     | v1alpha | `properties/{id}/channelGroups` POST ("AI assistants")                        | `listChannelGroups`                  | `deleteChannelGroup`                                                               |
| `ANNOTATION_CREATE`    | v1alpha | `properties/{id}/reportingDataAnnotations` POST                               | `listAnnotations`, aynı başlık+gün   | `deleteAnnotation`                                                                 |

- **Enhanced measurement kapsamı:** yama yalnız şu an KAPALI olan öğeleri (`streamEnabled`, `scrollsEnabled`, `outboundClicksEnabled`, `siteSearchEnabled`, `fileDownloadsEnabled`) açar; site araması açılıyorsa ve parametre boşsa `searchQueryParameter` `q,s,search,query,keyword`. `formInteractionsEnabled` ve sahibin bilerek kapalı bıraktığı HİÇBİR öğe değişmez. Beşi zaten açıksa no-op. Onay kartı: "turns on the enhanced-measurement items that are currently off (scrolls, outbound clicks, site search, file downloads); items that are already on and form interactions are not changed".
- **Not (annotation):** başlık "Agentelse: " önekiyle en çok 60 karakter, kontrol karakteri/`<>`/URL temizlenir, gün [bugün-30, bugün+1] aralığında. Manuel not dedupe anahtarı gün+başlık.
- **Key event:** olay adı `^[A-Za-z][A-Za-z0-9_]{0,39}$`; `google_`, `ga_`, `firebase_` önekleri ve `page_view`, `session_start`, `first_visit`, `user_engagement` reddedilir. Mülk başına sınır dolmuşsa `limit_reached` (standart 30, 360 için 50; "doğrulanmalı").
- **Teklif eşlemesi:** MH5 (key event yok / yalnız purchase) → `KEY_EVENT_CREATE` (seçenekler: kanıt önerileri + `generate_lead`, `click_to_call`, `whatsapp_click`, `email_click`, `purchase`, mevcutlar çıkarılır, en çok 6); MH14 (saklama iki ay) → `RETENTION_14M`; MH17 (enhanced kapalı, akış kimliği var) → `ENHANCED_MEASUREMENT`; `CHANNEL_GROUP_AI` bağımsız. **MH9 ve MH10 asla düğme almaz** (Google'da API yok; rehberle kalır, offers testi doğrular).

## Yaşam döngüsü ve motor geçişleri

`GaConfigChange` satırı: PROPOSED → APPROVED → APPLYING → APPLIED → VERIFIED; yan dallar FAILED, UNDOING, UNDONE, REJECTED, EXPIRED. `openKey` (= `dedupeKey`, yalnız PROPOSED/APPROVED/APPLYING/APPLIED iken dolu, aksi hâlde null) ve `@@unique([linkId, openKey])` her (bağ, tür, konu) için tek açık değişikliği garanti eder. Tüm yazmalar beklenen durumla `updateMany` (CAS).

| Olay                                                                                                            | Nereden  | Nereye                                 | Not                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| yazma için talep                                                                                                | APPROVED | APPLYING                               | CAS: kilit ve `nextAttemptAt` boş/geçmiş; `attempts+1`; kilit +2 dk. Kapalı bayrak/tür: satır APPROVED kalır, `skipped` |
| yalnız geri okuma için talep                                                                                    | APPLIED  | APPLIED (kilit)                        | Yazma yok                                                                                                               |
| kapı başarısız (onay APPROVED değil, bağ birincil değil/kimlik uyumsuz/pasif, düzenleme izni yok, mock uyumsuz) | APPLYING | FAILED                                 | Yazıcı ASLA çağrılmaz. Onay kapısı yalnız `status === 'APPROVED'`; `expiresAt`'e bakılmaz                               |
| plan no-op                                                                                                      | APPLYING | VERIFIED (`noop=true`)                 | Yazma yok, geri alma yok                                                                                                |
| plan red `limit_reached`                                                                                        | APPLYING | FAILED                                 |                                                                                                                         |
| yazma döndü                                                                                                     | APPLYING | APPLIED (`appliedAt`, kaynak adı)      |                                                                                                                         |
| geri okuma tamam                                                                                                | APPLIED  | VERIFIED                               | `after`, `verifiedAt`, `openKey` null; Task COMPLETED                                                                   |
| geri okuma uyuşmuyor                                                                                            | APPLIED  | FAILED `readback_mismatch`             | `appliedAt` kalır, `after` null                                                                                         |
| create'te 409                                                                                                   | APPLYING | VERIFIED no-op                         | Yeniden oku + yeniden planla                                                                                            |
| yazma dönmeden yeniden denenebilir hata, deneme < 3                                                             | APPLYING | APPROVED (`nextAttemptAt`)             | Bekleme 2 dk, 10 dk, 30 dk; günlük kota 6 sa                                                                            |
| aynı hata 3. denemede                                                                                           | APPLYING | FAILED                                 |                                                                                                                         |
| geri okuma ÇAĞRISINDA hata                                                                                      | APPLIED  | APPLIED (kilit bırakılır)              | 3 talepten sonra FAILED `google_unavailable` (`appliedAt` kalır); asla ikinci yazma                                     |
| yeniden denenemez hata                                                                                          | APPLYING | FAILED                                 | SCOPE_MISSING ayrıca `gaEdit`i temizler                                                                                 |
| süresi dolmuş kilit (reconcile)                                                                                 | APPLYING | APPROVED (`appliedAt` yoksa) / APPLIED |                                                                                                                         |
| süresi dolmuş kilit (reconcile)                                                                                 | UNDOING  | VERIFIED                               |                                                                                                                         |
| geri alma                                                                                                       | VERIFIED | UNDOING → UNDONE                       | Hatada VERIFIED'a döner, `error.undo=true`                                                                              |
| ret / düzeltme isteği (herhangi yol)                                                                            | PROPOSED | REJECTED                               | `syncApprovalState`; `openKey` null, Task CANCELLED                                                                     |
| onay iptal/süresi dolmuş                                                                                        | PROPOSED | EXPIRED                                |                                                                                                                         |
| öneri `expiresAt`'i geçti                                                                                       | PROPOSED | EXPIRED                                | Onay PENDING → EXPIRED, Task CANCELLED                                                                                  |
| onaylı ama 14 gündür uygulanmadı                                                                                | APPROVED | EXPIRED                                | Task CANCELLED                                                                                                          |

Her terminal geçiş `openKey`'i null yapar. Kullanıcı etiketleri: PROPOSED "Waiting for approval", APPROVED "Approved, applying", APPLYING "Applying", APPLIED "Applied, checking", VERIFIED "Done and checked", FAILED "Didn't work", UNDOING "Undoing", UNDONE "Undone", REJECTED "Rejected", EXPIRED "Expired". No-op'lu VERIFIED panelde "Already there" olur (başarısızlık değil).

## Onay akışı

1. **Öneri** (`GaFixes.propose`): `GaConfigChange` (PROPOSED), yeni yetenek `ANALYTICS_EDIT` ile bir Task ve tip `CRITICAL_CHANGE_APPROVAL` bir Approval (`entityType: 'Task'`, seviye LEVEL_3_CLIENT, 7 gün sonra süresi dolar, `notify: false`). Öneri herhangi bir proje üyesine açıktır; onay, panelden ret, geri alma ve izin verme/kapatma yalnız OWNER/ADMIN'dir. Kartta Google mülk adı YOKTUR ("Your Google Analytics property"); satırlar: What happens, Where, Undo, Expires.
2. **Yetki kapısı:** `ApprovalRepository.decide` içinde SATIR İÇİ arama (tenant-context import'u next-auth'u worker'a çekerdi): `:` içeren kullanıcı kimliği (Telegram sözde kullanıcısı) sorgusuz reddedilir; aksi hâlde `workspaceMember.findUnique` ve rol OWNER/ADMIN. Autonomy-policy yedeği YOK. Kapı onayı, reddi ve düzeltme isteğini (sohbet yolu dahil) kapsar; yalnız sistemin CANCELLED geçişi kapıdan geçmez. Başka onay tiplerinde sorgu çalışmaz.
3. **Dağıtım:** `TaskPlanner.dispatchApprovedTask` `ANALYTICS_EDIT` için araya girer; ExecutionJob, provider ve outbox yoktur. `GaFixes.onTaskApproved` uygulamayı 20 sn bütçeyle yarıştırır (`GA_FIX_INLINE_BUDGET_MS`); bütçe bitince uygulama aynı süreçte sürer, hatalar yutulur (onay zaten verildi), arayüz o sırada "Approved, applying" der. `ga-fixes` tick adımı güvenlik ağıdır (yeniden deneme, çöken kilit, `dispatchApprovedTask`'ı atlayan yollarla verilen onaylar, `syncApprovalState`).
4. **Ret, düzeltme isteği, sohbetten karar:** `syncGaFixApprovalState(changeId)` Approval satırını okur ve değişikliği taşır; `decideGaFixAction` kararın hemen ardından, `propose` (açık satır PROPOSED ise; satır yeni kapandıysa aynı çağrıda yenisi açılabilir), reconcile ve `loadGaFixesView` (PROPOSED satırın gösterilen durumunu Approval'dan türetir, sohbet reddi hemen "Rejected" görünür) çağırır.
5. **Telegram'a HİÇBİR ŞEY gitmez:** istek bildirimi kapalı (`notify:false`); iki dar ortak düzenleme geri kalan sızıntıları kapatır: `notifyApprovalDecision` `CRITICAL_CHANGE_APPROVAL` için hemen döner, `TaskRepository.transition` `ANALYTICS_EDIT` için "Task completed/failed" bildirimini atlar. `no-telegram.test.ts` başka bir yolun bu başlığı taşımadığını izin listesiyle korur (yeni bir Telegram göndericisi eklenirse incelenmeden geçmez). Uygulama içi sohbet/Task olayları kalır.

## Uygulama sırası ve hata kataloğu

Uygulama sırası: CAS kilidi → kapılar (onay APPROVED, bağ birincil, kimlik ACTIVE, düzenleme izni, mock eşleşmesi, bayrak/tür) → CANLI "before" okuma → `planFix` (zaten sağlanmışsa no-op) → yazma → geri okuma → doğrulama. "Before" her zaman uygulama anında yeniden okunur; bu, zaman aşımına uğramış yazmanın yeniden denemesini idempotent yapar. Create çağrıları HTTP çekirdeğinde `retry:false`; PATCH ve DELETE varsayılan tekrarı korur. Zaman aşımına uğrayan ama gerçekleşmiş yazma no-op kaydedilir ve Agentelse'ten geri alınamaz (kabul edilen sınır).

| Kod                  | Kullanıcıya                                                                                     | Not                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| `not_enabled`        | Düzenleme şu an kapalı                                                                          | bayrak/mock uyumsuzluğu                 |
| `no_edit_access`     | Düzenleme izni verilmemiş                                                                       |                                         |
| `scope_missing`      | İzin yetmiyor                                                                                   | `gaEdit` temizlenir                     |
| `reconnect`          | Yeniden bağlan                                                                                  | AUTH                                    |
| `no_property_access` | Mülke yazma yetkisi yok                                                                         | PERMISSION                              |
| `property_changed`   | Mülk/kaynak bulunamadı                                                                          | NOT_FOUND (v1alpha'da `google_changed`) |
| `no_stream`          | Web akışı yok                                                                                   |                                         |
| `limit_reached`      | Mülk sınırı dolu                                                                                | VALIDATION + /limit\|maximum\|exceed/i  |
| `readback_mismatch`  | Google kabul etti ama değer görünmüyor                                                          | `appliedAt` kalır                       |
| `google_unavailable` | Google şu an yanıt vermiyor                                                                     | yeniden denenebilir                     |
| `google_changed`     | Google'ın yanıtı beklenenden farklı                                                             | UNEXPECTED_SHAPE, v1alpha kayması       |
| `rate_limited`       | Kota; sonra denenecek                                                                           |                                         |
| `rejected_by_google` | Google isteği reddetti                                                                          |                                         |
| `cannot_undo`        | "It was changed again since. Change it back in Google Analytics if you still want it reverted." | geri alma ön koşulu                     |
| `approval_missing`   | Onay kaydı yok                                                                                  |                                         |
| `unknown`            | Beklenmeyen hata                                                                                |                                         |

**Mock güvenliği:** süreç mock moddaysa motor `link.isMock` ister, değilse reddeder (öneri `not_allowed_here`, uygulama FAILED `not_enabled`); mock değilse `!link.isMock` ister (`mockMatchesLink`; öneri, uygulama, geri alma ve izlemede test edilir). Paylaşılan DB'deki mock süreç gerçek bağın keyEvents/dataRetention'ını asla ezmez.

## Geri alma

Bilinçli bir OWNER/ADMIN tıklaması (`undoneByUserId` + AuditLog); ikinci onay değildir. Yalnız VERIFIED ve `noop=false` iken, CAS `VERIFIED → UNDOING`; sonra canlı okuma, **ön koşul**, ters yazma, geri okuma ve UNDONE. Yönetici denetimi uygulama motorunda satır içidir (`workspaceMember`, OWNER/ADMIN, `:` içeren kimlik reddedilir; `isWorkspaceManager` next-auth'u worker'a çekeceği için kullanılmaz). Ön koşul: tekil kaynaklarda (saklama, enhanced measurement) canlı durum, değişikliğin dokunduğu alanlar için kayıtlı "after" ile aynı olmalıdır, değilse `cannot_undo` — sonradan elle yapılan değişiklik asla ezilmez. Create türlerinde ad ile silinir; `delete*` sırasında 404 "zaten yok" sayılır ve doğrudan geri okumaya geçilir. Başarısız geri alma VERIFIED'a döner (`error.undo=true`). Saklama geri alması kısaltma uyarısı taşır. Enhanced measurement geri almasında yalnız değişen anahtarlar geri yazılır; eski `searchQueryParameter` boşsa gönderilmez (Google boş değeri reddedebilir).

## Değişiklik geçmişi izleme (`ga-change-watch`)

- `GaChangeWatcher.runDue(3)`: bağ başına günde en çok bir kez (~23 saat), yalnız kimliğinde `gaEdit` olan (ya da mock) bağlar için; `searchChangeHistoryEvents` v1beta, hesap düzeyinde POST. İlk çalışma yalnız imleci "şimdi"ye koyar. `lastRunAt` 3 günden eskiyse ve imleç doluysa imleç sıfırlanır, boşluk için uyarı üretilmez. Pencere `cursorAt-1h .. şimdi`, en çok 5 sayfa × 100; sayfa kalırsa `lastError: 'truncated'` yazılır ve imleç yine ilerler (sınırlı maliyet). Yeniden izin verme de imleci sıfırlar.
- Ayrıştırıcı aktör e-postalarını atar (ve içinde "email" geçen her anahtarı ve e-posta biçimli değerleri `before`/`after`'dan siler); olaylar saklanmaz. Yalnız `actorType: USER`; kendi değişikliklerimiz sayılmaz (kaynak adı eşleşmesi, tekil kaynaklarda ±15 dk).
- Uyarılar: kaynak `GA4`, türler `GA_CHG_KEY_EVENT_REMOVED` (WARN, olay adı ayrıntıda) ve `GA_CHG_RETENTION_SHORTENED` (INFO); 4 parçalı `dedupeKey` (GA-F3'ün 3 parçalı eşlemesini etkilemez); asla CRITICAL (SiteAlerts Telegram'a göndermez). GA-F3 sayaçlarına ve Today GA4 satırlarına girer (zararsız şişme).
- **Çözme algoritması CANLI okumalara dayanır** (eski bağ sütunlarına değil): `listKeyEvents` ve `getDataRetention` yalnız kaldırılan olay/kısaltma varken ya da açık uyarı varken çağrılır; koşul hâlâ geçerliyse uyarı açılır, aynı çalışmada açılan uyarı kapatılmaz.
- Hata eşlemesi `fixErrorFor` ile; `scope_missing` ayrıca `clearGaEditGrant` çağırır. Günlüklerde yalnız hata kodu ve adı; olay adı, aktör ya da ayrıntı yok. Nabız anahtarı `ga.changewatch`.

## Otomatik not önerileri (`ga-annotations`)

`GaAnnotations.runDue(20)` yalnız ÖNERİR (Google'a asla yazmaz); `GA_FIXES_ANNOTATIONS` kapalıyken sorgusuz 0. Her öneri yine Task + Approval'dan geçer; odak ayarı önemli değildir.

- **Başlatma tetikleyicisi:** Meta `AdsLaunch` ACTIVE ve `activatedAt` son 3 gün; kampanya adı `spec.campaignName`, sonra `spec.plan.campaignName`, sonra "ad campaign" (temizlenir, 40 karaktere kırpılır); başlık "Agentelse: <kampanya> launched"; saklanan `dedupeKey` tam olarak `ANNOTATION_CREATE:launch:<launchId>` ve TÜM durumlarda aranır (reddedilen/süresi dolan öneri yeniden önerilmez).
- **Yayın tetikleyicisi** (`GA_FIXES_ANNOTATIONS_PUBLISH`): proje başına haftada en çok bir öneri, "Agentelse: new posts published", `dedupe publish:<ISO hafta>` (mülk saat dilimi), yalnız o hafta COMPLETED bir yayın Task'ı (`ExecutionPolicy.isPublish`, `completedAt`) varsa; gün o haftanın Pazartesi'si.
- Duraklatılmış projeler (`isProjectAgencyActive` false) atlanır; projede zaten 3 not PROPOSED ise yeni öneri yok (incelenmemiş SYSTEM önerileri `countActiveSystemTasks` üzerinden diğer sistem işini aç bırakmasın); tick başına en çok 20 öneri. Yazı başına not bilerek yok (gürültü); yalnız haftalık özet.
- `propose` `dedupeKey`'i `${kind}:${subject}` saklar; `proposeAnnotation({dedupeKey})` ile saklanan anahtar tam `ANNOTATION_CREATE:${dedupeKey}` olur (çağıran öneki kendisi koyar).

## Disconnect, saklama ve Limited Use

- **Saklanan:** önce/sonra anlık görüntüleri ve parametreler yalnız `GaConfigChange`'te; terminal satırlar 24 ay sonra günlük bakım adımıyla silinir (yalnız `gaGlobalWorkAllowedHere()` iken; paylaşılan DB'deki dev süreç çalıştırmaz). Disconnect hepsini hemen siler (bağ cascade: `GaConfigChange`, `GaChangeWatch`).
- **Disconnect temizliği** (`cancelPendingGaFixesForCredential`, `gaFixesEnabled()` ile kapılı): PROPOSED/APPROVED satırlar EXPIRED, bekleyen Approval ve açık Task iptal; Task/Approval/sohbet kartı bağ cascade'iyle gitmediği için, `taskId`'si olan her değişiklik için Task başlığı "Google Analytics change", açıklama null, yük `{}`; eşleşen sohbet kartının (Command satırı; `card.taskId` ya da `card.approvalId` ile bulunur) başlığı ve `details`, `resultText`, `note`, `errorMessage` alanları temizlenir. Hata Disconnect'i durdurmaz. **`GA_FIXES`'i kullandıktan SONRA kapatıp sonra Disconnect edersen Task metinleri (olay adı, kampanya adı) kalır:** önce Disconnect, sonra bayrağı kapat ya da bayrağı açık bırak.
- **AuditLog** veri içermez (`{changeId, kind, source?, code?}`). Operatörler yalnız sayaç görür (`loadGaFixCounters`). Onay kartında mülk adı yok. Telegram'a hiçbir şey gitmez. LLM kullanılmaz.
- Gizlilik sayfası her zaman bu isteğe bağlı izni, 24 aylık saklamayı, günlük değişiklik geçmişi okumasının liste saklamadığını ve izni Google'da kaldırma yolunu anlatır (Google doğrulama inceleyicisi okuyacağı için izin henüz canlı olmasa da).

## Testler

`src/lib/website-analytics/fixes/*.test.ts` (bayraklar, hibe, metinler, katalog, doğrulama, plan, geri okuma, kanal grubu, yaşam döngüsü, teklifler, değişiklik olayları), `google-analytics/admin-write*.test.ts` (sözleşme testleri tam isteklerimizi sabitler; mock mağazası hata ve "okuma yalanı" enjeksiyonu), `google/services|oauth.test.ts`, `security/oauth-state.test.ts`, `api/integrations/google/start|callback/route.test.ts` (yükseltme dalı, `edit_scope_missing` önceliği, "revoke asla çağrılmaz"), `website-analytics/fixes/{propose,approval-hook,apply,undo,reconcile,cleanup,read,counters,change-watch,annotations}.test.ts`, `write-guard.test.ts` (Admin yazıcısına yalnız izinli yerlerden erişilir), `no-telegram.test.ts`, `actions/ga-fix-actions.test.ts`, `components/website-analytics/{fix-it-button,ga-fixes-panel,ga-edit-access-card,ga-fixes-counters-card}.test.ts`, `execution-policy.test.ts`, `commands/task-planner.test.ts`, `repositories/approval.repository.test.ts`, `integrations/google-disconnect.test.ts`, `privacy/page.test.ts`, `data-deletion/page.test.ts`. DB entegrasyon testleri (`edit-grant.integration.test.ts`, `fixes.integration.test.ts`, `change-watch.integration.test.ts`) tek kullanımlık Postgres ister.

## SAHİP ADIMLARI (kod dışı)

1. Google Cloud Console → OAuth consent screen → Data Access: `analytics.edit` kapsamını AYNI projeye ekle ve MEVCUT doğrulama başvurusuna ekle. İkinci doğrulama YOKTUR. Onaylanana kadar yalnız 100 test kullanıcısı bu izni verebilir ve onay ekranı "unverified app" der. `GA_FIXES` üretimde sahip bunu onaylayana kadar KAPALI kalır (GK13).
2. Analytics Admin API zaten etkin; v1alpha aynı API'nin parçasıdır.
3. Bayrakları yukarıdaki sırayla aç; gerçek bir test mülkünde dene.
4. `.env.example`'a dört bayrağı ekle.

## Doğrulanmalı (v1alpha'yı açmadan önce API Explorer'da test mülkünde)

- `channelGroups`: `fieldName` (`eachScopeSource`, `GA_AI_CHANNEL_FIELD`) ve kural biçimi (`PARTIAL_REGEXP`, değer ≤ 800 karakter).
- `reportingDataAnnotations`: başlık sınırı, renk enum'u (`BLUE`), `annotationDate` biçimi.
- `enhancedMeasurementSettings`: alan adları ve `updateMask`.
- `searchChangeHistoryEvents`: yanıt şekilleri (`keyEvents` mı `conversionEvents` mı), `userActorEmail` alanı.
- Mülk başına key event sınırı (standart/360).
- Yalnız `analytics.edit` `searchChangeHistoryEvents` için yeter mi; Editor rolü gerekir mi.

Fixtures ve "doğrulanmalı" notları `admin-write.fixtures.ts`'tedir. Şekil kayması `UNEXPECTED_SHAPE` → `google_changed` olur; `GA_FIXES_ALPHA` kill switch'i onaylı alpha satırlarını bekletir, başarısız yapmaz.

## Açık konular

- Yazı başına yayın notu bilerek yok (yalnız haftalık özet).
- MH9 ve MH10 yalnız rehber (Google'da API yok).
- Onay kartı genel sohbet akışında, bekleyen kararlarda ve panoda da görünür (Telegram'da değil). Onaylayacak OWNER/ADMIN bakmazsa öneri 7 günde sona erer; panel kimin onaylayabileceğini söyler. Sohbetten ret herhangi bir üyeye açıktır (yalnız onay kapılıdır).
- İncelenmemiş SYSTEM önerileri 3 ile sınırlı.
- Tekil kaynak geri almasında ön koşul sıkı olduğu için sonradan yapılan elle değişiklikten sonra geri alma reddedilir; kullanıcı GA'da elle geri çevirir.
- Yeni `CapabilityKey` değeri genel Task listelerinde ve ajans işleyicilerinde (TASK_COMPLETED fan-out) görünebilir; işleyiciler `taskId`/yeteneğe göre arar ve bilinmeyeni yok sayar. Enum değişikliğinden sonra `agency-loop` entegrasyon testlerini koş.

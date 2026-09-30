# Chat motoru (streaming ajan)

Chat iki motordan biriyle çalışır; `CHAT_ENGINE` env'i seçer.

| Değer                 | Motor                                                                                                      | Not                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `legacy` (varsayılan) | `ChatService.turn` (`src/server/commands/chat-service.ts`): tek seferlik JSON sınıflandırma, Server Action | Yeni motor doğrulanana kadar silinmez              |
| `agent`               | `runChatAgent` (`src/server/chat/`): OpenAI Responses API, token akışı, tool çağırma                       | Route: `POST /api/projects/[projectId]/chat` (SSE) |

## Env değişkenleri

| Değişken                | Varsayılan | Açıklama                                                                                                                                                           |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHAT_ENGINE`           | `legacy`   | `agent` \| `legacy`. Geçersiz değer `legacy`'ye düşer.                                                                                                             |
| `CHAT_MODEL`            | boş        | Boşsa `OPENAI_MODEL`. Chat artık `lite` katmanında değil.                                                                                                          |
| `CHAT_REASONING_EFFORT` | `low`      | `minimal` \| `low` \| `medium` \| `high`. Yalnızca `gpt-5*` / `o*` modellerine gönderilir.                                                                         |
| `CHAT_WEB_SEARCH`       | `false`    | OpenAI'ın yerleşik `web_search` tool'unu açar (arama başına ücret).                                                                                                |
| `OPENAI_API_KEY`        | -          | Zorunlu. Eksik/geçersiz/kotası bitmiş anahtar `provider-unconfigured` kartı olarak görünür; gerçek neden sunucu logunda `[chat-agent] blocked (...)` satırındadır. |

## Akış

1. Route: oturum, proje erişimi, kullanıcı başı rate limit (20/dk, süreç içi), dosya doğrulama, dosyaları depoya yazma.
2. `runChatAgent`: **önce** `Command` satırını oluşturur (bağlantı kopsa da mesaj kaybolmaz), `start` olayını yollar.
3. Bağlam: `buildContext` (`src/server/chat/context.ts`: marka, durum, bekleyen onaylar, proje durumu, son 36 satır). Bundan önce `ensureProjectActive` çalışır (aşağıya bak). Geçmiş rol yapılı mesajlara çevrilir; pipeline olayları `developer` mesajı olur. Geçmiş ~100k karakterle sınırlıdır (`trimHistory`); son 2 turdaki görsel/PDF ekleri modele gerçekten yeniden verilir (`history-files.ts`).
4. Döngü (sıradan mesajda en çok 6 tur, work session'lı mesajda 24): model metin akıtır, gerekirse tool çağırır, sonuç modele döner. Bir mesajın ne yapabileceğini `run-guard.ts` belirler.
5. Sonunda cevap ve varsa kart aynı `Command` satırına yazılır; kullanım `ReasoningCall` (`purpose: chat.turn`) ve bütçe sayaçlarına işlenir.

## İlk marka taraması (Quick Discovery)

Marka Çekirdeği (aktif `BrandConstitution`) olmayan bir projede **ilk sohbet turu**, cevaptan önce markayı tanır (`src/server/brand/quick-discovery.ts`). Uzun bir onboarding yoktur; müşteri ilk mesajını yazar, arada canlı bir "Getting to know your brand…" göstergesi görür.

1. `QuickDiscoveryService.claim`: yalnızca gerçek modda (mock'ta asla), `ACTIVE` bir projede, aktif constitution yokken ve son 10 dakikada başlamış bir tarama yokken çalışır. `brand.quick_discovery.started` audit kaydı hem tekrarı hem de art arda başarısız denemeleri engeller.
2. Site: `safeFetch` (SSRF korumalı) ile ana sayfa ve en çok 2 ilgili sayfa (hakkımızda, ürünler/hizmetler, fiyat) okunur; metin `htmlToText` ile çıkarılır. Her sayfa `Evidence` olarak saklanır (`sourceUrl`, `contentHash`, `accessedAt`); 7 günden yeni okunmuş sayfa yeniden indirilmez.
3. Tek yapılandırılmış model çağrısı (`quickDiscoveryDef`, OpenAI'ın barındırılan `web_search` aracıyla) `ConstitutionOutput` şeklinde çıktı verir. Çağrı `ReasoningService` üzerinden gider: bütçe kapısı, `ReasoningCall`, audit ve arama ücreti maliyete girer.
4. Sonuç `ConstitutionService.publishVersion` ile **v1** olarak aktifleşir; `BrandDossier`'in yalnızca **boş** sütunları doldurulur (müşterinin yazdığına dokunulmaz).
5. Cevap en çok 75 saniye beklenir. Süre dolarsa tur taramasız devam eder, tarama arka planda biter ve marka sonraki turda bilinir. Model, tur bağlamında taramanın bitip bitmediğini ("ilk taslak" / "bitmedi, marka hakkında az şey biliyorsun") öğrenir.

Güvenlik kuralları: sayfa metni ve arama sonuçları **güvenilmeyen veri** olarak verilir; `approvedClaims` her zaman boştur (müşteri onaylamadan hiçbir iddia "onaylı" olmaz); kaynaksız "kesin bilgi" yazılmaz (`knownFacts` kaynak URL taşır, çıkarımlar `assumptions`'a gider). 12 aşamalı derin kurulum sonradan v2'yi bunun üzerine yazar.

Yalnızca agent motorunda çalışır (`CHAT_ENGINE=agent`); legacy motor kendi intake akışını sürdürür.

## SSE olayları

`start` · `text.delta` · `tool.start` · `tool.end` · `card` · `suggestions` · `done` · `error`

İçerik paketi koşusu (`POST …/chat/package`) aynı formatı kullanır, ek olarak: `item.start` · `item.partial` · `item.done` · `package.done` (bkz. "İçerik paketi").

Tanım: `src/server/chat/types.ts`, kodlama/çözme: `sse.ts`. Sunucu her 10 sn'de `: ping` yorumu yollar (proxy zaman aşımına karşı).

## Tool'lar

| Tür      | Tool                                                                                                                  | Not                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| iş       | `create_task`, `generate_image`, `start_strategic_project`\*, `generate_ideas_from_opportunities`, `decide_approval`, `start_deep_enrichment` | Sıradan mesajda **en fazla biri** çalışır, work session'da en çok 6 (bkz. "Work Session"); hepsi mevcut servisleri (`CommandService.submit` vb.) sarar |
| terminal | `ask_user`, `start_plan_brief`                                                                                        | Turu soru kartıyla / plan sihirbazıyla bitirir                                                    |
| not      | `remember_preference`, `start_work_session`, `update_work_session`, `save_idea`, `suggest_replies`, `propose_content_package` | İş sayılmaz (paket yalnızca kart üretir)                                                          |
| okuma    | `get_pending_approvals`, `get_recent_tasks`, `get_idea_status`, `get_brand_profile`                                   | Sınırsız; hep turun kendi `projectId`'siyle sorgular                                              |

Kurulum artık ön koşul değil: proje ilk mesajda ya da komutta kendiliğinden `ACTIVE` olur (`src/server/projects/activation.ts`, `ensureProjectActive`). Durum makinesi `CREATED → ACTIVE` geçişine izin vermediği için yasal yolu (`DISCOVERY → PROFILE_REVIEW → ACTIVE`) adım adım yürütür; `PAUSED` ve `CLOSED` kullanıcı kararıdır, asla geri alınmaz.

Tool kısıtı koddadır (`tools.ts`, `phases`) ve iki durumludur: `ACTIVE` hepsi, `ON_HOLD` (duraklatılmış/kapalı proje) yalnızca soru/tercih/okuma. `CommandService`'in `PROJECT_INACTIVE` kapısı yedek olarak durur. Eski onboarding aracı (`start_brand_setup`) kaldırıldı; yerine isteğe bağlı **derin marka araştırması** (`start_deep_enrichment`) geldi.

\* `start_strategic_project` yalnızca `LEGACY_AGENCY_LOOP=on` iken sunulur (planlayan Director artık çalışmıyorsa ajan geniş işi kendisi somut çıktılara böler). `save_idea` her modda vardır.

### Girdisi eksik iş açılmaz (yeni hesap: platform)

`SOCIAL_ACCOUNT_SETUP` dar bir şeydir: bir tarayıcı ajanı **yeni** bir Instagram / TikTok / LinkedIn hesabı açar (yüksek risk, müşteri onayı). Platform olmadan çalışamaz ve yalnızca standart tarayıcı profil paketinde profili olan platformlarda çalışabilir (X'in profili hiç oluşmaz, bu yüzden düğme olarak sunulmaz; liste `capability-input.ts`'te derleme zamanında pakete bağlıdır); eskiden görev ve onay kartı yine de oluşuyor, hata ancak müşteri Approve'a bastıktan sonra çıkıyordu (onay tüketilmiş, görev `FAILED`, kart ölü düğmelerle kalıyordu). Şimdi kural tek yerde (`src/server/execution/capability-input.ts`, saf) ve hem görev **açılmadan önce** hem onay **verilmeden önce** uygulanır:

- `create_task`: platform yoksa (ya da hesap açılamayan bir platformsa: Facebook, YouTube, Pinterest, X) görev açmaz; 3 platform düğmeli bir soru kartı gösterir (`platform_question_shown`). Cevap sıradan bir mesajdır, ajan aynı araçla platformu vererek yeniden çağırır.
- `CommandService.submit` (legacy sınıflandırıcı, composer kısayolu, hızlı eylemler): `NEEDS_INPUT` döner, hiçbir Task/Approval oluşmaz. Legacy sohbet ve "+" menüsü kısayolu aynı soruyu düğmeyle sorar (`src/server/commands/needs-input.ts`).
- Onay: `applyApprovalDecision` (web ve Telegram) ve sohbette "onayla" (`CommandService`), görevi **onay tüketilmeden önce** kontrol eder. Çalışamayacak görev onaylanmaz, onay `PENDING` kalır ve Reject hâlâ çalışır (bu, veritabanında zaten bekleyen eski onayları da kurtarır). Hata kodu `INVALID_INPUT`; mesaj müşteriye eyleme dönük söylenir, Telegram aynı metni gösterir.
- Router (`CapabilityRouter.resolveBrowserProfile`) aynı kuralı kullanır; buraya ulaşan bir görev, kapılardan birinin atlandığını gösterir.
- Onay kartı artık ne olacağını söyler: "Platform", "What happens" satırları (`buildApprovalDetails`).
- `create_task` açıklaması bu yeteneğin ne olduğunu ve **planlama / yönetim için olmadığını** söyler. "Sosyal medya yönetimini planla" gibi istekler artık bir hesap-açma görevi değil, içerik planı ya da soru olmalı.

Aynı sınıftan bilinen açık: `INSTAGRAM/TIKTOK/LINKEDIN/X_PUBLISH` yetenekleri `create_task`'tan serbest metinle açılabiliyor ve bağlı hesapta `imageUrl` / `videoUrl` / `caption` eksikliğiyle başarısız oluyor. Sahip kararı bekliyor (menüden çıkarmak ya da "yayın bitmiş bir creative kartından" demek).

## Bağlam ve hafıza: Brand Core, Brand Memory, Current Context

Ajanın her turdaki bağlamı üç ayrı katmandan kurulur (`src/server/chat/context.ts`). Tüm sohbet geçmişi ve tüm saklı tercihler artık her tur modele gönderilmez.

| Katman | Ne | Kaynak | Bağlamda |
| --- | --- | --- | --- |
| **Brand Core** | Markanın kim olduğu: kimlik, konumlandırma, kitle, ses, yasaklı iddialar, görsel kimlik, odak hedef | Versiyonlu `BrandConstitution` + `BrandDossier` + `BrandVisualIdentity` (`getBrandTwin`, `brandCoreOf`) | Her tur (hafıza alanları çıkarılmış) |
| **Brand Memory** | Müşterinin söyledikleri ve geçmiş işlerin nasıl karşılandığı | `BrandLearning` (+ eski `UserDecision`) | Yalnızca **o mesajla ilgili olanlar** |
| **Current Context** | Tarih, bekleyen onaylar, ajans durumu, son görev sonuçları (son 3), son mesajlar | `Command` satırları, `Approval`, günlük sayaçlar | Her tur |

**Tek sürüm politikası.** Çekirdek her yerde `ACTIVE` constitution'dan okunur (`getBrandTwin` önceden "durumu ne olursa olsun en yenisini" okuyordu; sohbet ile fikir/konsey hattı aynı markayı farklı sürümlerden görebiliyordu). `ACTIVE` yoksa en yeni taslağa düşer.

### Brand Memory (`src/server/memory/`)

Tek yazıcı `MemoryService.remember`, tek okuyucu `MemoryService.recall`. Her hafıza kaynağını ve güvenini taşır; alan yapısı `BrandLearning`'dedir (yeni tablo/migration yok).

| Kaynak (`sourceType`) | Başlangıç güveni | Ne zaman yazılır |
| --- | --- | --- |
| `USER_EXPLICIT` | 0,95 | Müşteri kalıcı bir tercihi/kuralı kendi sözleriyle söyledi (`remember_preference`) |
| `USER_CORRECTION` | 0,60 | Müşteri bir creative için değişiklik istedi (revize notu) |
| `OUTPUT_ACCEPTED` / `OUTPUT_REJECTED` | 0,50 | Müşteri bir creative'i onayladı / reddetti (web, Telegram, sohbet) |
| `AI_INFERRED` | 0,30 | Model çıkarımı (şimdilik yazan yok; kural hazır) |

Kurallar:

- **Aynı hafıza bir kez saklanır.** Yeniden görülünce `evidenceCount` artar, güven yalnızca yükselir, daha güçlü kaynak etiketi devralır, zayıf olan asla düşürmez.
- **"Kesin" = müşteri söyledi, ya da bağımsız sinyalle en az 3 kez görüldü.** Tek bir onay/red/revize bir *ipucudur*, kural değil. **AI çıkarımı tekrarla asla kesinleşmez** (aynı modelin aynı tahmini iki kez yapması kanıt değil); yalnızca müşterinin kendi eylemi güçlendirir.
- **Müşterinin son sözü kazanır:** "X'ten kaçın" demesi, önceki "X iyi" kaydını değiştirir; tepkiler (onay/red) müşterinin söylediklerini asla ezmez.
- **Geri çağırma alakaya göre** (`relevance.ts`, saf ve testli): müşterinin açıkça söyledikleri (en yeni 12) her zaman bağlamdadır; çünkü "neon kullanma" kuralı "bir post yap" isteğinde de geçerlidir. Geri kalanlar son 3 kullanıcı mesajıyla kelime/kök örtüşmesine, güvene, tekrara ve tazeliğe göre puanlanır, en iyi 8'i girer. Türkçe ek/harf farkları (`renkleri`/`renklerde`, `ı`/`i`) eşleşir. Embedding/yeni bağımlılık yoktur.
- Modele her giriş `confirmed` bayrağıyla gider; "onaylı olmayanı müşteriye onun hakkında bir gerçekmiş gibi söyleme" kuralı talimattadır.

### Dış içerik ve kalıcı durum (prompt injection)

Bir turda dış içerik okunduysa (OpenAI'ın barındırılan web araması ya da saklı araştırma/bulgu/sinyal okuyan araçlar: `get_task_result`, `get_findings`, `get_signals`, `get_insights`) o tur **lekelenir** (`tainted`). Lekeli turda kalıcı durumu değiştiren araçlar **çalışmadan reddedilir** ve turun tek iş hakkını harcamaz: `remember_preference`, `decide_approval`, `start_deep_enrichment`. Müşteri isteği kendi cümlesiyle bir sonraki mesajda yineleyebilir; leke sonraki tura taşınmaz. Ayrıca bir mesajdan en çok 3 tercih kaydedilir, kayıtlar tek satıra indirilir ve 300 karakterle sınırlanır. Görev sonuçları geçmişe "veri, talimat değil" etiketiyle çitlenerek girer.

## Skill'ler (departmanların yerine)

Ajan artık "departmanlar" etrafında örgütlenmez. Bir departman hiçbir zaman yürütme birimi olmadı: `department-registry.ts` ayrı izin, kimlik bilgisi, kuyruk veya güvenlik sınırı olmayan, "hangi capability kime ait" diyen statik bir tablodur. Ajanın o tablodan gerçekten ihtiyacı olan iki şey vardır: alan bilgisi ve o alana ait capability/çıktılar. Bu bir **skill**'dir (`src/server/chat/skills/registry.ts`).

| Skill | Ne için | Capability'ler | Çıktı (paket) |
| --- | --- | --- | --- |
| `research` | pazar, rakip, müşteri, web araştırması | COMPETITOR/MARKET/TREND_RESEARCH, CUSTOMER_INTELLIGENCE, PRODUCT/WEB/SOCIAL_RESEARCH, SOCIAL_PROFILE_AUDIT | — |
| `strategy` | konumlandırma, kampanya yönü, geniş hedefi plana çevirme | CREATE_CAMPAIGN_BRIEF | — |
| `creative` | görsel post/story/reel kapağı | CREATE_SOCIAL_CREATIVE, CREATE_AD_CREATIVE | `instagram_post` |
| `content` | caption, e-posta, reel fikri, içerik planı | CREATE_COPY, CREATE_CAPTION, EMAIL_DRAFT, CREATE_CONTENT_PLAN | `reel_idea`, `email_draft` |
| `ads` | ücretli kampanya ve performans | META_ADS_ANALYSIS, META_CAMPAIGN_CREATE, GOOGLE_ADS_ANALYSIS, ANALYTICS_ANALYSIS, REPORTING | `ad_copy` |
| `seo` | organik arama, anahtar kelime, makale | SEO_RESEARCH, SEO_ANALYSIS | `seo_article` |

Yayın (`*_PUBLISH`) ve hesap kurulumu (`SOCIAL_ACCOUNT_SETUP`) bir skill'e bağlı değildir; onay akışı ve kanal bağlantıları üzerinden yürür.

- **Alt-ajan yok, devir yok.** Tek ajan, tek döngü. Skill, ajanın `load_skill` aracıyla yüklediği talimat metnidir (adımlar, hangi araç/capability, dürüstlük kuralları). Standart talimatta yalnızca tek satırlık katalog durur; ayrıntı, ajan o alanda gerçek iş yapacağı zaman yüklenir (konuşma başına bir kez; basit sorularda yüklenmez). Bir skill hiçbir zaman sert kuralların üzerine çıkamaz.
- `skills.test.ts` kaydı üç şeye karşı sabitler: departman tablosu (her capability bir departmana ait olmalı), sohbet capability listesi (yeni bir capability skill'siz eklenirse test kırılır) ve gerçek araç adları (talimatlarda anılan her araç var olmalı, kaldırılmış olan anılmamalı).
- `department-registry` ve `Task.departmentKey` **silinmedi**: Work paneli, Departments paneli ve içerik paketi kartları hâlâ okuyor. Mod ayarı (`ProjectDepartment.mode`) yürütmeyi etkilemez; UI kararı bekliyor.

## Derin marka araştırması (Deep Brand Enrichment)

Müşteri yalnızca kapsamlı bir marka/rakip/pazar analizi isterse ve açıkça onaylarsa başlar; ilk bakış (Quick Discovery) zaten otomatik yapıldığı için marka yeni diye başlatılmaz. Arka planda uzun sürer, araştırma bütçesi harcar ve **hiçbir işi bloklamaz**. Proje başına bir kez çalışır (tekrar istenirse ajan çalıştığını/bittiğini söyler).

`SetupIntake.mode = "ENRICHMENT"` ile mevcut 12 aşamalı makine kullanılır ama yalnızca eski ajans hattına hizmet eden aşamalar `SKIPPED` olur (`ENRICHMENT_SKIPPED_STAGES`, `setup-stages.ts`):

| Çalışır | Atlanır |
| --- | --- |
| INTAKE, DEEP_DISCOVERY, BRAND_CONSTITUTION, SIGNAL_PROFILE, GOAL_GENERATION, PROJECT_ACTIVATION | BASELINE_AUDITS, AGENCY_CONFIGURATION, AUTONOMY_CONFIGURATION, INITIAL_OPPORTUNITIES, INITIAL_IDEA_PORTFOLIO, INITIAL_WORK_PLAN |

Önemli davranışlar:

- Derin sentez, Quick Discovery'nin yazdığı v1 taslağını **başlangıç noktası** olarak görür (`previousConstitution`); araştırma zayıf kalsa bile ilk bakışın kurduğu bilgi silinmez.
- Brand Brain'e yansıtma **merge-aware**dır: yalnızca önceki yansıtmanın yazdığı ve kimsenin dokunmadığı satırlar yenilenir (onaylı iddia, CONFIRMED/REJECTED varsayım, elle eklenen kural/olgu korunur).
- Deep Discovery'de tüm görevler başarısız olursa aşama artık sonsuza dek RUNNING kalmaz: `FAILED` olur (otomatik en çok 5 deneme, sonra manuel yeniden deneme). Bir görev takılırsa ve en az biri tamamlandıysa 30 dakika sonra eldeki veriyle devam edilir (`discoveryVerdict`).
- Hedefler, müşteri "otomatik onayla" demedikçe onayını bekler (`WAITING_CLIENT`); ilerleme mevcut kurulum paneli/widget'ında görünür.

Kurulumu atlayan bir projede ilk tarayıcı gerektiren görev (`CapabilityRouter.resolveBrowserProfile`) standart `BrowserProfile` paketini ve projenin OpenClaw ajanını tembel olarak oluşturur (`src/server/projects/browser-profiles.ts`); profil olmadan OpenClaw kamuya açık araştırmayı hiç çalıştıramaz.

## Work Session (çok adımlı iş)

Sıradan bir mesaj tek iş yapar; yinelenen görev çıkmasın diye bu kuraldır. Müşteri birbirine bağlı **üç ya da daha fazla adımlı bir sonuç** istediğinde ("rakipleri araştır, üç konsept yaz, en iyisinin görselini hazırla") ajan önce `start_work_session` ile bir plan açar, sonra adımları **aynı mesajda, sırayla** yürütür ve her adımı `update_work_session` ile işaretler. Oturumun kendi kuyruğu, worker'ı ya da `Task`'ı yoktur: adımlar olağan tool'lardır (`create_task`, `generate_image`…). Bu yüzden onay kapıları, proje durumu kapısı ve maliyet sayaçları aynen geçerlidir ve eski ajans döngüsüne (`LEGACY_AGENCY_LOOP`) hiçbir bağımlılık yoktur.

**Durum nerede.** Bir `Command` satırında: `topic: "WORK_SESSION"`, `source: SYSTEM`, `parsedIntent.workSession` bir kontrol noktasıdır (hedef, adımlar, her adımın durumu / tek satır notu / `task` ve `idea` kimlikleri, toplam harcama, mesaj sayısı). Yeni tablo ya da migration yok. Sohbet akışı ve geçmişi yalnızca `topic: null` satırları okuduğu için bu satır mesaj olarak görünmez. Yazımlar, okunan sürümü (`rev`) koşul yapar; iki sekme aynı oturumu aynı anda güncellerse kaybeden taze durumun üstüne yeniden uygular.

Kod: `src/server/work-session/session.ts` (saf kurallar), `work-session-service.ts` (saklama), `src/server/chat/work-session-tools.ts` (iki tool), `src/server/chat/run-guard.ts` (mesaj başına sınırlar).

| Sınır | Sıradan mesaj | Work session'lı mesaj |
| --- | --- | --- |
| Model turu | 6 | 24 |
| İş eylemi | 1 | 6 |
| Bir mesajın model maliyeti | sınırsız (günlük bütçe geçerli) | 1,50 $ |
| Oturumun toplam maliyeti | - | 5 $; dolunca oturum kapanır (`endReason: "budget"`) |
| Bir mesajın süresi | - | 10 dk |
| Modele giden girdi | - | 150k token |
| Adım sayısı | - | başlangıçta 2-8, toplamda 12 |
| Boşta kalma | - | 48 saat dokunulmayan oturum "canlı" sayılmaz |

Kurallar (hepsi kodda ve testlidir, talimata güvenilmez):

- **Bir projede tek canlı oturum.** Yenisi, açık olan bitmeden ya da iptal edilmeden açılmaz.
- **Aynı eylem bir mesajda iki kez çalışmaz** (aynı tool + aynı argümanlar, anahtar sırasından bağımsız). Mesajın iş limiti (6) dolarsa model bilgilendirilir; kalanı için müşteri "devam" der.
- **Kararı ajan kendi işinin yan etkisi olarak veremez.** `decide_approval` ve `start_deep_enrichment` (`decisive`), oturumlu mesajda yalnızca mesajın **ilk** eylemi olabilir: müşteri bir onaya cevap verdiyse önce o kaydedilir, sonra iş sürer.
- **Yayın ve harcama oturum dışıyla aynıdır.** `create_task` → `ApprovalPolicy` (L3/L4) → müşteri onayı. Ajan görevi açar, bekleyeceğini söyler ve adımı `BLOCKED` işaretler.
- **Dış içerik.** `start_work_session` "hassas"tır: web araması ya da saklı araştırma okunduktan sonra reddedilir, yani plan önce açılır, araştırma sonra yapılır. `update_work_session` böyle bir mesajda yalnızca durum ve kimlik yazar; `note`, etiket, yeni adım ve iptal nedeni düşürülür (sonuç bunu modele söyler). Kaydedilen notlar sonraki mesajda modele "kendi kaydın, müşteri talimatı değil" çerçevesiyle JSON olarak verilir; tek satıra indirilir, 300 karakterle sınırlanır.
- **Limit dolarsa** yanıtın sonuna standart bir not eklenir ("devam de, kaldığım yerden süreyim"; bütçe bittiyse "yeni oturum başlatırım"). Kayıt korunur. Her ek tur günlük `reasoningCalls` sayacına da yazılır; günlük limit dolarsa hata kartı değil aynı türden bir not görünür. Sıradan mesajın 6 tur sınırı eskisi gibi sessizdir.
- **Stop / bağlantı kopması** kaydı bozmaz; sonraki mesaj bağlamda açık oturumu görür ve ilk bitmemiş adımdan sürer. Müşteri "durdur" derse ajan `update_work_session` ile `cancel: true` yollar.
- Mesajın harcaması (mock'ta 0) mesaj hangi yolla bitmiş olursa olsun oturuma yazılır.

**Görünürlük.** Arayüzde ayrı bir oturum kartı yoktur (UI değişmedi): ilerleme ajanın kendi anlatımı ve canlı tool göstergeleri ("Planning the work…", "Updating progress…") ile görünür. Bir oturum kartı ya da iptal düğmesi ileride bir UI kararıdır.

**Yapılmayan (F7b).** Onay ya da zamanlayıcı bekleyen oturumu arka plandan uyandıran bir tick adımı yoktur; oturum müşterinin sonraki mesajıyla sürer. Gerçek ihtiyaç görülürse ve bunun için tablo gerekirse ayrıca sorulur.

## İçerik planlama (sohbet içinde)

"Haftayı planla" gibi istekler görev olarak kuyruğa alınmaz (`create_task` artık `CREATE_CONTENT_PLAN` sunmaz; eski shortlist tabanlı planlayıcı yalnızca cron'da). Model müşteriyi sohbetle sorgulamaz; belirsizliği **sihirbaz** giderir. Akış:

1. Müşteri plan ister ama amaç, kanal ve adedi vermemişse model `start_plan_brief` çağırır: `plan-brief` kartı (`plan-brief-wizard.tsx`) açılır. Adımlar: **Amaç** (awareness / leads / sales / engagement / traffic) → **Mecralar** (Instagram, TikTok, LinkedIn, X, Blog/SEO, Ads; her birinin bağlantı durumu görünür, bağlı sosyal hesaplar önceden seçilir) → **Format** (yalnızca seçilen kanalda birden fazla format varsa) → **Tempo** (haftalık adet, süre, başlangıç, opsiyonel tema).
2. Cevap tek sohbet mesajı olarak gider (`serializePlanBrief`, `src/lib/plan-brief.ts`): okunur bir cümle + makine satırı `[Plan brief] goal=…; channels=instagram:carousel+reel,seo:article; perWeek=…; weeks=…; start=…`. Balonda makine satırı gizlenir (`stripPlanBriefMarker`). Kart mesajı, composer'ın kullandığı aynı yoldan gönderir (`chat-send-context.tsx`; agent motorunda SSE).
3. `propose_content_plan` tek çağrıda tüm planı verir: `goal`, ve her öğede gerçek tarih (`YYYY-MM-DD`, bugünden itibaren, en çok 60 gün), saat (varsayılan 10:00), `channel` + `formatKey` (`src/lib/content-channels.ts` kataloğu), konu, caption fikri; en çok 30 öğe. Ek model çağrısı yoktur. Sunucu tarihleri proje saat diliminde, kanal/format uyumunu ve mesajdaki brief'e uyumu (`validatePlanAgainstBrief`: yalnız seçilen kanal ve formatlar, en çok `perWeek × weeks` öğe, başlangıçtan önce değil, her kanal kapsanır) doğrular; hata modele geri döner. Eski `platform` + serbest metin `format` hâlâ kabul edilir ve kataloğa çevrilir.
4. Plan sohbette `content-plan-draft` kartı olur (`content-plan-card.tsx`): kanal chip'leri (bağlantı noktası, bağlı değilse "Connect" linki) + **Week | List** sekmeleri; henüz kaydedilmemiştir. Kanal bağlantısı plan çizildiği andaki anlık görüntüdür (`getChannelConnections`). Değişiklik istenirse model planın tamamını yeniden önerir; eski açık taslaklar `superseded` olur.
5. **Save to calendar** `saveContentPlanAction`: her öğeyi `Creative` `DRAFT` olarak yazar (`channel`, `formatKey`, `goal`, `planId` = planı çizen Command; SEO → `COPY`, reklam → `CAMPAIGN_BRIEF`, sosyal → `SOCIAL_POST`). **Görsel üretilmez.** Serializable transaction, çift tıklama çift kayıt üretmez.

Yayın modu formata bağlıdır (katalogda `publish`): `auto` (bağlı hesap API'siyle: Instagram post/story, LinkedIn, X), `manual` (carousel, reel, TikTok, thread, blog makalesi: müşteri yayınlar), `approval` (reklam: harcama, hep onaya düşer, otomatik yayınlanmaz). Bağlı olmayan kanalın `auto` formatı kartta `manual` görünür.

Takvim (`/projects/[id]/takvim`) kanal rozetini ve `?channel=` filtresini gösterir.

## Sohbet içinde görsel üretimi

`generate_image` görseli worker kuyruğunu beklemeden, sohbet turunun içinde üretir. Eski hat (Task → ExecutionJob → provider → Asset/Creative/onay/kart) aynen kullanılır; değişen üç şey vardır:

1. **Hemen başlar.** Tool görevi planlar, sonra `driveJobInline` (`src/server/chat/inline-job.ts`) ile işi kendisi sürer (worker'ın 10 sn'lik tick'ini beklemez). Önce işin outbox `execution.dispatch` olayını alır (`OutboxRepository.claimDispatchForInline`, PENDING → PROCESSED): olay PENDING kalsaydı worker, OpenAI provider'ları üretimin tamamını `execute()` içinde yaptığı için referanssız RUNNING görünen işi "takılmış" sayıp sıfırlar ve **ikinci kez üretirdi** (çift harcama). Sonra `startExecution` işi CAS ile sahiplenir. Olayı worker zaten almışsa iş ona bırakılır, tool yalnızca tamamlanmasını bekler.
2. **Metin LLM'i atlanır.** `imagePrompt`, `caption` ve `copy`'yi sohbet modeli yazar (marka bağlamı zaten onda) ve payload'da `preset` olarak provider'a gider. Worker yolunda (`preset` yok) provider eskisi gibi kendi LLM çağrısını yapar.
3. **Önizleme akar.** Bir izleyici varken (`creative-progress.ts`) `gpt-image-2` `stream: true, partial_images: 2` ile çağrılır; ara görüntüler `image.partial` SSE olayı olarak gelir, bitince mevcut `creative-ready` kartı düşer. Akış başarısız olursa tek istekli yola düşülür. Referans/base görselli (edit) render'lar akıtılmaz. İzleyici varken Gemini katmanı da atlanır.

**Tasarımı ne belirler:** kod hiçbir sahne, renk veya stil dayatmaz. Tasarım (1) markanın Visual Identity'sinden (ana/ikincil/vurgu renkleri, fotoğraf stili, mood, kompozisyon notları, her zaman ekle/kaçın, stil referans görseli) ve (2) sohbette müşterinin seçtiklerinden gelir. Model önce `get_visual_identity` ile kimliği okur; brief tasarımı açık bırakıyorsa (ne söylesin, görünüm, görselde yazı olsun mu, format) tek bir `ask_user` turuyla, seçenekleri o markanın kimliğinden türeterek sorar; brief netse doğrudan üretir. Logo ve renk şeridi yapay zekâya çizdirilmez: `applyBrandTemplate` markanın ayarladığı konumda piksel-hassas ekler. Görselde yazı yalnızca müşteri isterse (`headline`, isteğe bağlı `highlight`) çizilir; logo köşesi ve renk şeridi alanı yazıdan boş bırakılır. Aksi halde görsel yazısız kalır.

**Post layout'ları:** marka Brand sekmesinde layout kaydettiyse `get_visual_identity` bunları (`layouts`: id, ad, uygun formatlar, başlık var mı) döner ve `generate_image` isteğe bağlı `layoutId` alır. Model belirgin olanı kendisi seçer (yazı isteniyorsa başlıklı bir layout), birden çoğu uyuyorsa tek `ask_user` turunda seçenek olarak sorabilir; `layoutId` yoksa formata uygun olan/varsayılan uygulanır. Tool sonucu **gerçekten kullanılan** layout'u (işin `rawResult`'ından okunur) modele bildirir; bilinmeyen id sessizce varsayılana düşmez, model bunu müşteriye söyler. Ayrıntı: [brand-kit.md](./brand-kit.md).

Kalite: sohbette varsayılan `draft` = `medium`; kullanıcı açıkça yayına hazır/en yüksek kalite isterse `final` = `high`. Varolan bir görselin yüksek kaliteli sürümü ayrı bir üretimdir (yeni creative), mevcut olanı yerinde değiştirmez.

## İçerik paketi (konu → paket → canlı üretim)

Müşteri çıktı türü söylemeden bir konu/hedef yazınca ("Kommo CRM sağlık turizmi") model soru sormaz: bağlamındaki **ajans yetenekleri** (aktif departmanlar, üretebildikleri çıktılar, bağlı kanallar; `deliverables.ts` kataloğu + `agency-focus.ts`) ile aynı yanıtta `propose_content_package` çağırır. Sonuç `content-package` kartıdır: 1-5 parça (Instagram post, SEO yazısı, Reel fikri, reklam metni, e-posta), her biri departman rozeti, başlık ve markaya/konuya özel tek cümlelik açıyla. Görsel parçada format (Post 3:4 / Story / Reel / Kare) kartta seçilir. Sunucu pasif departman çıktısını ve formatsız görseli reddeder (hata modele döner); yeni öneri eski açık paketleri `superseded` yapar.

**"Create selected (n)" işi hemen ve sohbette başlatır.** Kart seçilenleri sohbete verir (`chat-package-context.tsx`); sohbet her parça için anında kendi assistant mesajını açar (kullanıcı balonu yok) ve `POST /api/projects/[id]/chat/package` (SSE) akışını okur:

1. Sunucu (`content-package-run.ts`) kartı Serializable transaction'da `draft → started` yapar (çift tıklama çift iş üretmez; yarışı kaybeden P2034 alırsa "already being started" der), sonra seçilen parçaları **aynı anda** çalıştırır. Her parça bölümünün görevidir (`TaskPlanner.planForCapability`, `commandId` = paketin Command satırı) ve `generate_image` gibi `driveJobInline` ile sürülür (dispatch olayını önce alır; worker aynı işi çift çalıştıramaz). Görsel parçalar `generate_image` gibi taslak (`medium`) kalitede çizilir; art arda yüksek kaliteli render'lar görsel çağrısının zaman sınırına dayanır. İş bitince kartın `startedCount`/`startedItemIds` alanları yalnızca gerçekten görevi açılanları listeler.
2. Olaylar parça kimliğiyle etiketlidir: `item.start` (görev var; metin parçası "running" kartına döner), `item.partial` (görsel önizleme, `gpt-image-2` akışı, `creative-progress.ts`), `item.done` (son kart + kalıcı sohbet satırının id'si), `package.done`. Bir parçanın hatası ötekileri durdurmaz; tanınan bütçe/kota hataları `limit-notice` kartı olur. Hiçbir görev açılamazsa kart yeniden `draft` olur.
3. Kalıcılık: yürütme hattı zaten her görev için tek bir SYSTEM satırı yazar ("loading/running" → yerinde "creative-ready / task-result / failed"). Sohbet sayfası paketin görevlerinin satırlarını da yükler (`page.tsx`, `PACKAGE_ROW_KINDS`; creative-ready de dahil, genel creative sorgusunun 40 satır sınırına takılmasın diye); yenilemeden sonra yerel mesaj, görevinin satırı **final** olunca düşer (`package-run.ts`), o zamana dek satırın "running" hali gizlenir. İstemci koparsa iş sunucuda biter; canlı akış yokken sayfa, süren iş görünüyorsa (taze bir "generating/running" satırı ya da satırı henüz açılmamış, 2 dk'dan genç bir paket) 6 sn'de bir kendini yeniler (`needsProgressPoll`). Kartın "basıldı" durumu sohbette tutulur (`chat-package-context.tsx`) ve kart paket kimliğiyle anahtarlanır: assistant-ui mesajları konuma göre anahtarladığı için liste kayınca kart başka paketin durumunu devralmasın.
4. Yazı çıktıları (`CREATE_COPY`, `CREATE_CAPTION`, `EMAIL_DRAFT`) müşterinin istediği görevlerde (`createdByType = USER`) `task-result` kartında **açık** gelir (`expanded`, `shouldExpandTaskResult`); araştırma ve otonom iş planı çıktıları eskisi gibi kapalı.

Not: metin sağlayıcısı (`openai-ai.provider.ts`) yanıtı bir bütün olarak döndürür; yazı parçaları token token akmaz, "running" kartı sonra sonuç kartı gelir.

## Hata davranışı

- Tanınan engeller (bütçe, kota, anahtar yok, oran sınırı, zaman aşımı): `limit-notice` kartı, yedeğe düşülmez.
- Model hiçbir şey üretmeden ve hiçbir iş kuyruğa girmeden düşerse: eski kural tabanlı `parseIntent` yedeği.
- Bir tool çalıştıktan veya metin akıtıldıktan sonra hata: yedeğe **düşülmez** (çift iş / çelişen metin olmasın), yalnızca dürüst hata.
- Kullanıcı Stop'a basarsa: istek iptal olur, o ana kadarki metin kaydedilir.

## Bilinen sınırlar

- Inline çalıştırma (`generate_image`, içerik paketi) işin dispatch olayını tükettiği için, süreç ölürse (redeploy) o iş worker tarafından yeniden denenmez: RUNNING kalan işi self-healing 30 dk sonra düşürür; olayı aldıktan ama işi sahiplenmeden (yüzlerce ms) ölürse iş QUEUED kalır ve elle iptal edilmelidir. Worker'ın "takılmış dispatch" kurtarması yaşı olmayan RUNNING işi sıfırladığı için olay tüketilmeden inline iş güvenle sürülemez.
- İçerik paketi: kart `started` olduktan sonra, ilk görev açılmadan (~1 sn) sunucu ölürse kart "started" kalır ve yeniden denenemez (müşteri ajandan yeni paket ister). Görevi açılamayan tek tek parçalar da karttan yeniden denenmez; sohbette hata mesajı olarak görünür.
- Konuşma özeti yok: eski turlar `trimHistory` ile atılır; eski bilgiye okuma tool'larıyla ulaşılır. Kalıcı özet için ek LLM çağrısı ve saklama alanı (şema) gerekir.
- Rate limit süreç içidir; birden çok instance'ta paylaşılmaz. Asıl harcama sınırı projenin günlük `AutonomyPolicy` bütçesidir.
- Tool izi (hangi tool çağrıldı) kalıcı değildir; yalnızca canlı akışta görünür.
- Bir mesajda birden çok kart üretilirse (work session) hepsi canlı akışta görünür ama `Command` satırına yalnızca sonuncusu yazılır; görev ve creative sonuçları kendi SYSTEM satırlarıyla zaten kalıcıdır.
- Edit, yeni mesaj olarak gider (dal geçmişi tutulmaz); BranchPicker tek dalda gizlidir.

## Test

`src/server/chat/*.test.ts` ve `src/app/api/projects/[projectId]/chat/route.test.ts` (sahte model/SDK, DB'siz). Canlı OpenAI ile uçtan uca test elle yapılır.

# Guided setup (butonlu kurulum sheet'i)

Ekranın ortasında açılan bir pencere (Base UI Drawer üzerinde): yazı yazmadan, dokunarak marka kurulumu. Sayılar ve kimlikler tek kaynaktan gelir: `src/lib/guided-setup/contract.ts`. Bu belge ile kod ayrışırsa kod doğrudur.

## Keşif öncelikli kurulum (güncel akış)

> Aşağıdaki "Sorular" ve "Saklama: iki Command satırı" bölümleri **eski soru sihirbazını** anlatır. Sihirbaz (adımlar, plan, oturum, Approve, panel) kodda durur ama `GUIDED_SETUP` açıkken **artık bağlanmaz**; sonraki bir temizlik görevinde silinecek. Güncel akış burada; kaynak: `src/lib/guided-discovery/contract.ts`.

**Kişinin yaptığı:** yalnızca marka adı ve (isteğe bağlı) web sitesi. Ülke ve dil otomatik seçilir, tek satırda "Change" ile değiştirilir. İlke: ajansın kendi bulabileceği şeyi sormayız.

**Akış:** Marka girişi, derin keşif, Brand Brain sentezi, gözden geçirme, hazır. Sheet dört aşama gösterir: siteyi okuma, logo/renk/font bulma, web'de araştırma, profili yazma. Her aşama simge ve sözle `pending / running / done / skipped / failed` gösterir.

**Güven eşikleri:** model her alan için skor ve kanıt türü (`site`, `web`, `both`, `inferred`) bildirir; sunucu skora tek başına güvenmez, kanıta göre tavanlar: `inferred` 70, `site` 90, `web` 90, `both` 100.

| Skor       | Katman              | Ne olur                                                                                 |
| ---------- | ------------------- | --------------------------------------------------------------------------------------- |
| 85 ve üstü | Found (accepted)    | Otomatik kabul, dossier'ye yazılır                                                      |
| 60-84      | Check (assumed)     | Varsayım olarak gösterilir, yazılmaz; "+" çipi ile eklenir; onboarding'i asla durdurmaz |
| 60 altı    | Not found (unknown) | Boş bırakılır; bu turda soru sorulmaz                                                   |

`approvedClaims` her zaman boştur; web'den gelen hiçbir şey iddia, kural ya da bellek satırı olmaz.

**Önizleme ekranı:** alan başına bir blok (about, audience, products, services, markets, voice, positioning, competitors, channels): değer, küçük katman etiketi, altında "also found" aday çipleri (satır başına en çok 8, metin en çok 140 karakter, en çok 9 satır). Çipe dokunmak tek bir değeri ekler (liste alanlarında dossier'de en çok 12 öğe, tekrar yok; metin alanı yalnızca boşsa). Kimlik bloğu logo, renk, font ve stili özetler; kanallar sitedeki sosyal bağlantılardan yalnızca etiket olarak gelir (URL saklanmaz). **Looks good** durumu CONFIRMED yapar ("Workspace ready"), başka hiçbir şey yazmaz ya da harcamaz. `services` ve ek öğeler için ayrı küçük bir "extend" çağrısı vardır (öğe başına skor, 85 ve üstü yalnızca liste boşsa kaydedilir, 60-84 aday olur).

**Boş satır kalmaz:** "extend" çağrısı yalnızca services/products/markets/görsel kurallar için değil, about, voice, positioning ve audience için de 1-3 öneri döndürür (skor 50-84, asla 84 üstü). Bunlar **hiçbir zaman otomatik kaydedilmez**; "Suggested" etiketiyle dokun-ekle çipi olarak gelir. Değeri dolu bir metin satırı (about/voice/positioning) öneri almaz; audience listesi her zaman açıktır. Öneri de gelmediyse satır "Nothing found yet" der, boş kalmaz. Model anahtarı yoksa (mock) öneriler boştur.

**Hızlı ekleme:** "Add all suggestions (N)" bekleyen tüm önerileri sırayla ekler (her biri ayrı, yalnızca kimlik alan yazma; biri başarısız olursa döngü durur, kalanlar dokunulmaz). Hazır (CONFIRMED) ekranı da tüm profili gösterir ve ekleme kabul eder.

**Başarısızlık ve yeniden deneme:** nedenler `limit`, `busy`, `timeout`, `error`, `unavailable`. Yeniden deneme yalnızca durum FAILED iken ve deneme sayısı 3'ten azken, açık "Try again" dokunuşuyla olur (en çok 3 ücretli deneme). Koşu 150 sn sonunda zaman aşımına uğrar; 240 sn'den eski RUNNING satırı okunurken FAILED/timeout sayılır (yazılmaz). Başarısız koşunun tavan rezervasyonu iade edilir.

**Tavanlar ve maliyet:** tek `Command` satırı `gd_<projectId>` (`topic: GUIDED_DISCOVERY`, migration yok); satır birincil anahtarı bir başlatmada yalnızca bir araştırma garantiler. Ücretli araştırma yalnızca oluştur dokunuşu ve açık "Try again" ile başlar; GET, yoklama, render ya da yeniden açma asla harcama başlatmaz. Kapılar ve çalışma alanı tavanları eskisiyle aynıdır (`reserveDiscovery`, `GUIDED_SETUP_DISCOVERY`, `GUIDED_SETUP_DISCOVERY_CAPS`); yeni bayrak yoktur.

**API:** `/api/projects/[projectId]/guided-discovery`: `GET` görünümü verir; `POST` `add` (candidateId), `confirm`, `retry`. Yalnızca kimlikler alınır.

**Henüz yok:** bilinmeyen alanlar için sorular, sosyal hesap okuma, bağlı dosyalar, hedefler (sonraki turlar).

## Amaç

Yeni bir proje, ajansın ilk işi için yeterli bir profille başlasın: hedef, kanallar, işin ne olduğu, kitle, ton. Sohbette soru-cevap yerine beş dokunuş, sonunda tek bir "Approve". Sheet **iki motorda da aynı** çalışır (`CHAT_ENGINE=legacy` ve `agent`). Her şey `GUIDED_SETUP` arkasında **kapalı** gelir.

## Sorular (eski sihirbaz, bağlı değil)

Varsayılan yol beş sorudur (`MAIN_QUESTIONS`): `goal`, `channels`, `business`, `audience`, `tone`. Checkpoint'te "Add more detail" seçilirse iki soru daha gelir (`DETAIL_QUESTIONS`): `angle` (konumlandırma) ve `guardrails` (asla yapma kuralları). Sonra Review; Review, Approve'un çalıştıracağı plan nesnesinden (`buildApplyPlan`) üretilir, yani ekranda yazan ile yazılan aynıdır.

Seçenek metni yalnızca üç kaynaktan gelir: kapalı statik kataloglar, ajansın zaten bildiği marka bilgisi (ACTIVE, mock olmayan constitution, temizlenmiş) ve kullanıcı "Get ideas"a dokunursa tek bir Quick Discovery çalıştırması. "Something else" ile yazılan metin tek seçim sayılır ve `cleanUserText` ile temizlenir.

## Saklama: iki `Command` satırı

Yeni tablo ve migration yok. Oturum durumu iki `Command` satırıdır; id'ler sunucuda projectId'den türetilir (istemci veremez), oluşturma birincil anahtar insert'üdür (P2002 = zaten var):

| `topic`              | id               | İçerik                                                            |
| -------------------- | ---------------- | ----------------------------------------------------------------- |
| `GUIDED_SETUP`       | `gs_<projectId>` | Cevaplar, adım bayrakları, `applied` özeti, `editRev`             |
| `GUIDED_SETUP_IDEAS` | `gi_<projectId>` | "Get ideas" durumu (`attempts`, RUNNING/READY/FAILED), seçenekler |

- Yazmalar CAS'tır (`editRev`): iki sekme aynı anda yazarsa eskisi "This setup changed in another tab." alır.
- Satır şemaları **gevşek** (`z.looseObject`): yeni sürümün yazdığı bilinmeyen alanlar okuma-değiştirme-yazmadan geçer, geri alma sonrası eski örnekte de parse olur. Hiç parse edilemeyen satır `start` tarafından değiştirilir (audit: `guided_setup.session_reset`), proje asla takılı kalmaz.
- Her sohbet akışı `topic: null` süzdüğü için bu satırlar mesaj olarak görünmez.
- İki satır da proje silinince silinir (çalışma zamanında tablo keşfi).

## Env değişkenleri ve nasıl açılır

| Değişken                      | Varsayılan | Anlamı                                                                                                                                                                                               |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GUIDED_SETUP`                | `false`    | Ana anahtar: her yüzey, route, action, `?guide=setup`, chip, Welcome kartı, "+" öğesi, ajan aracı, legacy çözücü, `/projects/new` tek ekran. Süreç geneli.                                           |
| `GUIDED_SETUP_DISCOVERY`      | `false`    | Yalnızca ücretli "Get ideas" çalıştırması. `false`, `true` (tüm çalışma alanları) veya virgülle ayrılmış çalışma alanı kimlikleri (canary). Hatalı giriş "kapalı" okunur, asla "herkese açık" değil. |
| `GUIDED_SETUP_DISCOVERY_CAPS` | boş        | `"kullanıcı,çalışma alanı,genel"` 24 saat başına, örn. `1,2,4`. Tavanları yalnızca **düşürür**; ayrıştırılamazsa tavanlar geçerli; `0,0,0` fikir adımını durdurur.                                   |

Hepsi yalnızca sunucuda okunur (`NEXT_PUBLIC_` yok; o değerler build'de donar). `getEnv()` süreç boyunca önbelleğe alır: değişiklik yeniden başlatma ister (Railway, değişken değişince zaten yapar). Her giriş noktası bayrağı kendisi tekrar kontrol eder (Server Action herkese açık bir POST'tur).

- **Yerel**: repo kökündeki `.env` dosyasına `GUIDED_SETUP=true` ekleyin (ücretli adımı denemek için `GUIDED_SETUP_DISCOVERY=true`), `next dev`'i yeniden başlatın. `.env.example`'a üç anahtar yorum satırı olarak eklenir. Yerel `.env` paylaşılan Neon veritabanına bağlıdır: "Get ideas"ı, branch deploy edilene kadar (deploy edilen worker ve prompt'lar bu satırları bilmez) yalnızca sandbox projelerde deneyin; Approve ve "Get ideas" gerçek satır yazar.
- **Railway**: Variables → `GUIDED_SETUP=true` → servis yeniden başlar. `GUIDED_SETUP_DISCOVERY`'yi önce **tek bir sandbox çalışma alanı kimliği** ve `GUIDED_SETUP_DISCOVERY_CAPS=1,2,4` ile açın.
- **Geri alma**: değişkenleri kaldır, yeniden başlat. Deploy ve migration gerekmez. Approve'un yazdığı veri sıradan profil verisidir ve kalır; kapılar kaybolur, saklı kartlar etkisiz satıra döner.

Bayrağın erişimi: `GUIDED_SETUP_DISCOVERY` ve `..._CAPS` yalnızca **sheet'in** ücretli kapısını yönetir. Ajan motorunun ilk sohbet turundaki Quick Discovery ayrı bir kapıdır; bu değişkenler onu saymaz ve durdurmaz. O anahtar `CHAT_ENGINE=legacy` (veya `GUIDED_SETUP=false`) olur.

## "Get ideas" ve Quick Discovery sıralaması

Sheet Quick Discovery ile **yarışmaz, sıralar**. Mevcut `QuickDiscoveryService.run` (site + az web araması) tek kez çalışır; sonuç şu kurallarla birleşir:

- Kullanıcının kendi alanları kazanır, boşlar doldurulur; `approvedClaims` asla.
- Yalnızca guided çalıştırmada (`claim(projectId, { guided })`) şunlar devrededir: sayfa metni için rastgele **çit (fence)**, model çıktısı için **temizleme (scrub)** (claim-tipi alanlar `negativeBrief`, `knownFacts`, `forbiddenClaims` vb. web'den gelen metinle dolmaz), geç gelen sonucun **birleştirmesi** ve gevşetilmiş claim kapısı (yalnızca guided-only ince bir constitution varken Quick Discovery yine uygundur).
- Bayrak kapalıyken yol HEAD ile bayt bayt aynıdır.
- Approve, Quick Discovery'yi beklemez ve onun yüzünden başarısız olmaz. Hangi sırayla biterlerse bitsin kullanıcı verisi ezilmez (`ifActiveVersion` çakışma koruması).

## Tavanlar ve maliyet dürüstlüğü

| Sınır                                   | Değer                                                               |
| --------------------------------------- | ------------------------------------------------------------------- |
| Proje başına ücretli çalıştırma (ömür)  | **3** (`MAX_DISCOVERY_ATTEMPTS`), yeniden deneme yalnızca dokunuşla |
| Kullanıcı / çalışma alanı / genel, 24 s | **5 / 10 / 20** (üst sınırdır; env yalnızca düşürür)                |
| Çalıştırıcı bekleme süresi              | 150 sn; 240 sn'den eski RUNNING satırı `FAILED(timeout)`            |
| İstek gövdesi                           | en çok **16 KB** (16.384 bayt), aşarsa 413                          |
| Approve                                 | proje başına 24 saatte 12                                           |

Sayaç satırları (`guided_setup.discovery.started`) **çalışma alanı düzeyindedir**: `projectId` ve `brandId` taşımazlar, bu yüzden proje silinince kaybolmazlar (yoksa sınır, sınırsız proje açılarak atlatılırdı).

**Tavanlar çalıştırma SAYISINI sınırlar, doları değil.** Tam kesilmiş (kesilip iki kez yeniden denenen) bir çalıştırma yaklaşık 1 USD tutabilir [tahmin]. OpenAI kredisi tek ortak havuzdur ve sayaç hiçbir şeyi kapatmaz; havuzu yalnızca sağlayıcı tarafındaki sert aylık limit korur. Bu yüzden ücretli adım, çağrı başına sınırlar (Increment B1) gelene kadar **kapalı kalır**; yalnızca sahibin tek çalışma alanlık denemesi istisnadır.

### Sahip kapıları (açmadan önce)

- P0 dağıtımdaki `CHAT_ENGINE` değerini oku, kalan krediye OpenAI panelinden bak (`OPENAI_CREDIT_BALANCE` 4 Eki 2026'da kalktı) ve OpenAI projesinde **sert aylık limit** olduğunu doğrula.
- P1 CI'da `store.integration.test.ts` ve `limits.integration.test.ts` yeşil (Postgres 16).
- P2 Railway'de `after()` probu (60-150 sn iş, deploy sırasında SIGTERM).
- P3 tek sandbox projede (Web Health değil) bir çalıştırma, `GUIDED_SETUP_DISCOVERY` = o çalışma alanının kimliği; `finished` DONE, süre ~75 sn altı, maliyet beklenen aralıkta.
- P4 cihaz kontrol listesi (aşağıda).
- P5 probe projeyi sil, "started" sayımı **düşmemeli** (satırlar çalışma alanı düzeyinde).
- P6 **`LEGACY_AGENCY_LOOP` `drain` veya `off`** olduğunu doğrula (kontrol edilen kapı).
- P7 Increment B1 canlıda doğrulandı. Herhangi bir gerçek kullanıcı için bu kapı şarttır.

Sıra: (1) üç değişken de kapalıyken merge; (2) `GUIDED_SETUP` yerel/staging'de önce legacy, sonra agent; (3) `LEGACY_AGENCY_LOOP=drain`; (4) P0-P6 tek sandbox çalışma alanında; (5) B1; (6) gerçek çalışma alanı kimlik listesi, sonra `true`.

## Saklama notu (retention)

Sheet'in kendi satırları sayfa alıntısı **saklamaz**; yalnızca seçilen seçenekler ve cevaplar. Ancak Quick Discovery okuduğu her sayfayı `Evidence.extractedText` olarak saklar: **sayfa başına en çok 20.000 karakter, proje silinene kadar** (7 gün yeniden kullanılır). Bu, üçüncü taraf, güvenilmeyen metindir ve kalır. Audit metadata'sı yalnızca sayım, adım kimliği ve neden kodu taşır; serbest metin ve URL asla. `WEB_PAGE` kanıtlarının 30 günden sonra temizlenmesi B5 işidir.

## Proje oluşturma düğmesi: siteden kimlik ve (açıksa) marka araştırması

`GUIDED_SETUP` açıkken `/projects/new` ekranındaki ana düğme bir **onaydır**: sunucu, proje oluştuktan sonra yanıttan sonra (`after()`) şunları başlatır (`src/server/brand/intake-start.ts`). Düğmenin etiketi ve altındaki not, neyin başlayacağını söyleyen **aynı fonksiyondan** gelir (`src/lib/intake-offer.ts`): not yalnızca gerçekten harcama başlıyorsa "AI credit" der.

| Durum                                                                                      | Düğme                      | Başlayan                                                |
| ------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------- |
| Site yazılmadı                                                                             | Create and continue        | Hiçbir şey (not: "Add a website and we can also read…") |
| Site var, gerçek model + OpenAI anahtarı                                                   | Create and read my website | Marka kimliği taraması                                  |
| Site var, ücretli araştırma da açık (`GUIDED_SETUP_DISCOVERY` bu çalışma alanını kapsıyor) | Create and set up with AI  | Kimlik taraması + marka araştırması                     |
| Mock mod ya da anahtar yok                                                                 | Create and continue        | Hiçbir şey                                              |

- **Kimlik taraması** (`src/server/brand/site-scan/auto-identity.ts`): Brand sekmesindeki "Scan site" ile aynı tarama (logo, renkler, fontlar, stil). Sonuç bir modalda onaya sunulmak yerine doğrudan marka kitine yazılır, ama **yalnızca hâlâ boş olan** yere: sizin koyduğunuz logo, renk, font ya da stil asla ezilmez (yazmadan hemen önce yeniden okunur). Her şey doluysa tarama hiç çalışmaz, maliyet yoktur. Sayfanın ya da modelin yazdığı hiçbir şeye güvenilmez: renkler altı haneli hex olarak, stil alanları listelerle doğrulanır, serbest metinler link/işaret/talimat taşıyorsa bütünüyle atılır, logo çözülüp yeniden kodlanır; ikon ya da sosyal görsel logo sayılmaz.
- **Sınırlar:** bir proje otomatik olarak **bir kez** taranır; kullanıcı başına 10, çalışma alanı başına 20 otomatik tarama / 24 saat (çalışma alanı düzeyinde denetim satırları, proje silinince silinmez). Bir tarama yaklaşık 0,01–0,04 dolardır.
- **Yeniden tarama:** Brand sekmesindeki **Scan site** düğmesi aynen duruyor: istediğiniz zaman siteyi yeniden tarar, sonucu görüp seçerek kaydedersiniz (bu yol mevcut değerlerin üzerine yazar).
- **Marka araştırması:** artık keşif akışının (`startDiscovery`) bir parçasıdır (yukarıdaki "Keşif öncelikli kurulum"); aynı kapılar ve tavanlar, koşu arka planda sürer.
- **Henüz yok:** sosyal hesap ve bağlı dosya okuma, alan başına güven skoru (85 üstü otomatik kabul, 60–84 varsayım, altı tek soru), çok adımlı seçim sihirbazının kaldırılması ve "kritik boşluk soruları" akışı (yeni ürün tarifi; sonraki artışlar).

## Brand Dossier'in boş alanlarını AI önerisiyle doldurma

Sheet yalnızca dokunduğunuz şeyi yazar (işletme türü etiketi, kitle, ton). `Services`, `Products`, `Markets` ve `Visual guidelines` boş kalır; Quick Discovery de `services` ve `visualGuidelines` alanlarını hiç doldurmaz. Bunun için ayrı, küçük bir adım vardır (`src/server/brand/dossier-suggest.ts`):

- **Otomatik:** Approve başarılı olunca yanıt döndükten sonra (`after()`, Approve beklemez ve bundan etkilenmez) bir kez çalışır. Bir marka için otomatik deneme en çok 2 kez yapılır (başarısız çağrı da sayılır).
- **Elle:** Brand Brain → Brand Dossier kartındaki **Suggest with AI** düğmesi. Sizin dokunuşunuz olduğu için deneme sınırına takılmaz; kullanıcı + proje başına 10 dakikada 3 istekle sınırlıdır.
- **Girdi:** yalnızca markanın bildiği bilgiler (marka adı, site adresi, işletme türü, kitleler, ton, pazar, dil). Sayfa metni ya da web'den gelen bir şey modele verilmez; link, işaret veya talimat gibi görünen her metin atılır.
- **Yazma kuralı:** yalnızca hâlâ **boş** olan alanlara yazılır (yazarken yeniden okunur); elle yazdığınız hiçbir değer değişmez. Yalnızca işletme türü etiketinden ibaret bir `summary` yer tutucu sayılır ve bir cümlelik özetle değiştirilir.
- **Dürüstlük:** yazılan alanlar denetim kaydına `brand_dossier.autofilled` (`source: ai_suggested`) olarak yazılır; kart, dossier'yi siz düzenleyene kadar "AI-suggested: ..." notunu gösterir. Bunlar doğrulanmış bilgi değil, başlangıç önerisidir.
- **Maliyet:** tek küçük çağrı (varsayılan model, en fazla 1.800 çıktı tokenı, web araması yok), yaklaşık 0,005–0,01 dolar. Mock modda ya da yapay zekâ anahtarı yokken hiçbir şey yazılmaz.
- **Bayrak:** `GUIDED_SETUP` kapalıyken düğme yoktur ve otomatik adım çalışmaz.

## Approve ne yazar, ne yazmaz

Approve kısa, yalnızca DB işidir; ağ yok, model çağrısı yok, sohbete asistan mesajı yok. Tek sohbet yazımı aşağıdaki makbuz `Command` satırıdır.

| Cevap                 | Yazılan                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `business`            | constitution `identity`, `BrandDossier.summary`                                                                           |
| `audience` (en çok 2) | `audiences`, `targetAudiences`                                                                                            |
| `angle`               | `positioning` (constitution + dossier)                                                                                    |
| `tone`                | `toneOfVoice` (constitution + dossier)                                                                                    |
| `goal`                | bir `ProjectGoal` (`GOAL_PRESETS`'ten; aşağıdaki mod kuralı)                                                              |
| `channels`            | anahtarlı bir `USER_EXPLICIT` hafıza satırı (`sourceRef guided-setup:channels`)                                           |
| `guardrails`          | `NegativeBriefRule` (`category "client-rule"`, eklemeli, tekrarsız) + bir AVOID hafıza satırı (`guided-setup:guardrails`) |

Constitution **yeni bir sürüm** olarak birleşir (kullanıcı adına, `decidedBy USER`); mock satır yok sayılır, okunamayan gerçek payload o parçayı başarısız eder. Dossier yalnızca tanımlı anahtarlarla kısmi upsert'tir. Atlanan ve ertelenen cevaplar hiçbir şey yazmaz. Bir çalıştırmada en çok iki hafıza satırı.

**Asla yazılmaz**: `approvedClaims`, `forbiddenClaims`, `negativeBrief`, `knownFacts`, `assumptions`, `openQuestions` (ince v1'deki sabit işaret hariç), `legalRestrictions`, `UserDecision`, `Competitor`, `ProjectSignalProfile`, `AutonomyPolicy` ve `autopilotMode`, `ProjectSchedule`, `Idea`, proje adı/alan adı/dil/ülke, bağlantı kimlik bilgileri. Yayınlama, zamanlama, reklam harcaması, hesap bağlama, derin araştırma, tarama ve sohbet mesajı da Approve'un işi değildir (her biri ayrı bir onaydır).

Değişen bir şey varsa sohbete kapalı kelime dağarcıklı tek bir makbuz kartı (`guided-setup`, `state: done`) yazılır: "Draft my first plan" (yalnızca agent motoru, sunucuda zorlanır), "Connect accounts" (`/projects/{id}/integrations` bağlantısı), "Edit setup".

### Hedefin "öneri" (proposed) modu

Aktif bir hedef, `LEGACY_AGENCY_LOOP=on` iken eski Director'ın bekleyen fikirlere göre iş yapmasını sağlar ve `autopilotMode` varsayılanı AUTOPILOT'tur. Bu yüzden `resolveGoalMode`, **döngü `on` VE autopilot AUTOPILOT (politika satırı yoksa da) VE en az bir kanal bağlı** ise `proposed` döner, aksi halde `active`; okuma hatasında `proposed` (güvenli taraf). `proposed` modda hedef PROPOSED kalır (Director göremez), Review "Adds your goal as a proposal: approve it in Strategy." der. `active` modda hedef kullanıcı adına APPROVED sonra ACTIVE yapılır; `GoalEngine.approveAll` asla çağrılmaz. **Kontrol edilen kapı: gerçek kullanıcılardan önce `LEGACY_AGENCY_LOOP=drain`** (bkz. `docs/architecture/legacy-loop-rollout.md`).

## Legacy motor davranışı

`CHAT_ENGINE` varsayılanı `legacy` ve legacy sınıflandırıcı, `ProjectSetupState` satırı olmayan projede kurulum röportajı yürütür. Sheet'ten sonra aynı müşteri yeniden sorgulanmasın diye küçük, bayrakla kapılı, silinebilir bir çözücü vardır: `src/server/chat/legacy-setup-gate.ts`. Bayrak kapalıyken bugünkü değeri aynen döner (20 kombinasyonluk eşlik testi).

| Kurulum satırı | mod        | `activatedAt` | profileReady | guidedApplied | bugün       | bayrak açık                                    |
| -------------- | ---------- | ------------- | ------------ | ------------- | ----------- | ---------------------------------------------- |
| yok            | -          | -             | hayır        | hayır         | NOT_STARTED | NOT_STARTED (profilsiz projede röportaj sürer) |
| yok            | -          | -             | evet         | herhangi      | NOT_STARTED | **ACTIVE**                                     |
| yok            | -          | -             | hayır        | evet          | NOT_STARTED | **ACTIVE** (sheet constitution'sız uygulandı)  |
| var            | FULL / yok | null          | herhangi     | herhangi      | IN_PROGRESS | IN_PROGRESS (çalışan FULL pipeline engeller)   |
| var            | ENRICHMENT | null          | herhangi     | herhangi      | IN_PROGRESS | **ACTIVE** (derin araştırma asla engellemez)   |
| var            | herhangi   | dolu          | herhangi     | herhangi      | ACTIVE      | ACTIVE                                         |

`guidedApplied` bir birincil anahtar okumasıdır ve yalnızca gerekince yapılır. Sheet hiçbir `ProjectSetupState` oluşturmaz. Sheet uygulanmadan kapatılırsa legacy davranışı değişmez.

## Ajan aracı ve kart

- `start_guided_setup` (terminal araç, yalnızca `ACTIVE` faz, argümansız: modelin UI'ya serbest metin kanalı yok). `GUIDED_SETUP` kapalıyken kayıtlı değildir ve istemler bayt bayt aynıdır. İstemdeki not yalnızca bayrak açıkken eklenir. Kurulum isteğinde tek cümlelik giriş + araç; sorular sohbette sorulmaz, `create_task` ile kuyruğa atılmaz.
- Müşterinin kendi kelimeleri (tohum) sunucuda `Command` satırından okunur (en çok 500 karakter, talimat biçimliyse atılır).
- `guided-setup` kartı durumsuzdur: `open` bir başlatıcı (etiket canlı bağlamdan, `entry.label`: "Set up your brand" / "Continue setup · question n of 5" / "Update your setup"; "Start setup" / "Continue setup" Welcome kartının düğmesidir), `done` makbuz. Akışta `open` kartı sheet'i bir kez açar; geçmişten yüklenen kart asla kendiliğinden açmaz. Bağlam yoksa (bayrak kapalı, fikir dizisi) düz, etkisiz bir satırdır.
- Ajan motorunun ilk tur Quick Discovery'si bayrak açıkken sertleştirilir (çit, scrub, birleştirme, gevşek kapı); kapalıyken HEAD ile aynıdır.

## Drawer, klavye ve Android Geri

Pencere Base UI Drawer'ı üzerinde ama **ekranın ortasında** açılır (alt kenara yapışık değil, kayma ve sürükleme yok; açılış yalnızca yumuşak bir belirme/ölçek geçişidir). Kapatma: Esc veya X; yüzey/gövde dokunuşu asla kapatmaz, arka plana dokunmak da kapatmaz. Kapatınca oturum kalır ve chip "Continue setup · question n of 5" der. **Android sistem Geri'si sheet'i kapatır ve mevcut seçim korunur**; iOS kenar kaydırması kaydedilmemiş seçimle sayfadan çıkarmaz. "Something else…" alanı için klavye sağlayıcısı alanı ve Continue'yu görünür tutar (16 px yazı, iOS yakınlaştırması yok); masaüstünde Enter geçerli metinle devam eder, telefonda klavyeyi kapatır. Hedefler en az 44 px, pencere sabit 40 rem yüksekliktedir ve kısa ekranlarda ekrandan taşmaz (`max-h-full`), gövde kaydırır, Continue/Approve her zaman erişilebilir. Azaltılmış hareket ve zorunlu renk modu desteklenir.

## Test ve cihaz kontrol listesi

### Yoklama (poll) sayıları

Kaynak `POLL` (`contract.ts`): 2 sn aralık, en çok 5 dk (`maxMs`), istek başına 15 sn zaman aşımı, 60 sn sonra "Still working ...", sekme gizliyken tik atlanır, 429/5xx/ağ hatasında sessiz geri çekilme (gecikme ikiye katlanır, en çok 10 sn), üst üste 3 hatadan sonra şerit vazgeçer, terminal durumda durur.

Testler `*.test.ts`, DB'siz. Entegrasyon testleri (`store.integration.test.ts`, `limits.integration.test.ts`) yalnızca CI'daki Postgres'te koşar. Cihaz geçişi sahibindedir (gerçek iPhone Safari ve Android Chrome, sandbox proje), bu ortamda görülemez:

1. `?guide=setup` derin bağlantısı: hidrasyondan sonra açılır, **composer klavyeyi bir an bile açmaz**, parametre URL'den silinir, yenilemede yeniden açılmaz.
2. Açma/kapama animasyonu, arka plan dokunuşu işe yaramaz, Esc kapatır, Android Geri kapatır ve seçim kalır.
3. Yükseklik ve güvenli alan: yatay telefon, %200-%400 yakınlaştırma, %200 yazı ölçeği.
4. "Something else…" üzerinde klavye; Enter davranışı.
5. 44 px hedefler, "n of max", 160 karakterlik seçenek kesilmez.
6. VoiceOver/TalkBack: odak her adımda soru başlığına ve gövde en üstte; "Question n of 5" tek durum bölgesinden bir kez; bant çıkınca "Suggestions are ready."; diyalog adı "Set up {Brand}, {soru}"; AI metni proje dilinde (`lang`); seçili satırlar basılı okunur; `aria-disabled` iken Approve ipucunu okur; Kapat erişilebilir; "Get ideas", "Try again", "Not quite" sonrası odak diyaloğun en üstüne atlamaz.
7. Azaltılmış hareket, karanlık mod, zorunlu renkler (seçili durum Check ikonu ile).
8. Ortada yenileme ve iki sekme ("This setup changed in another tab." + Reload setup).
9. Oturum süresi dolması ve `callbackUrl`; deploy sırasındaki 502 kayıt sorunu olarak gösterilir.
10. Araştırma (sandbox çalışma alanı): Get ideas bir kez; yenileme devam eder; yeniden deploy 4 dk sonra "couldn't gather ideas" + Try again.
11. Approve: bitti görünümü (Close odaklı), makbuz ve düğmeler (değişen yoksa düğme yok); legacy'de mesaj gitmez ve sonraki mesaj röportaj yapmaz; agent'ta "Draft my first plan" bir dokunuş bir mesaj. **Telefonda Approve sonrası klavye açılmaz ve sheet açıkken `router.refresh()` odağı sheet'in dışına taşımaz.** Bağlı hesap, autopilot ve legacy döngü `on` iken Review hedefin öneri olduğunu söyler ve Strategy PROPOSED gösterir.
12. Sheet açıkken süren sohbet turunda odak sheet'te kalır.
13. `/projects/new`: bayrak açıkken tek ekran, kapalıyken dört adımlı sihirbaz değişmez.
14. Pencere ekranın ortasındadır; kaydırarak kapanmaz (sürükleme kapalı). "applying" sırasında X/Esc yalnızca gizler.
15. Yavaş ağ (slow-3G): iskelet, hatada satır içi uyarı, toast yok.
16. İki sekmede iki projede araştırma: hiçbirinde hata bandı yok (429 sessiz geri çekilme).
17. Girişler: boş sohbette yalnızca Welcome kartı, dolu sohbette yalnızca chip, **Not now** chip'i gizler, "+" öğesi kalır.

## Yol haritası

| Artımlı | İçerik                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | Bu belge: dokunmalı sheet, Approve, makbuz, legacy çözücü, ajan aracı, tek ekran `/projects/new`.                                                                                       |
| B1      | Çağrı başına arama sınırları (kesintide tek çağrı, 70 sn, `search_context_size low`, `max_tool_calls`), maliyet toplamı. **`GUIDED_SETUP_DISCOVERY` için kapı.**                        |
| B2-B5   | Geçişler (rakipler, içerik fikirleri), kaynak çipleri, rakip/sütun/örnek adımları, fikir yenileme ve 30 günden eski `WEB_PAGE` kanıt temizliği (kendi bayrağı `GUIDED_SETUP_RESEARCH`). |
| C       | Devam pill'i (app shell), Brand sekmesi CTA'sı, Setup paneli işaretçisi, iki düğmeli Review, legacy yazılı kapı, web sitesi ayarlayıcı.                                                 |
| D       | Telemetri panoları, yönetici tarafından düzenlenebilir tavanlar (tavanlar `GUIDED_SETUP_DISCOVERY_CAPS` ile zaten düşürülebilir).                                                       |

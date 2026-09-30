# Guided setup (butonlu kurulum sheet'i)

Alttan çıkan bir Drawer (Base UI): yazı yazmadan, dokunarak marka kurulumu. Sayılar ve kimlikler tek kaynaktan gelir: `src/lib/guided-setup/contract.ts`. Bu belge ile kod ayrışırsa kod doğrudur.

## Amaç

Yeni bir proje, ajansın ilk işi için yeterli bir profille başlasın: hedef, kanallar, işin ne olduğu, kitle, ton. Sohbette soru-cevap yerine beş dokunuş, sonunda tek bir "Approve". Sheet **iki motorda da aynı** çalışır (`CHAT_ENGINE=legacy` ve `agent`). Her şey `GUIDED_SETUP` arkasında **kapalı** gelir.

## Sorular

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

- P0 dağıtımdaki değerleri oku (`CHAT_ENGINE`, `OPENAI_CREDIT_BALANCE`) ve OpenAI projesinde **sert aylık limit** olduğunu doğrula.
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

Drawer Base UI'dır. Kapatma: Esc veya başlıktan kaydırma; yüzey/gövde dokunuşu ve gövde kaydırması asla kapatmaz, arka plana dokunmak da kapatmaz. Kapatınca oturum kalır ve chip "Continue setup · question n of 5" der. **Android sistem Geri'si sheet'i kapatır ve mevcut seçim korunur**; iOS kenar kaydırması kaydedilmemiş seçimle sayfadan çıkarmaz. "Something else…" alanı için klavye sağlayıcısı alanı ve Continue'yu görünür tutar (16 px yazı, iOS yakınlaştırması yok); masaüstünde Enter geçerli metinle devam eder, telefonda klavyeyi kapatır. Hedefler en az 44 px, `dvh` ile sheet hiçbir zaman ekrandan uzun olmaz, gövde kaydırır, Continue/Approve her zaman erişilebilir. Azaltılmış hareket ve zorunlu renk modu desteklenir.

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
14. Kaydırma: yalnızca başlıktan kapatılır; "applying" sırasında kaydırma sadece gizler.
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

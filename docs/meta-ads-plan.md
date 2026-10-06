# Agentelse · Meta Ads Yönetimi: Mimari ve Uygulama Planı

Durum: Plan (6 Ekim 2026) — henüz uygulanmadı.

> **Kapsam:** Meta (Facebook + Instagram) reklamları. Google Ads bu planın dışında; yine de yeni tablolar `platform` alanı taşıdığı için ileride aynı yapıya girebilir.
>
> **Dayanak:** Dört kod haritası (Meta entegrasyon katmanı; kampanya oluşturma ve düzenleme akışları; analiz, izleme ve optimizasyon; altyapı) ile iki araştırma raporu (Marketing API'nin Ekim 2026 durumu; profesyonel medya alımı oyun kitabı). Kod iddiaları repoda örneklenerek doğrulandı, örneğin `meta-client.ts:233-241`, `meta-client.ts:1095`, `meta-performance-scanner.ts:192`, `meta-api-provider.ts:79`, `approval-policy.ts:22-30`, `approval-details.ts:94,110`, `meta-ads-actions.ts:56,107,479,535`, `schema.prisma:2170-2173` ve `docs/modules.md` içindeki "Açık kalanlar". Repo dosyalarında değişiklik yapılmadı. Plan ardından iki bağımsız eleştiri turundan geçti (Meta'nın resmî dokümanı ve repo kodu üzerinden); kabul edilen bulgular bu sürüme işlendi. Farklı uygulanan önerilerin gerekçesi ilgili bölümde yazılıdır.
>
> **(doğrulanmalı):** Bu işareti taşıyan Meta davranışları ve alan adları, test reklam hesabında denenmeden koda bağlanmamalı.
>
> **Kurallar:** Uygulama arayüzü İngilizce; doküman ve kod yorumları Türkçe. Kod yazmaya başlamadan önce AGENTS.md uyarısı geçerli: bu sürümün Next.js 16 dokümanı `node_modules/next/dist/docs/` altında okunur.

**İçindekiler:** 0 Özet · 1 Hedef davranış · 2 Mevcut durum ve boşluklar · 3 Hedef mimari (3.0–3.9) · 4 Veri modeli · 5 İşler, zamanlama ve kota bütçesi · 6 Oyun kitabı · 7 Erişim ve App Review · 8 Test · 9 Yol haritası · 10 Riskler · 11 Kararlar · Ek A Kaynaklar · Ek B Kısaltmalar

---

## 0. Özet

**Hedef.** Agentelse bir "AI Meta Ads yöneticisi"ne dönüşecek: reklamları profesyonel bir medya alıcısının rutinleriyle planlayacak, güvenle kuracak, kesintisiz denetleyecek, ölçecek ve iyileştirecek. Para harcayan her adım koruma raylarından geçecek ve varsayılan olarak insan onayı isteyecek. Sunucumuz düşse bile Meta tarafındaki frenler harcamayı sınırlayacak.

**Bugün nerede duruyoruz?** Meta'da PAUSED (duraklatılmış) taslak kampanya kurabiliyor ve temel rapor okuyabiliyoruz. Ancak:

- Canlıda arka plan işçisi 1 Ekim'den beri tetiklenmiyor ve bunu fark eden bir mekanizma yok.
- Kurulan reklamların ne bitiş tarihi ne de harcama tavanı var.
- Tarayıcı, bütçesi ad set'te olan (yani bizim kurduğumuz) kampanyaları atlıyor.
- "Sonuç" metriği yanlış hesaplanıyor.
- Eski yolda bütçe, para birimine göre 100 kat yanlış gidebiliyor.
- Token, kota ve idempotency yönetimi yok.
- Harcama onayları süresiz ve rol ayrımı yok; L4 onayı Telegram'dan ve sohbetten de verilebiliyor.

### En kritik 5 mimari karar

1. **Önce nabız ve fren (F0a/F0b).** Birikmiş işler önce bir kapıdan geçirilir, sonra canlı işçi açılır (F0a, aynı gün). Ardından kalp atışı yazılır ve bunu GitHub dışındaki bir harici monitör izler (F0b). F0b'de modül akışındaki her ad set'e bitiş tarihi yazılır; eski sihirbaz da zorunlu bir End date ister. Kampanya harcama tavanı (`spend_cap`) F3'te gelir. Bu temel kurulmadan yeni bir reklam özelliği açılmaz.
2. **Tek Meta erişim katmanı ve hesap başına kota yöneticisi (F1).** Bütün Graph çağrıları tek bir çekirdekten geçer. Bu çekirdek şunları sağlar:
   - koda dayalı hata kataloğu (Meta'nın `blame_field_specs` alanıyla alan bazlı hata),
   - Meta'nın kullanım başlıklarına göre çalışan ve durumunu DB'de tutan kota yöneticisi,
   - üç öncelik şeridi (güvenlik eylemleri her zaman önde ve hiçbir yerel devre kesiciye takılmaz),
   - yalnızca güvenli tekrar deneme (kota bloklarında kısa tekrar yok),
   - `appsecret_proof` ve tek sürüm sabiti.
3. **Her yazma bir niyet kaydıdır (`AdsOperation`), lansman ise asenkron bir adım makinesidir (F1/F3).** Meta idempotency anahtarı sunmuyor. Bu yüzden yazmadan önce kalıcı bir niyet kaydı ve ad etiketi tutulur. Zaman aşımında kör tekrar yapılmaz; önce bu etiketle Meta'da arama yapılır. Lansman sırası: yerel doğrulama + görsel yükleme + kampanya ve kreatif için `validate_only` + Meta önizlemesi → tek onay → kurulum (kampanya PAUSED, ad set ve reklamlar ACTIVE) → geri okuma → tek yazmayla aktifleştirme (kampanya ACTIVE). Ad set ve reklam düzeyindeki Meta hataları kampanya kapalıyken, harcama olmadan yakalanır. Kısmi hatada ya yalnızca eksik adım tekrarlanır ya da telafi (temizlik) yapılır; her deneme ayrı bir görevdir.
4. **Yerel ayna ve günlük insights deposu (F2).** Ekranlar, sohbet ve kurallar canlı Graph yerine aynadan okur. Ayna 30-60 dakikada bir tazelenir. Atıf değişikliklerini yakalamak için son 28 gün her gün yeniden çekilir. Para kararları hesap ve kampanya toplamlarından verilir, böylece arşivlenen ya da silinen nesnelerin harcaması kaybolmaz. Ads Manager'da elle yapılan değişiklikler (drift) yakalanır. Hesap başına kota tüketimi, Dev bütçesinin yaklaşık %2-3'üne iner.
5. **Çift fren ve karar kaydı (F3/F4).** Bizim tarafımızdaki frenler: zarf, hız sınırı, rol, onay süresi ve acil durdurma (kill switch). Meta tarafındaki frenler sunucumuz düşse de çalışır: süreli lansmanda `lifetime_budget` + `end_time`, always-on'da ad set `end_time` (30 günlük zarfın sonu) ve ek tavan olarak kampanya `spend_cap`. Ad Rules yalnız F7'de isteğe bağlı bir sigortadır. Optimizasyonu, asgari veri ve öğrenme kapılı deterministik kurallar yapar; yapay zekâ yalnızca açıklar ve önceliklendirir. Her değişiklik bir `AdsDecision` kaydıdır ve şu zinciri izler: öneri → onay → uygulama → geri okuma → değerlendirme → geri alma.

### Fazlar

| Faz | Tek satır                                                                                                                                                                                                                  | Boyut |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| F0a | Aynı gün: claim noktasında birikim kapısı, tüm iş tiplerini gösteren birikim raporu, işçinin açılması (K1, K2)                                                                                                            | S     |
| F0b | Temel ve acil yamalar: kalp atışı + harici monitör, `end_time` (röle dahil) + `advantage_audience`, para birimi, 190 hatası, onay süresi ve rolü (tüm yollar), nesne-hesap doğrulaması, riskli otomatik yolların kapatılması | M     |
| F1  | Meta erişim katmanı ve hesap modeli: hata kataloğu, kota yöneticisi, niyet günlüğü, token sağlığı, `AdsAccount`                                                                                                            | L     |
| F2  | Ayna ve sürekli denetim: senkron, bekçiler, tekilleştirilmiş uyarılar, Ads sohbetinde durum kartı ve günlük özet, "Pause all"                                                                                              | L     |
| F3  | Güvenli lansman v2: doğrulama + önizleme, tek onay, asenkron ve idempotent yürütücü, Meta tarafı frenler, telafi                                                                                                           | L     |
| F5a | Mesaj ve trafik amaçları: Messages (WhatsApp / IG Direct / Messenger), Traffic → LPV ve "tıklamaya optimize etme" uyarısı                                                                                                  | M     |
| F4  | Optimizasyon v2: oyun kitabı kuralları, karar kaydı, gölge mod, fikir havuzuna bağlı kreatif yenileme                                                                                                                      | M     |
| F5b | Planlama motoru ve formlar: Leads, KPI hedefi, kreatif matrisi (iki oran), tahmin, video/carousel, mevcut kampanyaya ekleme                                                                                                | L     |
| F6  | Raporlama ve öğrenme: haftalık/aylık rapor, teşhis ağacı, Brand Brain öğrenmeleri, Brand sekmesi "Ads" kartı                                                                                                               | M     |
| F7  | Webhook ve koruma raylı otonomi ("Guarded auto", sınırlı "Full auto"); isteğe bağlı Ad Rules sigortası                                                                                                                     | M     |
| F8  | Ajans ölçeği: Facebook Login for Business + BISU, workspace düzeyi bağlantı, çoklu hesap, müşteri onay rolü; async insights, batch ve anomali tespiti                                                                      | L     |

Tablo uygulama sırasını gösterir. F5a, numarasına rağmen F4'ten önce gelir: KOBİ'nin asıl ihtiyacı mesaj hedefidir ve F4'ün gölge modu ancak canlı hesaplarda karar biriktikçe ölçülebilir (K26). Kod dışı paralel bir kritik yol F0 ile başlar: App Review (reklam izinleri), Live mod ve Full tier (§7, §9).

Boyut ölçeği kaba bir tahmindir ve tek geliştirici + yapay zekâ desteği varsayar: **S** ≈ 1-2 gün, **M** ≈ 3-5 gün, **L** ≈ 1-2 hafta. Her faz tek başına canlıya çıkabilir ve kendi başına değer üretir. Gerçek müşteri hesabında senkron ve lansman ise App Review, Live mod ve Full tier kapısına bağlıdır (§7).

### Sahibin hemen vermesi gereken kararlar (F0-F3'ü bloklayanlar)

Tam liste §11'de.

1. **İşçi tetikleyicisi (K1).** Yalnız web servisinde `ENABLE_INPROCESS_WORKER=true` açılsın; CRON_SECRET eşitlenmiş GitHub cron yedek kalsın. Bozuk Railway cron-worker servisi silinsin ve secret döndürülsün. _(Önerilen)_
2. **Birikmiş işler (K2).** İşçi açılmadan önce F0a kapısı devreye girsin: onayı 24 saatten ya da görevi 72 saatten eski META_* yazmaları iptal edilip yeniden onaya sunulsun; planlanan saati 24 saatten eski yayın slotları yayınlanmasın, takvimde "Missed" kalsın. Karar, tüm iş tiplerini gösteren birikim raporu okunduktan sonra verilir. _(Önerilen)_
3. **Harici monitör (K23).** İşçi nabzını GitHub dışındaki ücretsiz bir uptime ya da dead-man servisi izlesin; GitHub cron yalnız yedek tetikleyici kalsın. _(Önerilen)_
4. **Lansman onayı (K4).** Tek onay hem kurulumu hem zarf içinde yayını kapsasın; ayrıca "Create paused only" seçeneği olsun. _(Önerilen)_
5. **Harcama onaycısı (K5).** L4 harcama onayını yalnız workspace OWNER/ADMIN versin. Kural web, Telegram ve sohbet yollarının hepsinin geçtiği ortak onay noktasında uygulanır; Telegram'a L4 için yalnız "Review in Agentelse" bağlantısı gider. _(Önerilen)_
6. **Bitiş ve tavan (K6).** Süreli lansmanda `lifetime_budget` + `end_time` kullanılsın. Always-on lansmanda ad set'e günlük bütçe ile 30 günlük zarfın sonunu gösteren `end_time` yazılsın; aylık yenileme bu tarihi uzatan bir L4 karar olsun. Kampanya `spend_cap`, hesabın asgari değeri gözetilerek ek tavan olarak eklensin. _(Önerilen)_
7. **Veri saklama (K7).** Günlük insights saklansın: reklam düzeyi 180 gün, üst düzeyler 400 gün; gizlilik metni de güncellensin. Organik için Faz 4'te verilen "sayı saklamama" kararı değişmez. _(Önerilen)_
8. **Uyarı kanalı (K8).** Kritik uyarılar uygulama içinde ve Telegram'da gösterilsin. Telegram'a yalnız Agentelse'in kendi verisi gider; Meta'dan okunan harcama, sonuç ve kampanya adı gitmez. Bu, "arka planda bildirim yok" kararının yalnızca CRITICAL seviyedeki istisnasıdır. _(Önerilen)_
9. **Günlük özetin yeri (K24).** Today arayüzden kalktığı için günlük özet ve uyarı kartı projenin Ads sohbetine düşsün. _(Önerilen)_
10. **Otonomi (K3).** Varsayılan seviye "Suggest only" olsun. "Guarded auto" proje bazında, isteğe bağlı olarak F7'de gelsin. _(Önerilen)_
11. **Disconnect (K18).** Meta Ads ayrılınca bizim taraftaki token ve reklam verisi silinsin. Meta'daki izin yalnız reklam izinleri için ve yalnız aynı kişinin başka bir Meta Ads bağlantısı yoksa geri alınsın. Tüm izinleri geri almak (`DELETE /me/permissions`) aynı kişinin Facebook ve Instagram bağlantılarını da koparırdı. _(Önerilen)_
12. **Test için ayrı Meta uygulaması (K25).** Yerel geliştirme ve test reklam hesabı denemeleri "Agentelse Dev" adlı ayrı bir uygulamayla yapılsın; canlı uygulamanın kotası ve Full tier hata oranı etkilenmesin. _(Önerilen)_

---

## 1. Hedef davranış: "AI Meta Ads yöneticisi"

### 1.1 Profesyonel rutin

| Ritim                                     | AI yöneticisi ne yapar                                                                                                                                                                                                                                                                                             | Çıktı                                                            | İnsan ne yapar                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| **Sürekli** (15-30 dk)                    | Harcama temposu, kaçak harcama, sonuçsuz harcama, teslimat/ret durumu; işçi ve senkron nabzı                                                                                                                                                                                                                       | Uyarı (yalnız sorun varsa). Kritik durumda tek dokunuşla "Pause" | Kritik uyarıda karar verir                            |
| **Günlük** (sabah, hesap saatiyle)        | Token/izin sağlığı; hesap durumu, ödeme, `spend_cap` payı; 24 saati aşan inceleme; teslimat almayan aktif nesne (G8); öğrenme durumu; takılan lansman, yetim nesne, drift; dünkü harcama ile planın karşılaştırması                                                                                                    | Ads sohbetinde günlük özet kartı (yalnız not edilecek bir şey varsa) | Bir dakikada okur, gerekirse onaylar                  |
| **Haftalık** (Pazartesi)                  | Her ad set/kampanya için KPI'yı hedefle karşılaştırır ve ölçekle/düşür/koru önerir (asgari veri + öğrenme kapısıyla). Kreatif yorgunluğunu ve kaybeden reklamları bulur. Yeni konsept gerekiyorsa, performans iyi olsa bile 3-6 haftada bir (O14), fikir havuzuna brief yazar. Olgunlaşan kararları değerlendirir. Meta önerilerini ikinci görüş olarak sunar | Toplu karar listesi + haftalık rapor                             | Kararları toplu onaylar/reddeder, yeni kreatifi seçer |
| **Aylık** (ayın 1'i)                      | Hesap denetimi: yapıyı sadeleştirme, çakışma, izleme sağlığı, özel kategori/DSA. "Bu ay kaç müşteri geldi?" mutabakatı. Gelecek ayın zarfı: ad set `end_time` uzatma ve kampanya `spend_cap` yenilemesi. Ad Library'de rakip incelemesi (elle açılan bağlantı). Öğrenmeleri Brand Brain'e yazar | Aylık rapor (ajansta müşteri raporu) + zarf onayı                | Zarfı onaylar, mutabakat sorusunu yanıtlar            |
| **Çeyreklik** (büyük hesap, isteğe bağlı) | Kreatif konsept testi (Meta creative testing), yapının yeniden kurgulanması                                                                                                                                                                                                                                        | Test planı                                                       | Onaylar                                               |
| **Platform** (operatör)                   | API sürüm ve changelog kontrolü, Marketing API çağrı hata oranı (Access Tier şartı), kota olayları, harici monitör alarmları                                                                                                                                                                                       | Operatör özeti                                                   | Sahip izler                                           |

### 1.2 Otonomi seviyeleri

| Seviye (UI)             | Otomatik yapılabilenler                                                                                                                                                         | Asla otomatik olmayanlar                                                                | Önkoşul                                                                                         | Varsayılan           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------- |
| **Suggest only**        | Okuma, uyarı, öneri, rapor. Ayrıca onaylı zarfın parçası olan Meta tarafı frenlerin kendiliğinden çalışması                                                                     | Her Meta yazması (hepsi onay ister)                                                     | —                                                                                               | **Evet**             |
| **Guarded auto**        | Yalnız riski azaltan eylemler: kaçak harcamada PAUSE; sonuçsuz harcamada PAUSE (yalnız platform içi olaylarda: mesaj, anında form; site dışı dönüşümde öneri kalır); bütçeyi en çok %30 düşürme (72 saatte bir); reddedilmiş/yetim nesneyi arşivleme (`launchId`'si olmayan olası kullanıcı kopyaları hariç) | Bütçe artışı, aktifleştirme, hedefleme/kreatif/özel kategori değişikliği, yeni kampanya | Sağlıklı token, F2 aynası, F4 karar kaydı, proje bazında açık rıza, güncellenmiş gizlilik metni | Hayır (isteğe bağlı) |
| **Full auto (limited)** | "Guarded auto"daki her şey; ek olarak onaylı aylık zarf içinde en az 72 saat arayla en fazla %20 bütçe artışı ve önceden onaylanmış kreatifleri mevcut ad set'e haftalık ekleme | Zarfı aşmak, yeni kampanya, yeni nesneyi aktifleştirme, hedefleme/özel kategori         | Full access tier, süresiz token (BISU), izleme sağlığı OK, en az 30 günlük geçmiş, aylık tavan  | Hayır (F7 sonrası)   |

- **Otomatik eylemlerin kaydı ve sınırı:** Her otomatik eylem bir karar kaydı oluşturur, sonradan bildirilir ve tek dokunuşla geri alınabilir. Proje başına günde en fazla 5 otomatik eylem yapılır; sınır aşılırsa iş insan onayına düşer.
- **Savunma derinliği:** Yürütücü (`MetaApiProvider`), `META_SAFETY_ACTION` içinde harcamayı artıracak her isteği koşulsuz reddeder: durumu ACTIVE yapmak, bütçeyi artırmak gibi.
- **Onay politikası istisnası:** `ApprovalPolicy` bugün seviyeyi yalnız yükseltir, asla düşürmez. Guarded'da L1'e indirme yalnız `META_SAFETY_ACTION` + `riskReducing=true` + GUARDED olduğunda yapılır. Bu, kuralın yazılı ve testle sabitlenmiş tek istisnasıdır (F7).
- **Gizlilik metni:** `src/app/privacy/page.tsx` bugün `ads_management` iznini "when you ask for it or approve it" diye anlatıyor. "Guarded auto" açılmadan önce bu metin ve App Review açıklaması güncellenmeli.

### 1.3 Tasarım ilkeleri

- **Meta'nın otomasyonuyla yarışma, onu doğru besle.** Doğru amaç ve olay, geniş kitle (Advantage+ audience), yüksek kreatif çeşitliliği (Andromeda farklı kreatifleri ödüllendirir), marka güvenliği (Meta'nın içerik üreten AI kreatif dönüşümleri varsayılan kapalı), harcama freni ve anlaşılır rapor.
- **KOBİ varsayılanı.** Marka başına 1 always-on kampanya, 1 ad set ve 3-6 gerçekten farklı reklam. Yeni kampanya yalnız gerekçeyle açılır: farklı amaç, özel reklam kategorisi, farklı ülke fiyat seviyesi, süreli kampanya ya da ayrı bütçe sahibi.
- **Tıklamaya optimize etme.** Piksel yoksa platform içi olay hedeflenir: mesaj, anında form, profil ziyareti.
- **Küçük veride kesin dil yok.** "Winner" etiketi yalnız istatistik kapısını geçen sonuca verilir (§6, O11); geçemeyenler "directional" olarak gösterilir.
- **Her sayı bağlamıyla gösterilir.** Atıf ayarı, hesap saat dilimi ve tazelik birlikte yazılır, ör. "Updated 12 min ago · Account time".
- **Para birimi tek modülden.** Tüm tutarlar minor unit olarak tutulur; hiçbir yerde sabit `×100` ya da `/100` kalmaz.
- **Sadelik.** İleri özellikler (cost cap, ROAS goal, katalog, A/B testi) ancak yeterli veri ve talep oluşunca, "uzman modu" altında açılır.

### 1.4 Başarı ölçütleri

| Ölçüt                                         | Hedef                                |
| --------------------------------------------- | ------------------------------------ |
| Çift kampanya/ad set/reklam                   | 0                                    |
| Onaylı zarfı %10'dan fazla aşan harcama olayı | 0                                    |
| Kritik sorunun tespit süresi                  | ≤ 60 dk (F7 webhook sonrası ≤ 10 dk) |
| İşçi durmasının fark edilmesi                 | ≤ 15 dk (harici monitör)             |
| "Bugün" insights tazeliği                     | ≤ 30 dk                              |
| İşçi kalp atışı                               | 24 saatte en uzun boşluk < 6 dk      |
| Marketing API hata oranı (son 500 çağrı)      | < %5 (Full tier şartı < %15)         |
| Ayna doğruluğu                                | Hesap toplamı = kampanya toplamları = reklam satırları (±%1); sonuç sayısı Ads Manager "Results" ile ±%1 |
| Onaydan kuruluma kadar geçen süre (kampanya hâlâ PAUSED) | Full: ≤ 2 dk · Dev: ≤ 6 dk |
| Önerilerin kabul oranı (gölge modda ölçülür)  | ≥ %60                                |

---

## 2. Mevcut durum ve boşluk analizi

### 2.1 Bileşen envanteri: korunacak, yeniden düzenlenecek, kaldırılacak

| Bileşen                                                                                                                                                        | Bugün                                                                                  | Karar                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/integrations/meta-client.ts`                                                                                                                       | Graph v26 sarmalayıcısı, ~2.100 satır, tek `request()`                                 | **Yeniden düzenle.** Çekirdek `src/server/integrations/meta/*` altına taşınır; yazma fonksiyonlarına eksik alanlar eklenir                                                                                                                                                                      |
| `src/server/execution/providers/meta/meta-api-provider.ts` | Tek META_* yürütücüsü; sonuç süreç içi `Map`'te (`:79`); video bekleme kaydı dayanıklı | **Yeniden düzenle.** `Map` kalkar (INSTAGRAM_PUBLISH ve FACEBOOK_PUBLISH dahil tüm yetenekler); `AdsOperation` günlüğü, nesne-hesap doğrulaması (F0b), asenkron `META_LAUNCH` ve `META_SAFETY_ACTION` eklenir. Video bekleme deseni korunur ve lansman adım makinesine örnek olur |
| `src/server/integrations/meta-ads-query.ts`                                                                                                                    | Her render'da canlı Graph                                                              | **Yeniden düzenle.** Aynadan okur; canlı çağrı yalnız "Refresh" ile                                                                                                                                                                                                                             |
| `src/server/agency/performance/meta-performance-scanner.ts` | 7 saatlik tarayıcı; ABO'yu atlıyor (`:192`); yalnız ACTIVE projeleri tarıyor | F0b'de yamanır (ABO, ad set düzeyinde bulgu). F2'de `META_ADS_SYNC` açıkken adımı atlanır ve mantığı G/O kurallarına taşınır. F4'te silinir |
| `src/server/agency/performance/meta-performance-rules.ts` | Saf kurallar; `/100` hatası (`:61`); testsiz | F0b'de yamanır, F4'te `src/server/ads/rules/*`'e taşınır (iskelet ve tipler korunur) |
| `src/server/agency/performance/performance-optimizer.ts` | Öneri → Task + Approval; AD_FATIGUE onaysız görsel üretimi başlatıyor (`:155`); görev kotası dolunca PAUSE önerisini sessizce düşürüyor (`:56-63`); bütçe önerisi kampanya düzeyinde (`:77-105`) | F0b'de otomatik görsel kapanır, PAUSE/REDUCE önerileri günlük kotadan muaf olur, ABO'da öneri ad set'e gider; F4'te karar kaydına dönüşür |
| `src/server/agency/meta-ads/meta-campaign-chain-relay.ts`, `meta-adset-chain-relay.ts` | Üç onaylı, işçiye bağlı zincir; `__pendingAdSet` alanlarını tek tek kopyalıyor | F0b'de `durationDays` taşınır. F3'te yeni lansmanlar kullanmaz; eski görevler bitince **kaldırılır** |
| `src/lib/module-flows/ads/*`, `src/components/module-flows/ads/*`, `src/server/actions/ads-flow-actions.ts`, `src/server/modules/ads/*` | Bayraklı modül akışı (`isModulesEnabled()`: `MODULES_UI` + `WORKS_UI` + `CHAT_ENGINE=agent`); doğru para birimi; claim ile tek lansman | **Korunur ve genişler** (modüller açıkken tek oluşturma yolu, §2.4) |
| `src/app/projects/[projectId]/ads/page.tsx`, `src/components/ads/*`, `src/server/actions/meta-ads-actions.ts` | Eski sihirbaz; `×100`; çift bütçe; düzenleme formları veri kaybettiriyor | F0b'de para birimi, bütçe ve düzenleme formları yamanır, oluşturmada End date zorunlu olur. F3'te oluşturma/düzenleme formları kalkar, sayfa "Ads account" izleme sayfası olur. Yeniden kullanılacak parçalar: `GeoTargetSelect`, `CitySearchCommand`, `LocaleSearchCommand`, `GenderToggle`, `CarouselCardEditor`, `VideoUploadField`, `AdPreviewCard` |
| `src/server/commands/approval-decisions.ts` → `maybeProposeMetaCampaign` (`:663-817`) + `meta-campaign-brief.ts` | LLM'den ACTIVE kampanya önerisi (`:798`) | **Kaldırılır.** F0b'de çağrılar kapanır, F3'te kod silinir |
| `src/server/agency/measurement/measurement-engine.ts` (META_CAMPAIGN_CREATE şablonu)                                                                           | Sağlayıcısı olmayan MEASUREMENT_CHECK                                                  | META şablonu kaldırılır; yerine F2'deki lansman sonrası kontrol noktaları gelir                                                                                                                                                                                                                 |
| `src/server/modules/analytics/meta-ads.ts`                                                                                                                     | Ayrı `graphGet` ve `v26.0` kopyası                                                     | Ortak çekirdeğe ve aynaya bağlanır                                                                                                                                                                                                                                                              |
| `src/server/works/ads-pulse.ts`, `src/lib/works/ads-insight.ts`, `src/server/actions/work-ads-actions.ts`, `src/components/works/ads-insight-card.tsx`         | Metadata digest kartı; dürüst "stale" durumu                                           | Korunur; aynadan beslenir; uyarı ve karar kutusuna dönüşür                                                                                                                                                                                                                                      |
| `src/server/execution/approval-policy.ts`, `approval-details.ts`, `src/server/commands/task-planner.ts`, `src/server/repositories/approval.repository.ts` | L4 tabanı sağlam; onaylar süresiz ve süre karar anında denetlenmiyor; rol yok; `/100`; META_CAMPAIGN_CREATE için detay yok | Korunur; onay süresi (karar anında da), rol (ortak onay noktası `ApprovalRepository.decide`), para modülü ve yeni yetenekler eklenir |
| `src/server/observability/error-classifier.ts`, `provider-health.service.ts`                                                                                   | Metin regex; kiracıdan bağımsız devre kesici                                           | Meta hatası kod tabanlı sınıflanır; kiracıya özgü hatalar global sağlığı düşürmez                                                                                                                                                                                                               |
| `src/server/workers/execution-worker.ts`, `src/instrumentation.ts`, `src/app/api/cron/worker/route.ts`, `src/server/agency/continuous/agency-wiring.ts` | Tek döngü; iz bırakmıyor; Meta adımları LLM'li adımlarla aynı sırada | Korunur; aşama izolasyonu, kalp atışı ve tick adım sırası (Meta adımları LLM'li adımlardan önce) eklenir |
| OAuth (`start`/`callback` rotaları), `oauth-state.ts`, `crypto.ts`, `meta-signed-request.ts`, `meta-data-requests.ts` | Sağlam | Korunur. Callback'e `debug_token` ve izin kontrolü eklenir; app-scoped kullanıcı kimliği Facebook yolu bağlantılarının hepsine yazılır ve silme akışı onları da kapsar |
| Outbox, ExecutionJob, Approval, TaskPlanner hattı; `card-store.ts`; `inline-job.ts`; analytics `summary.ts` + `src/lib/module-flows/analytics/number-check.ts` | Sağlam ve testli                                                                       | **Korunur**, yeni yapı bunların üstüne kurulur                                                                                                                                                                                                                                                  |

### 2.2 Boşluk tablosu

| #   | Boşluk                                                                                                | Önem                           | Kanıt                                                                                                                                                                        | Etki                                                                                                                | Faz           |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Canlı işçi tetikleyicileri bozuk; işçiyi izleyen kimse yok                                            | Kritik                         | `instrumentation.ts:53-54` bayrak yoksa sessizce çıkıyor; cron rotası 401 dönüyor; `railway.json`'da healthcheck yok; `AgencyLoopState.lastTickAt` hiçbir ekranda görünmüyor | Onaylı Meta yazmaları, zincir, doğrulama, tarayıcı ve Telegram onayları günlerdir duruyor; kart "Still working" der | F0a, F0b      |
| 2   | Süresiz harcama: `end_time`, `lifetime_budget` ve `spend_cap` hiç gönderilmiyor                       | Kritik                         | `adsLaunchPayload` (`state.ts`), `createMetaAdSet`, `docs/modules.md`                                                                                                        | Aktifleştirilen reklam, biri elle durdurana kadar harcar                                                            | F0b, F3 |
| 3   | Kendi kurduğumuz ABO kampanyalar izlenmiyor                                                           | Kritik                         | `meta-performance-scanner.ts:192`: kampanya bütçesi yoksa `continue`                                                                                                         | Agentelse'in kurduğu reklamlarda hiçbir kural ya da uyarı çalışmıyor                                                | F0b, F2 |
| 4   | "Sonuç" metriği, en yüksek sayılı action'dan sezgisel seçiliyor                                       | Kritik                         | `meta-client.ts` `toInsightsRow`; kodun kendisi de bunu kabul ediyor (`ads-insight.ts`)                                                                                      | 0 satış/lead ile para yakan kampanya "sonuçlu" görünüyor                                                            | F2            |
| 5   | Para birimi ofseti eski yolda, kural motorunda ve onay kartında yok                                   | Yüksek                         | `meta-ads-actions.ts:56,107,479,535` (`×100`); `meta-performance-rules.ts:61`; `approval-details.ts:94,110`                                                                  | JPY/KRW/HUF/IDR gibi hesaplarda bütçe 100 kat gidiyor, onaylayan yanlış tutarı görüyor                              | F0b |
| 6   | Token yaşam döngüsü yok                                                                               | Yüksek                         | `meta-client.ts:329-354`; süre yazılıyor ama Meta Ads için hiç okunmuyor                                                                                                     | Bağlantı ~60 günde habersiz kopar, kampanyalar gözetimsiz kalır                                                     | F1 (BISU: F8) |
| 7   | 190 hatası tutarsız ele alınıyor                                                                      | Yüksek                         | Bağlantıyı yalnız Test eylemi ve provider'ın dış catch'i (`meta-api-provider.ts:785-793`) EXPIRED yapıyor                                                                    | Ekranda "Connected" yazarken her işlem başarısız oluyor                                                             | F0b |
| 8   | Kota yönetimi yok; 80000 kodu tanınmıyor                                                              | Yüksek                         | `meta-client.ts:233-241`; yanıt başlıkları atılıyor (`:243-290`); 3 Ekim'deki "(#4)" hatası                                                                                  | Okumalar yazmaları aç bırakıyor; geçici hata kalıcı FAILED oluyor                                                   | F0b, F1 |
| 9   | Idempotency yok; sonuçlar bellekte tutuluyor                                                          | Yüksek                         | `meta-api-provider.ts:79, 426-449`; koşulsuz stalled-dispatch kurtarma (`execution-service.ts:147-157`); 8 sn zaman aşımı                                                    | Çift nesne oluşabiliyor; Meta'da oluşan nesne "FAILED" görünüp kimliği kayboluyor                                   | F1, F3        |
| 10  | Nesne-hesap doğrulaması yok | Yüksek | `meta-ads-actions.ts:74-117` `campaignId`'yi formdan alıyor; provider update yolları yalnız id + token ile çalışıyor ve her çağrıda güncel `selectedAdAccountId`'yi kullanıyor | Aynı ajans token'ıyla B müşterisinin kampanyası değişebilir; onaydan sonra hesap seçimi değişirse kampanya bir hesapta, ad set başka hesapta kurulabilir | F0b |
| 11  | Metadata bütün nesne olarak yazılıyor                                                                 | Yüksek                         | `meta-performance-scanner.ts:325-335`; `meta-actions.ts`                                                                                                                     | Tarama sırasında yapılan hesap seçimi geri yazılıyor, işler yanlış müşteri hesabına gidiyor                         | F0b → F1 |
| 12  | Hesap, teslimat, ret ve öğrenme sağlığı okunmuyor                                                     | Yüksek                         | `listAdAccounts` yalnız `id,name,currency` okuyor (`meta-client.ts:570-584`); `issues_info`, `ad_review_feedback`, `learning_stage_info` hiç kullanılmıyor                   | Ödeme hatası, kapanan hesap ve reddedilen reklam sessiz kalıyor                                                     | F1, F2        |
| 13  | Onaylar süresiz ve süre karar anında denetlenmiyor; rol ayrımı yok, L4 Telegram ve sohbetten de onaylanabiliyor; Telegram'daki onay "kör"; `decide_approval` en son bekleyeni seçiyor | Yüksek | `task-planner.ts` `expiresAt` set etmiyor; `ApprovalRepository.decide` `expiresAt`'e bakmıyor, `expireOverdue` görevi açık bırakıyor; `applyApprovalDecision` (web, Telegram, Works, plan, post) ve sohbetin doğrudan `ApprovalRepository.decide` çağıran yolu (`command-service.ts:265`) rol denetlemiyor; Telegram onaylayıcısı `telegram:<id>` sözde kullanıcısı; `telegram-approval-notifier.ts:148` yalnız başlık + tip gönderiyor | Bayat ya da hiç görülmemiş bir harcama onayı yetkisiz kişi tarafından uygulanabiliyor; süresi dolan görev kartta sonsuza dek "Still working" der | F0b |
| 14  | İşçi açılınca birikmiş işler kontrolsüz akacak | Yüksek | dispatch ve `startExecution` yaş kontrolü yapmıyor; 1 Ekim birikimi zaten dispatch edilmiş (ExecutionJob QUEUED, outbox PENDING); `SelfHealing` ölü mektupları yetenek ayırmadan yeniden kuyruğa alıyor; gecikmiş zamanlanmış slot bir kez çalışıyor (`scheduler-service.ts:80-153`) | 1 Ekim'den beri bekleyen Meta yazmaları güncel kontrol olmadan çalışır; bayat yayınlar çıkar, LLM'li adımlar toplu koşar | F0a |
| 15  | `advantage_audience` açıkça gönderilmiyor | Yüksek | `buildTargetingSpec` | Özel yaş/kitle verilen ad set hata verebilir (doğrulanmalı). Varsayılan ya da gevşetilmiş olmayan hedeflemede yeni ad set için açık 0/1 değeri v23'ten beri zorunlu; HEC'te v26'da zorunlu, tüm sürümlerde v25 kullanımdan kalkınca (tarih belli değil). Kod v26 kullandığı için pratikte fark etmez | F0b |
| 16  | Özel reklam kategorisi ve DSA desteği yok | Yüksek | `meta-client.ts:1095` sabit `[]` gönderiyor; `dsa_*` alanları yok; modül akışında AB ülkeleri seçilebiliyor (`src/lib/locales.ts`) | AB hedefli lansman ad set adımında düşer ve yarım zincir bırakır; emlak/istihdam/finans markalarında yanlış beyan riski | F0b (AB için DSA), F3 |
| 17  | Doğrulama sahte; yetim nesneler oluşuyor; temizlik yok                                                | Orta                           | `execution-worker.ts:330-420` rawResult'ı kanıt sayıyor; `meta-api-provider.ts:1095-1103`                                                                                    | "COMPLETED" gerçeği kanıtlamıyor; hesap kirleniyor                                                                  | F2, F3        |
| 18  | Tarihsel veri yok; her okuma canlı                                                                    | Yüksek                         | `meta-ads-query.ts:38-42`; yalnız `previousScanSnapshot` + 5 kampanyalık digest tutuluyor                                                                                    | Trend, tempo, yorgunluk ve rapor yapılamıyor; kota tükeniyor                                                        | F2            |
| 19  | Kural motoru sığ                                                                                      | Yüksek                         | Öğrenme durumu, asgari veri ve hedef KPI kullanılmıyor; tek bulgu diğerlerini gölgeliyor (`meta-performance-rules.ts`)                                                       | Gürültüye dayalı kesinti/ölçek önerileri; öğrenme sıfırlanıyor                                                      | F4            |
| 20  | Performans uyarıları LLM'de elenebiliyor ve kalıcı olarak tekilleşiyor                                | Yüksek                         | `intelligence-engine.ts` alaka puanı veriyor; parmak izi zamansız                                                                                                            | Aynı sorun ikinci kez uyarı üretmiyor                                                                               | F2            |
| 21  | Riskli otomatik yollar açık                                                                           | Orta                           | `approval-decisions.ts:798` ACTIVE kampanya öneriyor; `performance-optimizer.ts:155` onaysız görsel üretiyor                                                                 | LLM kaynaklı link ve hedef; çakışan bütçe; maliyetli görsel                                                         | F0b |
| 22  | Global devre kesici kiracılar arası etki yapıyor                                                      | Orta                           | `provider-health.service.ts`, `capability-router.ts:98-118`                                                                                                                  | Tek müşterinin hatası herkesin Meta işini durdurabiliyor                                                            | F1            |
| 23  | VERIFYING tuzağı tick'in ajans kısmını düşürüyor | Yüksek | `execution-worker.ts:359-418`'de öğe başına try/catch yok; onarım sorgusu CANCELLED/FAILED görevleri her dakika yeniden seçiyor ve `take 20` bu satırlarla doluyor | Tek bir iptal, Meta taramasını ve onayları durduruyor; gerçek onarımlar aç kalıyor | F0b |
| 24  | Amaç kapsamı dar                                                                                      | Yüksek                         | Yalnız 3 hedef var; Traffic = LINK_CLICKS (`state.ts`)                                                                                                                       | Yerel KOBİ'nin asıl ihtiyacı olan mesaj ve form yok                                                                 | F5a, F5b |
| 25  | Instagram kimliği ve biçim uyarlaması yok                                                             | Orta                           | `createMetaAdCreative` `instagram_user_id` göndermiyor; tek görsel kullanılıyor                                                                                              | IG yerleşiminde Page kimliği görünüyor; Story/Reels'te görsel kırpılıyor                                            | F3, F5b |
| 26  | Sohbet ajanı reklam bağlantısını göremiyor                                                            | Orta                           | `meta-connection-status.ts` hedef listesinde `meta_ads` yok; `tools.ts` `MODULE_TOOLS.ads` yalnız ortak araçları içeriyor                                                    | "CPA neden arttı?" sorusu yanıtlanamıyor                                                                            | F2, F3        |
| 27  | FB Login için deauthorize/veri silme yok; Disconnect token'ı saklıyor                                 | Orta                           | `meta-data-requests.ts` yalnız instagram; `meta-actions.ts:259-290`                                                                                                          | Uyumluluk açığı                                                                                                     | F1            |
| 28  | Ajans hesap keşfi eksik; saat dilimi bilinmiyor                                                       | Orta                           | `/me/adaccounts` sayfalanmıyor; `timezone_name` okunmuyor                                                                                                                    | Hesap listede görünmeyebiliyor; gün sınırları kayıyor                                                               | F1, F8        |
| 29  | Dev mod engeli (1885183) | Yüksek | Uygulama Development modundayken `object_story_spec` ile (uygulamanın oluşturduğu yayınlanmamış gönderiyle) kurulan her reklam, reklam adımında düşüyor | Sahibin test hesabında da son halka (reklam) düşüyor; gerçek müşteride lansman imkânsız | Önkoşul (§7); testte `object_story_id` yolu (§8) |
| 30  | Kritik yollarda test yok; `appsecret_proof` yok                                                       | Orta/Düşük                     | Kural motoru ve `request()` hata ayrıştırması testsiz                                                                                                                        | Sessiz regresyon; "Require App Secret" açılırsa her şey kırılır                                                     | Her faz, F1   |
| 31  | `PerformanceOptimizer` koruma önerilerini sessizce düşürüyor | Orta | `performance-optimizer.ts:56-63`: görev kotası ya da LLM bütçesi dolunca PAUSE dahil öneri `daily-cap` ile düşüyor; AuditLog'a da /health'e de iz bırakmıyor | Kaçak harcamada bile öneri gelmeyebilir | F0b |
| 32  | ABO kampanyada bütçe önerisi kampanyaya yazılıyor | Yüksek | `performance-optimizer.ts:77-105` (`META_CAMPAIGN_UPDATE` + `daily_budget`); tarayıcı ABO'ya açılınca tetiklenir; sonuç metriği de yanlış (#4) | Meta reddeder ya da bütçe yapısı bozulur; yanlış CPR ile L4 öneri düşer | F0b |
| 33  | Zincir rölesi yeni alanları düşürüyor | Yüksek | `meta-campaign-chain-relay.ts:98-115` `__pendingAdSet` alanlarını tek tek kopyalıyor | `adsLaunchPayload`'a eklenen bitiş bilgisi Meta'ya ulaşmaz | F0b |
| 34  | Eski düzenleme formları veri kaybettiriyor | Orta | `campaign-edit-form.tsx` bütçeyi zorunlu tutuyor ve ABO kampanyaya `daily_budget` yolluyor; ad set düzenleme her seferinde tüm targeting'i yeniden yazıyor | ABO yapısı bozulur; Ads Manager'da eklenen ilgi alanları, özel kitleler ve Advantage+ ayarları sessizce silinir | F0b |
| 35  | Tarayıcı yalnız ACTIVE projeleri tarıyor | Orta | `meta-performance-scanner.ts:80-86` | Agentelse'te duraklatılan projenin reklamları Meta'da harcamaya devam eder ve izlenmez | F2 |
| 36  | Sağlık ekranı ve eylemleri kiracılar arası | Orta | `health-actions.ts:145-196` yalnız workspace üyeliği istiyor ama etkileri global; sağlık raporu sistem düzeyindeki DLQ metinlerini herkese gösteriyor | Bir müşteri kullanıcısı platform genelini etkileyen eylemleri tetikleyebilir; başka kiracının hata metni görünür | F1 |
| 37  | Yerel dev işçisi canlı işleri claim edebiliyor | Orta | `local-worker-policy.ts:19-25` (`ENABLE_LOCAL_WORKER=true`); outbox claim'leri yalnız CAS, işin hangi ortamda koşacağını belirlemiyor | Yerelde çalışmak canlı lansmanı FAILED/DLQ yapabilir, canlı kotayı tüketir ve gerçek kullanıcılara uyarı gönderebilir | F0b |

F0, aynı gün yapılacak F0a ile sonraki deploy'daki F0b'nin toplamıdır (§9).

### 2.3 `docs/modules.md` açık kalanlarının karşılığı

| Açık kalan                                                                               | Plandaki karşılığı                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bitiş zamanı gönderilmiyor; reklam duraklatılana kadar döner | F0b: ad set `end_time` (`durationDays` ile, röle dahil). F3: FIXED'de `lifetime_budget`; always-on'da zarf sonu `end_time` + kampanya `spend_cap` |
| Her halka işçiyi bekler (~10 sn) | F0a/F0b: işçi onarımı. F3: tek lansman görevi, asenkron adım makinesi ve onay anında `after()` ile sürüş |
| "Edit and launch again" yeni kampanya kurar; yarım nesneler PAUSED kalır | F3 niyet günlüğü: "Fix and retry" (yeni görev) yalnız eksik adımları kurar, "Discard" kampanya düzeyinde telafi eder. F2: yetim nesne bekçisi |
| Asgari günlük bütçe denetlenmiyor | F1: `minimum_budgets` (yoksa `min_daily_budget`) okunur. F3: yerel doğrulama + kampanya ve kreatif için `validate_only` |
| Instagram yerleşimi denetlenmiyor | F3: IG kimliği (P9) + Story/Reels önizlemesi. F5b: 9:16 varyant (`asset_feed_spec`) |
| Ad set ve reklam görevlerinin Command'ı yok; başka sohbetlerde karar olarak görünüyorlar | F3: lansman görevleri (her deneme ayrı görev) aynı `AdsLaunch`'a ve kartın Command'ına bağlıdır |
| Eski sihirbaz bütçeyi hem kampanyaya hem ad set'e koyuyor | F0b: kampanyaya bütçe gönderilmez; düzenleme formu ABO'da bütçe yollamaz. F3: sihirbaz kaldırılır |

### 2.4 İki paralel oluşturma yolu: karar

**Karar:** Tek oluşturma yolu, modül akışındaki Ads Manager kartı olur. Eski `/projects/[projectId]/ads` sayfası **"Ads account"** adıyla bir izleme ve hafif yönetim sayfasına dönüşür. Bu sayfada şunlar kalır: Pause/Resume, onaylı bütçe kararı, "Open in Ads Manager" ve "Refresh".

**Gerekçe:**

- Modül akışının avantajları: para birimini doğru işliyor, claim ile çift lansmanı engelliyor, sohbetle bütünleşik ve onay kartın içinde veriliyor.
- Eski yolun sorunları: `×100` hatası, çift bütçe, Works guard'ının ve oran sınırının olmaması.

**Geçiş sırası:**

1. **F0b:** Eski yolun para ve bütçe hataları ile düzenleme formlarının veri kaybı yamanır; oluşturmada tek tarih/saat seçiciyle zorunlu bir End date istenir. Eski yol canlıda kaldığı sürece zarar vermemeli.
2. **F3:** Eski oluşturma/düzenleme formları yalnız `isModulesEnabled() && META_ADS_LAUNCH_V2` iken gizlenir. Bu koşulda sohbet ajanının `META_CAMPAIGN_CREATE` isteği eski form linki yerine modül kartını açar; koşul sağlanmıyorsa `command-service` eski form linkini vermeye devam eder. Aksi hâlde modüllerin kapalı olduğu ortamda hiç reklam oluşturma yolu kalmaz. Önkoşul: canlıda `MODULES_UI=true`, `WORKS_UI=true` ve `CHAT_ENGINE=agent` (5 Ekim itibarıyla `MODULES_UI` sahipte bekliyordu).
3. **F3 sonrası:** V2 iki hafta sorunsuz çalışırsa, modül bayrakları en az iki haftadır canlıda açıksa ve bekleyen eski görev kalmazsa şunlar silinir: formlar, `meta-ads-actions.ts` içindeki oluşturma eylemleri ve zincir röleleri.

Eski yolda olup modülde olmayan carousel ve video biçimleri F5b'de modüle taşınır. O zamana kadar kullanıcı "Open in Ads Manager" ile Meta'ya yönlendirilir.

---

## 3. Hedef mimari

### 3.0 Katmanlar ve veri akışı

```
[Arayüz]   Ads modül kartı + sohbet araçları · Ads sohbetindeki durum kartı ve günlük özet
           · "Ads account" sayfası · Integrations kutucuğu · işçi şeridi · /health (yalnız operatör)
     │ server action / araç                                         ▲ okuma (ayna)
     ▼                                                              │
[Motorlar] Planlama (F5b) ─spec──┐   Optimizasyon (F4) ──karar──┐   Raporlama (F6)
                                 ▼                              ▼          ▲
[Koruma rayları + onay]  zarf · hız sınırı · otonomi · rol · onay süresi · kill switch
     │ Task → Approval → ExecutionJob / Outbox  (+ onay anında inline sürüş)  │
     ▼                                                                        │
[Yazma yolu]  MetaApiProvider + AdsOperation      [Senkron + denetim]  yapı / sağlık / insights,
              doğrula → kur (kampanya PAUSED) → geri oku → aç          drift, bekçiler, AdsAlert, nabız
     │                                                            ▲
     ▼                                                            │
[Meta erişim katmanı]  graph çekirdeği · hata kataloğu · governor (kota, durum DB'de) · güvenli retry
                       · token sağlığı · appsecret_proof · (batch + async insights: F8)
     │                                                            ▲  webhook (F7)
     ▼                                                            │
[Meta]  Marketing API v26  +  Meta tarafı frenler: end_time / lifetime_budget, spend_cap  (Ad Rules: F7, isteğe bağlı)
[Veri]  AdsAccount (+ AdsAccountProject) · AdsObject · AdsInsightDaily · AdsOperation · AdsLaunch · AdsDecision · AdsAlert · SystemHeartbeat
```

**Optimizasyon karar akışı:**

```
Meta ──(senkron 30-60 dk; F7'de webhook)──▶ Ayna (AdsObject, AdsInsightDaily)
                                              ▼
                           Özellikler: pencereler, taban, öğrenme durumu, hedef KPI, tempo
                       ┌──────────────────────┴───────────────────────┐
                       ▼                                              ▼
           Koruma kuralları (sürekli)                  Optimizasyon kuralları (haftalık)
                       └─────────────── asgari veri + öğrenme kapısı ─┘
                                              ▼
              Aday karar ──▶ AI: açıklama + önceliklendirme (tutar değiştiremez, number-check)
                                              ▼
              Koruma rayları: zarf, hız sınırı, otonomi seviyesi, rol
                                              ▼
              AdsDecision (PROPOSED ya da SHADOW) ──▶ Onay (L4, 72 sa)  │  Guarded auto: yalnız risk azaltan
                                              ▼
              Yazma: AdsOperation + CAS (güncel değer = kararın "önce" değeri mi?) ──▶ Meta
                                              ▼
              Geri okuma → VERIFIED ──▶ veri olgunlaşınca değerlendirme (WORKED / DIDNT / INCONCLUSIVE)
                    │                                         │
                    ▼                                         ▼
              Tek dokunuş geri alma                     Brand Brain öğrenmesi + fikir havuzu
```

### 3.1 Meta API istemcisini sertleştirme

**Yeni dosyalar** (`src/server/integrations/meta/`):

- `version.ts`: tek `GRAPH_API_VERSION`.
- `graph.ts`: GET/POST/DELETE çekirdeği; zaman aşımları, `appsecret_proof` ve yanıt başlıklarının yakalanması.
- `errors.ts`: genişletilmiş `MetaApiError` ve `classifyMetaError()`.
- `error-catalog.ts`: kod/alt kod → sınıf, eylem ve kullanıcı mesajı tablosu.
- `governor.ts`: hesap başına kota kovası.
- `paging.ts`, `insights.ts` (senkron; async rapor ve `batch.ts` F8'de), `fields.ts` (seviye başına alan listeleri).
- `__fixtures__/`: kayıtlı Graph yanıtları.

**Değişen dosyalar:**

- `meta-client.ts`: domain fonksiyonları çekirdeği kullanır.
- `src/server/modules/analytics/meta-ads.ts`: kendi `graphGet`'i kalkar.
- `meta-api-provider.ts`.
- `error-classifier.ts` ve `provider-health.service.ts`.

| Konu               | Tasarım                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tipli sarmalayıcı  | Her uç için küçük bir fonksiyon yazılır. Yanıtlar zod ile ayrıştırılır ve yalnız kullanılan alanlar alınır; `fields` listeleri tek yerde durur. Token loglara asla yazılmaz.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sürüm yönetimi     | Tek sabit `v26.0` kullanılır; analytics'teki kopya kalkar. `X-Ad-Api-Version-Warning` başlığı sayılır ve /health'te gösterilir. Yükseltme adımları: dalda sürümü artır → fikstürleri yeni sürümde yeniden kaydet → test hesabında uçtan uca dene → yayınla. Bu adımlar için 90 günlük geçiş penceresi takvime yazılır. 27 Ekim 2026'da tüm sürümlere uygulanacaklar: protokol kaldırmaları (`GET /?ids=`, `date_format`, `pretty`, ETag), `delivery_estimate` alanlarının kalkması, Web+App kampanyalarında web-only kreatif kısıtı, Messenger story ve anket reklamlarının kaldırılması. Repo tarandı; protokol kalıpları kodda yok. |
| Uyarlamalı kısma   | `governor.ts` hesap başına puan kovası tutar: okuma 1, yazma 3 puan; anahtar her zaman Meta `act_` kimliğidir. Kova Dev'de 54 puan/300 sn, Full'da 8.000 puan/300 sn'dir (%10 pay bırakılmıştır). Durum süreç belleğinde değil DB'de tutulur (`AdsAccount.lastUsage`, `rateLimitedUntil`) ve her çağrıdan önce okunur; böylece deploy örtüşmesindeki iki kopya, GitHub cron tetiklemesi ve süreç içi tick aynı kovayı görür. Karar Meta başlıklarına göre verilir: `X-Ad-Account-Usage.acc_id_util_pct` ile `X-Business-Use-Case-Usage` içindeki `call_count`, `total_cputime` ve `total_time` yüzdelerinin en büyüğü (Meta kotayı CPU ve duvar saatiyle de ölçer); `X-FB-Ads-Insights-Throttle` ve `X-App-Usage` de okunur. Şeritler (v1'de üç): **P0** güvenlik (pause, kill switch) > **P1** kullanıcı işi (yazma ve okuma) > **P2** arka plan senkronu. Kullanım ≥ %75 ise P2 bekler, ≥ %90 ise yalnız P0 çalışır; kovada P0 için sürekli en az 12 puan rezerv tutulur. Blok hatasında `estimated_time_to_regain_access` ya da `reset_time_duration` kadar (yoksa sabit blok süresi, bkz. Retry) `rateLimitedUntil` yazılır. `ads_api_access_tier` başlığı kovanın boyutunu seçer. |
| Retry + jitter     | Kısa tekrar (2 sn / 8 sn / 30 sn, ±%25 jitter, en çok 3 deneme) yalnız TRANSIENT okumalara uygulanır. RATE_LIMIT ve CHANGE_LIMIT'te kısa tekrar yoktur; her tekrar yeniden hata alır, Full tier'ın hata oranını ve Insights kotasındaki "kullanıcı hatası" terimini kötüleştirir. İş, `estimated_time_to_regain_access` / `reset_time_duration` değeri ya da sabit blok süresi kadar ertelenir: Dev 300 sn, Full 60 sn, 613/1487632 → 60 dk, 17/1885172 → hesap gününün sonu. Süre dolunca her hesapta önce tek bir çağrıyla, jitter'lı olarak yeniden başlanır. Alt kodsuz 613 (Meta'nın kötüye kullanım koruması) gelirse o hesabın P1-P2 trafiği 1 saat durdurulur ve operatör uyarılır. Yazmalarda kör tekrar yoktur (bkz. idempotency). Zaman aşımları işlem türüne göre ayrılır: okuma 15 sn, yazma 30 sn, yükleme 120 sn (bugün hepsi 8 sn). |
| Idempotency        | Meta istemci tarafı idempotency anahtarı sunmuyor. Desen dört adımdır: (1) Yazmadan önce `AdsOperation` kaydı açılır: PENDING durumunda, `tag = agx:<6 karakter>` ile. (2) Etiket nesne adının sonuna eklenir, ör. `Spring offer · Traffic [agx:k3f9q2]` (alternatif `adlabels`, doğrulanmalı). (3) Zaman aşımı, 5xx ya da süreç ölümü olursa 30 sn ve 120 sn beklenip iki kez arama yapılır: ebeveyn kenarında `filtering=[{field:"name",operator:"CONTAIN",value:"agx:k3f9q2"}]`, sonuçtan `created_time ≥ sentAt − 60 sn` olanlar alınır (okuma tutarlılığı belgesiz olduğu için tek arama yetmez). Tek eşleşme → RECONCILED; birden fazla eşleşme → en eskisi alınır, diğerleri operatöre bildirilir. (4) Hiç eşleşme yoksa tek tekrar yapılır. Agentelse nesnesi adıyla değil, `AdsObject`'te saklanan `externalId` ve `launchId` ile tanınır; ad etiketi yalnız bu belirsiz pencerede kullanılır, çünkü Ads Manager'daki "Duplicate" etiketi de kopyalar. Görsel yükleme içerik hash'li olduğu için zaten idempotenttir. Durum ve bütçe güncellemeleri mutlak değerle ve CAS ile yapılır: önce güncel değer okunur; kararın "önce" değeriyle eşleşmiyorsa uygulanmaz (SUPERSEDED). |
| `validate_only`    | Onaydan önce yalnız ebeveyn gerektirmeyen nesneler Meta'da doğrulanır: kampanya (`/act_x/campaigns`) ve kreatif (`/act_x/adcreatives`) için `execution_options=["validate_only"]` (+ `include_recommendations`). Ad set doğrulaması `campaign_id` ister; alternatifi `campaign_spec` yalnız name, objective ve buying_type taşıdığı için kampanya düzeyindeki kuralları (özel kategori, bütçe paylaşımı, `spend_cap`) test edemez. Reklam için satır içi `adset_spec` + satır içi `creative` ile `/ads` `validate_only` + `synchronous_ad_review` denenebilir; bu yol test hesabında çalıştığı kanıtlanana kadar bayrakla kapalıdır. Geri kalan ad set ve reklam hataları kurulum sırasında, kampanya PAUSED iken (harcamasız ve telafi edilebilir) yakalanır (§3.4). |
| Batch (F8)         | Yalnız okumalarda kullanılır (geri okuma, önizleme, çoklu nesne): en çok 50 alt istek. Batch atomik değildir; her alt yanıt ayrı değerlendirilir ve başarısız olanlar tek tek yeniden denenir. Yazmalar niyet günlüğünü basit tutmak için sıralı kalır. KOBİ hacminde (hesapta 10-60 nesne) gerekmez; ajans ölçeğinde (F8) eklenir. |
| Async insights (F8) | v1'de (F1-F7) async kullanılmaz: boyut hatasında aralık bölünür, 90 günlük ilk yükleme 30 günlük senkron parçalarla yapılır. F8'de şu durumlarda async rapora geçilir: bölünmüş senkron çağrı yine `100/1504018`, `2/1504038`, `100/1487534` hatası verirse. Akış: `POST /act_x/insights` → dönen `report_run_id` iş durumunda saklanır (30 gün geçerli) → her tick'te tek durum kontrolü yapılır → `Job Completed` olunca sonuç sayfa sayfa okunur. `Job Skipped` gelirse istek yeniden gönderilir. Async işler hesap başına günlük bir sayaçla sınırlanır; kota kesinleşene kadar temkinli değer min(10, aktif reklam sayısı) kullanılır (Meta'nın 8 Mayıs 2026 OCC notu; yalnız opt-in kırılımlara mı uygulandığı belirsiz). Kota dolunca iş ertesi güne kalır ve bilgi uyarısı gösterilir. Kırılımlı ve 13 aydan eski reach verisi için hesap başına günde 10 istek sınırı (`x-Fb-Ads-Insights-Reach-Throttle`) ayrıca sayılır. |
| Sayfalama          | `requestAllPages`, `{ items, truncated }` döndürür; kırpma olursa loglanır. `/me/adaccounts` artık sayfalı çekilir ve `account_status, timezone_name, currency, business, user_tasks` alanlarını içerir.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Hata sınıflandırma | `MetaApiError` şu alanlarla genişler: `code`, `subcode`, `type`, `userTitle`, `userMessage`, `blameFieldSpecs` (`error_data.blame_field_specs`: hatalı alanın yolu), `fbtraceId`, `isTransient`, `httpStatus`. Karar mesaj metnine göre değil, yalnız kod, alt kod ve çağrı ailesine göre verilir (§3.6). Kullanıcıya `error_user_msg` gösterilir; Review formunda hata `blameFieldSpecs` ile ilgili alana bağlanır. `fbtrace_id` loglanır ve /health'te (yalnız operatör) görünür. |
| Devre kesici       | Kesici çağrı ailesine göre ayrılır: (a) Graph platform hataları (alt kodsuz kod 4, 32) yalnız organik Page/IG okumalarını durdurur; Marketing API, Graph platform limitlerinden muaftır. (b) Insights hataları (4/1504022, 4/1504039, 80000) yalnız insights senkronunu durdurur. (c) Ads Management yazmaları yalnız TRANSIENT/5xx hatalarında ve hesap bazında durur. VALIDATION, POLICY, ACCOUNT, AUTH ve PERMISSION hataları hesap düzeyinde kalır (`AdsAccount.healthStatus`) ve global `meta-api` sağlığını düşürmez. P0 güvenlik yazmaları hiçbir yerel kesiciye takılmaz; yalnız Meta'nın kendi blok süresine uyar. Böylece tek bir organik okuma kotası bütün müşterilerin reklam yazmalarını ve güvenlik durdurmalarını kilitleyemez. |
| Güvenlik           | Tüm çağrılara `appsecret_proof` eklenir; ardından Meta panelinde "Require App Secret" açılır. 3 Ekim'deki (#4) olayının asıl tüketicisi sağ paneldeki Instagram kartıydı ve düzeltildi: Page token süreç içinde 30 dk önbellekte, overview 15 dk önbellekte, limitte 30 dk duraklama var. Facebook yolu zaten Page token kullanıyor; Instagram Login ise ayrı uygulama kimliğiyle `graph.instagram.com`'a gidiyor ve bu kotayı tüketmiyor. Kalan kaynak ölçülerek bulunur: F1'de her Graph yanıtındaki `X-App-Usage` (`call_count`, `total_time`, `total_cputime`) çağrı noktası etiketiyle 48 saat loglanır ve en çok tüketen nokta düzeltilir. Aday düzeltmeler: türetilen Page token'larının (süresiz) şifreli olarak DB'de saklanması (bellek önbelleği her deploy'da sıfırlanıyor; yalnız 190'da yeniden türetilir) ve `/me/accounts` ile `/me/adaccounts` sonuçlarının 1 saat önbelleklenmesi. |

Kısa arayüz taslağı:

```ts
type Lane = "P0_SAFETY" | "P1_USER" | "P2_BACKGROUND";
type MetaErrorClass =
  | "TRANSIENT"
  | "RATE_LIMIT"
  | "CHANGE_LIMIT"
  | "VOLUME_LIMIT"
  | "AUTH"
  | "PERMISSION"
  | "APP_ACCESS"
  | "VALIDATION"
  | "POLICY"
  | "ACCOUNT"
  | "STATE"
  | "CREATIVE_SOURCE_GONE"
  | "TERMS_REQUIRED"
  | "INSIGHTS_SIZE"
  | "VERSION"
  | "UNKNOWN";

// Durum DB'de (AdsAccount.lastUsage, rateLimitedUntil); anahtar Meta act_ kimliği.
interface MetaGovernor {
  acquire(adAccountId: string, lane: Lane, points: 1 | 3): Promise<void>; // bekletir ya da RateLimitedError
  observe(
    adAccountId: string,
    res: { headers: Headers; error?: MetaErrorClass },
  ): Promise<void>;
}
```

### 3.2 Senkronizasyon katmanı (ayna)

**Yeni dosyalar** (`src/server/ads/sync/`): `runner.ts` (tick adımı ve hesap kilidi), `health.ts`, `structure.ts`, `insights.ts`, `drift.ts`. Ayrıca `src/lib/ads/results.ts` ve `src/lib/ads/money.ts` eklenir.

**Değişen dosyalar:** `agency-wiring.ts` (`meta-ads-sync` adımı; `META_ADS_SYNC` açıkken eski `meta-ads-performance-scan` adımı atlanır), `meta-ads-query.ts`, `ads-pulse.ts`, `work-ads-actions.ts`, `modules/analytics/meta-ads.ts`. `meta-performance-scanner.ts` aynaya uyarlanmaz: ZERO_RESULTS, HIGH_CPA ve AD_FATIGUE mantığı doğrudan G/O kurallarına taşınır, dosya F4'te silinir.

| Senkron          | Uç ve alanlar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Sıklık                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Hesap sağlığı    | `GET /act_x?fields=account_status,disable_reason,currency,timezone_name,spend_cap,amount_spent,min_daily_budget,min_campaign_group_spend_cap,funding_source_details,capabilities,user_tasks,business,is_personal,failed_delivery_checks,default_dsa_payor,default_dsa_beneficiary`, `GET /act_x/minimum_budgets` (24 sa önbellek) ve `GET /act_x/adspixels?fields=id,name,last_fired_time,is_unavailable`. `funding_source_details` için MANAGE/ADVERTISE görevi gerekir. | 6 saatte bir, ayrıca her yazmadan önce (15 dk önbellekle) |
| Yapı             | Hesap kenarları: `/act_x/campaigns`, `/act_x/adsets`, `/act_x/ads`. `effective_status` süzgeci ARCHIVED'ı da içerir (Meta arşivlenmiş nesneleri ancak açıkça istenirse döndürür). Alan listeleri seviye başına ayrıdır (`fields.ts`), çünkü düğümde olmayan bir alan bütün çağrıyı kod 100 ile düşürür. **CAMPAIGN:** `id,name,status,configured_status,effective_status,objective,daily_budget,lifetime_budget,spend_cap,budget_remaining,bid_strategy,special_ad_categories,issues_info,created_time,updated_time`. **ADSET:** `id,name,campaign_id,status,configured_status,effective_status,optimization_goal,billing_event,destination_type,promoted_object,targeting,learning_stage_info,daily_budget,lifetime_budget,budget_remaining,start_time,end_time,issues_info,created_time,updated_time`. **AD:** `id,name,adset_id,status,configured_status,effective_status,creative{id,effective_object_story_id},ad_review_feedback,failed_delivery_checks,issues_info,created_time,updated_time`. `targeting`'in yalnız hash'i saklanır. Sözleşme testleri her listeyi fikstürle doğrular | Teslimat aktifse 60 dk; boştaysa ve bitmiş (`end_time` geçmiş) nesnelerde 6 sa |
| Bugünkü insights | `/act_x/insights?level=account`; kampanya toplamları için kimlikle `/{campaign_id}/insights` (arşivlenen ve silinen alt nesneler dahil ebeveyn toplamı); `level=adset` ve `level=ad` listeleri (`filtering` ile ARCHIVED dahil `adset.effective_status` / `ad.effective_status` süzgeci). `time_range` = bugün, `time_increment=1` | Teslimat aktifse 30 dk (Meta veriyi 15 dk'da bir yeniler) |
| Pencere metrikleri | Ad set ve reklam düzeyinde `date_preset=last_7d` ve `last_28d` ile `reach`, `frequency`, `impressions`. Tekil kişi metrikleri günlük satırlardan toplanamaz; sonuç `AdsObject.windowStats`'a yazılır | Yapı senkronuyla birlikte (60 dk) |
| Geri doldurma    | Son 28 gün, aynı seviyeler. Silinen Agentelse nesneleri (`AdsObject.goneAt`) son teslimattan sonra 28 gün boyunca kimlikle `/{id}/insights` ile ayrıca doldurulur. 28 günden eski satırlar `isFinal` olarak işaretlenir | Günlük, hesap saatiyle 04:00 |
| İlk yükleme      | Son 90 gün; 30 günlük senkron parçalar (async rapor F8'de) | Hesap bağlanınca bir kez |

**Para kararları ve arşivlenen/silinen nesneler.** Meta, `/<ebeveyn>/insights?level=<seviye>` listelerinde ARCHIVED ve DELETED nesnelerin istatistiklerini döndürmez; bunlar yalnız ebeveynin toplamında ve kimlikle yapılan `/{id}/insights` çağrısında vardır. Silinen bir reklam son teslimattan sonra 28 gün daha olay toplayabilir. Bu yüzden:

- Para kararları (tempo, G1/G2, zarf, rapor toplamları) yalnız `level=account` satırından ve kampanya için kimlikle yapılan `/{campaign_id}/insights` çağrısından hesaplanır. Alt satırların toplamı para kararında kullanılmaz. (`level=campaign` listesinin silinen alt reklamları da içerdiği test hesabında doğrulanırsa kampanya okuması tek çağrıya indirilir.)
- Silinen nesnelerin kimliği `AdsObject`'te kalır (`goneAt`, `lastDeliveryAt`).
- Teslimat almış nesne ARCHIVED yapılır; DELETED yalnız hiç gösterim almamış nesneye ya da son teslimattan 28 gün sonra uygulanır.
- Yapı senkronunda listede görünmeyen bir Agentelse nesnesi önce `/{id}?fields=effective_status` ile okunur; ARCHIVED ya da DELETED ise OBJECT_MISSING değil "Archived in Ads Manager" olarak işaretlenir.
- `end_time`'ı geçmiş nesne UI'da "Completed" olarak gösterilir ve boştaki senkron sıklığına (6 sa) düşer.

**Insights alanları:** `spend`, `impressions`, `reach`, `frequency`, `clicks`, `inline_link_clicks`, `inline_link_click_ctr`, `cpm`, `results`, `cost_per_result`, `result_rate`, `actions`, `action_values`, `cost_per_action_type`, `video_thruplay_watched_actions`, `purchase_roas`, `attribution_setting`; reklam düzeyinde ek olarak `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`. 3 saniyelik oynatma `actions` içindeki `video_view`'dan okunur.

Kaldırılan pencereler (`7d_view`, `28d_view`) istenmez; 12 Ocak 2026'dan beri boş dönüyorlar. Opt-in isteyen kırılımlar da istenmez: `impression_device`, saatlik kırılım ve `frequency_value` opt-in olmadan HTTP 200 ile boş döner.

**Sonuç** (`src/lib/ads/results.ts`). "En yüksek sayılı action" sezgisinin yerine Meta'nın kendi alanları geçer. Insights'tan `results`, `cost_per_result` ve `result_rate` istenir (ayrıca `objective_results` ve `cost_per_objective_result`); bunlar Ads Manager'ın "Results" sütununu amaç ve ayarlara göre doğrudan verir. `AdsInsightDaily.results` bu alandan (gösterge + değer) yazılır; biçim fikstürle doğrulanır. Aşağıdaki eşleme tablosu yalnız iki iş için kalır: (a) `results` boş döndüğünde yedek; (b) testlerde çapraz kontrol. Ads Manager'la fark %1'i aşarsa SYNC_DATA_GAP uyarısı açılır. F0b'de bu tablonun küçük ilk sürümü eski tarayıcı için gelir (LINK_CLICKS, REACH, POST_ENGAGEMENT).

| `optimization_goal` (+ bağlam)                          | Sonuç olarak sayılan                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| LINK_CLICKS                                             | `link_click`                                                                |
| LANDING_PAGE_VIEWS                                      | `landing_page_view`                                                         |
| POST_ENGAGEMENT                                         | `post_engagement`                                                           |
| REACH / IMPRESSIONS                                     | `reach` / `impressions` alanı                                               |
| THRUPLAY                                                | `video_thruplay_watched_actions`                                            |
| LEAD_GENERATION / QUALITY_LEAD (ON_AD)                  | `lead` (ya da `onsite_conversion.lead_grouped`)                             |
| CONVERSATIONS (WHATSAPP / INSTAGRAM_DIRECT / MESSENGER) | `onsite_conversion.messaging_conversation_started_7d`                       |
| OFFSITE_CONVERSIONS + PURCHASE / LEAD                   | `offsite_conversion.fb_pixel_purchase` / `offsite_conversion.fb_pixel_lead` |
| VALUE                                                   | `purchase` + `action_values` (ROAS)                                         |

Action adları test hesabında doğrulanmalı. `results` alanı boş dönen ve eşlemesi de olmayan bir hedefte UI "Results unknown" gösterir; tahmin yapılmaz.

**Saat dilimi:**

- Hesabın `timezoneName` değeri saklanır.
- Tarih anahtarı, Meta'nın döndürdüğü `date_start` değeridir, yani hesabın yerel günüdür.
- "Bugün" ve tempo hesapları hesap saatine göre yapılır.
- Proje saat dilimi farklıysa UI'da "Account time (Europe/Istanbul)" etiketi gösterilir.
- Saat hesaplarında (ör. `end_time`) hesabın IANA adı kullanılır; `timezone_offset_hours_utc` kullanılmaz, çünkü yaz saati uygulayan hesaplarda (ör. Europe/Skopje) kayar.
- Zamanlamalar (özet, rapor) proje saat dilimiyle yapılır.

**Para birimi:**

- Tüm para alanları minor unit olarak `BigInt` tutulur; repository katmanında `number`'a çevrilir (2^53 sınırı yeterli) ve istemciye `bigint` gitmez.
- Insights'tan gelen `spend` ana birimde ondalıklı metindir; `src/lib/ads/money.ts` ile minor unit'e çevrilir.
- `minorUnitOffset` ve `ZERO_DECIMAL_CURRENCIES` artık tek kaynaktır; bugün `src/lib/module-flows/ads/state.ts` ve `src/lib/works/ads-insight.ts` içinde dağınıktırlar.

**Drift (Ads Manager'da elle yapılan değişiklik):**

- **Tanım:** Drift, izlenen alanlardan birinde değişikliktir: `configured_status`, bütçeler, `end_time`, `spend_cap`, `bid_strategy`, targeting hash'i, kreatif kimliği. Yalnız `updated_time`'ın değişmesi drift değildir; Meta bu alanı inceleme sonucunda da değiştirir. Bizim `AdsOperation` kayıtlarımızla (bütün projelerinkiler) ya da F7'deki Ad Rules geçmişiyle (`adrules_history`) açıklanan değişiklik de drift sayılmaz.
- **Algılama:** Açıklanamayan bir değişiklikte "Changed in Ads Manager" INFO uyarısı açılır ve o nesnedeki açık kararlar SUPERSEDED olur.
- **Zarfı aşan değişiklik:** Bütçe artışı, bitiş tarihinin kaldırılması ya da `spend_cap` silinmesi WARN uyarısı üretir ve "Update plan" ya da "Revert" önerilir. Otomatik geri alma yapılmaz.

**Kilit ve hata durumu:**

- `AdsAccount.syncLeaseUntil` değeri CAS ile (`updateMany where syncLeaseUntil < now`) 5 dakikalık bir kilit olarak alınır. Kilit Meta hesabı başınadır: aynı hesap birden çok projeye bağlı olsa bile tek kez senkronlanır (§4).
- Tick başına en çok 3 hesap işlenir.
- Hata alan hesap için üstel geri çekilme uygulanır: 5 dk'dan başlar, 6 saate kadar çıkar.
- 190 hatasında bağlantı EXPIRED yapılır ve o hesabın senkronu durur.
- Senkron ve bekçiler `Project.status`'tan bağımsızdır: bağlantı ACTIVE ve hesapta son 7 günde harcama varsa, proje PAUSED ya da ARCHIVED olsa bile izlenir. Uyarı başlığında "Project paused in Agentelse, ads still running in Meta" yazar.

**Okuyucuların aynaya geçişi:**

- "Ads account" sayfası, Works "Check performance", Analytics'in Meta bölümü, sohbetteki `META_ADS_ANALYSIS` ve `IdeaFoundry.performanceSnapshotForProject` artık aynadan okur.
- Canlı Graph çağrısı yalnız "Refresh" düğmesiyle yapılır: P1 şeridinde, hesap başına 5 dakikada bir.
- `META_ADS_SYNC` kapalıyken okuyucular eski canlı yolu kullanır; ayna yalnız bayrak açıkken kaynaktır. Böylece bayrak kapatılarak geri dönülebilir.

### 3.3 Planlama motoru

**Girdiler:**

- **Brand Brain:** işletme tipi, teklif, marka sesi, never-rules, approved claims, öğrenmeler.
- **`ProjectGoal`:** hedef KPI.
- **Brief:** bütçe, süre ya da always-on seçimi, ülke/şehir, link; KPI için "Average sale value" ve "Out of 10 leads or chats, how many become customers?" (ya da doğrudan "Max cost per lead"); mesaj hedefinde ortalama yanıt süresi (kullanıcının beyanı).
- **Bağlantılar:** piksel var mı, IG hesabı bağlı mı, WhatsApp numarası var mı.
- **Hesap geçmişi:** aynadaki 28 günlük taban CPA, CTR ve CPM.
- **Fikir havuzu ve organik başarılılar:** "worked" olarak işaretlenen postlar.

**Amaç karar ağacı** (`src/server/ads/planner/objective-tree.ts`, `src/lib/ads/objectives.ts`'teki ODAX tablosuyla doğrulanır):

| İşletme durumu                                | Önerilen kurgu                                                               | Not                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Yerel hizmet, satış DM/WhatsApp ile yapılıyor | Mesaj hedefi (WHATSAPP / INSTAGRAM_DIRECT / MESSENGER), CONVERSATIONS | Yanıt süresi uzunsa: FIXED (`lifetime_budget`) kurguda `adset_schedule` ile mesai saatleri uygulanır (`timezone_type: ADVERTISER`, tam saat, en az 1 saat); ALWAYS_ON'da zamanlama yapılamaz, onun yerine Meta'nın Instant Reply / Away message ayarı kurdurulur. Click-to-WhatsApp için Sayfaya bağlı WhatsApp numarası önkoşuldur. WhatsApp Business Platform kullanan markada CTWA sohbeti, işletme 24 saat içinde yanıt verirse 72 saat ücretsizdir |
| Yerel hizmet, randevu/teklif formu            | OUTCOME_LEADS, ON_AD (anında form, "Higher intent"), LEAD_GENERATION         | Form oluşturmak için `pages_manage_ads` gerekir (§7)                                              |
| Site var, piksel var                          | Satış: OUTCOME_SALES + OFFSITE_CONVERSIONS/VALUE. Trafik: LANDING_PAGE_VIEWS | Ön koşul: piksel/dataset sağlıklı                                                                 |
| Site var, piksel yok                          | Mesaj ya da form. Trafik zorunluysa LINK_CLICKS, uyarıyla                    | "Tıklamaya optimize etme" uyarısı gösterilir; tek tık CAPI önerilir                               |
| Instagram büyümesi                            | Trafik + Instagram profil hedefi                                             | API desteği doğrulanmalı; yalnız IG yerleşimlerinde çalışır                                       |
| Yerel bilinirlik                              | OUTCOME_AWARENESS, REACH, frekans 7 günde 2-3                                | Sonuç "satış" olarak raporlanmaz                                                                  |
| Organikte iyi giden post                      | Mevcut post ile reklam (post ID)                                             | Sosyal kanıt korunur; organik ön test yerine geçer                                                |
| Sağlık/wellness işletmesi                     | Mesaj ya da form                                                             | Alt huni olay kısıtları nedeniyle                                                                 |

**Yapı:**

- Varsayılan: 1 kampanya + 1 ad set (always-on).
- Ad set sayısı en çok `max(1, haftalık bütçe / (50 × hedef CPA))` olur.
- Yeni kampanya yalnız §1.3'teki gerekçelerle açılır.
- Planlayıcı önce "mevcut kampanyaya ekle" seçeneğini önerir.
- `smart_promotion_type` gönderilmez; Advantage+ durumu üç kaldıraçtan türetilir ve `advantage_state_info` okunarak rozet olarak gösterilir.

**Kitle:**

- `targeting_automation.advantage_audience=1` açık gönderilir (F5b'den itibaren varsayılan; F0b'de bugünkü sert yaş/cinsiyet davranışını korumak için 0).
- Yaş ve cinsiyet öneri olarak (`age_range`) verilir; Brief'te "Suggest / Limit to" ayrımı sunulur.
- Sert sınırlar: konum (+ yarıçap), asgari yaş (≤ 25), dil, hariç tutma listeleri (exclusion-only audiences).
- Özel kategoride (HEC) `advantage_audience` açıkça 1 ya da kullanıcının seçtiği değer olarak gönderilir; Meta bu kategorilerde Advantage+ audience'ı destekler. Kategori kısıtları §3.9'daki gibi uygulanır.
- İlgi alanları sabit listeden değil, canlı `targetingsearch` ile önerilir.

**Kreatif matrisi** (`creative-matrix.ts`):

- Ad set başına 3-6 reklam ve en az 3 konsept olur. Konseptler beş boyuttan en az üçünde farklılaşmalıdır: içerik stili, mesaj teması, hook, format, kişi/görsel kimlik.
- Her reklamın 4:5 ve 9:16 varyantı üretilir ve ikisi tek reklamda `asset_feed_spec` + yerleşim kurallarıyla bağlanır (§3.4); ayrı reklam açılmaz, çünkü bu yazma sayısını artırır ve öğrenmeyi böler. 9:16 için güvenli alan: üstte %14, altta %35, yanlarda %6 (muhtemel).
- Ana metin en fazla 125 karakterdir.
- Kaynaklar: onaylı/yayınlanmış postlar, organik başarılılar, fikir havuzundaki `ads` fikirleri.
- Biçim uyarlaması `adaptFromAssetId` ile yapılır; politika lint'i uygulanır.

**KPI hedefi:**

- Brief iki soru sorar: "Average sale value" ve "Out of 10 leads or chats, how many become customers?". Başabaş CPL = satış değeri × kapanış oranı × pazarlama payı (varsayılan %30, kullanıcı değiştirebilir). Hedef CPL başabaşın %70'idir; hedef CPA için kapanış oranı 1 alınır.
- Kullanıcı isterse doğrudan "Max cost per lead" girer. Hiçbiri girilmemişse ilk 14 gün hedefsiz çalışılır ve hesabın kendi 28 günlük CPL'i taban olur.
- Gerekçe: ilk taslaktaki "değer × kabul oranı (%25)" formülü müşteri değerini lead değeriyle karıştırıyordu; 1.000 TRY'lik bir müşteri değeri 250 TRY hedef CPL verir, TR'de tipik CPL ise 25-80 TRY'dir ve O2, O3, G3 hiç tetiklenmezdi.
- Hedef `ProjectGoal`'a `status=ACTIVE` ve `approvedByType=USER` ile yazılır (`metricKey`: `ads.cpl`, `ads.cpa`, `ads.cost_per_conversation`, `ads.roas`); varsayılan statü PROPOSED olduğu için bu açıkça verilir.
- `currentValue` haftalık güncellenir; bugün bu alanı hiçbir kod yazmıyor.

**Öğrenme fizibilitesi:** Günlük bütçe hedef CPA × 50/7'den küçükse kullanıcıya iki seçenek sunulur: daha sık gerçekleşen bir olaya geçmek (satış yerine lead ya da mesaj) ya da "Learning limited" durumunu bilerek kabul etmek.

**Bütçe:**

- **FIXED** (toplam tutar + tarih aralığı): `lifetime_budget` + `start_time`/`end_time`.
- **ALWAYS_ON:** günlük bütçe + ad set `end_time` = 30 günlük zarfın sonu (§3.4, §3.9).
- Onay kartı iki tutar gösterir. **Net zarf**, Meta'nın `spend` değeridir; zarf, `spend_cap` ve G2 bununla çalışır. **Tahmini brüt fatura** = bütçe × (1 + Σ hedef ülke payı × o ülkenin konum ücreti) × (1 + KDV).
- Konum ücreti reklamverenin değil, reklamın gösterildiği ülkeye göre alınır (1 Temmuz 2026'dan beri; ör. TR %5, AT %5, FR/IT/ES %3, UK %2). Bütçe ve CBO bu ücreti hesaba katmaz; ücret Insights `spend` değerinde de görünmez (ikincil kaynaklar, doğrulanmalı).
- KDV reklamverenin ülkesine ve hesabın `is_personal`/vergi durumuna göre uygulanır. Ücret tablosu tek yerde ve tarihli tutulur (`src/lib/ads/fees.ts`).

**Tahmin:**

- `reachestimate` kitle aralığını verir; `-1` dönerse "Meta bu kitle için tahmin vermiyor" gösterilir.
- `delivery_estimate` kullanılır; v26'da `daily_outcomes_curve`, `budget_guardrail` ve `estimate_dau` alanları yok.
- Sonuç aralığı = haftalık bütçe / taban CPA. Taban CPA hesabın 28 günlük geçmişinden gelir; geçmiş yoksa geniş bir bant kullanılır. Tahmin her zaman "directional" etiketiyle gösterilir.
- Kitlenin üst sınırı 100 binin altındaysa "dar kitle" uyarısı verilir.

**Test planı:**

- KOBİ'de ayrı test kampanyası açılmaz; yeni konseptler always-on ad set'e haftalık olarak toplu eklenir.
- Bütçe yaklaşık 100 USD/gün ve üstündeyse Meta creative testing önerilebilir (F6+): 2-5 varyant, bütçenin en çok %20'si, 7-14 gün.

**LLM'in rolü:** Adları, metin varyantlarını ve gerekçe açıklamasını yazar. Amaç, yapı, sınırlar ve tutarlar deterministik koddan gelir; LLM bir tutar önerirse zarfa ve tavana kırpılır. Plan, sürümlü bir şemayla doğrulanır (`src/lib/module-flows/ads/state.ts` genişler).

**Dosyalar:**

- Yeni: `src/server/ads/planner/{plan,objective-tree,forecast,creative-matrix}.ts`, `src/lib/ads/objectives.ts`, `src/lib/ads/fees.ts`.
- Değişen: `src/server/modules/ads/{draft-plan,plan-prompt,brief-options,source-posts}.ts`, `src/components/module-flows/ads/{brief-step,plan-step}.tsx`, `src/server/ideas/idea-modules.ts`.

### 3.4 Oluşturma motoru

**Durum makinesi** (`AdsLaunch.status`):

```
DRAFT ─▶ MEDIA_PROCESSING ─▶ VALIDATED ─▶ AWAITING_APPROVAL ─▶ CREATING ─▶ CREATED_PAUSED ─▶ ACTIVATING ─▶ ACTIVE
         (yalnız video)                     │ 72 sa / bütçe, hedefleme,   │ hata       ("Create paused only" burada durur;
                                            │ amaç ya da kimlik değişti   ▼             "Turn on" ayrı bir L4 onayı ve yeni görevdir)
                                            ▼                          FAILED ─▶ "Fix and retry" (yeni görev, aynı launchKey; başarılı adımlar atlanır)
                                    EXPIRED / CANCELLED                  └────▶ "Discard" ─▶ DISCARDING ─▶ DISCARDED
```

- **Görev modeli:** `ExecutionService.dispatch` görev başına tek iş açar (`idempotencyKey = taskId:capability`). Bu yüzden her deneme ayrı bir Task'tır: "Fix and retry", "Turn on" ve "Discard" yeni bir Task açar. Bütçe, hedefleme, amaç ya da kimlik değiştiren "Fix and retry" ile "Turn on" yeni bir L4 onayı ister. Yalnız Meta'nın `blame_field_specs` ile gösterdiği metin veya format düzeltmesinde yeni görev, 72 saati dolmamış ilk onaya (`AdsLaunch.approvalId`) bağlanır. `AdsOperation.launchId` hepsini aynı `AdsLaunch`'a bağlar ve SUCCEEDED adımlar atlanır. Kart başına aynı anda en çok bir açık lansman görevi olur.
- **Asenkron adım makinesi:** `META_LAUNCH`, bugünkü video bekleme (`PendingVideoAd`) desenini izler. `execute()` lansman planını `ExecutionJob.rawResult`'a yazıp hemen döner. `getStatus()` her yoklamada governor'ın izin verdiği kadar adımı (en çok 3 yazma) ilerletir ve sonucu `AdsOperation`'a yazar. Böylece Dev kovasındaki kota beklemesi tick'in 5 dakikalık bekçisini ya da kullanıcının isteğini bloklamaz.
- **MEDIA_PROCESSING (F5b, video):** Video yüklemesi Review adımında başlar (onaydan önce, harcamasız). Her tick'te bir kez `GET /{video_id}?fields=status` ile `video_status` ve `processing_progress` okunur. Video `ready` olmadan "Approve & launch" pasif kalır; `error` durumu kullanıcıya açıklanır. Büyük dosyada parçalı yükleme (`upload_phase` start/transfer/finish) kullanılır.

| #   | Adım | Ayrıntı | Meta çağrısı | Hata olursa |
| --- | ---- | ------- | ------------ | ----------- |
| 1   | Preflight | Token geçerli ve izinler tamam; `account_status=1`, `disable_reason=0`, ödeme yöntemi var; para birimi ve saat dilimi Brief'tekiyle aynı; `spend_cap` payı yeterli; IG kimliği P9'a göre seçilebiliyor; HEC'te `issues_info`'da 2859024 (sertifika) yok. Sayfa ve IG erişimi lansmandan hemen önce önbelleğe bakılmadan yeniden okunur. Başka bir servis yeniden bağlandıktan sonra `debug_token.granular_scopes` değişmişse PERMISSION uyarısı açılır, çünkü Meta'nın tek izni son diyalogda seçilen Sayfaları bütün servislere uygular | 0-3 (hesap: 15 dk önbellek; Sayfa/IG: taze) | Review'da engelleyici mesaj |
| 2   | Yerel doğrulama | §6'daki P kuralları: ODAX tablosu, asgari bütçe, hedefleme, DSA ve bölgesel düzenleme | 0 | Alan bazlı hata |
| 3   | Görsel yükleme + Meta ön kontrolü | Görseller `adimages`'a yüklenir (harcama yok, hash idempotent). Kampanya ve her kreatif için `validate_only`. Reklam için satır içi `adset_spec` + `creative` ile `validate_only` + `synchronous_ad_review` yalnız bayrak açıksa (test hesabında kanıtlanana kadar kapalı) | Görsel başına 1 yazma + doğrulamalar (puanı doğrulanmalı) | Meta'nın `error_user_msg`'i Review'da `blameFieldSpecs` ile ilgili alanda gösterilir |
| 4   | Önizleme | `/act_x/generatepreviews`, `ad_format`: `MOBILE_FEED_STANDARD`, `INSTAGRAM_STANDARD`, `INSTAGRAM_STORY`, `INSTAGRAM_REELS`, `FACEBOOK_STORY_MOBILE`, `FACEBOOK_REELS_MOBILE` | 4-6 okuma | 2606 hatasında kendi önizlememiz gösterilir, not düşülür |
| 5   | Tek onay (L4) | Gösterilenler: net zarf ve tahmini brüt fatura (konum ücreti + KDV), bitiş (hesap saatiyle; "Turning it on later does not move the end date."), hesap, Page/IG kimliği, amaç, kitle özeti (`act_x/targetingsentencelines`), önizlemeler ve "Meta may spend up to 1.75× your daily budget on some days; the weekly total stays within 7×." Onay 72 saat geçerlidir; bütçe, hedefleme, amaç ya da kimlik değişirse geçersiz olur | 0 | EXPIRED → "Approve again" |
| 6   | Kurulum (`META_LAUNCH`, asenkron) | Kreatifler → kampanya (PAUSED) → ad set (ACTIVE) → reklamlar (ACTIVE) → geri okuma ile doğrulama → aynaya yazma. Kampanya kapalı olduğu için teslimat başlamaz, Meta incelemesi ise başlar (doğrulanmalı). Ad set ve reklam düzeyindeki Meta hataları burada, harcamasız yakalanır | 3 reklamda ~8 yazma + geri okuma | Aşağıdaki telafi kuralları |
| 7   | Aktifleştirme | Tek yazma: kampanya ACTIVE (son ve tek kapı). Yarıda kesilse bile onaylanmamış bir alt küme teslimata çıkamaz. "Create paused only"de bu yazma yapılmaz | 1 yazma | ACTIVATING'de takılırsa bekçi devreye girer |
| 8   | Lansman sonrası | Kontrol noktaları: 1 sa inceleme, 24 sa teslimat ve tempo, 72 sa erken KPI, 7 gün öğrenme (F2 bekçileri) | 0 (aynadan) | Uyarı |

**Gönderilecek alanlar:**

- **Kreatif:**
  - Kimlik: `object_story_spec` içinde `page_id` + `instagram_user_id` (seçim sırası P9; eski `instagram_actor_id` hiç gönderilmez). Alternatif olarak mevcut post kullanılabilir: FB için `object_story_id`, IG için `source_instagram_media_id`. Uygulama dev moddayken `object_story_spec` reklam adımında 1885183 ile düşer; testte bu iki alternatif kullanılır (§8).
  - İki oran: tek reklam `asset_feed_spec` ile kurulur: `images = [{hash: 4:5, adlabels: [feed]}, {hash: 9:16, adlabels: [vertical]}]`; `asset_customization_rules` Feed ve IG Feed'i `feed`'e, Story ve Reels'i `vertical`'a bağlar (Meta en az iki kural ister). Bu kurgu test hesabında doğrulanana kadar tek 4:5 görsel + `adapt_to_placement` OPT_IN kullanılır.
  - Video (F5b): `video_data` içinde `video_id` ile birlikte kapak görseli için `image_hash` her zaman gönderilir (kapak `adimages`'a yüklenir). Carousel'de `video_id` içeren her kartta `image_hash` ya da `picture` zorunludur.
  - Bağlantı: `url_tags`.
  - Meta AI dönüşümleri: `degrees_of_freedom_spec.creative_features_spec` ile her özellik açıkça ayarlanır (K14). Yapay zekâyla içerik üreten ya da metni değiştiren özellikler OPT_OUT gönderilir: `image_templates`, `image_uncrop`, `image_background_gen`, `image_animation`, `video_uncrop`, `text_optimizations`, `enhance_cta`, `creative_stickers`, `text_translation`, `image_text_translation`, `translate_voiceover`. `adapt_to_placement` OPT_IN kalır; kapatılırsa Story/Reels'te görselin etrafında boşluk kalır. `image_brightness_and_contrast` marka ayarına göre belirlenir. `image_touchups` görseli otomatik kırpıp genişletir; yalnız tek görselli reklamda OPT_IN olur. Kreatif oluşturulduktan sonra `degrees_of_freedom_spec` geri okunur; listede olmayan yeni bir özellik açık görünürse uyarı verilir. Açık liste 3858082 hatasını da önler.
  - Çok reklamverenli reklamlar: `contextual_multi_ads.enroll_status` her kreatifte açıkça gönderilir (premium markalarda OPT_OUT, diğerlerinde marka ayarına göre) ve geri okunur. API varsayılanı belgede yazmadığı için test hesabında doğrulanır.
  - Görsel: `adimages`'a bayt olarak, Review adımında yüklenir.
- **Kampanya:**
  - Temel: `objective`, `special_ad_categories` (+ `special_ad_category_country`), `buying_type=AUCTION`, `status=PAUSED`; ABO'da `is_adset_budget_sharing_enabled=false`; adında `[agx:…]` etiketi.
  - `spend_cap` = max(`min_campaign_group_spend_cap`, kampanyanın şimdiye kadarki harcaması + kalan zarf × 1,1). Asgari değer hesaptan okunur (yaklaşık 100 USD karşılığı); daha düşük bir değer 2446307 hatası verir. `spend_cap` ömür boyu birikimlidir: aylık yenilemede yeni değer = güncel kampanya harcaması (kimlikle `/{campaign_id}/insights`, lifetime) + yeni zarf × 1,1. Yeni zarfı doğrudan yazmak kampanyayı hemen durdurur. Küçük TR KOBİ bütçelerinde asgari, zarfın birkaç katı olabilir; o zaman `spend_cap` yalnız felaket tavanıdır, asıl fren ad set `end_time`'dır.
- **Ad set:**
  - Bütçe: FIXED'de `lifetime_budget` + `start_time`/`end_time`. ALWAYS_ON'da `daily_budget` + `end_time` = zarf bitişi (başlangıç + 30 gün, hesap saatiyle 23:59; en çok 31 gün). Saat, hesap saat diliminin IANA adıyla hesaplanır. Meta, süresi 24 saati aşan günlük bütçeli ad set'te `end_time`'a izin verir. Aylık yenileme onayı `end_time`'ı 30 gün uzatır; onaylanmazsa Meta teslimatı kendisi durdurur. `end_time` uzatmanın öğrenmeyi sıfırlamadığı test hesabında doğrulanmalı.
  - Optimizasyon: amaç tablosundan `optimization_goal`, `billing_event`, `destination_type` ve `promoted_object`; `bid_strategy=LOWEST_COST_WITHOUT_CAP`.
  - Hedefleme: `targeting` + `targeting_automation.advantage_audience` (0/1, her zaman açık değer).
  - REACH hedefinde `frequency_control_specs` (7 günde 2-3 gösterim; doğrulanmalı).
  - Zamanlama: `adset_schedule` + `pacing_type=["day_parting"]` yalnız `lifetime_budget` ile kullanılır; `timezone_type: ADVERTISER` açıkça verilir (varsayılan izleyicinin saatidir), saatler tam saat ve en az 1 saat arayla.
  - AB/AEA hedefinde `dsa_beneficiary` ve `dsa_payor` (en fazla 512 karakter). Bölgesel düzenlemeye tabi ülkeler v1'de desteklenmez (P5).
  - Yerleşim gönderilmez (Advantage+ placements). v26'da Explore hata veriyor, Messenger Story sessizce siliniyor.
  - `status=ACTIVE`; kampanya PAUSED olduğu için teslimat yoktur.
- **Reklam:** `status=ACTIVE` (aynı nedenle), adı etiketli.

**Kısmi hata ve telafi:**

- **TRANSIENT:** Önce uzlaştırma yapılır, ardından tek tekrar.
- **VALIDATION, POLICY ya da ACCOUNT:** Yürütme durur, kullanıcı mesajı ilgili alanda (`blameFieldSpecs`) gösterilir ve kartta iki seçenek çıkar:
  - "Fix and retry": spec düzeltilir ve yeni bir görev açılır; aynı `launchKey` kullanıldığı için SUCCEEDED olan adımlar atlanır. Onay kuralı yukarıdaki görev modelindeki gibidir.
  - "Discard": kampanya düzeyinde tek yazmadır; alt nesneler durumu miras alır. Hiç gösterim almamış kampanya DELETED, almış olan ARCHIVED yapılır, çünkü silinen nesnenin harcaması yalnız kimlikle okunabilir (§3.2). Arşivlenmiş reklam sınırı doluysa (1487990) önce eski arşivler DELETED yapılır.
- Kullanıcı karar vermezse yarım lansman kampanya düzeyinde PAUSED kalır. F2'deki yetim nesne bekçisi 24 saat sonra temizlik önerir.

**Satır içi (inline) sürüş:** "Approve & launch" tıklandığında olay outbox'tan önce alınır ve sürüş onay eyleminde `after()` ile başlar (kod yazmadan önce `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` okunur). İstek beklemez; kart ilerlemeyi yoklamayla canlı gösterir. Süreç ölürse işçi niyet günlüğünden kaldığı yerden devralır. Bu, sahibin "sohbet eylemleri anında ve canlı olmalı" kuralını karşılar. Uzun iş isteğin içinde koşturulmaz: Next 16'da Server Action'lar istemci başına sıralı çalıştığı için aynı sekmedeki diğer eylemleri bekletirdi.

**Kreatif hattı:**

- Kaynak post ya da fikir havuzundaki "Make this ad" → mevcut kreatif üretim hattı → `adaptFromAssetId` ile 4:5 ve 9:16 → politika lint'i → spec (`asset_feed_spec`).
- Fotogerçekçi AI insan içeren görseller Review'da işaretlenir ("This ad may get Meta's AI info label").

**UTM:** Varsayılan değer şudur; Brand ayarında değiştirilebilir. Makrolar muhtemel, doğrulanmalı.

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.id}}&utm_term={{placement}}
```

**Dosyalar:**

- Yeni: `src/server/ads/launch/{spec,preflight,validate,preview,executor,compensate,meta-brakes}.ts`, `src/lib/ads/policy-lint.ts`.
- Değişen: `meta-api-provider.ts` (`META_LAUNCH` işleyicisi), `src/lib/module-flows/ads/{state,chain}.ts`, `src/components/module-flows/ads/{ad-steps,launch-step}.tsx`, `src/server/actions/ads-flow-actions.ts`, `src/server/modules/ads/chain.ts`, `src/server/chat/{tools.ts,skills/registry.ts}`, `src/server/commands/command-service.ts` (`META_CAMPAIGN_CREATE` artık modül kartını açar).

Kısa spec taslağı:

```ts
type AdsLaunchSpec = {
  version: 1;
  adAccountId: string;
  currency: string;
  timezone: string;
  pageId: string;
  instagramUserId?: string;
  objective:
    | "OUTCOME_TRAFFIC"
    | "OUTCOME_AWARENESS"
    | "OUTCOME_ENGAGEMENT"
    | "OUTCOME_LEADS"
    | "OUTCOME_SALES";
  specialAdCategories: string[];
  specialAdCategoryCountries?: string[];
  budget:
    | {
        mode: "FIXED";
        lifetimeMinor: number;
        startTime: string;
        endTime: string;
      }
    | {
        mode: "ALWAYS_ON";
        dailyMinor: number;
        envelopeMinor: number;
        envelopeEndsAt: string;
      };
  adSets: {
    name: string;
    optimizationGoal: string;
    billingEvent: string;
    destinationType?: string;
    promotedObject?: Record<string, string>;
    targeting: TargetingSpec;
    advantageAudience: 0 | 1;
    dsa?: { beneficiary: string; payor: string };
    frequencyControl?: { maxImpressions: number; days: number }; // yalnız REACH
  }[];
  ads: {
    name: string;
    adSetIndex: number;
    creative: CreativeSpec; // iki oran asset_feed_spec ile
    urlTags: string;
  }[];
  guards: {
    campaignSpendCapMinor: number; // max(asgari, harcanan + kalan zarf × 1,1)
    adSetEndTime: string; // FIXED: plan sonu; ALWAYS_ON: zarf sonu
    insuranceRules?: boolean; // F7, isteğe bağlı Ad Rules
  };
  kpi?: {
    metric: "CPL" | "CPA" | "COST_PER_CONVERSATION" | "ROAS";
    target: number;
  };
  activate: boolean; // false = "Create paused only"
};
```

### 3.5 Optimizasyon motoru

1. **Özellikler** (`src/server/ads/rules/features.ts`): Nesne başına şu pencereler hesaplanır: bugün, dün, 3 gün, 7 gün, önceki 7 gün ve 28 günlük taban. Her pencerede doğru sonuç ile CPA/CPL/ROAS, link CTR, CPM, sıklık ve hook/hold oranları tutulur. Erişim ve sıklık tekil kişi metrikleridir; 7 ve 28 günlük değerleri `AdsObject.windowStats`'tan okunur, günlük satırlardan hesaplanmaz. Ayrıca öğrenme durumu ve `last_sig_edit_ts`, hedef KPI ve tempo eklenir.
2. **Kurallar** (saf fonksiyonlar: `guard-rules.ts`, `optimize-rules.ts`): Her kural `{ key, version, minData, evaluate(features) }` biçimindedir. Birden çok bulgu döndürülebilir, böylece bugünkü "tek bulgu gölgelemesi" kalkar. Öncelik sırası ayrı tutulur. Kural tablosu §6'dadır.
3. **Kapılar** (`gates.ts`): asgari veri, öğrenme koruması, hız sınırı, istatistik kapısı ve zarf.
4. **AI katmanı** (`explain.ts`, ReasoningService):
   - Yapabilecekleri: adayları ve kanıtları alıp kısa bir İngilizce açıklama ve teşhis anlatısı yazmak; adayları birleştirmek ya da önceliklendirmek; gerekçesini kaydederek bir adayı bastırmak.
   - Yapamayacakları: yeni bir para eylemi üretmek ya da tutar değiştirmek.
   - Denetim: her sayı `src/lib/module-flows/analytics/number-check.ts` ile kontrol edilir. LLM çalışmazsa şablon metin kullanılır.
5. **Koruma rayları ve otonomi:** Sonuç bir `AdsDecision` olur (gölge modda SHADOW, aksi hâlde PROPOSED). Kayıt onaya ya da Guarded auto'ya gider.
6. **Uygulama:** İş yazma şeridinden geçer ve bir `AdsOperation` kaydı açılır. CAS uygulanır: `change.from` güncel değere eşit değilse karar SUPERSEDED olur. 2-5 dakika sonra geri okuma yapılır ve karar VERIFIED olur.
7. **Değerlendirme:** Meta verisi 28 güne kadar değişebilir (7 günlük tıklama atfı, geç gelen CAPI olayları). Bu yüzden değerlendirme, "sonra" penceresinin bitiminden en az 7 gün sonra yapılır; yalnız platform içi olaylarda (mesaj, anında form) 2 gün yeterlidir. İki pencere de karar anına göre aynı olgunluk gecikmesiyle yeniden çekilmiş verilerle karşılaştırılır ve kayıt kullanılan veri tarihini saklar. İstatistik kapısına göre sonuç WORKED, DIDNT ya da INCONCLUSIVE olur. DIDNT olan bir bütçe artışı için geri alma önerilir.
8. **Geri alma:** `previousState`'ten ters bir karar üretilir ve tek dokunuşla uygulanır. Harcamayı artıran bir geri alma da onay ister.

**Karar durumları:**

```
SHADOW (gölge mod; yalnız kayıt)
PROPOSED ─▶ APPROVED ─▶ APPLYING ─▶ APPLIED ─▶ VERIFIED ─▶ (veri olgunlaşınca) değerlendirme: WORKED / DIDNT / INCONCLUSIVE
   ├─▶ REJECTED (aynı kural ve nesne için 14 gün susar; önem artarsa yeniden gelir)
   ├─▶ EXPIRED (72 sa)          └─▶ FAILED
   └─▶ SUPERSEDED (nesne değişti ya da daha yeni bir karar var)       VERIFIED ─(geri al)─▶ ROLLED_BACK
```

- **Susturma:** REJECTED kararın 14 günlük susması parmak iziyle değil sorguyla yapılır: (`ruleKey`, `externalId`, `status=REJECTED`, `createdAt > now − 14 gün`). Haftalık parmak izi yalnız aynı haftada çift kaydı önler.
- **Öğrenme koruması:** Ad set LEARNING durumundayken ya da son anlamlı düzenlemenin üzerinden 72 saat geçmeden acil olmayan öneri yapılmaz. Ad set başına 24 saatte en çok 1 bütçe değişikliği (Meta'nın sert sınırı saatte 4) ve haftada en çok 2 anlamlı düzenleme yapılır. Değişiklikler haftalık pencerede birleştirilir.
- **Ölçekleme:**
  - Dikey: bütçe her adımda %20 artırılır, iki adım arasında en az 72 saat olur. Küçük bütçede adım en az 2-5 USD karşılığıdır.
  - Yatay: yeni konsept eklemek ya da kanıtlanmış organik postu reklama taşımak.
  - KOBİ'de asıl ölçekleme kaldıracı kreatiftir.
- **Kreatif yenileme döngüsü:**
  1. O4, O6, O7, O13 ya da O14 kuralı tetiklenir ve `CREATIVE_REFRESH` kararı oluşur.
  2. IdeaEngine, `ads` modül tipinde 2-3 konsept isteği üretir. Bağlam: neyin yorulduğu, kazanan açılar ve Brand Brain öğrenmeleri. Konseptler beş boyuttan en az üçünde farklıdır.
  3. Kullanıcı Ideas panosunda "Make this ad" der.
  4. Kreatif üretilir, 4:5 ve 9:16 varyantları çıkarılır, politika lint'inden geçer.
  5. Yeni reklamlar haftalık olarak toplu biçimde mevcut ad set'e eklenir (L3 onay; bütçe değişmez).
  6. Yeni reklamlar incelemeden geçince yorulan reklam için PAUSE önerilir.
  - Bu döngü bugünkü AD_FATIGUE → onaysız `CREATE_AD_CREATIVE` yolunun yerine geçer.
- **Gölge mod:** `META_ADS_OPTIMIZER=shadow` ile en az 30 karar ya da 4 hafta (hangisi önce gelirse) yalnız kayıt tutulur. KOBİ'de ad set başına haftada yaklaşık 1 karar çıktığı için karar sayısı yetmezse kurallar aynanın 28 günlük geçmişi üzerinde yeniden oynatılır (replay). Sahip örnekleri inceler; kabul oranı en az %60 olursa `on`'a geçilir.

**Dosyalar:**

- Yeni: `src/server/ads/rules/{features,guard-rules,optimize-rules,gates,stats}.ts`, `src/server/ads/{optimizer,decisions,explain}.ts`.
- Değişen: `src/server/execution/approval-details.ts`, `src/components/works/ads-insight-card.tsx`, `src/server/ideas/{idea-engine,idea-modules}.ts`.
- Kaldırılan (F4 sonunda): `performance-optimizer.ts`, `meta-performance-rules.ts`, `meta-performance-scanner.ts`.

### 3.6 Sürekli hata denetimi ve sağlık

**Hata taksonomisi** (`src/server/integrations/meta/error-catalog.ts`; tek karar kaynağı koddur, mesaj metni değildir; sınıf çağrı ailesine göre de değişebilir, bkz. §3.1 Devre kesici):

| Sınıf | Meta kodları (örnek) | Otomatik eylem | Kullanıcı mesajı (UI) |
| ----- | -------------------- | -------------- | --------------------- |
| TRANSIENT | 1 ve 2 (insights dışında), 2/1504043, -2/2490547, 3910001, 5xx, ağ hatası | Okumada kısa tekrar (en çok 3 deneme + jitter). Yazmada önce uzlaştırma, sonra tek tekrar | Gösterilmez. 3 deneme de başarısızsa: "Meta is having a temporary problem. We'll try again shortly." |
| RATE_LIMIT | 4 (+1504022, 1504039), 17 (+2446079), 32, 613 (+1487742, 5044001; alt kodsuz 613 = kötüye kullanım koruması), 80000-80014 | Kısa tekrar yok. Hesap ya da çağrı ailesi `rateLimitedUntil` kadar bekler (§3.1). P0 yerel olarak beklemez, yalnız Meta'nın blok süresine uyar. Alt kodsuz 613'te hesabın P1-P2 trafiği 1 saat durur ve operatör uyarılır | "Meta asked us to slow down. Updates resume in about 5 min." |
| CHANGE_LIMIT | 613/1487632 (ad set bütçesi saatte 4'ten fazla), 17/1885172 (hesap `spend_cap` günde 10'dan fazla) | Değişiklik bir sonraki saate/güne ertelenir; bekleyen değişiklikler birleştirilir | "Meta limits budget changes. Scheduled for 14:00." |
| VOLUME_LIMIT | 613/1487225 (reklam oluşturma sınırı) | Yalnız yeni reklam oluşturma durur; pause ve bütçe düşürme serbest kalır. Kaybeden ve yetim reklamların arşivlenmesi önerilir | "This ad account reached Meta's limit for ads. Archive old ads to add new ones." |
| AUTH | 190 (+458, 459, 460, 463, 464, 467), 102 | Bağlantı EXPIRED olur ve otomasyonu donar; aktif kampanya varsa CRITICAL | "Reconnect Meta Ads: your connection expired." (459 için: "Log in to Facebook to clear a security check.") |
| PERMISSION | 10, 200-299, 294, 3, 100/3191001, 1815199; 190/492 (Sayfa token'ının sahibinin Sayfada rolü yok: yalnız o Sayfaya bağlı özellik durur, bağlantı EXPIRED yapılmaz). 100/33 önce çözülür: ebeveyn kenarı ya da hesap okunur; nesne listede yoksa STATE (OBJECT_MISSING, aynada `goneAt`), hesap çağrısı da 100/33 dönüyorsa PERMISSION | Eksik izin ya da varlık kaydedilir; ilgili yazmalar durur | "Agentelse doesn't have permission to manage this ad account. Reconnect and allow it." |
| APP_ACCESS | 1885183 (dev moddaki uygulamanın gönderisi; sahibin test hesabında da); 270/272 (doğrulanmalı) | Yürütme durur; operatör uyarılır | "Meta hasn't approved Agentelse for this yet." |
| VALIDATION | 100 (genel), 1/99 (yanlış `level`), 1885272/1885650 (bütçe düşük), 1885621 (çift bütçe), 2446307 (kampanya `spend_cap` asgarinin altında), 4834011, 2446383, 2446509, 1815946, 1487694/2446394 (hedefleme seçeneği kalktı), 3858082, 3858152 (DSA), 3858634/3858636 (bölgesel faydalanıcı/ödeyici eksik), 1340029 (Dynamic Creative reklamı tek başına silinemez), 1870165, 1885204, 1885029 | Tekrar yok. Spec düzeltilir; tekrarlayan hata için yerel doğrulayıcıya kural eklenir; hedefleme seçeneği kalktıysa yeniden aranır | `error_user_msg` ya da katalog metni (ör. "Daily budget is below Meta's minimum of 35 TRY."), `blameFieldSpecs` ile ilgili alanda |
| CREATIVE_SOURCE_GONE | 2490155, 2446289, 1487472, 1885557 (tanıtılan gönderi silinmiş, yayından kalkmış ya da tanıtılamaz) | Aynı kaynakla yeniden denenmez; yeni kreatif önerilir | "The post behind this ad is gone or can't be promoted. Pick another post." |
| TERMS_REQUIRED | 2859024 (özel kategori sertifikası), 1870090, 1870092 (Custom Audience / Meta Business Tools şartları), 200/1870034 | İlgili yazma bekler; kullanıcıya kabul bağlantısı gösterilir | "Accept Meta's terms for this feature to continue." |
| POLICY | 368, 1404078/2859015, 1404163, 2490427/2490468 (yalnız ilgili reklamı kilitler), 2708008 | Hesap düzeyindeki ihlalde (368, 1404078) P1-P2 otomatik eylemleri 24 saat durur; P0 PAUSE her durumda denenir. Aynı içerik asla yeniden gönderilmez | "Meta blocked this for policy reasons. Review Account Quality in Meta." |
| ACCOUNT | `account_status` 2/3/7/8/9/100/101, PENDING_BILLING_INFO, 2446880 (Sayfaya ya da IG'ye bağlı WhatsApp numarası koptu; CTWA durur) | Yazma kapısı kapanır (3/8/9'da yalnız artış ve yeni kampanya, diğerlerinde P1-P2'nin tümü); P0 PAUSE her durumda denenir; uyarı açılır | "Your ad account has a payment issue. Pay in Meta Billing to resume." |
| STATE | 1487007, 1487033, 1487056, 1487566, 1885088; 1487990 (arşivlenmiş reklam sınırı dolu) | Ayna yenilenir; ilgili karar SUPERSEDED olur. 1487990'da önce eski arşivler DELETED yapılır | "This campaign has ended or was archived in Meta." |
| INSIGHTS_SIZE | 100/1487534, 100/1504018, 2/1504038, -3/1504045, 2/1504041; insights çağrısında alt kodsuz kod 1 ("reduce the amount of data") | Aynı istek tekrarlanmaz; aralık bölünür (async F8'de), kırılım kaldırılır | Gösterilmez |
| VERSION | 2635 | Operatör alarmı; sürüm yükseltilir | Gösterilmez |
| SILENT_EMPTY | Aktif ve harcayan nesne için HTTP 200 + boş veri | Anomali sayılır; SYNC_DATA_GAP uyarısı | "Meta returned no data for this period." |
| UNKNOWN | Diğerleri | Yazmada tekrar yok; `fbtrace_id` kaydedilir; tekrarlarsa operatör uyarılır | "Something went wrong at Meta (ref: …)." |

**Bekçiler** (`src/server/ads/guard/watchdogs.ts`; aynadan okur, Meta'ya çağrı yapmaz):

| Bekçi | Kontrol | Sıklık | Eşik | Eylem |
| ----- | ------- | ------ | ---- | ----- |
| İşçi nabzı | `SystemHeartbeat("worker.tick")`: tick başında `lastBeatAt`, sonunda `lastOkAt`; `data.maxGapMs24h` | Her sayfa isteğinde (şerit) + 5 dk'da bir (harici monitör) | Şeritte > 5 dk WARN, > 10 dk CRITICAL; harici monitör ≤ 15 dk içinde uyarır | Uygulama içi şerit + harici monitörden e-posta/Telegram |
| Senkron nabzı | Aktif hesaplarda `AdsAccount.lastInsightsAt` | 15 dk | > 2 sa | SYNC_FAILING |
| Takılan lansman | AdsLaunch CREATING/ACTIVATING; AdsOperation SENT/UNKNOWN | 10 dk | Operasyon > 10 dk; lansman > 30 dk | Uzlaştırma; çözülemezse CHAIN_STUCK |
| Yetim PAUSED nesne | Agentelse etiketli ama tamamlanmış bir lansmana bağlı olmayan PAUSED nesne. Adında etiket olup `launchId`'si olmayan nesne kullanıcının Ads Manager'daki kopyası olabilir: temizlik önerilmez, yalnız bilgi verilir | Günlük | > 24 sa | Temizlik önerisi (Guarded'da otomatik arşiv) |
| DB ↔ Meta uzlaşması | Son uygulanan kararın değeri ile aynadaki değer; bizim kurduğumuz nesnenin aynada olup olmadığı (listede yoksa önce kimlikle okunur; ARCHIVED/DELETED ise "Archived in Ads Manager") | Günlük + her yapı senkronunda | Fark varsa | DRIFT_DETECTED / OBJECT_MISSING |
| Token | `debug_token` (`is_valid`, `expires_at`, `data_access_expires_at`, `granular_scopes`) + `/me/permissions` | Günlük + bağlanırken | ≤ 14/7/1 gün kaldıysa; izin eksikse; hesap `target_ids` dışındaysa; başka bir servis yeniden bağlandıktan sonra `granular_scopes` değiştiyse | TOKEN_EXPIRING / PERMISSION_MISSING |
| Hesap / ödeme | `account_status`, `disable_reason`, funding, `spend_cap` payı | 6 sa + her yazmadan önce | ≠ 1, ≠ 0, ödeme yöntemi yok, ≥ %90 | ACCOUNT_BLOCKED / PAYMENT_ISSUE / SPEND_CAP_NEAR |
| Ret ve teslimat | `effective_status`, `issues_info` (HARD/SOFT), `ad_review_feedback`, reklamın ve hesabın `failed_delivery_checks`'i | Her yapı senkronunda | DISAPPROVED, WITH_ISSUES, PENDING_BILLING_INFO, 24 saati aşan PENDING_REVIEW, G8 koşulu (§6) | AD_DISAPPROVED / DELIVERY_ISSUE / NO_DELIVERY |
| Piksel sağlığı | `last_fired_time`, `is_unavailable` | 6 sa (piksel varsa) | > 24 sa | TRACKING_STALE |
| Harcama temposu | Bugünkü harcama ile o gün yürürlükteki en yüksek bütçe; hesap saatiyle Pazar 00:00'dan bu yana harcama ile o haftanın bütçe toplamı (G1). MTD harcama ile zarf yalnız aylık zarf ya da tavan tanımlıysa | 30 dk | G1 eşikleri; MTD ±%10 / ±%20 | PACING_OVER / PACING_UNDER (+ G1). Günlük bütçeli hesapta düşük teslimat yalnız G8 ile izlenir; Meta'nın normal ±%75 günlük dalgalanması uyarı üretmez |
| Metrik anomalisi | v1'de haftalık eşik kuralları (O kuralları) yeterli. 14 günlük, haftanın gününe göre düzeltilmiş tabanla CPM, CPA ve link CTR z-skoru F8'de (ajans ölçeği) | — | — | METRIC_ANOMALY (F8) |
| Kota | `rateLimitedUntil` sıklığı, `app_id_util_pct` | Saatlik | > %75 | RATE_LIMITED (operatöre) |
| Hata oranı | Yalnız ad account kapsamlı Marketing API çağrıları (insights dahil); `validate_only` ve RATE_LIMIT hataları ayrı sayaçta gösterilir. Son 500 çağrı süreç içi bir halka tamponda tutulur ve 15 dakikada bir `SystemHeartbeat("meta.calls")`'a anlık görüntüsü yazılır (günlük sayaçlardan "son 500" hesaplanamaz) | Saatlik | > %10 | ERROR_RATE_HIGH (operatöre; Full tier için şart < %15) |
| Onay birikimi | Bekleyen L4 onaylar | Günlük | > 48 sa | Hatırlatma; 72 saatte EXPIRED (görev CANCELLED) |

**DLQ triyajı:**

- META_* dead-letter kayıtları hata sınıfıyla etiketlenir.
- TRANSIENT sınıfındaki okumalar otomatik olarak yeniden kuyruğa alınır.
- `SelfHealing.requeueRecoverableDeadLetters` bugün ölü mektupları yetenek ayırmadan yeniden kuyruğa alıyor. F0a'dan itibaren META_* yazmalarını atlar; F1'de niyet günlüğü gelince bunlar uzlaştırmayla çözülür.
- Yazmalar önce niyet günlüğüyle uzlaştırılır; nesne oluşmuşsa kayıt çözülmüş sayılır. Kalanlar /health'te insan triyajına düşer. /health ve sağlık eylemleri F1'den itibaren yalnız platform operatörüne açıktır (§3.8).
- /health'teki "Retry" hatası düzeltilir. Bugün FAILED işi QUEUED'a çevirmeden yeni olay ekliyor (`health-actions.ts`); `self-healing.service.ts`'teki düzeltmenin aynısı uygulanır.
- `isolate()` ve DLQ'nun Telegram bildirimleri dedupe anahtarıyla bir saat sessize alınır; böylece 10 saniyede bir tekrarlayan uyarı yağmuru önlenir.

**Uyarı yönlendirme** (`src/server/ads/guard/alerts.ts`; `AdsAlert` LLM puanlamasından geçmez):

| Önem     | Örnek                                                                                                                                               | Kanal                                                                                                           | Yeniden bildirim                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| CRITICAL | Kaçak harcama, hesap kapandı, ödeme alınamadı, aktif kampanya varken token geçersiz, tüm reklamlar reddedildi, işçi 10 dakikadan uzun süredir durdu | Uygulama içi kırmızı şerit + Ads sohbetindeki kart; proje Telegram'ı (bağlıysa; yalnız Agentelse'in kendi verisi, K8); platform olayları için harici monitör ve operatör | Önem artarsa ya da 24 saat sonra hâlâ açıksa |
| WARN | Token süresi ≤ 7 gün, `spend_cap` ≥ %90, teslimat yok, tek reklam reddedildi, tempo ±%20 (zarf tanımlıysa), izleme şüphesi, senkron başarısız | Ads sohbetindeki kart + günlük özet | Günlük özette |
| INFO     | Drift, learning limited, Meta önerisi, 24 saati aşan inceleme                                                                                       | "Ads account" sayfası + haftalık rapor                                                                          | —                                            |

Telegram mesajı Meta'dan okunan veriyi (harcama, sonuç, kampanya adı) taşımaz; örnek: "Ads alert: spending above plan. Open Agentelse." Gerekçe: App Review hazırlığında Telegram mesajlarından Meta kaynaklı metnin çıkarılması kararlaştırıldı; gizlilik sayfası Telegram'ı anmıyor ve Data handling yanıtlarında Telegram yalnız şartlı işleyici. E-posta için altyapı yok ve yeni bir bağımlılık gerektiriyor; karar K8'de. Uyarılar `(proje, dedupeKey)` başına tek satır tutar: koşul tekrar ederse aynı satır yeniden açılır ve `occurrences` artar, koşul düzelince kendiliğinden RESOLVED olur. "Mute for 7 days" seçeneği vardır.

**Günlük sağlık özeti:** Her sabah 08:30'da (proje saatiyle) projenin kalıcı Ads sohbetine SYSTEM kartı olarak düşer ve Recents'te öne çıkar. Bu sohbet `Work.module = "ads"` olan sohbettir; yoksa haftalık taslaktaki `wkplan_` desenine benzer bir `ads_<projectId>` Work'ü açılır (K24). Gerekçe: Today Work'ü 2 Ekim'de arayüzden kalktı; oraya konan kart kimsenin açmadığı bir yüzeye düşerdi. İçeriği:

- dünkü harcama ve planla farkı (±%),
- aktif kampanya sayısı,
- açık CRITICAL/WARN uyarıları,
- bekleyen kararlar,
- veri tazeliği.

Not edilecek bir şey yoksa kart çıkmaz. CRITICAL ya da WARN uyarısı varken bütün sohbetlerdeki "Sıradaki adım" şeridi bu sohbete götürür. Telegram'a özet gönderimi varsayılan olarak kapalıdır.

**İzleyeni kim izler?** Beş katman var:

1. **Süreç içi nabız:** Her tick başında `lastBeatAt`, sonunda `lastOkAt` yazılır (en fazla dakikada bir); `data.maxGapMs24h` en uzun boşluğu tutar.
2. **Harici monitör (K23):** GitHub dışındaki ücretsiz katmanlı bir uptime ya da dead-man servisi 5 dakikada bir `GET /api/health?worker=1` çağırır. Alternatif olarak işçi her başarılı tick'te bir heartbeat URL'sine ping atar ve 15 dk ping gelmezse servis e-posta ya da Telegram gönderir. Servise yalnız sağlık durumu gider, Meta verisi gitmez. Gerekçe: GitHub'ın zamanlanmış işleri pratikte 5-20 dakika gecikebilir ya da atlanabilir (`local-worker-policy.ts`); özel repoda Free planda ayda 2.000 Actions dakikası var ve her iş en az 1 dakika sayılır, bu yüzden `*/5` tetikleyici ile ayrı bir `*/10` bekçi kotayı ayın başında bitirip 1 Ekim'deki sessiz durmayı tekrarlatabilir.
   - GitHub cron yalnız yedek tetikleyicidir. Repo özelse `*/5` → `*/15` yapılır ve Actions dakika kullanımı /health'te gösterilir.
   - Sahip harici servisi istemezse yedek plan: ayrı workflow açılmaz, mevcut `cron-worker.yml`'ye ikinci adım eklenir (eşik 20 dk). Bu durumda tespit süresi GitHub'ın gecikmesine bağlı kalır.
3. **Kullanıcı:** Uygulama içi şerit istek anında hesaplanır, yani diğer her şey çökse bile ekranı açan OWNER/ADMIN durumu görür.
4. **Meta tarafı frenler:** `lifetime_budget`/`end_time` ve `spend_cap` bizden tamamen bağımsız çalışır (Ad Rules F7'de isteğe bağlı).
5. **Railway healthcheck:** `/api/health` yalnız canlılığı (süreç ayakta, DB'ye erişilebiliyor) bildirir. Railway bu kontrolü yalnız deploy başında çağırır ve sürekli izleme yapmaz (doğrulandı). Bu yüzden işçi kontrolü ayrı bir parametredir; aksi hâlde açılışta henüz tick atmamış işçi yüzünden deploy başarısız olur.

### 3.7 Analiz ve raporlama

| Rapor                  | Zaman              | İçerik                                                                                                                                          | Yüzey                                                                            | Maliyet                         |
| ---------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| Günlük sağlık özeti    | 08:30, proje saati | §3.6 | Ads sohbetinde SYSTEM kartı (K24) | Meta 0, LLM 0 |
| Haftalık rapor         | Pazartesi 08:00 | KPI ile hedef; önceki haftaya göre trend; teşhis ağacı; kreatif tablosu (yönlü etiketler); alınan kararlar ve sonuçları; gelecek haftanın planı | Ads modül sohbetinde rapor kartı; Markdown/PDF (Analytics'in paylaşım altyapısı) | 1-2 Meta okuması (dönem erişimi), 1 LLM (number-check'li) |
| Aylık / müşteri raporu | Ayın 1'i | Ay toplamları, hedefler, mutabakat ("How many new customers did you get?"), öğrenmeler, gelecek ayın zarfı | Analytics modülünün paylaşım adımı (Copy / Markdown / Print) | 0-3 Meta okuması (dönem erişimi, silinen nesneler), 1 LLM |
| İsteğe bağlı analiz    | Sohbette           | Ör. "Why did CPA go up this week?" → aynadan teşhis                                                                                             | `get_ad_performance` aracı                                                       | Meta 0 ("Refresh" hariç), 1 LLM |

Raporlar `AdsInsightDaily` verisinin görünümleridir; ayrı bir rapor tablosu tutulmaz. Para toplamları hesap ve kampanya satırlarından gelir (§3.2). Erişim (reach) ve sıklık tekil kişi metrikleri olduğu için günlük satırlardan toplanmaz; rapor dönemi için ayrıca okunur. Yalnız LLM özeti kartın verisinde önbelleğe alınır.

**Teşhis ağacı** (`src/server/ads/reports/diagnose.ts`):

- Temel denklem: `CPA = (CPM / 1000) / (link CTR × CVR)`.
- Haftalık değişim log farklarıyla bileşenlere ayrılır: Δln CPA = Δln CPM − Δln CTR − Δln CVR.
- Örnek çıktı: "CPA +35%: CPM +30% (auction/season), link CTR flat, CVR −5%."
- İnceleme sırası: izleme → CPM (açık artırma, sezon, doygunluk) → CTR (hook, yorgunluk) → CVR (sayfa, teklif, form) → sıklık.
- Segment kırılımlarında "breakdown effect" uyarısı gösterilir: Meta marjinal maliyete göre optimize eder, bu yüzden "pahalı" görünen bir segmenti kapatmak yanlış olabilir.

**Atıf uyarıları:**

- Her rakam ad set'in `attribution_setting` değeriyle birlikte gösterilir. 10 Haziran 2025'ten beri API, Ads Manager'ın atfını taklit ediyor.
- `7d_view` ve `28d_view` pencereleri 12 Ocak 2026'dan beri boş dönüyor.
- Mart 2026'da click-through tanımı değişti: artık yalnız link tıklaması sayılıyor, etkileşimler 1 günlük "engage-through"a taşındı. Bu tarihin öncesiyle sonrası karşılaştırılırken uyarı gösterilir (üçüncü taraf kaynak, doğrulanmalı).
- Saklama sınırları: unique ve saatlik kırılımlar 13 ay, `frequency_value` 6 ay.
- Son günlerin verisi olgunlaşmamıştır (geç atıf, CAPI); tablolar bunu "Recent days may still change" notuyla gösterir.
- Meta ile GA4/CRM arasındaki fark %30'u aşarsa izleme denetimi önerilir.

**Brand Brain öğrenmeleri** (`src/server/ads/reports/learnings.ts`):

- `BrandLearning` kaydı açılır: `sourceType = "META_ADS"` (alan String olduğu için migration gerekmez), polarity WORKS ya da AVOID.
- Yalnız iki durumda yazılır: değerlendirilmiş bir karar istatistik kapısını geçmişse ya da aynı desen en az 2 kez görülmüşse.
- Metin n'yi içerir; kapıyı geçmeyen sonuç "directional" etiketi taşır.
- Öğrenmeler fikir motorunu ve kreatif brieflerini besler. Kişisel veri yazılmaz.

**Meta önerileri:** `/act_x/recommendations` ve `opportunity_score` "Meta suggests…" başlığıyla ikinci görüş olarak haftalık rapora eklenir. Asla otomatik uygulanmaz: uygulamak Meta'nın şartlarını kabul etmek anlamına gelir ve öneriler genellikle Advantage+'a yönlendirir.

**Rakip incelemesi:** Aylık rutinde Ad Library bağlantısı (ülke ve marka kategorisi önceden doldurulmuş) kullanıcıya sunulur ve elle açılır; otomatik tarama yapılmaz.

### 3.8 Arayüz yüzeyleri

Arayüz İngilizcedir ve mevcut kurallara uyar: sağ dok sade kalır, tek tarih/saat seçici kullanılır, kartlar yerinde değişir. Aynı reklam durumu en fazla iki yerde gösterilir: Ads sohbetindeki kart ve "Ads account" sayfası. Sahip sağ panelde tekrarları kaldırttığı için Brand sekmesi kartı F6'ya ertelendi.

| Yüzey | Ne gösterir | Eylemler | Faz |
| ----- | ----------- | -------- | --- |
| Ads modül kartı (sohbet) | Brief → Plan → Create → Review (Meta ön kontrolü, yerleşim önizlemeleri, net zarf + tahmini brüt fatura) → Launch (adım adım ilerleme) | "Approve & launch", "Create paused only", "Fix and retry", "Discard", "Turn on" | F3, F5a, F5b |
| Ads sohbetindeki durum kartı (`ads-insight-card.tsx`'in evrimi; Ads modül sohbetlerinde ve kanallarında `ads` olan Work'lerde) | Günlük özet, açık uyarılar, bekleyen kararlar, odaktaki kampanya | Approve / Reject / Undo / "Pause now" / "Pause all" | F2, F4 |
| "Ads account" sayfası (`/projects/[projectId]/ads`) | Hesap sağlığı başlığı (durum, ödeme, `spend_cap`, token süresi, "Updated 12 min ago · Account time"). Kampanya / ad set / reklam tablosu ("Paused by you", "Stopped by Meta", "Completed" ve "Archived in Ads Manager" ayrımı, Agentelse etiketi). Sorunlar ve kararlar | Pause/Resume (Resume L4'tür: OWNER/ADMIN'in kendi tıklaması onaydır, MEMBER için onay isteği açılır), "Change budget" (karar + onay), "Open in Ads Manager", "Refresh" (5 dakikada bir) | F2 |
| Integrations → Meta Ads kutucuğu (`integrations/page.tsx`) | Token süresi ("Expires in 12 days"; kayıtlı bitiş tarihinden), izinler ve hesap durumu rozeti (F1) | Reconnect, hesap seçimi (kapalı hesap seçilemez) | F0b, F1 |
| İşçi şeridi (üst düzey yerleşim) | "Background jobs paused since 10:42" | — | F0b |
| Sağ dok → Brand sekmesi "Ads" kartı (`brand-summary-panel.tsx`, `brand-overview-cards.tsx`, `workspace-right-panel-data.ts`) | Sağlık noktası, bugünkü harcama/plan, açık sorun sayısı | "Ads account" sayfasına git | F6 (K22) |
| Settings → Autonomy (`settings-panel.tsx`) | "Ads autopilot": Suggest only / Guarded auto (/ Full auto) ve aylık tavan | — | F7 |
| /health (yalnız platform operatörü; `OPERATOR_USER_IDS`) | Meta bölümü: hata oranı, hesap kotaları, senkron tazeliği, bekleyen operasyonlar, `fbtrace_id`, düşen öneriler | "Reconcile now" | F1, F2 |
| Sohbet ajanı | `get_ads_overview`, `get_ad_performance` (okuma, anında); `propose_ads_change` (karar + onay); `pause_ads` (onay sorusuyla, inline). `decide_approval` L4 onay vermez: "Approve it on the card above." | Dış içerik okunmuş turda yazma araçları kapalı (mevcut koruma) | F0b, F2, F4 |

- **Takvim:** Bitiş tarihi ve özel tarih aralığı yalnız `src/components/ui/date-time-picker.tsx` ile seçilir.
- **Dok:** Yeni dok ikonu eklenmez; sahip kestirmeleri dokta istemedi (bkz. K22).
- **Kartın görünürlüğü:** Works ads kartı bugün Today Work'ünde ve `ads` kanallı Work'lerde görünüyor. Today arayüzden kalktığı için kart Ads modül sohbetlerine ve `ads` kanallı Work'lere taşınır (K24).

### 3.9 Güvenlik, harcama koruma rayları ve uyumluluk

**Çift fren:**

| Risk | Bizim fren (uygulama) | Meta tarafı fren (sunucumuzdan bağımsız) |
| ---- | --------------------- | ---------------------------------------- |
| Süresiz harcama | `end_time` zorunlu (F0b: modül akışında ad set'e yazılır, eski sihirbazda End date zorunlu); always-on için 30 günlük zarf ve aylık yenileme onayı | FIXED: ad set `lifetime_budget` + `end_time`. ALWAYS_ON: ad set `end_time` = zarf sonu (yenileme onaylanmazsa Meta teslimatı durdurur). Ek tavan: kampanya `spend_cap` (ömür boyu birikimli; asgari hesaptan okunur) |
| Kaçak günlük harcama | G1 bekçisi (30 dk) | Meta'nın kendi temposu: günde en çok 1,75 × günlük bütçe, takvim haftasında (Pazar-Cumartesi, hesap saatiyle) en çok 7 ×. v1'de Ad Rules sigortası kurulmaz (aşağıda) |
| Sonuçsuz harcama | G3 | F7'de isteğe bağlı Ad Rules (SCHEDULE, SEMI_HOURLY; Ads Manager'da görünür) |
| Hesap toplamı | Aylık tavan, MTD tempo bekçisi | Hesap `spend_cap`: yalnız müşteri onayıyla ve günde en çok 1 değişiklik (Meta sınırı 10). Birim tutarsızlığı doğrulanmalı |
| Yanlış hesap / müşteri | Nesne-hesap doğrulaması (F0b); hesap görevde sabitlenir | — |
| Yazım hatası (fazladan sıfır) | Tutar Meta asgarisi ile proje azamisi arasında olmalı; önceki bütçenin 3 katını aşan değişiklik ikinci bir doğrulama ister | — |

**Ad Rules (F7, isteğe bağlı):** v1'de Ad Rules kurulmaz. Gerekçe:

- Meta'nın kendi temposu günlük ve haftalık tavanı zaten uyguluyor. "Bugünkü harcama > 2 × günlük bütçe" TRIGGER kuralı yalnız Ads Manager'da elle yapılmış bir bütçe artışını yakalar; o da çoğu zaman müşterinin bilerek yaptığı bir değişikliktir ve görünmez bir kuralla durdurulmamalıdır.
- Trigger tabanlı kurallar yalnız API'de vardır; müşteri de ajans da onları Ads Manager'da göremez ve kapatamaz. NOTIFICATION eylemi Agentelse'e değil, kuralı oluşturan kişiye (token sahibine) gider.
- Kuralı oluşturan kullanıcı hesaba erişimini kaybettiğinde ya da uygulama yetkisi kalktığında kuralın çalışmaya devam ettiği belgelenmemiştir.
- Kural yaşam döngüsü (oluşturma, bütçe değişince yeniden yazma, silme) sisteme yük ekler.

F7'de açılırsa şu kurallara uyulur:

- Kural her zaman kimlik filtresiyle kurulur: `{"field": "campaign.id" ya da "adset.id", "operator": "IN", "value": […]}`. Tek başına `entity_type` kullanılmaz; aksi hâlde kural hesaba eklenen her yeni nesneye, müşterinin Agentelse dışındaki kampanyalarına da uygulanır.
- Tercih SCHEDULE tipidir (SEMI_HOURLY; Ads Manager'da görünür). TRIGGER kullanılırsa filtre `spent` (para biriminin alt biriminde) + `time_preset` olur ve `time_preset` TODAY içermelidir; gecikmenin p99'u ~7,5 dk'dır.
- Kural adı "Agentelse safety · <kampanya>" olur; kimlikler `AdsLaunch.guards` içinde tutulur.
- Eşikler sabit değerdir. Bütçe düşürüldüğünde eşik o gün için max(2 × eski bütçe, 2 × yeni bütçe) olarak kalır ve hesap saatiyle gece yarısından sonra yeni bütçeye iner; aksi hâlde kural kampanyayı kendi kendine durdurur. Bütçe artışında eşik hemen yükseltilir.
- Kural yürütmeleri senkronda `GET /act_x/adrules_history` ile okunur ve RULE aktörlü `AdsOperation` olarak kaydedilir; bunlar drift sayılmaz ve UI "Paused by Agentelse safety rule" gösterir.
- Kurallar önce test hesabında `/{rule_id}/preview` ile denenir.
- Disconnect sırası: önce kurallar silinir, sonra izin ve token. Silinemeyen kurallar operatörün /health ekranında listelenir.

**Değişiklik hız sınırları:**

| Değişiklik                                             | Sınır                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Ad set bütçesi                                         | 24 saatte en çok 1 (acil düşürme hariç); adım ≤ %20-30. Meta sert sınırı saatte 4 |
| Anlamlı düzenleme (hedefleme / kreatif / optimizasyon) | Ad set başına haftada ≤ 2; öğrenme sırasında hiç                                  |
| Hesap `spend_cap`                                      | Günde ≤ 1                                                                         |
| Yeni hesapta harcama                                   | İlk 2 hafta, haftada en çok 2 kat artış (risk incelemesini tetiklememek için)     |
| Otomatik eylem (Guarded)                               | Proje başına günde ≤ 5; aşılırsa insan onayı gerekir                              |
| 18:00'den sonra ≥ %20 bütçe artışı                     | Yapılmaz, ertesi sabaha planlanır (hesap saatiyle)                                |

**Acil durdurma (kill switch):**

- **Proje düzeyi:** "Pause all Agentelse ads" P0 şeridinden inline çalışır ve kampanya başına tek yazmadır; alt nesneler durumu miras alır. Onay, kullanıcının kendi tıklaması ve bir doğrulama diyaloğudur. Yetenek `META_SAFETY_ACTION` olur: kullanıcı başlattığında LEVEL_0, sistem başlattığında LEVEL_4. Sistem başlatması L4 kümesine açıkça eklenir; eklenmezse yeni yetenek kendiliğinden L1 olur. Guarded'da L1'e indirme, `ApprovalPolicy`'nin "yalnız yükseltir" kuralına yazılı ve testli bir istisnadır: yalnız `META_SAFETY_ACTION` + `riskReducing=true` + GUARDED (F7). Varsayılan kapsam yalnız Agentelse'in kurduğu nesnelerdir (`launchId` ile tanınır); "All active campaigns in this ad account" ayrı bir seçenektir.
- **Meta blokladığında:** Yerel öncelik Meta'nın blokunu aşamaz; blok varken P0 çağrısı da reddedilir. Blok sürerken kart "Meta is rate-limiting; pause applies in ~N min" yazar ve P0, reset anında ilk iş olarak denenir. O süre boyunca Meta tarafı frenler esastır.
- **Global:** `META_ADS_WRITES_DISABLED=true` ile yalnız PAUSE işlemleri geçer.
- **Geliştirme ortamı (F0b, K19):** `NODE_ENV=development`'ta işçi META_* işlerini ve `meta-ads-*` tick adımlarını hiç claim etmez; bunları atlar, FAILED yapmaz. Bu işler yalnız `DATABASE_URL` tek kullanımlık yerel Postgres'i (localhost ya da Unix soketi) gösteriyorsa ya da işin reklam hesabı `META_ADS_DEV_ALLOWED_ACCOUNTS=act_…` listesindeyse yerelde çalışır. Meta yazma fonksiyonları da development'ta yalnız bu listedeki hesaplara izin verir. Yerel ortamdan Telegram ve uyarı gönderimi kapalıdır. Yerel ortam canlı DB'yi paylaştığı için bu kural hem gerçek müşteri token'larıyla yanlışlıkla harcamayı hem de canlı bir lansmanın yerel işçide FAILED olmasını önler.

**Özel reklam kategorileri:**

- Brief'te işletme kategorisi sınıflandırılır: emlak, istihdam, kredi/sigorta/yatırım (`FINANCIAL_PRODUCTS_SERVICES`; `CREDIT`'in yerini aldı), kumar, siyaset.
- HEC (HOUSING, EMPLOYMENT, FINANCIAL_PRODUCTS_SERVICES): uyum için `tune_for_category` kullanılır. `advantage_audience` açıkça 1 (varsayılan) ya da kullanıcının seçtiği değer olarak gönderilir; Meta bu kategorilerde Advantage+ audience'ı destekler ve 0'a zorlamak erişimi gereksiz daraltır. Yaş 18-65+ (AB'deki kredi reklamlarında serbest), cinsiyet tümü. Yarıçap ABD/Kanada'da ≥ 25 km (15 mil), Avrupa'da ≥ 15 km. Zip, subcity, neighborhood ve metro_area konum türleri, konum hariç tutma ve lookalike kullanılmaz. Preflight, işletme yöneticisinin ayrımcılık karşıtı politikayı kabul ettiğini `issues_info`'da 2859024 olmamasıyla doğrular.
- ISSUES_ELECTIONS_POLITICS ve ONLINE_GAMBLING_AND_GAMING HEC hedefleme kilidine tabi değildir; ayrı yetkilendirme (`authorization_category`) ve yazılı izin ister. v1'de desteklenmez.
- AB'yi hedefleyen siyasi ya da sosyal konu reklamları engellenir (TTPA, 6 Ekim 2025).

**DSA ve bölgesel düzenlemeler:**

- **AB/AEA:** `dsa_beneficiary` + `dsa_payor` (en fazla 512 karakter). Brand ayarında "Who benefits from this ad?" ve "Who pays for it?" alanları tutulur. Hesabın `default_dsa_payor` / `default_dsa_beneficiary` alanları müşterinin bütün yeni ad set'lerini etkileyen hesap düzeyi bir değişiklik olduğu için yalnız müşterinin açık onayıyla yazılır.
- **F0b:** Modül akışında AB ülkesi seçilebiliyor. Brief'te AB ülkesi seçiliyse ve hesapta `default_dsa_*` yoksa Review bu iki alanı ister ve ad set'e gönderir; alanlar girilmeden AB ülkeleri seçilemez.
- **Bölgesel kimlik isteyen ülkeler:** Brezilya, Tayvan, Tayland ve Singapur ile Avustralya ve Hindistan'daki finans reklamları ad set'te `regional_regulated_categories` ve `regional_regulation_identities` (Meta'da doğrulanmış kimlik ID'leri; serbest metin kabul edilmez) ister; eksikse 3858634/3858636 gelir. Tayvan'daki finans ad set'i iki kategoriyi birlikte bildirir; kreatifte ayrıca `regional_regulation_disclaimer_spec` vardır. v1'de bu ülkeler desteklenmez: hedeflemede seçilirse lansman engellenir ve gerekçe gösterilir. İleride Brand ya da `AdsAccount` modeline `regionalIdentities Json?` eklenebilir.

**Politika ön denetimi** (`src/lib/ads/policy-lint.ts`, TR + EN):

- Şu kalıplar yakalanır:
  - 2. şahıs hitabı ile hassas özelliğin aynı cümlede olması ("Are you diabetic?"),
  - "other X's" kalıbı,
  - önce/sonra görseli + 18 yaş altı hedefleme,
  - süre belirtmeden kilo iddiası.
- Metin, Brand Brain'deki "approved claims" ve "never-rules" ile karşılaştırılır.
- Reddedilen reklam aynı içerikle asla yeniden gönderilmez; bunu yapmak "circumventing systems" riski taşır.
- Desteklenmeyen dillerde (MK, SQ, SR, BG, EL) kural tabanlı lint çalışmaz; metin "lint not available" notuyla LLM sınıflandırmasına düşer.

**Denetim kaydı:**

- `AdsOperation` her yazmayı tutar: önce/sonra durumu, aktör (USER/SYSTEM/RULE), `approvalId` ve `fbtrace_id`. Token asla kaydedilmez.
- Onay ve otonomi değişiklikleri ayrıca `AuditLog`'a yazılır.

**Gizlilik ve silme:**

- Facebook Login için deauthorize ve data-deletion uçları eklenir. Bağlanırken app-scoped kullanıcı kimliği Facebook yolu bağlantılarının hepsine yazılır: `facebook`, `login=facebook` olan `instagram` ve `meta_ads`. Deauthorize geldiğinde hepsi REVOKED olur.
- Disconnect token'ı ve reklam metadata'sını hemen siler, satırı REVOKED yapar. Meta tarafında yalnız reklam izinleri geri alınır: `DELETE /{app-scoped-user-id}/permissions/ads_management` ve `/ads_read`. Bu da yalnız aynı app-scoped kullanıcının başka bir projede ya da serviste ACTIVE Meta Ads bağlantısı yoksa yapılır. Ortak izinler (`pages_show_list`, `pages_read_engagement`, `business_management`) geri alınmaz.
- Gerekçe: Instagram, Facebook ve Meta Ads aynı Meta uygulamasını paylaşıyor ve Meta kişi + uygulama başına tek izin tutuyor (`meta-client.ts:40-47`). `DELETE /me/permissions` uygulamayı o kişi için tümden kaldırır; bir projede Meta Ads'i ayırmak, diğer projelerin Facebook yayınını, Facebook yolundaki Instagram'ını ve reklam bağlantılarını 190/458 ile düşürürdü. Bu çağrı yalnız kullanıcı bütün Meta servislerini kaldırmayı seçerse yapılır; aynı kişinin başka Meta bağlantısı varsa kullanıcıya "Remove Agentelse in your Facebook settings" bağlantısı gösterilir.
- Sıra: (F7'de kurulduysa) önce Ad Rules silinir, sonra izin ve token.
- Ayna ve insights verileri 30 gün sonra silinir (K18).
- Gizlilik metni güncellenir: günlük performans verisinin saklama süresi, otomatik koruma eylemleri (F7) ve lead verisi (F5b).

**Sırlar:** `appsecret_proof` kullanılır. Meta token'ları için ayrı ve sürümlü bir şifreleme anahtarı F8'de gelir; bugün OTP sırlarıyla ortak `TEMPORARY_SECRET_ENCRYPTION_KEY` kullanılıyor.

**Roller:**

- L4 (harcama) onayını yalnız workspace OWNER/ADMIN verir. Kural tek bir ortak noktada uygulanır: `ApprovalRepository.decide`. Web, Telegram, Works, plan ve post yolları `applyApprovalDecision` üzerinden, sohbetin `command-service` yolu ise doğrudan bu fonksiyonu çağırır (`command-service.ts:265`); bu yüzden kapı `applyApprovalDecision`'a değil, buraya konur. `level=LEVEL_4_CRITICAL` ve `to=APPROVED` ise onaylayan gerçek bir kullanıcı olmalı ve workspace rolü OWNER ya da ADMIN olmalıdır; değilse `AgentelseError(PERMISSION_DENIED)`.
- Telegram'daki L4 mesajında Approve/Reject düğmesi yerine "Review in Agentelse" bağlantısı olur; Telegram onaylayıcısı `telegram:<id>` sözde kullanıcısıdır ve workspace rolü yoktur. Gerekirse "can approve spend" eşlemesi F8'de gelir.
- Sohbetteki `decide_approval` aracı L4 onayı hiç vermez ve "Approve it on the card above." yanıtını döner; L3 META_* onayları için `approvalId` ister ve onay detayını gösterir.
- "Ads account" sayfasındaki Resume (ACTIVE) da L4'tür: OWNER/ADMIN'in kendi tıklaması onay sayılır, MEMBER için onay isteği açılır.
- Müşteri onaylayıcı rolü F8'de gelir.

---

## 4. Veri modeli

**Adlandırma.** Yeni tablolar `Ads*` önekini ve `platform` alanını taşır (`AdsPlatform`, şimdilik yalnız `META`). Bu, `meta-client.ts`'teki `MetaAdAccount` TS tipiyle çakışmayı önler ve Google Ads için yer açar.

**Alan türleri.** `kind` alanları String'dir (TS union ile); böylece yeni bir tür eklemek migration gerektirmez (`BrandLearning.sourceType` örneğindeki gibi). Durum alanları enum'dur. Para alanları minor unit cinsinden `BigInt`'tir.

| Model (faz)            | Amaç                                                  | Ana alanlar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Benzersiz / indeks                                                                     | Tahmini hacim                                                                             | Saklama                                         |
| ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `SystemHeartbeat` (F0b) | İşçi ve işlerin nabzı | `key` (PK: `worker.tick`, `meta.sync`, `meta.calls`), `lastBeatAt` (tick başı), `lastOkAt` (tick sonu), `lastError`, `data` (Json: `maxGapMs24h`, günlük çağrı ve hata sayaçları, son 500 Marketing API çağrısının anlık görüntüsü) | PK | < 10 satır | Kalıcı (üzerine yazılır, en fazla dakikada bir) |
| `AdsAccount` (F1) | Meta reklam hesabının workspace içindeki tek kaydı; sağlık, kota ve senkron durumu | `workspaceId, credentialId, platform, externalId ("act_…"), name, currency, timezoneName, accountStatus, disableReason, hasFunding, isPersonal, spendCapMinor, amountSpentMinor, minDailyBudgetMinor, minCampaignSpendCapMinor, minimumBudgets (Json), userTasks[], businessId, pageId, instagramUserId, dsaBeneficiary, dsaPayor, accessTier, lastUsage (Json), rateLimitedUntil, healthStatus, healthReason, lastHealthAt, lastStructureAt, lastInsightsAt, lastBackfillDate, syncLeaseUntil, syncLeaseOwner, consecutiveFailures` | `@@unique([workspaceId, platform, externalId])`, `@@index([syncLeaseUntil])` | Bağlı Meta hesabı başına 1 | Bağlantı yaşadıkça; Disconnect sonrası 30 gün |
| `AdsAccountProject` (F1) | Hesap ↔ proje bağlantısı | `adsAccountId, projectId, brandId, selected, createdAt` | `@@unique([adsAccountId, projectId])`, `@@index([projectId, selected])` | Proje başına 1-3 | Bağlantı yaşadıkça |
| `AdsOperation` (F1)    | Her Meta yazmasının niyet ve denetim kaydı            | Sketch aşağıda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `@@unique([tag])`, `@@index([projectId, createdAt])`, `@@index([status, sentAt])`      | Hesap başına ~50-150/ay                                                                   | 24 ay                                           |
| `AdsObject` (F2) | Kampanya / ad set / reklam aynası | `adsAccountId, projectId (launchId'den; dışarıda kurulan nesnede hesabın seçili projesi), level, externalId, parentExternalId, campaignExternalId, name, objective, optimizationGoal, billingEvent, bidStrategy, destinationType, configuredStatus, effectiveStatus, dailyBudgetMinor, lifetimeBudgetMinor, spendCapMinor, budgetRemainingMinor, startTime, endTime, learningStatus, learningConversions, lastSigEditAt, issues (Json), reviewFeedback (Json), failedDeliveryChecks (Json), advantageState, resultActionType, creativeExternalId, thumbnailAssetId, thumbnailFetchedAt, windowStats (Json: d7/d28 reach, frequency, impressions, okunma anı), createdByAgentelse, launchId, fieldsHash, metaUpdatedAt, lastSeenAt, lastDeliveryAt, driftAt, goneAt` | `@@unique([adsAccountId, externalId])`, `@@index([projectId, level, effectiveStatus])` | KOBİ hesabında 10-60; büyük hesapta 500-2.000 | `goneAt` + 90 gün |
| `AdsInsightDaily` (F2) | Günlük performans | `adsAccountId, projectId, level, externalId, date (@db.Date, hesap günü), spendMinor, impressions, reach, frequency, clicks, linkClicks, landingPageViews, results (Meta `results` alanından), resultActionType (`results` göstergesi), actionValuesMinor, actions (Json, ≤ 10 anahtar), video3s, thruplays, rankings (Json, yalnız reklam), attributionSetting, isFinal, fetchedAt`. Günlük `reach`/`frequency` yalnız o güne aittir; pencere değerleri `AdsObject.windowStats`'tadır | `@@unique([adsAccountId, level, externalId, date])`, `@@index([projectId, date])` | KOBİ hesabında günde ~5-10 satır; 100 hesapta günde ~1.000 (yılda ~365 bin, satır ~400 B) | Reklam düzeyi 180 gün, diğer düzeyler 400 gün |
| `AdsAlert` (F2)        | Tekilleştirilmiş uyarı / olay                         | `workspaceId, projectId, adsAccountId, externalId, kind, severity, status, dedupeKey, title, detail, data (Json), firstSeenAt, lastSeenAt, occurrences, notifiedAt, notifyChannels[], mutedUntil, resolvedAt`                                                                                                                                                                                                                                                                                                                      | `@@unique([projectId, dedupeKey])`, `@@index([projectId, status, severity])`           | Hesap başına onlarca                                                                      | Çözülenler 180 gün                              |
| `AdsLaunch` (F3) | Lansmanın tek kaydı (kart yalnız `launchId` tutar; lansman durumu buradan okunur) | `workspaceId, projectId, workId, commandId (kart), launchKey, adsAccountId, status, specVersion, spec (Json), validation (Json: validate_only + önizleme), approvalId, activationApprovalId, currentTaskId, campaignExternalId, envelope (Json), guards (Json: spendCap, endTime; F7'de ruleIds), error (Json), createdByUserId` | `@@unique([commandId, launchKey])`, `@@index([projectId, status])` | Hesap başına birkaç/ay | Kalıcı (denetim) |
| `AdsDecision` (F4)     | Optimizasyon karar kaydı                              | Sketch aşağıda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `@@unique([fingerprint])`, `@@index([projectId, status])`                              | Hesap başına 5-30/ay                                                                      | 24 ay                                           |
| `AdsWebhookEvent` (F7) | Gelen olay kutusu | `receivedAt, adAccountExternalId, field, objectExternalId, payload (Json), dedupeKey (sha256: entry.id + entry.time + change.field + value.object_id + changed_fields), processedAt, attempts` | `@@unique([dedupeKey])`, `@@index([processedAt])` | Olay başına 1 | 14 gün |
| `AdsConnection` (F8)   | Workspace düzeyinde Meta bağlantısı                   | `workspaceId, kind (USER / BISU / SYSTEM_USER), encryptedSecret, keyId, scopes[], expiresAt, dataAccessExpiresAt, clientBusinessId, status`                                                                                                                                                                                                                                                                                                                                                                                        | `@@index([workspaceId])`                                                               | Ajans başına birkaç                                                                       | Disconnect'te silinir                           |

**Alan notları:**

- **Küçük resimler:** Meta'nın döndürdüğü `thumbnail_url` imzalı ve bir süre sonra geçersizleşen bir CDN adresidir; Meta da kendi görsel adreslerinin kullanılmamasını söylüyor. Bu yüzden aynada saklanmaz. Agentelse'in kurduğu reklamlarda kaynak görselin kendi kaydı kullanılır (`thumbnailAssetId`, `assetUrl(id, "thumb")` deseni). Dışarıda kurulan reklamların küçük resmi görüntüleme anında `creative{thumbnail_url}` ile tazelenir ya da senkronda depoya kopyalanır (`thumbnailFetchedAt`).
- **Bölgesel kimlikler:** Brezilya, Tayvan, Tayland, Singapur ve AU/IN finans desteği gelirse Brand ya da `AdsAccount` modeline `regionalIdentities Json?` eklenebilir (§3.9); v1'de gerekmez.

**Enumlar:**

- `AdsPlatform` (META)
- `AdsLevel` (ACCOUNT, CAMPAIGN, ADSET, AD)
- `AdsOperationStatus` (PENDING, SENT, SUCCEEDED, UNKNOWN, RECONCILED, FAILED, COMPENSATED)
- `AdsLaunchStatus` (§3.4: DRAFT, MEDIA_PROCESSING, VALIDATED, AWAITING_APPROVAL, CREATING, CREATED_PAUSED, ACTIVATING, ACTIVE, FAILED, EXPIRED, CANCELLED, DISCARDING, DISCARDED)
- `AdsDecisionStatus` (SHADOW, PROPOSED, APPROVED, REJECTED, EXPIRED, SUPERSEDED, APPLYING, APPLIED, VERIFIED, FAILED, ROLLED_BACK)
- `AdsAlertStatus` (OPEN, ACKED, RESOLVED, MUTED)
- `AdsSeverity` (INFO, WARN, CRITICAL)
- `AdsAutonomyLevel` (SUGGEST, GUARDED, FULL)

**AdsAccount tekilliği.** Meta kota sınırları reklam hesabı (`act_`) başına uygulanır. Bu yüzden bir workspace'te her Meta hesabı tek satırdır; projelerle bağlantı `AdsAccountProject` tablosundadır. Senkron kilidi, governor durumu ve `rateLimitedUntil` bu tek satırdadır. Ayna ve insights bir kez yazılır, projelere görünüm olarak dağıtılır. Bir nesnenin hangi projeye ait olduğu `AdsObject.launchId` ve `projectId` ile belirlenir; drift kontrolü bütün projelerin `AdsOperation` kayıtlarına bakar. Benzersizlik workspace kapsamındadır: aynı Meta hesabı iki ayrı workspace'e bağlanırsa (nadir) kiracı verisi karışmasın diye satırlar ayrı kalır; governor o durumda kota durumunu aynı `externalId`'li satırların en kısıtlayıcısından okur. K10 (a) bu modelle uyumludur.

`CapabilityKey` enum'una eklenecekler: `META_SAFETY_ACTION` (F2), `META_LAUNCH` (F3). Her biri kendi migration klasöründe `ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS` ile eklenir (örnek: `20261002000000_add_facebook_publish_capability`). Yeni yetenek kayıt kontrol listesi: `MetaApiProvider.OWNED_CAPABILITIES`; `ExecutionPolicy` setleri (APPROVAL_REQUIRED, VERIFICATION, varsayılan risk, BROWSER_PURPOSE eşlemesi); `task-planner.publishApprovalType` (CAMPAIGN_APPROVAL); `buildApprovalDetails`; `approval-policy.ts` (L4 kümesi). `AutonomyPolicy`'ye eklenecekler (F7): `adsAutonomy AdsAutonomyLevel @default(SUGGEST)`, `adsMonthlyCapMinor BigInt?`.

Kısa şema taslağı:

```prisma
model AdsOperation {
  id               String             @id @default(cuid())
  workspaceId      String
  projectId        String
  adsAccountId     String
  kind             String             // CREATE_CAMPAIGN, CREATE_ADSET, UPDATE_BUDGET, SET_STATUS, ...
  tag              String             @unique // "agx:k3f9q2" — Meta'da uzlaştırma anahtarı
  launchId         String?
  decisionId       String?
  executionJobId   String?
  actorType        String             // USER | SYSTEM | RULE
  targetExternalId String?
  request          Json               // token'sız
  previousState    Json?              // geri alma için
  status           AdsOperationStatus @default(PENDING)
  resultExternalId String?
  error            Json?              // code, subcode, class, userMessage, blameFieldSpecs, fbtraceId
  attempts         Int                @default(0)
  sentAt           DateTime?
  completedAt      DateTime?
  createdAt        DateTime           @default(now())
  @@index([projectId, createdAt])
  @@index([status, sentAt])
}

model AdsDecision {
  id           String            @id @default(cuid())
  workspaceId  String
  projectId    String
  adsAccountId String
  level        AdsLevel
  externalId   String
  ruleKey      String            // "O3_SCALE"
  ruleVersion  Int
  kind         String            // PAUSE, BUDGET_DOWN, BUDGET_UP, CREATIVE_REFRESH, ARCHIVE, NOTIFY
  severity     AdsSeverity
  status       AdsDecisionStatus
  autonomy     AdsAutonomyLevel
  evidence     Json              // pencereler, metrikler, geçen kapılar
  explanation  String
  change       Json?             // { field, from, to } — "from" CAS için
  fingerprint  String            @unique // kural + nesne + hafta
  approvalId   String?
  taskId       String?
  expiresAt    DateTime?
  appliedAt    DateTime?
  verifiedAt   DateTime?
  evaluatedAt  DateTime?
  outcome      String?           // WORKED | DIDNT | INCONCLUSIVE
  rollbackOfId String?
  createdAt    DateTime          @default(now())
  @@index([projectId, status])
}
```

**Mevcut modellerle ilişki:**

- `AdsAccount.credentialId` → `IntegrationCredential` (provider `meta_ads`); projeler `AdsAccountProject` üzerinden bağlanır. F8'de `AdsConnection` eklenir.
- `AdsLaunch` → `Command` (kart), `Work`, `Task`, `Approval`.
- `AdsDecision` → `Task`, `Approval`, `AdsOperation`.
- `AdsOperation` → `ExecutionJob`.
- `AdsInsightDaily` verisi `ProjectGoal.currentValue` değerini besler.
- Performans uyarıları artık `Signal`'e yazılmaz. Brand Brain'in Intelligence anlatısı için haftada tek bir özet Signal kalır.
- Repo deseni: yalnız Brand, Project'e gerçek FK ile bağlıdır; diğer tablolar düz `projectId` kolonu taşır. `ProjectDeletionService` bu tabloları `information_schema` ile bulup alfabetik sırayla siler. Yeni Ads* tabloları da düz `projectId` taşır ve kendiliğinden silinir. Ads* tabloları arasında FK kurulursa `onDelete: Cascade` ya da `SetNull` olmalıdır, çünkü alfabetik sıra ebeveyni çocuğundan önce silebilir (ör. `AdsDecision`, `AdsOperation`'dan önce gelir). `AdsAccount` `projectId` taşımadığı için proje silinince kalır; bağlantı kopunca temizlenir.
- `IntegrationCredential.metadata` içindeki ads alanları (`selectedAdAccountId`, `adAccounts`, `previousScanSnapshot`, `adsDigest`, `lastAdsPerformanceScanAt`) geçiş süresince okunmaya devam eder ama F2'den sonra yazılmaz. Silinmeleri ayrı bir iştir ve sahibin onayını gerektirir.

**Migration stratejisi:**

1. Her fazın kendi yeni migration klasörü olur, ör. `prisma/migrations/<YYYYMMDDhhmmss>_add_ads_account_and_operation/`. Var olan migration dosyası asla düzenlenmez.
2. Yalnız ekleme yapılır: `CREATE TABLE`, nullable ya da varsayılanlı `ADD COLUMN`, `ALTER TYPE … ADD VALUE`. Aynı fazda yeniden adlandırma ya da kolon/tablo silme yapılmaz.
3. SQL, tek kullanımlık yerel Postgres'e karşı `prisma migrate diff` ile üretilir. Paylaşılan DB'de `migrate dev` ve `db push` asla çalıştırılmaz.
4. Var olan bir enum'a değer eklemek (`ALTER TYPE … ADD VALUE IF NOT EXISTS`, ör. `CapabilityKey`) ayrı bir migration klasöründe tutulur; yeni değer aynı işlemde kullanılamaz. Yeni enum'lar (`CREATE TYPE`) tablolarıyla aynı migration'da olabilir.
5. Uygulama: Railway başlangıcında `npx prisma migrate deploy` çalışır, CI da aynı komutu kullanır. Sahibin terminalindeki `migrate deploy`, çalışma ağacındaki commit'siz klasörleri de canlıya uygular; bu yüzden yarım migration klasörü ağaçta bırakılmaz.
6. Backfill tembeldir ve idempotenttir. Örneğin `AdsAccount` satırı, ilk okumada `IntegrationCredential.metadata`'dan oluşturulur; ayrı bir operasyon adımı gerekmez. Gerekirse `--dry-run`'lı bir betik yazılır.
7. Saklama temizliği (`ads-retention` işi) yalnız süresi dolmuş satırları siler; canlı veriye yıkıcı başka bir işlem yapılmaz.

---

## 5. İşler, zamanlama ve kota bütçesi

| İş                                 | Sıklık                                                                             | Tetikleyici                 | Kilit                                         | Meta bütçesi                                | Başarısızlıkta                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `worker-backlog-gate` (F0a)        | Her claim'de | `ExecutionService.startExecution` | ExecutionJob CAS | 0 | Bayat META_* işi ve görevi CANCELLED ("Stale after worker outage") |
| `worker.heartbeat`                 | Her tick: başta `lastBeatAt`, sonda `lastOkAt` (yazım en fazla dakikada bir) | `ExecutionWorker.tick` | Yok (upsert) | 0 | Harici monitör alarm verir |
| Harici monitör (K23)               | 5 dk | GitHub dışı uptime/dead-man servisi | — | 0 | Operatöre e-posta / Telegram (yalnız sağlık durumu, Meta verisi yok) |
| GitHub cron (yedek tetikleyici)    | `*/5` (özel repoda `*/15`) | GitHub Actions | — | 0 | GitHub'ın başarısız iş e-postası |
| `meta-ads-sync`                    | Her tick'te vadesi gelen en çok 3 hesap | Ajans tick adımı (heartbeat'ten hemen sonra) | `AdsAccount` kilidi (5 dk, CAS; Meta hesabı başına) | §5.1; P2 şeridi | Hesap başına üstel geri çekilme (5 dk → 6 sa). RATE_LIMIT → `rateLimitedUntil`. AUTH → EXPIRED ve dur. 3 ardışık hata → SYNC_FAILING. `Project.status`'tan bağımsız |
| ├ health                           | 6 sa + yazma öncesi (15 dk önbellek)                                               |                             |                                               | 2 okuma                                     |                                                                                                                                      |
| ├ structure                        | Aktifse 60 dk; boştaysa ve bitmiş nesnelerde 6 sa | | | 3+ okuma | |
| ├ insights-today                   | Aktif teslimatta 30 dk | | | 4+ okuma (hesap, kampanya kimlikle, ad set, reklam) | Aralık bölünür |
| ├ window-stats                     | Yapıyla birlikte (60 dk) | | | 2 okuma | — |
| ├ insights-backfill                | Günlük 04:00 (hesap saati), son 28 gün | | | 3-9 okuma + silinen nesneler (kimlikle) | Aralık bölünür; ertesi gün tekrar |
| └ reconcile/drift                  | Günlük + her yapı senkronunda                                                      |                             |                                               | 0 (aynadan)                                 | Uyarı                                                                                                                                |
| `meta-ads-guard`                   | 15 dk (senkrondan sonra)                                                           | Ajans tick adımı            | `AdsAccount` kilidi (yalnız otomatik eylemde) | 0 okuma; Guarded'da P0 yazma                | Uyarı tekilleşir; otomatik eylem başarısızsa CRITICAL                                                                                |
| `meta-launch-watchdog`             | 10 dk                                                                              | Ajans tick adımı            | `AdsLaunch` CAS                               | Uzlaştırma için ≤ 2 okuma                   | CHAIN_STUCK                                                                                                                          |
| `meta-write` (yazma kuyruğu)       | Olay tabanlı | Outbox + onay anında `after()` ile sürüş | ExecutionJob CAS; hesap başına seri | P0/P1 | Sınıfa göre (§3.6) |
| `ads-optimizer`                    | G kuralları her guard turunda; O kuralları haftalık (Pazartesi 07:00, hesap saati) | Ajans tick adımı            | Proje + hafta parmak izi                      | 0 (aynadan)                                 | Ertesi gün                                                                                                                           |
| `token-health`                     | Günlük + bağlanırken                                                               | Ajans tick adımı            | `updatedAt` CAS                               | 2 platform çağrısı                          | Geçersizse EXPIRED + uyarı                                                                                                           |
| `approval-expiry`                  | Her tick + karar anında (`decide` CAS koşulu) | Mevcut `sweepExpired` | CAS | 0 | Görev CANCELLED, kart "Expired" |
| `ads-daily-digest`                 | 08:30 (proje saati); Ads sohbetine SYSTEM kartı | Ajans tick adımı | Proje + gün | 0 | Atlanır |
| `ads-weekly-report`                | Pazartesi 08:00 | Ajans tick adımı | Proje + hafta | 1-2 okuma (+1 LLM) | Sonraki tick |
| `ads-monthly-report`               | Ayın 1'i | Ajans tick adımı | Proje + ay | 0-3 okuma (+1 LLM) | Sonraki tick |
| `ads-retention`                    | Günlük 03:00 UTC                                                                   | Ajans tick adımı            | Global kilit                                  | 0                                           | —                                                                                                                                    |
| `meta-webhook-ingest` (F7)         | HTTP                                                                               | `/api/webhooks/meta-ads`    | dedupe anahtarı                               | 0                                           | Hemen 200 döner; yoklama yedek kalır                                                                                                 |
| `meta-webhook-process` (F7)        | Her tick | Ajans tick adımı | Satır CAS | Olay başına 1 hedefli okuma (2 dk debounce) | 5 deneme → DLQ |
| `meta-webhook-subscription` (F7)   | Günlük | Ajans tick adımı | — | 2 okuma | Düşmüşse yeniden abone olur ve uyarı açar |

Yeni tick adımları `agency-wiring.ts` içinde `registerAgencyTickStep` ile kaydedilir. Adımlar sırayla koşar ve tick süresi LLM'li adımlar yüzünden dakikaları bulabilir (`TICK_WATCHDOG_MS` 5 dk). Bu yüzden `meta-ads-sync`, `meta-ads-guard` ve `meta-launch-watchdog`, `agency-loop-heartbeat`'ten hemen sonra, LLM'li adımlardan (insight-synthesis, idea-pool-refill, haftalık taslak) önce kaydedilir ve her biri adım başına 30 sn bütçe taşır. Bugün en sonda olan `telegram-approval-polling` de bunların hemen arkasına alınır. Adlar `legacy-loop.ts`'teki GENERATORS/DRAINERS listelerine ve `agency-focus.ts`'teki `FOCUS_DISABLED_TICK_STEPS`'e girmez, böylece her modda çalışırlar. Bayrak `process.env`'den çağrı anında okunur.

### 5.1 Kota bütçesi

**Meta sınırları (araştırma):**

| Sınır                                                                 | Dev / Limited                                         | Standard / Full                                           |
| --------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Hesap puan kovası (okuma 1, yazma 3)                                  | 60 puan / 300 sn (aşılırsa 300 sn blok)               | 9.000 puan / 300 sn (aşılırsa 60 sn blok)                 |
| BUC `ads_management` (hesap başına, saatlik)                          | 300 + 40 × aktif reklam                               | 100.000 + 40 × aktif reklam                               |
| BUC `ads_insights` (hesap başına, saatlik)                            | 600 + 400 × aktif reklam                              | 190.000 + 400 × aktif reklam (− 0,001 × kullanıcı hatası) |
| Yazma QPS (uygulama + hesap)                                          | 100                                                   | 100                                                       |
| Platform (kod 4, kullanıcı token'lı Graph; Marketing API dahil değil) | 200 × günlük aktif kullanıcı / saat (uygulama geneli) | aynı                                                      |

Başlıkta tier adı `development_access` / `standard_access` olarak görünebilir; Mayıs 2026'dan beri arayüzdeki adları Limited / Full. Eşleme doğrulanmalı.

**Aktif bir hesabın saatlik okuma kullanımı (bizim tasarım):**

| Kalem                                       | Sıklık     | Çağrı | Puan/sa                          |
| ------------------------------------------- | ---------- | ----- | -------------------------------- |
| Bugünkü insights (hesap + kampanya kimlikle + ad set + reklam) | 30 dk | 4 × 2 | 8 |
| Pencere metrikleri (ad set + reklam, 7 ve 28 gün) | 60 dk | 2 | 2 |
| Yapı (kampanya + ad set + reklam kenarları) | 60 dk      | 3     | 3                                |
| Hesap sağlığı + pikseller                   | 6 sa       | 2     | ~0,3                             |
| Geri doldurma (28 gün × 3 seviye, sayfalı)  | Günlük     | 3-9   | ~0,3 (04:00'te tek seferlik yük) |
| Hedefli yenileme / "Refresh"                | Olay bazlı | ≤ 4   | ≤ 4                              |
| **Toplam**                                  |            |       | **~14-18 puan/sa**               |

- Dev kovası kayan pencerede saatte en çok ~720 puan alır (60 / 300 sn); kullanımımız bunun **~%2-3'ü**.
- BUC payı: `ads_insights` 3 aktif reklamla saatte 1.800 çağrı; kullanımımız ~10-12, yani < %1. `ads_management` saatte 420; kullanımımız ~3-4, yani ~%1.

**Yazmalar:**

| İşlem | Çağrılar | Puan | Dev'de |
| ----- | -------- | ---- | ------ |
| Review (onaydan önce, 3 reklam × 2 oran) | 6 görsel yükleme + kampanya ve kreatif `validate_only` (~4) + 4-6 önizleme + 2-3 preflight | ~35-40 | Review sırasında, kendi penceresinde. Review ile onay aynı 300 sn'ye düşerse governor kurulumu bekletir |
| Lansman (onaydan sonra) | 3 kreatif + kampanya + ad set + 3 reklam + 1 aktivasyon ≈ 9 yazma + ~3 geri okuma | ~30 | P0 için 12 puanlık rezerv korunarak 54'lük kovaya sığar. Yazmalar `acc_id_util_pct` ölçülerek hız ayarlı yürür. Hesap başına aynı anda tek lansman çalışır |
| Bütçe kararı (CAS okuma + yazma) | 1 + 1 | 4 | Serbest |
| "Pause all" | Kampanya başına 1 yazma (KOBİ'de 1-2) | 3-6 | P0 rezervi içinde. Meta blok uyguluyorsa reset beklenir (§3.9) |

Gerekçe: ilk taslaktaki "16 yazma ≈ 51 puan" hesabı her reklamın 4:5 ve 9:16 varyantını ve beş ayrı aktivasyon yazmasını saymıyordu; doğru sayımla Dev'de 300 sn'lik blok kaçınılmazdı. Görsellerin Review'a, aktivasyonun tek kampanya yazmasına alınması bunu çözer.

**Ajans senaryosu** (20 hesap, her birinde 5 aktif reklam):

- Kovalar hesap başınadır; her hesap yine ~%2 kullanır. Toplamda saatte ~240-280 okuma yapılır.
- Senkron kapasitesi ölçülen tick süresine göre hesaplanır: tick başına 3 hesap ve ortalama tick süresi T ile saatte ~3 × 3.600 / T hesap (10 sn'lik tick'te ~1.000, 60 sn'de ~180). Meta adımları LLM'li adımlardan önce koştuğu için uzun tick'ler senkronu geciktirmez (§5).
- Uygulama düzeyi Insights kısıtının (`X-FB-Ads-Insights-Throttle.app_id_util_pct`) mutlak değeri belgelenmemiş. Governor %75'te P2'yi (arka plan) yavaşlatır; eşik ilk haftalarda gözlenerek ayarlanır (doğrulanmalı).
- Platform çağrıları (`debug_token`, `/me/permissions`, `/me/adaccounts`, `/me/accounts`) bağlantı başına günde ~4 tanedir; 20 bağlantıda günde ~80, yani ihmal edilebilir.
- 3 Ekim'deki (#4) hatasının asıl tüketicisi sağ paneldeki Instagram kartıydı ve düzeltildi (§3.1 Güvenlik); kalan kaynak F1'de `X-App-Usage` çağrı noktasıyla loglanarak ölçülür.
- 100 hesapta saatte ~1.200-1.400 okuma yapılır; hesap başına kullanım yine düşüktür. Limited tier ise "canlı reklamverenle çalışan üretim uygulaması için değildir"; bu yüzden Full tier yalnız ölçek için değil, ilk gerçek müşteri hesabı için de önkoşuldur (§7).
- Farklı hesaplardaki lansmanlar paralel çalışabilir; aynı hesaptaki lansmanlar seridir.

**Full access için hata oranı:** Son 500 Marketing API çağrısında hata oranı %15'in altında olmalı; Graph ve Instagram Login çağrıları bu orana girmez. Bunu sağlayan önlemler: yerel doğrulama, `validate_only`, kapalı hesaba yazmamak, kotaya saygı ve kör tekrar yapmamak. Ayrıca kullanıcı hataları Insights kotasını da düşürür.

---

## 6. Profesyonel oyun kitabı

KOBİ ölçeğine (günlük 5-50 USD, çoğunlukla pikselsiz, Instagram/Facebook odaklı) uyarlanmıştır. Bazı varsayımlar:

- Hedef CPA yoksa kurallar haftalık planın oranlarına düşer ve kullanıcıdan değer sorulur.
- Ülke benchmark'ı yerine hesabın kendi 28 günlük tabanı kullanılır. TR/Balkan CPM/CPL rakamları düşük güvenlidir ve doğrulanmalıdır.
- Hacim düşükse günlük yerine haftalık toplulaştırma yapılır.

**Koruma kuralları** (sürekli, 15-30 dk; acil olanlar öğrenme kapısına takılmaz):

| Kod | Kural               | Koşul / eşik                                                                                        | Asgari veri                                | Eylem                                                                                    | Otonomi                                                                                        | Gerekçe                                                                                                  |
| --- | ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| G1  | Kaçak harcama | Günlük: bugünkü harcama > 2 × (bugün yürürlükte olmuş en yüksek günlük bütçe). Haftalık: hesap saatiyle Pazar 00:00'dan bu ana kadarki harcama > Σ(haftanın her günü için o gün yürürlükteki günlük bütçe) × 1,05. Bütçe geçmişi `AdsOperation`'dan alınır. Para değerleri hesap ve kampanya toplamlarından okunur (§3.2) | — | PAUSE (ad set / kampanya) + CRITICAL | Suggest: tek dokunuş "Pause". Guarded: otomatik | Meta günde 1,75 kattan, takvim haftasında (Pazar-Cumartesi) 7 kattan fazla harcamaz; bu sınırın aşılması hata ya da drift işaretidir. ISO haftası ya da gün içinde düşürülen bütçeye göre hesap yanlış alarm üretirdi |
| G2  | Zarf aşımı | Kampanyanın toplam harcaması (kimlikle `/{campaign_id}/insights`; arşivlenen ve silinen alt nesneler dahil) ≥ onaylı zarf ya da MTD ≥ aylık tavan | — | PAUSE + yenileme kararı | Guarded: otomatik. Ad set `end_time` ve `spend_cap` sert durdurur | Onaysız harcama olmaz |
| G3  | Sonuçsuz harcama | 0 optimizasyon sonucu ve harcama ≥ 3 × hedef CPA (hedef yoksa haftalık planın %50'si). OFFSITE_CONVERSIONS hedeflerinde değerlendirme penceresi geç atıf nedeniyle son 24 saati dışarıda bırakır | ≥ 1.000 gösterim | Ad set PAUSE + izleme kontrolü | Guarded: otomatik yalnız platform içi olaylarda (mesaj, anında form); site dışı dönüşümde öneri. Suggest: öneri | Çoğunlukla izleme kırığı ya da yanlış kurgudur; beklemek bütçe yakar |
| G4  | İzleme kırığı       | Tıklama/LPV 14 günlük tabanın ±%30'unda, dönüşüm tabanın %30'unun altında; piksel 24 saattir sessiz | Tabanda günde ≥ 5 dönüşüm (yoksa haftalık) | Bütçe artışları dondurulur + uyarı                                                       | Suggest                                                                                        | Sinyal kaybı imzası                                                                                      |
| G5  | Ret / sorunlu nesne | DISAPPROVED, WITH_ISSUES, PENDING_BILLING_INFO; 24 saati aşan PENDING_REVIEW                        | —                                          | Uyarı; `ad_review_feedback` / `issues_info` sade dille; "Fix with a new creative"        | Suggest (aynı içerik asla yeniden gönderilmez)                                                 | Reddedilen reklam düzenlenemez (2490427)                                                                 |
| G6  | Hesap engeli        | `account_status` ≠ 1, `disable_reason` ≠ 0 ya da ödeme yöntemi yok                                  | —                                          | Bizim yazmalarımız durur (3/8/9'da artış ve yeni kampanya, diğerlerinde tümü) + CRITICAL | Her zaman                                                                                      | Kapalı hesaba yazmak hata oranını bozar                                                                  |
| G7  | Token / izin        | Token geçersiz, ≤ 7 gün kalmış, `ads_management` eksik ya da hesap `target_ids` dışında             | —                                          | Uyarı; geçersizse otomasyon donar                                                        | Her zaman                                                                                      | 60 günlük token sessizce düşer                                                                           |
| G8  | Teslimat yok | configured ve effective durum ACTIVE; `start_time` ≤ şimdi < `end_time`; kampanya ve hesap `spend_cap`'i dolmamış; `budget_remaining` > 0; reklam PENDING_REVIEW değil; ve son 24 saatte 0 gösterim ya da 48 saat boyunca planın < %20'si | — | Teşhis (durum, issues, reklamın ve hesabın `failed_delivery_checks`'i, bütçe < asgari, kitle boyutu, çakışma) + uyarı | Suggest | En sık görülen "sessiz durma". Ad set `effective_status`'ta COMPLETED değeri yoktur; bu koşullar olmadan bitmiş ya da başlamamış nesneler yanlış alarm üretir |
| G9  | `spend_cap` yakın ya da dolu | `amount_spent` ≥ `spend_cap`'in %90'ı; tavan dolduysa teslimatsızlığın nedeni olarak G8 yerine bu kural raporlar | — | Uyarı + yenileme önerisi | Suggest | Tavan dolunca teslimat aniden durur |

**Optimizasyon kuralları** (haftalık; acil değiller):

| Kod | Kural                        | Koşul / eşik                                                                                                                                                               | Asgari veri                                      | Eylem                                                                                    | Otonomi                                      | Gerekçe                                                                                                         |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| O1  | Öğrenme koruması (üst kural) | Ad set LEARNING ya da son anlamlı düzenlemeden < 72 sa                                                                                                                     | —                                                | Acil olmayan tüm öneriler bekletilir; hız sınırları (§3.9)                               | Her zaman                                    | Düzenlemeler öğrenmeyi sıfırlar (Meta: 7 günde ~50 olay; dinamik eşik varsa `dynamic_lp_conversions_threshold`) |
| O2  | Yüksek CPA                   | 7 günlük CPA > 1,5 × hedef                                                                                                                                                 | Harcama ≥ 3 × hedef CPA                          | Bütçe −%20-30. İki ardışık değerlendirmede sürerse kurgu değişikliği ya da PAUSE önerisi | Guarded: düşürme otomatik; geri kalanı öneri | Gürültüye aşırı tepkiyi önler                                                                                   |
| O3  | Ölçekle | CPA ≤ 0,8 × hedef (ya da ROAS ≥ 1,2 × hedef), soğuk kitlede 7 günlük sıklık (`windowStats`) < 2,5, son değişiklikten ≥ 72 sa, öğrenme dışında | KOBİ: 7 günde ≥ 10-15 sonuç (büyük hesapta ≥ 50) | +%20 (küçük bütçede en az ~2-5 USD karşılığı), zarfı aşmadan | Suggest (Full auto'da zarf içinde) | Yaygın uygulama: 48-72 saatte %20-30 |
| O4  | Kreatif yorgunluğu | Şunlardan en az ikisi: link CTR −%20 (7 günlük taban), CPM +%15, hook −%20, soğuk kitlede 7 günlük sıklık (`windowStats`) > 3 (yerel hizmette > 4). Ya da Meta "Creative fatigue" bildirdi | ≥ 14 gün ve ≥ 5.000 gösterim | Fikir havuzuna konsept isteği; otomatik görsel üretimi yok | Suggest | Erken sinyaller resmi durumdan 1-2 hafta önce gelir |
| O5  | Kaybeden reklam | Harcama ≥ 2,5 × hedef CPA ve 0 sonuç; ad set'te en az 2 başka aktif reklam. 7 günde ad set harcamasının %5'inden azını alan reklam kaybeden değil, Meta tarafından geri çekilmiş sayılır ve durdurma önerilmez | ≥ 1.000 gösterim | Durdurma önerisi | Suggest | Meta harcamayı zaten kaybedenden çeker; KOBİ'de erken öldürme yapılmaz |
| O6  | Düşük link CTR               | Link CTR < hesabın 28 günlük medyanının %70'i                                                                                                                              | ≥ 2.000 gösterim                                 | Yeni hook ya da teklif briefi                                                            | Suggest                                      | Tüm tıklamaları sayan CTR yanıltıcıdır                                                                          |
| O7  | Zayıf video hook'u           | 3 sn oynatma / gösterim < %20 (iyi değer ≥ %30)                                                                                                                            | ≥ 1.000-2.000 gösterim                           | İlk 3 saniye için kreatif briefi                                                         | Suggest                                      | En erken kalite sinyali                                                                                         |
| O8  | Learning limited             | `learning_stage_info.status = FAIL`, ≥ 7 gündür                                                                                                                            | —                                                | Birleştirme, daha sık olay, kitle genişletme ya da bütçe = hedef CPA × 50/7 önerisi      | Suggest (bilgi)                              | Ceza değil, yön gösterir                                                                                        |
| O9  | Birleştirme                  | Ad set sayısı > max(1, haftalık bütçe / (50 × hedef CPA))                                                                                                                  | 14 gün                                           | Ad set birleştirme önerisi                                                               | Suggest                                      | Bölünme öğrenmeyi yavaşlatır ve çakışma yaratır                                                                 |
| O10 | Aylık tempo (ajans)          | MTD, doğrusal planın ±%10'u dışındaysa uyarı; ±%20 dışındaysa yeni günlük bütçe = kalan / kalan gün                                                                        | Ayın en az 5. günü                               | Bütçe ayarı önerisi                                                                      | Guarded: yalnız düşürme                      | Ajans bütçe disiplini                                                                                           |
| O11 | "Winner" etiketi             | İki varyantın CPA oranı ≥ exp(1,96·√(2/n)): n=25 → 1,74×, n=50 → 1,48×, n=100 → 1,32×                                                                                      | Varyant başına n ≥ 25 sonuç                      | "Winner"; kapıyı geçmeyene "directional"                                                 | —                                            | Poisson yaklaşımı (bizim türetimimiz)                                                                           |
| O12 | Meta önerileri               | `/act_x/recommendations`                                                                                                                                                   | —                                                | "Meta suggests…" ikinci görüş                                                            | Asla otomatik değil                          | Uygulamak şartları kabul etmek demektir                                                                         |
| O13 | Zayıf hold rate | ThruPlay / 3 sn oynatma < %15 | ≥ 300 adet 3 sn oynatma | Video gövdesi ve tempo için kreatif briefi | Suggest | Hook'u geçen izleyici videoda kalmıyor |
| O14 | Kreatif ritmi | Performans iyi olsa da son yeni konseptten bu yana KOBİ'de 3-6 hafta, büyük hesapta 1-2 hafta geçti | — | Fikir havuzuna yeni konsept isteği | Suggest | Yorgunluk gelmeden yenilemek ucuzdur; Andromeda çeşitliliği ödüllendirir |

**Lansman öncesi kurallar** (P; §3.4'teki yerel doğrulama):

- **P1 Bütçe:** Asgari bütçe = `act_x/minimum_budgets` yanıtında ad set'in optimizasyon ve faturalama türüne karşılık gelen değer (alan adları fikstürle doğrulanır); bu değer yoksa `min_daily_budget`. Tek alan, tıklama ya da dönüşüm optimizasyonlu ad set'te asgariyi düşük gösterip 1885272'ye yol açabilir. Ömür boyu bütçede değer gün sayısıyla çarpılır; yanıt hesap başına 24 saat önbelleklenir. Ayrıca bütçe / hedef CPA ≥ ~7 olmalı; değilse daha sık bir olay önerilir.
- **P2 Kombinasyon:** Amaç × `optimization_goal` × `destination_type` × `promoted_object` × `billing_event`, ODAX tablosuna uygun olmalı. `adset_schedule` varsa `lifetime_budget` ve `pacing_type=["day_parting"]` zorunludur.
- **P3 Kitle otomasyonu:** `advantage_audience` açıkça gönderilir (F0b'de 0; F5b'den itibaren varsayılan 1). Açıkken `age_min` ≤ 25 ve `age_max` = 65 olur.
- **P4 Özel kategori:** HEC'te kitle §3.9'daki kurallarla kilitlenir ve preflight 2859024'ü kontrol eder. Siyaset ve kumar v1'de desteklenmez.
- **P5 DSA ve bölgesel kimlik:** AB/AEA hedefi → `dsa_beneficiary` + `dsa_payor` (en fazla 512 karakter); hesap varsayılanları yalnız müşterinin açık onayıyla yazılır. Brezilya, Tayvan, Tayland, Singapur, Avustralya-finans ve Hindistan-finans hedefleri `regional_regulated_categories` + `regional_regulation_identities` (Meta'da doğrulanmış kimlik ID'leri) ister; v1'de bu ülkeler desteklenmez, hedeflemede seçilirse lansman gerekçesiyle engellenir.
- **P6 Politika:** Politika lint'i ve approved claims karşılaştırması.
- **P7 Biçim ve çeşitlilik:** 4:5 + 9:16 (`asset_feed_spec`) ve güvenli alan; video varsa kapak görseli hash'i var ve `video_status=ready`; ad set başına 3-6 reklam ve en az 3 konsept önerilir.
- **P8 Süre:** `end_time` ya da always-on zarfı zorunludur.
- **P9 Kimlik:** IG kimliği şu sırayla seçilir: (1) `act_x/instagram_accounts` içinde Sayfanın bağlı IG hesabı varsa onun ID'si; (2) bağlı hesap yoksa ya da reklam hesabı bir Business Manager'a aitse PBIA (`POST /{page_id}/page_backed_instagram_accounts`; Sayfada zaten varsa mevcut ID döner); (3) aksi hâlde lansman "Connect your Instagram account to this ad account" mesajıyla engellenir (1815199). BM'ye ait olmayan reklam hesabında Sayfanın bağlı IG hesabı varsa PBIA kullanılamaz. `instagram_actor_id` hiç gönderilmez (`instagram_user_id` ile birlikte 2238055/2446149 verir).
- **P10 Meta AI:** `creative_features_spec` K14 listesiyle açıkça gönderilir ve geri okunur; `contextual_multi_ads.enroll_status` açık değerle gönderilir.
- **P11 UTM:** UTM şablonu.
- **P12 Preflight:** Hesap preflight'ı.
- **P13 Bütçe düzeyi ve düşürme:** Bütçe tek düzeyde olur (CBO ya da ABO). Düşürmede yeni değer, harcanan tutarın %110'undan az olamaz.
- **P14 Erişim sıklığı:** REACH hedefinde `frequency_control_specs` gönderilir (7 günde 2-3 gösterim; doğrulanmalı).

---

## 7. Erişim ve App Review önkoşulları

| Önkoşul                                                                    | Bugün                                                             | Gereken                                                                                                                                                                                                           | Ne zaman                                                      | Beklenen süre                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Business Verification                                                      | Tamam                                                             | —                                                                                                                                                                                                                 | —                                                             | —                                         |
| App Review: `ads_management`, `ads_read` (Advanced), `business_management` | Başvuru sürüyor; ads izinlerinin dahil olup olmadığı doğrulanmalı | İnceleyici senaryosu ve ekran videosu: giriş → reklam hesabı seçimi → PAUSED kampanya → 5 metrik (Impressions, Conversions, Spend, Clicks, Reach) | F0 ile başlayan paralel kritik yol; gerçek müşteri lansmanından (F3) önce bitmeli | Günler-haftalar (doğrulanmalı) |
| Uygulamanın Live moda geçmesi | Dev mod: uygulamanın gönderisiyle (`object_story_spec`) kurulan her reklam, sahibin test hesabında da 1885183 ile düşüyor | App Review'dan sonra Live | Test için F1 sonu (sahip kararı; izinler Standard Access'te kaldıkça yalnız uygulamada rolü olanlar izin verebilir); gerçek müşteri için Advanced Access sonrası | — |
| Marketing API Access Tier: Full | Limited; 500 çağrı şartı panelde "Completed" (3 Eki) | Son 15 günde en az 500 başarılı Marketing API çağrısı (tamam) ve son 500 çağrıda < %15 hata; ardından App Dashboard > App Review > Permissions and Features > Marketing API Access Tier > +Upgrade. Meta, Limited için "for development only; not for production apps running for live advertisers" diyor ve Limited'da çağrıları yalnız uygulama admin ve geliştiricileri yapabiliyor | Talep F1 sonunda. F2'nin gerçek müşteri hesaplarında açılması ve F3'teki gerçek müşteri lansmanı Full tier onayına bağlıdır | Onay otomatik değil; süresi belirsiz |
| Lead izinleri                                                              | Yok                                                               | `pages_manage_ads` (form oluşturma). Lead iletişim bilgisi gerekirse ek olarak `leads_retrieval` + `pages_manage_metadata`                                                                                        | F5b | App Review                                |
| Instagram kimliği | Ads bağlantısı IG alanını istemiyor | IG hesap kimliği `act_x/instagram_accounts` (ya da Page token'ıyla `/{page_id}/instagram_accounts`) ile okunur; yoksa PBIA (`POST /{page_id}/page_backed_instagram_accounts`). BM'ye ait olmayan reklam hesabında, Sayfanın bağlı IG hesabı varsa PBIA kullanılamaz. Reklam hesabının IG hesabına erişimi yoksa 1815199 gelir (P9) | F3 | — |
| Ads webhooks | Yok | Uygulama düzeyinde abonelik (`object=ad_account`), hesap başına `subscribed_apps`, `X-Hub-Signature-256` doğrulaması. `subscribed_apps` reklam hesabının ADMIN token'ını ister (admin kullanıcı ya da system user); yalnız ADVERTISE görevi olan ajans çalışanında webhook gelmez, hesap "polling only" kalır | F7 | — |
| "Require App Secret"                                                       | Kapalı olduğu varsayılıyor                                        | `appsecret_proof` devreye alındıktan sonra açılır                                                                                                                                                                 | F1                                                            | —                                         |
| FB Login deauthorize / data deletion                                       | Yalnız IG Login için var                                          | `meta_ads` için uçlar + Meta panel ayarları                                                                                                                                                                       | F1                                                            | —                                         |
| Gizlilik metni + veri işleme yanıtları                                     | "latest performance figures" diyor                                | Günlük veri saklama süresi (F2), otomatik koruma eylemleri (F7), lead verisi (F5b)                                                                                                                                 | İlgili faz                                                    | —                                         |
| Test ortamı | Yok; yerel geliştirme ve canlı aynı Meta uygulamasını paylaşıyor | Ayrı "Agentelse Dev" Meta uygulaması (dev modda, K25): yerel geliştirme, test reklam hesabı ve uçtan uca denemeler bununla yapılır, böylece canlı uygulamanın kotası ve Full tier hata oranı etkilenmez. Sandbox reklam hesabı: uygulama başına 1, teslimat yok, kreatif oluşturma kısıtlı olabilir (doğrulanmalı). Ayrıca küçük `spend_cap`'li gerçek bir test reklam hesabı ve uygulamada rolü olan bir test kullanıcısı. Canlı uygulamaya kasıtlı hatalı çağrı yapılmaz | F0-F1 | — |

**Token stratejisi:**

| Seçenek                                      | Artı                                                                                                      | Eksi                                                                                                                                       | Ne zaman                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Kullanıcı token'ı (bugün; ~60 gün)           | Akış hazır                                                                                                | Sessizce düşer; şifre değişince erken biter; süresi dolan token uzatılamaz; veri erişimi son aktiviteden 90 gün sonra biter                | Şimdi, sağlık denetimiyle (F1)       |
| Facebook Login for Business + BISU token     | Süresiz; müşterinin business portfolio'suna bağlı; kişiye bağlı değil; arka plan işleri için önerilen yol | Business tipi uygulama + `config_id` ve Advanced Access gerekir; BISU'ya 90 günlük veri erişimi kuralının uygulanıp uygulanmadığı belgesiz | F8 (Full tier ve App Review sonrası) |
| Ajans BM'sinde system user + partner erişimi | Ajansın kendi kontrolü; Full tier'da 10 system user                                                       | Müşteri hesabına partner erişimi ve görev ataması gerekir (100/33 hatası)                                                                  | F8 (ajans seçeneği)                  |

Token düşerse yeni yazma yapılamaz; ama `end_time`, `lifetime_budget` ve `spend_cap` token'dan bağımsız ve kesin olarak çalışır, mevcut kampanyalar bunlarla sınırlı kalır. Kısa vadede kullanıcı token'ıyla ilerlemeyi güvenli kılan budur. Ad Rules (F7) ise kuralı oluşturan kullanıcının token'ı ya da erişimi düştükten sonra da çalıştığı test hesabında doğrulanana kadar garanti sayılmaz.

---

## 8. Test ve doğrulama stratejisi

Sahibin tercihi: ağır inceleme turları ya da mutasyon testleri yapılmaz. Asgari kapı şudur: `tsc` + `eslint` + yeni ve etkilenen testler. Bu makinede `npm run build` Turbopack hatası verdiği için `tsc` ve dev logu kullanılır; build CI'da çalışır.

| Katman            | Kapsam                                                                                                                                                                                                                                             | Yöntem                                                                                                                                                  | Ortam      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Sözleşme          | Graph yanıt ve hata gövdeleri (190/463, 4, 17/2446079, 613/1487632, 80000, 80004, 100/1885183, 100/4834011, 2446307, 1487990, 2490427, 3858152, `blame_field_specs` örneği); seviye başına alan listeleri (`fields.ts`); sayfalama; kullanım başlıkları; HTTP 200 + boş veri; async rapor durumları (F8) | Fikstürler Meta'nın belgelenmiş hata gövdelerinden elle yazılır ya da Dev uygulamasıyla kaydedilir; canlı uygulamaya kasıtlı hatalı çağrı yapılmaz (`src/server/integrations/meta/__fixtures__/`, sürüm klasörüyle) + `vi.stubGlobal("fetch")` | CI |
| Birim             | `money` (ofset 1 ve 100 olan para birimleri), ücret tablosu, ODAX doğrulayıcı, sonuç eşlemesi, her kuralın sınır değerleri (G1'in Pazar-Cumartesi haftası dahil), öğrenme/asgari veri/istatistik kapıları, governor, hata kataloğu, uzlaştırma kararı, drift, saat dilimi gün anahtarı, politika lint'i, L4 rol kapısı (web, Telegram, sohbet), onay süresi | Vitest; saf modüller | CI |
| Entegrasyon (DB)  | Kilit/CAS, niyet günlüğü idempotency'si, uyarı tekilleştirme, karar CAS'i, saklama temizliği                                                                                                                                                       | Tek kullanımlık yerel Postgres (Unix soketi tarifi). Paylaşılan DB asla kullanılmaz                                                                     | Yerel      |
| Arıza enjeksiyonu | Oluşturmadan sonra zaman aşımı, süreç ölümü, çift dispatch, 613/17 blokları, adım ortasında 190                                                                                                                                                    | Sahte fetch + zamanlayıcı; "tam 1 nesne" doğrulaması                                                                                                    | CI / yerel |
| Uçtan uca         | PAUSED lansman, `validate_only` (kampanya ve kreatif; bayrakla reklam), önizleme, DSA, `advantage_audience`, CBO/ABO, Messages/Leads, `spend_cap` asgarisi ve birimi, `end_time` (uzatma dahil), arşivleme ve silme sonrası toplamlar | Gerçek test reklam hesabı (küçük `spend_cap`) + sandbox hesabı, Dev uygulamasıyla; uygulamada rolü olan test kullanıcısı; yerel işçi yalnız tek kullanımlık DB'ye bağlanır. Uygulama dev moddayken reklam adımı `object_story_id` (Sayfada elle oluşturulmuş gönderi) ya da `source_instagram_media_id` ile yapılır; `object_story_spec` yolu Live moda geçince ayrıca doğrulanır | Yerel |
| Gölge mod         | Optimizasyon kararları | `META_ADS_OPTIMIZER=shadow` ile en az 30 karar ya da 4 hafta; yetmezse aynanın 28 günlük geçmişi üzerinde replay; sahip örnekleri inceler | Canlı |
| Canlı doğrulama   | Aynanın doğruluğu (dünkü hesap harcaması ±%1; hesap toplamı = kampanya toplamları = reklam satırları, arşivleme ve silme sonrasında da; sonuç sayısı "Results" sütunuyla ±%1), hata oranı, kota, kalp atışı | Günlük uzlaştırma işi + /health | Canlı |

Mevcut `meta-performance-scanner.test.ts` ve `ads-flow-actions.test.ts` korunur. Kural testleri yeni modüle taşınır. Test edilmeyen `request()` hata ayrıştırması ile `isMetaRateLimit` sözleşme testleriyle kapatılır.

---

## 9. Fazlı yol haritası

Önerilen sıra: F0a → F0b → F1 → F2 → F3 → F5a → F4 → F5b → F6 → F7 → F8. F5a, numarasına rağmen F4'ten önce gelir: KOBİ'nin asıl ihtiyacı mesaj hedefidir ve F4'ün gölge modu ancak canlı hesaplarda karar biriktikçe ölçülebilir (K26). F6, F5b ile paralel yürüyebilir. Her fazdan sonra `docs/meta-ads.md` güncellenir. İlerleme raporlarında hangi ekranda neyin değiştiği (rota, kart adı, bayrak, migration) yazılır.

**Paralel kritik yol (F0 ile başlar, kod dışı):** `ads_management`, `ads_read` ve `business_management` için App Review gönderimi (PAUSED kampanya + 5 metrik senaryosu), Live mod geçişi, Full tier başvurusu (+Upgrade), test reklam hesabı ve ayrı Dev uygulaması (K25). Gerçek müşteri hesabında senkron (F2) ve lansman (F3) bu yola bağlıdır; kod fazları bu yolu beklemeden test hesabıyla ilerler.

### F0a — Birikim kapısı ve işçinin açılması · S (aynı gün)

**Amaç:** Arka plan işlerini canlıda, bayat işler çalışmadan geri getirmek.

**Kapsam:**

- `src/server/execution/execution-service.ts` → `startExecution`: kapı dispatch'te değil, işçinin claim noktasındadır, çünkü 1 Ekim birikimi zaten dispatch edilmiş durumda (ExecutionJob QUEUED, outbox PENDING). META_* yazmalarında `now − approval.reviewedAt > 24 sa` ya da `now − task.createdAt > 72 sa` ise iş ve görev CANCELLED olur (`failureReason: "Stale after worker outage"`); kart "Approve again" gösterir.
- `src/server/observability/self-healing.service.ts` → `requeueRecoverableDeadLetters`, niyet günlüğü gelene kadar (F1) META_* yazmalarını atlar.
- Zamanlanmış yayın: planlanan saati 24 saatten eski slot yayınlanmaz, takvimde "Missed" kalır (K2'de sahip onayıyla).
- Salt okunur rapor: `prisma/worker-backlog-report.ts` + `npm run db:report:backlog` (repodaki betikler `prisma/` altında durur ve npm script ile çalışır). Rapor tüm iş tiplerini kapsar: bekleyen işler ve onaylar, tarihi geçmiş zamanlanmış yayınlar, haftalık taslaklar ve LLM'li ajans adımları.

**Sahip adımları (kod dışı):**

1. Rapor okunur ve K2 kararı verilir.
2. Railway'de **web servisi** → Variables → `ENABLE_INPROCESS_WORKER=true` (yalnız bu serviste, tek kopya).
3. Yeni bir `CRON_SECRET` üretilir ve aynı değer hem Railway web servisine hem GitHub → Settings → Secrets → `CRON_SECRET`'e yazılır. `PROD_WORKER_URL` kontrol edilir.
4. Bozuk Railway cron-worker servisi silinir; başlangıç komutunda secret düz metin olarak görünüyordu.

**Sıra:** Önce F0a kodu deploy edilir, sonra işçi env üzerinden açılır. Kalp atışı F0a'nın önkoşulu değildir; onu beklemek bütün arka plan özelliklerinin kesintisini gereksiz uzatır.

**Migration:** Yok.

**Bayrak:** Yok.

**Kabul ölçütleri:**

- Birikim raporu çıkarıldı ve K2 kararı uygulandı.
- Onayı 24 saatten ya da görevi 72 saatten eski META_* işi çalışmıyor (testli).
- SelfHealing META_* yazmasını yeniden kuyruğa almıyor (testli).
- 24 saatten eski yayın slotu yayınlanmıyor (testli).
- İşçi açıldıktan sonraki ilk saatte yeni işler normal akıyor (Recents ve takvimde gözlenir).

**Bağımlılık:** Yok.

**Görünür değişiklik:** Bayat Meta onay kartlarında "Approve again"; takvimde eski slotlar "Missed".

### F0b — Temel ve acil yamalar · M

**Amaç:** Arka plan işlerini görünür kılmak; bugün açık olan para ve onay risklerini kapatmak.

**Sahip adımları (kod dışı):**

1. Harici monitör hesabı açılır (K23): `GET /api/health?worker=1` adresi ya da heartbeat ping URL'si tanımlanır, uyarı e-postası ve isterse operatör Telegram'ı bağlanır. K23'te yedek plan seçilirse operatör Telegram'ı GitHub Secrets'a eklenir (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
2. Repo özelse `cron-worker.yml` zamanlaması `*/15`'e çekilir.

**Kapsam:**

- **Nabız:**
  - `prisma/schema.prisma` (`SystemHeartbeat`), `src/server/observability/heartbeat.ts` (yeni).
  - `src/server/workers/execution-worker.ts`: tick başında `lastBeatAt`, sonunda `lastOkAt` yazılır ve `data.maxGapMs24h` tutulur; dispatch, poll ve verify aşamaları `isolate()` içine alınır; `resolvePendingVerifications`'a öğe başına try/catch eklenir ve onarım sorgusu `task.status notIn [COMPLETED, CANCELLED, FAILED]` koşulunu alır.
  - `src/app/api/health/route.ts` (yeni): canlılık kontrolü; `?worker=1` verildiğinde nabız eskiyse 503 döner.
  - `src/lib/public-paths.ts`: `/api/health` eklenir.
  - Harici monitör (K23); reddedilirse yedek plan olarak `cron-worker.yml`'ye ikinci adım (§3.6). Ayrı bir `worker-watchdog.yml` açılmaz.
  - `src/instrumentation.ts`: açılış satırına `worker=on/off` ve `META` eklenir.
  - Uygulama içi işçi şeridi.
  - `railway.json`: `healthcheckPath` (canlılık).
- **Yerel güvenlik (K19):** `src/lib/local-worker-policy.ts` + işçi: development'ta META_* işleri ve `meta-ads-*` adımları claim edilmez (atlanır, FAILED yapılmaz); `META_ADS_DEV_ALLOWED_ACCOUNTS` izin listesi; yerelden Telegram ve uyarı gönderimi kapalı (§3.9).
- **Para:**
  - `src/lib/ads/money.ts` (yeni); `state.ts` ve `ads-insight.ts` yardımcıları buraya taşınır.
  - Düzeltilecek yerler: `meta-ads-actions.ts:56,107,479,535`, `approval-details.ts:94,110` (`formatBudget(minor, currency)`; para birimi olmayan eski yüklerde tutarın yanına "(account currency)" notu), `meta-performance-rules.ts:61`, `ads/page.tsx` ve `src/components/ads/*` gösterimleri.
  - Tüm META_* görev yüklerine `currency` ve `adAccountId` eklenir: modül akışı, eski sihirbaz, `PerformanceOptimizer` ve zincir röleleri.
  - `buildApprovalDetails`, bugün `undefined` döndürdüğü META_CAMPAIGN_CREATE için `__pendingAdSet`'ten şu satırları üretir: Daily budget, Runs for / Ends, Countries, Objective.
  - Eski CampaignWizard kampanyaya bütçe göndermez ve tek tarih/saat seçiciyle zorunlu bir End date ister.
  - Eski düzenleme formları: `campaign-edit-form` ABO kampanyada bütçe alanını göstermez, yalnız status düzenlenir; `updateMetaCampaignAction` bütçeyi yalnız kampanya CBO ise gönderir. `adset-edit-wizard` yalnız değişen alanları gönderir; targeting değişmediyse targeting yollanmaz.
- **Bitiş ve kitle:**
  - `src/lib/module-flows/ads/state.ts` `adsLaunchPayload`: `__pendingAdSet` mutlak bir tarih değil `durationDays` taşır. Zincir üç ayrı onay bekleyebildiği için Launch anında hesaplanan mutlak tarih planı kısaltır ya da geçmişte kalırdı.
  - `src/server/agency/meta-ads/meta-campaign-chain-relay.ts`: `PendingAdSet` tipine `durationDays` eklenir, `readPendingAdSet` bu alanı okur ve `payloadExtra`'ya geçirir. Röle alanları tek tek kopyaladığı için aksi hâlde alan düşer.
  - `meta-api-provider.ts` + `meta-client.ts` `createMetaAdSet`: ad set oluşturulurken `start_time` = şimdi, `end_time` = şimdi + `durationDays` (UTC ofsetli ISO 8601) ve `targeting_automation.advantage_audience=0` gönderilir. 0, Brief'teki yaş ve cinsiyeti bugünkü gibi sert sınır olarak korur; 1 ve "Suggest / Limit to" ayrımı F5b'de gelir.
  - Hesap saat dilimi Launch'ta tek bir `GET /act_x?fields=timezone_name` çağrısıyla okunur ve karta dondurulur.
  - Review metni: "Runs 7 days from creation, until 13 Oct 23:59 (UTC+3). Turning it on later does not move the end date." `copy.ts`'teki `noEndDate` metni kalkar.
  - DSA: Brief'te AB ülkesi seçiliyse ve hesapta `default_dsa_*` yoksa Review "Who benefits / Who pays" alanlarını ister ve ad set'e `dsa_beneficiary`/`dsa_payor` gönderilir; alanlar girilmeden AB ülkeleri seçilemez.
- **Tarayıcı** (`meta-performance-scanner.ts`, `performance-optimizer.ts`):
  - ABO kampanyalar değerlendirilir; bulgu ad set düzeyinde üretilir ve öneri `META_ADSET_UPDATE` ile verilir.
  - Minimal sonuç eşlemesi (`src/lib/ads/results.ts` ilk sürümü): ad set'in `optimization_goal`'ından LINK_CLICKS → `link_click`, REACH → `reach`, POST_ENGAGEMENT → `post_engagement`.
  - F2'ye kadar SCALE_BUDGET önerisi kapalıdır; yalnız ZERO_RESULTS_SPEND ve HIGH_CPA (PAUSE/REDUCE) açıktır.
  - PAUSE ve REDUCE önerileri `checkAndIncrement(tasksCreated)` kotasından muaftır (deterministik, LLM yok). Düşen her öneri AuditLog'a `ads.proposal_dropped` olarak yazılır ve /health'te görünür.
  - Metadata yazımları anahtar başına `jsonb_set` ile yapılır.
  - 190 hatasında bağlantı EXPIRED olur.
- **190:**
  - `src/server/integrations/meta-credential-health.ts` (yeni, `markMetaCredentialExpired`). 190/492 hariçtir: Sayfa rolü eksikliği yalnız o Sayfaya bağlı özelliği durdurur.
  - Çağıranlar: tarayıcı, `work-ads-actions.ts`, `modules/analytics/meta-ads.ts`, `meta-targeting-actions.ts` (hatayı yutmaz), `ads/page.tsx`, provider'ın adım catch'leri.
- **Kota:** `meta-client.ts:240` → koşul `code >= 80000 && code <= 80014` olur.
- **Nesne-hesap doğrulaması** (F1'den öne alındı; ajans müşterileri arası risk bugün açık): `MetaApiProvider`'ın update yollarında (`updateCampaign`, `updateAdSet`, `updateAd`) hedef nesne `GET /{id}?fields=account_id` ile okunur (önbellekli) ve görevdeki `adAccountId` ile karşılaştırılır; uyuşmazsa FAILED ("Ad account mismatch"). Seçili hesap onaydan sonra değişmişse iş FAILED olur ("Ad account changed since approval").
- **Onay güvenliği:**
  - `task-planner.ts`: META_* L4 onaylarına `expiresAt` = 72 sa.
  - `ApprovalRepository.decide`: CAS koşuluna `OR [{expiresAt: null}, {expiresAt: {gt: now}}]` eklenir; süre geçmişse kullanıcı "This approval expired. Ask again." görür. L4 rol kapısı da buradadır (§3.9 Roller) ve web, Telegram, Works, plan, post ve sohbet yollarının hepsini kapsar.
  - `expireOverdue`: süresi dolan onayın görevini de CANCELLED yapar (`failureReason: "Approval expired"`) ve TASK_CANCELLED tetiği üretir; kart "Expired — Edit and launch again" gösterir. Bugün yalnız Approval satırı güncellendiği için kart sonsuza dek "Still working" diyor.
  - Tek seferlik, idempotent ve `--dry-run`'lı backfill (`prisma/` altında betik + npm script): PENDING durumdaki, `level=LEVEL_4_CRITICAL` META_* onaylarından `expiresAt`'i null olanlara `createdAt + 72 sa` yazılır.
  - `telegram-approval-notifier.ts`: L4 mesajında Approve/Reject yerine "Review in Agentelse" bağlantısı olur. Mesaj yalnız Agentelse'in kendi verisini taşır: kullanıcının girdiği bütçe, süre ve amaç; Meta'dan okunan veri gönderilmez (K8).
  - `tools.ts` + `command-service.ts`: `decide_approval` L4 onayı vermez ("Approve it on the card above."); L3 META_* onayları için `approvalId` ister.
  - `health-actions.ts`: "Retry" FAILED işi QUEUED'a çevirir.
- **Riskli yolların kapatılması:**
  - `approval-decisions.ts`: `maybeProposeMetaCampaign` çağrıları kaldırılır.
  - `performance-optimizer.ts`: AD_FATIGUE artık `CREATE_AD_CREATIVE` açmaz, yalnız öneri üretir.
  - `measurement-engine.ts`: META_CAMPAIGN_CREATE şablonu çıkarılır.
- **Token süresi:** Integrations'taki Meta Ads kutucuğu, callback'in zaten yazdığı `metadata.longLivedTokenExpiresAt` değerinden "Expires in N days" gösterir.
- **Doküman:** `docs/meta-ads.md` (yeni).

**Migration:** `<ts>_add_system_heartbeat` (yalnız yeni tablo).

**Bayrak:** Yok; bunlar hata düzeltmeleri. Nabız ve sağlık ucu her zaman açık.

**Kabul ölçütleri:**

- 24 saatlik gözlemde `SystemHeartbeat("worker.tick").data.maxGapMs24h` < 6 dk ve harici monitörden sıfır alarm. (Tek satırlık ve üzerine yazılan tabloda "hiç 2 dakikadan eski olmadı" ölçülemezdi; meşru bir tick de dakikalar sürebilir.)
- `GET /api/health?worker=1` normalde 200 dönüyor. Tatbikat canlı işçi kapatılmadan yapılır: monitörde ikinci bir test kontrolü bilerek beslenmez ya da 503 dönen bir test adresine yönlendirilir; uyarı ≤ 15 dk içinde geliyor.
- Yedek GitHub tetikleyicisi son 24 saatte en az bir kez 200 döndü.
- Test hesabında modül akışıyla kurulan ad set'in geri okumasında `end_time` = oluşturma anı + süre (±5 dk) ve `advantage_audience=0`.
- Birim test: JPY ve TRY'de eski sihirbaz, kural motoru ve onay kartı aynı tutarı üretiyor.
- `isMetaRateLimit(80000)` true dönüyor.
- Tarayıcı ABO kampanyayı ad set düzeyinde değerlendiriyor; ABO kampanya için hiçbir öneri `META_CAMPAIGN_UPDATE` ile bütçe taşımıyor; tarama sırasında yapılan hesap seçimi kaybolmuyor (testli).
- Tüm 190 yolları (492 hariç) bağlantıyı EXPIRED yapıyor (testli).
- MEMBER web, Telegram ve sohbet yollarının hiçbirinden L4 onaylayamıyor (testli).
- Süresi dolan onay karar anında da reddediliyor; görevi CANCELLED oluyor ve kart "Expired" gösteriyor (testli).
- Başka hesaba ait nesneyi güncelleme isteği reddediliyor (testli).
- Tek bir bozuk VERIFYING satırı tick'i durdurmuyor; terminal görevler onarım sorgusuna girmiyor (testli).
- Development'ta işçi META_* işini claim etmiyor (testli).
- Düşen koruma önerisi AuditLog'da görünüyor.

**Bağımlılık:** F0a.

**Görünür değişiklik:**

- İşçi durursa OWNER/ADMIN'e şerit görünür.
- Telegram L4 mesajı kullanıcının girdiği tutarı ve "Review in Agentelse" bağlantısını gösterir.
- Ads kartının Review adımında "Runs 7 days from creation, until …" yazar; AB ülkesi seçilince DSA alanları istenir.
- Integrations → Meta Ads kutucuğunda "Expires in N days".

### F1 — Meta erişim katmanı ve hesap modeli · L

**Amaç:** Tüm Meta çağrılarını tek ve güvenli bir çekirdekten geçirmek; yazmaları idempotent yapmak; token ve hesap sağlığını bilmek.

**Kapsam:**

- **Çekirdek:**
  - `src/server/integrations/meta/{version,graph,errors,error-catalog,governor,paging,insights,fields}.ts` ve `__fixtures__/` (batch ve async rapor F8'de).
  - Governor durumu DB'de (`AdsAccount.lastUsage`, `rateLimitedUntil`); üç şerit, P0 rezervi ve çağrı ailesine göre devre kesici (§3.1).
  - `meta-client.ts` çekirdeği kullanır. `listAdAccounts` sayfalı olur ve durum alanlarını getirir; `minimum_budgets` ve `min_campaign_group_spend_cap` okunur.
  - `modules/analytics/meta-ads.ts` ortak çekirdeğe bağlanır.
  - Platform kotası ölçümü: her Graph yanıtındaki `X-App-Usage`, çağrı noktası etiketiyle 48 saat loglanır ve en çok tüketen nokta düzeltilir (aday: türetilen Page token'larının şifreli DB'de saklanması, `/me/accounts` ve `/me/adaccounts` için 1 saat önbellek). İlk taslaktaki "organik okumaları Page token'ına taşıma" işi zaten yapılmış durumda (`instagram-target.ts`, `fetchPageAccessToken`).
- **Niyet günlüğü:**
  - `src/server/ads/operations.ts` (yeni).
  - `meta-api-provider.ts`: `Map` kaldırımı tüm yetenekleri kapsar (INSTAGRAM_PUBLISH ve FACEBOOK_PUBLISH dahil). `execute()` sonucu `correlationId` ile `ExecutionJob.rawResult`'a yazar, `getStatus` oradan okur; `AdsOperation` yalnız META_* yazmalarını tutar. Etiketle uzlaştırma yapılır; `errorCode`, `retryable` ve `blameFieldSpecs` doldurulur.
  - `execution-service.ts`: stalled kurtarma yalnız niyet günlüğü uzlaştırmasından sonra çalışır.
  - `self-healing.service.ts`: F0a'daki META_* atlaması niyet günlüğüyle uzlaştırmaya dönüşür.
- **Hesap modeli:**
  - `AdsAccount` (workspace'te Meta hesabı başına tek satır) + `AdsAccountProject` ve `src/server/ads/accounts.ts` (resolver ve hazırlık durumu). Bunlar `modules/ads/account.ts`'in ve `MetaAdsQuery.resolveConnection`'ın tek kaynağı olur.
  - `meta-actions.ts`: seçimler atomik yazılır (tablo + `jsonb_set`). Disconnect token'ı ve reklam metadata'sını siler; Meta'da yalnız reklam izinleri ve yalnız aynı kişinin başka bir Meta Ads bağlantısı yoksa geri alınır (§3.9, K18).
  - `callback/route.ts`: `debug_token` + `/me/permissions` kontrolü, `AdsAccount` upsert'ü; app-scoped kullanıcı kimliği Facebook yolu bağlantılarının hepsine yazılır.
  - `meta-connection-status.ts` + sohbetin `get_connected_platforms` aracı Meta Ads hazırlığını görür.
- **Token sağlığı:** `src/server/ads/token-health.ts` (günlük iş); Integrations kutucuğu izin durumunu ve hesap rozetini gösterir (token süresi F0b'de geldi).
- **Uyumluluk:**
  - `meta-data-requests.ts` ve deauthorize/data-deletion rotaları Facebook yolu bağlantılarının hepsini eşler: `facebook`, Facebook yolundaki `instagram` ve `meta_ads`.
  - `appsecret_proof` eklenir.
- **Devre kesici:** `error-classifier.ts` Meta hatası için kataloğa delege eder; `provider-health.service.ts` kiracıya özgü sınıfları dışlar.
- **Sağlık ekranı:** /health ve sağlık eylemleri (Run self-heal, Reset circuit, Reconcile now, Retry) yalnız platform operatörüne açılır (`OPERATOR_USER_IDS` env listesi). Başka kiracının hesap kotası, `fbtrace_id`'si ya da DLQ metni gösterilmez; kullanıcılar Meta sağlığını proje kapsamlı "Ads account" sayfasında görür.
- **Altyapı borcu:**
  - Eski zincir boşalana kadar `AgencyTrigger`'a PROCESSING kilidi ve backoff eklenir (`agency-trigger.repository.ts`).
  - `SchedulerService` ve Telegram poller için CAS claim eklenir; deploy örtüşmesinde iki kopya aynı slotu ya da aynı onayı işlemez.

**Migration:** `<ts>_add_ads_account_and_operation` (`AdsAccount`, `AdsAccountProject`, `AdsOperation`, `AdsPlatform`, `AdsOperationStatus`).

**Bayrak:** Yok. Davranışı koruyan iç sertleştirmedir; kullanıcının göreceği yenilikler (izin ve hesap rozeti) zararsızdır.

**Kabul ölçütleri:**

- En az 25 hata kodu fikstürden doğru sınıf, eylem ve mesaja eşleniyor; `blameFieldSpecs` ilgili alana bağlanıyor.
- Zaman aşımı enjekte edilen oluşturma işleminde ikinci deneme yeni nesne kurmuyor.
- Süreç yeniden başlatma simülasyonunda iş FAILED olmuyor ve nesne kimliği korunuyor; Instagram ve Facebook yayınında gönderi tekrarlanmıyor.
- Kodda `new Map` sonuç deposu kalmadı.
- Kullanım başlıkları `AdsAccount.lastUsage`'a yazılıyor; %75'in üstünde P2 bekliyor, P0 rezervi korunuyor, RATE_LIMIT'te kısa tekrar yapılmıyor (birim test).
- Token uyarıları 14, 7 ve 1 gün kala çıkıyor.
- `/me/adaccounts` 25'ten fazla hesabı sayfalı getiriyor.
- Meta doğrulama hataları ve organik okuma kotası, reklam yazmalarını ya da P0'ı durduran bir devre kesiciyi açmıyor.
- Disconnect token'ı siliyor ve aynı kişinin Facebook bağlantısı çalışmaya devam ediyor; FB Login deauthorize Facebook yolu bağlantılarının hepsini REVOKED yapıyor.
- MEMBER /health eylemlerini çalıştıramıyor (testli).
- `X-App-Usage` raporu çıkarıldı ve en çok tüketen nokta düzeltildi.

**Bağımlılık:** F0b.

**Görünür değişiklik:** Integrations → Meta Ads kutucuğunda izin ve hesap durum rozetleri; hata mesajları Meta'nın kullanıcı metniyle ve ilgili alanda gösterilir; /health'te (yalnız operatör) Meta bölümü.

### F2 — Ayna ve sürekli denetim · L

**Amaç:** Hesapları sürekli, ucuz ve doğru biçimde izlemek; sorunları bir saat içinde fark edip söylemek.

**Kapsam:**

- **Senkron ve denetim:**
  - `src/server/ads/sync/*`, `src/lib/ads/results.ts` (Meta `results` alanı + yedek eşleme).
  - Arşiv ve silme farkındalığı, para toplamlarının hesap ve kampanya düzeyinden okunması (§3.2), pencere metrikleri (`windowStats`), `Project.status`'tan bağımsız izleme.
  - `src/server/ads/guard/{watchdogs,alerts,digest}.ts`.
  - `agency-wiring.ts`: `meta-ads-sync`, `meta-ads-guard` ve `meta-launch-watchdog` (heartbeat'ten hemen sonra), `ads-daily-digest` ve `ads-retention` adımları. `META_ADS_SYNC` açıkken eski `meta-ads-performance-scan` adımı atlanır; ZERO_RESULTS, HIGH_CPA ve AD_FATIGUE mantığı doğrudan G/O kurallarına taşınır, tarayıcı aynaya uyarlanmaz.
- **Okuyucular aynaya geçer:** `meta-ads-query.ts`, `ads-pulse.ts`, `work-ads-actions.ts`, `modules/analytics/meta-ads.ts`, `meta-api-provider.ts` (`analyzeAds`). `META_ADS_SYNC` kapalıyken eski canlı yol kullanılır.
- **UI:**
  - Ads sohbetindeki durum kartı (`ads-insight-card.tsx`'in evrimi) ve günlük özet (K24).
  - "Ads account" sayfasının ayna sürümü (`ads/page.tsx`, salt okuma + Pause/Resume).
  - "Pause all" (`META_SAFETY_ACTION`, inline; kampanya başına tek yazma).
  - Brand sekmesi "Ads" kartı F6'ya ertelendi.
- **Sohbet okuma araçları:** `get_ads_overview` ve `get_ad_performance` (`tools.ts`, `MODULE_TOOLS.ads`, `skills/registry.ts`).
- **Yetenek kaydı:** `META_SAFETY_ACTION` için §4'teki kontrol listesi.
- **Gizlilik:** `privacy/page.tsx` güncellenir (K7).

**Migration:** `<ts>_add_ads_mirror_and_alerts` (`AdsObject`, `AdsInsightDaily`, `AdsAlert`; yeni enumlar `AdsLevel`, `AdsAlertStatus`, `AdsSeverity`) ve ayrı klasörde `<ts>_add_meta_safety_action_capability` (`ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_SAFETY_ACTION'`).

**Bayrak:** `META_ADS_SYNC=true`.

**Kabul ölçütleri:**

- Test hesabında yapı en geç 60 dakikada, bugünkü insights en geç 30 dakikada aynaya yansıyor.
- Dünkü harcama Ads Manager ile ±%1 tutuyor. Bir reklam arşivlendikten ve bir reklam silindikten sonra hesap toplamı = kampanya toplamları = reklam satırları toplamı (±%1).
- Sonuç sayısı Ads Manager'ın "Results" sütunuyla ±%1 tutuyor.
- 28 günlük geri doldurma her gün çalışıyor ve `isFinal` doğru işaretleniyor.
- Hesap başına okuma, Dev kovasının %5'ini aşmıyor (logdan ölçülür).
- Her bekçi senaryosu için birim test var. Uyarılar tekilleşiyor ve koşul düzelince kapanıyor; bitmiş ya da henüz başlamamış nesne için G8 uyarısı çıkmıyor.
- "Pause all" tüm Agentelse kampanyalarını 60 saniye içinde PAUSED yapıyor.
- Ekranlar canlı Graph'a yalnız "Refresh" ile çıkıyor; `META_ADS_SYNC` açıkken eski tarayıcı Graph çağırmıyor.
- Aynı Meta hesabı iki projeye bağlıyken tek kez senkronlanıyor ve tek uyarı üretiyor.
- Duraklatılmış projenin harcayan hesabı izlenmeye devam ediyor.

**Bağımlılık:** F1. Gerçek müşteri hesaplarında açılış Full tier onayına bağlıdır (§7).

**Görünür değişiklik:**

- Ads sohbetinde günlük özet ve durum kartı.
- "Ads account" sayfasında tazelik etiketi ile "Completed" ve "Archived in Ads Manager" durumları.
- "Pause all".

### F3 — Güvenli lansman v2 · L

**Amaç:** Tek onayla, doğrulanmış, idempotent ve iki yönlü frenli lansman.

**Kapsam:**

- **Lansman motoru:** `src/server/ads/launch/*`, `src/lib/ads/{objectives,policy-lint}.ts`.
- **Yürütücü:** `meta-api-provider.ts` içinde `META_LAUNCH` asenkron adım makinesi (create / activate / discard modları; her deneme ayrı görev, §3.4).
- **Onay:** `approval-policy.ts`: `META_LAUNCH` L4 olur; §4'teki yetenek kayıt kontrol listesi uygulanır.
- **Modül akışı:**
  - `src/lib/module-flows/ads/{state,chain}.ts` (spec v1).
  - `src/components/module-flows/ads/{ad-steps,launch-step}.tsx`: önizlemeler, tek onay, ilerleme (yoklamayla), "Fix and retry", "Discard", "Turn on".
  - `ads-flow-actions.ts` (`AdsLaunch`; onay eyleminde `after()` ile sürüş) ve `src/server/modules/ads/chain.ts`.
- **İstemci alanları:** `meta-client.ts`'e `lifetime_budget`, `start_time`, `spend_cap` (asgari hesaptan), `special_ad_categories` + ülke, `dsa_*`, `promoted_object`, `bid_strategy`, `instagram_user_id`, `url_tags`, `degrees_of_freedom_spec`, `contextual_multi_ads`, `frequency_control_specs`, `execution_options` (kampanya ve kreatif için `validate_only`) ve `generatepreviews` eklenir. Ad Rules istemcisi F7'dedir.
- **Brand ayarları:** DSA payer/beneficiary, UTM, Meta AI tercihi, çok reklamverenli reklam tercihi.
- **Sohbet:** `META_CAMPAIGN_CREATE`, modüller açıkken modül kartını açar.
- **Eski yol:** Eski sihirbaz formları yalnız `isModulesEnabled() && META_ADS_LAUNCH_V2` iken gizlenir; bu koşul yoksa eski form linki kalır. V2 iki hafta sorunsuz çalışırsa, modül bayrakları en az iki haftadır açıksa ve bekleyen eski görev yoksa formlar, röleler ve `maybeProposeMetaCampaign` kodu silinir.

**Migration:** `<ts>_add_ads_launch` (`AdsLaunch`, `AdsLaunchStatus`) ve ayrı klasörde `<ts>_add_meta_launch_capability` (`ALTER TYPE "CapabilityKey" ADD VALUE IF NOT EXISTS 'META_LAUNCH'`).

**Bayrak:** `META_ADS_LAUNCH_V2=true`.

**Kabul ölçütleri:**

- Yerel kurallarla yakalanabilen geçersiz kombinasyonlar onaya ulaşmıyor; kampanya ve kreatif düzeyindeki Meta hataları Review'da ilgili alanda görünüyor. Ad set ve reklam düzeyindeki Meta hataları kampanya PAUSED iken, harcama olmadan yakalanıp kartta gösteriliyor.
- Feed, Story ve Reels önizlemeleri görünüyor.
- Her adımda zaman aşımı ya da çökme enjekte edildiğinde tam 1 kampanya, 1 ad set ve N reklam oluşuyor (uygulama dev moddayken reklam adımı `object_story_id` ile).
- Her lansmanda ad set `end_time` (FIXED'de `lifetime_budget` ile) ve kampanya `spend_cap` var; geri okumayla doğrulanıyor.
- Aktifleştirme tek yazma; yarıda kesilse bile onaylanmamış bir alt küme teslimata çıkmıyor.
- AB hedefinde DSA alanları gönderiliyor; bölgesel kimlik isteyen ülke seçilince lansman gerekçesiyle engelleniyor.
- "Fix and retry" yalnız eksik adımları kuruyor; "Discard" 0 yetim bırakıyor.
- Onaylandıktan sonra lansman `after()` ile başlıyor ve istek beklemiyor; süreç ölürse işçi devralıyor; tick 5 dakikalık bekçiye takılmıyor.
- Kart başına aynı anda en çok bir açık lansman görevi var ve her deneme ayrı görev olarak izlenebiliyor.

**Bağımlılık:** F1 (F2 önerilir) + §7: Live mod, reklam izinleri ve gerçek müşteri için Full tier. Önkoşul bayraklar canlıda açık: `MODULES_UI`, `WORKS_UI`, `CHAT_ENGINE=agent`.

**Görünür değişiklik:**

- Ads modül kartının Review adımında Meta ön kontrolü, önizlemeler, net zarf ve tahmini brüt fatura.
- Tek "Approve & launch".
- Launch adımında adım adım ilerleme.

### F5a — Mesaj ve trafik amaçları · M

**Amaç:** Yerel KOBİ'nin asıl amacı olan mesaj hedefini erken getirmek; trafik kampanyalarını doğru olaya taşımak.

**Kapsam:**

- Amaçlar: Messages (WhatsApp / IG Direct / Messenger, CONVERSATIONS); Traffic → LANDING_PAGE_VIEWS (piksel varsa) ve pikselsiz trafikte "tıklamaya optimize etme" uyarısı.
- Brief: WhatsApp numarası ve mesajlara ortalama yanıt süresi (kullanıcının beyanı).
- Preflight: Click-to-WhatsApp için Sayfaya bağlı WhatsApp numarası doğrulanır (alan adı doğrulanmalı; numara koptuysa 2446880).
- Mesai dışı için Meta'nın Instant Reply / Away message ayarı kurdurulur; mesai saatleriyle zamanlama yalnız FIXED (`lifetime_budget`) kurguda sunulur.
- ODAX tablosu (`src/lib/ads/objectives.ts`) ve P2 doğrulayıcısı bu amaçlara genişler.

**Migration:** Yok.

**Bayrak:** `META_ADS_PLANNER=true`. Her amaç, kod düzeyindeki `ready` listesiyle ayrı ayrı açılır.

**Kabul ölçütleri:**

- Test hesabında Messages amacı uçtan uca kuruluyor (kampanya ve kreatif `validate_only` + oluşturma).
- Pikselsiz trafik kurgusunda uyarı görünüyor; piksel varsa LPV seçiliyor.
- `adset_schedule` yalnız `lifetime_budget` ile öneriliyor (testli).

**Bağımlılık:** F3.

**Görünür değişiklik:** Brief'te mesaj hedefi ve WhatsApp numarası; Plan adımında amaç gerekçesi.

### F4 — Optimizasyon v2 · M

**Amaç:** Profesyonel oyun kitabını güvenli, açıklanabilir ve geri alınabilir kararlara dönüştürmek.

**Kapsam:**

- `src/server/ads/rules/*`, `optimizer.ts`, `decisions.ts`, `explain.ts` (§3.5).
- `approval-details.ts`: karar kartı (önce/sonra, kanıt, kural sürümü).
- `ads-insight-card.tsx`: Approve / Reject / Undo.
- `idea-engine.ts` + `idea-modules.ts`: kreatif yenileme isteği (O4, O6, O7, O13, O14).
- `ProjectGoal.currentValue` güncellemesi.
- Olgunluk gecikmeli değerlendirme ve sorguyla yapılan REJECTED susturması (§3.5).
- `performance-optimizer.ts`, `meta-performance-rules.ts` ve `meta-performance-scanner.ts` silinir (F2'den beri `META_ADS_SYNC` açıkken atlanıyorlardı).

**Migration:** `<ts>_add_ads_decision` (`AdsDecision`, `AdsDecisionStatus`, `AdsAutonomyLevel`).

**Bayrak:** `META_ADS_OPTIMIZER` = off / shadow / on.

**Kabul ölçütleri:**

- Her kuralın sınır değerleri testli; öğrenme, asgari veri ve istatistik kapıları testli.
- Gölge modda en az 30 karar ya da 4 hafta (hangisi önce gelirse) çalışıldı; karar sayısı yetmediyse aynanın 28 günlük geçmişi üzerinde replay yapıldı. Sahibin örnek incelemesinde kabul oranı en az %60.
- Uygulama CAS'li (değişmiş nesnede SUPERSEDED); 5 dakika içinde VERIFIED oluyor; geri alma tek dokunuşla çalışıyor.
- Değerlendirme, pencere bitişinden en az 7 gün sonra (platform içi olaylarda 2 gün) yapılıyor (testli).
- Reddedilen karar 14 gün geri gelmiyor.
- Yorgunluk kararı otomatik görsel üretmiyor, fikir havuzuna düşüyor.

**Bağımlılık:** F2 (F5a önerilir: mesaj kampanyalarından karar birikir).

**Görünür değişiklik:** Ads sohbetindeki kartta "Suggested: lower budget to 14 TRY/day — why?"; Ideas panosunda "For your ads".

### F5b — Planlama motoru ve formlar · L

**Amaç:** Bütçe ve işletme tipinden profesyonel bir kampanya planı çıkarmak; form hedefini ve kreatif çeşitliliğini getirmek.

**Kapsam:**

- §3.3: `src/server/ads/planner/*`.
- Brief genişler: işletme tipi, satış değeri ve kapanış oranı ya da "Max cost per lead" (KPI hedefi), FIXED/ALWAYS_ON, `advantage_audience=1` ile "Suggest / Limit to" ayrımı.
- Leads: anında form, "Higher intent", 2-3 eleme sorusu. Lead teslimi v1'de Meta'nın kendi yoluyladır: Leads Center ve e-posta bildirimi açtırılır; Agentelse yeni lead sayısını kişisel veri olmadan (insights'taki lead action) 30 dakikada bir kontrol eder ve "New leads: 3 — open Leads Center" uyarısı verir. `leads_retrieval` yalnız CRM aktarımı istenirse alınır.
- IG profil hedefi (doğrulanmalı).
- Carousel ve video modüle taşınır (eski sihirbaz bileşenleri; MEDIA_PROCESSING durumu, kapak görseli, büyük video için parçalı yükleme).
- İki oranlı reklam: `asset_feed_spec` + yerleşim kuralları (test hesabında doğrulanana kadar tek 4:5 + `adapt_to_placement`).
- "Add to an existing campaign" yolu: yeni reklamlar mevcut ad set'e haftalık toplu eklenir.
- Kreatif matrisi ve çeşitlilik kontrolü; tahmin (`reachestimate`, `delivery_estimate`, sonuç aralığı).
- Ücret tablosu (`src/lib/ads/fees.ts`): net zarf ve tahmini brüt fatura.
- İçerik planındaki `ads.campaign` parçasına "Make this ad" köprüsü.

**Migration:** Yok (plan JSON'da tutulur; `ProjectGoal` mevcut).

**Bayrak:** `META_ADS_PLANNER=true`. Her amaç, kod düzeyindeki `ready` listesiyle ayrı ayrı açılır.

**Kabul ölçütleri:**

- Test hesabında Leads amacı uçtan uca kuruluyor (`validate_only` + oluşturma).
- Öğrenme fizibilitesi uyarısı doğru hesaplanıyor.
- Plan şemayla doğrulanıyor; LLM tutar belirleyemiyor (testli).
- "Mevcut kampanyaya ekle" yeni kampanya kurmuyor.
- 4:5 + 9:16 varyantları ve güvenli alan kontrolü çalışıyor; video `ready` olmadan onay düğmesi pasif.
- Hedef CPL başabaş formülüyle hesaplanıyor ve `ProjectGoal`'a ACTIVE yazılıyor (testli).

**Bağımlılık:** F3, F5a (+ §7: lead izinleri).

**Görünür değişiklik:** Brief'te "Average sale value" ve "Out of 10 leads or chats, how many become customers?"; Plan adımında amaç gerekçesi ve "Expected: 25-40 conversations/week (directional)".

### F6 — Raporlama ve öğrenme · M

**Amaç:** Haftalık ve aylık profesyonel raporlama (günlük özet F2'de); öğrenmelerin markaya geri dönmesi.

**Kapsam:**

- `src/server/ads/reports/{weekly,diagnose,learnings}.ts`.
- Analytics modülünün paylaşım/dışa aktarma altyapısının kullanılması.
- Haftalık rapor kartı.
- Aylık müşteri raporu ve mutabakat sorusu.
- Rapor dönemi için erişim ve sıklığın ayrıca okunması (günlük satırlardan toplanmaz).
- `BrandLearning` yazımı.
- Meta önerileri ikinci görüş olarak; aylık rutinde Ad Library bağlantısı.
- Haftalık tek özet Signal (Brand Brain anlatısı için).
- Sağ dok → Brand sekmesi "Ads" kartı (K22).

**Migration:** Yok.

**Bayrak:** `META_ADS_REPORTS=true`.

**Kabul ölçütleri:**

- Haftalık rapor Pazartesi, proje saatiyle çıkıyor.
- Özetteki her sayı aynaya dayanıyor (number-check testleri).
- Teşhis ağacının bileşenlere ayırma hesabı testli.
- Atıf etiketi her tabloda görünüyor.
- Rapordaki erişim dönem okumasından geliyor (testli).
- Öğrenme yalnız kapıyı geçen sonuçtan yazılıyor.
- Aylık rapor Markdown/PDF olarak dışa aktarılabiliyor.

**Bağımlılık:** F2 (karar sonuçları için F4). F5b ile paralel yürüyebilir.

**Görünür değişiklik:** Ads modül sohbetinde "Weekly ads report" kartı; Brand Brain'de reklam kaynaklı öğrenmeler; Brand sekmesinde "Ads" kartı.

### F7 — Webhook ve koruma raylı otonomi · M

**Amaç:** Olaylara dakikalar içinde tepki vermek ve isteğe bağlı, sınırlı otonomi.

**Kapsam:**

- **Webhook:**
  - `src/app/api/webhooks/meta-ads/route.ts`: GET'te `hub.challenge`; POST'ta `X-Hub-Signature-256` doğrulanır, olay `AdsWebhookEvent`'e yazılır ve hemen 200 dönülür.
  - `src/lib/public-paths.ts`: rota eklenir.
  - `meta-webhook-process` tick adımı. `effective_status` olayı yeni değeri taşımaz; nesne hedefli olarak okunur.
  - Hesap bağlanınca `user_tasks` MANAGE içeriyorsa `subscribed_apps` çağrılır (admin token gerekir). İçermiyorsa hesap "polling only" olarak işaretlenir ve UI "Real-time alerts need an admin of this ad account" gösterir.
  - `dedupeKey` = sha256(entry.id + entry.time + change.field + value.object_id + changed_fields); olay gövdesinde olay kimliği yoktur.
  - Günlük `meta-webhook-subscription` işi `GET /{app_id}/subscriptions` ve `GET /act_x/subscribed_apps` ile aboneliği doğrular; düşmüşse yeniden abone olur ve uyarı açar. Webhook alan hesaplarda da yapı yoklaması 60 dk'dan seyrek yapılmaz.
  - Alanlar: `effective_status`, `with_issues_ad_objects`, `in_process_ad_objects`, `creative_fatigue`, `ad_recommendations`.
- **Otonomi:**
  - `AutonomyPolicy.adsAutonomy` ve aylık tavan.
  - Settings → Autonomy "Ads autopilot".
  - `approval-policy.ts`: `META_SAFETY_ACTION` için LEVEL_1 kuralı; yalnız GUARDED + `riskReducing=true` + kapılar geçtiyse. Bu, "yalnız yükseltir" kuralına yazılı ve testle sabitlenmiş bir istisnadır.
  - Provider harcamayı artıran isteği reddeder.
  - Sonradan bildirim + Undo.
  - Gizlilik ve App Review metinleri güncellenir.
- **Ad Rules sigortası (isteğe bağlı):** §3.9'daki kurallarla (kimlik filtresi, tercihen SCHEDULE, `adrules_history` okuma, eşik geçişi, Disconnect sırası). İstemci: `adrules_library`, `adrules_history`, `/{rule_id}/preview`.
- "Full auto (limited)" yalnız §1.2'deki önkoşullarla açılabilir.

**Migration:** `<ts>_add_ads_autonomy_and_webhook_events`.

**Bayraklar:** `META_ADS_WEBHOOKS=true`, `META_ADS_AUTOPILOT=true`, `META_ADS_RULES=true` (isteğe bağlı sigorta).

**Kabul ölçütleri:**

- İmzasız istek reddediliyor; aynı olay iki kez işlenmiyor.
- Ret ya da teslimat sorunu uyarısı 10 dakika içinde geliyor.
- Guarded modda yalnız risk azaltan eylemler otomatik çalışıyor (savunma derinliği testi).
- Günlük otomatik eylem sınırı çalışıyor.
- Her otomatik eylem geri alınabiliyor.
- Ad Rules açıksa kural yalnız kimlik filtreli nesnelere uygulanıyor, yürütmesi drift sayılmıyor ve token iptali sonrasındaki davranışı test hesabında belgelendi.

**Bağımlılık:** F4 + §7 (Live mod, webhook ayarı).

**Görünür değişiklik:** Settings → Autonomy'de "Ads autopilot"; Ads sohbetindeki kartta "Auto-paused · Undo".

### F8 — Ajans ölçeği ve token modeli · L

**Amaç:** Çok müşterili ajansın tek yerden, süresiz ve güvenli yönetimi.

**Kapsam:**

- `AdsConnection` (workspace düzeyi): Facebook Login for Business (`config_id`) + BISU token; `/me?fields=client_business_id`.
- İsteğe bağlı: ajans system user + partner erişimi.
- Projelere hesap atama; proje başına birden çok hesap.
- Business uçları (`owned_ad_accounts`, `client_ad_accounts`).
- Müşteri onaylayıcı rolü (L4 müşteri onayı); gerekirse Telegram'da "can approve spend" eşlemesi.
- Workspace genelinde "Ads overview" sayfası (tüm müşterilerin sağlığı).
- Ayrı ve sürümlü şifreleme anahtarı (`keyId`).
- Kitle çakışması kontrolü.
- Ölçek araçları: async insights (hesap başına günlük iş sayacıyla), batch okumalar ve z-skoru tabanlı metrik anomalisi (§3.1, §3.6).

**Migration:** `<ts>_add_ads_connection` (`AdsConnection`, `AdsAccount.connectionId`, rol alanı).

**Bayrak:** `META_ADS_AGENCY=true`.

**Kabul ölçütleri:**

- BISU ile bağlanan müşterinin token'ı süresiz ve `debug_token` ile doğrulanıyor.
- Bir bağlantı 3 projeye hesap atayabiliyor.
- Müşteri onaylayıcı yalnız kendi projesinin L4 onayını verebiliyor.
- Ajans görünümü 20 hesabı listeliyor.
- Async insights hesap başına günlük sayaçla sınırlanıyor.

**Bağımlılık:** F1 + Full tier + FLfB için App Review.

---

## 10. Riskler ve azaltımlar

| Risk                                                                        | Olasılık / etki    | Azaltım                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| İşçi yine sessizce durur | Orta / yüksek | Kalp atışı + GitHub dışı harici monitör (K23) + uygulama şeridi; Meta tarafı frenler bağımsız çalışır |
| İşçi açılınca bayat işler harcama yapar | Yüksek / yüksek | F0a birikim kapısı claim noktasında (onay > 24 sa ya da görev > 72 sa), SelfHealing'in META_* atlaması, 24 saatten eski yayın slotlarının "Missed" kalması; K2 |
| Çift ya da yetim nesne | Orta / orta | Niyet günlüğü + etiketle iki aşamalı uzlaştırma, her deneme ayrı görev, telafi, yetim nesne bekçisi; kullanıcının Ads Manager kopyalarına dokunulmaz |
| Token düşer, kampanya gözetimsiz kalır | Yüksek / yüksek | Günlük `debug_token` ve 14/7/1 gün uyarıları; `end_time`/`lifetime_budget`/`spend_cap`; F8'de BISU |
| Dev tier kotası, Full tier ve 1885183 | Yüksek / yüksek | DB'de durum tutan ve Meta başlıklarıyla çalışan governor, ayna okumaları, ölçülerek bulunan platform tüketicisi; görseller Review'da, aktivasyon tek yazma; App Review + Live + Full tier (+Upgrade; otomatik değil); dev moddaki testlerde `object_story_id` |
| Para birimi ya da yazım hatası                                              | Orta / yüksek      | Tek `money` modülü, birim testleri, onay kartında para birimi, büyük değişiklikte ikinci doğrulama                                                                                    |
| Aşırı otomasyon öğrenmeyi bozar                                             | Orta / orta        | Öğrenme kapısı, hız sınırları, gölge mod, varsayılan "Suggest only"                                                                                                                   |
| Politika reddi ya da hesap kısıtı | Orta / yüksek | Politika lint'i, özel kategori/DSA, aynı içeriği yeniden göndermeme; hesap düzeyindeki ihlalde (368/1404*) P1-P2 için 24 saat dondurma, P0 PAUSE serbest |
| Meta API değişikliği (27 Ekim v26 zorlaması, v27)                           | Yüksek / orta      | Tek sürüm sabiti, sürüm uyarı başlığı, sözleşme fikstürleri, aylık changelog kontrolü. v24 bugün sona erdi; kod v26 kullandığı için etkilenmiyor                                      |
| Meta'nın AI'ı marka mesajını değiştirir | Orta / orta | `creative_features_spec` açık listeyle OPT_OUT ve geri okuma; `contextual_multi_ads` açık değer; Review'da Meta önizlemesi |
| Gizlilik ve uyumluluk (veri saklama, lead verisi)                           | Orta / yüksek      | Gizlilik metni güncellemesi, saklama işi, FB Login silme akışı; v1'de lead PII saklanmaz                                                                                              |
| Paylaşılan DB ve migration'lar                                              | Orta / yüksek      | Yalnız ekleme yapan, faz başına yeni migration; tek kullanımlık yerel DB'de üretim; geliştirmede Meta yazmaları kapalı                                                                |
| Ajans müşterileri arası sızıntı | Düşük / çok yüksek | Nesne-hesap doğrulaması (F0b), hesap başına devre kesici, rol tabanlı onay, /health yalnız operatöre açık |
| Yerel ortamdan gerçek harcama ya da canlı işin bozulması | Düşük / yüksek | Development'ta işçi META_* işlerini claim etmez; yazmalar `META_ADS_DEV_ALLOWED_ACCOUNTS` listesiyle sınırlı; ayrı Dev Meta uygulaması (K25) |
| Deploy sırasında iki kopya | Orta / orta | Senkron ve lansmanda CAS kilitleri; governor durumu DB'de. Zamanlayıcı ve Telegram poller için F1'de CAS claim; eski tarayıcı F2'de devre dışı |
| Doğrulanmamış Meta ayrıntıları (alan adları, birimler, inceleme davranışı, `asset_feed_spec`, `results` biçimi, Ad Rules) | Yüksek / orta | "(doğrulanmalı)" maddeleri F1-F3 öncesinde Dev uygulaması ve test hesabıyla kontrol listesi olarak denenir |
| Disconnect başka Meta bağlantılarını koparır | Orta / yüksek | Yalnız reklam izinleri ve yalnız aynı kişinin başka Meta Ads bağlantısı yoksa geri alınır; `DELETE /me/permissions` yalnız bütün servisler kaldırılırken (K18) |
| Telegram'a giden Meta verisi App Review'ı riske atar | Orta / yüksek | Telegram'a yalnız Agentelse'in kendi verisi gider (K8) |
| Modül bayrakları açılmazsa oluşturma yolu kalmaz | Orta / orta | Eski formlar yalnız `isModulesEnabled()` iken gizlenir; silme, bayraklar iki hafta açık kaldıktan sonra (§2.4) |
| Arşivlenen ya da silinen nesnelerin harcaması raporlardan düşer | Orta / yüksek | Para kararları hesap ve kampanya toplamlarından; silinen nesneler 28 gün kimlikle doldurulur; teslimat almış nesne silinmez, arşivlenir (§3.2) |
| Karmaşıklık artışı | Orta / orta | Faz başına bayrak; KOBİ varsayılanları; aynı durum en fazla iki yüzeyde; async insights, batch ve anomali tespiti F8'de; uzman özellikleri ancak talep olunca |
| Rakipler (Meta Ads MCP, Muse for SMB, Birch, Madgicx)                       | Orta / orta        | Fark yaratan noktalar: Brand Brain ile bütünleşik kreatif, ajans onay akışı, çift fren, TR/Balkan gerçekleri (konum ücreti, KDV, WhatsApp öncelikli kurgu). Muse yalnız ABD/Kanada'da |
| Reklam hacmi ve arşiv sınırları (613/1487225, 1487990) | Düşük / orta | VOLUME_LIMIT sınıfı yalnız yeni reklam oluşturmayı durdurur; yetim ve kaybeden reklamlar arşivlenir, eski arşivler silinir |

---

## 11. Sahibin vermesi gereken kararlar

| #   | Karar                           | Seçenekler                                                                                                                                                    | Önerilen                                                                                   | Gerektiği faz |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| K1  | Canlı işçi tetikleyicisi | (a) Yalnız web servisinde `ENABLE_INPROCESS_WORKER=true` + CRON_SECRET'i eşitlenmiş GitHub cron yedek; (b) yalnız GitHub cron; (c) Railway cron-worker'ı onar | (a); Railway cron-worker silinsin, secret döndürülsün | F0a |
| K2  | 1 Ekim birikimi | (a) F0a kapısı: onayı 24 saatten ya da görevi 72 saatten eski META_* yazmaları iptal edilip yeniden onaya sunulsun; planlanan saati 24 saatten eski yayın slotları "Missed" kalsın; karar tüm iş tiplerini gösteren rapordan sonra; (b) hepsi çalışsın; (c) hepsi iptal edilsin | (a) | F0a |
| K3  | Varsayılan otonomi              | Suggest only / Guarded auto / Full auto                                                                                                                       | Suggest only. Guarded auto proje bazında, isteğe bağlı (F7); Full auto yalnız önkoşullarla | F4 / F7       |
| K4  | Lansman onayı | (a) Tek onay: kur + zarf içinde aç ("Create paused only" seçeneğiyle; sonradan "Turn on" ayrı L4 ve ayrı görev); (b) iki ayrı onay | (a) | F3 |
| K5  | L4 (harcama) onaylayıcısı | (a) Yalnız workspace OWNER/ADMIN, bütün yolların geçtiği `ApprovalRepository.decide`'da; Telegram'da L4 için yalnız bağlantı, sohbette L4 onayı yok; (b) her proje üyesi; (c) ayrı müşteri rolü | Şimdi (a), F8'de (c) | F0b |
| K6  | Bitiş ve tavan | (a) Süreli: `lifetime_budget` + `end_time`. Always-on: günlük bütçe + ad set `end_time` = 30 günlük zarf sonu (yenileme = `end_time`'ı uzatan L4 karar) + kampanya `spend_cap` = max(asgari, harcanan + kalan zarf × 1,1); (b) yalnız günlük bütçe + `end_time` | (a); F0b'de geçici olarak (b) (`durationDays` ile) | F0b / F3 |
| K7  | Insights saklama                | (a) Günlük veri (reklam düzeyi 180 gün, diğerleri 400 gün) + gizlilik metni; (b) bugünkü gibi yalnız son durum                                                | (a). Organik için Faz 4'teki "sayı saklamama" kararı değişmez                              | F2            |
| K8  | Kritik uyarı kanalı | (a) Uygulama içi + yalnız CRITICAL için Telegram; Telegram'a yalnız Agentelse'in kendi verisi (Meta verisi gönderilecekse önce gizlilik sayfasına ve App Review Data handling'e Telegram işleyici olarak eklenir); (b) yalnız uygulama içi; (c) + e-posta (yeni bağımlılık) | (a); e-posta sonra | F0b / F2 |
| K9  | Token modeli                    | (a) Şimdilik kullanıcı token'ı + sağlık denetimi, F8'de FLfB + BISU; (b) hemen FLfB                                                                           | (a)                                                                                        | F1 / F8       |
| K10 | Proje başına reklam hesabı | (a) v1'de proje başına tek seçili hesap; `AdsAccount` + `AdsAccountProject` çokluya hazır; (b) hemen çoklu | (a) | F1 |
| K11 | Eski sihirbaz ve otonom öneri | (a) V2 açılınca ve modüller açıkken (`isModulesEnabled()`) formlar gizlensin; modül bayrakları iki hafta açık ve V2 iki hafta sorunsuzsa silinsin; `maybeProposeMetaCampaign` hemen kapansın; (b) kalsınlar | (a) | F0b / F3 |
| K12 | İlk eklenecek amaçlar | (a) Messages (F5a) + Leads (anında form, F5b); (b) önce Sales (piksel) | (a). v1'de lead kişisel verisi saklanmaz; teslim Leads Center + e-posta ile, Agentelse yalnız sayı bildirir | F5a / F5b |
| K13 | Meta tarafı sigorta | (a) Her lansmanda Meta'nın sert frenleri otomatik (onaylı zarfın parçası): FIXED'de `lifetime_budget` + `end_time`, always-on'da ad set `end_time` + kampanya `spend_cap`; Ad Rules yalnız F7'de isteğe bağlı (kimlik filtreli, tercihen SCHEDULE); (b) ek olarak her lansmanda Ad Rules TRIGGER sigortası; (c) yalnız bizim bekçiler | (a) | F3 / F7 |
| K14 | Meta AI kreatif iyileştirmeleri | (a) Yapay zekâyla içerik üreten ya da metni değiştiren özellikler OPT_OUT; `adapt_to_placement` OPT_IN; `image_brightness_and_contrast` marka ayarıyla; `image_touchups` yalnız tek görselde; `contextual_multi_ads` açık değerle (premium markada OPT_OUT); (b) Meta varsayılanı | (a) | F3 |
| K15 | Raporlama saati ve atıf         | (a) Meta rakamları hesap saat diliminde ve ad set atıf ayarıyla, etiketli; (b) proje saatine çevir                                                            | (a)                                                                                        | F2            |
| K16 | Agentelse nesne etiketi         | (a) Adın sonuna "[agx:…]"; (b) `adlabels` (doğrulanmalı)                                                                                                      | (a)                                                                                        | F1            |
| K17 | Hedef KPI girdisi | (a) Brief'te satış değeri + kapanış oranı (ya da doğrudan "Max cost per lead") sorulur; hedef CPL = başabaş × %70, `ProjectGoal`'a ACTIVE yazılır; hiçbiri yoksa ilk 14 gün hesabın kendi tabanı; (b) hedefsiz kurallar | (a) | F4 / F5b |
| K18 | Disconnect davranışı | (a) Token ve reklam verisi hemen silinsin; Meta'da yalnız reklam izinleri ve yalnız aynı kişinin başka Meta Ads bağlantısı yoksa geri alınsın (`DELETE /me/permissions` yalnız bütün Meta servisleri kaldırılırken); ayna ve insights 30 gün sonra silinsin; (b) bugünkü gibi yalnız REVOKED; (c) her Disconnect'te `DELETE /me/permissions` | (a) | F1 |
| K19 | Yerelde Meta işleri | (a) Development'ta işçi META_* işlerini claim etmez; yazmalar yalnız izin listesindeki test hesabına; (b) serbest | (a) | F0b |
| K20 | Webhook'lar                     | (a) F7'de eklensin, yoklama yedek kalsın; (b) hiç eklenmesin                                                                                                  | (a)                                                                                        | F7            |
| K21 | "Require App Secret"            | `appsecret_proof` sonrası açılsın / kapalı kalsın                                                                                                             | Açılsın                                                                                    | F1            |
| K22 | Sağ dok | (a) Brand sekmesinde "Ads" kartı; (b) 5. dok ikonu "Ads" | (a) | F6 |
| K23 | Harici monitör | (a) GitHub dışı ücretsiz uptime/dead-man servisi (5 dk; yalnız sağlık durumu gider); (b) mevcut `cron-worker.yml`'ye ikinci adım (eşik 20 dk, GitHub gecikmesine bağlı); (c) ayrı GitHub workflow | (a); reddedilirse (b) | F0b |
| K24 | Günlük özet ve uyarı kartının yeri | (a) Projenin kalıcı Ads sohbeti (SYSTEM kartı, Recents'te öne çıkar; uyarı varken şerit buraya götürür); (b) Today Work'ünü geri getir; (c) yalnız "Ads account" sayfası | (a) | F2 |
| K25 | Test için Meta uygulaması | (a) Ayrı "Agentelse Dev" uygulaması (dev modda): yerel geliştirme ve test hesabı denemeleri; canlı uygulamanın kotası ve hata oranı korunur; (b) canlı uygulama + test hesabı | (a). Canlı uygulama sırlarının yerel `.env`'den çıkarılması ayrıca değerlendirilir; çıkarılırsa yerelde organik özellikler canlı token'larla denenemez | F0b / F1 |
| K26 | Faz sırası | (a) F5a (mesaj ve trafik) F4'ten önce; (b) ilk taslaktaki sıra (F4 → F5) | (a) | F3 sonrası |

---

## Ek A. Temel Meta kaynakları

- Graph API sürümleri ve v26 changelog'u: https://developers.facebook.com/docs/graph-api/changelog/version26.0
- Marketing API rate limiting: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting
- Hata referansı: https://developers.facebook.com/documentation/ads-commerce/marketing-api/error-reference
- Ad Campaign (spend_cap, special_ad_categories, validate_only): https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign-group
- Advantage+ audience: https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-expansion/advantage-audience
- Advantage+ creative (creative_features_spec): https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started
- Insights en iyi uygulamaları (async, atıf, saklama): https://developers.facebook.com/documentation/ads-commerce/marketing-api/insights/best-practices
- Ad Rules: https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-rules
- Ads Webhooks: https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/ads-webhooks-overview
- Facebook Login for Business (BISU): https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
- Marketing API erişim seviyeleri: https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization

## Ek B. Kısaltmalar

- **ABO / CBO:** Bütçenin ad set'te (Ad set Budget Optimization) ya da kampanyada (Campaign Budget Optimization; Meta'da Advantage campaign budget) tutulması.
- **BISU:** Business Integration System User token'ı; Facebook Login for Business ile alınan, kişiye bağlı olmayan süresiz token.
- **BUC:** Business Use Case; Meta'nın kullanım türüne göre ayrı tuttuğu kota.
- **CAPI:** Conversions API.
- **CAS:** Compare-and-swap; yalnız değer hâlâ okunduğu gibiyse yapılan koşullu güncelleme.
- **CTWA:** Click-to-WhatsApp reklamı.
- **DLQ:** Dead-letter queue; tekrar denemeleri biten işlerin düştüğü kuyruk.
- **DSA:** AB Dijital Hizmetler Yasası; reklamda faydalanıcı ve ödeyici beyanı ister.
- **FLfB:** Facebook Login for Business.
- **HEC:** Housing / Employment / Credit; bugün `HOUSING`, `EMPLOYMENT` ve `FINANCIAL_PRODUCTS_SERVICES` özel reklam kategorileri.
- **LPV:** Landing page view.
- **MTD:** Month to date; ay başından bugüne.
- **OCC:** Meta'nın sürüm dışı değişiklik (out-of-cycle changes) duyurusu.
- **ODAX:** Outcome-Driven Ad Experiences; Meta'nın sonuç odaklı amaçları (`OUTCOME_*`).
- **PBIA:** Page-backed Instagram account; Sayfa adına açılan IG reklam kimliği.
- **TTPA:** AB Siyasi Reklamların Şeffaflığı ve Hedeflenmesi Tüzüğü.

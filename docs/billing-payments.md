# Ödemeler (Stripe, Faz 4)

Abonelik ödemesi, plan değiştirme, iptal, ek paket satın alma ve iade/itiraz geri alma. Yalnız ödeme: kota ve park mantığı `docs/billing-quota.md` ve `docs/billing-tasks.md`'de. **Bu faz canlıda hiçbir şeyi kendiliğinden açmaz**: Stripe anahtarları girilmedikçe `/billing` fiyatları gösterir, satın alma düğmeleri kapalıdır ve webhook ucu 503 verir. `BILLING_MODE` bu fazda DEĞİŞMEZ (`off` kalır).

## Sahip: kurulum (bir kez, sırayla)

Önce TEST modunda deneyin; canlı anahtarı en son girin.

1. **Stripe hesabı** → Developers → API keys → _Secret key_ (`sk_test_…`). Kısıtlı anahtar (`rk_…`) kullanacaksanız şu izinler gerekir: Customers, Checkout Sessions, Subscriptions, Invoices, Charges, PaymentIntents, Disputes, Products, Coupons, Promotion codes, Customer portal sessions (hepsi _write_; Charges/PaymentIntents/Disputes/Promotion codes _read_). Duman testi (aşağıda) daha çok şey yarattığı için TAM test anahtarı (`sk_test_…`) ister.
2. **Webhook ucu** → Developers → Webhooks → _Add endpoint_:
   - URL: `https://<uygulama-adresi>/api/webhooks/billing`
   - Dinlenecek olaylar (yalnız bunlar): `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.
   - Yük (payload) stili: **Snapshot** (Thin DEĞİL; ince olaylarda `data.object` yoktur ve uç nokta onları 400 ile reddeder). Olay kaynağı: **Your account**.
   - TEST ve CANLI için AYRI uç noktalar (ayrı `whsec_…`) gerekir.
   - Oluşunca _Signing secret_'ı (`whsec_…`) kopyalayın.
3. **Müşteri portalı** → Settings → Billing → _Customer portal_ → kaydedin (kaydedilmeden portal oturumu açılmaz). Ayar TEST ve CANLI modda AYRI kaydedilir; canlı için Stripe hesabının önce etkinleştirilmiş (activate) olması da gerekir (aksi hâlde canlı Checkout `testmode_charges_only` verir ve müşteri "Billing is temporarily unavailable" görür). Önerilen ayar: ödeme yöntemi güncelleme AÇIK, fatura geçmişi AÇIK, **abonelik iptali ve plan/aralık değiştirme KAPALI olmalıdır** (öneri değil gereklilik). Bunlar uygulamanın kendi ekranından yapılır: portaldan yapılan değişiklik (a) aralık değişirse Stripe dönemi sıfırlayıp hemen faturalar ve uygulamanın plan değiştirmesi bu abonelik için kilitlenir (`BILLING_CHANGED_OUTSIDE`), (b) "sonraki faturada orantıla" ile yapılan yükseltme ancak yenileme faturası ödenince başlar (kota farkı verilmez), (c) yükseltmenin kota farkı yalnız uygulama akışında (`always_invoice`) hesaplanır.
   Ayrıca (Stripe panelinde, bir kez):
   - **Ödenmeyen abonelik**: Settings → Billing → _Subscriptions and emails_ → yeniden denemeler tükenince aboneliği **iptal et** (Stripe varsayılanı). "Ödenmemiş olarak işaretle" seçilirse abonelik `unpaid` kalır: uygulamada ödeme sorunu süresiz görünür ve yeniden abone olmak, Stripe'a sorulup bitmediği doğrulanana dek `PAYMENT_PROBLEM` ile engellenir.
   - **Tek abonelik**: Settings → Checkout → "Limit customers to one subscription" AÇIK önerilir. Açık değilse paralel iki Checkout'un ikincisi de ödenebilir: uygulama onu Stripe'ta kendiliğinden İPTAL eder (yenilenmesin) ama ilk faturası tahsil edilmiştir ve ELLE iade gerekir (aşağıya bakın).
   - **Gizlilik**: Stripe'a müşterinin giriş e-postası (uygulamada doğrulanmıyor), çalışma alanı adı ve ödeme verisi gider. Canlıya geçmeden önce gizlilik politikasının "bilgi paylaşımı" bölümüne ödeme işleyicisi (Stripe) ve şartlara iade metni EKLENMELİ; bu fazda hukuki metinlere dokunulmadı (sahip kararı).
   - **Ek paket makbuzu** (`invoice_creation`): Stripe bu faturalar için ek ücret alabilir (Stripe fiyatlandırmasına bakın); istemezseniz kodda kapatılır.
   - Test (sandbox) hesabında yeniden deneme/ödeme hatası zamanlaması canlıdan farklı olabilir; ödeme hatası akışını canlıda varsayma, test modunda `4000 0000 0000 0341` ile deneyin.
4. **Ortam değişkenleri** (Railway, servis `@agentelse`):
   - `STRIPE_SECRET_KEY` = `sk_test_…`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…` (TAM imzalama sırrı: `whsec_` + en az 24 karakter; yer tutucu ya da kesik sır ile ödeme KAPALI kalır)
   - `NEXT_PUBLIC_APP_URL` = uygulamanın genel adresi (`https://…`, sonunda `/` yok): Checkout dönüş adresleri bundan üretilir
   - Üretimde `BILLING_MODE=enforce` iken **TEST anahtarı ödemeyi KAPATIR** (herkes test kartıyla bedava plan alamasın); canlı anahtarı girin.
   - `BILLING_UI=true` (ekranı açar; zaten açıksa gerekmez)
   - (sır döndürürken) `STRIPE_WEBHOOK_SECRET_PREVIOUS` = eski `whsec_…`; yeni sır yerleşince silin.
5. **Yerel geliştirme**: yalnız TEST anahtarı. Canlı anahtar `NODE_ENV≠production` iken **reddedilir** (geliştirme süreci canlı veritabanını paylaşır). Webhook'u yerelde denemek için `stripe listen --forward-to localhost:3000/api/webhooks/billing` verdiği `whsec_…`'i kullanın. Ödeme denemesi için **ayrı, atılabilir bir workspace** kullanın: test modunda ödenmiş bir abonelik o workspace'in satırına yazılır.
6. **Test planı** (anahtarlar girildikten sonra, test modunda): Subscribe → `4242 4242 4242 4242` → `/billing?tab=subscription`'da "Payment received. Your plan is active." → Stripe'ta olayların 200 döndüğünü ve `BillingEvent` tablosunda `PROCESSED` olduğunu doğrulayın. Sonra: yükseltme, düşürme, iptal/devam, ek paket, portal (ödeme yöntemi), `4000 0000 0000 0341` (yenilemede ödeme hatası), Stripe panelinden iade.
7. **Canlıya geçiş**: aynı adımlar canlı anahtar ve canlı webhook ucuyla. `BILLING_MODE` hâlâ `off`; zorunlulama ayrı karardır (`docs/billing-quota.md`, Faz 7). Geçmeden ÖNCE test sürecinde bağlanmış abonelikleri emekli edin (test kartıyla plan almış biri, `enforce`'ta ödenmiş süre bitene dek — yıllıkta bir yıla kadar — GERÇEK erişim alırdı):

   ```
   npm run billing:retire-test-subscriptions            # kuru çalışma: yalnız listeler
   npm run billing:retire-test-subscriptions -- --apply # yazar
   ```

   Canlı ödeme yapan workspace'lere dokunmaz. Sonra test webhook ucunu silin. Yenileme ve ödeme hatası akışı gerçek zamanda denenemez (Stripe test saati uygulamanın müşterisine bağlanmıyor); bu akışlar testlerle kapsanır, canlıda ilk gerçek yenilemede `BillingEvent` satırlarını ve `Subscription.paidThrough`'u izleyin (`docs/billing-rollout.md`).

## Nasıl çalışır

**Olay yalnız tetikleyicidir.** Webhook gelince işleyici nesneyi (abonelik, fatura, Checkout oturumu, ödeme, itiraz) Stripe'tan _güncel haliyle ve sabit API sürümüyle_ (`2024-06-20`) yeniden okur ve sonucu uygular. Böylece: sırasız gelen olaylar, aynı olayın tekrar teslimi ve webhook ucunun farklı API sürümü sonucu değiştirmez; olay gövdesinde kişisel veri saklanmaz. İşleyici idempotenttir; `paidThrough` ve iptal monotondur. Durum, iptal bayrağı ve plan eşitlemesi ise görüntünün OKUNMA anına bakar: kilitten önce okunmuş eski bir görüntü, satıra daha yeni uygulanmış olanı ezmez (`Subscription.stripeSyncedAt`; notta `stale-snapshot`). Ödeme ve iptal bu korumadan bağımsız uygulanır.

| Tetikleyici                                                           | Ne yapar                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice.paid` (ya da Checkout dönüşü / `checkout.session.completed`) | İlk ödeme: aboneliği workspace'e bağlar, `ACTIVE` yapar, `quotaAnchor` = Stripe başlangıcı, `paidThrough` = fatura dönem sonu, kota penceresini açar, bekleyen işleri uyandırır. Yenileme: `paidThrough` ileri gider (asla geri), `PAST_DUE` ise `ACTIVE`. Orantı faturası (plan değişikliği) `paidThrough`'u oynatmaz |
| `invoice.payment_failed`, abonelik `past_due`                         | `PAST_DUE`, `graceUntil` = +3 gün (yeniden denemelerde uzamaz); ek süre içinde mevcut hak harcanır, yeni pencere açılmaz                                                                                                                                                                                               |
| `customer.subscription.updated/deleted`                               | İptal işareti, plan/aralık eşitlemesi, Stripe'ın bitirmesi → `CANCELED` (erişim `paidThrough`'a kadar sürer); `payment_failed`→`PAYMENT_FAILED`, `payment_disputed`→`CHARGEBACK`                                                                                                                                       |
| `checkout.session.completed` (ek paket)                               | `EXTRA` havuzuna süresiz hak (`PURCHASE`, anahtar `pack:<payment_intent>`)                                                                                                                                                                                                                                             |
| `charge.refunded`                                                     | Abonelik faturasının **tamamı** iade: erişim hemen biter (`REFUNDED`), açık penceredeki kullanılmamış hak geri alınır, Stripe aboneliği de kapatılır ve fatura **mezar taşına** yazılır (aşağıda). **Kısmi iade erişimi değiştirmez.** Eski dönem ya da orantı faturası iadesi de erişime dokunmaz (`older-period` / `not-a-period-invoice`, günlükte uyarı: sahip elle bakar). Ek paket: iade oranında geri alınır |
| `charge.dispute.created`                                              | Abonelik: hangi dönemin faturasında olursa olsun `CHARGEBACK` olarak hemen biter + Stripe'ta kapatılır + mezar taşı; ek paket tamamen geri alınır                                                                                                                                                                      |

**Geri alma tabanı:** kullanılmış + rezerve edilmiş hak geri alınmaz (gerçekleşen maliyet). Geri alma defterde işaretli ters kayıt olarak durur (`UsageGrant.amount < 0`, `reason REFUND`, `reverses`).

**İade/itiraz mezar taşı (`BillingReversal`):** Stripe, parası iade edilen faturayı "paid" bırakır (iade yalnız tahsilatı değiştirir). Bu yüzden her tam iade/itiraz, erişim değişsin değişmesin, faturayı mezar taşına yazar ve durum makinesi o faturayı hiçbir yolla "ödenmiş" saymaz (`invoice-reversed`): iadeden sonra yeniden gönderilen `invoice.paid`, aynı Checkout olayı ya da müşterinin eski başarı adresini yeniden açması erişimi ve (yıllıkta) aylık kotayı GERİ GETİRMEZ. Ödemeden ÖNCE işlenen iade de kaybolmaz: mezar taşı yazılır, Stripe aboneliği kapatılır, ödeme olayı gelince uygulanmaz. Yeni bir fatura (yenileme/yeniden abonelik) normal şekilde ödenmiş sayılır.

**Çift abonelik:** ödeme süren bir abonelik varken ikinci bir abonelik ödenirse (iki sekmede açılmış Checkout) ikincisi UYGULANMAZ (`duplicate-subscription`, günlükte uyarı) ve Stripe'ta İPTAL edilir; fatura ödenmiş kalır, **elle iade gerekir** (iade olayı kaydedilir, ikinci kez iptal gerekmez). İptalden önce bağlı aboneliğin Stripe'ta gerçekten sürdüğü doğrulanır: iptal olayı kaçmışsa (Stripe'ta bitmiş) satır eşitlenir ve yeni abonelik bağlanır. Ödenmiş süresi bitmiş bir satır yeni ödemeyi engellemez. İptal edilmiş ama ödenmiş süresi SÜREN bir satıra yeni abonelik bağlanırsa kalan süre kısaltılmaz (`kept-paid-time`).

**Test ve canlı veri aynı veritabanında:** satır hangi modda bağlandıysa o anahtar görür. Çalışan anahtarın modundan farklı bir bağ "abonelik yok" sayılır (Subscribe açılır, plan değiştirme/iptal/paket "abonelik yok" der; müşteri portalı o moddaki müşteriye bakar). Canlı ödeme eski test bağını DEĞİŞTİRİR; ters yönde, hâlâ süren canlı bir aboneliği test ödemesi ezemez (`live-subscription-exists`) ve test anahtarıyla yeni abonelik açılmaz.

**Plan değiştirme** (aralık aynı kalır):

- _Yükseltme_: Stripe'ta kalem değişir, fark orantılı olarak hemen faturalanır ve tahsil edilir (`always_invoice` + `error_if_incomplete`: ödenemezse güncelleme UYGULANMAZ). Fatura ödenmiş görününce plan hemen değişir ve kalan pencere oranında fark hakkı eklenir (`plan-change:<fatura>:<eski>><yeni>`).
- _Düşürme_: Stripe kalemi değişir ama para hareketi yoktur (`proration none`); kullanıcı ödenmiş dönemin sonuna kadar eski planda kalır (`pendingPlanKey`, `pendingEffectiveAt` = `paidThrough` − 6 saat), sonraki yenileme yeni fiyattan faturalanır ve yeni pencere küçük kotayla açılır.
- _Vazgeçme_: bekleyen düşürmeyi geri almak ya da bekleyenin üstüne yükseltmek, önce Stripe kalemini ÖDENEN plana parasız geri alır (aynı aralık), sonra istenen değişikliği oradan yapar: "düşür, vazgeç, yükselt" aynı dönemi iki kez ücretlendirmez. Yükseltme (kart) reddedilirse zamanlanmış düşürme GERİ konur: müşterinin seçimi kaybolmaz ve "planınız değişmedi" doğru kalır.
- Her değişiklik önce Stripe'ın GÜNCEL hâliyle eşitlenir. Stripe satırdan ÖNDEYSE ve ödenmişse (işlenmemiş ödeme) o benimsenir; ödenmemişse hiçbir şey yapılmaz (`CHANGE_IN_PROGRESS`). Aralık Stripe'ta uygulama dışından değişmişse dokunulmaz (`BILLING_CHANGED_OUTSIDE`: kalemi geri itmek dönemi sıfırlayıp hemen faturalar).
- Ödeme sorunu (`PAST_DUE` → `PAYMENT_PROBLEM`) ya da iptali planlanmış abonelikte (`SUBSCRIPTION_ENDING`) plan değiştirilemez; kural sunucuda zorunludur, yalnız düğmelerin gizlenmesine bağlı değildir.
- Sonucu belirsiz değişiklik (ağ hatası, 5xx, bozuk yanıt, kayıt hatası) "değişmedi" DENMEZ: durum Stripe'tan yeniden okunup eşitlenir ve `OUTCOME_UNKNOWN` ("Check My subscription…") döner. Başarısız denemeden sonra da ekran yenilenir.
- Muaf (kalıcı tam erişimli) workspace'e abonelik ya da ek paket satılmaz (`FULL_ACCESS`); erişimi biten bir plana (ek süresi dolmuş) ek paket satılmaz.

**İlk ay indirimi:** yalnız aylık faturalamada, daha önce hiç ödeme yapmamış ve kampanyayı kullanmamış workspace'e (sunucu karar verir; istemciden gelen "uygula" isteği uygun değilse reddedilir). Stripe tarafında plan başına bir kupon (`amount_off`, `duration once`, kimliği tutarı taşır). Business/Agency'de ilk pencere %75 kotayla açılır; yeniden abone olan ikinci kez indirim/azaltılmış pencere almaz.

**Checkout dönüşü:** kullanıcı Stripe'tan `/billing?...&session_id=…` ile dönünce sayfa webhook'u beklemeden aynı işleyiciyi çalıştırır (oturum bu workspace'in müşterisine aitse). Webhook sonra gelince hiçbir şey değişmez. Yalnız faturalamayı yönetebilen kişi için, workspace başına 10 dakikada 10 kez ve workspace'in o moddaki Stripe müşterisi yoksa Stripe'a HİÇ gidilmeden çalışır (adres Stripe'a okuma yağdırmak için kullanılamaz). Bildirim gösterildikten sonra `notice`, `checkout`, `purchase`, `session_id` adresten silinir (yer imi/yeniden yükleme tekrarlamaz).

**Promosyon kodu:** fiyat ekranındaki "Promo code" alanı Stripe'ın promosyon kodlarını kullanır; kodlar SİZİN tarafınızdan Stripe'ta yaratılır (Dashboard → Product catalog → Coupons → bir kupon yaratın → *Promotion codes* → kod ekleyin). Kullanıcı kodu yazar, uygulama kodun geçerli olduğunu ve ne verdiğini ("20% off your first payment") gösterir; ödeme Stripe Checkout'ta kodla alınır. Kurallar:
- Checkout tek indirim kabul eder: **kod, ilk ay indiriminin yerine geçer** (ikisi birlikte olmaz); yıllık faturalamada da kullanılabilir.
- Kod YALNIZ fiyatı etkiler: kota değişmez ve Business/Agency'nin "ilk ay %75 kota"sı **uygulanmaz** (kod = tam kota; çünkü o azaltma yalnız uygulamanın kendi ilk ay kampanyasına bağlıdır).
- Kullanım sınırı, bitiş tarihi, "yalnız ilk alışveriş", asgari tutar ve müşteriye özel kod Stripe'ta kod ayarıdır; Checkout'ta Stripe uygular. Uygulama ön denetimde geçersiz/süresi dolmuş/dolu/başkasına ait kodu nedenini söylemeden ("That code is not valid or has expired.") reddeder. Kod denemeleri kullanıcı başına 10 dakikada 10 ile sınırlıdır (tahmin yavaşlatılır).
- Para birimi USD dışı tutarlı kuponlar "A discount" olarak gösterilir.

**Güvenlik ağı (süpürme):** webhook'a bağımlı olmayan bir tick adımı (`billing-payments-sweep`, en çok yarım saatte bir) yenileme tarihi gelmiş/geçmiş (son 14 gün) abonelikleri Stripe'tan yeniden okuyup aynı durum makinesine verir. Webhook ucu saatlerce/günlerce kapalı kalsa (Stripe ~3 gün yeniden dener, sonra bırakır) bile yenilemesini ödemiş müşteri erişimsiz, aboneliği Stripe'ta bitmiş müşteri açık kalmaz. Yalnız bağlanmış abonelikler ve yalnız çalışan anahtarın modu; ödeme kapalıyken hiçbir şey yapmaz; `BILLING_MODE`'dan bağımsızdır. (Hiç bağlanmamış ilk ödeme için güvenlik ağı Checkout dönüşüdür; ikisi birden kaybolursa Stripe panelinden olayı yeniden gönderin.)

## Sorun giderme (günlük etiketleri)

Railway günlüğünde aranacak etiketler:

| Günlük satırı                                        | Anlamı / yapılacak                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[billing][operator-action]`                         | Stripe isteklerimizi reddediyor (geçersiz/süresi dolmuş anahtar, canlı hesap etkin değil, portal ayarı kaydedilmemiş). Müşteri "Billing is temporarily unavailable" görür; Stripe panelini düzeltin |
| `[billing] STRIPE_… is not set`                      | Anahtar ve webhook sırrından yalnız biri girilmiş; ödeme kapalı. İkisini de girin                                                                    |
| `[billing] a Stripe TEST key is running in production` | Test anahtarı üretimde: ödeme alınmaz. Gerçek müşteriden önce canlı anahtara geçin                                                                  |
| `[billing] event evt_… needs a look: <not>`          | Elle bakılacak olay (bkz. Veri bölümü); `BillingEvent.note` aynı nedeni söyler                                                                       |
| `[billing] sweep …`                                  | Güvenlik ağı bir aboneliği okuyamadı / Stripe tanımıyor                                                                                              |
| `[billing-webhook] … failed`                         | Olay işlenemedi (500): Stripe 3 güne dek yeniden dener; `BillingEvent.status = FAILED`                                                               |

**Webhook kesintisinden sonra:** kaçırılan yenilemeleri ve bitişleri süpürme (yarım saatte bir) kendiliğinden onarır. Hiç bağlanmamış bir ilk ödeme için müşterinin Checkout dönüşü ya da yeniden "Subscribe" tıklaması (Stripe'ta süren aboneliği bulup bağlar) onarır; yine de bir olayı yeniden göndermek için Stripe panelinde _Developers → Webhooks → olay → Resend_ (30 gün içinde) ya da `stripe events resend <evt_…> --webhook-endpoint <we_…>` kullanılır. `BillingEvent` tablosu şimdilik temizlenmez (olay başına bir satır).

## Gerçek Stripe testi (duman testi)

Birim testler Stripe'ı taklit eder; parametre adlarındaki ya da alan şeklindeki bir yanlışı yalnız gerçek Stripe test API'sine karşı bir koşu yakalar. Tek komut (yerelde, `.env` içinde `STRIPE_SECRET_KEY=sk_test_...` varken; canlı anahtar REDDEDİLİR, veritabanına dokunmaz):

```
npm run billing:stripe-smoke
```

Çıktıdaki her satır `PASS` / `WARN` / `FAIL`'dir. Test; her planın Checkout oturumunu ve kupon fiyatını, yıllık oturumu, ek paket oturumlarını, promosyon kodunu, portalı, gerçek bir test aboneliğini (ilk ay kuponuyla ödenen tutar katalogla aynı mı), yükseltmeyi (orantı faturası), düşürmeyi (para hareketi yok), iptal/devamı, fatura listesini, kısmi iadeyi, ek paket ödemesini ve imza turunu dener; sonunda kendi yarattığı abonelik ve müşteriyi siler, test promosyon kodunu kapatır. `WARN` genelde portal ayarının kaydedilmediğini söyler (adım 3). `FAIL` varsa çıktının tamamını geliştiriciye gönderin. İtiraz kartını da denemek için `npm run billing:stripe-smoke -- --dispute`.

## Güvenlik

- İmza: `Stripe-Signature` ham gövde üzerinde HMAC-SHA256, 5 dakika tolerans, zaman-sabit karşılaştırma, çoklu `v1` ve çoklu sır (döndürme). Geçersiz → 401. Gövde ≤ 512 KB (aşarsa 413, `Content-Length` yalan söylese bile okunan bayta bakılır). Sır yoksa 503 (Stripe olayı tutup yeniden dener).
- Kiracı: bir olayın workspace'i yalnız `BillingCustomer` tablosundan çözülür; Stripe tarafındaki `metadata.workspaceId` / `client_reference_id` ile ÇELİŞİRSE olay işlenmez (`tenant-mismatch`, günlükte yüksek sesle). Tanınmayan müşteri → yok sayılır.
- Tutarlar ve planlar yalnız `plans.ts`'ten; istemciden yalnız plan/aralık/paket anahtarı gelir ve doğrulanır. Workspace asla istemciden alınmaz.
- Eylemler yalnız workspace sahibi/yöneticisi içindir; kullanıcı başına 10 dakikada 20 çağrı.
- Canlı ve test müşterileri ayrı satırlardır (`BillingCustomer` mod başına); test modunda bağlanmış bir abonelik gerçek (canlı) ödemeyi engellemez, canlı ödeme onu değiştirir (bkz. "Test ve canlı veri").
- Çift abonelik: ödeme süren bir abonelik varken ikinci Checkout açılmaz (yerel kayıt "ödüyor" dese de önce Stripe'a sorulur); yine de ikinci bir abonelik ödenirse Stripe'ta iptal edilir ve olay `duplicate-subscription` olarak ayrılır (bkz. "Çift abonelik"); **elle iade gerekir**.
- Webhook ucu: `Stripe-Signature` başlığı yoksa gövde hiç okunmadan 401. `STRIPE_WEBHOOK_SECRET` kesik/yer tutucu ise ödeme kapalı (HMAC anahtarı tahmin edilebilir olurdu).
- Stripe'a giden müşteri adı 200, e-posta 254 karakterle sınırlıdır; biçimsiz e-posta gönderilmez (Checkout müşteriden ister). Müşteri/ürün/kupon istekleri rastgele idempotency anahtarı taşır (Stripe sabit anahtarın ilk yanıtını 24 saat tekrar eder: silinen müşteri/başarısız istek yeniden denenemezdi).

## Veri

- `BillingCustomer` (workspace × mod → Stripe müşterisi), `Subscription.stripeSubscriptionId` / `stripeLivemode` / `stripeSyncedAt`, `BillingEvent` (webhook gelen kutusu: olay kimliği tekil, durum `PENDING|PROCESSED|IGNORED|FAILED`, `note`), `BillingReversal` (parası iade/itiraz edilen fatura, `stripeInvoiceId` tekil, `reason` `REFUNDED|CHARGEBACK`). Migration'lar: `20261009130000_add_payments`, `20261009150000_add_billing_reversal` (yalnız ekleme).
- Bir olaya bakmak: `SELECT type, status, attempts, note, "workspaceId", "receivedAt" FROM "BillingEvent" ORDER BY "receivedAt" DESC LIMIT 50;` `FAILED` olay Stripe tarafından 3 güne kadar yeniden denenir; düzeltme sonrası Stripe panelinden "Resend" ile de gönderilebilir. `IGNORED` satırlarında `note` nedeni söyler (`tenant-mismatch`, `unknown-customer`, `duplicate-subscription`, `live-subscription-exists`, `unknown-plan`, `awaiting-payment`, `partial-refund`, `invoice-reversed`, `older-period`, `livemode-mismatch` …). Günlükte uyarı veren notlar (`tenant-mismatch`, `duplicate-subscription`, `live-subscription-exists`, `unknown-plan`, `no-paid-period`, `livemode-mismatch`, `older-period`, `not-a-period-invoice`) elle bakılacak durumlardır; `livemode-mismatch` anahtarın modu ile webhook ucunun modu çelişiyor demektir (yanlış kurulum), olay kalıcı IGNORED kalır ve "Resend" onu işlemez.
- Stripe'ta ürünler (`agentelse_plan_<plan>`) ve ilk ay kuponları ilk kullanımda KENDİLİĞİNDEN yaratılır; fiyatlar her ödemede satır içi (`price_data`) gönderilir, panelde elle fiyat tutmayın.

## Bilinen sınırlar ve açık kararlar

- **İade/itiraz politikası sahip kararı bekliyor**; yukarıdakiler güvenli varsayılandır (tam iade = anında bitir; kısmi iade = dokunma; itiraz = bitir). Kısmi iade ve orantı faturası iadesi elle ele alınır.
- Aylık↔yıllık geçiş bu ekrandan yok (plan değişir, aralık kalır). Portal'da açılırsa sistem bunu düşürme gibi (dönem sonunda) işler ama o abonelik için uygulama içi plan değişikliği kapanır (`BILLING_CHANGED_OUTSIDE`): portalda plan/aralık değiştirmeyi KAPALI tutun.
- 3D Secure gerektiren yükseltme ödemesi hata verir ("kart reddedildi / ek doğrulama"): çözüm kullanıcıya portaldan kartı güncelletmek ya da yeniden denetmektir; sayfa içi doğrulama akışı yok.
- Vergi (Stripe Tax / KDV numarası toplama) YOK; B2B faturası için sahip kararı.
- Deneme: kayıtta kartsız 7 gün bağlandı (`docs/billing-quota.md`). Uygulama içi kampanyalar (ilk aboneliğe %25 bonus kullanım, referans ödülü) YAPILMIYOR (sahip kararı); promosyon kodu yalnız fiyatı etkiler.
- Bir workspace aynı anda tek Stripe aboneliği taşır; paralel iki Checkout'un ikincisi `duplicate-subscription` olur (yukarıya bakın).
- Faz 7: aynı akışlar gerçek Stripe TEST API'sine karşı elle doğrulanacak (bu fazdaki testlerde Stripe sahte ağ geçididir; istek şekilleri `gateway.test.ts`'te gerçek alan adlarıyla sabitlenmiştir).

## Testler

`stripe/*.test.ts` (imza, form kodlama, istemci, ayrıştırıcılar, katalog, ağ geçidi istek şekilleri, ayar), `payments/*.integration.test.ts` (durum makinesi, iade/geri alma, olay işleme, kullanıcı eylemleri — gerçek Postgres; `review-fixes` = inceleme düzeltmelerinin kanıtı, `review-gaps` = mutasyon incelemesinin bulduğu boşluklar: kiracı denetimi her olay yolunda, canlı mod/yıllık faturalama, ödeme sonrası bekleyen işin uyanması, eşzamanlı eşitleme), `api/webhooks/billing/route*.test.ts`, `actions/billing-actions*.test.ts`, `billing/page*.test.ts`, `billing-screens.test.ts`, `plan-picker.wiring.test.ts` (düğmelerin GÖNDERDİĞİ eylem/girdi/onay/yönlendirme), `picker-mode.test.ts`. Düğmenin kendi davranışı (tıklama, meşgul durumu, hata metni, yönlendirme) için DOM test kütüphanesi (happy-dom/jsdom) gerekir; yeni bağımlılık olduğu için sahip onayı bekliyor.

Test yazarken: sürüm/süre sabitlerini testte içe aktarıp oracle yapma (5 dk imza toleransı, 6 saat bekleme payı, 100 USD sınırı gibi belgelenmiş değerler sabit sayı olarak sınanır); `toBeLessThanOrEqual(1)` gibi gevşek sayım yerine tam sayı kullan.

# Ödemeler (Stripe, Faz 4)

Abonelik ödemesi, plan değiştirme, iptal, ek paket satın alma ve iade/itiraz geri alma. Yalnız ödeme: kota ve park mantığı `docs/billing-quota.md` ve `docs/billing-tasks.md`'de. **Bu faz canlıda hiçbir şeyi kendiliğinden açmaz**: Stripe anahtarları girilmedikçe `/billing` fiyatları gösterir, satın alma düğmeleri kapalıdır ve webhook ucu 503 verir. `BILLING_MODE` bu fazda DEĞİŞMEZ (`off` kalır).

## Sahip: kurulum (bir kez, sırayla)

Önce TEST modunda deneyin; canlı anahtarı en son girin.

1. **Stripe hesabı** → Developers → API keys → _Secret key_ (`sk_test_…`). Kısıtlı anahtar (`rk_…`) kullanacaksanız şu izinler gerekir: Customers, Checkout Sessions, Subscriptions, Invoices, Charges, PaymentIntents, Disputes, Products, Coupons, Promotion codes, Customer portal sessions (hepsi _write_; Charges/PaymentIntents/Disputes/Promotion codes _read_). Duman testi (aşağıda) daha çok şey yarattığı için TAM test anahtarı (`sk_test_…`) ister.
2. **Webhook ucu** → Developers → Webhooks → _Add endpoint_:
   - URL: `https://<uygulama-adresi>/api/webhooks/billing`
   - Dinlenecek olaylar (yalnız bunlar): `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.
   - Oluşunca _Signing secret_'ı (`whsec_…`) kopyalayın.
3. **Müşteri portalı** → Settings → Billing → _Customer portal_ → kaydedin (kaydedilmeden portal oturumu açılmaz). Önerilen ayar: ödeme yöntemi güncelleme AÇIK, fatura geçmişi AÇIK, **abonelik iptali ve plan değiştirme KAPALI** (bunlar uygulamanın kendi ekranından yapılır; portalda açık kalırsa sistem yine doğru eşitler ama yükseltmenin kota farkı yalnız uygulama akışında hesaplanır).
4. **Ortam değişkenleri** (Railway, servis `@agentelse`):
   - `STRIPE_SECRET_KEY` = `sk_test_…`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…`
   - `BILLING_UI=true` (ekranı açar; zaten açıksa gerekmez)
   - (sır döndürürken) `STRIPE_WEBHOOK_SECRET_PREVIOUS` = eski `whsec_…`; yeni sır yerleşince silin.
5. **Yerel geliştirme**: yalnız TEST anahtarı. Canlı anahtar `NODE_ENV≠production` iken **reddedilir** (geliştirme süreci canlı veritabanını paylaşır). Webhook'u yerelde denemek için `stripe listen --forward-to localhost:3000/api/webhooks/billing` verdiği `whsec_…`'i kullanın. Ödeme denemesi için **ayrı, atılabilir bir workspace** kullanın: test modunda ödenmiş bir abonelik o workspace'in satırına yazılır.
6. **Test planı** (anahtarlar girildikten sonra, test modunda): Subscribe → `4242 4242 4242 4242` → `/billing?tab=subscription`'da "Payment received. Your plan is active." → Stripe'ta olayların 200 döndüğünü ve `BillingEvent` tablosunda `PROCESSED` olduğunu doğrulayın. Sonra: yükseltme, düşürme, iptal/devam, ek paket, portal (ödeme yöntemi), `4000 0000 0000 0341` (yenilemede ödeme hatası), Stripe panelinden iade.
7. **Canlıya geçiş**: aynı adımlar canlı anahtar ve canlı webhook ucuyla. `BILLING_MODE` hâlâ `off`; zorunlulama ayrı karardır (`docs/billing-quota.md`, Faz 7).

## Nasıl çalışır

**Olay yalnız tetikleyicidir.** Webhook gelince işleyici nesneyi (abonelik, fatura, Checkout oturumu, ödeme, itiraz) Stripe'tan _güncel haliyle ve sabit API sürümüyle_ (`2024-06-20`) yeniden okur ve sonucu uygular. Böylece: sırasız gelen olaylar, aynı olayın tekrar teslimi ve webhook ucunun farklı API sürümü sonucu değiştirmez; olay gövdesinde kişisel veri saklanmaz. İşleyici monoton ve idempotenttir.

| Tetikleyici                                                           | Ne yapar                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice.paid` (ya da Checkout dönüşü / `checkout.session.completed`) | İlk ödeme: aboneliği workspace'e bağlar, `ACTIVE` yapar, `quotaAnchor` = Stripe başlangıcı, `paidThrough` = fatura dönem sonu, kota penceresini açar, bekleyen işleri uyandırır. Yenileme: `paidThrough` ileri gider (asla geri), `PAST_DUE` ise `ACTIVE`. Orantı faturası (plan değişikliği) `paidThrough`'u oynatmaz |
| `invoice.payment_failed`, abonelik `past_due`                         | `PAST_DUE`, `graceUntil` = +3 gün (yeniden denemelerde uzamaz); ek süre içinde mevcut hak harcanır, yeni pencere açılmaz                                                                                                                                                                                               |
| `customer.subscription.updated/deleted`                               | İptal işareti, plan/aralık eşitlemesi, Stripe'ın bitirmesi → `CANCELED` (erişim `paidThrough`'a kadar sürer); `payment_failed`→`PAYMENT_FAILED`, `payment_disputed`→`CHARGEBACK`                                                                                                                                       |
| `checkout.session.completed` (ek paket)                               | `EXTRA` havuzuna süresiz hak (`PURCHASE`, anahtar `pack:<payment_intent>`)                                                                                                                                                                                                                                             |
| `charge.refunded`                                                     | Abonelik faturasının **tamamı** iade: erişim hemen biter (`REFUNDED`), açık penceredeki kullanılmamış hak geri alınır, Stripe aboneliği de kapatılır. **Kısmi iade erişimi değiştirmez.** Ek paket: iade oranında geri alınır                                                                                          |
| `charge.dispute.created`                                              | Abonelik: `CHARGEBACK` olarak hemen biter + Stripe'ta kapatılır; ek paket tamamen geri alınır                                                                                                                                                                                                                          |

**Geri alma tabanı:** kullanılmış + rezerve edilmiş hak geri alınmaz (gerçekleşen maliyet). Geri alma defterde işaretli ters kayıt olarak durur (`UsageGrant.amount < 0`, `reason REFUND`, `reverses`).

**Plan değiştirme** (aralık aynı kalır):

- _Yükseltme_: Stripe'ta kalem değişir, fark orantılı olarak hemen faturalanır ve tahsil edilir (`always_invoice` + `error_if_incomplete`: ödenemezse güncelleme UYGULANMAZ). Fatura ödenmiş görününce plan hemen değişir ve kalan pencere oranında fark hakkı eklenir (`plan-change:<fatura>:<eski>><yeni>`).
- _Düşürme_: Stripe kalemi değişir ama para hareketi yoktur (`proration none`); kullanıcı ödenmiş dönemin sonuna kadar eski planda kalır (`pendingPlanKey`, `pendingEffectiveAt` = `paidThrough` − 6 saat), sonraki yenileme yeni fiyattan faturalanır ve yeni pencere küçük kotayla açılır.
- _Vazgeçme_: bekleyen düşürmeyi geri almak ya da bekleyenin üstüne yükseltmek, önce Stripe kalemini ÖDENEN plana parasız geri alır, sonra istenen değişikliği oradan yapar: "düşür, vazgeç, yükselt" aynı dönemi iki kez ücretlendirmez.
- Ödeme sorunu (`PAST_DUE`) ya da iptali planlanmış abonelikte plan değiştirilemez.

**İlk ay indirimi:** yalnız aylık faturalamada, daha önce hiç ödeme yapmamış ve kampanyayı kullanmamış workspace'e (sunucu karar verir; istemciden gelen "uygula" isteği uygun değilse reddedilir). Stripe tarafında plan başına bir kupon (`amount_off`, `duration once`, kimliği tutarı taşır). Business/Agency'de ilk pencere %75 kotayla açılır; yeniden abone olan ikinci kez indirim/azaltılmış pencere almaz.

**Checkout dönüşü:** kullanıcı Stripe'tan `/billing?...&session_id=…` ile dönünce sayfa webhook'u beklemeden aynı işleyiciyi çalıştırır (oturum bu workspace'in müşterisine aitse). Webhook sonra gelince hiçbir şey değişmez.

**Promosyon kodu:** fiyat ekranındaki "Promo code" alanı Stripe'ın promosyon kodlarını kullanır; kodlar SİZİN tarafınızdan Stripe'ta yaratılır (Dashboard → Product catalog → Coupons → bir kupon yaratın → *Promotion codes* → kod ekleyin). Kullanıcı kodu yazar, uygulama kodun geçerli olduğunu ve ne verdiğini ("20% off your first payment") gösterir; ödeme Stripe Checkout'ta kodla alınır. Kurallar:
- Checkout tek indirim kabul eder: **kod, ilk ay indiriminin yerine geçer** (ikisi birlikte olmaz); yıllık faturalamada da kullanılabilir.
- Kod YALNIZ fiyatı etkiler: kota değişmez ve Business/Agency'nin "ilk ay %75 kota"sı **uygulanmaz** (kod = tam kota; çünkü o azaltma yalnız uygulamanın kendi ilk ay kampanyasına bağlıdır).
- Kullanım sınırı, bitiş tarihi, "yalnız ilk alışveriş", asgari tutar ve müşteriye özel kod Stripe'ta kod ayarıdır; Checkout'ta Stripe uygular. Uygulama ön denetimde geçersiz/süresi dolmuş/dolu/başkasına ait kodu nedenini söylemeden ("That code is not valid or has expired.") reddeder. Kod denemeleri kullanıcı başına 10 dakikada 10 ile sınırlıdır (tahmin yavaşlatılır).
- Para birimi USD dışı tutarlı kuponlar "A discount" olarak gösterilir.

**Güvenlik ağı (süpürme):** webhook'a bağımlı olmayan bir tick adımı (`billing-payments-sweep`, en çok yarım saatte bir) yenileme tarihi gelmiş/geçmiş (son 14 gün) abonelikleri Stripe'tan yeniden okuyup aynı durum makinesine verir. Webhook ucu saatlerce/günlerce kapalı kalsa (Stripe ~3 gün yeniden dener, sonra bırakır) bile yenilemesini ödemiş müşteri erişimsiz, aboneliği Stripe'ta bitmiş müşteri açık kalmaz. Yalnız bağlanmış abonelikler ve yalnız çalışan anahtarın modu; ödeme kapalıyken hiçbir şey yapmaz; `BILLING_MODE`'dan bağımsızdır. (Hiç bağlanmamış ilk ödeme için güvenlik ağı Checkout dönüşüdür; ikisi birden kaybolursa Stripe panelinden olayı yeniden gönderin.)

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
- Canlı ve test müşterileri ayrı satırlardır (`BillingCustomer` mod başına); test modunda bağlanmış bir abonelik gerçek (canlı) ödemeyi engellemez, canlı ödeme onu değiştirir.
- Çift abonelik: ödeme süren bir abonelik varken ikinci Checkout açılmaz; yine de ikinci bir abonelik ödenirse olay `duplicate-subscription` olarak ayrılır (UYGULANMAZ), günlükte uyarılır; **elle iade gerekir**.

## Veri

- `BillingCustomer` (workspace × mod → Stripe müşterisi), `Subscription.stripeSubscriptionId` / `stripeLivemode`, `BillingEvent` (webhook gelen kutusu: olay kimliği tekil, durum `PENDING|PROCESSED|IGNORED|FAILED`, `note`). Migration: `20261009130000_add_payments` (yalnız ekleme).
- Bir olaya bakmak: `SELECT type, status, attempts, note, "workspaceId", "receivedAt" FROM "BillingEvent" ORDER BY "receivedAt" DESC LIMIT 50;` `FAILED` olay Stripe tarafından 3 güne kadar yeniden denenir; düzeltme sonrası Stripe panelinden "Resend" ile de gönderilebilir. `IGNORED` satırlarında `note` nedeni söyler (`tenant-mismatch`, `unknown-customer`, `duplicate-subscription`, `unknown-plan`, `awaiting-payment`, `partial-refund` …).
- Stripe'ta ürünler (`agentelse_plan_<plan>`) ve ilk ay kuponları ilk kullanımda KENDİLİĞİNDEN yaratılır; fiyatlar her ödemede satır içi (`price_data`) gönderilir, panelde elle fiyat tutmayın.

## Bilinen sınırlar ve açık kararlar

- **İade/itiraz politikası sahip kararı bekliyor**; yukarıdakiler güvenli varsayılandır (tam iade = anında bitir; kısmi iade = dokunma; itiraz = bitir). Kısmi iade ve orantı faturası iadesi elle ele alınır.
- Aylık↔yıllık geçiş bu ekrandan yok (plan değişir, aralık kalır). Portal'da açılırsa sistem bunu düşürme gibi (dönem sonunda) işler.
- 3D Secure gerektiren yükseltme ödemesi hata verir ("kart reddedildi / ek doğrulama"): çözüm kullanıcıya portaldan kartı güncelletmek ya da yeniden denetmektir; sayfa içi doğrulama akışı yok.
- Vergi (Stripe Tax / KDV numarası toplama) YOK; B2B faturası için sahip kararı.
- Uygulama içi kampanyalar (ilk aboneliğe %25 bonus kullanım, referans ödülü) ve deneme (kartlı/kartsız) kararı açık; promosyon kodu yalnız fiyatı etkiler.
- Bir workspace aynı anda tek Stripe aboneliği taşır; paralel iki Checkout'un ikincisi `duplicate-subscription` olur (yukarıya bakın).
- Faz 7: aynı akışlar gerçek Stripe TEST API'sine karşı elle doğrulanacak (bu fazdaki testlerde Stripe sahte ağ geçididir; istek şekilleri `gateway.test.ts`'te gerçek alan adlarıyla sabitlenmiştir).

## Testler

`stripe/*.test.ts` (imza, form kodlama, istemci, ayrıştırıcılar, katalog, ağ geçidi istek şekilleri, ayar), `payments/*.integration.test.ts` (durum makinesi, iade/geri alma, olay işleme, kullanıcı eylemleri — gerçek Postgres), `api/webhooks/billing/route.test.ts`, `actions/billing-actions.test.ts`, `billing/page.test.ts`, `billing-screens.test.ts`, `picker-mode.test.ts`.

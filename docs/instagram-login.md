# Instagram bağlantısı: Instagram ile giriş

Instagram entegrasyonu iki yoldan kurulabilir. Aynı `instagram` kimlik kaydına (IntegrationCredential) yazılırlar, yayın ve test kodu ikisini aynı çözümleyiciden okur (`src/server/integrations/instagram-target.ts`).

|                        | Instagram ile giriş (yeni, önerilen)                             | Facebook Page ile (eski yol)                                                           |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Kullanıcı ne yapar     | Instagram'ın onay ekranında izin verir                           | Facebook'a girer, Page seçer                                                           |
| Facebook hesabı / Page | Gerekmez                                                         | Gerekir (Page'e bağlı Instagram)                                                       |
| Token                  | Hesabın kendi token'ı (`graph.instagram.com`)                    | Facebook kullanıcı token'ı, yayın anında Page token'ı türetilir (`graph.facebook.com`) |
| Env                    | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`                       | `META_APP_ID`, `META_APP_SECRET`                                                       |
| Başlatma               | `/api/integrations/meta/start?service=instagram&login=instagram` | `.../start?service=instagram`                                                          |

Meta Ads her zaman Facebook yolunu kullanır (Instagram ile giriş reklamlara erişemez). Eski bağlantılar bozulmaz; yeni bağlantı eskisinin yerini alır.

## Kullanıcıya gösterilen şartlar

Entegrasyonlar sayfasındaki Instagram penceresinde "Before you connect" kutusunda yazar:

- Hesap **profesyonel** olmalı (Business ya da Creator). Kişisel hesap bağlanamaz: Instagram'da Ayarlar > Hesap türü ve araçlar > Profesyonel hesaba geç. Kişisel hesap gelirse bağlantı kaydedilmeden `not_professional` hatası gösterilir.
- Facebook hesabı ya da Page gerekmez.
- API ile 24 saatte en çok 100 gönderi yayınlanabilir. Story'de açıklama (caption) olmaz, metin görselin üstünde olmalı.
- Bağlantı 60 gün sürer; süre dolunca kutucuk "Needs reconnection" olur, yeniden bağlanmak yeniler. (Otomatik yenileme yok.)
- Meta uygulaması geliştirme modundayken yalnızca uygulamaya **Instagram tester** olarak eklenmiş hesaplar bağlanabilir.

## Kurulum (bir kez, uygulama sahibi)

Aynı Meta uygulamasında kalınır, ama **Instagram uygulama kimliği ve sırrı `META_APP_ID` / `META_APP_SECRET` değildir**; ayrı bir çifttir.

1. Meta App Dashboard > uygulama > **Add product > Instagram** (kullanım senaryosu: "Manage messaging & content on Instagram").
2. **Instagram > API setup with Instagram login** sayfasında "Instagram app ID" ve "Instagram app secret" değerlerini kopyala.
3. Aynı sayfada **Business login settings > Redirect URL** alanına şunu ekle (yönlendirme adresi Facebook yolununkiyle aynıdır, ama burada ayrıca kaydedilmesi gerekir):
   `<NEXT_PUBLIC_APP_URL>/api/integrations/meta/callback`
4. İzinler: `instagram_business_basic`, `instagram_business_content_publish`.
5. Geliştirme modundayken: **App roles > Roles > Instagram Testers** altına bağlanacak hesapları ekle; hesap sahibi daveti Instagram'da (Ayarlar > Uygulamalar ve web siteleri > Tester davetleri) kabul eder.
6. Railway ortam değişkenleri: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`. Eksikse Instagram penceresi yalnızca Facebook yolunu sunar; ikisi de eksikse bağlantı düğmesi pasiftir.
7. Başkalarının (müşterilerin) hesabını bağlamak için uygulamanın **App Review**'dan `instagram_business_content_publish` için _Advanced Access_ alması gerekir. Facebook yolundaki `instagram_content_publish` için de aynısı geçerliydi.

## Kayıt şekli (`MetaInstagramMetadata`)

```jsonc
// Instagram ile giriş
{
  "login": "instagram",
  "instagramAccount": {
    "id": "<IG professional account id>",
    "username": "...",
    "accountType": "BUSINESS|MEDIA_CREATOR",
  },
  "pages": [],
  "connectedName": "@username",
  "longLivedTokenExpiresAt": "...",
}
// Facebook yolu: "login" yok, "pages" + "selectedPageId" dolu (eskisi gibi)
```

`resolveInstagramTarget(metadata)` iki şekli de `{ login, igUserId, username, pageId? }` olarak çözer; `instagramAccessFor` doğru token'ı ve Graph sunucusunu verir. Yayın hedefi listesi, `canExecute`, yayın ve bağlantı testi hep bunu kullanır.

## Sorun giderme

- **"Unsupported request - method type: get" (long-lived token adımında):** Meta'nın yanıltıcı mesajı. Bağlanan Instagram hesabı uygulamaya **Instagram Tester** olarak eklenmiş ama davet **Pending**. Hesap sahibi Instagram'da Ayarlar > Uygulamalar ve web siteleri > Tester invites > Accept demeli; Meta'da App roles > Roles sayfasında durum **Active** olmalı. GET, POST ve sürümlü yol aynı mesajı verir, yöntem değiştirmek işe yaramaz. Kod bu mesajı bu açıklamayla birlikte gösterir.
- **"Invalid redirect_uri":** adres Instagram > API setup with Instagram login > "4. Set up Instagram business login" > Business login settings > OAuth redirect URIs listesinde birebir olmalı (Enter ile etiket olarak eklenir; "3. Configure webhooks" alanı başka bir şeydir). Yerelde Instagram yalnızca `https://` kabul eder: `npm run dev:https`, `.env.development.local` içinde `NEXT_PUBLIC_APP_URL=https://localhost:3000` ve Meta'ya `https://localhost:3000/api/integrations/meta/callback`.
- Callback hataları sunucu loguna `[meta-callback] ... failed at "<adım>"` olarak yazılır ve entegrasyon penceresinde "Meta said: ..." satırı olarak görünür.

## Bilinen sınırlar

- Token yenileme yok (`ig_refresh_token` kullanılmadı); 60 günde bir yeniden bağlanmak gerekir. Facebook yolunda da durum aynıydı.
- Bağlı hesaplar kartındaki **Facebook** satırı Page'e bakar: Instagram ile girişte Page olmadığı için, Meta Ads'in seçili Page'i yoksa "Bağlı değil" görünür.
- Business Discovery (rakip hesap okuma) yalnızca Facebook yolunda çalışır; kodda kullanılmıyor.
- Canlı Instagram hesabıyla denenmedi: onay ekranı, kod değişimi ve yayın akışı birim testlerde sahte yanıtlarla doğrulandı.

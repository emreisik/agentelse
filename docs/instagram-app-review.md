# Instagram: herkesin hesabını bağlayabilmek için (App Review)

Şu an yalnızca Meta uygulamasında rolü olan (Instagram Tester) hesaplar bağlanabiliyor. Müşterilerin hesaplarını tester eklemeden bağlamak için uygulamanın **Advanced Access** alması gerekir. Bunun için Meta'ya başvuru (App Review) yapılır. Bu belge, başvurudan önce hazır olması gerekenleri ve kodda neyin hazır olduğunu listeler. Genel kurulum: `docs/instagram-login.md`.

## Kodda hazır olanlar (deploy sonrası canlı)

| Meta'nın istediği | Adres | Ne yapar |
|---|---|---|
| Privacy Policy URL | `https://agentelse.ai/privacy` | "Instagram and Meta connections" bölümü eklendi (hangi izinler, neyi saklıyoruz, nasıl silinir) |
| Terms URL | `https://agentelse.ai/terms` | zaten vardı |
| **Deauthorize callback URL** | `https://agentelse.ai/api/integrations/meta/deauthorize` | Kişi uygulamayı Instagram'dan kaldırınca bağlantıyı iptal eder (`REVOKED`) |
| **Data deletion request URL** | `https://agentelse.ai/api/integrations/meta/data-deletion` | Veri silme talebinde bağlantı kaydını (token, hesap id, kullanıcı adı) siler, `{url, confirmation_code}` döner |
| Data deletion instructions / durum sayfası | `https://agentelse.ai/data-deletion` | Silme talimatı; `?code=` ile bir talebin durumunu gösterir |

İki callback oturumsuz çalışır, Meta'nın `signed_request` imzasını Instagram ya da Meta uygulama secret'ıyla doğrular, imzasız isteğe 400 döner. Kişiyi iki kimlikten biriyle eşler (hesap id ve app-scoped id); **bu id'ler yalnızca bu sürümden sonra bağlanan hesaplara kaydedilir**, daha önce bağlanan hesabı eşleştirmek için yeniden bağlamak gerekir. Facebook Page yolunda Facebook kullanıcı id'si saklamadığımız için o isteklerle eşleşme olmaz (zararsız, hiçbir şey yapılmaz).

## Meta panelinde girilecekler (sizde)

1. **Instagram > API setup with Instagram login > "4. Set up Instagram business login" > Business login settings**
   - Deauthorize callback URL: `https://agentelse.ai/api/integrations/meta/deauthorize`
   - Data deletion request URL: `https://agentelse.ai/api/integrations/meta/data-deletion`
2. **App settings > Basic:** uygulama ikonu (1024x1024), Privacy Policy URL, Terms of Service URL, kategori, iş e-postası, **User data deletion** için aynı veri silme callback adresi (ya da talimat adresi `https://agentelse.ai/data-deletion`).
3. Aynı iki adresi, Meta Ads / Facebook Login için de **Facebook Login for Business > Settings** altındaki ilgili alanlara girebilirsiniz.
4. **Business Verification:** uygulamanın bağlı olduğu işletme doğrulanmış olmalı (Meta Business Suite > Ayarlar > Güvenlik merkezi). Şu an uygulama "Web Health | Sağlık Turizmi Dijital Ajansı" işletmesine bağlı; ürünü sunan işletmenin bu olduğundan emin olun.

## Başvurudan önce (sizde)

- **Test çağrıları:** Meta > Test sayfasında `instagram_business_content_publish` için "0 of 1 API call required" yazıyor. Agentelse'ten Instagram'a **bir gerçek yayın** yapın (Share on Social Accounts > Post), gönderiyi sonra silin. Sayaçlar 24 saate kadar geç güncellenebilir. `instagram_business_basic` için bağlanma sırasındaki profil okuması sayılır.
- **Yalnızca iki izin isteyin:** `instagram_business_basic`, `instagram_business_content_publish`. `manage_comments`, `manage_messages`, `manage_insights` kullanılmıyor.
- **Gözden geçiren hesabı:** canlıda giriş yapılabilen bir test hesabı (e-posta/şifre) ve içinde bir proje. Instagram tarafında bağlanacak bir profesyonel hesap, **Meta uygulamasında Instagram Tester olarak Active** (gözden geçirenin Instagram hesabı da eklenebilir ya da sizin test hesabınız verilebilir).

## Başvuruya yapıştırılacak metinler (İngilizce)

**Permission: instagram_business_basic**
> Agentelse is a marketing workspace for agencies and brands. After a user signs in to Agentelse and chooses Connect with Instagram, we use instagram_business_basic only to read the connected account's id, username and account type, so we can show which Instagram account is connected and confirm it is a professional account. We do not read followers, messages, comments or any other profile data.

**Permission: instagram_business_content_publish**
> Agentelse creates social posts and stories that the user reviews and approves. When the user clicks Share on the approved creative, Agentelse publishes that image to the connected Instagram professional account using instagram_business_content_publish. Nothing is published without the user's explicit action. Posts are published as feed posts or stories.

**Reviewer instructions**
> 1. Open https://agentelse.ai/login and sign in with the test account given in the credentials field.
> 2. Open the project "<proje adı>", then Integrations (left menu) > Instagram.
> 3. Click "Connect with Instagram", sign in on Instagram with the test Instagram account (an Instagram Tester of this app) and tap Allow.
> 4. The connection dialog now shows the connected @username and account type.
> 5. Open any creative in the project and, under "Share on Social Accounts", click "Post". The image is published to the connected account (visible on the account's Instagram profile).
> 6. To remove the connection: Integrations > Instagram > Disconnect, or remove Agentelse in Instagram > Settings > Apps and websites. Data deletion: https://agentelse.ai/data-deletion

## Ekran videosu senaryosu (İngilizce arayüz, ekranda kısa altyazılar)

Her izin için ayrı video, ya da tek videoda iki bölüm. 1-2 dakika.

1. **instagram_business_basic:** (altyazı: "Sign in to Agentelse") giriş > Integrations > Instagram > "Connect with Instagram" > Instagram onay ekranı, izin listesi görünsün, **Allow** > dönüşte pencerede "Instagram account: @username (Business)" satırı (altyazı: "Agentelse reads the account id, username and type to show which account is connected").
2. **instagram_business_content_publish:** (altyazı: "Publish an approved creative") projede bir görsel kartı > "Share on Social Accounts" > **Post** > "Sent" onayı > Instagram uygulaması/web'de profilde gönderinin göründüğü an (altyazı: "The post appears on the connected Instagram account").
3. **Kaldırma:** Integrations > Instagram > **Disconnect**; sonra `https://agentelse.ai/data-deletion` sayfasını göster (altyazı: "Users can disconnect and request deletion at any time").

## Sonra

Onaylanınca kodda değişiklik gerekmez: müşteriler yalnızca profesyonel (Business ya da Creator) Instagram hesabıyla, tester eklemeden bağlanır. Meta, uygulamanın Data Use Checkup'ını yılda bir ister.

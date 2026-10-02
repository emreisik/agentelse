# Instagram: herkesin hesabını bağlayabilmek için (App Review)

Şu an yalnızca Meta uygulamasında rolü olan (Instagram Tester) hesaplar bağlanabiliyor. Müşterilerin hesaplarını tester eklemeden bağlamak için uygulamanın **Advanced Access** alması gerekir. Bunun için Meta'ya başvuru (App Review) yapılır. Bu belge, başvurudan önce hazır olması gerekenleri ve kodda neyin hazır olduğunu listeler. Genel kurulum: `docs/instagram-login.md`.

## Kodda hazır olanlar (deploy sonrası canlı)

| Meta'nın istediği | Adres | Ne yapar |
|---|---|---|
| Privacy Policy URL | `https://agentelse.ai/privacy` | "Instagram connection" bölümü eklendi (hangi izinler, neyi saklıyoruz, otomatik/zamanlı yayın, nasıl silinir, Facebook yolu ve Meta Ads) |
| Terms URL | `https://agentelse.ai/terms` | zaten vardı |
| **Deauthorize callback URL** | `https://agentelse.ai/api/integrations/meta/deauthorize` | Kişi uygulamayı Instagram'dan kaldırınca bağlantıyı iptal eder (`REVOKED`) |
| **Data deletion request URL** | `https://agentelse.ai/api/integrations/meta/data-deletion` | Veri silme talebinde bağlantı kaydını (token, hesap id, kullanıcı adı) siler, `{url, confirmation_code}` döner |
| Data deletion instructions / durum sayfası | `https://agentelse.ai/data-deletion` | Silme talimatı; `?code=` ile bir talebin durumunu gösterir |

İki callback oturumsuz çalışır, Meta'nın `signed_request` imzasını Instagram ya da Meta uygulama secret'ıyla doğrular (imza doğrulanmadan hiçbir şey çözülmez; en çok 4096 karakter, gövde en çok 16 KB), imzasız isteğe 400 döner. Kişiyi iki kimlikten biriyle eşler (hesap id ve app-scoped id); **bu id'ler yalnızca 920d357'den sonra bağlanan hesaplara kaydedilir**, daha önce bağlanan hesabı eşleştirmek için yeniden bağlamak gerekir. Her doğrulanmış istek sunucu loguna tek satır yazar (`[meta-deauthorize] verified request (id length N): M connection(s) revoked`, `[meta-data-deletion] ... erased`; kimliğin kendisi yazılmaz), reddedilen istek `rejected` uyarısı bırakır: **Meta gerçekte ne gönderiyor, eşleşiyor mu** buradan görülür (`railway logs`).

**Facebook Page yolu eşleşmez:** o yolda Facebook kullanıcı id'si saklamıyoruz, yani Facebook Login için gelen bir silme/yetki iptali isteği hiçbir bağlantıyla eşleşmez. Bu yüzden bu iki callback adresini **yalnızca Instagram business login ayarlarına** girin, Facebook Login ayarlarına girmeyin. Eşleşmeyen istekte sayfa "eşleştirilemedi, e-posta atın" der (yalan söylemez).

## Meta panelinde girilecekler (sizde)

1. **Instagram > API setup with Instagram login > "4. Set up Instagram business login" > Business login settings**
   - Deauthorize callback URL: `https://agentelse.ai/api/integrations/meta/deauthorize`
   - Data deletion request URL: `https://agentelse.ai/api/integrations/meta/data-deletion`
2. **App settings > Basic:** uygulama ikonu (1024x1024), Privacy Policy URL, Terms of Service URL, kategori, iş e-postası. **User data deletion** alanına callback değil **talimat adresini** girin: `https://agentelse.ai/data-deletion`. Bu alan uygulamanın tamamı için (Facebook Login dahil) geçerli, callback eşleşemeyeceği için talimat adresi her durumda doğru olandır.
3. **Business Verification:** uygulamanın bağlı olduğu işletme doğrulanmış olmalı (Meta Business Suite > Ayarlar > Güvenlik merkezi). Şu an uygulama "Web Health | Sağlık Turizmi Dijital Ajansı" işletmesine bağlı; ürünü sunan işletmenin bu olduğundan emin olun.

## Başvurudan önce (sizde)

- **Test çağrıları:** Meta > Test sayfasında `instagram_business_content_publish` için "0 of 1 API call required" yazıyor. Agentelse'ten Instagram'a **bir gerçek yayın** yapın, gönderiyi sonra silin. Canlıda `WORKS_UI=true`: Agency Desk'te yeni bir Work başlatıp bir Instagram görseli isteyin, kartta **Approve**'a basın, kartın altındaki satırda ("On hold: no publish time is set.") **Post now**'a, çıkan onayda ("Post to Instagram now? It goes live right away.") tekrar **Post now**'a basın. Sayaçlar 24 saate kadar geç güncellenebilir. `instagram_business_basic` için bağlanma sırasındaki profil okuması sayılır.
- **Test projesinde otomatik yayını kapatın:** Settings > Autonomy'de Autopilot ve zamanlı yayın kapalı olsun. Aksi halde proje, gözden geçiren hiçbir şeye basmadan yayın yapabilir (varsayılan mod AUTOPILOT; otomatik içerik planlaması ve yayın slotu açılmışsa gönderi insan tıklaması olmadan çıkar). Bu hem başvuru metninin doğruluğu hem de beklenmedik gönderi için önemli.
- **Yalnızca iki izin isteyin:** `instagram_business_basic`, `instagram_business_content_publish`. `manage_comments`, `manage_messages`, `manage_insights` kullanılmıyor.
- **Gözden geçiren hesabı:** canlıda giriş yapılabilen bir test hesabı (e-posta/şifre) ve içinde bir proje. Instagram tarafında bağlanacak bir profesyonel hesap, **Meta uygulamasında Instagram Tester olarak Active** (gözden geçirenin Instagram hesabı da eklenebilir ya da sizin test hesabınız verilebilir).

## Başvuruya yapıştırılacak metinler (İngilizce)

**Permission: instagram_business_basic**
> Agentelse is a marketing workspace for agencies and brands. After a user signs in to Agentelse and chooses Connect with Instagram, we use instagram_business_basic only to read the connected account's id, username and account type, so we can show which Instagram account is connected and confirm it is a professional account. We do not read followers, messages, comments or any other profile data.

**Permission: instagram_business_content_publish**
> Agentelse helps agencies and brands create social posts and stories. The user creates or reviews a post in Agentelse and approves it. An approved post is published to the connected Instagram professional account with instagram_business_content_publish, either right away when the user presses Post now and confirms, or at the time the user set when they turned on scheduled posting (or Autopilot) for that project. Posts are published as feed posts or stories. Only approved content is published, and the user can turn scheduled posting and Autopilot off at any time (Settings).

**Reviewer instructions**
> 1. Open https://agentelse.ai/login and sign in with the test account given in the credentials field.
> 2. Open the project "<PROJE ADI: Meta'ya verilecek test projesinin adı>", then Connectors (left menu, under Channels) > Instagram.
> 3. Click "Connect with Instagram", sign in on Instagram with the test Instagram account (an Instagram Tester of this app) and tap Allow.
> 4. The connection dialog now shows the connected @username and account type.
> 5. Go back to the Agency Desk (top of the left menu), start a new Work and ask for "an Instagram post about <topic>". When the creative card appears, click "Approve". Under the card, click "Post now" and confirm with "Post now" again. The image is published to the connected account (visible on the account's Instagram profile).
> 6. To remove the connection: Connectors > Instagram > Disconnect, or remove Agentelse in Instagram > Settings > Apps and websites. Data deletion: https://agentelse.ai/data-deletion

## Ekran videosu senaryosu (İngilizce arayüz, ekranda kısa altyazılar)

Her izin için ayrı video, ya da tek videoda iki bölüm. 1-2 dakika.

1. **instagram_business_basic:** (altyazı: "Sign in to Agentelse") giriş > Connectors (sol menü, Channels altında) > Instagram > "Connect with Instagram" > Instagram onay ekranı, izin listesi görünsün, **Allow** > dönüşte pencerede "Instagram account: @username (Business)" satırı (altyazı: "Agentelse reads the account id, username and type to show which account is connected").
2. **instagram_business_content_publish:** (altyazı: "Publish an approved creative") Agency Desk'te yeni Work > "an Instagram post about ..." > kartta **Approve** > altındaki satırda **Post now** > onayda **Post now** > "Sent to Instagram. It goes live in a moment." > Instagram uygulaması/web'de profilde gönderinin göründüğü an (altyazı: "The post appears on the connected Instagram account").
3. **Kaldırma:** Connectors > Instagram > **Disconnect**; sonra `https://agentelse.ai/data-deletion` sayfasını göster (altyazı: "Users can disconnect and request deletion at any time").

## Sonra

Onaylanınca kodda değişiklik gerekmez: müşteriler yalnızca profesyonel (Business ya da Creator) Instagram hesabıyla, tester eklemeden bağlanır. Meta, uygulamanın Data Use Checkup'ını yılda bir ister.

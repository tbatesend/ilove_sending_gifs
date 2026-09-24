# X → Discord: Direkt Medya & GIF Yapıcı

X'teki (Twitter) GIF'leri ve videoları Discord'a düzgün atabilmek için bir
Violentmonkey/Tampermonkey userscript'i. `x-direct-media.user.js` dosyası.

## Kurulum

1. Tarayıcına [Violentmonkey](https://violentmonkey.github.io/) kur.
2. `x-direct-media.user.js` dosyasının **Raw** halini aç, Violentmonkey kurmayı
   önerir. Ya da Violentmonkey → **+** → yeni script → dosyanın içeriğini
   yapıştır → kaydet.
3. Arkadaşının eski script'i (v5) de açıksa **onu kapat**, ikisi aynı Share
   menüsüne müdahale eder.
4. Tampermonkey kullanıyorsan ilk kullanımda `api.fxtwitter.com`,
   `video.twimg.com`, `discord.com` adreslerine istek izni sorabilir,
   "Always allow" de.

## Kullanım

X'te bir GIF'e ya da videoya **sağ tıkla** (normal menü için Shift + sağ tık):

| Medya | Seçenek | Ne olur |
|---|---|---|
| GIF | **GIF linkini kopyala** | `gif.fxtwitter.com/tweet_video/….gif` linki. Discord'a yapıştır, sadece GIF görünür. |
| GIF / video | **GIF'e çevir → linki kopyala** | Tarayıcıda GIF yapar, Discord'a yükler, linki kopyalar. |
| GIF / video | **MP4 linkini kopyala** | Video olarak gider. **Denendi, çalışıyor.** |
| Hepsi | **FixupX linkini kopyala** | Tweet'in tamamı embed olur. **Denendi, çalışıyor.** |

Paylaş menüsünde de "Direkt medya / GIF yap…" var. X'in kendi
**Bağlantıyı kopyala** seçeneği de `fixupx.com` linki kopyalar.

### "GIF'e çevir" için bir kerelik ayar: webhook

Başka sitelere yüklenen GIF'leri Discord açmadı (catbox'ta
`Invalid resource` hatası). Discord'un kesin açtığı yer kendi sunucusu. Bu
yüzden GIF, senin sunucundaki bir webhook ile Discord'a yüklenir ve linki
kopyalanır:

1. Kendine boş, özel bir Discord sunucusu aç (ya da var olanda gizli bir kanal).
2. Kanal ayarları → **Entegrasyonlar** → **Webhook'lar** → **Yeni Webhook** →
   **Webhook URL'sini Kopyala**.
3. İlk kez "GIF'e çevir"e bastığında script bu linki sorar, yapıştır. Bir
   daha sormaz. Değiştirmek için: Violentmonkey simgesi → "Discord webhook ayarla".

Notlar:
- O kanaldaki mesajları **silme**. Discord linkleri imzalı ve süreli.
  Discord içinde paylaşılan linkleri kendisi yeniler, ama mesaj silinirse
  link ölür.
- Webhook linki gizli kalmalı. Linki bilen herkes o kanala mesaj atabilir.

### GIF yapma nasıl çalışır

Dönüştürme için başka bir siteye gitmez, her şey tarayıcında olur: MP4 indirilir,
kare kare okunur (15 fps, en uzun kenar 480 px, ilk 15 sn), 255 renklik GIF'e
çevrilir. 10 MB'ı geçerse önce fps, sonra boyut düşürülüp tekrar denenir.
Ayarlar script'in başındaki `CONFIG` bölümünde.

## Bilmen gerekenler

- **GIF linki** FxTwitter'ın kaynak koduna göre yazıldı
  (`packages/atmosphere/src/helpers/media.ts`: `.mp4` yerine `.gif`, host
  `gif.fxtwitter.com`). Discord'da canlı denenmedi. FxEmbed'de şu an açık
  "GIF'ler Discord'da görünmüyor" hata kayıtları var (#2456, #2465).
  Çalışmazsa aynı menüdeki "GIF'e çevir"i kullan.
- Resimlerde sağ tık menüsü açılmaz, tarayıcının normal menüsü çıkar.
- GIF formatı en fazla 256 renk gösterir. Renk geçişli videolarda bantlanma
  olur.
- X'in sayfa yapısı değişirse sağ tık menüsü açılmayabilir. O zaman Paylaş
  menüsündeki seçeneği dene.

## Test

```sh
node test/encoder.test.js          # GIF kodlayıcı, sentetik karelerle
node test/browser.test.js          # Chromium'da sahte X sayfası (Playwright gerekir)
python3 test/check_gif.py          # Çıkan GIF'leri Pillow ile çözüp karşılaştırır
```

Testler gerçek X'e, FxTwitter'a ya da Discord'a bağlanmaz. X sayfası, API ve
webhook yanıtları sahte, video da tarayıcıda üretilmiş bir WebM. Gerçek X'te elle denenmesi
gerekiyor.

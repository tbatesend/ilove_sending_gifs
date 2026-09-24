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
   `video.twimg.com`, `catbox.moe` gibi adreslere istek izni sorabilir,
   "Always allow" de.

## Kullanım

X'te bir resme, videoya ya da GIF'e **sağ tıkla**. Tarayıcının menüsü yerine
bu menü açılır (normal menü lazımsa **Shift + sağ tık**):

| Medya | Seçenek | Discord'da ne olur |
|---|---|---|
| GIF / video | **GIF yap → yükle & linki kopyala** | Linki yapıştır, GIF olarak oynar. |
| GIF / video | **GIF yap → indir (.gif)** | Dosyayı Discord'a sürükle, GIF olarak oynar. |
| GIF | **FxTwitter GIF linkini kopyala** | Anında. Animasyonlu WebP linki. |
| GIF / video | **MP4 linkini kopyala** | Oynat tuşlu video olarak gösterir. |
| GIF / video | **MP4 indir** | Dosyayı sürükle, video olarak gider. |
| Resim | **Resim linkini kopyala / indir** | Orijinal boyut (`?name=orig`). |
| Hepsi | **FixupX linkini kopyala** | Tweet'in tamamı embed olur. |

Aynı menü tweet'in **Paylaş** menüsünde de var: "Direkt medya / GIF yap…".
X'in kendi **Bağlantıyı kopyala** seçeneği de artık `fixupx.com` linki kopyalar.

### GIF yapma nasıl çalışır

Hiçbir dönüştürme sitesine gitmez, her şey tarayıcında olur:

1. Tweet'in MP4'ü indirilir (GIF boyutuna yetecek en küçük kalite).
2. Video kare kare okunur (varsayılan 15 fps, en uzun kenar 480 px, ilk 15 sn).
3. 255 renklik ortak bir palet çıkarılır. Her karede yalnızca değişen
   pikseller kaydedilir, bu da dosyayı çok küçültür.
4. Sonuç **10 MB**'tan büyükse (Nitro'suz Discord'un yükleme sınırı) önce fps
   düşürülür (en az 10), sonra çözünürlük küçültülerek tekrar denenir.

Ayarlar script'in en üstündeki `CONFIG` bölümünde (`maxSide`, `fps`,
`maxSeconds`, `maxBytes`, `rightClickMenu`, `rewriteNativeCopyLink`).

## Bilmen gerekenler

- **"Yükle & linki kopyala" dosyayı [catbox.moe](https://catbox.moe)'ya
  yükler. Dosya herkese açık ve kalıcı olur, silemezsin.** Özel bir şey
  için "indir"i kullan.
- Discord'un nitro'suz yükleme sınırı 10 MB. Nitro'n varsa `maxBytes`
  değerini artırabilirsin.
- Uzun videolardan GIF yapmak mantıklı değil. 15 saniyeden sonrası kesilir,
  ve 10 MB'a sığdırmak için görüntü çok küçülür.
- GIF formatında en fazla 256 renk olur. Renk geçişli videolarda bantlanma
  görmen normal.
- **FxTwitter GIF linki** (`gif.fxtwitter.com/...webp`) animasyonlu WebP'dir.
  Discord 2025'ten beri animasyonlu WebP'yi destekliyor
  ([Discord blog](https://discord.com/blog/modern-image-formats-at-discord-supporting-webp-and-avif)).
  Ama bu linkin Discord'da gerçekten oynadığını **test edemedim**. Oynamazsa
  "GIF yap" seçeneklerini kullan.
- X'in sayfa yapısı (`data-testid`'ler) değişirse sağ tık menüsü açılmayabilir.
  O zaman Paylaş menüsündeki seçeneği dene, o daha az şeye bağlı.

## Test

```sh
node test/encoder.test.js          # GIF kodlayıcı, sentetik karelerle
node test/browser.test.js          # Chromium'da sahte X sayfası (Playwright gerekir)
python3 test/check_gif.py          # Çıkan GIF'leri Pillow ile çözüp karşılaştırır
```

Testler gerçek X'e ya da FxTwitter'a bağlanmaz. X sayfası ve API yanıtı
sahte, video da tarayıcıda üretilmiş bir WebM. Gerçek X'te elle denenmesi
gerekiyor.

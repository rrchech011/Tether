# Tether — Premiere Pro için After Effects tarzı takip (CEP paneli)

Premiere Pro'da bir nesneyi (yüz, kafa, top, çizgi film karakteri…) kare kare izleyip klibin Position / Scale / Rotation keyframelerine çevirir.

## Nasıl çalışır
1. Klip seç → **Kare al** → nesnenin üstüne **Takip bölgesi** (mavi) çiz. Turuncu **Arama bölgesi** kenarlarından ayarlanır.
2. **Takip et**. Yöntem *Otomatik*: önce nokta takibi (Lucas-Kanade piramidi, ileri-geri doğrulama); zayıfsa şablon eşleştirme (ZNCC) ile boşlukları doldurur.
3. Güven grafiğinde sarı/kırmızı karelere git, kutuyu nesneye çek, **Buradan ileri / geri takip**. Düzelttiğin kareler çapa olur, yeniden takip bir sonraki çapada durur.
4. Hedef klibi seç, modu seç, **Uygula**.

Önizleme ve "Kare al" görüntüsü yakınlaştırılabilir (+ / − düğmeleri, fare tekerleği; kaydırma: orta/sağ tuş ya da Boşluk+sürükle). Fare imleci gibi küçük nesneler için Yöntem > **İmleç / küçük nesne** (yerel çözünürlükte, arka plandan ayırarak izler).

## Kurulum
Windows: `kur.bat`, Mac: `kur.command` dosyasını çalıştır. Premiere'i yeniden aç: Window > Extensions > Tether.

**ffmpeg** (yalnızca videodan kare okumak için) kurulum sırasında yoksa otomatik indirilir (tek seferlik, yaklaşık 170 MB, internet gerekir). İndirme başarısız olursa `ffmpeg.exe` dosyasını `%APPDATA%\Adobe\CEP\Tether_ffmpeg` klasörüne (Mac: `~/Library/Application Support/Adobe/CEP/Tether_ffmpeg`) elle koyabilirsin; sistem PATH'inde ffmpeg varsa o da kullanılır. ffmpeg bu depoyla dağıtılmaz; ayrı bir projedir (ffmpeg.org).

## Bilinen sınırlar
Çok hızlı / kapanan küçük nesneler (ör. bacağa değen top) kayabilir; sahne kesmesinde elle düzeltme gerekir. İki noktalı / perspektif / düzlem takibi yok.

## Geliştirme notları
Takip kodu: `Tether/js/track.js` (tarayıcıdan ve Node'dan çalışır). Test: ffmpeg ile kare okuyup `trackRegion` çağır.

## Güvenlik ve izinler
- Premiere imzasız (unsigned) paneller için **PlayerDebugMode** ister. `kur.bat` / `kur.command` bunu kullanıcı hesabında açar (Windows: `HKCU\Software\Adobe\CSXS.*`, Mac: `defaults write com.adobe.CSXS.*`). Geri almak için `sil.bat` veya bu anahtarı elle silmek yeterli.
- Panel, seçtiğin klibin medya dosyasını yalnızca yerel ffmpeg ile okur; internete veri göndermez. İnternet yalnızca kurulumda ffmpeg indirmek için kullanılır.
- Kurulum betiklerini çalıştırmadan önce okuyabilirsin: kısa ve düz metin.

## Lisans
Depodaki `LICENSE` dosyasına bak.

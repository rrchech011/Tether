#!/bin/bash
# Tether - macOS kurulum
for v in 9 10 11 12 13 14 15; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
BASE="$HOME/Library/Application Support/Adobe/CEP/extensions"
KEEP="$HOME/Library/Application Support/Adobe/CEP/Tether_ffmpeg"
if [ -f "$BASE/Tether/ffmpeg" ]; then mkdir -p "$KEEP"; cp -f "$BASE/Tether/ffmpeg" "$KEEP/ffmpeg"; fi
# ffmpeg yoksa otomatik indir (tek seferlik); olmazsa Homebrew dene
if [ ! -x "$KEEP/ffmpeg" ] && ! command -v ffmpeg >/dev/null 2>&1; then
  mkdir -p "$KEEP"; echo "ffmpeg indiriliyor (tek seferlik)..."
  TMPZ="$(mktemp -d)/ff.zip"
  if curl -fL --max-time 300 -o "$TMPZ" "https://evermeet.cx/ffmpeg/getrelease/zip" && unzip -o -q "$TMPZ" -d "$KEEP" && [ -f "$KEEP/ffmpeg" ]; then
    chmod +x "$KEEP/ffmpeg"; xattr -dr com.apple.quarantine "$KEEP" 2>/dev/null; echo "ffmpeg kuruldu."
  elif command -v brew >/dev/null 2>&1; then brew install ffmpeg
  else echo "UYARI: ffmpeg indirilemedi. Internete bagli oldugundan emin ol ve tekrar calistir ya da 'brew install ffmpeg' kur."; fi
fi
rm -rf "$BASE/MaskTakip" "$BASE/Tether"; mkdir -p "$BASE/Tether"
cp -R "$(cd "$(dirname "$0")" && pwd)/Tether/." "$BASE/Tether/"
echo "Bitti. Premiere'i kapatip ac, sonra Window > Extensions > Tether."
echo "ffmpeg otomatik kurulur ($KEEP). Basarisiz olursa ffmpeg dosyasini o klasore elle koyabilirsin."

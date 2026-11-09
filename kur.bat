@echo off
rem Tether kurulum: imzasiz panellere izin verir ve paneli kullanici klasorune kopyalar.
rem Eski "MaskTakip" paneli varsa kaldirir. Mevcut ffmpeg korunur.
for %%V in (9 10 11 12 13 14 15) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f
set "EXT=%APPDATA%\Adobe\CEP\extensions"
set "KEEP=%APPDATA%\Adobe\CEP\Tether_ffmpeg"
if exist "%EXT%\Tether\ffmpeg.exe" (
  if not exist "%KEEP%" mkdir "%KEEP%"
  copy /Y "%EXT%\Tether\ffmpeg.exe" "%KEEP%\ffmpeg.exe" >nul
)
rem ffmpeg yoksa (ne kalici klasorde ne de PATH'te) otomatik indir: tek seferlik, ~170 MB. Yalniz kare okumak icin kullanilir.
if exist "%KEEP%\ffmpeg.exe" set "HAVEFF=1"
where ffmpeg >nul 2>nul && set "HAVEFF=1"
if defined HAVEFF (
  echo.
  echo ffmpeg zaten kurulu, indirme atlandi.
) else (
  echo.
  echo ffmpeg bulunamadi, indiriliyor ^(tek seferlik, yaklasik 170 MB^)... lutfen bekle ^(ilerleme cubugu asagida gorunur^).
  if not exist "%KEEP%" mkdir "%KEEP%"
  if exist "%TEMP%\tether_ffmpeg.zip" del /f /q "%TEMP%\tether_ffmpeg.zip"
  where curl.exe >nul 2>nul && curl.exe -L --fail --progress-bar -o "%TEMP%\tether_ffmpeg.zip" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip" || del /f /q "%TEMP%\tether_ffmpeg.zip" 2>nul
  if not exist "%TEMP%\tether_ffmpeg.zip" ( echo Alternatif yontem deneniyor ^(ilerleme gosterilmez^)... & powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip' -OutFile $env:TEMP\tether_ffmpeg.zip" )
  if exist "%TEMP%\tether_ffmpeg.zip" ( echo Indirme tamam, dosyalar cikariliyor... & powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $z=Join-Path $env:TEMP 'tether_ffmpeg.zip'; $d=Join-Path $env:TEMP 'tether_ffmpeg'; if(Test-Path $d){Remove-Item $d -Recurse -Force}; Expand-Archive -LiteralPath $z -DestinationPath $d -Force; $e=Get-ChildItem $d -Recurse -Filter ffmpeg.exe | Select-Object -First 1; Copy-Item $e.FullName '%KEEP%\ffmpeg.exe' -Force; Remove-Item $z,$d -Recurse -Force" )
  if exist "%KEEP%\ffmpeg.exe" ( echo ffmpeg kuruldu. ) else ( echo UYARI: ffmpeg indirilemedi. Internete bagli oldugundan emin ol ve kur.bat'i tekrar calistir. )
)
if exist "%EXT%\MaskTakip" rmdir /S /Q "%EXT%\MaskTakip"
if exist "%EXT%\Tether" rmdir /S /Q "%EXT%\Tether"
xcopy /E /I /Y "%~dp0Tether" "%EXT%\Tether"
echo.
echo Bitti. Premiere'i kapatip ac, sonra Window ^> Extensions ^> Tether.
pause

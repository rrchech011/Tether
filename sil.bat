@echo off
rem Tether kaldirma (eski MaskTakip dahil)
if exist "%APPDATA%\Adobe\CEP\extensions\MaskTakip" rmdir /S /Q "%APPDATA%\Adobe\CEP\extensions\MaskTakip"
if exist "%APPDATA%\Adobe\CEP\extensions\Tether" rmdir /S /Q "%APPDATA%\Adobe\CEP\extensions\Tether"
echo Kaldirildi.
pause

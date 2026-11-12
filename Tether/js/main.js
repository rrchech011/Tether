(function () {
  var cs = window.__adobe_cep__;
  var fs, zlib, os, path;
  try { fs = require('fs'); zlib = require('zlib'); os = require('os'); path = require('path'); } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var st = { src: null, tgts: [], tracks: [], xml: null, backups: {}, last: null, undo: [], batch: 0, neutral: {}, written: {}, declined: {} };
  var CHUNK = 200;
  var SAVE_IDS = ['mode', 'fit', 'step', 'smooth', 'tol', 'despike', 'pinX', 'pinY', 'zoom', 'zoomMax', 'zoomMode', 'sizeTrack', 'sizeStr', 'autoZoom', 'dz', 'offX', 'offY', 'ref', 'txtComp', 'plc', 'plcGap', 'scTrack', 'scStr', 'keepOld', 'applyTo', 'shutterAng', 'preset', 'rotTrack', 'ownModel'];

  function log(s) {
    var l = $('log'); l.textContent += s + '\n'; if (l.textContent.length > 40000) l.textContent = l.textContent.slice(-30000); l.scrollTop = l.scrollHeight;
    var t = $('status');
    if (t) {
      t.textContent = String(s).split('\n')[0];
      t.className = /^HATA|^Hata|yazılamadı|okunamadı/.test(s) ? 'err' : /^UYARI/.test(s) ? 'warn' : /tamam|bulundu|yazıldı|dönüldü|Bitti|Hazır|düzeltildi/.test(s) ? 'ok' : '';
    }
  }
  function mark(id, on) { var e = $(id); if (e && e.classList) e.classList.toggle('done', !!on); }
  function ev(script) { return new Promise(function (res) { cs.evalScript(script, res); }); }
  function evJson(script) {
    return ev(script).then(function (r) { try { return JSON.parse(r); } catch (e) { return { ok: false, err: 'Yanıt okunamadı: ' + r }; } });
  }
  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function sizeOf(c) { return c.nat ? c.nat[0] + '×' + c.nat[1] : '?'; }
  function num(id, def) { var v = parseFloat($(id).value); return isNaN(v) ? def : v; }
  function pct(id) { var v = parseFloat($(id).value); if (isNaN(v)) v = 50; return Math.min(100, Math.max(0, v)) / 100; }
  function posix(p) { return p.replace(/\\/g, '/'); }
  function outDir() { var d = path.join(os.homedir(), 'Desktop'); return fs.existsSync(d) ? d : os.homedir(); }
  function progress(f) { $('prog').firstChild.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; }
  var BTNS = ['bTgt', 'bGo', 'bUndo', 'bReset', 'bCsv', 'bDbg', 'bRaw', 'bProbe', 'bDiagCopy'];
  var isBusy = false;
  // Premiere keyframe'leri oynatma basligi oynamadan ekrana yansitmaz; yazimdan sonra monitoru yenile
  function refreshMonitor() { return ev('ppRefresh()').catch(function () {}); }
  function setInfo(id, html, cls) { var e = $(id); if (!e) return; e.innerHTML = html; e.className = 'info' + (cls ? ' ' + cls : ''); }
  function missing() {
    var m = [];
    if (!st.src) m.push('takip edilecek klip'); else if (!st.tracks.length) m.push('takip sonucu');
    if ($('mode').value !== 'follow' && !st.tgts.length) m.push('hedef klip');
    return m;
  }
  function updateReady() {
    var m = missing(), n = $('need'), go = $('bGo');
    if (n) { n.textContent = m.length ? 'Uygulamak için eksik: ' + m.join(' · ') : ''; n.style.display = m.length ? 'block' : 'none'; }
    if (go) { go.disabled = isBusy || m.length > 0; go.title = m.length ? 'Önce: ' + m.join(', ') : ''; }
  }
  function busy(on) {
    isBusy = on;
    BTNS.forEach(function (id) { $(id).disabled = on; });
    if (!on) progress(0);
    updateReady();
    if (!on && livePending) { livePending = false; setTimeout(runLive, 60); }
  }

  // --- Ayarları hatırla ---
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('tether_v1') || '{}');
      SAVE_IDS.forEach(function (id) {
        if (!(id in s)) return;
        if ($(id).type === 'checkbox') $(id).checked = !!s[id]; else $(id).value = s[id];
      });
    } catch (e) {}
  }
  function saveSettings() {
    try {
      var s = {};
      SAVE_IDS.forEach(function (id) { s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; });
      localStorage.setItem('tether_v1', JSON.stringify(s));
    } catch (e) {}
  }
  SAVE_IDS.forEach(function (id) {
    $(id).addEventListener('change', function () { saveSettings(); if (id !== 'mode' && id !== 'live') touch(); });
  });
  $('live').addEventListener('change', function () { if ($('live').checked) touch(); });
  ['srcW', 'srcH'].forEach(function (id) { $(id).addEventListener('change', touch); });
  var DEFAULTS = {};   // HTML'deki ilk degerler (kayitli ayarlar yuklenmeden once)
  SAVE_IDS.forEach(function (id) { DEFAULTS[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; });
  function fireEv(el, type) { var ev = document.createEvent('Event'); ev.initEvent(type, true, true); el.dispatchEvent(ev); }
  function resetSettings() {
    try { localStorage.removeItem('tether_v1'); } catch (e) {}
    SAVE_IDS.forEach(function (id) {
      var el = $(id); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!DEFAULTS[id]; else el.value = DEFAULTS[id];
    });
    SAVE_IDS.forEach(function (id) { var el = $(id); fireEv(el, 'input'); fireEv(el, 'change'); });
    $('srcW').value = st.src && st.src.nat ? st.src.nat[0] : ($('srcW').value); $('srcH').value = st.src && st.src.nat ? st.src.nat[1] : ($('srcH').value);
    saveSettings(); touch();
    log('Ayarlar varsayılana döndürüldü.');
  }
  var bRs = $('bResetSettings'); if (bRs) bRs.addEventListener('click', function () { if (window.confirm('Tüm Tether ayarları varsayılana dönsün mü?')) resetSettings(); });
  loadSettings();

  // Kaynak klibin etkin boyutu (Motion'un Scale'inin referans aldığı boyut)
  function effectiveSrcSize() {
    var w = Number($('srcW').value) || st.src.seqW, h = Number($('srcH').value) || st.src.seqH;
    if ($('fit').checked) { var f = Math.min(st.src.seqW / w, st.src.seqH / h); w *= f; h *= f; }
    return [w, h];
  }

  // Tether bir klibe animasyon yazdiktan sonra klip yeniden secilirse, getValue() ilk keyframe'i verir (asil deger degil).
  // Yedegimiz varsa asil taban degerleri oradan alinir; boylece tekrar uygulama / sifirlama kaymaz.
  function restoreBase(c) {
    var b = st.backups[c.nodeId];
    if (!b || !c.posAnimated) return false;
    c.pos = b.info.pos; c.scale = b.info.scale;
    c.posPx = Math.abs(c.pos[0]) > 10 || Math.abs(c.pos[1]) > 10;
    c.posAnimated = false; c.scaleAnimated = false;
    return true;
  }

  /* ===================== v1.9: analiz durumu, asamalar, hatalar, diagnostics ===================== */
  var PLUGIN_VERSION = '2.16.1';
  var TPS_ = (window.MaskParser && MaskParser.TPS) || 254016000000;

  function qualityCell(track) {
    if (!track || !window.MaskParser || !MaskParser.quality) return null;
    var q = MaskParser.quality(track.points), lbl = q.level === 'good' ? 'İyi' : q.level === 'warn' ? 'Uyarı' : 'Sorun';
    return { level: q.level, text: lbl + (q.issues.length ? ' — ' + q.issues.join(', ') : ''), raw: q };
  }
  function renderDiag() {
    var dl = $('diagGrid'); if (!dl) return; dl.innerHTML = '';
    var ffp = null; try { ffp = ownFf(); } catch (e) {}
    var rows = [['Eklenti sürümü', PLUGIN_VERSION], ['ffmpeg', ffp ? 'bulundu' : 'bulunamadı'], ['Takip modülü', window.TetherTrack ? 'yüklü' : 'yüklenemedi'], ['Hedef klip sayısı', String((st.tgts || []).length)], ['Takip noktası', st.tracks && st.tracks[0] ? String(st.tracks[0].points.length) : '—']];
    rows.forEach(function (r) { var x = document.createElement('dt'), y = document.createElement('dd'); x.textContent = r[0]; y.textContent = r[1]; dl.appendChild(x); dl.appendChild(y); });
    st.diagRows = rows;
  }


  // ===== Kendi takibim (beta): ffmpeg + Tether Tracker =====
  var OWN = window.TetherTrack, osm = null, pth = null;
  try { osm = require('os'); pth = require('path'); } catch (eo) {}
  var own = { info: null, rect: null, tRef: 0, ff: undefined, imgW: 0, imgH: 0, img: null };
  function ownMsg(t, lvl) { var m = $('ownMsg'); m.textContent = t; m.style.color = lvl === 'err' ? 'var(--er)' : (lvl === 'ok' ? 'var(--ok)' : (lvl === 'warn' ? 'var(--wn)' : '')); }
  function extDir() {
    try { var u = cs.getSystemPath('extension'); u = decodeURI(String(u)).replace(/^file:\/\/\//, ''); if (/^[A-Za-z]:/.test(u)) return u; return '/' + u; } catch (e) {}
    try { return __dirname; } catch (e2) { return null; }
  }
  function ownFf() { if (!OWN) return null; if (own.ff === undefined) own.ff = OWN.findFfmpeg(extDir()); return own.ff; }
  var FF_HELP = 'ffmpeg bulunamadı. kur.bat (Mac: kur.command) dosyasını internete bağlıyken tekrar çalıştır, ffmpeg otomatik indirilir. Olmazsa ffmpeg.exe dosyasını CEP\\Tether_ffmpeg klasörüne koy ya da sistem PATH\'ine ekle. Sonra Premiere\'i kapatıp aç.';
  // Arama bolgesi (dis kutu): takip bolgesinin her kenarindan pad kadar disari. Elle degistirilmediyse varsayilan + "Dar/Normal/Genis" carpani
  function ownPad() {
    var r = own.rect; if (!r) return [0, 0]; if (own.padUser) return own.padUser;
    var a = (own.imgH && own.imgW) ? own.imgH / own.imgW : 0.5625, mul = Number($('ownSearch').value) || 1, m = Math.max(r[2], r[3] * a);
    // v2.14: Normal'de (carpan 1) buyuk kutularda arama bolgesi daha yavas buyur (esik m0 = 0.12/0.9 ve altinda eski formulle ayni). Dar / Genis eski formulle aynen kalir.
    var R = Math.min(0.147, 0.12 + 0.25 * Math.max(0, m - 0.12 / 0.9)) * mul;   // v2.16: Dar/Genis da ayni yavas egriyi carpar (Dar her zaman <= Normal), Normal ust siniri 0.147 = Video 1 kutusundaki mevcut deger (0.1466); V1 arama bolgesi AYNEN kalir, daha buyuk kutularda artik buyumez
    return [R, R / a];
  }
  function ownOuter() { var r = own.rect, p = ownPad(); return [r[0] - p[0], r[1] - p[1], r[2] + 2 * p[0], r[3] + 2 * p[1]]; }
  function ownSearchR() { var p = ownPad(), W = own.W || 640; return p[0] * W; }
  function ownSearchRy() { var p = ownPad(), W = own.W || 640, H = own.H || (W * (own.imgH / own.imgW)); return p[1] * H; }
  function drawOwn() {
    var cv = $('ownCv'), g = cv.getContext('2d'), bg = own.bg || own.img; if (!bg) return;
    g.clearRect(0, 0, cv.width, cv.height); g.drawImage(bg, 0, 0, cv.width, cv.height);
    var sc = own.W ? cv.width / own.W : 1;
    if (own.res && own.frames) {          // izleme izi + o karedeki poligon
      var fr = own.res.frames, i0 = own.scrub, k, f;
      g.lineWidth = 2; var prev = null;
      for (k = 0; k < fr.length; k++) {        // yol: guclu = yesil, zayif = sari; kopuk yerler cizilmez
        f = fr[k]; if (!f) { prev = null; continue; }
        if (prev) { g.strokeStyle = (f.conf < WEAK || prev.conf < WEAK) ? 'rgba(255,196,0,.95)' : 'rgba(80,220,140,.85)'; g.beginPath(); g.moveTo(prev.cx * sc, prev.cy * sc); g.lineTo(f.cx * sc, f.cy * sc); g.stroke(); }
        prev = f;
      }
      f = fr[i0];
      if (f) {
        var okc = f.conf >= WEAK; g.strokeStyle = okc ? '#3ddc84' : '#ffc400'; g.lineWidth = 2.5; g.beginPath(); f.poly.forEach(function (p, j) { j ? g.lineTo(p[0] * sc, p[1] * sc) : g.moveTo(p[0] * sc, p[1] * sc); }); g.closePath(); g.stroke();
      }
      else { g.fillStyle = 'rgba(255,60,60,.9)'; g.font = 'bold 13px sans-serif'; g.fillText(T('bu karede takip yok (kayıp / kapalı)'), 10, 20); }
    }
    if (own.rect) {                         // dis kutu: arama bolgesi
      var o = ownOuter(), cw = cv.width, ch = cv.height;
      g.save(); g.setLineDash([7, 4]); g.lineWidth = 2; g.strokeStyle = '#ffb02e'; g.fillStyle = 'rgba(255,176,46,.07)';
      g.fillRect(o[0] * cw, o[1] * ch, o[2] * cw, o[3] * ch); g.strokeRect(o[0] * cw, o[1] * ch, o[2] * cw, o[3] * ch); g.restore();
      g.fillStyle = '#ffb02e'; var ox = [o[0], o[0] + o[2] / 2, o[0] + o[2]], oy = [o[1], o[1] + o[3] / 2, o[1] + o[3]];
      for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) { if (a === 1 && b === 1) continue; g.fillRect(ox[a] * cw - 3, oy[b] * ch - 3, 7, 7); }
      g.font = 'bold 11px sans-serif'; g.fillStyle = '#ffb02e'; g.fillText(T('Arama bölgesi'), Math.max(4, o[0] * cw + 4), Math.max(12, o[1] * ch - 4));
      g.fillStyle = '#5aa9ff'; g.fillText(T('Takip bölgesi'), own.rect[0] * cw + 4, own.rect[1] * ch + 13);
    }
    if (own.rect) { var r = own.rect; g.lineWidth = 2; g.strokeStyle = '#2d8ceb'; g.fillStyle = 'rgba(45,140,235,.12)'; g.fillRect(r[0] * cv.width, r[1] * cv.height, r[2] * cv.width, r[3] * cv.height); g.strokeRect(r[0] * cv.width, r[1] * cv.height, r[2] * cv.width, r[3] * cv.height);
      g.fillStyle = '#fff'; var hx = [r[0], r[0] + r[2] / 2, r[0] + r[2]], hy = [r[1], r[1] + r[3] / 2, r[1] + r[3]];
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) { if (i === 1 && j === 1) continue; g.fillRect(hx[i] * cv.width - 3, hy[j] * cv.height - 3, 6, 6); } }
  }
  // ---- Kare al goruntusunu yakinlastir / uzaklastir: nesne kucukse (fare imleci) kutuyu tam oturtmak icin ----
  var ownZ = { z: 1, space: false }, OZMIN = 0.4, OZMAX = 14, ownPan = null;
  function ownZoomApply() {
    var cv = $('ownCv'), wrap = $('ownWrap'); if (!own.imgW) return;
    var bw = Math.round(520 * Math.max(1, Math.min(4, ownZ.z)));                // cizim cozunurlugu yakinlastikca artar (en cok 4x)
    cv.width = bw; cv.height = Math.round(bw * own.imgH / own.imgW);
    var avail = Math.max(120, (wrap.parentNode.clientWidth || 520) - 4), fit = Math.min(520, avail, 0.48 * window.innerHeight * own.imgW / own.imgH);
    cv.style.maxWidth = 'none'; cv.style.maxHeight = 'none'; cv.style.width = Math.round(fit * ownZ.z) + 'px'; cv.style.height = 'auto';
    $('ozFit').textContent = Math.round(ownZ.z * 100) + '%';
    drawOwn();
  }
  function ownZoomAt(f, cx, cy) {                       // (cx,cy): ekran px; o noktanin altindaki goruntu noktasi sabit kalir
    var cv = $('ownCv'), wrap = $('ownWrap'), r = cv.getBoundingClientRect(); if (!r.width) return;
    var u = (cx - r.left) / r.width, v = (cy - r.top) / r.height;
    ownZ.z = Math.max(OZMIN, Math.min(OZMAX, ownZ.z * f)); ownZoomApply();
    var r2 = cv.getBoundingClientRect(); wrap.scrollLeft += (r2.left + u * r2.width) - cx; wrap.scrollTop += (r2.top + v * r2.height) - cy;
  }
  function ownZoomCenter(f) { var r = $('ownWrap').getBoundingClientRect(); ownZoomAt(f, r.left + r.width / 2, r.top + Math.min(r.height, 200) / 2); }
  $('ozIn').onclick = function () { ownZoomCenter(1.5); };
  $('ozOut').onclick = function () { ownZoomCenter(1 / 1.5); };
  $('ozFit').onclick = function () { ownZ.z = 1; ownZoomApply(); $('ownWrap').scrollLeft = 0; $('ownWrap').scrollTop = 0; };
  $('ownCv').addEventListener('wheel', function (e) { e.preventDefault(); ownZoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  $('ownCv').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  $('ownCv').addEventListener('mousedown', function (e) {
    if (!(e.button === 1 || e.button === 2 || (e.button === 0 && ownZ.space))) return;
    var w = $('ownWrap'); ownPan = { x: e.clientX, y: e.clientY, sl: w.scrollLeft, st: w.scrollTop }; e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) { if (!ownPan) return; var w = $('ownWrap'); w.scrollLeft = ownPan.sl - (e.clientX - ownPan.x); w.scrollTop = ownPan.st - (e.clientY - ownPan.y); });
  window.addEventListener('mouseup', function () { ownPan = null; });
  function ownTyping(e) { var t = e.target && e.target.tagName; return t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA'; }
  window.addEventListener('keydown', function (e) { if (e.key === ' ' && !ownTyping(e) && !$('ownBox').classList.contains('hidden') && !ownZ.space) { ownZ.space = true; $('ownCv').style.cursor = 'grab'; e.preventDefault(); } });
  window.addEventListener('keyup', function (e) { if (e.key === ' ' && ownZ.space) { ownZ.space = false; $('ownCv').style.cursor = 'crosshair'; } });
  window.addEventListener('resize', function () { if (!$('ownBox').classList.contains('hidden')) ownZoomApply(); });
  window.__tetherDbg = { own: own, drawOwn: drawOwn };
  (function () {
    var cv = $('ownCv'), drag = null, CUR = { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    function pos(e) { var b = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; }
    function size() { var b = cv.getBoundingClientRect(); return [b.width, b.height]; }
    cv.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || ownZ.space) return;                                 // orta / sag tus ve Bosluk+surukle kaydirma icin ayrildi
      var p = pos(e), sz = size(), hit = OWN.rectHit(own.rect, p[0], p[1], sz[0], sz[1]), oh = (!hit && own.rect) ? OWN.rectHit(ownOuter(), p[0], p[1], sz[0], sz[1]) : null;
      if (hit) drag = { mode: hit, p0: p, r0: own.rect.slice() };               // var olan kutuyu tasi / boyutlandir
      else if (oh && oh !== 'move') drag = { mode: 'outer', edge: oh, p0: p, r0: own.rect.slice() };   // arama bolgesini boyutlandir
      else drag = { mode: 'new', p0: p, r0: own.rect ? own.rect.slice() : null, replaced: false };
      e.preventDefault();
    });
    cv.addEventListener('mousemove', function (e) {
      if (drag) return;
      var p = pos(e), sz = size(), hit = OWN.rectHit(own.rect, p[0], p[1], sz[0], sz[1]), oh = (!hit && own.rect) ? OWN.rectHit(ownOuter(), p[0], p[1], sz[0], sz[1]) : null;
      cv.style.cursor = hit ? CUR[hit] : ((oh && oh !== 'move') ? CUR[oh] : 'crosshair');
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var p = pos(e), sz = size(), dx = p[0] - drag.p0[0], dy = p[1] - drag.p0[1], minW = 14 / sz[0], minH = 14 / sz[1];
      if (drag.mode === 'outer') {
        var r0 = drag.r0, cp = ownPad(), px = cp[0], py = cp[1], ed = drag.edge;
        if (ed.indexOf('e') >= 0) px = p[0] - (r0[0] + r0[2]); else if (ed.indexOf('w') >= 0) px = r0[0] - p[0];
        if (ed.indexOf('s') >= 0) py = p[1] - (r0[1] + r0[3]); else if (ed.indexOf('n') >= 0) py = r0[1] - p[1];
        own.padUser = [Math.max(0.01, px), Math.max(0.01, py)];
      } else if (drag.mode === 'new') {
        if (Math.abs(dx) * sz[0] < 6 && Math.abs(dy) * sz[1] < 6 && !drag.replaced) return;   // tek tik mevcut kutuyu silmesin
        drag.replaced = true; own.padUser = null; own.rect = [Math.min(drag.p0[0], p[0]), Math.min(drag.p0[1], p[1]), Math.abs(dx), Math.abs(dy)];
      } else own.rect = OWN.rectApply(drag.r0, drag.mode, dx, dy, minW, minH);
      drawOwn();
    });
    window.addEventListener('mouseup', function () {
      if (!drag) return; var d = drag; drag = null;
      var r = own.rect, sz = size();
      if (d.mode === 'outer') { drawOwn(); return; }
      if (d.mode === 'new' && r && (r[2] * sz[0] < 14 || r[3] * sz[1] < 14)) { own.rect = d.r0; drawOwn(); if (!d.r0) { ownMsg('Dikdörtgen çok küçük; nesnenin üstüne daha büyük çiz.', 'err'); $('bOwnRun').disabled = true; } return; }
      if (!r) return;
      $('bOwnRun').disabled = false; setRunWhy(false);
      var srcMax = Math.max(r[2] * (own.imgW || 1), r[3] * (own.imgH || 1));
      if ($('ownMethod').value === 'auto' && own.imgW && srcMax < 0.07 * own.imgW) ownMsg('Bölge hazır. Nesne küçük görünüyor (~' + Math.round(srcMax) + ' px). Fare imleci gibi küçük bir şeyse "Otomatik" yöntem gerekirse "İmleç / küçük nesne"ye kendisi geçer; sonra "Takip et".', 'ok');
      else ownMsg('Bölge hazır. Kutuyu tutup taşıyabilir, kenar/köşelerinden boyutlandırabilirsin; sonra "Takip et".', 'ok');
    });
  })();
  $('bOwnFrame').onclick = async function () {
    if (!OWN) return ownMsg('Takip modülü yüklenemedi.', 'err');
    busy(true);
    try {
      var inf = await evJson('ppOwnInfo()');
      if (!inf.ok) return ownMsg('HATA: ' + inf.err, 'err');
      if (!inf.mediaPath) return ownMsg('Bu klip bir medya dosyasından değil (nest, grafik vb.). Şimdilik yalnız video dosyası olan klipler destekleniyor.', 'err');
      var ff = ownFf(); if (!ff) return ownMsg(FF_HELP, 'err');
      var fr = Number(inf.frameTicks) > 0 ? Number(inf.frameTicks) / TPS_ : 1 / 30;
      var tRef = Math.min(Math.max(inf.inSec + (inf.playSec - inf.startSec), inf.inSec), inf.outSec - fr);
      own.info = inf; own.tRef = tRef; own.rect = null; $('bOwnRun').disabled = true; setRunWhy(true);
      var png = pth.join(osm.tmpdir(), 'tether_ownframe.png');
      try { fs.unlinkSync(png); } catch (e0) {}
      ownMsg('Kare alınıyor…');
      OWN.readOneFramePng(ff, inf.mediaPath, tRef, png, function (err) {
        if (err) return ownMsg('HATA: ' + err, 'err');
        var img = new Image();
        img.onload = function () {
          own.img = img; own.imgW = img.width; own.imgH = img.height; own.bg = null; own.res = null; own.frames = null; own.verify = null; own.pair = null; $('ownReview').classList.add('hidden'); own.prevRun = null; ownRestoreUI();
          $('ownBox').classList.remove('hidden'); ownZ.z = 1; ownZoomApply();
          ownMsg('Nesnenin üstüne fareyle dikdörtgen çiz (köşeleri/dokuyu içersin). Çizdikten sonra kutuyu taşıyıp boyutlandırabilirsin.');
        };
        img.onerror = function () { ownMsg('Kare görüntüsü yüklenemedi.', 'err'); };
        img.src = 'data:image/png;base64,' + fs.readFileSync(png).toString('base64');
      });
    } finally { busy(false); }
  };
  function gray2canvas(i) {
    var fr = own.frames[i], c = document.createElement('canvas'); c.width = own.W; c.height = own.H;
    var g = c.getContext('2d'), id = g.createImageData(own.W, own.H), d = id.data;
    for (var k = 0; k < fr.length; k++) { var v = fr[k]; d[4 * k] = v; d[4 * k + 1] = v; d[4 * k + 2] = v; d[4 * k + 3] = 255; }
    g.putImageData(id, 0, 0); return c;
  }
  function polyBox2(poly) { var xs = poly.map(function (p) { return p[0]; }), ys = poly.map(function (p) { return p[1]; }); return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)]; }
  function polyArea(poly) { var a = 0, n = poly.length; for (var i = 0; i < n; i++) { var j = (i + 1) % n; a += poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1]; } return Math.abs(a) / 2; }
  // Guven grafigi: yesil guclu, sari zayif (<0.6), kirmizi takipsiz
  var WEAK = 0.6;
  function badFrame(i) { var f = own.res && own.res.frames[i]; return !f || f.conf < WEAK; }
  function drawConf(cur) {
    var cv = $('ownConf'), fr = own.res && own.res.frames; if (!cv || !fr) return;
    var g = cv.getContext('2d'), n = fr.length, W = cv.width, H = cv.height, i;
    g.clearRect(0, 0, W, H);
    for (i = 0; i < n; i++) {
      var f = fr[i], x = Math.floor(i * W / n), w = Math.max(1, Math.ceil(W / n));
      g.fillStyle = !f ? '#c33' : (f.conf < WEAK ? '#d9a21b' : '#3a9d4a'); g.fillRect(x, 0, w, H);
    }
    if (own.anchors) for (var ak in own.anchors) { g.fillStyle = '#7dd3fc'; g.fillRect(Math.floor(ak * W / n), 0, 2, H); }
    g.fillStyle = '#fff'; g.fillRect(Math.floor(cur * W / n), 0, 2, H);
    drawSusp(cur);
  }
  // v2.14: hedef dogrulama seridi (YALNIZ GOSTERIM). Guven cubugunun anlamini degistirmez; own.verify.episodes'u okur. Turuncu = "Kontrol et", kirmizi = "Yuksek suphe". Deneysel, kesin kanit degil.
  function drawSusp(cur) {
    var cv = $('ownSusp'), lg = $('ownSuspLegend'), fr = own.res && own.res.frames; if (!cv || !fr) return;
    var g = cv.getContext('2d'), n = fr.length, W = cv.width, H = cv.height, eps = (own.verify && own.verify.episodes) || [], k, i;
    g.clearRect(0, 0, W, H);
    var lvl = new Array(n);
    for (k = 0; k < eps.length; k++) for (i = Math.max(0, eps[k].from); i <= Math.min(n - 1, eps[k].to); i++) lvl[i] = (eps[k].level === 'yuksek' || lvl[i] === 2) ? 2 : 1;
    for (i = 0; i < n; i++) if (lvl[i]) { var x = Math.floor(i * W / n), w = Math.max(1, Math.ceil(W / n)); g.fillStyle = lvl[i] === 2 ? '#e11d48' : '#f97316'; g.fillRect(x, 0, w, H); }
    g.fillStyle = '#fff'; g.fillRect(Math.floor(cur * W / n), 0, 2, H);
    if (lg) lg.textContent = eps.length ? 'Hedef doğrulama (deneysel): turuncu = Kontrol et, kırmızı = Yüksek şüphe. Üstteki yeşil yalnızca takip sonucu üretildiğini gösterir; hedefin doğru olduğunu doğrulamaz.' : 'Hedef doğrulama: şüpheli aralık bulunmadı. Bu, hedefin doğru takip edildiğinin kanıtı değildir; yeşil yalnızca takip sonucu üretildiğini gösterir.';
  }
  function gotoBad(dir) {
    var n = own.frames ? own.frames.length : 0, i = own.scrub + dir;
    for (; i >= 0 && i < n; i += dir) if (badFrame(i)) { var sl = $('ownScrub'); sl.value = i; showScrub(i); return; }
    ownMsg('Bu yönde zayıf kare yok.');
  }
  // v2.15: ilk takip <-> alternatif / otomatik duzeltilmis takip. Ikisi de gercek takip ciktisi; degistirince sonuc yeniden olusturulur (Uygula'dan once).
  function ownAltLabel() { var pr = own.pair; if (!pr) return ''; return pr.showing === 'first' ? (pr.kind === 'auto' ? 'Düzeltilmiş takibi göster' : 'Alternatif takibi göster') : 'İlk (ham) takibi göster'; }
  $('bOwnAlt') && ($('bOwnAlt').onclick = async function () {
    var pr = own.pair; if (!pr || own.running) return; ownBusyUI(true);
    try {
      pr.showing = pr.showing === 'first' ? 'other' : 'first'; own.res = pr.showing === 'first' ? pr.first : pr.other; own.anchors = {};
      var mm = pr.showing === 'first' ? pr.mFirst : pr.mOther; own.method = mm.method; own.crop = mm.crop;   // "Buradan ileri / geri" gosterilen sonucu ureten yontemle calissin
      await ownFinalize(own.res, 0, pr.showing === 'first' ? ' (ilk takip gösteriliyor)' : (pr.kind === 'auto' ? ' (otomatik düzeltilmiş takip gösteriliyor)' : ' (alternatif takip gösteriliyor: "' + pr.name + '")'));
      showScrub(Number($('ownScrub').value) || 0);
    } catch (e) { ownMsg('HATA: ' + e, 'err'); } finally { ownBusyUI(false); }
  });
  // v2.16.1: "Önceki takibe dön". Tam takip tekrar çalıştırılınca önceki sonuç saklanır; düğme ikisi arasında geçiş yapar.
  function ownSnap() { return { res: own.res, frames: own.frames, W: own.W, H: own.H, fps: own.fps, nativeFps: own.nativeFps, rect: own.rect ? own.rect.slice() : null, method: own.method, crop: own.crop, cutsIdx: own.cutsIdx, scrub: own.scrub, verRef: own.verRef }; }
  function ownRestoreUI() {
    var b = $('bOwnRestore'); if (!b) return;
    var p = own.prevRun, show = !!(p && p.res && p.res !== own.res);
    b.classList.toggle('hidden', !show);
    if (show) b.textContent = own.prevShown ? '↷ Yeni takibe dön' : '↶ Önceki takibe dön';
  }
  $('bOwnRestore') && ($('bOwnRestore').onclick = async function () {
    var p = own.prevRun; if (!p || !p.res || own.running) return; ownBusyUI(true);
    try {
      var cur = ownSnap(); own.prevShown = !own.prevShown;
      own.res = p.res; own.frames = p.frames; own.W = p.W; own.H = p.H; own.fps = p.fps; own.nativeFps = p.nativeFps; own.rect = p.rect; own.method = p.method; own.crop = p.crop; own.cutsIdx = p.cutsIdx || []; own.verRef = p.verRef; own.pair = null; own.anchors = {};
      own.prevRun = cur;
      await ownFinalize(own.res, 0, own.prevShown ? ' (önceki takip geri getirildi)' : ' (yeni takip geri getirildi)');
      drawOwn(); var sl = $('ownScrub'); sl.max = own.frames.length - 1; sl.value = Math.min(own.frames.length - 1, Math.max(0, p.scrub || 0)); showScrub(Number(sl.value));
    } catch (e) { ownMsg('HATA: ' + e, 'err'); } finally { ownBusyUI(false); ownRestoreUI(); }
  });
  function stepScrub(d) { if (!own.frames) return; var sl = $('ownScrub'), i = Math.max(0, Math.min(own.frames.length - 1, Number(sl.value) + d)); sl.value = i; showScrub(i); return i; }
  var playT = null;
  function stopPlay() { if (playT) { clearInterval(playT); playT = null; } $('bOwnPlay').textContent = '▶'; }
  $('bOwnPrev').onclick = function () { stopPlay(); stepScrub(-1); };
  $('bOwnNext').onclick = function () { stopPlay(); stepScrub(1); };
  $('bOwnPlay').onclick = function () {
    if (playT) { stopPlay(); return; }
    if (!own.frames) return; $('bOwnPlay').textContent = '❚❚';
    playT = setInterval(function () { var cur = Number($('ownScrub').value); if (cur >= own.frames.length - 1) { stopPlay(); return; } stepScrub(1); }, Math.max(33, 1000 / (own.fps || 25)));
  };
  $('ownSearch').addEventListener('change', function () { own.padUser = null; drawOwn(); });
  $('bOwnPrevBad').onclick = function () { gotoBad(-1); };
  $('bOwnNextBad').onclick = function () { gotoBad(1); };
  $('ownSusp') && $('ownSusp').addEventListener('click', function (e) { if (!own.frames) return; var r = this.getBoundingClientRect(), i = Math.max(0, Math.min(own.frames.length - 1, Math.floor((e.clientX - r.left) / r.width * own.frames.length))); $('ownScrub').value = i; showScrub(i); });
  $('ownConf').addEventListener('click', function (e) { if (!own.frames) return; var r = this.getBoundingClientRect(), i = Math.max(0, Math.min(own.frames.length - 1, Math.floor((e.clientX - r.left) / r.width * own.frames.length))); $('ownScrub').value = i; showScrub(i); });
  function showScrub(i) {
    own.scrub = i; own.bg = gray2canvas(i);
    var f = own.res.frames[i];
    var sugg = false;
    if (f) { var bb = polyBox2(f.poly); own.rect = [Math.max(0, bb[0] / own.W), Math.max(0, bb[1] / own.H), Math.min(1, (bb[2] - bb[0]) / own.W), Math.min(1, (bb[3] - bb[1]) / own.H)]; }
    else {                                   // takipsiz kare: komsu izlenen kareler arasindan konum ONER (kutu oraya konur, sen sadece ince ayar yap)
      var pa = null, nb = null, q;
      for (q = i - 1; q >= 0 && !pa; q--) if (own.res.frames[q]) pa = own.res.frames[q];
      for (q = i + 1; q < own.res.frames.length && !nb; q++) if (own.res.frames[q]) nb = own.res.frames[q];
      var A = pa || nb, B = nb || pa;
      if (A) {
        var tt = (pa && nb) ? (i - pa.i) / Math.max(1, nb.i - pa.i) : 0, cx = A.cx + (B.cx - A.cx) * tt, cy = A.cy + (B.cy - A.cy) * tt, ba = polyBox2(A.poly), bw = (ba[2] - ba[0]), bh = (ba[3] - ba[1]);
        own.rect = [Math.max(0, (cx - bw / 2) / own.W), Math.max(0, (cy - bh / 2) / own.H), Math.min(1, bw / own.W), Math.min(1, bh / own.H)]; sugg = true;
      }
    }
    own.suggested = sugg;
    drawOwn();
    drawConf(i);
    $('ownScrubInfo').textContent = 'Kare ' + (i + 1) + '/' + own.frames.length + (f ? (f.conf < WEAK ? ' · zayıf (güven %' + Math.round(f.conf * 100) + ')' : ' · izleniyor') : ' · takip yok' + (sugg ? ' · kutu komşu karelerden ÖNERİLDİ, nesneye çekip düzelt' : ''));
  }
  function setRunWhy(on) { var w = $('runWhy'); if (w) w.classList.toggle('hidden', !on); }
  function ownBusyUI(on) { own.running = on; $('bOwnRun').textContent = on ? 'Durdur' : 'Takip et'; $('bOwnRun').classList.toggle('primary', !on); ['bOwnFrame', 'bOwnFwd', 'bOwnBwd'].forEach(function (id) { $(id).disabled = on; }); $('ownScrub').disabled = on; if ($('bOwnRestore')) $('bOwnRestore').disabled = on; if (!on) ownRestoreUI(); }
  // Sonucu Tether takip verisine cevir ve durum panelini guncelle
  // v2.14: hedef dogrulama uyari metni. Kare numaralari arayuzdeki gibi 1'den baslar. B DENEYSELDIR; hicbir ifade kesin hedef kaybi iddiasi degildir.
  function ownVerifyText(ver) {
    if (!ver || !ver.episodes || !ver.episodes.length) return '';
    function ranges(list) { var segs = list.map(function (e) { return [e.from, e.to]; }).sort(function (a, b) { return a[0] - b[0]; }), out = [], k; for (k = 0; k < segs.length; k++) { var l = out[out.length - 1]; if (l && segs[k][0] <= l[1] + 1) l[1] = Math.max(l[1], segs[k][1]); else out.push(segs[k].slice()); } return out.slice(0, 3).map(function (s) { return (s[0] + 1) + '–' + (s[1] + 1); }).join(', ') + (out.length > 3 ? ', …' : ''); }
    var all = ranges(ver.episodes), hi = ver.episodes.filter(function (e) { return e.level === 'yuksek'; }), A = ver.episodes.filter(function (e) { return e.signal === 'A'; }), B = ver.episodes.filter(function (e) { return e.signal === 'B'; });
    var t = 'Şüpheli aralık: ' + all + '.';
    if (hi.length) t += ' Yüksek şüphe (' + ranges(hi) + '): kutu ilk karedeki görünümden uzak ve görüntüde neredeyse hiç hareket etmiyor; hedef kaybedilmiş olabilir (deneysel).';
    if (A.length) t += ' Kontrol et (' + ranges(A) + '): kutunun içeriği ilk karedeki görünümden uzaklaştı; yüz dönmüş de olabilir, takip başka bir yere kaymış da.';
    if (B.length) t += ' Kontrol et (' + ranges(B) + '): kutu neredeyse hiç hareket etmiyor; hedef gerçekten duruyorsa sorun yok, değilse arka plana kilitlenmiş olabilir (deneysel).';
    return t + ' ';
  }
  async function ownFinalize(res, t0, note) {
    own.verify = null;   // eski dogrulama sonucu yeni takibe karismasin
    var inf = own.info, inT = inf.inSec * TPS_, ft = own.fps ? TPS_ / own.fps : Number(inf.frameTicks);   // v2.16: takip kare hizi (klip hizi olabilir)
    var pts = OWN.toPoints(res, function (i) { return Math.round(inT + i * ft); });
    if (pts.length < 2) { ownMsg('Takip başarısız: ' + (res.reasonFwd || res.reasonBwd || 'bölgede takip edilecek doku bulunamadı') + '. Daha dokulu bir bölge seç.', 'err'); return false; }
    var timing = { start: Number(inf.startTicks), end: Number(inf.endTicks), inP: inT, outP: inf.outSec * TPS_, ratio: 1 };
    var mapped = MaskParser.mapSourcePoints(timing, pts);
    var c = await evJson('ppGetSelection()'); if (!c.ok) { ownMsg('HATA: ' + c.err, 'err'); return false; }
    st.src = c; restoreBase(c);
    $('srcW').value = c.nat ? c.nat[0] : c.seqW; $('srcH').value = c.nat ? c.nat[1] : c.seqH;
    st.tracks = [{ clipStartSec: timing.start / TPS_, clipEndSec: timing.end / TPS_, points: mapped, kind: 'own', source: 'tether', unverified: false, file: inf.mediaPath, range: null }];
    mark('card1', true); refreshPreview(false); updateReady();
    var span = Math.round((pts[pts.length - 1].src - pts[0].src) / ft) + 1, holes = Math.max(0, span - pts.length);
    var weakN = res.frames.filter(function (f) { return f && f.conf < WEAK; }).length, weakTxt = weakN ? ' ' + weakN + ' kare zayıf güvenli (grafikte sarı).' : '';
    // v2.14: hedef dogrulama UYARISI (yalniz uyari; takip sonucu, keyframe'ler ve Uygula akisi degismez). Hata verirse sessizce atlanir.
    var ver = null; try { ver = (own.method !== 'small' && own.verRef && own.frames) ? await OWN.verifyTargetAsync(res, own.frames, own.W, own.H, own.verRef.idx, own.verRef.rect, { fps: own.fps, cuts: own.cutsIdx || [], anchors: own.anchors || {} }) : null; } catch (e) { log('Hedef doğrulama atlandı: ' + (e && e.message || e)); }
    var bAlt = $('bOwnAlt'); if (bAlt) { bAlt.classList.toggle('hidden', !own.pair); if (own.pair) bAlt.textContent = ownAltLabel(); }
    own.verify = ver; var vm = ownVerifyText(ver); try { drawConf(own.scrub || 0); } catch (e) {}
    var holeTxt = holes ? ' ' + holes + ' kare takipsiz (kapanma / kayıp); arası doğrusal geçilir. Kaydırıcıyla o kareye gidip kutuyu nesneye çek, "Buradan ileri" de.' : '';
    if (vm) ownMsg('⚠ ' + pts.length + ' kare işlendi' + (t0 ? ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' sn)' : '') + '; hedefin doğru takip edildiği doğrulanamadı. ' + vm + (note || '') + holeTxt + weakTxt + ' Bu bir uyarıdır, kesin hedef kaybı kanıtı değil; kareleri kontrol et. Yeşil yalnızca takip sonucu üretildiğini gösterir; "İzlendi" hedefin doğru olduğunu doğrulamaz. Çubuğun altındaki turuncu / kırmızı şerit şüpheli aralıkları gösterir.', 'warn');
    else ownMsg('✓ ' + pts.length + ' kare izlendi' + (t0 ? ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' sn)' : '') + '.' + (note || '') + holeTxt + weakTxt + ' Yeşil yalnızca takip sonucu üretildiğini gösterir; hedefin doğru olduğu doğrulanmadı. Kontrol edip Uygula\'ya geç.', 'ok');
    log('Kendi takibim: ' + pts.length + ' kare, konum + ölçek + dönme.' + (holes ? ' ' + holes + ' kare boş.' : ''));
    if (vm) log('UYARI: Hedef doğrulama (deneysel): ' + vm);
    var qc = qualityCell(st.tracks[0]); if (qc && qc.level !== 'good') log('UYARI: Takip kalitesi: ' + qc.text);
    ownRestoreUI();
    return true;
  }
  function ownProg(done, total) { ownMsg('Takip ediliyor… %' + Math.round(100 * done / Math.max(1, total)) + ' (' + done + '/' + total + ' kare)'); }
  // "Imlec / kucuk nesne" yontemi: kareler yerel cozunurlukte parca parca okunur (bellek uzunluktan bagimsiz); sonuc onizleme karelerinin (own.W x own.H) koordinatina indirilir
  async function ownSmallRun(inSec, n, refIdx, dir) {
    var inf = own.info, ff = ownFf(), pr = OWN.probe(ff, inf.mediaPath), srcW = pr ? pr.w : own.imgW, srcH = pr ? pr.h : own.imgH;
    var Wn = Math.min(srcW, 2560); Wn -= Wn % 2; var Hn = Math.round(Wn * srcH / srcW); Hn -= Hn % 2; var k = Wn / own.W;
    ownMsg('İmleç / küçük nesne: yerel çözünürlükte izleniyor (' + Wn + '×' + Hn + ')…');
    var rs = await OWN.trackSmall(ff, inf.mediaPath, { inSec: inSec, fps: own.fps, n: n, refIdx: refIdx, rect: own.rect, W: Wn, H: Hn, dir: dir, searchR: ownSearchR() * k, search: 1, onProgress: ownProg, cancel: function () { return own.cancel; }, sig: own.sig = {} });
    if (rs.setupError) { ownMsg('HATA: ' + rs.setupError, 'err'); log('Kendi takibim (küçük nesne): ' + rs.setupError); return null; }
    rs.frames = rs.frames.map(function (f) {
      if (!f) return null;
      return { i: f.i, poly: f.poly.map(function (p) { return [p[0] / k, p[1] / k]; }), cx: f.cx / k, cy: f.cy / k, scale: f.scale, rot: f.rot, conf: f.conf };
    });
    rs.w = own.W; rs.h = own.H;
    if (rs.stats) log('Küçük nesne takibi: maske ' + rs.stats.maskPx + ' px, arka plan benzerliği ' + rs.stats.decoy + ', eşikler ' + (rs.stats.thr || []).join('/') + ', kayıp ' + rs.stats.coasts + ', yeniden bulma ' + rs.stats.resumes + '.');
    return rs;
  }
  $('bOwnRun').onclick = async function () {
    if (own.running) { own.cancel = true; if (own.sig && own.sig.kill) own.sig.kill(); return; }
    var inf = own.info, ff = ownFf(); if (!inf || !own.rect || !ff) return;
    own.prevShown = false;
    if (own.res && own.frames) own.prevRun = ownSnap();   // v2.16.1: yeni takip bu sonucun yerine geçmeden önce saklanır ("Önceki takibe dön")
    own.cancel = false; ownBusyUI(true); own.pair = null; own.cutsIdx = [];
    var t0 = Date.now();
    try {
      var seqFps = TPS_ / Number(inf.frameTicks), dur = inf.outSec - inf.inSec;
      var pr = OWN.probe(ff, inf.mediaPath), asp = pr ? pr.h / pr.w : own.imgH / own.imgW;
      // v2.16: takip KLIBIN KENDI kare hizinda yapilir (ffmpeg'in dizi hizina kare cogaltmasi / atmasi hareketi duzensizlestiriyordu: 24 fps klip, 25/60 fps dizi). Dizi hizina esleme compute()'ta yapilir. Klip hizi okunamazsa dizi hizi (eski davranis).
      var fps = (pr && pr.fps && Math.abs(pr.fps - seqFps) > 0.02 * seqFps) ? pr.fps : seqFps; own.nativeFps = fps !== seqFps ? fps : 0;
      if (own.nativeFps) log('Takip klibin kendi kare hızında yapılıyor: ' + fps + ' fps (dizi ' + (Math.round(seqFps * 100) / 100) + ' fps); konumlar dizi karelerine eşlenecek.');
      var W = Number($('ownRes').value) || 640, nF = Math.round(dur * fps);
      while (nF * W * Math.round(W * asp) > 420e6 && W > 240) W = Math.floor(W * 0.85);
      W -= W % 2; var H = Math.round(W * asp); H -= H % 2;
      ownMsg('Kareler okunuyor… (' + nF + ' kare, ' + W + '×' + H + ')');
      var r = await new Promise(function (resolve, reject) {
        own.sig = {};
        OWN.readFrames(ff, inf.mediaPath, inf.inSec, dur, fps, W, H, function (err, rr) { err ? reject(err) : resolve(rr); }, function (n) { if (n % 20 === 0) ownMsg('Kareler okunuyor… ' + n + '/' + nF); }, own.sig);
      });
      if (own.cancel) { ownMsg('Durduruldu.'); return; }
      own.frames = r.frames; own.W = W; own.H = H; own.fps = fps;
      var refIdx = Math.min(r.frames.length - 1, Math.max(0, Math.round((own.tRef - inf.inSec) * fps)));
      async function runSmallMode() {   // imlec / kucuk nesne: baska yontemlere dokunmaz
        var rsm = await ownSmallRun(inf.inSec, r.frames.length, refIdx, $('ownDir').value);
        if (!rsm) return;
        own.method = 'small'; own.crop = undefined; own.res = rsm; own.scrub = refIdx; own.anchors = {};
        if (await ownFinalize(rsm, t0, (rsm.cancelled ? ' (durduruldu: o ana kadarki kısım)' : '') + ' (imleç / küçük nesne, yerel çözünürlük)')) {
          $('ownReview').classList.remove('hidden'); var sl2 = $('ownScrub'); sl2.max = r.frames.length - 1; sl2.value = refIdx; showScrub(refIdx);
        }
      }
      if ($('ownMethod').value === 'small') { await runSmallMode(); return; }
      var res = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), onProgress: ownProg, cancel: function () { return own.cancel; } });
      // v2.16: sahne kesmesi varsa "sablonla doldurma" yalniz REFERANS SAHNESINDE yapilir (diger sahnelerde nesne yoktur; orada dolgu uydurma konum olurdu). Kesme yoksa sahne = tum klip, davranis AYNEN.
      var cutsE = []; try { OWN.detectCutsStrict(r.frames, W, H).forEach(function (c, ci) { if (c) cutsE.push(ci); }); } catch (e) {}
      var scB = OWN._fgSceneBounds(r.frames.length, refIdx, cutsE), scN = scB[1] - scB[0] + 1;
      function inSc(q) { return q >= scB[0] && q <= scB[1]; }
      function cntSc(rr) { var c = 0, q; for (q = scB[0]; q <= scB[1]; q++) if (rr.frames[q]) c++; return c; }
      function onlySc(rr) { return (scN === r.frames.length) ? rr : Object.assign({}, rr, { frames: rr.frames.map(function (f, q) { return inSc(q) ? f : null; }) }); }
      var okN = cntSc(res), relaxedNote = '', mth = $('ownMethod').value;
      // v2.16.1: kucuk nesne (imlec gibi) + nokta takibi neredeyse hic tutunamadiysa sablona dusmek yerine yerel cozunurluklu "imlec / kucuk nesne" yontemi kullanilir (testte sablon imleci kaybedip %100 izlemis gibi gosteriyordu).
      if (mth === 'auto' && !res.cancelled && !own.cancel && r.frames.length > 12 && own.imgW && own.rect && Math.max(own.rect[2] * own.imgW, own.rect[3] * (own.imgH || own.imgW)) < 0.07 * own.imgW && okN < Math.round(scN * 0.5)) {
        log('Nesne küçük ve nokta takibi tutunamadı (' + okN + ' / ' + scN + ' kare): "İmleç / küçük nesne" yöntemine geçildi.');
        await runSmallMode(); return;
      }
      own.method = ''; own.crop = undefined;
      if (mth === 'tpl' || (mth === 'auto' && !res.cancelled && r.frames.length > 12 && okN < Math.round(scN * 0.95))) {   // nokta takibi zayifsa (dokusuz / hizli nesne) sablon eslestirmeyi dene
        ownMsg('Şablon eşleştirme deneniyor…');
        var rt = null, okT = -1, crops = [0.7, 1], ci;      // iki sablon boyutu dene (ic kisim / tum kutu); daha cok kare izleyeni sec
        for (ci = 0; ci < crops.length && !own.cancel; ci++) {
          var rc = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), method: 'tpl', tplCrop: crops[ci], onProgress: ownProg, cancel: function () { return own.cancel; } });
          rc = onlySc(rc); var okC = cntSc(rc);
          if (okC > okT) { rt = rc; okT = okC; own.crop = crops[ci]; }
        }
        var wholesale = mth === 'tpl' || okN < Math.round(scN * 0.5);
        if (rt && !wholesale && okT > okN && !own.cancel) {   // nokta takibi iyi ama bosluklari var: bosluklari sablon takibiyle doldur (zayif / sari isaretli)
          var rf2 = OWN.fillGaps(res, rt); log('Kendi takibim: nokta takibi ' + okN + ' kare; ' + rf2.filled + ' boş kare şablon eşleştirmeyle dolduruldu (zayıf işaretli).'); res = rf2; okN = res.frames.filter(Boolean).length; relaxedNote = ' (' + rf2.filled + ' kare şablonla dolduruldu)';
        }
        if (rt && wholesale && (mth === 'tpl' || okT > okN * 1.25)) {
          // v2.14: "Otomatik"te şablon, yalnızca daha çok kare izledi diye nokta sonucunun yerine konmaz; ortak karelerdeki fark ölçülür (OWN.autoPick). Elle seçilen "Şablon" yöntemi eskisi gibi.
          var pick = mth === 'tpl' ? { mode: 'template', verified: true } : OWN.autoPick(res, rt, { boxW: own.rect[2] * W, boxH: own.rect[3] * H });
          if (pick.mode === 'template') {
            log('Kendi takibim: nokta takibi ' + okN + ', şablon eşleştirme ' + okT + ' kare izledi; şablon yöntemi seçildi.' + (pick.verified === false ? ' (Nokta takibi yalnız ' + pick.overlap + ' ortak kare verdi; şablon sonucu doğrulanamadı.)' : '')); res = rt; okN = okT; own.method = 'tpl';
            relaxedNote = ' (şablon eşleştirme' + (pick.verified === false ? '; nokta takibiyle doğrulanamadı, önizlemeyi dikkatle kontrol et' : '') + ')';
          } else if (pick.mode === 'fill') {
            log('Kendi takibim: nokta takibi ' + okN + ' kare; şablon sonucu ortak ' + pick.overlap + ' karede nokta takibiyle uyumlu (ortanca fark ' + pick.medianPx.toFixed(1) + ' px). Nokta kareleri korundu, ' + pick.filled + ' boş kare şablonla dolduruldu (zayıf işaretli).');
            res = pick.res; okN = res.frames.filter(Boolean).length; relaxedNote = ' (nokta kareleri korundu; ' + pick.filled + ' kare şablonla dolduruldu)';
          } else {
            var pct = Math.round(100 * pick.badFrac);
            log('UYARI: Kendi takibim: şablon sonucu, ortak ' + pick.overlap + ' karenin %' + pct + '\'inde nokta takibinden kutu boyunun %25\'inden fazla ayrıldı (ortanca ' + pick.medianPx.toFixed(1) + ' px). Hangisinin doğru olduğu belirlenemediği için nokta takibi korundu, şablon kullanılmadı.');
            relaxedNote = ' · UYARI: şablon eşleştirme nokta takibiyle çeliştiği için kullanılmadı; yalnız nokta takibinin ' + okN + ' karesi var. Takipsiz karelerde kutuyu nesneye çekip "Buradan ileri / geri" ile sür.';
          }
        }
      }
      if (!res.cancelled && own.method !== 'tpl' && r.frames.length > 30 && okN < Math.max(8, Math.round(r.frames.length * 0.03))) {   // neredeyse hic takip yok: hassas modla bir kez daha dene
        log('Kendi takibim: ilk deneme yalnız ' + okN + ' kare izledi; hassas modla yeniden deneniyor.' + (res.stats ? ' [' + JSON.stringify(res.stats) + ']' : ''));
        ownMsg('İlk deneme zayıf, hassas modla yeniden deneniyor…');
        res = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), relaxed: true, onProgress: ownProg, cancel: function () { return own.cancel; } });
        relaxedNote = ' (hassas mod)';
      }
      if (res.stats) log('Takip tanısı: kayıp ' + res.stats.coasts + ' (nokta ' + res.stats.lkLost + ', görünüm ' + res.stats.lowApp + '), takip yeniden sürdürme ' + res.stats.resumes + ', şablonla yeniden bulma ' + res.stats.reacqs + '.');
      var cutIdx = []; own.cutsIdx = cutsE.slice(); cutsE.forEach(function (ci) { cutIdx.push(ci + 1); });   // v2.16: kesmeler yukarida (sablon asamasindan once) bir kez hesaplandi
      if (cutIdx.length) { relaxedNote += ' · sahne kesmesi / ani plan değişimi: kare ' + cutIdx.slice(0, 5).join(', ') + (cutIdx.length > 5 ? '…' : '') + ' (orada takip güvenilmez, kontrol et)'; log('Kendi takibim: sahne kesmesi kareleri: ' + cutIdx.join(', ')); }
      // v2.15: dogrulamali duzeltme. YALNIZ "Otomatik" yontemde ve hedef dogrulama supheli donem (ya da cok bos kare) buluyorsa calisir; supheli donem yoksa sonuc AYNEN kalir.
      // Adaylar (sablon / birlesik / sabit kamera on plan) gercek goruntu kanitiyla uretilir; yalniz belirgin sekilde daha az supheli+bos kare veren aday alinir.
      if (mth === 'auto' && !res.cancelled && !own.cancel && own.method !== 'small' && r.frames.length > 12) {
        try {
          var imp = await OWN.improveTrackAsync(res, r.frames, W, H, refIdx, own.rect, { fps: own.fps, cuts: own.cutsIdx || [], anchors: {}, cancel: function () { return own.cancel; }, onStage: function (t, p) { ownMsg('Doğrulama şüphe buldu — ' + t + (p == null ? '…' : ' %' + p) + ' (bu aşama birkaç dakika sürebilir)'); },
            base: { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy() } });
          log('Doğrulamalı düzeltme: ilk sonuç şüpheli ' + imp.report.base.suspect + ' + boş ' + imp.report.base.missing + ' kare; adaylar: ' + (imp.report.cands.map(function (c) { return c.name + ' (şüpheli ' + c.suspect + ', boş ' + c.missing + (c.high ? ', yüksek şüphe' : '') + ')'; }).join('; ') || 'yok') + (imp.report.fg && imp.report.fg.reason ? ' [ön plan: ' + imp.report.fg.reason + ']' : ''));
          own.pair = null;
          if (imp.changed) {
            res = imp.res; okN = res.frames.filter(Boolean).length; relaxedNote += imp.note; log('Doğrulamalı düzeltme: "' + res.improvedBy + '" seçildi (otomatik).');
            own.crop = res.improvedBy === 'şablon' ? 0.7 : (res.improvedBy === 'şablon (tam kutu)' ? 1 : undefined); own.method = (res.improvedBy.indexOf('şablon') === 0) ? 'tpl' : '';
            own.pair = { kind: 'auto', name: res.improvedBy, first: imp.orig, other: res, showing: 'other', mFirst: { method: '', crop: undefined }, mOther: { method: own.method, crop: own.crop } };
          } else if (imp.alt) {
            own.pair = { kind: 'alt', name: imp.alt.name, first: res, other: imp.alt.res, showing: 'first', mFirst: { method: own.method, crop: own.crop }, mOther: { method: (imp.alt.name.indexOf('şablon') === 0 ? 'tpl' : ''), crop: imp.alt.name === 'şablon' ? 0.7 : (imp.alt.name === 'şablon (tam kutu)' ? 1 : undefined) } };
            relaxedNote += ' · Alternatif takip hazır ("' + imp.alt.name + '"; şüpheli+boş kare ' + imp.alt.score + ', ilk takipte ' + imp.report.base.score + '). Kendiliğinden uygulanmadı: "Alternatif takibi göster" ile karşılaştır, beğenmezsen "İlk takibe dön".';
            log('Doğrulamalı düzeltme: alternatif hazır, uygulanmadı: ' + imp.alt.name);
          }
        } catch (e) { log('Doğrulamalı düzeltme atlandı: ' + (e && e.message || e)); }
      }
      try { var sj = OWN.smoothJumps(res, Math.max(6, Math.round(0.5 * own.fps)), 0.25); if (sj.jumps) { res = sj.res; relaxedNote += ' · ' + sj.jumps + ' yerde kutu bir karede çok sıçradı (takip kaynağı değişimi); geçiş yumuşatıldı (sarı kareler)'; log('Takip kaynağı birleşiminde ' + sj.jumps + ' sıçrama yumuşatıldı.'); } } catch (e) {}
      try { var dw = OWN.dropFrozenAfterCuts(res, own.cutsIdx || [], refIdx, own.W); if (dw.dropped) { res = dw.res; relaxedNote += ' · sahne kesmesinden sonra arka plana sabitlenip hiç kımıldamayan ' + dw.dropped + ' kare takipsiz bırakıldı (keyframe yapılmaz)'; log('Sahne kesmesi sonrası sabitlenmiş takip silindi: ' + dw.dropped + ' kare.'); } } catch (e) {}
      if (own.method === 'tpl' && own.rect && own.imgW && Math.max(own.rect[2] * own.imgW, own.rect[3] * (own.imgH || own.imgW)) < 0.07 * own.imgW) relaxedNote += ' · UYARI: nesne çok küçük; şablon yöntemi nesneyi kaybedip arka plana kayabilir. Önizlemeyi kontrol et; gerekirse "Yöntem" listesinden "İmleç / küçük nesne"yi seç';
      own.res = res; own.scrub = refIdx; own.anchors = {};
      own.verRef = { idx: refIdx, rect: own.rect.slice() };   // v2.14: hedef dogrulama uyarisi icin ILK referans (yeniden takipte kutu degisse bile ilk gorunum kullanilir)
      if (await ownFinalize(res, t0, (res.cancelled ? ' (durduruldu: o ana kadarki kısım)' : '') + relaxedNote)) {
        $('ownReview').classList.remove('hidden'); var sl = $('ownScrub'); sl.max = r.frames.length - 1; sl.value = refIdx; showScrub(refIdx);
      }
    } catch (e) { ownMsg('HATA: ' + e, 'err'); log('HATA: Kendi takibim: ' + (e && e.stack || e)); }
    finally { ownBusyUI(false); }
  };
  $('ownScrub').addEventListener('input', function () { if (own.res && own.frames) showScrub(Number($('ownScrub').value)); });
  function anchorsHit(k) { return !!(own.anchors && own.anchors[k]); }
  async function ownRetrack(dir) {
    if (!own.res || !own.frames || !own.rect) return;
    var i = own.scrub, fr = own.res.frames, near = null, d, N = own.frames.length;
    for (d = 0; d < fr.length && !near; d++) { if (fr[i - d]) near = fr[i - d]; else if (fr[i + d]) near = fr[i + d]; }
    var ratio = near ? Math.sqrt((own.rect[2] * own.W * own.rect[3] * own.H) / Math.max(1, polyArea(near.poly))) : 1;
    // Duzeltilen kareler "capa" olur: yeniden takip bir sonraki / onceki capaya kadar gider, onun otesindeki onceki duzeltmelere dokunmaz
    own.anchors = own.anchors || {}; own.anchors[i] = true;
    var lo = 0, hi = N - 1, k;
    if (dir === 'fwd') { for (k = i + 1; k < N; k++) if (own.anchors[k]) { hi = k; break; } }
    else { for (k = i - 1; k >= 0; k--) if (own.anchors[k]) { lo = k; break; } }
    // v2.16: duzeltme SAHNE KESMESINDE durur (baska sahnenin kareleri baska bir goruntu; oraya yazmak dogru takibi bozar). own.cutsIdx = yeni sahnenin ilk kareleri.
    var cutLim = false, cx2 = own.cutsIdx || [], cq;
    if (dir === 'fwd') { for (cq = 0; cq < cx2.length; cq++) if (cx2[cq] > i && cx2[cq] - 1 < hi) { hi = cx2[cq] - 1; cutLim = true; } }
    else { for (cq = 0; cq < cx2.length; cq++) if (cx2[cq] <= i && cx2[cq] > lo) { lo = cx2[cq]; cutLim = true; } }
    own.pair = null;   // elle duzeltme gecerli sonuca uygulanir; ilk/alternatif karsilastirmasi sona erer
    own.cancel = false; ownBusyUI(true); var t0 = Date.now();
    try {
      var sub = own.frames.slice(lo, hi + 1), off = lo;
      var res2 = own.method === 'small' ? await ownSmallRun(own.info.inSec + lo / own.fps, hi - lo + 1, i - off, dir) : await OWN.trackRegionAsync(sub, own.W, own.H, i - off, own.rect, { dir: dir, method: own.method || undefined, tplCrop: own.crop || undefined, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), baseScale: near ? near.scale * ratio : 1, baseRot: near ? near.rot : 0, onProgress: ownProg, cancel: function () { return own.cancel; } });
      if (!res2) return;
      // v2.16: nokta takibi bolgede neredeyse hic ilerleyemediyse (<=5 kare: kucuk / dokusuz hedefte baslayamaz ya da hemen kaybolur) sablonla dene (Takip et'teki ayni autoPick karari; zayif/sari isaretli).
      // Nokta takibi daha cok kare izlediyse bu blok hicbir sey yapmaz (sonuc eskisiyle ayni; kuyruk kaybi uyarisi S0 aynen).
      var rtNote = '';
      if (!res2.cancelled && !own.cancel && own.method !== 'small' && own.method !== 'tpl') {
        try {
          var rgA = dir === 'fwd' ? i - off : 0, rgB = dir === 'fwd' ? hi - off : i - off, rgN = rgB - rgA + 1, okL = 0, qq;
          for (qq = rgA; qq <= rgB; qq++) if (res2.frames[qq]) okL++;
          if (okL < rgN && okL <= 5) {   // YALNIZ nokta takibi neredeyse hic ilerleyemediyse (baslayamadi / hemen kayboldu). Daha cok kare izleyip sonra kaybettiyse sablonla DOLDURMA: V2 kuyruk kaybinda sablon omuza kayip yanlis kare uretti (olculdu)
            var rtp = null, okT2 = -1, cj, crops2 = [0.7, 1];
            for (cj = 0; cj < crops2.length && !own.cancel; cj++) {
              var rc3 = await OWN.trackRegionAsync(sub, own.W, own.H, i - off, own.rect, { dir: dir, method: 'tpl', tplCrop: crops2[cj], model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), baseScale: near ? near.scale * ratio : 1, baseRot: near ? near.rot : 0, onProgress: ownProg, cancel: function () { return own.cancel; } });
              var okC2 = 0; for (qq = rgA; qq <= rgB; qq++) if (rc3.frames[qq]) okC2++;
              if (okC2 > okT2) { okT2 = okC2; rtp = rc3; }
            }
            if (rtp && okT2 > okL && !own.cancel) {
              var pk2 = OWN.autoPick(res2, rtp, { boxW: own.rect[2] * own.W, boxH: own.rect[3] * own.H });
              if (pk2.mode === 'template') { res2 = rtp; rtNote = ' · nokta takibi bölgenin yalnız ' + okL + '/' + rgN + ' karesini izleyebildi; şablon eşleştirmeyle ' + okT2 + ' kare izlendi (zayıf işaretli, önizlemeyi kontrol et)'; }
              else if (pk2.mode === 'fill') { res2 = pk2.res; rtNote = ' · nokta takibi ' + okL + '/' + rgN + ' kare izledi; ' + pk2.filled + ' boş kare şablonla dolduruldu (zayıf işaretli, kontrol et)'; }
              else { rtNote = ' · şablon sonucu nokta takibiyle çeliştiği için kullanılmadı; yalnız nokta takibinin ' + okL + '/' + rgN + ' karesi var'; }
              log('Buradan ' + (dir === 'fwd' ? 'ileri' : 'geri') + ' takip: nokta ' + okL + '/' + rgN + ', şablon ' + okT2 + ' kare → ' + (pk2.mode === 'template' ? 'şablon kullanıldı' : pk2.mode === 'fill' ? 'boşluklar şablonla dolduruldu' : 'nokta takibi korundu'));
            }
          }
        } catch (e) { log('Buradan takip: şablonla yeniden deneme atlandı: ' + (e && e.message || e)); }
      }
      var out = own.res.frames.slice(), from = dir === 'fwd' ? i : lo, to = dir === 'fwd' ? hi : i;
      // S1: baslatma hatasi (motor ilk karede takibe baslayamadi: lostFwd/lostBwd = referans kare, tek gecerli kare = duzeltilen kare; durdurma DEGIL).
      // Bu durumda onceki takip KORUNUR; yalniz kullanicinin duzeltilen karesi yazilir (capa zaten ona aittir).
      var sfN = 0, sfK; for (sfK = 0; sfK < res2.frames.length; sfK++) if (res2.frames[sfK]) sfN++;
      var startFail = !res2.cancelled && (dir === 'fwd' ? res2.lostFwd : res2.lostBwd) === i - off && sfN === 1 && !!res2.frames[i - off], wFrom = startFail ? i : from, wTo = startFail ? i : to;
      for (k = wFrom; k <= wTo; k++) {
        if (own.anchors[k] && k !== i) continue;           // baska bir duzeltilmis kareyi ezme
        var nf = res2.frames[k - off] || null;
        if (nf) { nf = Object.assign({}, nf); nf.i = k; }
        out[k] = nf;
      }
      // v2.16: elle duzeltilen kareye ISINLANMA olmasin. Duzeltme noktasinin onceki (fwd) / sonraki (bwd) ~1.5 sn'lik kareleri, eski takipten duzeltilmis konuma dogrusal gecirilir; gecis kareleri zayif guvenli (sari) isaretlenir.
      try {
        var K = Math.max(3, Math.round(1.5 * own.fps)), s1 = dir === 'fwd' ? -1 : 1, e1 = out[i], oldEnd = out[i + s1 * K] || null, q, oldf = own.res.frames;
        if (e1 && oldf[i + s1 * K] && oldf[i + s1 * K].poly && e1.poly && i + s1 * K >= 0 && i + s1 * K < N) {
          var o2 = oldf[i + s1 * K], jump = Math.hypot(oldf[i] ? oldf[i].cx - e1.cx : 0, oldf[i] ? oldf[i].cy - e1.cy : 0), ok2 = true;
          for (q = 1; q < K; q++) if (anchorsHit(i + s1 * q)) ok2 = false;
          if (ok2 && jump > 0) for (q = 1; q < K; q++) {
            var k2 = i + s1 * q, of = oldf[k2], w2 = q / K;   // w2: eski takibin agirligi
            if (!of || !of.poly) continue;
            var nb = Object.assign({}, of); nb.cx = e1.cx + (o2.cx - e1.cx) * w2; nb.cy = e1.cy + (o2.cy - e1.cy) * w2;
            nb.poly = of.poly.map(function (pt, z) { var A = e1.poly[z], B = o2.poly[z]; return [A[0] + (B[0] - A[0]) * w2, A[1] + (B[1] - A[1]) * w2]; });
            nb.conf = Math.min(of.conf, 0.45); nb.i = k2; out[k2] = nb;
          }
        }
      } catch (e) { log('Geçiş yumuşatma atlandı: ' + (e && e.message || e)); }
      // A2-0 (tani): yeniden takip oncesi / sonrasi takipsiz kare sayisi. YALNIZ Gunluge yazar; sonucu (out) degistirmez.
      try {
        var dg0 = own.res.frames, dgB = 0, dgA = 0, dgLost = 0, dgGain = 0, dgK;
        for (dgK = 0; dgK < N; dgK++) { if (!dg0[dgK]) dgB++; if (!out[dgK]) dgA++; }
        var dgR = [], dgS = -1, dgL;   // A2-1a: bosalan karelerin aralik listesi (1 tabanli, arayuzdeki gibi)
        for (dgK = from; dgK <= to + 1; dgK++) {
          dgL = dgK <= to && dg0[dgK] && !out[dgK];
          if (dgK <= to) { if (dgL) dgLost++; else if (!dg0[dgK] && out[dgK]) dgGain++; }
          if (dgL) { if (dgS < 0) dgS = dgK; } else if (dgS >= 0) { dgR.push(dgS === dgK - 1 ? String(dgS + 1) : (dgS + 1) + '–' + dgK); dgS = -1; }
        }
        var dgTxt = dgR.length ? ' Boşalan kareler: ' + (dgR.length > 12 ? dgR.slice(0, 12).join(', ') + ' … (+' + (dgR.length - 12) + ' aralık daha)' : dgR.join(', ')) + '.' : '';
        log('Buradan ' + (dir === 'fwd' ? 'ileri' : 'geri') + ' takip (kare ' + (i + 1) + ', bölge ' + (from + 1) + '–' + (to + 1) + (res2.cancelled ? ', durduruldu' : '') + '): takipsiz kare ' + dgB + ' → ' + dgA + ' / ' + N + '; bölgede eskiden izli ' + dgLost + ' kare boşaldı, ' + dgGain + ' boş kare doldu.' + (dgLost ? ' UYARI: yeni takip bu karelerde sonuç üretemedi; önceki sonuç silindi, Uygula bu karelere keyframe yazmaz.' : '') + dgTxt);
        if (res2.stats) log('Yeniden takip tanısı: kayıp ' + res2.stats.coasts + ' (nokta ' + res2.stats.lkLost + ', görünüm ' + res2.stats.lowApp + '), takip yeniden sürdürme ' + res2.stats.resumes + ', şablonla yeniden bulma ' + res2.stats.reacqs + '. Yöntem: ' + (own.method === 'tpl' ? 'şablon' : 'nokta') + '.');
      } catch (e) { }
      // S0/S1 (kullaniciya gorunur uyari): yalniz Gunluk + ownFinalize mesaji; sonucu (out) degistirmez. Basarili yolda sfNote / tailNote bos kalir -> mesaj eskisiyle birebir ayni.
      var sfNote = '', tailNote = '';
      try {
        if (startFail) {
          sfNote = ' ⚠ YENİDEN TAKİP BAŞLATILAMADI: ' + ((dir === 'fwd' ? res2.reasonFwd : res2.reasonBwd) || 'bölgede takip edilecek doku yok.') + ' Önceki takip korundu; yalnız kare ' + (i + 1) + ' düzeltildi (düzeltmeden sonrası eski takip konumlarında kalır).';
          log('Yeniden takip başlatılamadı (kare ' + (i + 1) + '): ' + ((dir === 'fwd' ? res2.reasonFwd : res2.reasonBwd) || 'bölgede takip edilecek doku yok.') + ' Önceki takip korundu; yalnız kare ' + (i + 1) + ' düzeltildi.');
        } else {
          // S0: kuyruk kaybi = motorun son (fwd) / ilk (bwd) gecerli karesinden bolge ucuna kadar, ESKIDEN izli olup SIMDI bos kalan kareler (eskiden bos olanlar sayilmaz; gecis blogundan sonraki out ile karsilastirilir)
          var s0Old = own.res.frames, s0N = 0, s0A = -1, s0B = -1, s0K, s0Edge = i;
          if (dir === 'fwd') { for (s0K = i; s0K <= to; s0K++) if (res2.frames[s0K - off]) s0Edge = s0K; for (s0K = s0Edge + 1; s0K <= to; s0K++) if (!(own.anchors[s0K] && s0K !== i) && s0Old[s0K] && !out[s0K]) { s0N++; if (s0A < 0) s0A = s0K; s0B = s0K; } }
          else { for (s0K = i; s0K >= from; s0K--) if (res2.frames[s0K - off]) s0Edge = s0K; for (s0K = s0Edge - 1; s0K >= from; s0K--) if (!(own.anchors[s0K] && s0K !== i) && s0Old[s0K] && !out[s0K]) { s0N++; if (s0B < 0) s0B = s0K; s0A = s0K; } }
          if (s0N > 0) {
            tailNote = res2.cancelled
              ? ' ⚠ Durdurulduğu için eskiden izli ' + s0N + ' kare (' + (s0A + 1) + '–' + (s0B + 1) + ' aralığında) boşaldı.'
              : ' ⚠ KUYRUK KAYBI: yeni takip kare ' + (s0Edge + 1) + (dir === 'fwd' ? ' sonrasında' : ' öncesinde') + ' durdu; eskiden izli ' + s0N + ' kare (' + (s0A + 1) + '–' + (s0B + 1) + ' aralığında) boşaldı. Kutuyu nesneye çekip tekrar "Buradan ' + (dir === 'fwd' ? 'ileri' : 'geri') + '" de.';
            log('Yeniden takip: ' + tailNote.replace(/^ ⚠ /, ''));
          }
          // S0b: kuyruk disindaki (ic) kayiplar da panel mesajinda gorunur; sayi A2 Gunluk blogundaki dgLost'tan (eskiden izli, simdi bos) kuyruk kaybi cikarilarak bulunur
          var s0Other = (typeof dgLost === 'number' ? dgLost : 0) - s0N;
          if (s0Other > 0) { var oNote = ' ⚠ ' + (s0N > 0 ? 'Ayrıca eskiden' : 'Eskiden') + ' izli ' + s0Other + ' kare boşaldı (aralıklar Günlükte).'; tailNote += oNote; log('Yeniden takip: ' + oNote.replace(/^ ⚠ /, '')); }
        }
      } catch (e) { }
      own.res = Object.assign({}, own.res, { frames: out });
      await ownFinalize(own.res, t0, (res2.cancelled ? ' (durduruldu)' : '') + (hi < N - 1 && dir === 'fwd' ? ' (bir sonraki düzeltmeye kadar)' : '') + (lo > 0 && dir === 'bwd' ? ' (bir önceki düzeltmeye kadar)' : '') + (cutLim ? ' (sahne kesmesine kadar)' : '') + sfNote + rtNote + tailNote);
      showScrub(i);
    } catch (e) { ownMsg('HATA: ' + e, 'err'); log('HATA: Kendi takibim (yeniden): ' + (e && e.stack || e)); }
    finally { ownBusyUI(false); }
  }
  $('bOwnFwd').onclick = function () { ownRetrack('fwd'); };
  $('bOwnBwd').onclick = function () { ownRetrack('bwd'); };

  $('bTgt').onclick = async function () {
    busy(true);
    try {
      var r = await evJson('ppGetSelectionAll()');
      if (!r.ok) { setInfo('tgtInfo', 'Klip alınamadı: ' + esc(r.err), 'err'); return log('HATA: ' + r.err); }
      st.tgts = r.clips; r.clips.forEach(restoreBase);
      setInfo('tgtInfo', '<b>' + esc(r.clips.map(function (c) { return c.name; }).join(', ')) + '</b>' + (r.clips.length > 1 ? '<br>' + r.clips.length + ' klip seçildi' : ''), 'ok');
      mark('card2', true);
      refreshPreview(false);
      log('Hedef: ' + r.clips.length + ' klip');
      if (r.clips.some(function (c) { return c.posAnimated; })) log('Bilgi: Bazı hedeflerde zaten Position animasyonu var; temel konum olarak ilk keyframe değeri alındı. Yeniden uygulamak güvenli (eskiler silinir, "Geri al" ile ilk haline dönülebilir).');
    } finally { busy(false); }
  };

  // Yazi / grafik klibinde yazi, grafik karesinin merkezinde degil kendi "Text > Position" noktasindadir. Motion Position'i nesneye
  // koyarsak yazi nesnenin (yazi konumu - kare merkezi) kadar yanina duser. Bu fark Motion Position'dan cikarilir. Normalize (sekans) birim.
  function nz(v, size) { return Math.abs(v) > 10 ? v / size : v; }
  function visOffset(tgt) {
    var cb = $('txtComp'); if (cb && !cb.checked) return null;
    if (!tgt || !tgt.text || !tgt.text.pos || !tgt.anchor) return null;
    var s = (Number(tgt.scale) || 100) / 100;
    var vx = (nz(tgt.text.pos[0], tgt.seqW) - nz(tgt.anchor[0], tgt.seqW)) * s, vy = (nz(tgt.text.pos[1], tgt.seqH) - nz(tgt.anchor[1], tgt.seqH)) * s;
    if (!isFinite(vx) || !isFinite(vy) || (Math.abs(vx) < 1e-4 && Math.abs(vy) < 1e-4)) return null;
    return [vx, vy];
  }
  function where_for_opts() { return WHERE(); }
  // 'Yalnız konum' modelinde takip verisi ölçek/dönme taşımaz; boyut-takibi ayarları gizlenir ve uygulanmaz
  function posOnly() { return !!$('ownModel') && $('ownModel').value === 'trans'; }
  function buildOpts(tgt) {
    var ss = effectiveSrcSize();
    return {
      motion: { pos: st.src.pos, scale: st.src.scale, scaleW: (st.src.uniform === false && st.src.scaleW) ? st.src.scaleW : null, anchor: st.src.anchor },
      srcW: ss[0], srcH: ss[1], seqW: tgt.seqW, seqH: tgt.seqH,
      mode: $('mode').value, tgtPos: tgt.pos,
      step: Math.max(1, num('step', 1)), smooth: Math.max(0, num('smooth', 0)), tol: Math.max(0, num('tol', 0)),
      zoom: ($('zoomMode').value === 'keep' && st.src) ? (Number(st.src.scale) || 100) : (num('zoom', 150) || 150),
      zoomMax: Math.max(num('zoomMax', 300) || 300, Math.ceil(Math.max(tgt.seqW / ss[0], tgt.seqH / ss[1]) * 100 * 1.1)), dynZoom: $('zoomMode').value === 'auto', sizeTrack: !posOnly() && $('sizeTrack').checked, sizeStr: Math.max(0, num('sizeStr', 70)),
      despike: $('despike').checked ? 0.05 : 0, deadzone: Math.max(0, num('dz', 0)) / 100,
      offset: [num('offX', 0), num('offY', 0)], pin: [pct('pinX'), pct('pinY')], stats: {}, vis: visOffset(tgt), rotTrack: !posOnly() && !!($('rotTrack') && $('rotTrack').checked), rotStr: 100, tgtRot: Number(tgt.xf && where_for_opts() === 'xform' ? tgt.xf.rot : tgt.rot) || 0, scaleTrack: !posOnly() && !!($('scTrack') && $('scTrack').checked), scaleStr: Math.max(0, num('scStr', 100)), tgtScale: Number(tgt.scale) || 100, place: ($('plc') ? $('plc').value : 'center'), gap: num('plcGap', 24)
    };
  }

  // Hesapla + kareye oturt + tekrarları ele
  function compute(tgt, quiet) {
    var t = st.tracks[0], o = buildOpts(tgt);
    if (o.mode === 'follow' && $('zoomMode').value === 'fixed' && $('autoZoom').checked) {
      var z = MaskParser.autoZoom(t.points, o);
      if (z > 1000) { if (!quiet) log('UYARI: Kenarsız kadraj için %' + z + ' zoom gerekir; 1000 ile sınırlandı. Dinamik zoom\'u aç, nesneyi ortalamak yerine Nesne X/Y konumunu kenara kaydır ya da Ölü bölge kullan.'); z = 1000; }
      o.zoom = z; $('zoom').value = z;
      if (!quiet) log('Otomatik zoom: %' + z);
    }
    // v2.14.2-test.1 duzeltme: Position once YOGUN (tol=0) uretilir, dizi fps'ine oturtulur (rsq), SONRA seyreltilir (reduceKeys).
    // Eskiden seyreltme resample'dan once yapiliyordu: seyrek listede ortanca aralik kare suresinden >%2 sapinca resampleToFrames basamakli (hold) uygulayip Position'i bozuyordu.
    // Scale / Rotation (zAll / rAll) zaten yogun listeden gelir; degismez.
    var pts = MaskParser.toPositions(t.points, Object.assign({}, o, { tol: 0 }));
    var TPS = MaskParser.TPS, sT = Number(tgt.startTicks), eT = Number(tgt.endTicks);
    var ft = Number(tgt.frameTicks), off = $('ref').value === 'inpoint' ? tgt.inSec : 0;
    // zamani kareye oturt, ayni kareye dusenleri tekle
    function toFrames(arr, mk) {
      var byFrame = {}, list = [];
      arr.forEach(function (p) {
        var rel = p.tl * TPS - sT;
        if (rel < -2000 || p.tl * TPS > eT + 2000) return;
        var k = ft > 0 ? Math.round(rel / ft) : Math.round(rel);
        var sec = (ft > 0 ? k * ft : rel) / TPS;
        if (sec < 0) return;
        byFrame[k] = mk(p, sec + off);
      });
      Object.keys(byFrame).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) { list.push(byFrame[k]); });
      return list;
    }
    // v2.16: klip fps'i ile dizi fps'i farkliysa (24 -> 25 / 30 / 60) egri TAM dizi kare zamanlarinda orneklenir (aksi halde her nokta en yakin kareye yazilip hiz duzensizlesir). Hiz esitse AYNEN.
    function rsq(a) { return ft > 0 ? MaskParser.resampleToFrames(a, sT / TPS, ft / TPS) : a; }
    var list = toFrames(MaskParser.reduceKeys(rsq(pts), o.tol, o.seqW, o.seqH), function (p, sec) { return { sec: sec, x: p.x, y: p.y, tl: p.tl }; });
    var zlist = pts.zAll ? MaskParser.reduceScalar(toFrames(rsq(pts.zAll), function (p, sec) { return { sec: sec, z: p.z, tl: p.tl }; }), 0.1, 'z') : null;
    var rlist = pts.rAll ? MaskParser.reduceScalar(toFrames(rsq(pts.rAll), function (p, sec) { return { sec: sec, z: p.z, tl: p.tl }; }), 0.15, 'z') : null;
    return { list: list, zlist: zlist, rlist: rlist, seqW: tgt.seqW, seqH: tgt.seqH, zoom: o.zoom, stats: o.stats, track: t, o: o };
  }

  // Onizleme hedefi: kadraj takibinde maskeli klibin kendisi, digerlerinde ilk hedef
  function previewTarget() { return $('mode').value === 'follow' ? st.src : (st.tgts[0] || st.src); }
  function refreshPreview(show) {
    if (!window.MTPreview) return;
    if (show) MTPreview.show();
    MTPreview.refresh();
  }
  // Sıçrama sayımı: işlenmiş (despike/yumuşatma sonrası) ham yol üzerinde, keyframe seyreltmesinden bağımsız.
  function jumpCount(r) {
    var C = MaskParser.processed(r.track.points, r.o), j = 0;
    for (var i = 1; i < C.length; i++) if (Math.abs(C[i][0] - C[i - 1][0]) > 0.15 || Math.abs(C[i][1] - C[i - 1][1]) > 0.15) j++;
    return j;
  }

  // ===== Uygulama yeri: Motion mu, Transform EFEKTI mi (Shutter Angle / hareket bulaniklugu icin) =====
  function WHERE() { var a = $('applyTo'); return a && a.value === 'xform' ? 'xform' : 'motion'; }
  // Transform efekti, Motion'dan ONCE (klibin kendi karesinde) uygulanir: efektin konumu klip-normalize, Motion ise onu dizi karesine tasir.
  // Dizi konumu S = Pm + (T - Am) * k  (k = klip boyutu/dizi boyutu * Motion olcegi). Tether dizi-normalize konum uretir; T = Am + (S - Pm) / k.
  function xfCtx(tgt, follow) {
    var seqW = tgt.seqW || (st.src && st.src.seqW) || 1920, seqH = tgt.seqH || (st.src && st.src.seqH) || 1080;
    var nzv = function (v, size) { return Math.abs(v) > 10 ? v / size : v; };
    var Pm = tgt.posPx ? [tgt.pos[0] / seqW, tgt.pos[1] / seqH] : [tgt.pos[0], tgt.pos[1]];
    var Am = tgt.anchor ? [nzv(tgt.anchor[0], seqW), nzv(tgt.anchor[1], seqH)] : [0.5, 0.5];
    var m = Number(tgt.scale) || 100, sy = m / 100, sx = ((tgt.uniform === false && tgt.scaleW) ? tgt.scaleW : m) / 100;
    var cw = tgt.nat ? tgt.nat[0] / seqW : 1, ch = tgt.nat ? tgt.nat[1] / seqH : 1;
    var k = [Math.max(1e-4, cw * sx), Math.max(1e-4, ch * sy)];
    var x = tgt.xf || {}, xp = x.pos ? (x.posPx ? [x.pos[0] / seqW, x.pos[1] / seqH] : [x.pos[0], x.pos[1]]) : [0.5, 0.5];
    var S0 = [Pm[0] + (xp[0] - Am[0]) * k[0], Pm[1] + (xp[1] - Am[1]) * k[1]];
    var tgt2 = Object.assign({}, tgt, { pos: S0, posPx: false, scale: follow ? tgt.scale : (x.scale != null ? x.scale : 100) });
    return { tgt2: tgt2, m: m, px: !!x.posPx, k: k, conv: function (X, Y) { return [Am[0] + (X - Pm[0]) / k[0], Am[1] + (Y - Pm[1]) / k[1]]; } };
  }

  // Motion <-> Transform gecisi: digerinin animasyonu kalirsa ikisi UST USTE biner (cift kayma). Uygulamadan once digerini etkisiz yap.
  // Donus: Motion sifirlandiysa { pos, scale } (Transform hesabinda taban olarak kullanilir), degilse null.
  async function neutralizeOther(tgt, where) {
    try {
      var other = where === 'xform' ? 'motion' : 'xform', okey = tgt.nodeId + '|' + other, mine = !!st.written[okey];   // mine: bu oturumda Tether yazdi
      if (where === 'xform') {
        var bm = await evJson('ppReadKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(tgt.nodeId) + ',' + q('motion') + ')');
        if (bm.ok && (bm.animated || bm.scaleAnimated)) {
          if (!mine && !st.declined[okey] && !window.confirm('Bu klibin Motion animasyonu var (Tether yazmamış olabilir).\nTransform\'a yazarken çift kayma olmaması için Motion animasyonu temizlensin mi?\n\nİptal: Motion\'a dokunulmaz (çift kayma olabilir).')) { st.declined[okey] = true; log(tgt.name + ': UYARI: Motion animasyonu duruyor; Transform ile birlikte çalışır, konum çift kayabilir.'); return null; }
          var orig = st.backups[tgt.nodeId] ? st.backups[tgt.nodeId].info : null, W = tgt.seqW || 1920, H = tgt.seqH || 1080;
          var p = orig ? orig.pos : (tgt.posAnimated ? (tgt.posPx ? [W / 2, H / 2] : [0.5, 0.5]) : tgt.pos);
          var sv = bm.scaleAnimated ? (orig ? Number(orig.scale) : (tgt.scaleAnimated ? 100 : Number(tgt.scale))) : 0;
          var rs = await evJson('ppResetKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + Number(p[0]) + ',' + Number(p[1]) + ',' + q(tgt.nodeId) + ',' + sv + ',' + q('motion') + ')');
          if (rs.ok) { log(tgt.name + ': Motion\'daki animasyon temizlendi (Transform ile çift kayma olmasın).'); delete st.written[okey]; var o = { pos: [p[0], p[1]], posAnimated: false }; if (sv) o.scale = sv; return o; }
        }
      } else {
        var dr = await evJson('ppXfNeutral(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(tgt.nodeId) + ',1)');
        if (dr.ok && dr.changed) {
          if (!mine && !st.declined[okey] && !window.confirm('Klipte animasyonlu / ayarlı bir Transform efekti var (Tether yazmamış olabilir).\nMotion\'a yazarken çift kayma olmaması için etkisiz hale getirilsin mi?\n\nİptal: Transform\'a dokunulmaz (çift kayma olabilir).')) { st.declined[okey] = true; log(tgt.name + ': UYARI: Transform efekti duruyor; Motion ile birlikte çalışır, konum çift kayabilir.'); return null; }
          var rn = await evJson('ppXfNeutral(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(tgt.nodeId) + ')');
          if (rn.ok && rn.changed) { log(tgt.name + ': Transform efekti etkisiz hale getirildi (Motion\'a yazılıyor). İstersen efekti elle silebilirsin.'); delete st.written[okey]; }
        }
      }
    } catch (e) {}
    return null;
  }

  async function applyOne(tgt, follow, idx, live) {
    var where = WHERE(), nkey = tgt.nodeId + '|' + where, tgtB = tgt;
    if (!live || !st.neutral[nkey]) {
      delete st.neutral[tgt.nodeId + '|' + (where === 'xform' ? 'motion' : 'xform')];
      var nb = await neutralizeOther(tgt, where);
      st.neutral[nkey] = nb || true;
      if (nb) tgtB = Object.assign({}, tgt, nb);
    } else if (st.neutral[nkey] !== true) tgtB = Object.assign({}, tgt, st.neutral[nkey]);
    var xfc = where === 'xform' ? xfCtx(tgtB, follow) : null, tgtC = xfc ? xfc.tgt2 : tgtB;
    var r = compute(tgtC, idx > 0 || live), list = r.list, sct = !follow && !!(r.o.scaleTrack && r.zlist && r.zlist.length), dyn = (follow && !!r.o.dynZoom) || sct, keep = follow && $('zoomMode').value === 'keep';
    if (!follow && $('mode').value === 'attach' && $('keepOld').checked && list.length) {   // onceki sahne animasyonu varsa taban konum = yeni araliktan onceki son anahtar
      var bk0 = await evJson('ppReadKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(tgt.nodeId) + ',' + q(where) + ')'), pk = null;
      if (bk0.ok && bk0.animated && bk0.keys && bk0.keys.length) {
        bk0.keys.forEach(function (k) { if (k[0] <= list[0].sec - 1e-6) pk = k; });
        if (pk) {
          var tg3 = xfc ? null : Object.assign({}, tgtB, { pos: [pk[1], pk[2]] });
          if (xfc) { var xfc2 = xfCtx(Object.assign({}, tgtB, { xf: Object.assign({}, tgt.xf || {}, { pos: [pk[1], pk[2]], posPx: !!(tgt.xf && tgt.xf.posPx) }) }), follow); tg3 = xfc2.tgt2; }
          var r2 = compute(tg3, idx > 0 || live);
          if (r2.list && r2.list.length) { r = r2; list = r2.list; }
        }
      }
    }
    var label = tgt.name + ': ', vlog = live ? function () {} : log;
    if (tgt.posPx) vlog('Bilgi: ' + tgt.name + ' konumu piksel olarak tutuyor (grafik klip); değerler piksele çevrilerek yazılacak.');
    if (!list.length) return log(label + 'takip aralığıyla örtüşmüyor (timeline üzerinde aynı zamana denk gelmeli).');
    if (xfc) {   // dizi-normalize konumlari Transform efektinin klip-normalize konumuna cevir
      list.forEach(function (p) { var cv = xfc.conv(p.x, p.y); p.x = cv[0]; p.y = cv[1]; });
      if (follow && r.zlist) r.zlist.forEach(function (z) { z.z = z.z * 100 / xfc.m; });
      var shAng = Number($('shutterAng').value) || 0;
      vlog(label + 'Transform efektine yazılıyor' + (shAng > 0 ? ' (Shutter Angle ' + shAng + '°)' : '') + '.');
      if (tgt.nat && (Math.abs(tgt.nat[0] - r.seqW) > 2 || Math.abs(tgt.nat[1] - r.seqH) > 2)) vlog('UYARI: ' + tgt.name + ' dizi boyutundan farklı (' + tgt.nat[0] + '×' + tgt.nat[1] + '); Motion\'da "Scale to Frame Size" açıksa Transform konumu kayabilir.');
    }
    var a = list[0], b = list[list.length - 1];
    if (r.stats.spikes) vlog(label + r.stats.spikes + ' karelik takip sıçraması düzeltildi.');
    vlog(label + 'ilk (' + Math.round(a.x * r.seqW) + ', ' + Math.round(a.y * r.seqH) + ') px, son (' + Math.round(b.x * r.seqW) + ', ' + Math.round(b.y * r.seqH) + ') px, ' + list.length + ' keyframe');
    if (r.o.vis && r.o.mode === 'snap') vlog(label + 'yazı konumu telafi edildi: (' + Math.round(-r.o.vis[0] * r.seqW) + ', ' + Math.round(-r.o.vis[1] * r.seqH) + ') px');
    var ssz = effectiveSrcSize();
    if (!live && !follow && !$('fit').checked && Number(st.src.scale) === 100 && (Math.abs(ssz[0] - r.seqW) > 2 || Math.abs(ssz[1] - r.seqH) > 2))
      log('İpucu: Kaynak ' + Math.round(ssz[0]) + '×' + Math.round(ssz[1]) + ', sekans ' + r.seqW + '×' + r.seqH + '. Klipte "Scale to Frame Size" açıksa Gelişmiş > "Kareye sığdırılmış"ı işaretle; yoksa hedef, nesneden ' + (ssz[0] > r.seqW ? 'hızlı' : 'yavaş') + ' hareket eder ve kayar.');
    if (!live && st.src && st.src.uniform === false) vlog('Bilgi: Klipte Uniform Scale kapalı; X ve Y ölçeği ayrı hesaba katıldı (' + Math.round(st.src.scaleW || 0) + '% × ' + Math.round(st.src.scale) + '%).' + (follow ? ' Kadraj takibi Scale\'i tek değerle yazar: oran bozulmasın diye Motion > Uniform Scale\'i aç.' : ''));
    if (!live && r.o.place && r.o.place !== 'center' && r.o.mode === 'snap' && !r.track.points.every(function (p) { return p.bn; })) log('Bilgi: Yerleşim (üst/alt/sol/sağ) yalnız Object Mask kutusu olan takipte çalışır; bu takipte merkez kullanıldı.');
    if (!live && !follow && r.o.scaleTrack && r.stats.sizeMissing) log('UYARI: Bu takip verisinde boyut bilgisi yok; Scale takibi yapılmadı (yalnız konum).');
    if (!live && !follow && sct && tgt.uniform === false) log('UYARI: Hedefte Uniform Scale kapalı; Scale yalnız yüksekliği değiştirir. Hedefte Motion > Uniform Scale\'i aç.');
    if (follow && r.stats.clamped && r.stats.clamped >= Math.max(6, 0.05 * list.length)) log('UYARI: Nesne kenara yakın olduğu için ' + r.stats.clamped + ' / ' + list.length + ' karede kadraj kenar sınırına dayandı: nesne pin noktasına getirilemedi, kadraj yerinde duruyor / yalnız dikey oynuyor gibi görünür (takip verisi doğru olsa bile). Çözüm: "Nesne X / Y" konumunu nesnenin bulunduğu kenara kaydır ya da "En çok zoom"u artır.');
    if (!live && follow && !$('fit').checked && Number(st.src.scale) === 100 && (r.seqH > r.seqW) !== (ssz[1] > ssz[0]) && Math.abs(ssz[0] / ssz[1] - r.seqW / r.seqH) > 0.02)
      log('İpucu (dikey / yatay uyumsuzluğu): Dizi ' + r.seqW + '×' + r.seqH + ', kaynak ' + Math.round(ssz[0]) + '×' + Math.round(ssz[1]) + '. Klipte "Scale to Frame Size" açıksa Gelişmiş > "Kareye sığdırılmış"ı işaretle, yoksa kadraj kayar ya da kenarda boşluk kalır. Kadraj takibinde "Otomatik zoom" boşluk bırakmayacak en küçük zoomu bulur.');
    var jumps = jumpCount(r);
    if (jumps) log('UYARI: ' + jumps + ' yerde ani sıçrama var (takip kopmuş olabilir). Yumuşatma artırmayı ya da nesneyi yeniden takip ettirmeyi dene.');
    var zoom = ((follow && !dyn && !keep) ? r.zoom : 0) * (xfc ? 100 / xfc.m : 1);   // keep: Scale'e dokunma
    if (keep) vlog('Yalnız Position: Scale\'e dokunulmuyor (mevcut %' + Math.round(r.zoom) + ' kullanılıyor).');
    if (follow && !dyn) {
      var ss2 = effectiveSrcSize();
      if (ss2[0] * r.zoom / 100 / r.seqW <= 1 || ss2[1] * r.zoom / 100 / r.seqH <= 1)
        log('UYARI: Bu yakınlaştırmada klip kadrajı tam dolduramıyor, kenarlarda boşluk kalır. Yakınlaştırmayı artır, otomatik zoom\'u ya da dinamik zoom\'u aç.');
      if (!keep) vlog('İpucu: Nesne kenara yaklaşınca sabit zoom kamerayı durdurur (nesneye yetişemez). "Otomatik zoom" bunu çözer.');
    }
    if (dyn && r.zlist && r.zlist.length) {
      var zmax = 0; r.zlist.forEach(function (p) { if (p.z > zmax) zmax = p.z; });
      if (r.o.sizeTrack && r.stats.sizeMissing) log('UYARI: Bu takip verisinde boyut (ölçek) bilgisi okunamadı; zoom yalnız kenara göre hesaplandı.');
      vlog(label + (sct ? 'boyut takibi: Scale %' : (r.stats.sizeTracked ? 'boyuta göre zoom: %' : 'dinamik zoom: %')) + Math.round(r.zlist[0].z) + ' → en çok %' + Math.round(zmax) + ', ' + r.zlist.length + ' Scale keyframe');
      if (zmax >= (r.o.zoomMax || 300) - 0.5) log('UYARI: Zoom "En çok zoom" sınırına dayandı; o karelerde kamera nesneyi tam ortada tutamaz. Sınırı artır ya da nesnenin kadraja göre yerini (önizlemede sürükle) kenara kaydır.');
    }
    if (follow && !(Number($('smooth').value) > 0) && !(Number($('dz').value) > 0)) vlog('İpucu: Kamera gibi yumuşak takip için Yumuşatma 3-6 ya da Ölü bölge %5-10 dene.');
    // Geri alma yedeği: YALNIZCA ilk uygulamada (asıl durum). Sonraki uygulamalar yedeği ezmez.
    var bk = await evJson('ppReadKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(tgt.nodeId) + ',' + q(where) + ')'), bkey = tgt.nodeId + (xfc ? '#x' : '');
    if (bk.ok && !live) st.undo.push({ tgt: tgt, info: bk, where: where, scaleTouched: (!!follow && !keep) || sct, batch: st.batch });   // "Geri al": yalniz son uygulamayi geri alir
    if (bk.ok) {
      if (!st.backups[bkey]) st.backups[bkey] = { tgt: tgt, info: bk, where: where, scaleTouched: (!!follow && !keep) || sct };
      else if ((follow && !keep) || sct) st.backups[bkey].scaleTouched = true;
    }
    var tmp = path.join(os.tmpdir(), 'tether_keys_' + idx + '.txt');
    try {
      var pxu = xfc ? xfc.px : tgt.posPx, ux = pxu ? r.seqW : 1, uy = pxu ? r.seqH : 1;   // grafik klipleri konumu piksel olarak tutabilir
      fs.writeFileSync(tmp, list.map(function (p) { return p.sec.toFixed(6) + ',' + (p.x * ux).toFixed(6) + ',' + (p.y * uy).toFixed(6); }).join('\n'), 'utf8');
    } catch (e) { return log('HATA (geçici dosya yazılamadı): ' + e); }
    st.last = { list: list, seqW: r.seqW, seqH: r.seqH };
    var zn = (dyn && r.zlist) ? r.zlist.length : 0;
    var from = 0, total = list.length, res, count = 0, bad = 0, keepArg = $('keepOld').checked ? 1 : 0, holdArg = ((Number(tgt.frameTicks) / TPS_) || 0.02).toFixed(6), whArg = q(where), shArg = xfc ? (Number($('shutterAng').value) || 0) : 0;
    do {
      res = await evJson('ppApplyKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(posix(tmp)) + ',' + q(tgt.nodeId) + ',' + (from === 0 ? zoom : 0) + ',' + from + ',' + CHUNK + ',' + keepArg + ',' + holdArg + ',' + whArg + ',' + shArg + ')');
      if (!res.ok) break;
      count += res.count; bad += res.bad; from += CHUNK;
      progress(Math.min(from, total) / (total + zn));
    } while (from < res.total);
    try { fs.unlinkSync(tmp); } catch (e) {}
    if (!res.ok) return log(label + 'HATA: ' + res.err);
    st.written[tgt.nodeId + '|' + where] = true;
    if (res.verify) vlog(label + (where === 'xform' ? 'Transform' : 'Motion') + ' Position: ' + res.verify.found + '/' + res.verify.want + ' keyframe doğrulandı' + (res.verify.fixed ? ' (' + res.verify.fixed + ' eksik yeniden yazıldı)' : '') + '.');
    if (res.verify && res.verify.found < res.verify.want) log(label + 'UYARI: ' + res.verify.want + ' keyframe istendi, Premiere ' + res.verify.found + ' tanesini tuttu. Günlük\'ü ve Position keyframe\'lerini kontrol et.');
    if (res.shutterNote) log(label + 'UYARI: Shutter Angle tam ayarlanamadı: ' + res.shutterNote + 'Transform efektinde elle ayarla (Use Composition\'s Shutter Angle kapalı, Shutter Angle istediğin değer).');
    var zc = 0;
    if (zn) {
      var tmp2 = path.join(os.tmpdir(), 'tether_scale_' + idx + '.txt'), f2 = 0, rs;
      try { fs.writeFileSync(tmp2, r.zlist.map(function (p) { return p.sec.toFixed(6) + ',' + p.z.toFixed(3); }).join('\n'), 'utf8'); }
      catch (e) { return log('HATA (scale dosyası yazılamadı): ' + e); }
      do {
        rs = await evJson('ppApplyScaleKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(posix(tmp2)) + ',' + q(tgt.nodeId) + ',' + f2 + ',' + CHUNK + ',' + keepArg + ',' + holdArg + ',' + whArg + ')');
        if (!rs.ok) break;
        zc += rs.count; f2 += CHUNK;
        progress((total + Math.min(f2, zn)) / (total + zn));
      } while (f2 < rs.total);
      try { fs.unlinkSync(tmp2); } catch (e) {}
      if (!rs.ok) return log(label + 'Position yazıldı ama Scale HATA: ' + rs.err);
    }
    if (sct && r.zlist && r.zlist.length > 1) {
      var zr0 = r.zlist[0].z, zr1 = r.zlist[r.zlist.length - 1].z, zrt = zr1 / zr0;
      vlog(label + 'Boyut takibi: %' + zr0.toFixed(0) + ' → %' + zr1.toFixed(0) + ' (×' + zrt.toFixed(2) + ').');
      if (zrt > 1.5 || zrt < 0.67) log(label + 'UYARI: Boyut takibi hedefi ×' + zrt.toFixed(2) + ' değiştirdi. Nesne gerçekten o kadar yaklaşmadıysa Boyut takibi kartında kapat ya da Etki (%) değerini düşür.');
    }
    var rc = 0;
    if (r.rlist && r.rlist.length && !follow) {      // Donme takibi: Rotation keyframe'leri (yalniz Kendi takibim verisi)
      var tmp4 = path.join(os.tmpdir(), 'tether_rot_' + idx + '.txt'), f4 = 0, rr;
      try { fs.writeFileSync(tmp4, r.rlist.map(function (p) { return p.sec.toFixed(6) + ',' + p.z.toFixed(3); }).join('\n'), 'utf8'); } catch (e) { return log('HATA (rotasyon dosyası yazılamadı): ' + e); }
      do {
        rr = await evJson('ppApplyScaleKeys(' + q(tgt.startTicks) + ',' + q(tgt.name) + ',' + q(posix(tmp4)) + ',' + q(tgt.nodeId) + ',' + f4 + ',' + CHUNK + ',' + keepArg + ',' + holdArg + ',' + whArg + ',' + q('rot') + ')');
        if (!rr.ok) break; rc += rr.count; f4 += CHUNK;
      } while (f4 < rr.total);
      try { fs.unlinkSync(tmp4); } catch (e) {}
      if (!rr.ok) return log(label + 'Position yazıldı ama Rotation HATA: ' + rr.err);
      if (bk.ok && !live && st.undo.length) st.undo[st.undo.length - 1].rotTouched = true;
    }
    if (r.o.rotTrack && r.stats.rotMissing && !live) log('Bilgi: Döndürme yalnız "Kendi takibim" verisinde var; bu takipte yalnız konum yazıldı.');
    log(label + 'tamam, ' + count + ' keyframe yazıldı' + (zc ? ' + ' + zc + ' Scale keyframe' : '') + (rc ? ' + ' + rc + ' Rotation keyframe' : '') + (bad ? ' (' + bad + ' atlandı)' : '') + '.');
  }

  async function applyAll(live) {
    var follow = $('mode').value === 'follow';
    if (!st.src || !st.tracks.length) return log('Önce klibi seç ve takip et.');
    var targets = follow ? [st.src] : st.tgts;
    if (follow && !live) log('Kadraj takibi: hedef olarak takip edilen klibin kendisi kullanılıyor.');
    if (!targets.length) return log('Önce hedef klibi seç.');
    busy(true);
    if (!live) st.batch++;
    try {
      for (var i = 0; i < targets.length; i++) {
        var tgt = targets[i], md = $('mode').value;
        if (!live && !follow && st.src.nodeId === tgt.nodeId) {
          if (md === 'attach' || md === 'snap') log('UYARI: Hedef ile takip edilen klip aynı. "' + (md === 'attach' ? 'Takip et' : 'Nesnenin üstüne taşı') + '" modu görüntünün kendisini nesneyle birlikte kaydırır. Nesneyi sabit tutmak için "Sabitle", kadrajın ortasında tutmak için "Kadraj takibi" modunu kullan.');
          else log('Aynı klip üzerinde çalışılıyor (nesne sabitlenecek).');
        }
        await applyOne(tgt, follow, i, live);
      }
      await refreshMonitor();
    } finally { busy(false); }
  }
  $('bGo').onclick = function () { return applyAll(false); };

  // ---- Canlı uygula: önizlemede bir şeyi bırakınca / ayar değişince (kısa bekleyip) Premiere'e yazar ----
  var liveT = null, livePending = false;
  function touch() {
    var lv = $('live'); if (!lv || !lv.checked) return;
    clearTimeout(liveT); liveT = setTimeout(runLive, 450);
  }
  function runLive() {
    if (isBusy) { livePending = true; return; }
    if (missing().length) return;
    applyAll(true);
  }

  async function restoreEntry(b) {
    var t = b.tgt, inf = b.info, sv = b.scaleTouched ? Number(inf.scale) : 0, res, wh = q(b.where || 'motion');
    if (inf.animated && inf.keys.length) {
      var tmp = path.join(os.tmpdir(), 'tether_undo.txt');
      fs.writeFileSync(tmp, inf.keys.map(function (k) { return k[0].toFixed(6) + ',' + k[1].toFixed(6) + ',' + k[2].toFixed(6); }).join('\n'), 'utf8');
      res = await evJson('ppApplyKeys(' + q(t.startTicks) + ',' + q(t.name) + ',' + q(posix(tmp)) + ',' + q(t.nodeId) + ',' + sv + ',0,1000000,0,0.02,' + wh + ',0)');
      try { fs.unlinkSync(tmp); } catch (e) {}
    } else {
      res = await evJson('ppResetKeys(' + q(t.startTicks) + ',' + q(t.name) + ',' + Number(inf.pos[0]) + ',' + Number(inf.pos[1]) + ',' + q(t.nodeId) + ',' + sv + ',' + wh + ')');
    }
    // Klibin kendi Scale animasyonu vardiysa onu da geri yaz
    if (res.ok && b.scaleTouched && inf.scaleAnimated && inf.scaleKeys && inf.scaleKeys.length) {
      var tmp3 = path.join(os.tmpdir(), 'tether_undo_scale.txt');
      fs.writeFileSync(tmp3, inf.scaleKeys.map(function (k) { return k[0].toFixed(6) + ',' + Number(k[1]).toFixed(4); }).join('\n'), 'utf8');
      res = await evJson('ppApplyScaleKeys(' + q(t.startTicks) + ',' + q(t.name) + ',' + q(posix(tmp3)) + ',' + q(t.nodeId) + ',0,1000000,0,0.02,' + wh + ')');
      try { fs.unlinkSync(tmp3); } catch (e) {}
    }
    if (res.ok && b.rotTouched) {
      if (inf.rotAnimated && inf.rotKeys && inf.rotKeys.length) {
        var tmp5 = path.join(os.tmpdir(), 'tether_undo_rot.txt');
        fs.writeFileSync(tmp5, inf.rotKeys.map(function (k) { return k[0].toFixed(6) + ',' + Number(k[1]).toFixed(4); }).join('\n'), 'utf8');
        await evJson('ppApplyScaleKeys(' + q(t.startTicks) + ',' + q(t.name) + ',' + q(posix(tmp5)) + ',' + q(t.nodeId) + ',0,1000000,0,0.02,' + wh + ',' + q('rot') + ')');
        try { fs.unlinkSync(tmp5); } catch (e) {}
      } else await evJson('ppResetRot(' + q(t.startTicks) + ',' + q(t.name) + ',' + q(t.nodeId) + ',' + Number(inf.rot || 0) + ',' + wh + ')');
    }
    return res;
  }
  $('bUndo').onclick = async function () {
    busy(true);
    try {
      if (st.undo.length) {                       // yalniz SON uygulamayi geri al (onceki sahnelere dokunma)
        var bt = st.undo[st.undo.length - 1].batch, ents = st.undo.filter(function (e) { return e.batch === bt; });
        st.undo = st.undo.filter(function (e) { return e.batch !== bt; });
        for (var u = ents.length - 1; u >= 0; u--) {
          var rs = await restoreEntry(ents[u]);
          log(rs.ok ? ents[u].tgt.name + ': son uygulama geri alındı.' : ents[u].tgt.name + ': HATA: ' + rs.err);
        }
        await refreshMonitor(); return;
      }
      var ids = Object.keys(st.backups);
      if (!ids.length) return log('Geri alınacak uygulama yok (bu panel oturumunda yedek alınmadı).');
      for (var i = 0; i < ids.length; i++) {
        var res = await restoreEntry(st.backups[ids[i]]);
        log(res.ok ? st.backups[ids[i]].tgt.name + ': ilk haline dönüldü.' : st.backups[ids[i]].tgt.name + ': HATA: ' + res.err);
        if (res.ok) delete st.backups[ids[i]];
      }
      await refreshMonitor();
    } finally { busy(false); }
  };

  $('bReset').onclick = async function () {
    var follow = $('mode').value === 'follow';
    var targets = follow && st.src ? [st.src] : st.tgts;
    if (!targets.length) return log('Önce hedef klibi seç.');
    if (!window.confirm('Hedefin animasyonu silinsin ve orijinal değere dönülsün mü?')) return;
    busy(true);
    try {
      for (var i = 0; i < targets.length; i++) {
        var wh0 = WHERE(), t = targets[i], bk = st.backups[t.nodeId + (wh0 === 'xform' ? '#x' : '')];
        var p = bk ? bk.info.pos : (wh0 === 'xform' ? ((t.xf && t.xf.pos) || [0.5, 0.5]) : t.pos);                                   // asıl (Tether öncesi) konum
        var sv = (bk && bk.scaleTouched) ? Number(bk.info.scale) : ((follow && $('zoomMode').value !== 'keep' && !bk) ? Number(st.src.scale) : 0);
        var res = await evJson('ppResetKeys(' + q(t.startTicks) + ',' + q(t.name) + ',' + Number(p[0]) + ',' + Number(p[1]) + ',' + q(t.nodeId) + ',' + sv + ',' + q(wh0) + ')');
        log(res.ok ? t.name + ': animasyon silindi, orijinal değere dönüldü.' + (wh0 === 'xform' ? ' (Transform efekti)' : '') : t.name + ': HATA: ' + res.err);
        if (res.ok) delete st.backups[t.nodeId + (wh0 === 'xform' ? '#x' : '')];
      }
      await refreshMonitor();
    } finally { busy(false); }
  };

  $('bCsv').onclick = function () {
    if (!st.last) return log('Önce "Uygula" ile bir sonuç üret.');
    try {
      var f = path.join(outDir(), 'tether_keys.csv');
      fs.writeFileSync(f, 'sn,x_px,y_px\n' + st.last.list.map(function (p) { return p.sec.toFixed(4) + ',' + (p.x * st.last.seqW).toFixed(2) + ',' + (p.y * st.last.seqH).toFixed(2); }).join('\n'), 'utf8');
      log('CSV yazıldı: ' + f);
    } catch (e) { log('HATA: ' + e); }
  };

  $('bRaw').onclick = function () {
    if (!st.tracks.length) return log('Önce klibi seç ve takip et.');
    try {
      var t = st.tracks[0], n = (t.points[0].raw || []).length, h = ['sn'], i;
      for (i = 0; i < n; i++) h.push('f' + i);
      var rows = t.points.map(function (p) { return (p.tl - t.clipStartSec).toFixed(4) + ',' + (p.raw || []).map(function (v) { return +v.toFixed(5); }).join(','); });
      var f = path.join(outDir(), 'tether_ham_takip.csv');
      fs.writeFileSync(f, h.join(',') + '\n' + rows.join('\n'), 'utf8');
      log('Ham takip verisi yazıldı: ' + f + ' (' + t.points.length + ' kare, ' + n + ' değer). Bu dosyayı bana gönder: ölçek/döndürme sütunlarını bulup onları da takibe katarım.');
    } catch (e) { log('HATA: ' + e); }
  };
  $('bDiagCopy').onclick = function () {
    renderDiag();
    var txt = (st.diagRows || []).map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
    try { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); log('Diagnostics panoya kopyalandı.'); }
    catch (e) { log('HATA: kopyalanamadı: ' + e); }
  };
  $('bProbe').onclick = async function () {
    busy(true);
    try {
      var r = await evJson('ppProbe()');
      if (!r.ok) return log('HATA: ' + r.err);
      var f = path.join(outDir(), 'tether_canli.txt');
      fs.writeFileSync(f, r.text.split('@@').join('\n'), 'utf8');
      log('Canlı teşhis yazıldı: ' + f + ' (' + r.text.split('@@').length + ' satır). Bu dosyayı da bana gönder.');
    } catch (e) { log('HATA: ' + e); } finally { busy(false); }
  };
  $('bDbg').onclick = function () {
    if (!st.tracks.length) return log('Önce klibi seç ve takip et.');
    try {
      var f = path.join(outDir(), 'tether_debug.json');
      fs.writeFileSync(f, JSON.stringify({ src: st.src, tgts: st.tgts, track: st.tracks[0] }, null, 1), 'utf8');
      log('Debug dosyası yazıldı: ' + f);
    } catch (e) { log('HATA: ' + e); }
  };
  $('mode').addEventListener('change', updateReady);
  updateReady(); renderDiag();
  window.MT = { own: own, st: st, compute: compute, previewTarget: previewTarget, save: saveSettings, touch: touch };
  // ===== v2.16 (TEST): guncelleyici arayuzu. Hatalar paneli bozmaz. Otomatik kurulum acikken Premiere kapatilmaz: kurulumdan sonra panel kendini yeniler (calisma varsa kullanici onayi beklenir). =====
  (function () {
    var U = window.TetherUpdater, upd = null, last = null, busy = false;
    try { if (U) upd = U.create({}); } catch (e) { upd = null; }
    function um(t, lvl) { var m = $('updMsg'); if (m) { m.textContent = t; m.style.color = lvl === 'err' ? 'var(--er)' : (lvl === 'ok' ? 'var(--ok)' : (lvl === 'warn' ? 'var(--wn)' : '')); } }
    // Ustteki ince bar: tek yer, tek mesaj. pct: 0-100 ya da null (ilerleme cizgisi yok). btn: {t, f} ya da null.
    function bar(t, pct, btn) {
      var b = $('updBar'); if (!b) return; if (t == null) { b.classList.add('hidden'); return; }
      b.classList.remove('hidden'); $('updBarTxt').textContent = t; $('updBarPct').textContent = pct == null ? '' : '%' + Math.round(pct); $('updBarFill').style.width = (pct == null ? 0 : pct) + '%';
      var bb = $('updBarBtn'); bb.classList.toggle('hidden', !btn); if (btn) { bb.textContent = btn.t; bb.onclick = btn.f; }
    }
    var bt = window.TetherUpdaterBoot;
    if (bt && bt.message) { um(bt.message, 'warn'); log('UYARI: Güncelleyici: ' + bt.message); bar(bt.message, null, { t: 'Tamam', f: function () { bar(null); } }); }
    window.__tetherMarkHealthy = function () { try { if (upd) upd.markHealthy(); else if (U) U.create({}).markHealthy(); } catch (e) {} };
    if (!upd) { um('Güncelleyici yüklenemedi (panelin diğer özellikleri çalışır).', 'err'); return; }
    function idle() { return !own.running && !own.frames && !own.rect && !(st.tracks && st.tracks.length) && !st.busy; }   // kutu cizilmis / kare yuklenmis / takip varsa panel kendiliginden YENILENMEZ (calisma kaybi ve beyaz ekran olmasin)
    // Kurulumdan sonra: host.jsx yeniden yuklenir (ExtendScript tarafi yeni kodla calissin), sonra panel kendini yeniler; Premiere kapanmaz.
    async function reloadPanel() {
      bar('Panel yenileniyor…', 100);
      try { await ev("$.evalFile('" + extDir().replace(/\\/g, '/').replace(/'/g, "\\'") + "/jsx/host.jsx')"); } catch (e) {}
      setTimeout(function () { location.reload(); }, 600);
    }
    async function install(r) {
      if (busy2) return; busy2 = true;
      try {
        bar('Yeni sürüm v' + r.latest + ' indiriliyor…', 0);
        var d = await upd.downloadAndVerify(r, function (g, t) { bar('Yeni sürüm v' + r.latest + ' indiriliyor…', t ? Math.min(90, 90 * g / t) : null); });
        if (!d.ok) { bar('Güncelleme kurulmadı: ' + d.message, null, { t: 'Tamam', f: function () { bar(null); } }); log('Güncelleyici: ' + d.code + ': ' + d.message); return; }
        bar('Doğrulandı, kuruluyor…', 95);
        var r2 = upd.install(d.files, extDir(), PLUGIN_VERSION, r.latest);
        if (!r2.ok) { bar('Güncelleme kurulmadı: ' + r2.message, null, { t: 'Tamam', f: function () { bar(null); } }); log('Güncelleyici: ' + r2.message); return; }
        log('Güncelleyici: v' + r.latest + ' kuruldu (' + r2.written + ' dosya). Yedek: ' + r2.backupDir); um('v' + r.latest + ' kuruldu.', 'ok');
        if (idle()) await reloadPanel();
        else bar('v' + r.latest + ' kuruldu. Çalışmanı kaybetmemen için panel henüz yenilenmedi.', 100, { t: 'Şimdi yenile', f: reloadPanel });
      } catch (e) { bar('Güncelleme hatası: ' + (e && e.message || e), null, { t: 'Tamam', f: function () { bar(null); } }); } finally { busy2 = false; }
    }
    var busy2 = false;
    async function check(silent) {
      if (busy) return; busy = true; var b = $('bUpdCheck'); if (b) b.disabled = true; if (!silent) um('Denetleniyor…');
      try {
        var r = await upd.checkLatest(PLUGIN_VERSION); last = r;
        if (r.state === 'uptodate') um('Güncel: v' + PLUGIN_VERSION + ' (en son sürüm).', 'ok');
        else if (r.state === 'available') {
          log('Güncelleyici: yeni sürüm v' + r.latest + (r.canInstall ? ' kurulabilir.' : ' kurulamaz: ' + r.reason));
          if (!r.canInstall) um('Yeni sürüm var: v' + r.latest + '. Kurulamıyor: ' + r.reason, 'err');
          else if (ac && ac.checked) { um('Yeni sürüm v' + r.latest + ' kuruluyor…', 'warn'); install(r); }
          else { um('Yeni sürüm var: v' + r.latest, 'warn'); bar('Yeni sürüm var: v' + r.latest, null, { t: 'Güncelle', f: function () { install(r); } }); }
        } else { if (!silent) um('Denetim başarısız: ' + r.message, 'err'); log('Güncelleyici: denetim başarısız (' + r.code + '): ' + r.message); }
      } catch (e) { if (!silent) um('Denetim hatası: ' + (e && e.message || e), 'err'); }
      finally { busy = false; if (b) b.disabled = false; }
    }
    var ac = $('updAuto');
    $('bUpdCheck') && ($('bUpdCheck').onclick = function () { check(false); });
    try { if (ac) { ac.checked = upd.readState().autoCheck !== false; ac.onchange = function () { upd.setAutoCheck(ac.checked); }; } } catch (e) {}
    // Açılışta her seferinde denetle (tek hafif istek). Otomatik kurma kapalıysa yalnız haber verir (üstte "Güncelle" barı), kurmaz.
    try { setTimeout(function () { check(true); }, 3000); } catch (e) {}
  })();
  log('Hazır. Tether v' + PLUGIN_VERSION);
  try { if (window.__tetherMarkHealthy) window.__tetherMarkHealthy(); } catch (e) {}   // v2.15: main.js hatasiz sonuna kadar calistiysa acilis sagliklidir (erken kapatma yanlis geri almaya yol acmasin)
})();

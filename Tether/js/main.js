(function () {
  var cs = window.__adobe_cep__;
  var fs, zlib, os, path;
  try { fs = require('fs'); zlib = require('zlib'); os = require('os'); path = require('path'); } catch (e) {}
  var $ = function (id) { return document.getElementById(id); };
  var st = { src: null, tgts: [], tracks: [], xml: null, backups: {}, last: null, undo: [], batch: 0, neutral: {}, written: {}, declined: {} };
  var CHUNK = 200;
  var SAVE_IDS = ['mode', 'fit', 'step', 'smooth', 'tol', 'despike', 'pinX', 'pinY', 'zoom', 'zoomMax', 'zoomMode', 'sizeTrack', 'sizeStr', 'autoZoom', 'dz', 'offX', 'offY', 'ref', 'txtComp', 'plc', 'plcGap', 'scTrack', 'scStr', 'omFix', 'keepOld', 'applyTo', 'shutterAng', 'preset', 'rotTrack', 'ownModel'];

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
  var BTNS = ['bSrc', 'bTgt', 'bGo', 'bUndo', 'bReset', 'bCsv', 'bDbg', 'bRaw', 'bScan', 'bProbe', 'bFind', 'bOmUse', 'bOmReport', 'bOmCache', 'bDiagCopy'];
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
  ['srcW', 'srcH', 'selMask'].forEach(function (id) { $(id).addEventListener('change', touch); });
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
  var PLUGIN_VERSION = '2.12.3';
  var OM = window.ObjectMask || null;                 // yoksa (yuklenemediyse) eski akisla devam edilir
  st.diag = { api: null, detection: null, locate: null, parse: null, projectPath: '', xml: null };
  st.omCand = null;
  var TPS_ = (window.MaskParser && MaskParser.TPS) || 254016000000;
  var LV = { ok: '✓', warn: '⚠', err: '✕' };
  function fmtDur(sec) { if (!isFinite(sec) || sec < 0) return '—'; var m = Math.floor(sec / 60), s = sec - m * 60; return (m ? m + ' dk ' : '') + s.toFixed(1) + ' sn'; }

  var stageEls = [];
  function stagesInit(texts) {
    var ol = $('stages'); ol.innerHTML = ''; stageEls = [];
    texts.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; li.setAttribute('data-t', t); ol.appendChild(li); stageEls.push(li); });
    ol.classList.remove('hidden');
  }
  function stage(i, state, text) {
    var li = stageEls[i]; if (!li) return;
    li.className = state || ''; if (text) li.textContent = text;
  }
  function stagesDone(text) {
    var li = document.createElement('li'); li.className = 'ok'; li.textContent = text; $('stages').appendChild(li); stageEls.push(li);
  }
  function setCell(id, html, cls) { var e = $(id); if (!e) return; e.innerHTML = html; e.className = cls || ''; }
  function renderGrid(g) {
    $('stGrid').classList.remove('hidden');
    setCell('gSrc', g.src ? '<b>' + esc(g.src) + '</b>' : '—');
    setCell('gMask', (g.mask && g.mask.length) ? g.mask.map(function (l) { return '<div class="' + l.level + '">' + LV[l.level] + ' ' + esc(l.text) + '</div>'; }).join('') : '—');
    setCell('gStatus', g.status ? LV[g.status.level] + ' ' + esc(g.status.text) : '—', g.status ? g.status.level : '');
    setCell('gData', g.data ? LV[g.data.level] + ' ' + esc(g.data.text) : '—', g.data ? g.data.level : '');
    setCell('gTrk', g.trk ? LV[g.trk.level] + ' ' + esc(g.trk.text) : '—', g.trk ? g.trk.level : '');
    setCell('gRange', g.range ? LV[g.range.level] + ' ' + esc(g.range.text) : '—', g.range ? g.range.level : '');
    setCell('gKf', g.kf === undefined || g.kf === null ? '—' : String(g.kf));
    setCell('gDur', g.dur || '—');
    setCell('gQual', g.q ? LV[g.q.level === 'good' ? 'ok' : g.q.level === 'warn' ? 'warn' : 'err'] + ' ' + esc(g.q.text) : '—', g.q ? (g.q.level === 'good' ? 'ok' : g.q.level === 'warn' ? 'warn' : 'err') : '');
  }
  function showErr(e, extraHint) {
    var box = $('errBox');
    if (!e) { box.classList.add('hidden'); return; }
    $('errTitle').textContent = e.title;
    $('errDetail').textContent = (e.hint ? e.hint + '\n' : '') + (extraHint ? extraHint + '\n' : '') + (e.detail ? '\nDetails:\n' + e.detail : '');
    box.classList.remove('hidden'); box.open = false;
  }
  function resetStatus() {
    st.omCand = null; showErr(null); $('omBox').classList.add('hidden');
    $('stGrid').classList.add('hidden'); st.diag = { api: null, detection: null, locate: null, parse: null, projectPath: '', xml: null };
  }
  // bir asamada hata: asama + durum satiri + hata kutusu + gunluk
  function failAt(i, code, detail, headline) {
    var e = OM ? OM.errors.make(code, detail) : { code: code, title: String(detail || code), hint: '', detail: '' };
    stage(i, 'err', e.title); showErr(e);
    setInfo('srcInfo', (headline ? headline + '<br>' : '') + esc(e.title) + '. ' + esc(e.hint), 'err');
    log('HATA: ' + e.title + (detail ? ' (' + String(detail).split('\n')[0] + ')' : ''));
    renderDiag();
  }
  function qualityCell(track) {
    if (!track || !window.MaskParser || !MaskParser.quality) return null;
    var q = MaskParser.quality(track.points), lbl = q.level === 'good' ? 'İyi' : q.level === 'warn' ? 'Uyarı' : 'Sorun';
    return { level: q.level, text: lbl + (q.issues.length ? ' — ' + q.issues.join(', ') : ''), raw: q };
  }
  function currentGrid() {
    var c = st.src, d = st.diag.detection, t = st.tracks[Number($('selMask').value) || 0] || null;
    var g = { src: c ? c.name + (c.nat ? ' (' + c.nat[0] + '×' + c.nat[1] + ')' : '') + (c.uniform === false ? ' · Uniform Scale kapalı (' + Math.round(c.scaleW || 0) + '% × ' + Math.round(c.scale) + '%)' : '') : '', mask: d ? d.lines.slice() : [], kf: t ? t.points.length : (d ? 0 : null), q: null };
    if (t && t.kind === 'object' && t.unverified) g.mask = [{ level: 'ok', text: 'Object Mask — ' + t.points.length + ' keyframe (dosyadan)' }];
    // Object Mask: Algılama -> Veri (PRMF) -> Takip  (ayrı ayrı)
    var isObj = (d && (d.state === 'object-nodata' || d.state === 'object-ok')) || (t && t.kind === 'object');
    if (isObj) {
      var lc2 = st.diag.locate, nf = lc2 ? lc2.files.filter(function (f) { return !f.isDir; }).length : 0, pp = st.diag.parse;
      g.data = nf ? { level: 'ok', text: 'PRMF bulundu (' + nf + ' dosya)' } : (d.state === 'object-ok' ? { level: 'ok', text: 'Projede' } : { level: 'warn', text: lc2 ? 'PRMF bulunamadı' : 'Aranmadı' });
      g.trk = (t && t.kind === 'object' && t.unverified) ? { level: 'ok', text: 'Okundu: ' + t.points.length + ' kare · önizlemeyi kontrol et' } : (pp && pp.ok ? { level: 'ok', text: 'Okundu · uygulamaya hazır' } : (nf ? { level: 'warn', text: 'Veri biçimi desteklenmiyor' } : (d.state === 'object-ok' ? { level: 'ok', text: t ? t.points.length + ' keyframe' : 'Okundu' } : { level: 'err', text: 'Takip verisi yok' })));
    }
    var rg = t && t.range ? t.range : (st.omCand && st.omCand.range ? st.omCand.range : null); if (isObj && rg) g.range = rg;
    var dur = c ? (Number(c.endTicks) - Number(c.startTicks)) / TPS_ : NaN;
    g.dur = fmtDur(dur) + (t && t.points.length > 1 ? ' · takip ' + fmtDur(t.points[t.points.length - 1].tl - t.points[0].tl) : '');
    if (t) { g.status = t.unverified ? { level: 'ok', text: 'Dosya verisi okundu' } : { level: 'ok', text: t.points.length + ' keyframe okundu' }; g.q = qualityCell(t); }
    else if (d && d.state === 'object-nodata') g.status = { level: 'warn', text: 'Takip verisi erişilemiyor' };
    else if (d && d.state === 'untracked') g.status = { level: 'warn', text: 'Maske takip edilmemiş' };
    else if (d && d.state === 'none') g.status = { level: 'err', text: 'Maske bulunamadı' };
    return g;
  }
  function refreshStatus() { if (st.src && (st.diag.detection || st.tracks.length)) renderGrid(currentGrid()); }

  function diagCtx() { return { pluginVersion: PLUGIN_VERSION, api: st.diag.api, projectPath: st.diag.projectPath, selection: st.src, detection: st.diag.detection, locate: st.diag.locate, parse: st.diag.parse, range: st.diag.range }; }
  function renderDiag() {
    var dl = $('diagGrid'); if (!dl) return; dl.innerHTML = '';
    var rows = OM ? OM.diagnostics.summary(diagCtx()) : [['Eklenti sürümü', PLUGIN_VERSION], ['Object Mask modülü', 'yüklenemedi']];
    rows.forEach(function (r) { var a = document.createElement('dt'), b = document.createElement('dd'); a.textContent = r[0]; b.textContent = r[1]; dl.appendChild(a); dl.appendChild(b); });
    st.diagRows = rows;
  }
  function writeOmReport(quiet) {
    if (!OM) return null;
    try {
      var f = path.join(outDir(), 'tether_objectmask_rapor.txt');
      fs.writeFileSync(f, OM.diagnostics.build(diagCtx()), 'utf8');
      if (!quiet) log('Object Mask raporu yazıldı: ' + f);
      return f;
    } catch (e) { log('HATA: rapor yazılamadı: ' + e); return null; }
  }

  $('bSrc').onclick = async function () {
    busy(true); resetStatus();
    stagesInit(['Klip analiz ediliyor…', 'Maskeler algılanıyor…', 'Takip verisi okunuyor…', 'Keyframe\'ler işleniyor…']);
    try {
      stage(0, 'run'); setInfo('srcInfo', 'Okunuyor…', '');
      var c = await evJson('ppGetSelection()');
      if (!c.ok) return failAt(0, OM ? OM.errors.classify(c.err) : 'NO_CLIP', c.err);
      if (!fs) return failAt(0, 'NODE_MISSING', 'Node.js erişimi yok (manifest --enable-nodejs)');
      st.src = c; st.tracks = []; st.xml = null; mark('card1', false);
      $('srcW').value = c.nat ? c.nat[0] : c.seqW;
      $('srcH').value = c.nat ? c.nat[1] : c.seqH;
      setInfo('srcInfo', '<b>' + esc(c.name) + '</b><br>Analiz ediliyor…', '');
      var rb = restoreBase(c);
      if (!rb && (c.posAnimated || c.scaleAnimated)) log('UYARI: Klibin Position/Scale değeri animasyonlu. Sadece ilk keyframe değeri kullanılır; sonuç kayabilir.');
      if (!c.nat) log('Bilgi: Kaynak boyutu okunamadı, sekans boyutu varsayıldı. Gerekirse Gelişmiş bölümünden elle gir.');
      // Premiere API tanilamasi (zorunlu degil: eski/yeni surumlerde calismazsa sadece "sinir" olarak raporlanir)
      var api = await evJson('ppDiag()');
      if (!api || (api.ok === false && /Yanıt okunamadı/.test(api.err || ''))) api = { ok: false, err: 'ppDiag çalışmadı', limits: ['bu Premiere sürümünde tanılama betiği çalışmadı'] };
      st.diag.api = api; if (api.limits && api.limits.length) log('Bilgi: Premiere API sınırı: ' + api.limits.slice(0, 3).join('; '));
      log('Proje kaydediliyor...');
      var s = await evJson('ppSaveProject()');
      if (!s.ok) return failAt(0, OM ? OM.errors.classify(s.err) : 'PROJECT_NOT_SAVED', s.err, '<b>' + esc(c.name) + '</b>');
      st.diag.projectPath = s.path;
      var xml;
      try { xml = zlib.gunzipSync(fs.readFileSync(s.path)).toString('utf8'); st.xml = xml; st.diag.xml = xml; }
      catch (e) { return failAt(0, 'PROJECT_READ', e && (e.stack || e), '<b>' + esc(c.name) + '</b>'); }
      stage(0, 'ok', 'Klip: ' + c.name + (api.version ? ' · Premiere ' + api.version : ''));

      // --- maske algilama ---
      stage(1, 'run');
      var det = null;
      if (OM) { try { det = OM.detector.detect(xml, Number(c.startTicks), c.name, api); } catch (e) { log('UYARI: algılama hatası: ' + e); } }
      st.diag.detection = det;
      try { st.tracks = MaskParser.findTracks(xml, Number(c.startTicks), c.name); }
      catch (e) { st.tracks = []; renderDiag(); return failAt(1, 'PARSER_ERROR', e && (e.stack || e), '<b>' + esc(c.name) + '</b>'); }
      if (det) {
        var worst = det.lines.some(function (l) { return l.level === 'err'; }) ? 'err' : (det.lines.some(function (l) { return l.level === 'warn'; }) ? 'warn' : 'ok');
        stage(1, worst, 'Maskeler: ' + det.lines.map(function (l) { return l.text; })[0] + (det.lines.length > 1 ? ' (+' + (det.lines.length - 1) + ')' : ''));
        det.lines.forEach(function (l) { log((l.level === 'ok' ? '' : l.level === 'warn' ? 'UYARI: ' : 'Bilgi: ') + l.text); });
      } else stage(1, 'ok', 'Maskeler aranıdı');
      // proje icinde okunan tracker'lari tur etiketiyle isaretle
      if (det) {
        var readable = det.masks.filter(function (m) { return m.keyframes > 0; });
        st.tracks.forEach(function (t, i) { var m = readable[i]; if (m && m.keyframes === t.points.length) { t.kind = m.kind; t.shape = m.shape; } t.source = 'proje'; });
      }

      // --- takip verisi ---
      stage(2, 'run');
      if (st.tracks.length) stage(2, 'ok', 'Takip verisi projede okundu (' + st.tracks.length + ' maske, ' + st.tracks[0].points.length + ' kare)');
      else if (det && det.state === 'object-nodata' && OM) {
        stage(2, 'run', 'Object Mask veri dosyası aranıyor…');
        var projDir = ''; try { projDir = path.dirname(s.path); } catch (e0) {}
        var lc = null;
        try { lc = await OM.reader.locate({ guids: det.guids, projectDir: projDir, xml: xml, onStage: function (t) { stage(2, 'run', 'Object Mask: ' + t); } }); }
        catch (e) { log('UYARI: dosya araması hatası: ' + e); }
        st.diag.locate = lc;
        var files = lc ? lc.files.filter(function (f) { return !f.isDir; }) : [], pr = null, pf = null;
        stage(2, 'run', 'Object Mask veri dosyası çözülüyor…');
        try { pf = OM.parser.parseFiles(files.map(function (f) { return f.path; })); pr = pf.best; } catch (e3) { log('UYARI: PRMF çözme hatası: ' + e3); }
        st.diag.tried = pf ? pf.tried : [];
        if (pr) {
          var timing = MaskParser.clipTiming(xml, Number(c.startTicks), c.name);
          if (!timing) { st.diag.parse = { ok: false, reason: 'klip zamanlaması projeden çözülemedi' }; stage(2, 'warn', 'Dosya eşleşti ama klip zamanlaması çözülemedi'); }
          else {
            // PRMF zamanları klip-bağıl (ilk kare = 0): kaynak zamanına klibin In noktası eklenir (doğrulanamayan varsayım)
            // PRMF tick'leri KAYNAK MEDYA zamanıdır (kırpılmış klipte kanıtlandı: InPoint 50 kare + 10 kare = ilk tick 60 kare). InPoint eklenmez.
            var rf0 = ($('omFix') && !$('omFix').checked) ? null : OM.refine(pr.points);
            var srcPts = rf0 ? rf0.points : pr.points;
            var nUse = srcPts.length, trimTxt = (rf0 && (rf0.trimmedHead || rf0.trimmedTail)) ? ' Güvenilmez ' + (rf0.trimmedHead + rf0.trimmedTail) + ' kare (nesne kaybı / ani sıçrama) kırpıldı.' : '';
            var mapped = MaskParser.mapSourcePoints(timing, srcPts);
            var rng = OM.coverage ? OM.coverage(srcPts, timing) : null;
            var over = mapped.filter(function (p) { return p.tl > timing.end / TPS_ + 0.002; }).length;
            st.omCand = { points: mapped, file: pr.path, parserLabel: pr.parserLabel, clipStartSec: timing.start / TPS_, clipEndSec: timing.end / TPS_, relTime: !!pr.relTime, range: rng };
            st.diag.parse = { ok: true, parserLabel: pr.parserLabel, points: pr.points, file: pr.path };
            st.diag.range = rng;
            stage(2, rng && !rng.full ? 'warn' : 'ok', 'Object Mask takibi okundu: ' + nUse + ' kare' + (rng ? ' (' + rng.text + ')' : ''));
            $('omMsg').textContent = 'Object Mask takibi hazır: ' + nUse + ' kare' + (rng ? ' · ' + rng.text : '') + '.' + trimTxt + ' Konum, nesne kutusunun merkezidir. Uygulamadan önce önizlemede kutunun nesneyi izlediğini kontrol et; yanlışsa Geri al.' + (pr.meta && pr.meta.lostFrames ? ' Premiere takipte nesneyi kaybetti (' + pr.meta.lostFrames + ' yerde); o karelerden sonrası takip dışı. Premiere\'de maskeyi nesne net görünen bir karede baştan çizip tekrar takip ettirirsen daha uzun takip alabilirsin.' : '') + (rng && !rng.full ? ' Takip dışı kalan karelerde hareket ilk/son bilinen konumda sabit kalır.' : '') + (over ? ' UYARI: ' + over + ' kare klip süresinin dışına düşüyor.' : '');
            $('omBox').className = 'ombox ' + (rng && !rng.full ? 'warn' : 'info');
            $('omBox').classList.remove('hidden');
            log('Object Mask dosyasından ' + nUse + '/' + pr.points.length + ' kare kullanılıyor: ' + pr.path + (rng ? ' · ' + rng.text : '') + (over ? ' · ' + over + ' kare klip dışında' : ''));
          }
        } else {
          var reason = files.length ? (pf && pf.tried.some(function (t) { return t.error; }) ? 'dosya bulundu ama ayrıştırma hatası' : 'dosya bulundu ama biçimi tanınmadı veya doğrulanamadı') : 'veri dosyası bulunamadı';
          st.diag.parse = { ok: false, reason: reason + (pf && pf.tried.length ? ' · ' + pf.tried.map(function (t) { return t.reason; }).filter(Boolean).join(' | ') : '') };
          stage(2, 'warn', 'Object Mask: ' + reason);
          var rf = writeOmReport(true);
          log('UYARI: Object Mask — ' + reason + (lc ? ' (' + lc.searched.map(function (x) { return x.stage + ': ' + x.scanned + ' öğe'; }).join(', ') + (lc.fromCache ? ', önbellekten ' + lc.fromCache : '') + ')' : ''));
          if (rf) log('Object Mask raporu yazıldı: ' + rf + ' — bu dosyayı bana gönder; biçim çözülebilirse çözücü eklerim.');
          var perr = pf && pf.tried.filter(function (t) { return t.error; })[0];
          showErr(OM.errors.make(perr ? 'PARSER_ERROR' : (files.length ? 'OM_UNSUPPORTED_FORMAT' : 'OM_FILE_NOT_FOUND'), lc ? lc.searched.map(function (x) { return x.stage + ': ' + x.scanned + ' öğe, ' + x.ms + ' ms'; }).join('\n') + (files.length ? '\n' + (pf ? pf.tried.map(function (t) { return t.path + ' → ' + (t.reason || (t.error && t.error.detail) || '?'); }) : files.map(function (f) { return f.path; })).join('\n') : '') : ''),
            OM.errors.ERR.OM_NO_DATA.hint);
        }
      } else if (det && det.state === 'untracked') { stage(2, 'warn', 'Maske takip edilmemiş, okunacak veri yok'); showErr(OM.errors.make('MASK_UNTRACKED')); }
      else { stage(2, 'warn', 'Okunacak takip verisi yok'); if (OM && det) showErr(OM.errors.make(det.state === 'none' ? 'NO_MASK' : 'MASK_UNTRACKED')); }

      // --- keyframe isleme ---
      stage(3, 'run');
      var sel = $('selMask'); sel.innerHTML = '';
      st.tracks.forEach(function (t, i) {
        var o = document.createElement('option');
        o.value = i; o.textContent = 'Maske ' + (i + 1) + ' - ' + t.points.length + ' kare'; sel.appendChild(o);
      });
      var mr = $('maskRow'); if (mr && mr.classList) mr.classList.toggle('hidden', st.tracks.length < 2);
      mark('card1', st.tracks.length > 0);
      refreshPreview(false);
      if (st.tracks.length) {
        var q0 = qualityCell(st.tracks[0]);
        stage(3, q0 && q0.level !== 'good' ? 'warn' : 'ok', st.tracks[0].points.length + ' keyframe işlendi' + (q0 ? ' · takip kalitesi: ' + q0.text.split(' — ')[0] : ''));
        setInfo('srcInfo', '<b>' + esc(c.name) + '</b><br>' + st.tracks.length + ' takipli maske · ' + st.tracks[0].points.length + ' kare', 'ok');
        log(st.tracks.length + ' takipli maske bulundu.');
        if (q0 && q0.level !== 'good') log('UYARI: Takip kalitesi: ' + q0.text + (q0.raw.stats.spikes && !$('despike').checked ? ' — "Sıçramaları düzelt" ayarını aç.' : ''));
        stagesDone('✓ Analiz tamamlandı');
      } else {
        var head = !det ? 'Bu klipte takip verisi olan maske bulunamadı.' : (det.state === 'object-nodata' ? 'Object Mask algılandı, takip verisine erişilemiyor.' : det.state === 'untracked' ? 'Maske var ama takip edilmemiş.' : 'Maske bulunamadı.');
        stage(3, 'err', 'Keyframe işlenemedi: takip verisi yok');
        setInfo('srcInfo', '<b>' + esc(c.name) + '</b><br>' + esc(head), 'err');
        log('Bu klipte takip verisi olan maske bulunamadı.');
        try {
          var txt = MaskParser.scan(xml, Number(c.startTicks), c.name), f = path.join(outDir(), 'tether_tarama.txt');
          fs.writeFileSync(f, txt, 'utf8');
          log('Teşhis dosyası otomatik yazıldı: ' + f + ' — bu dosyayı bana gönder. Ayrıca Araçlar sekmesinden "Canlı teşhis"e basıp tether_canli.txt dosyasını da gönder.');
        } catch (e2) { log('Teşhis dosyası yazılamadı: ' + e2); }
      }
      renderGrid(currentGrid()); renderDiag();
    } catch (e) {
      failAt(3, 'PARSER_ERROR', e && (e.stack || e));
    } finally { busy(false); }
  };

  // Doğrulanmamış Object Mask dosya verisini, kullanıcı onaylarsa mevcut hatta bagla
  $('bOmUse').onclick = function () {
    var cd = st.omCand; if (!cd) return;
    st.tracks = [{ clipStartSec: cd.clipStartSec, clipEndSec: cd.clipEndSec, points: cd.points, kind: 'object', source: 'dosya', unverified: true, file: cd.file, range: cd.range }];
    var sel = $('selMask'); sel.innerHTML = ''; var o = document.createElement('option'); o.value = 0; o.textContent = 'Object Mask - ' + cd.points.length + ' kare'; sel.appendChild(o);
    $('maskRow').classList.add('hidden'); $('omBox').classList.add('hidden'); showErr(null);
    mark('card1', true); refreshPreview(false); updateReady();
    if (!(Number($('smooth').value) > 0)) { $('smooth').value = 4; var ev0 = document.createEvent('Event'); ev0.initEvent('input', true, true); $('smooth').dispatchEvent(ev0); var ev1 = document.createEvent('Event'); ev1.initEvent('change', true, true); $('smooth').dispatchEvent(ev1); log('Yumuşatma 4 yapıldı (Object Mask kutusu kare kare hafif titrer). İstersen Ayarlar sekmesinden değiştir.'); }
    log('Object Mask takibi kullanılıyor (' + cd.parserLabel + '). Önizlemede hareketi kontrol et; sonuç yanlışsa Geri al.');
    setInfo('srcInfo', '<b>' + esc(st.src.name) + '</b><br>Object Mask · ' + cd.points.length + ' kare (doğrulanmadı)', 'ok');
    stagesDone('✓ Object Mask takibi hazır — önizlemede kontrol et');
    renderGrid(currentGrid());
    var q = qualityCell(st.tracks[0]); if (q && q.level !== 'good') log('UYARI: Takip kalitesi: ' + q.text);
  };
  $('selMask').addEventListener('change', refreshStatus);

  // ===== Kendi takibim (beta): ffmpeg + Tether Tracker =====
  var OWN = window.TetherTrack, osm = null, pth = null;
  try { osm = require('os'); pth = require('path'); } catch (eo) {}
  var own = { info: null, rect: null, tRef: 0, ff: undefined, imgW: 0, imgH: 0, img: null };
  function ownMsg(t, lvl) { var m = $('ownMsg'); m.textContent = t; m.style.color = lvl === 'err' ? 'var(--er)' : (lvl === 'ok' ? 'var(--ok)' : ''); }
  function extDir() {
    try { var u = cs.getSystemPath('extension'); u = decodeURI(String(u)).replace(/^file:\/\/\//, ''); if (/^[A-Za-z]:/.test(u)) return u; return '/' + u; } catch (e) {}
    try { return __dirname; } catch (e2) { return null; }
  }
  function ownFf() { if (!OWN) return null; if (own.ff === undefined) own.ff = OWN.findFfmpeg(extDir()); return own.ff; }
  var FF_HELP = 'ffmpeg bulunamadı. kur.bat (Mac: kur.command) dosyasını internete bağlıyken tekrar çalıştır, ffmpeg otomatik indirilir. Olmazsa ffmpeg.exe dosyasını CEP\\Tether_ffmpeg klasörüne koy ya da sistem PATH\'ine ekle. Sonra Premiere\'i kapatıp aç.';
  // Arama bolgesi (dis kutu): takip bolgesinin her kenarindan pad kadar disari. Elle degistirilmediyse varsayilan + "Dar/Normal/Genis" carpani
  function ownPad() {
    var r = own.rect; if (!r) return [0, 0]; if (own.padUser) return own.padUser;
    var a = (own.imgH && own.imgW) ? own.imgH / own.imgW : 0.5625, R = Math.max(0.12, 0.9 * Math.max(r[2], r[3] * a)) * (Number($('ownSearch').value) || 1);
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
      else { g.fillStyle = 'rgba(255,60,60,.9)'; g.font = 'bold 13px sans-serif'; g.fillText('bu karede takip yok (kayıp / kapalı)', 10, 20); }
    }
    if (own.rect) {                         // dis kutu: arama bolgesi
      var o = ownOuter(), cw = cv.width, ch = cv.height;
      g.save(); g.setLineDash([7, 4]); g.lineWidth = 2; g.strokeStyle = '#ffb02e'; g.fillStyle = 'rgba(255,176,46,.07)';
      g.fillRect(o[0] * cw, o[1] * ch, o[2] * cw, o[3] * ch); g.strokeRect(o[0] * cw, o[1] * ch, o[2] * cw, o[3] * ch); g.restore();
      g.fillStyle = '#ffb02e'; var ox = [o[0], o[0] + o[2] / 2, o[0] + o[2]], oy = [o[1], o[1] + o[3] / 2, o[1] + o[3]];
      for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) { if (a === 1 && b === 1) continue; g.fillRect(ox[a] * cw - 3, oy[b] * ch - 3, 7, 7); }
      g.font = 'bold 11px sans-serif'; g.fillStyle = '#ffb02e'; g.fillText('Arama bölgesi', Math.max(4, o[0] * cw + 4), Math.max(12, o[1] * ch - 4));
      g.fillStyle = '#5aa9ff'; g.fillText('Takip bölgesi', own.rect[0] * cw + 4, own.rect[1] * ch + 13);
    }
    if (own.rect) { var r = own.rect; g.lineWidth = 2; g.strokeStyle = '#2d8ceb'; g.fillStyle = 'rgba(45,140,235,.12)'; g.fillRect(r[0] * cv.width, r[1] * cv.height, r[2] * cv.width, r[3] * cv.height); g.strokeRect(r[0] * cv.width, r[1] * cv.height, r[2] * cv.width, r[3] * cv.height);
      g.fillStyle = '#fff'; var hx = [r[0], r[0] + r[2] / 2, r[0] + r[2]], hy = [r[1], r[1] + r[3] / 2, r[1] + r[3]];
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) { if (i === 1 && j === 1) continue; g.fillRect(hx[i] * cv.width - 3, hy[j] * cv.height - 3, 6, 6); } }
  }
  window.__tetherDbg = { own: own, drawOwn: drawOwn };
  (function () {
    var cv = $('ownCv'), drag = null, CUR = { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    function pos(e) { var b = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))]; }
    function size() { var b = cv.getBoundingClientRect(); return [b.width, b.height]; }
    cv.addEventListener('mousedown', function (e) {
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
      $('bOwnRun').disabled = false;
      ownMsg('Bölge hazır. Kutuyu tutup taşıyabilir, kenar/köşelerinden boyutlandırabilirsin; sonra "Takip et".', 'ok');
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
      own.info = inf; own.tRef = tRef; own.rect = null; $('bOwnRun').disabled = true;
      var png = pth.join(osm.tmpdir(), 'tether_ownframe.png');
      try { fs.unlinkSync(png); } catch (e0) {}
      ownMsg('Kare alınıyor…');
      OWN.readOneFramePng(ff, inf.mediaPath, tRef, png, function (err) {
        if (err) return ownMsg('HATA: ' + err, 'err');
        var img = new Image();
        img.onload = function () {
          own.img = img; own.imgW = img.width; own.imgH = img.height; own.bg = null; own.res = null; own.frames = null; $('ownReview').classList.add('hidden');
          var cv = $('ownCv'); cv.classList.remove('hidden'); cv.width = 520; cv.height = Math.round(520 * img.height / img.width); drawOwn();
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
  }
  function gotoBad(dir) {
    var n = own.frames ? own.frames.length : 0, i = own.scrub + dir;
    for (; i >= 0 && i < n; i += dir) if (badFrame(i)) { var sl = $('ownScrub'); sl.value = i; showScrub(i); return; }
    ownMsg('Bu yönde zayıf kare yok.');
  }
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
  function ownBusyUI(on) { own.running = on; $('bOwnRun').textContent = on ? 'Durdur' : 'Takip et'; $('bOwnRun').classList.toggle('primary', !on); ['bOwnFrame', 'bOwnFwd', 'bOwnBwd'].forEach(function (id) { $(id).disabled = on; }); $('ownScrub').disabled = on; }
  // Sonucu Tether takip verisine cevir ve durum panelini guncelle
  async function ownFinalize(res, t0, note) {
    var inf = own.info, inT = inf.inSec * TPS_, ft = Number(inf.frameTicks);
    var pts = OWN.toPoints(res, function (i) { return Math.round(inT + i * ft); });
    if (pts.length < 2) { ownMsg('Takip başarısız: ' + (res.reasonFwd || res.reasonBwd || 'bölgede takip edilecek doku bulunamadı') + '. Daha dokulu bir bölge seç.', 'err'); return false; }
    var timing = { start: Number(inf.startTicks), end: Number(inf.endTicks), inP: inT, outP: inf.outSec * TPS_, ratio: 1 };
    var mapped = MaskParser.mapSourcePoints(timing, pts);
    var c = await evJson('ppGetSelection()'); if (!c.ok) { ownMsg('HATA: ' + c.err, 'err'); return false; }
    st.src = c; st.xml = null; st.omCand = null; restoreBase(c);
    $('srcW').value = c.nat ? c.nat[0] : c.seqW; $('srcH').value = c.nat ? c.nat[1] : c.seqH;
    var rng = OM && OM.coverage ? OM.coverage(pts, timing) : null;
    st.tracks = [{ clipStartSec: timing.start / TPS_, clipEndSec: timing.end / TPS_, points: mapped, kind: 'own', source: 'tether', unverified: false, file: inf.mediaPath, range: rng }];
    var sel = $('selMask'); sel.innerHTML = ''; var o = document.createElement('option'); o.value = 0; o.textContent = 'Kendi takibim - ' + pts.length + ' kare'; sel.appendChild(o);
    $('maskRow').classList.add('hidden'); $('omBox').classList.add('hidden'); showErr(null);
    mark('card1', true); refreshPreview(false); updateReady();
    var span = Math.round((pts[pts.length - 1].src - pts[0].src) / ft) + 1, holes = Math.max(0, span - pts.length);
    var weakN = res.frames.filter(function (f) { return f && f.conf < WEAK; }).length, weakTxt = weakN ? ' ' + weakN + ' kare zayıf güvenli (grafikte sarı).' : '';
    var holeTxt = holes ? ' ' + holes + ' kare takipsiz (kapanma / kayıp); arası doğrusal geçilir. Kaydırıcıyla o kareye gidip kutuyu nesneye çek, "Buradan ileri" de.' : '';
    ownMsg('✓ ' + pts.length + ' kare izlendi' + (t0 ? ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' sn)' : '') + '.' + (note || '') + holeTxt + weakTxt + ' Kontrol edip Uygula\'ya geç.', 'ok');
    log('Kendi takibim: ' + pts.length + ' kare, konum + ölçek + dönme.' + (holes ? ' ' + holes + ' kare boş.' : ''));
    setInfo('srcInfo', '<b>' + esc(c.name) + '</b><br>Kendi takibim · ' + pts.length + ' kare', 'ok');
    renderGrid(currentGrid());
    setCell('gMask', LV.ok + ' Kendi takibim', 'ok'); setCell('gStatus', LV.ok + ' Takip tamamlandı', 'ok'); setCell('gTrk', LV.ok + ' ' + pts.length + ' kare · konum + ölçek + dönme', 'ok');
    var qc = qualityCell(st.tracks[0]); if (qc && qc.level !== 'good') log('UYARI: Takip kalitesi: ' + qc.text);
    return true;
  }
  function ownProg(done, total) { ownMsg('Takip ediliyor… %' + Math.round(100 * done / Math.max(1, total)) + ' (' + done + '/' + total + ' kare)'); }
  $('bOwnRun').onclick = async function () {
    if (own.running) { own.cancel = true; if (own.sig && own.sig.kill) own.sig.kill(); return; }
    var inf = own.info, ff = ownFf(); if (!inf || !own.rect || !ff) return;
    own.cancel = false; ownBusyUI(true);
    var t0 = Date.now();
    try {
      var fps = TPS_ / Number(inf.frameTicks), dur = inf.outSec - inf.inSec;
      var pr = OWN.probe(ff, inf.mediaPath), asp = pr ? pr.h / pr.w : own.imgH / own.imgW;
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
      var res = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), onProgress: ownProg, cancel: function () { return own.cancel; } });
      var okN = res.frames.filter(Boolean).length, relaxedNote = '', mth = $('ownMethod').value;
      own.method = ''; own.crop = undefined;
      if (mth === 'tpl' || (mth === 'auto' && !res.cancelled && r.frames.length > 12 && okN < Math.round(r.frames.length * 0.95))) {   // nokta takibi zayifsa (dokusuz / hizli nesne) sablon eslestirmeyi dene
        ownMsg('Şablon eşleştirme deneniyor…');
        var rt = null, okT = -1, crops = [0.7, 1], ci;      // iki sablon boyutu dene (ic kisim / tum kutu); daha cok kare izleyeni sec
        for (ci = 0; ci < crops.length && !own.cancel; ci++) {
          var rc = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), method: 'tpl', tplCrop: crops[ci], onProgress: ownProg, cancel: function () { return own.cancel; } });
          var okC = rc.frames.filter(Boolean).length;
          if (okC > okT) { rt = rc; okT = okC; own.crop = crops[ci]; }
        }
        var wholesale = mth === 'tpl' || okN < Math.round(r.frames.length * 0.5);
        if (rt && !wholesale && okT > okN && !own.cancel) {   // nokta takibi iyi ama bosluklari var: bosluklari sablon takibiyle doldur (zayif / sari isaretli)
          var rf2 = OWN.fillGaps(res, rt); log('Kendi takibim: nokta takibi ' + okN + ' kare; ' + rf2.filled + ' boş kare şablon eşleştirmeyle dolduruldu (zayıf işaretli).'); res = rf2; okN = res.frames.filter(Boolean).length; relaxedNote = ' (' + rf2.filled + ' kare şablonla dolduruldu)';
        }
        if (rt && wholesale && (mth === 'tpl' || okT > okN * 1.25)) { log('Kendi takibim: nokta takibi ' + okN + ', şablon eşleştirme ' + okT + ' kare izledi; şablon yöntemi seçildi.'); res = rt; okN = okT; own.method = 'tpl'; relaxedNote = ' (şablon eşleştirme)'; }
      }
      if (!res.cancelled && own.method !== 'tpl' && r.frames.length > 30 && okN < Math.max(8, Math.round(r.frames.length * 0.03))) {   // neredeyse hic takip yok: hassas modla bir kez daha dene
        log('Kendi takibim: ilk deneme yalnız ' + okN + ' kare izledi; hassas modla yeniden deneniyor.' + (res.stats ? ' [' + JSON.stringify(res.stats) + ']' : ''));
        ownMsg('İlk deneme zayıf, hassas modla yeniden deneniyor…');
        res = await OWN.trackRegionAsync(r.frames, W, H, refIdx, own.rect, { dir: $('ownDir').value, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), relaxed: true, onProgress: ownProg, cancel: function () { return own.cancel; } });
        relaxedNote = ' (hassas mod)';
      }
      if (res.stats) log('Takip tanısı: kayıp ' + res.stats.coasts + ' (nokta ' + res.stats.lkLost + ', görünüm ' + res.stats.lowApp + '), takip yeniden sürdürme ' + res.stats.resumes + ', şablonla yeniden bulma ' + res.stats.reacqs + '.');
      var cutIdx = []; OWN.detectCuts(r.frames).forEach(function (c, ci) { if (c) cutIdx.push(ci + 1); });
      if (cutIdx.length) { relaxedNote += ' · sahne kesmesi / ani plan değişimi: kare ' + cutIdx.slice(0, 5).join(', ') + (cutIdx.length > 5 ? '…' : '') + ' (orada takip güvenilmez, kontrol et)'; log('Kendi takibim: sahne kesmesi kareleri: ' + cutIdx.join(', ')); }
      own.res = res; own.scrub = refIdx; own.anchors = {};
      if (await ownFinalize(res, t0, (res.cancelled ? ' (durduruldu: o ana kadarki kısım)' : '') + relaxedNote)) {
        $('ownReview').classList.remove('hidden'); var sl = $('ownScrub'); sl.max = r.frames.length - 1; sl.value = refIdx; showScrub(refIdx);
      }
    } catch (e) { ownMsg('HATA: ' + e, 'err'); log('HATA: Kendi takibim: ' + (e && e.stack || e)); }
    finally { ownBusyUI(false); }
  };
  $('ownScrub').addEventListener('input', function () { if (own.res && own.frames) showScrub(Number($('ownScrub').value)); });
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
    own.cancel = false; ownBusyUI(true); var t0 = Date.now();
    try {
      var sub = own.frames.slice(lo, hi + 1), off = lo;
      var res2 = await OWN.trackRegionAsync(sub, own.W, own.H, i - off, own.rect, { dir: dir, method: own.method || undefined, tplCrop: own.crop || undefined, model: $('ownModel').value, adapt: $('ownAdapt').value !== '0', search: 1, searchR: ownSearchR(), searchRy: ownSearchRy(), baseScale: near ? near.scale * ratio : 1, baseRot: near ? near.rot : 0, onProgress: ownProg, cancel: function () { return own.cancel; } });
      var out = own.res.frames.slice(), from = dir === 'fwd' ? i : lo, to = dir === 'fwd' ? hi : i;
      for (k = from; k <= to; k++) {
        if (own.anchors[k] && k !== i) continue;           // baska bir duzeltilmis kareyi ezme
        var nf = res2.frames[k - off] || null;
        if (nf) { nf = Object.assign({}, nf); nf.i = k; }
        out[k] = nf;
      }
      own.res = Object.assign({}, own.res, { frames: out });
      await ownFinalize(own.res, t0, (res2.cancelled ? ' (durduruldu)' : '') + (hi < N - 1 && dir === 'fwd' ? ' (bir sonraki düzeltmeye kadar)' : '') + (lo > 0 && dir === 'bwd' ? ' (bir önceki düzeltmeye kadar)' : ''));
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
  function buildOpts(tgt) {
    var ss = effectiveSrcSize();
    return {
      motion: { pos: st.src.pos, scale: st.src.scale, scaleW: (st.src.uniform === false && st.src.scaleW) ? st.src.scaleW : null, anchor: st.src.anchor },
      srcW: ss[0], srcH: ss[1], seqW: tgt.seqW, seqH: tgt.seqH,
      mode: $('mode').value, tgtPos: tgt.pos,
      step: Math.max(1, num('step', 1)), smooth: Math.max(0, num('smooth', 0)), tol: Math.max(0, num('tol', 0)),
      zoom: ($('zoomMode').value === 'keep' && st.src) ? (Number(st.src.scale) || 100) : (num('zoom', 150) || 150),
      zoomMax: num('zoomMax', 300) || 300, dynZoom: $('zoomMode').value === 'auto', sizeTrack: $('sizeTrack').checked, sizeStr: Math.max(0, num('sizeStr', 70)),
      despike: $('despike').checked ? 0.05 : 0, deadzone: Math.max(0, num('dz', 0)) / 100,
      offset: [num('offX', 0), num('offY', 0)], pin: [pct('pinX'), pct('pinY')], stats: {}, vis: visOffset(tgt), rotTrack: !!($('rotTrack') && $('rotTrack').checked), rotStr: 100, tgtRot: Number(tgt.xf && where_for_opts() === 'xform' ? tgt.xf.rot : tgt.rot) || 0, scaleTrack: !!($('scTrack') && $('scTrack').checked), scaleStr: Math.max(0, num('scStr', 100)), tgtScale: Number(tgt.scale) || 100, place: ($('plc') ? $('plc').value : 'center'), gap: num('plcGap', 24)
    };
  }

  // Hesapla + kareye oturt + tekrarları ele
  function compute(tgt, quiet) {
    var t = st.tracks[Number($('selMask').value) || 0], o = buildOpts(tgt);
    if (o.mode === 'follow' && $('zoomMode').value === 'fixed' && $('autoZoom').checked) {
      var z = MaskParser.autoZoom(t.points, o);
      if (z > 1000) { if (!quiet) log('UYARI: Kenarsız kadraj için %' + z + ' zoom gerekir; 1000 ile sınırlandı. Dinamik zoom\'u aç, nesneyi ortalamak yerine Nesne X/Y konumunu kenara kaydır ya da Ölü bölge kullan.'); z = 1000; }
      o.zoom = z; $('zoom').value = z;
      if (!quiet) log('Otomatik zoom: %' + z);
    }
    var pts = MaskParser.toPositions(t.points, o);
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
    var list = toFrames(pts, function (p, sec) { return { sec: sec, x: p.x, y: p.y, tl: p.tl }; });
    var zlist = pts.zAll ? MaskParser.reduceScalar(toFrames(pts.zAll, function (p, sec) { return { sec: sec, z: p.z, tl: p.tl }; }), 0.1, 'z') : null;
    var rlist = pts.rAll ? MaskParser.reduceScalar(toFrames(pts.rAll, function (p, sec) { return { sec: sec, z: p.z, tl: p.tl }; }), 0.15, 'z') : null;
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
    var jumps = jumpCount(r);
    if (jumps) log('UYARI: ' + jumps + ' yerde ani sıçrama var (takip kopmuş olabilir). Yumuşatma artırmayı ya da nesneyi yeniden takip ettirmeyi dene.');
    var zoom = ((follow && !dyn && !keep) ? r.zoom : 0) * (xfc ? 100 / xfc.m : 1);   // keep: Scale'e dokunma
    if (keep) vlog('Yalnız Position: Scale\'e dokunulmuyor (mevcut %' + Math.round(r.zoom) + ' kullanılıyor).');
    if (follow && !dyn) {
      var ss2 = effectiveSrcSize();
      if (ss2[0] * r.zoom / 100 / r.seqW <= 1 || ss2[1] * r.zoom / 100 / r.seqH <= 1)
        log('UYARI: Bu yakınlaştırmada klip kadrajı tam dolduramıyor, kenarlarda boşluk kalır. Yakınlaştırmayı artır, otomatik zoom\'u ya da dinamik zoom\'u aç.');
      if (!keep) vlog('İpucu: Nesne kenara yaklaşınca sabit zoom kamerayı durdurur (nesneye yetişemez). "Otomatik: Scale + Position" bunu çözer.');
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
      var t = st.tracks[Number($('selMask').value) || 0], n = (t.points[0].raw || []).length, h = ['sn'], i;
      for (i = 0; i < n; i++) h.push('f' + i);
      var rows = t.points.map(function (p) { return (p.tl - t.clipStartSec).toFixed(4) + ',' + (p.raw || []).map(function (v) { return +v.toFixed(5); }).join(','); });
      var f = path.join(outDir(), 'tether_ham_takip.csv');
      fs.writeFileSync(f, h.join(',') + '\n' + rows.join('\n'), 'utf8');
      log('Ham takip verisi yazıldı: ' + f + ' (' + t.points.length + ' kare, ' + n + ' değer). Bu dosyayı bana gönder: ölçek/döndürme sütunlarını bulup onları da takibe katarım.');
    } catch (e) { log('HATA: ' + e); }
  };
  $('bScan').onclick = function () {
    if (!st.xml || !st.src) return log('Önce "Seçili klibi al" ile klibi seç (proje okunsun).');
    try {
      var txt = MaskParser.scan(st.xml, Number(st.src.startTicks), st.src.name);
      var f = path.join(outDir(), 'tether_tarama.txt');
      fs.writeFileSync(f, txt, 'utf8');
      log('Tarama yazıldı: ' + f + ' (' + txt.split('\n').length + ' satır). Bu dosyayı bana gönder.');
    } catch (e) { log('HATA: ' + e); }
  };
  $('bFind').onclick = async function () {
    if (!st.xml || !st.src) return log('Önce Object Mask klibini seç ve "Seçili klibi al"a bas (proje okunsun).');
    var g = MaskParser.guids(st.xml);
    if (!g.length) return log('Tracker içinde GUID referansı bulunamadı; bu klip için dış veri araması gerekmiyor.');
    busy(true); log('Aranıyor (en fazla ~45 sn): ' + g.length + ' GUID...');
    try {
      var projDir = ''; try { var sp = await evJson('ppSaveProject()'); if (sp.ok) projDir = path.dirname(sp.path); } catch (e0) {}
      var r = await MaskFinder.run({ guids: g, projectDir: projDir });
      var hits = r.nameHits.concat(r.contentHits.map(function (h) { return h.replace(/ \(\d+ bayt\)$/, ''); })).filter(function (h, i, a) { return a.indexOf(h) === i; });
      var extra = '';
      if (OM) {
        // bulunan dosyalar onbellege yazilir ve bicimleri analiz edilir (sadece okur)
        hits.slice(0, 20).forEach(function (h) {
          var p = h.replace(/\s+\[KLASOR\]$/, ''), low = p.toLowerCase();
          g.forEach(function (gg) { if (low.indexOf(gg) >= 0 || low.indexOf(gg.replace(/-/g, '')) >= 0) OM.reader.cachePut(gg, p); });
        });
        extra = '\n\n=== Bulunan dosyaların biçim analizi (v1.9) ===\n' + (hits.length ? hits.slice(0, 10).map(function (h) { var p = h.replace(/\s+\[KLASOR\]$/, ''); return p + '\n' + OM.diagnostics.fileReport(p).join('\n'); }).join('\n\n') : '(dosya yok)');
      }
      var f = path.join(outDir(), 'tether_cache_arama.txt'); fs.writeFileSync(f, r.text + extra, 'utf8');
      log('Bitti: adında GUID geçen ' + r.nameHits.length + ', içinde GUID geçen ' + r.contentHits.length + ' dosya. Rapor: ' + f + ' — bu dosyayı bana gönder.');
    } catch (e) { log('HATA: ' + e); } finally { busy(false); }
  };
  $('bOmReport').onclick = function () {
    if (!st.src || !st.diag.detection) return log('Önce "Analiz et" ile klibi analiz et.');
    var f = writeOmReport(false); if (f) log('Raporu bana gönderirsen Object Mask biçimini inceleyebilirim.');
  };
  $('bOmCache').onclick = function () { if (OM) { OM.reader.cacheClear(); log('Object Mask dosya önbelleği temizlendi.'); } };
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
      fs.writeFileSync(f, JSON.stringify({ src: st.src, tgts: st.tgts, track: st.tracks[Number($('selMask').value) || 0] }, null, 1), 'utf8');
      log('Debug dosyası yazıldı: ' + f);
    } catch (e) { log('HATA: ' + e); }
  };
  $('mode').addEventListener('change', updateReady);
  updateReady(); renderDiag();
  window.MT = { st: st, compute: compute, previewTarget: previewTarget, save: saveSettings, touch: touch };
  log('Hazır. Tether v' + PLUGIN_VERSION + (OM ? '' : ' (Object Mask modülü yüklenemedi; diğer özellikler çalışır)'));
})();

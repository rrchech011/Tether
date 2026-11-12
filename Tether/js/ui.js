/* Tether - arayuz davranisi (sekmeler, mod secici, moda gore gorunum). Is mantigi main.js'te. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };

  function showPage(id) {
    each(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-page') === id); });
    each(document.querySelectorAll('.page'), function (p) { p.classList.toggle('on', p.id === id); });
    $('preview').classList.toggle('hidden', id === 'pTools' || id === 'pLog');
    if (id === 'pLog') { var l = $('log'); l.scrollTop = l.scrollHeight; }
  }
  each(document.querySelectorAll('.tab'), function (t) { t.onclick = function () { showPage(t.getAttribute('data-page')); }; });
  $('status').onclick = function () { showPage('pLog'); };
  $('bClear').onclick = function () { $('log').textContent = ''; };
  $('bCopyLog').onclick = function () {
    var txt = $('log').textContent || '';
    if (!txt) return;
    try { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e) {}
  };

  var DESC = {
    attach: 'Hedef klip bulunduğu yerde kalır, nesnenin hareketini izler.',
    snap: 'Hedef klibi nesnenin üstüne yerleştirir ve izletir.',
    stabilize: 'Seçtiğin nokta hep aynı yerde kalır (örn. duran bir bina köşesi; hareketli nesneyi seçme). Hedef olarak aynı klibi seç. Yalnız kaymayı düzeltir; dönme ve zoom titremesini düzeltmez. Kenarda boşluk kalırsa klibi biraz büyüt.',
    follow: 'Klibi yakınlaştırır, nesneyi kadrajda tutar. Hedef klip gerekmez, aynı klip kullanılır. Dikey (9:16) videoda "Otomatik zoom" boşluk bırakmaz.'
  };
  function applyMode() {
    var m = $('mode').value;
    $('modeDesc').textContent = DESC[m] || '';
    each(document.querySelectorAll('#seg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === m); });
    each(document.querySelectorAll('[data-modes]'), function (e) {
      e.classList.toggle('hidden', e.getAttribute('data-modes').split(' ').indexOf(m) < 0);
    });
    $('n3').textContent = m === 'follow' ? '2' : '3';
  }
  each(document.querySelectorAll('#seg button'), function (b) {
    b.onclick = function () {
      $('mode').value = b.getAttribute('data-mode');
      // main.js ayarlari 'change' ile kaydeder
      var ev = document.createEvent('Event'); ev.initEvent('change', true, true); $('mode').dispatchEvent(ev);
      applyMode();
    };
  });
  $('mode').addEventListener('change', applyMode);

  function smoothOut() { $('smoothOut').textContent = $('smooth').value; }
  $('smooth').addEventListener('input', smoothOut);

  // Dinamik zoom açıkken sabit "otomatik zoom" anlamsız; zoom alanı "asgari zoom" olur
  var ZHINT = {
    auto: 'Zoom nesneye göre her karede ayarlanır; kenarda boşluk kalmaz.',
    fixed: 'Tek zoom değeri kullanılır; yalnız konum hareket eder.',
    keep: 'Zoom\'a dokunulmaz, klibin mevcut Scale değeri kalır; yalnız konum kayar.'
  };
  function zoomUI() {
    var zm = $('zoomMode').value, auto = zm === 'auto', size = auto && $('sizeTrack').checked;
    $('zoomLbl').textContent = auto ? 'En az zoom (%)' : 'Zoom (%)';
    $('zoomHide').classList.toggle('hidden', zm === 'keep');
    $('zoomMaxRow').classList.toggle('hidden', !auto);
    $('sizeRow').classList.toggle('hidden', !auto);
    $('sizeStrRow').classList.toggle('hidden', !size);
    $('autoZoomRow').classList.toggle('hidden', zm !== 'fixed');
    $('zoomModeHint').textContent = ZHINT[zm] || '';
  }
  $('zoomMode').addEventListener('change', zoomUI);
  $('sizeTrack').addEventListener('change', zoomUI);

  // Hazir ayarlar: mevcut kontrolleri doldurur (ayri mantik yok), sonra olaylari tetikler ki main.js kaydetsin / yenilesin
  var PRESETS = {
    tag:  { mode: 'snap', plc: 'top', plcGap: 24, smooth: 4, despike: true, tol: 0.5, txtComp: true, scTrack: false, rotTrack: false },
    lock: { mode: 'snap', plc: 'center', plcGap: 0, smooth: 2, despike: true, tol: 0.5, offX: 0, offY: 0, scTrack: false, rotTrack: false },
    cam:  { mode: 'follow', zoomMode: 'auto', smooth: 8, dz: 6, despike: true, tol: 0.5, sizeTrack: false, zoom: 120, zoomMax: 220 },
    text: { mode: 'attach', smooth: 4, despike: true, tol: 0.5, scTrack: false, rotTrack: false },
    stab: { mode: 'stabilize', smooth: 3, despike: true, tol: 0.5 }
  };
  function fire(el, type) { var ev = document.createEvent('Event'); ev.initEvent(type, true, true); el.dispatchEvent(ev); }
  var applyingPreset = false;
  $('preset').addEventListener('change', function () {
    var p = PRESETS[$('preset').value]; if (!p) return;
    applyingPreset = true;
    Object.keys(p).forEach(function (id) {
      var el = $(id); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!p[id]; else el.value = p[id];
      fire(el, id === 'smooth' ? 'input' : 'change'); if (id === 'smooth') fire(el, 'change');
    });
    applyMode(); zoomUI(); smoothOut();
    applyingPreset = false;
  });
  // Ayarlardan biri elle degisince hazir ayar etiketi "Ozel"e doner (artik o hazir ayar degil)
  ['mode', 'plc', 'plcGap', 'smooth', 'despike', 'tol', 'txtComp', 'scTrack', 'scStr', 'dz', 'zoomMode', 'sizeTrack', 'zoom', 'zoomMax', 'offX', 'offY'].forEach(function (id) {
    var el = $(id); if (!el) return;
    ['change', 'input'].forEach(function (ev) { el.addEventListener(ev, function () { if (!applyingPreset && $('preset').value) { $('preset').value = ''; fire($('preset'), 'change'); } }); });
  });



  // Premiere gibi: sayi kutusunu saga / sola surukleyerek degeri degistir; tiklayip elle de yazabilirsin. Shift = 5 kat hizli.
  (function () {
    var TIP = 'Sürükle: değeri değiştir · tıkla: elle yaz · Shift: hızlı';
    var st = null;
    function num(el, k, d) { var v = parseFloat(el.getAttribute(k)); return isFinite(v) ? v : d; }
    each(document.querySelectorAll('input[type=number]'), function (el) {
      if (!el.title) el.title = TIP;
      el.addEventListener('mousedown', function (e) {
        if (e.button !== 0 || el.disabled || el.readOnly) return;
        st = { el: el, x: e.clientX, v: parseFloat(el.value) || 0, on: false };
      });
    });
    window.addEventListener('mousemove', function (e) {
      if (!st) return;
      var dx = e.clientX - st.x;
      if (!st.on) { if (Math.abs(dx) < 4) return; st.on = true; document.body.classList.add('scrubbing'); try { st.el.blur(); window.getSelection().removeAllRanges(); } catch (x) {} }
      var el = st.el, step = num(el, 'step', 1), mn = num(el, 'min', -Infinity), mx = num(el, 'max', Infinity), dec = step < 1 ? 1 : 0;
      var v = st.v + (dx / 2) * step * (e.shiftKey ? 5 : 1);
      v = Math.max(mn, Math.min(mx, v)); v = Number(v.toFixed(dec));
      if (String(v) !== el.value) { el.value = v; fire(el, 'input'); }
      e.preventDefault();
    });
    window.addEventListener('mouseup', function () {
      if (!st) return; var s = st; st = null;
      if (s.on) { document.body.classList.remove('scrubbing'); fire(s.el, 'change'); }
    });
  })();

  // Takip modeli 'Yalnız konum' ise ölçek/boyut/dönme ayarları gizlenir (veride ölçek yok)
  function modelUI() { document.body.classList.toggle('posonly', $('ownModel').value === 'trans'); }
  $('ownModel').addEventListener('change', modelUI); modelUI();

  // Uygulama yeri: Transform secilince Shutter Angle satiri + ipucu gorunur
  function xfUI() { var x = $('applyTo').value === 'xform'; $('shutRow').classList.toggle('hidden', !x); $('xfHint').classList.toggle('hidden', !x); }
  $('applyTo').addEventListener('change', xfUI);
  smoothOut(); applyMode(); zoomUI(); xfUI();   // main.js kayitli ayarlari yukledikten sonra calisir
  (function () {
    var ls = $('langSel'); if (!ls) return;
    ls.value = window.TETHER_LANG === 'en' ? 'en' : 'tr';
    ls.onchange = function () { try { localStorage.setItem('tether_lang', ls.value); } catch (e) {} location.reload(); };
  })();
})();

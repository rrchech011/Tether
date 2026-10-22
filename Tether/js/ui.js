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

  var DESC = {
    attach: 'Hedef klip bulunduğu yerde kalır, nesnenin hareketini izler.',
    snap: 'Hedef klibi nesnenin üstüne yerleştirir ve izletir.',
    stabilize: 'Nesne sabit kalsın diye hareketi tersine uygular. Hedef olarak aynı klibi seç.',
    follow: 'Klibi yakınlaştırır, nesneyi kadrajda tutar. Hedef klip gerekmez, aynı klip kullanılır.'
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
    auto: 'Position ve Scale birlikte, her kare keyframelenir.',
    fixed: 'Scale tek bir değere sabitlenir; yalnız Position keyframelenir.',
    keep: 'Scale\'e hiç dokunulmaz, klibin mevcut Scale değeri kullanılır; yalnız Position keyframelenir.'
  };
  function zoomUI() {
    var zm = $('zoomMode').value, auto = zm === 'auto', size = auto && $('sizeTrack').checked;
    $('zoomLbl').textContent = auto ? 'Asgari zoom (Scale %)' : 'Yakınlaştırma (Scale %)';
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

  // Takip kaynagi anahtari: Premiere maskesi / Kendi takibim (son secim hatirlanir)
  function setSrc(v) {
    each(document.querySelectorAll('#srcSeg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-src') === v); });
    $('paneMask').classList.toggle('hidden', v !== 'mask'); $('paneOwn').classList.toggle('hidden', v !== 'own');
    try { localStorage.setItem('tether_src', v); } catch (e) {}
  }
  each(document.querySelectorAll('#srcSeg button'), function (b) { b.addEventListener('click', function () { setSrc(b.getAttribute('data-src')); }); });
  setSrc('own');   // Premiere maskesi kaynagi arayuzden gizli (kod duruyor); kayitli eski secim yok sayilir
  window.tetherSetSrc = setSrc;

  // Uygulama yeri: Transform secilince Shutter Angle satiri + ipucu gorunur
  function xfUI() { var x = $('applyTo').value === 'xform'; $('shutRow').classList.toggle('hidden', !x); $('xfHint').classList.toggle('hidden', !x); }
  $('applyTo').addEventListener('change', xfUI);
  smoothOut(); applyMode(); zoomUI(); xfUI();   // main.js kayitli ayarlari yukledikten sonra calisir
})();

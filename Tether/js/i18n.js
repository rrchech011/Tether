/* Tether i18n: Turkish source text, English via dictionary. Default: Turkish for existing users; new installs follow the system language.
   Exact entries translate whole elements / text / title / placeholder; "sub" entries translate pieces inside composed messages (log, status).
   A MutationObserver keeps dynamic text translated, so the rest of the code stays Turkish and unchanged. */
(function () {
  'use strict';
  var KEY = 'tether_lang', lang = 'tr';
  try {
    lang = localStorage.getItem(KEY) || '';
    if (!lang) {
      var existing = localStorage.getItem('tether_v1');
      var nav = String((navigator && (navigator.language || navigator.userLanguage)) || 'en').toLowerCase();
      lang = existing ? 'tr' : (nav.indexOf('tr') === 0 ? 'tr' : 'en');
    }
  } catch (e) { lang = 'tr'; }
  if (lang !== 'en' && lang !== 'tr') lang = 'tr';
  var D = window.TETHER_EN || { html: {}, sub: {} };
  var subs = [];
  Object.keys(D.sub).forEach(function (k) {
    var re = null, L = 'A-Za-zÇĞİÖŞÜçğıöşü';
    if (k.length <= 8) {
      var f = new RegExp('^[' + L + ']').test(k), l = new RegExp('[' + L + ']$').test(k);
      if (f || l) re = new RegExp((f ? '(^|[^' + L + '0-9])' : '()') + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (l ? '(?![' + L + '])' : ''), 'g');
    }
    subs.push({ k: k, v: D.sub[k], re: re });
  });
  subs.sort(function (a, b) { return b.k.length - a.k.length; });
  var TR = /[A-Za-zÇĞİÖŞÜçğıöşü]{3}/;


  // Tam cumle kaliplari: birlesik log cumleleri dogal Ingilizce olsun diye (sira degisen cumleler). Satir bazinda calisir, sonra parca sozlugu kalanlari cevirir.
  var DIR = function (d) { return d === 'ileri' ? 'forward' : 'backward'; };
  var RX = [
    [/^Buradan (ileri|geri) takip \(kare (\d+), bölge (\d+)–(\d+)(, durduruldu)?\): takipsiz kare (\d+) → (\d+) \/ (\d+); bölgede eskiden izli (\d+) kare boşaldı, (\d+) boş kare doldu\./, function (m, d, f, a, b, st, x, y, n, lost, gain) { return 'Track ' + DIR(d) + ' from here (frame ' + f + ', range ' + a + '–' + b + (st ? ', stopped' : '') + '): untracked frames ' + x + ' → ' + y + ' / ' + n + '; ' + lost + ' previously tracked frames in the range became empty, ' + gain + ' empty frames were filled.'; }],
    [/^Buradan (ileri|geri) takip: nokta (\d+)\/(\d+), şablon (\d+) kare → (şablon kullanıldı|boşluklar şablonla dolduruldu|nokta takibi korundu)/, function (m, d, a, b, c, r) { return 'Track ' + DIR(d) + ' from here: points ' + a + '/' + b + ', template ' + c + ' frames → ' + ({ 'şablon kullanıldı': 'template used', 'boşluklar şablonla dolduruldu': 'gaps filled by template', 'nokta takibi korundu': 'point tracking kept' })[r]; }],
    [/^(Yeniden takip tanısı|Takip tanısı): kayıp (\d+) \(nokta (\d+), görünüm (\d+)\), takip yeniden sürdürme (\d+), şablonla yeniden bulma (\d+)\.( Yöntem: (şablon|nokta)\.)?/, function (m, h, c, p, a, r, q, y, me) { return (h === 'Takip tanısı' ? 'Tracking diagnostics' : 'Retrack diagnostics') + ': ' + c + ' lost (points ' + p + ', appearance ' + a + '), ' + r + ' resumed, ' + q + ' re-found by template.' + (y ? ' Method: ' + (me === 'şablon' ? 'template' : 'points') + '.' : ''); }],
    [/^Kendi takibim: (\d+) kare, konum \+ ölçek \+ dönme\.(?: (\d+) kare boş\.)?/, function (m, n, h) { return 'Own tracking: ' + n + ' frames, position + scale + rotation.' + (h ? ' ' + h + ' frames empty.' : ''); }],
    [/⚠ KUYRUK KAYBI: yeni takip kare (\d+) (sonrasında|öncesinde) durdu; eskiden izli (\d+) kare \((\d+)–(\d+) aralığında\) boşaldı\. Kutuyu nesneye çekip tekrar "Buradan (ileri|geri)" de\./, function (m, f, w, n, a, b, d) { return '⚠ TAIL LOSS: the new tracking stopped ' + (w === 'sonrasında' ? 'after' : 'before') + ' frame ' + f + '; ' + n + ' previously tracked frames (' + a + '–' + b + ') became empty. Drag the box onto the object and press "Track ' + DIR(d) + ' from here" again.'; }],
    [/tamam, (\d+) keyframe yazıldı(?: \+ (\d+) Scale keyframe)?(?: \+ (\d+) Rotation keyframe)?(?: \((\d+) atlandı\))?\./, function (m, n, s, r, k) { return 'done, ' + n + ' keyframes written' + (s ? ' + ' + s + ' Scale keyframes' : '') + (r ? ' + ' + r + ' Rotation keyframes' : '') + (k ? ' (' + k + ' skipped)' : '') + '.'; }],
    [/Takip ediliyor… %(\d+) \((\d+)\/(\d+) kare\)/, function (m, p, a, b) { return 'Tracking… ' + p + '% (' + a + '/' + b + ' frames)'; }],
    [/^(✓|⚠) (\d+) kare (izlendi|işlendi)(?: \(([\d.]+) sn\))?/, function (m, i, n, w, s) { return i + ' ' + n + ' frames ' + (w === 'izlendi' ? 'tracked' : 'processed') + (s ? ' (' + s + ' s)' : ''); }],
    [/Takip kalitesi: (İyi|Uyarı|Sorun)(?: — ([^\n]*?))?\.(?: Önizlemede ve grafikte o kareleri kontrol et\.)?/, function (m, l, iss) { return 'Tracking quality: ' + ({ 'İyi': 'Good', 'Uyarı': 'Warning', 'Sorun': 'Problem' })[l] + (iss ? ' — ' + qIssuesEn(iss) : '') + (/Önizlemede/.test(m) ? '. Check those frames in the preview and graph.' : '.'); }],
    [/^Dikkat: seçtiğin nokta kadrajın %(\d+)'i kadar geziyor\. Sabitle duran bir nokta ister \(örn\. bina köşesi\); hareketli nesnede video o nesneyi sabitler\. Nesneyi takip etmek istiyorsan "Takip et" modunu kullan\./, function (m, n) { return 'Careful: the point you picked wanders across ' + n + '% of the frame. Stabilize needs a fixed point (e.g. a building corner); with a moving object the video locks onto that object. To follow an object, use the "Track" mode.'; }],
    [/^Kurulum sorunu: /, function () { return 'Setup problem: '; }],
    [/Kurulum kontrolü: /, function () { return 'Setup check: '; }],
    [/Takip modülü yüklenemedi\. Eklentiyi yeniden kur \(kur\.bat \/ kur\.command\)\./, function () { return 'Tracking module failed to load. Reinstall the extension (kur.bat / kur.command).'; }],
    [/ffmpeg bulunamadı\. kur\.bat \(Mac: kur\.command\) dosyasını internete bağlıyken çalıştır\./, function () { return 'ffmpeg not found. Run kur.bat (Mac: kur.command) while connected to the internet.'; }],
    [/Premiere tarafı \(host\.jsx\) eksik ya da eski yüklenmiş \(([^)]*)\)\. Premiere'i tamamen kapatıp yeniden aç; olmazsa eklentiyi yeniden kur\./, function (m, l) { return 'The Premiere side (host.jsx) is missing or outdated (' + l + '). Fully close and reopen Premiere; if that does not help, reinstall the extension.'; }],
  ];
  function qIssuesEn(s) {
    return s.replace(/(\d+) tek karelik sıçrama/, '$1 single-frame spikes').replace(/(\d+) ani X\/Y değişimi/, '$1 sudden X/Y changes').replace(/(\d+) ani ölçek değişimi/, '$1 sudden scale changes').replace(/(\d+) mükerrer keyframe/, '$1 duplicate keyframes').replace(/(\d+) birbirine çok yakın keyframe/, '$1 near-duplicate keyframes').replace(/(\d+) yerde takip boşluğu/, '$1 tracking gaps').replace(/takip (\d+) kare boyunca donmuş \(kayma \/ kopma şüphesi\)/, 'tracking frozen for $1 frames (drift / loss suspected)').replace(/(\d+) karede nesne kadraj dışında/, 'object outside the frame in $1 frames').replace(/Çok az keyframe \((\d+)\)/, 'Too few keyframes ($1)');
  }
  function rxLines(s) {
    if (!/[çğıöşüÇĞİÖŞÜ]|kare|takip/.test(s)) return s;
    return s.split('\n').map(function (ln) { for (var i = 0; i < RX.length; i++) { if (RX[i][0].test(ln)) ln = ln.replace(RX[i][0], RX[i][1]); } return ln; }).join('\n');
  }

  function T(s) {
    if (lang !== 'en' || s == null) return s;
    s = String(s);
    var ex = D.html[s]; if (ex !== undefined) return ex;
    if (!TR.test(s)) return s;
    var out = rxLines(s);
    for (var i = 0; i < subs.length; i++) {
      var e = subs[i];
      if (out.indexOf(e.k) < 0) continue;
      if (e.re) out = out.replace(e.re, function (m, p) { return p + e.v; });
      else out = out.split(e.k).join(e.v);
    }
    return out;
  }
  window.T = T; window.TETHER_LANG = lang;
  if (lang !== 'en') { return; }

  var ob = null, INL = /^(B|I|SMALL|CODE|KBD|EM|STRONG|SPAN|A|BR)$/;
  function isLeaf(el) { for (var i = 0; i < el.children.length; i++) { if (!INL.test(el.children[i].tagName) || !isLeaf(el.children[i])) return false; } return true; }
  function attrs(el) {
    ['title', 'placeholder'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a); if (!v) return;
      var t = D.html['@' + v]; if (t === undefined) t = T(v);
      if (t !== v) el.setAttribute(a, t);
    });
  }
  function walk(el) {
    if (el.nodeType === 3) { var tx = el.textContent, tt = tx.trim().replace(/\s+/g, ' '); if (!tt) return; var r = D.html[tt]; r = r !== undefined ? r : T(tx); if (r !== tx && r !== tt) el.textContent = r; return; }
    if (el.nodeType !== 1) return;
    var tg = el.tagName; attrs(el); if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'CANVAS' || tg === 'SVG') return;
    if (el.children.length && isLeaf(el) && !el.querySelector('input,select,textarea,button')) {
      var key = el.innerHTML.trim().replace(/\s+/g, ' '), ex = D.html[key];
      if (ex !== undefined) { el.innerHTML = ex; Array.prototype.forEach.call(el.querySelectorAll('[title]'), attrs); return; }
    }
    var kids = Array.prototype.slice.call(el.childNodes);
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  }
  function run(fn) { if (ob) ob.disconnect(); try { fn(); } finally { if (ob) ob.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder'] }); } }
  function start() {
    document.documentElement.setAttribute('lang', 'en');
    ob = new MutationObserver(function (recs) {
      run(function () {
        var seen = [];
        recs.forEach(function (r) {
          if (r.type === 'characterData') walk(r.target);
          else if (r.type === 'attributes') attrs(r.target);
          else if (r.addedNodes.length) { if (seen.indexOf(r.target) < 0) { seen.push(r.target); walk(r.target); } }
        });
      });
    });
    run(function () { walk(document.body); });
  }
  var _c = window.confirm, _a = window.alert;
  window.confirm = function (m) { return _c.call(window, T(m)); };
  window.alert = function (m) { return _a.call(window, T(m)); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

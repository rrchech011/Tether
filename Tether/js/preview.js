/* Tether - canli onizleme: kare kaydirici, oynat, onizlemede surukleyerek ofset / kadraj konumu ayari.
 * Tuval ekrandaki gercek boyutta cizilir; yuksekligi alttaki tutamacla degistirilir. Hesap: MaskParser.previewData; durum: window.MT. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var each = function (l, f) { Array.prototype.forEach.call(l, f); };
  var cv = $('cv'), g = cv.getContext('2d'), wrap = $('pvWrap'), box = $('preview');
  var data = null, L = null, cur = 0, timer = null, drag = false, deb = null;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var MIN_SHOW = 40, DEF_H = Math.max(64, Math.min(130, Math.round(window.innerHeight * 0.17)));   // panel boyuna gore

  var LEG = {
    attach: '<i style="background:#f97316"></i>nesne<i style="background:#38bdf8"></i>hedef · sürükle: hedefin yeri',
    snap: '<i style="background:#f97316"></i>nesne<i style="background:#38bdf8"></i>hedef · sürükle: nesneye göre yeri',
    stabilize: '<i style="background:#f97316"></i>nesne<i style="background:#38bdf8"></i>hedefin yeni konumu',
    follow: '<i style="background:#f97316"></i>nesne<i style="background:#38bdf8"></i>nesnenin yeri · sürükle: ayarla<i style="background:#5fcf80"></i>klip<i style="background:#f06b5b"></i>boşluk'
  };

  function prepare() {
    var T = window.MT;
    if (!T || !T.st.src || !T.st.tracks.length) { data = null; return; }
    var r;
    try { r = T.compute(T.previewTarget(), true); } catch (e) { data = null; return; }
    var pts = r.track.points;
    data = { d: MaskParser.previewData(pts, r.o), o: r.o, pts: pts, track: r.track };
    var sc = $('pvScrub'); sc.max = Math.max(0, pts.length - 1);
    cur = clamp(cur, 0, pts.length - 1); sc.value = cur;
    cv.style.cursor = r.o.mode === 'stabilize' ? 'default' : 'crosshair';
    $('pvLegend').innerHTML = LEG[r.o.mode] || '';
    $('pvLegend').title = $('pvLegend').textContent;
  }

  // tuvali ekrandaki boyuta esitle; sekans oranini koruyarak cerceveyi yerlestir
  function layout() {
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!data || w < 30 || h < 30) { L = null; return false; }
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var ar = data.o.seqW / data.o.seqH, m = Math.min(14, w * 0.06, h * 0.12), fw = Math.min(w - 2 * m, (h - 2 * m) * ar), fh = fw / ar;
    L = { w: w, h: h, dpr: dpr, fx: (w - fw) / 2, fy: (h - fh) / 2, fw: fw, fh: fh };
    return true;
  }

  function render() {
    box.classList.toggle('empty', !data);
    $('pvTitle').textContent = data ? 'Önizleme' : 'Önizleme · takip bitince görünür';
    if (!data) { $('pvTime').textContent = ''; return; }
    if (!layout()) return;
    var d = data.d, o = data.o, i = cur, n = data.pts.length;
    var X = function (v) { return L.fx + v * L.fw; }, Y = function (v) { return L.fy + v * L.fh; };
    g.setTransform(L.dpr, 0, 0, L.dpr, 0, 0); g.setLineDash([]);
    g.fillStyle = '#161616'; g.fillRect(0, 0, L.w, L.h);
    g.fillStyle = '#1e1e1e'; g.fillRect(L.fx, L.fy, L.fw, L.fh);
    g.strokeStyle = '#2d2d2d'; g.lineWidth = 1; g.beginPath();            // ucte bir kilavuzu
    [1 / 3, 2 / 3].forEach(function (t) { g.moveTo(X(t), L.fy); g.lineTo(X(t), L.fy + L.fh); g.moveTo(L.fx, Y(t)); g.lineTo(L.fx + L.fw, Y(t)); });
    g.stroke();
    g.strokeStyle = '#6a6a6a'; g.lineWidth = 1; g.strokeRect(L.fx + .5, L.fy + .5, L.fw - 1, L.fh - 1);

    function poly(arr, col, w) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      arr.forEach(function (p, k) { if (k) g.lineTo(X(p[0]), Y(p[1])); else g.moveTo(X(p[0]), Y(p[1])); });
      g.stroke();
    }
    function dot(p, col, r) { g.fillStyle = col; g.beginPath(); g.arc(X(p[0]), Y(p[1]), r, 0, 6.2832); g.fill(); }
    function cross(p, col, s) {
      g.strokeStyle = col; g.lineWidth = 1.8; g.beginPath();
      g.moveTo(X(p[0]) - s, Y(p[1])); g.lineTo(X(p[0]) + s, Y(p[1])); g.moveTo(X(p[0]), Y(p[1]) - s); g.lineTo(X(p[0]), Y(p[1]) + s); g.stroke();
    }
    var gap = false;
    if (o.mode === 'follow') {
      poly(d.S, '#666', 1.2);                                              // nesnenin kadrajdaki izi
      var oi = d.out[i], wi = d.wNs[i], hi = d.hNs[i], left = oi.x - d.A[0] * wi, top = oi.y - d.A[1] * hi;
      gap = left > 1e-4 || top > 1e-4 || left + wi < 1 - 1e-4 || top + hi < 1 - 1e-4;
      g.save(); g.setLineDash([6, 4]); g.strokeStyle = gap ? '#f06b5b' : '#5fcf80'; g.lineWidth = 1.5;
      g.strokeRect(X(left), Y(top), wi * L.fw, hi * L.fh); g.restore();
      cross(o.pin, '#38bdf8', 7);
      dot(d.S[i], '#f97316', 4);
    } else {
      var outXY = d.out.map(function (p) { return [p.x, p.y]; });
      poly(d.Q, '#666', 1.2);                                              // nesnenin yolu
      poly(outXY, 'rgba(56,189,248,.75)', 1.2);                            // hedefin yolu
      dot(d.Q[0], '#22c55e', 3); dot(d.Q[n - 1], '#ef4444', 3);
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(d.Q[i][0]), Y(d.Q[i][1])); g.lineTo(X(outXY[i][0]), Y(outXY[i][1])); g.stroke(); g.restore();
      cross(outXY[i], '#38bdf8', 7);
      dot(d.Q[i], '#f97316', 4);
    }
    if (gap) { g.fillStyle = '#f06b5b'; g.font = '600 11px sans-serif'; g.fillText('Kenarda boşluk var', 6, 14); }
    var t = data.pts[i].tl - data.track.clipStartSec;
    $('pvTime').textContent = t.toFixed(2) + ' sn · ' + (i + 1) + '/' + n + (o.mode === 'follow' && d.out[i].z ? ' · %' + Math.round(d.out[i].z) : '');
  }

  function refresh() { prepare(); render(); }
  function sched() { clearTimeout(deb); deb = setTimeout(refresh, 40); }

  // ---- fareyle ayar ----
  function pos(e) {
    var r = cv.getBoundingClientRect();
    return [(e.clientX - r.left - L.fx) / L.fw, (e.clientY - r.top - L.fy) / L.fh];
  }
  function setv(id, v) { $(id).value = v; }
  function applyDrag(p) {
    var o = data.o, b = data.d.out[cur];
    if (o.mode === 'follow') {
      setv('pinX', clamp(Math.round(p[0] * 100), 0, 100)); setv('pinY', clamp(Math.round(p[1] * 100), 0, 100));
    } else if (o.mode === 'attach' || o.mode === 'snap') {
      setv('offX', Math.round((p[0] - (b.x - o.offset[0] / o.seqW)) * o.seqW));
      setv('offY', Math.round((p[1] - (b.y - o.offset[1] / o.seqH)) * o.seqH));
    } else return;
    refresh();
  }
  cv.addEventListener('mousedown', function (e) { if (!data || !L) return; stop(); drag = true; applyDrag(pos(e)); e.preventDefault(); });
  window.addEventListener('mousemove', function (e) { if (drag && data && L) applyDrag(pos(e)); });
  window.addEventListener('mouseup', function () { if (drag) { drag = false; if (window.MT) { window.MT.save(); window.MT.touch(); } } });

  // ---- sifirla: onizlemede surukleyerek yapilan ayari varsayilana dondur ----
  function resetAdjust() {
    setv('offX', 0); setv('offY', 0); setv('pinX', 50); setv('pinY', 50);
    refresh();
    if (window.MT) { window.MT.save(); window.MT.touch(); }
  }
  $('pvReset').onclick = resetAdjust;
  cv.addEventListener('dblclick', resetAdjust);

  // ---- kaydirici / oynat ----
  $('pvScrub').addEventListener('input', function () { stop(); cur = Number(this.value) || 0; render(); });
  function stop() { if (timer) { clearInterval(timer); timer = null; $('pvPlay').textContent = '▶'; } }
  $('pvPlay').onclick = function () {
    if (timer) return stop();
    if (!data) return;
    $('pvPlay').textContent = '■';
    timer = setInterval(function () { cur = (cur + 1) % data.pts.length; $('pvScrub').value = cur; render(); }, 40);
  };

  // ---- boyut tutamaci ----
  var pvh = DEF_H;
  try { var sv = Number(localStorage.getItem('tether_pvh')); if (sv >= 0 && localStorage.getItem('tether_pvh') !== null) pvh = sv; } catch (e) {}
  function maxH() { return Math.max(60, Math.round(window.innerHeight * 0.55)); }
  function setH(h, save) {
    pvh = clamp(Math.round(h), 0, maxH());
    box.style.setProperty('--pvh', Math.max(pvh, 60) + 'px');
    box.classList.toggle('min', pvh < MIN_SHOW);
    if (save) { try { localStorage.setItem('tether_pvh', String(pvh)); } catch (e) {} }
    render();
  }
  var gs = null;
  $('pvGrip').addEventListener('mousedown', function (e) { gs = { y: e.clientY, h: box.classList.contains('min') ? 0 : wrap.clientHeight }; e.preventDefault(); });
  window.addEventListener('mousemove', function (e) { if (gs) setH(gs.h + (e.clientY - gs.y), false); });
  window.addEventListener('mouseup', function () { if (gs) { gs = null; try { localStorage.setItem('tether_pvh', String(pvh)); } catch (e) {} } });
  $('pvGrip').addEventListener('dblclick', function () { setH(box.classList.contains('min') ? DEF_H : 0, true); });

  // ---- ayar degisince canli guncelle ----
  each(document.querySelectorAll('#pSet input, #pSet select'), function (el) { el.addEventListener('input', sched); el.addEventListener('change', sched); });
  $('mode').addEventListener('change', sched);
  $('selMask').addEventListener('change', sched);
  window.addEventListener('resize', function () { if (pvh > maxH()) setH(maxH(), false); else render(); });

  window.MTPreview = {
    refresh: refresh,
    frame: function () { return L; },
    show: function () { if (box.classList.contains('min')) setH(DEF_H, true); }
  };
  setH(pvh, false);
})();

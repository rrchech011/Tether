/* Tether Tracker — kendi izleyicimiz (After Effects tarzi nokta/bolge takibi).
 * Hat: ffmpeg (kare okuma) -> gri kareler -> piramidal Lucas-Kanade + benzerlik donusumu (konum, olcek, donme) -> noktalar
 * Cikis noktalari Tether'in mevcut hattiyla ayni bicimdedir: { src (tick), cx, cy (0-1), bbox [x,y,w,h px], bn [w,h 0-1], raw }.
 * Veri uydurmaz: izleyici nesneyi kaybederse durur ve bunu bildirir. Saf JS; tarayici (CEP/Node) ve Node'da calisir. */
(function (root) {
  'use strict';
  var cp = null, fs = null, path = null;
  try { cp = require('child_process'); fs = require('fs'); path = require('path'); } catch (e) {}

  /* ---------------- ffmpeg ---------------- */
  function findFfmpeg(extDir) {
    var cands = [];
    if (process && process.env && process.env.TETHER_FFMPEG) cands.push(process.env.TETHER_FFMPEG);
    if (extDir && path) { cands.push(path.join(extDir, 'ffmpeg.exe'), path.join(extDir, 'bin', 'ffmpeg.exe'), path.join(extDir, 'ffmpeg'), path.join(extDir, 'bin', 'ffmpeg')); }
    try {   // guncellemede silinmeyen kalici klasor: CEP\Tether_ffmpeg
      var os0 = require('os'), base = process.platform === 'win32' ? path.join(process.env.APPDATA || os0.homedir(), 'Adobe', 'CEP') : path.join(os0.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP');
      cands.push(path.join(base, 'Tether_ffmpeg', 'ffmpeg.exe'), path.join(base, 'Tether_ffmpeg', 'ffmpeg'));
    } catch (e) {}
    cands.push('ffmpeg');
    for (var i = 0; i < cands.length; i++) {
      try {
        if (cands[i] !== 'ffmpeg' && !fs.existsSync(cands[i])) continue;
        var r = cp.spawnSync(cands[i], ['-version'], { timeout: 8000, windowsHide: true });
        if (r && r.status === 0) return cands[i];
      } catch (e) {}
    }
    return null;
  }
  function probe(ffmpeg, file) {   // genislik, yukseklik
    var r = cp.spawnSync(ffmpeg, ['-hide_banner', '-i', file], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    var t = (r.stderr || '') + (r.stdout || ''), m = /Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(t);
    if (!m) return null;
    var rot = /rotate\s*:\s*(-?\d+)/.exec(t);
    return { w: +m[1], h: +m[2], rotate: rot ? +rot[1] : 0 };
  }
  /* Bir araligi gri ham kareler olarak okur. cb(err, {frames:[Uint8Array], w, h}) */
  function readFrames(ffmpeg, file, t0, dur, fps, W, H, cb, onProg, signal) {
    var args = ['-v', 'error', '-ss', String(Math.max(0, t0)), '-i', file, '-t', String(dur), '-an', '-vf', 'fps=' + fps + ',scale=' + W + ':' + H + ':flags=area,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
    var p = cp.spawn(ffmpeg, args, { windowsHide: true }), size = W * H, frames = [], buf = Buffer.alloc(0), err = '';
    if (signal) signal.kill = function () { try { p.kill(); } catch (e) {} };
    p.stdout.on('data', function (d) {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) { frames.push(new Uint8Array(buf.subarray(0, size))); buf = buf.subarray(size); if (onProg) onProg(frames.length); }
    });
    p.stderr.on('data', function (d) { err += d.toString(); });
    p.on('error', function (e) { cb('ffmpeg çalıştırılamadı: ' + e.message); });
    p.on('close', function (code) { if (!frames.length) cb('ffmpeg kare üretmedi' + (err ? ': ' + err.slice(0, 300) : '')); else if (code !== 0 && code !== null && !(signal && signal.killed)) cb('ffmpeg yarıda kesildi (kod ' + code + '), ' + frames.length + ' kare okundu' + (err ? ': ' + err.slice(0, 200) : '')); else cb(null, { frames: frames, w: W, h: H }); });
  }
  function readOneFramePng(ffmpeg, file, t, outPng, cb) {
    var p = cp.spawn(ffmpeg, ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', outPng], { windowsHide: true }), err = '';
    p.stderr.on('data', function (d) { err += d.toString(); });
    p.on('error', function (e) { cb(e.message); });
    p.on('close', function (c) { fs.existsSync(outPng) ? cb(null) : cb('kare alınamadı' + (err ? ': ' + err.slice(0, 200) : '')); });
  }

  /* ---------------- goruntu yardimcilari ---------------- */
  function toFloat(u8) { var f = new Float32Array(u8.length); for (var i = 0; i < u8.length; i++) f[i] = u8[i]; return f; }
  function blurDown(src, w, h) {     // 5-tap [1 4 6 4 1]/16 ayrik bulaniklastir + 2'ye indir
    var k = [1, 4, 6, 4, 1], tmp = new Float32Array(w * h), x, y, j, s;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      s = 0; for (j = -2; j <= 2; j++) { var xx = x + j; if (xx < 0) xx = -xx; if (xx >= w) xx = 2 * w - 2 - xx; s += k[j + 2] * src[y * w + xx]; }
      tmp[y * w + x] = s / 16;
    }
    var w2 = w >> 1, h2 = h >> 1, out = new Float32Array(w2 * h2);
    for (y = 0; y < h2; y++) for (x = 0; x < w2; x++) {
      s = 0; var yc = y * 2, xc = x * 2;
      for (j = -2; j <= 2; j++) { var yy = yc + j; if (yy < 0) yy = -yy; if (yy >= h) yy = 2 * h - 2 - yy; s += k[j + 2] * tmp[yy * w + xc]; }
      out[y * w2 + x] = s / 16;
    }
    return { data: out, w: w2, h: h2 };
  }
  /* Gurultu / sikistirma izini azalt: ayrik [1 4 6 4 1]/16 bulaniklastirma, `times` kez. Dokusuz yuzeylerde (sac, duz kiyafet) LK gurultuyu izlemesin. */
  function smoothFrame(u8, w, h, times) {
    var k = [1, 4, 6, 4, 1], a = toFloat(u8), b = new Float32Array(w * h), t, x, y, j, s, xx, yy;
    for (t = 0; t < times; t++) {
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { s = 0; for (j = -2; j <= 2; j++) { xx = x + j; if (xx < 0) xx = -xx; if (xx >= w) xx = 2 * w - 2 - xx; s += k[j + 2] * a[y * w + xx]; } b[y * w + x] = s / 16; }
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { s = 0; for (j = -2; j <= 2; j++) { yy = y + j; if (yy < 0) yy = -yy; if (yy >= h) yy = 2 * h - 2 - yy; s += k[j + 2] * b[yy * w + x]; } a[y * w + x] = s / 16; }
    }
    return a;
  }
  function pyramid(u8, w, h, levels) {
    var L = [{ data: toFloat(u8), w: w, h: h }];
    for (var i = 1; i < levels; i++) { var p = L[i - 1]; if (p.w < 24 || p.h < 24) break; L.push(blurDown(p.data, p.w, p.h)); }
    return L;
  }
  function bil(im, x, y) {
    var w = im.w, h = im.h;
    if (x < 0) x = 0; else if (x > w - 1.001) x = w - 1.001;
    if (y < 0) y = 0; else if (y > h - 1.001) y = h - 1.001;
    var x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, d = im.data, i = y0 * w + x0;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }

  /* ---------------- Lucas-Kanade (tek nokta, tek seviye) ---------------- */
  function lkLevel(I, J, px, py, gx, gy, R, iters) {
    // I: onceki, J: simdiki. (px,py) I'deki nokta. (gx,gy) baslangic oteleme. Donus: {dx,dy,err,ok}
    var n = (2 * R + 1) * (2 * R + 1), ti = new Float32Array(n), ix = new Float32Array(n), iy = new Float32Array(n), a = 0, b = 0, c = 0, k = 0, x, y;
    for (y = -R; y <= R; y++) for (x = -R; x <= R; x++) {
      var X = px + x, Y = py + y, v = bil(I, X, Y), gX = (bil(I, X + 1, Y) - bil(I, X - 1, Y)) * 0.5, gY = (bil(I, X, Y + 1) - bil(I, X, Y - 1)) * 0.5;
      ti[k] = v; ix[k] = gX; iy[k] = gY; a += gX * gX; b += gX * gY; c += gY * gY; k++;
    }
    var det = a * c - b * b, tr = a + c;
    if (det < 1e-6 || (tr / n) < 0.5) return { ok: false, dx: gx, dy: gy, err: 1e9 };
    var ia = c / det, ib = -b / det, ic = a / det, dx = gx, dy = gy, err = 0;
    for (var it = 0; it < iters; it++) {
      var bx = 0, by = 0; k = 0; err = 0;
      for (y = -R; y <= R; y++) for (x = -R; x <= R; x++) {
        var e = ti[k] - bil(J, px + x + dx, py + y + dy);
        bx += ix[k] * e; by += iy[k] * e; err += e * e; k++;
      }
      var ux = ia * bx + ib * by, uy = ib * bx + ic * by;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < 1e-4) break;
      if (Math.abs(dx - gx) > R * 3 || Math.abs(dy - gy) > R * 3) return { ok: false, dx: gx, dy: gy, err: 1e9 };
    }
    return { ok: true, dx: dx, dy: dy, err: Math.sqrt(err / n) };
  }
  function lkPyr(PI, PJ, x, y, R, iters, g0) {
    var L = Math.min(PI.length, PJ.length) - 1, gx = g0 ? g0[0] / (1 << L) : 0, gy = g0 ? g0[1] / (1 << L) : 0, lv, r;
    for (lv = L; lv >= 0; lv--) {
      var s = 1 << lv; r = lkLevel(PI[lv], PJ[lv], x / s, y / s, gx, gy, R, iters);
      if (!r.ok && lv === 0) return { ok: false };
      gx = r.dx; gy = r.dy; if (lv > 0) { gx *= 2; gy *= 2; }
    }
    return { ok: r.ok, dx: gx, dy: gy, err: r.err };
  }

  /* ---------------- kose (Shi-Tomasi) ---------------- */
  var MIN_EV = 40;   // kose kalitesi alt siniri (5x5 pencere, min ozdeger): gurultu / duz yuzeyi kose sanmasin
  function detect(img, poly, maxN, minDist, core, minEv) {
    var w = img.w, h = img.h, d = img.data, xs = [], ys = [], i;
    for (i = 0; i < 4; i++) { xs.push(poly[i][0]); ys.push(poly[i][1]); }
    var x0 = Math.max(4, Math.floor(Math.min.apply(null, xs))), x1 = Math.min(w - 5, Math.ceil(Math.max.apply(null, xs)));
    var y0 = Math.max(4, Math.floor(Math.min.apply(null, ys))), y1 = Math.min(h - 5, Math.ceil(Math.max.apply(null, ys)));
    if (x1 - x0 < 6 || y1 - y0 < 6) return [];
    var cand = [], x, y, yy, xx, ecx = (x0 + x1) / 2, ecy = (y0 + y1) / 2, ehw = Math.max(1, (x1 - x0) / 2 * (core || 1)), ehh = Math.max(1, (y1 - y0) / 2 * (core || 1));
    for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) {
      if (!inPoly(poly, x, y)) continue;
      if (core && core < 1 && ((x - ecx) * (x - ecx)) / (ehw * ehw) + ((y - ecy) * (y - ecy)) / (ehh * ehh) > 1) continue;   // kutunun elips cekirdegi: koselerdeki arka plani ele
      var a = 0, b = 0, c = 0;
      for (yy = -2; yy <= 2; yy++) for (xx = -2; xx <= 2; xx++) {
        var p = (y + yy) * w + (x + xx), gx = (d[p + 1] - d[p - 1]) * 0.5, gy = (d[p + w] - d[p - w]) * 0.5; a += gx * gx; b += gx * gy; c += gy * gy;
      }
      var tr = a + c, det = a * c - b * b, ev = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
      if (ev >= (minEv || MIN_EV)) cand.push([ev, x, y]);
    }
    if (!cand.length) return [];
    cand.sort(function (p, q) { return q[0] - p[0]; });
    var best = cand[0][0], out = [], md2 = minDist * minDist;
    for (i = 0; i < cand.length && out.length < maxN; i++) {
      if (cand[i][0] < best * 0.02) break;
      var ok = true; for (var j = 0; j < out.length; j++) { var dx = out[j][0] - cand[i][1], dy = out[j][1] - cand[i][2]; if (dx * dx + dy * dy < md2) { ok = false; break; } }
      if (ok) out.push([cand[i][1], cand[i][2]]);
    }
    return out;
  }
  function inPoly(poly, x, y) {
    var inside = false, n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------------- benzerlik donusumu (olcek + donme + oteleme), saglam ---------------- */
  function fitSim(P, Q, keep) {
    // x' = a*x - b*y + tx ; y' = b*x + a*y + ty
    var idx = [], i, it;
    for (i = 0; i < P.length; i++) idx.push(i);
    var res = null;
    for (it = 0; it < 4; it++) {
      var n = idx.length; if (n < 3) break;
      var mx = 0, my = 0, nx = 0, ny = 0;
      for (i = 0; i < n; i++) { mx += P[idx[i]][0]; my += P[idx[i]][1]; nx += Q[idx[i]][0]; ny += Q[idx[i]][1]; }
      mx /= n; my /= n; nx /= n; ny /= n;
      var sxx = 0, num_a = 0, num_b = 0;
      for (i = 0; i < n; i++) {
        var px = P[idx[i]][0] - mx, py = P[idx[i]][1] - my, qx = Q[idx[i]][0] - nx, qy = Q[idx[i]][1] - ny;
        sxx += px * px + py * py; num_a += px * qx + py * qy; num_b += px * qy - py * qx;
      }
      if (sxx < 1e-6) break;
      var a = num_a / sxx, b = num_b / sxx, tx = nx - (a * mx - b * my), ty = ny - (b * mx + a * my);
      var r = [], j;
      for (j = 0; j < P.length; j++) { var X = a * P[j][0] - b * P[j][1] + tx, Y = b * P[j][0] + a * P[j][1] + ty; r.push(Math.sqrt((X - Q[j][0]) * (X - Q[j][0]) + (Y - Q[j][1]) * (Y - Q[j][1]))); }
      var sr = idx.map(function (k) { return r[k]; }).sort(function (u, v) { return u - v; }), med = sr[Math.floor(sr.length / 2)], thr = Math.max(0.8, 2.5 * med * 1.4826);
      res = { a: a, b: b, tx: tx, ty: ty, inl: idx.length, med: med };
      var nidx = []; for (j = 0; j < P.length; j++) if (r[j] <= thr && idx.indexOf(j) >= 0) nidx.push(j);
      if (nidx.length === idx.length || nidx.length < 3) { res.keep = idx; break; }
      idx = nidx; res.keep = idx;
    }
    return res;
  }
  /* Yalniz oteleme modeli (kafa / yuz gibi katı olmayan nesneler): olcek ve donme tahmin edilmez, birikmez.
   * Medyan oteleme + saglam aykiri nokta eleme. Donus fitSim ile ayni bicimde (a=1,b=0). */
  function transFit(P, Q) {
    var n = P.length; if (n < 3) return null;
    var dxs = [], dys = [], i;
    for (i = 0; i < n; i++) { dxs.push(Q[i][0] - P[i][0]); dys.push(Q[i][1] - P[i][1]); }
    var mdx = median(dxs), mdy = median(dys), res = [];
    for (i = 0; i < n; i++) res.push(Math.hypot(dxs[i] - mdx, dys[i] - mdy));
    var thr = Math.max(1.2, 2.5 * 1.4826 * median(res)), keep = [], sx = 0, sy = 0;
    for (i = 0; i < n; i++) if (res[i] <= thr) { keep.push(i); sx += dxs[i]; sy += dys[i]; }
    if (keep.length < 3) return null;
    return { a: 1, b: 0, tx: sx / keep.length, ty: sy / keep.length, keep: keep, inl: keep.length, trans: true };
  }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

  /* ---------------- yuksek geciren goruntu: duz gecisleri (gradyan) ve isik farkini atar; ZNCC'yi ayirt edici yapar ---------------- */
  function hpLevel(P, L) {
    if (L >= P.length) L = P.length - 1;
    var im = P[L]; if (im._hp) return im._hp;
    var w = im.w, h = im.h, d = im.data, tmp = new Float32Array(w * h), o = new Float32Array(w * h), x, y, j, sum, k = [1, 4, 6, 4, 1];
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { sum = 0; for (j = -2; j <= 2; j++) { var xx = Math.min(w - 1, Math.max(0, x + j)); sum += k[j + 2] * d[y * w + xx]; } tmp[y * w + x] = sum / 16; }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) { sum = 0; for (j = -2; j <= 2; j++) { var yy = Math.min(h - 1, Math.max(0, y + j)); sum += k[j + 2] * tmp[yy * w + x]; } o[y * w + x] = d[y * w + x] - sum / 16; }
    // ikinci, genis bulaniklik (daha dusuk frekansi da at): yaklasik 4x4 kutu
    var t2 = new Float32Array(w * h), o2 = new Float32Array(w * h), r = 4;
    for (y = 0; y < h; y++) { var acc = 0, cnt = 0; for (x = -r; x <= r; x++) { if (x >= 0 && x < w) { acc += d[y * w + x]; cnt++; } } for (x = 0; x < w; x++) { t2[y * w + x] = acc / cnt; var xa = x - r, xb = x + r + 1; if (xa >= 0) { acc -= d[y * w + xa]; cnt--; } if (xb < w) { acc += d[y * w + xb]; cnt++; } } }
    for (x = 0; x < w; x++) { var ac = 0, cn = 0; for (y = -r; y <= r; y++) { if (y >= 0 && y < h) { ac += t2[y * w + x]; cn++; } } for (y = 0; y < h; y++) { o2[y * w + x] = ac / cn; var ya = y - r, yb = y + r + 1; if (ya >= 0) { ac -= t2[ya * w + x]; cn--; } if (yb < h) { ac += t2[yb * w + x]; cn++; } } }
    for (var i = 0; i < o.length; i++) o[i] = (d[i] - o2[i]) * 0.6 + o[i] * 0.4;
    im._hp = { data: o, w: w, h: h }; return im._hp;
  }
  function hpPyr(P) { return [hpLevel(P, 0), hpLevel(P, 1), hpLevel(P, 2)]; }

  /* ---------------- sablon (nesne gorunumu) ---------------- */
  function even(n) { n = Math.round(n); return Math.max(6, n - (n % 2)); }
  function polyBox(poly) {
    var xs = poly.map(function (p) { return p[0]; }), ys = poly.map(function (p) { return p[1]; });
    return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs), y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys) };
  }
  function meanSub(t) { var m = 0, v = 0, i; for (i = 0; i < t.length; i++) m += t[i]; m /= t.length; for (i = 0; i < t.length; i++) { t[i] -= m; v += t[i] * t[i]; } return v; }
  // Piramit P'nin L seviyesinden (cx0,cy0: seviye-0 koordinati, hw0/hh0: seviye-0 yari boyut) sablon kirp
  function cropTpl(P, L, cx0, cy0, hw0, hh0, sc) {   // P: normal piramit; hp goruntu icerde (gerektiginde) hesaplanir
    if (L >= P.length) L = P.length - 1;
    var img = hpLevel(P, L), sl = 1 << L, tw = even(2 * hw0 * sc / sl), th = even(2 * hh0 * sc / sl), cx = cx0 / sl, cy = cy0 / sl, t = new Float32Array(tw * th), x, y;
    for (y = 0; y < th; y++) for (x = 0; x < tw; x++) t[y * tw + x] = bil(img, cx - tw / 2 + x + 0.5, cy - th / 2 + y + 0.5);
    var v = meanSub(t); if (v < tw * th * 3) return null;
    return { t: t, tw: tw, th: th, sd: Math.sqrt(v / (tw * th)) };
  }
  function makeTpl(P, poly, scaleRef) {
    var bx = polyBox(poly), cx0 = (bx.x0 + bx.x1) / 2, cy0 = (bx.y0 + bx.y1) / 2;
    var hw0 = Math.max(10, Math.min(64, (bx.x1 - bx.x0) * 0.45)), hh0 = Math.max(10, Math.min(64, (bx.y1 - bx.y0) * 0.45));
    var T = { hw0: hw0, hh0: hh0, s: scaleRef, L: [null], P: P, cx0: cx0, cy0: cy0 };
    T.L.push(cropTpl(P, 1, cx0, cy0, hw0, hh0, 1)); T.L.push(cropTpl(P, 2, cx0, cy0, hw0, hh0, 1));
    if (!T.L[1] || !T.L[2]) return null;
    T.sd = T.L[1].sd;       // sablonun yuksek-frekans gucu: dusukse (pürüzsüz yuz / bulanik) gorunum kontrolu GUVENILMEZ
    return T;
  }
  function scaledTpl(T, L, sc) { return cropTpl(T.P, L, T.cx0, T.cy0, T.hw0, T.hh0, sc); }
  function zn(img, tp, cx, cy) {                // sablon merkezi (cx,cy) img piksel koordinati; stride 2
    var x0 = Math.round(cx - tp.tw / 2), y0 = Math.round(cy - tp.th / 2);
    if (x0 < 0 || y0 < 0 || x0 + tp.tw >= img.w || y0 + tp.th >= img.h) return -1;
    var d = img.data, m = 0, c = 0, v = 0, tv = 0, x, y, cnt = 0, q;
    for (y = 0; y < tp.th; y += 2) for (x = 0; x < tp.tw; x += 2) { m += d[(y0 + y) * img.w + x0 + x]; cnt++; }
    m /= cnt;
    for (y = 0; y < tp.th; y += 2) for (x = 0; x < tp.tw; x += 2) { q = d[(y0 + y) * img.w + x0 + x] - m; var t = tp.t[y * tp.tw + x]; v += q * q; c += q * t; tv += t * t; }
    if (v < 1e-3 || tv < 1e-3) return -1;
    return c / Math.sqrt(v * tv);
  }
  function bestAround(img, tp, cx, cy, rad, step) {
    var best = -2, bx = cx, by = cy, x, y;
    for (y = -rad; y <= rad; y += step) for (x = -rad; x <= rad; x += step) { var sc = zn(img, tp, cx + x, cy + y); if (sc > best) { best = sc; bx = cx + x; by = cy + y; } }
    return { s: best, x: bx, y: by };
  }
  // En iyi eslesme + ondan >= minSep piksel uzaktaki en iyi ikinci eslesme (ayirt edicilik: gercek nesne arka plandan belirgin ayrilir)
  function bestAround2(img, tp, cx, cy, rad, step, minSep) {
    var n = Math.floor(2 * rad / step) + 1, grid = new Float32Array(n * n), best = -2, bi = 0, bj = 0, i, j;
    for (j = 0; j < n; j++) for (i = 0; i < n; i++) { var sc = zn(img, tp, cx - rad + i * step, cy - rad + j * step); grid[j * n + i] = sc; if (sc > best) { best = sc; bi = i; bj = j; } }
    var second = -2, sep = Math.max(1, Math.ceil(minSep / step));
    for (j = 0; j < n; j++) for (i = 0; i < n; i++) { if (Math.abs(i - bi) <= sep && Math.abs(j - bj) <= sep) continue; if (grid[j * n + i] > second) second = grid[j * n + i]; }
    return { s: best, s2: second, x: cx - rad + bi * step, y: cy - rad + bj * step };
  }
  /* Kayip nesneyi yeniden bul. Tahmini merkez pc (seviye-0), k: kayip kare sayisi. Dondur: {x,y,sc,score} ya da null */
  var DBG = null;
  function reacquire(Pi, Ts, pc, k, curS, noScale) {
    var L2 = hpLevel(Pi, 2), L1 = hpLevel(Pi, 1), L0 = null, best = null, ti, si;
    var scales = [1]; if (!noScale) { if (k >= 4) scales.push(0.85, 1.18); if (k >= 16) scales.push(0.7, 1.4); }
    var full = k > 24, rad = full ? Math.max(L2.w, L2.h) : Math.min(Math.max(L2.w, L2.h), 8 + 3 * k), stp = rad > 28 ? 2 : 1;
    for (ti = 0; ti < Ts.length; ti++) {
      var T = Ts[ti]; if (!T) continue;
      for (si = 0; si < scales.length; si++) {
        var sc = scales[si] * (curS / T.s), tp = scaledTpl(T, 2, sc); if (!tp) continue;
        var cx2 = full ? L2.w / 2 : pc[0] / 4, cy2 = full ? L2.h / 2 : pc[1] / 4, r = full ? Math.max(L2.w, L2.h) / 2 : rad;
        var b = bestAround2(L2, tp, cx2, cy2, Math.min(Math.floor(r), 140), stp, 7);
        var distinct = b.s >= 0.62 || (b.s >= 0.45 && b.s - b.s2 >= 0.12);   // belirgin tepe mi? (arka plandaki dokuya kilitlenmeyi onler)
        if (distinct && (!best || b.s > best.c2)) best = { c2: b.s, s2: b.s2, x2: b.x, y2: b.y, sc: sc, T: T };
      }
    }
    if (!best) { if (typeof DBG === 'function') DBG('  k=' + k + ' coarse: yok'); return null; }
    var tp1 = scaledTpl(best.T, 1, best.sc); if (!tp1) return null;
    var f1 = bestAround(L1, tp1, best.x2 * 2, best.y2 * 2, 5, 1), bsc = best.sc, rs;
    var fac = [0.8, 0.87, 0.93, 1.07, 1.15, 1.25];
    for (rs = 0; rs < (noScale ? 0 : fac.length); rs++) {                // olcegi seviye-1'de incelt
      var sc2 = best.sc * fac[rs], tq = scaledTpl(best.T, 1, sc2); if (!tq) continue;
      var fq = bestAround(L1, tq, f1.x, f1.y, 3, 1); if (fq.s > f1.s + 0.01) { f1 = fq; bsc = sc2; }
    }
    best.sc = bsc; tp1 = scaledTpl(best.T, 1, bsc);
    if (typeof DBG === 'function') DBG('  k=' + k + ' coarse ' + best.c2.toFixed(2) + ' @' + (best.x2*4) + ',' + (best.y2*4) + ' sc=' + best.sc.toFixed(2) + ' refine ' + f1.s.toFixed(2));
    if (f1.s < 0.5) return null;
    if (best.sc / (curS / best.T.s) < (k < 16 ? 0.78 : 0.6) || best.sc / (curS / best.T.s) > (k < 16 ? 1.3 : 1.7)) return null;   // kisa kapanmada olcek aniden degismez
    var X = f1.x * 2, Y = f1.y * 2, tp0 = scaledTpl(best.T, 0, best.sc), s0 = 0;
    if (tp0) { L0 = hpLevel(Pi, 0); var f0 = bestAround(L0, tp0, X, Y, 4, 1); s0 = f0.s; if (f0.s > 0.3) { X = f0.x; Y = f0.y; } }
    return { x: X, y: Y, sc: best.sc / (curS / best.T.s), score: f1.s, s0: s0, c2: best.c2, gap: best.c2 - (best.s2 === undefined ? 0 : best.s2) };
  }

  /* ---------------- sablon eslestirme izleyici (After Effects tarzi: arama bolgesi + hiz tahmini + sablon uyarlama) ----------------
   * Dokusuz / hizli / kose bulunmayan nesneler icin. Ayni sonuc bicimini uretir. Yalniz konum izler (olcek 1, donme 0). */
  function tplIntegral(img) {
    var w = img.w, h = img.h, W = w + 1, S = new Float64Array(W * (h + 1)), Q = new Float64Array(W * (h + 1)), d = img.data, x, y, rs, rq, v;
    for (y = 0; y < h; y++) { rs = 0; rq = 0; for (x = 0; x < w; x++) { v = d[y * w + x]; rs += v; rq += v * v; S[(y + 1) * W + x + 1] = S[y * W + x + 1] + rs; Q[(y + 1) * W + x + 1] = Q[y * W + x + 1] + rq; } }
    img._S = S; img._Q = Q;
  }
  function tplGet(P, L, cx, cy, rw, rh, ow, oh) {    // seviye L'de: merkez (cx,cy: seviye-0 koordinati), kaynak bolge rw x rh (seviye-0 px) -> ow x oh seviye-L piksel sablon (ortalamasi cikarilmis)
    var img = P[L], sl = 1 << L, tw = Math.max(6, Math.round(ow === undefined ? rw / sl : ow)), th = Math.max(6, Math.round(oh === undefined ? rh / sl : oh)), t = new Float32Array(tw * th), x, y, m = 0, v = 0;
    var kx = rw / sl / tw, ky = rh / sl / th;
    for (y = 0; y < th; y++) for (x = 0; x < tw; x++) { t[y * tw + x] = bil(img, cx / sl + (x + 0.5 - tw / 2) * kx, cy / sl + (y + 0.5 - th / 2) * ky); m += t[y * tw + x]; }
    m /= t.length; for (x = 0; x < t.length; x++) { t[x] -= m; v += t[x] * t[x]; }
    return { t: t, tw: tw, th: th, v: v, m: m, sd: Math.sqrt(v / t.length) };
  }
  // seviye-L goruntusunde (cx,cy) merkezli +-R pikselde en iyi ZNCC. Dondur {s,x,y(seviye L px), g (skor izgarasi)}
  function tplMatch(img, tp, cx, cy, R, wantGrid, Ry) {
    if (Ry === undefined) Ry = R;
    if (!img._S) tplIntegral(img);
    var S = img._S, Q = img._Q, W = img.w + 1, d = img.data, iw = img.w, ih = img.h, tw = tp.tw, th = tp.th, n = tw * th, T = tp.t;
    var bx0 = Math.round(cx - tw / 2), by0 = Math.round(cy - th / 2), best = -2, bxx = bx0, byy = by0, n2 = 2 * R + 1, g = wantGrid ? new Float32Array(n2 * n2).fill(-2) : null, dx, dy, x, y;
    if (tp.v < 1e-3) return { s: -1, x: cx, y: cy, g: g, R: R };
    for (dy = -Ry; dy <= Ry; dy++) {
      var y0 = by0 + dy; if (y0 < 0 || y0 + th > ih) continue;
      for (dx = -R; dx <= R; dx++) {
        var x0 = bx0 + dx; if (x0 < 0 || x0 + tw > iw) continue;
        var a = (y0 + th) * W + x0 + tw, b = y0 * W + x0 + tw, c = (y0 + th) * W + x0, e = y0 * W + x0;
        var sI = S[a] - S[b] - S[c] + S[e], qI = Q[a] - Q[b] - Q[c] + Q[e], vI = qI - sI * sI / n;
        if (vI < 1e-3 * n) { continue; }
        var num = 0, ti = 0;
        for (y = 0; y < th; y++) { var row = (y0 + y) * iw + x0; for (x = 0; x < tw; x++, ti++) num += T[ti] * d[row + x]; }
        var sc = num / Math.sqrt(vI * tp.v);
        if (sc > 0) { var dm = Math.abs(sI / n - tp.m), sdI = Math.sqrt(vI / n), rr = Math.min(sdI, tp.sd) / Math.max(sdI, tp.sd); sc *= Math.max(0, 1 - dm / 100) * Math.sqrt(rr); }   // parlaklik / kontrast da benzesin (gri tonlu ZNCC beyaz ayakkabiyi kirmizi topla karistirmasin)
        if (g) g[(dy + R) * n2 + dx + R] = sc;
        if (sc > best) { best = sc; bxx = x0; byy = y0; }
      }
    }
    return { s: best, x: bxx + tw / 2, y: byy + th / 2, g: g, R: R, bi: [bxx - bx0 + R, byy - by0 + R] };
  }
  /* Sahne kesmesi / ani plan degisimi: ardisik kareler arasi ortalama mutlak fark, tum videonun medyaninin >= 4 kati ve >= 12 ise.
   * Doner: bool dizisi; cut[j] = (j-1) -> j arasinda kesme var. */
  function detectCuts(frames) {
    var n = frames.length, d = new Array(n).fill(0), i, p, s, c, a, b;
    for (i = 1; i < n; i++) { a = frames[i]; b = frames[i - 1]; s = 0; c = 0; for (p = 0; p < a.length; p += 7) { s += Math.abs(a[p] - b[p]); c++; } d[i] = s / Math.max(1, c); }
    var srt = d.slice(1).sort(function (x, y) { return x - y; }), med = srt.length ? srt[srt.length >> 1] : 0, thr = Math.max(12, 4 * med);
    return d.map(function (v) { return v > thr; });
  }
  function* tplGen(frames, w, h, refIdx, rect, opts) {
    var dirs = opts.dir || 'both', total = frames.length, done = 0, out = new Array(total), relaxed = !!opts.relaxed, outScale = opts.model !== 'trans';
    var bw = Math.max(8, rect[2] * w), bh = Math.max(8, rect[3] * h), cx0 = (rect[0] + rect[2] / 2) * w, cy0 = (rect[1] + rect[3] / 2) * h, TC = opts.tplCrop || 0.7, tbw = Math.max(8, bw * TC), tbh = Math.max(8, bh * TC), m = Math.min(tbw, tbh);
    var CL = m >= 110 ? 3 : (m >= 56 ? 2 : (m >= 26 ? 1 : 0)), LV = CL + 1, thrOK = opts.thr || (relaxed ? 0.35 : 0.42), thrBack = relaxed ? 0.5 : 0.55, thrRef = opts.thrRef !== undefined ? opts.thrRef : (relaxed ? 0.1 : 0.15), maxCoast = opts.maxCoast || 900;
    var stats = { coasts: 0, lkLost: 0, lowApp: 0, resumes: 0, reacqs: 0, tpl: 1 };
    if (opts.shared) opts.shared.out = out;
    var cache = {}, cuts = opts.noCuts ? [] : detectCuts(frames), cutList = [];
    function PY(i) { if (!cache[i]) cache[i] = pyramid(frames[i], w, h, LV); return cache[i]; }
    function tplSet(P, cx, cy, S) { var s = [], L; for (L = 0; L <= CL; L++) s[L] = tplGet(P, L, cx, cy, tbw * S, tbh * S); s.S = S; s.P = P; s.px = cx; s.py = cy; return s; }
    function summ(i, cx, cy, S, conf) {
      var sc = outScale ? S : 1, hw = bw * sc / 2, hh = bh * sc / 2, poly = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
      return { i: i, poly: poly, cx: cx, cy: cy, scale: sc, rot: 0, conf: conf };
    }
    var yRatio = (opts.searchR && opts.searchRy) ? Math.max(0.15, Math.min(6, opts.searchRy / opts.searchR)) : 1;
    function find(P, set, px, py, R0) {              // kaba -> ince; seviye-0 koordinatinda sonuc
      var sl = 1 << CL, r = tplMatch(P[CL], set[CL], px / sl, py / sl, Math.max(2, Math.ceil(R0 / sl)), false, Math.max(2, Math.ceil(R0 * yRatio / sl))), L, x = r.x, y = r.y, s = r.s;
      for (L = CL - 1; L >= 0; L--) { var q = tplMatch(P[L], set[L], x * 2, y * 2, 2, L === 0); x = q.x; y = q.y; s = q.s; if (L === 0 && q.g && q.s > -1) {   // alt-piksel (parabol)
          var R = q.R, n2 = 2 * R + 1, bi = q.bi, gx = q.g, c = gx[bi[1] * n2 + bi[0]];
          if (bi[0] > 0 && bi[0] < n2 - 1) { var l = gx[bi[1] * n2 + bi[0] - 1], rr = gx[bi[1] * n2 + bi[0] + 1], dn = l - 2 * c + rr; if (l > -2 && rr > -2 && dn < -1e-6) x += Math.max(-0.5, Math.min(0.5, 0.5 * (l - rr) / dn)); }
          if (bi[1] > 0 && bi[1] < n2 - 1) { var u = gx[(bi[1] - 1) * n2 + bi[0]], dd = gx[(bi[1] + 1) * n2 + bi[0]], dn2 = u - 2 * c + dd; if (u > -2 && dd > -2 && dn2 < -1e-6) y += Math.max(-0.5, Math.min(0.5, 0.5 * (u - dd) / dn2)); }
        } }
      return { x: x, y: y, s: s };
    }
    // seviye-0'da olcek adaylari: sablonu g kadar buyutup / kucultup en iyi skoru ver
    function scaleTry(P, cur, x, y, g) {
      var tp = tplGet(cur.P, 0, cur.px, cur.py, tbw * cur.S, tbh * cur.S, tbw * cur.S * g, tbh * cur.S * g);
      return tplMatch(P[0], tp, x, y, 2, false);
    }
    var P0 = PY(refIdx), refSet = tplSet(P0, cx0, cy0, 1);
    out[refIdx] = summ(refIdx, cx0, cy0, 1, 1);
    function refScore(P, x, y, S) { var tp = tplGet(refSet.P, 0, cx0, cy0, tbw, tbh, tbw * S, tbh * S); return tplMatch(P[0], tp, x, y, 1, false).s; }
    function* run(dir) {
      var cur = refSet, S = 1, px = cx0, py = cy0, vx = 0, vy = 0, k = 0, i;
      for (i = refIdx + dir; i >= 0 && i < total; i += dir) {
        yield i;
        var P = PY(i), sp = Math.hypot(vx, vy), R0 = ((opts.searchR || Math.max(0.12 * w, 0.9 * Math.max(bw, bh) * S)) + 2.5 * sp) * (opts.search || 1), tx = px + vx * 0.9, ty = py + vy * 0.9;
        if (k > 0) { R0 = Math.min(0.45 * w, R0 * (1 + 0.5 * k)); tx = px + vx * Math.max(0, 1 - 0.15 * k) * k * 0.5; ty = py + vy * Math.max(0, 1 - 0.15 * k) * k * 0.5; }
        R0 = Math.min(R0, 0.45 * w);
        var isCut = cuts[dir > 0 ? i : i + 1]; if (isCut && cutList.indexOf(i) < 0) cutList.push(i);
        if (isCut) { k++; stats.coasts++; vx = 0; vy = 0; out[i] = null; if (opts.onProgress) opts.onProgress(++done, total); continue; }   // sahne kesmesi: o karede nesne bulunmaz (uydurma konum yok); sonraki karelerde ilk gorunumle yeniden aranir
        var f = find(P, cur, tx, ty, R0), fS = S, g;
        if (cur !== refSet && S === 1) { var fr = find(P, refSet, tx, ty, R0); if (fr.s > f.s) f = fr; }
        if (f.s > 0.2 && outScale && !opts.noScale) {                  // olcek: kucuk adimlarla guncelle
          var gb = 1, sb = f.s;
          [0.93, 1.075].forEach(function (gg) { var q = scaleTry(P, cur, f.x, f.y, gg); if (q.s > sb + (opts.scaleMargin || 0.015)) { sb = q.s; gb = gg; f = { x: q.x, y: q.y, s: q.s }; } });
          fS = Math.max(0.5, Math.min(3, S * gb));
        }
        var sRef = f.s >= thrOK ? refScore(P, f.x, f.y, fS) : -1;
        if (opts.dbg) opts.dbg(i, f.s, f.x, f.y, k, R0, sRef, fS);
        var ok = f.s >= (k > 0 ? thrBack : thrOK) && sRef >= thrRef;
        if (ok && k === 0 && Math.hypot(f.x - px, f.y - py) > 1.6 * R0) ok = false;
        if (ok && (f.x < -bw * 0.4 || f.x > w + bw * 0.4 || f.y < -bh * 0.4 || f.y > h + bh * 0.4)) ok = false;
        if (ok) {
          if (k > 0) stats.resumes++;
          var steps = k + 1; vx = 0.5 * vx + 0.5 * (f.x - px) / steps; vy = 0.5 * vy + 0.5 * (f.y - py) / steps;
          px = f.x; py = f.y; k = 0; S = fS;
          out[i] = summ(i, px, py, S, Math.max(0.05, Math.min(1, f.s)));
          if (opts.adapt !== false && f.s < 0.93 && f.s >= (opts.adaptMin || 0.75) && sRef >= (opts.adaptRef || 0.5)) { var ns = tplSet(P, px, py, S); if (ns.every(Boolean)) cur = ns; }
          else if (f.s >= 0.93 && cur !== refSet && opts.adapt !== false) { cur = tplSet(P, px, py, S); }   // skor yuksek: sablonu ayni gorunumle, yeni olcek / konumda tazele
        } else {
          k++; stats.coasts += (k === 1 ? 1 : 0); stats.lkLost += (k === 1 ? 1 : 0); vx *= 0.9; vy *= 0.9;
          if (k > maxCoast) return { lost: i, reason: 'nesne kapandı / kayboldu ve geri bulunamadı' };
        }
        for (var dk in cache) { if (Math.abs(+dk - i) > 2 && +dk !== refIdx) delete cache[dk]; }
        if (opts.onProgress) opts.onProgress(++done, total);
      }
      return { lost: null };
    }
    var rf = { lost: null }, rb = { lost: null };
    if (dirs === 'fwd' || dirs === 'both') rf = yield* run(1);
    if (dirs === 'bwd' || dirs === 'both') rb = yield* run(-1);
    return { frames: out, lostFwd: rf.lost, lostBwd: rb.lost, reasonFwd: rf.reason, reasonBwd: rb.reason, refIdx: refIdx, w: w, h: h, stats: stats, cuts: cutList };
  }

  /* ---------------- ana izleyici (jenerator: durdurulabilir / ilerleme verir) ---------------- */
  /* frames: gri kareler (Uint8Array[]), w,h. refIdx: bolgenin secildigi kare. rect: [x,y,w,h] (0-1).
   * opts: dir 'fwd'|'bwd'|'both', baseScale/baseRot (onceki sonucun bu karedeki degeri), shared (kismi sonuc icin).
   * Sonuc: {frames:[{i,poly,cx,cy,scale,rot,conf}|null], lostFwd, lostBwd, reasonFwd, reasonBwd, refIdx, w, h} */
  function* trackGen(frames, w, h, refIdx, rect, opts) {
    opts = opts || {};
    if (opts.method === 'tpl') return yield* tplGen(frames, w, h, refIdx, rect, opts);
    var dirs = opts.dir || 'both', maxPts = opts.points || (opts.relaxed ? 110 : 70), R = opts.window || (opts.relaxed ? 9 : 7), levels = opts.levels || 4, total = frames.length, done = 0;
    var baseS = opts.baseScale || 1, baseR = opts.baseRot || 0, maxCoast = opts.maxCoast || 900, model = opts.model || 'sim', TR = (model === 'trans'), core = opts.core || (TR ? 0.75 : 1), minEv = opts.relaxed ? 15 : MIN_EV;   // core: koselerdeki arka plani disla (elips cekirdek)
    var poly0 = [[rect[0] * w, rect[1] * h], [(rect[0] + rect[2]) * w, rect[1] * h], [(rect[0] + rect[2]) * w, (rect[1] + rect[3]) * h], [rect[0] * w, (rect[1] + rect[3]) * h]];
    var out = new Array(frames.length), pyrCache = {}, stats = { coasts: 0, lkLost: 0, lowApp: 0, resumes: 0, reacqs: 0 };
    if (opts.shared) opts.shared.out = out;
    function P(i) { if (!pyrCache[i]) pyrCache[i] = pyramid(opts.smooth > 0 ? smoothFrame(frames[i], w, h, opts.smooth) : frames[i], w, h, levels); return pyrCache[i]; }
    function summarize(i, poly, s, rot, conf) {
      var cx = 0, cy = 0; for (var k = 0; k < 4; k++) { cx += poly[k][0]; cy += poly[k][1]; } cx /= 4; cy /= 4;
      return { i: i, poly: poly, cx: cx, cy: cy, scale: s, rot: rot, conf: conf };
    }
    out[refIdx] = summarize(refIdx, poly0, baseS, baseR, 1);
    var tplRef = makeTpl(P(refIdx), poly0, baseS);
    if (opts.debug) opts.debug('tplRef sd=' + (tplRef ? tplRef.sd.toFixed(2) : 'yok'));
    function* run(step) {
      var poly = poly0.map(function (p) { return p.slice(); }), pts = detect(P(refIdx)[0], poly, maxPts, 6, core, minEv), cumS = baseS, cumR = baseR, badRun = 0, sinceSeed = 0, i;
      var verifyLeft = 0, vbad = 0, n0 = pts.length, prevIdx = refIdx, vel = [0, 0], hist = [], coast = null, lastPoly = poly, tpl = tplRef, lowRun = 0, sinceTpl = 0, streak = [], prevApp = 1;
      var good = { poly: poly, pts: pts.slice(), cumS: cumS, cumR: cumR, prevIdx: prevIdx }, appHist = [];
      function lkMatch(A, B, plist, gap) {       // noktalari A'dan B'ye izle (ileri-geri dogrulamali)
        var src = [], dst = [], kk;
        for (kk = 0; kk < plist.length; kk++) {
          var f = lkPyr(A, B, plist[kk][0], plist[kk][1], R, 25, null);
          if ((!f.ok || f.err > 28) && (vel[0] || vel[1])) f = lkPyr(A, B, plist[kk][0], plist[kk][1], R, 25, [vel[0] * step * gap * step, vel[1] * step * gap * step]);
          if (!f.ok || f.err > 28) continue;
          var nx = plist[kk][0] + f.dx, ny = plist[kk][1] + f.dy;
          var bk = lkPyr(B, A, nx, ny, R, 25, null);
          if (!bk.ok || Math.abs(nx + bk.dx - plist[kk][0]) > 0.9 || Math.abs(ny + bk.dy - plist[kk][1]) > 0.9) continue;
          if (nx < 2 || ny < 2 || nx > w - 3 || ny > h - 3) continue;
          src.push(plist[kk]); dst.push([nx, ny]);
        }
        return { src: src, dst: dst };
      }
      function strongTpl() { return !!(tpl && tpl.sd >= 4 && !opts.relaxed); }
      if (n0 < 6) return { lost: refIdx, reason: 'bölgede takip edilecek doku (köşe) yok: düz saç / düz kıyafet izlenemez. Kutuyu saç çizgisi, kulak, yaka, gözlük gibi dokulu yerleri içine alacak şekilde çiz (kutunun köşelerinde dokulu arka plan kalmasın).' };
      for (i = refIdx + step; i >= 0 && i < frames.length; i += step) {
        yield i; var k;
        if (coast) {                                           // nesne kayip (kapandi?): once takibi dogrudan surdurmeyi dene, olmazsa sablonla yeniden bul
          coast.k++;
          if (coast.k > maxCoast) return { lost: i, reason: 'nesne kapandı / kayboldu ve geri bulunamadı' };
          if (coast.k <= 40 && (coast.k <= 8 || coast.k % 2 === 0)) {
            var mr = lkMatch(P(good.prevIdx), P(i), good.pts, Math.abs(i - good.prevIdx)), fr = mr.src.length >= 3 ? (TR ? transFit(mr.src, mr.dst) : fitSim(mr.src, mr.dst)) : null;
            if (fr && fr.keep && fr.keep.length >= Math.max(6, Math.round(n0 * 0.4))) {
              var rs0 = Math.sqrt(fr.a * fr.a + fr.b * fr.b);
              if (rs0 >= 0.75 && rs0 <= 1.35) {
                var rpoly = good.poly.map(function (p) { return [fr.a * p[0] - fr.b * p[1] + fr.tx, fr.b * p[0] + fr.a * p[1] + fr.ty]; }), rok = true;
                if (strongTpl()) { var rtp = scaledTpl(tpl, 1, good.cumS * rs0 / tpl.s), rbx = polyBox(rpoly); if (rtp && bestAround(hpLevel(P(i), 1), rtp, (rbx.x0 + rbx.x1) / 4, (rbx.y0 + rbx.y1) / 4, 2, 1).s < 0.3) rok = false; }
                if (rok) {
                  poly = rpoly; lastPoly = rpoly; cumS = good.cumS * rs0; cumR = good.cumR + Math.atan2(fr.b, fr.a);
                  pts = fr.keep.map(function (q) { return mr.dst[q]; }); prevIdx = i; coast = null; badRun = 0; lowRun = 0; sinceSeed = 0; streak = []; stats.resumes++;
                  out[i] = summarize(i, poly, cumS, cumR, 0.6);
                  good = { poly: poly, pts: pts.slice(), cumS: cumS, cumR: cumR, prevIdx: i };
                  if (opts.onProgress) opts.onProgress(++done, total);
                  continue;
                }
              }
            }
          }
          var dmp = Math.pow(0.92, coast.k); coast.cx += vel[0] * step * dmp; coast.cy += vel[1] * step * dmp;
          var skip = coast.k > 90 ? 4 : (coast.k > 30 ? 2 : 1);
          if (coast.k % skip !== 0) { out[i] = null; continue; }
          var m = reacquire(P(i), [tpl, tplRef], [coast.cx, coast.cy], coast.k, cumS, TR);
          if (m && opts.debug) opts.debug('reacq i=' + i + ' k=' + coast.k + ' x=' + m.x.toFixed(0) + ' y=' + m.y.toFixed(0) + ' sc=' + m.sc.toFixed(2) + ' score=' + m.score.toFixed(2) + ' c2=' + m.c2.toFixed(2) + ' gap=' + m.gap.toFixed(2) + ' s0=' + m.s0.toFixed(2));
          if (m) {   // iki ardisik denemede ayni yerde bulunursa kabul et (tek seferlik yanlis eslesmeyi ele)
            var pd = coast.pend ? Math.hypot(m.x - coast.pend.x, m.y - coast.pend.y) : 1e9;
            if (!coast.pend || pd > 24 * skip + 10) { coast.pend = m; coast.pn = 1; out[i] = null; continue; }
            coast.pend = m; coast.pn++;
            if (coast.pn < 3) { out[i] = null; continue; }   // ust uste 3 denemede ayni yerde bulunmali
            coast.pend = null;
          } else if (coast.pend && coast.k % skip === 0) coast.pend = null;
          if (m) {
            var bb = polyBox(lastPoly), ox = (bb.x0 + bb.x1) / 2, oy = (bb.y0 + bb.y1) / 2;
            poly = lastPoly.map(function (p) { return [m.x + (p[0] - ox) * m.sc, m.y + (p[1] - oy) * m.sc]; });
            var bx3 = polyBox(poly), cc3 = [(bx3.x0 + bx3.x1) / 2, (bx3.y0 + bx3.y1) / 2], inner3 = poly.map(function (p) { return [cc3[0] + (p[0] - cc3[0]) * 0.85, cc3[1] + (p[1] - cc3[1]) * 0.85]; });
            var np2 = detect(P(i)[0], inner3, maxPts, 6, core, minEv);
            if (np2.length >= Math.max(6, Math.round(n0 * 0.3))) {
              stats.reacqs++; cumS *= m.sc; pts = np2; prevIdx = i; coast = null; badRun = 0; lowRun = 0; sinceSeed = 0; lastPoly = poly; n0 = Math.max(6, np2.length); hist = []; vel = [0, 0];
              out[i] = summarize(i, poly, cumS, cumR, 0.5 * m.score);
              good = { poly: poly, pts: pts.slice(), cumS: cumS, cumR: cumR, prevIdx: i };
              tpl = makeTpl(P(i), poly, cumS) || tpl; streak = []; verifyLeft = 8; vbad = 0;
              if (opts.onProgress) opts.onProgress(++done, total);
              continue;
            }
          }
          out[i] = null; continue;
        }
        var A = P(prevIdx), B = P(i), mt = lkMatch(A, B, pts, Math.abs(i - prevIdx)), src = mt.src, dst = mt.dst;
        var fit, ok;
        if (TR) { fit = src.length >= 3 ? transFit(src, dst) : null; ok = !!fit && fit.keep.length >= Math.max(3, Math.round(n0 * 0.12)); }   // yalniz konum: olcek / donme birikmez
        else {
          fit = src.length >= 3 ? fitSim(src, dst) : null; ok = !!fit && fit.keep && fit.keep.length >= Math.max(3, Math.round(n0 * 0.12));
          if (ok) { var sc = Math.sqrt(fit.a * fit.a + fit.b * fit.b); if (sc < 0.85 || sc > 1.18) ok = false; }
          if (ok && model === 'scale') {   // konum + olcek: donme yok. Olcek = benzerlik olcegi; oteleme ayni noktalardan yeniden hesaplanir
            var sc2 = Math.sqrt(fit.a * fit.a + fit.b * fit.b), mx2 = 0, my2 = 0, nx2 = 0, ny2 = 0, kq;
            for (kq = 0; kq < fit.keep.length; kq++) { mx2 += src[fit.keep[kq]][0]; my2 += src[fit.keep[kq]][1]; nx2 += dst[fit.keep[kq]][0]; ny2 += dst[fit.keep[kq]][1]; }
            mx2 /= fit.keep.length; my2 /= fit.keep.length; nx2 /= fit.keep.length; ny2 /= fit.keep.length;
            fit = { a: sc2, b: 0, tx: nx2 - sc2 * mx2, ty: ny2 - sc2 * my2, keep: fit.keep, inl: fit.inl };
          }
        }
        if (!ok && src.length >= 2 && (!fit || !fit.keep || fit.keep.length < 3)) {
          var dxs = [], dys = []; for (k = 0; k < src.length; k++) { dxs.push(dst[k][0] - src[k][0]); dys.push(dst[k][1] - src[k][1]); }
          var mdx = median(dxs), mdy = median(dys), cnt = 0; for (k = 0; k < src.length; k++) if (Math.abs(dxs[k] - mdx) < 1.2 && Math.abs(dys[k] - mdy) < 1.2) cnt++;
          if (cnt >= Math.max(3, Math.round(n0 * 0.12))) { fit = { a: 1, b: 0, tx: mdx, ty: mdy, keep: null, trans: true, inl: cnt }; ok = true; }
        }
        if (!ok) {
          if (++badRun >= 2) { stats.coasts++; stats.lkLost++; poly = good.poly; lastPoly = good.poly; pts = good.pts; cumS = good.cumS; cumR = good.cumR; prevIdx = good.prevIdx; streak.forEach(function (j) { out[j] = null; }); streak = []; var bbx = polyBox(good.poly); coast = { k: 0, cx: (bbx.x0 + bbx.x1) / 2, cy: (bbx.y0 + bbx.y1) / 2 }; }
          out[i] = null; continue;
        }
        badRun = 0;
        var a = fit.a, b = fit.b, tx = fit.tx, ty = fit.ty, gap = Math.abs(i - prevIdx);
        if (!TR && (cumS * Math.sqrt(a * a + b * b) > baseS * 2.2 || cumS * Math.sqrt(a * a + b * b) < baseS * 0.45)) { var tf0 = transFit(src, dst); if (tf0) { a = 1; b = 0; tx = tf0.tx; ty = tf0.ty; } }   // olcek kosarak kaymasin
        var npoly = poly.map(function (p) { return [a * p[0] - b * p[1] + tx, b * p[0] + a * p[1] + ty]; });
        var ncumS = cumS * Math.sqrt(a * a + b * b), ncumR = cumR + Math.atan2(b, a);
        var cx = (npoly[0][0] + npoly[2][0]) / 2, cy = (npoly[0][1] + npoly[2][1]) / 2, ocx = (lastPoly[0][0] + lastPoly[2][0]) / 2, ocy = (lastPoly[0][1] + lastPoly[2][1]) / 2;
        if (cx < -w * 0.05 || cx > w * 1.05 || cy < -h * 0.05 || cy > h * 1.05) return { lost: i, reason: 'nesne kareden çıktı' };
        // Gorunum kontrolu: sablonla ZNCC cok dusukse nesne onunde baska sey var (kapanma); LK onun uzerinde surukleniyor olabilir
        var app = 1, checked = false;
        if (strongTpl() && (i % 2 === 0 || lowRun > 0)) { checked = true; var tp1 = scaledTpl(tpl, 1, ncumS / tpl.s); if (tp1) { var bxn = polyBox(npoly); app = bestAround(hpLevel(B, 1), tp1, (bxn.x0 + bxn.x1) / 4, (bxn.y0 + bxn.y1) / 4, 2, 1).s; } }
        if (opts.dbgApp && opts.debug) opts.debug('app i=' + i + ' app=' + app.toFixed(2) + ' hist=' + appHist.length + ' strong=' + strongTpl());
        // Sablonu uyarla (AE "Adapt Feature on Every Frame"): nokta takibi saglikli (cogu nokta tutuyor) ve benzerlik YAVASCA dusuyorsa
        // (yuz doner / mimik degisir) bu kapanma degil gorunum degisimidir -> sablonu simdiki gorunume yenile. Ani dusus (kapanma) uyarlanmaz.
        if (checked && opts.adapt !== false && app < 0.7 && app >= 0.15 && app >= 0.6 * prevApp && ((fit.keep ? fit.keep.length : fit.inl) / n0) >= 0.6) {
          var ntpl = makeTpl(B, npoly, ncumS); if (ntpl) { tpl = ntpl; sinceTpl = 0; prevApp = app; app = 1; if (opts.debug && opts.dbgApp) opts.debug('  adapt i=' + i); }
        } else if (checked) prevApp = app;
        var base = 0; if (appHist.length >= 6) { var sh = appHist.slice().sort(function (x, y) { return x - y; }); base = sh[Math.floor(sh.length / 2)]; }
        if (!checked) { /* bu karede olculmedi: sayaclara dokunma */ }
        else if (base >= 0.45 && app < Math.min(0.3, 0.4 * base)) lowRun++; else { lowRun = 0; appHist.push(app); if (appHist.length > 14) appHist.shift(); }
        if (verifyLeft > 0 && tplRef) {   // yeniden bulunduktan sonra ilk kareler: ORIJINAL gorunumle de tutarli mi?
          verifyLeft--;
          var tr1 = scaledTpl(tplRef, 1, ncumS / tplRef.s), bxr = polyBox(npoly), ar = tr1 ? bestAround(hpLevel(B, 1), tr1, (bxr.x0 + bxr.x1) / 4, (bxr.y0 + bxr.y1) / 4, 3, 1).s : 1;
          if (opts.debug && opts.dbgApp) opts.debug('verify i=' + i + ' ar=' + ar.toFixed(2));
          if (ar < 0.3) vbad++;
          if (vbad >= 3) { lowRun = 3; verifyLeft = 0; }
        }
        poly = npoly; cumS = ncumS; cumR = ncumR;
        hist.push([(cx - ocx) / gap, (cy - ocy) / gap]); if (hist.length > 3) hist.shift();
        vel = [0, 0]; hist.forEach(function (v) { vel[0] += v[0] / hist.length; vel[1] += v[1] / hist.length; });
        var keepIdx = fit.keep || src.map(function (_, q) { return q; }), np = [];
        for (k = 0; k < keepIdx.length; k++) np.push(dst[keepIdx[k]]);
        pts = np; sinceSeed++; prevIdx = i; lastPoly = poly;
        if (pts.length < n0 * 0.6 || sinceSeed >= 25) {
          var bx2 = polyBox(poly), ccx = (bx2.x0 + bx2.x1) / 2, ccy = (bx2.y0 + bx2.y1) / 2, inner = poly.map(function (p) { return [ccx + (p[0] - ccx) * 0.85, ccy + (p[1] - ccy) * 0.85]; });
          var fresh = detect(B[0], inner, maxPts, 6, core, minEv), merged = pts.slice();
          for (k = 0; k < fresh.length && merged.length < maxPts; k++) {
            var near = false; for (var j2 = 0; j2 < merged.length; j2++) { var ddx = merged[j2][0] - fresh[k][0], ddy = merged[j2][1] - fresh[k][1]; if (ddx * ddx + ddy * ddy < 36) { near = true; break; } }
            if (!near) merged.push(fresh[k]);
          }
          pts = merged; sinceSeed = 0;
        }
        out[i] = summarize(i, poly, cumS, cumR, Math.min(1, (fit.keep ? fit.keep.length : fit.inl) / n0));
        if (lowRun >= 3) { stats.coasts++; stats.lowApp++;                // gorunum tutmuyor: son kareleri geri al, bekleme moduna gec
          out[i] = null; streak.forEach(function (j) { out[j] = null; }); streak = [];
          poly = good.poly; lastPoly = good.poly; pts = good.pts; cumS = good.cumS; cumR = good.cumR; prevIdx = good.prevIdx;
          var bbx2 = polyBox(good.poly); coast = { k: 0, cx: (bbx2.x0 + bbx2.x1) / 2, cy: (bbx2.y0 + bbx2.y1) / 2 }; lowRun = 0;
          continue;
        }
        if (!checked) { if (streak.length === 0) good = { poly: poly, pts: pts.slice(), cumS: cumS, cumR: cumR, prevIdx: i }; else streak.push(i); }
        else if (app < 0.5) streak.push(i); else { streak = []; good = { poly: poly, pts: pts.slice(), cumS: cumS, cumR: cumR, prevIdx: i }; }
        sinceTpl++;
        var stable = appHist.length >= 3 && appHist.slice(-3).every(function (x) { return x >= 0.6; });
        if (checked && app > 0.7 && stable && sinceTpl >= 6 && streak.length === 0) { tpl = makeTpl(B, poly, cumS) || tpl; sinceTpl = 0; }   // gorunum yavasca degisirse (donme/olcek) sablonu guncelle; kapanma suphesinde guncelleme
        for (var dk in pyrCache) { if (+dk !== prevIdx && +dk !== refIdx && Math.abs(+dk - i) > 3) delete pyrCache[dk]; }
        if (opts.onProgress) opts.onProgress(++done, total);
      }
      return { lost: null };
    }
    var rf = { lost: null }, rb = { lost: null };
    if (dirs === 'fwd' || dirs === 'both') rf = yield* run(1);
    if (dirs === 'bwd' || dirs === 'both') rb = yield* run(-1);
    return { frames: out, lostFwd: rf.lost, lostBwd: rb.lost, reasonFwd: rf.reason, reasonBwd: rb.reason, refIdx: refIdx, w: w, h: h, stats: stats };
  }
  function trackRegion(frames, w, h, refIdx, rect, opts) {      // senkron (test / kucuk isler)
    var g = trackGen(frames, w, h, refIdx, rect, opts), r; do { r = g.next(); } while (!r.done); return r.value;
  }
  function trackRegionAsync(frames, w, h, refIdx, rect, opts) { // UI donmasin: parca parca calisir; opts.cancel() true donerse durur (kismi sonuc)
    opts = opts || {}; var shared = {}; opts.shared = shared;
    return new Promise(function (resolve) {
      var g = trackGen(frames, w, h, refIdx, rect, opts);
      function tick() {
        var t0 = Date.now(), r;
        do {
          if (opts.cancel && opts.cancel()) { try { g.return(); } catch (e) {} return resolve({ frames: shared.out || [], lostFwd: null, lostBwd: null, cancelled: true, refIdx: refIdx, w: w, h: h }); }
          r = g.next();
        } while (!r.done && Date.now() - t0 < 25);
        if (r.done) resolve(r.value); else setTimeout(tick, 0);
      }
      tick();
    });
  }
  /* Onceki sonuca yeni (yeniden takip) sonucu birlestir: 'fwd' -> refIdx ve sonrasi, 'bwd' -> refIdx ve oncesi degisir */
  function mergeResults(prev, next, dir) {
    var out = prev.frames.slice(), r = next.refIdx, i;
    for (i = 0; i < out.length; i++) {
      var take = (dir === 'fwd' && i >= r) || (dir === 'bwd' && i <= r) || dir === 'both';
      if (take) out[i] = next.frames[i] || null;
    }
    return { frames: out, lostFwd: next.lostFwd, lostBwd: next.lostBwd, reasonFwd: next.reasonFwd, reasonBwd: next.reasonBwd, refIdx: prev.refIdx, w: prev.w, h: prev.h };
  }

  /* Nokta takibinin (lk) bos biraktigi kareleri sablon takibiyle (tp) doldur. lk kareleri AYNEN korunur.
   * Dolgu, bosluk kenarlarindaki LK-sablon farkiyla kaydirilir (sicrama olmasin); guven <= 0.55 yapilir (arayuzde "zayif" gorunur). */
  function fillGaps(lk, tp) {
    var out = lk.frames.slice(), n = out.length, i = 0, filled = 0;
    function shift(f, dx, dy, i2, conf) { var g = { i: i2, poly: f.poly.map(function (p) { return [p[0] + dx, p[1] + dy]; }), cx: f.cx + dx, cy: f.cy + dy, scale: f.scale, rot: f.rot, conf: conf }; return g; }
    while (i < n) {
      if (out[i] || !tp.frames[i]) { i++; continue; }
      var a = i; while (i < n && !out[i]) i++; var b = i - 1;                      // bosluk [a..b]
      var L = a > 0 && lk.frames[a - 1] && tp.frames[a - 1] ? lk.frames[a - 1] : null, R = b < n - 1 && lk.frames[b + 1] && tp.frames[b + 1] ? lk.frames[b + 1] : null;
      var dA = L ? [L.cx - tp.frames[a - 1].cx, L.cy - tp.frames[a - 1].cy] : null, dB = R ? [R.cx - tp.frames[b + 1].cx, R.cy - tp.frames[b + 1].cy] : null;
      for (var k = a; k <= b; k++) {
        var f = tp.frames[k]; if (!f) continue;
        var t = (b > a) ? (k - a + 1) / (b - a + 2) : 0.5, d = dA && dB ? [dA[0] + (dB[0] - dA[0]) * t, dA[1] + (dB[1] - dA[1]) * t] : (dA || dB || [0, 0]);
        out[k] = shift(f, d[0], d[1], k, Math.min(0.55, f.conf)); filled++;
      }
    }
    return { frames: out, lostFwd: lk.lostFwd, lostBwd: lk.lostBwd, reasonFwd: lk.reasonFwd, reasonBwd: lk.reasonBwd, refIdx: lk.refIdx, w: lk.w, h: lk.h, stats: lk.stats, filled: filled };
  }

  /* Takip sonucunu Tether nokta bicimine cevirir. res: trackRegion sonucu; tickOf(i) -> kaynak tick */
  function toPoints(res, tickOf) {
    var w = res.w, h = res.h, pts = [];
    res.frames.forEach(function (f) {
      if (!f) return;
      var xs = f.poly.map(function (p) { return p[0]; }), ys = f.poly.map(function (p) { return p[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      var s = f.scale, c = Math.cos(f.rot), sn = Math.sin(f.rot), raw = [0, 0, 0, 0, 0, 0, 0, 0, 0, s * c, -s * sn, 0, s * sn, s * c];
      pts.push({ src: tickOf(f.i), cx: f.cx / w, cy: f.cy / h, raw: raw, bbox: [x0, y0, x1 - x0, y1 - y0], bn: [(x1 - x0) / w, (y1 - y0) / h], conf: f.conf, rot: f.rot, scale: f.scale });
    });
    pts.sort(function (a, b) { return a.src - b.src; });
    return pts;
  }

  /* ---------------- kutu duzenleme (tasi / boyutlandir) ---------------- */
  // r: [x,y,w,h] (0-1). (x,y): imlec (0-1). bw,bh: tuvalin ekrandaki px boyutu. Donus: 'move' | 'n','s','e','w','nw','ne','sw','se' | null
  function rectHit(r, x, y, bw, bh) {
    if (!r) return null;
    var tol = 9, X0 = r[0] * bw, Y0 = r[1] * bh, X1 = (r[0] + r[2]) * bw, Y1 = (r[1] + r[3]) * bh, px = x * bw, py = y * bh;
    if (px < X0 - tol || px > X1 + tol || py < Y0 - tol || py > Y1 + tol) return null;
    var v = Math.abs(py - Y0) <= tol ? 'n' : (Math.abs(py - Y1) <= tol ? 's' : ''), h = Math.abs(px - X0) <= tol ? 'w' : (Math.abs(px - X1) <= tol ? 'e' : '');
    if (v || h) return v + h;
    return (px > X0 && px < X1 && py > Y0 && py < Y1) ? 'move' : null;
  }
  // r0: surukleme baslangicindaki kutu; dx,dy: imlecin 0-1 birimindeki kaymasi. minW/minH: en kucuk boyut (0-1)
  function rectApply(r0, mode, dx, dy, minW, minH) {
    var x0 = r0[0], y0 = r0[1], x1 = r0[0] + r0[2], y1 = r0[1] + r0[3], w = r0[2], h = r0[3];
    function cl(v) { return Math.min(1, Math.max(0, v)); }
    if (mode === 'move') {
      var nx = Math.min(1 - w, Math.max(0, x0 + dx)), ny = Math.min(1 - h, Math.max(0, y0 + dy));
      return [nx, ny, w, h];
    }
    if (mode.indexOf('w') >= 0) x0 = cl(x0 + dx);
    if (mode.indexOf('e') >= 0) x1 = cl(x1 + dx);
    if (mode.indexOf('n') >= 0) y0 = cl(y0 + dy);
    if (mode.indexOf('s') >= 0) y1 = cl(y1 + dy);
    if (x1 - x0 < minW) { if (mode.indexOf('w') >= 0) x0 = Math.max(0, x1 - minW); else x1 = Math.min(1, x0 + minW); }
    if (y1 - y0 < minH) { if (mode.indexOf('n') >= 0) y0 = Math.max(0, y1 - minH); else y1 = Math.min(1, y0 + minH); }
    return [x0, y0, x1 - x0, y1 - y0];
  }

  var api = { setDebug: function (f) { DBG = f; }, rectHit: rectHit, rectApply: rectApply, findFfmpeg: findFfmpeg, probe: probe, readFrames: readFrames, readOneFramePng: readOneFramePng, trackRegion: trackRegion, trackRegionAsync: trackRegionAsync, mergeResults: mergeResults, fillGaps: fillGaps, detectCuts: detectCuts, toPoints: toPoints, _lk: lkPyr, _pyramid: pyramid };
  root.TetherTrack = api;   // CEP'te hem 'module' hem 'window' vardir: ikisine de ver
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

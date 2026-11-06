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
    var vl = /Video:[^\n]*/.exec(t), fm = vl ? /(\d+(?:\.\d+)?)\s*fps/.exec(vl[0]) : null, nf = fm ? +fm[1] : 0;   // v2.16: klibin kendi kare hizi (ortalama)
    return { w: +m[1], h: +m[2], rotate: rot ? +rot[1] : 0, fps: (nf >= 5 && nf <= 240) ? nf : 0 };
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
  /* v2.14 Adim 2A: yalnizca kullaniciya gosterilen sahne kesmesi NOTLARI icin. Takip (tplGen) bunu KULLANMAZ; tplGen eski detectCuts'i kullanmaya devam eder.
     Kural: detectCuts ile ayni global kosul + kare 8x8 hucreye bolunur, hucrelerin en az %90'i ayni esigi asmali (kamyon gecisi gibi kismi hareket kesme sayilmaz).
     Esik degerleri detectCuts ile ayni: max(12, 4*medyan). */
  var STRICT = { grid: 8, minFrac: 0.9 };
  function cutThreshold(d) { var srt = d.slice(1).sort(function (x, y) { return x - y; }), med = srt.length ? srt[srt.length >> 1] : 0; return Math.max(12, 4 * med); }
  function cutSignals(frames, w, h) {   // d[i]: i-1 -> i ortalama mutlak fark (detectCuts ile ayni ornekleme); cells(i): aday kare icin 64 hucre ortalamasi
    var n = frames.length, d = new Array(n).fill(0), i, p, s, c, a, b, G = STRICT.grid, cw = Math.max(1, Math.floor(w / G)), ch = Math.max(1, Math.floor(h / G));
    for (i = 1; i < n; i++) { a = frames[i]; b = frames[i - 1]; s = 0; c = 0; for (p = 0; p < a.length; p += 7) { s += Math.abs(a[p] - b[p]); c++; } d[i] = s / Math.max(1, c); }
    function cells(i) {
      var a = frames[i], b = frames[i - 1], cs = new Array(G * G).fill(0), cn = new Array(G * G).fill(0), x, y, k, o;
      for (y = 0; y < h; y += 2) { var gy = Math.min(G - 1, Math.floor(y / ch)); for (x = 0; x < w; x += 2) { k = gy * G + Math.min(G - 1, Math.floor(x / cw)); o = y * w + x; cs[k] += Math.abs(a[o] - b[o]); cn[k]++; } }
      return cs.map(function (v, k) { return v / Math.max(1, cn[k]); });
    }
    return { d: d, cells: cells };
  }
  function strictFromSignals(d, cellsOf) {   // cellsOf(i) -> 64 hucre ortalamasi (yalnizca d[i] esigi astiginda cagrilir)
    var thr = cutThreshold(d);
    return d.map(function (v, i) { if (!(v > thr)) return false; var cs = cellsOf(i), c = 0, k; for (k = 0; k < cs.length; k++) if (cs[k] > thr) c++; return c / cs.length >= STRICT.minFrac; });
  }
  function detectCutsStrict(frames, w, h) { var sg = cutSignals(frames, w, h); return strictFromSignals(sg.d, sg.cells); }
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

  /* ---------------- kucuk nesne / imlec (sabit arka planli ekran kaydi) ----------------
   * Kutudaki nesnenin siluetini, nesnenin uzaklastigi karelerden cikarilan arka planla farkindan bulur (maske).
   * Sonra YALNIZ maske pikselleriyle maskeli ZNCC esleme yapar: arka plan eslemeye karismaz, imlec metnin / beyaz yuzeyin /
   * baska pencerenin ustunden gecse de skor dusmez. Kutu nesneden buyuk cizilmis olabilir.
   * Imlec gibi 10-20 px'lik nesneler kucultulmus karede (640-960 px) ayirt edilemez; bu yuzden bu yontem karelerin TAMAMINI
   * bellege koymaz: yerel cozunurlukte parca parca (48 kare) okur, eslemeyi yapar, parcayi birakir. Bellek uzunluktan bagimsizdir.
   * Veri uydurmaz: nesne arka plandan ayrilamazsa ya da kayip olursa kare BOS kalir, neden soylenir. Yalniz konum izler (olcek 1, donme 0). */
  function smallBox(rect, w, h) {
    var x0 = Math.max(0, Math.floor(rect[0] * w)), y0 = Math.max(0, Math.floor(rect[1] * h)), x1 = Math.min(w, Math.ceil((rect[0] + rect[2]) * w)), y1 = Math.min(h, Math.ceil((rect[1] + rect[3]) * h));
    return { x0: x0, y0: y0, bw: x1 - x0, bh: y1 - y0 };
  }
  function smallBuild(patches, B, refIdx) {              // patches[j]: j. karenin kutu bolgesi (bw*bh bayt)
    var bw = B.bw, bh = B.bh, n = bw * bh, R = new Float32Array(n), ref = patches[refIdx], x, y, j, k, p, N = patches.length;
    if (!ref || bw < 6 || bh < 6) return { err: 'kutu çok küçük ya da kare okunamadı' };
    for (p = 0; p < n; p++) R[p] = ref[p];
    var cnt = [];                                       // her karede kutu icinde ref'ten belirgin farkli piksel sayisi
    for (j = 0; j < N; j++) {
      var pj = patches[j], c = 0; if (!pj || j === refIdx) { cnt.push(0); continue; }
      for (p = 0; p < n; p++) if (Math.abs(pj[p] - R[p]) > 40) c++;
      cnt.push(c);
    }
    var minC = Math.max(6, Math.round(n * 0.01)), F0 = [];
    for (j = 0; j < N; j++) if (cnt[j] >= minC) F0.push(j);
    if (F0.length < 4) return { err: 'kutunun içi videoda neredeyse hiç değişmiyor: nesne kıpırdamıyor ya da kutuya girmiyor. Nesnenin hareket ettiği bir bölümde "Kare al" yap.' };
    function medPatch(list) {                          // piksel basina medyan (en cok 41 kare)
      var step = Math.max(1, Math.floor(list.length / 41)), sel = [], out = new Float32Array(n), v = [], kk, pp;
      for (kk = 0; kk < list.length; kk += step) sel.push(list[kk]);
      for (pp = 0; pp < n; pp++) { v.length = 0; for (kk = 0; kk < sel.length; kk++) v.push(patches[sel[kk]][pp]); v.sort(function (a, b) { return a - b; }); out[pp] = v[v.length >> 1]; }
      return out;
    }
    function silhouette(bg) {                          // |ref - arka plan| buyuk olan pikseller; en buyuk bagli parca; ici dolu
      var M = new Uint8Array(n), q, lab = new Int32Array(n), best = 0, bestId = 0, id = 0, st, a, nb, dx, dy, xx, yy;
      for (q = 0; q < n; q++) M[q] = Math.abs(R[q] - bg[q]) > 28 ? 1 : 0;
      for (q = 0; q < n; q++) {
        if (!M[q] || lab[q]) continue; id++; st = [q]; lab[q] = id; var sz = 0;
        while (st.length) { a = st.pop(); sz++; yy = (a / bw) | 0; xx = a - yy * bw;
          for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { var ax = xx + dx, ay = yy + dy; if (ax < 0 || ay < 0 || ax >= bw || ay >= bh) continue; nb = ay * bw + ax; if (M[nb] && !lab[nb]) { lab[nb] = id; st.push(nb); } } }
        if (sz > best) { best = sz; bestId = id; }
      }
      var O = new Uint8Array(n); for (q = 0; q < n; q++) O[q] = lab[q] === bestId && bestId ? 1 : 0;
      var out = new Uint8Array(n), stk = [];             // kenardan ulasilamayan bosluklar = nesnenin ici
      function seed(ax, ay) { var z = ay * bw + ax; if (!O[z] && !out[z]) { out[z] = 1; stk.push(z); } }
      for (xx = 0; xx < bw; xx++) { seed(xx, 0); seed(xx, bh - 1); } for (yy = 0; yy < bh; yy++) { seed(0, yy); seed(bw - 1, yy); }
      while (stk.length) { a = stk.pop(); yy = (a / bw) | 0; xx = a - yy * bw; if (xx > 0) seed(xx - 1, yy); if (xx < bw - 1) seed(xx + 1, yy); if (yy > 0) seed(xx, yy - 1); if (yy < bh - 1) seed(xx, yy + 1); }
      for (q = 0; q < n; q++) O[q] = out[q] ? 0 : 1;
      return O;
    }
    var bg = medPatch(F0), M = silhouette(bg), it;
    for (it = 0; it < 2; it++) {                       // maske temizse nesnenin SILUET YERINDE olmadigi kareleri bul, arka plani onlardan yeniden kur
      var Lm0 = []; for (p = 0; p < n; p++) if (M[p]) Lm0.push(p);
      if (Lm0.length < 12) break;
      var F1 = [];
      for (j = 0; j < N; j++) {
        var pq = patches[j]; if (!pq || j === refIdx) continue; var d = 0;
        for (k = 0; k < Lm0.length; k++) d += Math.abs(pq[Lm0[k]] - bg[Lm0[k]]);
        if (d / Lm0.length < 14) F1.push(j);
      }
      if (F1.length < 4) break;
      bg = medPatch(F1); M = silhouette(bg);
    }
    var T0 = smallTemplate(R, M, B, n); if (!T0.err) T0.bgFrames = F0.length; return T0;
  }
  /* Maske M (0/1, bw*bh) + referans parca R -> eslesme sablonu. Maske duzse (tek renk) 2 px genisletilir; yine duzse hata. */
  function smallTemplate(R, M, B, n) {
    var bw = B.bw, bh = B.bh, k;
    function dilate(A) { var O2 = new Uint8Array(n), q, a2, b2, dx2, dy2; for (q = 0; q < n; q++) if (A[q]) { a2 = (q / bw) | 0; b2 = q - a2 * bw; for (dy2 = -2; dy2 <= 2; dy2++) for (dx2 = -2; dx2 <= 2; dx2++) { var X = b2 + dx2, Y = a2 + dy2; if (X >= 0 && Y >= 0 && X < bw && Y < bh) O2[Y * bw + X] = 1; } } return O2; }
    function pix(A) { var L = []; for (var q = 0; q < n; q++) if (A[q]) L.push(q); return L; }
    function sd(L) { var m = 0, v = 0, q; for (q = 0; q < L.length; q++) m += R[L[q]]; m /= L.length; for (q = 0; q < L.length; q++) v += (R[L[q]] - m) * (R[L[q]] - m); return Math.sqrt(v / L.length); }
    var Lm = pix(M);
    if (Lm.length < 12) return { err: 'kutudaki nesne arka plandan ayrılamadı (siluet çok küçük). Kutuyu imleci tam içine alacak şekilde, daha sıkı çiz.' };
    if (sd(Lm) < 6) return smallBlob(R, M, Lm, B, n, dilate);     // tek renk leke (ornegin koyu zeminde yalniz beyaz dolgu): ZNCC tanimsiz, merkez-cevre karsitligi kullan
    var cenX = bw >> 1, cenY = bh >> 1, m = Lm.length, dxs = new Int32Array(m), dys = new Int32Array(m), tz = new Float32Array(m), mt = 0, vt = 0;
    for (k = 0; k < m; k++) { var yq = (Lm[k] / bw) | 0, xq = Lm[k] - yq * bw; dxs[k] = xq - cenX; dys[k] = yq - cenY; tz[k] = R[Lm[k]]; mt += tz[k]; }
    mt /= m; for (k = 0; k < m; k++) { tz[k] -= mt; vt += tz[k] * tz[k]; }
    var ex = 0, ey = 0; for (k = 0; k < m; k++) { ex = Math.max(ex, Math.abs(dxs[k])); ey = Math.max(ey, Math.abs(dys[k])); }
    return { dx: dxs, dy: dys, tz: tz, m: m, vt: vt, ex: ex, ey: ey, px0: B.x0 + cenX, py0: B.y0 + cenY, ofx: bw / 2 - cenX, ofy: bh / 2 - cenY, bw: bw, bh: bh, frac: m / n };
  }
  /* Tek renkli (duz) siluet: sekil = maske pikselleri hep ayni parlaklikta, cevresindeki 1-2 px'lik halka belirgin farkli. Skor = (ic ortalama - halka ortalamasi) / referanstaki fark x
   * (ic piksellerin ref ortalamasina +-45 icinde kalan orani). Arka plan hareketli de olsa halka yalniz gurultu ekler. */
  function smallBlob(R, M, Lm, B, n, dilate) {
    var bw = B.bw, bh = B.bh, k, q, mi = 0, D = dilate(M), ring = [];
    for (k = 0; k < Lm.length; k++) mi += R[Lm[k]]; mi /= Lm.length;
    for (q = 0; q < n; q++) if (D[q] && !M[q]) ring.push(q);
    if (ring.length < 8) return { err: 'nesne kutuyu dolduruyor, çevresinde arka plan göremedim; kutuyu nesneden biraz büyük çiz.' };
    var mr = 0; for (k = 0; k < ring.length; k++) mr += R[ring[k]]; mr /= ring.length;
    var span = mi - mr; if (Math.abs(span) < 60) return { err: 'nesne düz tek renk ve arka plandan yeterince ayrışmıyor.' };
    var cenX = bw >> 1, cenY = bh >> 1, m = Lm.length, dxs = new Int32Array(m), dys = new Int32Array(m), rdx = new Int32Array(ring.length), rdy = new Int32Array(ring.length), ex = 0, ey = 0;
    for (k = 0; k < m; k++) { var yq = (Lm[k] / bw) | 0, xq = Lm[k] - yq * bw; dxs[k] = xq - cenX; dys[k] = yq - cenY; ex = Math.max(ex, Math.abs(dxs[k])); ey = Math.max(ey, Math.abs(dys[k])); }
    for (k = 0; k < ring.length; k++) { var yr = (ring[k] / bw) | 0, xr = ring[k] - yr * bw; rdx[k] = xr - cenX; rdy[k] = yr - cenY; ex = Math.max(ex, Math.abs(rdx[k])); ey = Math.max(ey, Math.abs(rdy[k])); }
    return { blob: true, dx: dxs, dy: dys, rdx: rdx, rdy: rdy, rm: ring.length, mean: mi, span: span, m: m, ex: ex, ey: ey, px0: B.x0 + cenX, py0: B.y0 + cenY, ofx: bw / 2 - cenX, ofy: bh / 2 - cenY, bw: bw, bh: bh, frac: m / n };
  }
  /* Arka plandan bagimsiz maske: parcadaki cok parlak (>=205) ve cok koyu (<=50) pikseller; kutunun ortasina en cok oturan bagli parca(lar). Imlec = beyaz dolgu + siyah kontur.
   * Arka plan hareketli / klip kisa / imlec kipirdamiyorsa bile calisir. Koyu masaustunde yalniz beyaz dolgu, beyaz pencerede yalniz siyah kontur kalir. */
  function smallBuildExtreme(R, B) {
    var bw = B.bw, bh = B.bh, n = bw * bh, p, cx = bw / 2, cy = bh / 2, rc = 0.3 * Math.min(bw, bh);
    if (bw < 6 || bh < 6) return { err: 'kutu çok küçük' };
    function comps(bin) {
      var lab = new Int32Array(n), out = [], id = 0, q, st, a, xx, yy, dx, dy, nb;
      for (q = 0; q < n; q++) {
        if (!bin[q] || lab[q]) continue; id++; st = [q]; lab[q] = id; var px = [];
        while (st.length) { a = st.pop(); px.push(a); yy = (a / bw) | 0; xx = a - yy * bw;
          for (dy = -1; dy <= 1; dy++) for (dx = -1; dx <= 1; dx++) { var ax = xx + dx, ay = yy + dy; if (ax < 0 || ay < 0 || ax >= bw || ay >= bh) continue; nb = ay * bw + ax; if (bin[nb] && !lab[nb]) { lab[nb] = id; st.push(nb); } } }
        out.push(px);
      }
      return out;
    }
    function pick(bin) {                                // kutu merkezine en cok oturan, makul buyuklukte parca
      var best = null, bs = 0, cs = comps(bin), i, j;
      for (i = 0; i < cs.length; i++) {
        if (cs[i].length < 15 || cs[i].length > 0.35 * n) continue; var ins = 0;
        for (j = 0; j < cs[i].length; j++) { var yy = (cs[i][j] / bw) | 0, xx = cs[i][j] - yy * bw; if (Math.hypot(xx - cx, yy - cy) <= rc) ins++; }
        var sc = ins + cs[i].length * 0.01; if (ins > 0 && sc > bs) { bs = sc; best = cs[i]; }
      }
      return best;
    }
    var bright = new Uint8Array(n), dark = new Uint8Array(n), nd = 0;
    for (p = 0; p < n; p++) { if (R[p] >= 205) bright[p] = 1; if (R[p] <= 50) { dark[p] = 1; nd++; } }
    var cb = pick(bright), cd = nd < 0.3 * n ? pick(dark) : null;     // koyu piksel cogunluktaysa (koyu masaustu) siyah konturu secme
    if (!cb && !cd) return { err: 'kutuda imleç benzeri (parlak / koyu, belirgin) bir şekil bulunamadı.' };
    var M = new Uint8Array(n), i;
    if (cb) for (i = 0; i < cb.length; i++) M[cb[i]] = 1;
    if (cd) for (i = 0; i < cd.length; i++) M[cd[i]] = 1;
    var out = new Uint8Array(n), stk = [], a, xx, yy;     // kapali konturun ici (delikler) dolsun
    function seed(ax, ay) { var z = ay * bw + ax; if (!M[z] && !out[z]) { out[z] = 1; stk.push(z); } }
    for (xx = 0; xx < bw; xx++) { seed(xx, 0); seed(xx, bh - 1); } for (yy = 0; yy < bh; yy++) { seed(0, yy); seed(bw - 1, yy); }
    while (stk.length) { a = stk.pop(); yy = (a / bw) | 0; xx = a - yy * bw; if (xx > 0) seed(xx - 1, yy); if (xx < bw - 1) seed(xx + 1, yy); if (yy > 0) seed(xx, yy - 1); if (yy < bh - 1) seed(xx, yy + 1); }
    for (p = 0; p < n; p++) M[p] = out[p] ? 0 : 1;
    return smallTemplate(R, M, B, n);
  }
  function smallMatch(img, w, T, off, cx, cy) {          // (cx,cy) = kutu merkezi (tam sayi). Duz sablon: merkez-cevre karsitligi; degilse maskeli ZNCC
    var m = T.m, base = cy * w + cx, k, v;
    if (T.blob) {
      var sI = 0, sR = 0, ok = 0, ro = T.roff, rm = T.rm, mean = T.mean;
      for (k = 0; k < m; k++) { v = img[base + off[k]]; sI += v; if (v > mean - 45 && v < mean + 45) ok++; }
      for (k = 0; k < rm; k++) sR += img[base + ro[k]];
      var c = (sI / m - sR / rm) / T.span; if (c <= 0) return 0; if (c > 1) c = 1; return c * (ok / m);
    }
    var tz = T.tz, sI2 = 0, sII = 0, sIT = 0;
    for (k = 0; k < m; k++) { v = img[base + off[k]]; sI2 += v; sII += v * v; sIT += v * tz[k]; }
    var vI = sII - sI2 * sI2 / m; if (vI < 1e-3 * m) return -1;
    return sIT / Math.sqrt(vI * T.vt);
  }
  function smallFind(img, w, h, T, off, px, py, r, step) {
    var best = -2, bx = px, by = py, cx, cy, s, x0 = Math.max(T.ex, px - r), x1 = Math.min(w - 1 - T.ex, px + r), y0 = Math.max(T.ey, py - r), y1 = Math.min(h - 1 - T.ey, py + r);
    for (cy = y0; cy <= y1; cy += step) for (cx = x0; cx <= x1; cx += step) { s = smallMatch(img, w, T, off, cx, cy); if (s > best) { best = s; bx = cx; by = cy; } }
    if (step > 1 && best > -2) {                          // ince: en iyinin cevresinde tek piksel adimla
      var rx0 = Math.max(T.ex, bx - step + 1), rx1 = Math.min(w - 1 - T.ex, bx + step - 1), ry0 = Math.max(T.ey, by - step + 1), ry1 = Math.min(h - 1 - T.ey, by + step - 1), ox = bx, oy = by;
      for (cy = ry0; cy <= ry1; cy++) for (cx = rx0; cx <= rx1; cx++) { s = smallMatch(img, w, T, off, cx, cy); if (s > best) { best = s; ox = cx; oy = cy; } }
      bx = ox; by = oy;
    }
    return { s: best, x: bx, y: by };
  }
  function smallPeaks(img, w, h, T, off, S, offS, px, py, r) {   // S: alt-maske (her 4. piksel). Tum konumlar adim 1 (tepe ~1 px genisliginde); en iyi 8 aday tam maskeyle sinanir, skora gore sirali
    var x0 = Math.max(T.ex, px - r), x1 = Math.min(w - 1 - T.ex, px + r), y0 = Math.max(T.ey, py - r), y1 = Math.min(h - 1 - T.ey, py + r), top = [], cx, cy, s, i, mn = -2, mi = -1;
    function rescan() { mn = 9; mi = -1; for (var t = 0; t < top.length; t++) if (top[t].s < mn) { mn = top[t].s; mi = t; } }
    for (cy = y0; cy <= y1; cy++) for (cx = x0; cx <= x1; cx++) {
      s = smallMatch(img, w, S, offS, cx, cy); if (top.length >= 8 && s <= mn) continue;
      var near = -1; for (i = 0; i < top.length; i++) if (Math.abs(top[i].x - cx) < 4 && Math.abs(top[i].y - cy) < 4) { near = i; break; }
      if (near >= 0) { if (s > top[near].s) { top[near] = { s: s, x: cx, y: cy }; rescan(); } }
      else if (top.length < 8) { top.push({ s: s, x: cx, y: cy }); rescan(); }
      else { top[mi] = { s: s, x: cx, y: cy }; rescan(); }
    }
    var res = [];
    for (i = 0; i < top.length; i++) {
      var best = { s: -2, x: top[i].x, y: top[i].y };
      for (cy = top[i].y - 1; cy <= top[i].y + 1; cy++) for (cx = top[i].x - 1; cx <= top[i].x + 1; cx++) {
        if (cx < T.ex || cy < T.ey || cx > w - 1 - T.ex || cy > h - 1 - T.ey) continue; s = smallMatch(img, w, T, off, cx, cy); if (s > best.s) best = { s: s, x: cx, y: cy };
      }
      res.push(best);
    }
    res.sort(function (a, b) { return b.s - a.s; });
    return res;
  }
  function smallFindWide(img, w, h, T, off, S, offS, px, py, r) { var p = smallPeaks(img, w, h, T, off, S, offS, px, py, r); return p.length ? p[0] : { s: -2, x: px, y: py }; }
  /* Jenerator: her karenin basinda `yield i` (surucu o kareyi bellege getirir), sonra esler. getFrame(i) -> Uint8Array | null */
  function* smallGen(getFrame, total, w, h, refIdx, T, opts) {
    var out = new Array(total), stats = { coasts: 0, lkLost: 0, lowApp: 0, resumes: 0, reacqs: 0, small: 1 }, done = 0;
    if (opts.shared) opts.shared.out = out;
    var off = new Int32Array(T.m), q; for (q = 0; q < T.m; q++) off[q] = T.dy[q] * w + T.dx[q];
    var sm = Math.ceil(T.m / 4), S = { m: sm, ex: T.ex, ey: T.ey }, offS = new Int32Array(sm), sMean = 0;   // alt-maske: her 4. piksel (genis aramada hiz)
    for (q = 0; q < sm; q++) offS[q] = off[q * 4];
    if (T.blob) {
      T.roff = new Int32Array(T.rm); for (q = 0; q < T.rm; q++) T.roff[q] = T.rdy[q] * w + T.rdx[q];
      var rs = Math.ceil(T.rm / 3); S.blob = true; S.rm = rs; S.roff = new Int32Array(rs); S.mean = T.mean; S.span = T.span; for (q = 0; q < rs; q++) S.roff[q] = T.roff[q * 3];
    } else {
      S.tz = new Float32Array(sm); S.vt = 0; for (q = 0; q < sm; q++) { S.tz[q] = T.tz[q * 4]; sMean += S.tz[q]; } sMean /= sm; for (q = 0; q < sm; q++) { S.tz[q] -= sMean; S.vt += S.tz[q] * S.tz[q]; }
    }
    var wideMs = 25000;                                   // genis arama toplam suresi sinirli (uzun kayiplarda sonsuz beklemesin)
    var D = T.D, smp = opts.samples || [], si; if (D === undefined) { D = 0;      // sablonun arka planda ne kadar benzer yer buldugunu olc: ornek karelerde en iyi eslesmeden >=30 px uzaktaki en iyi aday
    for (si = 0; si < smp.length; si++) {
      var pk = smallPeaks(smp[si], w, h, T, off, S, offS, w >> 1, h >> 1, Math.max(w, h)), b0 = pk[0], t2;
      if (b0) for (t2 = 1; t2 < pk.length; t2++) if (Math.hypot(pk[t2].x - b0.x, pk[t2].y - b0.y) >= 30) { D = Math.max(D, pk[t2].s); break; }
    } T.D = D; }
    var tNear = Math.min(0.9, Math.max(0.58, D + 0.06)), tWide = Math.min(0.95, Math.max(0.68, D + 0.1));
    stats.decoy = +D.toFixed(2); stats.thr = [+tNear.toFixed(2), +tWide.toFixed(2)];
    var Rmax = Math.max(24, Math.min(0.45 * w, (opts.searchR || 0.12 * w) * (opts.search || 1))), dirs = opts.dir || 'both';
    function summ(i, cx, cy, s) {
      var hw = T.bw / 2, hh = T.bh / 2;
      return { i: i, poly: [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]], cx: cx, cy: cy, scale: 1, rot: 0, conf: Math.max(0.05, Math.min(1, (s - 0.3) / 0.5)) };
    }
    out[refIdx] = summ(refIdx, T.px0 + T.ofx, T.py0 + T.ofy, 1);
    function* run(dir) {
      var px = T.px0, py = T.py0, vx = 0, vy = 0, k = 0, i;
      for (i = refIdx + dir; i >= 0 && i < total; i += dir) {
        if (opts.limit && Math.abs(i - refIdx) > opts.limit) break;
        yield i;
        var img = getFrame(i);
        if (!img) { out[i] = null; if (k === 0) stats.coasts++; k++; if (opts.onProgress) opts.onProgress(++done, total - 1); continue; }
        var sp = Math.hypot(vx, vy), kk = k ? Math.min(k, 3) * 0.5 : 1;
        var pcx = Math.max(T.ex, Math.min(w - 1 - T.ex, Math.round(px + vx * kk))), pcy = Math.max(T.ey, Math.min(h - 1 - T.ey, Math.round(py + vy * kk)));
        var thrNear = tNear, thrWide = tWide, f;
        if (k > 6 && i % (k > 40 ? 15 : 6) !== 0) { out[i] = null; k++; if (opts.onProgress) opts.onProgress(++done, total - 1); continue; }   // uzun kayiplarda her karede tam arama yapma
        var rN = Math.min(Rmax, Math.ceil(1.5 * sp + 8 + 2 * Math.min(k, 6)));         // 1. asama: tahminin hemen cevresi
        f = smallFind(img, w, h, T, off, pcx, pcy, rN, 1);
        var okF = f.s >= thrNear;
        if (!okF) {                                                                    // 2. asama: biraz genis
          var r1 = Math.min(Rmax, Math.ceil(2 * sp + 14 + 2 * Math.min(k, 12)), 60), fm = smallFind(img, w, h, T, off, pcx, pcy, r1, 1);
          if (fm.s > f.s) f = fm; okF = f.s >= thrNear;
        }
        if (!okF && T.m >= 12 && wideMs > 0) {                                         // 3. asama: tum cevre
          var tw0 = Date.now(), r2 = k === 0 ? Rmax : Math.min(0.45 * w, Rmax * (1 + 0.5 * k));
          var f2 = smallFindWide(img, w, h, T, off, S, offS, pcx, pcy, Math.round(r2)); wideMs -= Date.now() - tw0;
          if (f2.s >= thrWide) { f = f2; okF = true; } else if (f2.s > f.s) f = f2;
        }
        if (okF) {
          if (k > 0) stats.resumes++;
          vx = 0.5 * vx + 0.5 * (f.x - px) / (k + 1); vy = 0.5 * vy + 0.5 * (f.y - py) / (k + 1); px = f.x; py = f.y; k = 0;
          out[i] = summ(i, px + T.ofx, py + T.ofy, f.s);
        } else { if (k === 0) { stats.coasts++; stats.lkLost++; } k++; vx *= 0.9; vy *= 0.9; out[i] = null; }
        if (opts.dbg) opts.dbg(i, f.s, f.x, f.y, k);
        if (opts.onProgress) opts.onProgress(++done, total - 1);
      }
      return { lost: null };
    }
    var rf = { lost: null }, rb = { lost: null };
    if (dirs === 'fwd' || dirs === 'both') rf = yield* run(1);
    if (dirs === 'bwd' || dirs === 'both') rb = yield* run(-1);
    stats.maskPx = T.m; stats.bgFrames = T.bgFrames;
    return { frames: out, lostFwd: rf.lost, lostBwd: rb.lost, reasonFwd: rf.reason, reasonBwd: rb.reason, refIdx: refIdx, w: w, h: h, stats: stats, cuts: [] };
  }
  /* ffmpeg'ten `count` kareyi (yerel cozunurluk, gri) akit; her kare icin onFrame(i, Uint8Array) cagrilir (kare kopya degil, saklanabilir). */
  function streamGray(ffmpeg, file, tStart, count, fps, W, H, onFrame, sig) {
    return new Promise(function (resolve, reject) {
      var args = ['-v', 'error', '-ss', String(Math.max(0, tStart)), '-i', file, '-frames:v', String(count), '-an', '-vf', 'fps=' + fps + ',scale=' + W + ':' + H + ':flags=area,format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
      var p = cp.spawn(ffmpeg, args, { windowsHide: true }), size = W * H, cur = Buffer.allocUnsafe(size), fill = 0, idx = 0, err = '';
      if (sig) sig.kill = function () { try { p.kill(); } catch (e) {} };
      p.stdout.on('data', function (d) {
        var pos = 0;
        while (pos < d.length && idx < count) {
          var take = Math.min(size - fill, d.length - pos); d.copy(cur, fill, pos, pos + take); fill += take; pos += take;
          if (fill === size) { onFrame(idx++, new Uint8Array(cur.buffer, cur.byteOffset, size)); cur = Buffer.allocUnsafe(size); fill = 0; }
        }
      });
      p.stderr.on('data', function (d) { err += d.toString(); });
      p.on('error', function (e) { reject('ffmpeg çalıştırılamadı: ' + e.message); });
      p.on('close', function () { if (!idx && err) reject('ffmpeg kare üretmedi: ' + err.slice(0, 300)); else resolve(idx); });
    });
  }
  /* Kucuk nesne / imlec izleyici (async). o: { inSec, fps, n (kare sayisi), refIdx, rect [x,y,w,h 0-1], W, H (yerel cozunurluk), dir, searchR (W biriminde px), search, onProgress, cancel, sig }
   * Sonuc trackRegionAsync ile ayni bicimde; kare konumlari W x H koordinatinda. Kutu icinden nesne ayrilamazsa sonuc.setupError doludur. */
  async function trackSmall(ffmpeg, file, o) {
    var n = o.n, W = o.W, H = o.H, B = smallBox(o.rect, W, H), patches = new Array(n), sig = o.sig || {}, tick = Date.now(), samples = [], sEvery = Math.max(1, Math.floor(n / 6));
    await streamGray(ffmpeg, file, o.inSec, n, o.fps, W, H, function (i, f) {      // 1) arka plan icin yalniz kutu bolgesini topla (kareler saklanmaz)
      var pt = new Uint8Array(B.bw * B.bh), y; for (y = 0; y < B.bh; y++) pt.set(f.subarray((B.y0 + y) * W + B.x0, (B.y0 + y) * W + B.x0 + B.bw), y * B.bw); patches[i] = pt; if (i % sEvery === 0 && samples.length < 6) samples.push(f);
    }, sig);
    if (o.cancel && o.cancel()) return { frames: new Array(n), lostFwd: null, lostBwd: null, cancelled: true, refIdx: o.refIdx, w: W, h: H };
    var Ta = smallBuild(patches, B, o.refIdx), refP = patches[o.refIdx], Rf = new Float32Array(B.bw * B.bh), qq;
    if (refP) for (qq = 0; qq < Rf.length; qq++) Rf[qq] = refP[qq];
    var Tb = refP ? smallBuildExtreme(Rf, B) : { err: 'kare okunamadı' }; patches = null;
    var cands = []; if (!Ta.err) { Ta.kind = 'arka plan farkı'; cands.push(Ta); } if (!Tb.err) { Tb.kind = 'parlak/koyu şekil'; cands.push(Tb); }
    if (o.force) cands = cands.filter(function (c) { return o.force === 'ext' ? c === Tb : c === Ta; });
    if (!cands.length) { var em = Ta.err + ' (' + Tb.err + ')'; return { frames: new Array(n), lostFwd: o.refIdx, lostBwd: o.refIdx, reasonFwd: em, reasonBwd: em, refIdx: o.refIdx, w: W, h: H, stats: { small: 1 }, cuts: [], setupError: em }; }
    var C = 48, cache = {};
    async function ensure(i) {                           // i. kareyi iceren parcayi getir (en yakin 2 parca bellekte kalir)
      var c = Math.floor(i / C); if (cache[c]) return;
      Object.keys(cache).forEach(function (kc) { if (Math.abs(+kc - c) > 1) delete cache[kc]; });
      var s0 = c * C, fr = []; await streamGray(ffmpeg, file, o.inSec + s0 / o.fps, Math.min(C, n - s0), o.fps, W, H, function (j, f) { fr.push(f); }, sig); cache[c] = fr;
    }
    function getFrame(i) { var c = Math.floor(i / C), fr = cache[c]; return (fr && fr[i - c * C]) || null; }
    async function runWith(T, limit, onProg) {
      var opts = { dir: o.dir, searchR: o.searchR, search: o.search || 1, onProgress: onProg, dbg: o.dbg, samples: samples, limit: limit }, shared = {}; opts.shared = shared;
      var g = smallGen(getFrame, n, W, H, o.refIdx, T, opts), r = g.next();
      while (!r.done) {                                  // her kare icin gerekirse parca yukle
        if (o.cancel && o.cancel()) { try { g.return(); } catch (e) {} return { frames: shared.out || [], lostFwd: null, lostBwd: null, cancelled: true, refIdx: o.refIdx, w: W, h: H }; }
        await ensure(r.value);
        if (Date.now() - tick > 25) { await new Promise(function (res) { setTimeout(res, 0); }); tick = Date.now(); }
        r = g.next();
      }
      return r.value;
    }
    var T = cands[0];
    if (cands.length > 1) {                              // iki maske de olusturulabildi: ref'ten +-45 karede hangisi daha cok kare izliyor? (esitlikte arka plan farki)
      var best = -1;
      for (var ci = 0; ci < cands.length; ci++) {
        var tr = await runWith(cands[ci], 45, null); if (tr.cancelled) return tr;
        var okc = tr.frames.filter(Boolean).length, mc = 0, nc = 0; tr.frames.forEach(function (f) { if (f) { mc += f.conf; nc++; } });
        cands[ci].trial = okc; var margin = okc < 3 ? -9 : (nc ? mc / nc : 0) * Math.min(1, okc / 20);   // ortalama guven x (en az 20 kare izleme)
        if (margin > best + 0.02) { best = margin; T = cands[ci]; }
      }
    }
    var fin = await runWith(T, 0, o.onProgress); if (fin.stats) { fin.stats.mask = T.kind; fin.stats.trial = cands.map(function (c) { return c.kind + ':' + c.trial; }).join(' '); }
    return fin;
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

  /* v2.14 Adim 1: "Otomatik" yontemde nokta (lk) ve sablon (tp) sonuclarindan hangisinin kullanilacagina karar verir.
   * Sablon, yalnizca daha cok kare izledi diye nokta sonucunun yerine KONMAZ: once ikisinin ORTAK karelerdeki farki olculur.
   * lk, tp: trackRegion sonuclari. o.boxW / o.boxH: takip kutusu (kare piksel koordinatinda). Yalniz "wholesale" durumunda
   * (nokta takibi karelerin yarisindan azini izlediginde) cagrilir; nokta takibi iyiyse (Video 1 yolu) bu fonksiyon hic calismaz.
   * mode: 'template' = nokta takibi yargilanamayacak kadar az kare izledi (dogrulanamadi), sablon sonucu kullanilir (eski davranis);
   *       'fill'     = ikisi ortak karelerde uyumlu: nokta kareleri AYNEN kalir, bos kareler sablonla doldurulur (zayif isaretli);
   *       'points'   = ikisi celisiyor: nokta sonucu korunur, sablon kullanilmaz (tahmin yok, uyari verilir). */
  var PICK = { minOverlap: 10, tau: 0.25, maxBad: 0.10 };
  function autoPick(lk, tp, o) {
    o = o || {};
    var n = lk.frames.length, size = Math.sqrt(Math.max(1, (o.boxW || 1) * (o.boxH || 1))), tau = (o.tau || PICK.tau) * size, ov = 0, bad = 0, ds = [], i, a, b;
    var okN = 0, okT = 0;
    for (i = 0; i < n; i++) {
      a = lk.frames[i]; b = tp.frames[i];
      if (a) okN++; if (b) okT++;
      if (a && b) { var d = Math.hypot(a.cx - b.cx, a.cy - b.cy); ds.push(d); ov++; if (d > tau) bad++; }
    }
    ds.sort(function (x, y) { return x - y; });
    var info = { okN: okN, okT: okT, overlap: ov, bad: bad, badFrac: ov ? bad / ov : 0, medianPx: ov ? ds[Math.floor(ov / 2)] : 0, tauPx: tau, sizePx: size };
    if (ov < (o.minOverlap || PICK.minOverlap)) { info.mode = 'template'; info.res = tp; info.verified = false; return info; }
    if (info.badFrac > (o.maxBad === undefined ? PICK.maxBad : o.maxBad)) { info.mode = 'points'; info.res = lk; return info; }
    var f = fillGaps(lk, tp); info.mode = 'fill'; info.res = f; info.filled = f.filled; return info;
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

  /* ---------------- v2.14: hedef dogrulama UYARISI (YALNIZ uyari; salt-okunur) ----------------
   * Takip BITTIKTEN SONRA sonucu analiz eder; takip sonucunu, kareleri, koordinatlari, guven puanlarini DEGISTIRMEZ, hedefi duzeltmez / yeniden bulmaz.
   * Sinyaller: A = kutu icerigi ilk (referans) karedeki gorunumden uzak (ilk saniyedeki en yuksek benzerlige gore); B (DENEYSEL) = kutu konumu ve icerigi arka plan kadar durgun.
   * Tum sayilar DENEMELIKTIR: olculmus / dogrulanmis esik degildir. Hicbir donem "hedef kayboldu" kaniti degildir; yalniz "kontrol et" uyarisidir.
   * B tek basina yalniz "kontrol" seviyesi uretir (hareketsiz kisi testi YAPILMADI); A ve B ayni donemde surerse "yuksek" supheli. */
  var VT = { fps: 25, patchCrop: 0.7, localR: 4, bgStep: 4, A: { mode: 'rel', absLimit: 0.5, relRatio: 0.5, relBaseSec: 1.0, relStat: 'max' }, B: { enabled: true, spdLimit: 0.002, relBgRatio: 1.5 }, windowSec: 0.6, persistSec: 0.5, gapSec: 0.2, skipWeakBelow: 0, cuts: [], anchors: {} };
  function vtMerge(a, b) { var o = {}, k; for (k in a) o[k] = a[k]; for (k in (b || {})) if (b[k] !== undefined) o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') ? vtMerge(a[k], b[k]) : b[k]; return o; }
  function vtPatch(img, w, h, cx, cy, tw, th) {
    var p = new Float32Array(tw * th), m = 0, x, y, v2 = 0;
    for (y = 0; y < th; y++) for (x = 0; x < tw; x++) { var px = Math.round(cx - tw / 2) + x, py = Math.round(cy - th / 2) + y, v = (px < 0 || py < 0 || px >= w || py >= h) ? 0 : img[py * w + px]; p[y * tw + x] = v; m += v; }
    m /= p.length; for (x = 0; x < p.length; x++) { p[x] -= m; v2 += p[x] * p[x]; }
    return { t: p, m: m, v: v2, sd: Math.sqrt(v2 / p.length), tw: tw, th: th };
  }
  function vtZncc(img, w, h, tp, x0, y0) {   // saf ZNCC; pencere disinda null
    var tw = tp.tw, th = tp.th, n = tw * th, s = 0, q = 0, num = 0, ti = 0, x, y;
    if (x0 < 0 || y0 < 0 || x0 + tw > w || y0 + th > h) return null;
    for (y = 0; y < th; y++) { var row = (y0 + y) * w + x0; for (x = 0; x < tw; x++, ti++) { var v = img[row + x]; s += v; q += v * v; num += tp.t[ti] * v; } }
    var vI = q - s * s / n; if (vI < 1e-3 * n || tp.v < 1e-3) return -1; return num / Math.sqrt(vI * tp.v);
  }
  function vtLocal(img, w, h, tp, cx, cy, R) {
    var best = -2, bx = Math.round(cx - tp.tw / 2), by = Math.round(cy - tp.th / 2), dx, dy;
    for (dy = -R; dy <= R; dy++) for (dx = -R; dx <= R; dx++) { var z = vtZncc(img, w, h, tp, bx + dx, by + dy); if (z !== null && z > best) best = z; }
    return best;
  }
  function vtHalf(img, w, h) { var w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2), x, y; for (y = 0; y < h2; y++) for (x = 0; x < w2; x++) o[y * w2 + x] = (img[2 * y * w + 2 * x] + img[2 * y * w + 2 * x + 1] + img[(2 * y + 1) * w + 2 * x] + img[(2 * y + 1) * w + 2 * x + 1]) / 4; return { d: o, w: w2, h: h2 }; }
  function* vtFeatures(res, frames, w, h, refIdx, rect, o) {
    var bw = Math.max(8, rect[2] * w), bh = Math.max(8, rect[3] * h), tw = Math.max(8, Math.round(bw * o.patchCrop)), th = Math.max(8, Math.round(bh * o.patchCrop));
    var cx0 = (rect[0] + rect[2] / 2) * w, cy0 = (rect[1] + rect[3] / 2) * h, tp = vtPatch(frames[refIdx], w, h, cx0, cy0, tw, th);
    var out = { rows: [], refFlat: tp.sd < 3, box: [bw, bh] }, fr = res.frames, n = fr.length, bgCache = null, i, k;
    var bwh = Math.max(6, tw >> 1), bhh = Math.max(6, th >> 1), stp = Math.max(bhh, 12), stpx = Math.max(bwh, 12);
    for (i = 0; i < n; i++) {
      var f = fr[i]; if (!f) continue;
      if (i % 4 === 0) yield i;
      var row = { i: i, cx: f.cx, cy: f.cy, conf: f.conf, ref: vtLocal(frames[i], w, h, tp, f.cx, f.cy, o.localR), dchg: null, bgChg: null };
      var nb = (fr[i - 1] ? i - 1 : (fr[i + 1] ? i + 1 : -1));
      if (nb >= 0) { var cur = vtPatch(frames[i], w, h, f.cx, f.cy, tw, th), g = fr[nb], pb = vtPatch(frames[nb], w, h, g.cx, g.cy, tw, th), s = 0; for (k = 0; k < cur.t.length; k++) s += Math.abs((cur.t[k] + cur.m) - (pb.t[k] + pb.m)); row.dchg = s / cur.t.length; }
      if (o.bgStep && (i % o.bgStep === 0 || bgCache === null)) {   // arka plan degisimi: kutu boyutunda yamalarin onceki kareye gore ortanca farki (yarim cozunurluk)
        var bgChg = null;
        if (nb >= 0) {
          var hi = vtHalf(frames[i], w, h), hp = vtHalf(frames[nb], w, h), ds = [], x0, y0, x, y;
          for (y0 = 0; y0 + bhh <= hi.h; y0 += stp) for (x0 = 0; x0 + bwh <= hi.w; x0 += stpx) { var s2 = 0; for (y = 0; y < bhh; y += 2) for (x = 0; x < bwh; x += 2) s2 += Math.abs(hi.d[(y0 + y) * hi.w + x0 + x] - hp.d[(y0 + y) * hp.w + x0 + x]); ds.push(s2 / (Math.ceil(bhh / 2) * Math.ceil(bwh / 2))); }
          ds.sort(function (a, b) { return a - b; }); bgChg = ds.length ? ds[ds.length >> 1] : null;
        }
        bgCache = { bgChg: bgChg };
      }
      if (bgCache) row.bgChg = bgCache.bgChg;
      out.rows.push(row);
    }
    return out;
  }
  function vtWindow(rows, o, boxMax) {
    var W = Math.max(3, Math.round(o.windowSec * o.fps)), by = {}, out = [], r, j;
    for (j = 0; j < rows.length; j++) by[rows[j].i] = rows[j];
    function med(a) { var x = a.filter(function (v) { return v !== null && v !== undefined; }).sort(function (p, q) { return p - q; }); return x.length ? x[x.length >> 1] : null; }
    for (j = 0; j < rows.length; j++) {
      r = rows[j]; var w = [], k; for (k = r.i - W; k <= r.i; k++) if (by[k]) w.push(by[k]);
      if (w.length < Math.max(3, Math.round(W * 0.6))) { out.push({ i: r.i, ref: r.ref, spd: null, dchgW: null, bgChgW: null }); continue; }
      var a = w[0], b = w[w.length - 1], span = Math.max(1, b.i - a.i);
      out.push({ i: r.i, ref: r.ref, spd: Math.hypot(b.cx - a.cx, b.cy - a.cy) / span / Math.max(1, boxMax), dchgW: med(w.map(function (x) { return x.dchg; })), bgChgW: med(w.map(function (x) { return x.bgChg; })) });
    }
    return out;
  }
  function vtBuild(rowsIn, cfg) {   // saf mantik: ozellik satirlarindan donemler
    var o = vtMerge(VT, cfg || {}), rows = rowsIn.filter(function (r) { return !(o.skipWeakBelow > 0 && r.conf < o.skipWeakBelow) && !(o.anchors && o.anchors[r.i]); }), cutSet = {}, kk;
    (o.cuts || []).forEach(function (c) { for (var q = -Math.round(0.3 * o.fps); q <= Math.round(0.3 * o.fps); q++) cutSet[c + q] = true; });
    rows = rows.filter(function (r) { return !cutSet[r.i]; });
    var F = vtWindow(rows, o, o.boxMax || 1), bl = null;
    if (o.A.mode === 'rel') {   // kosunun kendi baslangic davranisi: ref karesinden uzaklasirken ilk relBaseSec saniyedeki en yuksek (veya medyan) benzerlik
      var m = Math.max(3, Math.round(o.A.relBaseSec * o.fps)), pos = rows.filter(function (r) { return r.i > o.refIdx; }).slice(0, m).map(function (r) { return r.ref; }), neg = rows.filter(function (r) { return r.i < o.refIdx; }).slice(-m).map(function (r) { return r.ref; });
      var st = function (a) { var x = a.slice().sort(function (p, q) { return p - q; }); return x.length ? (o.A.relStat === 'max' ? x[x.length - 1] : x[x.length >> 1]) : null; };
      bl = { fwd: st(pos), bwd: st(neg) };
    }
    function flagA(r) {
      if (o.refFlat) return false;
      if (o.A.mode === 'abs') return r.ref < o.A.absLimit;
      if (o.A.mode === 'rel') { var b = r.i >= o.refIdx ? bl.fwd : bl.bwd; return b !== null && r.ref < o.A.relRatio * b; }
      return false;
    }
    function flagB(r) { if (!o.B.enabled || r.spd === null || r.dchgW === null) return false; return r.spd < o.B.spdLimit && r.bgChgW !== null && r.dchgW < o.B.relBgRatio * Math.max(r.bgChgW, 0.3); }
    var flags = F.map(function (r) { return { i: r.i, A: flagA(r), B: flagB(r) }; });
    var minLen = Math.max(1, Math.round(o.persistSec * o.fps)), gap = Math.round(o.gapSec * o.fps);
    function runs(key) {   // izlenen kareler uzerinde: en fazla `gap` kare normal kalmasina izin veren kesintisiz diziler, en az minLen kare
      var out = [], cur = null, miss = 0, q;
      for (q = 0; q < flags.length; q++) {
        var f = flags[q];
        if (f[key]) { if (!cur) cur = { from: f.i, to: f.i, n: 1 }; else { cur.to = f.i; cur.n++; } miss = 0; }
        else if (cur) { miss++; if (miss > gap) { if (cur.n >= minLen) out.push(cur); cur = null; miss = 0; } }
      }
      if (cur && cur.n >= minLen) out.push(cur); return out;
    }
    var ra = runs('A'), rb = runs('B'), eps = [];
    ra.forEach(function (e) { eps.push({ from: e.from, to: e.to, n: e.n, signal: 'A', level: 'kontrol', experimental: false }); });
    rb.forEach(function (e) { eps.push({ from: e.from, to: e.to, n: e.n, signal: 'B', level: 'kontrol', experimental: true }); });   // B tek basina yalniz "kontrol"
    ra.forEach(function (a) { rb.forEach(function (b) { var lo = Math.max(a.from, b.from), hi = Math.min(a.to, b.to); if (lo <= hi) eps.push({ from: lo, to: hi, n: hi - lo + 1, signal: 'A+B', level: 'yuksek', experimental: true }); }); });
    eps.sort(function (p, q) { return p.from - q.from || (p.signal < q.signal ? -1 : (p.signal > q.signal ? 1 : 0)); });
    return { episodes: eps, flags: flags };
  }
  function* vtGen(res, frames, w, h, refIdx, rect, opts) {
    var o = vtMerge(VT, opts), feat = yield* vtFeatures(res, frames, w, h, refIdx, rect, o), notes = [];
    if (feat.refFlat) notes.push('referans kutu icinde ayirt edici doku yok: hedef dogrulamasi yapilamadi (A devre disi)');
    var be = vtBuild(feat.rows, vtMerge(o, { refIdx: refIdx, refFlat: feat.refFlat, boxMax: Math.max(feat.box[0], feat.box[1]) }));
    return { episodes: be.episodes, rows: feat.rows, notes: notes };
  }
  function verifyTarget(res, frames, w, h, refIdx, rect, opts) { var g = vtGen(res, frames, w, h, refIdx, rect, opts), r; do { r = g.next(); } while (!r.done); return r.value; }
  function verifyTargetAsync(res, frames, w, h, refIdx, rect, opts) {   // UI donmasin: parca parca (25 ms dilimler)
    return new Promise(function (resolve, reject) {
      var g; try { g = vtGen(res, frames, w, h, refIdx, rect, opts); } catch (e) { return reject(e); }
      function tick() { var t0 = Date.now(), r; try { do { r = g.next(); } while (!r.done && Date.now() - t0 < 25); } catch (e) { return reject(e); } if (r.done) resolve(r.value); else setTimeout(tick, 0); }
      tick();
    });
  }

  /* ===== v2.15: dogrulamali aday secimi (improveTrack) + sabit kamera on plan izleyici (fgTrack) =====
   * Yalniz dogrulama (verifyTarget) supheli donem bulursa calisir; supheli donem yoksa sonuc BIREBIR ayni kalir (Video 1).
   * Adaylar gercek goruntu kanitina dayanir; konum uydurulmaz. Aday ancak belirgin sekilde daha az supheli / kayip kare uretirse alinir.
   * Korunan motor fonksiyonlarina (trackGen, tplGen, ...) dokunulmaz; yalniz trackRegionAsync cagrilir. */
  var FG = { thr: 18, minMaskPx: 20, minScore: 0.3, maxLost: 6, staticShare: 0.15, staticRatio: 1.0, bgSamples: 31, minScene: 12 };

  function fgSceneBounds(n, refIdx, cuts) {            // cuts: kesme olan (yeni sahnenin ilk) kare indeksleri
    var a = 0, b = n - 1, k;
    for (k = 0; k < (cuts || []).length; k++) { var c = cuts[k]; if (c <= refIdx && c > a) a = c; if (c > refIdx && c - 1 < b) b = c - 1; }
    return [a, b];
  }
  function* fgBackground(frames, w, h, a, b) {         // sahne icin pikselbasina zamansal medyan (kamera sabitse arka plan); satir gruplari arasinda yield (UI donmasin)
    var m = Math.min(FG.bgSamples, b - a + 1), idx = [], k, p, q, N = w * h, bg = new Uint8Array(N), tmp = new Uint8Array(m), chunk = Math.max(1, Math.floor(60000 / Math.max(1, m)));
    for (k = 0; k < m; k++) idx.push(a + Math.round(k * (b - a) / Math.max(1, m - 1)));
    for (p = 0; p < N; p++) {
      for (k = 0; k < m; k++) { var v = frames[idx[k]][p]; q = k - 1; while (q >= 0 && tmp[q] > v) { tmp[q + 1] = tmp[q]; q--; } tmp[q + 1] = v; }
      bg[p] = tmp[m >> 1];
      if (p % chunk === chunk - 1) yield 0;
    }
    return { bg: bg, idx: idx };
  }
  function fgIsStatic(frames, w, h, bgo) {             // kamera sabit mi? (1) medyan kareden >18 farkli piksel payi kucuk, (2) ortalama |fark| / ortalama yerel gradyan kucuk (kontrasttan bagimsiz; olculen: V3 0.13, V1 8.3, V2 13)
    var shares = [], ratios = [], k, p, x, y, N = w * h, step = 3, g = 0, gn = 0, bg = bgo.bg;
    for (y = 1; y < h - 1; y += 3) for (x = 1; x < w - 1; x += 3) { g += Math.abs(bg[y * w + x + 1] - bg[y * w + x - 1]) + Math.abs(bg[(y + 1) * w + x] - bg[(y - 1) * w + x]); gn += 2; }
    g = Math.max(0.5, g / Math.max(1, gn));
    for (k = 0; k < bgo.idx.length; k++) { var f = frames[bgo.idx[k]], c = 0, tot = 0, sd = 0; for (p = 0; p < N; p += step) { var d = Math.abs(f[p] - bg[p]); tot++; sd += d; if (d > FG.thr) c++; } shares.push(c / tot); ratios.push(sd / tot / g); }
    shares.sort(function (a, b) { return a - b; }); ratios.sort(function (a, b) { return a - b; });
    var ms = shares[shares.length >> 1], mr = ratios[ratios.length >> 1];
    return { median: ms, ratio: mr, ok: ms < FG.staticShare && mr < FG.staticRatio };
  }
  function fgWz(cur, cw, tp, tm, bw, bh, x0, y0) {     // on plan agirlikli ZNCC
    var sw = 0, sa = 0, sb = 0, x, y, i;
    for (y = 0; y < bh; y++) { var ro = y * bw, co = (y0 + y) * cw + x0; for (x = 0; x < bw; x++) { if (tm[ro + x]) { sw++; sa += tp[ro + x]; sb += cur[co + x]; } } }
    if (sw < FG.minMaskPx) return -1;
    var ma = sa / sw, mb = sb / sw, saa = 0, sbb = 0, sab = 0;
    for (y = 0; y < bh; y++) { var ro2 = y * bw, co2 = (y0 + y) * cw + x0; for (x = 0; x < bw; x++) { if (tm[ro2 + x]) { var a = tp[ro2 + x] - ma, b = cur[co2 + x] - mb; saa += a * a; sbb += b * b; sab += a * b; } } }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : -1;
  }
  function* fgGen(frames, w, h, refIdx, rect, opts) {
    opts = opts || {};
    var n = frames.length, sc = opts.scene || [0, n - 1], a = sc[0], b = sc[1], out = new Array(n), i;
    for (i = 0; i < n; i++) out[i] = null;
    var res = { frames: out, lostFwd: null, lostBwd: null, refIdx: refIdx, w: w, h: h, method: 'fg' };
    if (b - a + 1 < FG.minScene) { res.reason = 'sahne cok kisa'; return res; }
    var bgo = yield* fgBackground(frames, w, h, a, b);
    var st = fgIsStatic(frames, w, h, bgo); res.staticShare = st.median; res.staticRatio = st.ratio;
    if (!st.ok) { res.reason = 'kamera sabit degil (arka plan modeli gecersiz; fark/gradyan ' + st.ratio.toFixed(2) + ')'; return res; }
    var bg = bgo.bg, bw = Math.max(8, Math.round(rect[2] * w)), bh = Math.max(8, Math.round(rect[3] * h)), bx0 = Math.round(rect[0] * w), by0 = Math.round(rect[1] * h);
    if (bx0 < 0 || by0 < 0 || bx0 + bw > w + 1 || by0 + bh > h + 1) { res.reason = 'kutu kare disinda'; return res; }
    bx0 = Math.min(bx0, w - bw); by0 = Math.min(by0, h - bh);
    var exact = [rect[0] * w, rect[1] * h];
    function emit(t, dx, dy, s) { var x0 = exact[0] + dx, y0 = exact[1] + dy; return { i: t, poly: [[x0, y0], [x0 + bw, y0], [x0 + bw, y0 + bh], [x0, y0 + bh]], cx: x0 + bw / 2, cy: y0 + bh / 2, scale: 1, rot: 0, conf: Math.max(0.05, Math.min(1, s)) }; }
    out[refIdx] = emit(refIdx, 0, 0, 1);
    var Rx = Math.max(10, Math.min(36, Math.round(0.4 * bw))), Ry = Math.max(4, Math.min(12, Math.round(0.1 * bh)));
    var tp = new Uint8Array(bw * bh), tm = new Uint8Array(bw * bh);
    var dirs = opts.dir === 'fwd' ? [1] : (opts.dir === 'bwd' ? [-1] : [1, -1]), di;
    for (di = 0; di < dirs.length; di++) {
      var d = dirs[di], x0 = bx0, y0 = by0, vx = 0, vy = 0, lost = 0, t, tEnd = d > 0 ? b : a, prev = refIdx;
      for (t = refIdx + d; d > 0 ? t <= tEnd : t >= tEnd; t += d) {
        var P = frames[prev], x, y, cnt = 0;
        for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) { var o = (y0 + y) * w + x0 + x; tp[y * bw + x] = P[o]; var mv = Math.abs(P[o] - bg[o]) > FG.thr ? 1 : 0; tm[y * bw + x] = mv; cnt += mv; }
        var best = -2, bxx = x0, byy = y0, px = Math.round(x0 + vx), py = Math.round(y0 + vy), sx, dx, dy, grid = {};
        if (cnt >= FG.minMaskPx) {
          for (dy = -Ry; dy <= Ry; dy++) for (dx = -Rx; dx <= Rx; dx++) { var xx = px + dx, yy = py + dy; if (xx < 0 || yy < 0 || xx + bw > w || yy + bh > h) continue; sx = fgWz(frames[t], w, tp, tm, bw, bh, xx, yy); grid[xx + ',' + yy] = sx; if (sx > best) { best = sx; bxx = xx; byy = yy; } }
        }
        if (best < FG.minScore) {                       // bu karede on plan bulunamadi: konum UYDURULMAZ, kare bos kalir
          lost++; if (lost > FG.maxLost) { if (d > 0) res.lostFwd = t; else res.lostBwd = t; res.reason = 'on plan kayboldu'; break; }
          vx *= 0.8; vy *= 0.8; prev = prev; if ((t - refIdx) % 40 === 0) yield 0; continue;
        }
        lost = 0;
        var gl = grid[(bxx - 1) + ',' + byy], gr = grid[(bxx + 1) + ',' + byy], gu = grid[bxx + ',' + (byy - 1)], gd = grid[bxx + ',' + (byy + 1)], fx = 0, fy = 0;
        if (gl !== undefined && gr !== undefined) { var dn = gl - 2 * best + gr; if (dn < -1e-6) fx = Math.max(-0.5, Math.min(0.5, 0.5 * (gl - gr) / dn)); }
        if (gu !== undefined && gd !== undefined) { var dn2 = gu - 2 * best + gd; if (dn2 < -1e-6) fy = Math.max(-0.5, Math.min(0.5, 0.5 * (gu - gd) / dn2)); }
        vx = 0.6 * vx + 0.4 * (bxx - x0); vy = 0.6 * vy + 0.4 * (byy - y0); x0 = bxx; y0 = byy;
        out[t] = emit(t, x0 + fx - bx0, y0 + fy - by0, best);
        prev = t;
        if ((t - refIdx) % 20 === 0) yield 0;
      }
    }
    return res;
  }
  function fgTrackAsync(frames, w, h, refIdx, rect, opts) {
    return new Promise(function (resolve, reject) {
      var g = fgGen(frames, w, h, refIdx, rect, opts);
      function tick() { var t0 = Date.now(), r; try { do { if (opts && opts.cancel && opts.cancel()) { try { g.return(); } catch (e) {} return resolve(null); } r = g.next(); } while (!r.done && Date.now() - t0 < 25); } catch (e) { return reject(e); } if (r.done) resolve(r.value); else setTimeout(tick, 0); }
      tick();
    });
  }
  function vtSuspectCount(ver, n) {                      // supheli episode'larin kapsadigi benzersiz kare sayisi
    var seen = {}, c = 0, k, i, e;
    if (!ver || !ver.episodes) return 0;
    for (k = 0; k < ver.episodes.length; k++) { e = ver.episodes[k]; for (i = Math.max(0, e.from); i <= Math.min(n - 1, e.to); i++) if (!seen[i]) { seen[i] = 1; c++; } }
    return c;
  }
  function trackedCount(res) { var c = 0; res.frames.forEach(function (f) { if (f) c++; }); return c; }
  /* Iki sonucu kare bazinda birlestir: ayni karede ikisi de varsa ve konumlari kutu boyunun %35'inden fazla ayriliyorsa, ayrisan ARDISIK kareler
   * (en fazla 2 karelik bosluk toleransi) bir parca sayilir; parcada referansa benzerligi (ref) ortalamada belirgin (>0.05) yuksek olan sonuc alinir.
   * Yalniz biri varsa o alinir. Her iki sonuc da gercek takip ciktisidir; konum uydurulmaz. */
  function mergeByRef(res0, v0, cand, vc) {
    var n = res0.frames.length, out = new Array(n), i, r0 = {}, rc = {};
    (v0.rows || []).forEach(function (q) { r0[q.i] = q.ref; }); (vc.rows || []).forEach(function (q) { rc[q.i] = q.ref; });
    function size(f) { var xs = f.poly.map(function (p) { return p[0]; }), ys = f.poly.map(function (p) { return p[1]; }); return Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys)); }
    var dis = new Array(n), takeC = new Array(n);
    for (i = 0; i < n; i++) { var a = res0.frames[i], b = cand.frames[i]; takeC[i] = false; dis[i] = !!(a && b && Math.hypot(a.cx - b.cx, a.cy - b.cy) > 0.35 * size(a)); if (!a && b) takeC[i] = true; }
    i = 0;
    while (i < n) {
      if (!dis[i]) { i++; continue; }
      var s = i, e = i, gap = 0, j = i + 1;
      while (j < n && gap <= 2) { if (dis[j]) { e = j; gap = 0; } else gap++; j++; }
      var m0 = 0, mc = 0, c = 0, k;
      for (k = s; k <= e; k++) if (res0.frames[k] && cand.frames[k] && r0[k] !== undefined && rc[k] !== undefined) { m0 += r0[k]; mc += rc[k]; c++; }
      var pickC = c > 0 && (mc - m0) / c > 0.05;
      for (k = s; k <= e; k++) takeC[k] = pickC && !!cand.frames[k];
      i = e + 1;
    }
    for (i = 0; i < n; i++) out[i] = takeC[i] ? cand.frames[i] : (res0.frames[i] || null);
    return Object.assign({}, res0, { frames: out });
  }
  /* res0: mevcut (otomatik akis) sonucu. Donus: { res, changed, auto, note, report, v, alt, orig }.
   * KURAL (Video 1'i korumak icin): mevcut kareler YALNIZ su durumlarda degistirilir ("auto"):
   *   (a) iki sinyalli (A+B) sabit kilit bulundu ve aday hareket ediyor (B yok); (b) cok kare BOS (>=%15): yalniz bos kareler adaydan doldurulur, mevcut kareler aynen kalir;
   *   (c) supheli donem kliibin >=%50'sini kapsiyor ve aday belirgin daha iyi. Diger durumlarda daha iyi bir aday "alt" olarak HAZIRLANIR, ama uygulanmaz (kullanici onayi).
   * Referans benzerligi (A) tek basina hakem degildir: Video 1'de farkli baslangic karelerinde A, dogru takibi supheli, yanlis adayi "daha iyi" gosterebildi (olculdu). */
  async function improveTrackAsync(res0, frames, w, h, refIdx, rect, opts) {
    opts = opts || {};
    var n = frames.length, vopts = { fps: opts.fps, cuts: opts.cuts || [], anchors: opts.anchors || {} };
    var v0 = await verifyTargetAsync(res0, frames, w, h, refIdx, rect, vopts);
    var origHigh = v0.episodes.some(function (e) { return e.level === 'yuksek'; }), s0 = vtSuspectCount(v0, n), miss0 = n - trackedCount(res0), score0 = s0 + miss0, frac0 = s0 / n;
    var report = { base: { suspect: s0, missing: miss0, score: score0, episodes: v0.episodes.length, high: origHigh, suspectFrac: +frac0.toFixed(2) }, cands: [] };
    var none = { res: res0, changed: false, auto: false, note: '', report: report, v: v0, alt: null, orig: res0 };
    var sc0 = fgSceneBounds(n, refIdx, opts.cuts), scN = sc0[1] - sc0[0] + 1, sceneEp = v0.episodes.filter(function (e) { return e.to >= sc0[0] && e.from <= sc0[1]; }), missSc = 0, qq;
    for (qq = sc0[0]; qq <= sc0[1]; qq++) if (!res0.frames[qq]) missSc++;
    var hasB0 = sceneEp.some(function (e) { return e.signal.indexOf('B') >= 0; }), needTpl = missSc >= 0.15 * scN;   // sablon adayi yalniz bos kare doldurmak icin (kendiliginden uygulanabilen tek sablon yolu);   // yalniz REFERANS SAHNESI sayilir: baska sahnelerdeki (kesme sonrasi) bos / sabit kareler yavas aramayi tetiklemesin;   // sablon adaylari yavas (dakikalar): yalniz kendiliginden uygulanabilecekse; yalniz-B durumunda sabit kamera on plan adayi (hizli) denenir
    if ((!v0.episodes.length && miss0 < 0.15 * n) || (opts.cancel && opts.cancel())) return none;
    var cands = [], stage = opts.onStage || function () {};
    function runT(crop, p0, p1) { stage('Şablon adayı deneniyor', p0); var last = -1; return trackRegionAsync(frames, w, h, refIdx, rect, Object.assign({}, opts.base || {}, { method: 'tpl', tplCrop: crop, cancel: opts.cancel, onProgress: function (d, t) { var p = Math.round(p0 + (p1 - p0) * d / Math.max(1, t)); if (p !== last) { last = p; stage('Şablon adayı deneniyor', p); } } })); }   // yuzde: sablon 0-35, 35-70, on plan 70-90, degerlendirme 90-100
    var t7 = needTpl ? await runT(0.7, 0, 35) : null; if (t7 && !t7.cancelled) cands.push({ name: 'şablon', kind: 'full', res: t7 });
    var t1 = needTpl ? await runT(1, 35, 70) : null; if (t1 && !t1.cancelled) cands.push({ name: 'şablon (tam kutu)', kind: 'full', res: t1 });
    stage('Sabit kamera ön plan adayı deneniyor', 70);
    var fgr = await fgTrackAsync(frames, w, h, refIdx, rect, { scene: fgSceneBounds(n, refIdx, opts.cuts), cancel: opts.cancel });
    report.fg = fgr ? { reason: fgr.reason || null, tracked: trackedCount(fgr), staticShare: fgr.staticShare } : null;
    if (fgr && trackedCount(fgr) >= FG.minScene) {      // yalniz kendi sahnesinde; sahne disinda mevcut sonuc korunur
      var sc = fgSceneBounds(n, refIdx, opts.cuts), merged = res0.frames.slice(), i;
      for (i = sc[0]; i <= sc[1]; i++) merged[i] = fgr.frames[i] || null;
      cands.push({ name: 'sabit kamera ön plan', kind: 'fg', res: Object.assign({}, res0, { frames: merged }) });
    }
    var tp = []; cands.forEach(function (c) { if (c.kind === 'full') tp.push(c); });
    if (miss0 >= 0.15 * n) tp.forEach(function (c) {    // (b) yalniz bos kareleri doldur; mevcut kareler AYNEN
      var fr = res0.frames.map(function (f, i) { return f || c.res.frames[i] || null; });
      cands.push({ name: 'boşlukları ' + c.name + ' ile doldur', kind: 'fill', res: Object.assign({}, res0, { frames: fr }) });
    });
    // Degisim yalniz supheli donemlerde (+-0.5 sn pay) gecerli olsun; disindaki kareler ilk sonuctan AYNEN kalir (bos olanlar adaydan dolar). Supheli donem icinde aday bossa kare bos kalir (yanlis kilit konumu "izlendi" gibi gosterilmez).
    var margin = Math.max(1, Math.round(0.5 * (opts.fps || 25))), span = new Array(n), q2;
    v0.episodes.forEach(function (e) { for (q2 = Math.max(0, e.from - margin); q2 <= Math.min(n - 1, e.to + margin); q2++) span[q2] = true; });
    function divergenceSpan(raw) {   // ilk sonuc ile aday kalici (>=6 kare, 2 kare bosluk toleransi) kutu boyunun %35'inden fazla ayriliyorsa o donem (+-pay) de degisim kapsamina girer (kilit, ilk supheli donemden once baslamis olabilir)
      var bs = Math.max(rect[2] * w, rect[3] * h), out = new Array(n), i, run0 = -1, last = -1, gap = 0;
      function close() { if (run0 >= 0 && last - run0 + 1 >= 6) for (var z = Math.max(0, run0 - margin); z <= Math.min(n - 1, last + margin); z++) out[z] = true; run0 = -1; last = -1; gap = 0; }
      for (i = 0; i < n; i++) { var a1 = res0.frames[i], b1 = raw.frames[i], dv = !!(a1 && b1 && Math.hypot(a1.cx - b1.cx, a1.cy - b1.cy) > 0.35 * bs); if (dv) { if (run0 < 0) run0 = i; last = i; gap = 0; } else if (run0 >= 0) { if (++gap > 2) close(); } }
      close(); return out;
    }
    cands.forEach(function (c) {
      if (c.kind !== 'full' && c.kind !== 'fg') return;
      var sp = span, dsp = (c.kind === 'fg' && (origHigh || v0.episodes.some(function (e) { return e.signal.indexOf('B') >= 0; }))) ? divergenceSpan(c.res) : null;
      var fr2 = res0.frames.map(function (f, i) { return (sp[i] || (dsp && dsp[i])) ? (c.res.frames[i] || null) : (f || c.res.frames[i] || null); });
      c.rawRes = c.res; c.res = Object.assign({}, res0, { frames: fr2 });
    });
    var k, evals = [];
    async function evalCand(c) {
      var v = await verifyTargetAsync(c.res, frames, w, h, refIdx, rect, vopts), s = vtSuspectCount(v, n), miss = n - trackedCount(c.res), mc = 0, mn = 0;
      c.res.frames.forEach(function (f) { if (f) { mc += f.conf; mn++; } });
      c.v = v; c.suspect = s; c.missing = miss; c.score = s + miss; c.high = v.episodes.some(function (e) { return e.level === 'yuksek'; });
      c.hasB = v.episodes.some(function (e) { return e.signal.indexOf('B') >= 0; }); c.meanConf = mn ? mc / mn : 0;
      report.cands.push({ name: c.name, kind: c.kind, suspect: s, missing: miss, score: c.score, high: c.high, hasB: c.hasB, meanConf: +c.meanConf.toFixed(2), episodes: v.episodes.length });
      // uygun: yuksek suphe yok ve (>=%30 iyilesme ya da iki sinyalli sabit kilitte hareket eden, guveni >=0.6 ve skoru dusen aday)
      c.ok = !c.high && (c.score <= 0.7 * score0 || (origHigh && !c.hasB && c.meanConf >= 0.6 && c.score < score0));
      return c;
    }
    for (k = 0; k < cands.length; k++) { if (opts.cancel && opts.cancel()) break; stage('Adaylar karşılaştırılıyor', Math.round(90 + 10 * k / cands.length)); evals.push(await evalCand(cands[k])); }
    var bt = null; cands.forEach(function (c) { if (c.kind === 'full' && !c.high && (!bt || c.score < bt.score)) bt = c; });
    if (bt && bt.v && !(opts.cancel && opts.cancel())) {   // birlesik (kare bazinda ref benzerligi): yalniz ALTERNATIF olarak sunulur, kendiliginden uygulanmaz
      var mres = mergeByRef(res0, v0, bt.res, bt.v), mc2 = { name: 'birleşik (ilk sonuç + ' + bt.name + ')', kind: 'merge', res: mres };
      cands.push(mc2); evals.push(await evalCand(mc2));
    }
    if (opts.cancel && opts.cancel()) return none;   // iptal edildi: kismi degerlendirmeyle hicbir sey uygulanmaz
    var elig = evals.filter(function (c) { return c.ok; }).sort(function (a, b) { return a.score - b.score; });
    var best = elig[0] || null;
    var fgAny = null; evals.forEach(function (c) { if (c.kind === 'fg' && !fgAny && !c.high) fgAny = c; });
    if (!best && !fgAny) return none;
    // sabit kamerada iki bagimsiz kanit: (1) ilk sonuc supheli donemde DONMUS (+-0.3 sn icinde kutu boyunun %5'inden az yer degistirmis), (2) on plan adayi ayni karelerde kutu boyunun >=%50'si kadar uzakta ve hareket ediyor
    var frozenFg = false, fgc = fgAny;   // on plan adayi dogrulayici skoru (A/B) yuzunden elenmis olsa bile degerlendirilir: kendi kaniti var
    if (fgc && v0.episodes.length) {
      var bs = Math.max(rect[2] * w, rect[3] * h), dd = [], kk = Math.max(1, Math.round(0.3 * (opts.fps || 25)));
      v0.episodes.forEach(function (e) { for (var q = e.from; q <= e.to; q++) { var a1 = res0.frames[q], b1 = fgc.rawRes.frames[q], p0 = res0.frames[Math.max(0, q - kk)], p1 = res0.frames[Math.min(n - 1, q + kk)]; if (!a1 || !b1 || !p0 || !p1) continue; if (Math.hypot(p1.cx - p0.cx, p1.cy - p0.cy) > 0.05 * bs) continue; dd.push(Math.hypot(a1.cx - b1.cx, a1.cy - b1.cy) / bs); } });
      dd.sort(function (x, y) { return x - y; }); report.frozenVsFg = dd.length ? +dd[dd.length >> 1].toFixed(2) : null;
      frozenFg = dd.length >= 6 && dd[dd.length >> 1] >= 0.5;
    }
    function autoOk(c) { return (c.kind === 'fg' && (origHigh || frozenFg)) || (!c.hasB && c.kind === 'fill'); }   // v2.16: on plan adayi icin B (deneysel, hareketsiz kutu) vetosu yok: kendi kaniti var (ilk sonuc sabit kilitli + hareketli on plan); 480/960 px'de gercek takibi B yanlis isaretliyordu   // v2.16: sablon adayi kendiliginden UYGULANMAZ (gercek V2 kullaniminda isinlanma / titreme uretti); yalniz alternatif olarak sunulabilir
    var chosen = null; elig.forEach(function (c) { if (!chosen && autoOk(c)) chosen = c; });
    if (!chosen && frozenFg && fgc) chosen = fgc;
    if (chosen) {
      var out = Object.assign({}, chosen.res, { improvedBy: chosen.name });
      var why = chosen.kind === 'fill' ? 'çok sayıda boş kare vardı; yalnızca boş kareler dolduruldu' : ((origHigh || frozenFg) ? 'hedefin sabit bir yere kilitlendiği görüldü' : 'şüpheli dönem klibin yarısından fazlasını kapsıyordu');
      return { res: out, changed: true, auto: true, note: ' (otomatik düzeltme: ' + why + '; "' + chosen.name + '" kullanıldı; "İlk takibe dön" ile geri alınabilir)', report: report, v: chosen.v, from: v0, alt: null, orig: res0 };
    }
    return { res: res0, changed: false, auto: false, note: '', report: report, v: v0, alt: best ? { res: Object.assign({}, best.res, { improvedBy: best.name }), name: best.name, v: best.v, score: best.score } : null, orig: res0 };
  }

  /* v2.16: sahne kesmesinden sonra, referans sahnesi DISINDA kalan ve kesintisiz izlenen >=3 karelik bir dizi piksel duzeyinde HIC hareket etmiyorsa (kutu merkezi yayilimi < 0.001 x kare genisligi)
   * o dizi bos birakilir. Neden: kesmeden sonra nesne yoktur; takipci arka plana kilitlenir (guveni yuksek gorunur) ve bu kareler keyframe olup dogrusal gecisle nesneyi bir yerden digerine ucurur.
   * Uydurma konum uretmez, yalniz siler. Kesme yoksa sonuc AYNEN doner. */
  function dropFrozenAfterCuts(res, cuts, refIdx, w) {
    var n = res.frames.length, cs = (cuts || []).filter(function (c) { return c > 0 && c < n; }).sort(function (a, b) { return a - b; }), dropped = 0, out = res.frames.slice(), i, k, a0 = 0, b0 = n - 1, tol = 0.001 * w;
    if (!cs.length) return { res: res, dropped: 0 };
    for (k = 0; k < cs.length; k++) { if (cs[k] <= refIdx) a0 = cs[k]; else { b0 = cs[k] - 1; break; } }   // referans sahnesi [a0, b0]
    function cen(f) { return f.cx != null ? [f.cx, f.cy] : [(f.poly[0][0] + f.poly[2][0]) / 2, (f.poly[0][1] + f.poly[2][1]) / 2]; }
    var inRef = function (q) { return q >= a0 && q <= b0; }, run0 = -1, q;   // run: birbirini izleyen, kare kareye < tol kayan izli kareler
    function flush(end) { if (run0 >= 0 && end - run0 >= 3) for (var z = run0; z < end; z++) { out[z] = null; dropped++; } run0 = -1; }
    for (i = 0; i <= n; i++) {
      if (i < n && out[i] && !inRef(i)) {
        if (run0 >= 0) { var c1 = cen(out[i - 1]), c2 = cen(out[i]); if (out[i - 1] && Math.abs(c1[0] - c2[0]) < tol && Math.abs(c1[1] - c2[1]) < tol) continue; flush(i); }
        run0 = i;
      } else flush(i);
    }
    return dropped ? { res: Object.assign({}, res, { frames: out }), dropped: dropped } : { res: res, dropped: 0 };
  }
  /* v2.16: iki izleme kaynagi birlesirken (ornegin nokta takibi kaybolunca sablon dolgusu) kutu bir karede kutu boyunun >%25'i kadar atlarsa bu "isinlanma"dir.
   * Atlayis noktasindan itibaren sonraki K karede, yeni konuma eski konumdan azalan bir kayma ile gecilir (kutu sureklilik icin ilk karede eski yerinde kalir, K karede yeni yere varir).
   * Gecis kareleri zayif guvenli (sari) isaretlenir. Atlayis yoksa sonuc AYNI nesne olarak doner. Bos (null) kareler atlayis sayilmaz. */
  function smoothJumps(res, K, frac) {
    var fr = res.frames, n = fr.length, out = null, i, q, cnt = 0; K = K || 12; frac = frac || 0.25;
    function cen(f) { return f.cx != null ? [f.cx, f.cy] : [(f.poly[0][0] + f.poly[2][0]) / 2, (f.poly[0][1] + f.poly[2][1]) / 2]; }
    function bsz(f) { var xs = f.poly.map(function (p) { return p[0]; }), ys = f.poly.map(function (p) { return p[1]; }); return Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys)); }
    for (i = 1; i < n; i++) {
      var a = (out || fr)[i - 1], b = (out || fr)[i]; if (!a || !b || !a.poly || !b.poly) continue;
      var ca = cen(a), cb = cen(b), jx = cb[0] - ca[0], jy = cb[1] - ca[1];
      if (Math.hypot(jx, jy) <= frac * Math.min(bsz(a), bsz(b))) continue;
      if (!out) out = fr.slice();
      for (q = 0; q < K && i + q < n; q++) {
        var f = out[i + q]; if (!f || !f.poly) break;
        var w = 1 - q / K, dx = -jx * w, dy = -jy * w;   // q=0: eski konum
        var nf = Object.assign({}, f); nf.cx = f.cx + dx; nf.cy = f.cy + dy; nf.poly = f.poly.map(function (pt) { return [pt[0] + dx, pt[1] + dy]; });
        nf.conf = Math.min(f.conf, 0.45); out[i + q] = nf;
      }
      cnt++; i += K - 1;
    }
    return out ? { res: Object.assign({}, res, { frames: out }), jumps: cnt } : { res: res, jumps: 0 };
  }
  var api = { setDebug: function (f) { DBG = f; }, dropFrozenAfterCuts: dropFrozenAfterCuts, smoothJumps: smoothJumps, rectHit: rectHit, rectApply: rectApply, findFfmpeg: findFfmpeg, probe: probe, readFrames: readFrames, readOneFramePng: readOneFramePng, trackRegion: trackRegion, trackRegionAsync: trackRegionAsync, mergeResults: mergeResults, fillGaps: fillGaps, detectCuts: detectCuts, detectCutsStrict: detectCutsStrict, _cutSignals: cutSignals, _strictFromSignals: strictFromSignals, autoPick: autoPick, verifyTarget: verifyTarget, verifyTargetAsync: verifyTargetAsync, _verifyBuild: vtBuild, improveTrackAsync: improveTrackAsync, fgTrackAsync: fgTrackAsync, _fgSceneBounds: fgSceneBounds, _mergeByRef: mergeByRef, toPoints: toPoints, _lk: lkPyr, _pyramid: pyramid, trackSmall: trackSmall };
  root.TetherTrack = api;   // CEP'te hem 'module' hem 'window' vardir: ikisine de ver
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

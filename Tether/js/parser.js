/* Tether - .prproj icinden mask tracker verisini okur ve Position degerlerine cevirir.
 * Sadece okur; proje dosyasina yazmaz. Ag baglantisi yok. */
(function (root) {
  var TPS = 254016000000; // Premiere tick / saniye

  function indexObjects(xml) {
    var idx = {};
    var re = /<(\w+) ObjectID="(\d+)"[^>]*?(\/?)>/g, m;
    while ((m = re.exec(xml))) {
      var tag = m[1];
      if (!/Component|Chain|Mask|Roto|Shape|Group|^SubClip$|^VideoClip$|^VideoClipTrackItem$/.test(tag)) continue;
      if (m[3] === '/') continue;
      var end = xml.indexOf('</' + tag + '>', re.lastIndex);
      if (end < 0) continue;
      idx[m[2]] = { tag: tag, body: xml.substring(re.lastIndex, end) };
    }
    return idx;
  }

  // Premiere 0 degerlerini XML'e yazmaz (ornek: 0'da baslayan klipte <Start> yok). def verilirse eksik etiket = def.
  function firstNum(body, tag, def) {
    var m = new RegExp('<' + tag + '>(-?\\d+)</' + tag + '>').exec(body);
    return m ? Number(m[1]) : (def === undefined ? null : def);
  }

  function decodeKeyframes(paramBody) {
    var m = /<Keyframes[^>]*>([\s\S]*?)<\/Keyframes>/.exec(paramBody);
    if (!m) return [];
    var out = [], items = m[1].split(';');
    for (var i = 0; i < items.length; i++) {
      var it = items[i].trim();
      if (!it) continue;
      var c = it.indexOf(',');
      var t = Number(it.substring(0, c));
      var buf = Buffer.from(it.substring(c + 1), 'base64');
      if (buf.length < 104) continue;
      var cx = buf.readFloatLE(4 + 15 * 4), cy = buf.readFloatLE(4 + 16 * 4);
      if (cx === 0 && cy === 0) continue; // ilk kare: baslangic durumu, merkez yok
      var raw = [];
      for (var q = 0; q < 25 && 4 + q * 4 + 4 <= buf.length; q++) raw.push(buf.readFloatLE(4 + q * 4));
      out.push({ src: t, cx: cx, cy: cy, raw: raw });
    }
    return out;
  }

  /* ---- Ters yonde arama yardimcilari: XML'de bir nesneyi kimlerin referans ettigini bulur ---- */
  function enclosing(xml, pos) {
    var k = xml.lastIndexOf('ObjectID="', pos); if (k < 0) return null;
    var lt = xml.lastIndexOf('<', k);
    var m = /^<(\w+)/.exec(xml.substr(lt, 80)), im = /^ObjectID="(\d+)"/.exec(xml.substr(k, 30));
    return m && im ? { tag: m[1], id: im[1], pos: lt } : null;
  }
  function parentsOf(xml, id) {
    var out = [], needle = 'ObjectRef="' + id + '"', p = xml.indexOf(needle);
    while (p >= 0 && out.length < 20) {
      var e = enclosing(xml, p); if (e && e.id !== id) out.push(e);
      p = xml.indexOf(needle, p + 1);
    }
    return out;
  }
  // Projedeki adi "Tracker" olan, keyframe'i bulunan tum nesneler (mask turu / bagli oldugu yer fark etmez)
  function trackerObjects(xml) {
    var res = [], re = /<(?:Name|n)>Tracker<\/(?:Name|n)>/g, m, seen = {};
    while ((m = re.exec(xml))) {
      var e = enclosing(xml, m.index); if (!e || seen[e.id]) continue; seen[e.id] = 1;
      var end = xml.indexOf('</' + e.tag + '>', m.index); if (end < 0) continue;
      var open = xml.indexOf('>', e.pos);
      res.push({ id: e.id, tag: e.tag, body: xml.substring(open + 1, end) });
    }
    return res;
  }
  // startId'den yukari dogru cikip targets icindeki bir nesneye (track item) ulasirsa onun id'sini dondurur
  function climbTo(xml, startId, targets) {
    var q = [startId], seen = {}, n = 0; seen[startId] = 1;
    while (q.length && n++ < 80) {
      var ps = parentsOf(xml, q.shift());
      for (var i = 0; i < ps.length; i++) {
        if (targets[ps[i].id]) return ps[i].id;
        if (!seen[ps[i].id]) { seen[ps[i].id] = 1; q.push(ps[i].id); }
      }
    }
    return null;
  }

  // Object Mask gibi verinin disarida tutuldugu durumlarda, Tracker parametresi icindeki GUID referanslarini cikarir.
  function guidsFromTrackers(xml) {
    var out = {}, list = [];
    trackerObjects(xml).forEach(function (t) {
      var re = /<StartKeyframeValue[^>]*>([^<]+)<\/StartKeyframeValue>/g, m;
      while ((m = re.exec(t.body))) {
        var txt = Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('latin1');
        var g = txt.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) || [];
        g.forEach(function (x) { x = x.toLowerCase(); if (!out[x]) { out[x] = 1; list.push(x); } });
      }
    });
    return list;
  }

  /* startTicks: timeline'da secili klibin baslangic tick'i, name: klip adi (opsiyonel)
   * 1) Klibin Motion/efekt zincirinden ileri yonde arar (eski yontem).
   * 2) Bulamazsa projedeki TUM "Tracker" verilerini bulup ters yonde klibe baglar (Unassigned Masks, her mask turu). */
  function findTracks(xml, startTicks, name) {
    var idx = indexObjects(xml);
    var cands = [];
    for (var id in idx) {
      var o = idx[id];
      if (o.tag !== 'VideoClipTrackItem') continue;
      var s = firstNum(o.body, 'Start', 0);
      if (Math.abs(s - startTicks) > 2000) continue;
      var sc = /<SubClip ObjectRef="(\d+)"/.exec(o.body);
      var nm = '';
      if (sc && idx[sc[1]]) { var n = /<(?:Name|n)>([^<]*)<\/(?:Name|n)>/.exec(idx[sc[1]].body); nm = n ? n[1] : ''; }
      cands.push({ id: id, o: o, sc: sc, nameMatch: name ? nm === name : true });
    }
    cands.sort(function (a, b) { return (b.nameMatch ? 1 : 0) - (a.nameMatch ? 1 : 0); });
    var results = [];

    function emit(c, params) {
      var start = firstNum(c.o.body, 'Start', 0), end = firstNum(c.o.body, 'End');
      var inP = null, outP = null;
      if (c.sc && idx[c.sc[1]]) {
        var cl = /<Clip ObjectRef="(\d+)"/.exec(idx[c.sc[1]].body);
        if (cl && idx[cl[1]]) { inP = firstNum(idx[cl[1]].body, 'InPoint', 0); outP = firstNum(idx[cl[1]].body, 'OutPoint'); }
      }
      if (start === null || end === null || inP === null || outP === null || outP === inP) return;
      var ratio = (end - start) / (outP - inP);
      params.forEach(function (p) {
        var kfs = decodeKeyframes(p.body);
        if (!kfs.length) return;
        var pts = kfs.map(function (k) {
          return { tl: (start + (k.src - inP) * ratio) / TPS, cx: k.cx, cy: k.cy, raw: k.raw };
        }).sort(function (a, b) { return a.tl - b.tl; });
        results.push({ clipStartSec: start / TPS, clipEndSec: end / TPS, points: pts });
      });
    }

    cands.forEach(function (c) {
      var seen = {}, params = [];
      // trackitem govdesindeki referanslari da gez
      var re2 = /ObjectRef="(\d+)"/g, m2;
      while ((m2 = re2.exec(c.o.body))) (function walk2(id3) {
        if (seen[id3]) return; seen[id3] = 1;
        var p = idx[id3]; if (!p) return;
        if (p.tag === 'ArbVideoComponentParam') {
          if (/<(?:Name|n)>Tracker<\/(?:Name|n)>/.test(p.body) && /<ParameterID>6<\/ParameterID>/.test(p.body) && p.body.indexOf('<Keyframes') >= 0) params.push(p);
          return;
        }
        if (!/Component|Chain|Mask|Group|Shape/.test(p.tag)) return;
        var r = /ObjectRef="(\d+)"/g, mm;
        while ((mm = r.exec(p.body))) walk2(mm[1]);
      })(m2[1]);
      emit(c, params);
    });

    if (!results.length && cands.length) {
      var targets = {}, byId = {}, owned = {};
      cands.forEach(function (c) { targets[c.id] = true; byId[c.id] = c; });
      trackerObjects(xml).forEach(function (t) {
        if (t.body.indexOf('<Keyframes') < 0) return;
        var owner = climbTo(xml, t.id, targets);
        if (owner) (owned[owner] = owned[owner] || []).push(t);
      });
      cands.forEach(function (c) { if (owned[c.id]) emit(c, owned[c.id]); });
    }
    return results;
  }

  // Premiere normalize (0-1) deger verir; ekran disina tasan degerler 1.5'u asabilir.
  // Sadece gercekten piksel gibi gorunen (>10) degerleri boluyoruz.
  function norm(v, size) { return Math.abs(v) > 10 ? v / size : v; }

  // Gauss agirlikli hareketli ortalama (yaricap r kare). r=0 -> kapali. Kenarlarda pencere daralir.
  function smooth(arr, r) {
    var n = arr.length;
    r = Math.max(0, Math.floor(r || 0));
    if (!r || n < 3) return arr;
    var sig = Math.max(0.5, r / 2), w = [], j;
    for (j = -r; j <= r; j++) w.push(Math.exp(-(j * j) / (2 * sig * sig)));
    // Uclarda tek tarafli pencere yerine "tek yansima" (x[-k] = 2*x[0] - x[k]): dogrusal hareket baslangicta / bitiste kaymaz.
    function at(k) {
      if (k < 0) { var m = Math.min(n - 1, -k); return [2 * arr[0][0] - arr[m][0], 2 * arr[0][1] - arr[m][1]]; }
      if (k > n - 1) { var m2 = Math.max(0, 2 * (n - 1) - k); return [2 * arr[n - 1][0] - arr[m2][0], 2 * arr[n - 1][1] - arr[m2][1]]; }
      return arr[k];
    }
    var out = [];
    for (var i = 0; i < n; i++) {
      var sx = 0, sy = 0, sw = 0;
      for (j = -r; j <= r; j++) { var ww = w[j + r], q = at(i + j); sx += q[0] * ww; sy += q[1] * ww; sw += ww; }
      out.push([sx / sw, sy / sw]);
    }
    return out;
  }

  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }

  // Takip sicramalarini (5 karelik medyandan thr kadar sapan kareleri) bulur, yerine komsu saglam kareler arasinda
  // dogrusal enterpolasyon koyar. thr: kaynak boyutuna oranla (0.05 = %5). 0 -> kapali.
  function despike(arr, thr, stats) {
    if (!thr || arr.length < 5) return arr;
    var n = arr.length, bad = [], cnt = 0, i, j;
    for (i = 0; i < n; i++) {
      var a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2), xs = [], ys = [];
      for (j = a; j <= b; j++) { xs.push(arr[j][0]); ys.push(arr[j][1]); }
      var f = Math.abs(arr[i][0] - median(xs)) > thr || Math.abs(arr[i][1] - median(ys)) > thr;
      bad.push(f); if (f) cnt++;
    }
    if (stats) stats.spikes = cnt;
    if (!cnt || cnt === n) return arr;
    var out = [];
    for (i = 0; i < n; i++) {
      if (!bad[i]) { out.push([arr[i][0], arr[i][1]]); continue; }
      var l = i - 1, r = i + 1;
      while (l >= 0 && bad[l]) l--;
      while (r < n && bad[r]) r++;
      if (l < 0) out.push([arr[r][0], arr[r][1]]);
      else if (r >= n) out.push([arr[l][0], arr[l][1]]);
      else { var t = (i - l) / (r - l); out.push([arr[l][0] + (arr[r][0] - arr[l][0]) * t, arr[l][1] + (arr[r][1] - arr[l][1]) * t]); }
    }
    return out;
  }

  // Olu bolge: "kamera" sadece nesne merkezden dz (kaynak boyutuna oranla) fazla uzaklasinca hareket eder.
  function deadzone(arr, dz) {
    if (!dz || arr.length < 2) return arr;
    var cam = [arr[0][0], arr[0][1]], out = [[cam[0], cam[1]]];
    for (var i = 1; i < arr.length; i++) {
      for (var k = 0; k < 2; k++) {
        var d = arr[i][k] - cam[k];
        if (d > dz) cam[k] = arr[i][k] - dz; else if (d < -dz) cam[k] = arr[i][k] + dz;
      }
      out.push([cam[0], cam[1]]);
    }
    return out;
  }

  // Ham takip merkezi -> temizlenmis merkez (kaynak-normalize). Sira: sicrama duzelt -> olu bolge -> yumusat.
  function clean(points, o) {
    var C = points.map(function (p) { return [p.cx, p.cy]; });
    C = despike(C, o.despike, o.stats);
    if (o.mode === 'follow') C = deadzone(C, o.deadzone);
    return smooth(C, o.smooth);
  }

  // Dogrusal interpolasyona gore gereksiz keyframe'leri ayiklar (Ramer-Douglas-Peucker, zaman farkindali).
  // tolPx: piksel hata siniri. 0 -> kapali.
  function reduceKeys(list, tolPx, W, H) {
    if (!tolPx || tolPx <= 0 || list.length < 3) return list;
    var keep = [], n = list.length, i;
    for (i = 0; i < n; i++) keep.push(false);
    keep[0] = keep[n - 1] = true;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1];
      if (b - a < 2) continue;
      var A = list[a], B = list[b], span = B.tl - A.tl, maxE = -1, mi = -1;
      for (i = a + 1; i < b; i++) {
        var t = span > 0 ? (list[i].tl - A.tl) / span : 0;
        var ex = (A.x + (B.x - A.x) * t - list[i].x) * W, ey = (A.y + (B.y - A.y) * t - list[i].y) * H;
        var e = Math.sqrt(ex * ex + ey * ey);
        if (e > maxE) { maxE = e; mi = i; }
      }
      if (maxE > tolPx) { keep[mi] = true; stack.push([a, mi]); stack.push([mi, b]); }
    }
    return list.filter(function (_, idx) { return keep[idx]; });
  }

  // Kayan pencere maksimumu (R kare onceye/sonraya bakar): zoom, ihtiyac dogmadan once yumusakca baslasin diye.
  function slideMax(a, R) {
    var out = [], n = a.length, i, j, m;
    for (i = 0; i < n; i++) {
      m = -Infinity;
      for (j = Math.max(0, i - R); j <= Math.min(n - 1, i + R); j++) if (a[j] > m) m = a[j];
      out.push(m);
    }
    return out;
  }

  // Tracker'in kare basina sakladigi olcek (ilk kareye gore): 2x2 donusum blogu raw[9], raw[10], raw[12], raw[13].
  // Doner: kare basina boyut orani dizisi (ilk karelerin medyanina bolunmus) ya da veri yoksa null.
  function sizeSeries(points) {
    var n = points.length, sv = [], i, ok = 0;
    for (i = 0; i < n; i++) {
      var r = points[i].raw, v = 0, bn = points[i].bn;
      if (r && r.length > 13) { v = Math.sqrt(Math.abs(r[9] * r[13] - r[10] * r[12])); if (isFinite(v) && v > 1e-4) ok++; else v = 0; }
      else if (bn && bn[0] > 0 && bn[1] > 0) { v = Math.sqrt(bn[0] * bn[1]); ok++; }   // Object Mask: kutu boyutunun geometrik ortalamasi
      sv.push(v);
    }
    if (ok < n * 0.8) return null;
    var good = sv.filter(function (v) { return v > 0; });
    for (i = 0; i < n; i++) if (!sv[i]) sv[i] = good[0];
    var med = sv.map(function (_, k) { var w = []; for (var j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) w.push(sv[j]); return median(w); });   // sicramalari at
    var ref = median(med.slice(0, 5));
    return med.map(function (v) { return Math.max(0.05, v / ref); });
  }

  /* Dinamik zoom (Scale keyframe): her karede zoom hesaplanir ve kamera nesneye yetisir.
   *  - sizeTrack acikken zoom nesnenin boyutuna gore SUREKLI degisir: nesne kuculdukca (uzaklasinca) zoom artar, buyudukce azalir.
   *    Taban zoom = o.zoom * (1/oran)^guc. Guc (o.sizeStr, %) 100 = nesne ilk kareki boyutta kalir.
   *  - Kenara yaklasinca, kenarda bosluk kalmamasi icin gereken zoom da uygulanir (ikisinin buyugu; once yumusak yaklasim icin kayan maksimum).
   *  - Sonuc yumusatilir ve o.zoomMax ile sinirlanir. */
  function dynamicZooms(C, o, points) {
    var pin = o.pin || [0.5, 0.5], base = o.zoom || 150, n = C.length, edge = [], i, k;
    for (i = 0; i < n; i++) {
      var need = [1, 1];
      for (k = 0; k < 2; k++) {
        var c = C[i][k], p = pin[k];
        if (c > 1e-4) need[k] = Math.max(need[k], p / c);
        if (c < 1 - 1e-4) need[k] = Math.max(need[k], (1 - p) / (1 - c));
      }
      edge.push(Math.max(need[0] * o.seqW / o.srcW, need[1] * o.seqH / o.srcH) * 100 * 1.02);
    }
    var em = slideMax(edge, 24), sz = null, req = [];
    if (o.sizeTrack) {
      var ser = sizeSeries(points), str = (o.sizeStr === undefined ? 70 : o.sizeStr) / 100;
      if (ser) { sz = ser.map(function (r) { return Math.max(100, base * Math.pow(1 / r, str)); }); if (o.stats) o.stats.sizeTracked = true; }
      else if (o.stats) o.stats.sizeMissing = true;
    }
    for (i = 0; i < n; i++) req.push(Math.max(sz ? sz[i] : base, em[i]));
    var sm = smooth(req.map(function (z) { return [z, 0]; }), 12);
    var cap = Math.max(base, Math.min(1000, o.zoomMax || 1000));
    return sm.map(function (p) { return Math.min(cap, Math.ceil(p[0] * 10) / 10); });
  }

  // Tek degerli (zoom %) keyframe seyreltme: dogrusal interpolasyona gore, tol birimi degerin kendisi.
  function reduceScalar(list, tol, key) {
    if (!tol || tol <= 0 || list.length < 3) return list;
    var n = list.length, keep = [], i;
    for (i = 0; i < n; i++) keep.push(false);
    keep[0] = keep[n - 1] = true;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var sp = stack.pop(), a = sp[0], b = sp[1];
      if (b - a < 2) continue;
      var A = list[a], B = list[b], span = B.tl - A.tl, maxE = -1, mi = -1;
      for (i = a + 1; i < b; i++) {
        var t = span > 0 ? (list[i].tl - A.tl) / span : 0;
        var e = Math.abs(A[key] + (B[key] - A[key]) * t - list[i][key]);
        if (e > maxE) { maxE = e; mi = i; }
      }
      if (maxE > tol) { keep[mi] = true; stack.push([a, mi]); stack.push([mi, b]); }
    }
    return list.filter(function (_, idx) { return keep[idx]; });
  }

  /* Kadraj takibi (ayni klip): klip zoom'lanir, nesne kadrajin pin noktasinda kalir, kenar bosluklari olusmasin diye Position sinirlanir.
   * Mutlak hesap: onceki Position/Scale degerlerine bagli degil, tekrar uygulamak guvenli. C: temizlenmis merkezler.
   * o.dynZoom aciksa zoom her kare icin ayri hesaplanir (Scale de keyframe'lenir); kapaliysa o.zoom sabit. */
  function followPositions(points, o, A, C) {
    var zs = o.dynZoom ? dynamicZooms(C, o, points) : null;
    var pin = o.pin || [0.5, 0.5];
    var out = [], step = Math.max(1, o.step || 1);
    for (var i = 0; i < points.length; i++) {
      if (i % step !== 0 && i !== points.length - 1) continue;
      var zz = zs ? zs[i] : (o.zoom || 150), z = zz / 100;
      var wN = o.srcW * z / o.seqW, hN = o.srcH * z / o.seqH;
      var x = pin[0] - (C[i][0] - A[0]) * wN, y = pin[1] - (C[i][1] - A[1]) * hN;
      if (wN > 1) x = Math.min(A[0] * wN, Math.max(1 - (1 - A[0]) * wN, x));
      if (hN > 1) y = Math.min(A[1] * hN, Math.max(1 - (1 - A[1]) * hN, y));
      out.push({ tl: points[i].tl, x: x, y: y, z: zz });
    }
    return out;
  }

  /* Kenarda bosluk kalmamasi icin gereken en kucuk zoom (%). Kaynagin tum takip boyunca pin'e oturabilmesi icin. */
  function autoZoom(points, o) {
    var C = clean(points, o), pin = o.pin || [0.5, 0.5], need = [1, 1];
    for (var i = 0; i < C.length; i++) {
      for (var k = 0; k < 2; k++) {
        var c = C[i][k], p = pin[k];
        if (c > 1e-4) need[k] = Math.max(need[k], p / c);
        if (c < 1 - 1e-4) need[k] = Math.max(need[k], (1 - p) / (1 - c));
      }
    }
    var zx = need[0] * o.seqW / o.srcW * 100, zy = need[1] * o.seqH / o.srcH * 100;
    return Math.max(100, Math.ceil(Math.max(zx, zy) * 1.02));
  }

  /* opts: motion{pos,scale,anchor} (kaynak klip), srcW/srcH, seqW/seqH, mode, tgtPos [x,y], step, smooth, despike, deadzone, offset [px,px], tol (px), stats */
  function toPositions(points, o) {
    var m = o.motion, sy = (m.scale || 100) / 100, sx = (m.scaleW || m.scale || 100) / 100;   // Uniform Scale kapaliysa X ve Y olcegi ayri
    var P = [norm(m.pos[0], o.seqW), norm(m.pos[1], o.seqH)];
    var A = [norm(m.anchor[0], o.srcW), norm(m.anchor[1], o.srcH)];
    var C = clean(points, o), out = [], step = Math.max(1, o.step || 1), i;
    if (o.mode === 'follow') {
      out = followPositions(points, o, A, C);
    } else {
      var Q = C.map(function (c) {
        return [(P[0] * o.seqW + (c[0] - A[0]) * o.srcW * sx) / o.seqW, (P[1] * o.seqH + (c[1] - A[1]) * o.srcH * sy) / o.seqH];
      });
      // Yerlesim (yalniz Ustune tasi + nesne kutusu bilinen takipte): nesnenin ust/alt/sol/sag kenarina, kutu boyutuyla birlikte
      var BN = null, plc = (o.mode === 'snap' && o.place && o.place !== 'center') ? o.place : null;
      if (plc && points.every(function (p) { return p.bn && p.bn[0] > 0; })) BN = smooth(points.map(function (p) { return [p.bn[0], p.bn[1]]; }), o.smooth);
      // Boyut takibi (Ustune tasi / Takip et): hedefin Scale'i nesne boyutuyla birlikte degisir (ilk karedeki boyut = hedefin mevcut olcegi)
      var ZS = null, zb = Number(o.tgtScale) || 100;
      if (o.scaleTrack && (o.mode === 'snap' || o.mode === 'attach')) {
        var ser = sizeSeries(points);
        if (ser) {
          var sm = smooth(ser.map(function (r) { return [r, 0]; }), Math.max(o.smooth || 0, 6)).map(function (a) { return a[0]; }), r0 = sm[0], sg = Math.max(0, (o.scaleStr === undefined ? 100 : o.scaleStr)) / 100;
          ZS = sm.map(function (r) { var q = Math.min(2.5, Math.max(0.4, r / r0)); return Math.min(1000, Math.max(5, zb * Math.pow(q, sg))); });   // izleyici olcegi kayabilir: 0.4x-2.5x ile sinirla
          if (o.stats) o.stats.sizeTracked = true;
        } else if (o.stats) o.stats.sizeMissing = true;
      }
      // Donme takibi (yalniz Kendi takibim verisi: rot = radyan, ilk kareye gore). Derece olarak hedefin Rotation'una yazilir.
      var RS = null;
      if (o.rotTrack && (o.mode === 'snap' || o.mode === 'attach') && points.length > 2 && points.every(function (p) { return typeof p.rot === 'number'; })) {
        var rsm = smooth(points.map(function (p) { return [p.rot, 0]; }), Math.max(o.smooth || 0, 2)).map(function (a) { return a[0]; }), rr0 = rsm[0], rk = Math.max(0, (o.rotStr === undefined ? 100 : o.rotStr)) / 100;
        RS = rsm.map(function (v) { return (Number(o.tgtRot) || 0) + (v - rr0) * 180 / Math.PI * rk; });
        if (o.stats) o.stats.rotTracked = true;
      } else if (o.rotTrack && o.stats) o.stats.rotMissing = true;
      var zArr = [], rArr = [];
      var p0 = Q[0], T0 = [norm(o.tgtPos[0], o.seqW), norm(o.tgtPos[1], o.seqH)];
      var ox = (o.offset ? o.offset[0] : 0) / o.seqW, oy = (o.offset ? o.offset[1] : 0) / o.seqH;
      for (i = 0; i < points.length; i++) {
        if (i % step !== 0 && i !== points.length - 1) continue;
        var q = Q[i], dx = q[0] - p0[0], dy = q[1] - p0[1], x, y;
        if (o.mode === 'snap') {
          var vr = ZS ? ZS[i] / zb : 1;   // yazinin kendi konum farki olcekle birlikte buyur/kuculur
          x = q[0] + ox - (o.vis ? o.vis[0] * vr : 0); y = q[1] + oy - (o.vis ? o.vis[1] * vr : 0);
          if (BN) {
            var bw = BN[i][0] * o.srcW * sx / o.seqW, bh = BN[i][1] * o.srcH * sy / o.seqH, gx = (o.gap || 0) / o.seqW, gy = (o.gap || 0) / o.seqH;
            if (plc === 'top') y -= bh / 2 + gy; else if (plc === 'bottom') y += bh / 2 + gy;
            else if (plc === 'left') x -= bw / 2 + gx; else if (plc === 'right') x += bw / 2 + gx;
          }
        }   // vis: yazi klibinin kendi konum farki (yazi tam nesnenin ustune otursun)
        else if (o.mode === 'stabilize') { x = T0[0] - dx; y = T0[1] - dy; }
        else if (o.mode === 'center') { x = T0[0] + 0.5 - q[0]; y = T0[1] + 0.5 - q[1]; }
        else {
          x = T0[0] + dx + ox; y = T0[1] + dy + oy;
          if (ZS && o.vis) { var va = ZS[i] / zb - 1; x -= o.vis[0] * va; y -= o.vis[1] * va; }   // olceklenince yazi, kare merkezinden uzaklasip kaymasin
        }
        out.push({ tl: points[i].tl, x: x, y: y });
        if (ZS) zArr.push({ tl: points[i].tl, z: ZS[i] });
        if (RS) rArr.push({ tl: points[i].tl, z: RS[i] });
      }
    }
    var zAll = (o.mode === 'follow' && o.dynZoom) ? out.map(function (p) { return { tl: p.tl, z: p.z }; }) : (zArr && zArr.length ? zArr : null);
    var red = reduceKeys(out, o.tol, o.seqW, o.seqH);
    if (rArr && rArr.length) red.rAll = rArr;
    if (zAll) red.zAll = zAll;          // Scale keyframe'leri ayri seyreltilir (main.js)
    return red;
  }



  /* Onizleme verisi: her kare icin temizlenmis merkez (C), nesnenin sekans icindeki yeri (Q),
   * hedefin cikis konumu (out), kadraj takibinde nesnenin kadrajdaki yeri (S). Tum degerler normalize (0-1). */
  function previewData(points, o) {
    var m = o.motion, sy = (m.scale || 100) / 100, sx = (m.scaleW || m.scale || 100) / 100, o2 = {}, k, i;
    for (k in o) o2[k] = o[k];
    o2.tol = 0; o2.step = 1; o2.stats = {};
    var P = [norm(m.pos[0], o.seqW), norm(m.pos[1], o.seqH)], A = [norm(m.anchor[0], o.srcW), norm(m.anchor[1], o.srcH)];
    var C = clean(points, o2), out = toPositions(points, o2), z = (o.zoom || 150) / 100;
    var wNs = [], hNs = [], Q = [], S = [];
    for (i = 0; i < C.length; i++) {
      var zi = (out[i] && out[i].z) ? out[i].z / 100 : z;      // dinamik zoom: kare basina
      wNs.push(o.srcW * zi / o.seqW); hNs.push(o.srcH * zi / o.seqH);
      Q.push([(P[0] * o.seqW + (C[i][0] - A[0]) * o.srcW * sx) / o.seqW, (P[1] * o.seqH + (C[i][1] - A[1]) * o.srcH * sy) / o.seqH]);
      S.push([out[i].x + (C[i][0] - A[0]) * wNs[i], out[i].y + (C[i][1] - A[1]) * hNs[i]]);
    }
    return { C: C, Q: Q, S: S, out: out, A: A, P: P, wN: wNs[0], hN: hNs[0], wNs: wNs, hNs: hNs };
  }

  /* Teshis: secili klibin proje XML'inde hangi nesne/parametre/keyframe yapilari var, metin olarak dokerler. */
  function scan(xml, startTicks, name) {
    var idx = indexObjects(xml), L = [], seen = {};
    function firstText(body, tag) { var m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(body); return m ? m[1] : ''; }
    function floats(b64) {
      try {
        var buf = Buffer.from(b64, 'base64'), a = [];
        for (var i = 0; i + 4 <= buf.length && i < 24 * 4; i += 4) a.push(+buf.readFloatLE(i).toFixed(4));
        return buf.length + ' bayt: ' + a.join(' ');
      } catch (e) { return '?'; }
    }
    function dump(id, depth) {
      if (seen[id] || L.length > 600) return; seen[id] = 1;
      var o = idx[id]; if (!o) return;
      var pad = new Array(depth + 1).join('  ');
      var nm = firstText(o.body, 'Name') || firstText(o.body, 'n') || firstText(o.body, 'MatchName');
      var pid = firstText(o.body, 'ParameterID');
      var line = pad + o.tag + ' #' + id + (nm ? ' "' + nm + '"' : '') + (pid ? ' ParameterID=' + pid : '');
      var km = /<Keyframes[^>]*>([\s\S]*?)<\/Keyframes>/.exec(o.body);
      if (km) {
        var items = km[1].split(';').filter(function (x) { return x.trim(); });
        line += '  [Keyframes: ' + items.length + ' adet]';
        L.push(line);
        for (var k = 0; k < Math.min(2, items.length); k++) {
          var c = items[k].indexOf(',');
          L.push(pad + '    #' + k + ' t=' + items[k].substring(0, c) + ' -> ' + floats(items[k].substring(c + 1).trim()));
        }
      } else L.push(line);
      var tags = {}, m, re = /<(\w+)[ >]/g;
      while ((m = re.exec(o.body))) tags[m[1]] = (tags[m[1]] || 0) + 1;
      var keys = Object.keys(tags).filter(function (t) { return !/^(Name|n|ParameterID|Keyframes)$/.test(t); });
      if (keys.length) L.push(pad + '    alt etiketler: ' + keys.slice(0, 30).join(','));
      var r = /ObjectRef="(\d+)"/g, mm;
      while ((mm = r.exec(o.body))) dump(mm[1], depth + 1);
    }
    for (var id in idx) {
      var o = idx[id];
      if (o.tag !== 'VideoClipTrackItem') continue;
      var st = firstNum(o.body, 'Start', 0);
      if (Math.abs(st - startTicks) > 2000) continue;
      L.push('=== VideoClipTrackItem #' + id + ' Start=' + st);
      dump(id, 0);
    }
    // Genel: isminde Mask/Track/Object gecen nesne turleri
    var names = {}, re2 = /<(\w*(?:Mask|Track|Object|Roto)\w*) ObjectID="(\d+)"/gi, m2;
    while ((m2 = re2.exec(xml))) names[m2[1]] = (names[m2[1]] || 0) + 1;
    // Projedeki tum "Tracker" nesneleri ve yukari dogru baglanti zinciri
    L.push('');
    L.push('=== "Tracker" adli nesneler ve bagli olduklari zincir ===');
    var trs = trackerObjects(xml);
    L.push('Toplam: ' + trs.length);
    trs.slice(0, 20).forEach(function (t) {
      var km = /<Keyframes[^>]*>([\s\S]*?)<\/Keyframes>/.exec(t.body), items = km ? km[1].split(';').filter(function (x) { return x.trim(); }) : [];
      var l = t.tag + ' #' + t.id + ' ParameterID=' + firstText(t.body, 'ParameterID') + ' Keyframes=' + items.length;
      L.push(l);
      for (var k = 0; k < Math.min(3, items.length); k++) { var c = items[k].indexOf(','); L.push('    #' + k + ' t=' + items[k].substring(0, c) + ' -> ' + floats(items[k].substring(c + 1).trim())); }
      var chain = [], cur = t.id, guard = 0;
      while (cur && guard++ < 12) {
        var ps = parentsOf(xml, cur);
        if (!ps.length) break;
        var p = ps[0], extra = '';
        if (p.tag === 'VideoClipTrackItem') { var ob = idx[p.id] ? firstNum(idx[p.id].body, 'Start', 0) : null; extra = ' Start=' + ob + (ob !== null && Math.abs(ob - startTicks) <= 2000 ? ' (SECILI KLIP)' : ''); }
        chain.push(p.tag + ' #' + p.id + extra);
        if (p.tag === 'VideoClipTrackItem') break;
        cur = p.id;
      }
      L.push('    zincir: ' + (chain.length ? chain.join('  <-  ') : '(ust baglanti bulunamadi)'));
    });
    // Projedeki buyuk veri dugumleri: Object Mask gibi verinin baska yerde saklandigi durumlari bulmak icin
    L.push('');
    L.push('=== Buyuk veri dugumleri (>=400 karakter; en fazla 60) ===');
    var big = /<(\w+)(?:\s[^>]*)?>([A-Za-z0-9+\/=,;\s.\-]{400,})<\/\1>/g, bm, nb = 0;
    function strs(buf) {
      var out = [], cur = '';
      for (var i = 0; i < buf.length && out.length < 8; i++) {
        var ch = buf[i];
        if (ch >= 32 && ch < 127) cur += String.fromCharCode(ch);
        else { if (cur.length >= 8) out.push(cur.substring(0, 60)); cur = ''; }
      }
      if (cur.length >= 8 && out.length < 8) out.push(cur.substring(0, 60));
      return out;
    }
    while ((bm = big.exec(xml)) && nb < 60) {
      nb++;
      var enc = enclosing(xml, bm.index), txt = bm[2].replace(/\s+/g, '');
      L.push(bm[1] + ' uzunluk=' + txt.length + ' sahip=' + (enc ? enc.tag + '#' + enc.id : '?') + (enc && seen[enc.id] ? '  (KLIP ICINDE)' : ''));
      if (txt.indexOf(';') >= 0 || txt.indexOf(',') >= 0) {
        var its = txt.split(';');
        L.push('    liste: ' + its.length + ' oge, ilk oge ' + its[0].substring(0, 70));
      } else {
        try {
          var bf = Buffer.from(txt, 'base64'), fl = [];
          for (var q2 = 0; q2 + 4 <= bf.length && q2 < 16 * 4; q2 += 4) fl.push(+bf.readFloatLE(q2).toFixed(4));
          L.push('    ' + bf.length + ' bayt, ilk floatlar: ' + fl.join(' '));
          if (bf.length <= 1024) L.push('    tam hex (zaman başlangıcı / sürüm alanlarını aramak için): ' + bf.toString('hex').replace(/(.{8})/g, '$1 ').trim());
          var ss = strs(bf); if (ss.length) L.push('    okunabilir metinler: ' + ss.join(' | '));
        } catch (e) { L.push('    (cozulemedi)'); }
      }
    }
    if (!nb) L.push('(yok)');
    L.push('');
    L.push('=== Projede Mask/Track/Object iceren nesne turleri (tur: adet) ===');
    Object.keys(names).forEach(function (k) { L.push(k + ': ' + names[k]); });
    return L.join('\n');
  }

  /* ================= v1.9: Object Mask algilama / kalite yardimcilari ================= */
  var GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

  // StartKeyframeValue blobu (FlatBuffers) icinde GERCEK nesne verisi (liste ogesi / tek kare referansi) var mi?
  // Bos "yuva" (yalniz GUID, bos liste) her maskede bulunur; Object Mask degildir. Okunamazsa eski davranis (nesne say).
  function objBlobInfo(body) {
    var re = /<StartKeyframeValue[^>]*>([^<]+)<\/StartKeyframeValue>/g, m, any = false, data = false;
    while ((m = re.exec(body))) {
      var b = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
      if (!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(b.toString('latin1'))) continue;
      any = true;
      try {
        var root = b.readUInt32LE(0), vt = root - b.readInt32LE(root), vs = b.readUInt16LE(vt);
        var slot = function (i) { return (4 + i * 2 + 2 > vs) ? 0 : b.readUInt16LE(vt + 4 + i * 2); };
        var lst = slot(1), sg = slot(2), n = 0;
        if (lst) { var a = root + lst, v = a + b.readUInt32LE(a); n = b.readUInt32LE(v); }
        if (n > 0 || sg) data = true;
      } catch (e) { data = true; }
    }
    return { any: any, data: data };
  }
  function guidsOfBody(body) {
    var out = {}, list = [], re = /<StartKeyframeValue[^>]*>([^<]+)<\/StartKeyframeValue>/g, m;
    while ((m = re.exec(body))) {
      var txt = Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('latin1');
      (txt.match(GUID_RE) || []).forEach(function (x) { x = x.toLowerCase(); if (!out[x]) { out[x] = 1; list.push(x); } });
    }
    return list;
  }

  // Secili klibin timeline/kaynak zamanlamasi (findTracks.emit ile ayni hesap): {start,end,inP,outP,ratio} ya da null
  function clipTiming(xml, startTicks, name) {
    var idx = indexObjects(xml), best = null;
    for (var id in idx) {
      var o = idx[id];
      if (o.tag !== 'VideoClipTrackItem') continue;
      var s = firstNum(o.body, 'Start', 0);
      if (Math.abs(s - startTicks) > 2000) continue;
      var sc = /<SubClip ObjectRef="(\d+)"/.exec(o.body), nm = '';
      if (sc && idx[sc[1]]) { var n = /<(?:Name|n)>([^<]*)<\/(?:Name|n)>/.exec(idx[sc[1]].body); nm = n ? n[1] : ''; }
      var c = { id: id, o: o, sc: sc, nameMatch: name ? nm === name : true };
      if (!best || (c.nameMatch && !best.nameMatch)) best = c;
    }
    if (!best) return null;
    var start = firstNum(best.o.body, 'Start', 0), end = firstNum(best.o.body, 'End'), inP = null, outP = null;
    if (best.sc && idx[best.sc[1]]) {
      var cl = /<Clip ObjectRef="(\d+)"/.exec(idx[best.sc[1]].body);
      if (cl && idx[cl[1]]) { inP = firstNum(idx[cl[1]].body, 'InPoint', 0); outP = firstNum(idx[cl[1]].body, 'OutPoint'); }
    }
    if (start === null || end === null || inP === null || outP === null || outP === inP) return null;
    return { trackItemId: best.id, start: start, end: end, inP: inP, outP: outP, ratio: (end - start) / (outP - inP) };
  }

  // Disaridan gelen (kaynak-zamanli) kare listesini timeline noktalarina cevirir
  function mapSourcePoints(timing, kfs) {
    return kfs.map(function (k) { return { tl: (timing.start + (k.src - timing.inP) * timing.ratio) / TPS, cx: k.cx, cy: k.cy, raw: k.raw || [], bbox: k.bbox, bn: k.bn, rot: k.rot }; })
      .sort(function (a, b) { return a.tl - b.tl; });
  }

  // Bir nesnenin yukari dogru zinciri (en fazla 8 halka): "Etiket#id 'Ad'" metinleri. Maske turu icin KANIT toplar, tahmin etmez.
  function ancestry(xml, idx, id) {
    var out = [], cur = id, guard = 0;
    while (cur && guard++ < 8) {
      var ps = parentsOf(xml, cur); if (!ps.length) break;
      var p = ps[0], nm = '';
      if (idx[p.id]) { var m = /<(?:Name|n|MatchName)>([^<]*)<\/(?:Name|n|MatchName)>/.exec(idx[p.id].body); nm = m ? m[1] : ''; }
      out.push(p.tag + '#' + p.id + (nm ? " '" + nm + "'" : ''));
      cur = p.id;
    }
    return out;
  }

  /* Secili klibe bagli TUM "Tracker" parametreleri (keyframe'i olsun olmasin):
   * [{id, keyframes, guids[], ancestry[]}]. keyframes = proje icinde okunabilen kare sayisi. */
  function trackersForClip(xml, startTicks, name) {
    var idx = indexObjects(xml), cands = [], found = {}, res = [];
    for (var id in idx) {
      var o = idx[id];
      if (o.tag !== 'VideoClipTrackItem') continue;
      if (Math.abs(firstNum(o.body, 'Start', 0) - startTicks) > 2000) continue;
      var sc = /<SubClip ObjectRef="(\d+)"/.exec(o.body), nm = '';
      if (sc && idx[sc[1]]) { var n = /<(?:Name|n)>([^<]*)<\/(?:Name|n)>/.exec(idx[sc[1]].body); nm = n ? n[1] : ''; }
      cands.push({ id: id, o: o, nameMatch: name ? nm === name : true });
    }
    if (cands.some(function (c) { return c.nameMatch; })) cands = cands.filter(function (c) { return c.nameMatch; });
    function add(tid, body) {
      if (found[tid]) return; found[tid] = 1;
      var oi = objBlobInfo(body);
      res.push({ id: tid, keyframes: decodeKeyframes(body).length, guids: guidsOfBody(body), emptySlot: oi.any && !oi.data, ancestry: ancestry(xml, idx, tid) });
    }
    cands.forEach(function (c) {
      var seen = {}, re2 = /ObjectRef="(\d+)"/g, m2;
      while ((m2 = re2.exec(c.o.body))) (function walk(id3) {
        if (seen[id3]) return; seen[id3] = 1;
        var p = idx[id3]; if (!p) return;
        if (p.tag === 'ArbVideoComponentParam') { if (/<(?:Name|n)>Tracker<\/(?:Name|n)>/.test(p.body) && /<ParameterID>6<\/ParameterID>/.test(p.body)) add(id3, p.body); return; }
        if (!/Component|Chain|Mask|Group|Shape/.test(p.tag)) return;
        var r = /ObjectRef="(\d+)"/g, mm;
        while ((mm = r.exec(p.body))) walk(mm[1]);
      })(m2[1]);
    });
    if (cands.length) {
      var targets = {}; cands.forEach(function (c) { targets[c.id] = true; });
      trackerObjects(xml).forEach(function (t) { if (!found[t.id] && climbTo(xml, t.id, targets)) add(t.id, t.body); });
    }
    return res;
  }

  // Ham olcek serisi (medyan filtresiz): kare basina boyut orani, veri yoksa null
  function sizeRaw(points) {
    var n = points.length, sv = [], ok = 0, i;
    for (i = 0; i < n; i++) {
      var r = points[i].raw, v = 0;
      if (r && r.length > 13) { v = Math.sqrt(Math.abs(r[9] * r[13] - r[10] * r[12])); if (isFinite(v) && v > 1e-4) ok++; else v = 0; }
      sv.push(v);
    }
    if (ok < n * 0.8) return null;
    var ref = median(sv.filter(function (v) { return v > 0; }).slice(0, 5));
    return sv.map(function (v) { return v > 0 ? v / ref : 0; });
  }

  /* Takip kalitesi: sicrama, ani X/Y / olcek degisimi, mukerrer / cok yakin keyframe, bosluk, donma, kadraj disi.
   * Sadece olcer; veriyi degistirmez. Doner {level:'good'|'warn'|'bad', issues[], stats}. */
  function quality(points) {
    var n = points.length, issues = [], st = { frames: n, spikes: 0, jumps: 0, scaleJumps: 0, dupTime: 0, nearDup: 0, gaps: 0, frozen: 0, outside: 0 }, i;
    if (n < 3) return { level: 'bad', issues: ['Çok az keyframe (' + n + ')'], stats: st };
    var dts = [], ds = [];
    for (i = 1; i < n; i++) {
      dts.push(points[i].tl - points[i - 1].tl);
      ds.push(Math.hypot(points[i].cx - points[i - 1].cx, points[i].cy - points[i - 1].cy));
    }
    var mdt = median(dts.filter(function (d) { return d > 1e-6; }).concat([1 / 30])) || 1 / 30;
    dts.forEach(function (d) { if (d <= 1e-6) st.dupTime++; else if (d < mdt * 0.5) st.nearDup++; else if (d > mdt * 3.5) st.gaps++; });
    var md = median(ds), mad = median(ds.map(function (d) { return Math.abs(d - md); })) * 1.4826;
    var thr = Math.max(md + 8 * mad, 0.08);
    for (i = 0; i < ds.length; i++) {
      if (ds[i] <= thr) continue;
      var ret = i + 1 < ds.length && ds[i + 1] > thr && Math.hypot(points[i + 2 < n ? i + 2 : n - 1].cx - points[i].cx, points[i + 2 < n ? i + 2 : n - 1].cy - points[i].cy) < thr;
      if (ret) { st.spikes++; i++; } else st.jumps++;
    }
    var sr = sizeRaw(points);
    if (sr) for (i = 1; i < sr.length; i++) if (sr[i] > 0 && sr[i - 1] > 0 && Math.abs(sr[i] / sr[i - 1] - 1) > 0.25) st.scaleJumps++;
    var run = 1, best = 1;
    for (i = 1; i < n; i++) { if (points[i].cx === points[i - 1].cx && points[i].cy === points[i - 1].cy) { run++; if (run > best) best = run; } else run = 1; }
    st.frozen = best;
    for (i = 0; i < n; i++) if (points[i].cx < -0.02 || points[i].cx > 1.02 || points[i].cy < -0.02 || points[i].cy > 1.02) st.outside++;
    if (st.spikes) issues.push(st.spikes + ' tek karelik sıçrama');
    if (st.jumps) issues.push(st.jumps + ' ani X/Y değişimi');
    if (st.scaleJumps) issues.push(st.scaleJumps + ' ani ölçek değişimi');
    if (st.dupTime) issues.push(st.dupTime + ' mükerrer keyframe');
    if (st.nearDup > n * 0.05) issues.push(st.nearDup + ' birbirine çok yakın keyframe');
    if (st.gaps) issues.push(st.gaps + ' yerde takip boşluğu');
    if (st.frozen >= Math.max(8, n * 0.1)) issues.push('takip ' + st.frozen + ' kare boyunca donmuş (kayma / kopma şüphesi)');
    if (st.outside > n * 0.05) issues.push(st.outside + ' karede nesne kadraj dışında');
    var bad = st.spikes + st.jumps > Math.max(3, n * 0.03) || st.outside > n * 0.25 || st.frozen >= n * 0.25 || st.scaleJumps > Math.max(3, n * 0.03);
    return { level: bad ? 'bad' : (issues.length ? 'warn' : 'good'), issues: issues, stats: st };
  }

  var api = { TPS: TPS, findTracks: findTracks, toPositions: toPositions, scan: scan, processed: clean, autoZoom: autoZoom, reduceKeys: reduceKeys, reduceScalar: reduceScalar, guids: guidsFromTrackers, previewData: previewData,
    clipTiming: clipTiming, mapSourcePoints: mapSourcePoints, trackersForClip: trackersForClip, objBlobInfo: objBlobInfo, guidsOfBody: guidsOfBody, quality: quality, sizeRaw: sizeRaw,
    internals: { indexObjects: indexObjects, decodeKeyframes: decodeKeyframes, enclosing: enclosing, parentsOf: parentsOf, firstNum: firstNum } };
  root.MaskParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

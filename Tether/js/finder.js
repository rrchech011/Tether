/* Tether - Object Mask verisi disarida mi? GUID'leri Adobe klasorlerinde ve proje klasorunde arar.
 * Sadece okur. Siniri vardir (sure/dosya sayisi). */
(function (root) {
  var fs, path, os;
  try { fs = require('fs'); path = require('path'); os = require('os'); } catch (e) {}

  function defaultRoots(projectDir) {
    var r = [], h = os.homedir(), env = process.env;
    if (projectDir) r.push(projectDir);
    if (env.APPDATA) r.push(path.join(env.APPDATA, 'Adobe'));
    if (env.LOCALAPPDATA) r.push(path.join(env.LOCALAPPDATA, 'Adobe'));
    r.push(path.join(h, 'Documents', 'Adobe'));
    r.push(path.join(h, 'Library', 'Application Support', 'Adobe'));
    r.push(path.join(h, 'Library', 'Caches', 'Adobe'));
    return r.filter(function (d, i) { try { return r.indexOf(d) === i && fs.existsSync(d); } catch (e) { return false; } });
  }
  var tick = function () { return new Promise(function (r) { setImmediate(r); }); };

  /* opts: guids[], projectDir, roots[] (opsiyonel), maxMs, recentHours, maxDepth (klasor derinligi siniri), nameOnly (icerik aramasi yapma) */
  async function run(opts) {
    var t0 = Date.now(), maxMs = opts.maxMs || 30000, recentMs = (opts.recentHours || 24) * 3600 * 1000;
    var roots = opts.roots || defaultRoots(opts.projectDir), L = [];
    var needles = [];
    opts.guids.forEach(function (g) { g = g.toLowerCase(); needles.push(g, g.replace(/-/g, '')); });
    var nameHits = [], recent = [], scanned = 0, dirs = 0, stop = '';
    L.push('Aranan GUID: ' + opts.guids.join(', '));
    L.push('Taranan kokler: ' + (roots.length ? roots.join(' ; ') : '(yok)'));
    var q = roots.slice(), qd = roots.map(function () { return 0; }), maxDepth = opts.maxDepth || 99;
    while (q.length) {
      if (Date.now() - t0 > maxMs) { stop = 'sure siniri'; break; }
      if (scanned > 400000) { stop = 'dosya siniri'; break; }
      var d = q.shift(), depth = qd.shift(), ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      if (++dirs % 200 === 0) await tick();
      for (var i = 0; i < ents.length; i++) {
        var e = ents[i], full = path.join(d, e.name), low = e.name.toLowerCase();
        scanned++;
        for (var n = 0; n < needles.length; n++) if (low.indexOf(needles[n]) >= 0) { nameHits.push(full + (e.isDirectory() ? '  [KLASOR]' : '')); break; }
        if (e.isDirectory()) { if (depth < maxDepth) { q.push(full); qd.push(depth + 1); } continue; }
        if (opts.nameOnly) continue;   // yalniz ad aramasi: dosya basina stat maliyeti yok
        try {
          var st = fs.statSync(full);
          if (!opts.nameOnly && Date.now() - st.mtimeMs < recentMs) recent.push({ p: full, size: st.size, m: st.mtimeMs });
        } catch (e2) {}
      }
    }
    recent.sort(function (a, b) { return b.m - a.m; });
    // Yakin zamanli kucuk dosyalarin icinde GUID ara (ascii ve utf16)
    var contentHits = [], pats = [];
    needles.forEach(function (g) { pats.push(Buffer.from(g, 'latin1'), Buffer.from(g, 'utf16le')); });
    var cands = recent.filter(function (r) { return r.size > 0 && r.size < 8 * 1024 * 1024 && !/\.(pek|cfa|mp4|mov|mxf|wav|png|jpg)$/i.test(r.p); }).slice(0, 400);
    for (var c = 0; c < cands.length; c++) {
      if (Date.now() - t0 > maxMs + 15000) { stop = stop || 'icerik arama sure siniri'; break; }
      if (c % 20 === 0) await tick();
      try {
        var b = fs.readFileSync(cands[c].p);
        for (var k = 0; k < pats.length; k++) if (b.indexOf(pats[k]) >= 0) { contentHits.push(cands[c].p + ' (' + cands[c].size + ' bayt)'); break; }
      } catch (e3) {}
    }
    L.push('');
    L.push('Taranan dosya/klasor: ' + scanned + (stop ? ' (durdu: ' + stop + ')' : ''));
    L.push('');
    L.push('=== Adinda GUID gecen dosyalar/klasorler: ' + nameHits.length + ' ===');
    nameHits.slice(0, 50).forEach(function (x) { L.push(x); });
    L.push('');
    L.push('=== Icinde GUID gecen yakin zamanli dosyalar (son ' + (opts.recentHours || 24) + ' saat): ' + contentHits.length + ' ===');
    contentHits.slice(0, 50).forEach(function (x) { L.push(x); });
    L.push('');
    L.push('=== Son ' + (opts.recentHours || 24) + ' saatte yazilan dosyalar (en yeni 60) ===');
    recent.slice(0, 60).forEach(function (r) { L.push(new Date(r.m).toISOString().replace('T', ' ').substring(0, 19) + '  ' + r.size + ' bayt  ' + r.p); });
    return { text: L.join('\n'), nameHits: nameHits, contentHits: contentHits, scanned: scanned, stop: stop, roots: roots, ms: Date.now() - t0 };
  }

  var api = { run: run, defaultRoots: defaultRoots };
  root.MaskFinder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

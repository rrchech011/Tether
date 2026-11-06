/* Tether guncelleyici (v2.15, TEST). Surum denetimi, guvenli indirme, dogrulama, kurma, geri alma, acilis sagligi.
 * Ilkeler: hicbir hata paneli bozmaz (tum hatalar sonuc nesnesi olarak doner); kurulum icin kullanici onayi gerekir (otomatik YALNIZ denetim yapilir);
 * sha256 dogrulanamayan paket KURULMAZ; zip yol kacisi / bozuk paket / sozdizimi hatasi reddedilir; kurulum yarida kalirsa eski dosyalar geri yuklenir;
 * guncelleme sonrasi panel ilk acilista "saglikli" isaretlenmezse bir sonraki acilista otomatik geri alinir.
 * Bagimliliklar (fs, path, os, crypto, zlib, vm, transport) disaridan verilebilir -> Node'da test edilir. */
(function (root) {
  'use strict';
  var DEF_REPO = 'rrchech011/Tether';
  var LIM = { maxZip: 60 * 1024 * 1024, maxFile: 40 * 1024 * 1024, maxTotal: 90 * 1024 * 1024, maxEntries: 600, ratio: 200, apiTimeout: 12000, dlTimeout: 60000, redirects: 5 };
  var REQUIRED = ['CSXS/manifest.xml', 'index.html', 'js/main.js', 'js/track.js', 'js/updater.js'];

  function mod(name) { try { return require(name); } catch (e) { return null; } }

  /* ---------- surum ---------- */
  function parseVer(s) { var m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/.exec(String(s || '').trim()); return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null; }
  function cmpVer(a, b) {   // -1, 0, 1; gecersiz -> null. On ek (pre) varsa ayni numarali duz surumden DUSUK
    var x = parseVer(a), y = parseVer(b), i; if (!x || !y) return null;
    for (i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
    if (x.pre === y.pre) return 0; if (!x.pre) return 1; if (!y.pre) return -1; return x.pre < y.pre ? -1 : 1;
  }

  /* ---------- crc32 ---------- */
  var CRC = null;
  function crc32(buf) {
    if (!CRC) { CRC = new Int32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c; } }
    var crc = -1; for (var i = 0; i < buf.length; i++) crc = CRC[(crc ^ buf[i]) & 255] ^ (crc >>> 8); return (crc ^ -1) >>> 0;
  }

  /* ---------- zip okuyucu (stored + deflate; zip64 / sifreli reddedilir) ---------- */
  function safeName(raw) {
    var n = String(raw).replace(/\\/g, '/');
    if (n.indexOf('\0') >= 0 || /^\//.test(n) || /^[A-Za-z]:/.test(n)) return null;
    var parts = n.split('/'), i; for (i = 0; i < parts.length; i++) { if (parts[i] === '..') return null; }
    return n;
  }
  function readZip(buf, zlib) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('zip çok küçük / bozuk');
    var eocd = -1, i; for (i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip sonu bulunamadı (bozuk dosya)');
    var total = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOff = buf.readUInt32LE(eocd + 16);
    if (total === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('zip64 desteklenmiyor');
    if (total > LIM.maxEntries) throw new Error('zip çok fazla dosya içeriyor');
    if (cdOff + cdSize > buf.length) throw new Error('zip dizini bozuk');
    var p = cdOff, out = [], sumU = 0;
    for (i = 0; i < total; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip dizin girdisi bozuk');
      var flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), cs = buf.readUInt32LE(p + 20), us = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
      var name = buf.toString((flags & 0x800) ? 'utf8' : 'latin1', p + 46, p + 46 + nl); p += 46 + nl + el + cl;
      if (flags & 1) throw new Error('şifreli zip desteklenmiyor');
      var sn = safeName(name); if (sn === null) throw new Error('güvensiz dosya yolu: ' + name);
      if (/\/$/.test(sn)) continue;   // klasor girdisi
      if (us > LIM.maxFile) throw new Error('dosya çok büyük: ' + sn); sumU += us; if (sumU > LIM.maxTotal) throw new Error('paket çok büyük');
      if (cs > 0 && us / cs > LIM.ratio) throw new Error('şüpheli sıkıştırma oranı: ' + sn);
      out.push({ name: sn, method: method, crc: crc, cs: cs, us: us, lo: lo });
    }
    return out.map(function (e) {
      return { name: e.name, data: function () {
        var o = e.lo; if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('yerel başlık bozuk: ' + e.name);
        var nl2 = buf.readUInt16LE(o + 26), el2 = buf.readUInt16LE(o + 28), s = o + 30 + nl2 + el2, raw = buf.slice(s, s + e.cs), d;
        if (raw.length !== e.cs) throw new Error('veri eksik: ' + e.name);
        if (e.method === 0) d = raw; else if (e.method === 8) d = zlib.inflateRawSync(raw, { maxOutputLength: e.us + 1 }); else throw new Error('sıkıştırma yöntemi desteklenmiyor: ' + e.name);
        if (d.length !== e.us) throw new Error('boyut uyuşmuyor: ' + e.name);
        if (crc32(d) !== e.crc) throw new Error('CRC hatası: ' + e.name);
        return d;
      } };
    });
  }

  /* ---------- varsayilan ag katmani (https; yonlendirmeyi cagiran izler) ---------- */
  function defaultTransport(opts) {
    var https = mod('https'), http = mod('http');
    return function (url, o) {
      return new Promise(function (resolve, reject) {
        var u; try { u = new URL(url); } catch (e) { return reject(new Error('geçersiz adres')); }
        var lib = u.protocol === 'https:' ? https : ((opts && opts.allowHttp && u.protocol === 'http:') ? http : null);
        if (!lib) return reject(new Error('yalnız https'));
        var done = false, chunks = [], got = 0, req = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: Object.assign({ 'User-Agent': 'Tether-Updater', 'Accept': '*/*' }, (o && o.headers) || {}) }, function (res) {
          var st = res.statusCode, hd = res.headers || {};
          if (st >= 300 && st < 400) { res.resume(); done = true; return resolve({ status: st, headers: hd, body: Buffer.alloc(0) }); }
          var total = Number(hd['content-length'] || 0);
          if (o && o.maxBytes && total > o.maxBytes) { res.destroy(); done = true; return reject(new Error('dosya çok büyük')); }
          res.on('data', function (c) { got += c.length; if (o && o.maxBytes && got > o.maxBytes) { res.destroy(); if (!done) { done = true; reject(new Error('dosya çok büyük')); } return; } chunks.push(c); if (o && o.onProgress) { try { o.onProgress(got, total); } catch (e) {} } });
          res.on('end', function () { if (!done) { done = true; resolve({ status: st, headers: hd, body: Buffer.concat(chunks) }); } });
          res.on('error', function (e) { if (!done) { done = true; reject(e); } });
        });
        req.setTimeout((o && o.timeoutMs) || 15000, function () { req.destroy(new Error('zaman aşımı')); });
        req.on('error', function (e) { if (!done) { done = true; reject(e); } });
      });
    };
  }

  function create(deps) {
    deps = deps || {};
    var fs = deps.fs || mod('fs'), path = deps.path || mod('path'), os = deps.os || mod('os'), crypto = deps.crypto || mod('crypto'), zlib = deps.zlib || mod('zlib'), vm = deps.vm || mod('vm');
    var repo = deps.repo || DEF_REPO, transport = deps.transport || defaultTransport({ allowHttp: !!deps.allowHttp });
    var allow = deps.allowHosts || ['api.github.com', 'github.com'], now = deps.now || function () { return Date.now(); };
    var stateDir = deps.stateDir || (os && path ? path.join(os.homedir(), '.tether', 'updater') : null);
    var apiBase = deps.apiBase || 'https://api.github.com';
    var GH_CDN = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'];
    function hostOk(h) { h = String(h || '').toLowerCase(); return allow.indexOf(h) >= 0 || GH_CDN.indexOf(h) >= 0; }

    function mkdirp(d) { if (fs.existsSync(d)) return; mkdirp(path.dirname(d)); try { fs.mkdirSync(d); } catch (e) { if (!fs.existsSync(d)) throw e; } }   // eski Node (CEP 9) icin recursive secenegi kullanilmaz
    /* ---- durum dosyasi ---- */
    function statePath() { return stateDir ? path.join(stateDir, 'state.json') : null; }
    function readState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch (e) { return {}; } }
    function writeState(s) { try { mkdirp(stateDir); var tmp = statePath() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, statePath()); return true; } catch (e) { return false; } }
    function patchState(p) { var s = readState(); Object.keys(p).forEach(function (k) { if (p[k] === null) delete s[k]; else s[k] = p[k]; }); writeState(s); return s; }

    /* ---- ag: yonlendirme + izinli ana makineler ---- */
    async function fetchFollow(url, o) {
      var cur = url, hops = 0, r;
      for (;;) {
        var u; try { u = new URL(cur); } catch (e) { throw coded('URL', 'geçersiz adres'); }
        if (u.protocol !== 'https:' && !(deps.allowHttp && u.protocol === 'http:')) throw coded('SCHEME', 'yalnız https adreslerine izin var');
        if (!deps.allowAnyHost && !hostOk(u.hostname)) throw coded('HOST', 'izin verilmeyen sunucu: ' + u.hostname);
        r = await transport(cur, o);
        if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) { if (++hops > LIM.redirects) throw coded('REDIRECT', 'çok fazla yönlendirme'); cur = new URL(r.headers.location, cur).toString(); continue; }
        return r;
      }
    }
    function coded(code, msg) { var e = new Error(msg); e.code = code; return e; }
    function errRes(e) { var code = e && e.code || 'NET', m = e && e.message || String(e); if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || /zaman aşımı|ENOTFOUND|getaddrinfo/.test(m)) { return { state: 'error', code: 'OFFLINE', message: 'Sunucuya ulaşılamadı (internet yok ya da zaman aşımı): ' + m }; } return { state: 'error', code: code, message: m }; }

    /* ---- denetim ---- */
    async function checkLatest(current) {
      try {
        if (!parseVer(current)) return { state: 'error', code: 'VERSION', message: 'Mevcut sürüm anlaşılamadı: ' + current };
        var r = await fetchFollow(apiBase + '/repos/' + repo + '/releases/latest', { timeoutMs: deps.apiTimeoutMs || LIM.apiTimeout, maxBytes: 2 * 1024 * 1024, headers: { 'Accept': 'application/vnd.github+json' } });
        if (r.status === 404) return { state: 'error', code: 'NO_RELEASE', message: 'Yayınlanmış sürüm bulunamadı.' };
        if (r.status === 403 || r.status === 429) return { state: 'error', code: 'RATE', message: 'GitHub istek sınırı doldu; biraz sonra tekrar dene.' };
        if (r.status !== 200) return { state: 'error', code: 'HTTP', message: 'GitHub ' + r.status + ' döndürdü.' };
        var j; try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { return { state: 'error', code: 'JSON', message: 'Sürüm bilgisi okunamadı (bozuk yanıt).' }; }
        if (!j || typeof j !== 'object' || typeof j.tag_name !== 'string') return { state: 'error', code: 'JSON', message: 'Sürüm bilgisi eksik.' };
        if (j.draft || j.prerelease) return { state: 'uptodate', current: current, latest: current, note: 'son sürüm ön sürüm; yok sayıldı' };
        var latest = j.tag_name.replace(/^v/i, ''), c = cmpVer(latest, current);
        if (c === null) return { state: 'error', code: 'VERSION', message: 'Yayın etiketi anlaşılamadı: ' + j.tag_name };
        var base = { current: current, latest: latest, htmlUrl: typeof j.html_url === 'string' ? j.html_url : null, notes: String(j.body || '').slice(0, 1500), checkedAt: now() };
        patchState({ lastCheck: base.checkedAt, lastLatest: latest });
        if (c <= 0) return Object.assign({ state: 'uptodate' }, base);
        var assets = Array.isArray(j.assets) ? j.assets : [], a = null, k;
        for (k = 0; k < assets.length; k++) { var nm = String(assets[k].name || ''); if (/^tether.*\.zip$/i.test(nm) && !/source/i.test(nm) && typeof assets[k].browser_download_url === 'string') { a = assets[k]; break; } }
        if (!a) return Object.assign({ state: 'available', canInstall: false, reason: 'Sürümde Tether .zip paketi yok.' }, base);
        var sha = null, dg = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
        if (dg) sha = dg[1].toLowerCase(); else { var bm = /sha-?256[^\n]{0,80}?([0-9a-f]{64})/i.exec(String(j.body || '')); if (bm) sha = bm[1].toLowerCase(); }
        var info = Object.assign({ state: 'available', asset: { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0 }, sha256: sha }, base);
        if (!sha) { info.canInstall = false; info.reason = 'Sürümde sha256 sağlama toplamı yok; güvenli kurulum yapılamaz. Sürüm sayfasından elle indir.'; } else info.canInstall = true;
        return info;
      } catch (e) { return errRes(e); }
    }

    /* ---- paket dogrulama ---- */
    function inspectPackage(buf, expectVer) {
      var ents = readZip(buf, zlib), map = {}, i, rel = [];
      ents.forEach(function (e) { if (e.name.indexOf('Tether/') !== 0) return;   /* paket kokundeki kur.bat / OKU.txt gibi dosyalar KURULMAZ, yok sayilir; yalniz Tether/ altindakiler yazilir (tehlikeli yollar readZip'te reddedilir) */ var r = e.name.slice(7); if (!r) return; map[r] = e; rel.push(r); });
      REQUIRED.forEach(function (f) { if (!map[f]) throw new Error('pakette gerekli dosya yok: ' + f); });
      var man = map['CSXS/manifest.xml'].data().toString('utf8'), mv = /ExtensionBundleVersion="([^"]+)"/.exec(man), mj = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(map['js/main.js'].data().toString('utf8'));
      if (!mv || !mj) throw new Error('paket sürümü okunamadı');
      if (mv[1] !== expectVer || mj[1] !== expectVer) throw new Error('paket sürümü yayın etiketiyle uyuşmuyor (manifest ' + mv[1] + ', main.js ' + mj[1] + ', yayın ' + expectVer + ')');
      var files = {};
      rel.forEach(function (r) { var d = map[r].data(); if (/\.js$/.test(r)) { try { new vm.Script(d.toString('utf8'), { filename: r }); } catch (e) { throw new Error('JS sözdizimi hatası (' + r + '): ' + (e && e.message)); } } files[r] = d; });
      return files;
    }

    /* ---- indir + dogrula ---- */
    async function downloadAndVerify(info, onProgress) {
      try {
        if (!info || info.state !== 'available' || !info.canInstall || !info.asset || !info.sha256) return { ok: false, code: 'NOT_INSTALLABLE', message: (info && info.reason) || 'Kurulabilir paket yok.' };
        var r = await fetchFollow(info.asset.url, { timeoutMs: LIM.dlTimeout, maxBytes: LIM.maxZip, onProgress: onProgress });
        if (r.status !== 200) return { ok: false, code: 'HTTP', message: 'İndirme başarısız (HTTP ' + r.status + ').' };
        var h = crypto.createHash('sha256').update(r.body).digest('hex');
        if (h !== info.sha256) return { ok: false, code: 'HASH', message: 'Sağlama toplamı (sha256) uyuşmuyor; paket reddedildi.' };
        var files = inspectPackage(r.body, info.latest);
        try { mkdirp(path.join(stateDir, 'downloads')); fs.writeFileSync(path.join(stateDir, 'downloads', path.basename(String(info.asset.name))), r.body); } catch (e) {}
        return { ok: true, files: files, bytes: r.body.length, sha256: h };
      } catch (e) { var x = errRes(e); return { ok: false, code: x.code, message: x.message }; }
    }

    /* ---- kur: yalnizca paketteki dosyalarin ustune yazar (ffmpeg.exe vb. korunur); once yedek ---- */
    function install(files, extDir, from, to) {
      var pst = readState().status;
      if (pst === 'applied' || pst === 'installing') return { ok: false, code: 'PENDING', message: 'Önceki güncelleme henüz doğrulanmadı; Premiere\'i yeniden başlatıp paneli aç, sonra tekrar dene.' };
      var written = [], created = [], backupDir = path.join(stateDir, 'backup_' + from), rels = Object.keys(files), i;
      function rm(p) { try { fs.unlinkSync(p); } catch (e) {} }
      try {
        if (!fs.existsSync(path.join(extDir, 'index.html'))) throw new Error('eklenti klasörü doğrulanamadı: ' + extDir);
        try { rmTree(backupDir); } catch (e) {}
        mkdirp(backupDir);
        var manifest = [];
        for (i = 0; i < rels.length; i++) { var dst = path.join(extDir, rels[i]); if (!fs.existsSync(dst)) created.push(rels[i]); if (fs.existsSync(dst)) { var bp = path.join(backupDir, rels[i]); mkdirp(path.dirname(bp)); fs.copyFileSync(dst, bp); manifest.push(rels[i]); } }
        writeState(Object.assign(readState(), { status: 'installing', from: from, to: to, backup: backupDir, backedUp: manifest, created: created.slice(), extDir: extDir, bootCount: 0, startedAt: now(), notified: false }));
        for (i = 0; i < rels.length; i++) {
          var d = path.join(extDir, rels[i]); mkdirp(path.dirname(d));
          var tmp = d + '.tetherupd'; fs.writeFileSync(tmp, files[rels[i]]); fs.renameSync(tmp, d);
          if (typeof deps.afterWrite === 'function') deps.afterWrite(rels[i], i);   // test kancasi (yari kalan kurulum)
          written.push(rels[i]);
        }
        patchState({ status: 'applied', bootCount: 0, appliedAt: now() });
        return { ok: true, written: written.length, backupDir: backupDir };
      } catch (e) {
        var rb = restore(extDir, backupDir, rels, created);
        rels.forEach(function (r) { try { fs.unlinkSync(path.join(extDir, r) + '.tetherupd'); } catch (e2) {} });
        patchState({ status: 'failed', error: String(e && e.message || e) });
        return { ok: false, code: 'INSTALL', message: 'Kurulum yarıda kaldı, ' + (rb ? 'eski dosyalar geri yüklendi' : 'GERİ YÜKLEME HATALI (eklentiyi kur.bat ile yeniden kur)') + ': ' + (e && e.message || e) };
      }
    }
    function rmTree(p) { if (!fs.existsSync(p)) return; fs.readdirSync(p).forEach(function (n) { var q = path.join(p, n); if (fs.statSync(q).isDirectory()) rmTree(q); else fs.unlinkSync(q); }); fs.rmdirSync(p); }
    function safeRel(r) { r = String(r); return !(/(^|[\\/])\.\.([\\/]|$)/.test(r) || /^[\\/]/.test(r) || /^[A-Za-z]:/.test(r) || r.indexOf('\0') >= 0); }
    function restore(extDir, backupDir, rels, newFiles) {
      var ok = true, i; rels = rels.filter(safeRel); newFiles = (newFiles || []).filter(safeRel);
      for (i = 0; i < rels.length; i++) { var bp = path.join(backupDir, rels[i]); try { if (fs.existsSync(bp)) fs.copyFileSync(bp, path.join(extDir, rels[i])); } catch (e) { ok = false; } }
      (newFiles || []).forEach(function (r) { try { fs.unlinkSync(path.join(extDir, r)); } catch (e) {} });
      return ok;
    }
    function rollback() {   // state.json'daki son kurulumu geri al
      var s = readState(); if (!s.backup || !s.extDir || !fs.existsSync(s.backup)) return { ok: false, message: 'geri alınacak yedek yok' };
      var rels = []; (function walk(d, pre) { fs.readdirSync(d).forEach(function (n) { var q = path.join(d, n); if (fs.statSync(q).isDirectory()) walk(q, pre + n + '/'); else rels.push(pre + n); }); })(s.backup, '');
      var ok = restore(s.extDir, s.backup, rels, s.created || []);
      patchState({ status: ok ? 'rolledback' : 'rollback_failed', rolledBackAt: now(), bootCount: null });
      return { ok: ok, message: ok ? 'önceki sürüme dönüldü (' + s.from + ')' : 'geri alma hatalı' };
    }

    /* ---- acilis sagligi ---- */
    function boot() {   // panel acilirken (main.js'ten ONCE) cagrilir
      try {
        var s = readState();
        if (s.status === 'installing') { var r0 = rollback(); return { action: 'rolledback', message: 'Önceki güncelleme yarıda kalmıştı; ' + r0.message + '. Paneli kapatıp yeniden aç.', ok: r0.ok }; }
        if (s.status === 'applied') {
          var c = (s.bootCount || 0) + 1;
          if (c >= 2) { var r = rollback(); return { action: 'rolledback', message: 'Güncelleme sonrası panel sağlıklı açılmadı; ' + r.message + '. Paneli kapatıp yeniden aç.', ok: r.ok }; }
          patchState({ bootCount: c }); return { action: 'pending' };
        }
        if (s.status === 'rolledback' && !s.notified) { patchState({ notified: true }); return { action: 'notice', message: 'Önceki güncelleme başarısız olduğu için ' + (s.from || 'önceki') + ' sürümüne dönüldü.' }; }
        return { action: 'none' };
      } catch (e) { return { action: 'none', error: String(e && e.message || e) }; }
    }
    function markHealthy() { try { var s = readState(); if (s.status === 'applied') { patchState({ status: 'ok', bootCount: null, healthyAt: now() }); return true; } } catch (e) {} return false; }
    function shouldAutoCheck(hours) { var s = readState(); if (s.autoCheck === false) return false; return !s.lastCheck || (now() - s.lastCheck) > (hours || 24) * 3600 * 1000; }
    function setAutoCheck(v) { patchState({ autoCheck: !!v }); }

    return { checkLatest: checkLatest, downloadAndVerify: downloadAndVerify, install: install, rollback: rollback, boot: boot, markHealthy: markHealthy, shouldAutoCheck: shouldAutoCheck, setAutoCheck: setAutoCheck, readState: readState, _inspect: inspectPackage, _fetch: fetchFollow };
  }

  var api = { create: create, cmpVer: cmpVer, parseVer: parseVer, readZip: readZip, crc32: crc32, LIM: LIM, REQUIRED: REQUIRED };
  root.TetherUpdater = api;
  // Panelde: acilis sagligi kontrolu main.js'ten ONCE ve ondan bagimsiz calisir (main.js bozuksa da geri alma tetiklenir).
  if (typeof window !== 'undefined' && !window.__TETHER_NO_AUTOBOOT) { try { window.TetherUpdaterBoot = create().boot(); var b0 = window.TetherUpdaterBoot; if (b0 && b0.action === 'rolledback' && b0.ok && !window.__tetherReloaded) { window.__tetherReloaded = true; try { location.reload(); } catch (e2) {} } } catch (e) { window.TetherUpdaterBoot = { action: 'none', error: String(e) }; } }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

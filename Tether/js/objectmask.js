/* Tether v1.9 - Object Mask katmani.
 * Akis:  Detector (projede ne var?) -> Reader (veri dosyasi nerede?) -> Parser (formati TANIYORSA coz)
 *        -> normalize nokta listesi {tl, cx, cy, raw} -> mevcut Tether hatti (smooth / despike / deadzone / zoom).
 * KURAL: Format varsayilmaz. Taninmayan dosya cozulmez; yalnizca teshis raporu uretilir. Hicbir yerde tahmini / uydurma nokta uretilmez.
 * Adobe Object Mask verisini acarsa yalnizca ObjectMaskParser.register() ile yeni bir cozucu eklemek yeter. */
(function (root) {
  var fs, path, os, zlib;
  try { fs = require('fs'); path = require('path'); os = require('os'); zlib = require('zlib'); } catch (e) {}
  var MP = function () { return root.MaskParser; };
  var MF = function () { return root.MaskFinder; };
  var TPS = 254016000000;
  var CACHE_KEY = 'tether_om_cache_v1', NEG_TTL = 10 * 60 * 1000;

  /* ====================== Hata siniflari ====================== */
  var ERR = {
    NO_SEQUENCE: { title: 'Aktif sequence yok', hint: 'Bir sequence açıp timeline\'a tıkla.' },
    NO_CLIP: { title: 'Klip seçilmedi', hint: 'Timeline\'da bir video klibi seç.' },
    PROJECT_NOT_SAVED: { title: 'Proje kaydedilmemiş', hint: 'Önce Ctrl+S ile projeyi kaydet.' },
    PROJECT_READ: { title: 'Proje dosyası okunamadı', hint: 'Dosya kilitli ya da bozuk olabilir.' },
    NODE_MISSING: { title: 'Node.js erişimi yok', hint: 'Panel yanlış kurulmuş olabilir; kur.bat ile yeniden kur.' },
    NO_MASK: { title: 'Maske bulunamadı', hint: 'Effect Controls > Opacity altından bir maske çiz ve Tracker ile takip ettir.' },
    MASK_UNTRACKED: { title: 'Maske var ama takip edilmemiş', hint: 'Maskeyi Tracker ile (ileri) takip ettir.' },
    OM_NO_DATA: { title: 'Object Mask algılandı ama takip verisine erişilemiyor', hint: 'Veri projede değil. Aynı nesne için Ellipse ya da Pen maske çizip Tracker ile takip ettir.' },
    OM_FILE_NOT_FOUND: { title: 'Object Mask veri dosyası bulunamadı', hint: 'Araçlar > "Object Mask verisini ara" derin aramayı çalıştırır.' },
    OM_UNSUPPORTED_FORMAT: { title: 'Object Mask dosya biçimi desteklenmiyor', hint: 'Dosya bulundu ama biçimi tanınmadı. Raporu gönderirsen çözücü yazılabilir.' },
    API_LIMIT: { title: 'Premiere API sınırı', hint: 'Bu Premiere sürümü istenen bilgiyi betik arayüzünden vermiyor.' },
    PARSER_ERROR: { title: 'Ayrıştırma hatası', hint: 'Ayrıntı için "Details" bölümüne bak.' }
  };
  function classify(msg) {
    var m = String(msg || '');
    if (/sequence yok/i.test(m)) return 'NO_SEQUENCE';
    if (/video klibi/i.test(m)) return 'NO_CLIP';
    if (/kaydedilmemi/i.test(m)) return 'PROJECT_NOT_SAVED';
    if (/Node\.js/i.test(m)) return 'NODE_MISSING';
    if (/okunamad|ENOENT|EBUSY|EPERM|incorrect header|gunzip/i.test(m)) return 'PROJECT_READ';
    return 'PARSER_ERROR';
  }
  function makeErr(code, detail) { var e = ERR[code] || ERR.PARSER_ERROR; return { code: code, title: e.title, hint: e.hint, detail: detail ? String(detail) : '' }; }

  /* ====================== Detector ====================== */
  /* Proje XML'inden secili klibin maskelerini siniflandirir. Maske TURU (Pen/Ellipse) yalnizca XML'de KANIT varsa soylenir.
   * api: ppDiag() sonucu (opsiyonel; yalniz ek kanit / sinir bilgisi). */
  function shapeEvidence(anc) {
    var t = anc.join(' | ');
    if (/ellips/i.test(t)) return 'Ellipse';
    if (/bezier|\bpen\b|polygon/i.test(t)) return 'Pen';
    return null;
  }
  function detect(xml, startTicks, name, api) {
    var res = { state: 'none', masks: [], guids: [], keyframeCount: 0, lines: [], api: api || null, objectUnreadable: false };
    var trs = [];
    try { trs = MP().trackersForClip(xml, Number(startTicks), name); } catch (e) { res.error = makeErr('PARSER_ERROR', e && e.stack || e); }
    var guidSeen = {};
    trs.forEach(function (t) {
      var isObj = t.guids.length > 0 && !t.emptySlot, kind = isObj ? 'object' : (t.emptySlot ? 'slot' : (t.keyframes > 0 ? 'normal' : 'untracked'));   // slot = her maskede bulunan bos Object Mask yuvasi
      var m = { trackerId: t.id, kind: kind, keyframes: t.keyframes, guids: t.guids, shape: isObj ? null : shapeEvidence(t.ancestry), ancestry: t.ancestry };
      res.masks.push(m);
      if (!t.emptySlot) t.guids.forEach(function (g) { if (!guidSeen[g]) { guidSeen[g] = 1; res.guids.push(g); } });
    });
    var normal = res.masks.filter(function (m) { return m.kind === 'normal'; });
    var objOk = res.masks.filter(function (m) { return m.kind === 'object' && m.keyframes > 0; });
    var objNo = res.masks.filter(function (m) { return m.kind === 'object' && m.keyframes === 0; });
    var untr = res.masks.filter(function (m) { return m.kind === 'untracked'; });
    res.objectUnreadable = objNo.length > 0;
    res.keyframeCount = res.masks.reduce(function (a, m) { return Math.max(a, m.keyframes); }, 0);
    normal.forEach(function (m) { res.lines.push({ level: 'ok', text: (m.shape ? m.shape + ' Mask' : 'Maske') + ' — ' + m.keyframes + ' keyframe' }); });
    objOk.forEach(function (m) { res.lines.push({ level: 'ok', text: 'Object Mask — ' + m.keyframes + ' keyframe (projede)' }); });
    objNo.forEach(function (m) { res.lines.push({ level: 'warn', text: 'Object Mask — algılandı; takip verisi projede yok (' + m.guids.length + ' GUID referansı)' }); });
    res.untrackedCount = untr.length; res.emptySlots = res.masks.filter(function (m) { return m.kind === 'slot'; }).length;
    // Takipli bir maske varsa takipsiz maskeler / bos yuvalar uyari degildir (kullanilmayan maske); yalniz hic takip yoksa uyar
    if (!normal.length && !objOk.length && !objNo.length) untr.forEach(function (m) { res.lines.push({ level: 'warn', text: 'Maske — takip edilmemiş (keyframe yok)' }); });
    if (objOk.length) res.state = 'object-ok'; else if (normal.length) res.state = 'normal'; else if (objNo.length) res.state = 'object-nodata'; else if (untr.length) res.state = 'untracked'; else res.state = 'none';
    if (res.state === 'none') {
      res.lines.push({ level: 'err', text: 'Maske algılanmadı' });
      if (api && api.ok && api.hasObjectMaskName) { res.lines.push({ level: 'warn', text: 'Premiere API bileşen adlarında "Object Mask" geçiyor ama projede bağlı Tracker bulunamadı' }); }
    }
    if (api && api.limits && api.limits.length) res.lines.push({ level: 'warn', text: 'Premiere API sınırı: ' + api.limits.slice(0, 2).join('; ') });
    if (api && api.ok === false && api.err && !/sequence|klip/i.test(api.err)) res.lines.push({ level: 'warn', text: 'Premiere API: ' + api.err });
    return res;
  }

  /* ====================== Reader: GUID -> dosya (onbellekli, asamali) ====================== */
  function ls() { try { return root.localStorage; } catch (e) { return null; } }
  function cacheLoad() { try { return JSON.parse(ls().getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; } }
  function cacheSave(c) { try { ls().setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) {} }
  // {path} = gecerli bulgu; {miss:true} = yakin zamanda arandi bulunamadi; null = bilinmiyor
  function cacheGet(guid) {
    var c = cacheLoad(), e = c[guid]; if (!e) return null;
    if (e.path) {
      try { var s = fs.statSync(e.path); if (s.mtimeMs === e.mtime) return { path: e.path }; } catch (x) {}
      delete c[guid]; cacheSave(c); return null;
    }
    if (e.miss && Date.now() - e.t < NEG_TTL) return { miss: true };
    delete c[guid]; cacheSave(c); return null;
  }
  function cachePut(guid, p) {
    var c = cacheLoad();
    if (p) { try { c[guid] = { path: p, mtime: fs.statSync(p).mtimeMs, t: Date.now() }; } catch (e) { return; } }
    else c[guid] = { miss: true, t: Date.now() };
    cacheSave(c);
  }
  function cacheClear() { try { ls().removeItem(CACHE_KEY); } catch (e) {} }

  var esc = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // Proje XML'inde GUID'in (Tracker'in kendi base64 degeri disinda) acik metin gectigi yerler
  function xmlRefs(xml, guid) {
    var out = [], re = new RegExp(esc(guid), 'ig'), m, I = MP().internals;
    while ((m = re.exec(xml)) && out.length < 20) {
      var en = I.enclosing(xml, m.index);
      out.push({ at: m.index, owner: en ? en.tag + '#' + en.id : '?', snippet: xml.substr(Math.max(0, m.index - 40), 120).replace(/\s+/g, ' ') });
    }
    return out;
  }

  /* opts: {guids[], projectDir, xml, deep (icerik aramasi + onbellegi atla), onStage(text), maxMsA, maxMsB} */
  async function locate(opts) {
    var out = { files: [], projectRefs: [], log: [], fromCache: 0, searched: [], ms: 0 }, t0 = Date.now(), need = [];
    var stage = opts.onStage || function () {};
    opts.guids.forEach(function (g) {
      if (opts.xml) xmlRefs(opts.xml, g).forEach(function (r) { out.projectRefs.push({ guid: g, owner: r.owner, snippet: r.snippet }); });
      if (!opts.deep) {
        var c = cacheGet(g);
        if (c && c.path) { out.files.push({ guid: g, path: c.path, via: 'önbellek' }); out.fromCache++; return; }
        if (c && c.miss) { out.log.push(g + ': yakın zamanda arandı, bulunamadı (önbellek, ' + Math.round(NEG_TTL / 60000) + ' dk)'); out.fromCache++; return; }
      }
      need.push(g);
    });
    function addHits(res, via) {
      (res.nameHits || []).forEach(function (h) {
        var p = h.replace(/\s+\[KLASOR\]$/, ''), low = p.toLowerCase();
        need.slice().forEach(function (g) {
          if (low.indexOf(g) >= 0 || low.indexOf(g.replace(/-/g, '')) >= 0) {
            if (!out.files.some(function (f) { return f.path === p && f.guid === g; })) out.files.push({ guid: g, path: p, via: via, isDir: / \[KLASOR\]$/.test(h) });
          }
        });
      });
    }
    function pending() { return need.filter(function (g) { return !out.files.some(function (f) { return f.guid === g; }); }); }
    if (need.length && MF()) {
      stage('Proje klasörü aranıyor…');
      var a = await MF().run({ guids: need, roots: opts.projectDir ? [opts.projectDir] : [], maxDepth: 3, nameOnly: true, maxMs: opts.maxMsA || 4000 });
      out.searched.push({ stage: 'proje klasörü', roots: a.roots, scanned: a.scanned, stop: a.stop, ms: a.ms }); addHits(a, 'proje klasörü');
      if (pending().length) {
        stage('Adobe klasörleri aranıyor…');
        var roots = MF().defaultRoots('').filter(function (r) { return !opts.projectDir || r !== opts.projectDir; });
        var b = await MF().run({ guids: pending(), roots: roots, maxDepth: 6, nameOnly: !opts.deep, maxMs: opts.deep ? 30000 : (opts.maxMsB || 12000) });
        out.searched.push({ stage: opts.deep ? 'Adobe klasörleri (derin: son 24 saat içerik dahil)' : 'Adobe klasörleri (yalnız ad)', roots: b.roots, scanned: b.scanned, stop: b.stop, ms: b.ms });
        addHits(b, 'Adobe klasörleri');
        (b.contentHits || []).forEach(function (h) {
          var p = h.replace(/ \(\d+ bayt\)$/, '');
          pending().forEach(function (g) { out.files.push({ guid: g, path: p, via: 'içerikte GUID' }); });
        });
        out.deepText = b.text;
      }
    }
    // onbellegi guncelle
    need.forEach(function (g) {
      var f = out.files.filter(function (x) { return x.guid === g && !x.isDir; })[0];
      if (f) cachePut(g, f.path); else if (!opts.deep) cachePut(g, null);
    });
    out.ms = Date.now() - t0;
    return out;
  }

  /* ====================== Format tanima + Parser kaydi ====================== */
  function entropy(buf) {
    var n = Math.min(buf.length, 65536); if (!n) return 0;
    var c = new Array(256).fill(0), i, e = 0;
    for (i = 0; i < n; i++) c[buf[i]]++;
    for (i = 0; i < 256; i++) if (c[i]) { var p = c[i] / n; e -= p * Math.log(p) / Math.LN2; }
    return +e.toFixed(2);
  }
  function startsWith(buf, arr) { for (var i = 0; i < arr.length; i++) if (buf[i] !== arr[i]) return false; return true; }
  function sniff(buf) {
    var r = { size: buf.length, entropy: entropy(buf), kind: 'binary', detail: '' }, head = buf.slice(0, 16);
    var txt = buf.slice(0, 4096).toString('latin1').replace(/^\xEF\xBB\xBF/, '').replace(/^\s+/, '');
    if (buf.length >= 32 && buf.slice(0, 4).toString('latin1') === 'prmf') { r.kind = 'prmf'; r.detail = 'Premiere PRMF v' + buf.readUInt32LE(4); return r; }
    if (startsWith(head, [0x1f, 0x8b])) { r.kind = 'gzip'; return r; }
    if (head[0] === 0x78 && (head[1] === 0x01 || head[1] === 0x5e || head[1] === 0x9c || head[1] === 0xda)) { r.kind = 'zlib'; return r; }
    if (startsWith(head, [0x50, 0x4b, 3, 4])) { r.kind = 'zip'; return r; }
    if (buf.slice(0, 15).toString('latin1') === 'SQLite format 3') { r.kind = 'sqlite'; return r; }
    if (buf.slice(0, 8).toString('latin1') === 'bplist00') { r.kind = 'bplist'; return r; }
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47]) || startsWith(head, [0xff, 0xd8, 0xff]) || buf.slice(4, 8).toString('latin1') === 'ftyp') { r.kind = 'media'; r.detail = 'görüntü/video'; return r; }
    if (txt[0] === '{' || txt[0] === '[') { r.kind = 'json?'; return r; }   // gercek dogrulama parse ile
    if (txt[0] === '<' && txt.indexOf('>') > 0) { r.kind = 'xml'; r.detail = (/^<\?xml[^>]*\?>\s*<(\w[\w:.-]*)/.exec(txt) || /^<(\w[\w:.-]*)/.exec(txt) || [])[1] || ''; return r; }
    return r;
  }
  // gzip / zlib katmanlarini ac (en fazla 3 kat, cikti siniri 256MB)
  function unwrap(buf) {
    var layers = [], cur = buf, i;
    for (i = 0; i < 3; i++) {
      var k = sniff(cur).kind;
      try {
        if (k === 'gzip') { cur = zlib.gunzipSync(cur, { maxOutputLength: 256 * 1024 * 1024 }); layers.push('gzip'); }
        else if (k === 'zlib') { cur = zlib.inflateSync(cur, { maxOutputLength: 256 * 1024 * 1024 }); layers.push('zlib'); }
        else break;
      } catch (e) { layers.push(k + ' (açılamadı: ' + (e && e.message) + ')'); return { buf: cur, layers: layers, failed: true }; }
    }
    return { buf: cur, layers: layers };
  }

  // Cozulen noktalarin DOGRULANMASI: bu kontrol gecmezse nokta kullanilmaz.
  function validatePoints(pts) {
    if (!pts || pts.length < 2) return 'en az 2 nokta gerekir';
    var inR = 0, i, same = true;
    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (!isFinite(p.src) || !isFinite(p.cx) || !isFinite(p.cy)) return 'sayısal olmayan değer';
      if (i && p.src < pts[i - 1].src) return 'zaman sıralı değil';
      if (p.cx >= -1 && p.cx <= 2 && p.cy >= -1 && p.cy <= 2) inR++;
      if (i && (p.cx !== pts[0].cx || p.cy !== pts[0].cy)) same = false;
    }
    if (inR < pts.length * 0.9) return 'koordinatlar normalize (0-1) görünmüyor; birim bilinmeden kullanılamaz';
    if (same) return 'tüm noktalar aynı (hareket yok)';
    if (pts[pts.length - 1].src <= pts[0].src) return 'zaman aralığı sıfır';
    return '';
  }

  var parsers = [];
  /* Cozucu arayuzu: {id, label, test(sniffInfo) -> bool, parse(buf, info) -> {points:[{src(kaynak tick), cx, cy, raw?}], meta}}
   * parse() SADECE dosyada gercekten bulunan degerleri dondurebilir. */
  function register(p) { parsers.push(p); }

  // P1: icinde Tether'in bildigi "<Keyframes>zaman,base64;..." kayit duzeni olan XML (kayit boyutu >=104 bayt, merkez float #15/#16)
  register({
    id: 'keyframes-xml', label: 'XML <Keyframes> (Tether tracker kayıt düzeni)',
    test: function (info) { return info.kind === 'xml'; },
    parse: function (buf) {
      var xml = buf.toString('utf8'), re = /<Keyframes[^>]*>[\s\S]*?<\/Keyframes>/g, m, best = null, blocks = 0;
      while ((m = re.exec(xml)) && blocks < 200) {
        blocks++;
        var pts = MP().internals.decodeKeyframes(m[0]);
        if (pts.length && (!best || pts.length > best.length)) best = pts;
      }
      if (!best) return { points: [], meta: { blocks: blocks, note: '<Keyframes> blokları bu kayıt düzenine uymuyor' } };
      return { points: best, meta: { blocks: blocks } };
    }
  });

  // P2: kendini tanimlayan JSON: ALAN ADLARI acik olmali (zaman: time/t/seconds/sec/timestamp; konum: x+y, cx+cy ya da center:[x,y]|{x,y})
  var TFIELDS = ['time', 't', 'seconds', 'sec', 'timestamp'];
  function pickPos(o) {
    if (typeof o.cx === 'number' && typeof o.cy === 'number') return [o.cx, o.cy];
    if (typeof o.x === 'number' && typeof o.y === 'number') return [o.x, o.y];
    var c = o.center; if (c) {
      if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') return [c[0], c[1]];
      if (typeof c.x === 'number' && typeof c.y === 'number') return [c.x, c.y];
    }
    return null;
  }
  function findSeries(node, depth, out, where) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length >= 3 && node.every(function (o) { return o && typeof o === 'object' && !Array.isArray(o); })) {
        var tf = null;
        for (var i = 0; i < TFIELDS.length && !tf; i++) if (node.every(function (o) { return typeof o[TFIELDS[i]] === 'number'; })) tf = TFIELDS[i];
        if (tf && node.every(function (o) { return pickPos(o); })) out.push({ where: where, tf: tf, items: node });
      }
      node.slice(0, 5000).forEach(function (v, k) { if (k < 50) findSeries(v, depth + 1, out, where + '[' + k + ']'); });
    } else Object.keys(node).slice(0, 200).forEach(function (k) { findSeries(node[k], depth + 1, out, where + '.' + k); });
  }
  register({
    id: 'json-fields', label: 'JSON (açık alan adları: zaman + x/y)',
    test: function (info) { return info.kind === 'json?'; },
    parse: function (buf) {
      var j; try { j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { return { points: [], meta: { note: 'geçerli JSON değil' } }; }
      var found = []; findSeries(j, 0, found, '$');
      if (!found.length) return { points: [], meta: { note: 'zaman + x/y alanları olan dizi bulunamadı' } };
      found.sort(function (a, b) { return b.items.length - a.items.length; });
      var s = found[0], maxT = Math.max.apply(null, s.items.map(function (o) { return Math.abs(o[s.tf]); }));
      var unit;   // zaman birimi yalnizca belirsizlik yoksa belirlenir
      if (s.tf === 'seconds' || s.tf === 'sec') unit = 1;
      else if (maxT < 1e6) unit = 1; else if (maxT >= 1e9) unit = 1 / TPS; else return { points: [], meta: { note: 'zaman birimi belirsiz (maks ' + maxT + ')', where: s.where } };
      var pts = s.items.map(function (o) { var p = pickPos(o); return { src: o[s.tf] * unit * TPS, cx: p[0], cy: p[1], raw: [] }; });
      return { points: pts, meta: { where: s.where, count: s.items.length, timeField: s.tf, note: 'zaman tabanı (kaynak medya zamanı) DOĞRULANAMAZ' } };
    }
  });

  /* P3: Premiere PRMF v3 (Object Mask).  TERS MUHENDISLIKLE DOGRULANAN KISIM = dosya sonundaki (kuyruk) FlatBuffers dizini:
   *   [0..32)  baslik: 'prmf' | u32 surum=3 | u64 veriBoyu | u64 kuyrukBoyu | u64 =32
   *   [32..veriBoyu) chunk'lar (gövde sıkıştırılmış/şifreli, ÇÖZÜLMEDİ ve gerekmiyor)
   *   [veriBoyu..) FlatBuffers: kök{f0=3, f1=tablo, f2=kayıt vektörü}; her kayıt: bayrak, zaman(u64 tick), chunk ofset, bbox(x,y,w,h i32), kare(W,H i32), chunk boyu.
   * Kayıtlar chunk bölgesini boşluksuz kaplıyorsa (bütünlük) ve bbox'lar kare içindeyse nokta üretilir. Nokta = bbox MERKEZİ / kare boyutu.
   * Zaman: tick = KAYNAK MEDYA zamanı (üç klipte doğrulandı; klip In noktasına göre değil). Doğrulanamayan: piksel orijini (sol-üst varsayılır). Koordinat orijini için sonuç 'önizlemede kontrol et' notuyla sunulur. */
  function prmfIndex(buf) {
    var N = buf.length, E = function (m) { throw new Error(m); };
    function need(o, n) { if (o < 0 || o + n > N) E('sınır dışı okuma @' + o); }
    function u16(o) { need(o, 2); return buf.readUInt16LE(o); }
    function u32(o) { need(o, 4); return buf.readUInt32LE(o); }
    function i32(o) { need(o, 4); return buf.readInt32LE(o); }
    function u64(o) { need(o, 8); var hi = buf.readUInt32LE(o + 4), lo = buf.readUInt32LE(o); var v = hi * 4294967296 + lo; if (!isFinite(v) || v > 9007199254740991) E('u64 çok büyük'); return v; }
    if (N < 32) return { note: 'dosya 32 bayttan kısa' };
    var ver = buf.readUInt32LE(4);
    if (ver !== 3) return { note: 'PRMF sürüm ' + ver + ' — yalnız sürüm 3 doğrulandı', version: ver };
    var dataSize = u64(8), tailSize = u64(16), hdr = u64(24);
    if (hdr !== 32 || dataSize < 32 || dataSize + tailSize !== N) return { note: 'başlık alanları tutarsız (veriBoyu ' + dataSize + ' + kuyruk ' + tailSize + ' ≠ dosya ' + N + ')', version: ver };
    var tail = buf.slice(dataSize), T = tail.length;
    function tneed(o, n) { if (o < 0 || o + n > T) E('kuyrukta sınır dışı okuma @' + o); }
    var tu16 = function (o) { tneed(o, 2); return tail.readUInt16LE(o); }, tu32 = function (o) { tneed(o, 4); return tail.readUInt32LE(o); }, ti32 = function (o) { tneed(o, 4); return tail.readInt32LE(o); };
    function fpos(tbl, idx) {   // alanin tablo icindeki mutlak konumu; yoksa -1
      var vt = tbl - ti32(tbl), vs = tu16(vt);
      if (4 + idx * 2 + 2 > vs) return -1;
      var off = tu16(vt + 4 + idx * 2); return off ? tbl + off : -1;
    }
    var root = tu32(0), rv = fpos(root, 2);
    if (rv < 0) return { note: 'kayıt vektörü yok', version: ver };
    var vec = rv + tu32(rv), n = tu32(vec);
    if (n < 1 || n > 200000) return { note: 'kayıt sayısı makul değil: ' + n, version: ver };
    var recs = [], k;
    for (k = 0; k < n; k++) {
      var ep = vec + 4 + 4 * k, rp = ep + tu32(ep);
      var pT = fpos(rp, 1), pO = fpos(rp, 2), pB = fpos(rp, 3), pF = fpos(rp, 4), pS = fpos(rp, 6);
      if (pB < 0 || pF < 0 || pS < 0 || pO < 0) E('kayıt ' + k + ': zorunlu alan yok');
      var tick = 0;
      if (pT >= 0) { tneed(pT, 8); tick = tail.readUInt32LE(pT + 4) * 4294967296 + tail.readUInt32LE(pT); if (tick > 9007199254740991) E('zaman çok büyük'); }
      recs.push({ tick: tick, off: tu32(pO), size: tu32(pS), x: ti32(pB), y: ti32(pB + 4), w: ti32(pB + 8), h: ti32(pB + 12), W: ti32(pF), H: ti32(pF + 4) });
    }
    return { version: ver, dataSize: dataSize, tailSize: tailSize, recs: recs, rootVersion: (function () { var p0 = fpos(root, 0); return p0 < 0 ? null : tu32(p0); })() };
  }
  function prmfPoints(buf) {
    var ix = prmfIndex(buf);
    if (!ix.recs) return { points: [], meta: { note: ix.note, version: ix.version } };
    var r = ix.recs, W = r[0].W, H = r[0].H, i, bad = '', lost = {};   // lost: Premiere'in "nesne kaybedildi" isareti (1 baytlik chunk + tum kare bbox)
    for (i = 0; i < r.length && !bad; i++) {
      var q = r[i];
      if (q.W !== W || q.H !== H || W < 16 || H < 16 || W > 16384 || H > 16384) bad = 'kare boyutu tutarsız (kayıt ' + i + ')';
      else if (q.w <= 0 || q.h <= 0 || q.x < -2 || q.y < -2 || q.x + q.w > W + 2 || q.y + q.h > H + 2) bad = 'bbox kare dışında (kayıt ' + i + ': ' + [q.x, q.y, q.w, q.h].join(',') + ')';
      else if (q.off < 32 || q.size < 1 || q.off + q.size > ix.dataSize) bad = 'chunk aralığı dosya dışında (kayıt ' + i + ')';
      else if (q.size < 12) {
        // Gercek veri tasimayan kisa chunk: yalniz "tum kare bbox" ise Premiere'in nesne-kaybi isaretidir; baska durumda dizin gecersiz sayilir
        if (q.x === 0 && q.y === 0 && q.w === W && q.h === H) lost[i] = true; else bad = 'kısa chunk beklenmeyen kayıt (kayıt ' + i + ')';
      }
      else if ((buf.readUInt32LE(q.off) & 0xffff) !== 0xfb04) bad = 'chunk işareti beklenen değil (kayıt ' + i + ' @' + q.off + ')';
    }
    if (bad) return { points: [], meta: { note: 'PRMF dizini doğrulanamadı: ' + bad, version: ix.version } };
    var byOff = r.slice().sort(function (a, b) { return a.off - b.off; }), cur = 32;
    for (i = 0; i < byOff.length; i++) { if (byOff[i].off !== cur) return { points: [], meta: { note: 'PRMF dizini chunk bölgesini kaplamıyor (@' + cur + ' ≠ ' + byOff[i].off + ')', version: ix.version } }; cur += byOff[i].size; }
    if (cur !== ix.dataSize) return { points: [], meta: { note: 'PRMF dizini veri bölgesinin sonuna ulaşmıyor (' + cur + ' ≠ ' + ix.dataSize + ')', version: ix.version } };
    var lostTicks = r.filter(function (q, k) { return lost[k]; }).map(function (q) { return q.tick; }).sort(function (a, b) { return a - b; });
    var s = r.filter(function (q, k) { return !lost[k]; }).sort(function (a, b) { return a.tick - b.tick; });
    if (s.length < 2) return { points: [], meta: { note: 'geçerli kayıt sayısı yetersiz (' + s.length + ')', version: ix.version, lostFrames: lostTicks.length } };
    for (i = 1; i < s.length; i++) if (s[i].tick === s[i - 1].tick) return { points: [], meta: { note: 'yinelenen zaman damgası', version: ix.version } };
    var pts = s.map(function (q) { return { src: q.tick, cx: (q.x + q.w / 2) / W, cy: (q.y + q.h / 2) / H, raw: [], bbox: [q.x, q.y, q.w, q.h], bn: [q.w / W, q.h / H] }; });
    return { points: pts, meta: { relTime: false, version: ix.version, frameW: W, frameH: H, records: r.length, dataSize: ix.dataSize, tailSize: ix.tailSize, chunkCover: true, lostFrames: lostTicks.length, lostTicks: lostTicks, firstTick: s[0].tick, lastTick: s[s.length - 1].tick,
      note: 'merkez = bbox merkezi; piksel orijini (sol-üst) doğrulanamaz; zaman = kaynak medya zamanı (doğrulandı); chunk gövdeleri (maske bitmap) çözülmedi' } };
  }
  register({
    id: 'prmf-v3-index', label: 'PRMF v3 dizini (kare bazlı bbox merkezi)',
    test: function (info) { return info.kind === 'prmf'; },
    parse: function (buf) { return prmfPoints(buf); }
  });

  /* buf -> {ok, points?, parser?, layers, sniff, attempts[], unverified:true} ; noktalar yalnizca validatePoints gecerse doner */
  function parseBuffer(buf) {
    var res = { ok: false, layers: [], attempts: [], sniff: sniff(buf) };
    var u = unwrap(buf); res.layers = u.layers;
    var inner = sniff(u.buf); res.inner = inner;
    if (u.failed) { res.attempts.push({ id: 'unwrap', ok: false, reason: u.layers.join(', ') }); return res; }
    var tried = 0;
    parsers.forEach(function (p) {
      if (res.ok) return;
      var okTest = false; try { okTest = p.test(inner); } catch (e) {}
      if (!okTest) return; tried++;
      try {
        var r = p.parse(u.buf, inner), why = validatePoints(r.points);
        if (r.points && r.points.length && !why) { res.ok = true; res.points = r.points; res.parser = p.id; res.parserLabel = p.label; res.meta = r.meta; res.relTime = !!(r.meta && r.meta.relTime); res.unverified = true; }
        var has = !!(r.points && r.points.length);
        res.attempts.push({ id: p.id, ok: !why && has, reason: has ? (why || (r.meta && r.meta.note) || '') : ((r.meta && r.meta.note) || why), points: has ? r.points.length : 0 });
      } catch (e) { res.attempts.push({ id: p.id, ok: false, reason: 'ayrıştırma hatası: ' + (e && e.message) }); }
    });
    if (!tried) res.attempts.push({ id: '-', ok: false, reason: 'bu biçim (' + inner.kind + ') için kayıtlı çözücü yok' });
    return res;
  }

  function parseFile(p, maxBytes) {
    var st;
    try { st = fs.statSync(p); } catch (e) { return { ok: false, error: makeErr('OM_FILE_NOT_FOUND', p), path: p }; }
    if (st.isDirectory()) return { ok: false, isDir: true, path: p, attempts: [{ id: '-', ok: false, reason: 'klasör' }], sniff: { kind: 'klasör', size: 0, entropy: 0 } };
    if (st.size > (maxBytes || 64 * 1024 * 1024)) return { ok: false, path: p, size: st.size, attempts: [{ id: '-', ok: false, reason: 'dosya çok büyük (' + st.size + ' bayt > sınır)' }], sniff: { kind: 'büyük', size: st.size, entropy: 0 } };
    var key = p + '|' + st.size + '|' + st.mtimeMs, hit = parseMemo[key];
    if (hit) return hit;
    var r; try { r = parseBuffer(fs.readFileSync(p)); } catch (e) { return { ok: false, path: p, error: makeErr('PARSER_ERROR', e && e.stack || e) }; }
    r.path = p; r.size = st.size; r.mtime = st.mtimeMs;
    parseMemo[key] = r; if (Object.keys(parseMemo).length > 24) { delete parseMemo[Object.keys(parseMemo)[0]]; }
    return r;
  }
  var parseMemo = {};   // path|boyut|mtime -> sonuc (ayni dosya her analizde yeniden cozulmez)
  /* Bir GUID kumesine ait birden cok dosyadan EN COK nokta verenini secer (ornek: 1 karelik referans + N karelik takip). */
  function parseFiles(paths, maxN) {
    var tried = [], best = null, seen = {};
    paths.slice(0, maxN || 8).forEach(function (p) {
      if (seen[p]) return; seen[p] = 1;
      var r = parseFile(p);
      tried.push({ path: p, ok: !!r.ok, points: r.ok ? r.points.length : 0, size: r.size || 0, kind: r.sniff && r.sniff.kind, error: r.error || null,
        reason: r.ok ? '' : (r.error ? r.error.title : (r.attempts && r.attempts.length ? r.attempts.map(function (a) { return a.reason; }).filter(Boolean).join('; ') : '')) });
      if (r.ok && (!best || r.points.length > best.points.length)) best = r;
    });
    return { best: best, tried: tried };
  }

  /* ====================== Diagnostics ====================== */
  function strings(buf, min, max) {
    var out = [], cur = '', i;
    for (i = 0; i < buf.length && out.length < max; i++) {
      var c = buf[i];
      if (c >= 32 && c < 127) cur += String.fromCharCode(c); else { if (cur.length >= min) out.push(cur.substring(0, 100)); cur = ''; }
    }
    if (cur.length >= min && out.length < max) out.push(cur.substring(0, 100));
    return out;
  }
  function floatPlausibility(buf) {
    var res = [], al, n = Math.min(Math.floor(buf.length / 4) - 1, 512);
    if (n < 16) return 'veri çok kısa';
    for (al = 0; al < 4; al++) {
      var ok = 0, tot = 0, i;
      for (i = 0; i < n && al + i * 4 + 4 <= buf.length; i++) { var v = buf.readFloatLE(al + i * 4); tot++; if (isFinite(v) && Math.abs(v) < 4 && (Math.abs(v) > 1e-6 || v === 0)) ok++; }
      res.push('hiza ' + al + ': ' + Math.round(ok / tot * 100) + '% [-4,4] aralığında');
    }
    return res.join(' | ');
  }
  function fileReport(p) {
    var L = [], st, buf;
    try { st = fs.statSync(p); } catch (e) { return ['  (dosya okunamadı: ' + e.message + ')']; }
    L.push('  boyut: ' + st.size + ' bayt · değişiklik: ' + new Date(st.mtimeMs).toISOString());
    if (st.isDirectory()) {
      try { var ents = fs.readdirSync(p).slice(0, 30); L.push('  KLASÖR içeriği (ilk 30): ' + ents.join(', ')); } catch (e) {}
      return L;
    }
    try { buf = fs.readFileSync(p, { flag: 'r' }); if (buf.length > 8 * 1024 * 1024) buf = buf.slice(0, 8 * 1024 * 1024); } catch (e) { L.push('  okunamadı: ' + e.message); return L; }
    var sn = sniff(buf); L.push('  tür: ' + sn.kind + (sn.detail ? ' (' + sn.detail + ')' : '') + ' · entropi: ' + sn.entropy + ' bit/bayt' + (sn.entropy > 7.5 ? ' (sıkıştırılmış / şifreli görünüyor)' : ''));
    L.push('  ilk 96 bayt (hex): ' + buf.slice(0, 96).toString('hex').replace(/(..)/g, '$1 ').trim());
    var u = unwrap(buf);
    if (u.layers.length) { L.push('  katmanlar: ' + u.layers.join(' > ')); var sn2 = sniff(u.buf); L.push('  açılmış tür: ' + sn2.kind + (sn2.detail ? ' (' + sn2.detail + ')' : '') + ', ' + u.buf.length + ' bayt'); buf = u.buf; sn = sn2; }
    if (sn.kind === 'sqlite') {
      var tbl = buf.toString('latin1').match(/CREATE TABLE[^\0]{0,200}/g) || [];
      L.push('  SQLite tabloları (metin taramasıyla): ' + (tbl.length ? '' : '(bulunamadı)'));
      tbl.slice(0, 15).forEach(function (t) { L.push('    ' + t.replace(/\s+/g, ' ').substring(0, 160)); });
    } else if (sn.kind === 'xml') {
      var tags = {}, m, re = /<(\w[\w:.-]*)[\s>\/]/g, cnt = 0;
      var s = buf.toString('utf8', 0, Math.min(buf.length, 4 * 1024 * 1024));
      while ((m = re.exec(s)) && cnt++ < 200000) tags[m[1]] = (tags[m[1]] || 0) + 1;
      var top = Object.keys(tags).sort(function (a, b) { return tags[b] - tags[a]; }).slice(0, 15);
      L.push('  XML etiketleri (en sık): ' + top.map(function (t) { return t + ':' + tags[t]; }).join(', '));
      L.push('  <Keyframes> blok sayısı: ' + (s.match(/<Keyframes/g) || []).length);
    } else if (sn.kind === 'json?') {
      try {
        var j = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
        L.push('  JSON üst düzey: ' + (Array.isArray(j) ? 'dizi[' + j.length + ']' : 'nesne {' + Object.keys(j).slice(0, 20).join(', ') + '}'));
        var f = []; findSeries(j, 0, f, '$');
        L.push('  zaman+x/y içeren seriler: ' + (f.length ? f.slice(0, 5).map(function (x) { return x.where + ' (' + x.items.length + ' öğe, zaman alanı ' + x.tf + ')'; }).join('; ') : '(yok)'));
      } catch (e) { L.push('  JSON ayrıştırılamadı: ' + e.message); }
    } else if (sn.kind === 'binary' || sn.kind === 'prmf') {
      L.push('  float32 makullüğü (ilk 2 KB): ' + floatPlausibility(buf));
    }
    if (sn.kind === 'prmf') {
      var pm = prmfPoints(buf), m = pm.meta || {};
      L.push('  PRMF: sürüm ' + (m.version != null ? m.version : '?') + (m.records ? ' · kayıt ' + m.records + ' · kare ' + m.frameW + '×' + m.frameH + ' · veri ' + m.dataSize + ' B + kuyruk ' + m.tailSize + ' B · chunk kapsaması: ' + (m.chunkCover ? 'tam' : '—') : ' · ' + (m.note || '')));
      if (pm.points.length) L.push('  zaman aralığı (tick): ' + m.firstTick + ' … ' + m.lastTick + ' · ' + pm.points.length + ' nokta (bbox merkezi)');
    }
    var ss = strings(buf.slice(0, 1024 * 1024), 6, 25);
    L.push('  okunabilir metinler (ilk 25): ' + (ss.length ? ss.join(' | ') : '(yok)'));
    var par = parseBuffer(buf);
    L.push('  ÇÖZÜCÜ SONUCU: ' + (par.ok ? 'EŞLEŞTİ → ' + par.parserLabel + ', ' + par.points.length + ' nokta (önizlemede kontrol et)' : 'eşleşme YOK — sahte veri üretilmedi'));
    par.attempts.forEach(function (a) { L.push('    - ' + a.id + ': ' + (a.ok ? 'tamam' : 'olmadı') + (a.reason ? ' · ' + a.reason : '')); });
    return L;
  }

  /* ctx: {version, api, projectPath, selection, detection, locate, parse, pluginVersion} */
  function build(ctx) {
    var L = [], a = ctx.api || {}, d = ctx.detection || {};
    L.push('TETHER ' + (ctx.pluginVersion || '') + ' — Object Mask raporu · ' + new Date().toISOString());
    L.push('');
    L.push('=== Ortam ===');
    L.push('Premiere: ' + (a.version || '?') + (a.build ? ' (build ' + a.build + ')' : ''));
    L.push('Proje: ' + (ctx.projectPath || a.projectPath || '?'));
    L.push('Sequence: ' + (a.sequence || '?') + ' · Seçili klip: ' + (a.clip || (ctx.selection && ctx.selection.name) || '?') + ' (nodeId ' + (a.nodeId || (ctx.selection && ctx.selection.nodeId) || '?') + ')');
    if (a.limits && a.limits.length) L.push('API sınırları: ' + a.limits.join('; '));
    L.push('');
    L.push('=== Algılama ===');
    L.push('Durum: ' + (d.state || '?'));
    (d.lines || []).forEach(function (l) { L.push((l.level === 'ok' ? '✓ ' : l.level === 'warn' ? '⚠ ' : '✕ ') + l.text); });
    (d.masks || []).forEach(function (m, i) {
      L.push('Maske ' + (i + 1) + ': tür=' + m.kind + ' tracker#' + m.trackerId + ' keyframe=' + m.keyframes + (m.shape ? ' şekil=' + m.shape : ''));
      L.push('   zincir: ' + (m.ancestry && m.ancestry.length ? m.ancestry.join('  <-  ') : '(yok)'));
      (m.guids || []).forEach(function (g) { L.push('   GUID: ' + g); });
    });
    if (a.maskProps && a.maskProps.length) {
      L.push('');
      L.push('=== Premiere API: maske/tracker ile ilgili özellikler ===');
      a.maskProps.forEach(function (p) { L.push('  ' + p.comp + ' > ' + p.prop + '  varying=' + p.varying + ' keys=' + p.keys + (p.err ? ' hata=' + p.err : '')); });
    }
    var lc = ctx.locate;
    if (lc) {
      L.push('');
      L.push('=== Veri dosyası araması ===');
      L.push('Önbellekten: ' + lc.fromCache + ' · süre: ' + lc.ms + ' ms');
      (lc.log || []).forEach(function (x) { L.push('  ' + x); });
      (lc.searched || []).forEach(function (s) { L.push('  aşama "' + s.stage + '": ' + s.scanned + ' öğe, ' + s.ms + ' ms' + (s.stop ? ' (durdu: ' + s.stop + ')' : '') + ' · kökler: ' + (s.roots && s.roots.length ? s.roots.join(' ; ') : '(yok)')); });
      L.push('Projede GUID\'in açık metin geçtiği yerler: ' + lc.projectRefs.length);
      lc.projectRefs.slice(0, 10).forEach(function (r) { L.push('  ' + r.guid + ' → ' + r.owner + ' : ' + r.snippet); });
      L.push('Bulunan dosya/klasör: ' + lc.files.length);
      lc.files.slice(0, 10).forEach(function (f) { L.push('  [' + f.via + '] ' + f.path + (f.isDir ? '  (KLASÖR)' : '')); L.push.apply(L, fileReport(f.path)); });
      if (!lc.files.length) L.push('  (hiç dosya bulunamadı — veri bu kökler dışında ya da adında GUID olmayan bir dosyada olabilir)');
    }
    L.push('');
    L.push('=== Sonuç ===');
    L.push(ctx.parse ? (ctx.parse.ok ? 'Çözücü eşleşti: ' + ctx.parse.parserLabel + ' (' + ctx.parse.points.length + ' nokta) — kullanıcı onayı gerekir' : 'Çözülemedi: ' + (ctx.parse.reason || 'biçim tanınmadı')) : 'Çözme denenmedi.');
    L.push('Not: Tether hiçbir koşulda tahmini ya da uydurma takip verisi üretmez.');
    return L.join('\n');
  }

  /* Diagnostics paneli icin kisa [etiket, deger] listesi */
  function summary(ctx) {
    var a = ctx.api || {}, d = ctx.detection || {}, lc = ctx.locate, rows = [];
    rows.push(['Premiere sürümü', a.version ? a.version + (a.build ? ' (' + a.build + ')' : '') : '—']);
    rows.push(['Eklenti sürümü', ctx.pluginVersion || '—']);
    rows.push(['Proje yolu', ctx.projectPath || a.projectPath || '—']);
    rows.push(['Sequence', a.sequence || '—']);
    rows.push(['Seçili klip', a.clip ? a.clip + ' (#' + a.nodeId + ')' : (ctx.selection ? ctx.selection.name : '—')]);
    rows.push(['Maske türü', (d.masks && d.masks.length) ? d.masks.map(function (m) { return m.kind === 'object' ? 'Object Mask' : (m.kind === 'normal' ? (m.shape ? m.shape + ' Mask' : 'Normal Mask') : 'Takipsiz maske'); }).join(', ') : (d.state === 'none' ? 'yok' : '—')]);
    rows.push(['Object Mask GUID', d.guids && d.guids.length ? d.guids.join(', ') : '—']);
    rows.push(['Object Mask dosyası', lc ? (lc.files.length ? lc.files.map(function (f) { return f.path; }).join('; ') : 'bulunamadı') : (d.objectUnreadable ? 'aranmadı' : '—')]);
    var tkr = d.masks && d.masks.filter(function (m) { return m.kind === 'object'; }).map(function (m) { return '#' + m.trackerId; }).join(', ');
    rows.push(['Tracker ID', tkr || '—']);
    var pf = lc && lc.files.filter(function (f) { return !f.isDir; }).map(function (f) { try { return f.path.split(/[\\/]/).pop() + ' (' + fs.statSync(f.path).size + ' B)'; } catch (e) { return f.path; } });
    rows.push(['PRMF boyutu', pf && pf.length ? pf.join('; ') : '—']);
    rows.push(['Keyframe sayısı', ctx.parse && ctx.parse.ok && ctx.parse.points ? String(ctx.parse.points.length) : '—']);
    rows.push(['Hata ayrıntısı', ctx.parse && !ctx.parse.ok && ctx.parse.reason ? ctx.parse.reason : '—']);
    rows.push(['Takip aralığı', ctx.range ? ctx.range.text : '—']);
    rows.push(['Çözücü durumu', ctx.parse ? (ctx.parse.ok ? 'eşleşti: ' + ctx.parse.parserLabel : (ctx.parse.reason || 'çözülemedi')) : '—']);
    return rows;
  }



  /* Object Mask takibini temizler (veri uydurmaz; yalniz var olan kareleri eler / ortanca suzer):
   *  1) Guvenilmez kareleri bul: iki kare arasinda merkez sicramasi nesne boyutunu asarsa (tracker nesneyi kaybetmis) ya da kutu boyutu
   *     bir karede 1.8 kattan fazla degisirse "kopus" sayilir. Kopuslarla bolunen parcalardan EN UZUNU tutulur; digerleri atilir.
   *  2) Kalan karelerde merkez ve boyut 5'li ortanca suzgecten gecer (tek kareli titremeyi / kutu sekli oynamasini giderir).
   * Sonuc: {points, trimmedHead, trimmedTail, breaks, kept, total, refined}. Parca bulunamazsa / cok kisaysa hicbir sey atilmaz. */
  function refine(points, opts) {
    opts = opts || {};
    var n = points.length, i;
    if (n < 6 || !points.every(function (p) { return p.bbox && p.bbox[2] > 0 && p.bbox[3] > 0; })) return { points: points, trimmedHead: 0, trimmedTail: 0, breaks: [], kept: n, total: n, refined: false };
    var brk = [];
    for (i = 1; i < n; i++) {
      var a = points[i - 1].bbox, b = points[i].bbox, cx0 = a[0] + a[2] / 2, cy0 = a[1] + a[3] / 2, cx1 = b[0] + b[2] / 2, cy1 = b[1] + b[3] / 2;
      var sz = (b[2] + b[3]) / 2, step = Math.sqrt((cx1 - cx0) * (cx1 - cx0) + (cy1 - cy0) * (cy1 - cy0));
      var rw = Math.max(a[2], b[2]) / Math.min(a[2], b[2]), rh = Math.max(a[3], b[3]) / Math.min(a[3], b[3]);
      if (step / sz > 1.0 || rw > 1.8 || rh > 1.8) brk.push(i);   // i. kareden once kopus
    }
    var start = 0, best = [0, 0], cuts = brk.concat([n]);
    cuts.forEach(function (c) { if (c - start > best[1] - best[0]) best = [start, c]; start = c; });
    var keep = (opts.trim !== false && brk.length && (best[1] - best[0]) >= Math.max(5, n * 0.5)) ? best : [0, n];
    var seg = points.slice(keep[0], keep[1]);
    function med(v) { var w = v.slice().sort(function (x, y) { return x - y; }); return w[Math.floor(w.length / 2)]; }
    var out = seg.map(function (p, k) {
      var lo = Math.max(0, k - 2), hi = Math.min(seg.length - 1, k + 2), cx = [], cy = [], bw = [], bh = [], j;
      for (j = lo; j <= hi; j++) { cx.push(seg[j].cx); cy.push(seg[j].cy); if (seg[j].bn) { bw.push(seg[j].bn[0]); bh.push(seg[j].bn[1]); } }
      var q = {}; for (var key in p) q[key] = p[key];
      if (opts.median !== false) { q.cx = med(cx); q.cy = med(cy); if (p.bn) q.bn = [med(bw), med(bh)]; }
      return q;
    });
    return { points: out, trimmedHead: keep[0], trimmedTail: n - keep[1], breaks: brk, kept: out.length, total: n, refined: opts.median !== false };
  }

  /* Takip kapsamı: noktalar klibin görünen aralığının (inP..outP) ne kadarını kapsıyor? Salt hesap; veri üretmez.
   * timing: {inP, outP} (kaynak tick). Kare süresi = noktalar arası ortanca fark (ardışık kareler varsayımı). */
  function coverage(points, timing) {
    if (!points || points.length < 2 || !timing || timing.outP == null || timing.inP == null) return null;
    var t = points.map(function (p) { return p.src; }).sort(function (a, b) { return a - b; }), d = [], i;
    for (i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
    d.sort(function (a, b) { return a - b; });
    var step = d[Math.floor(d.length / 2)]; if (!(step > 0)) return null;
    var first = t[0], last = t[t.length - 1], total = Math.round((timing.outP - timing.inP) / step);
    var head = Math.max(0, Math.round((first - timing.inP) / step)), tail = Math.max(0, Math.round(((timing.outP - step) - last) / step));
    var f0 = Math.round(first / step), f1 = Math.round(last / step), full = head === 0 && tail === 0;
    var text = 'kare ' + f0 + '–' + f1 + ' · ' + points.length + ' kare · ' + (full ? 'klibin tamamı' : (head ? 'ilk ' + head + ' kare takip dışı' : '') + (head && tail ? ', ' : '') + (tail ? 'son ' + tail + ' kare takip dışı' : ''));
    return { step: step, total: total, count: points.length, firstFrame: f0, lastFrame: f1, head: head, tail: tail, full: full, level: full ? 'ok' : 'warn', text: text };
  }

  var api = {
    version: '2.9.2',
    errors: { ERR: ERR, classify: classify, make: makeErr },
    detector: { detect: detect },
    reader: { locate: locate, cacheGet: cacheGet, cachePut: cachePut, cacheClear: cacheClear, xmlRefs: xmlRefs },
    parser: { register: register, sniff: sniff, parseBuffer: parseBuffer, parseFile: parseFile, parseFiles: parseFiles, validatePoints: validatePoints },
    diagnostics: { build: build, summary: summary, fileReport: fileReport },
    coverage: coverage,
    refine: refine
  };
  root.ObjectMask = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

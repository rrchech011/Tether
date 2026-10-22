// Tether - Premiere tarafi (ExtendScript). Dosya ASCII tutuldu (kodlama sorunu olmasin).
function ppEsc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' '); }
function ppToJson(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "string") return '"' + ppEsc(v) + '"';
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(ppToJson(v[i])); return "[" + a.join(",") + "]"; }
  var p = []; for (var k in v) if (v.hasOwnProperty(k)) p.push('"' + k + '":' + ppToJson(v[k]));
  return "{" + p.join(",") + "}";
}
function ppFindProp(comp, name, fallbackIdx) {
  for (var i = 0; i < comp.properties.numItems; i++) { if (comp.properties[i].displayName == name) return comp.properties[i]; }
  return comp.properties[fallbackIdx];
}
function ppMotionComp(clip) {
  var i, j, n = clip.components.numItems, c, mn;
  for (i = 0; i < n; i++) {
    c = clip.components[i]; mn = "";
    try { mn = c.matchName; } catch (e0) {}
    if (c.displayName == "Motion" || mn == "AE.ADBE Motion") return c;
  }
  for (i = 0; i < n; i++) { if (clip.components[i].displayName == "Vector Motion") return clip.components[i]; }   // yazi / grafik klipleri
  for (i = 0; i < n; i++) {                                                                                       // Position ozelligi olan ilk bilesen
    c = clip.components[i];
    for (j = 0; j < c.properties.numItems; j++) { if (c.properties[j].displayName == "Position") return c; }
  }
  return clip.components[0];
}
function ppMkTime(sec) { var t = new Time(); t.seconds = sec; return t; }

// Animasyonluysa getValue() oynatma basligindaki degeri verir; bu yuzden ilk keyframe degerini baz alinir.
function ppBaseValue(prop) {
  try {
    if (prop.isTimeVarying()) {
      var ks = prop.getKeys();
      if (ks && ks.length) return prop.getValueAtKey(ks[0]);
    }
  } catch (e) {}
  return prop.getValue();
}
// Kaynak medyanin gercek piksel boyutu (Project metadata icinden)
function ppNativeSize(clip) {
  try {
    var md = clip.projectItem.getProjectMetadata();
    var m = /VideoInfo[^>]*>\s*(\d+)\s*x\s*(\d+)/.exec(md);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch (e) {}
  return null;
}
// Yazi / grafik klibinde "Text" bileseninin kendi konumu (Motion konumundan bagimsiz). Yoksa null.
function ppTextInfo(clip) {
  try {
    for (var i = 0; i < clip.components.numItems; i++) {
      var c = clip.components[i], mn = "";
      try { mn = c.matchName; } catch (e0) {}
      if (c.displayName == "Text" || mn == "AE.ADBE Text") {
        var p = null, a = null;
        for (var j = 0; j < c.properties.numItems; j++) {
          var d = c.properties[j].displayName;
          if (d == "Position" && !p) p = c.properties[j];
          if (d == "Anchor Point" && !a) a = c.properties[j];
        }
        if (!p) return null;
        var pv = ppBaseValue(p), av = a ? ppBaseValue(a) : [0, 0];
        if (!(pv instanceof Array) || pv.length < 2) return null;
        return { pos: [pv[0], pv[1]], anchor: (av instanceof Array && av.length > 1) ? [av[0], av[1]] : [0, 0] };
      }
    }
  } catch (e) {}
  return null;
}
// ---- Transform EFEKTI (AE.ADBE Geometry2): Motion yerine buna yazinca Shutter Angle (hareket bulaniklugu) kullanilabilir ----
function ppXfComp(clip) {
  for (var i = 0; i < clip.components.numItems; i++) {
    var c = clip.components[i], mn = "";
    try { mn = c.matchName; } catch (e) {}
    if (mn == "AE.ADBE Geometry2" || c.displayName == "Transform") return c;
  }
  return null;
}
// Klipte Transform efekti yoksa QE DOM ile eklemeyi dener (basarisiz olabilir; o zaman kullanici elle ekler).
function ppAddTransform(clip) {
  try {
    app.enableQE();
    var q = qe.project.getActiveSequence(), want = clip.start.seconds;
    for (var ti = 0; ti < q.numVideoTracks; ti++) {
      var tr = q.getVideoTrackAt(ti);
      for (var ii = 0; ii < tr.numItems; ii++) {
        var it = tr.getItemAt(ii), nm = "";
        try { nm = it.name; } catch (e0) {}
        if (nm != clip.name) continue;
        var st = -1;
        try { st = it.start.secs; } catch (e1) {}
        if (!(st >= 0)) { try { st = it.start.seconds; } catch (e2) {} }
        if (st >= 0 && Math.abs(st - want) > 0.05) continue;
        it.addVideoEffect(qe.project.getVideoEffectByName("Transform"));
        return true;
      }
    }
  } catch (e) {}
  return false;
}
// where: "xform" -> Transform efekti, aksi halde Motion. Donus: ozellik ya da null.
function ppTargetProp(clip, where, propName, fallbackIdx, startTicks, name, nodeId) {
  if (where == "xform_ro") { var cr = ppXfComp(clip); return cr ? ppXfByName(cr, propName) : null; }   // salt okuma: efekt eklemez
  if (where == "xform") {
    var c = ppXfComp(clip);
    if (!c) {
      if (ppAddTransform(clip)) { var c2 = ppFindClip(startTicks, name, nodeId); if (c2) c = ppXfComp(c2); }
    }
    if (!c) return null;
    return ppXfByName(c, propName);
  }
  return ppFindProp(ppMotionComp(clip), propName, fallbackIdx);
}
// Transform efekti ozelligini ada gore, bulunamazsa sabit siraya gore bul (0 Anchor,1 Position,2 Uniform Scale,3 Scale(Height),4 Scale Width,
// 5 Skew,6 Skew Axis,7 Rotation,8 Opacity,9 Use Composition's Shutter Angle,10 Shutter Angle,11 Sampling). Onay kutularinin adi bos gelebilir.
function ppXfProp(c, names, idx) {
  if (!c) return null;
  for (var i = 0; i < c.properties.numItems; i++) {
    var d = c.properties[i].displayName;
    for (var j = 0; j < names.length; j++) { if (d == names[j]) return c.properties[i]; }
  }
  if (idx >= 0 && c.properties.numItems >= 12) return c.properties[idx];
  return null;
}
function ppBoolOf(v) { return !(v === false || v === 0 || v === "false"); }
function ppXfByName(c, n) {
  if (n == "Rotation") return ppXfProp(c, ["Rotation"], 7);
  if (n == "Position") return ppXfProp(c, ["Position"], 1);
  if (n == "Scale") return ppXfProp(c, ["Scale", "Scale Height"], 3);
  return ppXfProp(c, [n], -1);
}
var PP_XF_ERR = "Hedef klipte Transform efekti yok ve otomatik eklenemedi. Effects > Video Effects > Distort > Transform efektini klibe elle surukle, sonra tekrar dene.";
function ppXfInfo(clip) {
  try {
    var c = ppXfComp(clip); if (!c) return null;
    var p = ppXfProp(c, ["Position"], 1), s = ppXfProp(c, ["Scale", "Scale Height"], 3), u = ppXfProp(c, ["Uniform Scale"], 2);
    var pv = p ? ppBaseValue(p) : null, sv = s ? ppBaseValue(s) : 100;
    if (!(pv instanceof Array) || pv.length < 2) return null;
    var rpx = ppXfProp(c, ["Rotation"], 7), rvx = rpx ? ppBaseValue(rpx) : 0;
    var xi = { has: true, rot: (rvx instanceof Array) ? rvx[0] : rvx, pos: [pv[0], pv[1]], posPx: (Math.abs(pv[0]) > 10 || Math.abs(pv[1]) > 10), scale: (sv instanceof Array) ? sv[0] : sv };
    if (u) { try { xi.uniform = ppBoolOf(u.getValue()); } catch (eu) {} }
    return xi;
  } catch (e) { return null; }
}
// Hareket bulaniklugu: "Use Composition's Shutter Angle" kapatilir, Shutter Angle yazilir (angle <= 0 ise dokunma). Donus: "" | "yok" | hata notu
function ppXfShutter(clip, angle) {
  var note = "";
  try {
    angle = Number(angle); if (!(angle > 0)) return "";
    var c = ppXfComp(clip); if (!c) return "efekt yok";
    var u = ppXfProp(c, ["Use Composition's Shutter Angle"], 9), a = ppXfProp(c, ["Shutter Angle"], 10);
    if (u) {
      try { u.setValue(false, true); } catch (e1) {}
      try { if (ppBoolOf(u.getValue())) u.setValue(0, true); } catch (e2) {}
      try { if (ppBoolOf(u.getValue())) note += "'Use Composition's Shutter Angle' kapatilamadi; "; } catch (e3) {}
    } else note += "onay kutusu bulunamadi; ";
    if (a) {
      try { a.setValue(angle, true); } catch (e4) {}
      try { var av = a.getValue(); if (Math.abs(Number(av) - angle) > 0.5) note += "Shutter Angle yazilamadi (simdi " + av + "); "; } catch (e5) {}
    } else note += "Shutter Angle bulunamadi; ";
  } catch (e) { note += String(e); }
  return note;
}
// Transform efektini etkisiz hale getir (Motion'a yazarken cift kayma olmasin): anahtarlari sil, konum = anchor, olcek 100.
function ppXfNeutral(startTicks, name, nodeId, dry) {
  dry = (Number(dry) == 1);
  try {
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var c = ppXfComp(clip); if (!c) return ppToJson({ ok: true, had: false });
    var pos = ppXfProp(c, ["Position"], 1), anc = ppXfProp(c, ["Anchor Point"], 0), un = ppXfProp(c, ["Uniform Scale"], 2), sc = ppXfProp(c, ["Scale", "Scale Height"], 3);
    var changed = false;
    if (pos) {
      var animated = false; try { animated = pos.isTimeVarying() && pos.getKeys().length > 0; } catch (e0) {}
      var av = anc ? ppBaseValue(anc) : null, pv = ppBaseValue(pos);
      if (animated || (av instanceof Array && pv instanceof Array && (Math.abs(av[0] - pv[0]) > 1e-6 || Math.abs(av[1] - pv[1]) > 1e-6))) {
        changed = true;
        if (!dry) {
          ppClearKeys(pos); try { pos.setTimeVarying(false); } catch (e1) {}
          if (av instanceof Array) pos.setValue([av[0], av[1]], true);
        }
      }
    }
    if (sc) {
      var sa = false; try { sa = sc.isTimeVarying() && sc.getKeys().length > 0; } catch (e2) {}
      var sv = ppBaseValue(sc); sv = (sv instanceof Array) ? sv[0] : sv;
      if (sa || Math.abs(Number(sv) - 100) > 1e-6) {
        changed = true;
        if (!dry) {
          ppClearKeys(sc); try { sc.setTimeVarying(false); } catch (e3) {}
          if (un) { try { un.setValue(true, false); } catch (e4) {} }
          sc.setValue(100, true);
        }
      }
    }
    return ppToJson({ ok: true, had: true, changed: changed });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppFindExact(comp, name) {
  for (var i = 0; i < comp.properties.numItems; i++) { if (comp.properties[i].displayName == name) return comp.properties[i]; }
  return null;
}
function ppClipInfo(clip, seq) {
  var info = { name: clip.name, startTicks: String(clip.start.ticks), endTicks: String(clip.end.ticks),
    inSec: clip.inPoint.seconds, seqW: seq.frameSizeHorizontal || 1920, seqH: seq.frameSizeVertical || 1080,
    frameTicks: String(seq.timebase), nodeId: String(clip.nodeId), nat: ppNativeSize(clip),
    pos: [0.5, 0.5], scale: 100, anchor: [0.5, 0.5], posAnimated: false, scaleAnimated: false, posPx: false };
  info.text = ppTextInfo(clip);
  info.xf = ppXfInfo(clip);
  try {
    var m = ppMotionComp(clip);
    var pos = ppFindProp(m, "Position", 0), sc = ppFindProp(m, "Scale", 1), an = ppFindProp(m, "Anchor Point", 5);
    info.pos = ppBaseValue(pos); info.scale = ppBaseValue(sc); info.anchor = ppBaseValue(an);
    try {   // Uniform Scale kapaliysa X olcegi "Scale Width"
      var unp = ppFindExact(m, "Uniform Scale"), swp = ppFindExact(m, "Scale Width");
      if (unp) {
        var uv = unp.getValue(); info.uniform = !(uv === false || uv === 0 || uv === "false");
        if (!info.uniform && swp) { var sw = ppBaseValue(swp); info.scaleW = (sw instanceof Array) ? sw[0] : sw; }
      }
    } catch (eU) {}
    try { var rpp = ppFindProp(m, "Rotation", 4); if (rpp) { var rbv = ppBaseValue(rpp); info.rot = (rbv instanceof Array) ? rbv[0] : rbv; } } catch (eRot) {}
    info.posPx = (Math.abs(info.pos[0]) > 10 || Math.abs(info.pos[1]) > 10);   // grafik klipleri konumu piksel olarak tutabilir
    try { info.posAnimated = !!pos.isTimeVarying(); info.scaleAnimated = !!sc.isTimeVarying(); } catch (e2) {}
  } catch (e) {}
  return info;
}
function ppGetSelection() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return ppToJson({ ok: false, err: "Aktif sequence yok" });
    var sel = seq.getSelection(), clip = null;
    for (var i = 0; i < sel.length; i++) { if (sel[i].mediaType == "Video") { clip = sel[i]; break; } }
    if (!clip) return ppToJson({ ok: false, err: "Timeline'da bir video klibi sec" });
    var info = ppClipInfo(clip, seq); info.ok = true;
    return ppToJson(info);
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppGetSelectionAll() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return ppToJson({ ok: false, err: "Aktif sequence yok" });
    var sel = seq.getSelection(), arr = [];
    for (var i = 0; i < sel.length; i++) { if (sel[i].mediaType == "Video") arr.push(ppClipInfo(sel[i], seq)); }
    if (!arr.length) return ppToJson({ ok: false, err: "Timeline'da en az bir video klibi sec" });
    return ppToJson({ ok: true, clips: arr });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppOwnInfo() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return ppToJson({ ok: false, err: "Aktif sequence yok" });
    var sel = seq.getSelection(), clip = null;
    for (var i = 0; i < sel.length; i++) { if (sel[i].mediaType == "Video") { clip = sel[i]; break; } }
    if (!clip) return ppToJson({ ok: false, err: "Timeline'da bir video klibi sec" });
    var mp = "";
    try { mp = clip.projectItem.getMediaPath(); } catch (e1) {}
    var ph = seq.getPlayerPosition();
    return ppToJson({ ok: true, name: clip.name, nodeId: String(clip.nodeId), mediaPath: mp ? String(mp) : "",
      startTicks: String(clip.start.ticks), endTicks: String(clip.end.ticks), startSec: clip.start.seconds, endSec: clip.end.seconds,
      inSec: clip.inPoint.seconds, outSec: clip.outPoint.seconds, playSec: ph.seconds, frameTicks: String(seq.timebase) });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppSaveProject() {
  try {
    if (!app.project.path) return ppToJson({ ok: false, err: "Proje henuz kaydedilmemis, once Ctrl+S ile kaydet" });
    app.project.save();
    return ppToJson({ ok: true, path: app.project.path });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppFindClip(startTicks, name, nodeId) {
  var seq = app.project.activeSequence, fallback = null, nCand = 0;
  if (nodeId) {
    for (var v0 = 0; v0 < seq.videoTracks.numTracks; v0++) {
      var tr0 = seq.videoTracks[v0];
      for (var c0 = 0; c0 < tr0.clips.numItems; c0++) { if (String(tr0.clips[c0].nodeId) == String(nodeId)) return tr0.clips[c0]; }
    }
  }
  for (var v = 0; v < seq.videoTracks.numTracks; v++) {
    var tr = seq.videoTracks[v];
    for (var c = 0; c < tr.clips.numItems; c++) {
      var cl = tr.clips[c];
      if (Math.abs(Number(cl.start.ticks) - Number(startTicks)) < 2000) {
        if (cl.name == name) return cl;
        nCand++; if (!fallback) fallback = cl;
      }
    }
  }
  return (nCand == 1) ? fallback : null;   // ayni noktada birden cok aday varsa tahmin etme (yanlis klibe yazma)
}
function ppClearKeys(pos) {
  try {
    if (pos.isTimeVarying()) {
      var ks = pos.getKeys();
      for (var i = ks.length - 1; i >= 0; i--) { try { pos.removeKey(ks[i]); } catch (e) {} }
    }
  } catch (e) {}
}
function ppReadFile(path) {
  var f = new File(path); f.encoding = "UTF-8";
  if (!f.open("r")) return null;
  var t = f.read(); f.close(); return t;
}
// Veri bir gecici dosyadan okunur (evalScript'e uzun metin gondermek guvenilir degil).
// Satir formati: "zamanSn,x,y" (zaman klibin keyframe referansina gore, saniye)
function ppSetScale(clip, val, where) {
  try {
    var sc = (where == "xform") ? (ppXfComp(clip) ? ppXfByName(ppXfComp(clip), "Scale") : null) : ppFindProp(ppMotionComp(clip), "Scale", 1);
    if (!sc) return false;
    ppClearKeys(sc);
    try { sc.setTimeVarying(false); } catch (e0) {}
    sc.setValue(val, true);
    return true;
  } catch (e) { return false; }
}
// Geri alma yedegi: hedefin mevcut Position anahtarlari ve taban degerleri
function ppReadKeys(startTicks, name, nodeId, where) {
  try {
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var pos = ppTargetProp(clip, where == "xform" ? "xform_ro" : where, "Position", 0, startTicks, name, nodeId), sc = ppTargetProp(clip, where == "xform" ? "xform_ro" : where, "Scale", 1, startTicks, name, nodeId);
    if (!pos || !sc) return ppToJson({ ok: true, animated: false, keys: [], pos: [0.5, 0.5], scale: 100, scaleAnimated: false, scaleKeys: [], noXf: true });
    var rp = ppTargetProp(clip, where == "xform" ? "xform_ro" : where, "Rotation", 4, startTicks, name, nodeId), rotInfo = { rot: 0, rotAnimated: false, rotKeys: [] };
    try {
      if (rp) {
        var rb = ppBaseValue(rp); rotInfo.rot = (rb instanceof Array) ? rb[0] : rb;
        if (rp.isTimeVarying()) { var rks = rp.getKeys(); if (rks.length) { rotInfo.rotAnimated = true; for (var rq = 0; rq < rks.length; rq++) { var rv = rp.getValueAtKey(rks[rq]); rotInfo.rotKeys.push([ppSecOf(rks[rq]), (rv instanceof Array) ? rv[0] : rv]); } } }
      }
    } catch (eR) {}
    var res = { ok: true, animated: false, keys: [], pos: ppBaseValue(pos), scale: ppBaseValue(sc), scaleAnimated: false, scaleKeys: [] };
    try {
      if (pos.isTimeVarying()) {
        res.animated = true;
        var ks = pos.getKeys();
        for (var i = 0; i < ks.length; i++) {
          var v = pos.getValueAtKey(ks[i]);
          var sec = (typeof ks[i] == "number") ? ks[i] : ks[i].seconds;
          res.keys.push([sec, v[0], v[1]]);
        }
      }
    } catch (e1) {}
    try {
      if (sc.isTimeVarying()) {
        res.scaleAnimated = true;
        var ks2 = sc.getKeys();
        for (var j = 0; j < ks2.length; j++) {
          var v2 = sc.getValueAtKey(ks2[j]);
          var sec2 = (typeof ks2[j] == "number") ? ks2[j] : ks2[j].seconds;
          res.scaleKeys.push([sec2, (v2 instanceof Array) ? v2[0] : v2]);
        }
      }
    } catch (e5) {}
    if (res.scale instanceof Array) res.scale = res.scale[0];
    res.rot = rotInfo.rot; res.rotAnimated = rotInfo.rotAnimated; res.rotKeys = rotInfo.rotKeys;
    return ppToJson(res);
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
// Parcali yazma: from==0 iken eski animasyon temizlenir. Bir cagri en fazla `count` satir yazar, boylece panel takilmaz.
function ppSecOf(k) { return (typeof k == "number") ? k : k.seconds; }
function ppRowRange(rows) {
  var mn = 1e18, mx = -1e18;
  for (var i = 0; i < rows.length; i++) { var t = parseFloat(rows[i].split(",")[0]); if (!isNaN(t)) { if (t < mn) mn = t; if (t > mx) mx = t; } }
  return [mn, mx];
}
// Onceki sahnelerin keyframe'lerini koru: yalniz yeni takibin zaman araligindaki eski anahtarlari sil. Yoksa (ya da keepOld=0) hepsini temizle.
function ppPrepKeys(prop, rows, keepOld, hs) {
  var had = false;
  try { had = prop.isTimeVarying() && prop.getKeys().length > 0; } catch (e0) {}
  if (keepOld && had) {
    var rg = ppRowRange(rows), eps = hs * 0.5, ks = prop.getKeys();
    for (var i = ks.length - 1; i >= 0; i--) {
      var s = ppSecOf(ks[i]);
      if (s >= rg[0] - eps && s <= rg[1] + eps) { try { prop.removeKey(ks[i]); } catch (e1) {} }
    }
    try { prop.setTimeVarying(true); } catch (e2) {}
    return;
  }
  prop.setTimeVarying(true);
  ppClearKeys(prop);
}
// Yeni araligin onune / arkasina "tutma" anahtari koy: onceki / sonraki sahne arasinda yazi kayarak gitmesin.
function ppHoldKeys(prop, rows, hs, lastV) {
  try {
    var rg = ppRowRange(rows), ks = prop.getKeys(), bef = null, aft = null;
    for (var i = 0; i < ks.length; i++) {
      var s = ppSecOf(ks[i]);
      if (s < rg[0] - hs * 0.5) { if (!bef || s > bef.t) bef = { t: s, k: ks[i] }; }
      else if (s > rg[1] + hs * 0.5) { if (!aft || s < aft.t) aft = { t: s }; }
    }
    if (bef && rg[0] - bef.t > hs * 1.5) {
      var bv = prop.getValueAtKey(bef.k), tb = rg[0] - hs;
      prop.addKey(ppMkTime(tb)); prop.setValueAtKey(ppMkTime(tb), bv, false);
      try { prop.setInterpolationTypeAtKey(ppMkTime(tb), 0, false); } catch (e1) {}
    }
    if (aft && aft.t - rg[1] > hs * 1.5) {
      var ta = aft.t - hs;
      prop.addKey(ppMkTime(ta)); prop.setValueAtKey(ppMkTime(ta), lastV, false);
      try { prop.setInterpolationTypeAtKey(ppMkTime(ta), 0, false); } catch (e2) {}
    }
  } catch (e) {}
}
// Yazilan anahtarlari geri oku: istenen araliktaki anahtar sayisi, eksikse eksik zamanlari yeniden yaz. Donus: {want, found, fixed}
function ppVerifyKeys(prop, rows, hs, isPoint) {
  var vr = { want: 0, found: 0, fixed: 0 };
  try {
    var want = [], i;
    for (i = 0; i < rows.length; i++) {
      var f = rows[i].split(","), t = parseFloat(f[0]);
      if (isNaN(t)) continue;
      want.push({ t: t, v: isPoint ? [parseFloat(f[1]), parseFloat(f[2])] : parseFloat(f[1]) });
    }
    vr.want = want.length;
    function present() {
      var ks = prop.getKeys(), have = [];
      for (var k = 0; k < ks.length; k++) have.push(ppSecOf(ks[k]));
      return have;
    }
    function hasT(have, t) { for (var k = 0; k < have.length; k++) { if (Math.abs(have[k] - t) < 0.0005) return true; } return false; }
    var pass, have, miss;
    for (pass = 0; pass < 3; pass++) {            // eksik anahtarlari en cok 2 kez yeniden yaz
      have = present(); miss = []; vr.found = 0;
      for (i = 0; i < want.length; i++) { if (hasT(have, want[i].t)) vr.found++; else miss.push(want[i]); }
      if (!miss.length || pass == 2) break;
      for (i = 0; i < miss.length; i++) {
        try {
          prop.addKey(ppMkTime(miss[i].t)); prop.setValueAtKey(ppMkTime(miss[i].t), miss[i].v, false);
          try { prop.setInterpolationTypeAtKey(ppMkTime(miss[i].t), 0, false); } catch (e1) {}
          vr.fixed++;
        } catch (e2) {}
      }
    }
  } catch (e) { vr.err = String(e); }
  return vr;
}
function ppApplyKeys(startTicks, name, dataPath, nodeId, scaleVal, from, count, keepOld, holdSec, where, shutter) {
  try {
    from = Number(from) || 0; count = Number(count) || 1000000;
    var keep = (Number(keepOld) == 1), hs = Number(holdSec) > 0 ? Number(holdSec) : 0.02;
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var txt = ppReadFile(dataPath);
    if (!txt) return ppToJson({ ok: false, err: "Gecici veri dosyasi okunamadi" });
    var all = txt.split(/\r?\n/), rows = [];
    for (var r = 0; r < all.length; r++) { if (all[r]) rows.push(all[r]); }
    var pos = ppTargetProp(clip, where, "Position", 0, startTicks, name, nodeId);
    if (!pos) return ppToJson({ ok: false, err: PP_XF_ERR });
    if (from == 0) ppPrepKeys(pos, rows, keep, hs);   // keep: onceki sahnelerin anahtarlari korunur; degilse hepsi temizlenir
    pos.setTimeVarying(true);
    var n = 0, bad = 0, end = Math.min(rows.length, from + count);
    for (var i = from; i < end; i++) {
      var f = rows[i].split(","), t = parseFloat(f[0]), v = [parseFloat(f[1]), parseFloat(f[2])];
      if (isNaN(t) || isNaN(v[0]) || isNaN(v[1])) { bad++; continue; }
      try { pos.addKey(ppMkTime(t)); pos.setValueAtKey(ppMkTime(t), v, i == rows.length - 1); }
      catch (e1) {
        try { pos.addKey(t); pos.setValueAtKey(t, v, i == rows.length - 1); } catch (e2) { bad++; continue; }
      }
      try { pos.setInterpolationTypeAtKey(ppMkTime(t), 0, false); } catch (e3) {} // 0 = linear
      n++;
    }
    var vr = null;
    if (end >= rows.length) vr = ppVerifyKeys(pos, rows, hs, true);   // yazilan anahtarlari geri oku, eksik varsa yeniden yaz
    if (keep && end >= rows.length) {
      var lr = rows[rows.length - 1].split(",");
      ppHoldKeys(pos, rows, hs, [parseFloat(lr[1]), parseFloat(lr[2])]);
    }
    var shNote = "";
    if (where == "xform" && end >= rows.length) { var cl2 = ppFindClip(startTicks, name, nodeId) || clip; shNote = ppXfShutter(cl2, shutter); }
    var scaleOk = true;
    if (from == 0 && scaleVal && Number(scaleVal) > 0) scaleOk = ppSetScale(clip, Number(scaleVal), where);
    return ppToJson({ ok: true, count: n, bad: bad, total: rows.length, scaleOk: scaleOk, shutterNote: shNote, verify: vr });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
// Program monitoru yenile: Premiere, betikle yazilan keyframe'leri oynatma basligi oynamadan ekrana yansitmaz.
// Oynatma basligini bir kare ileri-geri oynatip ayni yere birakir (yer degismez, goruntu yeniden cizilir).
function ppRefresh() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return ppToJson({ ok: false, err: "Aktif sequence yok" });
    var cur = seq.getPlayerPosition(), ticks = String(cur.ticks), tb = Number(seq.timebase) || 8475667200;
    var alt = Number(ticks) - tb; if (alt < 0) alt = Number(ticks) + tb;
    seq.setPlayerPosition(String(alt));
    seq.setPlayerPosition(ticks);
    try { app.project.activeSequence.setPlayerPosition(ticks); } catch (e2) {}
    return ppToJson({ ok: true });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
// Scale keyframe'leri (dinamik zoom). Satir formati: "zamanSn,scaleYuzde". from==0 iken eski Scale animasyonu temizlenir.
function ppApplyScaleKeys(startTicks, name, dataPath, nodeId, from, count, keepOld, holdSec, where, which) {
  try {
    from = Number(from) || 0; count = Number(count) || 1000000;
    var keep = (Number(keepOld) == 1), hs = Number(holdSec) > 0 ? Number(holdSec) : 0.02;
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var txt = ppReadFile(dataPath);
    if (!txt) return ppToJson({ ok: false, err: "Gecici scale dosyasi okunamadi" });
    var all = txt.split(/\r?\n/), rows = [];
    for (var r = 0; r < all.length; r++) { if (all[r]) rows.push(all[r]); }
    var isRot = (which == "rot");
    var sc = ppTargetProp(clip, where, isRot ? "Rotation" : "Scale", isRot ? 4 : 1, startTicks, name, nodeId);
    if (!sc) return ppToJson({ ok: false, err: PP_XF_ERR });
    if (!isRot && where == "xform" && from == 0) { try { var un = ppXfProp(ppXfComp(clip), ["Uniform Scale"], 2); if (un) un.setValue(true, false); } catch (eU) {} }
    if (from == 0) ppPrepKeys(sc, rows, keep, hs);
    sc.setTimeVarying(true);
    var n = 0, bad = 0, end = Math.min(rows.length, from + count);
    for (var i = from; i < end; i++) {
      var f = rows[i].split(","), t = parseFloat(f[0]), v = parseFloat(f[1]);
      if (isNaN(t) || isNaN(v)) { bad++; continue; }
      try { sc.addKey(ppMkTime(t)); sc.setValueAtKey(ppMkTime(t), v, i == rows.length - 1); }
      catch (e1) {
        try { sc.addKey(t); sc.setValueAtKey(t, v, i == rows.length - 1); } catch (e2) { bad++; continue; }
      }
      try { sc.setInterpolationTypeAtKey(ppMkTime(t), 0, false); } catch (e3) {}
      n++;
    }
    if (keep && end >= rows.length) { var lr2 = rows[rows.length - 1].split(","); ppHoldKeys(sc, rows, hs, parseFloat(lr2[1])); }
    return ppToJson({ ok: true, count: n, bad: bad, total: rows.length });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
// Hedefin Position animasyonunu siler ve verilen statik degere dondurur.
function ppResetRot(startTicks, name, nodeId, val, where) {
  try {
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var rp = ppTargetProp(clip, where == "xform" ? "xform_ro" : where, "Rotation", 4, startTicks, name, nodeId);
    if (!rp) return ppToJson({ ok: true });
    ppClearKeys(rp); try { rp.setTimeVarying(false); } catch (e1) {}
    rp.setValue(Number(val), true);
    return ppToJson({ ok: true });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
function ppResetKeys(startTicks, name, x, y, nodeId, scaleVal, where) {
  try {
    var clip = ppFindClip(startTicks, name, nodeId);
    if (!clip) return ppToJson({ ok: false, err: "Hedef klip bulunamadi" });
    var pos = ppTargetProp(clip, where == "xform" ? "xform_ro" : where, "Position", 0, startTicks, name, nodeId);
    if (!pos) return ppToJson({ ok: true, note: "Transform efekti yok, yapilacak sey yok" });
    ppClearKeys(pos);
    try { pos.setTimeVarying(false); } catch (e) {}
    pos.setValue([x, y], true);
    if (scaleVal && Number(scaleVal) > 0) ppSetScale(clip, Number(scaleVal), where == "xform" ? "xform" : "motion");
    return ppToJson({ ok: true });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}
// Canli teshis: secili klibin tum bilesenleri ve ozellikleri (Object Mask / maske verisi API'den okunabiliyor mu?)
function ppProbeVal(v) {
  try {
    if (v === null || v === undefined) return "null";
    var t = typeof v, s = String(v);
    if (s.length > 160) s = s.substring(0, 160) + "...(" + s.length + ")";
    return t + ":" + s;
  } catch (e) { return "?"; }
}
function ppProbe() {
  try {
    var seq = app.project.activeSequence;
    if (!seq) return ppToJson({ ok: false, err: "Aktif sequence yok" });
    var sel = seq.getSelection(), clip = null, i;
    for (i = 0; i < sel.length; i++) { if (sel[i].mediaType == "Video") { clip = sel[i]; break; } }
    if (!clip) return ppToJson({ ok: false, err: "Timeline'da bir video klibi sec" });
    var L = ["clip: " + clip.name + " | bilesen sayisi: " + clip.components.numItems];
    for (var c = 0; c < clip.components.numItems; c++) {
      var comp = clip.components[c], mn = "?";
      try { mn = comp.matchName; } catch (e0) {}
      L.push("COMP " + c + ": " + comp.displayName + " | match=" + mn + " | ozellik=" + comp.properties.numItems);
      for (var p = 0; p < comp.properties.numItems; p++) {
        var pr = comp.properties[p], line = "  [" + p + "] " + pr.displayName, ks = null;
        try { line += " varying=" + pr.isTimeVarying(); } catch (e1) {}
        try { ks = pr.getKeys(); line += " keys=" + (ks ? ks.length : 0); } catch (e2) { line += " keys=?"; }
        try { line += " val=" + ppProbeVal(pr.getValue()); } catch (e3) { line += " val=ERR"; }
        L.push(line);
        try {
          if (ks && ks.length) {
            for (var k = 0; k < Math.min(2, ks.length); k++) {
              var kt = (typeof ks[k] == "number") ? ks[k] : ks[k].seconds;
              L.push("      key" + k + " t=" + kt + " v=" + ppProbeVal(pr.getValueAtKey(ks[k])));
            }
          }
        } catch (e4) {}
      }
    }
    return ppToJson({ ok: true, text: L.join("@@") });
  } catch (e) { return ppToJson({ ok: false, err: String(e) }); }
}

// v1.9: Tanilama. Premiere surumu, proje, sequence, klip ve maske/tracker ile ilgili ozellikler. Her adim korumali:
// bir API yoksa "limits" listesine yazilir, hata firlatmaz (eski/yeni Premiere surumlerinde panel calismaya devam eder).
function ppDiag() {
  var o = { ok: true, version: "", build: "", projectPath: "", projectName: "", sequence: "", clip: "", nodeId: "", nComps: 0, maskProps: [], limits: [], hasObjectMaskName: false };
  try { o.version = String(app.version); } catch (e0) { o.limits.push("app.version okunamadi"); }
  try { o.build = String(app.build); } catch (e1) {}
  try { o.projectPath = String(app.project.path); o.projectName = String(app.project.name); } catch (e2) { o.limits.push("app.project bilgisi okunamadi"); }
  var seq = null;
  try { seq = app.project.activeSequence; } catch (e3) { o.limits.push("activeSequence erisilemedi"); }
  if (!seq) { o.ok = false; o.err = "Aktif sequence yok"; return ppToJson(o); }
  try { o.sequence = String(seq.name); } catch (e4) {}
  var clip = null, i;
  try {
    var sel = seq.getSelection();
    for (i = 0; i < sel.length; i++) { if (sel[i].mediaType == "Video") { clip = sel[i]; break; } }
  } catch (e5) { o.limits.push("getSelection erisilemedi"); }
  if (!clip) { o.ok = false; o.err = "Timeline'da bir video klibi sec"; return ppToJson(o); }
  try { o.clip = String(clip.name); o.nodeId = String(clip.nodeId); } catch (e6) {}
  var comps = null;
  try { comps = clip.components; } catch (e7) {}
  if (!comps || typeof comps.numItems === "undefined") { o.limits.push("clip.components API yok (maske ozellikleri okunamaz)"); return ppToJson(o); }
  o.nComps = comps.numItems;
  var RX = /mask|tracker|object|roto/i;
  for (var c = 0; c < comps.numItems && c < 40; c++) {
    var comp = comps[c], cn = "", mn = "";
    try { cn = String(comp.displayName); } catch (e8) {}
    try { mn = String(comp.matchName); } catch (e9) {}
    if (/object/i.test(cn + " " + mn) && /mask/i.test(cn + " " + mn)) o.hasObjectMaskName = true;
    var np = 0;
    try { np = comp.properties.numItems; } catch (e10) { o.limits.push("properties erisilemedi: " + cn); continue; }
    for (var p = 0; p < np && p < 80; p++) {
      var pr = comp.properties[p], pn = "";
      try { pn = String(pr.displayName); } catch (e11) { continue; }
      if (/object/i.test(pn) && /mask/i.test(pn)) o.hasObjectMaskName = true;
      if (!RX.test(pn) && !RX.test(cn)) continue;
      var rec = { comp: cn, prop: pn, varying: "?", keys: "?", err: "" };
      try { rec.varying = pr.isTimeVarying() ? "true" : "false"; } catch (e12) { rec.err = "isTimeVarying yok"; }
      try { var ks = pr.getKeys(); rec.keys = ks ? ks.length : 0; } catch (e13) { rec.err = (rec.err ? rec.err + "; " : "") + "getKeys erisilemedi"; }
      if (rec.err && o.limits.length < 6) o.limits.push(cn + " > " + pn + ": " + rec.err);
      if (o.maskProps.length < 60) o.maskProps.push(rec);
    }
  }
  return ppToJson(o);
}

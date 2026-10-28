import { t } from './i18n.js';
// 圖片處理：EXIF 轉正、縮放、OCR 前處理（灰階＋拉高對比）。無外部套件；iPhone Safari 可用。

// ---------- EXIF（純函式，可在 node 測）----------
// 讀 JPEG 的 Orientation（1–8）；非 JPEG 或沒有 EXIF 回 1
export function readExifOrientation(buf) {
  const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off); const len = v.getUint16(off + 2);
    if (marker === 0xffe1) {
      if (off + 10 > v.byteLength || v.getUint32(off + 4) !== 0x45786966) return 1; // "Exif"
      const t = off + 10; const little = v.getUint16(t) === 0x4949;
      if (!little && v.getUint16(t) !== 0x4d4d) return 1;
      const ifd = t + v.getUint32(t + 4, little);
      if (ifd + 2 > v.byteLength) return 1;
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > v.byteLength) return 1;
        if (v.getUint16(e, little) === 0x0112) { const o = v.getUint16(e + 8, little); return o >= 1 && o <= 8 ? o : 1; }
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return 1;
    off += 2 + len;
  }
  return 1;
}

// 轉正用的 canvas 變換：回傳 [a,b,c,d,e,f]（setTransform）與輸出寬高
export function orientTransform(o, w, h) {
  const swap = o >= 5;
  const T = {
    1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  };
  return { m: T[o] || T[1], w: swap ? h : w, h: swap ? w : h };
}

// ---------- 瀏覽器端 ----------
let autoExifCache = null;
// 瀏覽器是否已自動依 EXIF 轉正（Safari 13.1+/Chrome 81+ 是；舊版否）。以執行時產生的 2×1 EXIF=6 JPEG 實測，免內嵌圖檔。
async function browserAppliesExif() {
  if (autoExifCache !== null) return autoExifCache;
  try {
    const c = document.createElement('canvas'); c.width = 2; c.height = 1;
    const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 2, 1);
    const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    // APP1 Exif：TIFF little-endian、1 個 entry（0x0112 = 6）
    const exif = [0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    const withExif = new Blob([jpg.subarray(0, 2), new Uint8Array(exif), jpg.subarray(2)], { type: 'image/jpeg' });
    const url = URL.createObjectURL(withExif);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    autoExifCache = img.naturalWidth === 1 && img.naturalHeight === 2;
  } catch (_) { autoExifCache = true; }
  return autoExifCache;
}

// 任何 throw/reject 的東西都轉成「錯誤名稱：訊息」（null、Event、DOMException、NaN 都處理，永遠不會只剩 null）
export function errMsg(e) {
  let m = '';
  if (e === null || e === undefined) return t('common.unknownError');
  if (typeof e === 'string') m = e;
  else if (e.message || e.name) m = (e.name ? e.name + t('common.colon') : '') + (e.message || '');
  else if (e.type) return t('common.eventErr', { type: e.type });
  else { try { m = JSON.stringify(e); } catch (_) { m = String(e); } }
  m = String(m).trim();
  return !m || m === 'null' || m === 'undefined' ? t('common.unknownErrorType', { type: typeof e }) : m;
}
// 帶「步驟」的錯誤：message = 「步驟 → 錯誤名稱：訊息」；.step / .cause 供診斷用
export function stepErr(step, e) {
  if (e && e.step) return e; // 已標過步驟，保留最內層
  const err = new Error(t('step.' + step) + ' → ' + errMsg(e));
  err.step = step; err.cause = e; err.errName = (e && e.name) || typeof e;
  return err;
}
let warnHandler = null;
export function setImageWarnHandler(fn) { warnHandler = fn; }
const warn = (m, e) => { const txt = e === undefined ? m : m + t('common.colon') + errMsg(e); try { if (warnHandler) warnHandler(txt); else console.warn(txt); } catch (_) { /* ignore */ } };

// ---- 解碼：三條路依序試（Image+blobURL → createImageBitmap → FileReader dataURL+Image），回報每條路的失敗原因 ----
const imgFromUrl = (url) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => rej(new Error(t('img.onerror')));
  i.src = url;
});
async function decodeImage(blob) {
  const errs = [];
  try { // 路徑 1：blob URL（用完才 revoke，避免 Safari 延遲解碼時資源已被收回）
    const url = URL.createObjectURL(blob);
    try {
      const img = await imgFromUrl(url);
      if (img.decode) { try { await img.decode(); } catch (_) { /* 已 onload，decode 失敗不致命 */ } }
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, kind: 'img', done() { URL.revokeObjectURL(url); } };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  } catch (e) { errs.push('Image(blob): ' + errMsg(e)); }
  try { // 路徑 2：createImageBitmap（Safari 15+；明確要求依 EXIF 轉正）
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, kind: 'bitmap', done() { try { bmp.close(); } catch (_) { /* ignore */ } } };
    }
  } catch (e) { errs.push('createImageBitmap: ' + errMsg(e)); }
  try { // 路徑 3：FileReader → dataURL → Image
    const d = await blobToDataURL(blob); const img = await imgFromUrl(d);
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, kind: 'img', done() { /* none */ } };
  } catch (e) { errs.push('FileReader+Image: ' + errMsg(e)); }
  const err = new Error(errs.join(' | ') + ' — ' + t('img.heic')); err.name = 'DecodeError'; throw err;
}
const ctx2d = (c) => { try { return c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d'); } catch (_) { return c.getContext('2d'); } };

// 轉正＋縮放，回傳 canvas。每個階段失敗都標上步驟（exif / decode / draw）
async function orientedCanvas(blob, maxSide) {
  let o = 1;
  try { o = readExifOrientation(await blob.arrayBuffer()); } catch (e) { warn(t('img.exifFail'), e); }
  let dec;
  try { dec = await decodeImage(blob); } catch (e) { throw stepErr('decode', e); }
  try {
    // 已由瀏覽器轉正（Image 新版／createImageBitmap from-image）就不能再轉
    if (o !== 1 && (dec.kind === 'bitmap' || (await browserAppliesExif()))) o = 1;
    const sw = dec.w; const sh = dec.h;
    if (!sw || !sh) throw new Error(t('img.zero'));
    const draw = (orient, side) => {
      const scale = Math.min(1, side / Math.max(sw, sh));
      const dw = Math.max(1, Math.round(sw * scale)); const dh = Math.max(1, Math.round(sh * scale));
      const { m, w, h } = orientTransform(orient, dw, dh);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = ctx2d(c); if (!ctx) { releaseCanvas(c); throw new Error(t('img.noCanvas')); }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch (_) { /* ignore */ }
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.drawImage(dec.src, 0, 0, dw, dh);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return c;
    };
    try { return draw(o, maxSide); } catch (e1) {
      warn(t('img.rotateRetry'), e1);
      try { return draw(o, Math.min(maxSide, 1200)); } catch (e2) { warn(t('img.rotateSkip'), e2); return draw(1, Math.min(maxSide, 1200)); }
    }
  } catch (e) { throw stepErr('draw', e); } finally { dec.done(); }
}
function releaseCanvas(c) { try { c.width = 0; c.height = 0; } catch (_) { /* ignore */ } } // iOS Safari 不會即時釋放 canvas 記憶體

const toBlob = (c, type, q) => new Promise((res, rej) => {
  try {
    if (c.toBlob) c.toBlob((b) => (b ? res(b) : rej(new Error(t('img.blobNull')))), type, q);
    else rej(new Error('no toBlob'));
  } catch (e) { rej(e); }
}).catch(async (e1) => { // 後備：dataURL → Blob
  try { const d = c.toDataURL(type, q); if (!d || d.length < 20) throw new Error('toDataURL empty'); return await (await fetch(d)).blob(); }
  catch (e2) { throw new Error(errMsg(e1) + ' | toDataURL: ' + errMsg(e2)); }
});

// 儲存用：轉正、縮小、JPEG 壓縮。先試 1600px，失敗再試 1000px；都失敗就 throw（含步驟與錯誤名稱），由呼叫端改存原檔
export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  let lastErr = null;
  for (const [side, q] of [[maxSide, quality], [Math.min(maxSide, 1000), 0.6]]) {
    let c = null;
    try {
      c = await orientedCanvas(file, side);
      let blob; try { blob = await toBlob(c, 'image/jpeg', q); } catch (e) { throw stepErr('encode', e); }
      if (!blob || !blob.size) throw stepErr('encode', new Error(t('img.empty')));
      return { blob, width: c.width, height: c.height };
    } catch (e) { lastErr = e; warn(t('img.compressFail', { side }), e); } finally { if (c) releaseCanvas(c); }
  }
  throw lastErr instanceof Error ? lastErr : stepErr('compress', lastErr);
}

// 灰階＋自動色階（1%–99%）＋加強對比；就地處理 ImageData
export function enhanceGray(data, contrast = 1.25) {
  const n = data.length / 4; const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114 + 500) / 1000 | 0;
    data[i] = g; hist[g]++;
  }
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
  if (hi - lo < 32) { lo = 0; hi = 255; } // 幾乎無對比（空白圖）時不拉伸
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const s = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = (s * 255 - 128) * contrast + 128;
  }
  for (let i = 0; i < data.length; i += 4) { const g = lut[data[i]]; data[i] = data[i + 1] = data[i + 2] = g; data[i + 3] = 255; }
}

// OCR 前處理：EXIF 轉正 → 長邊縮到 ~2000px → 灰階 → 拉高對比 → PNG。
// 逐步退回：對比處理失敗 → 送未處理的轉正圖；轉正/縮放失敗 → 回傳原檔（呼叫端照樣 OCR）
export async function prepareForOcr(file, maxSide = 2000) {
  let c = null;
  try {
    c = await orientedCanvas(file, maxSide);
    try {
      const ctx = ctx2d(c);
      const id = ctx.getImageData(0, 0, c.width, c.height);
      enhanceGray(id.data);
      ctx.putImageData(id, 0, 0);
    } catch (e) { warn(t('img.enhanceFail'), e); }
    try { return await toBlob(c, 'image/png'); } catch (e) { throw stepErr('encode', e); }
  } catch (e) {
    warn(t('img.prepFail'), e);
    return file;
  } finally { if (c) releaseCanvas(c); }
}

export function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('FileReader error')); r.readAsDataURL(blob); }); }
export async function dataURLToBlob(d) { return (await fetch(d)).blob(); }

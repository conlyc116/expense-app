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

let warnHandler = null;
export function setImageWarnHandler(fn) { warnHandler = fn; }
const warn = (m, e) => { try { if (warnHandler) warnHandler(m + (e && e.message ? '：' + e.message : '')); else console.warn(m, e); } catch (_) { /* ignore */ } };

function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取圖片（HEIC 請在 iPhone 設定→相機→格式改為「最相容」，或截圖後再選）')); };
    i.src = url;
  });
}
const ctx2d = (c) => { try { return c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d'); } catch (_) { return c.getContext('2d'); } };

// 轉正＋縮放，回傳 canvas。每一步失敗都退一級：EXIF 讀不到→當作 1；轉正失敗→不轉正直接畫
async function orientedCanvas(blob, maxSide) {
  let o = 1;
  try { o = readExifOrientation(await blob.arrayBuffer()); } catch (e) { warn('讀取 EXIF 失敗，略過轉正', e); }
  const img = await loadImage(blob); // 這步失敗是真的讀不到圖，讓上層處理
  if (o !== 1) { try { if (await browserAppliesExif()) o = 1; } catch (e) { warn('EXIF 偵測失敗', e); } }
  const sw = img.naturalWidth; const sh = img.naturalHeight;
  if (!sw || !sh) throw new Error('圖片尺寸為 0（可能是不支援的格式）');
  const draw = (orient, side) => {
    const scale = Math.min(1, side / Math.max(sw, sh));
    const dw = Math.max(1, Math.round(sw * scale)); const dh = Math.max(1, Math.round(sh * scale));
    const { m, w, h } = orientTransform(orient, dw, dh);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = ctx2d(c); if (!ctx) { releaseCanvas(c); throw new Error('無法建立 canvas（記憶體不足？）'); }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch (_) { /* ignore */ }
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(img, 0, 0, dw, dh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  };
  try { return draw(o, maxSide); } catch (e1) {
    warn('轉正失敗，改用較小尺寸重試', e1);
    try { return draw(o, Math.min(maxSide, 1200)); } catch (e2) { warn('轉正仍失敗，改為不轉正', e2); return draw(1, Math.min(maxSide, 1200)); }
  }
}
function releaseCanvas(c) { try { c.width = 0; c.height = 0; } catch (_) { /* ignore */ } } // iOS Safari 不會即時釋放 canvas 記憶體

const toBlob = (c, type, q) => new Promise((res, rej) => {
  try {
    if (c.toBlob) c.toBlob((b) => (b ? res(b) : rej(new Error('圖片輸出失敗（toBlob 回傳空值）'))), type, q);
    else rej(new Error('no toBlob'));
  } catch (e) { rej(e); }
}).catch(async () => { // 後備：dataURL → Blob
  const d = c.toDataURL(type, q); return (await fetch(d)).blob();
});

// 儲存用：轉正、縮小、JPEG 壓縮。任何一步失敗 → 退回原檔（至少照片一定存得進去）
export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  let c = null;
  try {
    c = await orientedCanvas(file, maxSide);
    const blob = await toBlob(c, 'image/jpeg', quality);
    return { blob, width: c.width, height: c.height };
  } catch (e) {
    warn('照片壓縮失敗，改存原圖', e);
    if (file && file.size && file.size < 15 * 1024 * 1024) return { blob: file, width: 0, height: 0 };
    throw e;
  } finally { if (c) releaseCanvas(c); }
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
    } catch (e) { warn('灰階／對比處理失敗，使用未增強影像', e); }
    return await toBlob(c, 'image/png');
  } catch (e) {
    warn('OCR 前處理失敗，改用原圖', e);
    return file;
  } finally { if (c) releaseCanvas(c); }
}

export function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
export async function dataURLToBlob(d) { return (await fetch(d)).blob(); }

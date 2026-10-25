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

function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取圖片（HEIC 請在設定改為「最相容」或截圖後再選）')); };
    i.src = url;
  });
}

// 轉正＋縮放，回傳 canvas（呼叫端用完要 releaseCanvas）
async function orientedCanvas(blob, maxSide) {
  let o = 1;
  try { o = readExifOrientation(await blob.arrayBuffer()); } catch (_) { /* ignore */ }
  const img = await loadImage(blob);
  if (o !== 1 && (await browserAppliesExif())) o = 1; // 瀏覽器已轉正，不能再轉一次
  const sw = img.naturalWidth; const sh = img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale)); const dh = Math.max(1, Math.round(sh * scale));
  const { m, w, h } = orientTransform(o, dw, dh);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0, dw, dh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}
function releaseCanvas(c) { c.width = 0; c.height = 0; } // iOS Safari 不會即時釋放 canvas 記憶體

const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('圖片輸出失敗'))), type, q));

// 儲存用：轉正、縮小、JPEG 壓縮（keeps IndexedDB small）
export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  const c = await orientedCanvas(file, maxSide);
  try {
    const blob = await toBlob(c, 'image/jpeg', quality);
    return { blob, width: c.width, height: c.height };
  } finally { releaseCanvas(c); }
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

// OCR 前處理：EXIF 轉正 → 長邊縮到 ~2000px → 灰階 → 拉高對比 → PNG（無損，避免再壓縮雜訊）
export async function prepareForOcr(file, maxSide = 2000) {
  const c = await orientedCanvas(file, maxSide);
  try {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, c.width, c.height);
    enhanceGray(id.data);
    ctx.putImageData(id, 0, 0);
    return await toBlob(c, 'image/png');
  } finally { releaseCanvas(c); }
}

export function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
export async function dataURLToBlob(d) { return (await fetch(d)).blob(); }

// Downscale + JPEG-compress photos before storing (keeps IndexedDB small).
export async function compressImage(file, maxSide = 1600, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('無法讀取圖片（HEIC 請在設定改為「最相容」或截圖後再選）')); i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale); const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    return { blob, width: w, height: h };
  } finally { URL.revokeObjectURL(url); }
}
export function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
export async function dataURLToBlob(d) { return (await fetch(d)).blob(); }

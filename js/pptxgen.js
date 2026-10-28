// 產生「收據簡報」.pptx（Google 簡報／PowerPoint／Keynote 都能開）。不依賴外部套件，只需要 JSZip。
// 第 1 頁封面（出差名稱＋日期區間），之後每張照片一頁：照片等比例放到最大，頁面上寫日期、類別、金額、幣別、說明。
// 純函式：版面計算、JPEG/PNG 尺寸解析、XML 產生都可以在 node 測；瀏覽器只負責讀照片（見 export.js）。

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const SLIDE = { w: 12192000, h: 6858000 }; // 16:9（13.333in × 7.5in）
const MARGIN = 274320;      // 0.3in
const TOP_BAND = 1000000;   // 上方文字區高度
const SIDE_PANEL = 3600000; // 右側文字區寬度
const IN = (n) => Math.round(n);

const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = (s) => String(s ?? '').replace(BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => { const a = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

// ---------- 圖片尺寸（不需解碼）----------
export function sniffImage(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}
export function imageSize(bytes) {
  const kind = sniffImage(bytes);
  if (kind === 'png') { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); return { kind, w: v.getUint32(16), h: v.getUint32(20) }; }
  if (kind === 'jpeg') {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let off = 2;
    while (off + 9 < v.byteLength) {
      if (v.getUint8(off) !== 0xff) { off++; continue; }
      const m = v.getUint8(off + 1);
      if (m === 0xff) { off++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
      const len = v.getUint16(off + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { kind, h: v.getUint16(off + 5), w: v.getUint16(off + 7) };
      off += 2 + len;
    }
  }
  return null;
}

// ---------- 版面：文字放上方或右側，取照片較大的那一種 ----------
export function fitIn(area, w, h) {
  const s = Math.min(area.cx / w, area.cy / h); const cx = IN(w * s); const cy = IN(h * s);
  return { x: area.x + IN((area.cx - cx) / 2), y: area.y + IN((area.cy - cy) / 2), cx, cy, scale: s };
}
export function layoutFor(w, h) {
  const top = { mode: 'top', text: { x: MARGIN, y: MARGIN, cx: SLIDE.w - 2 * MARGIN, cy: TOP_BAND }, area: { x: MARGIN, y: MARGIN * 2 + TOP_BAND, cx: SLIDE.w - 2 * MARGIN, cy: SLIDE.h - TOP_BAND - 3 * MARGIN } };
  const side = { mode: 'side', text: { x: SLIDE.w - MARGIN - SIDE_PANEL, y: MARGIN, cx: SIDE_PANEL, cy: SLIDE.h - 2 * MARGIN }, area: { x: MARGIN, y: MARGIN, cx: SLIDE.w - 3 * MARGIN - SIDE_PANEL, cy: SLIDE.h - 2 * MARGIN } };
  if (!(w > 0 && h > 0)) return { ...top, pic: null };
  const a = fitIn(top.area, w, h); const b = fitIn(side.area, w, h);
  return b.scale > a.scale ? { ...side, pic: b } : { ...top, pic: a };
}

// ---------- XML 片段 ----------
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const FONT = '<a:latin typeface="Arial"/><a:cs typeface="Arial"/>';
const run = (text, sz, o = {}) => `<a:r><a:rPr lang="${o.lang || 'en-US'}" sz="${sz}"${o.b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${o.color || '222222'}"/></a:solidFill>${FONT}</a:rPr><a:t>${esc(text)}</a:t></a:r>`;
const para = (runs, o = {}) => `<a:p><a:pPr algn="${o.algn || 'l'}">${o.after ? `<a:spcAft><a:spcPts val="${o.after}"/></a:spcAft>` : ''}</a:pPr>${runs}</a:p>`;
const textBox = (id, name, box, paras, anchor = 't') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
const picture = (id, name, descr, rid, b) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}" descr="${esc(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.cx}" cy="${b.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
const slideXml = (shapes) => `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

export const fmtAmount = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '');
export const fmtDay = (s) => (s ? String(s).replace(/-/g, '/') : '');

export function coverSlide(c, L) {
  const w = SLIDE.w - 2 * 914400;
  const period = `${fmtDay(c.from)} – ${fmtDay(c.to)}`;
  const shapes = textBox(2, 'Title', { x: 914400, y: 2100000, cx: w, cy: 1300000 }, para(run(clip(c.title, 80), 4400, { b: 1, lang: c.lang }), { algn: 'ctr' }), 'b')
    + textBox(3, 'Period', { x: 914400, y: 3600000, cx: w, cy: 600000 }, para(run(period, 2800, { color: '444444' }), { algn: 'ctr' }))
    + textBox(4, 'Count', { x: 914400, y: 4300000, cx: w, cy: 500000 }, para(run(L.count, 1800, { color: '777777', lang: c.lang }), { algn: 'ctr' }));
  return { xml: slideXml(shapes), image: null };
}

// 收據頁：s = { no, date, category, amount, currency, ntd, desc, part, parts, image:{bytes,ext,w,h}|null }
export function receiptSlide(s, L) {
  const lay = layoutFor(s.image ? s.image.w : 0, s.image ? s.image.h : 0);
  const amount = `${fmtAmount(s.amount)} ${s.currency || ''}`.trim();
  const page = s.parts > 1 ? ` (${s.part}/${s.parts})` : '';
  const showNtd = s.currency && s.currency !== 'NTD' && Number.isFinite(s.ntd);
  let texts;
  if (lay.mode === 'top') {
    const line1 = `${fmtDay(s.date)}   |   ${s.category}   |   ${amount}`;
    const line2 = `${L.no} ${s.no}${page}${showNtd ? `   ·   ≈ NT$ ${fmtAmount(s.ntd)}` : ''}${s.desc ? `   ·   ${clip(s.desc, 200)}` : ''}`;
    texts = textBox(2, 'Info', lay.text, para(run(line1, 2400, { b: 1 }), { after: 400 }) + para(run(line2, 1400, { color: '444444' })));
  } else {
    const lv = (label, value, big) => para(run(label, 1100, { color: '888888' }), {}) + para(run(value, big ? 2200 : 1600, { b: big }), { after: 900 });
    texts = textBox(2, 'Info', lay.text,
      lv(L.no, `${s.no}${page}`) + lv(L.date, fmtDay(s.date)) + lv(L.category, s.category)
      + lv(L.amount, amount, true) + (showNtd ? lv(L.ntd, `NT$ ${fmtAmount(s.ntd)}`) : '')
      + (s.desc ? lv(L.desc, clip(s.desc, 260)) : ''));
  }
  const body = s.image && lay.pic
    ? picture(3, `Receipt ${s.no}`, `${fmtDay(s.date)} ${s.category} ${amount}`, 'rId2', lay.pic)
    : textBox(3, 'NoPhoto', lay.area, para(run(L.noPhoto, 1800, { color: 'B45309' }), { algn: 'ctr' }), 'ctr');
  return { xml: slideXml(texts + body), image: s.image || null };
}

// ---------- 固定零件：theme / master / layout ----------
const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Receipts"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const lvl = (sz) => `<a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`;
const MASTER = `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${lvl(4400)}</p:titleStyle><p:bodyStyle>${lvl(2800)}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvl(1800)}</p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const REL = (items) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join('')}</Relationships>`;

// data = { title, from, to, lang, slides:[…receipt 資料], labels }；回傳 { bytes, pages }
export async function buildPptxBytes(JSZip, data) {
  const L = data.labels;
  const pages = [coverSlide({ title: data.title, from: data.from, to: data.to, lang: data.lang }, { count: L.count })];
  for (const s of data.slides) pages.push(receiptSlide(s, L));
  const z = new JSZip(); const opt = { compression: 'DEFLATE', createFolders: false };
  const media = []; // { name, bytes, ext }
  const slideRels = pages.map((p, i) => {
    const rels = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    if (p.image) { const name = `image${media.length + 1}.${p.image.ext === 'png' ? 'png' : 'jpeg'}`; media.push({ name, bytes: p.image.bytes, ext: p.image.ext }); rels.push(['rId2', 'image', `../media/${name}`]); }
    return rels;
  });
  const exts = new Set(media.map((m) => (m.ext === 'png' ? 'png' : 'jpeg')));
  const ct = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.has('jpeg') ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : ''}${exts.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : ''}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${pages.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;
  z.file('[Content_Types].xml', ct, opt);
  z.file('_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`, opt);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  z.file('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(data.title)}</dc:title><dc:creator>Trip Expenses</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`, opt);
  z.file('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Trip Expenses</Application><Slides>${pages.length}</Slides></Properties>`, opt);
  z.file('ppt/presentation.xml', `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SLIDE.w}" cy="${SLIDE.h}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`, opt);
  z.file('ppt/_rels/presentation.xml.rels', REL([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...pages.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`]), [`rId${pages.length + 2}`, 'presProps', 'presProps.xml'], [`rId${pages.length + 3}`, 'viewProps', 'viewProps.xml'], [`rId${pages.length + 4}`, 'theme', 'theme/theme1.xml'], [`rId${pages.length + 5}`, 'tableStyles', 'tableStyles.xml']]), opt);
  z.file('ppt/presProps.xml', `${HEAD}<p:presentationPr ${NS}/>`, opt);
  z.file('ppt/viewProps.xml', `${HEAD}<p:viewPr ${NS}/>`, opt);
  z.file('ppt/tableStyles.xml', `${HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`, opt);
  z.file('ppt/theme/theme1.xml', THEME, opt);
  z.file('ppt/slideMasters/slideMaster1.xml', MASTER, opt);
  z.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', REL([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]), opt);
  z.file('ppt/slideLayouts/slideLayout1.xml', LAYOUT, opt);
  z.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', REL([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]), opt);
  pages.forEach((p, i) => { z.file(`ppt/slides/slide${i + 1}.xml`, p.xml, opt); z.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, REL(slideRels[i]), opt); });
  for (const m of media) z.file(`ppt/media/${m.name}`, m.bytes, { compression: 'STORE', createFolders: false });
  const bytes = await z.generateAsync({ type: 'uint8array', mimeType: PPTX_MIME });
  return { bytes, pages: pages.length };
}

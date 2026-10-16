/**
 * 在 Node 里跑插件里的纯函数：把 PDF 的文字层 / 矢量公式检测 / 版面分析 / 识别流程整条链路跑一遍。
 * 浏览器里跑的是同一份代码，这里只是把 pdf.js 和 canvas 换成 Node 版本。
 *
 *   node tools/harness.cjs <pdf> [--engine text|auto|ai] [--pages 1,2] [--strip out.png]
 *                            [--out out.md] [--dump-pages]
 *
 * --fake-ai 用一个假的 chat 回复来模拟视觉模型：
 *     {"strip": ["$n$", "$i$", …]}            —— 所有页共用（按编号顺序）
 *     {"strip": {"1": […], "2": […]}}         —— 每页一套：页码 → 第 i 块 LaTeX
 *     {"page": "整页正文"}                     —— 整页识别时返回的正文
 *   现成的“标准答案”见 tools/fixtures/p2196-answers.json（人工核对过那份 PDF）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// pdf.js 的 Node 版自己会去 require('canvas')（渲染页面时要用它的 DOMMatrix / Path2D / createCanvas）。
// 这里在 node_modules 里放一个转发到 @napi-rs/canvas 的小垫片，渲染就能在 Node 里真跑。
function ensureCanvasShim() {
  const fsx = require('fs');
  const dir = path.join(ROOT, 'node_modules', 'canvas');
  try {
    require.resolve('canvas', { paths: [ROOT] });
    return;
  } catch (e) { /* 没装：下面自己造一个 */ }
  fsx.mkdirSync(dir, { recursive: true });
  fsx.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'canvas', version: '0.0.0-shim', main: 'index.js' }));
  fsx.writeFileSync(path.join(dir, 'index.js'), "module.exports = require('@napi-rs/canvas');\n");
}
const napi = require('@napi-rs/canvas');
globalThis.DOMMatrix = napi.DOMMatrix;
globalThis.Path2D = napi.Path2D;
globalThis.ImageData = napi.ImageData;
ensureCanvasShim();

const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const plugin = require(path.join(ROOT, 'goj-pdf-to-markdown.user.js'));
plugin.setCanvasFactory((w, h) => napi.createCanvas(w, h));      // 让插件里的裁图逻辑在 Node 里也能真跑

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}

const OPS = pdfjs.OPS || {};
const OP_NAME = [];
for (const k of Object.keys(OPS)) if (typeof OPS[k] === 'number') OP_NAME[OPS[k]] = k;
const nameOf = (i) => OP_NAME[i] || '';
const IMAGE_OPS = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject', 'paintImageXObjectRepeat']
  .map((k) => OPS[k]).filter((v) => typeof v === 'number'));

const makeCanvas = (w, h) => napi.createCanvas(Math.max(1, w), Math.max(1, h));

const canvasToBlob = (canvas, type) => new Promise((resolve) => {
  const buf = canvas.toBuffer(type === 'image/jpeg' ? 'image/jpeg' : 'image/png');
  resolve({ size: buf.length, type: type || 'image/png', arrayBuffer: async () => buf });
});
const blobToDataUrl = async (blob, mime) => `data:${mime || blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;

/** 与插件运行时 loadPdf() 里的 handle 保持一致。 */
async function makeHandle(bytes) {
  const CMAP_DIR = path.join(ROOT, 'node_modules/pdfjs-dist/cmaps/');
  const STD_FONTS = path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/');
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false, disableFontFace: true, enableXfa: false, verbosity: 0,
    cMapUrl: CMAP_DIR, cMapPacked: true, standardFontDataUrl: STD_FONTS,
  }).promise;
  const holeCache = {};
  const renderPageOf = (page) => async (scale) => {
    const vp = page.getViewport({ scale });
    const canvas = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return canvas;
  };
  return {
    numPages: doc.numPages,
    hash: plugin.hashBytes(bytes),
    size: bytes.length,
    async pageText(n) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const fonts = {};
        let images = 0;
        let vecBoxes = 0;
        try {
          const ops = await page.getOperatorList();
          for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
          for (const id of Object.keys(tc.styles || {})) if (page.commonObjs.has(id)) fonts[id] = plugin.classifyFont(page.commonObjs.get(id).name);
          vecBoxes = plugin.paintedBoxes(ops, viewport, nameOf).filter((b) => plugin.isGlyphBox(b, 10)).length;
        } catch (e) { /* 忽略 */ }
        const spans = plugin.spansFromTextContent(tc.items, viewport, fonts);
        const stats = plugin.pageTextStats(spans);
        let holes = [];
        try {
          const boxes = plugin.paintedBoxes(await page.getOperatorList(), viewport, nameOf);
          holes = plugin.findHoles(spans, boxes, { width: viewport.width, height: viewport.height });
        } catch (e) { console.error('findHoles failed', e); }
        holeCache[n] = holes;
        return { width: viewport.width, height: viewport.height, spans: plugin.markHoles(spans, holes, n), chars: stats.chars, bad: stats.bad, garbled: stats.garbled, images, holes, vecBoxes };
      } finally { page.cleanup(); }
    },
    async pageImage(n) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(1600 / v1.width, 6);
        const canvas = await renderPageOf(page)(scale);
        const blob = await canvasToBlob(canvas, 'image/png');
        return { dataUrl: await blobToDataUrl(blob, 'image/png'), width: canvas.width, height: canvas.height, bytes: blob.size };
      } finally { page.cleanup(); }
    },
    async holeStrip(n, holes) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const out = await plugin.holeStripCanvas(renderPageOf(page), holes, { width: v1.width, height: v1.height });
        if (!out) return null;
        if (process.env.DUMP_STRIP) {
          fs.writeFileSync(process.env.DUMP_STRIP.replace('{n}', n), out.canvas.toBuffer('image/png'));
        }
        const blob = await canvasToBlob(out.canvas, 'image/png');
        return { dataUrl: await blobToDataUrl(blob, 'image/png'), used: out.used, bytes: blob.size };
      } finally { page.cleanup(); }
    },
    async holeCrops(n, idxs) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const picked = idxs.map((i) => (holeCache[n] || [])[i]).filter(Boolean);
        const canvases = await plugin.holeCropCanvases(renderPageOf(page), picked, { width: v1.width, height: v1.height });
        const urls = [];
        for (const c of canvases) urls.push(await blobToDataUrl(await canvasToBlob(c, 'image/png'), 'image/png'));
        return urls;
      } finally { page.cleanup(); }
    },
    destroy() { try { doc.destroy(); } catch (e) { /* 忽略 */ } },
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node tools/harness.cjs <pdf> [--engine text|auto|ai] [--fake-ai json] [--out out.md]');
    process.exit(2);
  }
  const bytes = new Uint8Array(fs.readFileSync(file));
  const engine = arg('engine', 'auto');
  const fakeAi = JSON.parse(arg('fake-ai', '{}'));
  const logLines = [];
  const calls = [];
  const handle = await makeHandle(bytes);
  const dumpPages = process.argv.includes('--dump-pages');
  const storage = new Map();
  const deps = {
    storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
    ui: { log: (...a) => logLines.push(a.join(' ')), state: () => {}, result: () => {} },
    sleep: async () => {},
    // 假的视觉模型：按“页码 → 每块 LaTeX”返回；整页识别时返回一段占位正文
    http: async (opts) => {
      const body = JSON.parse(opts.data);
      const isStrip = /编号/.test(JSON.stringify(body.messages));
      const pageArg = /(\d+)\/(\d+) 页/.exec(body.messages[0].content[0].text);
      calls.push(isStrip ? 'strip' : `page${pageArg ? pageArg[1] : '?'}`);
      let text = '';
      if (isStrip) {
        const want = Number(/(\d+) 块/.exec(body.messages[0].content[0].text)[1]);
        // strip 可以是数组（所有页共用），也可以是 { "页码": [每块 LaTeX] }。
        // 拼图请求里只有块数、没有页码，所以对象形式优先按“哪一页正好有这么多块”来选。
        const all = fakeAi.strip;
        let list = [];
        if (Array.isArray(all)) list = all;
        else if (all) {
          const same = Object.keys(all).find((k) => Array.isArray(all[k]) && all[k].length === want);
          const byPage = pageArg && all[pageArg[1]];
          list = (same && all[same]) || (Array.isArray(byPage) ? byPage : []) || Object.values(all).find(Array.isArray) || [];
        }
        for (let i = 1; i <= want; i++) text += `${i}. ${list[i - 1] || '?'}\n`;
      } else {
        text = fakeAi.page || '（假装这是模型转写出来的整页正文）';
      }
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) };
    },
  };
  if (dumpPages) {
    for (let k = 1; k <= handle.numPages; k++) {
      const p = await handle.pageText(k);
      console.log(`\n===== 第 ${k} 页：chars=${p.chars} bad=${p.bad} images=${p.images} vecBoxes=${p.vecBoxes} holes=${p.holes.length} =====`);
      p.holes.forEach((h, i) => console.log(`   #${i} ${h.inline ? '行内' : '独占'} S=${h.S.toFixed(1)} bbox=[${h.x0.toFixed(1)},${h.y0.toFixed(1)},${h.x1.toFixed(1)},${h.y1.toFixed(1)}] “${h.after}”…“${h.before}”`));
      console.log(plugin.layoutDocument([p], {}));
    }
  }
  const out = await plugin.recognizePdf({
    handle,
    engine,
    cfg: Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: fakeAi ? 'https://example.com/v1' : '', apiKey: fakeAi ? 'sk-x' : '', model: fakeAi ? 'fake-vl' : '' }),
    title: '葫芦娃救爷爷',
    pid: 'P2196',
    auto: false,
    progress: (t) => logLines.push(`[进度] ${t}`),
  }, deps);
  console.log(logLines.join('\n'));
  console.log(`\n=========== 引擎：${out.engine}，AI 页数：${out.aiPages}，请求：${calls.join(',') || '无'} ===========`);
  if (out.notes && out.notes.length) console.log('提示：\n  ' + out.notes.join('\n  '));
  const outFile = arg('out', '');
  if (outFile) fs.writeFileSync(outFile, out.body, 'utf8');
  console.log('\n' + out.body);
}

main().catch((e) => { console.error(e); process.exit(1); });

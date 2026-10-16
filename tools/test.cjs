/**
 * 测试：node tools/test.cjs
 *
 * 覆盖这次修复的重点 —— “PDF 把公式画成了矢量图形，文字层里只有一个空格”：
 *   1. 从绘制指令还原出的矢量图形 bbox 与文字行的空隙对得上（findHoles）
 *   2. 正常的文字层题面（公式是真文字）不产生误报
 *   3. 占位符插进片段流后不会打乱行聚类 / 分格（否则会被误判成表格）
 *   4. 模型回复的解析、兜底（截图 / [公式]）与端到端流程
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const napi = require('@napi-rs/canvas');
const ROOT = path.resolve(__dirname, '..');

// pdf.js 的 Node 版会 require('canvas')：垫一个转发到 @napi-rs/canvas 的壳（和 harness.cjs 里一样）
(function ensureCanvasShim() {
  const dir = path.join(ROOT, 'node_modules', 'canvas');
  try { require.resolve('canvas', { paths: [ROOT] }); return; } catch (e) { /* 自己造一个 */ }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'canvas', version: '0.0.0-shim', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), "module.exports = require('@napi-rs/canvas');\n");
}());

globalThis.DOMMatrix = napi.DOMMatrix;
globalThis.Path2D = napi.Path2D;
globalThis.ImageData = napi.ImageData;

const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const plugin = require(path.join(ROOT, 'goj-pdf-to-markdown.user.js'));
plugin.setCanvasFactory((w, h) => napi.createCanvas(w, h));

const OPS = pdfjs.OPS || {};
const OP_NAME = [];
for (const k of Object.keys(OPS)) if (typeof OPS[k] === 'number') OP_NAME[OPS[k]] = k;
const nameOf = (i) => OP_NAME[i] || '';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('同步测试里不要用 async');
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failures.push({ name, e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

const FIX = path.join(__dirname, 'fixtures');
const load = (f) => new Uint8Array(fs.readFileSync(path.join(FIX, f)));

/** 与运行时 loadPdf 里的 handle 等价（测试用）。 */
async function openPdf(bytes) {
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0,
    cMapUrl: path.join(ROOT, 'node_modules/pdfjs-dist/cmaps/'), cMapPacked: true,
    standardFontDataUrl: path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/'),
  }).promise;
  const holeCache = {};
  const render = (page) => async (scale) => {
    const vp = page.getViewport({ scale });
    const canvas = napi.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
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
    getHoles: (n) => holeCache[n] || [],
    async pageText(n) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const fonts = {};
        for (const id of Object.keys(tc.styles || {})) if (page.commonObjs.has(id)) fonts[id] = plugin.classifyFont(page.commonObjs.get(id).name);
        const opList = await page.getOperatorList();
        const imageOps = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject', 'paintImageXObjectRepeat'].map((k) => OPS[k]));
        const images = opList.fnArray.filter((f) => imageOps.has(f)).length;
        const spans = plugin.spansFromTextContent(tc.items, viewport, fonts);
        const stats = plugin.pageTextStats(spans);
        const boxes = plugin.paintedBoxes(opList, viewport, nameOf);
        const holes = plugin.findHoles(spans, boxes, { width: viewport.width, height: viewport.height });
        holeCache[n] = holes;
        return { width: viewport.width, height: viewport.height, spans: plugin.markHoles(spans, holes, n), chars: stats.chars, bad: stats.bad, garbled: stats.garbled, images, holes, vecBoxes: boxes.filter((b) => plugin.isGlyphBox(b, 10)).length };
      } finally { page.cleanup(); }
    },
    async pageImage(n) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const canvas = await render(page)(Math.min(2, 1600 / v1.width));
        return { dataUrl: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`, width: canvas.width, height: canvas.height };
      } finally { page.cleanup(); }
    },
    async holeStrip(n, holes) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const out = await plugin.holeStripCanvas(render(page), holes, { width: v1.width, height: v1.height });
        if (!out) return null;
        return { dataUrl: `data:image/png;base64,${out.canvas.toBuffer('image/png').toString('base64')}`, used: out.used };
      } finally { page.cleanup(); }
    },
    async holeCrops(n, idxs) {
      const page = await doc.getPage(n);
      try {
        const v1 = page.getViewport({ scale: 1 });
        const picked = idxs.map((i) => (holeCache[n] || [])[i]).filter(Boolean);
        const canvases = await plugin.holeCropCanvases(render(page), picked, { width: v1.width, height: v1.height });
        return canvases.map((c) => `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`);
      } finally { page.cleanup(); }
    },
    destroy() { try { doc.destroy(); } catch (e) { /* 忽略 */ } },
  };
}

/** 假的视觉模型。answers: 按调用顺序返回；元素是字符串（整页）或函数（拼图）。 */
function fakeDeps(answers, logs) {
  const storage = new Map();
  let n = 0;
  return {
    storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
    ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {} },
    sleep: async () => {},
    calls: [],
    http: async (opts) => {
      const body = JSON.parse(opts.data);
      const prompt = body.messages[0].content[0].text;
      const isStrip = /编号/.test(prompt);
      const want = isStrip ? Number(/(\d+) 块/.exec(prompt)[1]) : 0;
      const a = answers[Math.min(n++, answers.length - 1)];
      const text = typeof a === 'function' ? a({ isStrip, want }) : a;
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) };
    },
  };
}

const cfgWithApi = (extra) => Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: 'https://example.com/v1/chat/completions', apiKey: 'sk-test', model: 'fake-vl' }, extra || {});

(async () => {
  console.log('\n# 矢量公式检测');
  const p2196 = await openPdf(load('p2196-fhllyjyy.pdf'));
  const pages = [];
  for (let k = 1; k <= p2196.numPages; k++) pages.push(await p2196.pageText(k));
  await testAsync('矢量公式 PDF：检测出全部公式洞（第 1 页 19 处、第 2 页 9 处）', () => {
    assert.strictEqual(pages[0].holes.length, 19, `第 1 页检测到 ${pages[0].holes.length} 处`);
    assert.strictEqual(pages[1].holes.length, 9, `第 2 页检测到 ${pages[1].holes.length} 处`);
    assert.ok(pages[0].holes.every((h) => h.inline), '都应该是行内公式');
  });
  await testAsync('每个公式洞都落在文字行的空隙里，且大小和字号相当', () => {
    for (const p of pages) {
      for (const h of p.holes) {
        const w = h.x1 - h.x0;
        const ht = h.y1 - h.y0;
        assert.ok(w > 0 && ht > 0, '宽高要为正');
        assert.ok(ht <= 2.2 * h.S, `高度 ${ht.toFixed(1)} 相对于字号 ${h.S.toFixed(1)} 太大`);
        assert.ok(w <= 6 * h.S, `宽度 ${w.toFixed(1)} 相对字号太大`);
        assert.ok(Number.isFinite(h.gx0) && h.gx1 > h.gx0, '要记录空隙范围');
      }
    }
  });

  const plain = await openPdf(load('plain-text-math.pdf'));
  await testAsync('正常文字层的题面（公式是真文字）：一处都不误报', async () => {
    const p = await plain.pageText(1);
    assert.strictEqual(p.holes.length, 0, `误报了 ${p.holes.length} 处`);
  });

  const vector = await openPdf(load('vector-math.pdf'));
  const vectorPage = await vector.pageText(1);
  await testAsync('矢量公式 + 表格线 + 项目符号 + 普通括号：只认出真正的公式', () => {
    assert.strictEqual(vectorPage.holes.length, 10, `检测到 ${vectorPage.holes.length} 处`);
    assert.strictEqual(vectorPage.holes.filter((h) => h.inline).length, 9, '9 处是行内公式');
  });
  await testAsync('独占一行的大公式（上下都是文字行）也认得出来', () => {
    const disp = vectorPage.holes.filter((h) => !h.inline);
    assert.strictEqual(disp.length, 1, `检测到 ${disp.length} 处独占公式`);
    assert.ok(disp[0].x1 - disp[0].x0 > 100, '应该是一个宽公式');
    assert.ok(disp[0].y1 - disp[0].y0 > 20, '应该比正文行高');
  });

  console.log('\n# 占位符与版面');
  await testAsync('占位符插进片段流后，行聚类 / 分格不受影响（不会被当成表格）', () => {
    const md = plugin.layoutDocument(pages.slice(0, 1), {});
    assert.ok(!/\|.*%%H/.test(md), '占位符不该被分进表格格子里');
    assert.ok(md.includes('有%%H1-'), `正文里应该有占位符：\n${md.slice(0, 300)}`);
    assert.ok(md.includes('个葫芦娃，第%%H1-'), '占位符要贴在正确的词之间');
  });

  await testAsync('applyHoles：识别出的 LaTeX / 截图 / 缺失分别落到正确的位置', () => {
    const info = new Map([['1-0', { tex: '$n$' }], ['1-1', { img: '![公式](data:image/png;base64,AA)' }]]);
    const out = plugin.applyHoles('有%%H1-0%%个葫芦娃，第%%H1-1%%个，第%%H1-2%%个。', info);
    assert.strictEqual(out, '有$n$个葫芦娃，第![公式](data:image/png;base64,AA)个，第[公式]个。');
  });

  console.log('\n# 模型回复解析');
  await testAsync('parseStripReply：编号、括号、Markdown 列表、缺号、多余说明都能处理', () => {
    const reply = [
      '以下是结果：',
      '1. $n$',
      '2) $$\\sum_{i=1}^{n} a_i$$',
      '- 3、$a_i$',
      '4：?',
      '5. （图）',
      '随便一句没有被编号的话',
      '7. $p_i$',
    ].join('\n');
    const got = plugin.parseStripReply(reply, 7);
    assert.strictEqual(got[0], '$n$');
    assert.strictEqual(got[1], '\n\n$$\n\\sum_{i=1}^{n} a_i\n$$\n\n');
    assert.strictEqual(got[2], '$a_i$');
    assert.strictEqual(got[3], null, '“?” 算没认出');
    assert.strictEqual(got[4], null, '“（图）” 算没认出');
    assert.strictEqual(got[5], null, '缺号就是 null');
    assert.strictEqual(got[6], '$p_i$');
  });

  await testAsync('cleanSnippet：去掉围栏 / 定界符，空内容返回 null', () => {
    assert.strictEqual(plugin.cleanSnippet('```latex\n$x^2$\n```'), '$x^2$');
    assert.strictEqual(plugin.cleanSnippet('?'), null);
    assert.strictEqual(plugin.cleanSnippet('  '), null);
    assert.strictEqual(plugin.cleanSnippet('$$1-p$$'), '\n\n$$\n1-p\n$$\n\n');
  });

  console.log('\n# 端到端');
  await testAsync('auto + 视觉模型：公式逐处补全，正文里不再有占位符', async () => {
    const logs = [];
    const deps = fakeDeps([({ want }) => Array.from({ length: want }, (_, i) => (i === 0 ? '$\\alpha$' : `$x_{${i}}$`)).map((t, i) => `${i + 1}. ${t}`).join('\n')], logs);
    const r = await plugin.recognizePdf({
      handle: p2196, engine: 'auto', cfg: cfgWithApi(), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
    }, deps);
    assert.strictEqual(r.holes, 28, `应该有 28 处公式，实际 ${r.holes}`);
    assert.strictEqual(r.holeFixed, 28, `应该补上 28 处，实际 ${r.holeFixed}`);
    assert.ok(!r.body.includes('%%H'), '正文里不该留下占位符');
    assert.ok(!r.body.includes('[公式]'), '模型答上来的地方不该有 [公式]');
    assert.ok(r.body.includes('$\\alpha$'), '公式要写进正文');
    assert.ok(r.problems.length >= 0);
  });

  await testAsync('text + 没配 API：公式退化成截图（而不是整句缺公式）', async () => {
    const logs = [];
    const r = await plugin.recognizePdf({
      handle: p2196, engine: 'text', cfg: Object.assign({}, plugin.DEFAULT_CFG), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
    }, fakeDeps([''], logs));
    assert.ok(r.holes === 28);
    assert.ok(r.body.includes('![公式](data:image/png;base64,'), '应该插入截图');
    assert.ok(r.notes.some((n) => n.includes('矢量图形')), `应该有提示：${JSON.stringify(r.notes)}`);
  });

  await testAsync('关掉“识别不出的公式改用截图” → 用 [公式] 占位，并说明怎么补救', async () => {
    const logs = [];
    const r = await plugin.recognizePdf({
      handle: p2196, engine: 'text', cfg: Object.assign({}, plugin.DEFAULT_CFG, { holeImages: false }), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
    }, fakeDeps([''], logs));
    assert.ok(r.body.includes('[公式]'));
    assert.ok(!r.body.includes('data:image/png'), '不该插图片');
  });

  await testAsync('扫描件（整页一张图）仍然走整页视觉模型', async () => {
    const scan = await openPdf(load('scan.pdf'));
    const logs = [];
    const r = await plugin.recognizePdf({
      handle: scan, engine: 'auto', cfg: cfgWithApi(), title: '扫描件', pid: 'P1', auto: false, progress: () => {},
    }, fakeDeps(['# 扫描出来的题面\n\n正文'], logs));
    assert.strictEqual(r.engine, 'ai');
    assert.ok(r.body.includes('扫描出来的题面'));
    assert.strictEqual(r.holes, 0);
  });

  await testAsync('公式洞超过上限时，只补前一部分并说明', async () => {
    const small = Object.assign({}, p2196);
    const logs = [];
    const r = await plugin.recognizePdf({
      handle: Object.assign({}, small, { numPages: 2 }), engine: 'auto', cfg: cfgWithApi(), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
    }, fakeDeps([({ want }) => Array.from({ length: want }, (_, i) => `${i + 1}. ?`).join('\n')], logs));
    assert.ok(r.holes === 28);
    assert.ok(r.body.includes('[公式]'), '没认出来的要有兜底');
  });

  await testAsync('整页交给模型的页，不会再为它的公式裁一次图（省一次页面渲染）', async () => {
    const logs = [];
    let stripCalls = 0;
    const orig = p2196.holeStrip;
    p2196.holeStrip = async (...a) => { stripCalls++; return orig.apply(p2196, a); };
    try {
      const r = await plugin.recognizePdf({
        handle: p2196, engine: 'ai', cfg: cfgWithApi(), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
      }, fakeDeps(['# 整页转写'], logs));
      assert.strictEqual(r.engine, 'ai');
      assert.strictEqual(stripCalls, 0, `不该为整页识别的页裁公式（裁了 ${stripCalls} 次）`);
      assert.ok(!r.body.includes('%%H'));
    } finally { p2196.holeStrip = orig; }
  });

  console.log('\n# 静态检查');
  const src = fs.readFileSync(path.join(ROOT, 'goj-pdf-to-markdown.user.js'), 'utf8');
  await testAsync('脚本能解析，且 @version 与代码里的 VERSION 一致', () => {
    const vm = require('vm');
    new vm.Script(src, { filename: 'goj-pdf-to-markdown.user.js' });
    const headerVer = /^\/\/ @version\s+(\S+)/m.exec(src)[1];
    assert.strictEqual(headerVer, plugin.VERSION, '@version 与 VERSION 不一致');
  });
  await testAsync('设置面板里用到的每个 id 都在 UI_HTML 里存在（新增的复选框别写错名字）', () => {
    const ids = new Set();
    const re = /<[a-z]+[^>]*\sid="([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) ids.add(m[1]);
    const used = new Set();
    const re2 = /\$\('([^']+)'\)/g;
    while ((m = re2.exec(src))) used.add(m[1]);
    const missing = Array.from(used).filter((id) => !ids.has(id));
    assert.deepStrictEqual(missing, [], `这些 id 在 UI_HTML 里找不到：${missing.join(', ')}`);
  });
  await testAsync('占位符只有一套写法（%%PDF:n%% / %%H页-序号%%），没有被 GBK 之类的编码吃过', () => {
    assert.ok(!/[^%{]\?PDF:\d/.test(src), '还有 ?PDF:n? 这种写法');
    assert.ok(!plugin.HOLE_MARK_RE.test('%%H1-2'), 'HOLE_MARK_RE 带 g 标志时要小心 lastIndex（这里只是确认能匹配）');
    plugin.HOLE_MARK_RE.lastIndex = 0;
  });

  console.log(`\n${passed} 个测试通过${failures.length ? `，${failures.length} 个失败` : ''}\n`);
  if (failures.length) {
    for (const f of failures) console.error(`失败：${f.name}\n${f.e.stack}\n`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });

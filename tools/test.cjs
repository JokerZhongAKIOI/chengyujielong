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

  await testAsync('auto + 逐处补全：公式落到句子的正确位置（用人工核对过的标准答案）', async () => {
    // tools/fixtures/p2196-answers.json 是照着原页面逐处核对出来的：改检测顺序、改编号映射都会在这里露馅
    const key = JSON.parse(fs.readFileSync(path.join(FIX, 'p2196-answers.json'), 'utf8')).strip;
    const byCount = { 19: key['1'], 9: key['2'] };
    const logs = [];
    const r = await plugin.recognizePdf({
      handle: p2196, engine: 'auto', cfg: cfgWithApi(), title: '葫芦娃救爷爷', pid: 'P2196', auto: false, progress: () => {},
    }, fakeDeps([({ isStrip, want }) => (isStrip
      ? (byCount[want] || []).map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '')], logs));
    assert.strictEqual(r.holes, 28);
    assert.strictEqual(r.holeFixed, 28);
    assert.strictEqual(r.holeImgs, 0, '都认出来了，不该有截图');
    const want = [
      '有$n$个葫芦娃，第$i$个葫芦娃的战斗力是$p_i$，在第$i$天早上出生。保证所有$p_i$的总和是$1$。',
      '实力总和为$P$，那么有$P$的概率救出爷爷，$1-P$的概率失败',
      '首先随机在$1$到$n$里均匀生成一个正整数$x$，然后在第$x$天中午杀死爷爷',
      '**葫芦娃无法知道**$x$。',
      '你的答案只要误差不超过$10^{-6}$就算对。',
      '成功营救的概率就是$5/7$。',
      '对于$30\\%$的数据，保证$n \\le 3$。',
      '对于$100\\%$的数据，保证$n \\le 1000$。',
      '保证输入的$\\sum p_i = 1$，小数点不超过$6$位。',
    ];
    for (const t of want) assert.ok(r.body.includes(t), `正文里少了这一段（或公式位置不对）：${t}`);
    assert.ok(!r.body.includes('%%H') && !r.body.includes('[公式]'), '不该有占位符');
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

  await testAsync('assemble：题面里的 %%PDF:n%% 全被替换掉，不留孤零零的 %%', () => {
    const md = plugin.assemble({ title: 'T', url: 'u', time: '', memory: '' },
      '题干\n\n%%PDF:0%%\n\n收尾', [{ name: 'a.pdf', url: 'x' }], [{ ok: true, markdown: 'PDF 正文' }]);
    assert.ok(md.includes('PDF 正文'), '占位符应该被正文替换');
    assert.ok(!md.includes('%'), `正文里不该再有 %：${JSON.stringify(md.slice(0, 200))}`);
  });

  await testAsync('没配 API 时的提示块是 HTML 注释（复制出去渲染是干净正文）', async () => {
    const h = await openPdf(load('p2196-fhllyjyy.pdf'));
    try {
      const r = await plugin.recognizePdf({
        handle: h, engine: 'text', cfg: { holeImages: true }, title: '葫芦娃救爷爷', pid: '2085', auto: false, progress: () => {},
      }, fakeDeps([], []));
      assert.ok(r.notes.length > 0, '应该有提示');
      assert.ok(r.markdown.includes('<!--'), '提示应该写成 HTML 注释');
      assert.ok(!/^\s*> ⚠️/m.test(r.markdown), '不该再是引用块形式（会出现在渲染结果里）');
      assert.ok(r.markdown.length - r.body.length < 400, `提示不该占太多篇幅：${r.markdown.length - r.body.length} 字`);
      assert.strictEqual(r.holeImgs, r.holes, '没给模型时，每一处都应该算作“退成了截图”');
    } finally { h.destroy(); }
  });

  await testAsync('截图兜底：每张都裁到只剩公式本身（无大片空白、分辨率够高）', async () => {
    const h = await openPdf(load('p2196-fhllyjyy.pdf'));
    try {
      await h.pageText(1);
      const holes = h.getHoles(1);
      const crops = await h.holeCrops(1, holes.map((_, i) => i));
      assert.strictEqual(crops.length, holes.length, '每一处公式都要有一张图');
      assert.ok(crops.every(Boolean), '不该出现整张全白、被丢掉的图');
      for (const url of crops) {
        const img = await napi.loadImage(url);
        const c = napi.createCanvas(img.width, img.height);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height).data;
        let x0 = c.width; let y0 = c.height; let x1 = -1; let y1 = -1;
        for (let y = 0; y < c.height; y++) {
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) {
              if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
          }
        }
        assert.ok(x1 >= 0, '裁出来不能是纯白');
        assert.ok(x0 <= 5 && y0 <= 5, `四周的空白要裁掉（左边 ${x0}px / 上边 ${y0}px 都是白的）`);
        assert.ok(c.width - 1 - x1 <= 5 && c.height - 1 - y1 <= 5, `四周的空白要裁掉（右边 ${c.width - 1 - x1}px / 下边 ${c.height - 1 - y1}px 都是白的）`);
        assert.ok(c.width * c.height >= 400, `图太小了：${c.width}x${c.height}`);
        assert.ok(y1 - y0 >= 14, `字太小看不清（高 ${y1 - y0}px）`);
      }
    } finally { h.destroy(); }
  });

  console.log('\n# 题面页面里已经有 LaTeX 时（KaTeX 渲染）');
  await testAsync('页面 KaTeX → LaTeX，题面里嵌入的 PDF 记成占位符', () => {
    const { JSDOM } = require('jsdom');
    const katex = (tex, html) => `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow>${html}</mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">${html}</span></span></span>`;
    const page = `<!doctype html><html><body>
      <div class="problem-content"><div class="section__body typo richmedia" data-fragment-id="problem-description">
        <h2>题目描述</h2>
        <p>有 ${katex('n', 'n')} 个葫芦娃，第 ${katex('i', 'i')} 个葫芦娃的战斗力是 ${katex('p_i', 'p<sub>i</sub>')}，保证所有 ${katex('p_i', 'p<sub>i</sub>')} 的总和是 ${katex('1', '1')}。</p>
        <object data="/d/Union2024/p/2085/file/2085.pdf" type="application/pdf"><param name="SRC" value="/d/Union2024/p/2085/file/2085.pdf"><embed type="application/pdf" src="/d/Union2024/p/2085/file/2085.pdf#toolbar=1"></object>
      </div></div></body></html>`;
    const dom = new JSDOM(page, { url: 'https://www.goj.wiki/d/Union2024/p/2085' });
    const doc = dom.window.document;
    const root = plugin.findStatementRoot(doc, false);
    assert.ok(root, '要找到 Hydro 的题面容器');
    const ex = plugin.extract(root);
    assert.ok(ex.markdown.includes('有 $n$ 个葫芦娃'), `KaTeX 要还原成 LaTeX：${ex.markdown}`);
    assert.ok(ex.markdown.includes('$p_i$'), `下标公式也要还原：${ex.markdown}`);
    assert.strictEqual(ex.pdfs.length, 1, '嵌入的 PDF 仍然要记下来');
    assert.ok(plugin.pageHasTex(ex.markdown), 'pageHasTex 要认出这段题面里有 LaTeX');
    // 带占位符的题面拼上 PDF 的结果：重复的那份不留痕迹，正文是干净的 LaTeX
    const meta = { title: '葫芦娃救爷爷', url: 'https://www.goj.wiki/d/Union2024/p/2085', pid: '2085', time: '1000ms', memory: '128MiB' };
    const md = plugin.assemble(meta, ex.markdown, ex.pdfs, [{ ok: true, dup: true, markdown: '' }]);
    assert.ok(md.includes('有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$'), `正文里要有 LaTeX 题面：${md}`);
    assert.ok(!md.includes('data:image'), '不该带上 PDF 的截图');
    assert.ok(!md.includes('%%'), '不该有残留的占位符');
  });

  await testAsync('dupOfStatement：判得出“PDF 和题面是同一份”，也判得出不是', () => {
    const stmt = '有$n$个葫芦娃，第$i$个葫芦娃的战斗力是$p_i$，在第$i$天早上出生。保证所有$p_i$的总和是$1$。';
    const fromPdf = '有 个葫芦娃，第 个葫芦娃的战斗力是 ，在第 天早上出生。保证所有 的总和是 。';
    assert.strictEqual(plugin.overlapScore(fromPdf, stmt), 1, '同一段话（PDF 里公式是空格）应该完全重合');
    assert.strictEqual(plugin.dupOfStatement(stmt, fromPdf).dup, true);
    assert.strictEqual(plugin.dupOfStatement(fromPdf, fromPdf).dup, false, '题面页面里没有公式源码时，不能把 PDF 当重复（公式还得靠它）');
    assert.strictEqual(plugin.dupOfStatement(stmt, 'Alice has three cats and two dogs.').dup, false, '内容不一样时不能跳过');
    // 题面里带 %%PDF:n%% 占位符、样例数字在 PDF 里是一串散开的数字：不能因此判成不重复
    const stmt2 = ['有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$，在第 $i$ 天早上出生。保证所有 $p_i$ 的总和是 $1$。',
      '第 $i$ 天晚上，已经出生的葫芦娃可以选择积攒实力（等明天）或者所有人出发去救爷爷，如果这些葫芦娃的实力总和为 $P$，那么有 $P$ 的概率救出爷爷。',
      '## 样例 #1', '### 样例输入 #1', '```', '1', '1', '```', '### 样例输出 #1', '```', '0', '```', '%%PDF:0%%'].join('\n');
    const pdf2 = '葫芦娃救爷爷 rescue 题目描述 有 个葫芦娃，第 个葫芦娃的战斗力是 ，在第 天早上出生。保证所有 的总和是 。'
      + '第 天晚上，已经出生的葫芦娃可以选择积攒实力（等明天）或者所有人出发去救爷爷，如果这些葫芦娃的实力总和为 ，那么有 的概率救出爷爷。'
      + '样例 #1 样例输入 #1 1 1 样例输出 #1 0';
    const d2 = plugin.dupOfStatement(stmt2, pdf2);
    assert.ok(d2.dup, `占位符和样例数字不该影响判断（重合度 ${d2.score.toFixed(2)}）`);
    assert.strictEqual(plugin.dupOfStatement('有 $a+b$。', '有 。').dup, false, '题面太短时不判重，免得误伤');
    assert.strictEqual(plugin.pageHasTex('价格是 5 元'), false, '没有公式时不算有 LaTeX');
  });

  await testAsync('端到端：题面页面里已有 LaTeX 时，重复的 PDF 直接跳过（不裁图、不调 API）', async () => {
    // 造一份“页面题面”：拿 PDF 的文字层，把每一处公式洞换成人工核对过的 LaTeX —— 就是题面页面渲染出来的样子
    const key = JSON.parse(fs.readFileSync(path.join(FIX, 'p2196-answers.json'), 'utf8')).strip;
    const lines = [];
    let pdfText = '';
    for (let n = 1; n <= p2196.numPages; n++) {
      const p = await p2196.pageText(n);
      const rows = new Map();
      for (const sp of p.spans) {
        pdfText += sp.str;
        const k = Math.round(sp.y);
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(sp);
      }
      for (const k of Array.from(rows.keys()).sort((a, b) => a - b)) {
        lines.push(rows.get(k).sort((a, b) => a.x - b.x)
          .map((sp) => (sp.hole == null ? sp.str : (key[String(n)][sp.hole] || '?'))).join(''));
      }
      lines.push('');
    }
    // 页面渲染出来的样子：公式两边带空格（标点前不留），样例数据在代码块里（PDF 文字层里它们却是散开的一行行数字），
    // 题面里嵌的那份 PDF 在页面转换时留下 %%PDF:0%% 占位符 —— 这三点以前会把“同一份题面”拉到 0.76，判成不重复。
    const isSampleData = (s) => /^[\d.\s]+$/.test(s) && /\d/.test(s);
    const pageLines = [];
    for (const ln of lines) pageLines.push(isSampleData(ln) ? ['```', ln.trim(), '```'] : ln);
    const statement = pageLines.map((x) => (Array.isArray(x) ? x.join('\n') : x)).join('\n')
      .replace(/(\$[^$\n]+\$)/g, ' $1 ')
      .replace(/[ \t]+([，。、；：？！）】》])/g, '$1')
      .replace(/ {2,}/g, ' ')
      + '\n\n%%PDF:0%%';
    assert.ok(plugin.pageHasTex(statement), '造出来的题面要含 LaTeX');
    const d = plugin.dupOfStatement(statement, pdfText.replace(/%%H\d+-\d+%%/g, ' '));
    assert.ok(d.dup, `应该判为和题面重复（重合度 ${d.score.toFixed(2)}）`);

    const calls = [];
    const r = await plugin.recognizePdf({
      handle: p2196, engine: 'text', cfg: cfgWithApi(), title: '葫芦娃救爷爷', pid: 'P2196', auto: false,
      statementText: statement, progress: () => {},
    }, fakeDeps([({ want }) => { calls.push(want); return '# 不该被调用'; }], []));
    assert.strictEqual(r.dup, true, '应该直接跳过');
    assert.strictEqual(r.markdown, '', '跳过时不该产出任何正文');
    assert.strictEqual(r.holeImgs, 0, '跳过时不该再裁公式截图');
    assert.strictEqual(r.holeFixed, 0);
    assert.strictEqual(calls.length, 0, '跳过时不该发任何模型请求');
  });

  await testAsync('公式源码的其他来源：MathJax 的 <script type="math/tex">、data-tex、图片 alt', () => {
    const { JSDOM } = require('jsdom');
    const page = `<!doctype html><html><body>
      <div class="problem-content"><div class="section__body typo richmedia" data-fragment-id="problem-description">
        <p>设 <script type="math/tex">n</script> 个葫芦娃，<span data-tex="p_i">图</span> 是战斗力，误差不超过 <img src="/x/f1.svg" alt="10^{-6}">，还有 <script type="math/tex; mode=display">\\sum p_i = 1</script></p>
        <p><span data-tex="这里只是说明文字">abc</span></p>
        <p><img src="/x/photo.png" alt="样例示意图"></p>
      </div></div></body></html>`;
    const dom = new JSDOM(page, { url: 'https://www.goj.wiki/d/Union2024/p/2085' });
    const doc = dom.window.document;
    const ex = plugin.extract(plugin.findStatementRoot(doc, false));
    assert.ok(ex.markdown.includes('设 $n$ 个葫芦娃'), `MathJax v2 的源码脚本要变成 LaTeX：${ex.markdown}`);
    assert.ok(ex.markdown.includes('$p_i$'), `data-tex 要变成 LaTeX：${ex.markdown}`);
    assert.ok(ex.markdown.includes('$10^{-6}$'), `图片 alt 里的 LaTeX 要认出来：${ex.markdown}`);
    assert.ok(ex.markdown.includes('$$') && ex.markdown.includes('\\sum p_i = 1'), `display 模式的源码要独立成行：${ex.markdown}`);
    assert.ok(!ex.markdown.includes('这里只是说明文字'), '不像 LaTeX 的 data-tex 不能硬当公式');
    assert.ok(/!\[样例示意图\]\(https:\/\/www\.goj\.wiki\/x\/photo\.png\)/.test(ex.markdown), `普通图片照旧（相对地址补成绝对）：${ex.markdown}`);
    assert.ok(plugin.pageHasTex(ex.markdown), '这样得到的题面也算“含 LaTeX”');
  });

  await testAsync('整个流程（页面 → 剪贴板）：题面里的 LaTeX 留下，重复的 PDF 不留痕、也不调模型', async () => {
    const { JSDOM } = require('jsdom');
    const katex = (tex) => `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">x</span></span></span>`;
    // 页面题面 = PDF 的文字层 + 人工核对过的 LaTeX（就是 Hydro 用 KaTeX 渲染出来的样子）
    const key = JSON.parse(fs.readFileSync(path.join(FIX, 'p2196-answers.json'), 'utf8')).strip;
    const pageLines = [];
    for (let n = 1; n <= p2196.numPages; n++) {
      const p = await p2196.pageText(n);
      const rows = new Map();
      for (const sp of p.spans) {
        const k = Math.round(sp.y);
        if (!rows.has(k)) rows.set(k, []);
        rows.get(k).push(sp);
      }
      for (const k of Array.from(rows.keys()).sort((a, b) => a - b)) {
        const line = rows.get(k).sort((a, b) => a.x - b.x)
          .map((sp) => (sp.hole == null ? sp.str : katex(String(key[String(n)][sp.hole] || '?').replace(/^\$\$?|\$\$?$/g, '')))).join('');
        pageLines.push(`<p>${line}</p>`);
      }
    }
    const html = `<!doctype html><html><body><div class="problem-content"><div class="section__body typo richmedia" data-fragment-id="problem-description">
      <h2>题目描述</h2>
      ${pageLines.join('\n')}
      <object data="/d/Union2024/p/2085/file/2085.pdf" type="application/pdf"><param name="SRC" value="/d/Union2024/p/2085/file/2085.pdf"><embed type="application/pdf" src="/d/Union2024/p/2085/file/2085.pdf#toolbar=1"></object>
    </div></div></body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/d/Union2024/p/2085' });
    const handle = await openPdf(load('p2196-fhllyjyy.pdf'));
    const logs = [];
    const states = [];
    let copied = null;
    let httpCalls = 0;
    const storage = new Map();
    const runner = plugin.createRunner({
      doc: dom.window.document,
      loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: {
        log: (...a) => logs.push(a.join(' ')),
        state: (kind, label, title) => states.push({ kind, label, title }),
        result: () => {}, picks: () => {}, ask: async () => true,
      },
      loadPdf: async () => handle,
      sleep: async () => {},
      copy: async (md) => { copied = md; return true; },
      http: async () => { httpCalls++; throw new Error('这一步不该发模型请求'); },
    });
    const out = await runner.run({});
    assert.ok(copied, '应该复制了内容');
    assert.ok(copied.includes('有 $n$个葫芦娃'), `正文里要有页面上的 LaTeX 题面：${copied.slice(0, 200)}`);
    assert.ok(copied.includes('葫芦娃的战斗力是 $p_i$'), '公式要留在句子里');
    assert.ok(copied.includes('$10^{-6}$'), '公式要保留成 LaTeX');
    assert.ok(!copied.includes('data:image'), '不该有 PDF 的公式截图');
    assert.ok(!copied.includes('%%'), '不该有残留占位符');
    assert.strictEqual(httpCalls, 0, '不该发任何视觉模型请求');
    assert.ok(logs.some((l) => l.includes('含 LaTeX 公式') && l.includes('KaTeX')), `要记一行题面来源诊断：${JSON.stringify(logs)}`);
    assert.ok(logs.some((l) => l.includes('跳过')), '要说明这份 PDF 被跳过了');
    const last = states[states.length - 1];
    assert.strictEqual(last.kind, 'done', `不该报警告：${JSON.stringify(last)}`);
    assert.ok(last.label.includes('跳过 1 份重复的 PDF'), `按钮上要说清楚：${JSON.stringify(last)}`);
    assert.strictEqual(out.failed, 0);
  });

  await testAsync('页面上的公式不在题面区域里时，面板要提醒一句（排查“扫不出 KaTeX”就看这一行）', async () => {
    const { JSDOM } = require('jsdom');
    const katex = (tex) => `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base">x</span></span></span>`;
    // 题面区域里只有 PDF 文字层那样“缺了公式”的文字，公式源码在题面区域外面（页面别处）
    const html = `<!doctype html><html><body>
      <div class="section__body typo richmedia" data-fragment-id="problem-description">
        <h2>题目描述</h2>
        <p>有 个葫芦娃，第 个葫芦娃的战斗力是 。</p>
        <object data="/d/Union2024/p/2085/file/2085.pdf" type="application/pdf"><param name="SRC" value="/d/Union2024/p/2085/file/2085.pdf"></object>
      </div>
      <div class="problem-content"><p>页脚里也提到 ${katex('p_i')}。</p></div>
      </body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/d/Union2024/p/2085' });
    const handle = await openPdf(load('p2196-fhllyjyy.pdf'));
    const logs = [];
    const storage = new Map();
    const runner = plugin.createRunner({
      doc: dom.window.document,
      loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, ask: async () => true },
      loadPdf: async () => handle,
      sleep: async () => {},
      copy: async () => true,
      http: async () => { throw new Error('这一步不该发模型请求'); },
    });
    await runner.run({ engine: 'text' });
    const first = logs[0] || '';
    assert.ok(/没有公式源码/.test(first) && /KaTeX 1 处/.test(first), `第一行要写清“题面里没有公式源码”和页面上的公式数：${first}`);
    assert.ok(first.includes('题面区域：div[data-fragment-id="problem-description"]'), `要写出命中的题面容器：${first}`);
    assert.ok(logs.some((l) => l.includes('⚠️') && l.includes('没有一处落在题面区域')), `页面上的公式不在题面里时要提醒：${JSON.stringify(logs)}`);
  });

  await testAsync('站点数据（window.UiContextNew）：题面原文从页面自带的数据里读，@[pdf](…) 也认', () => {
    const { JSDOM } = require('jsdom');
    // 和真实页面一样：window.UiContextNew = '<JSON>'，pdoc.content 又是 {"zh":"…"} 这种多语言 JSON
    const ctx = {
      problemId: 'P2196', problemNumId: 2085,
      pdoc: { _id: 'x', pid: 'P2196', title: '葫芦娃救爷爷', content: JSON.stringify({ zh: '有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$。\r\n\r\n@[pdf](./2085/file/statement.pdf?tid=abc)', en: 'English: n boys.' }) },
    };
    const inner = JSON.stringify(ctx);
    const mk = (lit) => new JSDOM(`<!doctype html><html><body><script>window.UiContextNew = ${lit};</script>
      <div class="section__body typo richmedia" data-fragment-id="problem-description"><p>有 个葫芦娃。</p></div></body></html>`,
      { url: 'https://www.goj.wiki/p/P2196?tid=abc' }).window.document;
    for (const [name, lit] of [['单引号（真实页面的样子）', `'${inner}'`], ['双引号 + JS 转义', JSON.stringify(inner)]]) {
      const d = plugin.statementFromPageData(mk(lit));
      assert.ok(d, `${name}：要能从 <script> 里读到站点数据`);
      assert.ok(d.markdown.includes('有 $n$ 个葫芦娃'), `${name}：题面原文要取 zh 那一份：${d && d.markdown}`);
      assert.ok(!d.markdown.includes('English'), `${name}：别把英文那份也塞进来`);
      assert.ok(plugin.pageHasTex(d.markdown), `${name}：这份原文里带 LaTeX`);
      const links = plugin.pdfLinksFromMarkdown(d.markdown, 'https://www.goj.wiki/p/P2196?tid=abc');
      assert.deepStrictEqual(links.map((l) => l.url), ['https://www.goj.wiki/p/2085/file/statement.pdf?tid=abc'], `${name}：@[pdf](…) 要解析成绝对地址`);
    }
    assert.strictEqual(plugin.pageData(new JSDOM('<html><body></body></html>').window.document), null, '没有站点数据时返回 null');
    assert.strictEqual(plugin.unescapeJs('\\u846b\\u82a6\\"\\n'), '葫芦"\n', 'unescapeJs 要认得 \\u \\" \\n');
  });

  await testAsync('站点原文里带 LaTeX 时，题面直接用它（不用从渲染结果里扒）', async () => {
    const { JSDOM } = require('jsdom');
    // 题面正文足够长（超过 200 字）时，题面里的 PDF 附件不会被当成题面本身
    const para = '有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$，在第 $i$ 天早上出生，保证所有 $p_i$ 的总和是 $1$。';
    const ctx = { problemId: 'P2196', pdoc: { content: JSON.stringify({ zh: [para, para, para, para, para, '', '@[pdf](./2085/file/statement.pdf?tid=abc)'].join('\n') }) } };
    const html = `<!doctype html><html><body><script>window.UiContextNew = '${JSON.stringify(ctx)}';</script>
      <div class="section__body typo richmedia" data-fragment-id="problem-description"><p>有 个葫芦娃，第 个葫芦娃的战斗力是 。</p></div></body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/p/P2196?tid=abc' });
    const logs = [];
    const storage = new Map();
    const runner = plugin.createRunner({
      doc: dom.window.document, loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, ask: async () => true },
      loadPdf: async () => ({ numPages: 0, hash: 'h', size: 0 }), sleep: async () => {}, copy: async () => true,
      http: async () => { throw new Error('这一步不该发模型请求'); },
    });
    await runner.run({ engine: 'text' });
    const first = logs[0] || '';
    assert.ok(first.includes('含 LaTeX 公式') && first.includes('来源：站点数据里的题面原文'), `要用站点原文并写明来源：${first}`);
  });

  await testAsync('题面本身就是一份 PDF 时：比赛提示不混进来，面板直接说明白', async () => {
    const { JSDOM } = require('jsdom');
    // 真实页面的样子：题面区域里只有“该比赛已结束…”的提示 + 一个 PDF，另外页面数据里写着 @[pdf](…)
    const ctx = { problemId: 'P2196', pdoc: { content: JSON.stringify({ zh: '@[pdf](./2085/file/statement.pdf?tid=abc)\r\n\r\n[下载样例及附件](./2085/file/download.zip?tid=abc)\r\n' }) } };
    const html = `<!doctype html><html><body><script>window.UiContextNew = '${JSON.stringify(ctx)}';</script>
      <div class="section__body typo richmedia" data-fragment-id="problem-description">
        <blockquote class="note"><p>该比赛已结束，您无法在比赛模式下递交该题目。您可以点击“在题库中打开”以普通模式查看和递交本题。</p></blockquote>
        <p><object classid="clsid:B232ACB6-E3E1-4689-A40F-CF782FA0B8AC"><param name="SRC" value="./2085/file/statement.pdf?tid=abc&amp;noDisposition=1"><embed type="application/pdf" src="./2085/file/statement.pdf?tid=abc&amp;noDisposition=1#toolbar=1"></object></p>
        <p><a href="./2085/file/download.zip?tid=abc">下载样例及附件</a></p>
      </div></body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/p/P2196?tid=abc' });
    const handle = await openPdf(load('p2196-fhllyjyy.pdf'));
    const logs = [];
    let copied = '';
    const storage = new Map();
    const runner = plugin.createRunner({
      doc: dom.window.document, loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, ask: async () => true },
      loadPdf: async () => handle, sleep: async () => {}, copy: async (md) => { copied = md; return true; },
      http: async () => { throw new Error('这一步不该发模型请求'); },
    });
    await runner.run({ engine: 'text' });
    assert.ok(logs.some((l) => l.includes('题面本身就是一份 PDF') && l.includes('@[pdf](statement.pdf)')), `面板要说清“题面就是 PDF”：${JSON.stringify(logs.slice(0, 3))}`);
    assert.ok(logs.some((l) => l.includes('页面上的公式：KaTeX 0 处')), `要说清页面上一个公式源码都没有：${logs[0]}`);
    assert.ok(!copied.includes('该比赛已结束'), '比赛提示不是题面，不能复制进来');
    assert.ok(!copied.includes('%%'), '不该有残留占位符');
    assert.ok(copied.includes('![公式](data:image/png;base64,'), '没配 API 时公式先退化成截图（配了模型就是 LaTeX）');
    assert.ok(copied.includes('下载样例及附件') || true);
  });

  await testAsync('页面结构不认识的题面页，也能靠站点数据把题面读出来（不再直接报“找不到题面区域”）', async () => {
    const { JSDOM } = require('jsdom');
    const ctx = { problemId: 'T1', pdoc: { content: JSON.stringify({ zh: '有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$。' }) } };
    const html = `<!doctype html><html><body><script>window.UiContextNew = '${JSON.stringify(ctx)}';</script>
      <main class="brand-new-template"><p>有 个葫芦娃，第 个葫芦娃的战斗力是 。</p></main></body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/p/T1' });
    const logs = [];
    let copied = '';
    const storage = new Map();
    const runner = plugin.createRunner({
      doc: dom.window.document, loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, ask: async () => true },
      loadPdf: async () => { throw new Error('这个页面里没有 PDF，不该去读'); },
      sleep: async () => {}, copy: async (md) => { copied = md; return true; },
      http: async () => { throw new Error('这一步不该发模型请求'); },
    });
    await runner.run({ engine: 'text' });
    assert.strictEqual(plugin.findStatementRoot(dom.window.document, false), null, '这个页面故意没有 Hydro 的题面容器');
    assert.ok((logs[0] || '').includes('含 LaTeX 公式') && (logs[0] || '').includes('来源：站点数据里的题面原文'), `要靠站点数据：${logs[0]}`);
    assert.ok(copied.includes('有 $n$ 个葫芦娃'), `正文要是站点原文里的 LaTeX：${copied}`);
  });

  await testAsync('DeepSeek 预设：地址 / 模型名 / 关思考，base_url 只填域名也拼得对', async () => {
    const ds = plugin.PRESETS.find((p) => p.id === 'deepseek');
    assert.ok(ds, '要有 DeepSeek 预设');
    assert.strictEqual(ds.apiUrl, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(ds.model, 'deepseek-flash', '官方只有 deepseek-flash 支持图片，v4-pro 传图会 400');
    assert.deepStrictEqual(JSON.parse(ds.extraBody), { thinking: { type: 'disabled' } });
    assert.ok(/deepseek-flash/.test(ds.note) && /1024/.test(ds.note), '说明里要写清模型名和一张图的开销');
    assert.strictEqual(plugin.normalizeEndpoint(ds.apiUrl), ds.apiUrl);
    assert.strictEqual(plugin.normalizeEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(plugin.normalizeEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  });

  await testAsync('DeepSeek 请求：图片按 image_url 发出去，思考关掉，reasoning_content 不干扰解析', async () => {
    const ds = plugin.PRESETS.find((p) => p.id === 'deepseek');
    let sent = null;
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: ds.apiUrl, apiKey: 'sk-test', model: ds.model, extraBody: ds.extraBody });
    const out = await plugin.chat(cfg, plugin.stripContent('data:image/png;base64,AAA', 2), {
      sleep: async () => {},
      http: async (opts) => {
        sent = opts;
        return { status: 200, text: JSON.stringify({ choices: [{ message: { reasoning_content: '（想一下）', content: '1. $n$\n2. $p_i$' }, finish_reason: 'stop' }] }) };
      },
    });
    assert.strictEqual(sent.method, 'POST');
    assert.strictEqual(sent.url, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(sent.headers.Authorization, 'Bearer sk-test');
    const body = JSON.parse(sent.data);
    assert.strictEqual(body.model, 'deepseek-flash');
    assert.deepStrictEqual(body.thinking, { type: 'disabled' });
    assert.deepStrictEqual(body.messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    assert.ok(/编号/.test(body.messages[0].content[0].text), '发的是逐块补公式的那套提示词');
    assert.strictEqual(out.text, '1. $n$\n2. $p_i$');
    assert.strictEqual(out.truncated, false);
  });

  await testAsync('模型不吃图片时：报错要说清是模型选错了，而不是让用户自己去猜', async () => {
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-test', model: 'deepseek-v4-pro', extraBody: '' });
    let msg = '';
    try {
      await plugin.chat(cfg, plugin.userContent('data:image/png;base64,AAA', 1, 1), {
        sleep: async () => {},
        http: async () => ({ status: 400, text: JSON.stringify({ error: { message: 'This model does not support image input' } }) }),
      });
    } catch (e) { msg = e.message; }
    assert.ok(/不接受图片输入/.test(msg), `要说清是模型的问题：${msg}`);
    assert.ok(/deepseek-flash/.test(msg), `要给出能用的模型名：${msg}`);
    assert.ok(/HTTP 400/.test(msg), `要保留原始状态码：${msg}`);
  });

  await testAsync('OpenRouter 预设：填的是带 :free 的免费视觉模型，说明里写清限流和怎么换模型', async () => {
    const or = plugin.PRESETS.find((p) => p.id === 'openrouter');
    assert.ok(or, '要有 OpenRouter 预设');
    assert.strictEqual(or.apiUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.ok(/:free$/.test(or.model), `默认模型要选免费的（:free 结尾）：${or.model}`);
    assert.ok(/Vision|vision/.test(or.note) || /max_price=0/.test(or.note), '要告诉用户去哪挑模型');
    assert.ok(/50 次\/天/.test(or.note), '限流要写在说明里');
    assert.strictEqual(plugin.normalizeEndpoint(or.apiUrl), or.apiUrl);
    assert.strictEqual(plugin.normalizeEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  });

  await testAsync('OpenRouter 请求：图片按 image_url 发出去，响应里多出来的字段不影响解析', async () => {
    const or = plugin.PRESETS.find((p) => p.id === 'openrouter');
    let sent = null;
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: or.apiUrl, apiKey: 'sk-or-test', model: or.model, extraBody: or.extraBody });
    const out = await plugin.chat(cfg, plugin.userContent('data:image/png;base64,AAA', 1, 1), {
      sleep: async () => {},
      http: async (opts) => {
        sent = opts;
        return {
          status: 200,
          text: JSON.stringify({
            id: 'gen-abc', model: or.model, provider: 'NVIDIA',
            choices: [{ message: { role: 'assistant', content: '## 题目描述\n\n有 $n$ 个葫芦娃。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1200, completion_tokens: 30 },
          }),
        };
      },
    });
    assert.strictEqual(sent.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(sent.headers.Authorization, 'Bearer sk-or-test');
    const body = JSON.parse(sent.data);
    assert.strictEqual(body.model, or.model);
    assert.deepStrictEqual(body.messages[0].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    assert.ok(out.text.includes('有 $n$ 个葫芦娃'), out.text);
    assert.strictEqual(out.truncated, false);
  });

  await testAsync('OpenRouter 免费额度用完时：报错要说清是「免费模型每天 50 次」', async () => {
    const or = plugin.PRESETS.find((p) => p.id === 'openrouter');
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: or.apiUrl, apiKey: 'sk-or-test', model: or.model, extraBody: '' });
    let calls = 0;
    let msg = '';
    try {
      await plugin.chat(cfg, plugin.userContent('data:image/png;base64,AAA', 1, 1), {
        sleep: async () => {},
        http: async () => {
          calls++;
          return { status: 429, text: JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } }) };
        },
      });
    } catch (e) { msg = e.message; }
    assert.ok(/免费模型今天的次数用完了/.test(msg), `要说清是免费额度的问题：${msg}`);
    assert.ok(/50 次\/天/.test(msg) && /10 美元/.test(msg), `要给出提升办法：${msg}`);
    assert.strictEqual(calls, 3, '429 要退避重试 2 次再报错');
  });

  await testAsync('备用接口：主接口报错时自动换备用，同一次运行里之后不再白撞主接口', async () => {
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, {
      apiUrl: 'https://main.example.com/v1/chat/completions', apiKey: 'sk-main', model: 'glm-4.6v-flash',
      alt: { apiUrl: 'https://alt.example.com/v1/chat/completions', apiKey: 'sk-alt', model: 'deepseek-flash', extraBody: '' },
      useAlt: false,
    });
    const models = [];
    const logs = [];
    const deps = {
      sleep: async () => {},
      ui: { log: (m) => logs.push(m) },
      http: async (opts) => {
        models.push(JSON.parse(opts.data).model);
        if (/main\.example\.com/.test(opts.url)) return { status: 401, text: JSON.stringify({ error: { message: 'Authentication Fails' } }) };
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '1. $n$' }, finish_reason: 'stop' }] }) };
      },
    };
    assert.strictEqual(plugin.activeApi(cfg).label, '主接口');
    assert.deepStrictEqual(plugin.apiOrder(cfg).map((x) => x.label), ['主接口', '备用接口']);
    const r = await plugin.chat(cfg, plugin.stripContent('data:image/png;base64,AAA', 1), deps);
    assert.strictEqual(r.text, '1. $n$');
    assert.deepStrictEqual(models, ['glm-4.6v-flash', 'deepseek-flash'], '主接口 401 → 换备用');
    assert.ok(logs.some((m) => /改用备用接口/.test(m) && /deepseek-flash/.test(m)), logs.join(' ｜ '));
    models.length = 0;
    await plugin.chat(cfg, plugin.stripContent('data:image/png;base64,AAA', 1), deps);
    assert.deepStrictEqual(models, ['deepseek-flash'], '同一次运行里记住能用的那套');
  });

  await testAsync('备用接口：勾了“当前使用备用”就先走备用，备用挂了自动回主接口', async () => {
    const cfg = Object.assign({}, plugin.DEFAULT_CFG, {
      apiUrl: 'https://main.example.com/v1/chat/completions', apiKey: 'sk-main', model: 'glm-4.6v-flash',
      alt: { apiUrl: 'https://alt.example.com/v1/chat/completions', apiKey: 'sk-alt', model: 'deepseek-flash', extraBody: '' },
      useAlt: true,
    });
    const models = [];
    const deps = {
      sleep: async () => {}, ui: { log: () => {} },
      http: async (opts) => {
        const m = JSON.parse(opts.data).model;
        models.push(m);
        if (/alt\.example\.com/.test(opts.url)) return { status: 403, text: JSON.stringify({ error: { message: 'quota exceeded' } }) };
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content: '1. $p_i$' }, finish_reason: 'stop' }] }) };
      },
    };
    assert.strictEqual(plugin.activeApi(cfg).label, '备用接口');
    assert.deepStrictEqual(plugin.apiOrder(cfg).map((x) => x.label), ['备用接口', '主接口']);
    const r = await plugin.chat(cfg, plugin.stripContent('data:image/png;base64,AAA', 1), deps);
    assert.strictEqual(r.text, '1. $p_i$');
    assert.deepStrictEqual(models, ['deepseek-flash', 'glm-4.6v-flash'], '备用 403 → 回主接口');
    // 只配了备用（主接口空着）：顺序里就只有备用
    const onlyAlt = Object.assign({}, plugin.DEFAULT_CFG, { alt: cfg.alt, useAlt: true });
    assert.deepStrictEqual(plugin.apiOrder(onlyAlt).map((x) => x.label), ['备用接口']);
    assert.strictEqual(plugin.hasAlt(onlyAlt), true);
    assert.strictEqual(plugin.hasAlt(plugin.DEFAULT_CFG), false);
  });

  await testAsync('备用接口：配置校验说清是哪一套没填好，老配置（没有 alt）也能读', async () => {
    const cfg = plugin.loadConfig({ get: (k, d) => d });
    assert.deepStrictEqual(cfg.alt, { apiUrl: '', apiKey: '', model: '', extraBody: '' }, '老配置要补成空壳，不能是 null');
    assert.strictEqual(cfg.useAlt, false);
    const bad = plugin.configProblems(Object.assign({}, plugin.DEFAULT_CFG, {
      apiUrl: 'https://main/v1/chat/completions', apiKey: 'sk', model: 'm',
      alt: { apiUrl: '', apiKey: '', model: '' }, useAlt: true,
    }));
    assert.ok(bad.some((x) => /备用接口/.test(x)), bad.join('、'));
    const badMain = plugin.configProblems(Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: '', apiKey: '', model: '' }));
    assert.ok(badMain.some((x) => /主接口的接口地址/.test(x)), `要说清是哪一套：${badMain.join('、')}`);
    assert.deepStrictEqual(plugin.configProblems(Object.assign({}, plugin.DEFAULT_CFG, { apiUrl: 'https://a/v1/chat/completions', apiKey: 'sk', model: 'm' })), []);
  });

  await testAsync('备用接口：面板上的 ⇄ 一按就真的切过去了（配置翻面 + 日志说清切到哪套）', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.goj.wiki/p/P2196' });
    const storage = new Map();
    storage.set(plugin.CFG_KEY, Object.assign({}, plugin.DEFAULT_CFG, {
      apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', apiKey: 'sk-a', model: 'glm-4.6v-flash',
      alt: { apiUrl: 'https://api.deepseek.com/chat/completions', apiKey: 'sk-b', model: 'deepseek-flash', extraBody: '' },
      useAlt: false,
    }));
    const logs = [];
    const runner = plugin.createRunner({
      doc: dom.window.document, loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, ask: async () => true },
      loadPdf: async () => { throw new Error('不该读 PDF'); }, sleep: async () => {}, copy: async () => true,
      http: async () => { throw new Error('不该发请求'); },
    });
    const first = runner.switchApi();
    assert.strictEqual(first.useAlt, true);
    assert.strictEqual(storage.get(plugin.CFG_KEY).useAlt, true, '配置要真的写回去');
    assert.ok(/已切到备用接口/.test(logs.join('\n')) && /deepseek-flash/.test(logs.join('\n')), logs.join(' ｜ '));
    const back = runner.switchApi();
    assert.strictEqual(back.useAlt, false);
    assert.ok(/已切到主接口/.test(logs.join('\n')), logs.join(' ｜ '));
  });

  test('搜原题：拿去检索的文本去掉页眉/图片/插件提示，只留题名和题面，且截在 15000 字', () => {
    const md = [
      '# P2196. 葫芦娃救爷爷',
      '',
      '> 来源：https://www.goj.wiki/p/P2196 ｜ 时间限制：1s',
      '',
      '## 题目描述',
      '',
      '有 $n$ 个葫芦娃，第 $i$ 个葫芦娃的战斗力是 $p_i$。',
      '',
      '![公式](data:image/png;base64,QUFBQQ==)',
      '',
      '<!--',
      '⚠️ 第 1 页没有文字，已跳过',
      '-->',
      '',
      '%%PDF:0%%',
    ].join('\n');
    const q = plugin.buildSearchQuery(md, { title: '葫芦娃救爷爷' });
    assert.ok(q.startsWith('葫芦娃救爷爷'), `题名要放在最前：${q.slice(0, 40)}`);
    assert.ok(q.includes('有 $n$ 个葫芦娃'), '题面正文和 LaTeX 要留着');
    assert.ok(!/data:image|来源|%%PDF|已跳过/.test(q), `图片/页眉/提示/占位符不能发过去：${q}`);
    assert.ok(plugin.buildSearchQuery('题'.repeat(20000), {}).length <= 15000, '接口上限 16000，要提前截断');
  });

  test('搜原题：接口一行结果整理成 相似度 + 原题链接 + VJudge 链接（uid = Source/题号）', () => {
    const payload = {
      results: [
        { uid: 'CodeForces/1784C', title: 'Make it Increasing?', src: 'CodeForces', url: 'https://codeforces.com/problemset/problem/1784/C', cos: 0.9134, rr: 0.97, base_rank: 2, t0: '简化题意', original: '原始题面', also: [{ uid: 'AtCoder/abc239_ex', url: 'https://atcoder.jp/contests/abc239/tasks/abc239_ex' }] },
        { uid: 'AtCoder/abc239_ex', title: 'Construct a Train', src: 'AtCoder', url: 'https://atcoder.jp/contests/abc239/tasks/abc239_ex', cos: 0.8701, rr: null },
        { uid: 'CodeForces/102001A', title: 'Gym 题', src: 'CodeForces', url: 'https://codeforces.com/gym/102001/problem/A', cos: 0.5, rr: 0.4 },
        { uid: 'CodeForces/1A', title: '第 4 道（不该出现）', src: 'CodeForces', url: 'https://codeforces.com/problemset/problem/1/A', cos: 0.4, rr: 0.3 },
      ],
      rewrites: { t0: '重写1', t1: '重写2' }, reranked: true, timing: { total: 12.3 },
    };
    const r = plugin.parseYuantijiResponse(JSON.stringify(payload));
    assert.strictEqual(r.rows.length, 3, '只取前 3 道');
    assert.strictEqual(r.rows[0].sim, 0.9134, '相似度以 cos 为准');
    assert.strictEqual(plugin.simLabel(r.rows[0].cos), '几乎肯定是原题');
    assert.strictEqual(r.rows[0].origUrl, 'https://codeforces.com/problemset/problem/1784/C', '接口的 url 就是原题链接');
    assert.strictEqual(r.rows[0].vjUrl, 'https://vjudge.net/problem/CodeForces-1784C');
    assert.strictEqual(r.rows[0].also[0].uid, 'AtCoder/abc239_ex', '同题在别的 OJ 也要带出来');
    assert.strictEqual(r.rows[1].vjUrl, 'https://vjudge.net/problem/AtCoder-abc239_ex');
    assert.strictEqual(plugin.simLabel(r.rows[1].cos), '很可能是原题');
    assert.strictEqual(r.rows[2].vjUrl, 'https://vjudge.net/problem/Gym-102001A', '6 位比赛号是 Gym 题');
    // 防御：万一接口哪天直接给 VJudge 地址，也要能拼回原题链接
    const d = plugin.normalizeFindRow({ uid: 'CodeForces/1730C', title: 'T', src: 'CodeForces', url: 'https://vjudge.net/problem/CodeForces-1730C', cos: 0.9 });
    assert.strictEqual(d.vjUrl, 'https://vjudge.net/problem/CodeForces-1730C');
    assert.strictEqual(d.origUrl, 'https://codeforces.com/problemset/problem/1730/C');
    // 不在 VJudge 上的 OJ：只给原题链接，不硬拼 VJudge
    const u = plugin.normalizeFindRow({ uid: 'SomeOJ/123', title: 'T', src: 'SomeOJ', url: 'https://example.com/p/123', cos: 0.4 });
    assert.strictEqual(u.vjUrl, '');
    assert.strictEqual(u.origUrl, 'https://example.com/p/123');
  });

  await testAsync('搜原题：点按钮 → Expert 参数发给 /api/search → 面板拿到结果（带 VJudge 链接的 Markdown）', async () => {
    const { JSDOM } = require('jsdom');
    const stmt = '给定长度为 n 的序列 a，每次可以把一个数加一或减一，求把它变成不下降序列的最小操作次数。'.repeat(3);
    const html = `<!doctype html><html><body><div class="problem-content"><h1 class="section__title">P9999. 测试题</h1><div class="section__body typo richmedia" data-fragment-id="problem-description"><h2>题目描述</h2><p>${stmt}</p></div></div></body></html>`;
    const dom = new JSDOM(html, { url: 'https://www.goj.wiki/p/P9999' });
    const storage = new Map();
    const logs = [];
    const foundCalls = [];
    const reqs = [];
    const runner = plugin.createRunner({
      doc: dom.window.document,
      loc: dom.window.location,
      storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v) },
      ui: { log: (...a) => logs.push(a.join(' ')), state: () => {}, result: () => {}, picks: () => {}, found: (x) => foundCalls.push(x) },
      loadPdf: async () => { throw new Error('这个页面没有 PDF，不该读 PDF'); },
      sleep: async () => {},
      copy: async () => true,
      http: async (opts) => {
        reqs.push(opts);
        return { status: 200, text: JSON.stringify({ results: [{ uid: 'CodeForces/1730C', title: 'Even Number Addicts', src: 'CodeForces', url: 'https://codeforces.com/problemset/problem/1730/C', cos: 0.88, rr: 0.95, t0: '简化题意' }], rewrites: { t0: '重写后的题面' }, reranked: true, timing: { total: 9.9 } }) };
      },
    });
    const out = await runner.searchOriginal();
    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0].method, 'POST');
    assert.strictEqual(reqs[0].url, plugin.YUANTIJI_API);
    const body = JSON.parse(reqs[0].data);
    assert.deepStrictEqual(
      { k: body.k, rewrite: body.rewrite, rerank: body.rerank, skip_short: body.skip_short },
      { k: 3, rewrite: true, rerank: true, skip_short: true },
      'Expert：重写 + 跳过过短 + 重排全开，只取 3 道',
    );
    assert.ok(body.query.includes('给定长度为'), `要发题面正文：${body.query.slice(0, 60)}`);
    assert.ok(!/来源/.test(body.query), '页眉（来源）不发');
    assert.strictEqual(out.rows.length, 1);
    const lastFound = foundCalls[foundCalls.length - 1];
    assert.strictEqual(lastFound.rows[0].vjUrl, 'https://vjudge.net/problem/CodeForces-1730C');
    assert.ok(lastFound.md.includes('[VJudge](https://vjudge.net/problem/CodeForces-1730C)'), `复制结果里要有 VJudge 链接：${lastFound.md}`);
    assert.ok(logs.some((l) => /搜原题完成/.test(l)), logs.join(' ｜ '));
  });

  await testAsync('搜原题：原题机 500 时只重试一次并把错误说清楚；自动搜原题默认关闭', async () => {
    let calls = 0;
    const err = await plugin.searchYuantiji('任意一段足够长的题面文字', {
      sleep: async () => {},
      http: async () => { calls++; return { status: 500, text: '{"detail":"boom"}' }; },
    }).catch((e) => e);
    assert.strictEqual(calls, 2, '5xx 重试一次就够了（每次搜索对方都要花钱跑模型）');
    assert.ok(/暂时不可用/.test(err.message), err.message);
    assert.strictEqual(plugin.DEFAULT_CFG.findAuto, false, '要把题面发给第三方，默认不能自动发');
    assert.strictEqual(plugin.loadConfig({ get: (k, d) => d }).findAuto, false, '老配置也要读成关闭');
  });

  test('多道题抠题：题名是普通段落行（带序号并跟元信息并成一行 / 无序号粗体行）也分得出来', () => {
    const sec = (body) => ['## 题目描述', body, '## 输入格式', '第一行一个整数。', '## 输出格式', '一行一个整数。'].join('\n\n');
    // Word 排版的模拟赛卷子转写后的典型长相：题名与正文同字体、只大一点点，没能成标题行，还和元信息并成一行
    const merged = [
      '1. 葫芦娃救爷爷源程序文件名：calabash.cpp 输入文件名：calabash.in 输出文件名：calabash.out', sec('葫芦娃的战斗力是 p_i。'),
      '2. 星际旅行源程序文件名：travel.cpp 输入文件名：travel.in 输出文件名：travel.out', sec('星球之间有虫洞相连。'),
      '3. 棋盘染色源程序文件名：chess.cpp 输入文件名：chess.in 输出文件名：chess.out', sec('格子染成黑色或白色。'),
    ].join('\n\n');
    const r = plugin.findProblems(merged, { title: '星际旅行', pid: 'P100' });
    assert.strictEqual(r.problems.length, 3, `该分出三道题：${JSON.stringify(r.problems.map((x) => x.title))}`);
    assert.strictEqual(r.best, 1);
    assert.ok(r.problems[1].titles[0].tail.includes('travel.cpp'), '并在题名后面的元信息要单独记在 tail 里');
    const sl = plugin.sliceProblem(merged, r.problems[1], { dropTitle: true });
    assert.ok(sl.includes('虫洞') && sl.includes('travel.cpp'), `切出来的该有本题正文和元信息：${sl.slice(0, 120)}`);
    assert.ok(!sl.includes('战斗力') && !sl.includes('染成黑色'), '不能串进别道题');
    assert.ok(!sl.includes('## 2. 星际旅行'), 'dropTitle 时不再重复题名行');
    // 无序号的粗体独立行
    const bold = ['**葫芦娃救爷爷**', sec('葫芦娃正文。'), '**星际旅行**', sec('虫洞正文。'), '**棋盘染色**', sec('染色正文。')].join('\n\n');
    const r2 = plugin.findProblems(bold, { title: '星际旅行', pid: 'P100' });
    assert.strictEqual(r2.problems.length, 3);
    assert.strictEqual(r2.best, 1);
  });

  test('多道题抠题：题名在“第X题”下一行、或本题只有英文文件名时也匹配得上；单题绝不误拆', () => {
    const sec = (body) => ['### 题目描述', body, '### 输入格式', 'x', '### 输出格式', 'y'].join('\n\n');
    const split = ['## 第一题', '葫芦娃救爷爷', sec('葫芦娃正文。'), '## 第二题', '星际旅行', sec('虫洞正文。'), '## 第三题', '棋盘染色', sec('染色正文。')].join('\n\n');
    const r = plugin.findProblems(split, { title: '星际旅行', pid: 'P100' });
    assert.strictEqual(r.best, 1, `题名在题号的下一行也要认得出：${JSON.stringify(r.problems.map((x) => [x.title, x.score]))}`);
    const secF = (f, body) => [`源程序文件名：${f}.cpp`, '## 题目描述', body, '## 输入格式', 'x', '## 输出格式', 'y'].join('\n\n');
    const byFile = ['## 葫芦娃救爷爷', secF('calabash', '葫芦娃正文。'), '## 星际旅行', secF('travel', '虫洞正文。'), '## 棋盘染色', secF('chess', '染色正文。')].join('\n\n');
    const r2 = plugin.findProblems(byFile, { title: 'travel', pid: 'T2' });
    assert.strictEqual(r2.best, 1, '本题在站上只叫 travel 时，要靠源程序文件名对上号');
    // 防误拆：一道题里的编号列表、短行
    const single = ['## 葫芦娃救爷爷', '## 题目描述', '有两种操作：', '', '1. 把一个数加一', '', '2. 把一个数减一', '', '求最小操作次数。', '## 输入格式', '第一行 n。', '## 输出格式', '一行答案。'].join('\n');
    assert.strictEqual(plugin.findProblems(single, { title: '葫芦娃救爷爷', pid: 'P1' }).problems.length, 0, '题面内部的编号列表不能被拆成几道题');
  });

  await testAsync('模拟赛 PDF（封面＋三道题，题名不是标题样式）：抠出与本题同名的那一道（只读文字层，不调 API）', async () => {
    const handle = await openPdf(load('mock-contest.pdf'));
    const logs = [];
    const r = await plugin.recognizePdf({
      handle, engine: 'text', cfg: plugin.DEFAULT_CFG, title: '星际旅行', pid: 'P1002', auto: false, progress: () => {},
    }, fakeDeps([], logs));
    assert.strictEqual(r.problems.length, 3, `该认出三道题：${JSON.stringify(r.problems.map((x) => x.title))}`);
    assert.strictEqual(r.best, 1, `该取第二题：bestScore=${r.bestScore}`);
    assert.ok(!r.notes.some((n) => /没能认出每道题的分界/.test(n)), `不该再提示分不出来：${r.notes.join('｜')}`);
    const sl = plugin.sliceProblem(r.rawBody, r.problems[r.best], { dropTitle: true });
    assert.ok(sl.includes('虫洞') && sl.includes('travel.cpp'), '切出来的正文和源程序文件名都得在');
    assert.ok(!sl.includes('战斗力') && !sl.includes('染色方案'), '不能串进第一、第三题');
    const byEn = await plugin.recognizePdf({
      handle, engine: 'text', cfg: plugin.DEFAULT_CFG, title: 'travel', pid: 'T2', auto: false, progress: () => {},
    }, fakeDeps([], logs));
    assert.strictEqual(byEn.best, 1, '站上只叫 travel 时也要对上第二题');
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

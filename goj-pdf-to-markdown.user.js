// ==UserScript==
// @name         GOJ 题面 PDF 转 Markdown 并复制
// @namespace    https://github.com/JokerZhongAKIOI/ZZMMXX
// @version      2.6.0
// @description  在 goj.wiki（Hydro）题目页自动识别题面里嵌入的 PDF：直接读取 PDF 文字层，转成 Markdown（公式为 LaTeX）并复制到剪贴板；公式被“打印”成矢量图形、文字层里没有的 PDF 也能逐处裁图补全；一份 PDF 里有多道题时只取与本题同名的那一道；题单（训练）页一键复制其中所有题目的题面，每题间隔 0.5 秒（共用的 PDF 只下载一次）；认不出分题结构时会提醒；扫描件可选用视觉大模型
// @match        *://www.goj.wiki/d/*/p/*
// @match        *://www.goj.wiki/p/*
// @match        *://www.goj.wiki/d/*/contest/*/p/*
// @match        *://www.goj.wiki/d/*/homework/*/p/*
// @match        *://www.goj.wiki/d/*/training/*
// @match        *://www.goj.wiki/training/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js#sha256=5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946
// @require      https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js#sha256=feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b
// ==/UserScript==

/*
 * 工作流程（详见同目录 README.md）：
 *   1. 找到 Hydro 题面容器，按文档顺序遍历：文字 / KaTeX 公式 / 代码块 / 表格 → Markdown；
 *      题面里嵌入的 PDF（<object> / <embed> / <iframe>）先用占位符 %%PDF:n%% 占位；
 *   2. 带着登录 Cookie 下载每个 PDF，用 pdf.js 读出文字层，做版面分析（标题 / 段落 / 列表 / 表格 / 样例 / 上下标 / 公式）；
 *      默认完全在本地完成，不需要 API。扫描件、文字层损坏的页，以及“公式被打印成矢量图形、文字层里只剩一个空格”的页
 *      （题面会整句缺公式），才（可选）交给 OpenAI 兼容的视觉模型——只补公式时是把那几个小方块裁成一张编号拼图，
 *      一次请求转成 LaTeX；没配置 API 就退回这些公式的截图（可在设置里关成 [公式] 占位）；
 *      一份 PDF 里如果有多道题（比赛题面），按题名相似度只取与本题同名的那一道（面板里的下拉框可以改选，也可以取整份）；
 *   3. 把识别结果替换回占位符，拼上标题 / 时空限制，复制到剪贴板。
 *   4. 题单（训练）页：依次（每题间隔 0.5 秒）取回题单里每道题的页面，对每道题重复 1–3，合并成一份 Markdown 后复制。
 *
 * 本文件被 Node 测试以 require() 方式加载时只导出纯函数（见文件末尾），不会触碰 DOM / GM_*。
 */
(function () {
  'use strict';

  /* ====================================================================== *
   * 0. 常量
   * ====================================================================== */
  const VERSION = '2.6.0';
  const PROMPT_VERSION = 'p3';              // 改动提示词 / 渲染参数时递增，使旧缓存失效
  const CFG_KEY = 'cfg_v1';
  const CACHE_KEY = 'cache_v2';
  const OLD_CACHE_KEY = 'cache_v1';         // 1.x 的图片转写缓存，启动时清掉
  const CACHE_MAX = 120;
  const MAX_PDF_BYTES = 40 * 1024 * 1024;   // PDF 体积上限
  const MAX_PDF_PAGES = 80;                 // 页数上限（文字层识别）
  const MAX_AI_PAGES = 30;                  // 单次最多让模型识别的页数
  const AUTO_MAX_AI_PAGES = 12;             // 自动模式下需要模型识别的页数超过此数就不自动开跑（防止意外的 API 花费），改为手动点击
  const RENDER_WIDTH = 1600;                // 渲染成图片交给模型时的页面宽度（像素）
  const RENDER_MAX_SIDE = 7000;             // 渲染后任意一边的像素上限
  const MAX_RAW_BYTES = 3.5 * 1024 * 1024;  // PNG 超过此体积改用 JPEG
  const MIN_PAGE_CHARS = 15;                // 一页的文字少于此数，且页面里有图片 / 大量矢量字形 → 视为扫描页 / 矢量页
  const HOLE_STRIP_WIDTH = 1900;            // 裁公式时把整页渲染成多宽（像素）；再按需裁小图
  const HOLE_STRIP_MAX_H = 3400;            // 一页的公式拼图最多多高（像素），超出的洞这一轮不识别
  const HOLE_MIN_GAP = 0.6;                 // 文字行里的空隙宽于 0.6 倍字号，才可能藏着一个公式
  const HOLE_BOX_W = 4.5;                   // “字形大小”的矢量图形：宽 / 高不超过字号的若干倍（背景块、表格线、插图都超过）
  const HOLE_BOX_H = 3.2;
  const HOLE_PAD_X = 0.2;                   // 交给模型的分块：左右留的白（倍字号），留太多会把旁边汉字裁进来
  const HOLE_PAD_Y = 0.8;
  const HOLE_CROP_WIDTH = 2400;             // 截图兜底把整页渲染成多宽（像素）：比交给模型的拼图更清楚（约 4 倍）
  const HOLE_CROP_PAD_X = 0.18;             // 截图四边留的白（倍字号）
  const HOLE_CROP_PAD_Y = 0.12;
  const MAX_HOLES_PAGE = 40;                // 一页最多补多少个公式
  const MAX_HOLES_DOC = 240;                // 一份 PDF 最多补多少个公式
  const HOLE_IMG_TOTAL = 400 * 1024;        // 用截图代替公式时，整份文档的 base64 上限
  const SHORT_STATEMENT = 200;              // 题面本身的文字少于此数时，才把“链接到 PDF 的附件”当作题面
  const DUP_GRAM = 6;                       // 判断“这份 PDF 和页面上的题面是不是同一份”时用的字串长度
  const DUP_SKIP_SCORE = 0.8;                // PDF 里多少内容在题面里出现过，就算重复（页面题面已带 LaTeX 时不再复制 PDF）
  const DUP_MIN_CHARS = 20;                  // 正文太短就不判重了（几个字的题面比不出什么，误判了反而丢内容）
  const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';   // 字符映射表 / 标准字体按需从这里取
  const ROUTE_RE = /^\/(?:d\/[^/]+\/)?(?:(?:contest|homework)\/[^/]+\/)?p\/[^/]+\/?$/;
  const LIST_ROUTE_RE = /^\/(?:d\/[^/]+\/)?training\/[0-9a-f]{24}\/?$/i;     // 题单（Hydro 的“训练”）详情页；训练 ID 是 24 位 ObjectId
  const LIST_GAP_MS = 500;                  // 题单里相邻两道题之间的默认间隔（毫秒）
  const LIST_GAP_MAX = 10000;
  const AUTO_MAX_LIST = 50;                 // 自动模式下题单超过这个题数就不自动开跑（防止一打开页面就连发几百个请求），改为手动点击
  const LIST_MAX_AI_PAGES = 60;             // 手动复制题单时，整个题单最多让视觉模型识别的页数；用完后其余的题只读文字层
  const LIST_RETRIES = 2;                   // 取题面页遇到 429 / 5xx / 网络错误时的重试次数（退避 1 秒、2 秒）
  const ENGINES = ['auto', 'text', 'ai'];
  const DEFAULT_CFG = { apiUrl: '', apiKey: '', model: '', extraBody: '', auto: true, concurrency: 2, engine: 'auto', pick: true, listAuto: true, listGap: LIST_GAP_MS, listEach: false, holeImages: true };

  const PRESETS = [
    { id: 'zhipu', name: '智谱 GLM-4.6V-Flash（免费）', apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.6v-flash', extraBody: '{"thinking":{"type":"disabled"}}' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', apiUrl: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-VL-72B-Instruct', extraBody: '' },
    { id: 'openai', name: 'OpenAI（模型名请按官方文档填写）', apiUrl: 'https://api.openai.com/v1/chat/completions', model: '', extraBody: '' },
    { id: 'gemini', name: 'Google Gemini（OpenAI 兼容，模型名请按官方文档填写）', apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: '', extraBody: '' },
    { id: 'custom', name: '自定义', apiUrl: '', model: '', extraBody: '' },
  ];

  const PROMPT = [
    '你是严谨的 OCR 与文档转写助手。下面的图片是编程竞赛 / OJ 题面 PDF 中的一页，请把这一页里的内容原样转写成 Markdown。',
    '',
    '规则：',
    '1. 忠实转写：逐字转写图片中的全部文字、数字和符号。不要翻译、总结、改写、润色或补充，更不要解题或写代码。',
    '2. 保留结构：保持原有的段落、列表和表格（表格用 GitHub 风格的 Markdown 表格）。“题目描述 / 输入格式 / 输出格式 / 样例 / 数据范围 / 提示”等小节标题用 `##`；所有标题一律从 `##` 开始，不要使用 `#`。',
    '3. 数学公式一律用 LaTeX：行内公式写成 `$...$`，单独成行的公式写成 `$$...$$`。凡是数学表达式（变量、下标、上标、不等式、求和、取模、集合等）都放进公式里，例如 `$1 \\le n \\le 10^5$`、`$a_i \\bmod (10^9+7)$`。不要使用 `\\(...\\)` 或 `\\[...\\]`。',
    '4. 输入输出样例、示例数据和代码放进 ``` 围栏代码块，逐行保留换行与空格，不要把多行合并成一行。样例左边如果有行号（1 2 3 …），行号不是数据，不要转写。',
    '5. 示意图、函数图像、树 / 图等无法转成文字的图形，用 `（图：一句简短的描述）` 代替。',
    '6. 看不清或无法确定的字符写成 `[?]`，不要猜。',
    '7. 页眉、页脚、页码和水印不要转写。',
    '8. 只输出转写出的 Markdown 正文：不要有开场白或结尾说明，也不要用 ```markdown 把整段包起来。',
  ].join('\n');

  const TRUNCATED_NOTE = '<!-- ⚠️ 模型输出被截断（finish_reason=length），内容可能不完整；可在设置里的“额外请求参数”调大 max_tokens -->';


  class UserError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ====================================================================== *
   * 1. 题面 DOM → Markdown（PDF 先用 %%PDF:n%% 占位）
   * ====================================================================== */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'button', 'input', 'select',
    'textarea', 'iframe', 'canvas', 'audio', 'video', 'svg', 'object', 'embed']);
  const SKIP_CLASSES = ['toolbar', 'copy-button', 'line-numbers-rows', 'scratchpad-fill-button'];
  const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'figure', 'figcaption', 'details', 'summary', 'center', 'dl', 'dt', 'dd', 'form', 'fieldset']);

  // Hydro 题面容器：优先 data-fragment-id（PJAX 切换语言时整块替换的就是它）。
  const ROOT_SELECTORS = [
    '[data-fragment-id="problem-description"]',
    '.problem-content .typo',
    '.problem-content',
    '.problem-content-container',
  ];
  // 兜底：别的页面上也有这些容器（会把标签栏、权限提示等无关内容当成题面），所以只在“当前页”里用，取回别的页面时不用
  const ROOT_FALLBACKS = [
    '.section__body.typo.richmedia',
    '.medium-9.columns',
  ];

  // strict：只认题目页专有的容器，不用兜底选择器。取回别的题目页（题单）时用：权限不足的提示页里没有题面容器，不能把提示当成题面。
  function findStatementRoot(doc, strict) {
    for (const sel of strict ? ROOT_SELECTORS : ROOT_SELECTORS.concat(ROOT_FALLBACKS)) {
      const el = doc.querySelector(sel);
      if (el && (el.textContent.trim() || el.querySelector('img, embed, object, iframe'))) return el;
    }
    return null;
  }

  /** 把命中的题面容器写成一句人话（选择器 + 类名），用来打日志 / 排查别的站点。 */
  function rootHint(el) {
    if (!el || !el.localName) return '';
    const id = el.id ? `#${el.id}` : '';
    const frag = el.getAttribute && el.getAttribute('data-fragment-id');
    const cls = String((el.className && el.className.baseVal) || el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return `${el.localName}${id}${frag ? `[data-fragment-id="${frag}"]` : ''}${cls ? `.${cls}` : ''}`;
  }

  function isSkipped(el) {
    if (SKIP_TAGS.has(el.localName)) return true;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (el.style && el.style.display === 'none') return true;
    // 比赛结束后 Hydro 会在题面顶部插一句“该比赛已结束…”，那是站点的提示，不是题面
    if (el.localName === 'blockquote' && /该比赛已结束|无法在比赛模式下递交/.test(el.textContent || '')) return true;
    return SKIP_CLASSES.some((c) => el.classList.contains(c));
  }

  // KaTeX 渲染结果里带有 <annotation encoding="application/x-tex">，可以无损还原 LaTeX 源码。
  function texOf(el) {
    const a = el.querySelector('annotation[encoding="application/x-tex"]');
    const raw = a ? a.textContent : (el.querySelector('.katex-html') || el).textContent;
    // 个别站点把 $…$ 也写进 annotation，这里先脱掉外层定界符，免得又包一层变成 $$…$$
    return String(raw || '').trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
  }

  function mark(inner, m) {
    const core = inner.trim();
    if (!core) return inner;
    return inner.match(/^\s*/)[0] + m + core + m + inner.match(/\s*$/)[0];
  }

  function codeSpan(text) {
    const t = text.replace(/\n/g, ' ');
    if (!t.trim()) return '';
    const fence = t.includes('`') ? '``' : '`';
    return fence + (/^`|`$/.test(t) ? ` ${t} ` : t) + fence;
  }

  function preToMd(el) {
    const code = el.querySelector('code');
    const text = (code || el).textContent.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const m = /language-([\w+#-]+)/.exec((code && code.className) || el.className || '');
    // Hydro 把样例标成 language-input1 / language-output1，不是真正的语言名
    const lang = m && !/^(input|output)\d*$/i.test(m[1]) && m[1] !== 'none' ? m[1] : '';
    const longest = (text.match(/`{3,}/g) || []).reduce((a, s) => Math.max(a, s.length), 2);
    const fence = '`'.repeat(longest + 1);
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  }

  // Hydro 的前端脚本会给样例加上“样例输入 N / 样例输出 N”标题（同时把 <pre> 包进 .code-toolbar）。
  // 用 fetch 取回来的页面没有跑过前端脚本，标题得自己补；已经在 .code-toolbar 里的说明脚本处理过了，不能重复。
  function sampleHeading(el) {
    if (el.closest('.code-toolbar')) return '';
    const prev = el.previousElementSibling;                       // 标题已经在前面了（处理过、但没包进 .code-toolbar）：也不重复补
    if (prev && /^h[1-6]$/.test(prev.localName) && /样例|sample/i.test(prev.textContent)) return '';
    const code = el.querySelector('code');
    const m = /(?:^|\s)language-(input|output)(\d+)(?:\s|$)/i.exec(`${(code && code.className) || ''} ${el.className || ''}`);
    if (!m) return '';
    const zh = /^zh/i.test(el.ownerDocument.documentElement.lang || '');
    const word = m[1].toLowerCase() === 'input' ? (zh ? '样例输入' : 'Sample Input') : (zh ? '样例输出' : 'Sample Output');
    return `\n\n## ${word} ${m[2]}\n\n`;
  }

  function imgSrc(el) {
    const raw = el.currentSrc || el.src || el.getAttribute('data-src') || el.getAttribute('data-original') || '';
    if (!raw) return '';
    try { return new URL(raw, el.baseURI || el.ownerDocument.baseURI).href; } catch (e) { return raw; }   // data-src 可能是相对路径
  }

  // 题面里的普通图片（示意图等）：不做识别，原样保留成 Markdown 图片链接。
  // 有的转换工具会把公式源码直接放在属性里（alt / title / data-tex…），见到就用它，比截图强。
  const TEX_ATTRS = ['data-tex', 'data-latex', 'data-formula', 'data-math'];
  function texAttrOf(el) {
    for (const a of TEX_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.trim()) return v.trim();
    }
    return '';
  }
  /** 看着像 LaTeX 源码吗（有 \命令、_{} ^{} 或者整段用 $ 包着）。 */
  const looksLikeTex = (v) => /\\[a-zA-Z]+|[_^]\{[^}]*\}|\$\$?[^$]+\$\$?/.test(String(v || ''));
  /** 明确的“公式源码”属性（data-tex 这种）：允许不带花括号的下标，比如 p_i。 */
  const isTexAttr = (v) => looksLikeTex(v) || /[_^]/.test(String(v || ''));

  /** 一行 LaTeX → 行内 / 独立公式（去掉外面可能有的 $）。 */
  function texMarkup(tex, display) {
    const t = String(tex || '').trim().replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
    if (!t) return '';
    return display || /\\begin\{|\\\\/.test(t) ? `\n\n$$\n${t}\n$$\n\n` : `$${t}$`;
  }

  function imageToMd(el) {
    const src = imgSrc(el);
    const attrTex = texAttrOf(el);
    if (attrTex && isTexAttr(attrTex)) return texMarkup(attrTex);   // 图片只是公式的“照片”，源码就在属性里
    for (const t of [el.getAttribute('title') || '', el.getAttribute('alt') || '']) {
      if (looksLikeTex(t)) return texMarkup(t);
    }
    if (!src || /^data:/i.test(src)) return '';
    const alt = (el.getAttribute('alt') || '').replace(/[[\]\n]/g, ' ').trim();
    return `![${alt}](${src})`;
  }

  /* ---- PDF：<object> / <embed> / <iframe> / 指向 .pdf 的链接 ---- */
  const PDF_TAGS = new Set(['object', 'embed', 'iframe']);

  /** 是不是指向 PDF 的地址：路径以 .pdf 结尾（忽略查询串和 #fragment），或者是 data:application/pdf。 */
  function isPdfUrl(u) {
    const s = String(u || '').trim();
    if (/^data:application\/pdf[;,]/i.test(s)) return true;
    let path = s.split('#')[0].split('?')[0];
    try { path = decodeURIComponent(path); } catch (e) { /* 保留原样 */ }
    return /\.pdf$/i.test(path);
  }

  function pdfName(url) {
    if (/^data:/i.test(url)) return 'embedded.pdf';
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(p) || 'document.pdf';
    } catch (e) { return 'document.pdf'; }
  }

  /** 把（可能是相对的）PDF 地址变成绝对地址并去掉 #fragment（#toolbar=1&view=FitH 之类是给浏览器查看器用的）。 */
  function resolvePdfUrl(raw, base) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^data:/i.test(s)) return s;
    try {
      const u = new URL(s, base);
      u.hash = '';
      return u.href;
    } catch (e) { return ''; }
  }

  /**
   * <object> / <embed> / <iframe> 如果装的是 PDF，返回 { url, name }，否则 null。
   * Hydro 的 @[PDF](file://x.pdf) 渲染成 <object><param name="SRC" value="…"><embed type="application/pdf" src="…#toolbar=1…"></object>。
   */
  function pdfRefOf(el) {
    const tag = el.localName;
    if (!PDF_TAGS.has(tag)) return null;
    const base = el.baseURI || (el.ownerDocument && el.ownerDocument.baseURI) || 'http://localhost/';
    const cand = [];
    const push = (u) => { if (u) cand.push(u); };
    let typed = (el.getAttribute('type') || '').toLowerCase() === 'application/pdf';
    if (tag === 'embed') {
      push(el.getAttribute('src'));
    } else if (tag === 'object') {
      push(el.getAttribute('data'));
      for (const p of el.querySelectorAll('param')) if (/^(src|movie|data|url|file)$/i.test(p.getAttribute('name') || '')) push(p.getAttribute('value'));
      for (const e of el.querySelectorAll('embed')) {
        push(e.getAttribute('src'));
        if ((e.getAttribute('type') || '').toLowerCase() === 'application/pdf') typed = true;
      }
    } else {
      const src = el.getAttribute('src') || '';
      try { const f = new URL(src, base).searchParams.get('file'); if (f) push(f); } catch (e) { /* 忽略 */ }   // pdf.js 查看器：viewer.html?file=…
      push(src);
    }
    for (const u of cand) {
      if (typed || isPdfUrl(u)) {
        const url = resolvePdfUrl(u, base);
        if (url) return { url, name: pdfName(url) };
      }
    }
    return null;
  }

  function pdfToken(ref, ctx) {
    if (ctx.byUrl.has(ref.url)) return '';            // 同一个 PDF 在题面里出现多次，只识别一次
    const idx = ctx.pdfs.length;
    ctx.pdfs.push({ url: ref.url, name: ref.name, via: 'embed' });
    ctx.byUrl.set(ref.url, idx);
    return `\n\n%%PDF:${idx}%%\n\n`;
  }

  function linkToMd(el, ctx) {
    const inner = walkChildren(el, ctx);
    const text = inner.trim();
    if (!text) return '';
    const raw = el.getAttribute('href') || '';
    const href = el.href || raw;
    if (isPdfUrl(href) && /^https?:/i.test(href) && !ctx.pdfLinks.some((l) => l.url === href.split('#')[0])) {
      ctx.pdfLinks.push({ url: href.split('#')[0], name: pdfName(href), via: 'link' });       // 链接到 PDF：题面几乎是空的时候才会被当作题面（见 createRunner）
    }
    if (raw.startsWith('#') || !/^(https?:|mailto:)/i.test(href)) return inner;   // 页内锚点 / javascript:
    if (text === href) return `<${href}>`;
    return `[${text.replace(/\s*\n+\s*/g, ' ')}](${href.replace(/\)/g, '%29')})`;
  }

  function listToMd(el, ctx) {
    const ordered = el.localName === 'ol';
    let n = parseInt(el.getAttribute('start') || '1', 10);
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    for (const li of el.children) {
      if (li.localName !== 'li') continue;
      const marker = ordered ? `${n++}. ` : '- ';
      const pad = ' '.repeat(marker.length);
      const [first, ...rest] = tidy(walkChildren(li, ctx)).split('\n');
      items.push([marker + first, ...rest.map((l) => (l ? pad + l : l))].join('\n'));
    }
    return items.length ? `\n\n${items.join('\n')}\n\n` : '';
  }

  function tableToMd(el, ctx) {
    const rows = Array.from(el.rows || el.querySelectorAll('tr'));
    if (!rows.length) return '';
    const grid = rows.map((tr) => {
      const cells = [];
      for (const c of Array.from(tr.cells || tr.children)) {
        cells.push(tidy(walkChildren(c, ctx)).replace(/\s*\n+\s*/g, '<br>').replace(/\|/g, '\\|').trim());
        for (let k = 1; k < (parseInt(c.getAttribute('colspan'), 10) || 1); k++) cells.push('');
      }
      return cells;
    });
    const width = Math.max(...grid.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
    const sep = `| ${Array(width).fill('---').join(' | ')} |`;
    return `\n\n${[line(grid[0]), sep, ...grid.slice(1).map(line)].join('\n')}\n\n`;
  }

  function walkChildren(el, ctx) {
    let acc = '';
    for (const child of el.childNodes) {
      let piece = walk(child, ctx);
      if (!piece) continue;
      if (acc === '' || acc.endsWith('\n') || (acc.endsWith(' ') && piece.startsWith(' '))) piece = piece.replace(/^ +/, '');
      acc += piece;
    }
    return acc;
  }

  function walk(node, ctx) {
    if (node.nodeType === 3) return node.nodeValue.replace(/[ \t\r\n\f\u00a0]+/g, ' ');
    if (node.nodeType === 1 && PDF_TAGS.has(node.localName)) {
      const ref = pdfRefOf(node);
      if (ref) return pdfToken(ref, ctx);
    }
    if (node.nodeType !== 1) return '';
    const el0 = node;
    // MathJax v2 把原始 LaTeX 留在 <script type="math/tex"> 里；脚本本身在 SKIP_TAGS 里，这里要先看一眼
    if (el0.localName === 'script') {
      const type = (el0.getAttribute('type') || '').toLowerCase();
      if (/^math\/tex/.test(type)) {
        const tex = el0.textContent.trim();
        return tex ? texMarkup(tex, /mode\s*=\s*display/.test(type)) : '';
      }
    }
    if (isSkipped(el0)) return '';
    const el = el0;
    const tag = el.localName;
    const cl = el.classList;
    if (!cl.contains('katex') && !cl.contains('katex-display') && !cl.contains('katex-error')) {
      const attrTex = texAttrOf(el);
      if (attrTex && isTexAttr(attrTex)) return texMarkup(attrTex);
    }

    if (cl.contains('katex-display')) { const t = texOf(el); return t ? `\n\n$$\n${t}\n$$\n\n` : ''; }
    if (cl.contains('katex')) { const t = texOf(el); return t ? `$${t}$` : ''; }
    if (cl.contains('katex-error')) {
      const t = el.textContent.trim();
      return cl.contains('katex-block') ? `\n\n$$\n${t}\n$$\n\n` : `$${t}$`;
    }

    switch (tag) {
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'img': return imageToMd(el);
      case 'pre': return sampleHeading(el) + preToMd(el);
      case 'code': return codeSpan(el.textContent);
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = walkChildren(el, ctx).replace(/\s+/g, ' ').trim();
        return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : '';
      }
      case 'strong': case 'b': return mark(walkChildren(el, ctx), '**');
      case 'em': case 'i': return mark(walkChildren(el, ctx), '*');
      case 'del': case 's': case 'strike': return mark(walkChildren(el, ctx), '~~');
      case 'sup': case 'sub': {
        const inner = walkChildren(el, ctx).trim();
        return inner ? `<${tag}>${inner}</${tag}>` : '';
      }
      case 'a': return linkToMd(el, ctx);
      case 'ul': case 'ol': return listToMd(el, ctx);
      case 'table': return tableToMd(el, ctx);
      case 'blockquote': {
        const body = tidy(walkChildren(el, ctx));
        return body ? `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
      }
      default: {
        const inner = walkChildren(el, ctx);
        return BLOCK_TAGS.has(tag) ? `\n\n${inner}\n\n` : inner;
      }
    }
  }

  /**
   * Markdown → 只留正文的字（去掉公式、图片、链接地址、标记符号和空白），用来比较两份文本是不是同一段题面。
   * 例：`有 $n$ 个葫芦娃` 与 PDF 文字层里的 `有 个葫芦娃` 去完都是 `有个葫芦娃`。
   */
  function plainTextOf(md) {
    return String(md == null ? '' : md)
      .replace(/```[\s\S]*?```/g, ' ')                       // 代码块（样例）不参与比对
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')               // 图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // 链接只留文字
      .replace(/%%[^%\n]*%%/g, ' ')                           // 插件自己的占位符（%%PDF:n%% / %%H页-序号%%）
      .replace(/\$\$[\s\S]*?\$\$/g, ' ')
      .replace(/\$[^$\n]*\$/g, ' ')
      .replace(/\\[()\[\]]/g, ' ')
      // 数字不要：样例数据在 PDF 里是一串散开的数字，在题面里却躺在代码块里（已经被上面删掉了），
      // 留着只会把“同一份题面”误判成不重复。公式和样例都有别的机制处理，这里只比正文的字。
      .replace(/[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z]+/g, '');
  }

  /** 一串字的 k 元组（用来量两份文本的重合度）。 */
  function gramSet(text) {
    const out = new Set();
    const s = plainTextOf(text);
    for (let i = 0; i + DUP_GRAM <= s.length; i++) out.add(s.slice(i, i + DUP_GRAM));
    return out;
  }

  /** a 里有多少内容在 b 里出现过（0~1）。 */
  function overlapScore(a, b) {
    const ga = gramSet(a);
    if (!ga.size) return 0;
    const gb = gramSet(b);
    let hit = 0;
    for (const g of ga) if (gb.has(g)) hit++;
    return hit / ga.size;
  }

  const PAGE_TEX_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\(|\\\[/;
  /** 页面题面里已经有 LaTeX 公式了吗（Hydro 用 KaTeX 渲染，可以从 <annotation> 还原出源码）。 */
  const pageHasTex = (md) => PAGE_TEX_RE.test(String(md || ''));

  /**
   * 这份 PDF 是不是“题面页面里已经有的那一份”：页面题面带 LaTeX 公式、而 PDF 的内容和它基本重合时，
   * 就不再复制 PDF 那一份——题面页面上的公式是现成的 LaTeX，PDF 那一份反而是截图 / 占位符，是噪声。
   * 返回 { dup, score }（score = PDF 有多少内容在题面里出现过）。
   */
  function dupOfStatement(statementMd, pdfText) {
    if (!pageHasTex(statementMd)) return { dup: false, score: 0 };
    if (plainTextOf(statementMd).length + plainTextOf(pdfText).length < DUP_MIN_CHARS * 2) return { dup: false, score: 0 };
    const score = overlapScore(pdfText, statementMd);
    return { dup: score >= DUP_SKIP_SCORE, score };
  }

  /**
   * 规整 Markdown：去行尾空白（保留 <br> 产生的两个空格硬换行）、折叠连续空行。
   * 围栏代码块内部原样保留。
   */
  function tidy(s) {
    const out = [];
    let fence = 0;          // 当前围栏的反引号数；0 表示不在代码块内
    let blank = true;       // 上一输出行是否为空（开头视为空，从而去掉前导空行）
    for (const line of String(s).replace(/\r\n?/g, '\n').split('\n')) {
      const m = /^[ \t>]*(`{3,})([^`]*)$/.exec(line);
      if (fence) {
        out.push(line);
        if (m && m[1].length >= fence && !m[2].trim()) fence = 0;
        blank = false;
        continue;
      }
      if (m) { fence = m[1].length; out.push(line.replace(/\s+$/, '')); blank = false; continue; }
      if (!line.trim()) {
        if (!blank) {
          out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '');     // 段尾的硬换行空格没有意义
          out.push('');
        }
        blank = true;
        continue;
      }
      out.push(/ {2,}$/.test(line) ? `${line.replace(/\s+$/, '')}  ` : line.replace(/\s+$/, ''));
      blank = false;
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '');
    return out.join('\n');
  }

  /**
   * 题面 → { markdown（含 %%PDF:n%% 占位符）, pdfs: [{url, name, via}]（嵌入的 PDF）, pdfLinks: 题面里指向 .pdf 的链接（备用）}
   */
  function extract(root) {
    const ctx = { pdfs: [], byUrl: new Map(), pdfLinks: [] };
    const markdown = tidy(walkChildren(root, ctx));
    return { markdown, pdfs: ctx.pdfs, pdfLinks: ctx.pdfLinks.filter((l) => !ctx.byUrl.has(l.url)) };
  }

  /* ---- 站点自己带的页面数据（题面原文） --------------------------------- */

  /** 把 JS 字符串字面量里的转义还原成真字符（\" \n \u4e2d …）。 */
  function unescapeJs(body) {
    return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (all, esc) => {
      if (esc[0] === 'u' || esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[esc] || esc;
    });
  }

  /**
   * Hydro 会把这一页的数据写进 window.UiContextNew（题目、题面原文、比赛信息都在里面）。
   * 用户脚本带着 @grant 跑在沙箱里、读不到页面的 window，所以从 <script> 的文本里抠。
   */
  function pageData(doc) {
    const scripts = doc.querySelectorAll('script');
    let fallback = null;
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent || '';
      if (text.indexOf('UiContext') < 0) continue;
      const m = /window\.(?:UiContextNew|UiContext)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(text);
      if (!m) continue;
      const body = m[1].slice(1, -1);
      let obj = null;
      try { obj = JSON.parse(body); } catch (e) { /* 里面夹着 JS 自己的转义（\' 之类）时再还原一次 */ }
      if (!obj) { try { obj = JSON.parse(unescapeJs(body)); } catch (e) { continue; } }
      if (obj && (obj.pdoc || obj.tdoc)) return obj;        // 题面原文、比赛信息都在这个对象里，优先用它
      if (!fallback) fallback = obj;
    }
    return fallback;
  }

  /**
   * 页面数据里的题面原文（pdoc.content）。题面是 Markdown 时，这里就是带 $…$ 的源码 ——
   * 比从渲染结果里扒可靠：站点怎么渲染（KaTeX / 套一层 / 只有一句 @[pdf](…)）都不影响它。
   */
  function statementFromPageData(doc) {
    const data = pageData(doc);
    const pdoc = data && data.pdoc;
    if (!pdoc || typeof pdoc.content !== 'string') return null;
    let md = pdoc.content.trim();
    if (!md) return null;
    if (md[0] === '{') {
      try {                                             // Hydro 的多语言题面：{"zh":"…","en":"…"}
        const obj = JSON.parse(md);
        const keys = Object.keys(obj).filter((k) => typeof obj[k] === 'string');
        const pick = keys.filter((k) => /^zh/i.test(k))[0] || keys[0];
        if (pick) md = String(obj[pick]).trim();
      } catch (e) { /* 不是多语言 JSON，就按原文用 */ }
    }
    return { markdown: md, pid: pdoc.pid || '', data };
  }

  /** 题面原文里写着的 PDF（Hydro 的 @[pdf](url)，或普通链接）：DOM 里没嵌 PDF 时用它兜底。 */
  function pdfLinksFromMarkdown(md, base) {
    const out = [];
    const seen = new Set();
    const re = /@\[\s*pdf\s*\]\(\s*([^)\s]+)|\[[^\]]*\]\(\s*([^)\s]+)/gi;
    let m;
    while ((m = re.exec(md))) {
      let url = '';
      try { url = new URL((m[1] || m[2]).replace(/^<|>$/g, ''), base).href; } catch (e) { continue; }
      if (!/\.pdf(\?|#|$)/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, name: pdfName(url), via: 'data' });
    }
    return out;
  }

  // opts.pageId：地址里的题号是数字 ID（题单里的链接常这样写）时，改用页面标题里的题号（“#TR0043. 题名”）
  function extractMeta(doc, loc, opts) {
    const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const q = (s) => doc.querySelector(s);
    const pm = /\/p\/([^/]+)\/?$/.exec(loc.pathname);
    let pid = '';
    try { pid = pm ? decodeURIComponent(pm[1]) : ''; } catch (e) { pid = pm ? pm[1] : ''; }
    if (opts && opts.pageId && /^\d+$/.test(pid)) {
      const hm = /#([^\s.]+)\.\s/.exec(text(q('h1.section__title')));
      if (hm) pid = hm[1];
    }
    let title = text(q('.problem-content .section__title'));
    if (!title) title = text(q('h1.section__title')).replace(/^#?\s*[\w#-]+\.\s+/, '');
    if (!title) title = (doc.title || '').split(' - ')[0].trim();
    return {
      pid,
      title,
      url: String(loc.href).split('#')[0],
      time: text(q('.problem__tag-item.icon-stopwatch')).replace(/\s+/g, ''),
      memory: text(q('.problem__tag-item.icon-comparison')).replace(/\s+/g, ''),
    };
  }

  function buildHeader(meta) {
    const head = `# ${meta.pid ? `${meta.pid}. ` : ''}${meta.title || '题目'}`;
    const bits = [`来源：${meta.url}`];
    if (meta.time) bits.push(`时间限制：${meta.time}`);
    if (meta.memory) bits.push(`内存限制：${meta.memory}`);
    return `${head}\n\n> ${bits.join(' ｜ ')}`;
  }

  const flatten = (s) => s.replace(/\s*\n+\s*/g, ' ').trim();

  function failureNote(pdf, reason) {
    const link = pdf && pdf.url && !/^data:/i.test(pdf.url) ? `\n\n[${pdf.name || 'PDF'}](${pdf.url})` : '';
    return `> ⚠️ 这个 PDF 识别失败：${flatten(reason || '未知错误')}${link}`;
  }

  /** 把识别结果按占位符放回原位，拼上页眉。results[i] = {ok, markdown} | {ok:false, error} */
  function assemble(meta, markdown, pdfs, results) {
    const body = markdown.replace(/%%PDF:(\d+)(?:%%)?/g, (_, i) => {
      const r = results[Number(i)];
      const pdf = pdfs[Number(i)] || {};
      if (r && r.ok && r.dup) return '';        // 题面页面里已经有这一份（含 LaTeX），不留痕迹
      const text = r && r.ok ? r.markdown : failureNote(pdf, r && r.error);
      return `\n\n${pdfs.length > 1 && pdf.name ? `## ${pdf.name}\n\n` : ''}${text}\n\n`;
    });
    return `${tidy(`${buildHeader(meta)}\n\n${body}`)}\n`;
  }


  /* ====================================================================== *
   * 1b. 题单（训练）页：收集题目链接 / 把各题的 Markdown 合并成一份
   * ====================================================================== */
  const lineOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  /**
   * 题单页里的题目链接 → [{ url, label }]（页面顺序，按地址去重）。
   * Hydro 训练页（training_detail.html）每道题一行 <tr data-pid=题目的数字 ID>：
   *   - 报名了的：题名是 <a href=/d/域/p/题号>；
   *   - 没报名 / 章节未开放：题名只是文字、没有链接（模板在 invalid 时不输出 <a>），但登录用户的题名 td 上有 data-star-action=/d/域/p/数字ID；
   *   - 再不行就只剩 data-pid，按页面地址里的域前缀自己拼 /d/域/p/数字ID。
   * 没有这样的行时（别的题单样式），退回去收集页面主栏里所有指向题目页的链接。
   */
  function collectProblemLinks(doc, loc) {
    const out = [];
    const seen = new Set();
    const prefix = (/^(\/d\/[^/]+)\//.exec(loc.pathname) || [])[1] || '';
    const add = (cands, label) => {
      for (const raw of cands) {
        if (!raw) continue;
        let u;
        try { u = new URL(raw, loc.href); } catch (e) { continue; }
        if (u.origin !== loc.origin || !ROUTE_RE.test(u.pathname)) continue;
        u.hash = '';
        const key = u.pathname + u.search;
        if (!seen.has(key)) { seen.add(key); out.push({ url: u.href, label }); }
        return;
      }
    };
    for (const tr of Array.from(doc.querySelectorAll('tr[data-pid]'))) {
      const td = tr.querySelector('td.col--name') || tr;
      const a = td.querySelector('a[href]');
      const id = tr.getAttribute('data-pid');
      add([a && a.getAttribute('href'), td.getAttribute('data-star-action'), id && `${prefix}/p/${encodeURIComponent(id)}`], lineOf(a || td));
    }
    if (!out.length) {
      const scope = doc.querySelector('[data-fragment-id="training_detail"]') || doc.querySelector('.medium-9.columns, .medium-7.columns') || doc.body;
      for (const a of scope ? Array.from(scope.querySelectorAll('a[href]')) : []) add([a.getAttribute('href')], lineOf(a));
    }
    return out;
  }

  /** 题单里没有 data-pid 的行：题目被删除 / 无权查看时模板只输出一个没有链接的空壳行，没法取，只能数一数告诉用户。 */
  const countMissingRows = (doc) => doc.querySelectorAll('.training__problems tbody tr:not([data-pid])').length;

  const failedBlock = (it) => `# ${it.label || it.url}\n\n> ⚠️ 这道题没有取到：${flatten(it.error || '未知错误')}\n>\n> 来源：${it.url}`;

  /**
   * 把各题的结果合并成一份 Markdown：先是题单的标题块，再是每道题（与单独复制那道题的内容完全一样），题与题之间用 --- 隔开。
   * items[i] = { ok, md, label, url, error }；total 大于 items.length 表示中途停止了；listMeta.missing = 题单里取不到的空壳行数。
   */
  function assembleList(listMeta, items, total) {
    const n = total || items.length;
    const bad = items.filter((it) => !it.ok).length;
    const bits = [`来源：${listMeta.url}`, `共 ${n} 题`];
    if (listMeta.missing) bits.push(`另有 ${listMeta.missing} 行是被删除 / 无权查看的题，没法取`);
    if (items.length < n) bits.push(`已停止，只取了前 ${items.length} 题`);
    if (bad) bits.push(`${bad} 题没取到`);
    const head = `# 题单\n\n> ${bits.join(' ｜ ')}`;
    const parts = items.map((it) => (it.ok ? it.md.trim() : failedBlock(it)));
    return `${[head].concat(parts).join('\n\n---\n\n')}\n`;
  }


  /* ====================================================================== *
   * 2. 模型输出清洗 / 哈希 / 画布小工具
   * ====================================================================== */
  function mapOutsideCode(text, fn) {
    return text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g).map((seg, i) => (i % 2 ? seg : fn(seg))).join('');
  }

  function cleanModelOutput(raw) {
    let s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const wrapped = /^```(?:markdown|md)[ \t]*\n([\s\S]*?)\n```[ \t]*$/i.exec(s);
    if (wrapped) s = wrapped[1];
    // 统一成 Hydro / KaTeX 能识别的 $ 定界符
    s = mapOutsideCode(s, (seg) => seg
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => `\n$$\n${t.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => `$${t.trim()}$`));
    return tidy(s);
  }

  function looksLikeHtml(u8) {
    const head = String.fromCharCode.apply(null, Array.from(u8.subarray(0, 512))).trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head') || head.includes('<body');
  }

  /** 非加密的快速哈希（cyrb53 变体）：http 页面里没有 crypto.subtle，缓存键不需要抗碰撞。 */
  function hashBytes(u8) {
    let h1 = 0xdeadbeef ^ u8.length;
    let h2 = 0x41c6ce57 ^ u8.length;
    for (let i = 0; i < u8.length; i++) {
      h1 = Math.imul(h1 ^ u8[i], 2654435761);
      h2 = Math.imul(h2 ^ u8[i], 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-${u8.length.toString(36)}`;
  }

  /** 画布（浏览器里是 document.createElement；Node 测试用 setCanvasFactory 换成 @napi-rs/canvas）。 */
  let canvasFactory = null;
  const setCanvasFactory = (fn) => { canvasFactory = fn; };
  function makeCanvas(w, h) {
    const c = canvasFactory ? canvasFactory(w, h) : document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  const blobToDataUrl = (blob, mime) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      let url = String(fr.result);
      if (mime && !/^data:image\//.test(url)) url = url.replace(/^data:[^;,]*/, `data:${mime}`);
      resolve(url);
    };
    fr.onerror = () => reject(new Error('读取图片失败'));
    fr.readAsDataURL(blob);
  });

  const canvasToBlob = (canvas, type, q) => new Promise((resolve, reject) => {
    if (canvas.convertToBlob) { canvas.convertToBlob({ type, quality: q }).then(resolve, reject); return; }
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), type, q);
  });

  /* ====================================================================== *
   * 3. PDF 文字层 → Markdown（版面分析）
   *    输入是 pdf.js 抽出的“文字片段”（带位置 / 字号 / 字体类别），输出 Markdown。
   *    全部是纯函数，不依赖 pdf.js 和 DOM，Node 里可以直接测试。
   *
   *    片段（span）：{ str, x, y, w, size, bold, italic, mono, math }
   *      x / y 是基线左端点，y 向下增大；w 是宽度；size 是字号；后四个是由字体名判断出的类别。
   * ====================================================================== */
  const FONT_BOLD_RE = /bold|black|heavy|demi|cmbx|cmbsy|cmmib|msyhbd|simhei|stheiti|heiti|fzheiti|黑体|[-_,]bd(?![a-z])/i;
  const FONT_ITALIC_RE = /italic|oblique|cmti|cmsl|cmmi|mathit|[-_,]it(?![a-z])|[-_]ital/i;
  const FONT_MONO_RE = /mono(?!type)|courier|consolas|menlo|monaco|cmtt|typewriter|lucidaconsole|sourcecode|firacode|inconsolata|nsimsun|cousine|andale|fixedsys|jetbrains|sfmono/i;
  const FONT_MATH_RE = /math|cmmi|cmsy|cmex|cmmib|cmbsy|msam|msbm|eufm|eusm|rsfs|mtextra|mt-?extra|mtsy|mtmi|katex_|stix|xits|euclid|^symbol(?:mt)?$/i;

  /** 字体名 → 类别。subset 前缀（如 ABCDEF+）先去掉。 */
  function classifyFont(name) {
    const n = String(name || '').replace(/^[A-Z]{6}\+/, '');
    return { bold: FONT_BOLD_RE.test(n), italic: FONT_ITALIC_RE.test(n), mono: FONT_MONO_RE.test(n), math: FONT_MATH_RE.test(n) };
  }

  const BULLET_CHARS = '•●▪■◦○◆◇‣⁃□';
  // Unicode EquivalentUnifiedIdeograph.txt：U+2E80.. 的“CJK 部首补充”字符 → 对应的统一汉字（空串表示没有对应字符）
  const RADICALS_SUPP = ',5382,4E5B,4E5A,4E59,4EBB,5182,20628,5200,5202,535C,353E,5C0F,5C0F,5140,5C23,5C22,21BC2,5DF3,5E7A,5F51,2B739,5FC4,5FC3,624C,6535,,65E1,65E5,6708,6B7A,6BCD,6C11,6C35,6C3A,706C,722B,722B,4E2C,725B,72AD,738B,24D14,76EE,793A,793B,25AD7,7CF9,7E9F,7F53,7F52,34C1,5197,2626B,7F8A,2634C,2634B,8002,8080,807F,8089,26951,8279,8279,8279,864E,8864,8980,897F,89C1,89D2,278B2,8BA0,8D1D,27FB7,8F66,8FB6,8FB6,8FB6,9091,9485,9577,9578,957F,95E8,28E0F,961D,96E8,9752,97E6,9875,98CE,98DE,98DF,2967F,98E0,9963,29810,9A6C,9AA8,9B3C,9C7C,9E1F,5364,9EA6,9EC4,9EFE,6589,9F50,6B6F,9F7F,7ADC,9F99,9F9C,4E80,9F9F'.split(',');
  /** 统一字符：去控制符 / 零宽字符，各种空格变普通空格，康熙部首 / 部首补充 / 连字 / 数学字母数字符号还原成普通字符。 */
  function normChars(s) {
    return String(s)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[\t\n\r\u00a0\u1680\u2000-\u200a\u202f\u205f]/g, ' ')
      .replace(/[\u2e80-\u2ef3]/g, (ch) => { const h = RADICALS_SUPP[ch.charCodeAt(0) - 0x2e80]; return h ? String.fromCodePoint(parseInt(h, 16)) : ch; })
      .replace(/[\u2f00-\u2fdf\uf900-\ufaff\ufb00-\ufb06\u2160-\u217f\u{1d400}-\u{1d7ff}]/gu, (ch) => ch.normalize('NFKC'))
      .replace(/[\uf0b7\uf0a7\uf076]/g, '•')
      .replace(/\s?\u0338\s*=/g, '≠')                       // LaTeX 的 \not= 在文字层里是 U+0338 + =（通常分成两个片段，见 renderSpans）
      .replace(/[\u2010\u2011]/g, '-')
      .replace(/\u2206/g, '\u0394');                          // 增量号 ∆（U+2206）统一成 Δ，下面按 \Delta 处理
  }

  const SYMBOLS = {
    '≤': '\\le', '≦': '\\le', '⩽': '\\le', '≥': '\\ge', '≧': '\\ge', '⩾': '\\ge', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv', '～': '\\sim', '≪': '\\ll', '≫': '\\gg',
    '≅': '\\cong', '≃': '\\simeq', '∝': '\\propto', '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '·': '\\cdot', '⋅': '\\cdot', '∙': '\\cdot',
    '°': '\\circ', '⋆': '\\star', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap',
    '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
    '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
    '⊄': '\\not\\subset', '⊈': '\\not\\subseteq', '≮': '\\not<', '≯': '\\not>', '≰': '\\nleq', '≱': '\\ngeq',
    '∪': '\\cup', '∩': '\\cap', '∧': '\\land', '∨': '\\lor', '¬': '\\lnot', '⊕': '\\oplus', '⊗': '\\otimes', '⊙': '\\odot',
    '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle', '∣': '\\mid', '∤': '\\nmid', '∴': '\\therefore', '∵': '\\because',
    '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
    '…': '\\dots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '′': "'", '″': "''", '˚': '^{\\circ}',
    '−': '-', '‐': '-', '‒': '-', '–': '-', '—': '-', '’': "'", '‘': '`',
    '⌊': '\\lfloor ', '⌋': '\\rfloor ', '⌈': '\\lceil ', '⌉': '\\rceil ', '⟨': '\\langle ', '⟩': '\\rangle ', '〈': '\\langle ', '〉': '\\rangle ',
    'ℓ': '\\ell', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℝ': '\\mathbb{R}', 'ℂ': '\\mathbb{C}', 'ℙ': '\\mathbb{P}',
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon', 'ϵ': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta',
    'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi', 'π': '\\pi', 'ϖ': '\\varpi', 'ρ': '\\rho', 'ϱ': '\\varrho',
    'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
    'Γ': '\\Gamma', 'Δ': '\\Delta', '∆': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  };
  // 出现即可认定为数学内容的字符（… · ° 等在正文里也常见，不算）
  // 正文里也常见的符号不算“数学内容”（? 表示这里本来有一串符号，见 tools/reconstruct_gbk_damage.py）
  const PROSE_SYMBOLS = new Set(['…', '·', '⋅', '∙', '°', '˚', '′', '″', '-', '−', '‐', '‒', '–', '—', '’', '‘']);
  /** 放进正则字符类里前先转义（否则 '-' 会被当成区间） */
  const inClass = (c) => c.replace(/[\\\]^-]/g, '\\$&');
  const SYMBOL_KEYS = Object.keys(SYMBOLS);
  const MATH_TRIGGER_RE = new RegExp(`[${SYMBOL_KEYS.filter((c) => !PROSE_SYMBOLS.has(c)).map(inClass).join('')}\\u221a\\u2206]`);
  const SYMBOL_RE = new RegExp(`[${SYMBOL_KEYS.map(inClass).join('')}]`, 'g');
  const FN_NAMES = 'max|min|gcd|lcm|log|ln|lg|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|exp|mod|det|deg|arg|lim|sup|inf|sgn|dim|ker|rank|Pr';
  const FN_WORD_RE = new RegExp(`(?<![A-Za-z\\\\])(${FN_NAMES})(?![A-Za-z])`, 'g');
  const FN_TOKEN_RE = new RegExp(`^(?:${FN_NAMES})$`);
  const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u{20000}-\u{2fa1f}]/u;
  const isCjk = (ch) => !!ch && CJK_CHAR_RE.test(ch);

  // 关系符 / 二元运算符：LaTeX 里两侧各留一个空格更易读
  const REL_OP_RE = new RegExp(`\\s*(\\\\(?:${['le', 'ge', 'ne', 'approx', 'equiv', 'sim', 'll', 'gg', 'cong', 'simeq', 'propto', 'times', 'div', 'pm', 'mp', 'cdot', 'circ', 'star',
    'in', 'notin', 'ni', 'subset', 'supset', 'subseteq', 'supseteq', 'cup', 'cap', 'land', 'lor', 'oplus', 'otimes', 'odot', 'perp', 'parallel', 'mid', 'nmid',
    'to', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'therefore', 'because'].join('|')})(?![A-Za-z]))\\s*`, 'g');

  const SUP_OPEN = '\u0001';
  const SUB_OPEN = '\u0002';
  const SCR_CLOSE = '\u0003';
  const FRAC_OPEN = '\u0004';                 // \u0004 分子 \u0005 分母 \u0003
  const FRAC_MID = '\u0005';
  const TSUP_OPEN = '\u0006';                 // 挂在普通单词 / 汉字上的上下标（作者角标、脚注号）：输出成 <sup> / <sub>，不进公式
  const TSUB_OPEN = '\u0007';

  function weightedMedian(pairs) {
    const a = pairs.slice().sort((p, q) => p[0] - q[0]);
    const total = a.reduce((s, p) => s + p[1], 0);
    let acc = 0;
    for (const [v, w] of a) { acc += w; if (acc >= total / 2) return v; }
    return a.length ? a[a.length - 1][0] : 0;
  }

  const mulMatrix = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];

  /**
   * pdf.js getTextContent().items → 片段。viewport: { transform, scale }；fontInfo: fontName → classifyFont() 的结果。
   * 旋转的文字（水印 / 页边的竖排编号）直接丢弃。
   */
  function spansFromTextContent(items, viewport, fontInfo) {
    const out = [];
    for (const it of items || []) {
      if (!it || typeof it.str !== 'string' || !it.str || !it.transform) continue;
      const tr = mulMatrix(viewport.transform, it.transform);
      const size = Math.hypot(tr[2], tr[3]);
      if (!(size > 0.5) || !Number.isFinite(tr[4]) || !Number.isFinite(tr[5])) continue;
      if (Math.abs(tr[1]) > 0.2 * Math.abs(tr[0]) || tr[0] <= 0) continue;
      const fi = (fontInfo && fontInfo[it.fontName]) || {};
      out.push({
        str: it.str, x: tr[4], y: tr[5], w: Math.abs(it.width || 0) * (viewport.scale || 1), size,
        bold: !!fi.bold, italic: !!fi.italic, mono: !!fi.mono,
        math: !!fi.math || /[\u{1d400}-\u{1d7ff}]/u.test(it.str),
      });
    }
    return out;
  }

  /** 页面质量：非空白字符数，以及乱码（NUL / 替换符 / 私用区）所占比例。 */
  function pageTextStats(spans) {
    let chars = 0;
    let bad = 0;
    for (const sp of spans) {
      for (const ch of sp.str) {
        if (/\s/.test(ch)) continue;
        chars++;
        if (/[\u0000\ufffd\ue000-\uf8ff]/.test(ch) && !/[\uf0b7\uf0a7\uf076]/.test(ch)) bad++;
      }
    }
    return { chars, bad, garbled: chars > 0 && bad / chars > 0.3 };
  }

  /* ---------- 行聚类：垂直方向上的“字带”重叠超过一半的片段属于同一行（上下标自然并入） ---------- */
  function clusterLines(spans) {
    const order = spans.slice().sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x);
    const lines = [];
    for (const sp of order) {
      const top = sp.y - 0.8 * sp.size;
      const bot = sp.y + 0.22 * sp.size;
      let best = null;
      let bestRatio = 0;
      for (const ln of lines) {
        const ov = Math.min(bot, ln.bot) - Math.max(top, ln.top);
        if (ov <= 0) continue;
        const ratio = ov / Math.min(bot - top, ln.bot - ln.top);
        if (ratio > bestRatio) { bestRatio = ratio; best = ln; }
      }
      // 小号的片段（大型运算符的上下限等）与旁边大号片段的字带只重叠一部分时，只要紧挨着也算同一行
      const nearBig = (ln) => ln.spans.some((o) => o.size >= 1.15 * sp.size && sp.x - (o.x + o.w) <= 0.6 * sp.size && o.x - (sp.x + sp.w) <= 0.6 * sp.size);
      if (best && (bestRatio >= 0.5 || (bestRatio >= 0.2 && sp.size <= 0.8 * best.spans[0].size && nearBig(best)))) best.spans.push(sp);
      else lines.push({ spans: [sp], top, bot });
    }
    for (const ln of lines) {
      const maxSize = Math.max(...ln.spans.map((s) => s.size));
      const main = ln.spans.filter((s) => s.size >= 0.8 * maxSize);
      ln.S = maxSize;
      ln.B = weightedMedian(main.map((s) => [s.y, Math.max(1, s.str.trim().length)]));
      ln.x0 = Math.min(...ln.spans.map((s) => s.x));
      ln.x1 = Math.max(...ln.spans.map((s) => s.x + s.w));
    }
    return lines.sort((a, b) => a.B - b.B || a.x0 - b.x0);
  }

  /* ---------- 一行 → 带标记的字符串 ---------- */
  function classifySpan(sp, S, B) {
    if (sp.size > 0.92 * S) return 'base';
    const dy = sp.y - B;
    if (dy < -0.18 * S) return 'sup';
    if (dy > 0.1 * S) return 'sub';
    return 'base';
  }

  function needSpace(prevCh, nextCh, gap, size, hint) {
    if (hint) return true;
    const cp = isCjk(prevCh);
    const cn = isCjk(nextCh);
    if (cp && cn) return gap > 0.55 * size;                 // 汉字之间一般不加空格；排版时的全角空格 / 大空隙才算分隔
    return gap > ((cp || cn) ? 0.12 : 0.17) * size;
  }

  /** 着重号：汉字下面的小圆点（单独的 “.” / “·”，位置比基线低），不是正文。 */
  function isEmphasisDot(sp, S, B, cjkSpans) {
    return /^[.·•˙‧]$/.test(sp.str.trim()) && sp.y - B > 0.15 * S
      && cjkSpans.some((c) => sp.x >= c.x - 0.3 * S && sp.x + sp.w <= c.x + c.w + 0.3 * S);
  }

  // 脚本（上下标）只能挂在“像底数”的东西后面：汉字 / 标点 / 空白后面的小号文字不是上下标
  const canCarry = (text) => !!text && !isCjk(text[text.length - 1]) && !/[\s,.;:!?"'“”‘’([{<>=+\-?*/]$/.test(text);

  /** 把同类脚本片段按相邻程度分成若干“串”。 */
  function scriptRuns(list) {
    const runs = [];
    for (const sp of list.slice().sort((a, b) => a.x - b.x)) {
      const last = runs[runs.length - 1];
      if (last && sp.x <= last.right + 0.6 * sp.size) { last.spans.push(sp); last.right = Math.max(last.right, sp.x + sp.w); }
      else runs.push({ spans: [sp], left: sp.x, right: sp.x + sp.w });
    }
    return runs;
  }

  /**
   * 把一组片段（一行，或脚本里的一小段）渲染成字符串。
   * 返回 { s, f, st }：s 是文字（上下标用 \u0001 / \u0002 开头、\u0003 结尾的哨兵包起来，分数用 \u0004 分子 \u0005 分母 \u0003），
   * f 是逐字符的“来自数学字体”标记（'1' / '0'），st 是逐字符的样式（'0' 普通 / '1' 粗体 / '2' 行内代码）。
   * ctx = { bold, mono }：整行的主体样式；只有与主体样式不同的片段才会单独标记。
   */
  function renderSpans(spans, S, B, ctx, depth) {
    const sorted = spans.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const atoms = [];
    const free = [];
    const cjkSpans = sorted.filter((x) => isCjk(x.str.trim()[0]));
    let negate = false;
    for (const sp of sorted) {
      if (isEmphasisDot(sp, S, B, cjkSpans)) continue;
      if (/^\s*\u0338\s*$/.test(sp.str)) { negate = true; continue; }             // \not 的斜线：并入后面的关系符
      const kind = depth > 3 ? 'base' : classifySpan(sp, S, B);
      if (kind === 'base') {
        let text = sp.str.replace(/\s+/g, ' ').trim();
        if (negate && text) {                                                    // \not 的斜线 + 关系符 → 合体的“否定”符号
          text = text.replace(/^=/, '≠').replace(/^∈/, '∉').replace(/^[<>≤≥∣⊂⊆]/, (c) => ({ '<': '≮', '>': '≯', '≤': '≰', '≥': '≱', '∣': '∤', '⊂': '⊄', '⊆': '⊈' }[c]));
          negate = false;
        }
        atoms.push({ sp, sups: [], subs: [], left: sp.x, right: sp.x + sp.w, text });
        continue;
      }
      // 找挂靠的底数：x 最靠近、在它左边的底数原子
      let target = null;
      for (const a of atoms) if (a.sp && a.left <= sp.x + 0.5 * S && (!target || a.left >= target.left)) target = a;
      // 角标紧贴着底数：底数自带结尾空格、或者与单词之间隔了一个词间距的，是句子中间的行内分数，不是这个单词的上下标
      const reach = target && /[A-Za-z]{2,}$/.test(target.text) ? 0.3 : 0.9;
      if (target && !/\s$/.test(target.sp.str) && sp.x <= target.right + reach * S && canCarry(target.text)) {
        (kind === 'sup' ? target.sups : target.subs).push(sp);
        target.right = Math.max(target.right, sp.x + sp.w);
      } else free.push({ sp, kind });
    }
    // 没有底数的上下标：上下叠放且水平重合的是分数，其余当作孤立的脚注式上下标
    const supRuns = scriptRuns(free.filter((x) => x.kind === 'sup').map((x) => x.sp));
    const subRuns = scriptRuns(free.filter((x) => x.kind === 'sub').map((x) => x.sp));
    const usedSub = new Set();
    for (const up of supRuns) {
      const down = subRuns.find((d) => !usedSub.has(d) && Math.min(up.right, d.right) - Math.max(up.left, d.left) >= 0.4 * Math.min(up.right - up.left, d.right - d.left));
      if (down) { usedSub.add(down); atoms.push({ frac: [up.spans, down.spans], left: Math.min(up.left, down.left), right: Math.max(up.right, down.right) }); }
      else atoms.push({ sups: up.spans, subs: [], left: up.left, right: up.right, text: '' });
    }
    for (const d of subRuns) if (!usedSub.has(d)) atoms.push({ sups: [], subs: d.spans, left: d.left, right: d.right, text: '' });
    atoms.sort((a, b) => a.left - b.left);

    let s = '';
    let f = '';
    let st = '';
    const add = (t, flag, style) => { s += t; f += (flag ? '1' : '0').repeat(t.length); st += style.repeat(t.length); };
    const sub = (list) => {
      const size = Math.max(...list.map((x) => x.size));
      const main = list.filter((x) => x.size >= 0.8 * size);
      const base = weightedMedian(main.map((x) => [x.y, Math.max(1, x.str.trim().length)]));
      return renderSpans(list, size, base, { bold: false, mono: false }, depth + 1).s;
    };
    const addScript = (open, list) => { add(open, true, '0'); add(sub(list), true, '0'); add(SCR_CLOSE, true, '0'); };
    // 粗体：夹在两段粗体之间的数字 / 标点（字体不同导致的）也算粗体
    const isBold = (a) => !!a.sp && a.sp.bold && !a.sp.math && !ctx.bold;
    atoms.forEach((a, k) => { a.bold = isBold(a); });
    atoms.forEach((a, k) => {
      if (a.sp && !a.bold && !ctx.bold && /^[\d\s.,:;()（）/%+\-–—]+$/.test(a.text || '') && k > 0 && k < atoms.length - 1 && atoms[k - 1].bold && atoms[k + 1].bold) a.boldFill = true;
    });
    let prev = null;
    for (const a of atoms) {
      if (a.frac) {
        if (prev && (prev.trail || a.left - prev.right > 0.17 * S)) add(' ', false, '0');       // 分数前面的词间距：留在公式外面
        add(FRAC_OPEN, true, '0'); add(sub(a.frac[0]), true, '0'); add(FRAC_MID, true, '0'); add(sub(a.frac[1]), true, '0'); add(SCR_CLOSE, true, '0');
        prev = { right: a.right, last: ')', trail: false, size: S, style: '0' };
        continue;
      }
      const sp = a.sp;
      const text = a.text;
      if (sp && !text) continue;
      const lead = sp ? /^\s/.test(sp.str) : false;
      const size = sp ? sp.size : S;
      const strong = !!sp && (sp.math || (sp.italic && /^[A-Za-z]$/.test(text)));
      let style = '0';
      if (sp && !strong && sp.mono && !ctx.mono) style = '2';
      else if (sp && !strong && (a.bold || a.boldFill)) style = '1';
      if (sp && prev && needSpace(prev.last, text[0], a.left - prev.right, Math.min(prev.size, size), lead || prev.trail)) add(' ', false, prev.style === style ? style : '0');
      if (sp) {
        add(text, strong, style);
        a.style = style;
        a.wordy = !strong && (/[A-Za-z]{2,}/.test(text) || isCjk(text[text.length - 1]));
      } else if (prev && a.left - prev.right > 0.17 * S) add(' ', false, '0');
      if (a.wordy) {           // 单词 / 汉字上的角标：当作文字，不进公式
        if (a.subs.length) { add(TSUB_OPEN, false, a.style); add(sub(a.subs).replace(/[\u0001-\u0007]/g, ''), false, a.style); add(SCR_CLOSE, false, a.style); }
        if (a.sups.length) { add(TSUP_OPEN, false, a.style); add(sub(a.sups).replace(/[\u0001-\u0007]/g, ''), false, a.style); add(SCR_CLOSE, false, a.style); }
      } else {
        if (a.subs.length) addScript(SUB_OPEN, a.subs);
        if (a.sups.length) addScript(SUP_OPEN, a.sups);
      }
      prev = { right: a.right, last: text ? text[text.length - 1] : ')', trail: sp ? /\s$/.test(sp.str) : false, size, style: a.style || '0' };
    }
    return { s, f, st };
  }

  /* ---------- 行内数学：识别公式片段并包上 $...$，把 Unicode 符号换成 LaTeX ---------- */
  const stripScripts = (t) => {
    let prev;
    do { prev = t; t = t.replace(/[\u0001\u0002\u0004][^\u0001\u0002\u0004\u0003]*\u0003/g, ''); } while (t !== prev);
    return t;
  };
  const MATHY_CORE_RE = /^[A-Za-z0-9+\-?*/=<>()[\]{}|!%'’,.;:~^_\u2032\u2033]+$/;

  /** 一个不含空格 / CJK 的词：'strong'（一定是数学）| 'weak'（可能是数学的一部分）| 'fn'（函数名）| 'text' */
  function tokenKind(tok, flags) {
    if (/[\u0001\u0002\u0004]/.test(tok) || flags.includes('1') || MATH_TRIGGER_RE.test(tok)) return 'strong';
    const core = stripScripts(tok).replace(FN_WORD_RE, '');
    if (core !== stripScripts(tok) && MATHY_CORE_RE.test(core) && /[(\d]/.test(core)) return 'strong';        // max(a,b) 这种函数调用
    if (FN_TOKEN_RE.test(tok)) return 'fn';
    if (MATHY_CORE_RE.test(core) && !/[A-Za-z]{2,}/.test(core)) return 'weak';
    return 'text';
  }

  function trimMathEdges(core) {
    let lead = '';
    let trail = '';
    let m;
    while ((m = /^[\s,.;:!?)\]]+/.exec(core))) { lead += m[0]; core = core.slice(m[0].length); }
    for (;;) {
      if ((m = /[\s,.;:!?]+$/.exec(core))) { trail = m[0] + trail; core = core.slice(0, -m[0].length); continue; }
      const opens = (stripScripts(core).match(/[([]/g) || []).length;
      const closes = (stripScripts(core).match(/[)\]]/g) || []).length;
      if (closes > opens && /[)\]]$/.test(core)) { trail = core.slice(-1) + trail; core = core.slice(0, -1); continue; }
      if (opens > closes && /[([]$/.test(core)) { trail = core.slice(-1) + trail; core = core.slice(0, -1); continue; }
      break;
    }
    while (/^[([]/.test(core) && (stripScripts(core).match(/[([]/g) || []).length > (stripScripts(core).match(/[)\]]/g) || []).length) {
      lead += core[0];
      core = core.slice(1);
    }
    return { lead, core, trail };
  }

  /** 区域内文字 → LaTeX。 */
  function toLatex(core) {
    let t = core.replace(/[%&#${}]/g, (c) => `\\${c}`);                          // 字面量的特殊字符先转义，后面生成的花括号不受影响
    t = t.replace(/\(\s*mod\s+([^()]*)\)/g, '\\pmod{$1}');
    t = t.replace(/√\s*(\([^()]*\)|[A-Za-z0-9]+(?:[\u0001\u0002][^\u0001\u0002\u0003]*\u0003)*)/g, (_, op) => `\\sqrt{${/^\(.*\)$/.test(op) ? op.slice(1, -1) : op}}`);
    t = t.replace(/\.\s?\.\s?\./g, '\\dots');
    // 宏名后面紧跟字母 / 数字时补一个空格，否则会和后面的字符连成另一个宏名
    const macro = (name, str, at) => (/[A-Za-z0-9]/.test(str[at + 1] || '') ? `${name} ` : name);
    t = t.replace(SYMBOL_RE, (c, at, str) => (/^\\[A-Za-z]+$/.test(SYMBOLS[c]) ? macro(SYMBOLS[c], str, at) : SYMBOLS[c]));
    t = t.replace(FN_WORD_RE, (m, fn, at, str) => macro(fn === 'mod' ? '\\bmod' : `\\${fn}`, str, at + m.length - 1));
    t = t.replace(REL_OP_RE, ' $1 ');
    t = t.replace(/\u0001/g, '^{').replace(/\u0002/g, '_{').replace(/\u0004/g, '\\frac{').replace(/\u0005/g, '}{').replace(/\u0003/g, '}');
    t = t.replace(/([_^])\{([A-Za-z0-9])\}/g, '$1$2');                          // x^{2} → x^2
    t = t.replace(/\s+/g, ' ').replace(/ ([,;)\]^_])/g, '$1').replace(/([([]) /g, '$1').replace(/ \}/g, '}').replace(/\{ /g, '{');
    return t.trim();
  }

  /**
   * 在一行里找数学区域。返回片段数组 [{ t, math, from, to }]（from / to 是在原字符串里的区间，用来对齐样式）。
   * 规则：按空格和 CJK 边界切词；含数学字体字符 / 上下标 / 数学符号的词是“强”词，数字、单字母、运算符、括号是“弱”词，
   * 多字母单词和汉字会断开区域；一个区域里至少要有一个强词（或 = < >）才算公式。
   */
  function wrapMath(s, f) {
    const tokens = [];
    const re = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u{20000}-\u{2fa1f}]+|[^\s\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u{20000}-\u{2fa1f}]+/gu;
    let m;
    while ((m = re.exec(s))) {
      const cjk = isCjk(m[0][0]);
      tokens.push({ from: m.index, to: m.index + m[0].length, text: m[0], kind: cjk ? 'cjk' : tokenKind(m[0], f.slice(m.index, m.index + m[0].length)) });
    }
    const regions = [];
    for (let i = 0; i < tokens.length;) {
      if (!['strong', 'weak', 'fn'].includes(tokens[i].kind)) { i++; continue; }
      let j = i;
      let trigger = false;
      while (j < tokens.length && ['strong', 'weak', 'fn'].includes(tokens[j].kind)) {
        const t = tokens[j];
        if (t.kind === 'strong' || /[=<>]/.test(stripScripts(t.text))) trigger = true;
        // 词与词之间只能隔空白（不隔其他字符，tokens 本来就是连续的非空白段）
        j++;
      }
      let a = i;
      let b = j;
      while (a < b && tokens[a].kind === 'fn') a++;
      while (b > a && tokens[b - 1].kind === 'fn') b--;
      if (trigger && a < b) regions.push({ from: tokens[a].from, to: tokens[b - 1].to });
      i = j;
    }
    const out = [];
    let pos = 0;
    const pushText = (from, to) => { if (to > from) out.push({ t: s.slice(from, to), math: false, from, to }); };
    for (const r of regions) {
      const { lead, core, trail } = trimMathEdges(s.slice(r.from, r.to));
      if (!core.trim()) continue;
      const from = r.from + lead.length;
      const to = r.to - trail.length;
      pushText(pos, from);
      out.push({ t: core, math: true, from, to });
      pos = to;
    }
    pushText(pos, s.length);
    return out;
  }

  /** Markdown 行内特殊字符转义（只处理会破坏排版的几个；公式和代码不经过这里）。 */
  function escMd(t) {
    return t.replace(/\\/g, '\\\\').replace(/[*`<$]/g, (c) => `\\${c}`).replace(/(^|[\s(（])_|_($|[\s)）])/g, (m) => m.replace('_', '\\_'));
  }

  /** 普通文字 → Markdown：转义特殊字符，并把文字上下标哨兵换成 <sup> / <sub>。 */
  function plainToMd(t) {
    let out = '';
    let last = 0;
    const re = /([\u0006\u0007])([^\u0003]*)\u0003/g;
    let m;
    while ((m = re.exec(t))) {
      const tag = m[1] === TSUP_OPEN ? 'sup' : 'sub';
      out += `${escMd(t.slice(last, m.index))}<${tag}>${escMd(m[2])}</${tag}>`;
      last = re.lastIndex;
    }
    return out + escMd(t.slice(last));
  }

  function codeSpanMd(t) {
    const fence = t.includes('`') ? '``' : '`';
    return fence + (/^`|`$/.test(t) ? ` ${t} ` : t) + fence;
  }

  /** 片段数组 + 样式 → 行内 Markdown。 */
  function emitInline(segs, st) {
    let out = '';
    for (const seg of segs) {
      if (seg.math) {
        const sc = /^([\u0001\u0002])([^\u0001\u0002\u0003]*)\u0003$/.exec(seg.t);
        if (sc) {                                       // 没有底数的孤立上下标（脚注号之类）：用 HTML 标签
          const tag = sc[1] === SUP_OPEN ? 'sup' : 'sub';
          out += `<${tag}>${escMd(sc[2])}</${tag}>`;
        } else {
          out += `$${toLatex(seg.t)}$`;
        }
        continue;
      }
      // 按样式切段
      let i = seg.from;
      while (i < seg.to) {
        let j = i;
        while (j < seg.to && st[j] === st[i]) j++;
        const piece = seg.t.slice(i - seg.from, j - seg.from);
        const lead = /^\s*/.exec(piece)[0];
        const trail = /\s*$/.exec(piece)[0];
        if (st[i] === '2' && piece.trim()) out += `${lead}${codeSpanMd(piece.trim())}${trail}`;
        else if (st[i] === '1' && piece.trim()) out += `${lead}**${plainToMd(piece.trim())}**${trail}`;
        else out += plainToMd(piece);
        i = j;
      }
    }
    return out.replace(/[\u0001-\u0007]/g, '').replace(/ {2,}/g, ' ').trim();
  }

  /** 一行（或一格）→ { text（Markdown）, raw（无标记的纯文字，用来做判断）}。 */
  function renderLineParts(spans, S, B, ctx) {
    const { s, f, st } = renderSpans(spans, S, B, ctx, 0);
    const segs = wrapMath(s, f);
    return { text: emitInline(segs, st), raw: s.replace(/[\u0001\u0002\u0003]/g, ''), segs, s };
  }

  /* ---------- 页面 → 行（带各种统计量） ---------- */
  const CELL_GAP = 0.8;            // 两个片段之间的空隙超过 0.8 倍字号就算分成两格（LaTeX 表格列间距默认约 1 倍字号）
  const TERMINAL_RE = /[。！？；：.!?;:…]["”’）)]*$/;
  const BULLET_ONLY_RE = new RegExp(`^[${BULLET_CHARS}·]$`);
  const BULLET_PREFIX_RE = new RegExp(`^[${BULLET_CHARS}·]\\s*`);

  function lineFeatures(cluster, cellCount) {
    const cjkSpans = cluster.spans.filter((x) => isCjk(x.str.trim()[0]));
    const spans = cluster.spans.filter((s) => s.str.trim() && !isEmphasisDot(s, cluster.S, cluster.B, cjkSpans));
    const weight = (s) => Math.max(1, s.str.trim().length);
    const total = spans.reduce((a, s) => a + weight(s), 0) || 1;
    const frac = (pred) => spans.filter(pred).reduce((a, s) => a + weight(s), 0) / total;
    const textSpans = spans.filter((s) => !s.math);
    const textTotal = textSpans.reduce((a, s) => a + weight(s), 0);
    return {
      // 一行里有 3 格以上、每格隔得很开的，是表格（哪怕里面是等宽字体），不是代码
      mono: frac((s) => s.mono) >= 0.6 && cellCount < 3,
      bold: textTotal > 0 && textSpans.filter((s) => s.bold).reduce((a, s) => a + weight(s), 0) / textTotal >= 0.6,
      // 整行都是数学字体时没有可靠的“正文字号”
      textSize: textTotal ? weightedMedian(textSpans.map((s) => [s.size, weight(s)])) : null,
    };
  }

  function splitCells(cluster) {
    const sorted = cluster.spans.filter((s) => s.str.trim()).sort((a, b) => a.x - b.x);
    const groups = [];
    let right = -Infinity;
    for (const sp of sorted) {
      if (!groups.length || sp.x > right + CELL_GAP * cluster.S) groups.push([]);
      groups[groups.length - 1].push(sp);
      right = Math.max(right, sp.x + sp.w);
    }
    return groups.map((g) => ({ spans: g, x0: Math.min(...g.map((s) => s.x)), x1: Math.max(...g.map((s) => s.x + s.w)) }));
  }

  /** 行首的项目符号（• ● – - 等）：从片段里拿掉，记下来。 */
  function takeBullet(spans, S) {
    const vis = spans.filter((s) => s.str.trim()).sort((a, b) => a.x - b.x);
    if (!vis.length) return { spans, bullet: false };
    const first = vis[0];
    const t = first.str.trim();
    let rest = null;
    if (BULLET_ONLY_RE.test(t)) rest = '';
    else if (BULLET_PREFIX_RE.test(t) && t.length > 1) rest = t.replace(BULLET_PREFIX_RE, '');
    else if (/^[-–—*]$/.test(t) && vis[1] && vis[1].x - (first.x + first.w) > 0.25 * S) rest = '';
    else if (/^[-–—*]\s+\S/.test(first.str.replace(/^\s+/, ''))) rest = t.replace(/^[-–—*]\s+/, '');
    if (rest == null) return { spans, bullet: false };
    const out = spans.filter((s) => s !== first);
    if (rest) out.push(Object.assign({}, first, { str: rest, x: first.x + first.w * (1 - rest.length / Math.max(1, t.length)) }));
    return { spans: out, bullet: true };
  }

  function buildLines(page) {
    const spans = [];
    for (const sp of page.spans) {
      const str = normChars(sp.str);
      if (str.trim()) spans.push(Object.assign({}, sp, { str }));
    }
    const lines = [];
    for (const c0 of clusterLines(spans)) {
      const tb = takeBullet(c0.spans, c0.S);
      const c = tb.bullet ? Object.assign({}, c0, { spans: tb.spans }) : c0;
      if (tb.bullet) {
        if (!c.spans.some((s) => s.str.trim())) continue;
        c.x0 = Math.min(...c.spans.map((s) => s.x));
      }
      const groups = splitCells(c);
      const feat = lineFeatures(c, groups.length);
      const ctx = { bold: feat.bold, mono: feat.mono };
      const cells = groups.map((g) => Object.assign(g, renderLineParts(g.spans, c.S, c.B, ctx)));
      const text = cells.map((g) => g.text).join(' ').trim();
      const raw = cells.map((g) => g.raw).join(' ').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      lines.push({
        spans: c.spans, cells, text, raw, S: c.S, B: c.B, x0: tb.bullet ? c0.x0 : c.x0, textX0: c.x0, x1: c.x1,
        mono: feat.mono, bold: feat.bold, size: feat.textSize || c.S, mathOnly: feat.textSize == null,
        bullet: tb.bullet, cjk: /[\u3400-\u9fff]/.test(raw), display: false, tableId: -1, colRun: -1, page: 0,
      });
    }
    return lines;
  }

  /* ---------- 文档级统计 ---------- */
  function mostCommon(values, binSize) {
    const m = new Map();
    for (const v of values) { const k = Math.round(v / binSize) * binSize; m.set(k, (m.get(k) || 0) + 1); }
    let best = null;
    for (const [k, n] of m) if (!best || n > best.n || (n === best.n && k < best.k)) best = { k, n };
    return best ? best.k : null;
  }

  function docStats(pages) {
    const sizeW = new Map();
    for (const p of pages) {
      for (const ln of p.lines) {
        if (ln.mono) continue;
        for (const sp of ln.spans) {
          if (sp.math || !sp.str.trim()) continue;
          const k = Math.round(sp.size * 2) / 2;
          sizeW.set(k, (sizeW.get(k) || 0) + sp.str.trim().length);
        }
      }
    }
    let body = 0;
    let bestW = -1;
    for (const [k, w] of sizeW) if (w > bestW) { bestW = w; body = k; }
    if (!body) body = 12;
    const steps = [];
    const lefts = [];
    let right = 0;
    for (const p of pages) {
      p.lines.forEach((ln, i) => {
        if (ln.mono) return;
        lefts.push(ln.x0);
        right = Math.max(right, ln.x1);
        const prev = p.lines[i - 1];
        if (prev && !prev.mono) {
          const d = ln.B - prev.B;
          if (d >= 0.9 * body && d <= 2.2 * body) steps.push(d);
        }
      });
    }
    return {
      body,
      step: (steps.length ? mostCommon(steps, 0.5) : null) || 1.4 * body,
      left: lefts.length ? mostCommon(lefts, 2) : 0,
      right,
    };
  }

  /* ---------- 页眉 / 页脚 / 页码 ---------- */
  const PAGE_NO_RE = /^(?:[-–— ]*\d+[-–— ]*|第\s*\d+\s*页(?:\s*[,，]?\s*共\s*\d+\s*页)?|共\s*\d+\s*页|page\s*\d+(?:\s*(?:of|\/)\s*\d+)?|\d+\s*\/\s*\d+)$/i;
  // “第 3 页 共 9 页”“Page 3 of 9”这种一看就是页码的写法（不含光秃秃的数字）：页边区域放宽一些也敢删（NOIP 的页脚在页面高度的 92.6% 处）
  const PAGE_LABEL_RE = /^(?:第\s*\d+\s*页(?:\s*[,，]?\s*共\s*\d+\s*页)?|共\s*\d+\s*页|page\s*\d+(?:\s*(?:of|\/)\s*\d+)?|\d+\s*\/\s*\d+)$/i;
  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  function stripHeadersFooters(pages) {
    const key = (ln) => ln.raw.replace(/\d+/g, '#').replace(/\s+/g, '');
    const zone = (p, ln) => (ln.B < 0.09 * p.height ? 'top' : (ln.B > 0.93 * p.height ? 'bottom' : null));
    // 每页页边区域的行
    const margins = pages.map((p) => p.lines.filter((ln) => zone(p, ln)).map((ln) => ({ z: zone(p, ln), k: key(ln) })));
    const repeated = (pi, ln, z) => {
      const k = key(ln);
      if (ln.raw.length > 100 || pages.length < 2) return false;
      return margins.some((ms, qi) => qi !== pi && ms.some((m) => m.z === z && (m.k === k || commonPrefix(m.k, k) >= Math.max(8, 0.6 * Math.min(m.k.length, k.length)))));
    };
    // 离页边稍远的页眉 / 页脚（NOI 的页眉在页高 10%–12% 处，字号只有正文的 0.75 倍）：小字号、在页面上下沿一带，
    // 而且别的页的同一个高度（±3pt）也有同样（数字规整后）文字的行
    const orig = pages.map((p) => p.lines.slice());           // 逐页过滤之前的快照：前面的页删掉页眉之后，后面的页仍要拿它们比
    const sizes = [];
    pages.forEach((p) => p.lines.forEach((ln) => { if (!ln.mono) sizes.push(ln.size); }));
    sizes.sort((a, b) => a - b);
    const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 12;
    // 要有实实在在的文字（至少 6 个字符、含连续两个字母 / 汉字）：样例数据、行号、孤零零的数字不会被误删
    const runningHead = (pi, p, ln) => !ln.mono && ln.size <= 0.85 * medianSize && (ln.B < 0.16 * p.height || ln.B > 0.88 * p.height)
      && ln.raw.length >= 6 && ln.raw.length <= 100 && /\p{L}{2,}/u.test(ln.raw)
      && orig.some((lines, qi) => qi !== pi && lines.some((o) => Math.abs(o.B - ln.B) <= 3 && o.raw.length <= 100 && key(o) === key(ln)));
    pages.forEach((p, pi) => {
      p.lines = p.lines.filter((ln) => {
        if ((ln.B > 0.85 * p.height || ln.B < 0.15 * p.height) && PAGE_LABEL_RE.test(ln.raw)) return false;
        if (runningHead(pi, p, ln)) return false;
        const z = zone(p, ln);
        if (!z) return true;
        if (PAGE_NO_RE.test(ln.raw)) return false;
        return !repeated(pi, ln, z);
      });
    });
  }

  /* ---------- 表格 ---------- */
  function detectTables(lines, doc) {
    let id = 0;
    for (let i = 0; i < lines.length;) {
      const first = lines[i];
      if (first.mono || first.cells.length < 2) { i++; continue; }
      let j = i + 1;
      while (j < lines.length) {
        const a = lines[j - 1];
        const b = lines[j];
        if (b.page !== a.page || b.mono || b.cells.length < 2 || b.B - a.B > 2.6 * Math.max(a.S, b.S)) break;
        j++;
      }
      const rows = lines.slice(i, j);
      const cols = tableColumns(rows, doc);
      if (rows.length >= 2 && cols) {
        const tol = 0.3 * doc.body;
        for (const r of rows) r.colIndex = r.cells.map((c) => cols.findIndex((v) => c.x0 <= v[1] + tol && c.x1 >= v[0] - tol));
        // 每格都是整句整句的长文字：是分栏排版（论文），不是表格
        const all = rows.flatMap((r) => r.cells);
        const prose = rows.length >= 4 && cols.length <= 3 && all.filter((c) => c.raw.length >= 28).length >= 0.5 * all.length;
        for (const r of rows) { if (prose) r.colRun = id; else r.tableId = id; }
        id++;
      }
      i = j;
    }
  }

  /** 分栏排版：把“一行两栏”的连续行改成先读完左栏再读右栏。 */
  function serializeColumns(lines) {
    const out = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i].colRun < 0) { out.push(lines[i]); i++; continue; }
      let j = i;
      while (j < lines.length && lines[j].colRun === lines[i].colRun) j++;
      const rows = lines.slice(i, j);
      const ncol = Math.max(...rows.map((r) => Math.max(...r.colIndex) + 1));
      for (let k = 0; k < ncol; k++) {
        for (const r of rows) {
          r.cells.forEach((c, ci) => {
            if (r.colIndex[ci] !== k) return;
            out.push(Object.assign({}, r, { spans: c.spans, cells: [c], text: c.text, raw: c.raw, x0: c.x0, textX0: c.x0, x1: c.x1, bullet: r.bullet && ci === 0, colRun: -1, tableId: -1 }));
          });
        }
      }
      i = j;
    }
    return out;
  }

  function tableColumns(rows, doc) {
    const tol = 0.3 * doc.body;
    const ivs = [];
    rows.forEach((r) => r.cells.forEach((c) => ivs.push([c.x0, c.x1])));
    ivs.sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const iv of ivs) {
      const last = cols[cols.length - 1];
      if (last && iv[0] <= last[1] + tol) last[1] = Math.max(last[1], iv[1]);
      else cols.push([iv[0], iv[1]]);
    }
    if (cols.length < 2 || cols.length > 12) return null;
    const count = cols.map(() => 0);
    for (const r of rows) {
      const seen = new Set();
      for (const c of r.cells) {
        const k = cols.findIndex((v) => c.x0 <= v[1] + tol && c.x1 >= v[0] - tol);
        if (k >= 0) seen.add(k);
      }
      for (const k of seen) count[k]++;
    }
    return count.filter((n) => n >= 2).length >= 2 ? cols : null;
  }

  function gridToMd(rows) {
    const width = Math.max(...rows.map((r) => Math.max(...r.colIndex) + 1));
    const grid = rows.map((r) => {
      const cells = Array(width).fill('');
      r.cells.forEach((c, k) => {
        const col = Math.max(0, r.colIndex[k]);
        cells[col] = `${cells[col]} ${c.text}`.trim();
      });
      return cells.map((t) => t.replace(/\|/g, '\\|'));
    });
    const line = (r) => `| ${r.join(' | ')} |`;
    return [line(grid[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...grid.slice(1).map(line)].join('\n');
  }

  /* ---------- 标题 / 样例 / 列表 ---------- */
  const SAMPLE_HEAD_RE = /^[【[(（]?\s*(?:(?:样例|示例|样本|输入输出样例|sample|example)s?\s*)?(?:输入|输出|input|output)?(?:\s*(?:样例|示例|sample|example))?\s*[#＃]?\s*[\d一二三四五六七八九十]*\s*(?:输入|输出|input|output)?\s*[】\])）]?\s*[:：]?$/i;
  const isSampleHead = (raw) => raw.length <= 24 && /(样例|示例|样本|sample|example|输入|输出|input|output)/i.test(raw) && SAMPLE_HEAD_RE.test(raw.trim());

  // 题号 / 序号：“第一题”“题目 B”“Problem A”“T3”“A.”“2、”
  const LABEL_RE = /^(?:第\s*[0-9一二三四五六七八九十百]+\s*[题道部分]|题目\s*[0-9A-Za-z一二三四五六七八九十]{1,3}|(?:problem|prob|task|question)\s*[A-Za-z0-9]{1,3}|t\s*\d{1,3}|[A-Za-z]|\d{1,3})\s*[.．、:：)）]?$/i;

  /** 大字号的标题被 \quad 或全角空格隔成两三段（“第一题　最长路径”“Problem A　Sequence Sum”）：第一段是题号时仍然是标题，不是表格行。 */
  function spacedTitle(ln, doc) {
    if (ln.cells.length < 2 || ln.cells.length > 4 || ln.size < 1.12 * doc.body || ln.raw.length > 80 || /[$]|<su[bp]>/.test(ln.text)) return false;
    if (!ln.cells.every((c, i) => i === 0 || c.x0 - ln.cells[i - 1].x1 <= 2.5 * ln.S)) return false;
    // 第一段是题号：1.12 倍字号就算；没有题号的（“B. 皮配 / Mentor”在 18pt 下，词间空格宽过 0.8 倍字号，被拆成了两格）要明显大于正文，才不会把大字号的表头当标题
    return LABEL_RE.test(ln.cells[0].raw.trim()) ? ln.cells.length <= 3 && ln.raw.length <= 60 : ln.size >= 1.25 * doc.body;
  }

  function isHeadingLine(ln, doc) {
    if (ln.tableId >= 0 || ln.mono || ln.mathOnly || ln.bullet) return false;
    if (ln.cells.length > 1 && !spacedTitle(ln, doc)) return false;
    if (/\$/.test(ln.text) && ln.raw.length > 20) return false;
    const big = ln.size >= 1.12 * doc.body;
    const boldShort = ln.bold && ln.raw.length <= 40 && !TERMINAL_RE.test(ln.raw) && !/[,，]$/.test(ln.raw);
    return (big && ln.raw.length <= 80 && !/[。；;]$/.test(ln.raw)) || boldShort;
  }

  const stripBold = (t) => t.replace(/(^|[^\\])\*\*/g, '$1').replace(/(^|[^\\])\*\*/g, '$1');
  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /* ---------- 代码块：行号、列对齐 ---------- */
  /** 代码清单左边的行号（1 2 3 ...）：单独的纯数字片段，字号比正文小或者和代码之间隔得比较开。 */
  function stripLineNumbers(lines, cw) {
    const info = lines.map((l) => {
      const vis = l.spans.filter((s) => s.str.trim()).sort((a, b) => a.x - b.x);
      const first = vis[0];
      if (!first || !/^\d{1,4}$/.test(first.str.trim())) return null;
      const next = vis[1];
      const gap = next ? next.x - (first.x + first.w) : Infinity;
      const strong = !next || first.size <= 0.92 * next.size || gap >= 1.4 * cw;
      return { span: first, value: Number(first.str.trim()), gap, strong, hasNext: !!next };
    });
    const hits = info.filter(Boolean);
    if (!hits.length) return lines;
    let seq = 0;
    hits.forEach((h, k) => { if (k > 0 && h.value === hits[k - 1].value + 1) seq++; });
    const sequential = hits.length >= 3 && seq >= 0.8 * (hits.length - 1) && hits.every((h) => h.gap >= 1.0 * cw || !h.hasNext);
    const allStrong = hits.length === lines.length && hits.every((h) => h.strong && h.hasNext);
    const oneLine = hits.length >= 1 && hits.every((h) => h.strong && h.hasNext && h.span.size <= 0.92 * (lines[0].S || h.span.size));
    if (!(sequential || allStrong || oneLine)) return lines;
    return lines.map((l, k) => (info[k] ? Object.assign({}, l, { spans: l.spans.filter((s) => s !== info[k].span) }) : l));
  }

  function codeText(lines, cw) {
    const first = lines.map((l) => l.spans.filter((s) => s.str.trim()).map((s) => s.x)).filter((a) => a.length).map((a) => Math.min(...a));
    const x0 = first.length ? Math.min(...first) : 0;
    return lines.map((l) => {
      let out = '';
      for (const sp of l.spans.filter((s) => s.str.trim()).sort((a, b) => a.x - b.x)) {
        const col = Math.round((sp.x - x0) / cw);
        if (col > out.length) out += ' '.repeat(col - out.length);
        else if (out && !/\s$/.test(out) && col < out.length) out += ' ';
        out += sp.str.replace(/^\s+/, (m) => (out ? m : ''));
      }
      return out.replace(/\s+$/, '');
    });
  }

  /* ---------- 行 → 块 ---------- */
  function toBlocks(lines, doc) {
    const blocks = [];
    const body = doc.body;
    const paraGap = Math.max(1.5 * doc.step, 1.9 * body);
    const monoWidths = [];
    for (const l of lines) if (l.mono) for (const sp of l.spans) if (sp.str.trim()) monoWidths.push(sp.w / Math.max(1, sp.str.length));
    const cw = monoWidths.length ? monoWidths.sort((a, b) => a - b)[Math.floor(monoWidths.length / 2)] : 0.6 * body;

    const ENUM_RE = /^(?:\d{1,2}[.、](?!\d)|[（(]\d{1,2}[)）]|[①-⑳])/;
    const finished = (prev) => TERMINAL_RE.test(prev.raw) || prev.x1 < doc.right - 2.5 * body;   // 上一行看起来已经收尾
    const startsPara = (prev, ln) => {
      if (ENUM_RE.test(ln.raw)) return true;
      if (ln.page !== prev.page) return TERMINAL_RE.test(prev.raw) || prev.display || (ln.x0 - doc.left > 1.0 * body && finished(prev));
      if (ln.B - prev.B > paraGap) return true;
      if (Math.abs(ln.size - prev.size) > 0.15 * body) return true;
      if (prev.display || ln.display) return true;
      // 首行缩进（悬挂缩进的续行不算：它的上一行写满了、也没有收尾）
      if (ln.x0 - doc.left > 1.0 * body && ln.x0 - doc.left < 3.5 * body && prev.x0 - doc.left < 0.6 * body && finished(prev)) return true;
      if (TERMINAL_RE.test(prev.raw) && prev.x1 < doc.right - 2.5 * body) return true;           // 上一行没写满且已收尾
      return false;
    };
    const joinText = (a, b) => {
      if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b) && !/\s-$/.test(a)) return a.slice(0, -1) + b;       // 英文行尾断词
      if (isCjk(a[a.length - 1]) && isCjk(b[0])) return a + b;
      return `${a} ${b}`;
    };
    const breaksFlow = (nx) => nx.tableId >= 0 || nx.mono || nx.display || nx.bullet || isHeadingLine(nx, doc) || isSampleHead(nx.raw);

    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];

      if (ln.tableId >= 0) {
        let j = i;
        while (j < lines.length && lines[j].tableId === ln.tableId) j++;
        blocks.push({ type: 'table', md: gridToMd(lines.slice(i, j)) });
        i = j;
        continue;
      }

      if (ln.mono) {
        let j = i + 1;
        const rowStep = [];
        while (j < lines.length && lines[j].mono && lines[j].tableId < 0 && (lines[j].page !== lines[j - 1].page || lines[j].B - lines[j - 1].B <= 3.2 * lines[j].S)) {
          if (lines[j].page === lines[j - 1].page) rowStep.push(lines[j].B - lines[j - 1].B);
          j++;
        }
        const step = rowStep.length ? mostCommon(rowStep, 0.5) : 0;                // 最常见的行距（空行 = 两倍行距）
        const slice = stripLineNumbers(lines.slice(i, j), cw);
        const texts = codeText(slice, cw);
        const out = [];
        texts.forEach((t, k) => {
          const cur = lines[i + k];
          const prev = lines[i + k - 1];
          if (k && step && cur.page === prev.page) for (let b = 0; b < Math.min(3, Math.round((cur.B - prev.B) / step) - 1); b++) out.push('');
          out.push(t);
        });
        blocks.push({ type: 'code', lines: out });
        i = j;
        continue;
      }

      if (isHeadingLine(ln, doc)) {
        blocks.push({ type: 'heading', text: stripBold(ln.text), raw: ln.raw, size: ln.size, bold: ln.bold, page: ln.page });
        i++;
        continue;
      }

      if (isSampleHead(ln.raw)) {
        blocks.push({ type: 'heading', text: stripBold(ln.text), raw: ln.raw, size: ln.size, bold: ln.bold, page: ln.page, sample: true });
        let j = i + 1;
        const grab = [];
        while (j < lines.length && lines[j].tableId < 0 && !lines[j].mono && !isHeadingLine(lines[j], doc) && !isSampleHead(lines[j].raw)
          && !lines[j].cjk && /^[\x20-\x7e]+$/.test(lines[j].raw) && lines[j].cells.length <= 4) { grab.push(lines[j]); j++; }
        if (grab.length) {
          const out = [];
          grab.forEach((g, k) => {
            if (k && g.page === grab[k - 1].page) for (let b = 0; b < Math.min(3, Math.round((g.B - grab[k - 1].B) / doc.step) - 1); b++) out.push('');
            out.push(g.raw);
          });
          blocks.push({ type: 'code', lines: out });
          i = j;
        } else i++;
        continue;
      }

      if (ln.bullet) {
        let text = ln.text;
        let j = i + 1;
        while (j < lines.length) {
          const nx = lines[j];
          if (breaksFlow(nx) || ENUM_RE.test(nx.raw)) break;
          if (nx.page === lines[j - 1].page ? nx.B - lines[j - 1].B > paraGap : TERMINAL_RE.test(lines[j - 1].raw)) break;
          if (nx.page === lines[j - 1].page && nx.x0 < ln.textX0 - 0.6 * body) break;
          text = joinText(text, nx.text);
          j++;
        }
        const last = blocks[blocks.length - 1];
        const item = { text, x0: ln.x0 };
        if (last && last.type === 'list' && last.page === ln.page) last.items.push(item);
        else blocks.push({ type: 'list', items: [item], page: ln.page });
        i = j;
        continue;
      }

      if (ln.display) {
        blocks.push({ type: 'display', tex: ln.text.replace(/^\$|\$$/g, '') });
        i++;
        continue;
      }

      let text = ln.text.replace(/^[\u3000 ]+/, '');
      let j = i + 1;
      while (j < lines.length) {
        const nx = lines[j];
        if (breaksFlow(nx)) break;
        if (startsPara(lines[j - 1], nx)) break;
        text = joinText(text, nx.text);
        j++;
      }
      blocks.push({ type: 'para', text });
      i = j;
    }
    return blocks;
  }

  function renderBlocks(blocks, opts) {
    // 标题层级：先剔除与题目名重复的标题，再按（字号、是否粗体）排名
    const titleKey = normTitle(opts && opts.title);
    const headings = blocks.filter((b) => b.type === 'heading');
    // 标题样式只看字号（相差 7% 以内算同一级）；粗体与否在同一份文档里经常不一致（中英文字体不同）
    const sizes = headings.filter((b) => !b.sample).map((b) => b.size).sort((a, b) => b - a);
    const styles = [];
    for (const sz of sizes) if (!styles.length || styles[styles.length - 1].size / sz >= 1.07) styles.push({ size: sz });
    styles.forEach((st, k) => { st.key = String(k); });
    const styleKey = (b) => (styles.find((st) => st.size / b.size < 1.07 && b.size / st.size < 1.07) || styles[styles.length - 1] || { key: '0' }).key;
    const count = (k) => headings.filter((b) => !b.sample && styleKey(b) === k).length;
    // 只出现一次、字号明显最大、在第一页的是“文档标题”：和章节标题同级（都是 ##）
    const first = styles[0];
    const hasTitle = !!first && count(first.key) === 1 && styles.length > 1 && first.size >= 1.25 * styles[1].size
      && headings.find((b) => styleKey(b) === first.key).page === 0;
    const rank = (b) => {
      if (b.sample) return Math.min(styles.length, 2) + (hasTitle ? 0 : 1);
      const idx = styles.findIndex((s) => s.key === styleKey(b));
      return hasTitle ? Math.max(0, idx - 1) : idx;
    };
    const out = [];
    for (const b of blocks) {
      if (b.type === 'heading') {
        if (titleKey && normTitle(b.raw) && (normTitle(b.raw).includes(titleKey) || titleKey.includes(normTitle(b.raw))) && count(styleKey(b)) <= 2 && b.page === 0 && !b.sample) continue;
        const level = Math.min(5, 2 + Math.max(0, rank(b)));
        out.push(`${'#'.repeat(b.sample ? Math.max(3, level) : level)} ${b.text}`);
      } else if (b.type === 'para') out.push(b.text.replace(/^([#>+-])(?=\s|$)/, '\\$1'));
      else if (b.type === 'list') {
        // 嵌套层级：按项目符号的缩进位置聚类（相差不到 0.6 倍字号的算同一级）
        const tol = 0.6 * ((opts && opts.body) || 12);
        const levels = [];
        for (const x of Array.from(new Set(b.items.map((it) => it.x0))).sort((p, q) => p - q)) if (!levels.length || x - levels[levels.length - 1] > tol) levels.push(x);
        const levelOf = (x) => Math.min(3, levels.reduce((k, v, i) => (x >= v - tol ? i : k), 0));
        out.push(b.items.map((it) => `${'  '.repeat(levelOf(it.x0))}- ${it.text}`).join('\n'));
      } else if (b.type === 'table') out.push(b.md);
      else if (b.type === 'display') out.push(`$$\n${b.tex}\n$$`);
      else if (b.type === 'code') {
        const longest = (b.lines.join('\n').match(/`{3,}/g) || []).reduce((a, s) => Math.max(a, s.length), 2);
        const fence = '`'.repeat(longest + 1);
        out.push(`${fence}\n${b.lines.join('\n')}\n${fence}`);
      }
    }
    return out.join('\n\n');
  }

  /**
   * 文字层 → Markdown。pages: [{ width, height, spans }]；opts: { title }（与之重复的文档标题会被去掉）。
   */
  function layoutDocument(pagesIn, opts) {
    const pages = pagesIn.map((p, idx) => {
      const lines = buildLines(p);
      lines.forEach((l) => { l.page = idx; });
      return { height: p.height || 842, width: p.width || 595, lines };
    });
    stripHeadersFooters(pages);
    const doc = docStats(pages);
    // 大字号的等宽字体行是标题，不是代码（Word 文档的标题常用新宋体，会被当成等宽字体；代码清单不会比正文大这么多）
    for (const p of pages) for (const l of p.lines) if (l.mono && l.size >= 1.2 * doc.body && l.raw.length <= 80 && l.cells.length <= 3) l.mono = false;
    const all = [];
    for (const p of pages) {
      detectTables(p.lines, doc);
      p.lines = serializeColumns(p.lines);
      for (const l of p.lines) all.push(l);
    }
    // 独占一行、居中的公式 → 独立公式
    for (const p of pages) {
      const centerX = p.width / 2;
      for (const l of p.lines) {
        if (l.tableId >= 0 || l.mono || l.cells.length !== 1 || l.cjk || l.bullet) continue;
        const only = l.cells[0].segs.length === 1 && l.cells[0].segs[0].math && !/^[\u0001\u0002]/.test(l.cells[0].segs[0].t);
        if (only && /^\$[^$]+\$$/.test(l.text) && Math.abs((l.x0 + l.x1) / 2 - centerX) < 0.08 * p.width && l.x1 - l.x0 < 0.8 * p.width) l.display = true;
      }
    }
    const blocks = toBlocks(all, doc);
    return renderBlocks(blocks, Object.assign({}, opts, { body: doc.body }));
  }

  /* ====================================================================== *
   * 3b. 一份 PDF 里有多道题：取出与本题同名（相似度最高）的那一道
   * ====================================================================== */
  const PICK_MIN = 0.55;                // 最像的那道题相似度低于此值：认为 PDF 里没有同名的题，取整份
  const PICK_SURE = 0.8;                // 达到 PICK_MIN 但低于此值：照取，但在末尾提示“只是大致匹配”
  const PICK_DROP_TITLE = 0.9;          // 题名与本题标题几乎一样：去掉 PDF 里的题名标题（页眉里已经有了）

  const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 标题 → 纯文本：去掉 Markdown 记号（粗体 / 行内代码 / 转义 / 公式定界符 / 上下标标签），统一字符。 */
  function plainText(t) {
    return normChars(String(t == null ? '' : t)).normalize('NFKC')
      .replace(/\\([\\`*_{}[\]()#+\-.!$|<>~])/g, '$1')
      .replace(/<\/?su[bp]>/gi, '')
      .replace(/[`*$]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 标题 → 给人看的文字：只去掉 Markdown 记号，不改字符（全角括号保持原样）。 */
  const headingLabel = (t) => String(t == null ? '' : t)
    .replace(/\\([\\`*_{}[\]()#+\-.!$|<>~])/g, '$1').replace(/<\/?su[bp]>/gi, '').replace(/[`*$]/g, '').replace(/\s+/g, ' ').trim();

  // 小节名的词表（词 → 类别）。类别：bg 背景 / desc 描述 / in 输入 / out 输出 / sample 样例 / range 数据范围与评分 / note 其他说明；'' 只是连接词
  const SEC_WORDS = (() => {
    const table = {
      bg: ['题目背景', '故事背景', '背景', '引言', '前言', 'background', 'story', 'backstory'],
      desc: ['题目描述', '问题描述', '任务描述', '题目大意', '题目内容', '题意', '题面', '描述', '简述', '概述', '问题', '任务', 'description', 'statement', 'legend', 'overview', 'problem', 'task', 'introduction', 'intro'],
      in: ['输入格式', '输入说明', '输入描述', '输入数据', '输入文件', '输入形式', '输入要求', '标准输入', '输入', 'input', 'specification', 'specifications'],
      out: ['输出格式', '输出说明', '输出描述', '输出数据', '输出文件', '输出形式', '输出要求', '标准输出', '输出', 'output'],
      sample: ['样例', '样本', '示例', '例子', '范例', 'sample', 'samples', 'example', 'examples'],
      range: ['数据范围', '数据规模', '数据约定', '数据限制', '数据说明', '取值范围', '评分标准', '评分方式', '评分方法', '评分', '得分', '计分', '子任务', '部分分', '特殊性质', '约定', '约束', '限制', '范围', '规模', '数据', 'constraints', 'constraint', 'limits', 'limit', 'scoring', 'score', 'subtask', 'subtasks', 'grading', 'points', 'bounds'],
      note: ['提示', '说明', '备注', '注意事项', '注意', '附注', '补充说明', '补充', '解释', '时间限制', '内存限制', '空间限制', '时空限制', '交互方式', '交互说明', '交互', '附加文件', '附件', '下载', '题解', '格式', '要求', '测试点', '细节', 'note', 'notes', 'hint', 'hints', 'explanation', 'explanations', 'remark', 'remarks', 'interaction', 'interactive', 'format', 'time', 'memory', 'details', 'implementation', 'technical', 'attachment', 'attachments', 'download'],
      '': ['和', '与', '及', '或', '的', 'and', 'or', 'the', 'of', 'for', 'to'],
    };
    const list = [];
    for (const kind of Object.keys(table)) for (const w of table[kind]) list.push([w, kind]);
    return list.sort((a, b) => b[0].length - a[0].length);
  })();

  /**
   * 一个标题是不是“小节名”（题目描述 / 输入格式 / 【样例 1 输出】 / Sample Input 1 ……）：整个标题都由词表里的词、数字、连接词组成。
   * 返回 { sec, kinds }；kinds 是它涉及的类别（样例类的标题只算 sample，不算输入 / 输出）。
   */
  function sectionInfo(text) {
    const plain = plainText(text);
    const k = normTitle(plain);
    if (!k || k.length > 40 || LABEL_RE.test(plain)) return { sec: false, kinds: [] };          // “Problem 1”“第二题”这样的题号标题不是小节名
    const memo = new Map();
    const go = (i) => {
      if (i === k.length) return [];
      if (memo.has(i)) return memo.get(i);
      let res = null;
      const rest = k.slice(i);
      for (const [w, kind] of SEC_WORDS) {
        if (!rest.startsWith(w)) continue;
        const r = go(i + w.length);
        if (r) { res = kind ? [kind].concat(r) : r; break; }
      }
      if (!res) {
        const f = /^(?:\d+|[一二三四五六七八九十]+)/.exec(rest);
        if (f) res = go(i + f[0].length);
      }
      memo.set(i, res);
      return res;
    };
    const kinds = go(0);
    if (!kinds) return { sec: false, kinds: [] };
    const set = new Set(kinds);
    if (set.has('sample')) { set.clear(); set.add('sample'); }
    return { sec: true, kinds: Array.from(set) };
  }

  /** 像不像“题名”：不太长、不是句子 / 段落残片（带句号、以逗号结尾、括号不配对……）。 */
  function titleShape(plain) {
    const t = String(plain || '').trim();
    const k = normTitle(t);
    if (k.length < 2 || /^\d+$/.test(k)) return false;
    if (t.length > 60 || t.split(' ').length > 14) return false;
    if (/[。；;]/.test(t) || /[，,、]\s*$/.test(t)) return false;
    if ((t.match(/[，,：:]/g) || []).length >= 2) return false;
    const open = (t.match(/[(（[【{]/g) || []).length;
    const close = (t.match(/[)）\]】}]/g) || []).length;
    return open === close && !/^[)）\]】}'"’”]/.test(t);
  }

  // 题名前面的题号 / 序号（“Problem A.”、“第一题”、“1．”、“(2)”、“T3”）
  const ENUM_PREFIXES = [
    /^(?:题目名称|题目|试题|题名|名称|title)\s*[:：]\s*/i,
    /^(?:problem|prob\.?|task|question|exercise)\s+(?:[A-Za-z]|\d{1,3})(?:\s*[.:：)\-—]+\s*|\s+)/i,
    /^(?:题目|试题|问题)\s*(?:[A-Za-z0-9]{1,3}|[一二三四五六七八九十]{1,3})(?=[\s.．、:：)）\-—]|$)\s*[.．、:：)）\-—]*\s*/,
    /^第\s*(?:[0-9]{1,3}|[一二三四五六七八九十百]{1,3})\s*[题道部分]\s*[.．、:：)）\-—]*\s*/,
    /^题\s*(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})(?![\d一二三四五六七八九十百])\s*[.．、:：)）\-—]*\s*/,
    /^[(（]?\s*(?:\d{1,3}|[一二三四五六七八九十]{1,3}|[A-Za-z])\s*[)）.．、:：]\s*/,
    /^T\s*\d{1,3}\s*[.．、:：)）\-—]?\s*/,
  ];

  /** 一个题名的各种“比较用写法”：原样 / 去题号 / 去括号里的英文名 / 只取括号里的名字 / 按 | / - 拆开。
   *  返回 Map：只含字母数字的小写串 → 同一个写法保留词界的版本（词之间一个空格，用来判断英文名的“包含”）。 */
  function nameKeys(raw, pid) {
    const keys = new Map();
    const add = (t) => { const k = normTitle(t); if (k.length >= 2 && !keys.has(k)) keys.set(k, String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()); };
    const s0 = plainText(raw);
    const stages = [s0];
    const p = plainText(pid);
    if (p) {
      const t = s0.replace(new RegExp(`^#?\\s*${reEscape(p)}\\s*[.:：)\\-—]?\\s*`, 'i'), '');
      if (t && t !== s0) stages.push(t);
    }
    for (const base of stages.slice()) {
      const t = base.replace(/^[(（[【][^)）\]】]{1,30}[)）\]】]\s*(?=\S)/, '');            // 开头的 [赛事标签]
      if (t && t !== base) stages.push(t);
    }
    for (const st of stages) {
      add(st);
      let t = st;
      for (const re of ENUM_PREFIXES) {
        const u = t.replace(re, '');
        if (u !== t && u.trim()) { t = u; break; }
      }
      add(t);
      const alias = /^(.*?)\s*[(（]([^()（）]{1,40})[)）]\s*$/.exec(t);
      if (alias && alias[1].trim()) { add(alias[1]); if (normTitle(alias[2]).length >= 3) add(alias[2]); }
      for (const part of t.split(/\s*[|｜/／]\s*|\s+[-–—]\s+/)) if (part && part !== t) add(part);
    }
    return keys;
  }

  function editDistance(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }

  function bigramDice(a, b) {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const ga = grams(a);
    const gb = grams(b);
    let inter = 0;
    ga.forEach((c, g) => { inter += Math.min(c, gb.get(g) || 0); });
    return (2 * inter) / (a.length + b.length - 2);
  }

  /**
   * 两个“比较用写法”的相似度（0–1）：相等 1；一个包含另一个 0.8–1（汉字按子串，英文按整词：tree 不算包含在 street 里，A+B 算包含在 A+B Problem 里）；
   * 否则取双字组 Dice 与编辑距离相似度的较大者；数字对不上的打折。wa / wb：对应的保留词界的写法。
   */
  function keySim(a, b, wa, wb) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const aShort = a.length <= b.length;
    const s = aShort ? a : b;
    const l = aShort ? b : a;
    let best = Math.max(bigramDice(a, b), 1 - editDistance(a, b) / l.length);
    let inside;
    if (/[\u3400-\u9fff]/.test(s)) inside = l.includes(s);
    else {
      const ws = (aShort ? wa : wb) || s;
      const wl = (aShort ? wb : wa) || l;
      inside = ` ${wl} `.includes(` ${ws} `);
    }
    if (inside) best = Math.max(best, 0.8 + 0.2 * (s.length / l.length));
    const da = a.match(/\d+/g) || [];
    const db = b.match(/\d+/g) || [];
    if ((da.length || db.length) && da.join(',') !== db.join(',')) best *= 0.6;           // “排序 1”与“排序 2”不是一回事
    return best;
  }

  /** 两个题名的相似度（0–1）。pid：本题题号（题名里带着它时先去掉）。 */
  function nameSimilarity(a, b, pid) {
    const ka = nameKeys(a, pid);
    const kb = nameKeys(b, pid);
    let best = 0;
    ka.forEach((wx, x) => kb.forEach((wy, y) => { best = Math.max(best, keySim(x, y, wx, wy)); }));
    return best;
  }

  // 不是题名的标题：空白页提示（THUPC 的“此页刻意留白”）；题名下面的元数据行（“主文件名：cchkk”“时间限制：1 秒”）
  const NOISE_HEAD_RE = /^(?:(?:此页|本页|该页)(?:刻意|特意|有意|故意)?(?:留白|空白)|(?:刻意|特意)?留白页?|空白页|this page (?:is )?intentionally (?:left )?blank|intentionally left blank)$/i;
  const META_HEAD_RE = /^(?:主文件名|源程序文件名|源文件名|程序文件名|文件名|存盘名|程序名|可执行文件名|输入文件名?|输出文件名?|时间限制|空间限制|内存限制|时限|input file|output file|time limit|memory limit)\s*[:：]/i;

  // 正文里“题号 + 题名”形式的题名行（不是标题样式）：老 NOIP 试卷的“题一 均分纸牌（存盘名 NOIPG1） [问题描述]”、正文大小的“1．Vigenère 密码”。
  // specific：这种写法本身就是题号（题一 / 第一题 / Problem A / T1），可以直接当候选；否则（“1．”“A.”）要同一份文档里已有同写法的标题行为凭据，只补缺的序号。
  const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function parseOrd(t) {
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z]$/.test(t)) return t.toUpperCase().charCodeAt(0) - 64;
    if (t.length === 1) return CN_DIGITS[t];
    if (t[0] === '十') return 10 + (CN_DIGITS[t[1]] || 0);
    if (t[1] === '十') return CN_DIGITS[t[0]] * 10 + (CN_DIGITS[t[2]] || 0);
    return NaN;
  }
  const ORD_FAMILIES = [
    { id: 'ti', specific: true, re: /^题\s*([一二三四五六七八九十]{1,3}|\d{1,2})(?![\d一二三四五六七八九十百])\s*[.．、:：)）\-—]*\s*/u },       // 题号和题名之间可能没有空格（PDF 里不一定有空格字符）
    { id: 'di', specific: true, re: /^第\s*([一二三四五六七八九十百]{1,3}|\d{1,3})\s*[题道]\s*[.．、:：)）\-—]*\s*/u },
    { id: 'wt', specific: true, re: /^(?:题目|试题|问题)\s*([A-Za-z](?![\p{L}\d])|\d{1,3}(?!\d)|[一二三四五六七八九十]{1,3}(?![一二三四五六七八九十百]))\s*[.．、:：)）\-—]*\s*/u },
    { id: 'pr', specific: true, re: /^(?:problem|task|question)\s*([A-Za-z]|\d{1,3})\s*[.:：)\-—]*\s+/iu },
    { id: 'tn', specific: true, re: /^T\s*(\d{1,3})(?![\p{L}\d])\s*[.．、:：)）\-—]?\s*/u },
    { id: 'num', specific: false, re: /^(\d{1,2})\s*[．.、]\s*(?=\S)/u },
    { id: 'let', specific: false, re: /^([A-Z])\s*[.．、]\s+(?=\S)/u },
  ];
  const INLINE_LABEL_RE = /\s*[[【]\s*([^\]】]{1,10}?)\s*[\]】]\s*[:：]?\s*$/;
  function ordOf(plain) {
    for (const f of ORD_FAMILIES) {
      const m = f.re.exec(plain);
      if (m) { const ord = parseOrd(m[1]); return Number.isFinite(ord) && ord >= 1 ? { fam: f, ord, rest: plain.slice(m[0].length) } : null; }
    }
    return null;
  }

  /** 补充候选：正文里“题号 + 题名”的行。heads 是已有的标题候选。返回与标题候选同形的对象（level 0，para: true，inline = 行尾的小节名）。 */
  function titleLineCandidates(md, heads) {
    const found = [];
    let fence = 0;
    let pos = 0;
    while (pos <= md.length) {
      let nl = md.indexOf('\n', pos);
      if (nl < 0) nl = md.length;
      const line = md.slice(pos, nl);
      const f = FENCE_RE.exec(line);
      if (fence) {
        if (f && f[1].length >= fence && !f[2].trim()) fence = 0;
      } else if (f) {
        fence = f[1].length;
      } else if (line.trim() && !/^[ \t]*(?:[#|>]|[-*+]\s)/.test(line) && line.length <= 120) {
        const plain = plainText(line);
        const o = ordOf(plain);
        if (o) {
          let name = o.rest;
          let inline = '';
          const lm = INLINE_LABEL_RE.exec(name);
          if (lm && sectionInfo(lm[1]).sec) { inline = line.trim().slice(line.trim().lastIndexOf(lm[0].trim())); name = name.slice(0, lm.index); }
          name = name.trim();
          if (name.length >= 2 && titleShape(name) && !META_HEAD_RE.test(name) && !NOISE_HEAD_RE.test(name)) {
            found.push({ fam: o.fam, ord: o.ord, plain: plainText(line.replace(inline, '')), label: headingLabel(line.replace(inline, '')), inline, level: 0, para: true, from: pos, to: Math.min(md.length, nl + 1) });
          }
        }
      }
      pos = nl + 1;
    }
    // 标题候选里的同类题号（用来判断“这份文档的题名用标题样式”）
    const headOrds = new Map();
    for (const h of heads) {
      const o = ordOf(h.plain);
      if (o) { if (!headOrds.has(o.fam.id)) headOrds.set(o.fam.id, new Set()); headOrds.get(o.fam.id).add(o.ord); }
    }
    return found.filter((c, i) => {
      if (c.fam.specific) return true;
      const hs = headOrds.get(c.fam.id);
      if (!hs || hs.size < 2) return false;
      const max = Math.max.apply(null, Array.from(hs));
      if (c.ord >= max || hs.has(c.ord)) return false;
      // 同一个缺的序号可能有好几行（封面上的清单、正文里的题名）：取离“下一个序号”的标题最近的那一行
      const nextHead = heads.filter((h) => { const o = ordOf(h.plain); return o && o.fam.id === c.fam.id && o.ord > c.ord; }).sort((a, b) => a.from - b.from)[0];
      const rivals = found.filter((d) => d.fam === c.fam && d.ord === c.ord && d.from < nextHead.from);
      return rivals[rivals.length - 1] === c;
    });
  }

  const FENCE_RE = /^[ \t>]*(`{3,})([^`]*)$/;

  /** Markdown 里的 ATX 标题行（围栏代码块里的 # 不算）：[{ level, text, from, to }]，from / to 是该行的字符偏移。 */
  function parseHeadings(md) {
    const heads = [];
    let fence = 0;
    let pos = 0;
    while (pos <= md.length) {
      let nl = md.indexOf('\n', pos);
      if (nl < 0) nl = md.length;
      const line = md.slice(pos, nl);
      const f = FENCE_RE.exec(line);
      if (fence) {
        if (f && f[1].length >= fence && !f[2].trim()) fence = 0;
      } else if (f) {
        fence = f[1].length;
      } else {
        const m = /^(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line);
        if (m) heads.push({ level: m[1].length, text: m[2].replace(/[ \t]+#+$/, ''), from: pos, to: Math.min(md.length, nl + 1) });
      }
      pos = nl + 1;
    }
    return heads;
  }

  /** 一行（非标题）开头的小节名：独占一行的“【题目描述】”“输入格式：”“**样例**”，或者后面直接接正文的“【问题描述】凯凯刚写了……”“输入格式：第一行……”。 */
  function leadingLabel(line) {
    const t = line.trim();
    if (!t || /^(?:[-*+|>]|\d+[.)])\s/.test(t)) return '';
    if (t.length <= 30 && /^(?:\*\*.+\*\*|[【[].+[】\]]|.+[:：])$/.test(t)) return t.replace(/[:：]$/, '');
    const b = /^(?:\*\*)?[【[]\s*([^】\]]{1,20}?)\s*[】\]]/.exec(t) || /^(?:\*\*)?([^\s:：*|]{2,12})[:：]/.exec(t);
    return b ? b[1] : '';
  }

  /** 一段 Markdown 里出现了哪些类别的小节名（标题行，以及 leadingLabel 认出来的行首小节名）。 */
  function blockKinds(md, from, to) {
    const kinds = new Set();
    let fence = 0;
    for (const line of md.slice(from, to).split('\n')) {
      const f = FENCE_RE.exec(line);
      if (fence) { if (f && f[1].length >= fence && !f[2].trim()) fence = 0; continue; }
      if (f) { fence = f[1].length; continue; }
      const hm = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
      const text = hm ? hm[1] : leadingLabel(line);
      if (text) for (const k of sectionInfo(text).kinds) kinds.add(k);
    }
    return kinds;
  }

  /**
   * 在整份 PDF 的 Markdown 里找“一道题”的分界。
   * 做法：把“像题名的行”（不是小节名、不是句子残片）当作候选——标题行，以及正文里带题号的一行（titleLineCandidates）——
   * 每个候选管到下一个候选之前；一道题里“题目描述 / 输入 / 输出”各只会出现一次，所以某个候选管的那段里这些小节名又出现了一遍，就说明这里开始了新的一道题。
   * 一个小标题夹在题目中间（它后面接着的是这道题剩下的小节）不会被当成新题；紧挨着的几个标题（“第一题”+“假期计划”）算同一个题名。
   * 空白页提示、题名下面的“时间限制：…”之类的元数据行不当候选；与小节标题同级的“不认识的小标题”靠层级先验排除（排除之后仍分不清就退回全部候选）。
   * 返回 { problems: [{ index, title, names, titles, score, level, from, to }], best, bestScore, bestTitle, ties }；
   * 不足两道题时 problems 为空；best 是与 title 最像的那道题的下标，相似度低于 PICK_MIN 时为 -1。
   */
  function findProblems(md, opts) {
    const none = { problems: [], best: -1, bestScore: 0, bestTitle: '', ties: 0 };
    const title = opts && opts.title;
    const pid = opts && opts.pid;
    const heads = parseHeadings(md);
    let all = [];
    for (const h of heads) {
      const plain = plainText(h.text);
      if (!sectionInfo(plain).sec && titleShape(plain) && !NOISE_HEAD_RE.test(plain) && !META_HEAD_RE.test(plain)) all.push(Object.assign({ plain, label: headingLabel(h.text) }, h));
    }
    all = all.concat(titleLineCandidates(md, all)).sort((a, b) => a.from - b.from);
    if (all.length < 2) return none;

    // 层级先验：小节标题（题目描述 / 输入格式……）最常见的层级是 L；题名通常比小节标题大（层级更小）。
    // 题目中间“不认识的小标题”（【棋子类型与走子规则】）和小节标题同级，先把层级 ≥ L 的排除；排除之后分不出题就退回全部候选
    // （视觉模型转写出来的标题全是同一级、题名与小节同级的文档，层级帮不上忙）。
    const secLevels = heads.filter((h) => { const si = sectionInfo(h.text); return si.sec && !(si.kinds.length === 1 && si.kinds[0] === 'sample'); }).map((h) => h.level);
    const L = secLevels.length ? mostCommon(secLevels, 1) : 0;
    const top = L ? all.filter((c) => c.level < L) : all;
    let groups = null;
    let cands = all;
    if (top.length >= 2 && top.length < all.length) {
      const g = groupProblems(md, top);
      // 排除之后每道题的范围里都不能再有“题目描述 / 输入 / 输出”重复出现（重复说明漏掉了题与题之间的分界，层级先验不适用）
      if (g && g.every((x, k) => !repeatsInside(md, top[x.names[0]].from, g[k + 1] ? top[g[k + 1].names[0]].from : md.length))) { groups = g; cands = top; }
    }
    if (!groups) groups = groupProblems(md, all);
    if (!groups) return none;
    const problems = groups.map((g, k) => {
      const first = cands[g.names[0]];
      const next = groups[k + 1];
      const names = g.names.map((j) => cands[j].plain);
      const level = cands[g.names[g.names.length - 1]].level;
      return {
        index: k,
        names,
        titles: g.names.map((j) => ({ para: !!cands[j].para, text: cands[j].label, inline: cands[j].inline || '' })),
        title: g.names.map((j) => cands[j].label).join(' '),
        level,
        from: first.from,
        to: next ? cands[next.names[0]].from : md.length,
        score: title ? Math.max.apply(null, names.map((n) => nameSimilarity(title, n, pid))) : 0,
      };
    });
    let best = 0;
    problems.forEach((p, i) => { if (p.score > problems[best].score) best = i; });
    const top1 = problems[best];
    const ties = problems.filter((p) => p !== top1 && p.score >= top1.score - 0.02).length;
    return { problems, best: top1.score >= PICK_MIN ? best : -1, bestScore: top1.score, bestTitle: top1.title, ties };
  }

  const REPEAT_KINDS = ['desc', 'in', 'out'];         // 一道题里各只会出现一次的小节

  /** md[from, to) 里“题目描述 / 输入 / 输出”类的小节各出现了几次（标题行或行首小节名；一行里同一类只算一次）。 */
  function sectionCounts(md, from, to) {
    const counts = { desc: 0, in: 0, out: 0 };
    let fence = 0;
    for (const line of md.slice(from || 0, to == null ? md.length : to).split('\n')) {
      const f = FENCE_RE.exec(line);
      if (fence) { if (f && f[1].length >= fence && !f[2].trim()) fence = 0; continue; }
      if (f) { fence = f[1].length; continue; }
      const hm = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
      const text = hm ? hm[1] : leadingLabel(line);
      if (text) sectionInfo(text).kinds.forEach((k) => { if (k in counts) counts[k]++; });
    }
    return counts;
  }

  /** md[from, to) 里“题目描述 / 输入 / 输出”类的小节是不是出现了不止一次。 */
  const repeatsInside = (md, from, to) => REPEAT_KINDS.some((k) => sectionCounts(md, from, to)[k] > 1);

  /** 整份 Markdown 像不像装着好几道题：“题目描述 / 输入 / 输出”里至少有两类出现了不止一次。 */
  const looksMultiProblem = (md) => { const c = sectionCounts(md); return REPEAT_KINDS.filter((k) => c[k] >= 2).length >= 2; };

  /** 候选题名 → 分组（每组 = 一道题：{ names: [候选下标…], kinds }）；不足两道题返回 null。cands 会被补上 kinds / blank / core 字段。 */
  function groupProblems(md, cands) {
    cands.forEach((c, i) => {
      const end = i + 1 < cands.length ? cands[i + 1].from : md.length;
      c.kinds = blockKinds(md, c.to, end);
      c.blank = !md.slice(c.to, end).trim();                  // 紧挨着下一个标题：同一个题名的一部分
    });
    const CORE = ['desc', 'in', 'out', 'sample'];             // 题目的“正文类”小节；只有“注意事项”“评分”之类的段落不算一道题
    const REPEAT = REPEAT_KINDS;
    cands.forEach((c) => { c.core = CORE.some((x) => c.kinds.has(x)); });
    const groups = [];
    let cur = null;
    let pending = [];
    cands.forEach((c, i) => {
      if (!c.core) { pending.push(i); return; }
      const again = !!cur && REPEAT.some((x) => c.kinds.has(x) && cur.kinds.has(x));
      if (!cur || again) {
        // 紧挨着的标题（“Problem B”+“Sequence Sum”）算同一个题名；第一道题前面的标题是封面，不带上
        const room = cur ? 2 : 0;
        let k = pending.length;
        while (k > 0 && pending.length - k < room && cands[pending[k - 1]].blank) k--;
        const stacked = pending.slice(k);
        cur = { names: stacked.concat(i), kinds: new Set(c.kinds) };
        groups.push(cur);
      } else {
        c.kinds.forEach((x) => cur.kinds.add(x));
      }
      pending = [];
    });
    return groups.length >= 2 ? groups : null;
  }

  /**
   * 取出第 p 道题：从它的题名标题到下一道题之前。dropTitle：去掉开头的题名标题（页眉里已经有题名了）；
   * 标题层级整体平移，使最浅的一级变成 ##（页眉是 #）。
   */
  function sliceProblem(md, p, opts) {
    const lines = md.slice(p.from, p.to).replace(/\s+$/, '').split('\n');
    // 开头的题名行：标题样式的，dropTitle 时去掉；正文样式的（“题一 均分纸牌 [问题描述]”）dropTitle 时只留行尾的小节名，否则改写成 ## 标题
    const out0 = [];
    let seen = 0;
    while (lines.length && seen < p.names.length) {
      if (!lines[0].trim()) { out0.push(lines.shift()); continue; }
      const t = p.titles && p.titles[seen];
      if (t && t.para) {
        lines.shift();
        if (!(opts && opts.dropTitle)) out0.push(`## ${t.text}`);
        if (t.inline) out0.push('', t.inline);
      } else if (/^#{1,6}[ \t]+/.test(lines[0])) {
        const head = lines.shift();
        if (!(opts && opts.dropTitle)) out0.push(head);
      } else break;
      seen++;
    }
    lines.unshift(...out0);
    // 题与题之间夹着的“此页刻意留白”之类的空白页提示不属于任何一道题
    let fence0 = 0;
    const kept = lines.filter((line) => {
      const f = FENCE_RE.exec(line);
      if (fence0) { if (f && f[1].length >= fence0 && !f[2].trim()) fence0 = 0; return true; }
      if (f) { fence0 = f[1].length; return true; }
      return !NOISE_HEAD_RE.test(plainText(line.replace(/^#{1,6}[ \t]+/, '')));
    });
    let fence = 0;
    let min = 7;
    const isHead = kept.map((line) => {
      const f = FENCE_RE.exec(line);
      if (fence) { if (f && f[1].length >= fence && !f[2].trim()) fence = 0; return 0; }
      if (f) { fence = f[1].length; return 0; }
      const m = /^(#{1,6})[ \t]+\S/.exec(line);
      if (m) { min = Math.min(min, m[1].length); return m[1].length; }
      return 0;
    });
    const shift = min < 7 ? min - 2 : 0;
    const out = kept.map((line, i) => (isHead[i] && shift ? `${'#'.repeat(Math.max(2, Math.min(6, isHead[i] - shift)))}${line.slice(isHead[i])}` : line));
    return tidy(out.join('\n'));
  }

  /* ====================================================================== *
   * 3c. 画成矢量图形的公式（PDF 文字层里根本没有它）
   *
   *     不少题面 PDF 是把网页 / 文档“打印”出来的：公式被转成了矢量轮廓（曲线填色），
   *     文字层里只剩一个空格。直接读文字层就会「有 个葫芦娃」——公式凭空消失。
   *
   *     这里用绘制指令把每个矢量图形的 bbox 还原到页面坐标，再和文字行的空隙对上：
   *     落在空隙里、又只有“字形大小”的图形 = 一个公式占位（hole）。
   *     找到之后在片段流里插一个 %%H页-序号%% 占位符，最后由 recognizePdf 用视觉模型
   *     裁图识别出的 LaTeX 替换掉（没配置 API 时就插入截图或 [公式]）。
   *
   *     全部是纯函数（绘制指令以普通数组的形式传进来），Node 里可以直接测。
   * ====================================================================== */
  const HOLE_MARK_RE = /%%H(\d+)-(\d+)%%/g;
  const holeMark = (page, i) => `%%H${page}-${i}%%`;

  /** 影响后续绘制指令的算子（用来维护 CTM 栈）。 */
  const OPS_TRANSFORM = 'transform';
  const OPS_SAVE = 'save';
  const OPS_RESTORE = 'restore';
  const OPS_PATH = 'constructPath';
  const OPS_PAINT = new Set(['fill', 'eoFill', 'stroke', 'closeFillStroke', 'closeEOFillStroke', 'fillStroke', 'eoFillStroke']);
  const OPS_TEXT = new Set(['beginText', 'endText', 'showText', 'showSpacedText', 'nextLineShowText', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject']);

  /**
   * 绘制指令 → 已绘制图形的 bbox（设备坐标，y 向下；和 spans 的坐标系一致）。
   * opList: pdf.js 的 getOperatorList()；nameOf: 序号 → 算子名（运行时用 pdfjs.OPS 反查）。
   */
  function paintedBoxes(opList, viewport, nameOf) {
    const out = [];
    if (!opList || !opList.fnArray) return out;
    const fn = opList.fnArray;
    const args = opList.argsArray;
    let ctm = (viewport && viewport.transform ? viewport.transform : [1, 0, 0, 1, 0, 0]).slice();
    const stack = [];
    let pending = null;
    for (let i = 0; i < fn.length; i++) {
      const n = nameOf(fn[i]);
      if (n === OPS_TRANSFORM && args[i] && args[i].length >= 6) { ctm = mulMatrix(ctm, args[i]); continue; }
      if (n === OPS_SAVE) { stack.push(ctm.slice()); continue; }
      if (n === OPS_RESTORE) { if (stack.length) ctm = stack.pop(); pending = null; continue; }
      if (n === OPS_PATH) {
        const coords = (args[i] && args[i][1]) || [];
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (let k = 0; k + 1 < coords.length; k += 2) {
          const x = ctm[0] * coords[k] + ctm[2] * coords[k + 1] + ctm[4];
          const y = ctm[1] * coords[k] + ctm[3] * coords[k + 1] + ctm[5];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        pending = x0 <= x1 ? [x0, y0, x1, y1] : null;
        continue;
      }
      if (OPS_PAINT.has(n)) {                      // 真正落到纸面上的才会出现在这里：fill / stroke 前面的路径
        if (pending) out.push(pending);
        pending = null;
        continue;
      }
      if (OPS_TEXT.has(n) || n === 'setFont') pending = null;
    }
    return out;
  }

  /** 只有“字形大小”的图形才算公式的组成部分（背景块、表格线、插图都不算）。 */
  const isGlyphBox = (b, S) => (b[2] - b[0]) >= 0.12 * S && (b[3] - b[1]) >= 0.12 * S
    && (b[2] - b[0]) <= HOLE_BOX_W * S && (b[3] - b[1]) <= HOLE_BOX_H * S;

  const boxUnion = (list) => list.reduce((a, b) => [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3]),
  ], [Infinity, Infinity, -Infinity, -Infinity]);

  const boxWidth = (b) => b[2] - b[0];
  const boxHeight = (b) => b[3] - b[1];

  /**
   * 页面 → 公式占位（holes）：[{ x0, y0, x1, y1, S, inline, after, before }]
   *   x0/y0/x1/y1：公式的 bbox（设备坐标，含一点点留白用的原始范围）
   *   S：所在行的字号；inline：是否夹在文字中间（false = 独占一行的大公式）
   *   after / before：前后紧邻的文字片段（截断到 8 个字符，用来做提示和调试）
   */
  function findHoles(spans, boxes, opts) {
    const out = [];
    const S0 = (opts && opts.body) || 10;
    const small = boxes.filter((b) => isGlyphBox(b, S0));       // 先按正文字号粗筛，后面按每行字号再筛一次
    if (!small.length) return out;
    const used = new Set(small);
    const lines = clusterLines(spans);
    for (const ln of lines) {
      const S = ln.S || S0;
      const vis = ln.spans.filter((s) => s.str.trim()).sort((a, b) => a.x - b.x);
      const glyphs = small.filter((b) => b[1] < ln.bot + 0.15 * S && b[3] > ln.top - 0.15 * S && isGlyphBox(b, S));
      if (!glyphs.length) continue;
      for (let k = 0; k + 1 < vis.length; k++) {
        const a = vis[k];
        const b = vis[k + 1];
        const gx0 = a.x + a.w;
        const gx1 = b.x;
        const gap = gx1 - gx0;
        if (gap < HOLE_MIN_GAP * S) continue;
        const hit = glyphs.filter((g) => used.has(g) && ((g[0] + g[2]) / 2 > gx0 - 0.25 * S) && ((g[0] + g[2]) / 2 < gx1 + 0.25 * S));
        if (!hit.length) continue;
        const box = boxUnion(hit);
        hit.forEach((g) => used.delete(g));                       // 一个图形只算一次（同一个字不会被左右两个空隙重复认领）
        out.push({
          x0: box[0], y0: box[1], x1: box[2], y1: box[3], S, B: ln.B, gx0, gx1, inline: true,
          after: a.str.trim().slice(-8), before: b.str.trim().slice(0, 8),
        });
      }
    }
    // 独占一行的公式：整行都是图形，文字行里对不上 → 自己聚成簇
    const rest = small.filter((b) => used.has(b));
    const clusters = [];
    for (const b of rest.slice().sort((p, q) => p[1] - q[1] || p[0] - q[0])) {
      const last = clusters[clusters.length - 1];
      if (last && b[1] < last.box[3] + 0.6 * S0 && b[0] < last.box[2] + 1.2 * S0 && b[2] > last.box[0] - 1.2 * S0) last.box = boxUnion([last.box, b]);
      else clusters.push({ box: b });
    }
    const lineBands = lines.map((ln) => [ln.top - 0.2 * ln.S, ln.bot + 0.2 * ln.S]);
    for (const c of clusters) {
      const box = c.box;
      if (boxHeight(box) > 3.5 * S0 || boxWidth(box) > 0.62 * (opts && opts.width ? opts.width : 600)) continue;   // 太高 / 太宽：插图
      const near = lineBands.some(([t, b]) => (box[1] > t && box[1] < b) || (box[3] > t && box[3] < b) || (box[1] < t && box[3] > b));
      if (near) continue;                                        // 和文字行重叠：已经在上面的空隙里处理过了
      const above = lines.filter((ln) => ln.bot <= box[1] && box[1] - ln.bot < 2.4 * S0).sort((p, q) => q.bot - p.bot)[0];
      const below = lines.filter((ln) => ln.top >= box[3] && ln.top - box[3] < 2.4 * S0).sort((p, q) => p.top - q.top)[0];
      if (!above && !below) continue;                             // 上不着村下不着店：图里的元素
      out.push({
        x0: box[0], y0: box[1], x1: box[2], y1: box[3], S: S0, B: above ? above.B : box[3], gx0: box[0], gx1: box[2], inline: false,
        after: above ? above.spans.map((s) => s.str).join('').trim().slice(-8) : '', before: below ? below.spans.map((s) => s.str).join('').trim().slice(0, 8) : '',
      });
    }
    return out.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).slice(0, MAX_HOLES_PAGE);
  }

  /** 把 holes 变成片段流里的占位符（放在空隙的位置上，排版时会当成一个普通片段）。 */
  function markHoles(spans, holes, pageNo) {
    if (!holes || !holes.length) return spans;
    const extra = [];
    holes.forEach((h, i) => {
      const x0 = Number.isFinite(h.gx0) ? h.gx0 : h.x0;
      const x1 = Number.isFinite(h.gx1) ? Math.max(h.gx1, h.x1) : h.x1;
      extra.push({
        str: holeMark(pageNo, i),
        x: x0,
        y: Number.isFinite(h.B) ? h.B : h.y1 - 0.9 * h.S,               // 与同一行的片段对齐，行聚类才不会散架
        w: Math.max(0.4 * h.S, x1 - x0),
        size: h.S,
        bold: false, italic: false, mono: false, math: false, hole: i,
      });
    });
    return spans.concat(extra);
  }

  /**
   * 把占位符换成 LaTeX / 截图。info: Map（字符串键 `页-序号`）→
   *   { tex }（识别出的 LaTeX，带 $ 定界符）| { img }（截图 data URL）| { miss: 原因 }
   */
  function applyHoles(md, info) {
    return String(md).replace(HOLE_MARK_RE, (m, p, i) => {
      const it = info.get(`${p}-${i}`);
      if (it && it.tex) return it.tex;
      if (it && it.img) return it.img;
      return '[公式]';
    });
  }

  const holesNote = (pages, count) => `第 ${pageRanges(pages)} 页有 ${count} 处公式是矢量图形（PDF 文字层里没有，直接读文字层会整句缺公式）`;

  /** 没有配置 / 不能调用视觉模型时的提示（后面会拼上“实际怎么处理的”）。 */
  function holeNote(pages, count, aiHint, problems) {
    const tail = problems && problems.length
      ? `视觉模型 API 还没配置好（${problems.join('、')}）`
      : `要转成 LaTeX 可以${aiHint}，或到设置里把“PDF 识别方式”改成“自动”`;
    return `${holesNote(pages, count)}：${tail}`;
  }

  /**
   * 把每个洞落实成 { tex } / { img } / { miss }。
   * 优先级：模型识别出的 LaTeX → 截图（可在设置里关掉）→ [公式]
   */
  async function resolveHoles(holeOut, holePages, holesOf, handle, cfg, deps, used) {
    const info = new Map();
    const needImg = [];
    for (const k of holePages) {
      const holes = holesOf(k);
      const got = holeOut.get(k);
      holes.forEach((h, i) => {
        const key = `${k}-${i}`;
        if (used && !used.has(key)) return;              // 这一页整页交给模型了（或被跳过）：它的占位符用不上，不用裁图
        const idx = got ? got.used.indexOf(i) : -1;
        const tex = idx >= 0 ? got.tex[idx] : null;
        if (tex) info.set(key, { tex });
        else needImg.push({ key, k, i });
      });
    }
    if (!needImg.length) return info;
    const wantImg = !cfg || cfg.holeImages !== false;
    if (wantImg && handle.holeCrops) {
      let budget = HOLE_IMG_TOTAL;
      const byPage = new Map();
      needImg.forEach((it) => {
        if (!byPage.has(it.k)) byPage.set(it.k, []);
        byPage.get(it.k).push(it);
      });
      for (const [k, list] of byPage) {
        let urls = [];
        try {
          urls = await handle.holeCrops(k, list.map((it) => it.i));
        } catch (e) {
          if (deps && deps.ui) deps.ui.log(`  第 ${k} 页的公式截图失败：${e.message}`);
        }
        list.forEach((it, j) => {
          const url = urls && urls[j];
          if (url && url.length <= budget) { budget -= url.length; info.set(it.key, { img: `![公式](${url})` }); }
        });
      }
    }
    return info;
  }

  /**
   * 把若干个洞裁成一张竖条拼图：每一块左边写编号，模型看图逐块回 LaTeX（见 STRIP_PROMPT）。
   * renderPage(scale) → canvas（整页渲染，由运行时提供），dims = { width, height }（页面尺寸，pt）。
   * 返回 { canvas, used }（used = 用到的洞在 holes 里的下标，按图里的顺序）。
   */
  async function holeStripCanvas(renderPage, holes, dims) {
    if (!holes || !holes.length) return null;
    const w = (dims && dims.width) || 595;
    const scale = Math.max(1.6, Math.min(3.6, HOLE_STRIP_WIDTH / w));
    const page = await renderPage(scale);
    if (!page || !page.width) return null;
    const S0 = holes[0].S || 10;
    const gap = Math.max(6, Math.round(0.7 * S0 * scale));
    const fontPx = Math.max(13, Math.round(1.5 * S0 * scale));
    const labelW = Math.ceil(fontPx * (String(holes.length).length + 0.8));
    const blocks = [];
    const used = [];
    let y = 6;
    let right = 0;
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      const x0 = Math.max(0, Math.floor((h.x0 - HOLE_PAD_X * h.S) * scale));
      const y0 = Math.max(0, Math.floor((h.y0 - HOLE_PAD_Y * h.S) * scale));
      const x1 = Math.min(page.width, Math.ceil((h.x1 + HOLE_PAD_X * h.S) * scale));
      const y1 = Math.min(page.height, Math.ceil((h.y1 + HOLE_PAD_Y * h.S) * scale));
      const ww = x1 - x0;
      const hh = y1 - y0;
      if (ww < 3 || hh < 3) continue;
      const rowH = hh + 6;
      if (y + rowH > HOLE_STRIP_MAX_H) break;
      blocks.push({ x0, y0, ww, hh, top: y, label: used.length + 1 });
      used.push(i);
      y += rowH + gap;
      right = Math.max(right, ww);
    }
    if (!blocks.length) return null;
    const canvas = makeCanvas(labelW + right + 8, y + 6);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.textBaseline = 'middle';
    blocks.forEach((b) => {
      g.drawImage(page, b.x0, b.y0, b.ww, b.hh, labelW, b.top, b.ww, b.hh);
      g.fillStyle = '#999';
      g.fillRect(labelW - 5, b.top + b.hh + 3, canvas.width - labelW, 1);
      g.fillStyle = '#111';
      g.font = `${fontPx}px sans-serif`;
      g.fillText(`${b.label}.`, 4, b.top + b.hh / 2);
    });
    return { canvas, used };
  }

  /**
   * 一个公式在页面上的裁剪范围：以图形 bbox 为准，上下再补到整行的字带
   * （这样上下标、根号、求和号上下限不会被切掉），左右只留一点点，免得把旁边的汉字裁进来。
   */
  function holeCropBox(h) {
    const S = h.S || 10;
    const baseline = h.B;
    const top = Number.isFinite(baseline) ? Math.min(h.y0, baseline - 0.88 * S) : h.y0;
    const bot = Number.isFinite(baseline) ? Math.max(h.y1, baseline + 0.24 * S) : h.y1;
    return {
      x0: h.x0 - HOLE_CROP_PAD_X * S,
      y0: top - HOLE_CROP_PAD_Y * S,
      x1: h.x1 + HOLE_CROP_PAD_X * S,
      y1: bot + HOLE_CROP_PAD_Y * S,
    };
  }

  /** 把画布裁成“只剩有笔画的部分 + 一点白边”；整张几乎全白时返回 null。 */
  function trimCanvas(canvas, margin) {
    const g = canvas.getContext('2d');
    let data;
    try { data = g.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { return canvas; }
    const px = data.data;
    let x0 = canvas.width; let y0 = canvas.height; let x1 = -1; let y1 = -1;
    let ink = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) {          // 非白
          ink++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (ink < 8 || x1 < x0 || y1 < y0) return null;
    const m = margin == null ? 3 : margin;
    const w = Math.min(canvas.width, x1 - x0 + 1 + 2 * m);
    const h = Math.min(canvas.height, y1 - y0 + 1 + 2 * m);
    const out = makeCanvas(w, h);
    const g2 = out.getContext('2d');
    g2.fillStyle = '#fff';
    g2.fillRect(0, 0, w, h);
    g2.drawImage(canvas, x0 - m, y0 - m, w, h, 0, 0, w, h);
    canvas.width = 0;
    canvas.height = 0;
    return out;
  }

  /** 只裁一个洞（识别不出时的截图兜底）。返回画布数组，裁不出东西的位置是 null。 */
  async function holeCropCanvases(renderPage, holes, dims) {
    const out = [];
    if (!holes || !holes.length) return out;
    const w = (dims && dims.width) || 595;
    const scale = Math.max(2, Math.min(6, HOLE_CROP_WIDTH / w));
    const page = await renderPage(scale);
    for (const h of holes) {
      const box = holeCropBox(h);
      const x0 = Math.max(0, Math.floor(box.x0 * scale));
      const y0 = Math.max(0, Math.floor(box.y0 * scale));
      const x1 = Math.min(page.width, Math.ceil(box.x1 * scale));
      const y1 = Math.min(page.height, Math.ceil(box.y1 * scale));
      const ww = Math.max(1, x1 - x0);
      const hh = Math.max(1, y1 - y0);
      const c = makeCanvas(ww, hh);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, ww, hh);
      g.drawImage(page, x0, y0, ww, hh, 0, 0, ww, hh);
      try {
        out.push(trimCanvas(c, 3));
      } catch (e) {
        out.push(c);
      }
    }
    return out;
  }

  /** 模型对拼图的回复 → 每一块的 LaTeX（没有的留 null）。 */
  function parseStripReply(text, count) {
    const out = new Array(count).fill(null);
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    for (const line of lines) {
      const m = /^\s*[-*•]?\s*\**\s*(\d{1,3})\s*[).、:：,，]\s*(.+?)\s*\**\s*$/.exec(line);
      if (!m) continue;
      const i = Number(m[1]) - 1;
      if (i < 0 || i >= count || out[i]) continue;
      out[i] = cleanSnippet(m[2]);
    }
    return out;
  }

  /** 一句回复 → 行内 / 独立公式（去掉代码围栏、定界符、多余解释）。 */
  function cleanSnippet(raw) {
    let t = String(raw == null ? '' : raw).trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    t = t.replace(/^\\\[|\\\]$/g, '').trim();
    if (!t || t === '?' || /^[（(]\s*(图|公式)?\s*[）)]$/.test(t) || /^图$/.test(t) || /^(看不清|无法识别|未能识别|unknown|unclear)$/i.test(t)) return null;
    const display = /^\$\$[\s\S]*\$\$$/.test(t);
    t = t.replace(/^\$\$?/, '').replace(/\$\$?$/, '').trim();
    if (!t) return null;
    return display ? `\n\n$$\n${t}\n$$\n\n` : `$${t}$`;
  }

  /* ====================================================================== *
   * 4. 视觉模型 API（OpenAI 兼容 /chat/completions，可选）
   * ====================================================================== */
  function normalizeEndpoint(url) {
    const u = String(url || '').trim().replace(/\/+$/, '');
    return /\/chat\/completions$/.test(u) ? u : `${u}/chat/completions`;
  }

  function parseExtra(text) {
    const t = String(text || '').trim();
    if (!t) return {};
    let v;
    try { v = JSON.parse(t); } catch (e) { throw new UserError('CFG', `“额外请求参数”不是合法的 JSON：${e.message}`); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UserError('CFG', '“额外请求参数”必须是 JSON 对象，例如 {"max_tokens": 4096}');
    return v;
  }

  function configProblems(cfg) {
    cfg = cfg || {};
    const bad = [];
    if (!/^https?:\/\/\S+$/i.test(String(cfg.apiUrl || '').trim())) bad.push('接口地址');
    if (!String(cfg.apiKey || '').trim()) bad.push('API Key');
    if (!String(cfg.model || '').trim()) bad.push('模型名');
    try { parseExtra(cfg.extraBody); } catch (e) { bad.push('额外请求参数（JSON 格式错误）'); }
    return bad;
  }

  function errorMessage(text) {
    const raw = String(text || '');
    try {
      const j = JSON.parse(raw);
      const e = Array.isArray(j) ? j[0] : j;
      const m = (e && e.error && (e.error.message || (typeof e.error === 'string' ? e.error : ''))) || (e && (e.message || e.msg || e.detail));
      if (m) return String(m).slice(0, 400);
    } catch (e) { /* 不是 JSON */ }
    return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function describeHttpError(status, msg) {
    if (status === 0) return `网络错误或超时：${msg}（请检查接口地址能否访问；脚本管理器若弹出跨域访问确认，请选择“总是允许”）`;
    if (status === 401 || status === 403) return `认证失败（HTTP ${status}）：请检查 API Key 是否正确、是否有权调用该模型。${msg}`;
    if (status === 404) return `接口或模型不存在（HTTP 404）：请检查接口地址（应以 /chat/completions 结尾，或只填到 /v1）和模型名。${msg}`;
    if (status === 429) return `请求过于频繁或额度用尽（HTTP 429）：${msg}`;
    return `接口返回 HTTP ${status}：${msg}`;
  }

  function parseCompletion(text) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error(`接口返回的不是 JSON：${String(text).slice(0, 160)}`); }
    const ch = j && j.choices && j.choices[0];
    if (!ch) throw new Error(`接口返回里没有 choices：${String(text).slice(0, 160)}`);
    let c = ch.message && ch.message.content;
    if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
    if (typeof c !== 'string' || !c.trim()) {
      throw new Error(`模型返回了空内容（finish_reason=${ch.finish_reason || '?'}）。可能是图片不被该模型支持、被内容策略拦截，或输出额度被思考过程耗尽`);
    }
    return { text: c, truncated: ch.finish_reason === 'length' };
  }

  // 个别模型不支持 temperature / max_tokens / thinking：按报错信息删掉对应字段后重试。
  function adjustBody(body, msg) {
    const m = String(msg).toLowerCase();
    if ('max_tokens' in body && m.includes('max_completion_tokens')) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
      return true;
    }
    for (const k of ['temperature', 'max_tokens', 'max_completion_tokens', 'thinking']) {
      if (k in body && m.includes(k)) { delete body[k]; return true; }
    }
    return false;
  }

  /** 发一次 chat/completions；deps = { http({method,url,headers,data,timeout}) → {status,text}, sleep }。 */
  async function chat(cfg, content, deps) {
    const url = normalizeEndpoint(cfg.apiUrl);
    const body = Object.assign({ model: cfg.model, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 8192 }, parseExtra(cfg.extraBody));
    let transient = 0;
    let adjusted = 0;
    for (;;) {
      const res = await deps.http({
        method: 'POST',
        url,
        timeout: 180000,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(cfg.apiKey).trim()}` },
        data: JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return parseCompletion(res.text);
      const msg = errorMessage(res.text);
      if ((res.status === 400 || res.status === 422) && adjusted < 4 && adjustBody(body, msg)) { adjusted++; continue; }
      if ((res.status === 0 || res.status === 429 || res.status >= 500) && transient < 2) {
        transient++;
        await deps.sleep(1500 * 2 ** (transient - 1));
        continue;
      }
      throw new Error(describeHttpError(res.status, msg));
    }
  }

  const STRIP_PROMPT = [
    '这张图是从一份编程竞赛题面 PDF 的同一页里裁出来的一串数学内容。PDF 把公式画成了矢量图形，文字层里只有空格，所以只能靠看图还原。',
    '每一块的左边都有一个编号（1、2、3…）。请逐块转写成 LaTeX，只输出“编号. 公式”，一行一个，例如：',
    '1. $n$',
    '2. $\\sum_{i=1}^{n} a_i \\le 10^5$',
    '',
    '规则：',
    '1. 每块只输出这一个公式本身：不要输出旁边被裁进来的文字，不要翻译、不要解释、不要写代码块、不要用表格。',
    '2. 行内公式用 `$...$`；明显是独立成行的大公式（有分数、求和、根号，撑得比较高）用 `$$...$$`。',
    '3. 编号必须和图片里的编号一一对应，不能漏、不能改顺序。',
    '4. 下标用 `a_i`（只有一个字符时可以不加大括号），上标用 `x^2`，多个字符写成 `a_{i+1}`。',
    '5. 看不清的写 `n. ?`；某一块不是公式（是插图、表格线、装饰）时写 `n. （图）`。',
  ].join('\n');

  /** 拼图（多块公式）→ 一次请求的内容。 */
  function stripContent(dataUrl, count) {
    return [
      { type: 'text', text: `${STRIP_PROMPT}\n\n补充说明：这张图里一共有 ${count} 块。` },
      { type: 'image_url', image_url: { url: dataUrl } },
    ];
  }

  function userContent(dataUrl, page, total) {
    let text = PROMPT;
    if (total > 1) {
      text += `\n\n补充说明：这是 PDF 题面的第 ${page}/${total} 页。只转写本页中能看到的内容，不要重复其他页，也不要补全被页边切断的句子。`;
    }
    return [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }];
  }

  /* ====================================================================== *
   * 5. PDF 识别：校验 → 文字层（默认）/ 视觉模型（可选，扫描件用）
   * ====================================================================== */
  function pdfStart(u8) {
    const lim = Math.min(u8.length - 5, 1024);
    for (let i = 0; i <= lim; i++) {
      if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) return i;
    }
    return -1;
  }

  /** 校验下载到的字节确实是 PDF。没登录 / 没权限时服务器会重定向到登录页，那时拿到的是 HTML。 */
  function checkPdfBytes(u8) {
    if (!u8 || !u8.length) throw new UserError('PDF_EMPTY', '下载到的 PDF 是空的');
    if (u8.length > MAX_PDF_BYTES) throw new UserError('PDF_BIG', `PDF 太大（${(u8.length / 1048576).toFixed(1)} MB，上限 ${MAX_PDF_BYTES / 1048576} MB）`);
    if (pdfStart(u8) < 0) {
      if (looksLikeHtml(u8)) throw new UserError('PDF_HTML', '下载到的是一个网页而不是 PDF，多半是登录已过期或没有权限查看：请刷新页面、确认已登录后再试');
      throw new UserError('PDF_BAD', '下载到的内容不是 PDF 文件');
    }
    return u8;
  }

  function pageRanges(pages) {
    const out = [];
    for (let i = 0; i < pages.length;) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      out.push(j > i ? `${pages[i]}–${pages[j]}` : String(pages[i]));
      i = j + 1;
    }
    return out.join('、');
  }

  // 没有文字层的扫描页 / 文字全是乱码 / 整页都是矢量字形（公式画成了轮廓，文字层里一个字都没有）
  const needsAi = (p) => !!p && (p.garbled || (p.chars < MIN_PAGE_CHARS && (p.images > 0 || (p.vecBoxes || 0) >= 8)));
  const isBlankPage = (p) => !!p && p.chars === 0 && p.images === 0;

  /**
   * 末尾的提示块。写成 HTML 注释：复制出去的 Markdown 渲染出来是干净的正文，
   * 提示只在源码里（面板的日志里也有一份）。
   */
  const notesBlock = (notes) => (notes && notes.length
    ? `\n\n<!--\n${notes.map((t) => `⚠️ ${t}`).join('\n')}\n-->`
    : '');

  /**
   * 识别一个 PDF，返回 { ok: true, markdown, engine: 'text'|'ai'|'mixed', pages, aiPages, notes, truncated, ... }。
   * markdown 是整份 PDF（末尾带提示）；body / rawBody 是不带提示的正文（rawBody 保留所有标题）；
   * problems / best / bestScore / bestTitle / ties 是 findProblems 的结果（PDF 里有多道题时才有内容）。
   * job = { handle, engine, cfg, title, pid, force, auto, progress(text), aiHint }  （title / pid：本题标题 / 题号，用来找同名的那道题）
   * handle = { numPages, hash, pageText(n) → {width,height,spans,chars,bad,garbled,images,holes}, pageImage(n) → {dataUrl},
   *            holeStrip(n, holes) → {dataUrl, used}，holeCrops(n, holes) → [dataUrl] }
   *
   * engine：text = 只用文字层；ai = 每一页都交给视觉模型；auto = 先用文字层，只有扫描页 / 乱码页，
   *         以及“公式被画成矢量图形、文字层里没有”的页才交给视觉模型。
   */
  async function recognizePdf(job, deps) {
    const { handle, cfg, force, auto } = job;
    const mode = ENGINES.includes(job.engine) ? job.engine : 'auto';
    const n = handle.numPages;
    const progress = job.progress || (() => {});
    const aiHint = job.aiHint || '点“AI 重新识别”';      // 提示里“怎么补救”的说法；题单里没有这个按钮，运行器会换一句
    if (n > MAX_PDF_PAGES) throw new UserError('PDF_PAGES', `这个 PDF 有 ${n} 页，超过上限（${MAX_PDF_PAGES} 页），已放弃`);
    const notes = [];

    const pages = new Array(n).fill(null);
    if (mode !== 'ai') {
      for (let k = 1; k <= n; k++) {
        progress(`读取文字层 ${k}/${n}`);
        pages[k - 1] = await handle.pageText(k);
      }
    }
    // 题面页面里已经有这一段（带 LaTeX）时，这份 PDF 就不用再识别了：不裁图、不调 API、也不往正文里贴。
    if (job.statementText && pages.some(Boolean)) {
      // 公式洞在文字层里是占位符（%%H页-序号%%），比对前先去掉，免得影响重合度
      const pdfText = pages.map((p) => (p && p.spans ? p.spans.map((x) => x.str).join('').replace(/%%H\d+-\d+%%/g, ' ') : '')).join('\n');
      const { dup, score } = dupOfStatement(job.statementText, pdfText);
      if (dup) {
        return {
          ok: true, dup: true, dupScore: score, markdown: '', body: '', rawBody: '',
          holes: 0, holeFixed: 0, holeImgs: 0, pages: n, aiPages: 0, engine: 'text',
          problems: [], best: -1, bestScore: 0, bestTitle: '', ties: false, truncated: false, notes: [],
          statement: '页面题面里已经有这一段（含 LaTeX 公式），这份 PDF 的内容和它重复，就不再复制一遍了',
        };
      }
      if (score > 0.2 && deps.ui && deps.ui.log) deps.ui.log(`  和题面重合度 ${Math.round(score * 100)}%，不像同一份，照旧识别`);
    }

    const poor = pages.map((p) => needsAi(p));
    const poorList = poor.map((x, i) => (x ? i + 1 : 0)).filter(Boolean);
    const textList = pages.map((p, i) => (p && !poor[i] && !isBlankPage(p) ? i + 1 : 0)).filter(Boolean);
    let aiList = [];
    if (mode === 'ai') aiList = pages.map((_, i) => i + 1);
    else if (mode === 'auto') aiList = poorList;

    // “文字层里缺了公式”的页：公式是矢量图形，文字层里只有一个空格（见 3c）。这些页的文字照旧用
    // 文字层，只有公式那几个小方块裁出来交给视觉模型。
    const holesOf = (k) => (pages[k - 1] && pages[k - 1].holes) || [];
    const holePages = pages.map((p, i) => (p && p.holes && p.holes.length && textList.includes(i + 1) ? i + 1 : 0)).filter(Boolean);
    const holeTotal = holePages.reduce((a, k) => a + holesOf(k).length, 0);
    let regionList = mode === 'text' ? [] : holePages.filter((k) => !aiList.includes(k));

    if (mode === 'text') {
      if (!textList.length) {
        throw new UserError('NO_TEXT', `这个 PDF 里没有可提取的文字（像是扫描件，或字体编码损坏）。请到设置里把“PDF 识别方式”改成“自动”并配置视觉模型 API，或${aiHint}。`);
      }
      if (poorList.length) notes.push(`第 ${pageRanges(poorList)} 页没有可提取的文字（扫描图 / 字体编码损坏），已跳过；可${aiHint}补全`);
    }

    let holesWanted = holeTotal;                  // 这次准备补的公式数（用来写提示）
    if (aiList.length || regionList.length) {
      const problems = configProblems(cfg);
      const budget = aiList.length + regionList.length;
      if (problems.length) {
        if (mode === 'ai') throw new UserError('NO_CONFIG', `视觉模型 API 还没配置好：${problems.join('、')}`);
        if (!textList.length) throw new UserError('NO_CONFIG', `这个 PDF 没有可提取的文字（像是扫描件），需要视觉模型 API 来识别，但还没配置好：${problems.join('、')}`);
        if (aiList.length) notes.push(`第 ${pageRanges(aiList)} 页没有可提取的文字（扫描图 / 字体编码损坏），视觉模型 API 又没配置，已跳过`);
        if (regionList.length) notes.push(holeNote(regionList, holesWanted, aiHint, problems));
        aiList = [];
        regionList = [];
        holesWanted = 0;
      } else if (budget > MAX_AI_PAGES) {
        throw new UserError('PDF_PAGES', `需要视觉模型识别的页数太多（${budget} 页，上限 ${MAX_AI_PAGES} 页）`);
      } else if (auto && budget > AUTO_MAX_AI_PAGES) {
        throw new UserError('AUTO_SKIP', `需要视觉模型识别 ${budget} 页（超过 ${AUTO_MAX_AI_PAGES} 页）`);
      }
    }
    if (regionList.length) {
      let left = MAX_HOLES_DOC;
      const trimmed = regionList.filter((k) => { left -= holesOf(k).length; return left >= 0; });
      if (trimmed.length < regionList.length) {
        const dropped = regionList.filter((k) => !trimmed.includes(k));
        notes.push(`这份 PDF 里要补的公式太多，第 ${pageRanges(dropped)} 页的公式这一轮没交给模型；可以${aiHint}分页补`);
      }
      regionList = trimmed;
      holesWanted = regionList.reduce((a, k) => a + holesOf(k).length, 0);
    }
    const holeNotes = [];                      // 公式相关的提示要等识别 / 截图都做完才能说准
    if (mode === 'text' && holeTotal) {
      holeNotes.push({ kind: 'noapi', pages: holePages, count: holeTotal, problems: null });
    }

    const aiOut = new Map();                   // 整页交给模型的页：页码 → { md }
    const holeOut = new Map();                 // 只补公式的页：页码 → { tex: [LaTeX…], used: [洞的下标…], skipped }
    const jobs = aiList.map((k) => ({ k, kind: 'page' })).concat(regionList.map((k) => ({ k, kind: 'hole' })));
    if (jobs.length) {
      let done = 0;
      progress(`视觉模型识别 0/${jobs.length}`);
      const outs = await mapLimit(jobs, Number(cfg.concurrency) || 1, async (j) => {
        const k = j.k;
        try {
          const pageKey = `${handle.hash}|${n}|p${k}`;
          if (j.kind === 'hole') {
            const holes = holesOf(k);
            const key = `${pageKey}|holes|${cfg.model}|${PROMPT_VERSION}`;
            const hit = force ? null : cacheGet(deps.storage, key);
            if (hit) {
              if (deps.ui) deps.ui.log(`  第 ${k} 页的公式：命中缓存`);
              return Object.assign({ k, kind: 'hole' }, JSON.parse(hit));
            }
            const strip = await handle.holeStrip(k, holes);
            if (!strip || !strip.used.length) return { k, kind: 'hole', error: '这一页的公式没能裁出图（页面渲染失败？）' };
            const r = await chat(cfg, stripContent(strip.dataUrl, strip.used.length), deps);
            const tex = parseStripReply(r.text, strip.used.length);
            const got = { tex, used: strip.used, skipped: holes.length - strip.used.length, truncated: !!r.truncated };
            if (!r.truncated) cachePut(deps.storage, key, JSON.stringify(got));
            return Object.assign({ k, kind: 'hole' }, got);
          }
          const key = `${pageKey}|${cfg.model}|${PROMPT_VERSION}`;
          let md = force ? null : cacheGet(deps.storage, key);
          let truncated = false;
          if (md == null) {
            const img = await handle.pageImage(k);
            const r = await chat(cfg, userContent(img.dataUrl, k, n), deps);
            md = cleanModelOutput(r.text);
            if (r.truncated) { md += `\n\n${TRUNCATED_NOTE}`; truncated = true; } else cachePut(deps.storage, key, md);
          } else if (deps.ui) deps.ui.log(`  第 ${k} 页：命中缓存`);
          return { k, kind: 'page', md, truncated };
        } catch (e) {
          if (deps.ui) deps.ui.log(`  第 ${k} 页失败：${e.message}`);
          return { k, kind: j.kind, error: e.message };
        } finally {
          done++;
          progress(`视觉模型识别 ${done}/${jobs.length}`);
        }
      });
      const pageOuts = outs.filter((o) => o.kind === 'page');
      const holeOuts = outs.filter((o) => o.kind === 'hole');
      const failed = outs.filter((o) => o.error);
      const failedPages = pageOuts.filter((o) => o.error).map((o) => o.k);
      const failedHoles = holeOuts.filter((o) => o.error);
      if (failed.length === outs.length && !textList.length) throw new Error(`所有页面的视觉模型识别都失败了。${failed[0].error}`);
      pageOuts.forEach((o) => aiOut.set(o.k, o));
      holeOuts.filter((o) => !o.error).forEach((o) => holeOut.set(o.k, o));
      if (failedPages.length) notes.push(`第 ${pageRanges(failedPages)} 页视觉模型识别失败：${flatten(pageOuts.find((o) => o.error).error)}`);
      if (failedHoles.length) {
        holeNotes.push({
          kind: 'fail',
          pages: failedHoles.map((o) => o.k),
          count: failedHoles.reduce((a, o) => a + holesOf(o.k).length, 0),
          why: flatten(failedHoles[0].error),
        });
      }
      holeOuts.filter((o) => !o.error).forEach((o) => {
        const miss = o.tex.filter((t) => !t).length + (o.skipped || 0);
        if (deps.ui) deps.ui.log(`  第 ${o.k} 页：补上 ${o.tex.filter(Boolean).length} 处公式${miss ? `，${miss} 处没补上` : ''}`);
        if (o.truncated) notes.push(`第 ${o.k} 页的公式识别输出被截断，后半部分可能没补上；可${aiHint}`);
      });
    }

    // 文字层里有一部分字符解不出来（公式字体缺映射表等）：提醒一下
    const lossy = textList.filter((k) => pages[k - 1].bad >= 3 && pages[k - 1].bad / pages[k - 1].chars >= 0.03);
    if (lossy.length) notes.push(`第 ${pageRanges(lossy)} 页有少量字符无法解码，公式 / 符号可能缺失；可${aiHint}对照`);

    // 相邻的文字页合在一起做版面分析（段落可以跨页），视觉模型识别的页按页码穿插进去。
    // 每段文字做两遍：segs 去掉与题目名重复的文档标题（整份输出用）；rawSegs 保留所有标题（分题时要靠题名标题）
    const segs = [];
    const rawSegs = [];
    let run = [];
    const flush = () => {
      if (run.length) {
        const pgs = run.map((k) => pages[k - 1]);
        segs.push(layoutDocument(pgs, { title: job.title }));
        rawSegs.push(layoutDocument(pgs, {}));
      }
      run = [];
    };
    for (let k = 1; k <= n; k++) {
      const o = aiOut.get(k);
      if (o && !o.error) { flush(); segs.push(o.md); rawSegs.push(o.md); } else if (textList.includes(k)) run.push(k);
      // 空白页 / 被跳过的页不产生内容，也不打断前后的段落
    }
    flush();
    const joinSegs = (a) => a.filter((x) => x && x.trim()).join('\n\n');
    // 占位符 → LaTeX / 截图 / [公式]。只处理最终正文里真的用得上的那些（整页交给模型的页不需要裁图）
    const usedHoleMarks = new Set();
    for (const m of joinSegs(segs).matchAll(/%%H(\d+)-(\d+)%%/g)) usedHoleMarks.add(`${m[1]}-${m[2]}`);
    const holeInfo = await resolveHoles(holeOut, holePages, holesOf, handle, cfg, deps, usedHoleMarks);
    const patch = (md) => (md.indexOf('%%H') < 0 ? md : applyHoles(md, holeInfo));
    const body = patch(joinSegs(segs));
    if (!body.trim()) throw new UserError('NO_TEXT', '没有识别出任何内容');
    const rawBody = patch(joinSegs(rawSegs));
    // 一份 PDF 里有多道题（比赛题面）：找出每道题的范围，以及与本题标题最像的那一道（由运行器决定取不取）
    const found = findProblems(rawBody, { title: job.title, pid: job.pid });
    // 看起来有好几道题（“输入 / 输出”之类的小节重复出现），却没能分出每道题：不要悄悄复制整份，说一声
    if (found.problems.length < 2 && (!job.cfg || job.cfg.pick !== false) && looksMultiProblem(rawBody)) {
      notes.push(`这份 PDF 里好像有好几道题（“输入 / 输出”之类的小节出现了多次），但没能认出每道题的分界，所以复制了整份，请自己删掉不属于这道题的部分；可以${aiHint}试试（模型转写出来的标题更规整，更容易分题）`);
    }
    const aiCount = Array.from(aiOut.values()).filter((o) => !o.error).length;
    const holeTex = Array.from(holeInfo.values()).filter((v) => v.tex).length;
    const holeImg = Array.from(holeInfo.values()).filter((v) => v.img).length;
    holeNotes.forEach((it) => {
      const pages2 = pageRanges(it.pages);
      const how = [];
      if (holeTex) how.push(`${holeTex} 处已转成 LaTeX`);
      if (holeImg) how.push(`${holeImg} 处已换成截图`);
      const rest = it.count - holeTex - holeImg;
      if (rest > 0) how.push(`${rest} 处写成 [公式]`);
      const tail = how.length ? `（${how.join('，')}）` : '';
      if (it.kind === 'noapi') notes.push(holeNote(it.pages, it.count, aiHint, it.problems) + tail);
      else notes.push(`第 ${pages2} 页有 ${it.count} 处公式没能识别（${it.why}）${tail}`);
    });
    return {
      ok: true,
      markdown: body + notesBlock(notes),
      body,
      rawBody,
      holes: holeTotal,
      holeFixed: holeTex,          // 转成 LaTeX 的处数
      holeImgs: holeImg,           // 退成截图的处数
      problems: found.problems,
      best: found.best,
      bestScore: found.bestScore,
      bestTitle: found.bestTitle,
      ties: found.ties,
      // 只补公式也算“文字层 + 视觉模型”（纯截图兜底不算，那还是文字层）
      engine: (aiCount || holeTex) && textList.length ? 'mixed' : (aiCount ? 'ai' : 'text'),
      pages: n,
      aiPages: aiCount,
      notes,
      truncated: Array.from(aiOut.values()).some((o) => o.truncated),
    };
  }

  /* ====================================================================== *
   * 6. 运行器：缓存 / 并发 / 汇总
   * ====================================================================== */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
    return out;
  }

  const loadConfig = (storage) => Object.assign({}, DEFAULT_CFG, storage.get(CFG_KEY, {}) || {});

  /** 题单里相邻两道题之间的间隔（毫秒）：缺省 / 非法 → 0.5 秒，最大 10 秒。 */
  const listGapOf = (cfg) => {
    const g = Number(cfg && cfg.listGap);
    return Number.isFinite(g) && g >= 0 ? Math.min(Math.round(g), LIST_GAP_MAX) : LIST_GAP_MS;
  };
  // 题单里没有“AI 重新识别”按钮，提示里的补救办法要换一句说法（见 recognizePdf 的 aiHint）
  const LIST_AI_HINT = '单独打开这道题，点“AI 重新识别”';
  const LIST_AUTO_HINT = '点右下角的按钮手动复制题单（手动开始才会用视觉模型），或单独打开这道题';

  function cacheGet(storage, key) {
    const hit = (storage.get(CACHE_KEY, {}) || {})[key];
    return hit ? hit.md : null;
  }

  function cachePut(storage, key, md) {
    const all = storage.get(CACHE_KEY, {}) || {};
    all[key] = { t: Date.now(), md };
    const keys = Object.keys(all);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - CACHE_MAX).forEach((k) => delete all[k]);
    }
    storage.set(CACHE_KEY, all);
  }


  /**
   * deps: {
   *   doc, loc, storage{get,set}, http, sleep, copy(text)→Promise<bool>, ui{state,log,result},
   *   loadPdf(url)→Promise<handle>（见 recognizePdf）, testImage()→dataUrl
   * }
   */
  function createRunner(deps) {
    const { doc, loc, storage, ui } = deps;
    let running = false;
    let listRun = false;          // 正在复制题单
    let cancelled = false;        // 题单复制被要求停止
    let last = '';
    let session = null;
    const ENGINE_LABEL = { text: '文字层', ai: '视觉模型', mixed: '文字层 + 视觉模型' };
    const pct = (x) => `${Math.round(x * 100)}%`;
    const shorten = (t, k) => { const a = Array.from(String(t)); return a.length > k ? `${a.slice(0, k - 1).join('')}…` : a.join(''); };

    // 状态栏上的进度；题单复制被要求停止后，一直提示“正在停止”直到当前这道题处理完
    const busy = (text) => ui.state('running', `⏳ ${cancelled ? '正在停止（等当前这道题处理完）· ' : ''}${text}`);

    // c.label：题单里加在进度前面的“3/12 · TR0043 · ”；c.indent：题单里日志的缩进；c.aiHint：见 recognizePdf
    async function readPdf(pdf, i, total, c) {
      const prefix = `${c.label || ''}${total > 1 ? `PDF ${i + 1}/${total} · ` : ''}`;
      const ind = c.indent || '';
      ui.log(`${ind}PDF ${i + 1}/${total}：${pdf.name || pdf.url}`);
      busy(`${prefix}读取 PDF`);
      const got = c.pool ? await c.pool.get(pdf.url) : { handle: await deps.loadPdf(pdf.url), reused: false };
      const handle = got.handle;
      try {
        ui.log(`${ind}  ${handle.numPages} 页${handle.size ? `，${Math.ceil(handle.size / 1024)} KB` : ''}${got.reused ? '（与前面的题共用这份 PDF，不再下载）' : ''}`);
        const r = await recognizePdf({
          handle,
          engine: c.engine,
          cfg: c.cfg,
          title: c.meta.title,
          pid: c.meta.pid,
          force: c.force,
          auto: c.auto,
          aiHint: c.aiHint,
          statementText: c.statementText,
          progress: (t) => busy(`${prefix}${t}`),
        }, deps);
        if (r.dup) {
          // 这里只记面板日志：跳过的内容不留进正文（连注释也不加，免得又被当成“复制了一堆东西”）
          ui.log(`${ind}  跳过：题面页面上已经有这一段（含 LaTeX 公式），这份 PDF 的内容和它重复（重合度 ${pct(r.dupScore)}）`);
        } else if (r.holes) {
          ui.log(`${ind}  公式补全：${r.holeFixed}/${r.holes} 处（${r.holeFixed ? '其余' : '这些'}是矢量图形，文字层里没有）`);
        }
        return r;
      } finally {
        if (handle.destroy) handle.destroy();
      }
    }

    /** 题面 DOM → { meta, markdown（含 %%PDF:n%% 占位符）, pdfs }。当前页（run）和取回来的别的题目页（runList）共用。 */
    function prepare(pdoc, ploc, o) {
      const root = findStatementRoot(pdoc, o && o.strict);
      if (!root) throw new UserError('NO_ROOT', '没有找到题面区域：这个页面的结构可能和 Hydro 默认模板不同。');
      // run 的日志里要写“题面区域是哪个容器”，方便对着页面看
      const ex = extract(root);
      const meta = extractMeta(pdoc, ploc, o);
      let { markdown, pdfs } = ex;
      // 站点数据里的题面原文：带 LaTeX 时直接用它（是从渲染结果里扒不出来的那种准）
      const data = statementFromPageData(pdoc);
      const dataPdfs = data ? pdfLinksFromMarkdown(data.markdown, ploc.href) : [];
      let source = 'dom';
      if (data && pageHasTex(data.markdown)) {
        markdown = data.markdown;
        source = 'data';
      }
      // 题面几乎是空的、只放了一个 PDF（嵌入的，或站点原文里 @[pdf](…) 指向的）：把那个 PDF 当作题面
      const onlyPdf = !pdfs.length ? (dataPdfs.length ? dataPdfs : ex.pdfLinks) : [];
      if (!pdfs.length && onlyPdf.length && markdown.replace(/\s+/g, '').length < SHORT_STATEMENT) {
        pdfs = onlyPdf;
        markdown += pdfs.map((_, i) => `\n\n%%PDF:${i}%%`).join('');
      }
      return { meta, markdown, pdfs, root, source, dataPdf: dataPdfs[0] || null };
    }

    /** 依次识别题面里的每个 PDF。stopOnAuto：遇到“需要模型识别、自动模式不跑”时抛出（run 要据此整个跳过）；否则记成这个 PDF 失败。 */
    async function readAll(pdfs, c, stopOnAuto) {
      const results = [];
      for (let i = 0; i < pdfs.length; i++) {
        try {
          results.push(await readPdf(pdfs[i], i, pdfs.length, c));
        } catch (e) {
          if (e.code === 'AUTO_SKIP' && stopOnAuto) throw e;
          ui.log(`${c.indent || ''}  失败：${e.message}`);
          results.push({ ok: false, error: e.message, code: e.code });
        }
      }
      return results;
    }

    const hasProblems = (r) => !!(r && r.ok && r.problems && r.problems.length);

    /**
     * 一份 PDF 里有多道题时，按 choice（题目下标，或 'whole' = 整份）算出这份 PDF 放进题面的 Markdown。
     * mode：auto = 按题名相似度自动取（不太有把握时在末尾提示）；manual = 用户在下拉框里选的（不提示）；off = 设置里关掉了自动取，给整份。
     */
    function compose(r, choice, meta, mode) {
      const notes = (r.notes || []).slice();
      const n = r.problems.length;
      let body = r.body;
      r.choice = choice;
      r.pickWarn = false;
      if (choice !== 'whole') {
        const p = r.problems[choice];
        body = sliceProblem(r.rawBody, p, { dropTitle: p.score >= PICK_DROP_TITLE });
        if (mode === 'auto' && (p.score < PICK_SURE || r.ties)) {
          notes.push(`PDF 里有 ${n} 道题，按题名相似度取了第 ${choice + 1} 题「${p.title}」（相似度 ${pct(p.score)}${r.ties ? '，还有别的题同样相似' : ''}），不一定对；可以在 👀 面板的下拉框里换成别的题。`);
          r.pickWarn = true;
        }
      } else if (mode === 'auto') {
        notes.push(`PDF 里有 ${n} 道题，但没有找到与「${meta.title}」同名的（最像的是「${r.bestTitle}」，相似度 ${pct(r.bestScore)}），所以保留了整份 PDF；可以在 👀 面板的下拉框里选其中一道。`);
        r.pickWarn = true;
      }
      r.markdown = body + notesBlock(notes);
    }

    const pickLabel = (r) => {
      const n = r.problems.length;
      return r.choice === 'whole' ? ` · 整份 PDF（${n} 道题）` : ` · 第 ${r.choice + 1}/${n} 题「${shorten(r.problems[r.choice].title, 16)}」`;
    };

    // 题名自带题号（“2．乌龟棋”“Problem B”“第一题”）的就不再加一个序号
    const numbered = (t) => ENUM_PREFIXES.slice(1).some((re) => re.test(`${plainText(t)} `));
    const pickOptions = (r) => r.problems.map((p, i) => ({ value: String(i), label: `${numbered(p.title) ? '' : `${i + 1}. `}${shorten(p.title, 24)} · 相似度 ${pct(p.score)}` }))
      .concat([{ value: 'whole', label: `整份 PDF（${r.problems.length} 道题）` }]);

    /** 拼出最终题面、写进面板、复制、更新状态栏。 */
    async function finish(sess, opts) {
      const { meta, markdown, pdfs, results } = sess;
      const failed = results.filter((r) => !r.ok);
      const md = assemble(meta, markdown, pdfs, results);
      last = md;
      ui.result(md);
      const target = results.findIndex(hasProblems);
      if (ui.picks) ui.picks(target >= 0 ? pickOptions(results[target]) : null, target >= 0 ? String(results[target].choice) : '');
      const copied = await deps.copy(md);
      const good = results.filter((r) => r.ok);
      const warn = failed.length > 0 || good.some((r) => r.truncated || r.pickWarn || (r.notes && r.notes.length));
      const used = good.filter((r) => !r.dup);                    // 被跳过的 PDF（题面里已有）不算一种识别方式
      const how = Array.from(new Set(used.map((r) => ENGINE_LABEL[r.engine]).filter(Boolean))).join('、');
      const dupN = good.filter((r) => r.dup).length;
      const note = failed.length ? `（${failed.length} 个 PDF 失败）`
        : (warn ? '（有提示，见面板）' : (dupN ? `（跳过 ${dupN} 份重复的 PDF）` : ''));
      // 公式退成了截图：把“配上 API 就能转成 LaTeX”直接说在按钮上，别让用户以为只能这样
      const imgCount = good.reduce((a, r) => a + (r.holeImgs || 0), 0);
      const noApi = configProblems(loadConfig(storage)).length > 0;
      const imgLabel = `${imgCount} 处公式是截图`;
      if (!copied) {
        ui.state('warn', '⚠️ 复制失败，点 👀 手动复制', '浏览器拒绝写入剪贴板：请点右侧 👀 打开面板，手动复制文本框里的内容');
      } else if (imgCount && noApi && !failed.length) {
        ui.state('needcfg', `🔑 已复制 · ${imgLabel}，点这里转成 LaTeX`,
          '这些公式在 PDF 里是矢量图形（文字层里没有），要变成 LaTeX 得用视觉模型：点这里打开设置填好 API（有免费档），'
          + '回来再点一次就会把公式重新识别成 LaTeX；不想用 API 的话，也可以在设置里把“识别不出的公式改用截图”关掉，改成 [公式] 占位');
      } else if (imgCount && !failed.length && !warn) {
        ui.state('warn', `⚠️ 已复制 · ${imgLabel}`, '这些公式没认出来（内容不对 / 输出被截断），已经用截图代替：可以点“AI 重新识别”再试一次');
      } else {
        ui.state(warn ? 'warn' : 'done', `${warn ? '⚠️' : '✅'} 已复制 · ${md.length} 字${how ? ` · ${how}` : ''}${target >= 0 ? pickLabel(results[target]) : ''}${note}`, '点击可重新识别并复制');
      }
      if (!(opts && opts.quiet) && warn) good.forEach((r) => (r.notes || []).forEach((t) => ui.log(`提示：${t}`)));
      return { markdown: md, pdfs: pdfs.length, failed: failed.length, copied, engines: good.map((r) => r.engine) };
    }

    /** 一份 PDF 里有多道题（比赛题面）：只取与本题同名（相似度最高）的那一道；设置里可以关掉，面板里可以改选。 */
    function pickAll(results, c) {
      const ind = c.indent || '';
      const autoPick = c.cfg.pick !== false;
      results.forEach((r, i) => {
        if (!hasProblems(r)) return;
        ui.log(`${ind}  PDF ${i + 1} 里有 ${r.problems.length} 道题：${r.problems.map((p, k) => `${k + 1}.${shorten(p.title, 20)}`).join(' ｜ ')}`);
        const choice = autoPick && r.best >= 0 ? r.best : 'whole';
        compose(r, choice, c.meta, autoPick ? 'auto' : 'off');
        if (!autoPick) ui.log(`${ind}  设置里关闭了“多道题时只取同名的那道”，保留整份 PDF`);
        else if (choice === 'whole') ui.log(`${ind}  没有找到与「${c.meta.title}」同名的题（最像的是「${r.bestTitle}」，相似度 ${pct(r.bestScore)}），保留整份 PDF`);
        else ui.log(`${ind}  取第 ${choice + 1} 题「${r.problems[choice].title}」（与「${c.meta.title}」相似度 ${pct(r.problems[choice].score)}）`);
      });
    }

    const engineOf = (cfg, engine) => (ENGINES.includes(engine) ? engine : (ENGINES.includes(cfg.engine) ? cfg.engine : 'auto'));

    async function run(opts) {
      const { auto = false, force = false, engine } = opts || {};
      if (running) return { skipped: 'busy' };
      running = true;
      session = null;
      try {
        if (ui.picks) ui.picks(null, '');
        const { meta, markdown, pdfs, root, source, dataPdf } = prepare(doc, loc);
        if (auto && !pdfs.length) {
          ui.state('idle', '📋 复制题面 Markdown');
          return { skipped: 'no-pdf' };
        }

        const cfg = loadConfig(storage);
        const c = { cfg, meta, force, auto, engine: engineOf(cfg, engine), statementText: markdown };
        const katexN = doc.querySelectorAll('.katex').length;
        const mjxN = doc.querySelectorAll('mjx-container, script[type^="math/tex"]').length;
        const hasTex = pageHasTex(markdown);
        const mdChars = markdown.replace(/\s+/g, '').length;
        ui.log(`题面：${mdChars} 字${hasTex ? '，含 LaTeX 公式' : '，没有公式源码'}`
          + `（来源：${source === 'data' ? '站点数据里的题面原文' : '页面 HTML'}）`
          + `${pdfs.length ? `；PDF ${pdfs.length} 份` : ''}（页面上的公式：KaTeX ${katexN} 处 ｜ MathJax ${mjxN} 处`
          + `${root ? `；题面区域：${rootHint(root)}` : ''}）`);
        // 题面里没有公式源码，但页面上明明有公式：多半是题面区域认错了——这行日志能直接看出问题在哪
        if (!hasTex && katexN + mjxN > 0) ui.log(`⚠️ 页面上有 ${katexN + mjxN} 处公式，但没有一处落在题面区域（${root ? rootHint(root) : '没找到'}）里，公式只能从 PDF 里补；请把这行日志发给作者`);
        // 题面本身就是一个 PDF：页面上的“公式”是 PDF 里画出来的图，文字层里没有 —— 说清楚，别让人以为脚本没干活
        else if (!hasTex && pdfs.length && mdChars < SHORT_STATEMENT) {
          ui.log(`ℹ️ 这道题的题面本身就是一份 PDF（${dataPdf ? `站点原文里写着 @[pdf](${dataPdf.name})` : '题面里嵌着一份 PDF'}）：`
            + '公式在 PDF 里是画出来的图形，文字层里没有 → 想要真 LaTeX 得配一个视觉模型（面板里点 🔑 配置，免费预设：智谱 GLM-4.6V-Flash）');
        }
        let results;
        try {
          results = await readAll(pdfs, c, true);
        } catch (e) {
          if (e.code !== 'AUTO_SKIP') throw e;
          ui.state('idle', '🔑 PDF 需要模型识别，点击开始', `${e.message}。自动模式不会自动调用视觉模型（避免意外花费），请手动点击`);
          return { skipped: 'too-many' };
        }

        const failed = results.filter((r) => !r.ok);
        if (pdfs.length && failed.length === pdfs.length) {
          const f = failed[0];
          throw f.code ? new UserError(f.code, f.error) : new Error(f.error);
        }

        pickAll(results, c);
        session = { meta, markdown, pdfs, results };
        return await finish(session, {});
      } finally {
        running = false;
      }
    }

    /**
     * 题单里相邻的几道题常常嵌着同一份 PDF（同一场比赛的题面）：同一个地址只下载 / 解析一次，每页文字也只读一次（layoutDocument 不会改动传入的页面，可以放心共用）。
     * 最近用到的 2 份留在内存里（超出的关掉）；打开失败的不留着，下一道题再试。共用的句柄 destroy() 什么也不做，由池子统一关。
     */
    function makePdfPool() {
      const MAX = 2;
      const list = [];                                              // { url, p: Promise<句柄> }，最近用到的在最后
      const share = (h) => {
        const texts = new Map();
        return {
          numPages: h.numPages,
          hash: h.hash,
          size: h.size,
          pageText: (n) => { if (!texts.has(n)) texts.set(n, h.pageText(n)); return texts.get(n); },
          pageImage: (n) => h.pageImage(n),
          destroy() {},
          close() { if (h.destroy) h.destroy(); },
        };
      };
      const close = async (e) => { try { (await e.p).close(); } catch (err) { /* 没打开成功，没有句柄可关 */ } };
      return {
        async get(url) {
          let e = list.find((x) => x.url === url);
          const reused = !!e;
          if (e) {
            list.splice(list.indexOf(e), 1);
          } else {
            e = { url, p: Promise.resolve().then(() => deps.loadPdf(url)).then(share) };
            e.p.catch(() => { const k = list.indexOf(e); if (k >= 0) list.splice(k, 1); });
          }
          list.push(e);
          while (list.length > MAX) close(list.shift());
          return { handle: await e.p, reused };
        },
        closeAll: () => Promise.all(list.splice(0).map(close)),
      };
    }

    /** 取回题单里一道题的页面（429 / 5xx / 网络错误时退避重试）。fetchDoc 抛出的错误带 retry 标记表示值得重试。 */
    async function fetchPage(url) {
      for (let k = 0; ; k++) {
        try {
          return await deps.fetchDoc(url);
        } catch (e) {
          if (!e.retry || k >= LIST_RETRIES || cancelled) throw e;
          const wait = 1000 * 2 ** k;
          ui.log(`  ${e.message}，${wait / 1000} 秒后重试（${k + 1}/${LIST_RETRIES}）`);
          await deps.sleep(wait);
        }
      }
    }

    /** 题单里的一道题：取回页面 → 提取题面 → 识别 PDF → 取同名题 → 拼成 Markdown。出错不抛，记在返回值里，不影响后面的题。 */
    async function listProblem(link, i, total, c) {
      const tag = `${i + 1}/${total}`;
      const name = link.label || link.url;
      const item = { url: link.url, label: link.label, ok: false, warn: false, aiPages: 0 };
      ui.log(`[${tag}] ${name}`);
      busy(`${tag} · ${shorten(name, 20)} · 下载题面`);
      try {
        const got = await fetchPage(link.url);
        const { meta, markdown, pdfs } = prepare(got.doc, got.loc, { strict: true, pageId: true });
        item.label = [meta.pid, meta.title].filter(Boolean).join(' ') || item.label;
        const cc = Object.assign({}, c, { meta, statementText: markdown, label: `${tag} · ${shorten(meta.pid || meta.title, 14)} · `, indent: '  ' });
        const results = await readAll(pdfs, cc, false);
        pickAll(results, cc);
        item.md = assemble(meta, markdown, pdfs, results);
        item.ok = true;
        item.warn = results.some((r) => !r.ok || r.truncated || r.pickWarn || (r.notes && r.notes.length));
        item.aiPages = results.reduce((a, r) => a + (r.ok ? r.aiPages || 0 : 0), 0);
        ui.log(`  ✅ ${item.md.length} 字${item.warn ? '（有提示）' : ''}`);
      } catch (e) {
        item.error = e.message;
        item.code = e.code;
        ui.log(`  ❌ ${e.message}`);
      }
      return item;
    }

    /**
     * 题单（训练）页：按页面顺序依次取回每道题的页面（相邻两题之间等 listGap 毫秒，默认 0.5 秒），
     * 对每道题做与单独打开它时一样的转换，最后合并成一份 Markdown 复制。
     * 自动开始（auto）：题数不超过 AUTO_MAX_LIST，且只读 PDF 文字层、不调用视觉模型。
     * 设置里勾了“逐题写入剪贴板”时，每转换完一道题就先把这道题复制一次（给剪贴板历史工具用），最后再复制合并的整份。
     */
    async function runList(opts) {
      const { auto = false, force = false, engine } = opts || {};
      if (running) return { skipped: 'busy' };
      running = true;
      listRun = true;                // cancelled 只会在 listRun 期间被置位，并在 finally 里复位
      session = null;
      let pool = null;
      try {
        if (ui.picks) ui.picks(null, '');
        const cfg = loadConfig(storage);
        const links = collectProblemLinks(doc, loc);
        const total = links.length;
        if (!total) throw new UserError('NO_PROBLEMS', '这个页面里没有找到题目链接：页面结构可能和 Hydro 默认模板不同。');
        if (auto && total > AUTO_MAX_LIST) {
          ui.state('idle', `📚 题单有 ${total} 题，点击开始复制`, `超过 ${AUTO_MAX_LIST} 题不自动开始（避免一打开页面就连发大量请求），请手动点击`);
          return { skipped: 'too-many', total };
        }
        const gap = listGapOf(cfg);
        const want = auto ? 'text' : engineOf(cfg, engine);
        let aiLeft = want === 'text' ? 0 : LIST_MAX_AI_PAGES;
        const missing = countMissingRows(doc);
        ui.log(`题单共 ${total} 题，每题间隔 ${gap} 毫秒${auto ? '；自动开始只读 PDF 文字层，不调用视觉模型' : ''}`);
        if (missing) ui.log(`另有 ${missing} 行是被删除 / 无权查看的题，没法取，已跳过`);

        const items = [];
        pool = makePdfPool();
        let capLogged = false;
        for (let i = 0; i < total; i++) {
          if (cancelled) break;
          if (i > 0 && gap > 0) {
            await deps.sleep(gap);
            if (cancelled) break;
          }
          if (want !== 'text' && aiLeft <= 0 && !capLogged) {
            capLogged = true;
            ui.log(`视觉模型已经识别了 ${LIST_MAX_AI_PAGES} 页，这是一个题单的上限；后面的题只读 PDF 文字层`);
          }
          const item = await listProblem(links[i], i, total, { cfg, force, auto: false, engine: aiLeft > 0 ? want : 'text', aiHint: auto ? LIST_AUTO_HINT : LIST_AI_HINT, pool });
          aiLeft -= item.aiPages;
          items.push(item);
          if (item.ok && cfg.listEach) await deps.copy(item.md);
        }

        const stopped = items.length < total;
        const md = assembleList({ url: String(loc.href).split('#')[0], missing }, items, total);
        last = md;
        ui.result(md);
        const okN = items.filter((it) => it.ok).length;
        const failN = items.length - okN;
        const warnN = items.filter((it) => it.ok && it.warn).length;
        if (!okN) throw new UserError(items[0].code || 'LIST_FAIL', `一道题也没取到（共 ${items.length} 题）：${items[0].error}`);

        const copied = await deps.copy(md);
        const note = failN ? `（${failN} 题没取到，见面板）` : (warnN ? `（${warnN} 题有提示，见面板）` : '');
        if (!copied) {
          ui.state('warn', '⚠️ 复制失败，点 👀 手动复制', '浏览器拒绝写入剪贴板：请点右侧 👀 打开面板，手动复制文本框里的内容');
        } else {
          const bad = failN > 0 || warnN > 0 || stopped;
          ui.state(bad ? 'warn' : 'done', `${bad ? '⚠️' : '✅'} ${stopped ? '已停止，' : ''}已复制 ${okN}/${total} 题 · ${md.length} 字${note}`, '点击可重新复制整个题单');
        }
        return { markdown: md, total, ok: okN, failed: failN, copied, cancelled: stopped };
      } finally {
        if (pool) await pool.closeAll();
        running = false;
        listRun = false;
        cancelled = false;
      }
    }

    /** 要求停止正在进行的题单复制：当前这道题处理完就停，已处理的题照常合并复制。 */
    function cancel() {
      if (!listRun || cancelled) return false;
      cancelled = true;
      ui.state('running', '⏳ 正在停止（等当前这道题处理完）');
      ui.log('已要求停止：当前这道题处理完就停，已处理的题会照常复制');
      return true;
    }

    /** 面板下拉框改选：choice = 题目下标（字符串 / 数字）或 'whole'。不重新读 PDF，只重新取、重新复制。 */
    async function repick(value) {
      if (running) return { skipped: 'busy' };
      const target = session ? session.results.findIndex(hasProblems) : -1;
      if (target < 0) return { skipped: 'no-pick' };
      const r = session.results[target];
      const choice = value === 'whole' ? 'whole' : Number(value);
      if (choice !== 'whole' && !r.problems[choice]) return { skipped: 'bad-choice' };
      running = true;
      try {
        compose(r, choice, session.meta, 'manual');
        ui.log(choice === 'whole' ? '已改为整份 PDF' : `已改为第 ${choice + 1} 题「${r.problems[choice].title}」`);
        return await finish(session, { quiet: true });
      } finally {
        running = false;
      }
    }

    async function testConnection(cfg) {
      const bad = configProblems(cfg);
      if (bad.length) throw new UserError('CFG', `还没填好：${bad.join('、')}`);
      const r = await chat(cfg, [
        { type: 'text', text: '这是一张空白图片。请只回复两个字母：OK' },
        { type: 'image_url', image_url: { url: deps.testImage() } },
      ], deps);
      return r.text.trim().slice(0, 80);
    }

    return { run, runList, cancel, repick, testConnection, getLast: () => last, isBusy: () => running };
  }

  /* ---------------------------------------------------------------------- *
   * 测试用导出（Node require 时）：只导出纯函数，不启动 UI
   * ---------------------------------------------------------------------- */
  const api = {
    VERSION, PROMPT, PRESETS, ROUTE_RE, LIST_ROUTE_RE, LIST_GAP_MS, AUTO_MAX_LIST, LIST_MAX_AI_PAGES, DEFAULT_CFG, ENGINES, CFG_KEY, CACHE_KEY, PROMPT_VERSION,
    MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_AI_PAGES, AUTO_MAX_AI_PAGES, UserError,
    findStatementRoot, extract, extractMeta, buildHeader, assemble, collectProblemLinks, countMissingRows, assembleList, tidy, cleanModelOutput,
    plainTextOf, gramSet, overlapScore, pageHasTex, dupOfStatement, DUP_SKIP_SCORE, DUP_MIN_CHARS, rootHint,
    pageData, statementFromPageData, pdfLinksFromMarkdown, unescapeJs,
    looksLikeHtml, hashBytes, checkPdfBytes, pdfRefOf, isPdfUrl,
    classifyFont, normChars, spansFromTextContent, pageTextStats, clusterLines, wrapMath, toLatex, layoutDocument, recognizePdf,
    paintedBoxes, isGlyphBox, findHoles, markHoles, applyHoles, resolveHoles, parseStripReply, cleanSnippet,
    holeStripCanvas, holeCropCanvases, stripContent, STRIP_PROMPT, holeNote, HOLE_MARK_RE, setCanvasFactory, makeCanvas, canvasToBlob, blobToDataUrl,
    PICK_MIN, PICK_SURE, PICK_DROP_TITLE, NOISE_HEAD_RE, META_HEAD_RE, titleLineCandidates, looksMultiProblem, plainText, sectionInfo, titleShape, nameKeys, keySim, nameSimilarity, parseHeadings, blockKinds, findProblems, sliceProblem,
    normalizeEndpoint, parseExtra, configProblems, errorMessage, parseCompletion, adjustBody, chat, userContent,
    mapLimit, loadConfig, cacheGet, cachePut, createRunner,
  };
  if (typeof module === 'object' && module && module.exports) { module.exports = api; return; }

  /* ====================================================================== *
   * 7. 浏览器运行时：GM_* 封装 / PDF 下载与 pdf.js / 界面 / 启动
   * ====================================================================== */
  const log = (...a) => console.log('[goj2md]', ...a);

  function gmHttp(opts) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest(Object.assign({}, opts, {
        onload: (r) => resolve({ status: r.status, text: r.responseText }),
        onerror: (r) => resolve({ status: 0, text: `网络错误${r && r.error ? `（${r.error}）` : ''}` }),
        ontimeout: () => resolve({ status: 0, text: '请求超时' }),
        onabort: () => resolve({ status: 0, text: '请求被中止' }),
      }));
    });
  }

  function gmBytes(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 120000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response ? resolve(new Uint8Array(r.response)) : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('超时')),
        onabort: () => reject(new Error('已中止')),
      });
    });
  }

  /**
   * 下载 PDF 字节。同源的优先用页面自己的 fetch（带登录 Cookie 最可靠）；Hydro 会 302 到带签名的存储地址，
   * 那个地址如果不允许跨域读取，fetch 会失败，这时改用 GM 请求（不受 CORS 限制）。互为后备。
   */
  async function fetchPdfBytes(url) {
    if (/^data:/i.test(url)) {
      const r = await fetch(url);
      return checkPdfBytes(new Uint8Array(await r.arrayBuffer()));
    }
    const viaPage = async () => {
      const r = await fetch(url, { credentials: 'include', signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(120000) : undefined });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const sameOrigin = new URL(url, location.href).origin === location.origin;
    const order = sameOrigin ? [viaPage, () => gmBytes(url)] : [() => gmBytes(url), viaPage];
    let lastErr = null;
    let userErr = null;
    for (const f of order) {
      try {
        return checkPdfBytes(await f());
      } catch (e) {
        if (e.code === 'PDF_BIG') throw e;
        if (e instanceof UserError) userErr = userErr || e;
        lastErr = e;
      }
    }
    throw userErr || new UserError('PDF_FETCH', `下载 PDF 失败：${lastErr ? lastErr.message : '未知错误'}（${url}）`);
  }

  /**
   * 取回别的题目页（题单里用）：带登录 Cookie 的同源 fetch → 解析成一个独立文档（里面的脚本不会执行）。
   * 插入 <base>，让里面的相对地址（PDF / 图片）按这道题自己的地址解析，而不是按题单页的地址。
   * 429 / 5xx / 网络错误的错误带 retry 标记（值得重试）；被重定向到登录页 → LOGIN；403 / 404 → HTTP（重试没有意义）。
   */
  async function fetchProblemDoc(url) {
    const retryable = (e) => Object.assign(e, { retry: true });
    let res;
    try {
      res = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(60000) : undefined,
      });
    } catch (e) {
      throw retryable(new UserError('FETCH', `网络错误：${e && e.message ? e.message : e}`));
    }
    const finalUrl = new URL(res.url || url, location.href);
    if (/\/login\/?$/.test(finalUrl.pathname)) {
      throw new UserError('LOGIN', '被重定向到了登录页：登录已过期，或这道题要登录后才能看。请刷新页面、确认已登录后再试');
    }
    if (res.status === 429 || res.status >= 500) throw retryable(new UserError('HTTP', `HTTP ${res.status}`));
    if (!res.ok) throw new UserError('HTTP', `HTTP ${res.status}（没有权限，或这道题不存在）`);
    let html;
    try {
      html = await res.text();
    } catch (e) {
      throw retryable(new UserError('FETCH', `读取页面失败：${e && e.message ? e.message : e}`));
    }
    const d = new DOMParser().parseFromString(html, 'text/html');
    const base = d.createElement('base');
    base.href = finalUrl.href;
    d.head.insertBefore(base, d.head.firstChild);
    return { doc: d, loc: finalUrl };
  }

  function getPdfjs() {
    const lib = typeof pdfjsLib !== 'undefined' ? pdfjsLib : (typeof window !== 'undefined' ? window.pdfjsLib : null);
    return lib && typeof lib.getDocument === 'function' ? lib : null;
  }

  /** 下载并打开一个 PDF，返回 recognizePdf 需要的 handle。 */
  async function loadPdf(url) {
    const pdfjs = getPdfjs();
    if (!pdfjs) {
      throw new UserError('NO_PDFJS', '没有加载到 pdf.js：脚本头部的 @require 没有生效（网络访问不了 jsdelivr？）。请检查网络，或把两行 @require 换成能访问的镜像地址后重新安装脚本。');
    }
    // pdf.js 在页面里找不到 worker 脚本时，才会去读 GlobalWorkerOptions.workerSrc，读不到就抛一句看不懂的英文——这里先检查，给出明确提示
    const gl = typeof globalThis !== 'undefined' ? globalThis : window;
    if (!(gl.pdfjsWorker && gl.pdfjsWorker.WorkerMessageHandler) && !(pdfjs.GlobalWorkerOptions && pdfjs.GlobalWorkerOptions.workerSrc)) {
      throw new UserError('NO_PDFJS', '没有加载到 pdf.js 的 worker 脚本：脚本头部第二行 @require（pdf.worker.min.js）没有生效。请检查网络，或把两行 @require 换成能访问的镜像地址后重新安装脚本。');
    }
    const bytes = await fetchPdfBytes(url);
    const hash = hashBytes(bytes);
    let doc;
    try {
      // isEvalSupported:false 关掉字体的 eval 路径（CVE-2024-4367）；disableFontFace:true 避免往宿主页面塞字体
      doc = await pdfjs.getDocument({
        data: bytes.slice(),
        isEvalSupported: false,
        disableFontFace: true,
        enableXfa: false,
        cMapUrl: `${PDFJS_CDN}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_CDN}standard_fonts/`,
        verbosity: 0,
      }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new UserError('PDF_PASSWORD', 'PDF 有密码保护，无法读取');
      throw new UserError('PDF_PARSE', `PDF 解析失败：${e && e.message ? e.message : e}`);
    }
    const OPS = pdfjs.OPS || {};
    const IMAGE_OPS = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject', 'paintImageXObjectRepeat']
      .map((k) => OPS[k]).filter((v) => typeof v === 'number'));
    // 序号 → 算子名：绘制指令里只有序号，还原矢量公式（见 3c）时要按名字判断
    const OP_NAME = [];
    for (const k of Object.keys(OPS)) if (typeof OPS[k] === 'number') OP_NAME[OPS[k]] = k;
    const nameOf = (i) => OP_NAME[i] || '';

    const holeCache = {};                    // 页码 → findHoles 的结果（pageText 时算好，裁图时直接用）
    return {
      numPages: doc.numPages,
      hash,
      size: bytes.length,
      async pageText(n) {
        const page = await doc.getPage(n);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          const fonts = {};
          let images = 0;
          let holes = [];
          let vecBoxes = 0;
          let boxes = null;
          try {
            // 真正的字体名（判断粗体 / 等宽 / 数学字体）只有在解析过绘制指令后才能从 commonObjs 里取到；
            // 顺带把绘制指令里的矢量图形 bbox 还原出来（公式可能就是它们画的）
            const ops = await page.getOperatorList();
            for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
            for (const id of Object.keys(tc.styles || {})) {
              if (page.commonObjs.has(id)) fonts[id] = classifyFont(page.commonObjs.get(id).name);
            }
            boxes = paintedBoxes(ops, viewport, nameOf);
            vecBoxes = boxes.filter((b) => isGlyphBox(b, 10)).length;      // 整页都是矢量字形 = 矢量页（当扫描页处理）
          } catch (e) { log('读取绘制指令失败（不影响文字提取，但公式可能缺失）：', e && e.message); }
          const spans = spansFromTextContent(tc.items, viewport, fonts);
          const stats = pageTextStats(spans);
          try {
            // 矢量图形画的公式：文字层里只有一个空格，不找出来就会整句缺公式
            if (boxes) holes = findHoles(spans, boxes, { width: viewport.width, height: viewport.height });
          } catch (e) { log('还原矢量公式失败（公式可能会缺失）：', e && e.message); }
          holeCache[n] = holes;
          return { width: viewport.width, height: viewport.height, spans: markHoles(spans, holes, n), chars: stats.chars, bad: stats.bad, garbled: stats.garbled, images, holes, vecBoxes };
        } finally {
          page.cleanup();
        }
      },
      /** 一页的公式 → 一张带编号的竖条拼图（交给视觉模型）。 */
      async holeStrip(n, holes) {
        if (!holes || !holes.length) return null;
        const page = await doc.getPage(n);
        try {
          const v1 = page.getViewport({ scale: 1 });
          const renderPage = async (scale) => {
            const vp = page.getViewport({ scale });
            const canvas = makeCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
            const g = canvas.getContext('2d');
            g.fillStyle = '#fff';
            g.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: g, viewport: vp }).promise;
            return canvas;
          };
          const out = await holeStripCanvas(renderPage, holes, { width: v1.width, height: v1.height });
          if (!out) return null;
          let blob = await canvasToBlob(out.canvas, 'image/png');
          if (blob.size > MAX_RAW_BYTES) blob = await canvasToBlob(out.canvas, 'image/jpeg', 0.92);
          const dataUrl = await blobToDataUrl(blob, blob.type);
          out.canvas.width = 0;
          out.canvas.height = 0;
          return { dataUrl, used: out.used, bytes: blob.size };
        } finally {
          page.cleanup();
        }
      },
      /** 指定的几个公式 → 各自的截图（data URL），识别不出时兜底用。 */
      async holeCrops(n, idxs) {
        if (!idxs || !idxs.length) return [];
        const page = await doc.getPage(n);
        try {
          const v1 = page.getViewport({ scale: 1 });
          const renderPage = async (scale) => {
            const vp = page.getViewport({ scale });
            const canvas = makeCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
            const g = canvas.getContext('2d');
            g.fillStyle = '#fff';
            g.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: g, viewport: vp }).promise;
            return canvas;
          };
          const picked = idxs.map((i) => (holeCache[n] || [])[i]).filter(Boolean);
          const canvases = await holeCropCanvases(renderPage, picked, { width: v1.width, height: v1.height });
          const urls = [];
          for (const c of canvases) {
            const blob = await canvasToBlob(c, 'image/png');
            urls.push(await blobToDataUrl(blob, 'image/png'));
            c.width = 0;
            c.height = 0;
          }
          return urls;
        } finally {
          page.cleanup();
        }
      },
      async pageImage(n) {
        const page = await doc.getPage(n);
        try {
          const v1 = page.getViewport({ scale: 1 });
          const scale = Math.min(RENDER_WIDTH / v1.width, RENDER_MAX_SIDE / Math.max(v1.width, v1.height), 6);
          const vp = page.getViewport({ scale });
          const canvas = makeCanvas(Math.max(1, Math.ceil(vp.width)), Math.max(1, Math.ceil(vp.height)));
          const g = canvas.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: g, viewport: vp }).promise;
          let blob = await canvasToBlob(canvas, 'image/png');
          if (blob.size > MAX_RAW_BYTES) blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
          const dataUrl = await blobToDataUrl(blob, blob.type);
          const out = { dataUrl, width: canvas.width, height: canvas.height, bytes: blob.size };
          canvas.width = 0;
          canvas.height = 0;
          return out;
        } finally {
          page.cleanup();
        }
      },
      destroy() { try { doc.destroy(); } catch (e) { /* 忽略 */ } },
    };
  }

  async function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
    } catch (e) { /* 继续尝试其他方式 */ }
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 继续 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  /** 等元素子树连续 quietMs 毫秒没有变化（最多等 maxMs）。Hydro 的 KaTeX / Prism / 样例排版是异步改 DOM 的。 */
  function waitForStable(el, quietMs, maxMs) {
    return new Promise((resolve) => {
      let quiet = null;
      let cap = null;
      const mo = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, quietMs); });
      function done() { mo.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(); }
      mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
      quiet = setTimeout(done, quietMs);
      cap = setTimeout(done, maxMs);
    });
  }

  function testImage() {
    try {
      const c = makeCanvas(64, 64);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 64, 64);
      return c.toDataURL('image/png');
    } catch (e) {
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    }
  }

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .dock, .card, .form { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    .dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; gap: 6px; align-items: center; }
    button { font: inherit; cursor: pointer; border: 0; border-radius: 999px; padding: 8px 14px; color: #fff; background: #2563eb; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    button:hover { filter: brightness(1.08); }
    button.mini { padding: 8px 10px; color: #374151; background: #fff; }
    button.flat { box-shadow: none; border-radius: 6px; padding: 6px 12px; }
    button.ghost { background: #e5e7eb; color: #111827; }
    .main[data-state="running"] { background: #d97706; }
    .main[data-state="done"] { background: #16a34a; }
    .main[data-state="warn"] { background: #ca8a04; }
    .main[data-state="error"], .main[data-state="needcfg"] { background: #dc2626; }
    .card { position: fixed; right: 16px; bottom: 64px; z-index: 2147483647; width: min(580px, calc(100vw - 32px)); max-height: 72vh;
            display: flex; flex-direction: column; gap: 8px; padding: 12px; background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .card[hidden], .modal[hidden] { display: none; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row.end { align-items: flex-end; }
    .grow { flex: 1; }
    textarea { width: 100%; min-height: 240px; flex: 1; padding: 8px; resize: vertical; color: #111827; background: #fff; border: 1px solid #d1d5db; border-radius: 8px;
               font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .log { max-height: 96px; overflow: auto; white-space: pre-wrap; word-break: break-all; color: #4b5563; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; }
    .log:empty { display: none; }
    .row[hidden], button[hidden] { display: none; }
    .card[data-mode="list"] [data-act="rerun-ai"] { display: none; }
    .card select { min-width: 0; padding: 5px 8px; font: inherit; color: #111827; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; }
    .pickrow { font-size: 12px; color: #4b5563; }
    .modal { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
    .form { width: min(540px, calc(100vw - 32px)); max-height: 92vh; overflow: auto; display: grid; gap: 10px; padding: 16px; color: #111827; background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
    .form label { display: grid; gap: 4px; font-weight: 600; }
    .form small { font-weight: 400; color: #6b7280; }
    .form input[type=text], .form input[type=password], .form input[type=number], .form select, .form textarea { width: 100%; min-height: 0; padding: 7px 9px; font: inherit; color: #111827; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; }
    .form textarea { height: 56px; font-family: ui-monospace, Menlo, Consolas, monospace; resize: vertical; }
    .form label.check { display: flex; gap: 6px; align-items: center; font-weight: 400; }
    .msg { min-height: 1.4em; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .msg.err { color: #b91c1c; }
    .msg.ok { color: #15803d; }
  `;

  const UI_HTML = `
    <style>${UI_CSS}</style>
    <div class="dock">
      <button class="main" id="main" data-act="run" data-state="idle">📋 题面转 Markdown</button>
      <button class="mini" data-act="panel" title="查看结果 / 日志">👀</button>
      <button class="mini" data-act="settings" title="设置">⚙️</button>
    </div>
    <div class="card" id="panel" hidden>
      <div class="row">
        <b class="grow" id="panelTitle">题面 Markdown</b>
        <button class="flat ghost" data-act="stop" id="stopBtn" title="当前这道题处理完就停；已处理的题照常合并复制" hidden>停止</button>
        <button class="flat ghost" data-act="rerun" id="rerunBtn" title="忽略缓存，按当前设置重新识别">重新识别</button>
        <button class="flat ghost" data-act="rerun-ai" title="把每一页渲染成图片交给视觉模型识别（需要先配置 API）">AI 重新识别</button>
        <button class="flat" data-act="copy">复制</button>
        <button class="flat ghost" data-act="close">关闭</button>
      </div>
      <div class="row pickrow" id="pickRow" hidden>
        <span title="一份 PDF 里有多道题时，默认取与本题标题最相似的那一道">PDF 里有多道题，取：</span>
        <select class="grow" id="pickSel"></select>
      </div>
      <div class="log" id="log"></div>
      <textarea id="out" spellcheck="false"></textarea>
    </div>
    <div class="modal" id="modal" hidden>
      <div class="form">
        <b style="font-size:15px">设置</b>
        <label>PDF 识别方式 <small>“自动”：先直接读取 PDF 文字层（不需要 API，几秒出结果）；只有扫描件 / 文字损坏的页，以及“公式被画成矢量图形、文字层里没有”的页才交给视觉模型</small>
          <select id="engine">
            <option value="auto">自动（推荐）</option>
            <option value="text">只读文字层（永远不调用 API）</option>
            <option value="ai">总是用视觉模型（公式更准，需要 API）</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" id="holeimg"> 识别不出的公式改用截图 <small>（题面 PDF 常把公式转成矢量图形，文字层里没有。有 API 时会把这些公式裁成小图交给视觉模型转 LaTeX；没配置 / 识别失败时，勾选这里就插入图片，否则写 [公式]）</small></label>
        <b style="font-size:13px">视觉模型 API <small>可选：只有扫描件，或点“AI 重新识别”时才会用到</small></b>
        <label>快速填充<select id="preset"></select></label>
        <label>接口地址 <small>OpenAI 兼容接口；以 /chat/completions 结尾，或只填到 /v1</small><input type="text" id="apiUrl"></label>
        <label>API Key <small>只保存在脚本管理器本地，只会发给上面的接口地址</small><input type="password" id="apiKey" autocomplete="off"></label>
        <label>模型名 <small>必须是支持图片输入的模型</small><input type="text" id="model"></label>
        <label>额外请求参数（可选，JSON 对象） <small>会合并进请求体，如关闭思考、调大 max_tokens</small><textarea id="extra" spellcheck="false"></textarea></label>
        <div class="row end">
          <label class="grow">并发数 <small>同时识别几页（免费额度常限制为 1）</small><input type="number" id="concurrency" min="1" max="6"></label>
          <label class="check"><input type="checkbox" id="auto"> 打开题目页时自动识别并复制</label>
        </div>
        <label class="check"><input type="checkbox" id="pickon"> PDF 里有多道题时，只取与本题标题最相似的那一道 <small>（取消勾选则复制整份 PDF；面板里仍可手动改选）</small></label>
        <b style="font-size:13px">题单（训练）页 <small>在题单页一次复制里面所有题目的题面</small></b>
        <label class="check"><input type="checkbox" id="listauto"> 打开题单页时自动复制全部题面 <small>（题数不超过 50；自动开始只读 PDF 文字层，不调用视觉模型；取消勾选则只在点按钮时才复制）</small></label>
        <label>每题之间的间隔（毫秒） <small>相邻两道题的请求之间等多久。默认 500；0 = 不等待；最大 10000</small><input type="number" id="listgap" min="0" max="10000" step="100"></label>
        <label class="check"><input type="checkbox" id="listeach"> 逐题写入剪贴板 <small>（每转换完一道题先复制一次，最后再复制整份；给剪贴板历史工具用）</small></label>
        <div class="msg" id="msg"></div>
        <div class="row">
          <button class="flat ghost" data-act="test">测试连接</button>
          <span class="grow"></span>
          <button class="flat ghost" data-act="cancel">取消</button>
          <button class="flat" data-act="save">保存</button>
        </div>
      </div>
    </div>
  `;

  /** 右下角悬浮按钮 + 结果面板 + 设置对话框。放在 Shadow DOM 里，避免被站点样式影响。 */
  function createUI(h) {
    const host = document.createElement('div');
    host.id = 'goj2md-host';
    const open = typeof window !== 'undefined' && window.__GOJ2MD_OPEN_SHADOW__;     // 仅测试时置位
    const root = host.attachShadow({ mode: open ? 'open' : 'closed' });
    root.innerHTML = UI_HTML;
    document.documentElement.appendChild(host);

    // Hydro 在 document 上监听 keydown 触发全局快捷键，且不会忽略输入框；Shadow DOM 会把事件目标改成宿主元素，
    // 所以在设置框里输入时必须在 Shadow 根上拦下，不让它冒泡到页面。
    ['keydown', 'keyup', 'keypress'].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));

    const $ = (id) => root.getElementById(id);
    const main = $('main');
    const logEl = $('log');
    const out = $('out');
    const msg = $('msg');
    const fields = {
      engine: $('engine'), apiUrl: $('apiUrl'), apiKey: $('apiKey'), model: $('model'), extra: $('extra'), concurrency: $('concurrency'), auto: $('auto'), pick: $('pickon'), holeImg: $('holeimg'),
      listAuto: $('listauto'), listGap: $('listgap'), listEach: $('listeach'),
    };
    $('panel').dataset.mode = h.mode || 'problem';
    if (h.mode === 'list') {
      $('panelTitle').textContent = '题单 Markdown';
      $('rerunBtn').textContent = '重新复制';
      $('rerunBtn').title = '重新取回题单里的每道题并复制';
    }
    fields.apiUrl.placeholder = 'https://.../v1/chat/completions';
    fields.apiKey.placeholder = 'sk-...';
    fields.model.placeholder = '例如 glm-4.6v-flash（必须是支持图片输入的模型）';
    fields.extra.placeholder = '例如 {"thinking":{"type":"disabled"}}';
    $('preset').innerHTML = '<option value="">— 选择服务商 —</option>';
    PRESETS.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      $('preset').appendChild(o);
    });

    const setMsg = (text, kind) => { msg.textContent = text || ''; msg.className = `msg${kind ? ` ${kind}` : ''}`; };
    const readForm = () => ({
      engine: fields.engine.value,
      apiUrl: fields.apiUrl.value.trim(),
      apiKey: fields.apiKey.value.trim(),
      model: fields.model.value.trim(),
      extraBody: fields.extra.value.trim(),
      concurrency: Math.max(1, Math.min(6, parseInt(fields.concurrency.value, 10) || 1)),
      auto: fields.auto.checked,
      pick: fields.pick.checked,
      holeImages: fields.holeImg.checked,
      listAuto: fields.listAuto.checked,
      listGap: Number.isNaN(parseInt(fields.listGap.value, 10)) ? LIST_GAP_MS : Math.max(0, Math.min(LIST_GAP_MAX, parseInt(fields.listGap.value, 10))),
      listEach: fields.listEach.checked,
    });
    const openPanel = () => { $('panel').hidden = false; };
    const openSettings = () => {
      const c = h.getConfig();
      fields.engine.value = ENGINES.includes(c.engine) ? c.engine : 'auto';
      fields.apiUrl.value = c.apiUrl;
      fields.apiKey.value = c.apiKey;
      fields.model.value = c.model;
      fields.extra.value = c.extraBody;
      fields.concurrency.value = c.concurrency;
      fields.auto.checked = !!c.auto;
      fields.pick.checked = c.pick !== false;
      fields.holeImg.checked = c.holeImages !== false;
      fields.listAuto.checked = c.listAuto !== false;
      fields.listGap.value = listGapOf(c);
      fields.listEach.checked = !!c.listEach;
      $('preset').value = '';
      setMsg('');
      $('modal').hidden = false;
    };

    $('preset').addEventListener('change', (e) => {
      const p = PRESETS.find((x) => x.id === e.target.value);
      if (!p || p.id === 'custom') return;
      fields.apiUrl.value = p.apiUrl;
      if (p.model) fields.model.value = p.model;
      fields.extra.value = p.extraBody;
    });

    $('pickSel').addEventListener('change', (e) => h.repick(e.target.value));

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest && e.target.closest('[data-act]');
      if (!btn) return;
      switch (btn.dataset.act) {
        case 'run': if (main.dataset.state === 'needcfg') openSettings(); else h.run({}); break;
        case 'rerun': h.run({ force: true }); break;
        case 'stop': h.stop(); break;
        case 'rerun-ai': h.run({ force: true, engine: 'ai' }); break;
        case 'panel': openPanel(); break;
        case 'close': $('panel').hidden = true; break;
        case 'copy': {
          const ok = await h.copy(out.value);
          setCopyLabel(btn, ok);
          break;
        }
        case 'settings': openSettings(); break;
        case 'cancel': $('modal').hidden = true; break;
        case 'save': {
          const cfg = readForm();
          // API 是可选的：什么都没填可以直接保存；填了一部分、或者选了“总是用视觉模型”，就必须填完整
          const touched = cfg.apiUrl || cfg.apiKey || cfg.model || cfg.extraBody;
          const bad = touched || cfg.engine === 'ai' ? configProblems(cfg) : [];
          if (bad.length) { setMsg(`还没填好：${bad.join('、')}`, 'err'); break; }
          h.saveConfig(cfg);
          $('modal').hidden = true;
          h.onSaved();
          break;
        }
        case 'test': {
          setMsg('正在连接……');
          try { setMsg(`连接成功。模型回复：${await h.test(readForm())}`, 'ok'); } catch (err) { setMsg(err.message, 'err'); }
          break;
        }
        default:
      }
    });

    function setCopyLabel(btn, ok) {
      const old = btn.textContent;
      btn.textContent = ok ? '已复制 ✅' : '复制失败';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }

    return {
      state(name, label, title) { main.dataset.state = name; main.textContent = label; main.title = title || ''; },
      stateName: () => main.dataset.state,
      log(line) { logEl.textContent += `${logEl.textContent ? '\n' : ''}${line}`; logEl.scrollTop = logEl.scrollHeight; },
      clearLog() { logEl.textContent = ''; },
      /** 题单复制进行中：显示面板里的“停止”按钮。 */
      busy(on) { $('stopBtn').hidden = !on; },
      result(md) { out.value = md; },
      /** 面板里“PDF 里有多道题，取：”的下拉框。options = [{ value, label }]；传 null 隐藏。 */
      picks(options, selected) {
        const sel = $('pickSel');
        sel.textContent = '';
        for (const o of options || []) {
          const el = document.createElement('option');
          el.value = o.value;
          el.textContent = o.label;
          sel.appendChild(el);
        }
        sel.value = selected == null ? '' : String(selected);
        $('pickRow').hidden = !(options && options.length);
      },
      openPanel,
      openSettings,
    };
  }

  function boot() {
    const isList = LIST_ROUTE_RE.test(location.pathname);        // 题单（训练）页：一次复制里面所有题目的题面
    if (!isList && !ROUTE_RE.test(location.pathname)) return;
    if (document.getElementById('goj2md-host')) return;          // 装了两份脚本时只启用先加载的那份
    log(`v${VERSION} 已加载：${location.pathname}`);

    const storage = { get: (k, d) => GM_getValue(k, d), set: (k, v) => GM_setValue(k, v) };
    try { if (storage.get(OLD_CACHE_KEY, null)) storage.set(OLD_CACHE_KEY, {}); } catch (e) { /* 旧版本的图片转写缓存，清掉即可 */ }
    if (!getPdfjs()) log('警告：没有加载到 pdf.js（脚本头部的 @require 失败），识别 PDF 时会报错');
    let ui = null;
    const uiBridge = {
      state: (...a) => ui && ui.state(...a),
      log: (...a) => { log(...a); if (ui) ui.log(...a); },
      result: (...a) => ui && ui.result(...a),
      picks: (...a) => ui && ui.picks(...a),
    };
    const runner = createRunner({
      doc: document,
      loc: location,
      storage,
      http: gmHttp,
      sleep,
      copy: copyText,
      ui: uiBridge,
      loadPdf,
      fetchDoc: fetchProblemDoc,
      testImage,
    });

    const listCount = () => collectProblemLinks(document, location).length;
    const listLabel = (n) => `📚 复制题单全部题面（${n} 题）`;
    const listTip = () => `依次打开题单里的每道题，转成 Markdown 后合并复制；相邻两题间隔 ${listGapOf(loadConfig(storage))} 毫秒`;

    async function trigger(opts) {
      if (runner.isBusy()) {                                       // 正在转写：别清日志，手动点击时展开面板让用户看进度
        if (!(opts && opts.auto)) ui.openPanel();
        return;
      }
      ui.clearLog();
      if (isList) ui.busy(true);
      try {
        await (isList ? runner.runList(opts) : runner.run(opts));
      } catch (e) {
        log('失败：', e);
        if (e.code === 'NO_CONFIG') {
          ui.state('needcfg', '🔑 先配置视觉模型 API', `${e.message}。点击这里打开设置`);
          ui.log(e.message);
          if (!(opts && opts.auto)) ui.openSettings();
        } else {
          ui.state('error', '❌ 失败，点击重试', e.message);
          ui.log(e.message);
          ui.openPanel();
        }
      } finally {
        if (isList) ui.busy(false);
      }
    }

    ui = createUI({
      mode: isList ? 'list' : 'problem',
      stop: () => { if (!runner.cancel()) ui.log('现在没有正在复制的题单'); },
      getConfig: () => loadConfig(storage),
      saveConfig: (cfg) => storage.set(CFG_KEY, cfg),
      copy: copyText,
      run: trigger,
      repick: async (v) => {
        try {
          await runner.repick(v);
        } catch (e) {
          log('失败：', e);
          ui.state('error', '❌ 失败，点击重试', e.message);
          ui.log(e.message);
        }
      },
      test: (cfg) => runner.testConnection(cfg),
      onSaved: () => {
        if (isList) {                                                // 题单页：间隔改了，按钮上的提示跟着变；不会因为改设置就重新跑一遍整个题单
          if (ui.stateName() === 'idle' && listCount()) ui.state('idle', listLabel(listCount()), listTip());
        } else if (['needcfg', 'error'].includes(ui.stateName())) trigger({});     // 配置好 / 改好 Key 之后立刻重试
      },
    });
    if (isList) ui.state('idle', '📚 复制题单全部题面', '正在找题单里的题目……');
    else ui.state('idle', '📋 题面转 Markdown', '识别题面里的 PDF 并复制 Markdown');

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⚙️ 设置', () => ui.openSettings());
      if (isList) {
        GM_registerMenuCommand('📚 复制题单全部题面', () => trigger({}));
      } else {
        GM_registerMenuCommand('📋 识别并复制本题', () => trigger({}));
        GM_registerMenuCommand('🔁 用视觉模型重新识别', () => trigger({ force: true, engine: 'ai' }));
      }
      GM_registerMenuCommand('🧹 清除识别缓存', () => { storage.set(CACHE_KEY, {}); ui.log('已清除识别缓存'); });
    }

    if (isList) {
      // 等题单里的题目出现 → 再等页面“静止”（前端脚本处理完）→ 按设置自动开始。
      let listTries = 0;
      const listTimer = setInterval(() => {
        const n = listCount();
        if (n) {
          clearInterval(listTimer);
          ui.state('idle', listLabel(n), listTip());
          const root = document.querySelector('[data-fragment-id="training_detail"]') || document.body;
          waitForStable(root, 400, 5000).then(() => {
            if (runner.isBusy()) return;
            const total = listCount();
            ui.state('idle', listLabel(total), listTip());
            if (loadConfig(storage).listAuto) trigger({ auto: true });
          });
        } else if (++listTries > 50) {
          clearInterval(listTimer);
          ui.state('error', '❌ 没找到题目链接', '页面结构可能和 Hydro 默认模板不同');
        }
      }, 300);
      return;
    }

    // 等题面出现 → 再等它“静止”（前端脚本处理完）→ 自动转写。
    // PJAX 切换题面语言会把题面节点整块替换掉，替换后同样处理一次。
    let lastRoot = null;
    const schedule = async (root) => {
      lastRoot = root;
      await waitForStable(root, 400, 5000);
      if (findStatementRoot(document) !== root) return;          // 等待期间又被替换了：交给下一次 schedule
      if (loadConfig(storage).auto) trigger({ auto: true });
    };
    let tries = 0;
    const timer = setInterval(() => {
      const root = findStatementRoot(document);
      if (root) {
        clearInterval(timer);
        schedule(root);
        let debounce = 0;
        new MutationObserver(() => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            const r = findStatementRoot(document);
            if (r && r !== lastRoot) schedule(r);
          }, 300);
        }).observe(document.body, { childList: true, subtree: true });
      } else if (++tries > 50) {
        clearInterval(timer);
        ui.state('error', '❌ 没找到题面区域', '页面结构可能和 Hydro 默认模板不同');
      }
    }, 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
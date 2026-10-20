# -*- coding: utf-8 -*-
"""
一次性修复：上传的 插件.js 是被工具“另存为 GBK”过的版本，凡是 GBK 编不出来的字符
（emoji、大量数学符号）都被替换成了 ASCII '?'，其中 `?PDF:n?` 占位符还直接让脚本语法报错。
这里把能确定原意的字符按上下文还原（并把占位符换成 ASCII 的 %%PDF:n%%）。

跑法：python3 tools/reconstruct_gbk_damage.py
"""
import re
import sys

PATH = 'goj-pdf-to-markdown.user.js'
src = open(PATH, encoding='utf-8').read()

R = []          # (旧, 新, 说明)


def rep(old, new, why, count=1):
    R.append((old, new, why, count))


# ---------------------------------------------------------------- 占位符
rep('先用占位符 ?PDF:n? 占位；', '先用占位符 %%PDF:n%% 占位；', '文档注释里的占位符')
rep('（PDF 先用 ?PDF:n? 占位）', '（PDF 先用 %%PDF:n%% 占位）', '工作流程注释')
rep('含 ?PDF:n? 占位符', '含 %%PDF:n%% 占位符', 'extract 的文档注释', 2)
rep('return `\\n\\n?PDF:${idx}?\\n\\n`;', 'return `\\n\\n%%PDF:${idx}%%\\n\\n`;', 'pdfToken')
rep('markdown.replace(/?PDF:(\\d+)?/g,', 'markdown.replace(/%%PDF:(\\d+)/g,', 'assemble 里的替换')
rep('markdown += pdfs.map((_, i) => `\\n\\n?PDF:${i}?`).join(\'\');',
    'markdown += pdfs.map((_, i) => `\\n\\n%%PDF:${i}%%`).join(\'\');', 'run() 里直接嵌 PDF 的兜底')

# ---------------------------------------------------------------- 数学符号表
rep("""    '≤': '\\\\le', '?': '\\\\le', '≥': '\\\\ge', '?': '\\\\ge', '≠': '\\\\ne', '≈': '\\\\approx', '≡': '\\\\equiv', '～': '\\\\sim', '?': '\\\\ll', '?': '\\\\gg',
    '?': '\\\\cong', '?': '\\\\simeq', '∝': '\\\\propto', '×': '\\\\times', '÷': '\\\\div', '±': '\\\\pm', '?': '\\\\mp', '·': '\\\\cdot', '?': '\\\\cdot', '?': '\\\\cdot',
    '°': '\\\\circ', '?': '\\\\star', '∑': '\\\\sum', '∏': '\\\\prod', '∫': '\\\\int', '∮': '\\\\oint', '?': '\\\\bigcup', '?': '\\\\bigcap',
    '∞': '\\\\infty', '?': '\\\\partial', '?': '\\\\nabla', '?': '\\\\emptyset', '?': '\\\\forall', '?': '\\\\exists',
    '∈': '\\\\in', '?': '\\\\notin', '?': '\\\\ni', '?': '\\\\subset', '?': '\\\\supset', '?': '\\\\subseteq', '?': '\\\\supseteq',
    '∪': '\\\\cup', '∩': '\\\\cap', '∧': '\\\\land', '∨': '\\\\lor', '?': '\\\\lnot', '⊕': '\\\\oplus', '?': '\\\\otimes', '⊙': '\\\\odot',
    '⊥': '\\\\perp', '∥': '\\\\parallel', '∠': '\\\\angle', '∣': '\\\\mid', '?': '\\\\nmid', '∴': '\\\\therefore', '∵': '\\\\because',
    '→': '\\\\to', '←': '\\\\leftarrow', '?': '\\\\leftrightarrow', '?': '\\\\Rightarrow', '?': '\\\\Leftarrow', '?': '\\\\Leftrightarrow', '?': '\\\\mapsto',
    '…': '\\\\dots', '?': '\\\\cdots', '?': '\\\\vdots', '?': '\\\\ddots', '′': "'", '″': "''", '°': '^{\\\\circ}',
    '?': '-', '‐': '-', '?': '-', '–': '-', '—': '-', '’': "'", '‘': '`',
    '?': '\\\\lfloor ', '?': '\\\\rfloor ', '?': '\\\\lceil ', '?': '\\\\rceil ', '?': '\\\\langle ', '?': '\\\\rangle ', '〈': '\\\\langle ', '〉': '\\\\rangle ',
    '?': '\\\\ell', '?': '\\\\mathbb{N}', '?': '\\\\mathbb{Z}', '?': '\\\\mathbb{Q}', '?': '\\\\mathbb{R}', '?': '\\\\mathbb{C}', '?': '\\\\mathbb{P}',
    'α': '\\\\alpha', 'β': '\\\\beta', 'γ': '\\\\gamma', 'δ': '\\\\delta', 'ε': '\\\\varepsilon', '?': '\\\\epsilon', 'ζ': '\\\\zeta', 'η': '\\\\eta', 'θ': '\\\\theta', '?': '\\\\vartheta',
    'ι': '\\\\iota', 'κ': '\\\\kappa', 'λ': '\\\\lambda', 'μ': '\\\\mu', 'ν': '\\\\nu', 'ξ': '\\\\xi', 'π': '\\\\pi', '?': '\\\\varpi', 'ρ': '\\\\rho', '?': '\\\\varrho',
    'σ': '\\\\sigma', '?': '\\\\varsigma', 'τ': '\\\\tau', 'υ': '\\\\upsilon', 'φ': '\\\\varphi', '?': '\\\\phi', 'χ': '\\\\chi', 'ψ': '\\\\psi', 'ω': '\\\\omega',
    'Γ': '\\\\Gamma', 'Δ': '\\\\Delta', '?': '\\\\Delta', 'Θ': '\\\\Theta', 'Λ': '\\\\Lambda', 'Ξ': '\\\\Xi', 'Π': '\\\\Pi', 'Σ': '\\\\Sigma', 'Φ': '\\\\Phi', 'Ψ': '\\\\Psi', 'Ω': '\\\\Omega',""",
    """    '≤': '\\\\le', '≦': '\\\\le', '⩽': '\\\\le', '≥': '\\\\ge', '≧': '\\\\ge', '⩾': '\\\\ge', '≠': '\\\\ne', '≈': '\\\\approx', '≡': '\\\\equiv', '～': '\\\\sim', '≪': '\\\\ll', '≫': '\\\\gg',
    '≅': '\\\\cong', '≃': '\\\\simeq', '∝': '\\\\propto', '×': '\\\\times', '÷': '\\\\div', '±': '\\\\pm', '∓': '\\\\mp', '·': '\\\\cdot', '⋅': '\\\\cdot', '∙': '\\\\cdot',
    '°': '\\\\circ', '⋆': '\\\\star', '∑': '\\\\sum', '∏': '\\\\prod', '∫': '\\\\int', '∮': '\\\\oint', '⋃': '\\\\bigcup', '⋂': '\\\\bigcap',
    '∞': '\\\\infty', '∂': '\\\\partial', '∇': '\\\\nabla', '∅': '\\\\emptyset', '∀': '\\\\forall', '∃': '\\\\exists',
    '∈': '\\\\in', '∉': '\\\\notin', '∋': '\\\\ni', '⊂': '\\\\subset', '⊃': '\\\\supset', '⊆': '\\\\subseteq', '⊇': '\\\\supseteq',
    '⊄': '\\\\not\\\\subset', '⊈': '\\\\not\\\\subseteq', '≮': '\\\\not<', '≯': '\\\\not>', '≰': '\\\\nleq', '≱': '\\\\ngeq',
    '∪': '\\\\cup', '∩': '\\\\cap', '∧': '\\\\land', '∨': '\\\\lor', '¬': '\\\\lnot', '⊕': '\\\\oplus', '⊗': '\\\\otimes', '⊙': '\\\\odot',
    '⊥': '\\\\perp', '∥': '\\\\parallel', '∠': '\\\\angle', '∣': '\\\\mid', '∤': '\\\\nmid', '∴': '\\\\therefore', '∵': '\\\\because',
    '→': '\\\\to', '←': '\\\\leftarrow', '↔': '\\\\leftrightarrow', '⇒': '\\\\Rightarrow', '⇐': '\\\\Leftarrow', '⇔': '\\\\Leftrightarrow', '↦': '\\\\mapsto',
    '…': '\\\\dots', '⋯': '\\\\cdots', '⋮': '\\\\vdots', '⋱': '\\\\ddots', '′': "'", '″': "''", '˚': '^{\\\\circ}',
    '−': '-', '‐': '-', '‒': '-', '–': '-', '—': '-', '’': "'", '‘': '`',
    '⌊': '\\\\lfloor ', '⌋': '\\\\rfloor ', '⌈': '\\\\lceil ', '⌉': '\\\\rceil ', '⟨': '\\\\langle ', '⟩': '\\\\rangle ', '〈': '\\\\langle ', '〉': '\\\\rangle ',
    'ℓ': '\\\\ell', 'ℕ': '\\\\mathbb{N}', 'ℤ': '\\\\mathbb{Z}', 'ℚ': '\\\\mathbb{Q}', 'ℝ': '\\\\mathbb{R}', 'ℂ': '\\\\mathbb{C}', 'ℙ': '\\\\mathbb{P}',
    'α': '\\\\alpha', 'β': '\\\\beta', 'γ': '\\\\gamma', 'δ': '\\\\delta', 'ε': '\\\\varepsilon', 'ϵ': '\\\\epsilon', 'ζ': '\\\\zeta', 'η': '\\\\eta', 'θ': '\\\\theta', 'ϑ': '\\\\vartheta',
    'ι': '\\\\iota', 'κ': '\\\\kappa', 'λ': '\\\\lambda', 'μ': '\\\\mu', 'ν': '\\\\nu', 'ξ': '\\\\xi', 'π': '\\\\pi', 'ϖ': '\\\\varpi', 'ρ': '\\\\rho', 'ϱ': '\\\\varrho',
    'σ': '\\\\sigma', 'ς': '\\\\varsigma', 'τ': '\\\\tau', 'υ': '\\\\upsilon', 'φ': '\\\\varphi', 'ϕ': '\\\\phi', 'χ': '\\\\chi', 'ψ': '\\\\psi', 'ω': '\\\\omega',
    'Γ': '\\\\Gamma', 'Δ': '\\\\Delta', '∆': '\\\\Delta', 'Θ': '\\\\Theta', 'Λ': '\\\\Lambda', 'Ξ': '\\\\Xi', 'Π': '\\\\Pi', 'Σ': '\\\\Sigma', 'Φ': '\\\\Phi', 'Ψ': '\\\\Psi', 'Ω': '\\\\Omega',""",
    'SYMBOLS 表里所有被 GBK 吃掉的键')

# 触发字符 / 单字符正则：按 SYMBOLS 自动生成，顺便修掉 '-' 会把字符类变成区间的问题
rep("""  const MATH_TRIGGER_RE = /[≤≥≠≈≡～????∝×÷±???°?∑∏∫∮??∞?????∈??????∪∩∧∨?⊕?⊙⊥∥∠∣?∴∵→←????????√??????〈〉′″?????????αβγδε?ζηθ?ικλμνξπ?ρ?σ?τυφ?χψωΓΔ?ΘΛΞΠΣΦΨΩ]/;
  const SYMBOL_RE = new RegExp(`[${Object.keys(SYMBOLS).join('')}]`, 'g');""",
    """  // 正文里也常见的符号不算“数学内容”（? 表示这里本来有一串符号，见 tools/reconstruct_gbk_damage.py）
  const PROSE_SYMBOLS = new Set(['…', '·', '⋅', '∙', '°', '˚', '′', '″', '-', '−', '‐', '‒', '–', '—', '’', '‘']);
  /** 放进正则字符类里前先转义（否则 '-' 会被当成区间） */
  const inClass = (c) => c.replace(/[\\\\\\]^-]/g, '\\\\$&');
  const SYMBOL_KEYS = Object.keys(SYMBOLS);
  const MATH_TRIGGER_RE = new RegExp(`[${SYMBOL_KEYS.filter((c) => !PROSE_SYMBOLS.has(c)).map(inClass).join('')}\\\\u221a\\\\u2206]`);
  const SYMBOL_RE = new RegExp(`[${SYMBOL_KEYS.map(inClass).join('')}]`, 'g');""",
    'MATH_TRIGGER_RE / SYMBOL_RE')

rep(".replace(/[\\uf0b7\\uf0a7\\uf076]/g, '?')", ".replace(/[\\uf0b7\\uf0a7\\uf076]/g, '•')", '私用区圆点还原成 •')
rep(".replace(/\\u2206/g, '?');                              // 增量号统一成 U+2206，下面当 \\Delta 处理",
    ".replace(/\\u2206/g, '\\u0394');                          // 增量号 ∆（U+2206）统一成 Δ，下面按 \\Delta 处理",
    '∆ → Δ')
rep("const BULLET_CHARS = '?●?■?○◆◇????';",
    "const BULLET_CHARS = '•●▪■◦○◆◇‣⁃□';",
    '项目符号表')
rep('return /^[.·?˙]$/.test(sp.str.trim())', 'return /^[.·•˙‧]$/.test(sp.str.trim())', '着重号字符')
rep("""        if (negate && text) { text = text.replace(/^=/, '≠').replace(/^∈/, '?').replace(/^?/, '?'); negate = false; }""",
    """        if (negate && text) {                                                    // \\not 的斜线 + 关系符 → 合体的“否定”符号
          text = text.replace(/^=/, '≠').replace(/^∈/, '∉').replace(/^[<>≤≥∣⊂⊆]/, (c) => ({ '<': '≮', '>': '≯', '≤': '≰', '≥': '≱', '∣': '∤', '⊂': '⊄', '⊆': '⊈' }[c]));
          negate = false;
        }""",
    '否定关系符')
rep('const ENUM_RE = /^(?:\\d{1,2}[.、](?!\\d)|[（(]\\d{1,2}[)）]|[①-?])/;',
    'const ENUM_RE = /^(?:\\d{1,2}[.、](?!\\d)|[（(]\\d{1,2}[)）]|[①-⑳])/;',
    '带圈数字区间')
rep('/** 行首的项目符号（? ● – - 等）：从片段里拿掉，记下来。 */',
    '/** 行首的项目符号（• ● – - 等）：从片段里拿掉，记下来。 */', '注释')

# ---------------------------------------------------------------- 界面文案 / 提示里的 emoji
rep("const TRUNCATED_NOTE = '<!-- ? 模型输出被截断", "const TRUNCATED_NOTE = '<!-- ⚠️ 模型输出被截断", 'TRUNCATED_NOTE')
rep('return `> ?? 这个 PDF 识别失败：', 'return `> ⚠️ 这个 PDF 识别失败：', 'failureNote')
rep('> ?? 这道题没有取到：', '> ⚠️ 这道题没有取到：', 'failedBlock')
rep('/** 末尾的提示块：每条一行 `> ?? …`。 */', '/** 末尾的提示块：每条一行 `> ⚠️ …`。 */', 'notesBlock 注释')
rep('notes.map((t) => `> ?? ${t}`)', 'notes.map((t) => `> ⚠️ ${t}`)', 'notesBlock')
rep("ui.state('running', `? ${cancelled", "ui.state('running', `⏳ ${cancelled", 'busy 前缀')
rep("ui.state('running', '? 正在停止（等当前这道题处理完）')", "ui.state('running', '⏳ 正在停止（等当前这道题处理完）')", '停止提示')
rep('可以在 ?? 面板的下拉框里换成别的题。', '可以在 👀 面板的下拉框里换成别的题。', '分题提示 1')
rep('可以在 ?? 面板的下拉框里选其中一道。', '可以在 👀 面板的下拉框里选其中一道。', '分题提示 2')
rep("ui.state('warn', '?? 复制失败，点 ?? 手动复制', '浏览器拒绝写入剪贴板：请点右侧 ?? 打开面板，手动复制文本框里的内容');",
    "ui.state('warn', '⚠️ 复制失败，点 👀 手动复制', '浏览器拒绝写入剪贴板：请点右侧 👀 打开面板，手动复制文本框里的内容');",
    '复制失败提示', 2)
rep("`${warn ? '??' : '?'} 已复制", "`${warn ? '⚠️' : '✅'} 已复制", '单题完成状态')
rep("ui.state('idle', '?? 复制题面 Markdown');", "ui.state('idle', '📋 复制题面 Markdown');", '空闲状态')
rep("ui.state('idle', '?? PDF 需要模型识别，点击开始'", "ui.state('idle', '🔑 PDF 需要模型识别，点击开始'", '需要模型')
rep("ui.log(`  ? ${item.md.length} 字", "ui.log(`  ✅ ${item.md.length} 字", '题单单题成功日志')
rep('ui.log(`  ? ${e.message}`);', 'ui.log(`  ❌ ${e.message}`);', '题单单题失败日志')
rep("ui.state('idle', `?? 题单有 ${total} 题，点击开始复制`", "ui.state('idle', `📚 题单有 ${total} 题，点击开始复制`", '题单空闲状态')
rep("`${bad ? '??' : '?'} ${stopped ? '已停止，' : ''}已复制", "`${bad ? '⚠️' : '✅'} ${stopped ? '已停止，' : ''}已复制", '题单完成状态')
rep('title="查看结果 / 日志">??</button>', 'title="查看结果 / 日志">👀</button>', '面板按钮')
rep('title="设置">?</button>', 'title="设置">⚙️</button>', '设置按钮')
rep("btn.textContent = ok ? '已复制 ?' : '复制失败';", "btn.textContent = ok ? '已复制 ✅' : '复制失败';", '面板复制按钮')
rep('const listLabel = (n) => `?? 复制题单全部题面（${n} 题）`;', 'const listLabel = (n) => `📚 复制题单全部题面（${n} 题）`;', '题单标签')
rep("ui.state('needcfg', '?? 先配置视觉模型 API'", "ui.state('needcfg', '🔑 先配置视觉模型 API'", '需要配置')
rep("ui.state('error', '?? 失败，点击重试', e.message);", "ui.state('error', '❌ 失败，点击重试', e.message);", '失败状态', 2)
rep("if (isList) ui.state('idle', '?? 复制题单全部题面'", "if (isList) ui.state('idle', '📚 复制题单全部题面'", '题单初始状态')
rep("else ui.state('idle', '?? 题面转 Markdown'", "else ui.state('idle', '📋 题面转 Markdown'", '单题初始状态')
rep("GM_registerMenuCommand('? 设置'", "GM_registerMenuCommand('⚙️ 设置'", '菜单：设置')
rep("GM_registerMenuCommand('?? 复制题单全部题面'", "GM_registerMenuCommand('📚 复制题单全部题面'", '菜单：题单')
rep("GM_registerMenuCommand('?? 识别并复制本题'", "GM_registerMenuCommand('📋 识别并复制本题'", '菜单：单题')
rep("GM_registerMenuCommand('?? 用视觉模型重新识别'", "GM_registerMenuCommand('🔁 用视觉模型重新识别'", '菜单：重识别')
rep("GM_registerMenuCommand('?? 清除识别缓存'", "GM_registerMenuCommand('🧹 清除识别缓存'", '菜单：清缓存')
rep("ui.state('error', '?? 没找到题目链接'", "ui.state('error', '❌ 没找到题目链接'", '找不到题单')
rep("ui.state('error', '?? 没找到题面区域'", "ui.state('error', '❌ 没找到题面区域'", '找不到题面')
rep('>?? 题面转 Markdown</button>', '>📋 题面转 Markdown</button>', '主按钮')
rep('`  ? ${item.md.length} 字', '`  ✅ ${item.md.length} 字', '（备用写法）', 0)

# ---------------------------------------------------------------- 应用
miss = []
for old, new, why, count in R:
    if count == 0:
        continue
    n = src.count(old)
    if n < count:
        miss.append((why, old[:60], n, count))
        continue
    src = src.replace(old, new, count)
if miss:
    print('以下替换没找到（请检查）：')
    for why, old, n, want in miss:
        print(f'  - {why}: 找到 {n} 处，需要 {want}；片段：{old!r}')
    sys.exit(1)

open(PATH, 'w', encoding='utf-8', newline='\n').write(src)
left = len(re.findall(r'\?', src))
print(f'已写回 {PATH}（{left} 个 "?" 剩余，注意这里包含正常的 JS 语法 ? ）')

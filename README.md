# GOJ 题面 PDF 转 Markdown（`goj-pdf-to-markdown.user.js`）

goj.wiki（Hydro）题目页上的用户脚本：把题面里嵌着的 PDF 认出来，转成 Markdown（公式是 LaTeX）并复制到剪贴板。
题单（训练）页可以一次性复制里面所有题目的题面。

- 脚本本体：[`goj-pdf-to-markdown.user.js`](goj-pdf-to-markdown.user.js)（直接装进 Tampermonkey / Violentmonkey）
- 纯函数测试环境：`npm install` 后 `npm test`（Node + pdf.js，跑的是脚本里的同一份代码）
- 转换结果长什么样：[`docs/示例-2085-葫芦娃救爷爷.md`](docs/示例-2085-葫芦娃救爷爷.md)（28 处公式全部是 LaTeX，可以直接粘）

## v2.5.0 修了什么

### 1. PDF 里的公式被“打印”成矢量图形时，整句缺公式

有些题面 PDF 是从网页 / Word 打印出来的，公式不是文字，而是**矢量轮廓**（曲线填色）。
文字层里这些公式只剩下一个空格，于是转出来是：

```
有 个葫芦娃，第 个葫芦娃的战斗力是 ，在第 天早上出生。
```

（原来会多一个空格，看起来“扫不出 KaTeX”；其实 PDF 里确实没有这些字符，不是解析器坏了。）

现在脚本会把 PDF 的绘制指令还原成“图形 bbox”，和文字行的空隙对起来（见脚本里的 3c 一节）：

- 落在文字行空隙里、大小又和字号相当的封闭图形 → 认定这里有一个公式，插入占位符；
- 独占一行、上下都是文字行的图形簇 → 同样认定是公式；
- 背景块、表格线、插图、页面边框都会因为“太大 / 太细”被排除；
- 独占一行的大公式（分数、求和那种，上下都是文字行）同样认得出；
- 公式真文字（文字层里有 `≤`、`n`、`10^5`）的 PDF 一处都不会误报（`tools/fixtures/plain-text-math.pdf` 就是这条的回归用例）。

补全方式（按设置里的“PDF 识别方式”）：

| 情况 | 结果 |
| --- | --- |
| 自动 / AI + 配了视觉模型 API | 把一页里的公式裁成一张带编号的竖条拼图，**一次请求**转成 LaTeX，逐处填回原位 |
| 只读文字层 / 没配 API | 公式换成该处的截图（`![公式](data:image/png;base64,…)`），信息不丢；可在设置里关成 `[公式]` 占位 |
| 模型没认出来的某一处 | 同样退回截图 / `[公式]`，并在末尾提示块里说明补了多少、剩多少 |

一次请求只补一小块图，比把整页渲染给模型便宜得多；“只补公式”的页数也算进自动模式的页数上限，
超过上限（12 页）不会自动烧 API，而是等用户手动点。

### 2. 上传的文件本身被“另存为 GBK”毁过

仓库里这份脚本能正常跑：`插件.js` 被某个工具用 GBK 保存过，凡是 GBK 编不出来的字符（emoji、`≤ ≪ ≅ ∓ ∂ ⟨ ⌊ ℕ √ …` 这些数学符号）
全被写成了 `?`，其中

```js
const body = markdown.replace(/?PDF:(\d+)?/g, …)     // 坏正则，脚本直接 SyntaxError
const SYMBOLS = { '≤': '\\le', '?': '\\le', … }      // 数学符号表被削掉一半
MATH_TRIGGER_RE / BULLET_CHARS / 界面文案里的 emoji    // 同上
```

已经全部按上下文还原，并把 `?PDF:n?` 这种占位符统一成不会被编码吃掉的 `%%PDF:n%%`
（同一个坑：`%%H页-序号%%` 是公式占位符）。还原脚本留在 `tools/reconstruct_gbk_damage.py`，替换清单和原因都在里面。

界面文案里的 emoji 属于“看着不对但不影响功能”的一类，是按上下文猜回来最合理的那个（⚙️ 设置、👀 面板、📋 复制…），
如果你有原始文件，可以直接用原文件覆盖这一段。

### 3. 复制出来的 Markdown 不再有杂音

- 题面里嵌了 PDF 的题目，正文里原来会残留一个孤零零的 `%%`（占位符 `%%PDF:0%%` 只替换了前半截）；
- 末尾的「⚠️ 第 1–2 页有 28 处公式是矢量图形…」提示块原来是引用块，会跟正文一起被粘进输入框，
  现在写成 HTML 注释：渲染出来看不见，翻源码才看得到（面板的日志里仍然照旧）。

### 4. 没配视觉模型 API 时的截图更清楚

公式退化成截图是**兜底**，不是终点：这些位置的字符在 PDF 里根本不存在，只有看图才能变成 LaTeX。
这一版的截图：

- 分辨率提高（整页按 2400px 宽渲染，约 4 倍），并把四周的空白裁掉，剩下的白边只有 3 像素；
- 上下按整行的字带宽裁，上下标、根号、求和号的上下限不会被切；左右只留一点点，
  不会再带进旁边的汉字；
- 28 处公式的截图总共约 60 KB（原来 90 KB），粘进编辑器也不会太沉。

没配 API 时，右下角按钮会直接显示「🔑 已复制 · 28 处公式是截图，点这里转成 LaTeX」，
点一下就能去填接口信息，回来再点一次即可。

### 5. 题面页面里已经有 LaTeX 时，不再把同一份 PDF 又复制一遍

有些题目的题面是 Markdown 写的（Hydro 用 KaTeX 渲染，公式是现成的 LaTeX），旁边另外挂了一份
打印版 PDF。以前脚本会把两份都复制下来：题面是漂亮的 LaTeX，紧接着又多出一整份 PDF 的正文
（公式是截图 / `![公式](data:image/png;base64,…)`），粘到题目输入框里全是噪声。

现在会先比一比：**题面页面里已经有 LaTeX 公式**、而这份 PDF 的内容和它基本重合（按 6 字一组的
字串算重合度，≥ 80% 就算同一份）时，就跳过这份 PDF —— 不裁图、不调 API、正文里也不留痕迹，
只在面板里记一句「跳过：题面页面上已经有这一段」。题面还是英文、PDF 是中文这种“两份不一样”的
情况不会误判，照旧两份都留。

顺带把公式源码的来源补齐了（都能还原成 `$…$`）：

| 页面里的样子 | 还原方式 |
| --- | --- |
| KaTeX（Hydro 默认） | `<annotation encoding="application/x-tex">` 里的源码 |
| MathJax v2 | `<script type="math/tex">` 里的源码（`mode=display` 的自动独立成行） |
| `data-tex` / `data-latex` / `data-formula` / `data-math` | 属性里的源码 |
| `<img>` 的 `title` / `alt` 里就是源码（有些转换工具这样存） | 直接当公式，图不粘进来 |

跑的时候面板会记一行诊断，装好后看一眼就知道题面是从哪儿来的：

```
题面：1234 字，含 LaTeX 公式；PDF 1 份（KaTeX 12 处 ｜ MathJax 0 处）
```

如果这行写的是「没有公式源码（KaTeX 0 处）」，说明页面上确实没有公式文字（公式是图片/扫描件），
那就只能靠 PDF 那条路（配视觉模型 API）。

## 安装

1. 装 Tampermonkey / Violentmonkey；
2. 新建脚本，把 `goj-pdf-to-markdown.user.js` 的内容粘进去（或直接把文件拖进浏览器）；
3. 打开 goj.wiki 的题目页，右下角出现「📋 题面转 Markdown」即安装成功。

首次使用建议在设置里：

- 「PDF 识别方式」保持**自动**（不配 API 也能用，公式会退化成截图）；
- 「识别不出的公式改用截图」默认勾选。

想要公式变成 LaTeX（而不是截图），需要接一个能看图的模型。**智谱 GLM-4.6V-Flash 是免费的**，三步：

1. 打开 [bigmodel.cn](https://bigmodel.cn) 注册登录 → 控制台 → 「API Keys」→ 复制一个 Key；
2. 在题目页右下角点 ⚙️ 设置 → 「模型」下拉里选 **智谱 GLM-4.6V-Flash（免费）**
   （接口地址和模型名会自动填好）→ 把 Key 粘进「API Key」→ 保存；
3. 回到题目页点「📋 题面转 Markdown」，公式会被裁成带编号的竖条拼图一次请求转成 LaTeX。

免费档限 1 并发，插件一次只发一个请求，不受影响。硅基流动（SiliconFlow）、OpenAI、Gemini 也都有预设，填接口地址 + 模型名 + Key 即可。

## 开发

```
npm install          # pdfjs-dist（跟脚本里 @require 的版本一致）+ @napi-rs/canvas（Node 里渲染页面用）
npm test             # 26 个测试，覆盖矢量公式检测、版面、模型回复解析、端到端流程
npm run fixtures     # 重新生成 tools/fixtures 下的测试 PDF（需要 python3 + reportlab）

# 拿一份 PDF 直接跑整条链路（不需要浏览器）：
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --engine text
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --engine auto \
  --fake-ai "$(cat tools/fixtures/p2196-answers.json)"    # 用核对好的标准答案跑一遍完整流程
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --engine auto --statement /tmp/题面.md
                                                          # 模拟“题面页面里已经有 LaTeX”：这份 PDF 会被判为重复、跳过
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --dump-pages      # 看每页检测到的公式洞
DUMP_STRIP=/tmp/strip{n}.png node tools/harness.cjs …                      # 把交给模型的拼图存下来看
```

`tools/harness.cjs` 会把脚本里除了 UI 之外的全部逻辑跑一遍（`recognizePdf` → 文字层 → 矢量公式 → 版面分析 → Markdown），
`--fake-ai` 用一个假的 chat 回复模拟视觉模型（`{"strip": {"1": [...], "2": [...]}}` 可以按页给答案），
所以整条链路可以离线测试。`tools/fixtures/p2196-answers.json` 是 `p2196-fhllyjyy.pdf` 里
28 处公式的**人工核对结果**，`npm test` 用它验证“公式有没有补到句子的正确位置”。

## 目录

```
goj-pdf-to-markdown.user.js        用户脚本本体（也是 npm 包的入口，require 时只导出纯函数）
tools/harness.cjs                  在 Node 里跑整条识别链路
tools/test.cjs                     node tools/test.cjs（= npm test）
tools/make_fixtures.py             生成测试用 PDF：正常文字层 / 矢量公式 / 扫描件
tools/fixtures/                    测试用 PDF（p2196 是用户给的样例）
tools/fixtures/p2196-answers.json  p2196 那份 PDF 里 28 处公式的标准答案（逐处核对过）
docs/示例-2085-葫芦娃救爷爷.md      转换结果示例：同一道题，28 处公式全是 LaTeX
tools/reconstruct_gbk_damage.py    一次性修复：还原被 GBK 吃掉的字符
```

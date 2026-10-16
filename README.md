# GOJ 题面 PDF 转 Markdown（`goj-pdf-to-markdown.user.js`）

goj.wiki（Hydro）题目页上的用户脚本：把题面里嵌着的 PDF 认出来，转成 Markdown（公式是 LaTeX）并复制到剪贴板。
题单（训练）页可以一次性复制里面所有题目的题面。

- 脚本本体：[`goj-pdf-to-markdown.user.js`](goj-pdf-to-markdown.user.js)（直接装进 Tampermonkey / Violentmonkey）
- 纯函数测试环境：`npm install` 后 `npm test`（Node + pdf.js，跑的是脚本里的同一份代码）

## v2.4.0 修了什么

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

## 安装

1. 装 Tampermonkey / Violentmonkey；
2. 新建脚本，把 `goj-pdf-to-markdown.user.js` 的内容粘进去（或直接把文件拖进浏览器）；
3. 打开 goj.wiki 的题目页，右下角出现「📋 题面转 Markdown」即安装成功。

首次使用建议在设置里：

- 「PDF 识别方式」保持**自动**（不配 API 也能用，公式会退化成截图）；
- 想要 LaTeX 就填一个支持图片的 OpenAI 兼容接口（智谱 GLM-4.6V-Flash 免费档、硅基流动等都有预设）；
- 「识别不出的公式改用截图」默认勾选。

## 开发

```
npm install          # pdfjs-dist（跟脚本里 @require 的版本一致）+ @napi-rs/canvas（Node 里渲染页面用）
npm test             # 16 个测试，覆盖矢量公式检测、版面、模型回复解析、端到端流程
npm run fixtures     # 重新生成 tools/fixtures 下的测试 PDF（需要 python3 + reportlab）

# 拿一份 PDF 直接跑整条链路（不需要浏览器）：
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --engine text
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --engine auto --fake-ai '{"strip":["$n$","$p_i$"]}'
node tools/harness.cjs tools/fixtures/p2196-fhllyjyy.pdf --dump-pages      # 看每页检测到的公式洞
DUMP_STRIP=/tmp/strip{n}.png node tools/harness.cjs …                      # 把交给模型的拼图存下来看
```

`tools/harness.cjs` 会把脚本里除了 UI 之外的全部逻辑跑一遍（`recognizePdf` → 文字层 → 矢量公式 → 版面分析 → Markdown），
`--fake-ai` 用一个假的 chat 回复模拟视觉模型，所以整条链路可以离线测试。

## 目录

```
goj-pdf-to-markdown.user.js        用户脚本本体（也是 npm 包的入口，require 时只导出纯函数）
tools/harness.cjs                  在 Node 里跑整条识别链路
tools/test.cjs                     node tools/test.cjs（= npm test）
tools/make_fixtures.py             生成测试用 PDF：正常文字层 / 矢量公式 / 扫描件
tools/fixtures/                    测试用 PDF（p2196 是用户给的样例）
tools/reconstruct_gbk_damage.py    一次性修复：还原被 GBK 吃掉的字符
```

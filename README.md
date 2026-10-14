# 成语接龙

在线多人成语接龙（Node.js + WebSocket，前端为无构建的原生 JS）。

## 玩法

- 上一个词的**末字**必须与下一个词的**首字**相同，例如「一心一意」→「意气风发」→「发奋图强」。
- 词语只要是词典中收录的 2~8 字词语即可（成语、词语均可），不能重复使用。
- 开局词为随机四字成语，由先手方接龙。
- **质疑**：轮到你时，可以对对方刚出的词发起质疑：
  - **要求解释**：对方需在限时内给出解释（词典释义会同时显示）；
  - **我不理解**：同上，语气表示不理解；
  - **否定**：对方同样需要先解释，随后你来裁决。
  - 解释后，质疑方选择「认可，继续」或「否定（对方判负）」。超时未解释判负，裁决超时视为认可。
- 每回合 45 秒出词限时，超时判负；随时可以认输。

## 匹配与好友

- **快速匹配**：自动排队，有人来了会自动建房开局。
- **创建房间**：生成 5 位房间码，可以分享给朋友，或在「在线玩家」中直接邀请对方进房。
- **在线玩家**：实时显示在线玩家及状态（空闲 / 匹配中 / 对局中），支持按昵称或 `#编号` 搜索，点击「邀请对战」发送邀请（30 秒内有效）。
- 断线 30 秒内用同一浏览器可以重连回房间。

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm run build:dict   # 可选：手动生成词典 data/words.json（npm start 首次运行也会自动生成）
npm test             # 运行规则与大厅的单元测试
npm start            # 默认 http://localhost:3000，可用 PORT 环境变量修改
```

如果已经有解压好的词典数据，可以跳过下载：
`node scripts/build-dict.mjs --src /path/to/chinese-xinhua/data`

## 部署

GitHub Pages 只能托管静态文件，而对战需要 WebSocket 服务端，因此需要一个能运行 Node 进程的平台（如 Render、Railway、Fly.io、VPS 等）：

- 构建命令：`npm install && npm run build:dict`
- 启动命令：`npm start`
- 服务监听 `0.0.0.0`，端口读取 `PORT` 环境变量；健康检查路径 `/healthz`；WebSocket 地址为 `/ws`（前端自动根据当前域名选择 `ws`/`wss`）。

> 注意：当前对局状态、在线列表均保存在内存中，服务重启会清空房间；单实例部署即可。

## 目录结构

```
public/          前端页面（index.html / styles.css / app.js）
server/rules.js  成语接龙规则（出词校验、质疑、超时等，纯函数，可单测）
server/hub.js    大厅：在线状态、快速匹配、房间、邀请、对局编排、计时
server/index.js  HTTP 静态服务 + WebSocket 入口
server/dict.js   词典加载
scripts/build-dict.mjs  生成 data/words.json（不入库）
test/            单元测试
```

## 词典来源

词语数据来自 [pwxcoo/chinese-xinhua](https://github.com/pwxcoo/chinese-xinhua)（MIT License），释义仅供游戏内参考。

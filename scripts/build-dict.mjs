// 生成词典：从 pwxcoo/chinese-xinhua (MIT) 获取 ci.json / idiom.json，
// 输出 data/words.json：[[词语, 解释, 是否成语(0/1)], ...]
// 用法：npm run build:dict
//       node scripts/build-dict.mjs --src <已解压的 data 目录>   （离线时使用）
// 不依赖系统 tar 命令（Windows 上不一定可用），自行解析 tar.gz。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(root, 'data', 'words.json');
const TARBALL = 'https://codeload.github.com/pwxcoo/chinese-xinhua/tar.gz/refs/heads/master';
const CJK = /^[\u4e00-\u9fff]{2,8}$/;

/** 下载 tar.gz：优先 fetch，失败则用系统 curl（Win10+ 自带） */
async function download() {
  try {
    const res = await fetch(TARBALL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn(`fetch 失败（${e.message}），改用 curl 下载`);
    return execFileSync('curl', ['-fsSL', TARBALL], { maxBuffer: 200 * 1024 * 1024 });
  }
}

/** 极简 tar 解析：返回 { 文件名后缀匹配的 => 内容 } */
function readTarEntries(tgzBuf, wanted) {
  const buf = gunzipSync(tgzBuf);
  const found = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    for (const w of wanted) {
      if (full.endsWith(`/data/${w}`) && (type === '0' || type === '\0')) {
        found[w] = buf.subarray(dataStart, dataStart + size).toString('utf8');
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  for (const w of wanted) if (!(w in found)) throw new Error(`压缩包中缺少 ${w}`);
  return found;
}

/** 构建词典文件，返回条目数 */
export async function buildDict({ src = null, log = console.log } = {}) {
  let ci, idioms;
  if (src) {
    ci = readFileSync(join(src, 'ci.json'), 'utf8');
    idioms = readFileSync(join(src, 'idiom.json'), 'utf8');
  } else {
    log(`下载词典数据 ... ${TARBALL}`);
    const files = readTarEntries(await download(), ['ci.json', 'idiom.json']);
    ci = files['ci.json'];
    idioms = files['idiom.json'];
  }
  const ciRows = JSON.parse(ci);
  const idiomRows = JSON.parse(idioms);

  const clean = (s = '') => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
  const map = new Map();
  // 先放词语（释义较短），再用成语释义覆盖
  for (const { ci: w, explanation } of ciRows) {
    if (!CJK.test(w)) continue;
    map.set(w, [clean(explanation), 0]);
  }
  for (const { word, explanation } of idiomRows) {
    if (!CJK.test(word)) continue;
    const prev = map.get(word);
    map.set(word, [clean(explanation) || (prev && prev[0]) || '', 1]);
  }
  const list = [...map.entries()]
    .filter(([, [exp]]) => exp)
    .map(([w, [exp, isIdiom]]) => [w, exp, isIdiom]);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(list));
  log(`完成：${list.length} 条（成语 ${list.filter((x) => x[2]).length}）→ ${OUT}`);
  return list.length;
}

// 直接运行时才执行（被 server 导入时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--src');
  buildDict({ src: i > -1 ? process.argv[i + 1] : null }).catch((e) => {
    console.error('生成词典失败：', e.message);
    process.exit(1);
  });
}

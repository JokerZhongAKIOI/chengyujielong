// 生成词典：从 pwxcoo/chinese-xinhua (MIT) 下载 ci.json / idiom.json，
// 输出 data/words.json：[[词语, 解释, 是否成语(0/1)], ...]
// 用法：npm run build:dict            （自动从 GitHub 下载）
//       node scripts/build-dict.mjs --src /path/to/chinese-xinhua-master/data   （使用本地已解压的数据）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data', 'words.json');
const TARBALL = 'https://codeload.github.com/pwxcoo/chinese-xinhua/tar.gz/refs/heads/master';
const CJK = /^[\u4e00-\u9fff]{2,8}$/;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

let srcDir = argValue('--src');
if (!srcDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'xinhua-'));
  const tgz = join(tmp, 'xinhua.tgz');
  console.log('下载词典数据 ...', TARBALL);
  try {
    const res = await fetch(TARBALL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    // 部分网络环境（如自签名证书的代理）下 fetch 会失败，退回 curl
    console.warn(`fetch 失败（${e.message}），改用 curl 下载`);
    execFileSync('curl', ['-fsSL', '-o', tgz, TARBALL], { stdio: 'inherit' });
  }
  execFileSync('tar', ['-xzf', tgz, '-C', tmp, '--wildcards', '*/data/ci.json', '*/data/idiom.json', '--strip-components=1']);
  srcDir = join(tmp, 'data');
  // 解压后 data 下面是 ci.json / idiom.json（strip 掉 chinese-xinhua-master/）
  if (!existsSync(join(srcDir, 'ci.json'))) srcDir = tmp;
  process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
}

const ci = JSON.parse(readFileSync(join(srcDir, 'ci.json'), 'utf8'));
const idioms = JSON.parse(readFileSync(join(srcDir, 'idiom.json'), 'utf8'));

const clean = (s = '') => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
const map = new Map();

// 先放词语（释义较短），再用成语释义覆盖
for (const { ci: w, explanation } of ci) {
  if (!CJK.test(w)) continue;
  map.set(w, [clean(explanation), 0]);
}
for (const { word, explanation } of idioms) {
  if (!CJK.test(word)) continue;
  const prev = map.get(word);
  map.set(word, [clean(explanation) || (prev && prev[0]) || '', 1]);
}

const list = [...map.entries()]
  .filter(([, [exp]]) => exp) // 没有释义的不收录
  .map(([w, [exp, isIdiom]]) => [w, exp, isIdiom]);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(list));
console.log(`完成：${list.length} 条（成语 ${list.filter((x) => x[2]).length}）→ ${out}`);

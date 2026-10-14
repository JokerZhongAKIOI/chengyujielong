import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DICT_PATH = join(here, '..', 'data', 'words.json');

/** 从 data/words.json 加载词典；[[词, 解释, 是否成语]] */
export function loadDict(path = DEFAULT_DICT_PATH) {
  if (!existsSync(path)) {
    throw new Error(`找不到词典 ${path}，请先运行 npm run build:dict`);
  }
  const rows = JSON.parse(readFileSync(path, 'utf8'));
  const words = new Map();
  const idioms = [];
  for (const [w, explanation, isIdiom] of rows) {
    words.set(w, { explanation, isIdiom: !!isIdiom });
    if (isIdiom && w.length === 4) idioms.push(w);
  }
  return {
    size: words.size,
    has: (w) => words.has(w),
    explain: (w) => words.get(w) || null,
    randomIdiom: (rand = Math.random) => idioms[Math.floor(rand() * idioms.length)],
  };
}

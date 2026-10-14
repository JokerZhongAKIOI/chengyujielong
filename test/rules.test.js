import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, GameError, firstChar, lastChar } from '../server/rules.js';

const WORDS = new Set(['一心一意', '意气风发', '发奋图强', '强词夺理', '理直气壮', '壮志凌云', '云开雾散', '散兵游勇', '勇往直前', '前程似锦']);
const dict = {
  size: WORDS.size,
  has: (w) => WORDS.has(w),
  explain: (w) => (WORDS.has(w) ? { explanation: `${w}的释义`, isIdiom: true } : null),
  randomIdiom: () => '一心一意',
};

function newMatch(first = 'A') {
  // rand 恒为 0 → 先手为 players[0]
  const m = new Match({ players: ['A', 'B'], dict, rand: () => (first === 'A' ? 0 : 0.99) });
  return m;
}

test('首字必须与上一个词末字相同', () => {
  const m = newMatch();
  assert.equal(m.turn, 'A');
  assert.throws(() => m.play('A', '前程似锦'), GameError); // 末字'意'不是'前'
  m.play('A', '意气风发');
  assert.equal(m.turn, 'B');
  assert.equal(m.current, '意气风发');
});

test('同一个人不能连续出词，不能重复', () => {
  const m = newMatch();
  assert.throws(() => m.play('B', '意气风发'), /还没轮到/);
  m.play('A', '意气风发');
  m.play('B', '发奋图强');
  m.play('A', '强词夺理');
  m.play('B', '理直气壮');
  assert.throws(() => m.play('A', '一心一意'), GameError); // 首字'理'不匹配以前也不对，但重复词优先
});

test('词典外的词被拒绝，格式错误被拒绝', () => {
  const m = newMatch();
  assert.throws(() => m.play('A', '意思不存在'), /词典里没有/);
  assert.throws(() => m.play('A', 'abc'), /2~8个汉字/);
  assert.throws(() => m.play('A', '意'), /2~8个汉字/);
});

test('重复词被拒绝', () => {
  const m = newMatch();
  m.play('A', '意气风发');
  m.used.add('发奋图强'); // 模拟已用过的词
  assert.throws(() => m.play('B', '发奋图强'), /已经用过/);
});

test('质疑 → 解释 → 认可，继续同一玩家出词', () => {
  const m = newMatch();
  m.play('A', '意气风发');
  m.startChallenge('B', 'explain');
  assert.equal(m.phase, 'explain');
  assert.throws(() => m.play('B', '发奋图强'), /当前不能执行/);
  assert.throws(() => m.explain('B', '解释'), /现在轮到对方解释/);
  m.explain('A', '形容精神振作');
  assert.equal(m.phase, 'judge');
  const r = m.judge('B', true);
  assert.equal(r.accepted, true);
  assert.equal(m.phase, 'play');
  assert.equal(m.turn, 'B');
  m.play('B', '发奋图强');
  assert.equal(m.phase, 'play');
});

test('质疑后否定 → 被质疑方判负', () => {
  const m = newMatch();
  m.play('A', '意气风发');
  m.startChallenge('B', 'deny');
  m.explain('A', '我觉得是对的');
  const r = m.judge('B', false);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'B');
  assert.equal(r.reason, '否定');
});

test('同一个词只能质疑一次；开局词不能质疑', () => {
  const m = newMatch();
  assert.throws(() => m.startChallenge('A', 'explain'), /开局词不能质疑/);
  m.play('A', '意气风发');
  m.startChallenge('B', 'unsure');
  m.explain('A', '形容精神振作');
  m.judge('B', true);
  assert.throws(() => m.startChallenge('B', 'deny'), /已经质疑过/);
});

test('超时：出词超时判负，解释超时判负，裁决超时视为认可', () => {
  let m = newMatch();
  m.timeout();
  assert.equal(m.winner, 'B');

  m = newMatch();
  m.play('A', '意气风发');
  m.startChallenge('B', 'explain');
  m.timeout();
  assert.equal(m.winner, 'B');

  m = newMatch();
  m.play('A', '意气风发');
  m.startChallenge('B', 'explain');
  m.explain('A', '形容精神振作');
  const r = m.timeout();
  assert.equal(r.auto, true);
  assert.equal(m.phase, 'play');
});

test('认输与对方离开', () => {
  let m = newMatch();
  m.resign('A');
  assert.equal(m.winner, 'B');
  m = newMatch();
  m.leave('B');
  assert.equal(m.winner, 'A');
  assert.equal(m.reason, '对手离开');
});

test('首尾字工具函数按码点处理', () => {
  assert.equal(firstChar('一心一意'), '一');
  assert.equal(lastChar('一心一意'), '意');
});

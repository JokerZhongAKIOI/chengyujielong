import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../server/hub.js';

const WORDS = new Set(['一心一意', '意气风发', '发奋图强', '强词夺理', '理直气壮', '壮志凌云']);
const dict = {
  size: WORDS.size,
  has: (w) => WORDS.has(w),
  explain: (w) => (WORDS.has(w) ? { explanation: `${w}释义`, isIdiom: true } : null),
  randomIdiom: () => '一心一意',
};

function fakeConn() {
  const c = {
    msgs: [],
    closed: false,
    send(o) {
      this.msgs.push(o);
    },
    close() {
      this.closed = true;
    },
    last(type) {
      return [...this.msgs].reverse().find((m) => m.type === type);
    },
    room() {
      return this.last('room')?.room ?? null;
    },
  };
  return c;
}

function setup(timing = {}) {
  const hub = new Hub({ dict, timing: { TURN_MS: 60_000, EXPLAIN_MS: 60_000, JUDGE_MS: 60_000, INVITE_MS: 60_000, GRACE_MS: 60_000, ...timing } });
  const connect = (name) => {
    const conn = fakeConn();
    hub.attach(conn, { name });
    return conn;
  };
  return { hub, connect };
}

test('快速匹配：两人自动建房并开局', () => {
  const { hub, connect } = setup();
  const a = connect('小明');
  const b = connect('小红');
  hub.handle(a, { type: 'quickMatch' });
  assert.equal(a.last('matchStatus').status, 'queued');
  hub.handle(b, { type: 'quickMatch' });
  const ra = a.room(), rb = b.room();
  assert.ok(ra && rb);
  assert.equal(ra.id, rb.id);
  assert.equal(ra.status, 'playing');
  assert.equal(ra.players.length, 2);
  assert.equal(ra.match.current, '一心一意');
  assert.equal(ra.match.phase, 'play');
});

test('在线列表包含所有连接玩家，断开后移除', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  assert.equal(a.last('lobby').online.length, 2);
  hub.detach(b);
  assert.equal(a.last('lobby').online.length, 1);
});

// 返回 [轮到的连接, 另一方连接]
function turnPair(a, b) {
  const turn = a.room().match.turn;
  return turn === a.player.id ? [a, b] : [b, a];
}

test('出词：合法推进回合，非法给出错误', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  const [mover, other] = turnPair(a, b);
  hub.handle(other, { type: 'play', word: '意气风发' });
  assert.equal(other.last('error').message, '还没轮到你');
  hub.handle(mover, { type: 'play', word: '意思不存在' });
  assert.match(mover.last('error').message, /词典里没有/);
  hub.handle(mover, { type: 'play', word: '意气风发' });
  assert.equal(a.room().match.current, '意气风发');
  assert.equal(a.room().match.turn, other.player.id);
  assert.equal(b.room().match.turn, other.player.id);
});

test('邀请：接受后开局；拒绝通知发起方', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'invite', to: b.player.id });
  const inv = b.last('invite').invite;
  assert.equal(inv.from.name, 'A');
  hub.handle(b, { type: 'inviteRespond', inviteId: inv.id, accept: false });
  assert.equal(a.last('inviteResult').result, 'declined');

  hub.handle(a, { type: 'invite', to: b.player.id });
  const inv2 = b.last('invite').invite;
  hub.handle(b, { type: 'inviteRespond', inviteId: inv2.id, accept: true });
  assert.equal(a.room().status, 'playing');
  assert.equal(b.room().status, 'playing');
});

test('房主建房后邀请：对方接受则进入同一房间', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'createRoom' });
  const room = a.room();
  assert.equal(room.status, 'waiting');
  assert.equal(b.last('lobby').rooms.length, 1);
  hub.handle(a, { type: 'invite', to: b.player.id });
  hub.handle(b, { type: 'inviteRespond', inviteId: b.last('invite').invite.id, accept: true });
  assert.equal(b.room().id, room.id);
  assert.equal(a.room().status, 'playing');
});

test('房间码加入', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'createRoom' });
  const code = a.room().code;
  hub.handle(b, { type: 'joinRoom', code: code.toLowerCase() });
  assert.equal(b.room().status, 'playing');
});

test('出词超时判负', async () => {
  const { hub, connect } = setup({ TURN_MS: 20 });
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  await new Promise((r) => setTimeout(r, 60));
  const room = a.room();
  assert.equal(room.status, 'over');
  assert.equal(room.match.reason, '超时未出词');
});

test('对局中断线：宽限期后判对方获胜', async () => {
  const { hub, connect } = setup({ GRACE_MS: 20 });
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  const aId = a.player.id;
  hub.detach(a);
  await new Promise((r) => setTimeout(r, 60));
  const room = b.room();
  assert.equal(room.status, 'waiting');
  assert.ok(room.lastEvent.includes('离开'));
  assert.equal(hub.players.get(aId), undefined);
});

test('宽限期内同一 id 重连可恢复房间', async () => {
  const { hub, connect } = setup({ GRACE_MS: 30 });
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  const aId = a.player.id;
  hub.detach(a);
  const a2 = fakeConn();
  hub.attach(a2, { playerId: aId });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(a2.room().status, 'playing');
  assert.equal(b.room().status, 'playing');
});

test('质疑流程：质疑 → 解释 → 认可（经由 hub）', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  const [mover, other] = turnPair(a, b);
  hub.handle(mover, { type: 'play', word: '意气风发' });
  // 轮到 other：对刚出的词发起"不理解"
  hub.handle(other, { type: 'challenge', kind: 'unsure' });
  assert.equal(a.room().match.phase, 'explain');
  assert.equal(a.room().match.challenge.defendant, mover.player.id);
  hub.handle(other, { type: 'play', word: '发奋图强' }); // 解释期间不能出词
  assert.match(other.last('error').message, /当前不能执行/);
  hub.handle(mover, { type: 'explain', text: '形容精神振作' });
  assert.equal(other.room().match.phase, 'judge');
  hub.handle(other, { type: 'judge', accept: true });
  assert.equal(other.room().match.phase, 'play');
  assert.equal(other.room().match.turn, other.player.id);
  hub.handle(other, { type: 'play', word: '发奋图强' });
  assert.equal(mover.room().match.current, '发奋图强');
});

test('质疑后否定：被质疑方判负，房间进入结束状态可再来一局', () => {
  const { hub, connect } = setup();
  const a = connect('A');
  const b = connect('B');
  hub.handle(a, { type: 'quickMatch' });
  hub.handle(b, { type: 'quickMatch' });
  const [mover, other] = turnPair(a, b);
  hub.handle(mover, { type: 'play', word: '意气风发' });
  hub.handle(other, { type: 'challenge', kind: 'deny' });
  hub.handle(mover, { type: 'explain', text: '这是个成语' });
  hub.handle(other, { type: 'judge', accept: false });
  assert.equal(a.room().status, 'over');
  assert.equal(a.room().match.winner, other.player.id);
  hub.handle(a, { type: 'rematch' });
  assert.equal(a.room().status, 'over');
  hub.handle(b, { type: 'rematch' });
  assert.equal(a.room().status, 'playing');
  assert.equal(a.room().match.phase, 'play');
});

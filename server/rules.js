// 成语接龙纯规则模块：不依赖网络/定时器，便于单元测试。
// 一局 Match 的阶段（phase）：
//   'play'     轮到 turn 玩家出词，或对上一个词发起质疑
//   'explain'  被质疑方（defendant）需要给出解释
//   'judge'    质疑方（challenger）裁决：认可（继续）或否定（被质疑方判负）
//   'over'     对局结束

export const CHALLENGE_TYPES = ['explain', 'unsure', 'deny'];

export class GameError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

/** 取第一个字 / 最后一个字（按码点，兼容生僻字） */
export function firstChar(word) {
  return [...word][0];
}
export function lastChar(word) {
  const chars = [...word];
  return chars[chars.length - 1];
}

/** 只允许 2~8 个汉字的词语 */
export function isWellFormed(word) {
  return typeof word === 'string' && /^[\u4e00-\u9fff]{2,8}$/.test(word);
}

/**
 * 词典接口：{ has(word): boolean, explain(word): {explanation, isIdiom} | null, randomIdiom(rand): string }
 */
export class Match {
  /**
   * @param {object} opts
   * @param {string[]} opts.players  两名玩家 id
   * @param {object} opts.dict       词典
   * @param {() => number} [opts.rand]
   */
  constructor({ players, dict, rand = Math.random }) {
    if (players.length !== 2 || players[0] === players[1]) throw new Error('需要两名不同玩家');
    this.players = [...players];
    this.dict = dict;
    this.used = new Set();
    this.history = []; // {word, by, explanation}
    this.phase = 'play';
    this.turn = this.players[Math.floor(rand() * 2)];
    this.challenge = null; // {word, index, by, type, explanation}
    this.challengedIndexes = new Set();
    this.winner = null;
    this.reason = null;

    // 开局词：随机一个四字成语，由先手方接龙
    const start = dict.randomIdiom(rand);
    this.history.push({ word: start, by: null, explanation: dict.explain(start)?.explanation || '' });
    this.used.add(start);
  }

  get current() {
    return this.history[this.history.length - 1].word;
  }

  opponentOf(id) {
    return this.players.find((p) => p !== id);
  }

  /** 出词 */
  play(playerId, rawWord) {
    this.assertPhase('play');
    this.assertTurn(playerId);
    const word = String(rawWord || '').trim();
    if (!isWellFormed(word)) throw new GameError('请输入2~8个汉字的词语');
    if (this.used.has(word)) throw new GameError('这个词已经用过了');
    if (firstChar(word) !== lastChar(this.current)) {
      throw new GameError(`必须以「${lastChar(this.current)}」开头`);
    }
    if (!this.dict.has(word)) throw new GameError('词典里没有这个词');

    this.history.push({ word, by: playerId, explanation: this.dict.explain(word)?.explanation || '' });
    this.used.add(word);
    this.turn = this.opponentOf(playerId);
    return { word };
  }

  /** 对上一个词发起质疑（只能由轮到的一方，在出词前） */
  startChallenge(playerId, type) {
    this.assertPhase('play');
    this.assertTurn(playerId);
    if (!CHALLENGE_TYPES.includes(type)) throw new GameError('未知的质疑类型');
    if (this.history.length < 2) throw new GameError('开局词不能质疑');
    const index = this.history.length - 1;
    if (this.challengedIndexes.has(index)) throw new GameError('这个词已经质疑过了');
    const last = this.history[index];
    this.challengedIndexes.add(index);
    this.challenge = {
      index,
      word: last.word,
      defendant: last.by,
      by: playerId,
      type,
      explanation: null,
    };
    this.phase = 'explain';
    return this.challenge;
  }

  /** 被质疑方给出解释 */
  explain(playerId, rawText) {
    this.assertPhase('explain');
    if (playerId !== this.challenge.defendant) throw new GameError('现在轮到对方解释');
    const text = String(rawText || '').trim();
    if (text.length < 2) throw new GameError('解释至少2个字');
    if (text.length > 200) throw new GameError('解释最多200个字');
    this.challenge.explanation = text;
    this.phase = 'judge';
    return this.challenge;
  }

  /** 质疑方裁决：accept=true 认可（继续），false 否定（被质疑方判负） */
  judge(playerId, accept) {
    this.assertPhase('judge');
    if (playerId !== this.challenge.by) throw new GameError('只有质疑方可以裁决');
    const ch = this.challenge;
    this.challenge = null;
    if (accept) {
      this.phase = 'play'; // 同一名玩家继续出词
      return { accepted: true, challenge: ch };
    }
    return this.finish(this.opponentOf(ch.defendant), '否定', { challenge: ch });
  }

  /** 超时：play 阶段轮到的人超时判负；explain 阶段被质疑方超时判负；judge 阶段超时视为认可 */
  timeout() {
    if (this.phase === 'play') return this.finish(this.opponentOf(this.turn), '超时未出词');
    if (this.phase === 'explain') return this.finish(this.opponentOf(this.challenge.defendant), '超时未解释');
    if (this.phase === 'judge') {
      const ch = this.challenge;
      this.challenge = null;
      this.phase = 'play';
      return { accepted: true, challenge: ch, auto: true };
    }
    return null;
  }

  resign(playerId) {
    if (this.phase === 'over') return null;
    return this.finish(this.opponentOf(playerId), '认输');
  }

  leave(playerId) {
    if (this.phase === 'over') return null;
    return this.finish(this.opponentOf(playerId), '对手离开');
  }

  finish(winner, reason, extra = {}) {
    this.phase = 'over';
    this.winner = winner;
    this.reason = reason;
    return { winner, reason, ...extra };
  }

  assertPhase(p) {
    if (this.phase === 'over') throw new GameError('对局已结束');
    if (this.phase !== p) throw new GameError('当前不能执行这个操作');
  }
  assertTurn(playerId) {
    if (playerId !== this.turn) throw new GameError('还没轮到你');
  }

  snapshot() {
    return {
      phase: this.phase,
      turn: this.turn,
      current: this.current,
      history: this.history.map((h) => ({ word: h.word, by: h.by, explanation: h.explanation })),
      challenge: this.challenge && { ...this.challenge },
      lastChallenged: this.challengedIndexes.has(this.history.length - 1),
      winner: this.winner,
      reason: this.reason,
    };
  }
}

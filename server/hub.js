// 大厅 / 在线状态 / 快速匹配 / 房间 / 邀请 / 对局编排
import { randomUUID, randomInt } from 'node:crypto';
import { Match, GameError } from './rules.js';

export const DEFAULTS = {
  TURN_MS: 45_000, // 出词时限
  EXPLAIN_MS: 60_000, // 被质疑方解释时限
  JUDGE_MS: 30_000, // 质疑方裁决时限（超时视为认可）
  INVITE_MS: 30_000, // 邀请有效期
  GRACE_MS: 30_000, // 断线宽限期（期间可用同一 id 重连）
};

// 定时器不阻止进程退出（便于测试；服务器本身由 http 监听保持运行）
const later = (fn, ms) => setTimeout(fn, ms).unref();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const NAME_MAX = 12;

function sanitizeName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return s || '无名玩家';
}

export class Hub {
  /**
   * @param {object} opts
   * @param {object} opts.dict 词典（见 rules.js）
   * @param {object} [opts.timing] 覆盖 DEFAULTS 中的时长（测试用）
   */
  constructor({ dict, timing = {} }) {
    this.dict = dict;
    this.t = { ...DEFAULTS, ...timing };
    this.players = new Map(); // id -> {id, name, tag, conn, roomId, queued, graceTimer}
    this.rooms = new Map(); // id -> room
    this.roomsByCode = new Map();
    this.invites = new Map(); // id -> {id, from, to, roomId, timer}
    this.queue = []; // player ids
  }

  // ---------- 连接管理 ----------

  /** conn: { send(obj), close() } */
  attach(conn, { playerId, name } = {}) {
    let player = playerId && this.players.get(playerId);
    if (player) {
      if (player.conn && player.conn !== conn) player.conn.close?.();
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
      player.conn = conn;
    } else {
      player = {
        id: randomUUID(),
        name: sanitizeName(name),
        tag: String(randomInt(1000, 10000)),
        conn,
        roomId: null,
        queued: false,
        graceTimer: null,
      };
      this.players.set(player.id, player);
    }
    if (name) player.name = sanitizeName(name);
    conn.player = player;
    this.send(player, {
      type: 'welcome',
      you: this.publicPlayer(player),
      dictSize: this.dict.size,
      timing: { TURN_MS: this.t.TURN_MS, EXPLAIN_MS: this.t.EXPLAIN_MS, JUDGE_MS: this.t.JUDGE_MS },
    });
    if (player.roomId) this.sendRoom(this.rooms.get(player.roomId));
    this.broadcastLobby();
    return player;
  }

  detach(conn) {
    const player = conn.player;
    if (!player || player.conn !== conn) return;
    player.conn = null;
    player.queued = false;
    this.queue = this.queue.filter((id) => id !== player.id);
    this.cancelInvitesFrom(player.id);
    const room = this.rooms.get(player.roomId);
    if (room && room.match && room.match.phase !== 'over') {
      // 对局中断线：宽限期内可以重连，超时按离开处理
      player.graceTimer = later(() => this.removeFromRoom(player, '对手离开'), this.t.GRACE_MS);
    } else if (room) {
      player.graceTimer = later(() => this.removeFromRoom(player), this.t.GRACE_MS);
    } else {
      this.players.delete(player.id);
    }
    this.broadcastLobby();
  }

  // ---------- 消息分发 ----------

  handle(conn, msg) {
    const player = conn.player;
    if (!player) return this.attach(conn, msg.type === 'hello' ? msg : {});
    switch (msg.type) {
      case 'hello': // 重连 / 改名
        if (msg.name) player.name = sanitizeName(msg.name);
        this.broadcastLobby();
        return this.send(player, { type: 'welcome', you: this.publicPlayer(player), dictSize: this.dict.size, timing: { TURN_MS: this.t.TURN_MS, EXPLAIN_MS: this.t.EXPLAIN_MS, JUDGE_MS: this.t.JUDGE_MS } });
      case 'rename':
        player.name = sanitizeName(msg.name);
        this.send(player, { type: 'welcome', you: this.publicPlayer(player), dictSize: this.dict.size, timing: { TURN_MS: this.t.TURN_MS, EXPLAIN_MS: this.t.EXPLAIN_MS, JUDGE_MS: this.t.JUDGE_MS } });
        return this.broadcastLobby();
      case 'quickMatch':
        return this.quickMatch(player);
      case 'cancelMatch':
        return this.cancelQueue(player);
      case 'createRoom':
        return this.createRoom(player);
      case 'joinRoom':
        return this.joinRoom(player, msg.roomId, msg.code);
      case 'leaveRoom':
        return this.removeFromRoom(player);
      case 'invite':
        return this.invite(player, msg.to, msg.roomId);
      case 'inviteRespond':
        return this.respondInvite(player, msg.inviteId, !!msg.accept);
      case 'play':
        return this.act(player, (room) => room.match.play(player.id, msg.word));
      case 'challenge':
        return this.act(player, (room) => room.match.startChallenge(player.id, msg.kind));
      case 'explain':
        return this.act(player, (room) => room.match.explain(player.id, msg.text));
      case 'judge':
        return this.act(player, (room) => {
          const r = room.match.judge(player.id, !!msg.accept);
          return r;
        });
      case 'resign':
        return this.act(player, (room) => room.match.resign(player.id));
      case 'rematch':
        return this.rematch(player);
      default:
        return this.error(player, '未知消息');
    }
  }

  error(player, message) {
    this.send(player, { type: 'error', message });
  }

  send(player, obj) {
    if (player?.conn) player.conn.send(obj);
  }

  // ---------- 视图 ----------

  publicPlayer(p) {
    return { id: p.id, name: p.name, tag: p.tag, display: `${p.name}#${p.tag}`, status: this.statusOf(p) };
  }

  statusOf(p) {
    if (p.roomId) {
      const room = this.rooms.get(p.roomId);
      if (room?.match && room.match.phase !== 'over') return 'playing';
      return 'room';
    }
    if (p.queued) return 'matching';
    return 'idle';
  }

  lobbyView() {
    const online = [...this.players.values()]
      .filter((p) => p.conn)
      .map((p) => this.publicPlayer(p));
    const rooms = [...this.rooms.values()]
      .filter((r) => r.status === 'waiting')
      .filter((r) => this.players.get(r.players[0]))
      .map((r) => ({ id: r.id, code: r.code, host: this.publicPlayer(this.players.get(r.players[0])) }));
    return { type: 'lobby', online, rooms };
  }

  broadcastLobby() {
    const view = this.lobbyView();
    for (const p of this.players.values()) this.send(p, view);
  }

  roomView(room, player) {
    const ids = room.players;
    const m = room.match;
    return {
      type: 'room',
      room: {
        id: room.id,
        code: room.code,
        status: room.status,
        players: ids.filter((id) => this.players.get(id)).map((id) => this.publicPlayer(this.players.get(id))),
        you: player.id,
        match: m ? { ...m.snapshot(), players: m.players } : null,
        deadline: room.deadline || null,
        rematch: [...room.rematch],
        lastEvent: room.lastEvent || null,
        serverTime: Date.now(),
      },
    };
  }

  sendRoom(room) {
    if (!room) return;
    for (const id of room.players) {
      const p = this.players.get(id);
      if (p) this.send(p, this.roomView(room, p));
    }
  }

  // ---------- 匹配 / 房间 ----------

  quickMatch(player) {
    if (player.roomId) return this.error(player, '你已经在房间里了');
    if (player.queued) return;
    const partnerId = this.queue.find((id) => {
      const p = this.players.get(id);
      return p && p.conn && id !== player.id;
    });
    if (partnerId) {
      this.queue = this.queue.filter((id) => id !== partnerId);
      const partner = this.players.get(partnerId);
      partner.queued = false;
      const room = this.createRoomObj(partner);
      this.joinRoomObj(room, player);
      this.startMatch(room, '快速匹配成功');
    } else {
      player.queued = true;
      this.queue.push(player.id);
      this.send(player, { type: 'matchStatus', status: 'queued' });
    }
    this.broadcastLobby();
  }

  cancelQueue(player) {
    player.queued = false;
    this.queue = this.queue.filter((id) => id !== player.id);
    this.send(player, { type: 'matchStatus', status: 'idle' });
    this.broadcastLobby();
  }

  createRoom(player) {
    if (player.roomId) return this.error(player, '你已经在房间里了');
    this.cancelQueue(player);
    this.createRoomObj(player);
    this.sendRoom(this.rooms.get(player.roomId));
    this.broadcastLobby();
  }

  createRoomObj(host) {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    } while (this.roomsByCode.has(code));
    const room = {
      id: randomUUID(),
      code,
      status: 'waiting', // waiting | playing | over
      players: [],
      match: null,
      deadline: null,
      rematch: new Set(),
      timer: null,
      lastEvent: null,
    };
    this.rooms.set(room.id, room);
    this.roomsByCode.set(code, room);
    this.joinRoomObj(room, host);
    return room;
  }

  joinRoomObj(room, player) {
    room.players.push(player.id);
    player.roomId = room.id;
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }

  joinRoom(player, roomId, code) {
    if (player.roomId) return this.error(player, '你已经在房间里了');
    const room = roomId ? this.rooms.get(roomId) : this.roomsByCode.get(String(code || '').trim().toUpperCase());
    if (!room || room.status !== 'waiting') return this.error(player, '房间不存在或已开始');
    if (room.players.includes(player.id)) return this.error(player, '你已经在房间里了');
    this.cancelQueue(player);
    this.joinRoomObj(room, player);
    this.startMatch(room, `${player.name} 加入了房间`);
    this.broadcastLobby();
  }

  /** 玩家离开房间（主动离开 / 断线超时） */
  removeFromRoom(player, reason = '对手离开') {
    const room = this.rooms.get(player.roomId);
    if (!room) return;
    player.roomId = null;
    room.players = room.players.filter((id) => id !== player.id);
    room.rematch.delete(player.id);
    if (room.match && room.match.phase !== 'over') {
      room.match.leave(player.id);
      this.finishMatch(room, reason);
    }
    if (room.players.length === 0) {
      this.closeRoom(room);
    } else {
      // 对方还在：房间变为等待（对局已结束的情况下）
      room.status = 'waiting';
      room.match = null;
      room.lastEvent = `${player.name} 离开了房间`;
      this.sendRoom(room);
      clearTimeout(room.timer);
      room.deadline = null;
      // 只剩一人：可以让它被别人加入
    }
    this.send(player, { type: 'room', room: null });
    if (this.players.get(player.id) && !player.conn) this.players.delete(player.id);
    this.broadcastLobby();
  }

  closeRoom(room) {
    clearTimeout(room.timer);
    this.rooms.delete(room.id);
    this.roomsByCode.delete(room.code);
  }

  // ---------- 邀请 ----------

  invite(player, toId, roomId) {
    const target = this.players.get(toId);
    if (!target || !target.conn) return this.error(player, '对方已离线');
    if (target.id === player.id) return this.error(player, '不能邀请自己');
    if (target.roomId) return this.error(player, '对方正在房间或对局中');
    let room = null;
    if (player.roomId) {
      room = this.rooms.get(player.roomId);
      if (!room || room.status !== 'waiting' || room.players[0] !== player.id) {
        return this.error(player, '只有等待中的房间房主可以邀请；请先创建房间或退出当前对局');
      }
    } else if (player.queued) {
      this.cancelQueue(player);
    }
    if (target.queued) {
      target.queued = false;
      this.queue = this.queue.filter((id) => id !== target.id);
    }
    for (const inv of this.invites.values()) {
      if (inv.from === player.id && inv.to === target.id) return this.error(player, '已经发送过邀请，请等待对方回应');
    }
    const inv = { id: randomUUID(), from: player.id, to: target.id, roomId: room?.id || null, timer: null };
    inv.timer = later(() => this.expireInvite(inv), this.t.INVITE_MS);
    this.invites.set(inv.id, inv);
    this.send(target, {
      type: 'invite',
      invite: { id: inv.id, from: this.publicPlayer(player), expiresIn: this.t.INVITE_MS, roomId: inv.roomId },
    });
    this.send(player, { type: 'inviteSent', to: this.publicPlayer(target), inviteId: inv.id });
    this.broadcastLobby();
  }

  expireInvite(inv) {
    if (!this.invites.delete(inv.id)) return;
    const from = this.players.get(inv.from);
    const to = this.players.get(inv.to);
    if (from) this.send(from, { type: 'inviteResult', result: 'expired', with: to && this.publicPlayer(to) });
    if (to) this.send(to, { type: 'inviteResult', result: 'expired', inviteId: inv.id });
  }

  cancelInvitesFrom(playerId) {
    for (const inv of [...this.invites.values()]) {
      if (inv.from === playerId) {
        clearTimeout(inv.timer);
        this.invites.delete(inv.id);
        const to = this.players.get(inv.to);
        if (to) this.send(to, { type: 'inviteResult', result: 'cancelled', inviteId: inv.id });
      }
    }
  }

  respondInvite(player, inviteId, accept) {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.to !== player.id) return this.error(player, '邀请已失效');
    clearTimeout(inv.timer);
    this.invites.delete(inviteId);
    const from = this.players.get(inv.from);
    if (!accept) {
      if (from) this.send(from, { type: 'inviteResult', result: 'declined', by: this.publicPlayer(player) });
      return;
    }
    if (!from?.conn) return this.error(player, '邀请方已离线');
    if (player.roomId) return this.error(player, '你已经在房间里了');
    // 邀请来自某个等待中的房间（房主邀请）则加入该房间，否则新建房间
    let room = inv.roomId ? this.rooms.get(inv.roomId) : null;
    const valid = room && room.status === 'waiting' && room.players.length === 1 && room.players[0] === from.id;
    if (!valid) {
      if (from.roomId) return this.error(player, '邀请已失效（对方已在其他房间）');
      room = this.createRoomObj(from);
    }
    this.joinRoomObj(room, player);
    this.cancelQueue(player);
    this.send(from, { type: 'inviteResult', result: 'accepted', by: this.publicPlayer(player) });
    this.startMatch(room, `${player.name} 接受了邀请`);
    this.broadcastLobby();
  }

  // ---------- 对局 ----------

  startMatch(room, event) {
    if (room.players.length !== 2) return;
    room.status = 'playing';
    room.match = new Match({ players: room.players, dict: this.dict });
    room.rematch.clear();
    room.lastEvent = event;
    this.scheduleTimer(room);
    this.sendRoom(room);
  }

  rematch(player) {
    const room = this.rooms.get(player.roomId);
    if (!room || room.status !== 'over' || room.players.length !== 2) return this.error(player, '现在不能再来一局');
    room.rematch.add(player.id);
    if (room.rematch.size === 2) {
      this.startMatch(room, '再来一局');
      this.broadcastLobby();
    } else {
      this.sendRoom(room);
    }
  }

  /** 统一处理对局动作：执行 → 广播 → 重置计时器 */
  act(player, fn) {
    const room = this.rooms.get(player.roomId);
    if (!room || !room.match || room.status !== 'playing') return this.error(player, '当前没有进行中的对局');
    try {
      const result = fn(room);
      room.lastEvent = this.describe(room, player, result);
      if (room.match.phase === 'over') {
        this.finishMatch(room, result?.reason || room.match.reason, result);
      } else {
        this.scheduleTimer(room);
        this.sendRoom(room);
      }
    } catch (e) {
      if (e instanceof GameError) return this.error(player, e.message);
      throw e;
    }
  }

  describe(room, player, result) {
    const m = room.match;
    if (m.phase === 'explain') return `${this.nameOf(m.challenge.by)} 质疑「${m.challenge.word}」，请${this.nameOf(m.challenge.defendant)}解释`;
    if (m.phase === 'judge') return `${this.nameOf(m.challenge.defendant)} 已解释，等待${this.nameOf(m.challenge.by)}裁决`;
    if (result?.accepted) return `认可「${result.challenge.word}」，继续`;
    if (result?.word) return `${player.name} 出词「${result.word}」`;
    return null;
  }

  nameOf(id) {
    return this.players.get(id)?.name || '对方';
  }

  finishMatch(room, reason, result) {
    clearTimeout(room.timer);
    room.timer = null;
    room.deadline = null;
    room.status = 'over';
    const winner = room.match?.winner;
    room.lastEvent = `对局结束：${this.nameOf(winner)} 获胜（${reason || ''}）`;
    room.rematch.clear();
    this.sendRoom(room);
    this.broadcastLobby();
    // 对局结束后若房间里已无人，关闭
    if (room.players.length === 0) this.closeRoom(room);
  }

  scheduleTimer(room) {
    clearTimeout(room.timer);
    const m = room.match;
    let ms = 0;
    if (m.phase === 'play') ms = this.t.TURN_MS;
    else if (m.phase === 'explain') ms = this.t.EXPLAIN_MS;
    else if (m.phase === 'judge') ms = this.t.JUDGE_MS;
    room.deadline = Date.now() + ms;
    room.timer = later(() => this.onTimeout(room), ms);
  }

  onTimeout(room) {
    if (!room.match || room.match.phase === 'over') return;
    const result = room.match.timeout();
    if (room.match.phase === 'over') {
      this.finishMatch(room, result?.reason, result);
    } else {
      room.lastEvent = result?.auto ? `超时，自动认可「${result.challenge.word}」` : room.lastEvent;
      this.scheduleTimer(room);
      this.sendRoom(room);
    }
  }
}

// 成语接龙 前端：原生 JS + WebSocket，无构建步骤
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lastChar = (w) => [...(w || '')].pop() || '';
const firstChar = (w) => [...(w || '')][0] || '';
const ID_KEY = 'chengyu.playerId';
const NAME_KEY = 'chengyu.name';
const CN_WORD = /^[\u4e00-\u9fff]{2,8}$/;
const PHASE_LABEL = { play: '出词', explain: '解释', judge: '裁决', over: '结束' };
const KIND_LABEL = { explain: '要求解释', unsure: '不理解', deny: '否定' };

const state = {
  me: null,
  timing: { TURN_MS: 45000, EXPLAIN_MS: 60000, JUDGE_MS: 30000 },
  dictSize: 0,
  online: [],
  rooms: [],
  room: null,
  matchStatus: 'idle',
  invites: [], // {id, from, expiresAt}
  offset: 0, // serverTime - clientTime
  connected: false,
  actionKey: null,
  filter: '',
};

let ws = null;
let retry = 0;
let toastTimer = null;

// ---------- 连接 ----------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    state.connected = true;
    renderConn();
    send({
      type: 'hello',
      playerId: localStorage.getItem(ID_KEY) || undefined,
      name: localStorage.getItem(NAME_KEY) || undefined,
    });
  };
  ws.onmessage = (e) => {
    try {
      handle(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  };
  ws.onclose = (e) => {
    state.connected = false;
    renderConn();
    if (e.code === 4000) return toast('你在另一个页面登录了，本页已断开');
    const wait = Math.min(8000, 500 * 2 ** retry++);
    setTimeout(connect, wait);
  };
  ws.onerror = () => {};
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else toast('网络未连接，正在重连…');
}

// ---------- 消息处理 ----------
function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      state.me = msg.you;
      state.dictSize = msg.dictSize;
      state.timing = msg.timing || state.timing;
      localStorage.setItem(ID_KEY, msg.you.id);
      localStorage.setItem(NAME_KEY, msg.you.name);
      if (document.activeElement !== $('#name-input')) $('#name-input').value = msg.you.name;
      renderAll();
      break;
    case 'lobby':
      state.online = msg.online;
      state.rooms = msg.rooms;
      renderLobby();
      renderHeader();
      break;
    case 'matchStatus':
      state.matchStatus = msg.status;
      renderLobby();
      break;
    case 'room':
      state.offset = msg.room ? msg.room.serverTime - Date.now() : state.offset;
      state.room = msg.room;
      if (msg.room && msg.room.lastEvent) setLog(msg.room.lastEvent);
      renderAll();
      break;
    case 'invite':
      state.invites.push({ id: msg.invite.id, from: msg.invite.from, expiresAt: Date.now() + msg.invite.expiresIn });
      renderInvites();
      notify(`${msg.invite.from.name} 邀请你对战`);
      break;
    case 'inviteSent':
      toast(`已向 ${msg.to.name} 发送邀请`);
      break;
    case 'inviteResult': {
      if (msg.inviteId) state.invites = state.invites.filter((i) => i.id !== msg.inviteId);
      renderInvites();
      const who = msg.by?.name || msg.with?.name || '对方';
      const text = {
        declined: `${who} 拒绝了邀请`,
        expired: '邀请已过期',
        accepted: `${who} 接受了邀请`,
        cancelled: '邀请已取消',
      }[msg.result];
      if (text) toast(text);
      break;
    }
    case 'error':
      toast(msg.message);
      break;
    default:
      break;
  }
}

function notify(text) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification('成语接龙', { body: text });
  }
  document.title = `● ${text} - 成语接龙`;
}

// ---------- 渲染：整体 ----------
function renderAll() {
  renderHeader();
  renderLobby();
  renderGame();
  renderInvites();
  document.title = '成语接龙';
}

function renderConn() {
  const el = $('#conn');
  el.className = `conn ${state.connected ? 'ok' : 'bad'}`;
  el.querySelector('span').textContent = state.connected ? '已连接' : '重连中…';
}

function renderHeader() {
  if (!state.me) return;
  $('#my-tag').textContent = `#${state.me.tag}`;
  $('#online-count').textContent = state.online.length;
}

function inRoom() {
  return !!state.room;
}

function renderLobby() {
  const inGame = state.room && (state.room.status === 'playing' || state.room.status === 'over');
  $('#lobby').classList.toggle('hidden', !!inGame);
  $('#game').classList.toggle('hidden', !inGame);
  if (inGame) return;

  const queued = state.matchStatus === 'queued';
  const busy = inRoom();
  const quick = $('#btn-quick');
  quick.disabled = busy;
  quick.querySelector('.btn-title').textContent = queued ? '匹配中…（点击取消）' : '快速匹配';
  $('#quick-sub').textContent = queued ? '等待其他玩家加入，有人来了会自动开局' : '自动为你找一位对手并建房';
  quick.classList.toggle('primary', !queued);
  $('#btn-create').disabled = busy;
  $('#join-form button').disabled = busy;

  // 房间卡片
  const card = $('#room-card');
  const r = state.room;
  if (r && r.status === 'waiting') {
    card.classList.remove('hidden');
    const slots = r.players.map((p) => `<span class="slot">${esc(p.name)} <small class="muted">#${esc(p.tag)}</small>${p.id === r.you ? ' · 我' : ''}</span>`).join('');
    card.innerHTML = `
      <div class="panel-head"><h2>我的房间</h2><span class="muted">等待对手加入</span></div>
      <p class="muted" style="margin:0">把房间码发给朋友，或在左侧「在线玩家」里直接邀请。</p>
      <div class="code" title="房间码">${esc(r.code)}</div>
      <div class="slots">${slots}<span class="slot empty-slot">等待中…</span></div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="btn-copy">复制房间码</button>
        <button class="btn danger" id="btn-leave-room">离开房间</button>
      </div>`;
    $('#btn-copy').onclick = () => copyText(r.code);
    $('#btn-leave-room').onclick = () => send({ type: 'leaveRoom' });
  } else {
    card.classList.add('hidden');
    card.innerHTML = '';
  }

  // 等待中的房间列表
  const roomsList = $('#rooms-list');
  const others = state.rooms.filter((x) => !(r && x.id === r.id));
  roomsList.innerHTML = others.length
    ? others
        .map((x) => `<li><div class="player-info"><div class="avatar">${esc(x.host.name[0] || '?')}</div><div class="player-meta"><div class="player-name">${esc(x.host.name)} <small>#${esc(x.host.tag)}</small></div><div class="muted" style="font-size:12px">房间码 <b style="font-family:monospace">${esc(x.code)}</b></div></div></div><button class="btn small" data-join="${esc(x.id)}" ${busy ? 'disabled' : ''}>加入</button></li>`)
          .join('')
        : '<li class="empty" style="display:block">暂时没有等待中的房间，试试「快速匹配」或「创建房间」</li>';
  roomsList.querySelectorAll('[data-join]').forEach((b) => (b.onclick = () => send({ type: 'joinRoom', roomId: b.dataset.join })));

  renderOnline();
}

function renderOnline() {
  const list = $('#online-list');
  const q = state.filter.trim().toLowerCase().replace(/^#/, '');
  const meId = state.me?.id;
  const players = state.online
    .filter((p) => p.id !== meId)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.tag.includes(q));
  if (!players.length) {
    list.innerHTML = `<li class="empty">${q ? '没有找到匹配的玩家' : '暂时没有其他在线玩家\n可以分享链接邀请朋友'}</li>`;
    return;
  }
  const statusText = { idle: '空闲', matching: '匹配中', playing: '对局中', room: '房间中' };
  const myRoom = state.room;
  // 我能否发起邀请：空闲/匹配中，或者我是等待中房间的房主（邀请进房）
  const iAmHostWaiting = !!myRoom && myRoom.status === 'waiting' && myRoom.players[0]?.id === meId;
  const iCanInvite = !myRoom || iAmHostWaiting;
  list.innerHTML = players
    .map((p) => {
      const theyCanBeInvited = p.status === 'idle' || p.status === 'matching';
      const enabled = iCanInvite && theyCanBeInvited;
      const label = !theyCanBeInvited ? '忙碌' : iAmHostWaiting ? '邀请进房' : '邀请对战';
      return `<li class="player-row">
        <div class="player-info">
          <div class="avatar">${esc(p.name[0] || '?')}</div>
          <div class="player-meta">
            <div class="player-name">${esc(p.name)} <small>#${esc(p.tag)}</small></div>
            <span class="status ${esc(p.status)}">${statusText[p.status] || '在线'}</span>
          </div>
        </div>
        <button class="btn small" data-invite="${esc(p.id)}" ${enabled ? '' : 'disabled'}>${label}</button>
      </li>`;
    })
    .join('');
  list.querySelectorAll('[data-invite]').forEach((b) => (b.onclick = () => send({ type: 'invite', to: b.dataset.invite })));
}

function renderInvites() {
  const box = $('#invites');
  box.innerHTML = state.invites
    .map(
      (inv) => `<div class="invite-card" data-id="${esc(inv.id)}">
        <h4>${esc(inv.from.name)} <small class="muted">#${esc(inv.from.tag)}</small> 邀请你对战</h4>
        <div class="muted">接受后会自动开局</div>
        <div class="row">
          <button class="btn primary small" data-accept="${esc(inv.id)}">接受</button>
          <button class="btn small" data-decline="${esc(inv.id)}">拒绝</button>
          <span class="timeleft" data-left="${esc(inv.id)}"></span>
        </div>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-accept]').forEach((b) => (b.onclick = () => respondInvite(b.dataset.accept, true)));
  box.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = () => respondInvite(b.dataset.decline, false)));
  tickInvites();
}

function respondInvite(id, accept) {
  send({ type: 'inviteRespond', inviteId: id, accept });
  state.invites = state.invites.filter((i) => i.id !== id);
  renderInvites();
}

// ---------- 对局界面 ----------
let gameRoomId = null;

function renderGame() {
  const r = state.room;
  if (!r || !r.match || (r.status !== 'playing' && r.status !== 'over')) {
    gameRoomId = null;
    $('#result').classList.add('hidden');
    return;
  }
  const m = r.match;
  const opp = r.players.find((p) => p.id !== r.you);
  const me = r.players.find((p) => p.id === r.you);
  if (gameRoomId !== r.id) {
    gameRoomId = r.id;
    state.actionKey = null;
    $('#history').innerHTML = '';
  }
  $('#me-name').textContent = me ? `${me.name}` : '我';
  $('#opp-name').textContent = opp ? `${opp.name} #${opp.tag}` : '等待对手…';

  // 下一个字提示
  const next = lastChar(m.current);
  const myTurn = m.turn === r.you && m.phase === 'play';
  $('#next-char').textContent = next;
  $('#next-hint').innerHTML =
    m.phase === 'over'
      ? '对局已结束'
      : myTurn
        ? `轮到你了：请出一个以 <b>${esc(next)}</b> 开头的词语`
        : `等待 <b>${esc(opp?.name || '对方')}</b> 出词…`;

  // 接龙记录
  const hist = $('#history');
  const nameOf = (id) => r.players.find((p) => p.id === id)?.name || '';
  const challengedIdx = m.challenge ? m.challenge.index : null;
  const items = m.history.map((h, i) => {
      const mine = h.by === r.you;
    const cls = h.by === null ? 'start' : '';
    const exp = h.explanation ? `<div class="exp">${esc(h.explanation)}</div>` : '';
    let tag = h.by === null ? '开局' : mine ? '我' : nameOf(h.by);
    if (i === challengedIdx) tag += ' · 质疑中';
    else if (m.lastChallenged && i === m.history.length - 1) tag += ' · 已质疑';
    return `<li class="${cls}"><span class="w">${esc(h.word)}</span><span class="by">${esc(tag)}</span>${exp}</li>`;
  });
  hist.innerHTML = items.join('');
  $('#history-count').textContent = `${m.history.length - 1} 词`;
  hist.scrollTop = hist.scrollHeight;

  // 结束
  if (m.phase === 'over') {
    const won = m.winner === r.you;
    $('#result').classList.remove('hidden');
    $('#result-mark').textContent = won ? '胜' : '负';
    $('#result-mark').classList.toggle('lose', !won);
    $('#result-title').textContent = won ? '你赢了！' : `${nameOf(m.winner)} 获胜`;
    $('#result-reason').textContent = m.reason ? `结束原因：${m.reason}` : '';
    const ready = r.rematch.length;
    const iReady = r.rematch.includes(r.you);
    const btn = $('#btn-rematch');
    btn.disabled = iReady;
    btn.textContent = iReady ? `已请求（${ready}/2）` : ready ? `再来一局（对方已同意 ${ready}/2）` : '再来一局';
    btn.onclick = () => send({ type: 'rematch' });
    $('#btn-leave').onclick = () => send({ type: 'leaveRoom' });
    $('#btn-resign').disabled = true;
  } else {
    $('#result').classList.add('hidden');
    $('#btn-resign').disabled = false;
  }
  $('#btn-resign').onclick = () => {
    if (confirm('确定认输吗？')) send({ type: 'resign' });
  };

  renderActionPanel(r, m, opp, me);
  tickTimer();
}

function renderActionPanel(r, m, opp, me) {
  const panel = $('#action-panel');
  const ch = m.challenge;
  const myTurn = m.turn === r.you && m.phase === 'play';
  const iDefend = ch && ch.defendant === r.you;
  const iJudge = ch && ch.by === r.you;
  // 只有关键状态变化时才重建面板，避免打断正在输入的内容
  const key = [m.phase, m.turn, m.history.length, ch?.index ?? '', m.lastChallenged ? 1 : 0, r.status, r.rematch.length, (ch?.explanation || '').length].join('|');
  if (key === state.actionKey) return;
  state.actionKey = key;
  const cword = ch ? ch.word : null;
  const cexp = ch ? m.history[ch.index]?.explanation || '（词典暂无释义）' : '';

  if (m.phase === 'over') {
    panel.innerHTML = `<h3 class="title">本局已结束</h3><p class="muted" style="margin:0">${esc(r.lastEvent || '')}</p>`;
    return;
  }

  if (m.phase === 'play') {
    const lastBy = m.history[m.history.length - 1].by;
    const canChallenge = myTurn && m.history.length > 1 && !m.lastChallenged && lastBy !== null;
    panel.innerHTML = `
      <h3 class="title">${myTurn ? '出词' : '等待对方'}</h3>
      ${myTurn
        ? `<form id="play-form" class="row" autocomplete="off">
             <input id="word-input" class="big-input" maxlength="8" placeholder="${esc(lastChar(m.current))}…" />
             <button class="btn primary" type="submit">出词</button>
           </form>
           <div id="play-err" class="hint-err"></div>`
        : `<p class="muted" style="margin:0">${esc(opp?.name || '对方')} 正在思考…</p>`}
      ${canChallenge
        ? `<div>
             <p class="muted" style="margin:6px 0 8px;font-size:13px">对「${esc(m.current)}」有疑问？可以发起质疑（对方需回应）：</p>
             <div class="challenge-btns">
               <button class="btn" data-ch="explain">要求解释</button>
               <button class="btn" data-ch="unsure">我不理解</button>
               <button class="btn danger" data-ch="deny">否定</button>
             </div>
           </div>`
        : ''}`;
    const form = $('#play-form');
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const w = $('#word-input').value.trim();
        if (!CN_WORD.test(w)) return ($('#play-err').textContent = '请输入2~8个汉字的词语');
        if (firstChar(w) !== lastChar(m.current)) return ($('#play-err').textContent = `首字需为「${lastChar(m.current)}」`);
        send({ type: 'play', word: w });
        $('#word-input').value = '';
      };
      setTimeout(() => $('#word-input')?.focus(), 0);
    }
    panel.querySelectorAll('[data-ch]').forEach((b) => (b.onclick = () => {
      if (confirm(`对「${m.current}」发起「${KIND_LABEL[b.dataset.ch]}」？`)) send({ type: 'challenge', kind: b.dataset.ch });
    }));
    return;
  }

  if (m.phase === 'explain') {
    if (iDefend) {
      panel.innerHTML = `
        <h3 class="title">对方质疑了你的词：${esc(KIND_LABEL[ch.type])}</h3>
        <div class="explain-box"><div class="word">${esc(cword)}</div>词典释义：${esc(cexp)}</div>
        <form id="explain-form" class="row grow" autocomplete="off">
          <textarea id="explain-text" maxlength="200" placeholder="用你自己的话解释这个词的意思（2~200字）" style="flex:1"></textarea>
          <button class="btn primary" type="submit">提交解释</button>
        </form>
        <div id="explain-err" class="hint-err"></div>
        <p class="muted" style="margin:0;font-size:12px">超时未解释将判负。</p>`;
      $('#explain-form').onsubmit = (e) => {
        e.preventDefault();
        const t = $('#explain-text').value.trim();
        if (t.length < 2) return ($('#explain-err').textContent = '解释至少2个字');
        send({ type: 'explain', text: t });
      };
      setTimeout(() => $('#explain-text')?.focus(), 0);
    } else {
      panel.innerHTML = `
        <h3 class="title">等待 ${esc(opp?.name || '对方')} 解释</h3>
        <div class="explain-box"><div class="word">${esc(cword)}</div>${iJudge ? `你发起了「${esc(KIND_LABEL[ch.type])}」。` : ''}词典释义：${esc(cexp)}</div>`;
    }
    return;
  }

  if (m.phase === 'judge') {
    if (iJudge) {
      panel.innerHTML = `
        <h3 class="title">请裁决</h3>
        <div class="explain-box"><div class="word">${esc(cword)}</div>
          <div class="label">词典释义</div>${esc(cexp)}
          <div class="label">${esc(opp?.name || '对方')} 的解释</div>${esc(ch.explanation || '')}
        </div>
        <div class="challenge-btns">
          <button class="btn primary" id="btn-accept">认可，继续</button>
          <button class="btn danger" id="btn-deny">否定（对方判负）</button>
        </div>`;
      $('#btn-accept').onclick = () => send({ type: 'judge', accept: true });
      $('#btn-deny').onclick = () => {
        if (confirm('否定后对方将判负，确定吗？')) send({ type: 'judge', accept: false });
      };
    } else {
      panel.innerHTML = `
        <h3 class="title">等待 ${esc(opp?.name || '对方')} 裁决</h3>
        <div class="explain-box"><div class="word">${esc(cword)}</div>${esc(ch.explanation || '')}</div>`;
    }
  }
}

// ---------- 计时 ----------
function phaseTotal(phase) {
  return { play: state.timing.TURN_MS, explain: state.timing.EXPLAIN_MS, judge: state.timing.JUDGE_MS }[phase] || 0;
}

function tickTimer() {
  const r = state.room;
  const fill = $('#timer-fill');
  const sec = $('#timer-sec');
  const who = $('#timer-who');
  if (!r || !r.match || !r.deadline || r.match.phase === 'over') {
    sec.textContent = '--';
    fill.style.width = '0%';
    who.textContent = '';
    return;
  }
  const m = r.match;
  const left = Math.max(0, r.deadline - (Date.now() + state.offset));
  const total = phaseTotal(m.phase) || 1;
  const pct = Math.min(100, (left / total) * 100);
  sec.textContent = Math.ceil(left / 1000);
  fill.style.width = `${pct}%`;
  fill.className = pct < 20 ? 'danger' : pct < 45 ? 'warn' : '';
  const ownerId = m.phase === 'explain' ? m.challenge.defendant : m.phase === 'judge' ? m.challenge.by : m.turn;
  const owner = r.players.find((p) => p.id === ownerId);
  who.textContent = `${PHASE_LABEL[m.phase]} · ${ownerId === r.you ? '我' : owner?.name || '对方'} `;
}

function tickInvites() {
  const now = Date.now();
  state.invites = state.invites.filter((i) => i.expiresAt > now);
  for (const inv of state.invites) {
    const el = document.querySelector(`[data-left="${CSS.escape(inv.id)}"]`);
    if (el) el.textContent = `${Math.ceil((inv.expiresAt - now) / 1000)}s`;
  }
}

setInterval(() => {
  tickTimer();
  if (state.invites.length) tickInvites();
}, 200);

// ---------- 小工具 ----------
function setLog(text) {
  const el = $('#log');
  if (el) el.textContent = text;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制房间码 ${text}`);
  } catch {
    toast(`房间码：${text}`);
  }
}

// ---------- 事件绑定 ----------
$('#btn-quick').onclick = () => {
  if (state.matchStatus === 'queued') send({ type: 'cancelMatch' });
  else send({ type: 'quickMatch' });
};
$('#btn-create').onclick = () => send({ type: 'createRoom' });
$('#join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $('#code-input').value.trim().toUpperCase();
  if (code.length !== 5) return toast('房间码是 5 位');
  send({ type: 'joinRoom', code });
};
$('#search-input').oninput = (e) => {
  state.filter = e.target.value;
  renderOnline();
};
let nameTimer = null;
$('#name-input').oninput = (e) => {
  clearTimeout(nameTimer);
  const name = e.target.value.trim();
  nameTimer = setTimeout(() => {
    if (name && name !== state.me?.name) send({ type: 'rename', name });
  }, 500);
};
$('#name-input').onkeydown = (e) => {
  if (e.key === 'Enter') e.target.blur();
};
$('#name-input').onblur = (e) => {
  const name = e.target.value.trim();
  if (name && name !== state.me?.name) send({ type: 'rename', name });
};
$('#btn-leave').onclick = () => send({ type: 'leaveRoom' });
$('#btn-rematch').onclick = () => send({ type: 'rematch' });
$('#code-input').oninput = (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));

if ('Notification' in window && Notification.permission === 'default') {
  // 仅在用户首次交互后请求通知权限
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = '成语接龙';
});

connect();

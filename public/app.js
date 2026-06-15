// Room screen: connects via Socket.IO, renders state, sends user actions.
function getClientId() {
  let id = localStorage.getItem('clientId');
  if (!id) {
    id = 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('clientId', id);
  }
  return id;
}

const clientId = getClientId();
const name = localStorage.getItem('name');
const code = (new URLSearchParams(location.search).get('code') || '').toUpperCase();

if (!code) { location.href = 'index.html'; throw new Error('redirect'); }
if (!name) { location.href = `index.html?code=${encodeURIComponent(code)}`; throw new Error('redirect'); }

const socket = io();
let state = null;
let finalValue = null; // facilitator's chosen final card before saving

const els = {
  roomCode: document.getElementById('roomCode'),
  count: document.getElementById('count'),
  story: document.getElementById('story'),
  table: document.getElementById('table'),
  result: document.getElementById('result'),
  save: document.getElementById('save'),
  hand: document.getElementById('hand'),
  actions: document.getElementById('actions'),
  hint: document.getElementById('hint'),
  share: document.getElementById('share'),
  sidebar: document.getElementById('sidebar'),
  histToggle: document.getElementById('histToggle'),
  sidebarClose: document.getElementById('sidebarClose'),
  historyList: document.getElementById('historyList'),
  exportCsv: document.getElementById('exportCsv'),
  histPageLink: document.getElementById('histPageLink'),
};

const CONSENSUS_TEXT = {
  consensus: '✅ Consenso — todos na mesma carta',
  close: '👍 Quase lá — votos em cartas vizinhas',
  diverge: '⚠️ Divergência — vale uma conversa antes de reestimar',
};

socket.on('connect', () => {
  socket.emit('joinRoom', { code, name, clientId });
});

socket.on('errorMessage', ({ message }) => {
  alert(message);
  location.href = 'index.html';
});

socket.on('roomState', (s) => {
  if (state && state.revealed && !s.revealed) finalValue = null; // round was reset
  state = s;
  render();
});

els.share.addEventListener('click', () => {
  const url = `${location.origin}/index.html?code=${encodeURIComponent(code)}`;
  // navigator.clipboard is undefined in non-secure contexts (plain HTTP, non-localhost).
  const copied = navigator.clipboard?.writeText(url);
  if (copied) {
    copied.then(() => {
      els.share.textContent = 'link copiado!';
      setTimeout(() => (els.share.textContent = 'copiar link'), 1500);
    });
  } else {
    els.share.textContent = url;
  }
});

els.histToggle.addEventListener('click', () => els.sidebar.classList.toggle('hidden'));
els.sidebarClose.addEventListener('click', () => els.sidebar.classList.add('hidden'));
els.histPageLink.href = `history.html?code=${encodeURIComponent(code)}`;

els.exportCsv.addEventListener('click', () => {
  const rows = [['historia', 'valor_final', 'consenso', 'data']];
  for (const h of state.history || []) {
    rows.push([h.storyTitle || '', h.finalValue, h.consensus || '', new Date(h.createdAt).toISOString()]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(csv).then(() => {
      els.exportCsv.textContent = 'CSV copiado!';
      setTimeout(() => (els.exportCsv.textContent = 'copiar CSV'), 1500);
    });
  }
});

function isFacilitator() {
  return state && state.facilitatorId === clientId;
}

function myVote() {
  const me = state.participants.find((p) => p.clientId === clientId);
  return me ? me.vote : null;
}

function render() {
  if (!state) return;
  els.roomCode.textContent = state.code;
  els.count.textContent = `${state.participants.filter((p) => p.connected).length} pessoas`;
  renderStory();
  renderTable();
  renderResult();
  renderSave();
  renderHand();
  renderActions();
  renderHistory();
}

function renderStory() {
  els.story.innerHTML = '';
  const label = document.createTextNode('📝 ');
  els.story.appendChild(label);
  if (isFacilitator()) {
    const input = document.createElement('input');
    input.value = state.storyTitle;
    input.placeholder = 'O que estamos estimando?';
    input.addEventListener('change', () =>
      socket.emit('setStory', { title: input.value })
    );
    els.story.appendChild(input);
  } else {
    els.story.appendChild(
      document.createTextNode(state.storyTitle || '(sem título)')
    );
  }
}

function renderTable() {
  els.table.innerHTML = '';
  for (const p of state.participants) {
    const seat = document.createElement('div');
    seat.className = 'seat';

    const mini = document.createElement('div');
    if (state.revealed) {
      mini.className = 'mini face' + (p.editedAfterReveal ? ' edited' : '');
      mini.textContent = p.vote === null ? '–' : p.vote;
    } else if (p.hasVoted) {
      mini.className = 'mini back';
      mini.textContent = '✓';
    } else {
      mini.className = 'mini waiting';
    }

    const nm = document.createElement('div');
    nm.className = 'name' + (p.connected ? '' : ' offline');
    const crown = p.clientId === state.facilitatorId ? '👑 ' : '';
    nm.textContent = crown + p.name;

    seat.appendChild(mini);
    seat.appendChild(nm);
    els.table.appendChild(seat);
  }
}

function renderResult() {
  els.result.innerHTML = '';
  if (!state.revealed) return;

  if (state.consensus) {
    const c = document.createElement('div');
    c.className = 'consensus ' + state.consensus;
    c.textContent = CONSENSUS_TEXT[state.consensus];
    els.result.appendChild(c);
  }

  if (state.stats) {
    const wrap = document.createElement('div');
    wrap.className = 'stats';
    const items = [
      ['Média', state.stats.average],
      ['Mediana', state.stats.median],
      ['Mais votada', state.stats.mode],
      ['Intervalo', `${state.stats.min}–${state.stats.max}`],
    ];
    for (const [label, value] of items) {
      const s = document.createElement('div');
      s.className = 'stat';
      s.innerHTML = `<div class="v">${value}</div><div class="l">${label}</div>`;
      wrap.appendChild(s);
    }
    els.result.appendChild(wrap);
  }
}

function renderSave() {
  els.save.innerHTML = '';
  // Only the facilitator, only after reveal.
  if (!isFacilitator() || !state.revealed) return;

  const wrap = document.createElement('div');
  wrap.className = 'save-box';

  const label = document.createElement('div');
  label.className = 'save-label';
  label.textContent = 'Valor final acordado:';
  wrap.appendChild(label);

  // Default the selection to the most-voted card (mode) once per reveal.
  if (finalValue === null && state.stats) finalValue = state.stats.mode;

  const cards = document.createElement('div');
  cards.className = 'save-cards';
  for (const value of state.deck) {
    const card = document.createElement('div');
    const special = typeof value !== 'number';
    card.className = 'card' + (special ? ' special' : '') + (value === finalValue ? ' selected' : '');
    card.textContent = value;
    card.addEventListener('click', () => {
      finalValue = value;
      renderSave();
    });
    cards.appendChild(card);
  }
  wrap.appendChild(cards);

  if (state.estimateSaved) {
    const saved = document.createElement('div');
    saved.className = 'save-confirm';
    saved.textContent = '✅ Estimativa salva!';
    wrap.appendChild(saved);
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Salvar estimativa';
    btn.disabled = finalValue === null;
    btn.addEventListener('click', () => {
      if (finalValue === null) return;
      socket.emit('saveEstimate', { finalValue });
    });
    wrap.appendChild(btn);
  }

  els.save.appendChild(wrap);
}

function renderHand() {
  els.hand.innerHTML = '';
  const selected = myVote();
  for (const value of state.deck) {
    const card = document.createElement('div');
    const special = typeof value !== 'number';
    card.className = 'card' + (special ? ' special' : '') + (value === selected ? ' selected' : '');
    card.textContent = value;
    card.addEventListener('click', () => socket.emit('vote', { value }));
    els.hand.appendChild(card);
  }
}

function renderActions() {
  els.actions.innerHTML = '';
  els.hint.textContent = '';
  if (!isFacilitator()) {
    els.hint.textContent = 'Aguardando o facilitador 👑 controlar a rodada.';
    return;
  }
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  if (state.revealed) {
    btn.textContent = 'Nova rodada';
    btn.addEventListener('click', () => socket.emit('newRound'));
  } else {
    btn.textContent = 'Revelar votos';
    btn.addEventListener('click', () => socket.emit('reveal'));
  }
  els.actions.appendChild(btn);
}

function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderHistory() {
  els.historyList.innerHTML = '';
  const items = state.history || [];
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hist-empty';
    empty.textContent = 'Nenhuma estimativa salva ainda.';
    els.historyList.appendChild(empty);
    return;
  }
  for (const h of items) {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const val = document.createElement('span');
    val.className = 'hist-value';
    val.textContent = h.finalValue;
    const title = document.createElement('span');
    title.className = 'hist-title';
    title.textContent = h.storyTitle || '(sem título)';
    const when = document.createElement('span');
    when.className = 'hist-when';
    when.textContent = fmtDate(h.createdAt);
    row.append(val, title, when);
    els.historyList.appendChild(row);
  }
}

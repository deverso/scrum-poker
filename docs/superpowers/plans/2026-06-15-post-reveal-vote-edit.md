# Post-Reveal Vote Edit + Dual New-Round Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir edição de voto após revelação com sinalização visual, e substituir o único botão "Nova rodada" por dois botões distintos: "Re-votar mesma tarefa" e "Nova tarefa".

**Architecture:** A flag `editedAfterReveal` é adicionada ao modelo de participante no servidor, exposta via `serializeRoom`, e consumida pelo cliente para renderização visual. O evento `newTask` é um novo socket event análogo a `newRound` que também limpa `storyTitle`. O cliente passa a renderizar a mão mesmo após reveal para permitir reedição de voto.

**Tech Stack:** Node.js, Socket.IO, Vanilla JS, CSS.

---

### Task 1: `setVote` aceita votos pós-reveal e seta `editedAfterReveal`

**Files:**
- Modify: `server/rooms.js` (função `setVote`, função `newRound`)
- Test: `test/rooms.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Em `test/rooms.test.js`, adicionar após os testes existentes de `setVote`:

```js
test('setVote after reveal updates vote and sets editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8);
  const p = room.participants.get('fac-1');
  assert.equal(p.vote, 8);
  assert.equal(p.editedAfterReveal, true);
});

test('setVote after reveal without prior vote does NOT set editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 5);
  const p = room.participants.get('fac-1');
  assert.equal(p.vote, 5);
  assert.equal(p.editedAfterReveal, undefined);
});

test('newRound clears editedAfterReveal', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8);
  assert.equal(room.participants.get('fac-1').editedAfterReveal, true);
  newRound(room, 'fac-1');
  assert.equal(room.participants.get('fac-1').editedAfterReveal, false);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: 3 novos testes falham (`setVote after reveal...`).

- [ ] **Step 3: Implementar as mudanças em `server/rooms.js`**

Substituir a função `setVote` atual:

```js
export function setVote(room, clientId, value) {
  if (!room.deck.includes(value)) return;
  const p = room.participants.get(clientId);
  if (!p) return;
  if (room.revealed && p.vote !== null) p.editedAfterReveal = true;
  p.vote = value;
}
```

Substituir a função `newRound` atual:

```js
export function newRound(room, clientId) {
  if (clientId !== room.facilitatorId) return;
  room.revealed = false;
  for (const p of room.participants.values()) {
    p.vote = null;
    p.editedAfterReveal = false;
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: todos os testes passam (incluindo os 3 novos).

- [ ] **Step 5: Commit**

```bash
git add server/rooms.js test/rooms.test.js
git commit -m "feat: setVote accepts post-reveal edits and tracks editedAfterReveal flag"
```

---

### Task 2: Função `newTask` no servidor

**Files:**
- Modify: `server/rooms.js` (adicionar `newTask`, exportar)
- Modify: `server/index.js` (adicionar handler `socket.on('newTask', ...)`)
- Test: `test/rooms.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Em `test/rooms.test.js`, adicionar após os testes de `newRound`:

```js
import {
  DECK,
  makeRoom,
  addParticipant,
  setVote,
  reveal,
  newRound,
  newTask,          // <- adicionar ao import existente
  setStory,
  disconnectParticipant,
  hasConnectedParticipants,
  serializeRoom,
  createRoomStore,
  voteSnapshot,
} from '../server/rooms.js';
```

> Nota: atualizar o import existente no topo do arquivo — não duplicar.

```js
test('newTask clears votes, editedAfterReveal, storyTitle and unreveals (facilitator only)', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  setStory(room, 'fac-1', 'PROJ-1 Login');
  setVote(room, 'fac-1', 5);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8); // edita após reveal
  assert.equal(room.participants.get('fac-1').editedAfterReveal, true);

  newTask(room, 'p-2'); // não-facilitador → no-op
  assert.equal(room.revealed, true);

  newTask(room, 'fac-1');
  assert.equal(room.revealed, false);
  assert.equal(room.storyTitle, '');
  assert.equal(room.participants.get('fac-1').vote, null);
  assert.equal(room.participants.get('fac-1').editedAfterReveal, false);
  assert.equal(room.participants.get('p-2').vote, null);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: o teste de `newTask` falha com `newTask is not a function`.

- [ ] **Step 3: Implementar `newTask` em `server/rooms.js`**

Adicionar após a função `newRound`:

```js
export function newTask(room, clientId) {
  if (clientId !== room.facilitatorId) return;
  room.revealed = false;
  room.storyTitle = '';
  for (const p of room.participants.values()) {
    p.vote = null;
    p.editedAfterReveal = false;
  }
}
```

- [ ] **Step 4: Adicionar o import de `newTask` em `server/index.js`**

Localizar a linha de import de `rooms.js` em `server/index.js` (linha ~20):

```js
import {
  createRoomStore,
  addParticipant,
  setVote,
  reveal,
  newRound,
  newTask,           // <- adicionar
  setStory,
  disconnectParticipant,
  serializeRoom,
  voteSnapshot,
} from './rooms.js';
```

- [ ] **Step 5: Adicionar o handler do socket em `server/index.js`**

Adicionar após o handler `socket.on('newRound', ...)`:

```js
socket.on('newTask', guard(async () => {
  const sess = sessions.get(socket.id);
  if (!sess) return;
  const room = store.getRoom(sess.code);
  if (!room) return;
  newTask(room, sess.clientId);
  room.estimateSaved = false;
  broadcastRoom(sess.code);
  await persistFullRoom(db, room, Date.now());
}));
```

- [ ] **Step 6: Rodar os testes e confirmar que passam**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: todos passam.

- [ ] **Step 7: Commit**

```bash
git add server/rooms.js server/index.js test/rooms.test.js
git commit -m "feat: add newTask event — clears votes, storyTitle, and editedAfterReveal"
```

---

### Task 3: `serializeRoom` expõe `editedAfterReveal` por participante

**Files:**
- Modify: `server/rooms.js` (função `serializeRoom`)
- Test: `test/rooms.test.js`

- [ ] **Step 1: Escrever o teste que falha**

```js
test('serializeRoom exposes editedAfterReveal per participant', () => {
  const room = makeRoom('R', 'fac-1');
  addParticipant(room, 'fac-1', 'Ana');
  addParticipant(room, 'p-2', 'Bruno');
  setVote(room, 'fac-1', 5);
  setVote(room, 'p-2', 3);
  reveal(room, 'fac-1');
  setVote(room, 'fac-1', 8); // edita → editedAfterReveal = true

  const view = serializeRoom(room, 'fac-1');
  const ana = view.participants.find((p) => p.clientId === 'fac-1');
  const bruno = view.participants.find((p) => p.clientId === 'p-2');
  assert.equal(ana.editedAfterReveal, true);
  assert.equal(bruno.editedAfterReveal, false);
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: falha porque `editedAfterReveal` não está no payload.

- [ ] **Step 3: Atualizar `serializeRoom` em `server/rooms.js`**

Localizar o map de `participants` dentro de `serializeRoom` e adicionar o campo:

```js
const participants = [...room.participants.entries()].map(([clientId, p]) => ({
  clientId,
  name: p.name,
  connected: p.connected,
  hasVoted: p.vote !== null,
  vote: room.revealed || clientId === viewerId ? p.vote : null,
  editedAfterReveal: !!p.editedAfterReveal,
}));
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

```bash
node --test test/rooms.test.js 2>&1 | grep -E "✖|✔|fail|pass"
```

Esperado: todos passam.

- [ ] **Step 5: Commit**

```bash
git add server/rooms.js test/rooms.test.js
git commit -m "feat: expose editedAfterReveal per participant in serializeRoom"
```

---

### Task 4: Cliente — edição de voto pós-reveal + badge visual

**Files:**
- Modify: `public/app.js` (funções `renderHand` e `renderTable`)
- Modify: `public/styles.css` (classe `.edited`)

- [ ] **Step 1: Remover o guard `if (state.revealed) return` de `renderHand`**

Localizar em `public/app.js`:

```js
function renderHand() {
  els.hand.innerHTML = '';
  if (state.revealed) return; // no voting while revealed
  const selected = myVote();
```

Substituir por:

```js
function renderHand() {
  els.hand.innerHTML = '';
  const selected = myVote();
```

Isso faz a mão aparecer mesmo após reveal, permitindo que o participante clique em outra carta.

- [ ] **Step 2: Adicionar badge `.edited` em `renderTable`**

Localizar em `public/app.js` o bloco dentro de `renderTable` que monta a carta `mini`:

```js
    if (state.revealed) {
      mini.className = 'mini face';
      mini.textContent = p.vote === null ? '–' : p.vote;
    } else if (p.hasVoted) {
```

Substituir por:

```js
    if (state.revealed) {
      mini.className = 'mini face' + (p.editedAfterReveal ? ' edited' : '');
      mini.textContent = p.vote === null ? '–' : p.vote;
    } else if (p.hasVoted) {
```

- [ ] **Step 3: Adicionar estilo `.edited` em `public/styles.css`**

Localizar a linha `.save-confirm { ... }` e adicionar após ela:

```css
.mini.edited { outline: 2px dashed #f5a623; outline-offset: 2px; }
```

- [ ] **Step 4: Verificar manualmente no browser**

Iniciar o servidor:

```bash
node server/index.js
```

1. Abrir duas abas em `http://localhost:3000`
2. Criar sala, entrar com dois usuários
3. Ambos votam → facilitador revela
4. Um participante clica em outra carta → confirmar que a carta na mesa aparece com borda tracejada laranja
5. Confirmar que as estatísticas (média, mediana) atualizam para todos

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/styles.css
git commit -m "feat: allow vote edit after reveal with dashed-orange badge on edited card"
```

---

### Task 5: Cliente — dois botões no `renderActions`

**Files:**
- Modify: `public/app.js` (função `renderActions`)

- [ ] **Step 1: Substituir o único botão por dois botões quando `state.revealed`**

Localizar em `public/app.js` a função `renderActions` completa:

```js
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
```

Substituir por:

```js
function renderActions() {
  els.actions.innerHTML = '';
  els.hint.textContent = '';
  if (!isFacilitator()) {
    els.hint.textContent = 'Aguardando o facilitador 👑 controlar a rodada.';
    return;
  }
  if (state.revealed) {
    const btnReVote = document.createElement('button');
    btnReVote.className = 'btn';
    btnReVote.textContent = 'Re-votar mesma tarefa';
    btnReVote.addEventListener('click', () => socket.emit('newRound'));
    els.actions.appendChild(btnReVote);

    const btnNewTask = document.createElement('button');
    btnNewTask.className = 'btn primary';
    btnNewTask.textContent = 'Nova tarefa';
    btnNewTask.addEventListener('click', () => socket.emit('newTask'));
    els.actions.appendChild(btnNewTask);
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = 'Revelar votos';
    btn.addEventListener('click', () => socket.emit('reveal'));
    els.actions.appendChild(btn);
  }
}
```

- [ ] **Step 2: Verificar manualmente no browser**

1. Com o servidor rodando, criar sala e revelar votos
2. Confirmar que aparecem dois botões: "Re-votar mesma tarefa" e "Nova tarefa"
3. Clicar "Re-votar mesma tarefa" → título preservado, votos limpos, volta ao estado de votação
4. Votar, revelar, clicar "Nova tarefa" → título limpo, votos limpos, volta ao estado de votação

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: split new-round button into Re-votar mesma tarefa and Nova tarefa"
```

---

### Task 6: Teste de integração — edição pós-reveal atualiza stats para todos

**Files:**
- Modify: `test/integration.test.js`

- [ ] **Step 1: Escrever o teste de integração**

Adicionar ao final de `test/integration.test.js`:

```js
test('9. post-reveal vote edit updates stats for all participants', async () => {
  const code = await createRoom('A');
  const sockA = connectClient();
  const sockB = connectClient();

  try {
    sockA.emit('joinRoom', { code, name: 'Alice', clientId: 'A' });
    await waitForRoomState(sockA, (s) => s.participants.some((p) => p.clientId === 'A'));

    sockB.emit('joinRoom', { code, name: 'Bruno', clientId: 'B' });
    await waitForRoomState(sockA, (s) => s.participants.length === 2);

    sockA.emit('vote', { value: 5 });
    sockB.emit('vote', { value: 3 });
    await waitForRoomState(sockA, (s) => s.participants.every((p) => p.hasVoted));

    sockA.emit('reveal');
    await waitForRoomState(sockA, (s) => s.revealed);

    // Bruno edits his vote after reveal
    sockB.emit('vote', { value: 5 });
    const stateAfterEdit = await waitForRoomState(sockA, (s) => {
      const bruno = s.participants.find((p) => p.clientId === 'B');
      return bruno && bruno.editedAfterReveal === true;
    });

    // Stats should reflect the new vote (5 and 5 → average 5, consensus)
    assert.equal(stateAfterEdit.stats.average, 5);
    assert.equal(stateAfterEdit.consensus, 'consensus');

    const bruno = stateAfterEdit.participants.find((p) => p.clientId === 'B');
    assert.equal(bruno.editedAfterReveal, true);
  } finally {
    sockA.disconnect();
    sockB.disconnect();
  }
});
```

- [ ] **Step 2: Rodar a suite completa e confirmar que tudo passa**

```bash
node --test test/*.test.js 2>&1 | tail -12
```

Esperado: todos os testes passam (o número total aumenta em 1).

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.js
git commit -m "test: integration test for post-reveal vote edit updating stats in real time"
```

---

### Task 7: Verificação final

- [ ] **Step 1: Rodar a suite completa uma última vez**

```bash
node --test test/*.test.js 2>&1 | tail -12
```

Esperado: zero falhas.

- [ ] **Step 2: Smoke test manual completo**

1. Iniciar o servidor: `node server/index.js`
2. Abrir duas abas
3. Criar sala, dois usuários entram, ambos votam, facilitador revela
4. Participante edita voto → borda tracejada laranja aparece na carta da mesa para todos → stats atualizam
5. Facilitador clica "Re-votar mesma tarefa" → título preservado, votos limpos
6. Ambos votam novamente, facilitador revela
7. Facilitador clica "Nova tarefa" → título limpo, votos limpos

- [ ] **Step 3: Commit final de consolidação (se houver arquivos pendentes)**

```bash
git status
# Se limpo, não há nada a commitar.
```

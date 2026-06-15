# Design: Edição de voto pós-revelação + botões de nova rodada

**Data:** 2026-06-15
**Status:** Aprovado

---

## Contexto

Após o facilitador revelar os votos, os participantes não conseguem alterar sua estimativa sem que o facilitador inicie uma nova rodada. Isso força conversas desnecessárias quando alguém só quer ajustar um voto mal-digitado ou alinhar com o grupo sem uma rodada completamente nova.

Além disso, o botão "Nova rodada" atual tem semântica ambígua: não fica claro se mantém o título da tarefa ou apaga tudo.

---

## Requisitos

1. Após a revelação, qualquer participante pode alterar seu voto.
2. Voto alterado pós-revelação exibe sinalização visual para todos.
3. Estatísticas (média, mediana, modo, consenso) recalculam em tempo real quando um voto é editado.
4. Facilitador vê dois botões distintos após a revelação:
   - **Re-votar mesma tarefa** — limpa votos, mantém `storyTitle`, volta ao estado de votação.
   - **Nova tarefa** — limpa votos e `storyTitle`, volta ao estado de votação.
5. A flag de edição é limpa ao iniciar qualquer nova rodada.

---

## Arquitetura

### Servidor (`server/rooms.js`)

**`setVote`** — remover o guard `if (room.revealed) return`. Quando `room.revealed === true` e o participante já tinha voto, setar `p.editedAfterReveal = true`. Quando a rodada reinicia (`newRound` / `newTask`), zerar a flag junto com o voto.

**`newRound`** (existente) — comportamento atual mantido: limpa votos, `revealed = false`, mantém `storyTitle`. Renomeado semanticamente apenas na UI.

**`newTask`** (novo) — igual a `newRound` + `room.storyTitle = ''`. Protegido por `clientId !== room.facilitatorId`.

**`serializeRoom`** — expor `editedAfterReveal` por participante no array `participants`.

### Servidor (`server/index.js`)

Adicionar handler `socket.on('newTask', ...)` análogo ao `newRound`.

### Cliente (`public/app.js`)

**`renderHand`** — remover o guard `if (state.revealed) return`. Manter renderização da mão após revelação para permitir edição.

**`renderTable`** — quando `state.revealed && p.editedAfterReveal`, adicionar classe CSS `edited` na carta da mesa.

**`renderActions`** — substituir o único botão "Nova rodada" por dois botões quando `state.revealed`:
- "Re-votar mesma tarefa" → `socket.emit('newRound')`
- "Nova tarefa" → `socket.emit('newTask')`

### Cliente (`public/styles.css`)

Classe `.edited` na carta da mesa: badge ou borda de destaque (ex: borda amarela tracejada) indicando que o voto foi alterado após revelação.

---

## Fluxo de dados

```
[Participante clica carta após reveal]
  → socket.emit('vote', { value })
  → servidor: setVote seta p.vote + p.editedAfterReveal = true
  → broadcastRoom: serializeRoom inclui editedAfterReveal = true
  → todos os clientes recebem roomState atualizado
  → render() → renderTable mostra badge "editado" na carta
              → renderResult recalcula stats com novo voto
```

```
[Facilitador clica "Re-votar mesma tarefa"]
  → socket.emit('newRound')
  → servidor: revealed=false, votos=null, editedAfterReveal=false, storyTitle mantido
  → broadcastRoom → todos voltam ao estado de votação com título preservado

[Facilitador clica "Nova tarefa"]
  → socket.emit('newTask')
  → servidor: igual ao newRound + storyTitle=''
  → broadcastRoom → todos voltam ao estado de votação com título limpo
```

---

## Tratamento de casos-limite

- **Voto editado → facilitador salva estimativa:** o save usa `voteSnapshot` no momento do clique, capturando os votos editados. Comportamento aceitável (valor final é sempre acordado verbalmente).
- **Participante edita antes de ter votado (vote === null → algum valor):** `editedAfterReveal` NÃO é setado neste caso, pois não houve edição, houve primeiro voto. Apenas muda de um valor para outro valor conta como edição.
- **`newTask` por não-facilitador:** ignorado no servidor (mesmo guard do `newRound`).

---

## Testes

- `setVote` após `reveal` atualiza o voto e seta `editedAfterReveal = true`.
- `setVote` após `reveal` sem voto anterior NÃO seta `editedAfterReveal`.
- `newRound` zera `editedAfterReveal`.
- `newTask` zera `editedAfterReveal` e limpa `storyTitle`.
- `newTask` ignorado por não-facilitador.
- `serializeRoom` expõe `editedAfterReveal` por participante.
- Teste de integração: voto editado pós-reveal atualiza stats em tempo real para todos.

# Scrum Poker V2 — Persistência (Design)

**Data:** 2026-06-05
**Status:** Aprovado para planejamento
**Base:** estende o V1 ([2026-06-01-scrum-poker-design.md](2026-06-01-scrum-poker-design.md))

## Objetivo

Adicionar persistência ao Scrum Poker para que: (1) o estado vivo de uma sala
**sobreviva a restart/sleep** do servidor; (2) as estimativas finais sejam gravadas
num **histórico de longo prazo**; e (3) a **identidade dos participantes** persista
entre sessões. Hoje todo o estado é em memória e some a cada restart.

## Decisões do brainstorming

| Tema | Decisão |
|------|---------|
| O que persistir | Estado vivo da sala, histórico de estimativas, identidade dos participantes |
| Fora de escopo | Salas fixas/reutilizáveis por time |
| Retenção | Sala expira por inatividade (default 24h, configurável); histórico mantido indefinidamente |
| TTL configurável | Env var `ROOM_TTL_HOURS` (default `24`) |
| Banco | Turso / libSQL (`@libsql/client`) — SQLite hospedado, free tier, persiste no Render free |
| Dev/testes | URL `file:` local (offline); `file::memory:` nos testes |
| Gravar histórico | Facilitador confirma um **valor final** (carta do deck) e salva — não é automático |
| Valor final | Restrito às cartas do deck (validado no servidor) |
| Visualização do histórico | Sidebar show/hide na sala, visível a **todos** e atualizada em tempo real; + página por código acessível após a sala expirar |

## Arquitetura: write-through + reload no boot

O hot path do tempo real continua **em memória** (rápido para broadcast). A lógica pura
de `server/rooms.js` permanece intacta (opera sobre objetos de sala em memória). Em volta
dela, adicionamos uma camada de persistência:

- **Write-through:** a cada mutação de estado (`joinRoom`, `vote`, `reveal`, `newRound`,
  `setStory`, `saveEstimate`, `disconnect`), o servidor espelha a mudança no banco.
- **Reload no boot:** ao iniciar, o servidor carrega da base todas as salas **ativas**
  (não expiradas) para a memória. Participantes voltam com `connected = false` (vão
  reconectar via socket); os votos são preservados. Assim a sala "ressuscita" após restart.
- **`last_activity_at`** é atualizado em toda mutação e governa a expiração.

### Módulos novos (responsabilidades isoladas)

- `server/db.js` — cria/abre a conexão libSQL a partir das envs e roda a criação do schema
  (`CREATE TABLE IF NOT EXISTS`) no boot. Exporta o client.
- `server/repository.js` — funções puras de leitura/escrita SQL (recebem dados, executam
  queries). Sem conhecimento de sockets. Testável com um banco em arquivo/memória.
- `server/persistence.js` — orquestra o write-through (mapeia mutações → chamadas do
  repository) e expõe `loadActiveRooms(store)` usado no boot. Chamado pelo `index.js`
  ao lado das mutações em memória.

`server/config.js` — centraliza configuração derivada de env (`PORT`, `ROOM_TTL_HOURS`,
`DATABASE_URL`, `DATABASE_AUTH_TOKEN`), com defaults para dev.

## Schema (libSQL / SQLite)

```sql
CREATE TABLE IF NOT EXISTS rooms (
  code             TEXT PRIMARY KEY,
  facilitator_id   TEXT NOT NULL,
  story_title      TEXT NOT NULL DEFAULT '',
  revealed         INTEGER NOT NULL DEFAULT 0,   -- 0/1
  created_at       INTEGER NOT NULL,             -- epoch ms
  last_activity_at INTEGER NOT NULL              -- epoch ms; governa expiração
);

CREATE TABLE IF NOT EXISTS participants (
  room_code  TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  vote       TEXT,                                -- cobre números e '?'/'☕'; NULL = sem voto
  connected  INTEGER NOT NULL DEFAULT 0,          -- 0/1 (sempre 0 ao recarregar no boot)
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (room_code, client_id),
  FOREIGN KEY (room_code) REFERENCES rooms(code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS estimates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code    TEXT NOT NULL,
  story_title  TEXT NOT NULL,
  final_value  TEXT NOT NULL,                     -- carta do deck escolhida pelo facilitador
  average      REAL,                              -- snapshot das estatísticas no momento do salvar
  median       REAL,
  mode         TEXT,
  consensus    TEXT,                              -- 'consensus' | 'close' | 'diverge' | NULL
  votes_json   TEXT NOT NULL,                     -- [{name, vote}, ...] no momento do salvar
  voter_count  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_estimates_room ON estimates(room_code, created_at);
```

Notas:
- **Identidade** fica embutida em `participants` (nome por sala+cliente) e nos snapshots
  de `estimates.votes_json` (nomes dos votantes). Não há tabela global de pessoas (YAGNI).
- `estimates` **independe** do ciclo de vida da sala: quando a sala expira e suas linhas em
  `rooms`/`participants` são removidas, os `estimates` permanecem (consultáveis por código).
- O voto é gravado como TEXT; ao recarregar, valores numéricos são convertidos de volta a
  número para bater com o deck (`'5'` → `5`, mas `'?'`/`'☕'` permanecem string).

## Fluxo: salvar estimativa

1. Facilitador clica **Revelar** (igual ao V1). As estatísticas e o consenso aparecem.
2. Aparece um seletor de **valor final** usando o próprio deck (cartas clicáveis),
   pré-selecionando a carta **mais votada** (mode). Apenas o facilitador vê/usa o seletor.
3. Facilitador clica **Salvar estimativa** → emite `saveEstimate { finalValue }`.
4. Servidor (somente facilitador) valida que `finalValue` está no deck, monta o snapshot
   (story_title atual, estatísticas atuais, `votes_json` dos votos revelados, contagem) e
   faz `INSERT` em `estimates`. Em seguida faz broadcast do `roomState` atualizado (agora
   com a lista de histórico), para a sidebar de todos refletir o novo item.
5. **Nova rodada** continua limpando os votos e o `revealed` (salvar é opcional e separado;
   o facilitador pode salvar e então iniciar nova rodada, ou pular o salvar).

## Histórico na sala (sidebar) + página por código

- **Sidebar show/hide** dentro da sala, **visível a todos**: lista as estimativas salvas da
  sala (história · valor final · data), em ordem decrescente. Atualiza em tempo real porque
  o `roomState` passa a incluir `history` (array de estimativas da sala). Um botão alterna
  exibir/ocultar a sidebar (estado só no cliente).
- **Página por código** `history.html?code=XXXX`: visão somente-leitura que consulta
  `GET /api/rooms/:code/estimates` e renderiza a mesma lista, **funcionando mesmo após a
  sala expirar** (pois os `estimates` permanecem). Inclui botão **copiar como CSV** para
  exportação. A sidebar na sala viva também oferece o mesmo export.

## Eventos e endpoints (mudanças sobre o V1)

**Socket — novo:**
- `saveEstimate { finalValue }` — facilitador grava a estimativa final (validado no servidor).

**`roomState` — campo novo:**
- `history: [{ id, storyTitle, finalValue, consensus, createdAt }]` — estimativas salvas da
  sala (resumo para a sidebar; o detalhe completo fica no `votes_json`/endpoint).

**REST — novo:**
- `GET /api/rooms/:code/estimates` — retorna o histórico completo da sala por código
  (inclui `votes_json` parseado), independente de a sala estar viva. Usado pela página por
  código e pelo export CSV.

Os demais eventos do V1 (`joinRoom`, `vote`, `reveal`, `newRound`, `setStory`,
`disconnect`, `roomState`, `errorMessage`) permanecem, agora com write-through.

## Retenção / expiração

- A varredura periódica (já existente) passa a expirar salas cujo `last_activity_at` seja
  mais antigo que `ROOM_TTL_HOURS` (default 24h): remove a sala da memória e deleta as
  linhas de `rooms`/`participants` (cascade). Substitui a regra do V1 de "5 min vazia" — a
  sala agora sobrevive a pausas, sleeps e restarts dentro da janela de TTL.
- `estimates` **nunca** são removidas automaticamente.
- A janela é configurável por `ROOM_TTL_HOURS` sem alteração de código.

## Configuração / env

| Env | Default (dev) | Produção |
|-----|---------------|----------|
| `PORT` | `3000` | fornecido pela plataforma |
| `ROOM_TTL_HOURS` | `24` | `24` (ajustável) |
| `DATABASE_URL` | `file:./data/scrum.db` | `libsql://<db>.turso.io` |
| `DATABASE_AUTH_TOKEN` | (vazio para `file:`) | token do Turso (secret) |

- `data/` (arquivo SQLite local de dev) entra no `.gitignore`.
- `render.yaml` ganha `DATABASE_URL` e `DATABASE_AUTH_TOKEN` como envVars marcadas para
  serem definidas no painel (secret), não commitadas.

## Testes

- **`repository`/`persistence`** (com `file::memory:` ou arquivo temporário):
  - criação de schema idempotente;
  - write-through por mutação (insert/update de `rooms` e `participants`, set/clear de voto,
    reveal, setStory, expiração);
  - `loadActiveRooms` reconstrói o estado em memória (votos preservados; `connected=false`);
  - `appendEstimate` grava o snapshot e a consulta por código retorna na ordem correta;
  - conversão de voto TEXT↔número no reload.
- **Integração de "restart"** (novo teste e2e): sobe servidor com DB temp → cria sala, vota,
  revela, salva estimativa → encerra → sobe **nova instância** com o mesmo DB → confirma que
  a sala recarrega com os votos e que o histórico está presente; reconexão de socket restaura
  o participante.
- **Integração existente** do V1 adaptada para usar um DB temp (`file::memory:`/arquivo).
- **Puros** `rooms.js`/`stats.js` permanecem inalterados.

## Impacto no V1 / refatorações pontuais

- `server/index.js` deixa de instanciar o store puramente em memória e passa a: inicializar
  `db` + schema, chamar `loadActiveRooms(store)` no boot, e invocar `persistence.*` ao lado
  de cada mutação. Ler `PORT`/`ROOM_TTL_HOURS` de `server/config.js`.
- `server/rooms.js` permanece puro; se necessário, expõe um helper para extrair o snapshot de
  votos (nome+voto) usado ao salvar uma estimativa, mantendo a lógica fora do `index.js`.
- Frontend: `public/room.html`/`app.js` ganham o seletor de valor final (facilitador) e a
  sidebar de histórico (todos); novo `public/history.html` + `history.js` para a página por
  código; `styles.css` ganha estilos da sidebar e do seletor.

## Fora de escopo (V2)

- Salas fixas/reutilizáveis por time (código/nome fixo).
- Contas de usuário / login.
- Edição/remoção de itens já gravados no histórico.
- Migrations versionadas (basta `CREATE TABLE IF NOT EXISTS` no boot).
- Escala horizontal multi-instância (o reload no boot assume uma única instância de servidor).

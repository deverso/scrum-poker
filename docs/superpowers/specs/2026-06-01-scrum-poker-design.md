# Scrum Poker — Design v1

**Data:** 2026-06-01
**Status:** Aprovado para planejamento

## Objetivo

Uma aplicação web simples de Scrum Poker (Planning Poker) para estimativa colaborativa
durante a planning de um time remoto/híbrido. Cada pessoa entra numa sala compartilhada
pelo navegador, vota em segredo, e todos os votos são revelados ao mesmo tempo para
evitar viés de ancoragem.

## Decisões do brainstorming

| Tema | Decisão |
|------|---------|
| Uso | Remoto — cada pessoa no seu dispositivo, sala em tempo real |
| Baralho | Fibonacci puro: `1, 2, 3, 5, 8, 13, 21, 34` + `?` + `☕` |
| Identificação | Só digitar um nome (sem cadastro/login). Sala por código/link |
| Facilitador | Quem cria a sala. Controla revelação/nova rodada/título. **Também vota** |
| Rodada inclui | Título da história, estatísticas na revelação, indicador de consenso |
| Histórico de sessão | Fora do escopo do v1 |
| Stack | Node.js + Express + Socket.IO; estado em memória (sem banco) |
| Hospedagem | Pronto para deploy em nuvem (Render/Railway/Fly.io) |

## Arquitetura

- **Servidor único Node.js**: Express serve o frontend estático e Socket.IO cuida da
  comunicação em tempo real.
- **Estado em memória**: um `Map` de salas no servidor. Sem banco de dados. Salas são
  **efêmeras** — removidas quando ficam vazias por um período de carência, ou ao
  reiniciar o servidor.
- **Frontend**: HTML/CSS/JS puro (vanilla) + cliente Socket.IO. Sem framework de UI.
  Uma página de entrada (home) e a tela da sala.
- **Deploy**: usa `process.env.PORT`; documentação de deploy no README.

## Modelo de dados (em memória)

```
Room {
  code:          string        // ex: "PLAY-7K2", gerado e usado no link
  facilitatorId: string        // clientId do facilitador
  storyTitle:    string        // o que está sendo estimado
  revealed:      boolean        // false durante votação, true após revelar
  deck:          [1,2,3,5,8,13,21,34,"?","☕"]
  participants:  Map<clientId, Participant>
}

Participant {
  name:      string
  vote:      (valor do deck) | null
  connected: boolean
}
```

- `clientId` é gerado no cliente e guardado em `localStorage`. Permite **reconexão**
  sem perder identidade/voto se a conexão cair (o socketId muda, o clientId não).

## Papéis

- **Facilitador** = criador da sala. Permissões exclusivas: revelar votos, iniciar nova
  rodada, editar o título da história. O facilitador **também participa votando**.
- **Promoção automática**: se o facilitador sai, o participante conectado mais antigo
  assume como facilitador.

## Fluxo do usuário

1. **Home**: opção "Criar sala" (gera código e torna o usuário facilitador) ou "Entrar"
   (informa código + nome).
2. **Votar**: cada participante clica numa carta → voto registrado em segredo. Os demais
   veem apenas a indicação "já votou" (✓), nunca o valor.
3. **Revelar** (só facilitador): cartas viram para cima. Exibe estatísticas e o indicador
   de consenso.
4. **Nova rodada** (só facilitador): limpa os votos, mantém ou edita o título, retorna à
   fase de votação.

## Estatísticas (na revelação)

Calculadas apenas sobre votos numéricos (cartas `?` e `☕` são excluídas do cálculo):

- **Média** (com 2 casas decimais)
- **Mediana**
- **Mais votada** (moda)
- **Intervalo** (mínimo–máximo)

## Indicador de consenso (3 níveis)

Baseado nos votos numéricos, considerando a posição dos valores na sequência do baralho:

- ✅ **Consenso** — todos votaram a mesma carta.
- 👍 **Próximo** — todos os votos estão em cartas adjacentes na sequência (ex: `5` e `8`).
- ⚠️ **Divergência** — há votos separados por mais de uma posição na sequência
  (ex: `2` e `21`); sinaliza que vale uma conversa antes de reestimar.

Se houver apenas votos não-numéricos (todos `?`/`☕`), não há indicador de consenso
numérico — apenas mostra as cartas.

## Eventos Socket.IO

**Cliente → servidor:**

- `joinRoom { code, name, clientId }` — entra ou reconecta numa sala.
- `vote { value }` — registra/atualiza o voto secreto.
- `reveal` — revela os votos (somente facilitador; validado no servidor).
- `newRound` — inicia nova rodada (somente facilitador).
- `setStory { title }` — define/edita o título (somente facilitador).

**Servidor → clientes:**

- `roomState { code, storyTitle, revealed, deck, facilitatorId, participants }` —
  enviado em broadcast a cada mudança. Enquanto `revealed = false`, os votos dos demais
  são **mascarados** (apenas um booleano "votou: sim/não"); o valor real só vai no
  payload quando `revealed = true`.
- `errorMessage { message }` — ex: código de sala inválido.

## Tratamento de erros e casos de borda

- **Código de sala inválido** → `errorMessage` exibido na home.
- **Autorização no servidor**: revelar, nova rodada e editar título são validados no
  servidor contra o `facilitatorId` — não dependem apenas da UI esconder os botões.
- **Mascaramento de votos**: o servidor nunca envia o valor do voto de outras pessoas
  antes da revelação.
- **Nomes repetidos**: permitidos (sem bloqueio).
- **Limpeza de salas vazias**: sala removida após um período de carência sem
  participantes conectados.
- **Reconexão**: ao reconectar com o mesmo `clientId`, o participante recupera seu lugar
  e voto na sala.

## Estrutura do projeto

```
scrum-poker/
├── server/
│   ├── index.js        # Express + Socket.IO (camada de transporte)
│   ├── rooms.js        # lógica pura de salas: criar/entrar/sair/votar/revelar
│   └── stats.js        # média/mediana/moda/intervalo + consenso (3 níveis)
├── public/
│   ├── index.html      # home: criar / entrar
│   ├── room.html       # tela da sala
│   ├── app.js          # cliente Socket.IO + renderização da UI
│   └── styles.css
├── test/               # testes unitários da lógica pura (rooms, stats)
├── package.json
└── README.md           # como rodar localmente + instruções de deploy
```

## Estratégia de testes

A lógica de negócio (`rooms.js`, `stats.js`) é mantida **pura e isolada dos sockets**,
permitindo testes unitários diretos:

- `stats.js`: cálculo de média/mediana/moda/intervalo; exclusão de `?`/`☕`; os 3 níveis
  de consenso; caso de votos só não-numéricos.
- `rooms.js`: criar sala, entrar/sair, registrar/atualizar voto, mascaramento antes da
  revelação, revelar, nova rodada (limpa votos), promoção de facilitador ao sair.

## Fora de escopo (v1)

- Contas de usuário / login.
- Histórico e exportação de sessões.
- Baralhos configuráveis (fixo em Fibonacci puro por enquanto).
- Persistência em banco de dados.
```

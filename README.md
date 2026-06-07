# 🃏 Scrum Poker

Estimativa colaborativa em tempo real para a planning do time. Cada pessoa entra
numa sala pelo navegador, vota em segredo com cartas de Fibonacci, e os votos são
revelados ao mesmo tempo — com estatísticas e indicador de consenso.

## Funcionalidades

- Salas em tempo real (Socket.IO), entrada só com o nome (sem cadastro).
- Baralho Fibonacci puro: `1, 2, 3, 5, 8, 13, 21, 34` + `?` e `☕`.
- Voto secreto até o facilitador revelar.
- Na revelação: média, mediana, mais votada, intervalo e consenso (3 níveis).
- Facilitador (quem cria a sala) controla revelar / nova rodada / título.

## Rodar localmente

```bash
npm install
npm start
# abra http://localhost:3000
```

Para testar com várias pessoas na mesma máquina, abra abas anônimas diferentes
(cada aba tem seu próprio `clientId`).

## Testes

```bash
npm test
```

Cobrem a lógica pura de estatísticas/consenso (`server/stats.js`) e de salas
(`server/rooms.js`).

## Persistência (V2)

As salas e o histórico de estimativas são persistidos em **libSQL/Turso** (SQLite
hospedado). O estado vivo das salas sobrevive a restart/sleep do servidor, e as
estimativas finais ficam guardadas a longo prazo.

### Variáveis de ambiente

| Env | Default (dev) | Produção |
|-----|---------------|----------|
| `DATABASE_URL` | `file:./data/scrum.db` | `libsql://<seu-db>.turso.io` |
| `DATABASE_AUTH_TOKEN` | (vazio para `file:`) | token do Turso |
| `ROOM_TTL_HOURS` | `24` | `24` (ajustável) |

Localmente, sem configurar nada, o app usa um arquivo SQLite em `data/scrum.db`
(ignorado pelo git). Crie um `.env` para sobrescrever — ele é carregado via
`--env-file-if-exists` pelo `npm start`.

### Turso (produção)

```bash
# instalar a CLI: https://docs.turso.tech/cli/installation
turso db create scrumpoker
turso db show scrumpoker --url        # -> DATABASE_URL (libsql://...)
turso db tokens create scrumpoker     # -> DATABASE_AUTH_TOKEN
```

As salas expiram após `ROOM_TTL_HOURS` de inatividade; o histórico de estimativas
é mantido indefinidamente e fica acessível por código em `/history.html?code=XXXX`.

## Deploy

A app usa `process.env.PORT`, então funciona direto em Render, Railway ou Fly.io.

- **Render:** o `render.yaml` (Blueprint) já define o serviço. Defina `DATABASE_URL`
  e `DATABASE_AUTH_TOKEN` no painel (Environment), **não** no `render.yaml`.
- **Railway:** detecta `package.json` e usa `npm start` automaticamente; configure
  as mesmas variáveis de ambiente.
- O `Procfile` (`web: node server/index.js`) cobre plataformas estilo Heroku.

> As salas vivem em memória para o tempo real, com write-through para o banco; ao
> reiniciar, o servidor recarrega as salas ativas (não expiradas) do banco. No plano
> free do Render o serviço dorme após inatividade — ao acordar, as salas dentro da
> janela de TTL são restauradas a partir do Turso.

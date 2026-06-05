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

## Deploy

A app usa `process.env.PORT`, então funciona direto em Render, Railway ou Fly.io.

- **Render:** novo Web Service → build `npm install` → start `npm start`.
- **Railway:** detecta `package.json` e usa `npm start` automaticamente.
- O `Procfile` (`web: node server/index.js`) cobre plataformas estilo Heroku.

> Estado em memória: as salas são efêmeras e somem ao reiniciar o servidor ou
> após ~5 min vazias. Para histórico/persistência, seria preciso um banco (fora
> do escopo do v1).

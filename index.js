const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const SUITS = ["♦", "♣", "♥", "♠"];
const VALUES = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];
const SUIT_RANK = { "♦": 0, "♣": 1, "♥": 2, "♠": 3 };
const VALUE_RANK = Object.fromEntries(VALUES.map((v, i) => [v, i]));
const FIVE_ORDER = ["straight","flush","full_house","four_of_a_kind","straight_flush"];
const COMBO_LABELS = {
  single:"Carte seule", pair:"Paire", triple:"Brelan",
  straight:"Suite", flush:"Couleur", full_house:"Full House",
  four_of_a_kind:"Carré", straight_flush:"Quinte Flush"
};

function cs(c) { return VALUE_RANK[c.value] * 4 + SUIT_RANK[c.suit]; }
function sortHand(h) { return [...h].sort((a, b) => cs(a) - cs(b)); }

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const v of VALUES) d.push({ suit: s, value: v });
  return d.sort(() => Math.random() - 0.5);
}

function detectCombo(cards) {
  if (cards.length === 1) return { type: "single", rank: cs(cards[0]) };
  if (cards.length === 2) {
    if (cards[0].value === cards[1].value) {
      const best = cards.reduce((a, b) => cs(a) > cs(b) ? a : b);
      return { type: "pair", rank: VALUE_RANK[cards[0].value] * 4 + SUIT_RANK[best.suit] };
    }
    return null;
  }
  if (cards.length === 3) {
    if (cards.every(c => c.value === cards[0].value)) {
      const best = cards.reduce((a, b) => cs(a) > cs(b) ? a : b);
      return { type: "triple", rank: VALUE_RANK[cards[0].value] * 4 + SUIT_RANK[best.suit] };
    }
    return null;
  }
  if (cards.length === 5) return detect5(cards);
  return null;
}

function detect5(cards) {
  const sorted = [...cards].sort((a, b) => cs(a) - cs(b));
  const vals = sorted.map(c => VALUE_RANK[c.value]);
  const suits = sorted.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = vals.every((v, i) => i === 0 || v === vals[i - 1] + 1);
  const vc = {}; vals.forEach(v => vc[v] = (vc[v] || 0) + 1);
  const counts = Object.values(vc).sort((a, b) => b - a);
  if (counts[0] === 4) {
    const qv = Object.keys(vc).find(v => vc[v] === 4);
    const qCards = sorted.filter(c => VALUE_RANK[c.value] === parseInt(qv));
    const best = qCards.reduce((a, b) => cs(a) > cs(b) ? a : b);
    return { type: "four_of_a_kind", rank: parseInt(qv) * 4 + SUIT_RANK[best.suit] + 80000 };
  }
  const best = sorted[sorted.length - 1];
  const rank = cs(best);
  if (isFlush && isStraight) return { type: "straight_flush", rank: rank + 100000 };
  if (counts[0] === 3 && counts[1] === 2) return { type: "full_house", rank: rank + 60000 };
  if (isFlush) return { type: "flush", rank: rank + 40000 };
  if (isStraight) return { type: "straight", rank: rank + 20000 };
  return null;
}

function canBeat(cur, att) {
  if (!cur) return true;
  if (FIVE_ORDER.includes(cur.type) && FIVE_ORDER.includes(att.type)) {
    const ci = FIVE_ORDER.indexOf(cur.type), ai = FIVE_ORDER.indexOf(att.type);
    return ai > ci || (ai === ci && att.rank > cur.rank);
  }
  if (cur.type !== att.type) return false;
  return att.rank > cur.rank;
}

// ── IA AMÉLIORÉE ─────────────────────────────────────────────────
// Stratégie : jouer le minimum nécessaire pour battre, garder les grosses cartes
function groupByValue(cards) {
  const g = {};
  cards.forEach(c => { if (!g[c.value]) g[c.value] = []; g[c.value].push(c); });
  return g;
}

function aiFindPlay(hand, combo, playersCardCounts, myIdx) {
  const sorted = sortHand(hand);
  const opponents = playersCardCounts.filter((_, i) => i !== myIdx);
  const minOpponentCards = Math.min(...opponents);
  const isUrgent = minOpponentCards <= 3; // un adversaire est proche de gagner

  // Pas de combo sur table : ouvrir avec la carte/combo la plus faible
  if (!combo) {
    // Si on a des paires ou brelans, les jouer en priorité pour vider la main
    const g = groupByValue(sorted);
    for (const v of VALUES) {
      if (g[v] && g[v].length >= 2) return g[v].slice(0, 2); // jouer une paire
    }
    return [sorted[0]]; // sinon la carte la plus faible
  }

  if (combo.type === "single") {
    const candidates = [];
    for (const c of sorted) {
      const cc = detectCombo([c]);
      if (cc && canBeat(combo, cc)) candidates.push({ cards: [c], rank: cc.rank });
    }
    if (candidates.length === 0) return null;
    // Si urgent, jouer le minimum pour battre
    // Sinon, si on a beaucoup de cartes fortes, passer pour économiser
    if (!isUrgent && candidates.length > 2 && VALUE_RANK[sorted[sorted.length-1].value] >= 10) {
      // Garder les grosses cartes, jouer le minimum
      return candidates[0].cards;
    }
    return candidates[0].cards; // toujours jouer le minimum pour battre
  }

  if (combo.type === "pair") {
    const g = groupByValue(sorted);
    const candidates = [];
    for (const v of VALUES) {
      if (g[v] && g[v].length >= 2) {
        const p = g[v].slice(0, 2);
        const cc = detectCombo(p);
        if (cc && canBeat(combo, cc)) candidates.push({ cards: p, rank: cc.rank });
      }
    }
    if (candidates.length === 0) return null;
    return candidates[0].cards; // jouer la paire minimale qui bat
  }

  if (combo.type === "triple") {
    const g = groupByValue(sorted);
    const candidates = [];
    for (const v of VALUES) {
      if (g[v] && g[v].length >= 3) {
        const t = g[v].slice(0, 3);
        const cc = detectCombo(t);
        if (cc && canBeat(combo, cc)) candidates.push({ cards: t, rank: cc.rank });
      }
    }
    if (candidates.length === 0) return null;
    return candidates[0].cards;
  }

  if (FIVE_ORDER.includes(combo.type)) {
    const candidates = [];
    for (let i = 0; i < sorted.length - 4; i++)
      for (let j = i+1; j < sorted.length - 3; j++)
        for (let k = j+1; k < sorted.length - 2; k++)
          for (let l = k+1; l < sorted.length - 1; l++)
            for (let m = l+1; m < sorted.length; m++) {
              const five = [sorted[i], sorted[j], sorted[k], sorted[l], sorted[m]];
              const cc = detect5(five);
              if (cc && canBeat(combo, cc)) candidates.push({ cards: five, rank: cc.rank });
            }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.rank - b.rank);
    // Si urgent, jouer la meilleure combo ; sinon la plus faible qui bat
    return isUrgent ? candidates[candidates.length - 1].cards : candidates[0].cards;
  }

  return null;
}

// ── SALONS ────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function dealCards(room) {
  const deck = createDeck();
  const hands = [[], [], [], []];
  deck.forEach((c, i) => hands[i % 4].push(c));
  room.players.forEach((p, i) => { p.hand = sortHand(hands[i]); });
  let first = 0;
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].hand.some(c => c.value === "3" && c.suit === "♦")) { first = i; break; }
  }
  return first;
}

function buildPublicState(room) {
  return {
    roomCode: room.code,
    round: room.round,
    curPlayer: room.curPlayer,
    curCombo: room.curCombo,
    lastBy: room.lastBy,
    passed: room.passed,
    tableCards: room.tableCards,
    log: room.log,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, cardCount: p.hand.length,
    })),
    phase: room.phase,
  };
}

function emitState(room) {
  room.players.forEach((p, idx) => {
    const state = { ...buildPublicState(room), myIndex: idx, myHand: p.hand };
    io.to(p.id).emit("game:state", state);
  });
}

function addLog(room, msg) {
  room.log = [msg, ...room.log].slice(0, 30);
}

function allPassed(room) {
  const { passed, lastBy, players } = room;
  if (lastBy === null) return false;
  return passed.every((v, i) => v || i === lastBy || players[i].hand.length === 0);
}

function nextTurn(room, fromIdx) {
  if (allPassed(room)) { newTrick(room); return; }
  const { players, passed } = room;
  let next = (fromIdx + 1) % players.length;
  let tries = 0;
  while (tries < players.length) {
    if (!passed[next] && players[next].hand.length > 0) break;
    next = (next + 1) % players.length;
    tries++;
  }
  if (tries >= players.length) { newTrick(room); return; }
  room.curPlayer = next;
  emitState(room);
}

function newTrick(room) {
  const winner = room.lastBy;
  if (winner === null) {
    room.curPlayer = room.players.findIndex(p => p.hand.length > 0);
  } else {
    addLog(room, `↩ ${room.players[winner].name} remporte le pli !`);
    room.curPlayer = winner;
  }
  room.curCombo = null;
  room.tableCards = [];
  room.passed = [false, false, false, false];
  emitState(room);
}

function endRound(room, winnerIdx) {
  const scores = room.players.map(p => p.hand.length);
  addLog(room, `🏆 ${room.players[winnerIdx].name} remporte la manche ${room.round} !`);
  room.players.forEach((p, i) => {
    if (scores[i] > 0) { addLog(room, `  ${p.name} +${scores[i]} pt`); p.score += scores[i]; }
  });
  if (room.round >= 7) { room.phase = "end"; emitState(room); return; }
  setTimeout(() => {
    room.round++;
    const first = dealCards(room);
    room.curPlayer = first;
    room.curCombo = null;
    room.lastBy = first;
    room.passed = [false, false, false, false];
    room.tableCards = [];
    addLog(room, `── Manche ${room.round} ── ${room.players[first].name} commence`);
    emitState(room);
    scheduleBotTurn(room);
  }, 1500);
}

// ── SOCKET.IO ─────────────────────────────────────────────────────
io.on("connection", (socket) => {

  socket.on("room:create", ({ playerName }) => {
    const code = generateCode();
    rooms[code] = {
      code, phase: "lobby", round: 1,
      curPlayer: 0, curCombo: null, lastBy: null,
      passed: [false, false, false, false],
      tableCards: [], log: [],
      players: [{ id: socket.id, name: playerName || "Joueur 1", hand: [], score: 0 }],
    };
    socket.join(code);
    socket.emit("room:joined", { code, playerIndex: 0 });
    io.to(code).emit("lobby:update", { code, players: rooms[code].players.map(p => ({ name: p.name })) });
  });

  socket.on("room:join", ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) { socket.emit("room:error", "Salon introuvable."); return; }
    if (room.phase !== "lobby") { socket.emit("room:error", "La partie a déjà commencé."); return; }
    if (room.players.length >= 4) { socket.emit("room:error", "Le salon est plein (4/4)."); return; }
    const idx = room.players.length;
    room.players.push({ id: socket.id, name: playerName || `Joueur ${idx + 1}`, hand: [], score: 0 });
    socket.join(code);
    socket.emit("room:joined", { code, playerIndex: idx });
    io.to(code).emit("lobby:update", { code, players: room.players.map(p => ({ name: p.name })) });
  });

  socket.on("game:start", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.players[0].id !== socket.id) { socket.emit("room:error", "Seul l'hôte peut lancer la partie."); return; }
    if (room.players.length < 2) { socket.emit("room:error", "Il faut au moins 2 joueurs."); return; }
    while (room.players.length < 4) {
      const botIdx = room.players.length;
      room.players.push({
        id: `bot_${botIdx}`,
        name: ["Renard 🦊", "Loup 🐺", "Lion 🦁"][botIdx - 1] || `Bot ${botIdx}`,
        hand: [], score: 0, isBot: true
      });
    }
    room.phase = "game";
    const first = dealCards(room);
    room.curPlayer = first;
    room.lastBy = first;
    addLog(room, `Manche 1 — ${room.players[first].name} commence avec le 3♦`);
    emitState(room);
    scheduleBotTurn(room);
  });

  socket.on("game:play", ({ code, cards }) => {
    const room = rooms[code];
    if (!room || room.phase !== "game") return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.curPlayer) return;
    const combo = detectCombo(cards);
    if (!combo || !canBeat(room.curCombo, combo)) return;
    room.players[playerIdx].hand = room.players[playerIdx].hand.filter(
      c => !cards.some(s => s.value === c.value && s.suit === c.suit)
    );
    room.curCombo = combo;
    room.lastBy = playerIdx;
    room.tableCards = cards;
    room.passed = [false, false, false, false];
    addLog(room, `🫵 ${room.players[playerIdx].name} : ${cards.map(c => c.value + c.suit).join(" ")} — ${COMBO_LABELS[combo.type]}`);
    if (room.players[playerIdx].hand.length === 0) { endRound(room, playerIdx); return; }
    nextTurn(room, playerIdx);
    scheduleBotTurn(room);
  });

  socket.on("game:pass", ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== "game") return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.curPlayer) return;
    if (!room.curCombo) { io.to(socket.id).emit("room:error", "Vous devez jouer une carte pour ouvrir le pli !"); return; }
    room.passed[playerIdx] = true;
    addLog(room, `⏭ ${room.players[playerIdx].name} passe.`);
    if (allPassed(room)) { newTrick(room); scheduleBotTurn(room); return; }
    nextTurn(room, playerIdx);
    scheduleBotTurn(room);
  });

  // Chat en partie
  socket.on("game:chat", ({ code, message }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const msg = message.trim().slice(0, 100); // max 100 caractères
    if (!msg) return;
    io.to(code).emit("game:chat", { name: player.name, message: msg, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        if (room.phase === "lobby") {
          room.players.splice(idx, 1);
          if (room.players.length === 0) { delete rooms[code]; }
          else { io.to(code).emit("lobby:update", { code, players: room.players.map(p => ({ name: p.name })) }); }
        } else {
          room.players[idx].id = `bot_${idx}`;
          room.players[idx].isBot = true;
          room.players[idx].name += " (bot)";
          addLog(room, `${room.players[idx].name} a quitté — remplacé par un bot`);
          emitState(room);
          if (room.curPlayer === idx) nextTurn(room, idx);
          scheduleBotTurn(room);
        }
      }
    }
  });
});

// ── BOT AMÉLIORÉ ─────────────────────────────────────────────────
function scheduleBotTurn(room) {
  if (room.phase !== "game") return;
  const cur = room.players[room.curPlayer];
  if (!cur || !cur.isBot) return;

  setTimeout(() => {
    if (room.phase !== "game") return;
    if (!room.players[room.curPlayer]?.isBot) return;

    const idx = room.curPlayer;
    const player = room.players[idx];
    const cardCounts = room.players.map(p => p.hand.length);

    const aiPlay = aiFindPlay(player.hand, room.curCombo, cardCounts, idx);
    const pc = aiPlay ? detectCombo(aiPlay) : null;

    if (!aiPlay || !pc || (room.curCombo && !canBeat(room.curCombo, pc))) {
      if (!room.curCombo) {
        // Doit ouvrir : jouer la carte la plus faible
        const fallback = [sortHand(player.hand)[0]];
        const fallbackCombo = detectCombo(fallback);
        if (fallbackCombo) {
          player.hand = player.hand.filter(c => !(c.value === fallback[0].value && c.suit === fallback[0].suit));
          room.curCombo = fallbackCombo;
          room.lastBy = idx;
          room.tableCards = fallback;
          room.passed = [false, false, false, false];
          addLog(room, `🤖 ${player.name} : ${fallback.map(c => c.value + c.suit).join(" ")} — ${COMBO_LABELS[fallbackCombo.type]}`);
          if (player.hand.length === 0) { endRound(room, idx); return; }
          nextTurn(room, idx);
          scheduleBotTurn(room);
          return;
        }
      }
      room.passed[idx] = true;
      addLog(room, `⏭ ${player.name} passe.`);
      if (allPassed(room)) { newTrick(room); scheduleBotTurn(room); return; }
      nextTurn(room, idx);
      scheduleBotTurn(room);
      return;
    }

    player.hand = player.hand.filter(c => !aiPlay.some(a => a.value === c.value && a.suit === c.suit));
    room.curCombo = pc;
    room.lastBy = idx;
    room.tableCards = aiPlay;
    room.passed = [false, false, false, false];
    addLog(room, `🤖 ${player.name} : ${aiPlay.map(c => c.value + c.suit).join(" ")} — ${COMBO_LABELS[pc.type]}`);
    if (player.hand.length === 0) { endRound(room, idx); return; }
    nextTurn(room, idx);
    scheduleBotTurn(room);
  }, 900);
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", rooms: Object.keys(rooms).length }));

// Route pour vérifier qu'un salon existe (pour les liens d'invitation)
app.get("/room/:code", (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.json({ exists: false });
  res.json({
    exists: true,
    phase: room.phase,
    playerCount: room.players.filter(p => !p.isBot).length,
    isFull: room.players.filter(p => !p.isBot).length >= 4,
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`✅ Serveur démarré sur le port ${PORT}`));

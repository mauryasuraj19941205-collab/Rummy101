const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// index.html is in the repository root.
app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 8;
const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const rooms = new Map();

function send(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function makeId() {
  return crypto.randomBytes(9).toString("base64url");
}

function makeRoomCode() {
  let code;

  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));

  return code;
}

function rankValue(rank) {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return Number(rank);
}

function pointValue(rank) {
  return ["A", "J", "Q", "K"].includes(rank)
    ? 10
    : Number(rank);
}

function shuffledDeck() {
  const deck = [];

  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({
          suit,
          rank,
          id: makeId()
        });
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({
      suit: "★",
      rank: "J",
      id: makeId()
    });
  }

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function pureSequence(group) {
  if (group.length < 3) return false;
  if (group.some(c => c.suit === "★")) return false;

  const cards = [...group].sort(
    (a, b) => rankValue(a.rank) - rankValue(b.rank)
  );

  if (new Set(cards.map(c => c.suit)).size !== 1) {
    return false;
  }

  for (let i = 1; i < cards.length; i++) {
    if (
      rankValue(cards[i].rank) !==
      rankValue(cards[i - 1].rank) + 1
    ) {
      return false;
    }
  }

  return true;
}

function sequence(group) {
  if (group.length < 3) return false;

  const jokers = group.filter(c => c.suit === "★").length;

  const normal = group
    .filter(c => c.suit !== "★")
    .sort((a, b) => rankValue(a.rank) - rankValue(b.rank));

  if (!normal.length) return false;

  if (new Set(normal.map(c => c.suit)).size !== 1) {
    return false;
  }

  let gaps = 0;

  for (let i = 1; i < normal.length; i++) {
    const diff =
      rankValue(normal[i].rank) -
      rankValue(normal[i - 1].rank);

    if (diff <= 0) return false;

    gaps += diff - 1;
  }

  return gaps <= jokers &&
    normal.length + jokers >= 3;
}

function setGroup(group) {
  const normal = group.filter(c => c.suit !== "★");

  if (group.length < 3 || group.length > 4) {
    return false;
  }

  if (new Set(normal.map(c => c.rank)).size !== 1) {
    return false;
  }

  return new Set(normal.map(c => c.suit)).size === normal.length;
}

function validDeclaration(hand) {
  if (hand.length !== 13) return false;

  function search(remaining, groups) {
    if (remaining.length === 0) {
      return (
        groups.filter(sequence).length >= 2 &&
        groups.some(pureSequence)
      );
    }

    for (
      let mask = 1;
      mask < (1 << remaining.length);
      mask++
    ) {
      let count = 0;

      for (let x = mask; x; x >>= 1) {
        count += x & 1;
      }

      if (count < 3 || count > 4) continue;

      const group = [];
      const rest = [];

      remaining.forEach((card, i) => {
        if (mask & (1 << i)) {
          group.push(card);
        } else {
          rest.push(card);
        }
      });

      if (sequence(group) || setGroup(group)) {
        if (search(rest, groups.concat([group]))) {
          return true;
        }
      }
    }

    return false;
  }

  return search(hand, []);
}

function handScore(hand) {
  return hand.reduce(
    (sum, card) =>
      sum + (card.suit === "★" ? 0 : pointValue(card.rank)),
    0
  );
}

function activePlayers(room) {
  return room.players.filter(p => !p.out);
}

function publicState(room) {
  return {
    code: room.code,
    started: room.started,
    round: room.round,
    turn: room.turn,

    discard: room.discard.at(-1) || null,

    players: room.players.map((p, seat) => ({
      seat,
      name: p.name,
      score: p.score,
      ready: p.ready,
      out: p.out,
      connected: !!p.ws,
      cards:
        room.started && !p.out
          ? p.hand.length
          : 0
    }))
  };
}

function broadcast(room, message) {
  for (const player of room.players) {
    send(player.ws, message);
  }
}

function broadcastState(room) {
  broadcast(room, {
    type: "state",
    state: publicState(room)
  });
}

function sendHand(player, room) {
  send(player.ws, {
    type: "hand",

    hand:
      room.started && !player.out
        ? player.hand
        : [],

    drawn: !!player.drawn,

    canDraw:
      room.started &&
      room.turn === room.players.indexOf(player) &&
      !player.drawn &&
      !player.out
  });
}

function sendFullState(player, room) {
  send(player.ws, {
    type: "joined",
    code: room.code,
    sessionId: player.sessionId,
    resumed: true
  });

  send(player.ws, {
    type: "state",
    state: publicState(room)
  });

  sendHand(player, room);
}

function refillDeck(room) {
  if (room.deck.length > 0) {
    return true;
  }

  if (room.discard.length <= 1) {
    return false;
  }

  const top = room.discard.at(-1);

  room.deck = room.discard.slice(0, -1);
  room.discard = [top];

  for (let i = room.deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [room.deck[i], room.deck[j]] =
      [room.deck[j], room.deck[i]];
  }

  return room.deck.length > 0;
}

function startGame(room) {
  room.deck = shuffledDeck();
  room.discard = [];
  room.started = true;
  room.round = Math.max(1, room.round);

  for (const player of room.players) {
    player.hand = [];
    player.drawn = false;
  }

  for (let i = 0; i < 13; i++) {
    for (const player of activePlayers(room)) {
      player.hand.push(room.deck.pop());
    }
  }

  room.discard.push(room.deck.pop());

  room.turn =
    activePlayers(room).length
      ? room.players.indexOf(activePlayers(room)[0])
      : 0;

  for (const player of room.players) {
    sendHand(player, room);
  }

  broadcastState(room);
}

function nextTurn(room) {
  if (!room.players.length) return;

  let index = room.turn;

  for (let i = 0; i < room.players.length; i++) {
    index = (index + 1) % room.players.length;

    const player = room.players[index];

    if (!player.out) {
      room.turn = index;
      player.drawn = false;
      break;
    }
  }

  for (const player of room.players) {
    sendHand(player, room);
  }

  broadcastState(room);
}

function finishRound(room, winner) {
  for (const player of activePlayers(room)) {
    player.score +=
      player === winner
        ? 0
        : handScore(player.hand);

    if (player.score >= 101) {
      player.out = true;
    }

    player.ready = false;
    player.drawn = false;
  }

  broadcast(room, {
    type: "round_end",
    winner: winner.name,

    scores: room.players.map(p => ({
      name: p.name,
      score: p.score,
      out: p.out
    }))
  });

  const remaining = activePlayers(room);

  if (remaining.length <= 1) {
    room.started = false;

    broadcast(room, {
      type: "match_end",
      winner:
        remaining[0]?.name ||
        winner.name
    });

    broadcastState(room);
    return;
  }

  room.started = false;
  room.round += 1;
  room.turn = room.players.indexOf(remaining[0]);

  for (const player of room.players) {
    player.hand = [];
  }

  broadcastState(room);

  for (const player of room.players) {
    sendHand(player, room);
  }
}

function disconnectPlayer(room, player) {
  player.ws = null;
  player.disconnectedAt = Date.now();

  broadcastState(room);

  clearTimeout(player.reconnectTimer);

  player.reconnectTimer = setTimeout(() => {
    if (player.ws) return;

    const index = room.players.indexOf(player);

    if (index === -1) return;

    const wasTurn = room.turn === index;

    room.players.splice(index, 1);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (wasTurn && room.started) {
      room.turn = index % room.players.length;
    } else if (room.turn > index) {
      room.turn -= 1;
    }

    broadcastState(room);

    for (const p of room.players) {
      sendHand(p, room);
    }
  }, RECONNECT_GRACE_MS);
}

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let room = null;
  let player = null;

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ---------- RESUME AFTER REFRESH / DISCONNECT ----------

    if (msg.type === "resume") {
      const code =
        String(msg.code || "")
          .trim()
          .toUpperCase();

      const found = rooms.get(code);

      const sessionId =
        String(msg.sessionId || "");

      const foundPlayer =
        found?.players.find(
          p => p.sessionId === sessionId
        );

      if (!found || !foundPlayer) {
        return send(ws, {
          type: "error",
          message:
            "Session expired. Please join the room again."
        });
      }

      room = found;
      player = foundPlayer;

      clearTimeout(player.reconnectTimer);

      player.reconnectTimer = null;
      player.ws = ws;
      player.disconnectedAt = null;

      sendFullState(player, room);
      broadcastState(room);

      return;
    }

    // ---------- CREATE ROOM ----------

    if (msg.type === "create") {
      const name =
        String(msg.name || "Player")
          .trim()
          .slice(0, 18) ||
        "Player";

      room = {
        code: makeRoomCode(),
        players: [],
        started: false,
        round: 1,
        turn: 0,
        deck: [],
        discard: []
      };

      player = {
        sessionId: makeId(),
        name,
        ws,
        score: 0,
        ready: false,
        out: false,
        hand: [],
        drawn: false,
        reconnectTimer: null,
        disconnectedAt: null
      };

      room.players.push(player);
      rooms.set(room.code, room);

      send(ws, {
        type: "joined",
        code: room.code,
        sessionId: player.sessionId,
        resumed: false
      });

      broadcastState(room);
      return;
    }

    // ---------- JOIN ROOM ----------

    if (msg.type === "join") {
      const code =
        String(msg.code || "")
          .trim()
          .toUpperCase();

      room = rooms.get(code);

      if (
        !room ||
        room.started ||
        room.players.length >= MAX_PLAYERS
      ) {
        return send(ws, {
          type: "error",
          message:
            "Room unavailable or game already started."
        });
      }

      const name =
        String(msg.name || "Player")
          .trim()
          .slice(0, 18) ||
        "Player";

      player = {
        sessionId: makeId(),
        name,
        ws,
        score: 0,
        ready: false,
        out: false,
        hand: [],
        drawn: false,
        reconnectTimer: null,
        disconnectedAt: null
      };

      room.players.push(player);

      send(ws, {
        type: "joined",
        code: room.code,
        sessionId: player.sessionId,
        resumed: false
      });

      broadcastState(room);
      return;
    }

    if (!room || !player) return;

    // ---------- READY ----------

    if (msg.type === "ready") {
      if (room.started || player.out) return;

      player.ready = !!msg.value;

      const active = activePlayers(room);

      if (
        active.length >= 2 &&
        active.every(p => p.ready)
      ) {
        startGame(room);
      } else {
        broadcastState(room);
      }

      return;
    }

    // ---------- DRAW ----------

    if (msg.type === "draw") {
      const index = room.players.indexOf(player);

      if (
        !room.started ||
        room.turn !== index ||
        player.out ||
        player.drawn
      ) {
        return;
      }

      if (!refillDeck(room)) {
        return send(player.ws, {
          type: "error",
          message: "No cards left to draw."
        });
      }

      player.hand.push(room.deck.pop());
      player.drawn = true;

      sendHand(player, room);
      broadcastState(room);

      return;
    }

    // ---------- DISCARD ----------

    if (msg.type === "discard") {
      const index = room.players.indexOf(player);

      if (
        !room.started ||
        room.turn !== index ||
        player.out ||
        !player.drawn
      ) {
        return;
      }

      const cardIndex = Number(msg.index);

      if (
        !Number.isInteger(cardIndex) ||
        cardIndex < 0 ||
        cardIndex >= player.hand.length
      ) {
        return send(player.ws, {
          type: "error",
          message:
            "Select a valid card to discard."
        });
      }

      const [card] =
        player.hand.splice(cardIndex, 1);

      room.discard.push(card);

      player.drawn = false;

      // Empty hand = round win.
      if (player.hand.length === 0) {
        finishRound(room, player);
        return;
      }

      nextTurn(room);
      return;
    }

    // ---------- DECLARE ----------

    if (msg.type === "declare") {
      const index = room.players.indexOf(player);

      if (
        !room.started ||
        room.turn !== index ||
        player.out ||
        player.drawn
      ) {
        return;
      }

      if (!validDeclaration(player.hand)) {
        return send(player.ws, {
          type: "error",
          message:
            "Invalid declaration. Need 2 sequences, including 1 pure sequence."
        });
      }

      finishRound(room, player);
      return;
    }

    // ---------- CHAT ----------

    if (msg.type === "chat") {
      const text =
        String(msg.text || "")
          .trim()
          .slice(0, 160);

      if (text) {
        broadcast(room, {
          type: "chat",
          name: player.name,
          text
        });
      }
    }
  });

  ws.on("close", () => {
    if (
      room &&
      player &&
      player.ws === ws
    ) {
      disconnectPlayer(room, player);
    }
  });
});

// ---------- WEBSOCKET HEARTBEAT ----------

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

wss.on("close", () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log(
    `Rummy 101 listening on port ${PORT}`
  );
});=> {
  clearInterval(heartbeat);
});

wss.on("connection", ws => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    /*
      RESUME
    */
    if (message.type === "resume") {
      const token = String(message.token || "");

      const player = playersByToken.get(token);

      if (!player) {
        send(ws, {
          type: "resume_failed"
        });
        return;
      }

      const room = [...rooms.values()].find(
        r => r.players.includes(player)
      );

      if (!room) {
        send(ws, {
          type: "resume_failed"
        });
        return;
      }

      attachPlayer(room, player, ws);
      return;
    }

    /*
      CREATE
    */
    if (message.type === "create") {
      const room = {
        code: makeCode(),

        players: [],

        started: false,
        round: 1,
        turn: 0,

        phase: "waiting",

        deck: [],
        discard: []
      };

      rooms.set(room.code, room);

      const player = createPlayer(message.name);

      room.players.push(player);

      attachPlayer(room, player, ws);

      send(ws, {
        type: "joined",
        code: room.code,
        token: player.token,
        resumed: false
      });

      sendState(room);
      return;
    }

    /*
      JOIN
    */
    if (message.type === "join") {
      const code = String(message.code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: "error",
          message: "Room नहीं मिला।"
        });
        return;
      }

      if (room.started) {
        send(ws, {
          type: "error",
          message: "यह round already चल रहा है।"
        });
        return;
      }

      if (room.players.length >= MAX_PLAYERS) {
        send(ws, {
          type: "error",
          message: "Room full है।"
        });
        return;
      }

      const player = createPlayer(message.name);

      room.players.push(player);

      attachPlayer(room, player, ws);

      send(ws, {
        type: "joined",
        code: room.code,
        token: player.token,
        resumed: false
      });

      sendState(room);
      return;
    }

    const room = ws._room;
    const player = ws._player;

    if (!room || !player) {
      send(ws, {
        type: "error",
        message: "Server connection ready नहीं है।"
      });
      return;
    }

    /*
      READY
    */
    if (message.type === "ready") {
      if (room.started) {
        send(ws, {
          type: "error",
          message: "Round already चल रहा है।"
        });
        return;
      }

      if (player.out) {
        send(ws, {
          type: "error",
          message: "आप eliminate हो चुके हैं।"
        });
        return;
      }

      player.ready = Boolean(message.value);

      const active = activePlayers(room);

      if (
        active.length >= 2 &&
        active.every(p => p.ready && p.connected)
      ) {
        startRound(room);
      } else {
        sendState(room);
      }

      return;
    }

    /*
      DRAW
    */
    if (message.type === "draw") {
      if (!room.started) {
        send(ws, {
          type: "error",
          message: "Round शुरू नहीं हुआ है।"
        });
        return;
      }

      if (currentPlayer(room) !== player) {
        send(ws, {
          type: "error",
          message: "अभी आपकी turn नहीं है।"
        });
        return;
      }

      if (room.phase !== "draw") {
        send(ws, {
          type: "error",
          message: "पहले से card draw हो चुका है।"
        });
        return;
      }

      if (!refillDeck(room)) {
        send(ws, {
          type: "error",
          message: "Draw pile खाली है।"
        });
        return;
      }

      const card = room.deck.pop();

      if (!card) {
        send(ws, {
          type: "error",
          message: "Card draw नहीं हो पाया।"
        });
        return;
      }

      player.hand.push(card);
      player.drawn = true;

      room.phase = "discard";

      sendState(room);
      return;
    }

    /*
      DISCARD
    */
    if (message.type === "discard") {
      if (!room.started) {
        send(ws, {
          type: "error",
          message: "Round शुरू नहीं हुआ है।"
        });
        return;
      }

      if (currentPlayer(room) !== player) {
        send(ws, {
          type: "error",
          message: "अभी आपकी turn नहीं है।"
        });
        return;
      }

      if (room.phase !== "discard") {
        send(ws, {
          type: "error",
          message: "पहले DRAW करें।"
        });
        return;
      }

      const index = Number(message.index);

      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= player.hand.length
      ) {
        send(ws, {
          type: "error",
          message: "Invalid card selected."
        });
        return;
      }

      const card = player.hand.splice(index, 1)[0];

      room.discard.push(card);

      player.drawn = false;

      /*
        After discard, player has 13 cards.
        They may declare or end their turn.
      */
      room.phase = "declare";

      sendState(room);
      return;
    }

    /*
      DECLARE
    */
    if (message.type === "declare") {
      if (!room.started) {
        send(ws, {
          type: "error",
          message: "Round शुरू नहीं हुआ है।"
        });
        return;
      }

      if (currentPlayer(room) !== player) {
        send(ws, {
          type: "error",
          message: "अभी आपकी turn नहीं है।"
        });
        return;
      }

      if (room.phase !== "declare") {
        send(ws, {
          type: "error",
          message: "पहले DRAW करके card DISCARD करें।"
        });
        return;
      }

      if (player.hand.length !== 13) {
        send(ws, {
          type: "error",
          message: "Declaration के लिए 13 cards होने चाहिए।"
        });
        return;
      }

      if (!isValidHand(player.hand)) {
        send(ws, {
          type: "error",
          message:
            "Invalid declaration. 2 sequences चाहिए, जिनमें कम से कम 1 pure sequence हो।"
        });
        return;
      }

      finishRound(room, player);
      return;
    }

    /*
      END TURN
    */
    if (message.type === "end_turn") {
      if (!room.started) return;

      if (currentPlayer(room) !== player) {
        send(ws, {
          type: "error",
          message: "अभी आपकी turn नहीं है।"
        });
        return;
      }

      if (room.phase !== "declare") {
        send(ws, {
          type: "error",
          message: "पहले DRAW और DISCARD पूरा करें।"
        });
        return;
      }

      advanceTurn(room);
      return;
    }

    /*
      CHAT
    */
    if (message.type === "chat") {
      const text = String(message.text || "")
        .trim()
        .slice(0, 160);

      if (!text) return;

      broadcast(room, {
        type: "chat",
        name: player.name,
        text
      });

      return;
    }
  });

  ws.on("close", () => {
    const room = ws._room;
    const player = ws._player;

    if (!room || !player) return;

    /*
      Do NOT immediately remove player.
      They may reconnect because of mobile network changes,
      Render sleep/wake, browser backgrounding, etc.
    */
    if (player.ws === ws) {
      player.ws = null;
      player.connected = false;
      player.disconnectedAt = Date.now();
    }

    sendState(room);
  });

  ws.on("error", () => {
    // close event will handle player state
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "rummy101",
    rooms: rooms.size,
    time: new Date().toISOString()
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__di
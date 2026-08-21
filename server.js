const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(__dirname));

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 8;
const DISCONNECT_GRACE = 10 * 60 * 1000;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [
  "A", "2", "3", "4", "5", "6", "7",
  "8", "9", "10", "J", "Q", "K"
];

const rooms = new Map();
const playersByToken = new Map();

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data));
    } catch (_) {}
  }
}

function makeCode() {
  let code;

  do {
    code = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
  } while (rooms.has(code));

  return code;
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function rankValue(rank) {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return Number(rank);
}

function pointValue(rank) {
  if (["A", "J", "Q", "K"].includes(rank)) return 10;
  return Number(rank);
}

function makeDeck() {
  const deck = [];

  // Two normal decks
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({
          s: suit,
          r: rank,
          id: crypto.randomBytes(8).toString("hex")
        });
      }
    }
  }

  // Four printed jokers
  for (let i = 0; i < 4; i++) {
    deck.push({
      s: "★",
      r: "J",
      id: crypto.randomBytes(8).toString("hex")
    });
  }

  return shuffle(deck);
}

function shuffle(array) {
  const a = array.slice();

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

/*
  Pure sequence:
  - minimum 3 cards
  - no joker
  - same suit
  - consecutive ranks
*/
function isPureSequence(group) {
  if (!Array.isArray(group) || group.length < 3) return false;
  if (group.some(card => card.s === "★")) return false;

  const sorted = group
    .slice()
    .sort((a, b) => rankValue(a.r) - rankValue(b.r));

  if (new Set(sorted.map(c => c.s)).size !== 1) return false;

  for (let i = 1; i < sorted.length; i++) {
    if (
      rankValue(sorted[i].r) !==
      rankValue(sorted[i - 1].r) + 1
    ) {
      return false;
    }
  }

  return true;
}

/*
  Sequence with jokers.
*/
function isSequence(group) {
  if (!Array.isArray(group) || group.length < 3) return false;

  const jokers = group.filter(c => c.s === "★").length;

  const normal = group
    .filter(c => c.s !== "★")
    .sort((a, b) => rankValue(a.r) - rankValue(b.r));

  if (!normal.length) {
    return group.length >= 3;
  }

  if (new Set(normal.map(c => c.s)).size !== 1) {
    return false;
  }

  let requiredJokers = 0;

  for (let i = 1; i < normal.length; i++) {
    const gap =
      rankValue(normal[i].r) -
      rankValue(normal[i - 1].r);

    if (gap <= 0) return false;

    requiredJokers += gap - 1;
  }

  return (
    requiredJokers <= jokers &&
    normal.length + jokers >= 3
  );
}

/*
  Set:
  - 3 or 4 cards
  - same rank
  - different suits
*/
function isSet(group) {
  if (!Array.isArray(group)) return false;
  if (group.length < 3 || group.length > 4) return false;

  const normal = group.filter(c => c.s !== "★");

  if (new Set(normal.map(c => c.r)).size !== 1) {
    return false;
  }

  if (new Set(normal.map(c => c.s)).size !== normal.length) {
    return false;
  }

  return true;
}

/*
  Valid 13-card declaration:
  - entire hand must be grouped
  - at least 2 sequences
  - at least 1 pure sequence
*/
function isValidHand(hand) {
  if (!Array.isArray(hand) || hand.length !== 13) {
    return false;
  }

  function solve(remaining, groups) {
    if (remaining.length === 0) {
      const sequences = groups.filter(isSequence);
      const pure = groups.some(isPureSequence);

      return sequences.length >= 2 && pure;
    }

    // Avoid extremely expensive recursion
    if (remaining.length > 13) return false;

    for (let mask = 1; mask < (1 << remaining.length); mask++) {
      let count = 0;

      for (let bit = mask; bit; bit >>= 1) {
        count += bit & 1;
      }

      if (count < 3 || count > 4) continue;

      const group = [];
      const rest = [];

      for (let i = 0; i < remaining.length; i++) {
        if (mask & (1 << i)) {
          group.push(remaining[i]);
        } else {
          rest.push(remaining[i]);
        }
      }

      if (isSequence(group) || isSet(group)) {
        if (solve(rest, groups.concat([group]))) {
          return true;
        }
      }
    }

    return false;
  }

  return solve(hand, []);
}

function handScore(hand) {
  return hand.reduce((total, card) => {
    if (card.s === "★") return total;
    return total + pointValue(card.r);
  }, 0);
}

function activePlayers(room) {
  return room.players.filter(player => !player.out);
}

function connectedActivePlayers(room) {
  return activePlayers(room).filter(player => player.connected);
}

function currentPlayer(room) {
  return room.players[room.turn];
}

function publicState(room) {
  const current = currentPlayer(room);

  return {
    code: room.code,
    started: room.started,
    round: room.round,
    turn: room.turn,

    discardTop:
      room.discard.length
        ? room.discard[room.discard.length - 1]
        : null,

    deckCount: room.deck.length,

    phase: room.phase,

    players: room.players.map((player, index) => ({
      seat: index,
      name: player.name,
      score: player.score,
      ready: player.ready,
      out: player.out,
      connected: player.connected,
      cards: room.started && !player.out
        ? player.hand.length
        : 0
    })),

    currentPlayer:
      current && !current.out
        ? current.name
        : null
  };
}

function sendState(room) {
  broadcast(room, {
    type: "state",
    state: publicState(room)
  });

  sendHands(room);
}

function sendHands(room) {
  for (const player of room.players) {
    if (!player.ws) continue;

    const isTurn =
      room.started &&
      currentPlayer(room) === player;

    let canDraw = false;
    let canDiscard = false;
    let canDeclare = false;
    let canEndTurn = false;

    if (isTurn) {
      if (room.phase === "draw") {
        canDraw = true;
      }

      if (room.phase === "discard") {
        canDiscard = true;
      }

      if (room.phase === "declare") {
        canDeclare = true;
        canEndTurn = true;
      }
    }

    send(player.ws, {
      type: "hand",
      hand: player.hand,
      permissions: {
        canDraw,
        canDiscard,
        canDeclare,
        canEndTurn
      }
    });
  }
}

function broadcast(room, message) {
  for (const player of room.players) {
    send(player.ws, message);
  }
}

function startRound(room) {
  const players = activePlayers(room);

  if (players.length < 2) {
    broadcast(room, {
      type: "error",
      message: "कम से कम 2 active players चाहिए।"
    });
    return;
  }

  if (!players.every(player => player.ready && player.connected)) {
    broadcast(room, {
      type: "error",
      message: "सभी players को READY और connected होना चाहिए।"
    });
    return;
  }

  room.deck = makeDeck();
  room.discard = [];

  for (const player of room.players) {
    player.hand = [];
    player.drawn = false;
  }

  // Deal 13 cards to every active player
  for (let i = 0; i < 13; i++) {
    for (const player of players) {
      const card = room.deck.pop();

      if (card) {
        player.hand.push(card);
      }
    }
  }

  const firstDiscard = room.deck.pop();

  if (firstDiscard) {
    room.discard.push(firstDiscard);
  }

  room.turn = 0;

  // Skip eliminated players
  while (
    room.turn < room.players.length &&
    room.players[room.turn].out
  ) {
    room.turn++;
  }

  if (room.turn >= room.players.length) {
    room.turn = 0;
  }

  room.started = true;
  room.phase = "draw";

  for (const player of room.players) {
    player.ready = false;
    player.drawn = false;
  }

  broadcast(room, {
    type: "round_started",
    message: `Round ${room.round} शुरू हो गया।`
  });

  sendState(room);
}

function advanceTurn(room) {
  if (!room.started) return;

  let attempts = 0;

  do {
    room.turn = (room.turn + 1) % room.players.length;
    attempts++;

    if (attempts > room.players.length) {
      room.started = false;
      return;
    }
  } while (
    room.players[room.turn].out ||
    !room.players[room.turn].connected
  );

  room.phase = "draw";

  for (const player of room.players) {
    player.drawn = false;
  }

  sendState(room);
}

function finishRound(room, winner) {
  for (const player of activePlayers(room)) {
    if (player !== winner) {
      player.score += handScore(player.hand);
    }
  }

  const eliminated = activePlayers(room).filter(
    player => player.score >= 101
  );

  for (const player of eliminated) {
    player.out = true;
  }

  broadcast(room, {
    type: "round_end",
    winner: winner.name,
    scores: room.players.map(player => ({
      name: player.name,
      score: player.score,
      out: player.out
    }))
  });

  const remaining = activePlayers(room);

  if (remaining.length <= 1) {
    room.started = false;
    room.phase = "waiting";

    broadcast(room, {
      type: "match_end",
      winner:
        remaining[0]?.name ||
        winner.name
    });

    sendState(room);
    return;
  }

  room.round++;
  room.started = false;
  room.phase = "waiting";

  for (const player of room.players) {
    player.ready = false;
    player.drawn = false;
    player.hand = [];
  }

  sendState(room);
}

function refillDeck(room) {
  if (room.deck.length > 0) return true;

  if (room.discard.length <= 1) {
    return false;
  }

  const top =
    room.discard[room.discard.length - 1];

  const rest =
    room.discard.slice(0, -1);

  room.deck = shuffle(rest);
  room.discard = [top];

  return room.deck.length > 0;
}

function createPlayer(name) {
  const token = makeToken();

  const player = {
    token,
    name: String(name || "Player")
      .trim()
      .slice(0, 18) || "Player",

    ws: null,
    connected: false,
    disconnectedAt: null,

    ready: false,
    score: 0,
    out: false,

    hand: [],
    drawn: false
  };

  playersByToken.set(token, player);

  return player;
}

function attachPlayer(room, player, ws) {
  if (player.ws && player.ws !== ws) {
    try {
      player.ws.close(4000, "Reconnected elsewhere");
    } catch (_) {}
  }

  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;

  ws._room = room;
  ws._player = player;

  send(ws, {
    type: "joined",
    code: room.code,
    token: player.token,
    resumed: true
  });

  sendState(room);
}

function cleanupDisconnectedPlayers() {
  const now = Date.now();

  for (const room of rooms.values()) {
    const toRemove = room.players.filter(player => {
      return (
        !player.connected &&
        player.disconnectedAt &&
        now - player.disconnectedAt > DISCONNECT_GRACE
      );
    });

    for (const player of toRemove) {
      room.players = room.players.filter(p => p !== player);
      playersByToken.delete(player.token);

      if (
        room.started &&
        currentPlayer(room) === player
      ) {
        advanceTurn(room);
      }
    }

    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      sendState(room);
    }
  }
}

setInterval(cleanupDisconnectedPlayers, 30 * 1000);

/*
  WebSocket heartbeat.
  Render/network interruptions can otherwise leave stale sockets.
*/
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch (_) {}
      continue;
    }

    ws.isAlive = false;

    try {
      ws.ping();
    } catch (_) {}
  }
}, 25000);

wss.on("close", () => {
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
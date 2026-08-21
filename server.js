const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(__dirname));

const rooms = new Map();

const MAX_PLAYERS = 8;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [
  "A", "2", "3", "4", "5", "6", "7",
  "8", "9", "10", "J", "Q", "K"
];

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function roomCode() {
  return Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase();
}

function playerId() {
  return Math.random()
    .toString(36)
    .slice(2, 10);
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

function createDeck() {
  const deck = [];

  // Two standard decks
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({
          s: suit,
          r: rank,
          id: Math.random().toString(36).slice(2)
        });
      }
    }
  }

  // Four jokers
  for (let i = 0; i < 4; i++) {
    deck.push({
      s: "★",
      r: "J",
      id: Math.random().toString(36).slice(2)
    });
  }

  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

/*
  PURE SEQUENCE
  Example:
  4♠ 5♠ 6♠
  A♥ 2♥ 3♥
*/
function isPureSequence(group) {
  if (group.length < 3) return false;

  // Joker not allowed
  if (group.some(card => card.s === "★")) {
    return false;
  }

  const sorted = [...group].sort(
    (a, b) => rankValue(a.r) - rankValue(b.r)
  );

  const suits = new Set(sorted.map(card => card.s));

  if (suits.size !== 1) {
    return false;
  }

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
  SEQUENCE WITH JOKERS
*/
function isSequence(group) {
  if (group.length < 3) return false;

  const jokers = group.filter(card => card.s === "★").length;

  const normalCards = group
    .filter(card => card.s !== "★")
    .sort((a, b) => rankValue(a.r) - rankValue(b.r));

  if (normalCards.length === 0) {
    return false;
  }

  const suits = new Set(normalCards.map(card => card.s));

  if (suits.size !== 1) {
    return false;
  }

  let neededJokers = 0;

  for (let i = 1; i < normalCards.length; i++) {
    const gap =
      rankValue(normalCards[i].r) -
      rankValue(normalCards[i - 1].r);

    // Duplicate rank is invalid
    if (gap <= 0) {
      return false;
    }

    neededJokers += gap - 1;
  }

  return (
    neededJokers <= jokers &&
    normalCards.length + jokers >= 3
  );
}

/*
  SET
  Example:
  7♠ 7♥ 7♦
  9♠ 9♥ 9♦ 9♣
*/
function isSet(group) {
  const normalCards = group.filter(card => card.s !== "★");

  if (group.length < 3 || group.length > 4) {
    return false;
  }

  if (normalCards.length === 0) {
    return false;
  }

  const ranks = new Set(normalCards.map(card => card.r));
  const suits = new Set(normalCards.map(card => card.s));

  return (
    ranks.size === 1 &&
    suits.size === normalCards.length
  );
}

/*
  VALID RUMMY HAND

  Exactly 13 cards.
  At least 2 sequences.
  At least 1 pure sequence.
*/
function isValidHand(hand) {
  if (hand.length !== 13) {
    return false;
  }

  function search(remaining, groups) {
    if (remaining.length === 0) {
      const sequenceCount = groups.filter(isSequence).length;
      const hasPure = groups.some(isPureSequence);

      return sequenceCount >= 2 && hasPure;
    }

    // Prevent excessive recursion
    if (groups.length > 5) {
      return false;
    }

    for (let mask = 1; mask < (1 << remaining.length); mask++) {
      let count = 0;

      for (
        let bits = mask;
        bits;
        bits >>= 1
      ) {
        count += bits & 1;
      }

      if (count < 3 || count > 4) {
        continue;
      }

      const group = [];
      const rest = [];

      remaining.forEach((card, index) => {
        if (mask & (1 << index)) {
          group.push(card);
        } else {
          rest.push(card);
        }
      });

      if (
        isSequence(group) ||
        isSet(group)
      ) {
        if (search(rest, [...groups, group])) {
          return true;
        }
      }
    }

    return false;
  }

  return search(hand, []);
}

function calculateScore(hand) {
  return hand.reduce((total, card) => {
    if (card.s === "★") {
      return total;
    }

    return total + pointValue(card.r);
  }, 0);
}

/*
  Public room state.
  Do not send players' cards to everyone.
*/
function publicState(room) {
  return {
    code: room.code,
    started: room.started,
    round: room.round,

    turn: room.turn,

    // "waiting", "draw", "discard", "declare"
    phase: room.phase,

    players: room.players.map((player, index) => ({
      id: player.id,
      seat: index,
      name: player.name,
      ready: player.ready,
      score: player.score,
      out: player.out,
      cards: room.started ? player.hand.length : 0
    })),

    discardTop:
      room.discard.length
        ? room.discard[room.discard.length - 1]
        : null
  };
}

function broadcast(room, data) {
  room.players.forEach(player => {
    send(player.ws, data);
  });
}

/*
  Send each player their own hand.
*/
function sendHands(room) {
  room.players.forEach(player => {
    const isCurrent =
      room.started &&
      room.players[room.turn] === player;

    send(player.ws, {
      type: "hand",
      hand: player.hand,

      canDraw:
        isCurrent &&
        room.phase === "draw",

      canDiscard:
        isCurrent &&
        room.phase === "discard",

      canDeclare:
        isCurrent &&
        room.phase === "declare"
    });
  });
}

function broadcastState(room) {
  broadcast(room, {
    type: "state",
    state: publicState(room)
  });

  sendHands(room);
}

/*
  Start a round.
*/
function startRound(room) {
  room.deck = createDeck();
  room.discard = [];

  room.players.forEach(player => {
    player.hand = [];
    player.drawn = false;
  });

  // Deal 13 cards to every player
  for (let i = 0; i < 13; i++) {
    room.players.forEach(player => {
      player.hand.push(room.deck.pop());
    });
  }

  // Start discard pile
  room.discard.push(room.deck.pop());

  room.turn = 0;
  room.phase = "draw";
  room.started = true;

  broadcastState(room);
}

/*
  Move to next active player.
*/
function nextTurn(room) {
  if (!room.players.length) {
    return;
  }

  let attempts = 0;

  do {
    room.turn =
      (room.turn + 1) %
      room.players.length;

    attempts++;

    if (attempts > room.players.length) {
      break;
    }
  } while (room.players[room.turn].out);

  room.phase = "draw";

  room.players.forEach(player => {
    player.drawn = false;
  });

  broadcastState(room);
}

/*
  Finish round.
*/
function finishRound(room, winner) {
  room.players.forEach(player => {
    if (player !== winner) {
      player.score += calculateScore(player.hand);
    }
  });

  // Eliminate 101+
  room.players.forEach(player => {
    if (player.score >= 101) {
      player.out = true;
    }
  });

  broadcast(room, {
    type: "round_end",
    winner: winner.name,
    scores: room.players.map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      out: player.out
    }))
  });

  const activePlayers =
    room.players.filter(player => !player.out);

  // Match over
  if (activePlayers.length <= 1) {
    room.started = false;
    room.phase = "waiting";

    broadcast(room, {
      type: "match_end",
      winner:
        activePlayers[0]?.name ||
        winner.name
    });

    broadcastState(room);
    return;
  }

  // Prepare next round
  room.round++;
  room.started = false;
  room.phase = "waiting";
  room.turn = 0;

  room.players.forEach(player => {
    player.ready = false;
    player.hand = [];
    player.drawn = false;
  });

  broadcastState(room);
}

wss.on("connection", ws => {
  let room = null;
  let player = null;

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    /*
      CREATE ROOM
    */
    if (message.type === "create") {
      const code = roomCode();

      room = {
        code,
        players: [],
        started: false,
        turn: 0,
        round: 1,
        phase: "waiting",
        deck: [],
        discard: []
      };

      player = {
        id: playerId(),
        name: String(
          message.name || "Player"
        ).slice(0, 18),
        ws,
        ready: false,
        score: 0,
        out: false,
        hand: [],
        drawn: false
      };

      room.players.push(player);
      rooms.set(code, room);

      send(ws, {
        type: "joined",
        code,
        playerId: player.id
      });

      broadcastState(room);

      return;
    }

    /*
      JOIN ROOM
    */
    if (message.type === "join") {
      const code = String(
        message.code || ""
      )
        .trim()
        .toUpperCase();

      room = rooms.get(code);

      if (
        !room ||
        room.started ||
        room.players.length >= MAX_PLAYERS
      ) {
        send(ws, {
          type: "error",
          message:
            "Room unavailable. Check the room code or try another room."
        });

        return;
      }

      player = {
        id: playerId(),
        name: String(
          message.name || "Player"
        ).slice(0, 18),
        ws,
        ready: false,
        score: 0,
        out: false,
        hand: [],
        drawn: false
      };

      room.players.push(player);

      send(ws, {
        type: "joined",
        code: room.code,
        playerId: player.id
      });

      broadcastState(room);

      return;
    }

    /*
      All remaining messages require a player.
    */
    if (!room || !player) {
      send(ws, {
        type: "error",
        message: "You are not connected to a room."
      });

      return;
    }

    /*
      READY / UNREADY
    */
    if (message.type === "ready") {
      if (room.started) {
        return;
      }

      if (player.out) {
        return;
      }

      player.ready = Boolean(message.value);

      const activePlayers =
        room.players.filter(p => !p.out);

      const allReady =
        activePlayers.length >= 2 &&
        activePlayers.every(p => p.ready);

      if (allReady) {
        startRound(room);
      } else {
        broadcastState(room);
      }

      return;
    }

    /*
      DRAW
    */
    if (message.type === "draw") {
      const isMyTurn =
        room.started &&
        room.players[room.turn] === player;

      if (!isMyTurn) {
        send(ws, {
          type: "error",
          message: "It is not your turn."
        });

        return;
      }

      if (room.phase !== "draw") {
        send(ws, {
          type: "error",
          message: "You cannot draw right now."
        });

        return;
      }

      /*
        Recycle discard pile if deck is empty.
        Keep the top discard card.
      */
      if (room.deck.length === 0) {
        if (room.discard.length <= 1) {
          send(ws, {
            type: "error",
            message: "No cards available to draw."
          });

          return;
        }

        const top =
          room.discard[room.discard.length - 1];

        const recycled =
          room.discard
            .slice(0, -1)
            .sort(() => Math.random() - 0.5);

        room.deck = recycled;
        room.discard = [top];
      }

      const card = room.deck.pop();

      if (!card) {
        send(ws, {
          type: "error",
          message: "Unable to draw a card."
        });

        return;
      }

      player.hand.push(card);
      player.drawn = true;

      room.phase = "discard";

      broadcastState(room);

      return;
    }

    /*
      DISCARD
    */
    if (message.type === "discard") {
      const isMyTurn =
        room.started &&
        room.players[room.turn] === player;

      if (!isMyTurn) {
        send(ws, {
          type: "error",
          message: "It is not your turn."
        });

        return;
      }

      if (room.phase !== "discard") {
        send(ws, {
          type: "error",
          message: "Draw a card before discarding."
        });

        return;
      }

      if (player.hand.length !== 14) {
        send(ws, {
          type: "error",
          message: "You must have 14 cards before discard."
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
          message: "Invalid card selection."
        });

        return;
      }

      const discarded =
        player.hand.splice(index, 1)[0];

      room.discard.push(discarded);

      player.drawn = false;

      /*
        After discard, player has 13 cards.
        If hand is valid, give DECLARE opportunity.
      */
      if (isValidHand(player.hand)) {
        room.phase = "declare";

        broadcastState(room);

        send(ws, {
          type: "info",
          message:
            "Your hand is valid. Press DECLARE to finish the round."
        });

        return;
      }

      /*
        Not a winning hand.
        Automatically move to next player.
      */
      nextTurn(room);

      return;
    }

    /*
      DECLARE
    */
    if (message.type === "declare") {
      const isMyTurn =
        room.started &&
        room.players[room.turn] === player;

      if (!isMyTurn) {
        send(ws, {
          type: "error",
          message: "It is not your turn."
        });

        return;
      }

      if (room.phase !== "declare") {
        send(ws, {
          type: "error",
          message:
            "You can declare only after discarding."
        });

        return;
      }

      if (player.hand.length !== 13) {
        send(ws, {
          type: "error",
          message:
            "Declaration requires exactly 13 cards."
        });

        return;
      }

      if (!isValidHand(player.hand)) {
        send(ws, {
          type: "error",
          message:
            "Invalid declaration. Need 2 sequences, including 1 pure sequence."
        });

        return;
      }

      finishRound(room, player);

      return;
    }

    /*
      CHAT
    */
    if (message.type === "chat") {
      const text = String(
        message.text || ""
      ).trim();

      if (!text) {
        return;
      }

      broadcast(room, {
        type: "chat",
        name: player.name,
        text: text.slice(0, 160)
      });

      return;
    }
  });

  /*
    CONNECTION CLOSED
  */
  ws.on("close", () => {
    if (!room || !player) {
      return;
    }

    const index =
      room.players.indexOf(player);

    if (index === -1) {
      return;
    }

    room.players.splice(index, 1);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    /*
      If current player leaves during a game,
      move turn safely.
    */
    if (room.started) {
      if (room.turn >= room.players.length) {
        room.turn = 0;
      }

      if (room.players.length < 2) {
        room.started = false;
        room.phase = "waiting";

        room.players.forEach(p => {
          p.ready = false;
        });
      } else {
        room.phase = "draw";
      }
    }

    broadcastState(room);
  });

  ws.on("error", () => {
    // Connection errors are handled by close.
  });
});

/*
  Render requires the PORT environment variable.
*/
const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Rummy 101 server running on port ${PORT}`);
});

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TTL_MS = 5000;

// Render Environment Variables에서 MAP_PASS를 바꾸면 접속 비밀번호가 바뀜.
// MAP_PASS를 설정하지 않으면 기본값은 yddo123.
const ACCESS_PASS = process.env.MAP_PASS || "yddo123";

const players = new Map();

function cleanName(name) {
  if (!name) return "";
  return String(name)
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 16);
}

function cleanColor(color) {
  const c = String(color || "").trim().toLowerCase();

  if (c === "darkyellow") return "darkyellow";
  if (c === "skyblue") return "skyblue";
  if (c === "purple") return "purple";

  return "red";
}

function okPass(pass) {
  return String(pass || "") === String(ACCESS_PASS || "");
}

function cleanOld() {
  const now = Date.now();

  for (const [name, p] of players.entries()) {
    if (now - p.t > TTL_MS) {
      players.delete(name);
    }
  }
}

function getMajorBless() {
  const groups = new Map();

  for (const [, p] of players.entries()) {
    const bx = Number.isFinite(p.blessX) ? p.blessX : -1;
    const by = Number.isFinite(p.blessY) ? p.blessY : -1;

    if (bx < 0 || by < 0) continue;

    const key = `${bx},${by}`;

    if (!groups.has(key)) {
      groups.set(key, {
        x: bx,
        y: by,
        count: 0,
        latest: 0
      });
    }

    const g = groups.get(key);
    g.count++;
    g.latest = Math.max(g.latest, p.blessT || 0);
  }

  let best = null;

  for (const g of groups.values()) {
    if (!best) {
      best = g;
      continue;
    }

    // 다수결: count 많은 좌표 우선
    // 동률이면 더 최근에 올라온 좌표 우선
    if (g.count > best.count || (g.count === best.count && g.latest > best.latest)) {
      best = g;
    }
  }

  return best;
}

function makeText() {
  cleanOld();

  const lines = [];

  for (const [name, p] of players.entries()) {
    lines.push(`P|${name}|${p.x}|${p.y}|${p.color}`);
  }

  // 축복은 다수결 1개만 전송.
  // 예: 92,117이 3명 / 82,117이 1명이면 92,117만 내려감.
  const bless = getMajorBless();

  if (bless) {
    lines.push(`B|${bless.x}|${bless.y}|${bless.count}`);
  }

  return lines.join("\n");
}

app.get("/", (req, res) => {
  res.type("text/plain").send("bukbang xy server ok");
});

app.post("/check", (req, res) => {
  if (!okPass(req.body.pass)) {
    res.status(403).type("text/plain").send("ERR|BADPASS");
    return;
  }

  res.type("text/plain").send("OK");
});

app.get("/xy", (req, res) => {
  res.type("text/plain").send(makeText());
});

app.post("/xy", (req, res) => {
  if (!okPass(req.body.pass)) {
    res.status(403).type("text/plain").send("ERR|BADPASS");
    return;
  }

  const name = cleanName(req.body.name);
  const x = parseInt(req.body.x, 10);
  const y = parseInt(req.body.y, 10);
  const color = cleanColor(req.body.color);

  const blessX = parseInt(req.body.blessX, 10);
  const blessY = parseInt(req.body.blessY, 10);

  if (name && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    const old = players.get(name) || {};

    const next = {
      x,
      y,
      color,
      t: Date.now(),
      blessX: old.blessX ?? -1,
      blessY: old.blessY ?? -1,
      blessT: old.blessT ?? 0
    };

    if (Number.isFinite(blessX) && Number.isFinite(blessY) && blessX >= 0 && blessY >= 0) {
      next.blessX = blessX;
      next.blessY = blessY;
      next.blessT = Date.now();
    }

    players.set(name, next);
  }

  res.type("text/plain").send(makeText());
});

app.listen(PORT, () => {
  console.log(`bukbang xy server running on ${PORT}`);
});

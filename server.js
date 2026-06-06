const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 사람 좌표 유효 시간.
// 1초 동안 갱신이 없으면 서버 목록에서 사라짐.
const PLAYER_TTL_MS = 1000;

// 축복 좌표 유효 시간.
// 사람 좌표처럼 1초 동안 갱신이 없으면 삭제.
const BLESS_TTL_MS = 1000;

// 1등 좌표 유효 시간.
// 사람 좌표처럼 1초 동안 갱신이 없으면 삭제.
const FIRST_TTL_MS = 1000;

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

  // 기존 색 호환
  if (c === "red") return "red";
  if (c === "darkyellow") return "darkyellow";
  if (c === "skyblue") return "skyblue";
  if (c === "purple") return "purple";

  // 새 선택지 호환
  if (c === "yellow") return "darkyellow";
  if (c === "blue") return "skyblue";
  if (c === "green") return "green";
  if (c === "whitecircle" || c === "white_circle" || c === "whiteinner" || c === "white_inner") {
    return "whitecircle";
  }
  if (c === "whitex" || c === "white_x") {
    return "whitex";
  }

  return "skyblue";
}

function okPass(pass) {
  return String(pass || "") === String(ACCESS_PASS || "");
}

function cleanOld() {
  const now = Date.now();

  for (const [name, p] of players.entries()) {
    if (now - p.t > PLAYER_TTL_MS) {
      players.delete(name);
    }
  }
}

function getMajorPoint(xKey, yKey, tKey, ttlMs) {
  const now = Date.now();
  const groups = new Map();

  for (const [, p] of players.entries()) {
    const px = Number.isFinite(p[xKey]) ? p[xKey] : -1;
    const py = Number.isFinite(p[yKey]) ? p[yKey] : -1;
    const pt = p[tKey] || 0;

    if (px < 0 || py < 0) continue;
    if (now - pt > ttlMs) continue;

    const key = `${px},${py}`;

    if (!groups.has(key)) {
      groups.set(key, {
        x: px,
        y: py,
        count: 0,
        latest: 0
      });
    }

    const g = groups.get(key);
    g.count++;
    g.latest = Math.max(g.latest, pt);
  }

  let best = null;

  for (const g of groups.values()) {
    if (!best) {
      best = g;
      continue;
    }

    // 다수결: count 많은 좌표 우선
    // 동률이면 더 최근 좌표 우선
    if (g.count > best.count || (g.count === best.count && g.latest > best.latest)) {
      best = g;
    }
  }

  return best;
}

function getMajorBless() {
  return getMajorPoint("blessX", "blessY", "blessT", BLESS_TTL_MS);
}

function getMajorFirst() {
  return getMajorPoint("firstX", "firstY", "firstT", FIRST_TTL_MS);
}

function makeText() {
  cleanOld();

  const lines = [];

  for (const [name, p] of players.entries()) {
    lines.push(`P|${name}|${p.x}|${p.y}|${p.color}`);
  }

  const bless = getMajorBless();

  if (bless) {
    lines.push(`B|${bless.x}|${bless.y}|${bless.count}`);
  }

  const first = getMajorFirst();

  if (first) {
    // F = 1등 좌표
    lines.push(`F|${first.x}|${first.y}|${first.count}`);
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

  // 클라가 firstX/firstY 또는 rank1X/rank1Y 둘 중 뭐로 보내도 받음.
  const firstXRaw = req.body.firstX !== undefined ? req.body.firstX : req.body.rank1X;
  const firstYRaw = req.body.firstY !== undefined ? req.body.firstY : req.body.rank1Y;

  const firstX = parseInt(firstXRaw, 10);
  const firstY = parseInt(firstYRaw, 10);

  if (name && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    const old = players.get(name) || {};

    const next = {
      x,
      y,
      color,
      t: Date.now(),

      blessX: old.blessX ?? -1,
      blessY: old.blessY ?? -1,
      blessT: old.blessT ?? 0,

      firstX: old.firstX ?? -1,
      firstY: old.firstY ?? -1,
      firstT: old.firstT ?? 0
    };

    if (Number.isFinite(blessX) && Number.isFinite(blessY)) {
      if (blessX >= 0 && blessY >= 0) {
        // 유효 축복 좌표를 보낸 경우에만 축복 갱신 시간 갱신.
        next.blessX = blessX;
        next.blessY = blessY;
        next.blessT = Date.now();
      } else {
        // 인식 실패자는 축복 좌표 제거.
        // 다른 사람이 1초 안에 유효 좌표를 보내면 축복은 유지됨.
        next.blessX = -1;
        next.blessY = -1;
        next.blessT = 0;
      }
    }

    if (Number.isFinite(firstX) && Number.isFinite(firstY)) {
      if (firstX >= 0 && firstY >= 0) {
        // 유효 1등 좌표를 보낸 경우에만 1등 갱신 시간 갱신.
        next.firstX = firstX;
        next.firstY = firstY;
        next.firstT = Date.now();
      } else {
        // 인식 실패자는 1등 좌표 제거.
        // 다른 사람이 1초 안에 유효 좌표를 보내면 1등은 유지됨.
        next.firstX = -1;
        next.firstY = -1;
        next.firstT = 0;
      }
    }

    players.set(name, next);
  }

  res.type("text/plain").send(makeText());
});

app.listen(PORT, () => {
  console.log(`bukbang xy server running on ${PORT}`);
});

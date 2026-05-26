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

function makeText() {
  cleanOld();

  const lines = [];

  for (const [name, p] of players.entries()) {
    lines.push(`${name}|${p.x}|${p.y}|${p.color}`);
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
  // C#은 POST만 사용한다. 브라우저 확인용으로 목록만 보여준다.
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

  if (name && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    players.set(name, {
      x,
      y,
      color,
      t: Date.now()
    });
  }

  res.type("text/plain").send(makeText());
});

app.listen(PORT, () => {
  console.log(`bukbang xy server running on ${PORT}`);
});

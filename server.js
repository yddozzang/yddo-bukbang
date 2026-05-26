const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TTL_MS = 5000;

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

  let lines = [];

  for (const [name, p] of players.entries()) {
    lines.push(`${name}|${p.x}|${p.y}`);
  }

  return lines.join("\n");
}

app.get("/", (req, res) => {
  res.type("text/plain").send("bukbang xy server ok");
});

app.get("/xy", (req, res) => {
  res.type("text/plain").send(makeText());
});

app.post("/xy", (req, res) => {
  const name = cleanName(req.body.name);
  const x = parseInt(req.body.x, 10);
  const y = parseInt(req.body.y, 10);

  if (name && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    players.set(name, {
      x,
      y,
      t: Date.now()
    });
  }

  res.type("text/plain").send(makeText());
});

app.listen(PORT, () => {
  console.log(`bukbang xy server running on ${PORT}`);
});

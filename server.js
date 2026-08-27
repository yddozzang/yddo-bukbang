const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================================================================
// 기존 패자 지도 설정
// ================================================================

const PLAYER_TTL_MS = 1000;
const BLESS_TTL_MS = 1000;
const FIRST_TTL_MS = 1000;

// ================================================================
// 좌표 키싱크 설정
// /xy와 저장소를 완전히 분리한다.
// ================================================================

const SYNC_TTL_MS = 3000;

const ACCESS_PASS = process.env.MAP_PASS || "yddo123";

// 패자지도 데이터
const players = new Map();

// 키싱크 데이터
const syncPlayers = new Map();

// 키싱크 굴 전이 기록
const syncRoutes = new Map();

// ================================================================
// 공통
// ================================================================

function cleanName(name) {
  if (!name) return "";

  return String(name)
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 16);
}

function cleanMapName(name) {
  if (!name) return "";

  return String(name)
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 48);
}

function cleanSyncName(name) {
  if (!name) return "";

  return String(name)
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 64);
}

function cleanColor(color) {
  const c = String(color || "").trim().toLowerCase();

  if (c === "red") return "red";
  if (c === "darkyellow") return "darkyellow";
  if (c === "skyblue") return "skyblue";
  if (c === "purple") return "purple";

  if (c === "yellow") return "darkyellow";
  if (c === "blue") return "skyblue";
  if (c === "green") return "green";

  if (
    c === "whitecircle" ||
    c === "white_circle" ||
    c === "whiteinner" ||
    c === "white_inner"
  ) {
    return "whitecircle";
  }

  if (
    c === "whitex" ||
    c === "white_x"
  ) {
    return "whitex";
  }

  return "skyblue";
}

function cleanSyncState(state) {
  const raw = String(state || "").trim();

  const match = raw.match(
    /^([MS]):([LRUDN]):([01]):(\d{1,10})$/i
  );

  if (!match)
    return "S:N:0:0";

  return [
    match[1].toUpperCase(),
    match[2].toUpperCase(),
    match[3],
    match[4]
  ].join(":");
}

function cleanSession(session) {
  return String(session || "")
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 32);
}

function cleanMapHash(value) {
  const hash =
    String(value || "")
      .trim()
      .toUpperCase();

  return /^[0-9A-F]{16}$/.test(hash)
    ? hash
    : "";
}

function cleanRouteMove(value) {
  const move =
    String(value || "")
      .trim()
      .toUpperCase();

  return /^[LRUDE]$/.test(move)
    ? move
    : "";
}

function okPass(pass) {
  return String(pass || "") ===
    String(ACCESS_PASS || "");
}

// ================================================================
// 패자지도
// ================================================================

function cleanOld() {
  const now = Date.now();

  for (const [name, p] of players.entries()) {
    if (now - p.t > PLAYER_TTL_MS) {
      players.delete(name);
    }
  }
}

function getMajorPoint(
  xKey,
  yKey,
  tKey,
  ttlMs,
  mapFilter = null
) {
  const now = Date.now();
  const groups = new Map();

  for (const [, p] of players.entries()) {
    if (
      mapFilter !== null &&
      String(p.map || "") !== mapFilter
    ) {
      continue;
    }

    const px =
      Number.isFinite(p[xKey])
        ? p[xKey]
        : -1;

    const py =
      Number.isFinite(p[yKey])
        ? p[yKey]
        : -1;

    const pt = p[tKey] || 0;

    if (px < 0 || py < 0)
      continue;

    if (now - pt > ttlMs)
      continue;

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
    g.latest =
      Math.max(g.latest, pt);
  }

  let best = null;

  for (const g of groups.values()) {
    if (!best) {
      best = g;
      continue;
    }

    if (
      g.count > best.count ||
      (
        g.count === best.count &&
        g.latest > best.latest
      )
    ) {
      best = g;
    }
  }

  return best;
}

function getMajorBless(mapFilter = null) {
  return getMajorPoint(
    "blessX",
    "blessY",
    "blessT",
    BLESS_TTL_MS,
    mapFilter
  );
}

function getMajorFirst(mapFilter = null) {
  return getMajorPoint(
    "firstX",
    "firstY",
    "firstT",
    FIRST_TTL_MS,
    mapFilter
  );
}

function makeText(options = {}) {
  cleanOld();

  const now = Date.now();
  const lines = [];

  const mapMode =
    options.mapMode === true;

  const requestMap =
    cleanMapName(
      options.map || ""
    );

  const requester =
    cleanName(
      options.requester || ""
    );

  // ==============================================================
  // P
  // 현재 사용자와 같은 맵에 있는 사람만
  // 지도에 점 찍는 용도
  // ==============================================================

  for (const [name, p] of players.entries()) {
    if (mapMode) {
      if (requestMap) {
        if (
          String(p.map || "") !==
          requestMap
        ) {
          continue;
        }
      }
      else {
        // 맵 판정 실패 상태에서는
        // 다른 맵 사람이 섞이지 않게 자기 자신만 반환
        if (name !== requester)
          continue;
      }
    }

    const ageMs =
      Math.max(
        0,
        now - (p.t || 0)
      );

    lines.push(
      `P|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}`
    );
  }

  // ==============================================================
  // U
  // ONLINE 패널용 전체 접속자
  // 맵이 달라도 현재 살아있는 사람은 전부 반환
  // ==============================================================

  for (const [name, p] of players.entries()) {
    const ageMs =
      Math.max(
        0,
        now - (p.t || 0)
      );

    lines.push(
      `U|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}`
    );
  }

  // ==============================================================
  // B / F
  // 현재 맵 기준
  // ==============================================================

  const pointMapFilter =
    mapMode
      ? requestMap
      : null;

  if (
    !mapMode ||
    requestMap
  ) {
    const bless =
      getMajorBless(
        pointMapFilter
      );

    if (bless) {
      const ageMs =
        Math.max(
          0,
          now - (bless.latest || 0)
        );

      lines.push(
        `B|${bless.x}|${bless.y}|${bless.count}|${ageMs}`
      );
    }

    const first =
      getMajorFirst(
        pointMapFilter
      );

    if (first) {
      const ageMs =
        Math.max(
          0,
          now - (first.latest || 0)
        );

      lines.push(
        `F|${first.x}|${first.y}|${first.count}|${ageMs}`
      );
    }
  }

  return lines.join("\n");
}

// ================================================================
// 좌표 키싱크
// ================================================================

function cleanOldSync() {
  const now = Date.now();

  for (
    const [name, p]
    of syncPlayers.entries()
  ) {
    if (
      now - p.t >
      SYNC_TTL_MS
    ) {
      syncPlayers.delete(name);
    }
  }
}

function makeSyncText(
  sessionFilter = ""
) {
  cleanOldSync();

  const lines = [];

  for (
    const [name, p]
    of syncPlayers.entries()
  ) {
    lines.push(
      `S|${name}|${p.x}|${p.y}|${p.state}|${p.mapHash || ""}`
    );
  }

  for (
    const route
    of syncRoutes.values()
  ) {
    if (
      sessionFilter &&
      route.session !==
        sessionFilter
    ) {
      continue;
    }

    lines.push(
      `R|${route.session}|${route.fromHash}|${route.toHash}|` +
      `${route.x}|${route.y}|${route.move}|${route.seq}`
    );
  }

  return lines.join("\n");
}

// ================================================================
// 상태 확인
// ================================================================

app.get("/", (req, res) => {
  res
    .type("text/plain")
    .send(
      "bukbang xy + coordinate sync server ok"
    );
});

app.post("/check", (req, res) => {
  if (!okPass(req.body.pass)) {
    res
      .status(403)
      .type("text/plain")
      .send("ERR|BADPASS");

    return;
  }

  res
    .type("text/plain")
    .send("OK");
});

// ================================================================
// 패자지도 /xy
// ================================================================

app.get("/xy", (req, res) => {
  res
    .type("text/plain")
    .send(
      makeText()
    );
});

app.post("/xy", (req, res) => {
  if (!okPass(req.body.pass)) {
    res
      .status(403)
      .type("text/plain")
      .send("ERR|BADPASS");

    return;
  }

  const name =
    cleanName(
      req.body.name
    );

  const x =
    parseInt(
      req.body.x,
      10
    );

  const y =
    parseInt(
      req.body.y,
      10
    );

  const color =
    cleanColor(
      req.body.color
    );

  // 범용 지도 현재 맵
  // /sync의 mapHash와는 별개
  const map =
    cleanMapName(
      req.body.map
    );

  const mapMode =
    String(
      req.body.mapMode || ""
    ) === "1";

  const blessX =
    parseInt(
      req.body.blessX,
      10
    );

  const blessY =
    parseInt(
      req.body.blessY,
      10
    );

  const firstXRaw =
    req.body.firstX !== undefined
      ? req.body.firstX
      : req.body.rank1X;

  const firstYRaw =
    req.body.firstY !== undefined
      ? req.body.firstY
      : req.body.rank1Y;

  const firstX =
    parseInt(
      firstXRaw,
      10
    );

  const firstY =
    parseInt(
      firstYRaw,
      10
    );

  if (
    name &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0
  ) {
    const old =
      players.get(name) || {};

    const next = {
      x,
      y,
      color,

      map:
        mapMode
          ? map
          : "",

      t: Date.now(),

      blessX:
        old.blessX ?? -1,

      blessY:
        old.blessY ?? -1,

      blessT:
        old.blessT ?? 0,

      firstX:
        old.firstX ?? -1,

      firstY:
        old.firstY ?? -1,

      firstT:
        old.firstT ?? 0
    };

    if (
      Number.isFinite(blessX) &&
      Number.isFinite(blessY) &&
      blessX >= 0 &&
      blessY >= 0
    ) {
      next.blessX =
        blessX;

      next.blessY =
        blessY;

      next.blessT =
        Date.now();
    }

    if (
      Number.isFinite(firstX) &&
      Number.isFinite(firstY) &&
      firstX >= 0 &&
      firstY >= 0
    ) {
      next.firstX =
        firstX;

      next.firstY =
        firstY;

      next.firstT =
        Date.now();
    }

    players.set(
      name,
      next
    );
  }

  res
    .type("text/plain")
    .send(
      makeText({
        mapMode,
        map,
        requester: name
      })
    );
});

// ================================================================
// 좌표 키싱크 /sync
// 패자지도와 완전히 별도
// ================================================================

app.get("/sync", (req, res) => {
  const session =
    cleanSession(
      req.query.session
    );

  res
    .type("text/plain")
    .send(
      makeSyncText(
        session
      )
    );
});

app.post("/sync", (req, res) => {
  if (!okPass(req.body.pass)) {
    res
      .status(403)
      .type("text/plain")
      .send("ERR|BADPASS");

    return;
  }

  const session =
    cleanSession(
      req.body.session
    );

  const name =
    cleanSyncName(
      req.body.name
    );

  const x =
    parseInt(
      req.body.x,
      10
    );

  const y =
    parseInt(
      req.body.y,
      10
    );

  const state =
    cleanSyncState(
      req.body.state
    );

  const mapHash =
    cleanMapHash(
      req.body.map
    );

  if (
    name &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0
  ) {
    syncPlayers.set(
      name,
      {
        x,
        y,
        state,
        mapHash,
        session,
        t: Date.now()
      }
    );
  }

  const routeFrom =
    cleanMapHash(
      req.body.routeFrom
    );

  const routeTo =
    cleanMapHash(
      req.body.routeTo
    );

  const routeX =
    parseInt(
      req.body.routeX,
      10
    );

  const routeY =
    parseInt(
      req.body.routeY,
      10
    );

  const routeMove =
    cleanRouteMove(
      req.body.routeMove
    );

  const routeSeq =
    parseInt(
      req.body.routeSeq,
      10
    );

  if (
    session &&
    routeFrom &&
    routeTo &&
    Number.isFinite(routeX) &&
    Number.isFinite(routeY) &&
    routeX >= 0 &&
    routeY >= 0 &&
    routeMove &&
    Number.isFinite(routeSeq) &&
    routeSeq >= 0
  ) {
    const key = [
      session,
      routeFrom,
      routeTo,
      routeX,
      routeY,
      routeMove
    ].join("|");

    const old =
      syncRoutes.get(key);

    if (
      !old ||
      routeSeq >= old.seq
    ) {
      syncRoutes.set(
        key,
        {
          session,
          fromHash:
            routeFrom,

          toHash:
            routeTo,

          x:
            routeX,

          y:
            routeY,

          move:
            routeMove,

          seq:
            routeSeq
        }
      );
    }
  }

  res
    .type("text/plain")
    .send(
      makeSyncText(
        session
      )
    );
});

app.listen(PORT, () => {
  console.log(
    `bukbang xy + coordinate sync server running on ${PORT}`
  );
});

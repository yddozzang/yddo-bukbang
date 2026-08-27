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

// 지도 점 유효 시간. 250~1000ms 사이 클라이언트에서 페이드.
const PLAYER_TTL_MS = 1000;

// ONLINE 표시는 좌표점과 분리한다. 짧은 네트워크 흔들림에는 목록이 사라지지 않게 3초 유지.
const ONLINE_TTL_MS = 3000;

// 축복 좌표 유효 시간.
const BLESS_TTL_MS = 1000;

// 1등 좌표 유효 시간.
const FIRST_TTL_MS = 1000;

// ================================================================
// 새 좌표 키싱크 설정
// /xy와 저장소를 완전히 분리한다.
// ================================================================

// Render 왕복이 잠깐 밀려도 MAIN이 바로 사라지지 않도록 3초 유지.
// 실제 SUB 프로그램은 자체 수신 타임아웃으로 더 빨리 입력을 멈춘다.
const SYNC_TTL_MS = 3000;

// Render Environment Variables에서 MAP_PASS를 바꾸면 접속 비밀번호가 바뀜.
const ACCESS_PASS = process.env.MAP_PASS || "yddo123";

// 기존 패자 지도 사람 데이터
const players = new Map();

// 새 좌표 키싱크 데이터
const syncPlayers = new Map();

// 세션별로 메인이 학습한 굴 전이 기록.
// R|세션|이전맵|다음맵|출구X|출구Y|입력|순번
const syncRoutes = new Map();

// ================================================================
// 공통 정리 함수
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

// 패자지도 범용 맵 이름. /sync의 mapHash와는 완전히 별개다.
function cleanMapName(name) {
  if (!name) return "";

  return String(name)
    .replace(/\|/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "")
    .trim()
    .slice(0, 48);
}

// SESSION_MAIN, 컴퓨터명, PID가 들어가므로 sync 쪽은 64자 허용.
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
  const raw = String(color || "").trim().toLowerCase();

  // 새 표식 키
  // r/y/g/p + 0~9
  if (/^[rygp][0-9]$/.test(raw)) {
    return raw;
  }

  // 흰색 특수 표식
  if (
    raw === "w_circle" ||
    raw === "w_x" ||
    raw === "w_skull" ||
    raw === "w_dragon" ||
    raw === "w_turtle" ||
    raw === "w_bird" ||
    raw === "w_tiger"
  ) {
    return raw;
  }

  // 구버전 클라이언트 최소 호환
  if (raw === "red") return "r1";
  if (raw === "darkyellow" || raw === "yellow") return "y1";
  if (raw === "green") return "g1";
  if (raw === "purple") return "p1";
  if (raw === "whitecircle") return "w_circle";
  if (raw === "whitex") return "w_x";
  if (raw === "skyblue" || raw === "blue") return "w_circle";
  if (/^#[0-9a-f]{6}$/i.test(raw)) return "w_circle";

  return "w_circle";
}

// 좌표 키싱크 상태만 허용.
// M:R:1:25 = MAIN, 오른쪽, 이동 중, 시퀀스 25
// S:N:0:0  = SUB 생존 좌표
function cleanSyncState(state) {
  const raw = String(state || "").trim();

  const match = raw.match(
    /^([MS]):([LRUDN]):([01]):(\d{1,10})$/i
  );

  if (!match) return "S:N:0:0";

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
  const hash = String(value || "").trim().toUpperCase();
  return /^[0-9A-F]{16}$/.test(hash) ? hash : "";
}

function cleanRouteMove(value) {
  const move = String(value || "").trim().toUpperCase();
  return /^[LRUDE]$/.test(move) ? move : "";
}

function okPass(pass) {
  return String(pass || "") === String(ACCESS_PASS || "");
}

// ================================================================
// 기존 패자 지도 데이터
// ================================================================

function cleanOld() {
  const now = Date.now();

  for (const [name, p] of players.entries()) {
    if (now - p.t > ONLINE_TTL_MS) {
      players.delete(name);
    }
  }
}

function getMajorPoint(xKey, yKey, tKey, ttlMs, mapFilter = null) {
  const now = Date.now();
  const groups = new Map();

  for (const [, p] of players.entries()) {
    if (mapFilter !== null && String(p.map || "") !== mapFilter) continue;

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

    if (
      g.count > best.count ||
      (g.count === best.count && g.latest > best.latest)
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

// mapMode=true인 새 지도 클라이언트는 같은 맵 사람만 받는다.
// mapMode가 없는 구버전 클라이언트/GET은 기존처럼 전체 목록을 받아 호환성을 유지한다.
function makeText(options = {}) {
  cleanOld();

  const now = Date.now();
  const lines = [];
  const mapMode = options.mapMode === true;
  const requestMap = cleanMapName(options.map || "");
  const requester = cleanName(options.requester || "");

  for (const [name, p] of players.entries()) {
    if (mapMode) {
      if (requestMap) {
        if (String(p.map || "") !== requestMap) continue;
      } else {
        // 현재 맵을 판정하지 못한 새 클라이언트끼리 서로 다른 맵이 섞이지 않게
        // 자기 자신 외의 원격 점은 반환하지 않는다.
        if (name !== requester) continue;
      }
    }

    const ageMs = Math.max(0, now - (p.t || 0));
    if (!p.coordValid || ageMs > PLAYER_TTL_MS) continue;

    lines.push(
      `P|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}|1`
    );
  }

  // 최신 지도 UI의 ONLINE 패널용 전체 접속자.
  // P는 기존처럼 같은 맵만, U는 맵과 상관없이 현재 살아 있는 사용자 전체다.
  // 구버전 지도 클라이언트는 U 라인을 자동으로 무시하므로 호환된다.
  for (const [name, p] of players.entries()) {
    const ageMs = Math.max(0, now - (p.t || 0));
    if (ageMs > ONLINE_TTL_MS) continue;

    lines.push(
      `U|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}|${p.coordValid ? 1 : 0}`
    );
  }

  const pointMapFilter = mapMode ? requestMap : null;

  if (!mapMode || requestMap) {
    const bless = getMajorBless(pointMapFilter);

    if (bless) {
      const ageMs = Math.max(0, now - (bless.latest || 0));
      lines.push(
        `B|${bless.x}|${bless.y}|${bless.count}|${ageMs}`
      );
    }

    const first = getMajorFirst(pointMapFilter);

    if (first) {
      const ageMs = Math.max(0, now - (first.latest || 0));
      lines.push(
        `F|${first.x}|${first.y}|${first.count}|${ageMs}`
      );
    }
  }

  return lines.join("\n");
}

// ================================================================
// 새 좌표 키싱크 데이터
// ================================================================

function cleanOldSync() {
  const now = Date.now();

  for (const [name, p] of syncPlayers.entries()) {
    if (now - p.t > SYNC_TTL_MS) {
      syncPlayers.delete(name);
    }
  }
}

function makeSyncText(sessionFilter = "") {
  cleanOldSync();

  const lines = [];

  // S|이름|X|Y|상태|맵지문
  for (const [name, p] of syncPlayers.entries()) {
    lines.push(
      `S|${name}|${p.x}|${p.y}|${p.state}|${p.mapHash || ""}`
    );
  }

  for (const route of syncRoutes.values()) {
    if (
      sessionFilter &&
      route.session !== sessionFilter
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
    .send("bukbang xy + coordinate sync server ok");
});

app.post("/check", (req, res) => {
  if (!okPass(req.body.pass)) {
    res
      .status(403)
      .type("text/plain")
      .send("ERR|BADPASS");
    return;
  }

  res.type("text/plain").send("OK");
});

// ================================================================
// 기존 패자 지도 /xy
// 이 구간은 기존 동작을 그대로 유지한다.
// ================================================================

app.get("/xy", (req, res) => {
  // GET은 기존 도구 호환을 위해 전체 목록을 유지한다.
  res.type("text/plain").send(makeText());
});

app.post("/xy", (req, res) => {
  if (!okPass(req.body.pass)) {
    res
      .status(403)
      .type("text/plain")
      .send("ERR|BADPASS");
    return;
  }

  const name = cleanName(req.body.name);
  const x = parseInt(req.body.x, 10);
  const y = parseInt(req.body.y, 10);
  const color = cleanColor(req.body.color);

  // 범용 패자지도 맵 구분. 좌표 키싱크 /sync의 session/mapHash와는 전혀 공유하지 않는다.
  const map = cleanMapName(req.body.map);
  const mapMode = String(req.body.mapMode || "") === "1";

  const coordOkProvided =
    req.body.coordOk !== undefined;

  const coordValid = coordOkProvided
    ? String(req.body.coordOk || "") === "1"
    : (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        y >= 0
      );

  const blessX =
    parseInt(req.body.blessX, 10);

  const blessY =
    parseInt(req.body.blessY, 10);

  // 클라가 firstX/firstY 또는 rank1X/rank1Y 둘 중 뭐로 보내도 받음.
  const firstXRaw =
    req.body.firstX !== undefined
      ? req.body.firstX
      : req.body.rank1X;

  const firstYRaw =
    req.body.firstY !== undefined
      ? req.body.firstY
      : req.body.rank1Y;

  const firstX =
    parseInt(firstXRaw, 10);

  const firstY =
    parseInt(firstYRaw, 10);

  // 지도 ONLINE 생존은 좌표 변화와 분리한다.
  // 새 클라이언트는 coordOk=0이어도 50ms heartbeat로 ONLINE을 유지한다.
  // 좌표가 정상일 때만 x/y를 갱신하므로 UNKNOWN/정지 상태에서도 접속자가 사라지지 않는다.
  if (name) {
    const old =
      players.get(name) || {};

    const next = {
      x:
        old.x ?? -1,

      y:
        old.y ?? -1,

      coordValid:
        old.coordValid === true,

      color,

      map:
        mapMode
          ? map
          : "",

      t:
        Date.now(),

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
      coordValid &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      // 범용 맵은 음수 좌표도 정상값이다. 예: Y=-3.
      next.x = x;
      next.y = y;
      next.coordValid = true;
    }

    if (
      Number.isFinite(blessX) &&
      Number.isFinite(blessY)
    ) {
      if (
        blessX >= 0 &&
        blessY >= 0
      ) {
        next.blessX = blessX;
        next.blessY = blessY;
        next.blessT = Date.now();
      }
    }

    if (
      Number.isFinite(firstX) &&
      Number.isFinite(firstY)
    ) {
      if (
        firstX >= 0 &&
        firstY >= 0
      ) {
        next.firstX = firstX;
        next.firstY = firstY;
        next.firstT = Date.now();
      }
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
        requester:
          name
      })
    );
});

// ================================================================
// 새 좌표 키싱크 /sync
// 패자 지도 players, color, bless, first와 완전히 별도.
// ================================================================

app.get("/sync", (req, res) => {
  const session =
    cleanSession(
      req.query.session
    );

  res
    .type("text/plain")
    .send(
      makeSyncText(session)
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
        t:
          Date.now()
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
      routeSeq >=
        old.seq
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
      makeSyncText(session)
    );
});

app.listen(PORT, () => {
  console.log(
    `bukbang xy + coordinate sync server running on ${PORT}`
  );
});

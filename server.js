const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

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

// MAP MASTER 전용 키. Render에 MAP_MASTER_KEY를 따로 만들면 그 값을 사용한다.
// 설정하지 않으면 기존 MAP_PASS와 같은 값을 사용하므로 바로 동작한다.
const MAP_MASTER_KEY = process.env.MAP_MASTER_KEY || ACCESS_PASS;

// 맵 파일은 Render 메모리에 보관한다. Render 재시작 시 비워지지만
// 켜져 있는 MAP MASTER 클라이언트가 자동으로 다시 업로드한다.
let mapVersion = 0;
const mapBlobStore = new Map(); // sha256 -> Buffer
let mapManifest = new Map();   // filename -> { sha, size }

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

  // 현재 표식
  if (
    raw === "whitecircle" ||
    raw === "white_circle" ||
    raw === "w_circle"
  ) {
    return "whitecircle";
  }

  if (
    raw === "whitex" ||
    raw === "white_x" ||
    raw === "w_x"
  ) {
    return "whitex";
  }

  if (raw === "red") return "red";

  if (
    raw === "darkyellow" ||
    raw === "yellow"
  ) {
    return "darkyellow";
  }

  if (
    raw === "skyblue" ||
    raw === "blue"
  ) {
    return "skyblue";
  }

  if (raw === "purple") return "purple";
  if (raw === "green") return "green";

  if (
    raw === "skull" ||
    raw === "w_skull"
  ) {
    return "skull";
  }

  if (
    raw === "bird" ||
    raw === "w_bird"
  ) {
    return "bird";
  }

  // 직전 숫자표식 버전 호환
  if (/^r[0-9]$/.test(raw)) return "red";
  if (/^y[0-9]$/.test(raw)) return "darkyellow";
  if (/^b[0-9]$/.test(raw)) return "skyblue";
  if (/^p[0-9]$/.test(raw)) return "purple";
  if (/^g[0-9]$/.test(raw)) return "green";

  return "whitecircle";
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
  const hash = String(value || "")
    .trim()
    .toUpperCase();

  return /^[0-9A-F]{16}$/.test(hash)
    ? hash
    : "";
}

function cleanRouteMove(value) {
  const move = String(value || "")
    .trim()
    .toUpperCase();

  return /^[LRUDE]$/.test(move)
    ? move
    : "";
}

function okPass(pass) {
  return (
    String(pass || "") ===
    String(ACCESS_PASS || "")
  );
}

function okMapMaster(master) {
  return (
    String(master || "") ===
    String(MAP_MASTER_KEY || "")
  );
}

// ================================================================
// 맵 파일 공유
// ================================================================

function cleanMapFileName(name) {
  const n = String(name || "").trim();

  if (!n || n.length > 160) {
    return "";
  }

  if (
    n.includes("/") ||
    n.includes("\\") ||
    n.includes("..") ||
    n.includes("|")
  ) {
    return "";
  }

  if (/[\x00-\x1f]/.test(n)) {
    return "";
  }

  const lower = n.toLowerCase();

  if (lower === "maps.txt") {
    return n;
  }

  if (lower.endsWith(".png")) {
    return n;
  }

  if (lower.endsWith(".jpg")) {
    return n;
  }

  if (lower.endsWith(".jpeg")) {
    return n;
  }

  if (lower.endsWith(".bmp")) {
    return n;
  }

  if (lower.endsWith(".webp")) {
    return n;
  }

  return "";
}

function sha256Buffer(buf) {
  return crypto
    .createHash("sha256")
    .update(buf)
    .digest("hex");
}

function makeMapStateText() {
  const lines = [
    `V|${mapVersion}`
  ];

  const names =
    Array.from(
      mapManifest.keys()
    ).sort(
      (a, b) =>
        a.localeCompare(
          b,
          "en",
          {
            sensitivity: "base"
          }
        )
    );

  for (
    const name
    of names
  ) {
    const f =
      mapManifest.get(name);

    if (!f) {
      continue;
    }

    lines.push(
      `F|${encodeURIComponent(name)}|${f.sha}|${f.size}`
    );
  }

  return lines.join("\n");
}

function parseCommitManifest(
  base64Text
) {
  let text = "";

  try {
    text =
      Buffer
        .from(
          String(
            base64Text || ""
          ),
          "base64"
        )
        .toString("utf8");
  }
  catch {
    return null;
  }

  const next =
    new Map();

  const lines =
    text
      .replace(/\r/g, "")
      .split("\n");

  for (
    const raw
    of lines
  ) {
    if (!raw) {
      continue;
    }

    const cut =
      raw.lastIndexOf("|");

    if (cut <= 0) {
      return null;
    }

    const name =
      cleanMapFileName(
        raw.slice(0, cut)
      );

    const sha =
      raw
        .slice(cut + 1)
        .trim()
        .toLowerCase();

    if (
      !name ||
      !/^[0-9a-f]{64}$/.test(sha)
    ) {
      return null;
    }

    const blob =
      mapBlobStore.get(sha);

    if (
      !Buffer.isBuffer(blob)
    ) {
      return null;
    }

    next.set(
      name,
      {
        sha,
        size: blob.length
      }
    );
  }

  if (
    !Array
      .from(next.keys())
      .some(
        n =>
          n.toLowerCase() ===
          "maps.txt"
      )
  ) {
    return null;
  }

  return next;
}

function mapManifestSignature(
  manifest
) {
  const names =
    Array.from(
      manifest.keys()
    ).sort(
      (a, b) =>
        a.localeCompare(
          b,
          "en",
          {
            sensitivity: "base"
          }
        )
    );

  return names
    .map(
      name => {
        const f =
          manifest.get(name);

        return (
          `${name}|${f.sha}|${f.size}`
        );
      }
    )
    .join("\n");
}

// ================================================================
// 기존 패자 지도 데이터
// ================================================================

function cleanOld() {
  const now =
    Date.now();

  for (
    const [name, p]
    of players.entries()
  ) {
    if (
      now - p.t >
      ONLINE_TTL_MS
    ) {
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
  const now =
    Date.now();

  const groups =
    new Map();

  for (
    const [, p]
    of players.entries()
  ) {
    if (
      mapFilter !== null &&
      String(p.map || "") !==
        mapFilter
    ) {
      continue;
    }

    const px =
      Number.isFinite(
        p[xKey]
      )
        ? p[xKey]
        : -1;

    const py =
      Number.isFinite(
        p[yKey]
      )
        ? p[yKey]
        : -1;

    const pt =
      p[tKey] || 0;

    if (
      px < 0 ||
      py < 0
    ) {
      continue;
    }

    if (
      now - pt >
      ttlMs
    ) {
      continue;
    }

    const key =
      `${px},${py}`;

    if (
      !groups.has(key)
    ) {
      groups.set(
        key,
        {
          x: px,
          y: py,
          count: 0,
          latest: 0
        }
      );
    }

    const g =
      groups.get(key);

    g.count++;

    g.latest =
      Math.max(
        g.latest,
        pt
      );
  }

  let best = null;

  for (
    const g
    of groups.values()
  ) {
    if (!best) {
      best = g;
      continue;
    }

    if (
      g.count >
        best.count ||
      (
        g.count ===
          best.count &&
        g.latest >
          best.latest
      )
    ) {
      best = g;
    }
  }

  return best;
}

function getMajorBless(
  mapFilter = null
) {
  return getMajorPoint(
    "blessX",
    "blessY",
    "blessT",
    BLESS_TTL_MS,
    mapFilter
  );
}

function getMajorFirst(
  mapFilter = null
) {
  return getMajorPoint(
    "firstX",
    "firstY",
    "firstT",
    FIRST_TTL_MS,
    mapFilter
  );
}

function makeText(
  options = {}
) {
  cleanOld();

  const now =
    Date.now();

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

  // ------------------------------------------------
  // P
  // 현재 맵 지도 점
  // ------------------------------------------------

  for (
    const [name, p]
    of players.entries()
  ) {
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
        if (
          name !== requester
        ) {
          continue;
        }
      }
    }

    const ageMs =
      Math.max(
        0,
        now - (p.t || 0)
      );

    if (
      !p.coordValid ||
      ageMs >
        PLAYER_TTL_MS
    ) {
      continue;
    }

    lines.push(
      `P|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}|1`
    );
  }

  // ------------------------------------------------
  // U
  // 전체 ONLINE
  // ------------------------------------------------

  for (
    const [name, p]
    of players.entries()
  ) {
    const ageMs =
      Math.max(
        0,
        now - (p.t || 0)
      );

    if (
      ageMs >
      ONLINE_TTL_MS
    ) {
      continue;
    }

    lines.push(
      `U|${name}|${p.x}|${p.y}|${p.color}|${p.map || ""}|${ageMs}|${p.coordValid ? 1 : 0}`
    );
  }

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
          now -
            (bless.latest || 0)
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
          now -
            (first.latest || 0)
        );

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
  const now =
    Date.now();

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

app.get(
  "/",
  (req, res) => {
    res
      .type("text/plain")
      .send(
        "bukbang xy + coordinate sync server ok"
      );
  }
);

app.post(
  "/check",
  (req, res) => {
    if (
      !okPass(
        req.body.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

      return;
    }

    res
      .type("text/plain")
      .send("OK");
  }
);

// ================================================================
// map 폴더 실시간 공유
// /xy와 /sync 어느 저장소도 건드리지 않는다.
// ================================================================

app.get(
  "/map/state",
  (req, res) => {
    if (
      !okPass(
        req.query.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

      return;
    }

    res
      .type("text/plain")
      .send(
        makeMapStateText()
      );
  }
);

app.post(
  "/map/upload",

  express.raw({
    type:
      "application/octet-stream",

    limit:
      "50mb"
  }),

  (req, res) => {
    if (
      !okPass(
        req.query.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

      return;
    }

    if (
      !okMapMaster(
        req.query.master
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADMASTER"
        );

      return;
    }

    const name =
      cleanMapFileName(
        req.query.name
      );

    const wantSha =
      String(
        req.query.sha || ""
      )
        .trim()
        .toLowerCase();

    if (
      !name ||
      !/^[0-9a-f]{64}$/.test(
        wantSha
      ) ||
      !Buffer.isBuffer(
        req.body
      )
    ) {
      res
        .status(400)
        .type("text/plain")
        .send(
          "ERR|BADFILE"
        );

      return;
    }

    const actualSha =
      sha256Buffer(
        req.body
      );

    if (
      actualSha !== wantSha
    ) {
      res
        .status(400)
        .type("text/plain")
        .send(
          "ERR|BADSHA"
        );

      return;
    }

    mapBlobStore.set(
      actualSha,
      Buffer.from(
        req.body
      )
    );

    res
      .type("text/plain")
      .send(
        `OK|${actualSha}`
      );
  }
);

app.post(
  "/map/commit",
  (req, res) => {
    if (
      !okPass(
        req.body.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

      return;
    }

    if (
      !okMapMaster(
        req.body.master
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADMASTER"
        );

      return;
    }

    const next =
      parseCommitManifest(
        req.body.manifest
      );

    if (!next) {
      res
        .status(400)
        .type("text/plain")
        .send(
          "ERR|BADMANIFEST"
        );

      return;
    }

    const before =
      mapManifestSignature(
        mapManifest
      );

    const after =
      mapManifestSignature(
        next
      );

    if (
      before !== after
    ) {
      mapManifest =
        next;

      mapVersion++;

      if (
        mapVersion >
        2000000000
      ) {
        mapVersion = 1;
      }

      const keep =
        new Set(
          Array
            .from(
              mapManifest.values()
            )
            .map(
              v => v.sha
            )
        );

      for (
        const sha
        of Array.from(
          mapBlobStore.keys()
        )
      ) {
        if (
          !keep.has(sha)
        ) {
          mapBlobStore.delete(
            sha
          );
        }
      }
    }

    res
      .type("text/plain")
      .send(
        makeMapStateText()
      );
  }
);

app.get(
  "/map/file",
  (req, res) => {
    if (
      !okPass(
        req.query.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

      return;
    }

    const name =
      cleanMapFileName(
        req.query.name
      );

    const item =
      name
        ? mapManifest.get(
            name
          )
        : null;

    if (!item) {
      res
        .status(404)
        .type("text/plain")
        .send(
          "ERR|NOFILE"
        );

      return;
    }

    const wantSha =
      String(
        req.query.sha || ""
      )
        .trim()
        .toLowerCase();

    if (
      wantSha &&
      wantSha !==
        item.sha
    ) {
      res
        .status(409)
        .type("text/plain")
        .send(
          "ERR|STALE"
        );

      return;
    }

    const blob =
      mapBlobStore.get(
        item.sha
      );

    if (!blob) {
      res
        .status(404)
        .type("text/plain")
        .send(
          "ERR|NOBLOB"
        );

      return;
    }

    const lower =
      name.toLowerCase();

    if (
      lower.endsWith(
        ".png"
      )
    ) {
      res.type(
        "image/png"
      );
    }
    else if (
      lower.endsWith(
        ".jpg"
      ) ||
      lower.endsWith(
        ".jpeg"
      )
    ) {
      res.type(
        "image/jpeg"
      );
    }
    else if (
      lower.endsWith(
        ".webp"
      )
    ) {
      res.type(
        "image/webp"
      );
    }
    else if (
      lower ===
      "maps.txt"
    ) {
      res.type(
        "text/plain; charset=utf-8"
      );
    }
    else {
      res.type(
        "application/octet-stream"
      );
    }

    res.send(blob);
  }
);

// ================================================================
// 기존 패자 지도 /xy
// ================================================================

app.get(
  "/xy",
  (req, res) => {
    res
      .type("text/plain")
      .send(
        makeText()
      );
  }
);

app.post(
  "/xy",
  (req, res) => {
    if (
      !okPass(
        req.body.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

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

    const map =
      cleanMapName(
        req.body.map
      );

    const mapMode =
      String(
        req.body.mapMode || ""
      ) === "1";

    const coordOkProvided =
      req.body.coordOk !==
      undefined;

    const coordValid =
      coordOkProvided
        ? String(
            req.body.coordOk || ""
          ) === "1"
        : (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0
          );

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
      req.body.firstX !==
      undefined
        ? req.body.firstX
        : req.body.rank1X;

    const firstYRaw =
      req.body.firstY !==
      undefined
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

    if (name) {
      const old =
        players.get(name) ||
        {};

      const next = {
        x:
          old.x ?? -1,

        y:
          old.y ?? -1,

        coordValid:
          old.coordValid ===
          true,

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
        next.x = x;
        next.y = y;
        next.coordValid = true;
      }

      if (
        Number.isFinite(
          blessX
        ) &&
        Number.isFinite(
          blessY
        )
      ) {
        if (
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
      }

      if (
        Number.isFinite(
          firstX
        ) &&
        Number.isFinite(
          firstY
        )
      ) {
        if (
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
  }
);

// ================================================================
// 좌표 키싱크 /sync
// 기존 저장소/프로토콜 그대로 유지
// ================================================================

app.get(
  "/sync",
  (req, res) => {
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
  }
);

app.post(
  "/sync",
  (req, res) => {
    if (
      !okPass(
        req.body.pass
      )
    ) {
      res
        .status(403)
        .type("text/plain")
        .send(
          "ERR|BADPASS"
        );

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
      Number.isFinite(
        routeX
      ) &&
      Number.isFinite(
        routeY
      ) &&
      routeX >= 0 &&
      routeY >= 0 &&
      routeMove &&
      Number.isFinite(
        routeSeq
      ) &&
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
        makeSyncText(
          session
        )
      );
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `bukbang xy + coordinate sync server running on ${PORT}`
    );
  }
);

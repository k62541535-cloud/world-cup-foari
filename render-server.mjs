import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import session from "express-session";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number.parseInt(process.env.PORT || "8080", 10);
const root = __dirname;
const dataDir = path.join(root, "data");
const matchesPath = path.join(dataDir, "matches.json");
const predictionsPath = path.join(dataDir, "predictions.json");
const fifaScheduleUrl =
  "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums";

const refreshState = {
  sourceUrl: fifaScheduleUrl,
  sourceLabel: "FIFA",
  lastSyncedAt: null,
  lastRefreshSucceeded: false
};

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
const adminCode = (process.env.ADMIN_CODE || "admin123").trim();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "pulse-cup-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

function getRefreshInfo() {
  return {
    sourceUrl: refreshState.sourceUrl,
    sourceLabel: refreshState.sourceLabel,
    lastSyncedAt: refreshState.lastSyncedAt,
    lastRefreshSucceeded: refreshState.lastRefreshSucceeded
  };
}

function getServerInfo(req) {
  const urls = [];
  const requestOrigin = `${req.protocol}://${req.get("host")}`;

  if (requestOrigin) {
    urls.push(requestOrigin);
  }

  if (publicBaseUrl) {
    urls.push(publicBaseUrl.replace(/\/$/, ""));
  }

  return {
    port,
    shareUrls: [...new Set(urls)]
  };
}

function getGoogleAuthInfo() {
  return {
    enabled: Boolean(googleClientId),
    clientId: googleClientId
  };
}

async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

async function getPredictionsStore() {
  const store = (await readJsonFile(predictionsPath, { entries: [], participants: [] })) || {
    entries: [],
    participants: []
  };

  if (!Array.isArray(store.entries)) {
    store.entries = [];
  }

  if (!Array.isArray(store.participants)) {
    store.participants = [];
  }

  return store;
}

async function ensureParticipantRegistered(name) {
  const trimmedName = String(name || "").trim();

  if (!trimmedName) {
    return;
  }

  const store = await getPredictionsStore();
  const existingParticipant = store.participants.find(
    (participant) => normalizeName(participant.name) === normalizeName(trimmedName)
  );

  if (existingParticipant) {
    return;
  }

  store.participants.push({
    name: trimmedName,
    joinedAt: new Date().toISOString()
  });
  await writeJsonFile(predictionsPath, store);
}

function getOutcome(home, away) {
  if (home === away) {
    return "draw";
  }

  return home > away ? "home" : "away";
}

function scorePrediction(prediction, match) {
  if (!match.actual || !Number.isInteger(match.actual.home) || !Number.isInteger(match.actual.away)) {
    return { points: 0, exact: false };
  }

  if (!Array.isArray(prediction) || prediction.length !== 2) {
    return { points: 0, exact: false };
  }

  const home = Number.parseInt(prediction[0], 10);
  const away = Number.parseInt(prediction[1], 10);

  if (!Number.isInteger(home) || !Number.isInteger(away)) {
    return { points: 0, exact: false };
  }

  if (home === match.actual.home && away === match.actual.away) {
    return { points: 5, exact: true };
  }

  if (getOutcome(home, away) === getOutcome(match.actual.home, match.actual.away)) {
    return { points: 3, exact: false };
  }

  return { points: 0, exact: false };
}

async function getScoredEntries() {
  const matches = (await readJsonFile(matchesPath, [])) || [];
  const store = await getPredictionsStore();
  const entries = store.entries;
  const scoredEntries = entries.map((entry) => {
    let points = 0;
    let exact = 0;

    for (const match of matches) {
      const result = scorePrediction(entry.predictions?.[match.id], match);
      points += result.points;
      if (result.exact) {
        exact += 1;
      }
    }

    return {
      name: entry.name,
      updatedAt: entry.updatedAt,
      points,
      exact,
      submitted: true
    };
  });

  const scoredByName = new Map(scoredEntries.map((entry) => [normalizeName(entry.name), entry]));
  const joinedEntries = store.participants
    .filter((participant) => !scoredByName.has(normalizeName(participant.name)))
    .map((participant) => ({
      name: participant.name,
      updatedAt: participant.joinedAt,
      points: 0,
      exact: 0,
      submitted: false
    }));

  return [...scoredEntries, ...joinedEntries]
    .map((entry) => {
      let points = 0;
      let exact = 0;
      return {
        ...entry,
        points: entry.points ?? points,
        exact: entry.exact ?? exact
      };
    })
    .sort((left, right) => {
      if (right.points !== left.points) {
        return right.points - left.points;
      }

      if (right.exact !== left.exact) {
        return right.exact - left.exact;
      }

      if (Boolean(right.submitted) !== Boolean(left.submitted)) {
        return Number(right.submitted) - Number(left.submitted);
      }

      return left.name.localeCompare(right.name);
    });
}

async function hasExistingSubmission(name) {
  const store = await getPredictionsStore();
  return store.entries.some((entry) => normalizeName(entry.name) === normalizeName(name));
}

const flagMap = {
  Algeria: "🇩🇿",
  Argentina: "🇦🇷",
  Australia: "🇦🇺",
  Austria: "🇦🇹",
  Belgium: "🇧🇪",
  Bolivia: "🇧🇴",
  "Bosnia and Herzegovina": "🇧🇦",
  Brazil: "🇧🇷",
  "Cabo Verde": "🇨🇻",
  Canada: "🇨🇦",
  Colombia: "🇨🇴",
  "Congo DR": "🇨🇩",
  "Costa Rica": "🇨🇷",
  "Cote d'Ivoire": "🇨🇮",
  Croatia: "🇭🇷",
  Curacao: "🇨🇼",
  Czechia: "🇨🇿",
  Denmark: "🇩🇰",
  Ecuador: "🇪🇨",
  Egypt: "🇪🇬",
  England: "🏴",
  France: "🇫🇷",
  Germany: "🇩🇪",
  Ghana: "🇬🇭",
  Haiti: "🇭🇹",
  "IR Iran": "🇮🇷",
  Iraq: "🇮🇶",
  Italy: "🇮🇹",
  Jamaica: "🇯🇲",
  Japan: "🇯🇵",
  Jordan: "🇯🇴",
  "Korea Republic": "🇰🇷",
  Mexico: "🇲🇽",
  Morocco: "🇲🇦",
  Netherlands: "🇳🇱",
  "New Zealand": "🇳🇿",
  Norway: "🇳🇴",
  Paraguay: "🇵🇾",
  Panama: "🇵🇦",
  Poland: "🇵🇱",
  Portugal: "🇵🇹",
  Qatar: "🇶🇦",
  Romania: "🇷🇴",
  "Saudi Arabia": "🇸🇦",
  Scotland: "🏴",
  Senegal: "🇸🇳",
  Slovakia: "🇸🇰",
  "South Africa": "🇿🇦",
  Spain: "🇪🇸",
  Sweden: "🇸🇪",
  Switzerland: "🇨🇭",
  Tunisia: "🇹🇳",
  "Türkiye": "🇹🇷",
  Turkey: "🇹🇷",
  USA: "🇺🇸",
  Ukraine: "🇺🇦",
  Uruguay: "🇺🇾",
  Uzbekistan: "🇺🇿",
  Wales: "🏴"
};

function normalizeTeamName(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/Côte d'Ivoire/g, "Cote d'Ivoire")
    .replace(/Curaçao/g, "Curacao");
}

function getTeamFlag(name) {
  const normalized = normalizeTeamName(name);
  return flagMap[normalized] || "🏳️";
}

function normalizeStageLabel(stage) {
  if (stage === "Bronze final") {
    return "Third Place";
  }

  if (stage === "Quarter-finals") {
    return "Quarterfinal";
  }

  if (stage === "Semi-finals") {
    return "Semifinal";
  }

  if (stage.startsWith("Group ")) {
    return "Group Stage";
  }

  return stage;
}

function getTitleForStage(stage) {
  if (stage.startsWith("Group ")) {
    return stage;
  }

  if (stage === "Bronze final") {
    return "Third-place Play-off";
  }

  return stage;
}

function newMatchId(stage, home, away, dateLabel) {
  return `${stage}-${home}-${away}-${dateLabel}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function convertHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|section|article|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;|&ndash;/g, " - ")
    .replace(/&#8212;|&mdash;/g, " - ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

async function getFifaScheduleMatches() {
  const venues = [
    "Mexico City Stadium",
    "Estadio Guadalajara",
    "Toronto Stadium",
    "Los Angeles Stadium",
    "Boston Stadium",
    "BC Place Vancouver",
    "New York New Jersey Stadium",
    "San Francisco Bay Area Stadium",
    "Philadelphia Stadium",
    "Houston Stadium",
    "Dallas Stadium",
    "Estadio Monterrey",
    "Miami Stadium",
    "Atlanta Stadium",
    "Kansas City Stadium",
    "Seattle Stadium"
  ];

  const venuePattern = venues.map((venue) => venue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stagePattern = "Group [A-L]|Round of 32|Round of 16|Quarter-finals|Semi-finals|Bronze final|Final";
  const datePattern = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} (June|July) 2026$/;
  const fixturePattern = new RegExp(`(?<home>.+?) v (?<away>.+?)\\s*-\\s*(?<stage>${stagePattern})\\s*-\\s*(?<venue>${venuePattern})`, "g");

  const response = await fetch(fifaScheduleUrl);
  if (!response.ok) {
    throw new Error(`FIFA schedule request failed (${response.status}).`);
  }

  const html = await response.text();
  const text = convertHtmlToText(html);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const matches = [];
  let currentDate = null;
  let collecting = false;

  for (const line of lines) {
    if (line === "FIFA World Cup 2026 Group Stage fixtures") {
      collecting = true;
      continue;
    }

    if (!collecting) {
      continue;
    }

    if (/^Tap for World Cup 2026 ticket information$/.test(line)) {
      break;
    }

    if (datePattern.test(line)) {
      currentDate = line;
      continue;
    }

    if (!currentDate) {
      continue;
    }

    const normalizedLine = line.replace(/\s+/g, " ");
    const fixtureMatches = [...normalizedLine.matchAll(fixturePattern)];

    for (const fixture of fixtureMatches) {
      const rawStage = fixture.groups.stage.trim();
      const home = normalizeTeamName(fixture.groups.home);
      const away = normalizeTeamName(fixture.groups.away);
      const venue = fixture.groups.venue.trim();

      matches.push({
        id: newMatchId(rawStage, home, away, currentDate),
        stage: normalizeStageLabel(rawStage),
        title: getTitleForStage(rawStage),
        dateLabel: currentDate,
        venue,
        home,
        away,
        homeFlag: getTeamFlag(home),
        awayFlag: getTeamFlag(away),
        actual: null,
        winnerNote: "Auto-updated from FIFA official schedule"
      });
    }
  }

  if (matches.length < 16) {
    throw new Error("Unable to parse enough fixtures from FIFA schedule page.");
  }

  return matches;
}

async function tryRefreshMatches() {
  try {
    const stats = await fs.stat(matchesPath);
    refreshState.lastSyncedAt = stats.mtime.toISOString();
    refreshState.lastRefreshSucceeded = true;
    return true;
  } catch {
    refreshState.lastSyncedAt = null;
    refreshState.lastRefreshSucceeded = false;
    return false;
  }
}

async function verifyGoogleCredential(credential) {
  if (!credential) {
    throw new Error("Google credential is missing.");
  }

  if (!googleClientId) {
    throw new Error("Google sign-in is not configured on the server.");
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
  );

  if (!response.ok) {
    throw new Error("Google token verification failed.");
  }

  const payload = await response.json();

  if (payload.aud !== googleClientId) {
    throw new Error("Google token audience does not match this app.");
  }

  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") {
    throw new Error("Google token issuer is invalid.");
  }

  if (payload.email_verified !== "true") {
    throw new Error("Google account email is not verified.");
  }

  return {
    username: payload.name,
    email: payload.email,
    picture: payload.picture,
    provider: "google",
    subject: payload.sub
  };
}

function ensureAuthenticated(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  next();
}

async function getBootstrapPayload(req) {
  return {
    matches: (await readJsonFile(matchesPath, [])) || [],
    leaderboard: await getScoredEntries(),
    refreshInfo: getRefreshInfo(),
    serverInfo: getServerInfo(req)
  };
}

app.get("/api/auth/session", (req, res) => {
  if (!req.session.user) {
    res.json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      username: req.session.user.username,
      isAdmin: Boolean(req.session.user.isAdmin)
    }
  });
});

app.get("/api/auth/google/config", (req, res) => {
  res.json(getGoogleAuthInfo());
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const googleUser = await verifyGoogleCredential(req.body?.credential);
    await ensureParticipantRegistered(googleUser.username);
    req.session.user = {
      ...googleUser,
      isAdmin: false,
      createdAt: new Date().toISOString()
    };

    res.json({
      ok: true,
      user: {
        username: googleUser.username,
        email: googleUser.email,
        provider: "google",
        isAdmin: false
      }
    });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.post("/api/admin/unlock", ensureAuthenticated, async (req, res) => {
  const code = String(req.body?.code || "").trim();

  if (!code || code !== adminCode) {
    res.status(403).json({ error: "Admin code is incorrect." });
    return;
  }

  req.session.user.isAdmin = true;
  res.json({
    ok: true,
    user: {
      username: req.session.user.username,
      isAdmin: true
    }
  });
});

app.get("/api/bootstrap", ensureAuthenticated, async (req, res) => {
  res.json(await getBootstrapPayload(req));
});

app.get("/api/leaderboard", ensureAuthenticated, async (req, res) => {
  res.json({
    leaderboard: await getScoredEntries()
  });
});

app.post("/api/refresh", ensureAuthenticated, async (req, res) => {
  await tryRefreshMatches();
  res.json(await getBootstrapPayload(req));
});

app.post("/api/predictions", ensureAuthenticated, async (req, res) => {
  const name = String(req.body?.name || "");

  if (!name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  if (name !== req.session.user.username) {
    res.status(403).json({ error: "You can only submit picks for your signed-in account." });
    return;
  }

  if (await hasExistingSubmission(name)) {
    res.status(403).json({ error: "This account already submitted picks and is now locked." });
    return;
  }

  await ensureParticipantRegistered(name);
  const store = await getPredictionsStore();
  store.entries.push({
    name,
    updatedAt: new Date().toISOString(),
    predictions: req.body?.predictions || {}
  });
  await writeJsonFile(predictionsPath, store);

  res.json({
    ok: true,
    leaderboard: await getScoredEntries()
  });
});

app.post("/api/reset", ensureAuthenticated, async (req, res) => {
  res.status(403).json({ error: "Submitted entries are locked and cannot be reset." });
});

app.use(express.static(root));

app.get("*", (req, res) => {
  res.sendFile(path.join(root, "index.html"));
});

await tryRefreshMatches();

app.listen(port, () => {
  const shareUrls = publicBaseUrl ? [publicBaseUrl] : [`http://localhost:${port}`];
  console.log("Pulse Cup Predictor Render server running at:");
  for (const url of shareUrls) {
    console.log(` - ${url}`);
  }
});

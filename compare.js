// compare.js
// Work-oriented version (MEN):
// - Fetch ESPN scoreboard by date (Madrid timezone correct)
// - Match by ESPN team IDs when possible (best)
// - Fallback exact string match
// - Optional fuzzy matching (disabled in Strict mode)
// - Live compare updates while typing
// - Summary + Parse Errors + Resolve Errors
// - Copy mismatches button
//
// HYBRID additions:
// - Limit ESPN lines (to N, or to Other pasted count)
// - Hide unmatched ESPN lines (useful when creating in parts)
// - Row numbers (1,2,3...) in aligned comparison
// - Filters (All / Matches / Mismatches / ESPN missing / Other leftover)
// - Duplicate detection (ESPN + Other)
// - Venue column (H / N / ?), learned over time from ESPN API

const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard";

// --------------------------
// GLOBAL STATE (from last fetch)
// --------------------------
let lastEspnGames = [];     // array of game objects
let lastTeamIndex = null;   // built from lastEspnGames

// --------------------------
// HOME VENUE DB (learned)
// --------------------------
const HOME_VENUE_DB_KEY = "ncaab_home_venue_db_v1";

// { [teamId]: { primaryVenueId, primaryVenueName, counts: { [venueId]: { name, c } } } }
function loadHomeVenueDb() {
  try {
    return JSON.parse(localStorage.getItem(HOME_VENUE_DB_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveHomeVenueDb(db) {
  try {
    localStorage.setItem(HOME_VENUE_DB_KEY, JSON.stringify(db));
  } catch {}
}

function normalizeVenueName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[’'´`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function updateHomeVenueDbFromGames(games) {
  // Learn only from NON-neutral games where team is marked home
  const db = loadHomeVenueDb();

  for (const g of games) {
    if (!g.homeId || !g.venueId) continue;
    if (g.neutralSite) continue;

    const teamId = String(g.homeId);
    const venueId = String(g.venueId);
    const venueName = g.venueName || "";

    if (!db[teamId]) db[teamId] = { primaryVenueId: null, primaryVenueName: "", counts: {} };
    if (!db[teamId].counts[venueId]) db[teamId].counts[venueId] = { name: venueName, c: 0 };

    db[teamId].counts[venueId].c += 1;
    db[teamId].counts[venueId].name = venueName;
  }

  // recompute primary venue per team (most frequent)
  for (const teamId of Object.keys(db)) {
    const counts = db[teamId].counts || {};
    let bestVenueId = null;
    let bestCount = -1;

    for (const [venueId, obj] of Object.entries(counts)) {
      const c = obj?.c ?? 0;
      if (c > bestCount) {
        bestCount = c;
        bestVenueId = venueId;
      }
    }

    if (bestVenueId) {
      db[teamId].primaryVenueId = bestVenueId;
      db[teamId].primaryVenueName = counts[bestVenueId]?.name || "";
    }
  }

  saveHomeVenueDb(db);
  return db;
}

// Venue classification: only H / N / ?
function classifyVenueForGame(game, homeVenueDb) {
  const venueName = game?.venueName || "";
  const neutral = !!game?.neutralSite;

  // Neutral or non-home both become "N" for operational simplicity
  if (neutral) {
    return { code: "N", label: "Not home (neutral)", venueName };
  }

  const homeId = game?.homeId ? String(game.homeId) : null;
  const venueId = game?.venueId ? String(game.venueId) : null;
  if (!homeId || !venueId) return { code: "?", label: "Unknown venue", venueName };

  const homeRec = homeVenueDb?.[homeId];
  if (!homeRec?.primaryVenueId) return { code: "?", label: "Home venue not learned yet", venueName };

  // Exact ID match
  if (String(homeRec.primaryVenueId) === venueId) {
    return { code: "H", label: "Home venue", venueName };
  }

  // Fallback name match (rare: same arena but diff ID)
  const a = normalizeVenueName(homeRec.primaryVenueName);
  const b = normalizeVenueName(venueName);
  if (a && b && a === b) {
    return { code: "H", label: "Home venue", venueName };
  }

  // Everything else is "N" (not-home)
  return { code: "N", label: "Not home (alternate site)", venueName };
}

function venueBadgeHtml(v) {
  if (!v) return { cls: "badge", text: "?", title: "Unknown" };
  if (v.code === "H") return { cls: "badge badge-home", text: "H", title: `${v.label}: ${v.venueName}` };
  if (v.code === "N") return { cls: "badge badge-neutral", text: "N", title: `${v.label}: ${v.venueName}` };
  return { cls: "badge", text: "?", title: `${v.label}: ${v.venueName}` };
}

// --------------------------
// UTIL
// --------------------------
function debounce(fn, delay = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function stripLeadingJunk(line) {
  return (line || "").replace(/^[\s.\u2022\-–—]+/g, "").trim();
}

// --------------------------
// TEAM ALIASES
// --------------------------
const TEAM_ALIASES_COMMON = new Map([
  ["eastern tennessee st", "east tennessee state"],
  ["eastern tennessee state", "east tennessee state"],
  ["east tennessee st", "east tennessee state"],

  ["nwestern st", "northwestern state"],
  ["n'western st", "northwestern state"],
  ["northwestern st", "northwestern state"],

  ["missouri st", "missouri state"],

  ["etsu", "east tennessee state"],
  ["e tennessee st", "east tennessee state"],
  ["e tennessee state", "east tennessee state"],

  ["ohio st", "ohio state"],
  ["ohio st.", "ohio state"],

  ["s dakota st", "south dakota state"],
  ["s. dakota st", "south dakota state"],

  ["california san diego", "uc san diego"],

  ["indiana u", "indiana"],
  ["indiana u.", "indiana"],

  ["e washington", "eastern washington"],
  ["w kentucky", "western kentucky"],
  ["n kentucky", "northern kentucky"],
  ["no illinois", "northern illinois"],
  ["so illinois", "southern illinois"],

  ["coll charleston", "charleston"],
  ["detroit u", "detroit mercy"],
  ["detroit u.", "detroit mercy"],
  ["detroit mercy", "detroit mercy"],

  ["michigan st", "michigan state"],
  ["michigan st.", "michigan state"],

  ["north dakota st", "north dakota state"],
  ["north dakota st.", "north dakota state"],

  ["south dakota st", "south dakota state"],
  ["south dakota st.", "south dakota state"],

  ["tennessee st", "tennessee state"],
  ["tennessee st.", "tennessee state"],

  ["sacramento st", "sacramento state"],
  ["sacramento st.", "sacramento state"],
  
  ["cal irvine", "uc irvine"],
  ["cal san diego", "uc san diego"],
  ["cal riverside", "uc riverside"],
  ["ca baptist", "california baptist"],

  ["tenn martin", "ut martin"],
  ["tennessee martin", "ut martin"],

  ["middle tenn state", "mtsu"],
  ["middle tennessee state", "mtsu"],
  ["houston u", "houston"],

  ["md baltimore", "umbc"],

  ["florida international", "fiu"],
  ["illinois chicago", "uic"],
  ["kansas city", "umkc"],

  ["murray st", "murray state"],
  ["murray st.", "murray state"],
  ["oregon st", "oregon state"],
  ["oregon st.", "oregon state"],
  
  ["idaho st", "idaho state"],
  ["idaho st.", "idaho state"],
  ["weber st", "weber state"],
  ["weber st.", "weber state"],
  ["montana st", "montana state"],
  ["montana st.", "montana state"],
  ["portland st", "portland state"],
  ["portland st.", "portland state"],

  ["nebraska omaha", "omaha"],
  ["st thomas minnesota", "st thomas"],
  ["st thomas (mn)", "st thomas"],
  ["st. thomas minnesota", "st thomas"],
  ["st. thomas (mn)", "st thomas"],

  ["coastal", "coastal carolina"],

  ["purdue fw", "purdue fort wayne"],
  ["ipfw", "purdue fort wayne"],

  ["wisc green bay", "green bay"],
  ["wisconsin green bay", "green bay"],

  ["c connecticut", "central connecticut"],
  ["central conn", "central connecticut"],

  ["saint francis", "st francis pa"],
  ["st francis", "st francis pa"],
  ["fdu", "fairleigh dickinson"],

  ["se missouri", "se missouri state"],
  ["siue", "siu edwardsville"],

  ["arkansas lr", "little rock"],
  ["w illinois", "western illinois"],

  ["vcu", "va commonwealth"],
  ["utsa", "texas san antonio"],
  ["loyola md", "loyola maryland"],
  ["fgcu", "florida gulf coast"],
  ["jax state", "jacksonville state"],
  ["uconn", "connecticut"],
  ["c arkansas", "central arkansas"],
  ["fau", "florida atlantic"],
  ["app state", "appalachian state"],
  ["appalachian st", "appalachian state"],
  ["ga southern", "georgia southern"],
  ["texas a&m", "texas a and m"],
  ["lmu", "loyola marymount"],
  ["pitt", "pittsburgh"],
  ["miami", "miami florida"],
  ["milwaukee", "wisc milwaukee"],
  ["g washington", "george washington"],
  ["saint josephs", "st josephs"],
  ["saint joseph's", "st josephs"],
  ["st. josephs", "st josephs"],
  ["ar pine bluff", "arkansas pine bluff"],
  ["bethune", "bethune cookman"],
  ["prairie view", "prairie view a and m"],
  ["florida a and m", "florida am"],
  ["alabama a and m", "alabama am"],
  ["grambling", "grambling state"],
  ["ut rio grande", "ut rio grande valley"],
  ["nicholls", "nicholls state"],
  ["hou christian", "houston christian"],
  ["mcneese", "mcneese state"],
  ["sf austin", "stephen austin"],
  ["stephen f austin", "stephen austin"],
  ["miss valley st", "mississippi valley state"],
  ["texas a&m-cc", "texas a and m corpus"],
  ["texas a&m cc", "texas a and m corpus"],
  ["new orleans", "new orleans u"],
  ["georgia us state", "georgia"],
  ["ualbany", "albany ny"],
  ["ucf", "central florida"],
  ["brown u", "brown"],
  ["umass", "massachusetts"],
  ["penn", "pennsylvania"],
  ["nc a and t", "north carolina a and t"],
  ["n carolina a and t", "north carolina a and t"],
  ["western ky", "western kentucky"],
  ["sam houston", "sam houston st"],
  ["c michigan", "central michigan"],
  ["sc state", "south carolina state"],
  ["md eastern", "md eastern shore"],
  ["morgan st", "morgan state"],
  ["queens", "queens charlotte"],
  ["cal poly slo", "cal poly"],
]);

const TEAM_ALIASES_MEN = new Map([
  ["se louisiana", "southeastern louisiana"],
  ["s e louisiana", "southeastern louisiana"],
  ["southeastern la", "southeastern louisiana"],

  ["eastern texas a and m", "east texas am"],
  ["east texas a and m", "east texas am"],
  ["east texas a&m", "east texas am"],
  ["east texas am", "east texas am"],

  ["mississippi valley st", "mississippi valley state"],
  ["mvsu", "mississippi valley state"],
  ["alabama st", "alabama state"],

  ["louisiana lafayette", "louisiana"],
  ["ul lafayette", "louisiana"],

  ["odu", "old dominion"],
]);

// --------------------------
// TEAM NAME CLEANER
// --------------------------
function cleanTeamName(s) {
  s = String(s || "");
  s = s.replace(/\bn western\b/g, "nwestern");
  s = s.replace(/\s+`s/g, "s");
  s = s.replace(/\(women\)/gi, "");
  s = s.replace(/\(neutral[^)]*\)/gi, "");

  s = stripLeadingJunk(s).toLowerCase().trim();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/g, "");

  s = s.replace(/[’'´`]/g, "");
  s = s.replace(/[().,]/g, " ");
  s = s.replace(/&/g, " and ");
  s = s.replace(/-/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\bu\.\b/g, "u");

  s = s.replace(/\bno\b/g, "northern");
  s = s.replace(/\bso\b/g, "southern");

  s = s.replace(/\bs dakota\b/g, "south dakota");
  s = s.replace(/\bs dakota st\b/g, "south dakota state");
  s = s.replace(/\bn dakota\b/g, "north dakota");
  s = s.replace(/\bn dakota st\b/g, "north dakota state");

  s = s.replace(/\be\b/g, "eastern");
  s = s.replace(/\bw\b/g, "western");
  s = s.replace(/\bn\b/g, "northern");
  s = s.replace(/\bs\b/g, "southern");

  s = s.replace(/\bmn\b/g, "minnesota");
  s = s.replace(/\s+/g, " ").trim();

  if (TEAM_ALIASES_COMMON.has(s)) s = TEAM_ALIASES_COMMON.get(s);
  if (TEAM_ALIASES_MEN.has(s)) s = TEAM_ALIASES_MEN.get(s);

  s = s.replace(/\b([a-z]+)\s+u\b/g, "$1");
  return s;
}

// --------------------------
// HYBRID: ESPN subset control
// --------------------------
function getEspnSubset(espnLinesAll, otherLines) {
  const limitOn = document.getElementById("limitEspnToCount")?.checked;
  if (!limitOn) return espnLinesAll;

  const nRaw = document.getElementById("limitCount")?.value;
  const n = Number(nRaw);

  const limit = Number.isFinite(n) && n > 0 ? n : otherLines.length;
  return espnLinesAll.slice(0, Math.max(0, limit));
}

// --------------------------
// FILTER VIEW
// --------------------------
function getViewMode() {
  if (document.getElementById("showOnlyMismatches")?.checked) return "mismatches";
  return document.getElementById("mismatchView")?.value || "all";
}

function rowPassesFilter(viewMode, espnCls, otherCls, espnLine, otherLine) {
  const espnIsNoMatch = (otherLine === "(no match)");
  const otherIsLeftover = (espnLine === "(no match)");
  const isMatch = (espnCls === "match" && otherCls === "match");
  const isMismatch = !isMatch;

  if (viewMode === "matches") return isMatch;
  if (viewMode === "mismatches") return isMismatch;
  if (viewMode === "espnMissing") return espnIsNoMatch;
  if (viewMode === "otherMissing") return otherIsLeftover;
  return true;
}

// --------------------------
// PARSE MATCHUP: away/home
// --------------------------
function parseMatchupTeams(line) {
  let s = stripLeadingJunk(line);
  s = s.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  s = s.replace(/\s+at\s+/i, " @ ");
  s = s.replace(/\s*@\s*/g, " @ ");

  const parts = s.split(" @ ");
  if (parts.length !== 2) return null;

  return { awayText: parts[0].trim(), homeText: parts[1].trim() };
}

// --------------------------
// FUZZY
// --------------------------
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  a = cleanTeamName(a);
  b = cleanTeamName(b);
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - dist / maxLen;
}

// --------------------------
// TEAM INDEX FROM ESPN
// --------------------------
function buildTeamIndexFromEspnGames(espnGames) {
  const abbrToId = new Map();
  const nameToId = new Map();

  for (const g of espnGames) {
    if (g.awayId) {
      if (g.awayAbbr) {
        abbrToId.set(g.awayAbbr.toLowerCase(), g.awayId);
        nameToId.set(cleanTeamName(g.awayAbbr), g.awayId);
      }
      nameToId.set(cleanTeamName(g.away), g.awayId);
    }
    if (g.homeId) {
      if (g.homeAbbr) {
        abbrToId.set(g.homeAbbr.toLowerCase(), g.homeId);
        nameToId.set(cleanTeamName(g.homeAbbr), g.homeId);
      }
      nameToId.set(cleanTeamName(g.home), g.homeId);
    }
  }
  return { abbrToId, nameToId };
}

function resolveTeamToId(teamText, teamIndex, strictMode) {
  if (!teamIndex) return null;
  const raw = stripLeadingJunk(teamText);

  // Try abbreviation lookup even if not fully uppercase (UConn, UtSa, etc.)
  const acronym = raw.replace(/[^A-Za-z]/g, "");
  if (acronym.length >= 2 && acronym.length <= 6) {
    const id = teamIndex.abbrToId.get(acronym.toLowerCase());
    if (id) return id;
  }

  const cleaned = cleanTeamName(raw);

  // 1) exact cleaned-name match
  const exact = teamIndex.nameToId.get(cleaned);
  if (exact) return exact;

  // 2) SMART inference: if Other App drops trailing "state"
  // Only accept if it produces exactly ONE valid ESPN team for this date.
  // Example: "sacramento" -> "sacramento state"
  {
    const candidates = [];

    const tryNames = [
      `${cleaned} state`,
      `${cleaned} st`,
      `${cleaned} st.`,
    ];

    for (const name of tryNames) {
      const key = cleanTeamName(name);
      const id = teamIndex.nameToId.get(key);
      if (id) candidates.push(id);
    }

    // If unique candidate found -> safe to use
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
  }

  // 3) If strict mode, stop here (no fuzzy)
  if (strictMode) return null;

  // 4) fuzzy (existing)
  let bestId = null;
  let bestScore = 0;
  for (const [knownName, id] of teamIndex.nameToId.entries()) {
    const score = similarity(cleaned, knownName);
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }

  return bestScore >= 0.72 ? bestId : null;
}

// --------------------------
// KEY BUILDERS
// --------------------------
function buildIdKeyFromLine(line, teamIndex, strictMode) {
  const parsed = parseMatchupTeams(line);
  if (!parsed) {
    return { key: null, parseOk: false, reason: "Cannot parse matchup (need 'at' or '@')." };
  }

  const awayId = resolveTeamToId(parsed.awayText, teamIndex, strictMode);
  const homeId = resolveTeamToId(parsed.homeText, teamIndex, strictMode);

  if (!awayId || !homeId) {
    return {
      key: null,
      parseOk: true,
      reason: `Cannot resolve team id: away='${parsed.awayText}' home='${parsed.homeText}'`,
    };
  }

  return { key: `${awayId}|${homeId}`, parseOk: true, reason: null };
}

function buildStringKeyFromLine(line) {
  const parsed = parseMatchupTeams(line);
  if (!parsed) return null;
  const away = cleanTeamName(parsed.awayText);
  const home = cleanTeamName(parsed.homeText);
  if (!away || !home) return null;
  return `${away}|${home}`;
}

// --------------------------
// UI RENDER
// --------------------------
function compareAndRender() {
  const espnInputEl = document.getElementById("espnInput");
  const otherInputEl = document.getElementById("otherInput");
  const strictModeEl = document.getElementById("strictMode");

  const espnOutput = document.getElementById("espnOutput");
  const otherOutput = document.getElementById("otherOutput");
  const alignedOutput = document.getElementById("alignedOutput");

  const parseErrorsOutput = document.getElementById("parseErrorsOutput");
  const resolveErrorsOutput = document.getElementById("resolveErrorsOutput");
  const summaryText = document.getElementById("summaryText");

  const strictMode = !!strictModeEl?.checked;
  const hideUnmatched = document.getElementById("hideUnmatchedEspn")?.checked;

  const espnLinesAll = (espnInputEl.value || "")
    .split(/\r?\n/)
    .map(stripLeadingJunk)
    .filter(Boolean);

  const otherLines = (otherInputEl.value || "")
    .split(/\r?\n/)
    .map(stripLeadingJunk)
    .filter(Boolean);

  const espnLines = getEspnSubset(espnLinesAll, otherLines);

  // clear UI
  espnOutput.innerHTML = "";
  otherOutput.innerHTML = "";
  alignedOutput.innerHTML = "";
  parseErrorsOutput.textContent = "";
  resolveErrorsOutput.textContent = "";

  const parseErrors = [];
  const resolveErrors = [];

  const hasTeamIndex = !!lastTeamIndex;
  const idMatchingEnabled = hasTeamIndex;

  // Build lookup maps for OTHER (duplicate-safe: arrays/queues)
  const otherByIdKey = new Map();   // key -> [{ line, idx }]
  const otherByStrKey = new Map();  // key -> [{ line, idx }]
  const consumedOtherIdx = new Set();

  let dupOtherIdKeys = 0;
  let dupOtherStrKeys = 0;

  for (let idx = 0; idx < otherLines.length; idx++) {
    const line = otherLines[idx];

    const idRes = buildIdKeyFromLine(line, lastTeamIndex, strictMode);
    if (idRes.key) {
      if (!otherByIdKey.has(idRes.key)) otherByIdKey.set(idRes.key, []);
      if (otherByIdKey.get(idRes.key).length > 0) dupOtherIdKeys++;
      otherByIdKey.get(idRes.key).push({ line, idx });
      continue;
    }

    const sk = buildStringKeyFromLine(line);
    if (sk) {
      if (!otherByStrKey.has(sk)) otherByStrKey.set(sk, []);
      if (otherByStrKey.get(sk).length > 0) dupOtherStrKeys++;
      otherByStrKey.get(sk).push({ line, idx });
    } else {
      parseErrors.push(`[OTHER][PARSE] ${line} -> ${idRes.reason || "parse failed"}`);
    }
  }

  // Duplicate detection for ESPN too
  let dupEspnIdKeys = 0;
  let dupEspnStrKeys = 0;
  const seenEspnIdKeys = new Set();
  const seenEspnStrKeys = new Set();

  for (const espnLine of espnLines) {
    const idRes = buildIdKeyFromLine(espnLine, lastTeamIndex, strictMode);
    if (idRes.key) {
      if (seenEspnIdKeys.has(idRes.key)) dupEspnIdKeys++;
      else seenEspnIdKeys.add(idRes.key);
      continue;
    }
    const sk = buildStringKeyFromLine(espnLine);
    if (sk) {
      if (seenEspnStrKeys.has(sk)) dupEspnStrKeys++;
      else seenEspnStrKeys.add(sk);
    }
  }

  function appendLine(container, line, cls) {
    const div = document.createElement("div");
    div.className = "line " + cls;
    div.textContent = line;
    container.appendChild(div);
  }

  // Row numbers + filters + venue column
  function appendAlignedRow(idx, espnLine, espnCls, otherLine, otherCls) {
    const viewMode = getViewMode();
    if (!rowPassesFilter(viewMode, espnCls, otherCls, espnLine, otherLine)) return;

    const row = document.createElement("div");
    row.className = "row";

    const num = document.createElement("div");
    num.className = "idx";
    num.textContent = String(idx);

    const left = document.createElement("div");
    left.className = `cell ${espnCls}`;
    left.textContent = espnLine || "";

    const right = document.createElement("div");
    right.className = `cell ${otherCls}`;
    right.textContent = otherLine || "";

    const venueCell = document.createElement("div");
    venueCell.className = "cell venue";

    const vInfo = window.__espnLineVenue?.get(espnLine) || null;
    const b = venueBadgeHtml(vInfo);

    const badge = document.createElement("span");
    badge.className = b.cls;
    badge.textContent = b.text;
    badge.title = b.title;

    const venueText = document.createElement("span");
    venueText.textContent = vInfo?.venueName ? vInfo.venueName : "";

    venueCell.appendChild(badge);
    venueCell.appendChild(venueText);

    row.appendChild(num);
    row.appendChild(left);
    row.appendChild(right);
    row.appendChild(venueCell);

    alignedOutput.appendChild(row);
  }

  let matchedCount = 0;
  let unmatchedEspn = 0;

  // ESPN -> match to OTHER (consume queues)
  for (let i = 0; i < espnLines.length; i++) {
    const espnLine = espnLines[i];
    let matchedOtherLine = null;

    // 1) ID key match
    if (idMatchingEnabled) {
      const idRes = buildIdKeyFromLine(espnLine, lastTeamIndex, strictMode);

      if (!idRes.parseOk) {
        parseErrors.push(`[ESPN][PARSE] ${espnLine} -> ${idRes.reason}`);
      } else if (!idRes.key) {
        resolveErrors.push(`[ESPN][RESOLVE] ${espnLine} -> ${idRes.reason}`);
      } else if (otherByIdKey.has(idRes.key)) {
        const queue = otherByIdKey.get(idRes.key);
        if (queue && queue.length) {
          const item = queue.shift();
          matchedOtherLine = item.line;
          consumedOtherIdx.add(item.idx);
        }
      }
    }

    // 2) String key fallback
    if (!matchedOtherLine) {
      const sk = buildStringKeyFromLine(espnLine);
      if (sk && otherByStrKey.has(sk)) {
        const queue = otherByStrKey.get(sk);
        if (queue && queue.length) {
          const item = queue.shift();
          matchedOtherLine = item.line;
          consumedOtherIdx.add(item.idx);
        }
      }
    }

    // render
    if (matchedOtherLine) {
      matchedCount++;
      appendLine(espnOutput, espnLine, "match");
      appendLine(otherOutput, matchedOtherLine, "match");
      appendAlignedRow(i + 1, espnLine, "match", matchedOtherLine, "match");
    } else {
      unmatchedEspn++;
      if (!hideUnmatched) {
        appendLine(espnOutput, espnLine, "miss");
        appendAlignedRow(i + 1, espnLine, "miss", "(no match)", "miss");
      }
    }
  }

  // OTHER leftovers
  let unmatchedOther = 0;
  for (let idx = 0; idx < otherLines.length; idx++) {
    if (consumedOtherIdx.has(idx)) continue;
    const otherLine = otherLines[idx];
    unmatchedOther++;
    appendLine(otherOutput, otherLine, "warn");
    appendAlignedRow("-", "(no match)", "miss", otherLine, "warn");
  }

  parseErrorsOutput.textContent =
    parseErrors.length ? parseErrors.join("\n") : "No parse errors ✅";

  resolveErrorsOutput.textContent =
    resolveErrors.length ? resolveErrors.join("\n") : "No resolve errors ✅";

  const warnings = [];
  if (!idMatchingEnabled) warnings.push("⚠️ Fetch ESPN first for ID matching (best reliability).");
  if (strictMode) warnings.push("Strict mode ON (fuzzy disabled).");

  if (document.getElementById("limitEspnToCount")?.checked) {
    const nRaw = document.getElementById("limitCount")?.value;
    warnings.push(
      `Limit ESPN ON (${nRaw && Number(nRaw) > 0 ? `N=${nRaw}` : `N=Other(${otherLines.length})`}).`
    );
  }
  if (hideUnmatched) warnings.push("Hide ESPN not-created ON.");

  if (dupOtherIdKeys > 0 || dupOtherStrKeys > 0) {
    warnings.push(`⚠️ Duplicates in Other: idKeys=${dupOtherIdKeys}, nameKeys=${dupOtherStrKeys}.`);
  }
  if (dupEspnIdKeys > 0 || dupEspnStrKeys > 0) {
    warnings.push(`⚠️ Duplicates in ESPN: idKeys=${dupEspnIdKeys}, nameKeys=${dupEspnStrKeys}.`);
  }

  summaryText.textContent =
    `ESPN lines: ${espnLines.length} (from ${espnLinesAll.length}) | Other lines: ${otherLines.length}\n` +
    `Matched: ${matchedCount}\n` +
    `Unmatched ESPN: ${unmatchedEspn} | Unmatched Other: ${unmatchedOther}\n` +
    `Parse errors: ${parseErrors.length} | Resolve errors: ${resolveErrors.length}\n` +
    (warnings.length ? `\n${warnings.join(" ")}` : "");

  window.__lastMismatchPayload = {
    espnLines,
    otherLines,
    matchedCount,
    unmatchedEspn,
    unmatchedOther,
    parseErrors,
    resolveErrors,
  };
}

// --------------------------
// ESPN Fetch (Madrid timezone date correct)
// --------------------------
function yyyymmddFromDateInput(dateStr) {
  return dateStr.replaceAll("-", "");
}

function toUTCDateFromYYYYMMDD(yyyymmdd) {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

function addDaysYYYYMMDD(yyyymmdd, deltaDays) {
  const dt = toUTCDateFromYYYYMMDD(yyyymmdd);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);

  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function madridParts(isoUtc) {
  const d = new Date(isoUtc);
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const s = dtf.format(d).replace(",", "");
  const [datePart, timePart] = s.split(" ");
  const [dd, mm, yyyy] = datePart.split("/");
  return { madridDate: `${yyyy}-${mm}-${dd}`, madridTime: timePart };
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      const wait = [400, 1200, 3000][i] ?? 3000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function parseScoreboard(json) {
  const events = json?.events ?? [];
  const games = [];

  for (const ev of events) {
    const comp = ev?.competitions?.[0];
    if (!comp) continue;

    const venue = comp?.venue || null;
    const venueId = venue?.id || null;
    const venueName = venue?.fullName || venue?.name || "";
    const neutralSite = !!comp?.neutralSite;

    const competitors = comp?.competitors ?? [];
    const homeComp = competitors.find((c) => c.homeAway === "home");
    const awayComp = competitors.find((c) => c.homeAway === "away");
    if (!homeComp || !awayComp) continue;

    const homeTeam = homeComp.team;
    const awayTeam = awayComp.team;

    const home = homeTeam?.shortDisplayName || homeTeam?.displayName;
    const away = awayTeam?.shortDisplayName || awayTeam?.displayName;
    if (!home || !away) continue;

    const homeId = homeTeam?.id || null;
    const awayId = awayTeam?.id || null;
    const homeAbbr = homeTeam?.abbreviation || "";
    const awayAbbr = awayTeam?.abbreviation || "";

    const iso = comp?.date;
    if (!iso) continue;

    const { madridDate, madridTime } = madridParts(iso);

    games.push({
      away,
      home,
      awayId,
      homeId,
      awayAbbr,
      homeAbbr,
      madridDate,
      madridTime,
      venueId,
      venueName,
      neutralSite,
      line: `${away} @ ${home} (${madridDate} ${madridTime})`,
    });
  }

  return games;
}

async function fetchEspnGamesForMadridDate(selectedYYYYMMDD) {
  const prev = addDaysYYYYMMDD(selectedYYYYMMDD, -1);

  const urls = [
    `${ESPN_SCOREBOARD}?dates=${prev}&groups=50`,
    `${ESPN_SCOREBOARD}?dates=${selectedYYYYMMDD}&groups=50`,
  ];

  const allGames = [];
  for (const url of urls) {
    const res = await fetchWithRetry(url, 3);
    const json = await res.json();
    allGames.push(...parseScoreboard(json));
  }

  const selectedMadrid =
    `${selectedYYYYMMDD.slice(0, 4)}-${selectedYYYYMMDD.slice(4, 6)}-${selectedYYYYMMDD.slice(6, 8)}`;

  const filtered = allGames.filter((g) => g.madridDate === selectedMadrid);

  const seen = new Set();
  const lines = [];
  const games = [];

  for (const g of filtered) {
    const key =
      g.awayId && g.homeId
        ? `${g.awayId}|${g.homeId}|${g.madridDate}|${g.madridTime}`
        : `${cleanTeamName(g.away)}|${cleanTeamName(g.home)}|${g.madridDate}|${g.madridTime}`;

    if (seen.has(key)) continue;
    seen.add(key);

    lines.push(g.line);
    games.push(g);
  }

  return { lines, games, fetchedDates: [prev, selectedYYYYMMDD], selectedMadrid };
}

// --------------------------
// COPY MISMATCHES
// --------------------------
async function copyMismatchesToClipboard() {
  const payload = window.__lastMismatchPayload;
  if (!payload) return;

  const lines = [];
  lines.push("=== Schedule Compare Mismatches ===");
  lines.push(`Matched: ${payload.matchedCount}`);
  lines.push(`Unmatched ESPN: ${payload.unmatchedEspn}`);
  lines.push(`Unmatched Other: ${payload.unmatchedOther}`);
  lines.push("");

  if (payload.parseErrors.length) {
    lines.push("== Parse Errors ==");
    lines.push(...payload.parseErrors);
    lines.push("");
  }

  if (payload.resolveErrors.length) {
    lines.push("== Resolve Errors ==");
    lines.push(...payload.resolveErrors);
    lines.push("");
  }

  lines.push("Tip: In strict mode, fuzzy is disabled.");
  const text = lines.join("\n");

  try {
    await navigator.clipboard.writeText(text);
    alert("Mismatches copied ✅");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert("Mismatches copied ✅ (fallback)");
  }
}

// --------------------------
// WIRE UI
// --------------------------
document.addEventListener("DOMContentLoaded", () => {
  const datePicker = document.getElementById("datePicker");
  const fetchEspnBtn = document.getElementById("fetchEspnBtn");
  const statusEl = document.getElementById("status");
  const espnInput = document.getElementById("espnInput");
  const otherInput = document.getElementById("otherInput");
  const strictMode = document.getElementById("strictMode");
  const copyMismatchesBtn = document.getElementById("copyMismatchesBtn");

  const showOnlyMismatches = document.getElementById("showOnlyMismatches");
  const mismatchView = document.getElementById("mismatchView");

  const limitEspnToCount = document.getElementById("limitEspnToCount");
  const limitCount = document.getElementById("limitCount");
  const hideUnmatchedEspn = document.getElementById("hideUnmatchedEspn");

  datePicker.valueAsDate = new Date();

  const runCompareDebounced = debounce(compareAndRender, 250);

  espnInput.addEventListener("input", runCompareDebounced);
  otherInput.addEventListener("input", runCompareDebounced);
  strictMode.addEventListener("change", runCompareDebounced);

  limitEspnToCount?.addEventListener("change", runCompareDebounced);
  hideUnmatchedEspn?.addEventListener("change", runCompareDebounced);
  limitCount?.addEventListener("input", runCompareDebounced);

  showOnlyMismatches?.addEventListener("change", runCompareDebounced);
  mismatchView?.addEventListener("change", runCompareDebounced);

  copyMismatchesBtn.addEventListener("click", copyMismatchesToClipboard);

  fetchEspnBtn.addEventListener("click", async () => {
    statusEl.textContent = "Fetching ESPN…";
    fetchEspnBtn.disabled = true;

    try {
      const selectedYYYYMMDD = yyyymmddFromDateInput(datePicker.value);
      const { lines, games, fetchedDates, selectedMadrid } =
        await fetchEspnGamesForMadridDate(selectedYYYYMMDD);

      lastEspnGames = games;
      lastTeamIndex = buildTeamIndexFromEspnGames(lastEspnGames);

      // Learn home venues over time
      const homeVenueDb = updateHomeVenueDbFromGames(games);

      // Map ESPN rendered line -> venue classification
      window.__espnLineVenue = new Map();
      for (const g of games) {
        const info = classifyVenueForGame(g, homeVenueDb);
        window.__espnLineVenue.set(g.line, info);
      }

      espnInput.value = lines.join("\n");

      statusEl.textContent =
        `Loaded ${lines.length} games ✅ (Madrid ${selectedMadrid}; fetched ESPN ${fetchedDates.join(" + ")})`;

      compareAndRender();
    } catch (e) {
      statusEl.textContent = `ESPN fetch failed ❌ (${String(e.message || e)})`;
      console.error(e);
    } finally {
      fetchEspnBtn.disabled = false;
    }
  });

  compareAndRender();

});


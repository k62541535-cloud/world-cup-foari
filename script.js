const storageKeys = {
  name: "pulse-cup-player-name",
  predictions: "pulse-cup-predictions"
};

const state = {
  playerName: localStorage.getItem(storageKeys.name) || "",
  stageFilter: "all",
  predictions: readLocalPredictions(),
  matches: [],
  leaderboard: [],
  submitting: false,
  authConfig: null,
  isAdmin: false
};

const elements = {
  authShell: document.getElementById("auth-shell"),
  authMessage: document.getElementById("auth-message"),
  googleSignin: document.getElementById("google-signin"),
  adminCodeGroup: document.getElementById("admin-code-group"),
  adminCodeInput: document.getElementById("admin-code-input"),
  adminCodeButton: document.getElementById("admin-code-button"),
  playerName: document.getElementById("player-name"),
  stageFilter: document.getElementById("stage-filter"),
  matchList: document.getElementById("match-list"),
  template: document.getElementById("match-card-template"),
  scoreTotal: document.getElementById("score-total"),
  exactCount: document.getElementById("exact-count"),
  rankDisplay: document.getElementById("rank-display"),
  pulseGrid: document.getElementById("pulse-grid"),
  leaderboardBody: document.getElementById("leaderboard-body"),
  leaderboardNote: document.getElementById("leaderboard-note"),
  saveStatus: document.getElementById("save-status"),
  syncMeta: document.getElementById("sync-meta"),
  inviteCard: document.getElementById("invite-card"),
  shareRow: document.getElementById("share-row"),
  shareUrl: document.getElementById("share-url"),
  heroShareUrl: document.getElementById("hero-share-url"),
  copyShareButton: document.getElementById("copy-share-button"),
  shareHelp: document.getElementById("share-help"),
  submitButton: document.getElementById("submit-button"),
  refreshButton: document.getElementById("refresh-button"),
  logoutButton: document.getElementById("logout-button"),
  resetButton: document.getElementById("reset-button")
};

function readLocalPredictions() {
  try {
    return JSON.parse(localStorage.getItem(storageKeys.predictions)) || {};
  } catch {
    return {};
  }
}

function saveLocalDraft() {
  localStorage.setItem(storageKeys.name, state.playerName);
  localStorage.setItem(storageKeys.predictions, JSON.stringify(state.predictions));
}

function hasLockedSubmission() {
  const trimmedName = state.playerName.trim().toLowerCase();
  return Boolean(trimmedName) && state.leaderboard.some((row) => row.name.toLowerCase() === trimmedName);
}

function setAuthMessage(message, tone = "") {
  elements.authMessage.textContent = message;
  elements.authMessage.className = "auth-message";

  if (tone) {
    elements.authMessage.classList.add(`auth-${tone}`);
  }
}

function describeNetworkError(error, fallbackMessage) {
  if (error && error.message === "Failed to fetch") {
    return "Couldn't reach the app server. Restart server.ps1 and reopen the link.";
  }

  return error?.message || fallbackMessage;
}

function setAuthVisibility(isAuthenticated) {
  elements.authShell.classList.toggle("auth-hidden", isAuthenticated);
  document.body.classList.toggle("auth-locked", !isAuthenticated);
  elements.adminCodeGroup.classList.toggle("admin-only", !isAuthenticated || state.isAdmin);
}

function renderAdminVisibility() {
  elements.inviteCard.classList.toggle("admin-visible", state.isAdmin);
  elements.shareRow.classList.toggle("admin-visible", state.isAdmin);
  elements.adminCodeGroup.classList.toggle("admin-only", !state.playerName || state.isAdmin);
}

function resetAuthenticatedUi() {
  state.playerName = "";
  state.isAdmin = false;
  elements.playerName.value = "";
  elements.adminCodeInput.value = "";
  localStorage.removeItem(storageKeys.name);
  setAuthVisibility(false);
  renderAdminVisibility();
}

function setStatus(message, tone = "") {
  elements.saveStatus.textContent = message;
  elements.saveStatus.className = "status-pill";

  if (tone) {
    elements.saveStatus.classList.add(`status-${tone}`);
  }
}

function getOutcome(home, away) {
  if (home === away) {
    return "draw";
  }

  return home > away ? "home" : "away";
}

function getDraftPrediction(raw) {
  if (Array.isArray(raw) && raw.length === 2) {
    return {
      home: raw[0] === null || raw[0] === undefined ? "" : String(raw[0]),
      away: raw[1] === null || raw[1] === undefined ? "" : String(raw[1])
    };
  }

  if (raw && typeof raw === "object") {
    return {
      home: raw.home === null || raw.home === undefined ? "" : String(raw.home),
      away: raw.away === null || raw.away === undefined ? "" : String(raw.away)
    };
  }

  return { home: "", away: "" };
}

function parsePrediction(raw) {
  const draft = getDraftPrediction(raw);
  const home = Number.parseInt(draft.home, 10);
  const away = Number.parseInt(draft.away, 10);

  if (!Number.isInteger(home) || !Number.isInteger(away)) {
    return null;
  }

  return { home, away };
}

function buildSubmissionPredictions() {
  return Object.entries(state.predictions).reduce((entries, [matchId, rawPrediction]) => {
    const prediction = parsePrediction(rawPrediction);

    if (prediction) {
      entries[matchId] = [prediction.home, prediction.away];
    }

    return entries;
  }, {});
}

function scorePrediction(prediction, match) {
  if (!match.actual || !Number.isInteger(match.actual.home) || !Number.isInteger(match.actual.away)) {
    return { points: 0, exact: false, status: "pending", label: "Upcoming fixture" };
  }

  if (!prediction) {
    return { points: 0, exact: false, status: "pending", label: "Awaiting your pick" };
  }

  if (prediction.home === match.actual.home && prediction.away === match.actual.away) {
    return { points: 5, exact: true, status: "exact", label: "Exact hit - 5 pts" };
  }

  if (getOutcome(prediction.home, prediction.away) === getOutcome(match.actual.home, match.actual.away)) {
    return { points: 3, exact: false, status: "result", label: "Correct result - 3 pts" };
  }

  return { points: 0, exact: false, status: "miss", label: "Missed result - 0 pts" };
}

function summarizePredictions(predictions) {
  return state.matches.reduce(
    (summary, match) => {
      const result = scorePrediction(parsePrediction(predictions[match.id]), match);
      summary.points += result.points;
      summary.exact += result.exact ? 1 : 0;
      return summary;
    },
    { points: 0, exact: 0 }
  );
}

function formatDate(isoString) {
  if (!isoString) {
    return "Unknown";
  }

  const date = new Date(isoString);

  if (Number.isNaN(date.getTime())) {
    return "Just now";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function renderRefreshMeta(refreshInfo) {
  if (!refreshInfo) {
    elements.syncMeta.textContent = "Schedule cache status unavailable.";
    return;
  }

  const refreshed = formatDate(refreshInfo.lastSyncedAt);
  const sourceLabel = refreshInfo.sourceLabel || "FIFA";
  const suffix = refreshInfo.lastRefreshSucceeded ? "" : " - using cached data";
  elements.syncMeta.textContent = `Last schedule sync: ${refreshed} from ${sourceLabel}${suffix}.`;
}

function renderShareUrl(serverInfo) {
  const fallbackMessage = "No join link available yet.";

  if (!serverInfo || !Array.isArray(serverInfo.shareUrls) || !serverInfo.shareUrls.length) {
    elements.shareUrl.textContent = fallbackMessage;
    elements.heroShareUrl.textContent = fallbackMessage;
    elements.copyShareButton.disabled = true;
    return;
  }

  const preferred = serverInfo.shareUrls.find((url) => !url.includes("localhost") && !url.includes("127.0.0.1")) || serverInfo.shareUrls[0];
  elements.shareUrl.textContent = preferred;
  elements.heroShareUrl.textContent = preferred;
  elements.copyShareButton.disabled = false;
  elements.shareHelp.textContent = `Share this URL so other people can sign in and join the same leaderboard: ${preferred}`;
}

async function copyShareLink() {
  const url = elements.heroShareUrl.textContent.trim();

  if (!url || url === "No join link available yet." || url === "Waiting for public link...") {
    setStatus("No share link available yet.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    setStatus("Invite link copied. Share it so others can join.", "success");
  } catch {
    setStatus("Couldn't copy automatically. Copy the share link manually.", "error");
  }
}

function renderStageOptions() {
  const stages = ["all", ...new Set(state.matches.map((match) => match.stage))];
  elements.stageFilter.innerHTML = stages
    .map((stage) => {
      const label = stage === "all" ? "All stages" : stage;
      return `<option value="${stage}">${label}</option>`;
    })
    .join("");
  elements.stageFilter.value = state.stageFilter;
}

function renderMatches() {
  const visibleMatches = state.matches.filter((match) => {
    return state.stageFilter === "all" || match.stage === state.stageFilter;
  });

  if (!visibleMatches.length) {
    elements.matchList.innerHTML = '<div class="empty-state">No fixtures match that filter.</div>';
    return;
  }

  elements.matchList.innerHTML = "";

  visibleMatches.forEach((match) => {
    const fragment = elements.template.content.cloneNode(true);
    const title = fragment.querySelector(".match-title");
    const stage = fragment.querySelector(".match-stage");
    const kickoff = fragment.querySelector(".match-kickoff");
    const homeFlag = fragment.querySelector(".home-flag");
    const awayFlag = fragment.querySelector(".away-flag");
    const homeTeam = fragment.querySelector(".home-team");
    const awayTeam = fragment.querySelector(".away-team");
    const homeScore = fragment.querySelector(".home-score");
    const awayScore = fragment.querySelector(".away-score");
      const actualScore = fragment.querySelector(".actual-score");
      const winnerNote = fragment.querySelector(".winner-note");
      const points = fragment.querySelector(".match-points");
      const rawPrediction = getDraftPrediction(state.predictions[match.id]);
      const prediction = parsePrediction(rawPrediction);
      const result = scorePrediction(prediction, match);
      const locked = hasLockedSubmission();

    title.textContent = match.title;
    stage.textContent = match.stage;
    kickoff.textContent = `${match.dateLabel} - ${match.venue}`;
    homeFlag.textContent = match.homeFlag;
    awayFlag.textContent = match.awayFlag;
    homeTeam.textContent = match.home;
    awayTeam.textContent = match.away;
      actualScore.textContent = match.actual
        ? `Official score: ${match.actual.home} - ${match.actual.away}`
        : "Official score: not played yet";
      winnerNote.textContent = match.winnerNote || "";
      points.textContent = result.label;
      points.classList.add(`points-${result.status}`);

      homeScore.value = rawPrediction.home;
      awayScore.value = rawPrediction.away;
      homeScore.disabled = locked;
      awayScore.disabled = locked;

      const updatePrediction = () => {
        if (locked) {
          return;
        }

        const nextHome = homeScore.value.trim();
        const nextAway = awayScore.value.trim();

        if (!nextHome && !nextAway) {
          delete state.predictions[match.id];
        } else {
          state.predictions[match.id] = {
            home: nextHome,
            away: nextAway
          };
        }

        saveLocalDraft();
        setStatus("Draft saved locally");

        renderSummary();
        renderPulse();
        renderLeaderboard();

        const updatedResult = scorePrediction(parsePrediction(state.predictions[match.id]), match);
        points.textContent = updatedResult.label;
        points.className = "match-points";
        points.classList.add(`points-${updatedResult.status}`);
      };

    homeScore.addEventListener("input", updatePrediction);
    awayScore.addEventListener("input", updatePrediction);

    elements.matchList.appendChild(fragment);
  });
}

function renderPulse() {
  const toneMap = {
    exact: "var(--mint)",
    result: "var(--gold)",
    miss: "var(--coral)",
    pending: "var(--sky)"
  };

  elements.pulseGrid.innerHTML = state.matches
    .map((match) => {
      const prediction = parsePrediction(state.predictions[match.id]);
      const result = scorePrediction(prediction, match);
      return `
        <article class="pulse-card" style="border-color: ${toneMap[result.status]}33;">
          <span class="match-stage">${match.stage}</span>
          <strong>${match.homeFlag} ${match.home} vs ${match.away} ${match.awayFlag}</strong>
          <p>${result.label}</p>
          <div class="winner-note">${match.winnerNote || "Regulation scoreline only"}</div>
        </article>
      `;
    })
    .join("");
}

function renderSummary() {
  const summary = summarizePredictions(state.predictions);
  elements.scoreTotal.textContent = String(summary.points);
  elements.exactCount.textContent = String(summary.exact);

  const currentName = state.playerName.trim().toLowerCase();
  const rows = state.leaderboard.map((row, index) => ({ ...row, rank: index + 1 }));
  const current = rows.find((row) => row.name.toLowerCase() === currentName);
  elements.rankDisplay.textContent = current ? `#${current.rank}` : "-";

  const locked = hasLockedSubmission();
  elements.submitButton.disabled = locked || state.submitting;
  elements.resetButton.disabled = true;
  elements.resetButton.textContent = locked ? "Entry Locked" : "Reset Disabled";
}

function renderLeaderboard() {
  if (!state.leaderboard.length) {
    elements.leaderboardNote.textContent = "No shared entries yet. Share the link and submit the first pick.";
  } else {
    elements.leaderboardNote.textContent = `${state.leaderboard.length} player${state.leaderboard.length === 1 ? "" : "s"} joined this shared leaderboard.`;
  }

  const currentName = state.playerName.trim().toLowerCase();
  const rows = state.leaderboard.map((row, index) => ({
    ...row,
    rank: index + 1,
    currentUser: row.name.toLowerCase() === currentName
  }));
  elements.leaderboardBody.innerHTML = rows
    .map((row) => {
      return `
        <div class="leaderboard-row${row.currentUser ? " current-user" : ""}">
          <span class="leaderboard-rank" data-label="Rank">#${row.rank}</span>
          <span data-label="Player">${row.name}</span>
          <span data-label="Points">${row.points}</span>
          <span data-label="Exact">${row.exact}</span>
          <span class="leaderboard-updated" data-label="Updated">${formatDate(row.updatedAt)}</span>
        </div>
      `;
    })
    .join("");
}

function renderAll() {
  renderMatches();
  renderPulse();
  renderSummary();
  renderLeaderboard();
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;

  if (!response.ok) {
    const message = payload?.error || `Request failed (${response.status}).`;
    throw new Error(message);
  }

  return payload;
}

async function fetchBootstrap() {
  try {
    return await fetchJson("/api/bootstrap");
  } catch (error) {
    if (error.message.includes("Authentication required")) {
      throw new Error("AUTH_REQUIRED");
    }
    throw error;
  }
}

async function fetchSession() {
  try {
    return await fetchJson("/api/auth/session");
  } catch {
    return { authenticated: false };
  }
}

async function fetchGoogleConfig() {
  return fetchJson("/api/auth/google/config");
}

async function unlockAdminAccess() {
  const code = elements.adminCodeInput.value.trim();

  if (!code) {
    setStatus("Enter the admin code first.", "error");
    return;
  }

  elements.adminCodeButton.disabled = true;

  try {
    const payload = await fetchJson("/api/admin/unlock", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ code })
    });

    state.isAdmin = Boolean(payload.user?.isAdmin);
    elements.adminCodeInput.value = "";
    renderAdminVisibility();
    setStatus("Admin access unlocked.", "success");
  } catch (error) {
    setStatus(describeNetworkError(error, "Admin unlock failed."), "error");
  } finally {
    elements.adminCodeButton.disabled = false;
  }
}

async function handleGoogleCredential(response) {
  if (!response?.credential) {
    setAuthMessage("Google did not return a sign-in credential.", "error");
    return;
  }

  setAuthMessage("Signing you in...");

  try {
    const payload = await fetchJson("/api/auth/google", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ credential: response.credential })
    });

    state.playerName = payload.user.username;
    state.isAdmin = Boolean(payload.user.isAdmin);
    elements.playerName.value = state.playerName;
    saveLocalDraft();
    setAuthVisibility(true);
    renderAdminVisibility();
    setAuthMessage("Signed in.", "success");
    await initApp();
  } catch (error) {
    setAuthMessage(describeNetworkError(error, "Google sign-in failed."), "error");
  }
}

function initializeGoogleSignIn(attempt = 0) {
  if (!state.authConfig?.enabled) {
    setAuthMessage("Google sign-in is not configured on the server yet.", "error");
    return;
  }

  if (!window.google?.accounts?.id) {
    if (attempt < 20) {
      setAuthMessage("Loading Google sign-in...");
      window.setTimeout(() => initializeGoogleSignIn(attempt + 1), 250);
      return;
    }

    setAuthMessage("Google Sign-In library did not load. Refresh and try again.", "error");
    return;
  }

  window.google.accounts.id.initialize({
    client_id: state.authConfig.clientId,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true
  });

  elements.googleSignin.innerHTML = "";
  window.google.accounts.id.renderButton(elements.googleSignin, {
    theme: "outline",
    size: "large",
    width: 320,
    shape: "pill",
    text: "continue_with"
  });

  setAuthMessage("Sign in with Google to continue.");
}

async function submitPredictions() {
  const trimmedName = state.playerName.trim();

  if (!trimmedName) {
    setStatus("Sign in before submitting.", "error");
    return;
  }

  if (hasLockedSubmission()) {
    setStatus("Your World Cup entry is locked and already on the leaderboard.", "error");
    return;
  }

  state.submitting = true;
  elements.submitButton.disabled = true;
  setStatus("Submitting to shared leaderboard...");

  try {
    const payload = await fetchJson("/api/predictions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: trimmedName,
        predictions: buildSubmissionPredictions()
      })
    });

    state.leaderboard = payload.leaderboard;
    saveLocalDraft();
    setStatus("Entry submitted and locked into the leaderboard.", "success");
    renderAll();
  } catch (error) {
    setStatus(describeNetworkError(error, "Submission failed."), "error");
  } finally {
    state.submitting = false;
    elements.submitButton.disabled = false;
  }
}

async function refreshMatches() {
  elements.refreshButton.disabled = true;
  setStatus("Refreshing official match schedule...");

  try {
    const payload = await fetchJson("/api/refresh", {
      method: "POST"
    });

    state.matches = payload.matches;
    state.leaderboard = payload.leaderboard;
    renderStageOptions();
    renderAll();
    renderRefreshMeta(payload.refreshInfo);
    renderShareUrl(payload.serverInfo);
    setStatus(payload.refreshInfo?.lastRefreshSucceeded ? "Official schedule refreshed." : "Refresh attempted - using cached data.", payload.refreshInfo?.lastRefreshSucceeded ? "success" : "error");
  } catch (error) {
    setStatus(describeNetworkError(error, "Refresh failed."), "error");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function resetEntry() {
  setStatus("Submitted entries are locked and cannot be reset.", "error");
  renderAll();
}

async function logout() {
  try {
    await fetchJson("/api/auth/logout", { method: "POST" });
  } catch {
    // Keep local logout resilient even if the request fails.
  }

  resetAuthenticatedUi();
  initializeGoogleSignIn();
  setAuthMessage("Signed out.");
}

async function initApp() {
  const payload = await fetchBootstrap();
  state.matches = payload.matches;
  state.leaderboard = payload.leaderboard;
  renderStageOptions();
  renderAll();
  renderRefreshMeta(payload.refreshInfo);
  renderShareUrl(payload.serverInfo);
  setStatus("Draft saved locally");
}

async function init() {
  try {
    state.authConfig = await fetchGoogleConfig();
    const session = await fetchSession();

    if (!session.authenticated) {
      resetAuthenticatedUi();
      initializeGoogleSignIn();
      return;
    }

    state.playerName = session.user.username;
    state.isAdmin = Boolean(session.user.isAdmin);
    elements.playerName.value = state.playerName;
    setAuthVisibility(true);
    renderAdminVisibility();
    setStatus("Loading tournament data...");
    await initApp();
  } catch (error) {
    if (error.message === "AUTH_REQUIRED") {
      resetAuthenticatedUi();
      setStatus("Sign in to continue.", "error");
      initializeGoogleSignIn();
      return;
    }

    setAuthMessage(describeNetworkError(error, "Unable to initialize sign-in."), "error");
    setStatus(describeNetworkError(error, "Unable to load app."), "error");
  }
}

elements.stageFilter.addEventListener("change", (event) => {
  state.stageFilter = event.target.value;
  renderMatches();
});

elements.refreshButton.addEventListener("click", refreshMatches);
elements.submitButton.addEventListener("click", submitPredictions);
elements.logoutButton.addEventListener("click", logout);
elements.resetButton.addEventListener("click", resetEntry);
elements.copyShareButton.addEventListener("click", copyShareLink);
elements.adminCodeButton.addEventListener("click", unlockAdminAccess);

init();

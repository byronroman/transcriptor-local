import { register } from "./runtime.js";

const PROOFREAD_KIND_LABELS = {
  spelling: "Ortografia",
  punctuation: "Puntuacion",
  grammar: "Gramatica",
  style: "Estilo",
};

function enableSpanishProofing(element) {
  if (!element) return;
  element.lang = "es-CL";
  element.spellcheck = true;
  element.autocapitalize = "sentences";
  element.setAttribute("autocorrect", "on");
}

function proofreadPanelForKey(key) {
  return document.querySelector(`.proofread-panel[data-proofread-key="${CSS.escape(key)}"]`);
}

function textHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function proofreadCacheKey(key, hash) {
  return `${key}:${hash}`;
}

function clearProofreadTimers() {
  for (const timer of Object.values(state.proofreadTimers)) {
    clearTimeout(timer);
  }
  state.proofreadTimers = {};
  if (state.proofreadBatchTimer) {
    clearTimeout(state.proofreadBatchTimer);
    state.proofreadBatchTimer = null;
  }
}

function clearProofreadState() {
  clearProofreadTimers();
  if (state.proofreadObserver) {
    state.proofreadObserver.disconnect();
    state.proofreadObserver = null;
  }
  state.proofreadResults = {};
  state.proofreadRequests = {};
  state.proofreadQueue = {};
  state.proofreadBatchInFlight = false;
}

async function loadProofreadStatus(options = {}) {
  if (!state.proofreadEnabled) {
    if (state.proofreadStatusTimer) {
      clearTimeout(state.proofreadStatusTimer);
      state.proofreadStatusTimer = null;
    }
    renderProofreadStatus();
    return;
  }
  try {
    const status = await api(`/api/proofread/status${options.start ? "?start=1" : ""}`);
    state.proofreadAvailable = Boolean(status.available);
    state.proofreadStatus = status.status || (status.available ? "ready" : "unavailable");
    state.proofreadUnavailableMessage = (status.missing || []).join(" ") || status.message || "";
    state.proofreadStarting = state.proofreadStatus === "preparing";
  } catch (error) {
    state.proofreadAvailable = false;
    state.proofreadStatus = "unavailable";
    state.proofreadStarting = false;
    state.proofreadUnavailableMessage = visibleErrorMessage(error, "Corrector local no disponible.");
  }
  renderProofreadStatus();
  if (state.proofreadEnabled && state.proofreadStatus === "preparing") {
    scheduleProofreadStatusPoll();
  } else if (state.proofreadStatusTimer) {
    clearTimeout(state.proofreadStatusTimer);
    state.proofreadStatusTimer = null;
  }
  if (state.proofreadEnabled && state.proofreadAvailable === true && state.current?.status === "done") {
    observeProofreadSegments();
  }
}

function scheduleProofreadStatusPoll() {
  if (!state.proofreadEnabled) return;
  if (state.proofreadStatusTimer) clearTimeout(state.proofreadStatusTimer);
  state.proofreadStatusTimer = setTimeout(() => {
    state.proofreadStatusTimer = null;
    loadProofreadStatus().catch(() => {});
  }, PROOFREAD_STATUS_POLL_MS);
}

function proofreadStatusText() {
  if (!state.proofreadEnabled) return "Corrector desactivado";
  if (state.proofreadStarting || state.proofreadStatus === "preparing") return "Activando corrector";
  if (state.proofreadStatus === "ready") return "Corrector activado";
  if (state.proofreadStatus === "unavailable") {
    return state.proofreadUnavailableMessage
      ? `Corrector no disponible: ${state.proofreadUnavailableMessage}`
      : "Corrector no disponible";
  }
  return "Corrector";
}

function renderProofreadStatus() {
  const element = $("proofreadStatus");
  if (!element) return;
  const input = $("proofreadToggleInput");
  const label = element.querySelector(".proofread-switch-label");
  const title = proofreadStatusText();
  if (input) input.checked = state.proofreadEnabled;
  if (label) {
    if (state.proofreadStarting || state.proofreadStatus === "preparing") {
      label.textContent = "Corrector...";
    } else if (state.proofreadStatus === "unavailable") {
      label.textContent = /java/i.test(state.proofreadUnavailableMessage || "") ? "Java 17" : "No disponible";
    } else {
      label.textContent = "Corrector";
    }
  }
  element.title = title;
  element.setAttribute("aria-label", title);
  if (input) input.setAttribute("aria-label", `${state.proofreadEnabled ? "Desactivar" : "Activar"} corrector local`);
  const statusClass = !state.proofreadEnabled
    ? "disabled"
    : state.proofreadStarting || state.proofreadStatus === "preparing"
      ? "starting"
      : state.proofreadStatus || "idle";
  element.className = `proofread-switch proofread-${statusClass}`;
}

function firstLetterOffset(text) {
  const match = String(text || "").match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/);
  return match ? match.index : 0;
}

function isInitialCapitalizationMatch(match, text) {
  const offset = Number(match?.offset);
  if (!Number.isFinite(offset)) return false;
  const firstOffset = firstLetterOffset(text);
  if (offset !== 0 && offset !== firstOffset) return false;
  const haystack = [
    match.message,
    match.short_message,
    match.rule_id,
    match.category,
    match.issue_type,
  ]
    .join(" ")
    .toLowerCase();
  return /may[uú]scula|uppercase|capital/.test(haystack);
}

function segmentStartsNewProofreadSentence(index) {
  if (index <= 0) return true;
  const segments = currentSegments();
  const current = segments[index];
  const previous = segments[index - 1];
  if (!current || !previous) return true;
  if ((current.speaker || "SPEAKER_00") !== (previous.speaker || "SPEAKER_00")) return true;
  const previousText = String(previous.text || "").trim();
  if (!previousText) return true;
  return /[.!?…]$/.test(previousText);
}

function proofreadMatchesForSegment(index, matches) {
  const segment = currentSegments()[index];
  const text = String(segment?.text || "");
  return (matches || []).filter((match) => {
    if (!isInitialCapitalizationMatch(match, text)) return true;
    return segmentStartsNewProofreadSentence(index);
  });
}

function proofreadKind(match) {
  const haystack = [
    match?.issue_type,
    match?.category,
    match?.rule_id,
    match?.message,
    match?.short_message,
  ]
    .join(" ")
    .toLowerCase();
  if (/style|estilo|redundan|wordiness|simplific/.test(haystack)) return "style";
  if (/punct|puntuac|coma|comma|semicolon|colon|whitespace|espacio/.test(haystack)) return "punctuation";
  if (/misspell|morfologik|spelling|ortograf|typo|typograph|may[uú]scula|uppercase|capital|casing/.test(haystack)) {
    return "spelling";
  }
  if (/grammar|gram[aá]tica|agreement|concordancia|conjug|verb/.test(haystack)) return "grammar";
  return "grammar";
}

function proofreadVisibleMatches(index, matches) {
  return proofreadMatchesForSegment(index, matches).filter((match) => proofreadKind(match) !== "style");
}

function proofreadSummaryText(matches) {
  const first = String(matches?.[0]?.text || "").trim();
  if (!first) return "";
  const clipped = first.length > 28 ? `${first.slice(0, 28)}...` : first;
  const more = matches.length > 1 ? ` +${matches.length - 1}` : "";
  return `${clipped}${more}`;
}

function renderProofreadPanel(panel, key, index) {
  if (!panel) return;
  const result = state.proofreadResults[key];
  panel.innerHTML = "";
  const matches = proofreadVisibleMatches(index, result?.matches || []);
  panel.classList.toggle("hidden", !matches.length);
  if (!matches.length) return;

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "proofread-summary";
  summary.setAttribute("aria-label", `Ver ${matches.length} sugerencia${matches.length === 1 ? "" : "s"} del corrector`);
  const count = document.createElement("span");
  count.className = "proofread-summary-count";
  count.textContent = `${matches.length} sugerencia${matches.length === 1 ? "" : "s"}`;
  const snippet = document.createElement("span");
  snippet.className = "proofread-summary-snippet";
  snippet.textContent = proofreadSummaryText(matches);
  summary.append(count, snippet);
  panel.appendChild(summary);

  const popover = document.createElement("div");
  popover.className = "proofread-popover proofread-list-popover";

  for (const match of matches.slice(0, PROOFREAD_VISIBLE_LIMIT)) {
    const kind = proofreadKind(match);
    const item = document.createElement("div");
    item.className = `proofread-match proofread-${kind}`;

    const header = document.createElement("div");
    header.className = "proofread-match-header";
    const badge = document.createElement("span");
    badge.className = "proofread-kind";
    badge.textContent = PROOFREAD_KIND_LABELS[kind] || "Revision";
    const badText = document.createElement("span");
    badText.className = "proofread-bad-text";
    badText.textContent = match.text || "texto";
    header.append(badge, badText);
    item.appendChild(header);

    const message = document.createElement("strong");
    message.className = "proofread-message";
    message.textContent = match.message || "Revisar texto";
    item.appendChild(message);

    const replacements = Array.isArray(match.replacements) ? match.replacements.slice(0, 5) : [];
    if (replacements.length) {
      const actions = document.createElement("span");
      actions.className = "proofread-replacements";
      for (const replacement of replacements) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = replacement;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          applyProofreadReplacement(index, key, match, replacement);
        });
        actions.appendChild(button);
      }
      item.appendChild(actions);
    } else {
      const none = document.createElement("small");
      none.textContent = "Sin reemplazo automatico.";
      item.appendChild(none);
    }
    popover.appendChild(item);
  }

  if (matches.length > PROOFREAD_VISIBLE_LIMIT) {
    const more = document.createElement("small");
    more.className = "proofread-more";
    more.textContent = `${matches.length - PROOFREAD_VISIBLE_LIMIT} sugerencia${matches.length - PROOFREAD_VISIBLE_LIMIT === 1 ? "" : "s"} mas ocultas.`;
    popover.appendChild(more);
  }
  panel.appendChild(popover);
}

function queueProofreadSegment(index, key) {
  if (!state.proofreadEnabled) return;
  if (state.proofreadAvailable !== true) return;
  const segment = currentSegments()[index];
  if (!segment) return;
  const text = String(segment.text || "");
  if (text.trim().length < 4) {
    delete state.proofreadResults[key];
    renderProofreadPanel(proofreadPanelForKey(key), key, index);
    return;
  }
  const hash = textHash(text);
  const cached = state.proofreadCache[proofreadCacheKey(key, hash)];
  if (cached) {
    state.proofreadResults[key] = cached;
    renderProofreadPanel(proofreadPanelForKey(key), key, index);
    return;
  }
  const existing = state.proofreadResults[key];
  if (existing?.textHash === hash || state.proofreadQueue[key]?.textHash === hash) return;
  state.proofreadQueue[key] = { id: key, index, text, textHash: hash };
  const queuedKeys = Object.keys(state.proofreadQueue);
  while (queuedKeys.length > PROOFREAD_QUEUE_LIMIT) {
    const oldKey = queuedKeys.shift();
    if (oldKey) delete state.proofreadQueue[oldKey];
  }
  scheduleProofreadBatch();
}

function scheduleProofreadSegment(index, key) {
  if (!state.proofreadEnabled) return;
  if (state.proofreadAvailable !== true) return;
  clearTimeout(state.proofreadTimers[key]);
  state.proofreadTimers[key] = setTimeout(() => {
    delete state.proofreadTimers[key];
    queueProofreadSegment(index, key);
  }, PROOFREAD_DEBOUNCE_MS);
}

function scheduleProofreadBatch() {
  if (!state.proofreadEnabled) return;
  if (state.proofreadBatchTimer) return;
  state.proofreadBatchTimer = setTimeout(() => {
    state.proofreadBatchTimer = null;
    flushProofreadBatch().catch((error) => {
      state.proofreadAvailable = false;
      state.proofreadStatus = "unavailable";
      state.proofreadUnavailableMessage = visibleErrorMessage(error, "Corrector local no disponible.");
      state.proofreadQueue = {};
      renderProofreadStatus();
    });
  }, PROOFREAD_BATCH_DEBOUNCE_MS);
}

async function flushProofreadBatch() {
  if (!state.proofreadEnabled) return;
  if (state.proofreadBatchInFlight || state.proofreadAvailable !== true) return;
  const items = Object.values(state.proofreadQueue).slice(0, PROOFREAD_BATCH_SIZE);
  if (!items.length) return;
  for (const item of items) delete state.proofreadQueue[item.id];
  state.proofreadBatchInFlight = true;
  try {
    const response = await api("/api/proofread/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: "es",
        items: items.map((item) => ({ id: item.id, text: item.text })),
      }),
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const result of response.results || []) {
      const item = byId.get(result.id);
      if (!item) continue;
      const segment = currentSegments()[item.index];
      if (!segment || textHash(segment.text || "") !== item.textHash) continue;
      const normalized = {
        status: "done",
        textHash: item.textHash,
        matches: result.matches || [],
        truncated: Boolean(result.truncated),
      };
      state.proofreadResults[item.id] = normalized;
      state.proofreadCache[proofreadCacheKey(item.id, item.textHash)] = normalized;
      renderProofreadPanel(proofreadPanelForKey(item.id), item.id, item.index);
    }
  } finally {
    state.proofreadBatchInFlight = false;
    if (Object.keys(state.proofreadQueue).length) scheduleProofreadBatch();
  }
}

function observeProofreadSegments() {
  if (!state.proofreadEnabled) return;
  if (state.proofreadAvailable !== true || !state.current || state.current.status !== "done") return;
  if (state.proofreadObserver) state.proofreadObserver.disconnect();
  state.proofreadObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number(entry.target.dataset.segmentIndex);
        const key = entry.target.dataset.proofreadKey;
        if (Number.isInteger(index) && key) queueProofreadSegment(index, key);
      }
    },
    { root: null, rootMargin: "180px 0px", threshold: 0.01 }
  );
  document.querySelectorAll(".segment[data-proofread-key]").forEach((row) => {
    state.proofreadObserver.observe(row);
  });
}

function proofreadReplacementNeedsConfirmation(match, replacement) {
  const original = String(match?.text || "");
  const next = String(replacement || "");
  const originalWords = original.trim().split(/\s+/).filter(Boolean).length;
  const nextWords = next.trim().split(/\s+/).filter(Boolean).length;
  return originalWords > 1 || nextWords > 1 || Math.abs(next.length - original.length) > 16 || /[.!?;:]/.test(next);
}

function applyProofreadReplacement(index, key, match, replacement) {
  if (!state.proofreadEnabled) return;
  const segment = currentSegments()[index];
  if (!segment) return;
  const text = String(segment.text || "");
  const offset = Number(match.offset);
  const length = Number(match.length);
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length < 0 || offset < 0 || offset + length > text.length) return;
  const currentText = text.slice(offset, offset + length);
  if (match.text && currentText !== match.text) return;
  if (proofreadReplacementNeedsConfirmation(match, replacement)) {
    const ok = window.confirm(`Aplicar esta correccion?\n\n${currentText || "texto"} -> ${replacement}`);
    if (!ok) return;
  }
  pushSegmentUndo([{ index, segment: cloneSegment(segment) }], "proofread");
  segment.text = `${text.slice(0, offset)}${replacement}${text.slice(offset + length)}`;
  delete state.proofreadResults[key];
  markDirty();
  renderSegments();
  scheduleProofreadSegment(index, segmentKey(segment, index));
}

register({
  enableSpanishProofing,
  proofreadPanelForKey,
  textHash,
  proofreadCacheKey,
  clearProofreadTimers,
  clearProofreadState,
  loadProofreadStatus,
  scheduleProofreadStatusPoll,
  proofreadStatusText,
  renderProofreadStatus,
  firstLetterOffset,
  isInitialCapitalizationMatch,
  segmentStartsNewProofreadSentence,
  proofreadMatchesForSegment,
  proofreadKind,
  proofreadVisibleMatches,
  proofreadSummaryText,
  renderProofreadPanel,
  queueProofreadSegment,
  scheduleProofreadSegment,
  scheduleProofreadBatch,
  flushProofreadBatch,
  observeProofreadSegments,
  proofreadReplacementNeedsConfirmation,
  applyProofreadReplacement,
});

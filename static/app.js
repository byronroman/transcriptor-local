const state = {
  status: null,
  projects: [],
  current: null,
  pollTimer: null,
  elapsedTimer: null,
  activeJobId: null,
  currentJob: null,
  selectedSegmentIds: new Set(),
  lastSelectedSegmentIndex: null,
  activeSegmentIndex: null,
  audioSeekDragging: false,
  audioFollow: true,
  audioVolume: 1,
  audioMuted: false,
  previousAudioVolume: 1,
  audioVolumePopoverOpen: false,
  programmaticScrollUntil: 0,
  autosaveTimer: null,
  autosaveInFlight: false,
  autosaveQueued: false,
  draftTimer: null,
  playbackSaveTimer: null,
  playbackRestorePending: false,
  playbackProjectId: null,
  changeVersion: 0,
  dirty: false,
  sidebarCollapsed: false,
  sidebarPreference: null,
  speakersPanelOpen: false,
  saveBlocked: false,
  lastSaveError: null,
  saveConflict: null,
  dismissedDraftKeys: new Set(),
  pendingDraftRestoreResolve: null,
  pendingDeleteSegmentIndex: null,
  pendingDeleteSegmentResolve: null,
  pendingImportPreview: null,
  pendingDuplicateImport: null,
  segmentUndoStack: [],
  segmentUndoDismissedLength: 0,
  segmentUndoToastTimer: null,
  proofreadResults: {},
  proofreadTimers: {},
  proofreadRequests: {},
  proofreadEnabled: true,
  proofreadAvailable: null,
  proofreadStatus: "idle",
  proofreadStarting: false,
  proofreadUnavailableMessage: "",
  proofreadStatusTimer: null,
  proofreadQueue: {},
  proofreadBatchTimer: null,
  proofreadBatchInFlight: false,
  proofreadCache: {},
  proofreadObserver: null,
  browserDefaultPreferences: null,
  segmentVirtualStart: 0,
  segmentVirtualEnd: 0,
  segmentVirtualHeight: 108,
  segmentVirtualRenderFrame: null,
};

const $ = (id) => document.getElementById(id);
const THEME_STORAGE_KEY = "transcriptor.theme";
const SIDEBAR_STORAGE_KEY = "transcriptor.sidebarCollapsed";
const SPEAKERS_PANEL_STORAGE_KEY = "transcriptor.speakersPanelOpen";
const PROOFREAD_ENABLED_STORAGE_KEY = "transcriptor.proofreadEnabled.v2";
const AUDIO_VOLUME_STORAGE_KEY = "transcriptor.audioVolume";
const AUDIO_MUTED_STORAGE_KEY = "transcriptor.audioMuted";
const BROWSER_SETTINGS_FORMAT = "transcriptor-local-browser-settings";
const PROJECT_PREFERENCES_PREFIX = "transcriptor.projectPreferences.";
const DRAFT_DB_NAME = "transcriptor-drafts";
const DRAFT_DB_VERSION = 1;
const DRAFT_STORE_NAME = "drafts";
const SEGMENT_UNDO_LIMIT = 12;
const SEGMENT_UNDO_AUTO_HIDE_MS = 9000;
const PROOFREAD_DEBOUNCE_MS = 1800;
const PROOFREAD_BATCH_DEBOUNCE_MS = 250;
const PROOFREAD_BATCH_SIZE = 8;
const PROOFREAD_QUEUE_LIMIT = 40;
const PROOFREAD_STATUS_POLL_MS = 2000;
const PROOFREAD_VISIBLE_LIMIT = 8;
const PROOFREAD_KIND_LABELS = {
  spelling: "Ortografia",
  punctuation: "Puntuacion",
  grammar: "Gramatica",
  style: "Estilo",
};
const SEGMENT_VIRTUALIZATION_THRESHOLD = 140;
const SEGMENT_VIRTUAL_OVERSCAN = 14;
const SEGMENT_VIRTUAL_MIN_HEIGHT = 72;
const SEGMENT_VIRTUAL_MAX_HEIGHT = 190;
const SAVE_BEFORE_EXPORT_TIMEOUT_MS = 15000;
const SAVE_BEFORE_EXPORT_ATTEMPTS = 4;
const ACTIVE_STATUSES = new Set(["queued", "processing", "pausing", "cancelling"]);
const RESUMABLE_STATUSES = new Set(["paused", "cancelled", "error"]);
const SPEAKER_PALETTE_LIGHT = [
  { color: "#0f766e", bg: "#e7f5f2", border: "#8fd4c8" },
  { color: "#2563eb", bg: "#eef4ff", border: "#aac4ff" },
  { color: "#b45309", bg: "#fff6e7", border: "#f2c076" },
  { color: "#7c3aed", bg: "#f4efff", border: "#c8b5ff" },
  { color: "#be123c", bg: "#fff0f3", border: "#f7a8ba" },
  { color: "#3f6212", bg: "#f0f8e8", border: "#b7d98e" },
];
const SPEAKER_PALETTE_DARK = [
  { color: "#2dd4bf", bg: "#102722", border: "#1f766d" },
  { color: "#60a5fa", bg: "#101f35", border: "#285a9d" },
  { color: "#f59e0b", bg: "#2b210f", border: "#93650d" },
  { color: "#a78bfa", bg: "#211833", border: "#6b4fbd" },
  { color: "#fb7185", bg: "#321820", border: "#9a3549" },
  { color: "#a3e635", bg: "#1f2a12", border: "#63821f" },
];
const VOLUME_ICONS = {
  high:
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>',
  low:
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>',
  muted:
    '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5Z"></path><path d="m22 9-6 6"></path><path d="m16 9 6 6"></path></svg>',
};

function on(id, eventName, handler) {
  const element = $(id);
  if (!element) {
    console.warn(`Elemento no encontrado: #${id}`);
    return;
  }
  element.addEventListener(eventName, handler);
}

function fmtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseClockToSeconds(value) {
  const match = String(value || "").match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function isJobActive(job = state.currentJob) {
  return Boolean(job && ACTIVE_STATUSES.has(job.status));
}

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function updateThemeButton() {
  const button = $("themeToggleBtn");
  if (!button) return;
  const dark = currentTheme() === "dark";
  const label = dark ? "Modo claro" : "Modo oscuro";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("is-dark", dark);
}

function setTheme(theme, options = {}) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  if (options.persist !== false) persistBrowserPreferenceState();
  updateThemeButton();
  if (state.current?.status === "done") {
    renderSpeakerLabels();
    renderSegments();
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch (_) {
    saved = null;
  }
  if (saved === "dark" || saved === "light") {
    setTheme(saved, { persist: false });
    return;
  }
  const existing = currentTheme();
  setTheme(existing, { persist: false });
}

function readStoredBool(key) {
  try {
    const value = localStorage.getItem(key);
    if (value === "true") return true;
    if (value === "false") return false;
  } catch (_) {
    // Ignore storage failures.
  }
  return null;
}

function writeStoredBool(key, value) {
  try {
    localStorage.setItem(key, value ? "true" : "false");
  } catch (_) {
    // Ignore storage failures.
  }
}

function currentBrowserPreferences() {
  return {
    theme: currentTheme(),
    sidebarCollapsed: Boolean(state.sidebarCollapsed),
    speakersPanelOpen: Boolean(state.speakersPanelOpen),
    proofreadEnabled: Boolean(state.proofreadEnabled),
    audioVolume: Math.max(0, Math.min(1, Number(state.audioVolume) || 0)),
    audioMuted: Boolean(state.audioMuted),
  };
}

function browserSettingsPayload(preferences = currentBrowserPreferences()) {
  return {
    format: BROWSER_SETTINGS_FORMAT,
    version: 1,
    exported_at: Date.now(),
    preferences,
  };
}

function normalizeBrowserPreferences(payload) {
  if (!payload || typeof payload !== "object") return null;
  const source = payload.preferences && typeof payload.preferences === "object" ? payload.preferences : payload;
  const preferences = {};
  if (source.theme === "dark" || source.theme === "light") preferences.theme = source.theme;
  for (const key of ["sidebarCollapsed", "speakersPanelOpen", "proofreadEnabled", "audioMuted"]) {
    if (typeof source[key] === "boolean") preferences[key] = source[key];
  }
  if (source.audioVolume !== undefined) {
    const volume = Number(source.audioVolume);
    if (Number.isFinite(volume)) preferences.audioVolume = Math.max(0, Math.min(1, volume));
  }
  return Object.keys(preferences).length ? preferences : null;
}

function projectPreferencesKey(projectId) {
  return projectId ? `${PROJECT_PREFERENCES_PREFIX}${projectId}` : "";
}

function readProjectBrowserPreferences(projectId) {
  const key = projectPreferencesKey(projectId);
  if (!key) return null;
  try {
    return normalizeBrowserPreferences(JSON.parse(localStorage.getItem(key) || "null"));
  } catch (_) {
    return null;
  }
}

function writeProjectBrowserPreferences(projectId, payload = currentBrowserPreferences()) {
  const key = projectPreferencesKey(projectId);
  const preferences = normalizeBrowserPreferences(payload);
  if (!key || !preferences) return false;
  try {
    localStorage.setItem(key, JSON.stringify(browserSettingsPayload(preferences)));
    return true;
  } catch (_) {
    return false;
  }
}

function removeProjectBrowserPreferences(projectId) {
  const key = projectPreferencesKey(projectId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch (_) {
    // Ignore storage failures.
  }
}

function writeGlobalBrowserPreferences() {
  const preferences = currentBrowserPreferences();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preferences.theme);
  } catch (_) {
    // Ignore storage failures.
  }
  state.sidebarPreference = preferences.sidebarCollapsed;
  writeStoredBool(SIDEBAR_STORAGE_KEY, preferences.sidebarCollapsed);
  writeStoredBool(SPEAKERS_PANEL_STORAGE_KEY, preferences.speakersPanelOpen);
  writeStoredBool(PROOFREAD_ENABLED_STORAGE_KEY, preferences.proofreadEnabled);
  writeStoredAudioVolume(preferences.audioVolume);
  writeStoredAudioMuted(preferences.audioMuted);
  state.browserDefaultPreferences = preferences;
}

function persistBrowserPreferenceState() {
  if (state.current?.id) {
    writeProjectBrowserPreferences(state.current.id);
    return;
  }
  writeGlobalBrowserPreferences();
}

function applyBrowserPreferences(payload) {
  const preferences = normalizeBrowserPreferences(payload);
  if (!preferences) return null;
  if (preferences.theme) setTheme(preferences.theme, { persist: false });
  if (Object.prototype.hasOwnProperty.call(preferences, "sidebarCollapsed")) {
    setSidebarCollapsed(preferences.sidebarCollapsed, { persist: false });
  }
  if (Object.prototype.hasOwnProperty.call(preferences, "speakersPanelOpen")) {
    setSpeakersPanelOpen(preferences.speakersPanelOpen, { persist: false });
  }
  if (Object.prototype.hasOwnProperty.call(preferences, "proofreadEnabled")) {
    setProofreadEnabled(preferences.proofreadEnabled, { persist: false });
  }
  if (Object.prototype.hasOwnProperty.call(preferences, "audioVolume")) {
    setAudioVolume(preferences.audioVolume, { persist: false });
  }
  if (Object.prototype.hasOwnProperty.call(preferences, "audioMuted")) {
    state.audioMuted = preferences.audioMuted;
    applyAudioVolume();
  }
  return preferences;
}

function applyProjectBrowserPreferences(projectId) {
  const preferences = readProjectBrowserPreferences(projectId);
  if (preferences) return applyBrowserPreferences(preferences);
  if (state.browserDefaultPreferences) applyBrowserPreferences(state.browserDefaultPreferences);
  return null;
}

function applySidebarState() {
  const layout = $("appLayout");
  const sidebar = $("sidebar");
  const button = $("sidebarToggleBtn");
  const collapseButton = $("sidebarCollapseBtn");
  if (layout) layout.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  if (sidebar) sidebar.classList.toggle("collapsed", state.sidebarCollapsed);
  if (button) {
    const label = state.sidebarCollapsed ? "Mostrar panel lateral" : "Contraer panel lateral";
    button.classList.toggle("active", !state.sidebarCollapsed);
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  if (collapseButton) {
    const label = state.sidebarCollapsed ? "Expandir panel lateral" : "Contraer panel lateral";
    const icon = collapseButton.children[0];
    const text = collapseButton.children[1];
    if (icon) icon.textContent = state.sidebarCollapsed ? "›" : "‹";
    if (text) text.textContent = state.sidebarCollapsed ? "Expandir panel" : "Contraer panel";
    collapseButton.title = label;
    collapseButton.setAttribute("aria-label", label);
  }
}

function setSidebarCollapsed(collapsed, options = {}) {
  state.sidebarCollapsed = Boolean(collapsed);
  if (options.persist !== false) persistBrowserPreferenceState();
  applySidebarState();
}

function syncSidebarDefaultForCurrent() {
  if (state.sidebarPreference !== null) {
    applySidebarState();
    return;
  }
  state.sidebarCollapsed = Boolean(state.current && state.current.status === "done");
  applySidebarState();
}

function applySpeakersPanelState() {
  const panel = $("speakerPanel");
  const button = $("speakerPanelToggleBtn");
  if (panel) panel.classList.toggle("collapsed", !state.speakersPanelOpen);
  if (button) {
    button.textContent = state.speakersPanelOpen ? "Cerrar" : "Editar";
    button.title = state.speakersPanelOpen ? "Ocultar edicion de hablantes" : "Editar hablantes";
  }
}

function setSpeakersPanelOpen(open, options = {}) {
  state.speakersPanelOpen = Boolean(open);
  if (options.persist !== false) persistBrowserPreferenceState();
  applySpeakersPanelState();
}

function hideProofreadPanels() {
  document.querySelectorAll(".proofread-panel").forEach((panel) => {
    panel.innerHTML = "";
    panel.classList.add("hidden");
  });
}

function applyProofreadEnabledState() {
  renderProofreadStatus();
  if (!state.proofreadEnabled) {
    if (state.proofreadStatusTimer) {
      clearTimeout(state.proofreadStatusTimer);
      state.proofreadStatusTimer = null;
    }
    clearProofreadState();
    hideProofreadPanels();
  } else if (state.proofreadAvailable === true && state.current?.status === "done") {
    observeProofreadSegments();
  }
}

function setProofreadEnabled(enabled, options = {}) {
  state.proofreadEnabled = Boolean(enabled);
  if (options.persist !== false) persistBrowserPreferenceState();
  state.proofreadStarting = state.proofreadEnabled;
  if (!state.proofreadEnabled) {
    state.proofreadStatus = "idle";
    state.proofreadUnavailableMessage = "";
  }
  applyProofreadEnabledState();
  if (state.proofreadEnabled) {
    loadProofreadStatus({ start: true }).catch(() => {});
  } else {
    api("/api/proofread/stop", { method: "POST" }).catch(() => {});
  }
}

function initUiPreferences() {
  state.sidebarPreference = readStoredBool(SIDEBAR_STORAGE_KEY);
  state.sidebarCollapsed = state.sidebarPreference === null ? false : state.sidebarPreference;
  const speakersOpen = readStoredBool(SPEAKERS_PANEL_STORAGE_KEY);
  state.speakersPanelOpen = speakersOpen === null ? false : speakersOpen;
  const proofreadEnabled = readStoredBool(PROOFREAD_ENABLED_STORAGE_KEY);
  state.proofreadEnabled = proofreadEnabled === null ? false : proofreadEnabled;
  applySidebarState();
  applySpeakersPanelState();
  applyProofreadEnabledState();
}

function collectPortableBrowserSettings() {
  return browserSettingsPayload(currentBrowserPreferences());
}

function setDirty(dirty) {
  state.dirty = Boolean(dirty);
  const saveState = $("saveState");
  const saveBtn = $("saveBtn");
  if (saveState) {
    saveState.textContent = state.dirty ? "Cambios sin guardar" : "";
    saveState.classList.toggle("dirty", state.dirty);
  }
  if (saveBtn) saveBtn.classList.toggle("needs-save", state.dirty);
}

function unsavedDraftKey(projectId) {
  return `transcriptor.unsavedDraft.${projectId}`;
}

function normalizeDraftPayload(draft, projectId = state.current?.id) {
  if (!draft || typeof draft !== "object") return null;
  const draftProjectId = String(draft.project_id || projectId || "");
  if (!draftProjectId) return null;
  const segments = Array.isArray(draft.segments) ? draft.segments : null;
  if (!segments) return null;
  return {
    project_id: draftProjectId,
    name: String(draft.name || ""),
    segments,
    speaker_labels: draft.speaker_labels && typeof draft.speaker_labels === "object" ? draft.speaker_labels : {},
    change_version: Number(draft.change_version) || 0,
    content_revision: Number(draft.content_revision) || 0,
    project_updated_at: Number(draft.project_updated_at) || 0,
    reason: String(draft.reason || "edit"),
    local_saved_at: Number(draft.local_saved_at || draft.saved_at || Date.now()),
    saved_at: Number(draft.saved_at || draft.local_saved_at || Date.now()),
  };
}

function createUnsavedDraftPayload(reason = "edit") {
  if (!state.current?.id || state.current.status !== "done") return null;
  return normalizeDraftPayload(
    {
      project_id: state.current.id,
      name: $("projectName")?.value || state.current.name || "",
      segments: currentSegments(),
      speaker_labels: currentLabels(),
      change_version: state.changeVersion,
      content_revision: Number(state.current.content_revision) || 0,
      project_updated_at: Number(state.current.updated_at) || 0,
      reason,
      local_saved_at: Date.now(),
      saved_at: Date.now(),
    },
    state.current.id
  );
}

function openDraftDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB no disponible"));
      return;
    }
    const request = window.indexedDB.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        db.createObjectStore(DRAFT_STORE_NAME, { keyPath: "project_id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir IndexedDB"));
  });
}

async function withDraftStore(mode, callback) {
  const db = await openDraftDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DRAFT_STORE_NAME, mode);
      const store = transaction.objectStore(DRAFT_STORE_NAME);
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error || transaction.error || new Error("Operacion de borrador fallida"));
        }
      };
      transaction.oncomplete = () => finish(undefined);
      transaction.onerror = () => fail(transaction.error);
      transaction.onabort = () => fail(transaction.error);
      try {
        const result = callback(store, finish, fail);
        if (result !== undefined) finish(result);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

function writeUnsavedDraftSyncFallback(reason = "edit", payload = null) {
  const draft = payload || createUnsavedDraftPayload(reason);
  if (!draft?.project_id) return false;
  try {
    localStorage.setItem(unsavedDraftKey(draft.project_id), JSON.stringify(draft));
    return true;
  } catch (_) {
    return false;
  }
}

async function writeUnsavedDraft(reason = "edit") {
  const draft = createUnsavedDraftPayload(reason);
  if (!draft?.project_id) return false;
  try {
    await withDraftStore("readwrite", (store, finish, fail) => {
      const request = store.put(draft);
      request.onsuccess = () => finish(true);
      request.onerror = () => fail(request.error);
    });
    return true;
  } catch (_) {
    return writeUnsavedDraftSyncFallback(reason, draft);
  }
}

async function readUnsavedDraft(projectId) {
  if (!projectId) return null;
  try {
    const draft = await withDraftStore("readonly", (store, finish, fail) => {
      const request = store.get(projectId);
      request.onsuccess = () => finish(request.result || null);
      request.onerror = () => fail(request.error);
    });
    const normalized = normalizeDraftPayload(draft, projectId);
    if (normalized) return normalized;
  } catch (_) {
    // Fall back to localStorage below.
  }
  try {
    return normalizeDraftPayload(JSON.parse(localStorage.getItem(unsavedDraftKey(projectId)) || "null"), projectId);
  } catch (_) {
    return null;
  }
}

function draftDismissKey(draft) {
  if (!draft) return "";
  return `${draft.project_id}:${draft.local_saved_at}:${draft.content_revision}:${draft.change_version}`;
}

function segmentUndoKey(projectId = state.current?.id) {
  return projectId ? `transcriptor.segmentUndo.${projectId}` : "";
}

function cloneSegment(segment) {
  try {
    return structuredClone(segment);
  } catch (_) {
    return JSON.parse(JSON.stringify(segment));
  }
}

function loadSegmentUndoStack(projectId = state.current?.id) {
  state.segmentUndoStack = [];
  state.segmentUndoDismissedLength = 0;
  const key = segmentUndoKey(projectId);
  if (!key) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(parsed)) {
      state.segmentUndoStack = parsed
        .filter((action) => action && Array.isArray(action.items) && action.items.length)
        .slice(-SEGMENT_UNDO_LIMIT);
    }
  } catch (_) {
    state.segmentUndoStack = [];
  }
  // El historial persistido existe solo como red de seguridad. Al abrir o recargar
  // un proyecto no debe verse como una eliminacion nueva.
  state.segmentUndoDismissedLength = state.segmentUndoStack.length;
}

function persistSegmentUndoStack(projectId = state.current?.id) {
  const key = segmentUndoKey(projectId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state.segmentUndoStack.slice(-SEGMENT_UNDO_LIMIT)));
  } catch (_) {
    // Undo is a safety net; do not interrupt editing if storage is unavailable.
  }
}

function clearSegmentUndoTimer() {
  if (state.segmentUndoToastTimer) {
    clearTimeout(state.segmentUndoToastTimer);
    state.segmentUndoToastTimer = null;
  }
}

function scheduleSegmentUndoAutoHide() {
  clearSegmentUndoTimer();
  state.segmentUndoToastTimer = setTimeout(() => {
    state.segmentUndoToastTimer = null;
    clearSegmentUndoToast();
  }, SEGMENT_UNDO_AUTO_HIDE_MS);
}

function pushSegmentUndo(items, reason = "delete") {
  if (!state.current?.id || state.current.status !== "done" || !items.length) return;
  const normalized = items
    .map((item) => ({
      index: Math.max(0, Number(item.index) || 0),
      segment: cloneSegment(item.segment),
    }))
    .sort((a, b) => a.index - b.index);
  state.segmentUndoStack.push({
    project_id: state.current.id,
    reason,
    created_at: new Date().toISOString(),
    items: normalized,
  });
  state.segmentUndoStack = state.segmentUndoStack.slice(-SEGMENT_UNDO_LIMIT);
  state.segmentUndoDismissedLength = 0;
  persistSegmentUndoStack();
  renderSegmentUndoToast();
}

function renderSegmentUndoToast() {
  const toast = $("segmentUndoToast");
  const label = $("segmentUndoText");
  if (!toast) return;
  const action = state.segmentUndoStack[state.segmentUndoStack.length - 1];
  const dismissed = state.segmentUndoDismissedLength >= state.segmentUndoStack.length;
  const show = Boolean(state.current?.status === "done" && action?.items?.length && !dismissed);
  toast.classList.toggle("hidden", !show);
  if (show) {
    scheduleSegmentUndoAutoHide();
  } else {
    clearSegmentUndoTimer();
  }
  if (label && show) {
    const count = action.items.length;
    if (action.reason === "proofread") {
      label.textContent = "Correccion aplicada";
    } else {
      label.textContent = `${count} segmento${count === 1 ? "" : "s"} borrado${count === 1 ? "" : "s"}`;
    }
  }
}

function clearSegmentUndoToast() {
  state.segmentUndoDismissedLength = state.segmentUndoStack.length;
  clearSegmentUndoTimer();
  renderSegmentUndoToast();
}

function undoLastSegmentDelete() {
  if (!state.current?.id || state.current.status !== "done") return;
  clearSegmentUndoTimer();
  const action = state.segmentUndoStack.pop();
  if (!action?.items?.length) {
    renderSegmentUndoToast();
    return;
  }
  const segments = currentSegments();
  if (action.reason === "proofread") {
    for (const item of action.items.slice().sort((a, b) => a.index - b.index)) {
      const original = cloneSegment(item.segment);
      const targetById = original.id ? segments.findIndex((segment) => segment.id === original.id) : -1;
      const fallbackIndex = Math.max(0, Math.min(segments.length, Number(item.index) || 0));
      const targetIndex = targetById >= 0 ? targetById : fallbackIndex;
      if (segments[targetIndex]) {
        segments[targetIndex] = original;
      } else {
        segments.splice(targetIndex, 0, original);
      }
    }
  } else {
    for (const item of action.items.slice().sort((a, b) => a.index - b.index)) {
      const insertAt = Math.max(0, Math.min(segments.length, Number(item.index) || 0));
      segments.splice(insertAt, 0, cloneSegment(item.segment));
    }
  }
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  persistSegmentUndoStack();
  markDirty();
  renderSpeakerLabels();
  renderSegments();
  renderSegmentUndoToast();
}

function scheduleUnsavedDraft(delay = 800) {
  if (!state.current?.id || state.current.status !== "done") return;
  if (state.draftTimer) clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    state.draftTimer = null;
    writeUnsavedDraft("edit").catch(() => {});
  }, delay);
}

function clearUnsavedDraft(projectId = state.current?.id) {
  if (!projectId) return;
  if (state.draftTimer) {
    clearTimeout(state.draftTimer);
    state.draftTimer = null;
  }
  try {
    localStorage.removeItem(unsavedDraftKey(projectId));
  } catch (_) {
    // Ignore storage failures.
  }
  withDraftStore("readwrite", (store, finish, fail) => {
    const request = store.delete(projectId);
    request.onsuccess = () => finish(true);
    request.onerror = () => fail(request.error);
  }).catch(() => {});
}

function setEditorSaveBlocked(blocked) {
  state.saveBlocked = Boolean(blocked);
  document.body.classList.toggle("save-blocked", state.saveBlocked);
  const editor = $("editor");
  if (editor) editor.inert = state.saveBlocked;
}

function showSaveFailure(error, context = "Guardado") {
  state.lastSaveError = error;
  const player = $("audioPlayer");
  if (player) player.pause();
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  const overlay = $("saveFailureOverlay");
  const title = $("saveFailureTitle");
  const detail = $("saveFailureDetail");
  const draftStatus = $("saveFailureDraftStatus");
  if (title) title.textContent = `${context} fallido`;
  if (detail) detail.textContent = error?.message || String(error || "Error desconocido");
  if (draftStatus) {
    draftStatus.textContent = "Guardando borrador local en este navegador...";
    draftStatus.classList.remove("bad");
  }
  writeUnsavedDraft("save-failed")
    .then((draftSaved) => {
      if (!draftStatus) return;
      draftStatus.textContent = draftSaved
        ? "Se guardo un borrador local en este navegador mientras se resuelve el problema."
        : "No se pudo guardar borrador local; no cierres esta pestaña antes de reintentar.";
      draftStatus.classList.toggle("bad", !draftSaved);
    })
    .catch(() => {
      if (!draftStatus) return;
      draftStatus.textContent = "No se pudo guardar borrador local; no cierres esta pestaña antes de reintentar.";
      draftStatus.classList.add("bad");
    });
  if (overlay) overlay.classList.remove("hidden");
  const retry = $("retrySaveBtn");
  if (retry) retry.focus();
  setEditorSaveBlocked(true);
}

function clearSaveFailure() {
  const overlay = $("saveFailureOverlay");
  if (overlay) overlay.classList.add("hidden");
  state.lastSaveError = null;
  setEditorSaveBlocked(false);
}

function showSaveConflict(error) {
  state.saveConflict = error;
  const player = $("audioPlayer");
  if (player) player.pause();
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  const overlay = $("saveConflictOverlay");
  const detail = $("saveConflictDetail");
  const draftStatus = $("saveConflictDraftStatus");
  if (detail) detail.textContent = error?.message || "El servidor tiene una revision mas reciente.";
  if (draftStatus) {
    draftStatus.textContent = "Guardando borrador local en este navegador...";
    draftStatus.classList.remove("bad");
  }
  writeUnsavedDraft("conflict")
    .then((draftSaved) => {
      if (!draftStatus) return;
      draftStatus.textContent = draftSaved
        ? "Se guardo esta edicion como borrador local."
        : "No se pudo guardar borrador local; no cierres esta pestaña antes de decidir.";
      draftStatus.classList.toggle("bad", !draftSaved);
    })
    .catch(() => {
      if (!draftStatus) return;
      draftStatus.textContent = "No se pudo guardar borrador local; no cierres esta pestaña antes de decidir.";
      draftStatus.classList.add("bad");
    });
  if (overlay) overlay.classList.remove("hidden");
  const keepLocal = $("keepLocalConflictBtn");
  if (keepLocal) keepLocal.focus();
  setEditorSaveBlocked(true);
}

function clearSaveConflict() {
  const overlay = $("saveConflictOverlay");
  if (overlay) overlay.classList.add("hidden");
  state.saveConflict = null;
  setEditorSaveBlocked(false);
}

async function keepLocalAfterConflict() {
  if (!state.current?.id) return;
  const projectId = state.current.id;
  const serverProject = await api(`/api/projects/${projectId}`);
  if (state.current?.id !== projectId) return;
  state.current.content_revision = Number(serverProject.content_revision) || 0;
  state.current.updated_at = serverProject.updated_at || state.current.updated_at;
  clearSaveConflict();
  setDirty(true);
  scheduleAutosave(100);
}

function reloadServerAfterConflict() {
  if (!state.current?.id) return;
  const projectId = state.current.id;
  clearUnsavedDraft(projectId);
  clearSaveConflict();
  window.location.reload();
}

function shouldOfferDraftRestore(draft, project) {
  if (!draft || !project?.id || draft.project_id !== project.id) return false;
  if (state.dismissedDraftKeys.has(draftDismissKey(draft))) return false;
  if (!Array.isArray(draft.segments) || !draft.segments.length) return false;
  const serverUpdatedAt = Number(project.updated_at) || 0;
  const serverRevision = Number(project.content_revision) || 0;
  const draftRevision = Number(draft.content_revision) || 0;
  if (["save-failed", "conflict"].includes(draft.reason)) return true;
  if (Number(draft.local_saved_at) > serverUpdatedAt + 250) return true;
  return draft.change_version > 0 && draftRevision !== serverRevision;
}

function resolveDraftRestore(action) {
  const resolver = state.pendingDraftRestoreResolve;
  state.pendingDraftRestoreResolve = null;
  const overlay = $("draftRestoreOverlay");
  if (overlay) overlay.classList.add("hidden");
  if (resolver) resolver(action);
}

function showDraftRestorePrompt(draft, project) {
  const overlay = $("draftRestoreOverlay");
  const text = $("draftRestoreText");
  const detail = $("draftRestoreDetail");
  if (!overlay) return Promise.resolve("server");
  const savedAt = draft.local_saved_at ? new Date(draft.local_saved_at).toLocaleString() : "fecha desconocida";
  if (text) {
    text.textContent = `Se encontro un borrador local de "${project.name || "este proyecto"}". Elige si quieres recuperarlo antes de seguir editando.`;
  }
  if (detail) {
    detail.textContent = [
      `Borrador local: ${savedAt}`,
      `Revision del borrador: ${Number(draft.content_revision) || 0}`,
      `Revision del servidor: ${Number(project.content_revision) || 0}`,
      `Segmentos en borrador: ${draft.segments.length}`,
    ].join("\n");
  }
  overlay.classList.remove("hidden");
  const restoreButton = $("restoreDraftBtn");
  if (restoreButton) restoreButton.focus();
  return new Promise((resolve) => {
    state.pendingDraftRestoreResolve = resolve;
  });
}

function applyDraftToCurrent(draft) {
  if (!state.current?.id || draft.project_id !== state.current.id) return;
  state.current.name = draft.name || state.current.name;
  state.current.segments = cloneSegment(draft.segments);
  state.current.speaker_labels = draft.speaker_labels || {};
  state.current.content_revision = Number(draft.content_revision) || 0;
  state.current.updated_at = Number(draft.project_updated_at) || state.current.updated_at;
  state.changeVersion += 1;
  renderEditor();
  setDirty(true);
  scheduleAutosave(250);
}

async function maybeOfferDraftRestore(projectId) {
  if (!state.current?.id || state.current.id !== projectId || state.current.status !== "done") return;
  const draft = await readUnsavedDraft(projectId);
  if (!shouldOfferDraftRestore(draft, state.current)) return;
  const action = await showDraftRestorePrompt(draft, state.current);
  if (action === "restore") {
    applyDraftToCurrent(draft);
    return;
  }
  if (action === "discard") {
    clearUnsavedDraft(projectId);
    return;
  }
  state.dismissedDraftKeys.add(draftDismissKey(draft));
}

function segmentPreviewText(segment) {
  const text = String(segment?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return "Sin texto";
  return text.length > 130 ? `${text.slice(0, 127)}...` : text;
}

function resolveDeleteSegmentConfirmation(confirmed) {
  const resolver = state.pendingDeleteSegmentResolve;
  state.pendingDeleteSegmentResolve = null;
  state.pendingDeleteSegmentIndex = null;
  const overlay = $("confirmDeleteSegmentOverlay");
  if (overlay) overlay.classList.add("hidden");
  if (resolver) resolver(Boolean(confirmed));
}

function confirmDeleteSegment(index) {
  const segment = currentSegments()[index];
  if (!segment) return Promise.resolve(false);
  if (state.pendingDeleteSegmentResolve) {
    resolveDeleteSegmentConfirmation(false);
  }
  state.pendingDeleteSegmentIndex = index;
  const overlay = $("confirmDeleteSegmentOverlay");
  const meta = $("confirmDeleteSegmentMeta");
  const text = $("confirmDeleteSegmentText");
  if (!overlay) {
    state.pendingDeleteSegmentIndex = null;
    return Promise.resolve(
      confirm(
        `Borrar este segmento?\n\n${fmtTime(segment.start)}-${fmtTime(segment.end)}\n${segmentPreviewText(segment)}`
      )
    );
  }
  if (text) {
    text.textContent = "Esta accion quitara este segmento de la transcripcion. El cambio se guardara automaticamente.";
  }
  if (meta) {
    meta.textContent = `${fmtTime(segment.start)}-${fmtTime(segment.end)} · ${segmentPreviewText(segment)}`;
  }
  if (overlay) overlay.classList.remove("hidden");
  return new Promise((resolve) => {
    state.pendingDeleteSegmentResolve = resolve;
    const cancel = $("cancelDeleteSegmentBtn");
    if (cancel) cancel.focus();
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function markDirty() {
  if (state.current?.status !== "done") return;
  state.changeVersion += 1;
  setDirty(true);
  scheduleUnsavedDraft();
  scheduleAutosave();
}

function scheduleAutosave(delay = 1200) {
  if (!state.current || state.current.status !== "done") return;
  if (state.saveBlocked) return;
  if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => {
    state.autosaveTimer = null;
    saveEdits({ silent: true }).catch(() => {});
  }, delay);
}

function audioSrcForProject(projectId) {
  return `/api/projects/${projectId}/audio`;
}

function projectHasAudio(project = state.current) {
  return Boolean(project?.audio_path || project?.source_path);
}

function absoluteAudioSrc(projectId) {
  return new URL(audioSrcForProject(projectId), window.location.href).href;
}

function playbackStorageKey(projectId) {
  return `transcriptor.playback.${projectId}`;
}

function readStoredPlaybackPosition(project = state.current) {
  if (!project?.id) return 0;
  const projectPosition = Number(project.playback_position);
  let position = Number.isFinite(projectPosition) ? projectPosition : 0;
  try {
    const raw = localStorage.getItem(playbackStorageKey(project.id));
    if (raw) {
      const parsed = JSON.parse(raw);
      const localPosition = Number(typeof parsed === "object" ? parsed.seconds : parsed);
      if (Number.isFinite(localPosition)) position = localPosition;
    }
  } catch (_) {
    // localStorage can fail in private/restricted browser contexts.
  }
  return Math.max(0, position);
}

function writeStoredPlaybackPosition(projectId, seconds) {
  if (!projectId || !Number.isFinite(seconds)) return;
  try {
    localStorage.setItem(
      playbackStorageKey(projectId),
      JSON.stringify({ seconds: Math.max(0, seconds), updated_at: Date.now() })
    );
  } catch (_) {
    // Backend persistence still covers this when localStorage is unavailable.
  }
}

function removeStoredPlaybackPosition(projectId) {
  if (!projectId) return;
  try {
    localStorage.removeItem(playbackStorageKey(projectId));
  } catch (_) {
    // Ignore localStorage failures.
  }
}

function readStoredAudioVolume() {
  try {
    const stored = Number(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY));
    if (Number.isFinite(stored)) return Math.max(0, Math.min(1, stored));
  } catch (_) {
    // Ignore storage failures.
  }
  return 1;
}

function writeStoredAudioVolume(volume) {
  try {
    localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(Math.max(0, Math.min(1, volume))));
  } catch (_) {
    // Ignore storage failures.
  }
}

function readStoredAudioMuted() {
  try {
    return localStorage.getItem(AUDIO_MUTED_STORAGE_KEY) === "true";
  } catch (_) {
    return false;
  }
}

function writeStoredAudioMuted(muted) {
  try {
    localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, muted ? "true" : "false");
  } catch (_) {
    // Ignore storage failures.
  }
}

function setAudioVolumePopoverOpen(open) {
  state.audioVolumePopoverOpen = Boolean(open);
  const menu = $("audioVolumeMenu");
  const popover = $("audioVolumePopover");
  const button = $("audioVolumeBtn");
  if (menu) menu.classList.toggle("open", state.audioVolumePopoverOpen);
  if (popover) popover.classList.toggle("hidden", !state.audioVolumePopoverOpen);
  if (button) button.setAttribute("aria-expanded", state.audioVolumePopoverOpen ? "true" : "false");
}

function audioVolumeIconName(volume = state.audioVolume, muted = state.audioMuted) {
  if (muted || volume <= 0) return "muted";
  if (volume < 0.5) return "low";
  return "high";
}

function applyAudioVolume() {
  const player = $("audioPlayer");
  const volume = Math.max(0, Math.min(1, Number(state.audioVolume)));
  const muted = Boolean(state.audioMuted || volume <= 0);
  if (player) {
    player.volume = volume;
    player.muted = muted;
  }
  const slider = $("audioVolume");
  if (slider) slider.value = String(Math.round(volume * 100));
  const percent = Math.round(volume * 100);
  const percentLabel = $("audioVolumePercent");
  if (percentLabel) percentLabel.textContent = `${percent}%`;
  const muteButton = $("audioMuteBtn");
  if (muteButton) {
    muteButton.textContent = muted ? "Activar sonido" : "Silenciar";
    muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
  }
  const volumeButton = $("audioVolumeBtn");
  if (volumeButton) {
    const label = muted ? `Volumen silenciado, ${percent}%` : `Volumen ${percent}%`;
    volumeButton.title = "Volumen";
    volumeButton.setAttribute("aria-label", label);
  }
  const icon = $("audioVolumeIcon");
  if (icon) {
    icon.innerHTML = VOLUME_ICONS[audioVolumeIconName(volume, muted)];
  }
}

function setAudioVolume(value, options = {}) {
  const volume = Math.max(0, Math.min(1, Number(value)));
  state.audioVolume = Number.isFinite(volume) ? volume : 1;
  if (state.audioVolume > 0) {
    state.previousAudioVolume = state.audioVolume;
    state.audioMuted = false;
  } else {
    state.audioMuted = true;
  }
  applyAudioVolume();
  if (options.persist !== false) persistBrowserPreferenceState();
}

function toggleAudioMute() {
  if (state.audioMuted || state.audioVolume <= 0) {
    state.audioMuted = false;
    if (state.audioVolume <= 0) {
      state.audioVolume = Math.max(0.35, Math.min(1, Number(state.previousAudioVolume) || 1));
    }
  } else {
    state.previousAudioVolume = state.audioVolume || state.previousAudioVolume || 1;
    state.audioMuted = true;
  }
  applyAudioVolume();
  persistBrowserPreferenceState();
}

function initAudioVolume() {
  state.audioVolume = readStoredAudioVolume();
  state.previousAudioVolume = state.audioVolume > 0 ? state.audioVolume : 1;
  state.audioMuted = readStoredAudioMuted();
  applyAudioVolume();
}

function currentPlaybackPosition() {
  if (!state.current?.id || state.current.status !== "done") return null;
  const player = $("audioPlayer");
  if (!player) return null;
  const expected = absoluteAudioSrc(state.current.id);
  if (player.src && player.src !== expected) return null;
  const position = Number(player.currentTime);
  if (!Number.isFinite(position)) return null;
  return clampAudioTime(position, player);
}

function schedulePlaybackSave(delay = 4000) {
  if (!state.current?.id || state.current.status !== "done") return;
  if (state.playbackSaveTimer) return;
  state.playbackSaveTimer = setTimeout(() => {
    state.playbackSaveTimer = null;
    flushPlaybackPosition().catch(() => {});
  }, delay);
}

function rememberPlaybackPosition(options = {}) {
  const position = currentPlaybackPosition();
  if (position === null) return;
  if (state.playbackRestorePending && position < 0.5) return;
  state.current.playback_position = position;
  writeStoredPlaybackPosition(state.current.id, position);
  if (options.immediate) {
    flushPlaybackPosition({ keepalive: Boolean(options.keepalive) }).catch(() => {});
  } else {
    schedulePlaybackSave();
  }
}

async function flushPlaybackPosition(options = {}) {
  const projectId = state.current?.id;
  const position = currentPlaybackPosition();
  if (!projectId || position === null) return;
  if (state.playbackSaveTimer) {
    clearTimeout(state.playbackSaveTimer);
    state.playbackSaveTimer = null;
  }
  state.current.playback_position = position;
  writeStoredPlaybackPosition(projectId, position);
  const request = {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playback_position: position }),
    keepalive: Boolean(options.keepalive),
  };
  if (options.keepalive) {
    apiFireAndForget(`/api/projects/${projectId}`, request);
    return;
  }
  let updated = null;
  try {
    updated = await api(`/api/projects/${projectId}`, request);
  } catch (_) {
    return;
  }
  if (state.current?.id === projectId) {
    state.current.playback_position = Number(updated.playback_position) || position;
    state.current.updated_at = updated.updated_at || state.current.updated_at;
  }
}

function restorePlaybackPositionIfNeeded() {
  if (!state.playbackRestorePending || !state.current?.id) return;
  const player = $("audioPlayer");
  if (!player) return;
  const duration = audioDurationValue(player);
  if (!duration) return;
  if (state.playbackProjectId && state.playbackProjectId !== state.current.id) return;
  const position = Math.min(readStoredPlaybackPosition(state.current), Math.max(0, duration - 0.25));
  state.playbackRestorePending = false;
  state.playbackProjectId = null;
  if (position > 0.5) {
    player.currentTime = position;
    state.current.playback_position = position;
  }
  updateActiveSegmentFromAudio();
  updateStickyAudioControls();
}

async function saveDirtyBeforeContinuing(message) {
  if (state.saveBlocked) return false;
  if (!state.dirty) return true;
  const confirmed = confirm(`${message}\n\nPresiona OK para guardar y continuar, o Cancelar para volver al editor.`);
  if (!confirmed) return false;
  try {
    await saveEdits();
    return true;
  } catch (_) {
    return false;
  }
}

async function waitForAutosaveIdle(timeoutMs = SAVE_BEFORE_EXPORT_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (state.autosaveInFlight) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("El guardado automatico sigue en curso. Intenta exportar nuevamente.");
    }
    await delay(100);
  }
}

async function saveBeforePackageExport() {
  if (!state.current || state.current.status !== "done") return false;
  if (state.saveBlocked) {
    throw new Error("No se puede exportar porque hay un error de guardado pendiente. Reintenta el guardado primero.");
  }
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
  const saveState = $("saveState");
  if (saveState) {
    saveState.textContent = "Guardando antes de exportar...";
    saveState.classList.remove("dirty");
  }
  for (let attempt = 0; attempt < SAVE_BEFORE_EXPORT_ATTEMPTS; attempt += 1) {
    await waitForAutosaveIdle();
    if (state.saveBlocked) {
      throw new Error("No se puede exportar porque el guardado fallo.");
    }
    if (!state.dirty && !state.autosaveQueued) {
      if (saveState) saveState.textContent = "Listo para exportar";
      setTimeout(() => {
        if (!state.dirty && saveState?.textContent === "Listo para exportar") saveState.textContent = "";
      }, 1600);
      return true;
    }
    state.autosaveQueued = false;
    await saveEdits();
  }
  await waitForAutosaveIdle();
  if (state.saveBlocked || state.dirty) {
    throw new Error("No se pudo confirmar el guardado. No se exporto el paquete.");
  }
  return true;
}

function packageExportUrlWithBrowserSettings(href) {
  const url = new URL(href, window.location.origin);
  url.searchParams.set("browser_settings", JSON.stringify(collectPortableBrowserSettings()));
  return url.toString();
}

async function exportPackageAfterSave(event, linkId) {
  event.preventDefault();
  const link = $(linkId);
  if (!link?.href || link.getAttribute("href") === "#") return;
  if (link.dataset.exporting === "true") return;
  link.dataset.exporting = "true";
  link.setAttribute("aria-busy", "true");
  try {
    const saved = await saveBeforePackageExport();
    if (!saved) return;
    window.location.href = packageExportUrlWithBrowserSettings(link.href);
  } finally {
    delete link.dataset.exporting;
    link.removeAttribute("aria-busy");
  }
}

function setTranscribeBusy(busy) {
  const transcribeBtn = $("transcribeBtn");
  if (transcribeBtn) {
    transcribeBtn.disabled = busy;
    transcribeBtn.textContent = busy ? "Transcribiendo..." : "Transcribir";
  }
  for (const id of ["fileInput", "modelSelect", "profileSelect", "diarizeInput", "speakersSelect"]) {
    const element = $(id);
    if (element) element.disabled = busy;
  }
  const diarizeButton = $("diarizeProjectBtn");
  if (diarizeButton) diarizeButton.disabled = busy;
  const relabelButton = $("relabelProjectBtn");
  if (relabelButton) relabelButton.disabled = busy || !(state.current?.diarization_turns || []).length;
}

function jobProgressMeta(job) {
  const parts = [];
  if (job?.started_at) {
    parts.push(`Tiempo transcurrido: ${fmtElapsed(Date.now() - Number(job.started_at))}`);
  }
  if (job?.stage) {
    const stageLabels = {
      convert: "Conversion",
      whisper: "Whisper",
      diarization: "Separacion de hablantes",
      editor: "Editor",
      done: "Listo",
    };
    parts.push(`Etapa: ${stageLabels[job.stage] || job.stage}`);
  }
  if (job?.chunk_index && job?.chunk_total) {
    parts.push(`Tramo ${job.chunk_index}/${job.chunk_total}`);
  }
  if (job?.retry_size) {
    parts.push(`Intento ${job.retry_size}s`);
  }
  if (job?.last_warning) {
    parts.push(`Ultimo aviso: ${job.last_warning}`);
  }
  return parts.join(" · ") || "Tiempo transcurrido: 00:00";
}

function updateElapsedDisplay() {
  const meta = $("loadingMeta");
  const job = state.currentJob;
  if (!meta || !job?.started_at || !isJobActive(job)) return;
  meta.textContent = jobProgressMeta(job);
}

function startElapsedTimer() {
  if (state.elapsedTimer) return;
  state.elapsedTimer = setInterval(updateElapsedDisplay, 1000);
}

function stopElapsedTimer() {
  if (!state.elapsedTimer) return;
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function apiDetailMessage(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const location = Array.isArray(item.loc) ? item.loc.join(".") : "";
        const message = item.msg || item.message || item.detail || "";
        return [location, message].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof detail === "object") {
    for (const key of ["message", "msg", "error", "detail"]) {
      if (detail[key]) return apiDetailMessage(detail[key]);
    }
    return "";
  }
  return String(detail);
}

function normalizeErrorMessage(error, fallback = "No se pudo completar la operacion.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  const detail = apiDetailMessage(error.data?.detail || error.detail);
  const text = String(error.text || "").trim();
  const message = String(error.message || "").trim();
  return detail || message || text || fallback;
}

function createApiError(message, response, data, text) {
  const error = new Error(message || response?.statusText || "Error de servidor");
  error.name = "ApiError";
  error.status = response?.status || 0;
  error.statusText = response?.statusText || "";
  error.url = response?.url || "";
  error.data = data;
  error.text = text || "";
  return error;
}

function showError(error, fallback) {
  alert(normalizeErrorMessage(error, fallback));
}

function apiFireAndForget(path, options = {}) {
  fetch(path, options).catch(() => {});
}

async function api(path, options = {}) {
  let response = null;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw createApiError(
      error?.name === "AbortError" ? "La solicitud fue cancelada." : "No se pudo conectar con la app local.",
      null,
      null,
      ""
    );
  }
  let text = "";
  try {
    text = await response.text();
  } catch (_) {
    text = "";
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data && typeof data === "object" ? apiDetailMessage(data.detail) : "";
    const message = detail || text.trim() || response.statusText || `HTTP ${response.status}`;
    throw createApiError(message, response, data, text);
  }
  return data ?? {};
}

async function loadStatus() {
  state.status = await api("/api/status");
  renderStatus();
}

function renderStatus() {
  const tools = state.status?.tools || {};
  const diarization = state.status?.diarization || {};
  const models = state.status?.models || [];
  $("statusLine").textContent = models.length
    ? `${models.length} modelo(s) disponible(s)`
    : "Sin modelos Whisper disponibles";
  $("toolStatus").innerHTML = `
    <li><span>ffmpeg</span><strong class="${tools.ffmpeg ? "ok" : "bad"}">${tools.ffmpeg ? "OK" : "Falta"}</strong></li>
    <li><span>whisper.cpp</span><strong class="${tools.whisper ? "ok" : "bad"}">${tools.whisper ? "OK" : "Falta"}</strong></li>
    <li><span>sherpa-onnx</span><strong class="${diarization.ready ? "ok" : "bad"}">${diarization.ready ? "OK" : "Opcional"}</strong></li>
  `;
  const diagnosticsSummary = $("diagnosticsSummary");
  if (diagnosticsSummary) {
    const coreOk = Boolean(tools.ffmpeg && tools.whisper);
    diagnosticsSummary.textContent = coreOk && diarization.ready ? "Herramientas OK" : coreOk ? "Separacion de hablantes opcional" : "Revisar estado";
  }

  const select = $("modelSelect");
  select.innerHTML = "";
  if (!models.length) {
    const option = document.createElement("option");
    option.value = "auto";
    option.textContent = "Sin modelos";
    select.appendChild(option);
    return;
  }
  for (const model of models) {
    const option = document.createElement("option");
    const profile = modelProfile(model);
    option.value = model.name;
    option.textContent = `${profile.optionPrefix} · ${modelDisplayName(model.name)}${model.recommended ? " · recomendado" : ""}`;
    option.title = `${profile.title}. ${profile.description} ${profile.windows}`;
    option.selected = Boolean(model.recommended);
    select.appendChild(option);
  }
  updateModelHint();
  renderProfileSelect();
}

function modelDisplayName(name) {
  const value = String(name || "");
  if (value === "ggml-large-v3.bin") return "large-v3 completo";
  if (value.includes("large-v3-turbo")) return "large-v3 turbo q5";
  if (value.includes("large-v3-q5")) return "large-v3 q5";
  if (value.includes("medium")) return "medium q5";
  if (value.includes("small")) return "small q5";
  return value.replace(/^ggml-/, "").replace(/\.bin$/, "");
}

function modelProfile(model) {
  const name = String(model?.name || "").toLowerCase();
  if (name.includes("large-v3.bin") && !name.includes("q5") && !name.includes("turbo")) {
    return {
      optionPrefix: "Maxima calidad",
      title: "Maxima calidad",
      description: "Mayor precision local. Mas lento y pesado.",
      windows: "Windows: ideal 32 GB RAM.",
    };
  }
  if (name.includes("large-v3") && name.includes("q5") && !name.includes("turbo")) {
    return {
      optionPrefix: "Calidad alta",
      title: "Calidad alta recomendada",
      description: "Buen equilibrio para entrevistas largas.",
      windows: "Windows: recomendado con 16 GB RAM.",
    };
  }
  if (name.includes("large-v3-turbo")) {
    return {
      optionPrefix: "Rapido",
      title: "Rapido y estable",
      description: "Menor espera con buena calidad general.",
      windows: "Windows: opcion mas segura en CPU.",
    };
  }
  if (name.includes("medium")) {
    return {
      optionPrefix: "Intermedio",
      title: "Intermedio ligero",
      description: "Mas liviano; baja algo la precision.",
      windows: "Windows: util con poca RAM.",
    };
  }
  if (name.includes("small")) {
    return {
      optionPrefix: "Ligero",
      title: "Ligero para pruebas",
      description: "Rapido para pruebas, no para entrega final.",
      windows: "Windows: equipos basicos.",
    };
  }
  return {
    optionPrefix: "Modelo",
    title: "Modelo Whisper",
    description: "Modelo local disponible.",
    windows: "Depende de CPU y RAM.",
  };
}

function updateModelHint() {
  const hint = $("modelHint");
  const select = $("modelSelect");
  const models = state.status?.models || [];
  if (!hint || !select || !models.length) {
    if (hint) hint.classList.add("hidden");
    return;
  }
  const model = models.find((item) => item.name === select.value) || models.find((item) => item.recommended) || models[0];
  const profile = modelProfile(model);
  select.title = `${profile.title}. ${profile.description} ${profile.windows}`;
  hint.className = "model-hint";
  hint.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = `${profile.title}${model.recommended ? " · recomendado" : ""}`;
  const detail = document.createElement("span");
  detail.textContent = profile.description;
  const meta = document.createElement("small");
  meta.textContent = `${modelDisplayName(model.name)} · ${model.size_mb} MB · ${profile.windows}`;
  hint.append(title, detail, meta);
}

function processingProfileDetails(value) {
  if (value === "seguro_windows") {
    return {
      title: "Seguro Windows",
      detail: "Tramos cortos y 1 hilo. Menos riesgo de caida.",
    };
  }
  if (value === "rapido") {
    return {
      title: "Rapido",
      detail: "Prioriza velocidad. Usa turbo si esta disponible.",
    };
  }
  return {
    title: "Calidad",
    detail: "Tramos de 120s y reintentos para cuidar precision.",
  };
}

function renderProfileSelect() {
  const select = $("profileSelect");
  if (!select) return;
  const profiles = state.status?.profiles || [];
  if (profiles.length) {
    select.innerHTML = "";
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = profile.label;
      option.selected = Boolean(profile.default);
      select.appendChild(option);
    }
  } else if (state.status?.default_profile) {
    select.value = state.status.default_profile;
  }
  updateProfileHint();
}

function updateProfileHint() {
  const select = $("profileSelect");
  const hint = $("profileHint");
  if (!select || !hint) return;
  const details = processingProfileDetails(select.value);
  hint.className = "model-hint profile-hint";
  hint.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = details.title;
  const detail = document.createElement("span");
  detail.textContent = details.detail;
  hint.append(title, detail);
}

function maybeSelectModelForProfile() {
  const profile = $("profileSelect")?.value;
  const modelSelect = $("modelSelect");
  if (!profile || !modelSelect) return;
  if (profile === "rapido") {
    const turbo = [...modelSelect.options].find((option) => option.value.toLowerCase().includes("large-v3-turbo"));
    if (turbo) modelSelect.value = turbo.value;
  }
  updateModelHint();
  updateProfileHint();
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  renderProjects();
  syncSidebarDefaultForCurrent();
  const active = state.projects.find((project) => ACTIVE_STATUSES.has(project.status));
  if (active && !state.activeJobId) {
    state.activeJobId = active.id;
    state.currentJob = { status: active.status, step: active.status, progress: active.status === "queued" ? 0 : 25 };
    setTranscribeBusy(true);
    if (!state.current || state.current.id !== active.id) {
      await openProject(active.id);
    }
    pollJob(active.id);
  }
  if (!state.current) renderEditor();
}

async function loadProjectLog(projectId = state.current?.id) {
  if (!projectId) return;
  try {
    const data = await api(`/api/projects/${projectId}/logs`);
    const log = data.log || "Sin logs todavía.";
    const loadingLog = $("loadingLog");
    const editorLog = $("editorLog");
    if (loadingLog) loadingLog.textContent = log;
    if (editorLog) editorLog.textContent = log;
  } catch (_) {
    // Logs are diagnostic; avoid interrupting the workflow if unavailable.
  }
}

function renderProjects() {
  const list = $("projectList");
  list.innerHTML = "";
  if (!state.projects.length) {
    const p = document.createElement("p");
    p.textContent = "Todavia no hay proyectos.";
    list.appendChild(p);
    return;
  }
  for (const project of state.projects) {
    const row = document.createElement("div");
    row.className = "project-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-item${state.current?.id === project.id ? " active" : ""}`;
    button.textContent = `${project.name} (${project.status})`;
    button.addEventListener("click", () => openProject(project.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "project-delete danger secondary-danger";
    deleteButton.textContent = "Borrar";
    deleteButton.title = "Eliminar proyecto y archivos";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteProject(project.id, project.name).catch((error) => showError(error));
    });

    row.append(button, deleteButton);
    list.appendChild(row);
  }
}

function projectStatusText(status) {
  const labels = {
    done: "Listo",
    queued: "En cola",
    processing: "Procesando",
    paused: "Pausado",
    cancelled: "Cancelado",
    error: "Error",
    transcribed: "Transcrito",
  };
  return labels[status] || status || "Sin estado";
}

function projectUpdatedText(project) {
  const value = Number(project.updated_at || project.created_at);
  if (!Number.isFinite(value) || value <= 0) return "";
  const diff = Math.max(0, Date.now() - value);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "hace menos de 1 min";
  if (diff < hour) return `hace ${Math.floor(diff / minute)} min`;
  if (diff < day) return `hace ${Math.floor(diff / hour)} h`;
  return `hace ${Math.floor(diff / day)} d`;
}

function projectSegmentCount(project) {
  if (Array.isArray(project.segments)) return project.segments.length;
  const count = Number(project.segments);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function sortedProjectSuggestions() {
  const priority = { processing: 0, queued: 0, paused: 1, error: 2, cancelled: 3, done: 4, transcribed: 5 };
  return [...state.projects]
    .sort((a, b) => {
      const statusDelta = (priority[a.status] ?? 9) - (priority[b.status] ?? 9);
      if (statusDelta) return statusDelta;
      return Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0);
    })
    .slice(0, 5);
}

function renderEmptyState() {
  const container = $("emptyState");
  if (!container) return;
  container.innerHTML = "";

  const title = document.createElement("h2");
  title.textContent = state.projects.length ? "Continua una transcripcion" : "Sin proyectos todavia";
  const detail = document.createElement("p");
  detail.textContent = state.projects.length
    ? "Abre un proyecto reciente o sube un nuevo audio para empezar."
    : "Sube tu primer audio para transcribirlo y revisarlo aqui.";
  container.append(title, detail);

  const actions = document.createElement("div");
  actions.className = "empty-actions";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.textContent = "Subir audio";
  upload.addEventListener("click", () => {
    if (state.sidebarCollapsed) setSidebarCollapsed(false);
    $("fileInput")?.click();
  });
  actions.appendChild(upload);

  if (state.projects.length && state.sidebarCollapsed) {
    const showProjects = document.createElement("button");
    showProjects.type = "button";
    showProjects.className = "secondary";
    showProjects.textContent = "Ver panel";
    showProjects.addEventListener("click", () => setSidebarCollapsed(false));
    actions.appendChild(showProjects);
  }
  container.appendChild(actions);

  const suggestions = sortedProjectSuggestions();
  if (!suggestions.length) return;

  const list = document.createElement("div");
  list.className = "empty-projects";
  const listTitle = document.createElement("strong");
  listTitle.textContent = "Proyectos sugeridos";
  list.appendChild(listTitle);

  for (const project of suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "empty-project-card";
    button.addEventListener("click", () => openProject(project.id));

    const name = document.createElement("span");
    name.className = "empty-project-name";
    name.textContent = project.name || "Proyecto sin nombre";

    const meta = document.createElement("span");
    meta.className = "empty-project-meta";
    const segmentCount = projectSegmentCount(project);
    const parts = [
      projectStatusText(project.status),
      segmentCount ? `${segmentCount} segmentos` : "",
      projectUpdatedText(project),
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");

    button.append(name, meta);
    list.appendChild(button);
  }
  container.appendChild(list);
}

function renderSimpleEmptyState(titleText, detailText) {
  const container = $("emptyState");
  if (!container) return;
  container.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = titleText;
  const detail = document.createElement("p");
  detail.textContent = detailText;
  container.append(title, detail);
}

async function openProject(projectId) {
  if (state.dirty && state.current?.id && state.current.id !== projectId) {
    const confirmed = confirm("Hay cambios sin guardar. Si abres otro proyecto, se perderan.");
    if (!confirmed) return;
  }
  rememberPlaybackPosition({ immediate: true });
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
  if (state.playbackSaveTimer) {
    clearTimeout(state.playbackSaveTimer);
    state.playbackSaveTimer = null;
  }
  state.current = await api(`/api/projects/${projectId}`);
  state.playbackRestorePending = true;
  state.playbackProjectId = projectId;
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  state.activeSegmentIndex = null;
  state.segmentVirtualStart = 0;
  state.segmentVirtualEnd = 0;
  state.changeVersion = 0;
  state.autosaveQueued = false;
  clearProofreadState();
  loadSegmentUndoStack(projectId);
  const projectPreferences = applyProjectBrowserPreferences(projectId);
  renderProjects();
  renderEditor();
  if (!projectPreferences || !Object.prototype.hasOwnProperty.call(projectPreferences, "sidebarCollapsed")) {
    syncSidebarDefaultForCurrent();
  }
  setDirty(false);
  await maybeOfferDraftRestore(projectId);
}

function currentSegments() {
  return state.current?.segments || [];
}

function currentLabels() {
  if (!state.current.speaker_labels) state.current.speaker_labels = {};
  return state.current.speaker_labels;
}

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
    state.proofreadUnavailableMessage = error.message || "Corrector local no disponible.";
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
      state.proofreadUnavailableMessage = error.message || "Corrector local no disponible.";
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

function speakersFromSegments() {
  const speakers = new Set();
  for (const segment of currentSegments()) speakers.add(segment.speaker || "SPEAKER_00");
  for (const speaker of Object.keys(currentLabels())) speakers.add(speaker);
  return [...speakers].sort();
}

function segmentKey(segment, index) {
  if (!segment.id) segment.id = `seg-${index}-${Date.now()}`;
  return segment.id;
}

function selectedSegmentIndexes() {
  const indexes = [];
  currentSegments().forEach((segment, index) => {
    if (state.selectedSegmentIds.has(segmentKey(segment, index))) indexes.push(index);
  });
  return indexes;
}

function syncSelectedSegments() {
  const existing = new Set(currentSegments().map((segment, index) => segmentKey(segment, index)));
  for (const id of [...state.selectedSegmentIds]) {
    if (!existing.has(id)) state.selectedSegmentIds.delete(id);
  }
}

function setSegmentSelected(segment, index, selected) {
  const key = segmentKey(segment, index);
  if (selected) {
    state.selectedSegmentIds.add(key);
  } else {
    state.selectedSegmentIds.delete(key);
  }
}

function selectSegmentRange(fromIndex, toIndex) {
  const segments = currentSegments();
  const start = Math.max(0, Math.min(fromIndex, toIndex));
  const end = Math.min(segments.length - 1, Math.max(fromIndex, toIndex));
  for (let index = start; index <= end; index += 1) {
    state.selectedSegmentIds.add(segmentKey(segments[index], index));
  }
}

function speakerIndex(speaker, speakers = speakersFromSegments()) {
  return Math.max(0, speakers.indexOf(speaker));
}

function speakerTheme(speaker, speakers = speakersFromSegments()) {
  const palette = currentTheme() === "dark" ? SPEAKER_PALETTE_DARK : SPEAKER_PALETTE_LIGHT;
  return palette[speakerIndex(speaker, speakers) % palette.length];
}

function nextSpeakerId() {
  const used = new Set(speakersFromSegments());
  let index = 0;
  while (used.has(`SPEAKER_${String(index).padStart(2, "0")}`)) {
    index += 1;
  }
  return `SPEAKER_${String(index).padStart(2, "0")}`;
}

function speakerInitial(label) {
  const text = String(label || "").trim();
  const match = text.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/);
  return match ? match[0].toUpperCase() : "?";
}

function applySpeakerTheme(element, speaker, speakers = speakersFromSegments()) {
  const theme = speakerTheme(speaker, speakers);
  element.style.setProperty("--speaker-color", theme.color);
  element.style.setProperty("--speaker-bg", theme.bg);
  element.style.setProperty("--speaker-border", theme.border);
}

function cleanWarningText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function warningRangeFromText(text) {
  const ranges = [
    /entre\s+(\d{2}:\d{2}:\d{2})\s+y\s+(\d{2}:\d{2}:\d{2})/i,
    /entre\s+(\d{2}:\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2}:\d{2})/i,
    /(?:rango|afectado|revisar):\s*(\d{2}:\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2}:\d{2})/i,
    /(\d{2}:\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2}:\d{2})/,
  ];
  for (const pattern of ranges) {
    const match = text.match(pattern);
    if (match) {
      const start = parseClockToSeconds(match[1]);
      const end = parseClockToSeconds(match[2]);
      return {
        start,
        end,
        label: `${match[1]}-${match[2]}`,
      };
    }
  }
  const single = text.match(/(\d{2}:\d{2}:\d{2})/);
  if (!single) return null;
  const start = parseClockToSeconds(single[1]);
  return { start, end: null, label: single[1] };
}

function normalizeWarningForDisplay(warning) {
  const text = cleanWarningText(warning);
  const antiLoopLegacy = text.match(/^Filtro anti-loop de Whisper (.+)\. Primer rango afectado: ([^.]+)\.?$/);
  const antiLoopCurrent = text.match(/^Whisper corrigio repeticiones: (.+)\. Primer rango para revisar: ([^.]+)\.?$/);
  const antiLoop = antiLoopCurrent || antiLoopLegacy;
  if (antiLoop) {
    const range = antiLoop[2];
    const parsedRange = warningRangeFromText(range);
    return {
      kind: "whisper",
      severity: "medium",
      badge: "Corregido",
      title: "Whisper corrigio repeticiones",
      detail: "Se limpio texto repetido automaticamente. Revisa el punto si el texto se ve cortado o raro.",
      range: parsedRange?.label || range,
      meta: antiLoop[1],
      actionStart: parsedRange?.start ?? parseClockToSeconds(range),
    };
  }

  const noisyDiarization = text.match(/^Diarizacion ruidosa: (.+) detectados\.?$/);
  if (noisyDiarization) {
    return {
      kind: "diarization",
      severity: "low",
      badge: "Suavizado",
      title: "Separacion de hablantes suavizada",
      detail: "La app corrigio cambios breves entre hablantes. Revisa solo si ves colores alternando dentro de una misma frase.",
      meta: noisyDiarization[1],
    };
  }

  const speakerSeparation = text.match(/^Separacion de hablantes: (.+)\.?$/);
  if (speakerSeparation) {
    return {
      kind: "diarization",
      severity: "low",
      badge: "Suavizado",
      title: "Separacion de hablantes suavizada",
      detail: "Revisa cambios breves entre colores si una frase parece quedar en la persona incorrecta.",
      meta: speakerSeparation[1],
    };
  }

  const whisperReview = text.match(/^Whisper requiere revision entre (.+)$/);
  if (whisperReview) {
    const parsedRange = warningRangeFromText(whisperReview[1]);
    return {
      kind: "whisper",
      severity: "high",
      badge: "Revisar",
      title: "Whisper requiere revision",
      detail: "Hay un tramo donde Whisper no recupero texto con plena confianza.",
      range: parsedRange?.label || whisperReview[1],
      actionStart: parsedRange?.start ?? parseClockToSeconds(whisperReview[1]),
    };
  }

  const parsedRange = warningRangeFromText(text);
  const isError = /fallo|error|no recuperado|omitida|terminado/i.test(text);
  return {
    kind: "general",
    severity: isError ? "high" : "medium",
    badge: isError ? "Revisar" : "Aviso",
    title: isError ? "Aviso de proceso" : "Aviso",
    detail: text,
    range: parsedRange?.label || "",
    actionStart: parsedRange?.start ?? null,
  };
}

function renderWarnings() {
  const warnings = state.current?.warnings || [];
  const diagnosticMenu = $("reviewDiagnostics");
  const diagnosticLabel = $("reviewDiagnosticsLabel");
  if (diagnosticMenu) diagnosticMenu.classList.toggle("has-warnings", warnings.length > 0);
  if (diagnosticLabel) {
    diagnosticLabel.textContent = warnings.length
      ? `${warnings.length} aviso${warnings.length === 1 ? "" : "s"}`
      : "Diagnóstico";
  }
  const container = $("warnings");
  container.classList.toggle("hidden", warnings.length === 0);
  container.innerHTML = "";
  if (!warnings.length) return;
  for (const warning of warnings) {
    const view = normalizeWarningForDisplay(warning);
    const item = document.createElement("div");
    item.className = `warning-item warning-${view.kind} warning-${view.severity || "medium"}`;
    const main = document.createElement("div");
    main.className = "warning-main";
    const heading = document.createElement("div");
    heading.className = "warning-heading";
    const badge = document.createElement("span");
    badge.className = "warning-severity";
    badge.textContent = view.badge || "Aviso";
    const title = document.createElement("strong");
    title.textContent = view.title;
    heading.append(badge, title);
    if (view.range) {
      const range = document.createElement("span");
      range.className = "warning-range";
      range.textContent = view.range;
      heading.appendChild(range);
    }
    main.appendChild(heading);
    if (Number.isFinite(view.actionStart)) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "secondary warning-action";
      action.textContent = "Escuchar";
      action.addEventListener("click", () => playSegment(view.actionStart));
      main.appendChild(action);
    }
    const detail = document.createElement("span");
    detail.textContent = view.detail;
    item.append(main, detail);
    if (view.meta) {
      const meta = document.createElement("small");
      meta.textContent = view.meta;
      item.appendChild(meta);
    }
    container.appendChild(item);
  }
}

function renderEditor() {
  if (state.current && ["queued", "processing", "paused", "cancelled", "error"].includes(state.current.status)) {
    $("emptyState").classList.add("hidden");
    $("editor").classList.add("hidden");
    $("loadingState").classList.remove("hidden");
    renderSegmentUndoToast();
    renderLoading();
    return;
  }

  if (!state.current || state.current.status !== "done") {
    $("emptyState").classList.remove("hidden");
    $("loadingState").classList.add("hidden");
    $("editor").classList.add("hidden");
    if (state.current?.status === "error") {
      renderSimpleEmptyState("Error", state.current.error || "No se pudo procesar.");
    } else if (state.current) {
      renderSimpleEmptyState(state.current.name || "Proyecto", `Estado: ${state.current.status || "sin estado"}`);
    } else {
      renderEmptyState();
    }
    renderSegmentUndoToast();
    return;
  }

  $("emptyState").classList.add("hidden");
  $("loadingState").classList.add("hidden");
  $("editor").classList.remove("hidden");
  $("projectName").value = state.current.name;
  const audioPlayer = $("audioPlayer");
  const hasAudio = projectHasAudio(state.current);
  $("audioStickyBar")?.classList.toggle("hidden", !hasAudio);
  if (!hasAudio) {
    audioPlayer.pause();
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
    state.playbackRestorePending = false;
    state.playbackProjectId = null;
  } else {
    const audioUrl = audioSrcForProject(state.current.id);
    if (audioPlayer.src !== absoluteAudioSrc(state.current.id)) {
      audioPlayer.pause();
      audioPlayer.src = audioUrl;
      state.playbackRestorePending = true;
      state.playbackProjectId = state.current.id;
    }
  }
  $("exportTxt").href = `/api/projects/${state.current.id}/export/txt`;
  $("exportDocx").href = `/api/projects/${state.current.id}/export/docx`;
  $("exportDocxTs").href = `/api/projects/${state.current.id}/export/docx-ts`;
  $("exportSrt").href = `/api/projects/${state.current.id}/export/srt`;
  $("exportVtt").href = `/api/projects/${state.current.id}/export/vtt`;
  $("exportJson").href = `/api/projects/${state.current.id}/export/json`;
  $("exportPackage").href = `/api/projects/${state.current.id}/export/package`;
  $("exportPackageLite").href = `/api/projects/${state.current.id}/export/package-lite`;
  const relabelButton = $("relabelProjectBtn");
  if (relabelButton) relabelButton.disabled = !(state.current.diarization_turns || []).length;

  renderWarnings();

  loadProjectLog(state.current.id);
  renderSpeakerLabels();
  renderSegments();
  renderSegmentUndoToast();
  if (hasAudio) {
    restorePlaybackPositionIfNeeded();
    updateStickyAudioControls();
  }
}

function renderLoading() {
  $("emptyState").classList.add("hidden");
  $("editor").classList.add("hidden");
  $("loadingState").classList.remove("hidden");

  const project = state.current || {};
  const job = state.currentJob || {
    status: project.status || "queued",
    step: project.status || "Preparando",
    progress: project.status === "cancelled" ? 100 : 0,
  };
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const active = isJobActive(job);
  const resumable = RESUMABLE_STATUSES.has(job.status || project.status);
  const status = job.status || project.status;

  $("loadingPercent").textContent = `${Math.round(progress)}%`;
  $("loadingBar").style.width = `${progress}%`;
  $("loadingDetail").textContent = job.error || job.step || "Preparando archivo...";
  if (job.started_at) {
    $("loadingMeta").textContent = jobProgressMeta(job);
  } else {
    $("loadingMeta").textContent = "Tiempo transcurrido: 00:00";
  }
  $("loadingBadge").textContent = project.name || "Proyecto";
  if (project.id) loadProjectLog(project.id);

  if (status === "paused") {
    $("loadingTitle").textContent = "Transcripcion pausada";
    $("loadingDetail").textContent = "Puedes reanudar el procesamiento cuando quieras.";
  } else if (status === "cancelled") {
    $("loadingTitle").textContent = "Transcripcion cancelada";
    $("loadingDetail").textContent = "El proyecto se conserva. Puedes reintentarlo si lo necesitas.";
  } else if (status === "error") {
    $("loadingTitle").textContent = "Error";
    $("loadingDetail").textContent = job.error || project.error || "No se pudo procesar el archivo.";
  } else if (status === "pausing") {
    $("loadingTitle").textContent = "Pausando proceso";
  } else if (status === "cancelling") {
    $("loadingTitle").textContent = "Cancelando proceso";
  } else {
    $("loadingTitle").textContent = job.step || "Transcribiendo con Whisper";
  }

  $("pauseJobBtn").classList.toggle("hidden", !active);
  $("pauseJobBtn").disabled = status === "pausing" || status === "cancelling";
  $("cancelJobBtn").classList.toggle("hidden", !active);
  $("cancelJobBtn").disabled = status === "pausing" || status === "cancelling";
  $("resumeJobBtn").classList.toggle("hidden", !resumable);
  $("resumeJobBtn").textContent = status === "cancelled" ? "Reintentar" : "Reanudar";
  $("deleteLoadingProjectBtn").classList.toggle("hidden", active);
  setTranscribeBusy(active);
  if (active) {
    startElapsedTimer();
  } else {
    stopElapsedTimer();
  }
}

function renderSpeakerLabels() {
  const labels = currentLabels();
  const container = $("speakerLabels");
  container.innerHTML = "";
  const speakers = speakersFromSegments();
  for (const speaker of speakers) {
    if (!labels[speaker]) labels[speaker] = speaker;
    const label = document.createElement("label");
    label.className = "speaker-label-field";
    applySpeakerTheme(label, speaker, speakers);

    const title = document.createElement("span");
    title.className = "speaker-label-title";

    const badge = document.createElement("span");
    badge.className = "speaker-badge";
    badge.textContent = speakerInitial(labels[speaker]);

    const code = document.createElement("span");
    code.textContent = speaker;

    title.append(badge, code);

    const input = document.createElement("input");
    input.value = labels[speaker];
    input.addEventListener("input", () => {
      labels[speaker] = input.value;
      badge.textContent = speakerInitial(input.value);
      renderSpeakerSummary();
      markDirty();
    });
    input.addEventListener("change", () => {
      renderSegments();
    });
    label.append(title, input);
    container.appendChild(label);
  }
  renderSpeakerSummary();
  applySpeakersPanelState();
}

function renderSpeakerSummary() {
  const summary = $("speakerSummaryText");
  if (!summary) return;
  if (!state.current || state.current.status !== "done") {
    summary.textContent = "Sin hablantes";
    return;
  }
  const speakers = speakersFromSegments();
  if (!speakers.length) {
    summary.textContent = "Sin hablantes";
    return;
  }
  const labels = currentLabels();
  const names = speakers.map((speaker) => labels[speaker] || speaker).slice(0, 3);
  const extra = speakers.length > names.length ? ` +${speakers.length - names.length}` : "";
  summary.textContent = `${speakers.length} hablante${speakers.length === 1 ? "" : "s"} · ${names.join(", ")}${extra}`;
}

function addManualSpeaker() {
  if (!state.current || state.current.status !== "done") return;
  const speaker = nextSpeakerId();
  const labels = currentLabels();
  const fallback = `Persona ${speakersFromSegments().length + 1}`;
  const name = prompt("Nombre del nuevo hablante:", fallback);
  if (name === null) return;
  labels[speaker] = name.trim() || fallback;
  markDirty();
  renderSpeakerLabels();
  renderSegments();
}

function segmentVirtualizationEnabled(total = currentSegments().length) {
  return total > SEGMENT_VIRTUALIZATION_THRESHOLD;
}

function clampSegmentWindow(start, end, total) {
  if (total <= 0) return { start: 0, end: 0 };
  const size = Math.max(1, Math.ceil(end) - Math.floor(start));
  let boundedStart = Math.floor(start);
  let boundedEnd = Math.ceil(end);
  if (boundedStart < 0) {
    boundedEnd = Math.min(total, boundedEnd - boundedStart);
    boundedStart = 0;
  }
  if (boundedEnd > total) {
    boundedEnd = total;
    boundedStart = Math.max(0, boundedEnd - size);
  }
  boundedStart = Math.max(0, Math.min(total, boundedStart));
  boundedEnd = Math.max(boundedStart, Math.min(total, boundedEnd));
  return { start: boundedStart, end: boundedEnd };
}

function segmentVirtualWindow(total, options = {}) {
  if (!segmentVirtualizationEnabled(total)) return { start: 0, end: total, top: 0, bottom: 0, virtual: false };
  const height = Math.max(SEGMENT_VIRTUAL_MIN_HEIGHT, Number(state.segmentVirtualHeight) || 108);
  const visibleCount = Math.ceil(window.innerHeight / height);
  let start;
  let end;

  if (Number.isInteger(options.forceIndex)) {
    const windowSize = Math.max(visibleCount + SEGMENT_VIRTUAL_OVERSCAN * 2, SEGMENT_VIRTUAL_OVERSCAN * 3);
    start = options.forceIndex - Math.floor(windowSize / 2);
    end = start + windowSize;
  } else {
    const container = $("segments");
    const containerTop = container ? window.scrollY + container.getBoundingClientRect().top : 0;
    const viewportTop = Math.max(0, window.scrollY - containerTop);
    const viewportBottom = viewportTop + window.innerHeight;
    start = Math.floor(viewportTop / height) - SEGMENT_VIRTUAL_OVERSCAN;
    end = Math.ceil(viewportBottom / height) + SEGMENT_VIRTUAL_OVERSCAN;
  }

  const windowed = clampSegmentWindow(start, end, total);
  return {
    ...windowed,
    top: windowed.start * height,
    bottom: Math.max(0, (total - windowed.end) * height),
    virtual: true,
  };
}

function createSegmentVirtualSpacer(height) {
  const spacer = document.createElement("div");
  spacer.className = "segment-virtual-spacer";
  spacer.style.height = `${Math.max(0, Math.round(height))}px`;
  return spacer;
}

function updateSegmentVirtualHeight(container) {
  const rows = Array.from(container.querySelectorAll(".segment")).slice(0, 12);
  if (!rows.length) return;
  const values = rows
    .map((row) => row.getBoundingClientRect().height + 8)
    .filter((value) => Number.isFinite(value) && value >= SEGMENT_VIRTUAL_MIN_HEIGHT && value <= SEGMENT_VIRTUAL_MAX_HEIGHT);
  if (!values.length) return;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  state.segmentVirtualHeight = Math.round((state.segmentVirtualHeight * 0.72) + (average * 0.28));
}

function createSegmentRow(segment, index, speakers) {
  const currentSpeaker = segment.speaker || "SPEAKER_00";
  const key = segmentKey(segment, index);
  const row = document.createElement("article");
  row.className = `segment${state.selectedSegmentIds.has(key) ? " selected" : ""}${segment.needs_review ? " needs-review" : ""}`;
  row.dataset.segmentIndex = String(index);
  row.dataset.proofreadKey = key;

  const selectionCell = document.createElement("div");
  selectionCell.className = "segment-select-cell";
  const selection = document.createElement("input");
  selection.type = "checkbox";
  selection.className = "segment-check";
  selection.checked = state.selectedSegmentIds.has(key);
  selection.title = "Seleccionar segmento";
  selection.addEventListener("click", (event) => {
    if (event.shiftKey && Number.isInteger(state.lastSelectedSegmentIndex)) {
      selectSegmentRange(state.lastSelectedSegmentIndex, index);
    } else {
      setSegmentSelected(segment, index, selection.checked);
    }
    state.lastSelectedSegmentIndex = index;
    renderSegments();
  });
  selectionCell.appendChild(selection);

  const time = document.createElement("div");
  time.className = "time";
  time.title = segment.needs_review
    ? "Este rango requiere revision manual. Doble clic para escuchar desde este punto"
    : "Doble clic para escuchar desde este punto";
  time.addEventListener("dblclick", () => playSegment(segment.start));
  const timeMark = document.createElement("span");
  timeMark.className = "time-mark";
  const timeText = document.createElement("span");
  timeText.textContent = `${fmtTime(segment.start)} - ${fmtTime(segment.end)}`;
  time.append(timeMark, timeText);
  if (segment.needs_review) {
    const reviewBadge = document.createElement("span");
    reviewBadge.className = "review-segment-badge";
    reviewBadge.textContent = "Revisar";
    time.appendChild(reviewBadge);
  }

  const speakerCell = document.createElement("div");
  speakerCell.className = "speaker-cell";
  applySpeakerTheme(row, currentSpeaker, speakers);
  applySpeakerTheme(speakerCell, currentSpeaker, speakers);

  const speakerBadge = document.createElement("span");
  speakerBadge.className = "speaker-badge";
  speakerBadge.textContent = speakerInitial(currentLabels()[currentSpeaker] || currentSpeaker);

  const speaker = document.createElement("select");
  speaker.className = "speaker-select";
  for (const item of speakers) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = currentLabels()[item] || item;
    if (item === currentSpeaker) option.selected = true;
    speaker.appendChild(option);
  }
  speaker.addEventListener("change", () => {
    segment.speaker = speaker.value;
    const label = currentLabels()[segment.speaker] || segment.speaker;
    speakerBadge.textContent = speakerInitial(label);
    applySpeakerTheme(row, segment.speaker, speakers);
    applySpeakerTheme(speakerCell, segment.speaker, speakers);
    markDirty();
  });
  speakerCell.append(speakerBadge, speaker);

  const text = document.createElement("textarea");
  enableSpanishProofing(text);
  text.value = segment.text || "";
  text.addEventListener("focus", () => {
    queueProofreadSegment(index, key);
  });
  text.addEventListener("input", () => {
    segment.text = text.value;
    delete state.proofreadResults[key];
    renderProofreadPanel(proofreadPanel, key, index);
    markDirty();
    scheduleProofreadSegment(index, key);
  });

  const textWrap = document.createElement("div");
  textWrap.className = "segment-text-wrap";
  const proofreadPanel = document.createElement("div");
  proofreadPanel.className = "proofread-panel hidden";
  proofreadPanel.dataset.proofreadKey = key;
  textWrap.append(text, proofreadPanel);
  renderProofreadPanel(proofreadPanel, key, index);

  const tools = document.createElement("div");
  tools.className = "segment-tools";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "segment-play icon-button";
  play.textContent = "▶";
  play.title = "Reproducir segmento";
  play.setAttribute("aria-label", "Reproducir segmento");
  play.addEventListener("click", () => playSegment(segment.start));
  const split = document.createElement("button");
  split.type = "button";
  split.className = "secondary";
  split.textContent = "Dividir";
  split.addEventListener("click", () => splitSegment(index, text.selectionStart, text.selectionEnd));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Borrar";
  remove.addEventListener("click", () => {
    deleteSegment(index).catch((error) => showError(error));
  });
  tools.append(play, split, remove);

  row.append(selectionCell, time, speakerCell, textWrap, tools);
  return row;
}

function renderSegments(options = {}) {
  const container = $("segments");
  if (!container) return;
  syncSelectedSegments();
  const segments = currentSegments();
  const windowed = segmentVirtualWindow(segments.length, options);
  const sameWindow =
    options.force === false &&
    Number(container.dataset.virtualStart) === windowed.start &&
    Number(container.dataset.virtualEnd) === windowed.end &&
    container.dataset.virtualTotal === String(segments.length);
  if (sameWindow) return;

  container.innerHTML = "";
  container.dataset.virtualStart = String(windowed.start);
  container.dataset.virtualEnd = String(windowed.end);
  container.dataset.virtualTotal = String(segments.length);
  state.segmentVirtualStart = windowed.start;
  state.segmentVirtualEnd = windowed.end;

  if (windowed.virtual && windowed.top > 0) container.appendChild(createSegmentVirtualSpacer(windowed.top));
  const speakers = speakersFromSegments();
  for (let index = windowed.start; index < windowed.end; index += 1) {
    const segment = segments[index];
    if (segment) container.appendChild(createSegmentRow(segment, index, speakers));
  }
  if (windowed.virtual && windowed.bottom > 0) container.appendChild(createSegmentVirtualSpacer(windowed.bottom));

  updateSegmentVirtualHeight(container);
  renderSegmentSelectionBar();
  updateActiveSegmentFromAudio();
  observeProofreadSegments();
}

function playSegment(start) {
  if (!projectHasAudio()) {
    alert("Este proyecto fue importado sin audio.");
    return;
  }
  const player = $("audioPlayer");
  player.currentTime = Number(start) || 0;
  rememberPlaybackPosition({ immediate: true });
  player.play();
  updateActiveSegmentFromAudio({ scroll: true });
  updateStickyAudioControls();
}

function audioDurationValue(player = $("audioPlayer")) {
  const duration = Number(player?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function clampAudioTime(value, player = $("audioPlayer")) {
  const duration = audioDurationValue(player);
  const upper = duration || Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(upper, Number(value) || 0));
}

function seekAudioBy(deltaSeconds) {
  const player = $("audioPlayer");
  if (!player) return;
  player.currentTime = clampAudioTime((Number(player.currentTime) || 0) + deltaSeconds, player);
  rememberPlaybackPosition({ immediate: true });
  updateActiveSegmentFromAudio({ scroll: state.audioFollow });
  updateStickyAudioControls();
}

function toggleAudioPlayback() {
  const player = $("audioPlayer");
  if (!player) return;
  if (player.paused) {
    player.play();
  } else {
    player.pause();
  }
  updateStickyAudioControls();
}

function updateStickyAudioControls() {
  const player = $("audioPlayer");
  if (!player) return;
  const duration = audioDurationValue(player);
  const current = clampAudioTime(player.currentTime || 0, player);
  const playPause = $("audioPlayPauseBtn");
  if (playPause) {
    const label = player.paused ? "Reproducir" : "Pausar";
    playPause.textContent = player.paused ? "▶" : "⏸";
    playPause.title = label;
    playPause.setAttribute("aria-label", label);
  }
  const currentLabel = $("audioCurrentTime");
  if (currentLabel) currentLabel.textContent = fmtTime(current);
  const durationLabel = $("audioDuration");
  if (durationLabel) durationLabel.textContent = duration ? fmtTime(duration) : "00:00:00";
  const seek = $("audioSeek");
  if (seek && !state.audioSeekDragging) {
    seek.value = duration ? String(Math.round((current / duration) * 1000)) : "0";
  }
  applyAudioVolume();
  const follow = $("audioFollowBtn");
  if (follow) {
    follow.textContent = state.audioFollow ? "Siguiendo" : "Seguir";
    follow.classList.toggle("active", state.audioFollow);
    follow.title = state.audioFollow ? "Desactivar seguimiento automatico" : "Seguir segmento actual";
  }
  for (const id of ["audioBack30Btn", "audioBack5Btn", "audioPlayPauseBtn", "audioForward5Btn", "audioForward30Btn", "audioSeek", "audioFollowBtn", "audioVolumeBtn", "audioVolume", "audioMuteBtn"]) {
    const element = $(id);
    if (element) element.disabled = !state.current || state.current.status !== "done";
  }
}

function seekAudioFromRange(options = {}) {
  const player = $("audioPlayer");
  const seek = $("audioSeek");
  if (!player || !seek) return;
  const duration = audioDurationValue(player);
  if (!duration) return;
  player.currentTime = clampAudioTime((Number(seek.value) / 1000) * duration, player);
  rememberPlaybackPosition();
  updateActiveSegmentFromAudio({ scroll: Boolean(options.scroll) });
  updateStickyAudioControls();
}

function findActiveSegmentIndex(seconds) {
  const time = Number(seconds);
  if (!Number.isFinite(time)) return null;
  let nearestPrevious = null;
  const segments = currentSegments();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const start = Number(segment.start) || 0;
    const end = Math.max(start, Number(segment.end) || start);
    if (time >= start && time <= end + 0.08) return index;
    if (time > end) {
      nearestPrevious = { index, distance: time - end };
      continue;
    }
    if (time < start) break;
  }
  return nearestPrevious && nearestPrevious.distance <= 0.5 ? nearestPrevious.index : null;
}

function segmentRowForIndex(index) {
  if (!Number.isInteger(index)) return null;
  return document.querySelector(`[data-segment-index="${index}"]`);
}

function ensureSegmentRendered(index) {
  if (!Number.isInteger(index)) return null;
  let row = segmentRowForIndex(index);
  if (row) return row;
  if (!segmentVirtualizationEnabled()) return null;
  renderSegments({ forceIndex: index });
  row = segmentRowForIndex(index);
  return row;
}

function scheduleSegmentWindowRender() {
  if (!state.current || state.current.status !== "done" || !segmentVirtualizationEnabled()) return;
  const focusedRow = document.activeElement?.closest?.(".segment");
  if (focusedRow && isRowVisible(focusedRow)) return;
  if (state.segmentVirtualRenderFrame) return;
  state.segmentVirtualRenderFrame = window.requestAnimationFrame(() => {
    state.segmentVirtualRenderFrame = null;
    renderSegments({ force: false });
  });
}

function isRowVisible(row) {
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  const topLimit = 92;
  const bottomLimit = window.innerHeight - 92;
  return rect.bottom > topLimit && rect.top < bottomLimit;
}

function isSegmentIndexVisible(index) {
  const row = segmentRowForIndex(index);
  if (row) return isRowVisible(row);
  if (!Number.isInteger(index) || !segmentVirtualizationEnabled()) return false;
  const container = $("segments");
  if (!container) return false;
  const containerTop = window.scrollY + container.getBoundingClientRect().top;
  const estimatedTop = containerTop + (index * Math.max(SEGMENT_VIRTUAL_MIN_HEIGHT, state.segmentVirtualHeight));
  const estimatedBottom = estimatedTop + Math.max(SEGMENT_VIRTUAL_MIN_HEIGHT, state.segmentVirtualHeight);
  const viewportTop = window.scrollY + 92;
  const viewportBottom = window.scrollY + window.innerHeight - 92;
  return estimatedBottom > viewportTop && estimatedTop < viewportBottom;
}

function isEditingTranscriptField() {
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest("textarea, input, select"));
}

function isInteractiveControlFocused() {
  const active = document.activeElement;
  return Boolean(active && active.closest && active.closest("textarea, input, select, button, a"));
}

function setAudioFollow(enabled, options = {}) {
  state.audioFollow = Boolean(enabled);
  updateStickyAudioControls();
  updateReturnToAudioButton();
  if (state.audioFollow && options.scroll !== false) scrollToActiveAudioSegment();
}

function pauseAudioFollowFromUser() {
  if (!state.audioFollow || !state.current || state.current.status !== "done") return;
  if (Date.now() < state.programmaticScrollUntil) return;
  const player = $("audioPlayer");
  if (!player || player.paused) return;
  setAudioFollow(false, { scroll: false });
}

function updateReturnToAudioButton() {
  const button = $("returnToAudioBtn");
  if (!button) return;
  const shouldShow = Boolean(Number.isInteger(state.activeSegmentIndex) && !isSegmentIndexVisible(state.activeSegmentIndex));
  button.classList.toggle("hidden", !shouldShow);
  if (shouldShow) {
    const segment = currentSegments()[state.activeSegmentIndex];
    button.textContent = `Volver al audio ${fmtTime(segment?.start || 0)}`;
  }
}

function scrollToActiveAudioSegment() {
  const row = ensureSegmentRendered(state.activeSegmentIndex);
  if (!row) return;
  state.programmaticScrollUntil = Date.now() + 900;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(updateReturnToAudioButton, 280);
}

function updateActiveSegmentFromAudio(options = {}) {
  const player = $("audioPlayer");
  if (!player || !state.current || state.current.status !== "done") {
    const previousRow = segmentRowForIndex(state.activeSegmentIndex);
    if (previousRow) previousRow.classList.remove("current-audio", "audio-playing");
    state.activeSegmentIndex = null;
    updateReturnToAudioButton();
    return;
  }

  const nextIndex = findActiveSegmentIndex(player.currentTime);
  const changed = nextIndex !== state.activeSegmentIndex;
  if (changed) {
    const previousRow = segmentRowForIndex(state.activeSegmentIndex);
    if (previousRow) previousRow.classList.remove("current-audio", "audio-playing");
    state.activeSegmentIndex = nextIndex;
  }
  const shouldFollow =
    changed &&
    state.audioFollow &&
    !player.paused &&
    !isEditingTranscriptField();
  const currentRow = options.scroll || shouldFollow ? ensureSegmentRendered(state.activeSegmentIndex) : segmentRowForIndex(state.activeSegmentIndex);
  if (currentRow) {
    currentRow.classList.add("current-audio");
    currentRow.classList.toggle("audio-playing", !player.paused && !player.ended);
  }
  if (options.scroll || shouldFollow) scrollToActiveAudioSegment();
  updateReturnToAudioButton();
}

function splitSegment(index, cursor, selectionEnd = cursor) {
  const segments = currentSegments();
  const segment = segments[index];
  const text = segment.text || "";
  const point = Number(cursor);
  if (!Number.isFinite(point) || point <= 0 || point >= text.length || point !== selectionEnd) {
    alert("Pon el cursor en el punto exacto del texto donde quieres dividir.");
    return;
  }
  const first = text.slice(0, point).trim();
  const second = text.slice(point).trim();
  if (!first || !second) return;
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || start;
  const ratio = first.length / Math.max(1, first.length + second.length);
  const middle = start + (end - start) * ratio;
  segment.text = first;
  segment.end = Number(middle.toFixed(3));
  const copy = {
    ...segment,
    id: `seg-${Date.now()}`,
    start: Number(middle.toFixed(3)),
    text: second,
  };
  segments.splice(index + 1, 0, copy);
  state.selectedSegmentIds.clear();
  markDirty();
  renderSegments();
}

function renderSegmentSelectionBar() {
  const count = state.selectedSegmentIds.size;
  const bar = $("segmentSelectionBar");
  if (bar) bar.classList.toggle("hidden", count === 0);
  const countLabel = $("selectedSegmentsCount");
  if (!countLabel) return;
  countLabel.textContent = `${count} seleccionado${count === 1 ? "" : "s"}`;
  $("mergeSelectedBtn").disabled = count < 2;
  $("deleteSelectedBtn").disabled = count < 1;
  $("clearSelectionBtn").disabled = count < 1;
}

function mergeSelectedSegments() {
  const segments = currentSegments();
  const indexes = selectedSegmentIndexes();
  if (indexes.length < 2) return;
  const consecutive = indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1);
  if (!consecutive) {
    alert("Selecciona segmentos consecutivos para unir.");
    return;
  }
  const selected = indexes.map((index) => segments[index]);
  const speakers = new Set(selected.map((segment) => segment.speaker || "SPEAKER_00"));
  if (speakers.size > 1 && !confirm("Los segmentos seleccionados tienen hablantes distintos. Se conservara el hablante del primer segmento.")) {
    return;
  }
  const first = selected[0];
  const last = selected[selected.length - 1];
  const merged = {
    ...first,
    end: last.end,
    text: selected.map((segment) => segment.text || "").join(" ").replace(/\s+/g, " ").trim(),
  };
  segments.splice(indexes[0], indexes.length, merged);
  state.selectedSegmentIds.clear();
  state.selectedSegmentIds.add(segmentKey(merged, indexes[0]));
  markDirty();
  renderSegments();
}

async function deleteSegment(index) {
  const confirmed = await confirmDeleteSegment(index);
  if (!confirmed) return;
  const segment = currentSegments()[index];
  if (!segment) return;
  pushSegmentUndo([{ index, segment }], "delete-one");
  if (segment) state.selectedSegmentIds.delete(segmentKey(segment, index));
  currentSegments().splice(index, 1);
  markDirty();
  renderSegments();
}

function deleteSelectedSegments() {
  const indexes = selectedSegmentIndexes();
  if (!indexes.length) return;
  if (!confirm(`Borrar ${indexes.length} segmento${indexes.length === 1 ? "" : "s"} seleccionado${indexes.length === 1 ? "" : "s"}?`)) return;
  const segments = currentSegments();
  pushSegmentUndo(indexes.map((index) => ({ index, segment: segments[index] })).filter((item) => item.segment), "delete-selected");
  for (const index of indexes.slice().reverse()) {
    segments.splice(index, 1);
  }
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  markDirty();
  renderSegments();
}

function clearSegmentSelection() {
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  renderSegments();
}

async function saveEdits(options = {}) {
  if (!state.current) return;
  const projectId = state.current.id;
  const silent = Boolean(options.silent);
  const retryingAfterFailure = Boolean(options.retryingAfterFailure);
  if (state.saveBlocked && !retryingAfterFailure) return;
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
  if (state.autosaveInFlight) {
    state.autosaveQueued = true;
    return;
  }
  state.autosaveInFlight = true;
  const version = state.changeVersion;
  const saveState = $("saveState");
  if (saveState) {
    saveState.textContent = silent ? "Guardando automaticamente..." : "Guardando...";
    saveState.classList.remove("dirty");
  }
  const name = $("projectName")?.value || state.current.name || "";
  const baseContentRevision = Number(state.current.content_revision) || 0;
  try {
    const updatedProject = await api(`/api/projects/${state.current.id}/segments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        segments: currentSegments(),
        speaker_labels: currentLabels(),
        base_content_revision: baseContentRevision,
      }),
    });
    if (state.current?.id === projectId) {
      state.current.content_revision = Number(updatedProject.content_revision) || baseContentRevision + 1;
      state.current.updated_at = updatedProject.updated_at;
      if (state.changeVersion === version) {
        state.current.name = updatedProject.name || name;
      }
    }
    if (state.changeVersion === version) {
      setDirty(false);
      if (saveState) saveState.textContent = silent ? "Guardado automatico" : "Guardado";
    } else {
      setDirty(true);
      if (saveState) {
        saveState.textContent = "Cambios pendientes";
        saveState.classList.add("dirty");
      }
      scheduleAutosave(500);
    }
    if (!state.dirty) {
      clearUnsavedDraft(projectId);
      clearSaveFailure();
    }
    if (!silent) await loadProjects();
    setTimeout(() => {
      if (!state.dirty && saveState) saveState.textContent = "";
    }, 1600);
  } catch (error) {
    setDirty(true);
    if (saveState) {
      saveState.textContent = `No se pudo guardar: ${error.message}`;
      saveState.classList.add("dirty");
    }
    if (error?.status === 409) showSaveConflict(error);
    else showSaveFailure(error, silent ? "Guardado automatico" : "Guardado manual");
    throw error;
  } finally {
    state.autosaveInFlight = false;
    if (state.autosaveQueued) {
      state.autosaveQueued = false;
      if (!state.saveBlocked) scheduleAutosave(250);
    }
  }
}

async function uploadFile(event) {
  event.preventDefault();
  if (isJobActive()) return;
  const saved = await saveDirtyBeforeContinuing("Hay cambios sin guardar antes de subir otro audio.");
  if (!saved) return;
  const file = $("fileInput").files[0];
  if (!file) return;
  setTranscribeBusy(true);
  const data = new FormData();
  data.append("file", file);
  data.append("model", $("modelSelect").value || "auto");
  data.append("profile", $("profileSelect")?.value || "calidad");
  data.append("diarize", $("diarizeInput").checked ? "true" : "false");
  data.append("speakers", $("speakersSelect").value || "2");
  try {
    setDirty(false);
    const result = await api("/api/projects", { method: "POST", body: data });
    $("jobBox").classList.remove("hidden");
    state.activeJobId = result.id;
    state.currentJob = { status: "queued", step: "En cola", progress: 0, started_at: Date.now() };
    await openProject(result.id);
    pollJob(result.id);
  } catch (error) {
    setTranscribeBusy(false);
    throw error;
  }
}

async function importPackage(event) {
  event.preventDefault();
  const saved = await saveDirtyBeforeContinuing("Hay cambios sin guardar antes de importar otro proyecto.");
  if (!saved) return;
  await inspectSelectedPackage();
}

function formatPackageBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function formatPackageDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleString();
}

async function inspectSelectedPackage() {
  const input = $("packageInput");
  const status = $("importPackageStatus");
  const button = $("importPackageBtn");
  const file = input?.files?.[0];
  if (!file) {
    if (status) status.textContent = "Selecciona un paquete.";
    return;
  }
  const data = new FormData();
  data.append("file", file);
  if (button) button.disabled = true;
  if (status) {
    status.textContent = "Revisando paquete...";
    status.classList.remove("bad", "ok");
  }
  try {
    const result = await api("/api/import/package/inspect", { method: "POST", body: data });
    state.pendingImportPreview = result;
    showImportPreviewModal(result);
    if (status) status.textContent = "Listo para importar.";
  } catch (error) {
    if (status) {
      status.textContent = error.message || "No se pudo revisar.";
      status.classList.add("bad");
    }
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function showImportPreviewModal(result) {
  const overlay = $("importPreviewOverlay");
  const text = $("importPreviewText");
  const meta = $("importPreviewMeta");
  const confirmBtn = $("confirmImportPreviewBtn");
  const copyBtn = $("copyImportPreviewBtn");
  const openBtn = $("openExistingImportPreviewBtn");
  const pkg = result.package || {};
  const existing = result.existing || {};
  if (!overlay) {
    const ok = confirm(`Importar "${pkg.name || "transcripcion"}" con ${pkg.segments || 0} segmentos?`);
    if (ok) importSelectedPackage(result.duplicate ? "copy" : "ask").catch((error) => showError(error));
    return;
  }
  if (text) {
    text.textContent = result.duplicate
      ? `Este paquete ya existe como "${existing.name || "proyecto existente"}". Puedes abrirlo o importar otra copia.`
      : "El paquete se puede importar como proyecto local para revisar y corregir.";
  }
  if (meta) {
    const rows = [
      ["Nombre", pkg.name || "Sin nombre"],
      ["Segmentos", `${Number(pkg.segments) || 0}`],
      ["Hablantes", `${Number(pkg.speakers) || 0}`],
      ["Separacion de hablantes", pkg.has_diarization ? "Incluida" : "No incluida"],
      ["Audio", pkg.has_audio ? `${pkg.audio_name || "Incluido"}${pkg.audio_bytes ? ` (${formatPackageBytes(pkg.audio_bytes)})` : ""}` : "No incluido"],
      ["Preferencias", pkg.has_browser_settings ? "Incluidas" : "No incluidas"],
      ["Fecha", formatPackageDate(pkg.updated_at || pkg.created_at) || "Sin fecha"],
    ];
    if (result.duplicate) {
      rows.push(["Ya existe", `${existing.name || "Proyecto existente"}${existing.segments ? ` · ${existing.segments} segmentos` : ""}`]);
    }
    meta.innerHTML = "";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = label;
      const content = document.createElement("span");
      content.textContent = value;
      row.append(name, content);
      meta.appendChild(row);
    }
  }
  if (confirmBtn) {
    confirmBtn.classList.toggle("hidden", Boolean(result.duplicate));
    confirmBtn.textContent = "Importar";
  }
  if (copyBtn) copyBtn.classList.toggle("hidden", !result.duplicate);
  if (openBtn) openBtn.classList.toggle("hidden", !result.duplicate || !existing.id);
  overlay.classList.remove("hidden");
}

function hideImportPreviewModal() {
  $("importPreviewOverlay")?.classList.add("hidden");
  state.pendingImportPreview = null;
}

async function confirmImportPreview(mode = "ask") {
  hideImportPreviewModal();
  await importSelectedPackage(mode);
}

async function importSelectedPackage(duplicateMode = "ask") {
  const input = $("packageInput");
  const status = $("importPackageStatus");
  const button = $("importPackageBtn");
  const file = input?.files?.[0];
  if (!file) {
    if (status) status.textContent = "Selecciona un paquete.";
    return;
  }
  const data = new FormData();
  data.append("file", file);
  data.append("duplicate_mode", duplicateMode);
  if (button) button.disabled = true;
  if (status) {
    status.textContent = duplicateMode === "copy" ? "Importando copia..." : "Revisando paquete...";
    status.classList.remove("bad", "ok");
  }
  try {
    const result = await api("/api/import/package", { method: "POST", body: data });
    if (result.duplicate) {
      state.pendingDuplicateImport = result;
      showDuplicateImportModal(result);
      if (status) status.textContent = "Paquete ya importado.";
      return;
    }
    const storedSettings = writeProjectBrowserPreferences(result.id, result.browser_settings);
    if (input) input.value = "";
    if (status) {
      status.textContent = storedSettings ? "Importado con preferencias" : "Importado";
      status.classList.add("ok");
    }
    await loadProjects();
    await openProject(result.id);
  } catch (error) {
    if (status) {
      status.textContent = error.message || "No se pudo importar.";
      status.classList.add("bad");
    }
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function showDuplicateImportModal(result) {
  const overlay = $("duplicateImportOverlay");
  const text = $("duplicateImportText");
  const meta = $("duplicateImportMeta");
  const existing = result.existing || {};
  const incoming = result.package || {};
  if (!overlay) {
    const openExisting = confirm(`El paquete ya existe como "${existing.name || "proyecto existente"}".\n\nAceptar: abrir existente.\nCancelar: no importar.`);
    if (openExisting && existing.id) openProject(existing.id).catch((error) => showError(error));
    return;
  }
  if (text) {
    text.textContent = `Ya existe como "${existing.name || "proyecto existente"}". Puedes abrirlo o importar otra copia.`;
  }
  if (meta) {
    meta.textContent = [
      incoming.name ? `Paquete: ${incoming.name}` : "",
      existing.name ? `Existente: ${existing.name}` : "",
      existing.segments ? `${existing.segments} segmentos` : "",
    ].filter(Boolean).join(" · ");
  }
  overlay.classList.remove("hidden");
}

function hideDuplicateImportModal() {
  $("duplicateImportOverlay")?.classList.add("hidden");
  state.pendingDuplicateImport = null;
}

async function openDuplicateImportExisting() {
  const existing = state.pendingDuplicateImport?.existing;
  hideDuplicateImportModal();
  if (!existing?.id) return;
  const input = $("packageInput");
  const status = $("importPackageStatus");
  if (input) input.value = "";
  if (status) {
    status.textContent = "Abriendo existente";
    status.classList.remove("bad");
    status.classList.add("ok");
  }
  await openProject(existing.id);
}

async function copyDuplicateImport() {
  hideDuplicateImportModal();
  await importSelectedPackage("copy");
}

async function pollJob(projectId) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const job = await api(`/api/jobs/${projectId}`);
  state.currentJob = job;
  loadProjectLog(projectId);
  $("jobText").textContent = job.error || job.step || job.status;
  $("jobPercent").textContent = `${Math.round(Number(job.progress) || 0)}%`;
  $("jobBar").style.width = `${job.progress || 0}%`;
  if (ACTIVE_STATUSES.has(job.status)) {
    setTranscribeBusy(true);
  }
  renderLoading();
  if (job.status === "done") {
    await loadProjects();
    await openProject(projectId);
    state.activeJobId = null;
    state.currentJob = null;
    stopElapsedTimer();
    setTranscribeBusy(false);
    $("jobBox").classList.add("hidden");
    state.pollTimer = null;
    return;
  }
  if (["error", "paused", "cancelled"].includes(job.status)) {
    await loadProjects();
    await openProject(projectId);
    state.activeJobId = null;
    stopElapsedTimer();
    setTranscribeBusy(false);
    $("jobBox").classList.add("hidden");
    state.pollTimer = null;
    return;
  }
  state.pollTimer = setTimeout(() => pollJob(projectId), nextPollDelay(job));
}

function nextPollDelay(job) {
  const step = String(job.step || "").toLowerCase();
  if (step.includes("whisper") || step.includes("hablantes")) return 5000;
  return 2500;
}

async function pauseCurrentJob() {
  const projectId = state.activeJobId || state.current?.id;
  if (!projectId) return;
  await api(`/api/jobs/${projectId}/pause`, { method: "POST" });
  await pollJob(projectId);
}

async function cancelCurrentJob() {
  const projectId = state.activeJobId || state.current?.id;
  if (!projectId) return;
  await api(`/api/jobs/${projectId}/cancel`, { method: "POST" });
  await pollJob(projectId);
}

async function resumeCurrentProject() {
  const projectId = state.current?.id;
  if (!projectId) return;
  setTranscribeBusy(true);
  const result = await api(`/api/projects/${projectId}/resume`, { method: "POST" });
  state.activeJobId = result.id;
  state.currentJob = { status: "queued", step: "En cola", progress: 0, started_at: Date.now() };
  await openProject(result.id);
  pollJob(result.id);
}

async function reprocessCurrentProject() {
  const projectId = state.current?.id;
  if (!projectId || isJobActive()) return;
  const dirtyText = state.dirty ? " Tambien se perderan los cambios sin guardar." : "";
  const confirmed = confirm(`Esto volvera a transcribir el audio y reemplazara los segmentos actuales.${dirtyText} El audio original se conserva.`);
  if (!confirmed) return;
  setDirty(false);
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  setTranscribeBusy(true);
  const result = await api(`/api/projects/${projectId}/resume`, { method: "POST" });
  state.activeJobId = result.id;
  state.currentJob = { status: "queued", step: "En cola", progress: 0, started_at: Date.now() };
  await openProject(result.id);
  pollJob(result.id);
}

async function diarizeCurrentProject() {
  const projectId = state.current?.id;
  if (!projectId || isJobActive()) return;
  const saved = await saveDirtyBeforeContinuing("Hay cambios sin guardar antes de separar hablantes de nuevo.");
  if (!saved) return;
  const data = new FormData();
  data.append("speakers", $("editorSpeakersSelect")?.value || "2");
  setDirty(false);
  setTranscribeBusy(true);
  const result = await api(`/api/projects/${projectId}/diarize`, { method: "POST", body: data });
  state.activeJobId = result.id;
  state.currentJob = { status: "queued", step: "Preparando separacion de hablantes", progress: 0, started_at: Date.now() };
  await openProject(result.id);
  pollJob(result.id);
}

async function relabelCurrentProject() {
  const projectId = state.current?.id;
  if (!projectId || isJobActive()) return;
  if (!(state.current.diarization_turns || []).length) {
    alert("Este proyecto no tiene separacion de hablantes guardada para reetiquetar.");
    return;
  }
  const saved = await saveDirtyBeforeContinuing("Hay cambios sin guardar antes de reetiquetar hablantes.");
  if (!saved) return;
  $("saveState").textContent = "Reetiquetando hablantes...";
  const project = await api(`/api/projects/${projectId}/relabel-speakers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "interview_2p" }),
  });
  state.current = project;
  state.selectedSegmentIds.clear();
  state.lastSelectedSegmentIndex = null;
  setDirty(false);
  renderEditor();
  renderProjects();
  await loadProjects();
  $("saveState").textContent = "Hablantes reetiquetados";
  setTimeout(() => {
    if (!state.dirty) $("saveState").textContent = "";
  }, 1800);
}

async function deleteProject(projectId = state.current?.id, projectName = state.current?.name) {
  if (!projectId) return;
  const active = state.activeJobId === projectId || (state.current?.id === projectId && isJobActive());
  const label = projectName || "este proyecto";
  const message = active
    ? `Esto cancelara el proceso y borrara "${label}" con sus audios y archivos parciales. Esta accion no se puede deshacer.`
    : `Esto borrara "${label}" con sus audios, WAV, transcripciones parciales y exports locales. Esta accion no se puede deshacer.`;
  if (!confirm(message)) return;

  if (active) {
    await api(`/api/jobs/${projectId}/cancel`, { method: "POST" });
  }
  await api(`/api/projects/${projectId}`, { method: "DELETE" });
  removeStoredPlaybackPosition(projectId);
  removeProjectBrowserPreferences(projectId);
  if (state.current?.id === projectId) {
    state.current = null;
    state.currentJob = null;
    state.activeJobId = null;
    state.playbackRestorePending = false;
    state.playbackProjectId = null;
    if (state.playbackSaveTimer) {
      clearTimeout(state.playbackSaveTimer);
      state.playbackSaveTimer = null;
    }
    const player = $("audioPlayer");
    if (player) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    stopElapsedTimer();
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
    $("editor").classList.add("hidden");
    $("loadingState").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    renderEmptyState();
    setDirty(false);
  }
  setTranscribeBusy(false);
  $("jobBox").classList.add("hidden");
  await loadProjects();
}

async function init() {
  initTheme();
  initUiPreferences();
  initAudioVolume();
  state.browserDefaultPreferences = currentBrowserPreferences();
  if (state.proofreadEnabled) loadProofreadStatus({ start: true }).catch(() => {});
  on("themeToggleBtn", "click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  });
  on("proofreadToggleInput", "change", (event) => {
    setProofreadEnabled(Boolean(event.target?.checked));
  });
  on("sidebarToggleBtn", "click", () => {
    setSidebarCollapsed(!state.sidebarCollapsed);
  });
  on("sidebarCollapseBtn", "click", () => {
    setSidebarCollapsed(!state.sidebarCollapsed);
  });
  on("speakerPanelToggleBtn", "click", () => {
    setSpeakersPanelOpen(!state.speakersPanelOpen);
  });
  const sidebar = $("sidebar");
  if (sidebar) {
    sidebar.addEventListener("click", (event) => {
      if (!state.sidebarCollapsed) return;
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".sidebar-panel, .diagnostics-panel")) return;
      setSidebarCollapsed(false, { persist: false });
    });
  }
  const menus = Array.from(document.querySelectorAll(".export-menu, .tools-menu, .review-diagnostics"));
  for (const menu of menus) {
    menu.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".export-menu-list a, .tools-menu-list button, .review-diagnostics button")) menu.open = false;
    });
  }
  document.addEventListener("click", (event) => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
    const audioVolumeMenu = $("audioVolumeMenu");
    if (state.audioVolumePopoverOpen && audioVolumeMenu && !audioVolumeMenu.contains(event.target)) {
      setAudioVolumePopoverOpen(false);
    }
  });
  on("cancelDeleteSegmentBtn", "click", () => {
    resolveDeleteSegmentConfirmation(false);
  });
  on("confirmDeleteSegmentBtn", "click", () => {
    resolveDeleteSegmentConfirmation(true);
  });
  const confirmDeleteOverlay = $("confirmDeleteSegmentOverlay");
  if (confirmDeleteOverlay) {
    confirmDeleteOverlay.addEventListener("click", (event) => {
      if (event.target === confirmDeleteOverlay) {
        resolveDeleteSegmentConfirmation(false);
      }
    });
  }
  on("cancelDuplicateImportBtn", "click", () => {
    hideDuplicateImportModal();
  });
  on("openDuplicateImportBtn", "click", () => {
    openDuplicateImportExisting().catch((error) => showError(error));
  });
  on("copyDuplicateImportBtn", "click", () => {
    copyDuplicateImport().catch((error) => showError(error));
  });
  on("cancelImportPreviewBtn", "click", () => {
    hideImportPreviewModal();
  });
  on("confirmImportPreviewBtn", "click", () => {
    confirmImportPreview("ask").catch((error) => showError(error));
  });
  on("copyImportPreviewBtn", "click", () => {
    confirmImportPreview("copy").catch((error) => showError(error));
  });
  on("openExistingImportPreviewBtn", "click", () => {
    const existing = state.pendingImportPreview?.existing;
    hideImportPreviewModal();
    const input = $("packageInput");
    const status = $("importPackageStatus");
    if (input) input.value = "";
    if (status) {
      status.textContent = "Abriendo existente";
      status.classList.remove("bad");
      status.classList.add("ok");
    }
    if (existing?.id) openProject(existing.id).catch((error) => showError(error));
  });
  const importPreviewOverlay = $("importPreviewOverlay");
  if (importPreviewOverlay) {
    importPreviewOverlay.addEventListener("click", (event) => {
      if (event.target === importPreviewOverlay) {
        hideImportPreviewModal();
      }
    });
  }
  const duplicateImportOverlay = $("duplicateImportOverlay");
  if (duplicateImportOverlay) {
    duplicateImportOverlay.addEventListener("click", (event) => {
      if (event.target === duplicateImportOverlay) {
        hideDuplicateImportModal();
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.pendingImportPreview) {
      hideImportPreviewModal();
      return;
    }
    if (state.pendingDuplicateImport) {
      hideDuplicateImportModal();
      return;
    }
    if (state.pendingDeleteSegmentResolve) {
      resolveDeleteSegmentConfirmation(false);
      return;
    }
    if (state.audioVolumePopoverOpen) {
      setAudioVolumePopoverOpen(false);
      return;
    }
    for (const menu of menus) menu.open = false;
  });
  on("refreshBtn", "click", async () => {
    await loadStatus();
    await loadProjects();
  });
  on("uploadForm", "submit", (event) => {
    uploadFile(event).catch((error) => showError(error));
  });
  on("importPackageForm", "submit", (event) => {
    importPackage(event).catch((error) => showError(error));
  });
  on("exportPackage", "click", (event) => {
    exportPackageAfterSave(event, "exportPackage").catch((error) => showError(error));
  });
  on("exportPackageLite", "click", (event) => {
    exportPackageAfterSave(event, "exportPackageLite").catch((error) => showError(error));
  });
  on("modelSelect", "change", () => {
    updateModelHint();
  });
  on("profileSelect", "change", () => {
    maybeSelectModelForProfile();
  });
  on("saveBtn", "click", () => {
    saveEdits().catch(() => {});
  });
  on("retrySaveBtn", "click", async () => {
    const retryButton = $("retrySaveBtn");
    if (retryButton) {
      retryButton.disabled = true;
      retryButton.textContent = "Reintentando...";
    }
    try {
      await saveEdits({ retryingAfterFailure: true });
    } catch (_) {
      // showSaveFailure already keeps the blocking overlay visible.
    } finally {
      if (retryButton) {
        retryButton.disabled = false;
        retryButton.textContent = "Reintentar guardado";
      }
    }
  });
  on("reloadAfterSaveFailureBtn", "click", () => {
    if (!confirm("Recargar puede descartar cambios que no hayan quedado guardados en el servidor. Se intento guardar un borrador local en este navegador. ¿Recargar igual?")) {
      return;
    }
    window.location.reload();
  });
  on("restoreDraftBtn", "click", () => resolveDraftRestore("restore"));
  on("keepServerDraftBtn", "click", () => resolveDraftRestore("server"));
  on("discardDraftBtn", "click", () => resolveDraftRestore("discard"));
  on("keepLocalConflictBtn", "click", () => {
    keepLocalAfterConflict().catch((error) => showError(error));
  });
  on("reloadServerConflictBtn", "click", () => {
    reloadServerAfterConflict();
  });
  on("projectName", "input", () => {
    markDirty();
  });
  on("reprocessProjectBtn", "click", () => {
    reprocessCurrentProject().catch((error) => showError(error));
  });
  on("pauseJobBtn", "click", () => {
    pauseCurrentJob().catch((error) => showError(error));
  });
  on("cancelJobBtn", "click", () => {
    cancelCurrentJob().catch((error) => showError(error));
  });
  on("resumeJobBtn", "click", () => {
    resumeCurrentProject().catch((error) => showError(error));
  });
  on("diarizeProjectBtn", "click", () => {
    diarizeCurrentProject().catch((error) => showError(error));
  });
  on("relabelProjectBtn", "click", () => {
    relabelCurrentProject().catch((error) => showError(error));
  });
  on("addSpeakerBtn", "click", () => {
    addManualSpeaker();
  });
  on("deleteProjectBtn", "click", () => {
    deleteProject().catch((error) => showError(error));
  });
  on("deleteLoadingProjectBtn", "click", () => {
    deleteProject().catch((error) => showError(error));
  });
  on("mergeSelectedBtn", "click", () => {
    mergeSelectedSegments();
  });
  on("deleteSelectedBtn", "click", () => {
    deleteSelectedSegments();
  });
  on("clearSelectionBtn", "click", () => {
    clearSegmentSelection();
  });
  on("undoSegmentDeleteBtn", "click", () => {
    undoLastSegmentDelete();
  });
  on("dismissSegmentUndoBtn", "click", () => {
    clearSegmentUndoToast();
  });
  on("audioPlayer", "timeupdate", () => {
    updateActiveSegmentFromAudio();
    updateStickyAudioControls();
    rememberPlaybackPosition();
  });
  on("audioPlayer", "seeked", () => {
    updateActiveSegmentFromAudio();
    updateStickyAudioControls();
    rememberPlaybackPosition({ immediate: true });
  });
  on("audioPlayer", "play", () => {
    updateActiveSegmentFromAudio();
    updateStickyAudioControls();
  });
  on("audioPlayer", "pause", () => {
    updateActiveSegmentFromAudio();
    updateStickyAudioControls();
    rememberPlaybackPosition({ immediate: true });
  });
  on("audioPlayer", "ended", () => {
    updateActiveSegmentFromAudio();
    updateStickyAudioControls();
    rememberPlaybackPosition({ immediate: true });
  });
  on("audioPlayer", "loadedmetadata", () => {
    restorePlaybackPositionIfNeeded();
    updateStickyAudioControls();
  });
  on("audioBack30Btn", "click", () => {
    seekAudioBy(-30);
  });
  on("audioBack5Btn", "click", () => {
    seekAudioBy(-5);
  });
  on("audioPlayPauseBtn", "click", () => {
    toggleAudioPlayback();
  });
  on("audioForward5Btn", "click", () => {
    seekAudioBy(5);
  });
  on("audioForward30Btn", "click", () => {
    seekAudioBy(30);
  });
  on("audioFollowBtn", "click", () => {
    setAudioFollow(!state.audioFollow, { scroll: true });
  });
  on("audioSeek", "input", () => {
    state.audioSeekDragging = true;
    seekAudioFromRange();
  });
  on("audioSeek", "change", () => {
    seekAudioFromRange({ scroll: state.audioFollow });
    rememberPlaybackPosition({ immediate: true });
    state.audioSeekDragging = false;
    updateStickyAudioControls();
  });
  on("audioVolume", "input", (event) => {
    setAudioVolume(Number(event.target?.value) / 100);
    updateStickyAudioControls();
  });
  on("audioVolume", "change", (event) => {
    setAudioVolume(Number(event.target?.value) / 100);
  });
  on("audioVolumeBtn", "click", (event) => {
    event.stopPropagation();
    setAudioVolumePopoverOpen(!state.audioVolumePopoverOpen);
  });
  on("audioMuteBtn", "click", () => {
    toggleAudioMute();
    updateStickyAudioControls();
  });
  const audioVolumeMenu = $("audioVolumeMenu");
  if (audioVolumeMenu) {
    const canOpenVolumeOnHover =
      window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (canOpenVolumeOnHover) {
      audioVolumeMenu.addEventListener("mouseenter", () => setAudioVolumePopoverOpen(true));
      audioVolumeMenu.addEventListener("mouseleave", () => setAudioVolumePopoverOpen(false));
    }
    audioVolumeMenu.addEventListener("focusout", (event) => {
      if (!audioVolumeMenu.contains(event.relatedTarget)) setAudioVolumePopoverOpen(false);
    });
  }
  on("returnToAudioBtn", "click", () => {
    scrollToActiveAudioSegment();
  });
  window.addEventListener("scroll", () => {
    scheduleSegmentWindowRender();
    updateReturnToAudioButton();
  }, { passive: true });
  window.addEventListener("resize", () => {
    scheduleSegmentWindowRender();
    updateReturnToAudioButton();
  });
  window.addEventListener("wheel", pauseAudioFollowFromUser, { passive: true });
  window.addEventListener("touchmove", pauseAudioFollowFromUser, { passive: true });
  window.addEventListener("keydown", (event) => {
    if (isInteractiveControlFocused()) return;
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      pauseAudioFollowFromUser();
    }
  });
  await loadStatus();
  await loadProjects();
  setTranscribeBusy(isJobActive());
}

window.addEventListener("beforeunload", (event) => {
  rememberPlaybackPosition({ immediate: true, keepalive: true });
  if (!state.dirty) return;
  writeUnsavedDraftSyncFallback("beforeunload");
  event.preventDefault();
  event.returnValue = "";
});

init().catch((error) => {
  $("statusLine").textContent = error.message;
});

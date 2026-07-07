import { register } from "./runtime.js";

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
    audioPlaybackRate: normalizeAudioPlaybackRate(state.audioPlaybackRate),
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
  if (source.audioPlaybackRate !== undefined) {
    const rate = Number(source.audioPlaybackRate);
    if (Number.isFinite(rate)) preferences.audioPlaybackRate = normalizeAudioPlaybackRate(rate);
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
  writeStoredAudioPlaybackRate(preferences.audioPlaybackRate);
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
  if (Object.prototype.hasOwnProperty.call(preferences, "audioPlaybackRate")) {
    setAudioPlaybackRate(preferences.audioPlaybackRate, { persist: false });
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

register({
  currentTheme,
  updateThemeButton,
  setTheme,
  initTheme,
  readStoredBool,
  writeStoredBool,
  currentBrowserPreferences,
  browserSettingsPayload,
  normalizeBrowserPreferences,
  projectPreferencesKey,
  readProjectBrowserPreferences,
  writeProjectBrowserPreferences,
  removeProjectBrowserPreferences,
  writeGlobalBrowserPreferences,
  persistBrowserPreferenceState,
  applyBrowserPreferences,
  applyProjectBrowserPreferences,
  applySidebarState,
  setSidebarCollapsed,
  syncSidebarDefaultForCurrent,
  applySpeakersPanelState,
  setSpeakersPanelOpen,
  hideProofreadPanels,
  applyProofreadEnabledState,
  setProofreadEnabled,
  initUiPreferences,
  collectPortableBrowserSettings,
});

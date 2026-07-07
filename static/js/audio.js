import { register } from "./runtime.js";

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

function normalizeAudioPlaybackRate(value) {
  const allowed = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  if (value === null || value === undefined || value === "") return 1;
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return allowed.reduce((best, option) =>
    Math.abs(option - rate) < Math.abs(best - rate) ? option : best
  );
}

function readStoredAudioPlaybackRate() {
  try {
    return normalizeAudioPlaybackRate(localStorage.getItem(AUDIO_PLAYBACK_RATE_STORAGE_KEY));
  } catch (_) {
    return 1;
  }
}

function writeStoredAudioPlaybackRate(rate) {
  try {
    localStorage.setItem(AUDIO_PLAYBACK_RATE_STORAGE_KEY, String(normalizeAudioPlaybackRate(rate)));
  } catch (_) {
    // Ignore storage failures.
  }
}

function applyAudioPlaybackRate() {
  const rate = normalizeAudioPlaybackRate(state.audioPlaybackRate);
  state.audioPlaybackRate = rate;
  const player = $("audioPlayer");
  if (player) player.playbackRate = rate;
  const select = $("audioPlaybackRate");
  if (select) select.value = String(rate);
}

function setAudioPlaybackRate(value, options = {}) {
  state.audioPlaybackRate = normalizeAudioPlaybackRate(value);
  applyAudioPlaybackRate();
  if (options.persist !== false) persistBrowserPreferenceState();
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

function initAudioPlaybackRate() {
  state.audioPlaybackRate = readStoredAudioPlaybackRate();
  applyAudioPlaybackRate();
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
  applyAudioPlaybackRate();
  const follow = $("audioFollowBtn");
  if (follow) {
    follow.textContent = state.audioFollow ? "Siguiendo" : "Seguir";
    follow.classList.toggle("active", state.audioFollow);
    follow.title = state.audioFollow ? "Desactivar seguimiento automatico" : "Seguir segmento actual";
  }
  for (const id of ["audioBack30Btn", "audioBack5Btn", "audioPlayPauseBtn", "audioForward5Btn", "audioForward30Btn", "audioSeek", "audioFollowBtn", "audioPlaybackRate", "audioVolumeBtn", "audioVolume", "audioMuteBtn"]) {
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
  updateQuickScrollButtons();
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

function updateReturnToTopButton() {
  const button = $("returnToTopBtn");
  const editor = $("editor");
  if (!button || !editor) return;
  const editorVisible = !editor.classList.contains("hidden");
  const editorTop = editor.getBoundingClientRect().top + window.scrollY;
  const shouldShow = Boolean(state.current && editorVisible && window.scrollY > editorTop + 160);
  button.classList.toggle("hidden", !shouldShow);
}

function updateQuickScrollButtons() {
  updateReturnToAudioButton();
  updateReturnToTopButton();
}

function scrollToProjectStart() {
  const editor = $("editor");
  const target = editor && !editor.classList.contains("hidden") ? editor : $("appLayout");
  if (state.audioFollow) setAudioFollow(false, { scroll: false });
  state.programmaticScrollUntil = Date.now() + 900;
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  setTimeout(updateQuickScrollButtons, 280);
}

function scrollToActiveAudioSegment() {
  const row = ensureSegmentRendered(state.activeSegmentIndex);
  if (!row) return;
  state.programmaticScrollUntil = Date.now() + 900;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(updateQuickScrollButtons, 280);
}

function updateActiveSegmentFromAudio(options = {}) {
  const player = $("audioPlayer");
  if (!player || !state.current || state.current.status !== "done") {
    const previousRow = segmentRowForIndex(state.activeSegmentIndex);
    if (previousRow) previousRow.classList.remove("current-audio", "audio-playing");
    state.activeSegmentIndex = null;
    updateQuickScrollButtons();
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
  updateQuickScrollButtons();
}

register({
  audioSrcForProject,
  projectHasAudio,
  absoluteAudioSrc,
  playbackStorageKey,
  readStoredPlaybackPosition,
  writeStoredPlaybackPosition,
  removeStoredPlaybackPosition,
  readStoredAudioVolume,
  writeStoredAudioVolume,
  readStoredAudioMuted,
  writeStoredAudioMuted,
  normalizeAudioPlaybackRate,
  readStoredAudioPlaybackRate,
  writeStoredAudioPlaybackRate,
  applyAudioPlaybackRate,
  setAudioPlaybackRate,
  setAudioVolumePopoverOpen,
  audioVolumeIconName,
  applyAudioVolume,
  setAudioVolume,
  toggleAudioMute,
  initAudioVolume,
  initAudioPlaybackRate,
  currentPlaybackPosition,
  schedulePlaybackSave,
  rememberPlaybackPosition,
  flushPlaybackPosition,
  restorePlaybackPositionIfNeeded,
  playSegment,
  audioDurationValue,
  clampAudioTime,
  seekAudioBy,
  toggleAudioPlayback,
  updateStickyAudioControls,
  seekAudioFromRange,
  findActiveSegmentIndex,
  segmentRowForIndex,
  ensureSegmentRendered,
  scheduleSegmentWindowRender,
  isRowVisible,
  isSegmentIndexVisible,
  isEditingTranscriptField,
  isInteractiveControlFocused,
  setAudioFollow,
  pauseAudioFollowFromUser,
  updateReturnToAudioButton,
  updateReturnToTopButton,
  updateQuickScrollButtons,
  scrollToProjectStart,
  scrollToActiveAudioSegment,
  updateActiveSegmentFromAudio,
});

import { register } from "./runtime.js";

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
  if (detail) detail.textContent = visibleErrorMessage(error, "Error desconocido");
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
  if (detail) detail.textContent = visibleErrorMessage(error, "El servidor tiene una revision mas reciente.");
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

register({
  unsavedDraftKey,
  normalizeDraftPayload,
  createUnsavedDraftPayload,
  openDraftDb,
  withDraftStore,
  writeUnsavedDraftSyncFallback,
  writeUnsavedDraft,
  readUnsavedDraft,
  draftDismissKey,
  segmentUndoKey,
  cloneSegment,
  loadSegmentUndoStack,
  persistSegmentUndoStack,
  clearSegmentUndoTimer,
  scheduleSegmentUndoAutoHide,
  pushSegmentUndo,
  renderSegmentUndoToast,
  clearSegmentUndoToast,
  undoLastSegmentDelete,
  clearUnsavedDraft,
  setEditorSaveBlocked,
  showSaveFailure,
  clearSaveFailure,
  showSaveConflict,
  clearSaveConflict,
  keepLocalAfterConflict,
  reloadServerAfterConflict,
  shouldOfferDraftRestore,
  resolveDraftRestore,
  showDraftRestorePrompt,
  applyDraftToCurrent,
  maybeOfferDraftRestore,
  segmentPreviewText,
  resolveDeleteSegmentConfirmation,
  confirmDeleteSegment,
});

import "./runtime.js";
import "./utils/dom.js";
import "./utils/format.js";
import "./utils/errors.js";
import "./api.js";
import "./preferences.js";
import "./drafts.js";
import "./projects.js";
import "./proofread.js";
import "./speakers.js";
import "./editor.js";
import "./audio.js";
import "./import-export.js";
import "./jobs.js";

export async function initApp() {
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

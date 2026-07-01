import { register } from "./runtime.js";

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

function scheduleUnsavedDraft(delay = 800) {
  if (!state.current?.id || state.current.status !== "done") return;
  if (state.draftTimer) clearTimeout(state.draftTimer);
  state.draftTimer = setTimeout(() => {
    state.draftTimer = null;
    writeUnsavedDraft("edit").catch(() => {});
  }, delay);
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

function currentSegments() {
  return state.current?.segments || [];
}

function currentLabels() {
  if (!state.current.speaker_labels) state.current.speaker_labels = {};
  return state.current.speaker_labels;
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
      renderSimpleEmptyState("Error", sanitizeVisibleErrorMessage(state.current.error, "No se pudo procesar."));
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
  $("loadingDetail").textContent = job.error
    ? sanitizeVisibleErrorMessage(job.error)
    : job.step || "Preparando archivo...";
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
    $("loadingDetail").textContent = job.error
      ? sanitizeVisibleErrorMessage(job.error)
      : "El proyecto se conserva. Puedes reintentarlo si lo necesitas.";
  } else if (status === "error") {
    $("loadingTitle").textContent = "Error";
    $("loadingDetail").textContent = sanitizeVisibleErrorMessage(
      job.error || project.error,
      "No se pudo procesar el archivo."
    );
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
  $("resumeJobBtn").disabled = active;
  $("resumeJobBtn").textContent = status === "cancelled" ? "Reintentar" : "Reanudar";
  $("deleteLoadingProjectBtn").classList.toggle("hidden", active);
  setTranscribeBusy(active);
  if (active) {
    startElapsedTimer();
  } else {
    stopElapsedTimer();
  }
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
      saveState.textContent = `No se pudo guardar: ${visibleErrorMessage(error, "error desconocido")}`;
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

register({
  setDirty,
  scheduleUnsavedDraft,
  markDirty,
  scheduleAutosave,
  currentSegments,
  currentLabels,
  cleanWarningText,
  warningRangeFromText,
  normalizeWarningForDisplay,
  renderWarnings,
  renderEditor,
  renderLoading,
  segmentVirtualizationEnabled,
  clampSegmentWindow,
  segmentVirtualWindow,
  createSegmentVirtualSpacer,
  updateSegmentVirtualHeight,
  createSegmentRow,
  renderSegments,
  splitSegment,
  renderSegmentSelectionBar,
  mergeSelectedSegments,
  deleteSegment,
  deleteSelectedSegments,
  clearSegmentSelection,
  saveEdits,
});

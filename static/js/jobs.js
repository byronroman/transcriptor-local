import { register } from "./runtime.js";

function isJobActive(job = state.currentJob) {
  return Boolean(job && ACTIVE_STATUSES.has(job.status));
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

function clearJobPolling() {
  state.jobPollGeneration += 1;
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
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

async function pollJob(projectId) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const pollGeneration = state.jobPollGeneration;
  let job = null;
  try {
    job = await api(`/api/jobs/${projectId}`);
  } catch (error) {
    if (pollGeneration !== state.jobPollGeneration) return;
    handleJobConnectionLost(projectId, error);
    return;
  }
  if (pollGeneration !== state.jobPollGeneration) return;
  state.currentJob = job;
  loadProjectLog(projectId);
  $("jobText").textContent = job.error ? sanitizeVisibleErrorMessage(job.error) : job.step || job.status;
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

function setLocalJobStopped(projectId, status, step, error = "") {
  clearJobPolling();
  const visibleError = error ? sanitizeVisibleErrorMessage(error, "") : "";
  state.activeJobId = null;
  state.currentJob = {
    ...(state.currentJob || {}),
    status,
    step,
    progress: status === "cancelled" ? 100 : Number(state.currentJob?.progress) || 0,
    error: visibleError,
    can_resume: true,
  };
  if (state.current?.id === projectId) {
    state.current = {
      ...state.current,
      status,
      error: visibleError || null,
    };
  }
  stopElapsedTimer();
  setTranscribeBusy(false);
  const jobBox = $("jobBox");
  if (jobBox) jobBox.classList.add("hidden");
  renderLoading();
}

function handleJobConnectionLost(projectId, error) {
  const message = visibleErrorMessage(
    error,
    "La app local dejo de responder. Se detuvo el seguimiento del proceso."
  );
  setLocalJobStopped(
    projectId,
    "error",
    "Seguimiento detenido",
    `${message} Si cerraste la terminal, reinicia la app local para continuar.`
  );
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
  clearJobPolling();
  state.currentJob = {
    ...(state.currentJob || {}),
    status: "cancelling",
    step: "Cancelando proceso",
    stop_requested: "cancelled",
  };
  renderLoading();
  try {
    await api(`/api/jobs/${projectId}/cancel`, { method: "POST" });
    state.jobPollGeneration += 1;
    await pollJob(projectId);
  } catch (error) {
    setLocalJobStopped(
      projectId,
      "cancelled",
      "Cancelado localmente",
      "No se pudo confirmar la cancelacion con la app local. Si cerraste la terminal, el proceso ya fue interrumpido."
    );
  }
}

async function resumeCurrentProject() {
  const projectId = state.current?.id;
  if (!projectId) return;
  clearJobPolling();
  const resumeButton = $("resumeJobBtn");
  if (resumeButton) resumeButton.disabled = true;
  setTranscribeBusy(true);
  try {
    const result = await api(`/api/projects/${projectId}/resume`, { method: "POST" });
    const resumedProjectId = result.id || projectId;
    state.activeJobId = resumedProjectId;
    state.currentJob = { status: "queued", step: "En cola", progress: 0, started_at: Date.now() };
    if (state.current?.id === resumedProjectId) {
      state.current = { ...state.current, status: "queued", error: null };
    }
    state.projects = state.projects.map((project) =>
      project.id === resumedProjectId ? { ...project, status: "queued", error: null } : project
    );
    renderProjects();
    renderLoading();
    pollJob(resumedProjectId);
  } catch (error) {
    if (resumeButton) resumeButton.disabled = false;
    setTranscribeBusy(false);
    throw error;
  }
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

register({
  isJobActive,
  setTranscribeBusy,
  jobProgressMeta,
  updateElapsedDisplay,
  clearJobPolling,
  startElapsedTimer,
  stopElapsedTimer,
  pollJob,
  setLocalJobStopped,
  handleJobConnectionLost,
  nextPollDelay,
  pauseCurrentJob,
  cancelCurrentJob,
  resumeCurrentProject,
  reprocessCurrentProject,
  diarizeCurrentProject,
  relabelCurrentProject,
});

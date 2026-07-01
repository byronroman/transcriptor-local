import { register } from "./runtime.js";

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

register({
  loadStatus,
  renderStatus,
  modelDisplayName,
  modelProfile,
  updateModelHint,
  processingProfileDetails,
  renderProfileSelect,
  updateProfileHint,
  maybeSelectModelForProfile,
  loadProjects,
  loadProjectLog,
  renderProjects,
  projectStatusText,
  projectUpdatedText,
  projectSegmentCount,
  sortedProjectSuggestions,
  renderEmptyState,
  renderSimpleEmptyState,
  openProject,
  deleteProject,
});

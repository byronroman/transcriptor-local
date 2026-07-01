import { register } from "./runtime.js";

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
      status.textContent = visibleErrorMessage(error, "No se pudo revisar.");
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
      status.textContent = visibleErrorMessage(error, "No se pudo importar.");
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

register({
  saveDirtyBeforeContinuing,
  waitForAutosaveIdle,
  saveBeforePackageExport,
  packageExportUrlWithBrowserSettings,
  exportPackageAfterSave,
  uploadFile,
  importPackage,
  formatPackageBytes,
  formatPackageDate,
  inspectSelectedPackage,
  showImportPreviewModal,
  hideImportPreviewModal,
  confirmImportPreview,
  importSelectedPackage,
  showDuplicateImportModal,
  hideDuplicateImportModal,
  openDuplicateImportExisting,
  copyDuplicateImport,
});

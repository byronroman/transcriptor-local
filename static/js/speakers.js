import { register } from "./runtime.js";

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
  return `speaker-theme-${speakerIndex(speaker, speakers) % 6}`;
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
  for (let index = 0; index < 6; index += 1) {
    element.classList.remove(`speaker-theme-${index}`);
  }
  element.classList.add(speakerTheme(speaker, speakers));
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

register({
  speakersFromSegments,
  segmentKey,
  selectedSegmentIndexes,
  syncSelectedSegments,
  setSegmentSelected,
  selectSegmentRange,
  speakerIndex,
  speakerTheme,
  nextSpeakerId,
  speakerInitial,
  applySpeakerTheme,
  renderSpeakerLabels,
  renderSpeakerSummary,
  addManualSpeaker,
});

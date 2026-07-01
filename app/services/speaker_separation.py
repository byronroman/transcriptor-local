from __future__ import annotations

import re
import time
import unicodedata
from typing import Any, Optional


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def turn_duration(turn: dict[str, Any]) -> float:
    return max(0.0, float(turn.get("end", 0)) - float(turn.get("start", 0)))


def segment_duration(segment: dict[str, Any]) -> float:
    return max(0.0, float(segment.get("end", 0)) - float(segment.get("start", 0)))


def segment_word_count_value(segment: dict[str, Any]) -> int:
    return len((segment.get("text") or "").split())


def auto_split_base_id(segment_id: Any) -> Optional[str]:
    match = re.match(r"^(.+)-sp\d+$", str(segment_id or ""))
    return match.group(1) if match else None


def merge_auto_split_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    index = 0
    while index < len(segments):
        segment = segments[index]
        base_id = auto_split_base_id(segment.get("id"))
        if not base_id:
            merged.append(dict(segment))
            index += 1
            continue

        group = [segment]
        index += 1
        while index < len(segments) and auto_split_base_id(segments[index].get("id")) == base_id:
            group.append(segments[index])
            index += 1

        first = group[0]
        combined = dict(first)
        combined["id"] = base_id
        combined["start"] = round(min(float(item.get("start", 0)) for item in group), 3)
        combined["end"] = round(max(float(item.get("end", 0)) for item in group), 3)
        combined["text"] = " ".join((item.get("text") or "").strip() for item in group).replace("  ", " ").strip()
        merged.append(combined)
    return merged


def normalize_turns(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for turn in turns:
        start = float(turn.get("start", 0))
        end = float(turn.get("end", start))
        if end - start <= 0.08:
            continue
        normalized.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "speaker": str(turn.get("speaker") or "SPEAKER_00"),
            }
        )
    return sorted(normalized, key=lambda item: (float(item["start"]), float(item["end"])))


def merge_nearby_same_speaker_turns(turns: list[dict[str, Any]], max_gap: float = 0.75) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for turn in turns:
        item = dict(turn)
        if (
            merged
            and merged[-1]["speaker"] == item["speaker"]
            and float(item["start"]) - float(merged[-1]["end"]) <= max_gap
        ):
            merged[-1]["end"] = round(max(float(merged[-1]["end"]), float(item["end"])), 3)
            continue
        merged.append(item)
    return merged


def absorb_micro_turns(turns: list[dict[str, Any]], min_duration: float = 0.45) -> list[dict[str, Any]]:
    if not turns:
        return []
    cleaned: list[dict[str, Any]] = []
    for index, turn in enumerate(turns):
        if turn_duration(turn) >= min_duration:
            cleaned.append(dict(turn))
            continue
        previous_turn = cleaned[-1] if cleaned else None
        next_turn = turns[index + 1] if index + 1 < len(turns) else None
        if (
            previous_turn
            and next_turn
            and previous_turn["speaker"] == next_turn["speaker"]
            and float(turn["start"]) - float(previous_turn["end"]) <= 0.75
            and float(next_turn["start"]) - float(turn["end"]) <= 0.75
        ):
            previous_turn["end"] = round(max(float(previous_turn["end"]), float(next_turn["end"])), 3)
            continue
        if previous_turn and float(turn["start"]) - float(previous_turn["end"]) <= 0.35:
            continue
        if next_turn and float(next_turn["start"]) - float(turn["end"]) <= 0.35:
            continue
        cleaned.append(dict(turn))
    return merge_nearby_same_speaker_turns(cleaned)


def resolve_turn_overlaps(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    resolved: list[dict[str, Any]] = []
    for turn in turns:
        current = dict(turn)
        if not resolved:
            resolved.append(current)
            continue
        previous = resolved[-1]
        if float(current["start"]) >= float(previous["end"]):
            resolved.append(current)
            continue
        if previous["speaker"] == current["speaker"]:
            previous["end"] = round(max(float(previous["end"]), float(current["end"])), 3)
            continue

        previous_duration = turn_duration(previous)
        current_duration = turn_duration(current)
        if current_duration <= 1.2 and previous_duration >= current_duration * 2:
            continue
        if previous_duration <= 1.2 and current_duration >= previous_duration * 2:
            resolved.pop()
            resolved.append(current)
            continue

        boundary = round((float(current["start"]) + float(previous["end"])) / 2, 3)
        previous["end"] = boundary
        current["start"] = boundary
        if turn_duration(previous) <= 0.08:
            resolved.pop()
        if turn_duration(current) > 0.08:
            resolved.append(current)
    return resolved


def suppress_short_turn_islands(turns: list[dict[str, Any]], max_duration: float = 1.2) -> list[dict[str, Any]]:
    if len(turns) < 3:
        return turns
    cleaned = [dict(turn) for turn in turns]
    for index in range(1, len(cleaned) - 1):
        previous_turn = cleaned[index - 1]
        current = cleaned[index]
        next_turn = cleaned[index + 1]
        if (
            current["speaker"] != previous_turn["speaker"]
            and previous_turn["speaker"] == next_turn["speaker"]
            and turn_duration(current) <= max_duration
            and float(current["start"]) - float(previous_turn["end"]) <= 0.75
            and float(next_turn["start"]) - float(current["end"]) <= 0.75
        ):
            current["speaker"] = previous_turn["speaker"]
    return merge_nearby_same_speaker_turns(cleaned)


def postprocess_diarization_turns(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned = normalize_turns(turns)
    cleaned = absorb_micro_turns(cleaned)
    cleaned = resolve_turn_overlaps(cleaned)
    cleaned = merge_nearby_same_speaker_turns(cleaned)
    cleaned = suppress_short_turn_islands(cleaned)
    return resolve_turn_overlaps(merge_nearby_same_speaker_turns(cleaned))


def best_speaker_for_segment(
    start: float,
    end: float,
    turns: list[dict[str, Any]],
    fallback: str = "SPEAKER_00",
) -> str:
    best_speaker = fallback
    best_overlap = 0.0
    midpoint = (start + end) / 2
    nearest_distance = float("inf")
    nearest_speaker = fallback
    for turn in turns:
        turn_start = float(turn["start"])
        turn_end = float(turn["end"])
        value = overlap(start, end, turn_start, turn_end)
        if value > best_overlap:
            best_overlap = value
            best_speaker = turn["speaker"]
        center = (turn_start + turn_end) / 2
        distance = abs(center - midpoint)
        if distance < nearest_distance:
            nearest_distance = distance
            nearest_speaker = turn["speaker"]
    return best_speaker if best_overlap > 0 else nearest_speaker


def speaker_parts_for_segment(
    start: float,
    end: float,
    turns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    duration = max(0.0, end - start)
    if duration <= 0:
        return []
    min_overlap = 0.35 if duration >= 4 else 0.18
    parts = []
    for turn in turns:
        turn_start = float(turn["start"])
        turn_end = float(turn["end"])
        value = overlap(start, end, turn_start, turn_end)
        if value < min_overlap:
            continue
        parts.append(
            {
                "start": max(start, turn_start),
                "end": min(end, turn_end),
                "speaker": turn["speaker"],
            }
        )
    if not parts:
        return []
    parts.sort(key=lambda item: (item["start"], item["end"]))

    merged: list[dict[str, Any]] = []
    for part in parts:
        if not merged:
            merged.append(part)
            continue
        previous = merged[-1]
        if part["speaker"] == previous["speaker"] and part["start"] - previous["end"] <= 0.45:
            previous["end"] = max(previous["end"], part["end"])
        else:
            merged.append(part)

    return [part for part in merged if part["end"] - part["start"] >= 0.12]


def normalized_text_key(text: str) -> str:
    value = unicodedata.normalize("NFKD", text or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = re.sub(r"[^a-zA-Z0-9 ]+", " ", value).lower()
    return re.sub(r"\s+", " ", value).strip()


def is_question_like(text: str) -> bool:
    clean = normalized_text_key(text)
    if "?" in text or "Â¿" in text:
        return True
    starters = (
        "cuanto",
        "cuanta",
        "cuantos",
        "cuantas",
        "cual",
        "cuales",
        "como",
        "cuando",
        "donde",
        "quien",
        "quienes",
        "tiene",
        "tienen",
        "ustedes participan",
    )
    return any(clean.startswith(starter) for starter in starters)


def is_prompt_like(text: str) -> bool:
    clean = normalized_text_key(text)
    prompt_markers = (
        "ahora le voy a preguntar",
        "recapitulando",
        "integrante",
        "nivel educativo",
        "nacionalidad",
        "hogar",
        "dependencia funcional",
        "movilidad",
        "me cuenta",
        "le voy a preguntar",
        "haciamos",
        "tratamos",
        "tema es de tiempo",
        "mas agil",
        "para ustedes",
        "para nosotros",
        "gracias por recibirnos",
        "para el segundo",
        "para la segunda",
        "para el tercer",
        "para la tercera",
        "super",
    )
    return any(marker in clean for marker in prompt_markers)


def is_interviewer_ack_like(text: str) -> bool:
    clean = normalized_text_key(text)
    return clean in {
        "ya",
        "ah ya",
        "ya super",
        "super",
        "perfecto",
        "ok",
        "claro",
        "entiendo",
    }


def is_clear_short_response(text: str) -> bool:
    clean = normalized_text_key(text)
    if clean in {"si", "no", "ya", "claro", "exacto", "tambien"}:
        return True
    if re.fullmatch(r"(si|no)( si| no){0,3}", clean):
        return True
    if re.fullmatch(r"\d{1,3}", clean):
        return True
    return False


def role_speaker_ids(existing_labels: Optional[dict[str, str]] = None) -> tuple[str, str]:
    labels = existing_labels or {}
    interviewer = None
    interviewee = None
    for speaker, label in labels.items():
        clean = normalized_text_key(label)
        if "entrevistador" in clean:
            interviewer = speaker
        if "entrevistada" in clean or "entrevistado" in clean:
            interviewee = speaker
    return interviewer or "SPEAKER_00", interviewee or "SPEAKER_01"


def speaker_overlap_scores(
    start: float,
    end: float,
    turns: list[dict[str, Any]],
) -> dict[str, float]:
    scores: dict[str, float] = {}
    for turn in turns:
        value = overlap(start, end, float(turn["start"]), float(turn["end"]))
        if value > 0:
            scores[str(turn["speaker"])] = scores.get(str(turn["speaker"]), 0.0) + value
    return scores


def choose_interview_speaker(
    segment: dict[str, Any],
    turns: list[dict[str, Any]],
    existing_labels: Optional[dict[str, str]],
    previous_speaker: Optional[str],
    previous_end: Optional[float],
) -> str:
    start = float(segment.get("start", 0))
    end = float(segment.get("end", start))
    text = segment.get("text") or ""
    words = segment_word_count_value(segment)
    duration = max(0.0, end - start)
    interviewer, interviewee = role_speaker_ids(existing_labels)
    speakers = sorted({interviewer, interviewee, *(turn.get("speaker", "SPEAKER_00") for turn in turns)})
    scores = {speaker: 0.0 for speaker in speakers}

    acoustic_scores = speaker_overlap_scores(start, end, turns)
    for speaker, value in acoustic_scores.items():
        scores[speaker] = scores.get(speaker, 0.0) + value * 0.35
    if not acoustic_scores and turns:
        nearest = best_speaker_for_segment(start, end, turns, segment.get("speaker") or interviewer)
        scores[nearest] = scores.get(nearest, 0.0) + 0.4

    question = is_question_like(text)
    prompt = is_prompt_like(text)
    clear_response = is_clear_short_response(text)
    if question:
        scores[interviewer] = scores.get(interviewer, 0.0) + 4.0
    if prompt:
        scores[interviewer] = scores.get(interviewer, 0.0) + 3.0
    if is_interviewer_ack_like(text) and words <= 4:
        scores[interviewer] = scores.get(interviewer, 0.0) + 2.0
    if not question and not prompt:
        if previous_speaker == interviewer and (words >= 3 or clear_response):
            scores[interviewee] = scores.get(interviewee, 0.0) + 3.0
        if previous_speaker == interviewee and not is_interviewer_ack_like(text):
            scores[interviewee] = scores.get(interviewee, 0.0) + 1.0
        if words >= 8:
            scores[interviewee] = scores.get(interviewee, 0.0) + 2.0
        if clear_response:
            scores[interviewee] = scores.get(interviewee, 0.0) + 1.5

    if previous_speaker and duration <= 1.2 and not clear_response:
        scores[previous_speaker] = scores.get(previous_speaker, 0.0) + 1.4
    if previous_speaker and previous_end is not None and start - previous_end <= 0.75 and not question:
        scores[previous_speaker] = scores.get(previous_speaker, 0.0) + 0.4

    return max(scores.items(), key=lambda item: (item[1], item[0]))[0]


def should_split_segment_by_speaker(
    segment: dict[str, Any],
    parts: list[dict[str, Any]],
) -> bool:
    start = float(segment.get("start", 0))
    end = float(segment.get("end", start))
    text = segment.get("text") or ""
    if end - start < 6.0 or len(text.split()) < 18:
        return False
    if len(parts) < 2 or len(parts) > 4 or len({part["speaker"] for part in parts}) < 2:
        return False
    if any(float(part["end"]) - float(part["start"]) < 1.5 for part in parts):
        return False
    if min(float(parts[0]["end"]) - start, end - float(parts[-1]["start"])) < 1.5:
        return False
    return True


def split_text_by_durations(text: str, durations: list[float]) -> list[str]:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    count = len(durations)
    if count <= 1:
        return [cleaned]
    if not cleaned:
        return [""] * count

    words = cleaned.split(" ")
    if len(words) < count:
        return [cleaned] + [""] * (count - 1)

    total = sum(max(0.001, duration) for duration in durations)
    chunks: list[str] = []
    cursor = 0
    elapsed = 0.0
    for idx, duration in enumerate(durations[:-1]):
        elapsed += max(0.001, duration)
        target = round(len(words) * (elapsed / total))
        remaining_chunks = count - idx - 1
        min_cut = cursor + 1
        max_cut = len(words) - remaining_chunks
        cut = min(max(target, min_cut), max_cut)
        chunks.append(" ".join(words[cursor:cut]).strip())
        cursor = cut
    chunks.append(" ".join(words[cursor:]).strip())
    return chunks


def smooth_short_segment_islands(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(segments) < 3:
        return segments
    smoothed = [dict(segment) for segment in segments]
    for index in range(1, len(smoothed) - 1):
        previous = smoothed[index - 1]
        current = smoothed[index]
        next_segment = smoothed[index + 1]
        if (
            current.get("speaker") != previous.get("speaker")
            and previous.get("speaker") == next_segment.get("speaker")
            and segment_duration(current) <= 1.2
            and not is_clear_short_response(current.get("text") or "")
            and not is_question_like(current.get("text") or "")
            and not is_prompt_like(current.get("text") or "")
            and not is_interviewer_ack_like(current.get("text") or "")
        ):
            current["speaker"] = previous.get("speaker")
    return smoothed


def assign_speakers_from_processed_turns(
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    existing_labels: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    if not turns:
        return segments

    assigned: list[dict[str, Any]] = []
    previous_speaker: Optional[str] = None
    previous_end: Optional[float] = None
    for index, segment in enumerate(merge_auto_split_segments(segments)):
        start = float(segment.get("start", 0))
        end = float(segment.get("end", start))
        parts = speaker_parts_for_segment(start, end, turns)
        if should_split_segment_by_speaker(segment, parts):
            durations = [part["end"] - part["start"] for part in parts]
            text_parts = split_text_by_durations(segment.get("text") or "", durations)
            split_segments = []
            base_id = segment.get("id") or f"seg-{index}"
            for part_idx, (part, part_text) in enumerate(zip(parts, text_parts)):
                if not part_text:
                    continue
                item = dict(segment)
                item["id"] = f"{base_id}-sp{part_idx}"
                item["start"] = round(float(part["start"]), 3)
                item["end"] = round(float(part["end"]), 3)
                item["text"] = part_text
                item["speaker"] = part["speaker"]
                split_segments.append(item)
                previous_speaker = item["speaker"]
                previous_end = float(item["end"])
            if len(split_segments) >= 2:
                assigned.extend(split_segments)
                continue

        item = dict(segment)
        item["id"] = item.get("id") or f"seg-{index}"
        item["speaker"] = choose_interview_speaker(item, turns, existing_labels, previous_speaker, previous_end)
        assigned.append(item)
        previous_speaker = item["speaker"]
        previous_end = float(item.get("end", start))
    return smooth_short_segment_islands(assigned)


def assign_speakers(
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    existing_labels: Optional[dict[str, str]] = None,
) -> list[dict[str, Any]]:
    if not turns:
        return segments
    processed_turns = postprocess_diarization_turns(turns)
    return assign_speakers_from_processed_turns(segments, processed_turns, existing_labels)


def default_speaker_labels(
    segments: list[dict[str, Any]],
    existing_labels: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    speakers = sorted({segment.get("speaker", "SPEAKER_00") for segment in segments})
    defaults = ["Entrevistador/a", "Entrevistada/o", "Otra persona"]
    labels = {}
    for idx, speaker in enumerate(speakers):
        existing = (existing_labels or {}).get(speaker)
        labels[speaker] = existing or (defaults[idx] if idx < len(defaults) else speaker)
    return labels


def count_speaker_switches(items: list[dict[str, Any]]) -> int:
    return sum(1 for current, next_item in zip(items, items[1:]) if current.get("speaker") != next_item.get("speaker"))


def count_short_segment_islands(segments: list[dict[str, Any]], max_duration: float = 1.2) -> int:
    total = 0
    for index in range(1, len(segments) - 1):
        previous = segments[index - 1]
        current = segments[index]
        next_segment = segments[index + 1]
        if (
            current.get("speaker") != previous.get("speaker")
            and previous.get("speaker") == next_segment.get("speaker")
            and segment_duration(current) <= max_duration
            and not is_clear_short_response(current.get("text") or "")
        ):
            total += 1
    return total


def adjacent_overlap_stats(items: list[dict[str, Any]]) -> dict[str, Any]:
    count = 0
    seconds = 0.0
    for current, next_item in zip(items, items[1:]):
        if current.get("speaker") == next_item.get("speaker"):
            continue
        value = overlap(
            float(current.get("start", 0)),
            float(current.get("end", 0)),
            float(next_item.get("start", 0)),
            float(next_item.get("end", 0)),
        )
        if value > 0:
            count += 1
            seconds += value
    return {"count": count, "seconds": round(seconds, 3)}


def speaker_distribution(items: list[dict[str, Any]]) -> dict[str, dict[str, float | int]]:
    distribution: dict[str, dict[str, float | int]] = {}
    for item in items:
        speaker = str(item.get("speaker") or "SPEAKER_00")
        bucket = distribution.setdefault(speaker, {"count": 0, "seconds": 0.0})
        bucket["count"] = int(bucket["count"]) + 1
        bucket["seconds"] = round(float(bucket["seconds"]) + segment_duration(item), 3)
    return distribution


def compute_diarization_quality(
    raw_turns: list[dict[str, Any]],
    processed_turns: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> dict[str, Any]:
    duration = max(
        [float(item.get("end", 0)) for item in raw_turns + processed_turns + segments] or [0.0]
    )
    minutes = max(duration / 60.0, 1.0)
    raw_overlap = adjacent_overlap_stats(normalize_turns(raw_turns))
    segment_overlap = adjacent_overlap_stats(segments)
    raw_micro_turns = sum(1 for turn in normalize_turns(raw_turns) if turn_duration(turn) < 0.45)
    short_islands = count_short_segment_islands(segments)
    split_segments = [segment for segment in segments if auto_split_base_id(segment.get("id"))]
    short_split_segments = [segment for segment in split_segments if segment_duration(segment) <= 2.0]
    segment_switches = count_speaker_switches(segments)
    processed_switches = count_speaker_switches(processed_turns)
    warnings = []
    if short_islands >= 20:
        warnings.append(f"{short_islands} islas cortas de hablante")
    if raw_overlap["count"] >= 20:
        warnings.append(f"{raw_overlap['count']} solapes crudos")
    if raw_micro_turns >= 20:
        warnings.append(f"{raw_micro_turns} micro-turnos")
    return {
        "version": 1,
        "created_at": int(time.time() * 1000),
        "duration": round(duration, 3),
        "raw_turns": len(raw_turns),
        "processed_turns": len(processed_turns),
        "segments": len(segments),
        "raw_micro_turns": raw_micro_turns,
        "raw_adjacent_overlaps": raw_overlap,
        "segment_adjacent_overlaps": segment_overlap,
        "short_speaker_islands": short_islands,
        "auto_split_segments": len(split_segments),
        "short_auto_split_segments": len(short_split_segments),
        "processed_turn_switches_per_minute": round(processed_switches / minutes, 2),
        "segment_switches_per_minute": round(segment_switches / minutes, 2),
        "speaker_distribution": speaker_distribution(segments),
        "warnings": warnings,
    }


def format_diarization_quality_warning(quality: dict[str, Any]) -> str:
    short_islands = int(quality.get("short_speaker_islands") or 0)
    raw_overlap = quality.get("raw_adjacent_overlaps") or {}
    raw_overlap_count = int(raw_overlap.get("count") or 0)
    raw_micro_turns = int(quality.get("raw_micro_turns") or 0)
    short_auto_splits = int(quality.get("short_auto_split_segments") or 0)

    notes = []
    if raw_overlap_count >= 20 or raw_micro_turns >= 20:
        raw_parts = []
        if raw_overlap_count >= 20:
            raw_parts.append(f"{raw_overlap_count} solapes crudos")
        if raw_micro_turns >= 20:
            raw_parts.append(f"{raw_micro_turns} micro-turnos")
        notes.append(f"se suavizo una separacion de hablantes inestable ({', '.join(raw_parts)})")
    if short_islands >= 20:
        notes.append(f"quedan {short_islands} cambios breves de hablante para revisar")
    if short_auto_splits >= 20:
        notes.append(f"quedan {short_auto_splits} segmentos divididos muy cortos")
    if not notes:
        return ""
    return "Separacion de hablantes: " + "; ".join(notes) + "."


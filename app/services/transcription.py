from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any


def parse_time_value(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value) / 1000.0 if value > 10000 else float(value)
    if not isinstance(value, str):
        return 0.0
    text = value.strip().replace(",", ".")
    parts = text.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(text)
    except ValueError:
        return 0.0


def parse_whisper_time(offset_value: Any, timestamp_value: Any, fallback: Any = 0) -> float:
    if isinstance(offset_value, (int, float)):
        return float(offset_value) / 1000.0
    if isinstance(offset_value, str) and offset_value.strip().isdigit():
        return float(offset_value.strip()) / 1000.0
    return parse_time_value(timestamp_value if timestamp_value is not None else fallback)


def parse_whisper_json(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_segments = data.get("transcription") or data.get("segments") or []
    segments = []
    for idx, item in enumerate(raw_segments):
        timestamps = item.get("timestamps") or {}
        offsets = item.get("offsets") or {}
        start = parse_whisper_time(offsets.get("from"), timestamps.get("from"), item.get("start", 0))
        end = parse_whisper_time(offsets.get("to"), timestamps.get("to"), item.get("end", start))
        text = (item.get("text") or "").strip()
        if not text:
            continue
        segments.append(
            {
                "id": f"seg-{idx:05d}",
                "start": round(start, 3),
                "end": round(max(end, start), 3),
                "speaker": "SPEAKER_00",
                "text": text,
            }
        )
    return segments


TIMESTAMP_RE = re.compile(
    r"\[(?P<start>\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(?P<end>\d{2}:\d{2}:\d{2}[,.]\d{3})\]\s*(?P<text>.*)"
)


def parse_whisper_stdout(text: str) -> list[dict[str, Any]]:
    segments = []
    for line in text.splitlines():
        match = TIMESTAMP_RE.search(line)
        if not match:
            continue
        body = match.group("text").strip()
        if not body:
            continue
        idx = len(segments)
        segments.append(
            {
                "id": f"seg-{idx:05d}",
                "start": round(parse_time_value(match.group("start")), 3),
                "end": round(parse_time_value(match.group("end")), 3),
                "speaker": "SPEAKER_00",
                "text": body,
            }
        )
    return segments


def normalize_repetition_key(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", (text or "").lower())
    normalized = "".join(char for char in normalized if not unicodedata.combining(char))
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def repeated_clause_keep_limit(key: str) -> int:
    words = key.split()
    if len(words) <= 1 and key in {"si", "no", "ya", "ah"}:
        return 2
    return 1


def last_clause_key(text: str) -> str:
    parts = [part.strip() for part in (text or "").split(",") if part.strip()]
    return normalize_repetition_key(parts[-1]) if parts else normalize_repetition_key(text)


def collapse_repeated_clauses(text: str) -> tuple[str, dict[str, Any]]:
    original = (text or "").strip()
    parts = [part.strip() for part in original.split(",")]
    if len([part for part in parts if part]) < 3:
        return original, {}

    kept: list[str] = []
    removed: Counter[str] = Counter()
    previous_key = ""
    repeat_count = 0
    for part in parts:
        if not part:
            continue
        key = normalize_repetition_key(part)
        if not key:
            kept.append(part)
            previous_key = ""
            repeat_count = 0
            continue
        if key == previous_key:
            repeat_count += 1
        else:
            previous_key = key
            repeat_count = 1
        if repeat_count > repeated_clause_keep_limit(key):
            removed[key] += 1
            continue
        kept.append(part)

    if not removed:
        return original, {}
    cleaned = ", ".join(kept).strip()
    if cleaned and original and original[-1] in ".?!" and cleaned[-1] not in ".?!":
        cleaned += original[-1]
    return cleaned, {"removed_clauses": dict(removed)}


def internal_loop_candidates(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for segment in segments:
        text = (segment.get("text") or "").strip()
        cleaned, cleanup = collapse_repeated_clauses(text)
        removed = cleanup.get("removed_clauses") or {}
        if not removed:
            continue
        total_removed = sum(int(value) for value in removed.values())
        if total_removed < 3:
            continue
        example, count = max(removed.items(), key=lambda item: item[1])
        candidates.append(
            {
                "text": example,
                "count": int(count) + repeated_clause_keep_limit(example),
                "removed": total_removed,
                "internal": True,
                "start": round(float(segment.get("start", 0)), 3),
                "end": round(float(segment.get("end", 0)), 3),
                "cleaned": cleaned,
            }
        )
    return candidates


def merge_cleanup_data(*items: dict[str, Any]) -> dict[str, Any]:
    merged_dropped: Counter[str] = Counter()
    ranges: list[dict[str, Any]] = []
    text_cleanups: list[dict[str, Any]] = []
    for item in items:
        if not item:
            continue
        merged_dropped.update(item.get("dropped") or {})
        ranges.extend(item.get("ranges") or [])
        text_cleanups.extend(item.get("text_cleanups") or [])
    result: dict[str, Any] = {}
    if merged_dropped:
        result["dropped"] = dict(merged_dropped)
    if ranges:
        result["ranges"] = ranges
    if text_cleanups:
        result["text_cleanups"] = text_cleanups
    return result


def sanitize_internal_loop_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cleaned_segments: list[dict[str, Any]] = []
    dropped: Counter[str] = Counter()
    ranges: list[dict[str, Any]] = []
    text_cleanups: list[dict[str, Any]] = []

    for segment in segments:
        start = float(segment.get("start", 0))
        end = float(segment.get("end", start))
        text = (segment.get("text") or "").strip()
        cleaned_text, text_cleanup = collapse_repeated_clauses(text)
        removed_clauses = text_cleanup.get("removed_clauses") or {}
        heavy_internal_loop = sum(int(value) for value in removed_clauses.values()) >= 3
        key = normalize_repetition_key(cleaned_text)
        duration = max(0.0, end - start)

        previous = cleaned_segments[-1] if cleaned_segments else None
        previous_key = normalize_repetition_key(previous.get("text", "")) if previous else ""
        previous_last_clause = last_clause_key(previous.get("text", "")) if previous else ""
        same_timestamp = (
            previous is not None
            and abs(start - float(previous.get("start", 0))) <= 0.15
            and abs(end - float(previous.get("end", 0))) <= 0.15
        )
        repeated_zero_segment = (
            duration <= 0.15
            and previous is not None
            and same_timestamp
            and key
            and (
                key == previous_key
                or key in previous_key
                or previous_key in key
                or (previous_last_clause and key.startswith(previous_last_clause))
            )
        )

        if (duration <= 0.15 and heavy_internal_loop) or repeated_zero_segment:
            dropped[key or normalize_repetition_key(text) or "segmento vacio"] += 1
            ranges.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "text": normalize_repetition_key(text)[:120],
                    "reason": "internal_loop" if heavy_internal_loop else "zero_duration_repeat",
                }
            )
            continue

        updated = {**segment, "text": cleaned_text}
        if removed_clauses and cleaned_text != text:
            text_cleanups.append(
                {
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "removed": dict(removed_clauses),
                    "before": text[:240],
                    "after": cleaned_text[:240],
                }
            )
        cleaned_segments.append(updated)

    return cleaned_segments, merge_cleanup_data(
        {"dropped": dict(dropped), "ranges": ranges},
        {"text_cleanups": text_cleanups},
    )

def format_seconds_label(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    whole = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{whole:02d}"



def shift_segments(segments: list[dict[str, Any]], offset: float, id_prefix: str) -> list[dict[str, Any]]:
    shifted = []
    for idx, segment in enumerate(segments):
        start = round(float(segment.get("start", 0)) + offset, 3)
        end = round(float(segment.get("end", start)) + offset, 3)
        shifted.append(
            {
                **segment,
                "id": f"{id_prefix}-{idx:05d}",
                "start": start,
                "end": max(end, start),
            }
        )
    return shifted


def write_combined_whisper_json(output_base: Path, segments: list[dict[str, Any]]) -> None:
    payload = {
        "transcription": [
            {
                "offsets": {
                    "from": int(round(float(segment.get("start", 0)) * 1000)),
                    "to": int(round(float(segment.get("end", 0)) * 1000)),
                },
                "text": segment.get("text", ""),
            }
            for segment in segments
        ]
    }
    output_base.with_suffix(".json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    output_base.with_suffix(".txt").write_text("\n".join(segment.get("text", "") for segment in segments), encoding="utf-8")

def split_time_range(start: float, end: float, chunk_seconds: float) -> list[tuple[float, float]]:
    ranges = []
    cursor = start
    while cursor < end - 0.01:
        next_end = min(end, cursor + chunk_seconds)
        ranges.append((round(cursor, 3), round(next_end, 3)))
        cursor = next_end
    return ranges


def loop_candidates(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = [normalize_repetition_key(segment.get("text", "")) for segment in segments]
    keys = [key for key in keys if key]
    candidates = internal_loop_candidates(segments)
    if len(keys) < 4:
        return candidates
    counts = Counter(keys)
    total = len(keys)
    for key, count in counts.items():
        words = key.split()
        ratio = count / total
        if len(words) == 1:
            suspicious = count >= 18 and ratio >= 0.45
        else:
            suspicious = len(words) <= 10 and count >= 6 and (ratio >= 0.25 or count >= 10)
        if suspicious:
            candidates.append({"text": key, "count": count, "ratio": round(ratio, 3)})

    tail = keys[-10:]
    if len(tail) >= 5:
        tail_counts = Counter(tail)
        key, count = tail_counts.most_common(1)[0]
        if count >= 4 and len(key.split()) <= 10 and not any(item["text"] == key for item in candidates):
            candidates.append({"text": key, "count": count, "ratio": round(count / len(tail), 3), "tail": True})
    return dedupe_loop_candidates(candidates)


def dedupe_loop_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for item in candidates:
        key = normalize_repetition_key(str(item.get("text") or ""))
        if not key:
            continue
        count = int(item.get("count") or 0)
        current = merged.get(key)
        if current is None or count > int(current.get("count") or 0):
            merged[key] = {**item, "text": key, "count": count}
            continue
        for flag in ("internal", "tail"):
            if item.get(flag):
                current[flag] = True
        if item.get("removed"):
            current["removed"] = int(current.get("removed") or 0) + int(item.get("removed") or 0)
    return sorted(merged.values(), key=lambda item: int(item["count"]), reverse=True)


def summarize_quality_issues(issues: list[dict[str, Any]]) -> str:
    if not issues:
        return "resultado dudoso"
    return "; ".join(str(issue.get("message") or issue.get("type") or "resultado dudoso") for issue in issues[:3])


def sanitize_local_loop_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    segments, internal_cleanup = sanitize_internal_loop_segments(segments)
    if len(segments) < 8:
        return segments, internal_cleanup
    keys = [normalize_repetition_key(segment.get("text", "")) for segment in segments]
    counts = Counter(key for key in keys if key)
    total = max(1, len(keys))
    loop_keys = {
        key
        for key, count in counts.items()
        if key
        and 2 <= len(key.split()) <= 10
        and count >= 6
        and (count / total >= 0.25 or count >= 10)
    }
    if not loop_keys:
        return segments, internal_cleanup

    seen: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    dropped_ranges: list[dict[str, Any]] = []
    cleaned: list[dict[str, Any]] = []
    for segment, key in zip(segments, keys):
        if key in loop_keys:
            seen[key] += 1
            if seen[key] > 3:
                dropped[key] += 1
                dropped_ranges.append(
                    {
                        "start": round(float(segment.get("start", 0)), 3),
                        "end": round(float(segment.get("end", 0)), 3),
                        "text": key,
                    }
                )
                continue
        cleaned.append(segment)
    return cleaned, merge_cleanup_data(internal_cleanup, {"dropped": dict(dropped), "ranges": dropped_ranges})


def sanitize_whisper_loops_with_ranges(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    segments, internal_cleanup = sanitize_internal_loop_segments(segments)
    if len(segments) < 80:
        return segments, internal_cleanup

    keys = [normalize_repetition_key(segment.get("text", "")) for segment in segments]
    counts = Counter(key for key in keys if key)
    threshold = max(30, int(len(segments) * 0.02))
    loop_keys = {
        key
        for key, count in counts.items()
        if count >= threshold and 2 <= len(key.split()) <= 10 and len(key) <= 100
    }
    if not loop_keys:
        return segments, internal_cleanup

    seen: Counter[str] = Counter()
    dropped: Counter[str] = Counter()
    ranges: list[dict[str, Any]] = []
    cleaned: list[dict[str, Any]] = []
    for segment, key in zip(segments, keys):
        if key in loop_keys:
            seen[key] += 1
            if seen[key] > 8:
                dropped[key] += 1
                ranges.append(
                    {
                        "start": round(float(segment.get("start", 0)), 3),
                        "end": round(float(segment.get("end", 0)), 3),
                        "text": key,
                    }
                )
                continue
        cleaned.append(segment)
    return cleaned, merge_cleanup_data(internal_cleanup, {"dropped": dict(dropped), "ranges": ranges})


def format_cleanup_warning(cleanup: dict[str, Any]) -> str:
    dropped = cleanup.get("dropped") or {}
    text_cleanups = cleanup.get("text_cleanups") or []
    if not dropped and not text_cleanups:
        return ""
    parts = []
    if dropped:
        total = sum(int(value) for value in dropped.values())
        examples = ", ".join(
            f"{key}: {count}" for key, count in sorted(dropped.items(), key=lambda item: item[1], reverse=True)[:3]
        )
        parts.append(f"removio {total} segmento(s) repetidos ({examples})")
    if text_cleanups:
        parts.append(f"corrigio repeticiones internas en {len(text_cleanups)} segmento(s)")
    ranges = cleanup.get("ranges") or []
    if ranges:
        first = ranges[0]
        span = f"{format_seconds_label(first['start'])}-{format_seconds_label(first['end'])}"
    elif text_cleanups:
        first = text_cleanups[0]
        span = f"{format_seconds_label(first['start'])}-{format_seconds_label(first['end'])}"
    else:
        span = "sin rango"
    return f"Whisper corrigio repeticiones: {' y '.join(parts)}. Primer rango para revisar: {span}."


def review_segments_for_quality(
    issues: list[dict[str, Any]],
    core_start: float,
    core_end: float,
) -> list[dict[str, Any]]:
    review_ranges: list[tuple[float, float, str]] = []
    for issue in issues:
        issue_type = issue.get("type")
        if issue_type == "no_text_non_silent":
            review_ranges.append((core_start, core_end, "audio_no_recuperado"))
        if issue_type == "non_silent_gap":
            for gap in issue.get("gaps") or []:
                review_ranges.append(
                    (
                        max(core_start, float(gap.get("start", core_start))),
                        min(core_end, float(gap.get("end", core_end))),
                        "gap_con_audio",
                    )
                )

    segments = []
    seen: set[tuple[int, int]] = set()
    for start, end, reason in review_ranges:
        if end - start < 0.5:
            continue
        key = (int(round(start * 1000)), int(round(end * 1000)))
        if key in seen:
            continue
        seen.add(key)
        segments.append(
            {
                "id": f"review-{key[0]}-{key[1]}",
                "start": round(start, 3),
                "end": round(end, 3),
                "speaker": "SPEAKER_00",
                "text": (
                    "[Audio no recuperado con confianza entre "
                    f"{format_seconds_label(start)} y {format_seconds_label(end)}. Revisar manualmente.]"
                ),
                "needs_review": True,
                "review_reason": reason,
            }
        )
    return segments

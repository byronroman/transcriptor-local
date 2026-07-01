from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sherpa_onnx


DEFAULT_SPEAKERS = 2
DEFAULT_CHUNK_SECONDS = 180.0


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    sample_width: int
    frames: int

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


def log(message: str) -> None:
    print(message, flush=True)


def progress(percent: float, message: str) -> None:
    value = max(0.0, min(100.0, percent))
    print(f"DIARIZE_PROGRESS {value:.1f} {message}", flush=True)


def write_json_atomic(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def read_json_or_none(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def format_seconds(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    rest = int(seconds % 60)
    return f"{minutes:02d}:{rest:02d}"


def read_wav_info(path: Path) -> WavInfo:
    with wave.open(str(path), "rb") as wav:
        info = WavInfo(
            sample_rate=wav.getframerate(),
            channels=wav.getnchannels(),
            sample_width=wav.getsampwidth(),
            frames=wav.getnframes(),
        )
    if info.sample_width != 2:
        raise RuntimeError("La diarizacion espera WAV PCM 16-bit.")
    return info


def read_wav_chunk_float32(path: Path, start_frame: int, frame_count: int) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wav:
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        total_frames = wav.getnframes()
        if sample_width != 2:
            raise RuntimeError("La diarizacion espera WAV PCM 16-bit.")
        start_frame = max(0, min(start_frame, total_frames))
        frame_count = max(0, min(frame_count, total_frames - start_frame))
        wav.setpos(start_frame)
        frames = wav.readframes(frame_count)
    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, sample_rate


def diarization_model_paths(models_dir: Path) -> tuple[Path, Path]:
    segmentation_dir = models_dir / "diarization" / "sherpa-onnx-pyannote-segmentation-3-0"
    int8_model = segmentation_dir / "model.int8.onnx"
    segmentation_model = int8_model if int8_model.exists() else segmentation_dir / "model.onnx"
    embedding_model = models_dir / "diarization" / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    return segmentation_model, embedding_model


def build_diarizer(models_dir: Path, effective_speakers: int) -> tuple[sherpa_onnx.OfflineSpeakerDiarization, Path]:
    segmentation_model, embedding_model = diarization_model_paths(models_dir)

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(segmentation_model)
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_model)),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=effective_speakers,
            threshold=0.5,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("La configuracion de diarizacion no es valida.")
    return sherpa_onnx.OfflineSpeakerDiarization(config), segmentation_model


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def next_speaker_label(existing: set[str]) -> str:
    index = 0
    while True:
        label = f"SPEAKER_{index:02d}"
        if label not in existing:
            return label
        index += 1


def stabilize_speakers(
    current_turns: list[dict[str, float | str]],
    previous_turns: list[dict[str, float | str]],
    known_speakers: set[str],
    max_speakers: int | None = None,
) -> list[dict[str, float | str]]:
    if not current_turns:
        return []

    local_speakers = sorted({str(turn["speaker"]) for turn in current_turns})
    expected_speakers = {f"SPEAKER_{index:02d}" for index in range(max_speakers or 0)}
    mapping: dict[str, str] = {}
    used_global: set[str] = set()
    scores: dict[tuple[str, str], float] = {}

    for current in current_turns:
        current_speaker = str(current["speaker"])
        for previous in previous_turns:
            previous_speaker = str(previous["speaker"])
            value = overlap(
                float(current["start"]),
                float(current["end"]),
                float(previous["start"]),
                float(previous["end"]),
            )
            if value > 0:
                scores[(current_speaker, previous_speaker)] = scores.get((current_speaker, previous_speaker), 0.0) + value

    ranked_scores = sorted(
        ((score, local, global_) for (local, global_), score in scores.items()),
        reverse=True,
    )
    for score, local, global_ in ranked_scores:
        if score < 0.25 or local in mapping or global_ in used_global:
            continue
        mapping[local] = global_
        used_global.add(global_)

    for local in local_speakers:
        if local in mapping:
            continue
        if (local in known_speakers or local in expected_speakers) and local not in used_global:
            mapping[local] = local
            used_global.add(local)
            continue
        candidates = sorted((known_speakers | expected_speakers) - used_global)
        if candidates:
            mapping[local] = candidates[0]
            used_global.add(candidates[0])
            continue
        if expected_speakers:
            mapping[local] = sorted(expected_speakers)[0]
            continue
        label = next_speaker_label(known_speakers | used_global | set(mapping.values()))
        mapping[local] = label
        used_global.add(label)

    return [
        {
            "start": float(turn["start"]),
            "end": float(turn["end"]),
            "speaker": mapping[str(turn["speaker"])],
        }
        for turn in current_turns
    ]


def clip_turns(
    turns: list[dict[str, float | str]],
    start: float,
    end: float,
) -> list[dict[str, float | str]]:
    clipped = []
    for turn in turns:
        clipped_start = max(float(turn["start"]), start)
        clipped_end = min(float(turn["end"]), end)
        if clipped_end - clipped_start < 0.08:
            continue
        clipped.append(
            {
                "start": clipped_start,
                "end": clipped_end,
                "speaker": str(turn["speaker"]),
            }
        )
    return clipped


def merge_turns(turns: list[dict[str, float | str]]) -> list[dict[str, float | str]]:
    merged: list[dict[str, float | str]] = []
    for turn in sorted(turns, key=lambda item: (float(item["start"]), float(item["end"]))):
        speaker = str(turn["speaker"])
        start = round(float(turn["start"]), 3)
        end = round(float(turn["end"]), 3)
        if end <= start:
            continue
        if merged and merged[-1]["speaker"] == speaker and start - float(merged[-1]["end"]) <= 0.35:
            merged[-1]["end"] = max(float(merged[-1]["end"]), end)
            continue
        merged.append({"start": start, "end": end, "speaker": speaker})
    return merged


def diarize_array(
    diarizer: sherpa_onnx.OfflineSpeakerDiarization,
    audio: np.ndarray,
    offset: float,
) -> list[dict[str, float | str]]:
    if audio.size == 0:
        return []
    result = diarizer.process(audio).sort_by_start_time()
    return [
        {
            "start": float(item.start) + offset,
            "end": float(item.end) + offset,
            "speaker": f"SPEAKER_{int(item.speaker):02d}",
        }
        for item in result
    ]


def run_chunk_worker(
    wav_path: Path,
    models_dir: Path,
    output: Path,
    effective_speakers: int,
    read_start: float,
    read_end: float,
) -> int:
    diarizer, _ = build_diarizer(models_dir, effective_speakers)
    info = read_wav_info(wav_path)
    if info.sample_rate != diarizer.sample_rate:
        raise RuntimeError(f"Audio a {info.sample_rate} Hz, diarizacion espera {diarizer.sample_rate} Hz.")

    start_frame = int(round(read_start * info.sample_rate))
    end_frame = int(round(read_end * info.sample_rate))
    frame_count = max(0, end_frame - start_frame)
    audio, sample_rate = read_wav_chunk_float32(wav_path, start_frame, frame_count)
    if sample_rate != diarizer.sample_rate:
        raise RuntimeError(f"Audio a {sample_rate} Hz, diarizacion espera {diarizer.sample_rate} Hz.")

    turns = diarize_array(diarizer, audio, read_start)
    output.write_text(json.dumps(turns, ensure_ascii=False), encoding="utf-8")
    return 0


def run_isolated_chunk(
    wav_path: Path,
    models_dir: Path,
    chunk_output: Path,
    effective_speakers: int,
    read_start: float,
    read_end: float,
) -> list[dict[str, float | str]]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--wav",
        str(wav_path),
        "--models-dir",
        str(models_dir),
        "--output",
        str(chunk_output),
        "--speakers",
        str(effective_speakers),
        "--worker-start",
        str(read_start),
        "--worker-end",
        str(read_end),
    ]
    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stdout or "").strip()
        if result.returncode < 0:
            detail = f"worker terminado por senal {-result.returncode}." + (f"\n{detail}" if detail else "")
        elif not detail:
            detail = f"worker termino con codigo {result.returncode}, sin salida adicional."
        raise RuntimeError(detail)
    if not chunk_output.exists():
        raise RuntimeError("worker termino sin generar salida.")
    try:
        return json.loads(chunk_output.read_text(encoding="utf-8"))
    finally:
        try:
            chunk_output.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True)
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--speakers", type=int)
    parser.add_argument("--chunk-seconds", type=float, default=DEFAULT_CHUNK_SECONDS)
    parser.add_argument("--chunk-overlap-seconds", type=float, default=3.0)
    parser.add_argument("--worker-start", type=float)
    parser.add_argument("--worker-end", type=float)
    args = parser.parse_args()

    wav_path = Path(args.wav)
    output = Path(args.output)
    models_dir = Path(args.models_dir)
    effective_speakers = args.speakers or DEFAULT_SPEAKERS

    if args.worker_start is not None or args.worker_end is not None:
        if args.worker_start is None or args.worker_end is None:
            raise RuntimeError("worker-start y worker-end deben usarse juntos.")
        return run_chunk_worker(
            wav_path=wav_path,
            models_dir=models_dir,
            output=output,
            effective_speakers=effective_speakers,
            read_start=args.worker_start,
            read_end=args.worker_end,
        )

    info = read_wav_info(wav_path)
    segmentation_model, _ = diarization_model_paths(models_dir)

    chunk_seconds = max(30.0, float(args.chunk_seconds))
    overlap_seconds = max(0.0, min(float(args.chunk_overlap_seconds), chunk_seconds / 4))
    total_chunks = max(1, math.ceil(info.duration / chunk_seconds))
    partial_output = output.with_suffix(output.suffix + ".partial")
    manifest_path = output.with_name("diarization_manifest.json")
    chunks_dir = output.with_name("diarization_chunks")
    chunks_dir.mkdir(parents=True, exist_ok=True)
    audio_signature = {
        "path": str(wav_path),
        "size": wav_path.stat().st_size,
        "sha256": sha256_file(wav_path),
        "duration": round(info.duration, 3),
    }
    all_turns: list[dict[str, float | str]] = []
    previous_full_turns: list[dict[str, float | str]] = []
    known_speakers: set[str] = set()

    def new_manifest() -> dict:
        return {
            "version": 1,
            "stage": "diarization",
            "audio": audio_signature,
            "speakers": effective_speakers,
            "settings": {
                "chunk_seconds": chunk_seconds,
                "overlap_seconds": overlap_seconds,
                "segmentation_model": segmentation_model.name,
            },
            "chunks": [
                {
                    "index": index,
                    "core_start": round(index * chunk_seconds, 3),
                    "core_end": round(min(info.duration, (index + 1) * chunk_seconds), 3),
                    "status": "pending",
                }
                for index in range(total_chunks)
            ],
        }

    def compatible_manifest(payload) -> bool:
        if not isinstance(payload, dict):
            return False
        settings = payload.get("settings") or {}
        audio = payload.get("audio") or {}
        return (
            payload.get("version") == 1
            and payload.get("speakers") == effective_speakers
            and audio.get("sha256") == audio_signature["sha256"]
            and abs(float(audio.get("duration", 0)) - info.duration) < 0.01
            and float(settings.get("chunk_seconds", 0)) == chunk_seconds
            and float(settings.get("overlap_seconds", 0)) == overlap_seconds
            and settings.get("segmentation_model") == segmentation_model.name
        )

    manifest = read_json_or_none(manifest_path)
    if not compatible_manifest(manifest):
        manifest = new_manifest()

    def write_manifest() -> None:
        manifest["stage"] = "diarization"
        write_json_atomic(manifest_path, manifest)

    def accepted_chunk_path(chunk_index: int) -> Path:
        return chunks_dir / f"chunk_{chunk_index:04d}.json"

    def load_accepted_chunk(chunk_index: int):
        chunk = manifest["chunks"][chunk_index]
        if chunk.get("status") != "accepted":
            return None
        payload = read_json_or_none(accepted_chunk_path(chunk_index))
        if not isinstance(payload, dict):
            chunk["status"] = "pending"
            return None
        if not isinstance(payload.get("core_turns"), list):
            chunk["status"] = "pending"
            return None
        return payload

    def save_accepted_chunk(
        chunk_index: int,
        core_turns: list[dict[str, float | str]],
        mapped_turns: list[dict[str, float | str]],
    ) -> None:
        payload = {
            "version": 1,
            "index": chunk_index,
            "core_turns": core_turns,
            "mapped_turns": mapped_turns,
            "known_speakers": sorted(known_speakers),
        }
        write_json_atomic(accepted_chunk_path(chunk_index), payload)
        manifest["chunks"][chunk_index].update(
            {
                "status": "accepted",
                "turn_count": len(core_turns),
                "accepted_path": str(accepted_chunk_path(chunk_index).relative_to(output.parent)),
            }
        )
        write_manifest()

    write_manifest()

    log(
        "INFO diarizacion chunked: "
        f"duracion={format_seconds(info.duration)} "
        f"chunk={int(chunk_seconds)}s overlap={overlap_seconds:.1f}s "
        f"speakers={effective_speakers} "
        f"isolated=1 "
        f"modelo={segmentation_model.name}"
    )
    progress(0, "Preparando diarizacion por tramos")

    for chunk_index in range(total_chunks):
        chunk_start = chunk_index * chunk_seconds
        chunk_end = min(info.duration, chunk_start + chunk_seconds)
        read_start = max(0.0, chunk_start - overlap_seconds)
        read_end = min(info.duration, chunk_end + overlap_seconds)
        start_frame = int(round(read_start * info.sample_rate))
        end_frame = int(round(read_end * info.sample_rate))
        frame_count = max(0, end_frame - start_frame)
        chunk_pct = (chunk_index / total_chunks) * 100.0
        label = (
            f"Tramo {chunk_index + 1}/{total_chunks} "
            f"({format_seconds(chunk_start)}-{format_seconds(chunk_end)})"
        )
        progress(chunk_pct, label)
        log(f"INFO {label}: leyendo {frame_count} frames")

        accepted = load_accepted_chunk(chunk_index)
        if accepted is not None:
            core_turns = accepted.get("core_turns") or []
            all_turns.extend(core_turns)
            previous_full_turns = accepted.get("mapped_turns") or []
            known_speakers.update(str(turn.get("speaker")) for turn in previous_full_turns)
            known_speakers.update(str(speaker) for speaker in accepted.get("known_speakers") or [])
            partial_output.write_text(
                json.dumps(merge_turns(all_turns), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            log(f"INFO {label}: checkpoint reutilizado, {len(core_turns)} turnos utiles")
            progress(((chunk_index + 1) / total_chunks) * 100.0, f"{label} listo")
            continue

        manifest["chunks"][chunk_index]["status"] = "processing"
        write_manifest()
        chunk_output = output.with_suffix(f".chunk-{chunk_index:03d}.json")
        try:
            raw_turns = run_isolated_chunk(
                wav_path=wav_path,
                models_dir=models_dir,
                chunk_output=chunk_output,
                effective_speakers=effective_speakers,
                read_start=read_start,
                read_end=read_end,
            )
        except Exception as exc:
            manifest["chunks"][chunk_index]["status"] = "failed"
            manifest["chunks"][chunk_index]["error"] = str(exc)
            write_manifest()
            raise
        mapped_turns = stabilize_speakers(raw_turns, previous_full_turns, known_speakers, effective_speakers)
        known_speakers.update(str(turn["speaker"]) for turn in mapped_turns)
        core_turns = clip_turns(mapped_turns, chunk_start, chunk_end)
        all_turns.extend(core_turns)
        previous_full_turns = mapped_turns

        partial_output.write_text(
            json.dumps(merge_turns(all_turns), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        save_accepted_chunk(chunk_index, core_turns, mapped_turns)
        log(f"INFO {label}: {len(core_turns)} turnos utiles, {len(known_speakers)} hablante(s)")
        progress(((chunk_index + 1) / total_chunks) * 100.0, f"{label} listo")

    turns = merge_turns(all_turns)
    write_json_atomic(output, turns)
    manifest["stage"] = "diarization_done"
    write_json_atomic(manifest_path, manifest)
    try:
        partial_output.unlink()
    except FileNotFoundError:
        pass
    progress(100, f"Diarizacion terminada: {len(turns)} turnos")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

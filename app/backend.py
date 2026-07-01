from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import math
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
import wave
import webbrowser
import zipfile
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles


from app.config import (
    ALLOWED_IMPORT_AUDIO_SUFFIXES,
    ALLOWED_PACKAGE_DIAGNOSTICS,
    BROWSER_SETTINGS_FORMAT,
    BROWSER_SETTINGS_MEMBER,
    DATA_DIR,
    DEFAULT_DIARIZATION_SPEAKERS,
    DIARIZATION_CHUNK_OVERLAP_SECONDS,
    DIARIZATION_CHUNK_SECONDS,
    EXPORTS_DIR,
    EXPORT_TEMP_MAX_AGE_SECONDS,
    EXPORT_TEMP_PREFIX,
    HOST,
    LANGUAGETOOL_DIR,
    LANGUAGETOOL_JAR_PATTERNS,
    LANGUAGETOOL_VERSION,
    MAX_BROWSER_SETTINGS_BYTES,
    MAX_IMPORTED_SEGMENTS,
    MAX_IMPORTED_TEXT_CHARS,
    MAX_IMPORT_PACKAGE_BYTES,
    MAX_PACKAGE_AUDIO_BYTES,
    MAX_PACKAGE_DIAGNOSTIC_BYTES,
    MAX_PACKAGE_JSON_BYTES,
    MAX_PACKAGE_MEMBERS,
    MAX_UPLOAD_AUDIO_BYTES,
    MIN_LANGUAGETOOL_JAVA_MAJOR,
    MODELS_DIR,
    PORT,
    PROCESSING_PROFILES,
    PROJECTS_DIR,
    PROJECT_ID_RE,
    PROJECT_NOT_FOUND_DETAIL,
    ROOT_DIR,
    STATIC_DIR,
    TOOLS_DIR,
    WHISPER_CHUNK_OVERLAP_SECONDS,
    WHISPER_CHUNK_SECONDS,
    WHISPER_MAX_LEN,
    WHISPER_MAX_NON_SILENT_GAP_SECONDS,
    WHISPER_MODEL_INTEGRITY,
    WHISPER_RETRY_CHUNK_SECONDS,
    WHISPER_RMS_SPEECH_THRESHOLD,
)
from app.schemas import (
    JobStopped,
    ProjectUpdate,
    ProofreadBatchItem,
    ProofreadBatchRequest,
    ProofreadRequest,
    RelabelRequest,
    SegmentUpdate,
    ToolPaths,
)
from app.services.exporters import (
    export_docx,
    export_srt,
    export_txt,
    format_clock,
    format_timestamp,
    speaker_name,
)
from app.services import packages as package_service
from app.services import proofread as proofread_service
from app.services import projects as project_service
from app.services import transcription as transcription_service
from app.services.speaker_separation import (
    absorb_micro_turns,
    adjacent_overlap_stats,
    assign_speakers,
    assign_speakers_from_processed_turns,
    auto_split_base_id,
    best_speaker_for_segment,
    choose_interview_speaker,
    compute_diarization_quality,
    count_short_segment_islands,
    count_speaker_switches,
    default_speaker_labels,
    format_diarization_quality_warning,
    is_clear_short_response,
    is_interviewer_ack_like,
    is_prompt_like,
    is_question_like,
    merge_auto_split_segments,
    merge_nearby_same_speaker_turns,
    normalize_turns,
    normalized_text_key,
    overlap,
    postprocess_diarization_turns,
    resolve_turn_overlaps,
    role_speaker_ids,
    segment_duration,
    segment_word_count_value,
    should_split_segment_by_speaker,
    smooth_short_segment_islands,
    speaker_distribution,
    speaker_overlap_scores,
    speaker_parts_for_segment,
    split_text_by_durations,
    suppress_short_turn_islands,
    turn_duration,
)

WHISPER_OPTION_CACHE: dict[str, set[str]] = {}
MODEL_INTEGRITY_CACHE: dict[tuple[str, int, int], Optional[str]] = {}

for directory in (DATA_DIR, PROJECTS_DIR, EXPORTS_DIR, MODELS_DIR, TOOLS_DIR, LANGUAGETOOL_DIR):
    directory.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    normalize_stale_projects()
    yield


JOBS: dict[str, dict[str, Any]] = {}
RUNNING_PROCESSES: dict[str, subprocess.Popen[str]] = {}
JOBS_LOCK = threading.Lock()
PROJECT_FILE_LOCKS: dict[str, threading.Lock] = {}
PROJECT_FILE_LOCKS_LOCK = threading.Lock()
PROOFREAD_TOOL: Any = None
PROOFREAD_LOCK = threading.Lock()
PROOFREAD_STATUS_LOCK = threading.Lock()
PROOFREAD_CACHE_LOCK = threading.Lock()
PROOFREAD_INIT_STARTED = False
PROOFREAD_STATUS: dict[str, Any] = {
    "status": "idle",
    "available": False,
    "local": True,
    "language": "es",
    "message": "Corrector local sin iniciar.",
    "missing": [],
    "updated_at": None,
}
PROOFREAD_CACHE: dict[str, dict[str, Any]] = {}
PROOFREAD_CACHE_ORDER: list[str] = []
PROOFREAD_CACHE_LIMIT = 1200




def now_ms() -> int:
    return int(time.time() * 1000)


def clean_filename(name: str) -> str:
    stem = Path(name).stem or "audio"
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "", stem).strip()
    return stem[:80] or "audio"


def validate_project_id(project_id: str) -> str:
    return project_service.validate_project_id(project_id, PROJECT_ID_RE, PROJECT_NOT_FOUND_DETAIL)


def safe_project_dir(project_id: str) -> Path:
    return project_service.safe_project_dir(project_id, PROJECTS_DIR, PROJECT_ID_RE, PROJECT_NOT_FOUND_DETAIL)


def project_dir(project_id: str) -> Path:
    return safe_project_dir(project_id)


def project_owned_path(project_id: str, raw_path: Any) -> Optional[Path]:
    return project_service.project_owned_path(project_dir(project_id), raw_path)


def path_leaf(raw_path: Any) -> str:
    return project_service.path_leaf(raw_path)


def allowed_audio_file(path: Path) -> bool:
    return project_service.allowed_audio_file(path, ALLOWED_IMPORT_AUDIO_SUFFIXES)


def project_media_fallback(project_id: str, raw_path: Any, role: str, source_name: Any = "") -> Optional[Path]:
    return project_service.project_media_fallback(project_dir(project_id), raw_path, role, ALLOWED_IMPORT_AUDIO_SUFFIXES, source_name)


def project_media_path(project: dict[str, Any], key: str, role: str) -> Optional[Path]:
    return project_service.project_media_path(
        project,
        key,
        role,
        PROJECTS_DIR,
        PROJECT_ID_RE,
        PROJECT_NOT_FOUND_DETAIL,
        ALLOWED_IMPORT_AUDIO_SUFFIXES,
    )


def repair_project_media_paths(project: dict[str, Any]) -> list[str]:
    return project_service.repair_project_media_paths(
        project,
        PROJECTS_DIR,
        PROJECT_ID_RE,
        PROJECT_NOT_FOUND_DETAIL,
        ALLOWED_IMPORT_AUDIO_SUFFIXES,
    )


def metadata_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def project_file_lock(project_id: str) -> threading.Lock:
    project_id = validate_project_id(project_id)
    with PROJECT_FILE_LOCKS_LOCK:
        if project_id not in PROJECT_FILE_LOCKS:
            PROJECT_FILE_LOCKS[project_id] = threading.Lock()
        return PROJECT_FILE_LOCKS[project_id]


def is_retryable_replace_error(error: OSError) -> bool:
    return (
        isinstance(error, PermissionError)
        or getattr(error, "winerror", None) == 5
        or error.errno in {errno.EACCES, errno.EPERM}
    )


def replace_path_with_retry(source: Path, target: Path) -> None:
    delays = (0.05, 0.1, 0.2, 0.4, 0.8)
    for attempt in range(len(delays) + 1):
        try:
            source.replace(target)
            return
        except OSError as error:
            if attempt >= len(delays) or not is_retryable_replace_error(error):
                raise
            time.sleep(delays[attempt])


def recover_project_json(path: Path, text: str, error: json.JSONDecodeError) -> Optional[dict[str, Any]]:
    if error.msg != "Extra data":
        return None
    decoder = json.JSONDecoder()
    try:
        project, end = decoder.raw_decode(text)
    except json.JSONDecodeError:
        return None
    extra = text[end:]
    if extra.strip().strip("}") != "":
        return None
    backup = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
    try:
        shutil.copy2(path, backup)
    except OSError:
        pass
    project["id"] = validate_project_id(path.parent.name)
    save_project(project)
    return project


def load_project(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    path = metadata_path(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    text = path.read_text(encoding="utf-8")
    try:
        project = json.loads(text)
    except json.JSONDecodeError as error:
        recovered = recover_project_json(path, text, error)
        if recovered is not None:
            append_project_log(project_id, "project.json tenia datos extra al final; se creo backup y se reparo automaticamente.")
            project = recovered
        else:
            raise HTTPException(status_code=500, detail=f"project.json corrupto: {error}") from error
    project["id"] = project_id
    repaired_paths = repair_project_media_paths(project)
    if repaired_paths:
        project["updated_at"] = now_ms()
        save_project(project)
        append_project_log(project_id, f"Rutas locales reparadas tras migracion: {', '.join(repaired_paths)}.")
    project["content_revision"] = project_content_revision(project)
    return project


def save_project(project: dict[str, Any]) -> None:
    project["id"] = validate_project_id(str(project["id"]))
    path = metadata_path(project["id"])
    lock = project_file_lock(str(project["id"]))
    with lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
            replace_path_with_retry(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)


def project_content_revision(project: dict[str, Any]) -> int:
    try:
        value = int(project.get("content_revision", 0) or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, value)


def bump_content_revision(project: dict[str, Any]) -> int:
    next_revision = project_content_revision(project) + 1
    project["content_revision"] = next_revision
    return next_revision


def log_path(project_id: str) -> Path:
    return project_dir(project_id) / "process.log"


def processing_manifest_path(project_id: str) -> Path:
    return project_dir(project_id) / "processing_manifest.json"


def diarization_manifest_path(project_id: str) -> Path:
    return project_dir(project_id) / "diarization_manifest.json"


def write_json_atomic(path: Path, payload: dict[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        replace_path_with_retry(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def exports_root() -> Path:
    root = EXPORTS_DIR.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_export_path(project_id: str, suffix: str) -> Path:
    project_id = validate_project_id(project_id)
    suffix = str(suffix or "")
    if not suffix or "\x00" in suffix or "/" in suffix or "\\" in suffix:
        raise HTTPException(status_code=400, detail="Nombre de exportacion invalido.")
    root = exports_root()
    path = (root / f"{project_id}{suffix}").resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Ruta de exportacion invalida.") from exc
    return path


def temporary_export_path(label: str, suffix: str = ".tmp") -> Path:
    label = re.sub(r"[^A-Za-z0-9_-]+", "-", str(label or "export")).strip("-") or "export"
    suffix = str(suffix or ".tmp")
    if "\x00" in suffix or "/" in suffix or "\\" in suffix:
        raise HTTPException(status_code=400, detail="Nombre temporal invalido.")
    return exports_root() / f"{EXPORT_TEMP_PREFIX}{label}-{uuid.uuid4().hex}{suffix}"


def cleanup_stale_export_temps(max_age_seconds: int = EXPORT_TEMP_MAX_AGE_SECONDS) -> None:
    cutoff = time.time() - max(60, int(max_age_seconds))
    for path in exports_root().glob(f"{EXPORT_TEMP_PREFIX}*"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue


def write_export_atomically(output_path: Path, writer: Callable[[Path], None]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cleanup_stale_export_temps()
    tmp = temporary_export_path(output_path.stem, output_path.suffix or ".tmp")
    try:
        writer(tmp)
        replace_path_with_retry(tmp, output_path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def read_json_or_none(path: Path) -> Optional[Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def update_processing_manifest(project_id: str, **values: Any) -> None:
    path = processing_manifest_path(project_id)
    payload = read_json_or_none(path)
    if not isinstance(payload, dict):
        return
    payload.update(values)
    payload["updated_at"] = now_ms()
    write_json_atomic(path, payload)


def append_project_log(project_id: str, message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message.rstrip()}\n"
    path = log_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as out:
        out.write(line)


def read_project_log(project_id: str, limit: int = 12000) -> str:
    path = log_path(project_id)
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace")
    return text[-limit:]


def project_summary(project: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": project.get("id"),
        "name": project.get("name"),
        "status": project.get("status"),
        "created_at": project.get("created_at"),
        "updated_at": project.get("updated_at"),
        "segments": len(project.get("segments") or []),
        "speakers": len(project.get("speaker_labels") or {}),
    }


def list_projects() -> list[dict[str, Any]]:
    normalize_stale_projects()
    projects = []
    for path in sorted(PROJECTS_DIR.glob("*/project.json"), reverse=True):
        try:
            project_id = validate_project_id(path.parent.name)
            project = json.loads(path.read_text(encoding="utf-8"))
            project["id"] = project_id
            projects.append(project)
        except json.JSONDecodeError:
            continue
        except HTTPException:
            continue
    return sorted(projects, key=lambda item: item.get("created_at", 0), reverse=True)


def normalize_stale_projects() -> None:
    stale_statuses = {"queued", "processing", "pausing", "cancelling"}
    for path in PROJECTS_DIR.glob("*/project.json"):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        try:
            project_id = validate_project_id(path.parent.name)
        except HTTPException:
            continue
        project["id"] = project_id
        with JOBS_LOCK:
            has_job = project_id in JOBS or project_id in RUNNING_PROCESSES
        if project.get("status") not in stale_statuses or has_job:
            continue
        warnings = project.get("warnings") or []
        message = "Proceso anterior interrumpido al cerrar o recargar la app. Puedes reanudar o eliminar el proyecto."
        if message not in warnings:
            warnings.append(message)
        project["status"] = "paused"
        project["warnings"] = warnings
        project["error"] = None
        project["updated_at"] = now_ms()
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        replace_path_with_retry(tmp, path)


def which_local(candidates: list[Path], system_names: list[str]) -> Optional[str]:
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    for name in system_names:
        found = shutil.which(name)
        if found:
            return found
    return None


def get_tools() -> ToolPaths:
    ffmpeg_candidates = [
        TOOLS_DIR / "ffmpeg" / "ffmpeg.exe",
        TOOLS_DIR / "ffmpeg" / "ffmpeg",
        TOOLS_DIR / "ffmpeg.exe",
    ]
    whisper_candidates = [
        TOOLS_DIR / "whisper" / "whisper-cli.exe",
        TOOLS_DIR / "whisper" / "whisper-cli",
        TOOLS_DIR / "whisper" / "main.exe",
        TOOLS_DIR / "whisper" / "main",
    ]
    return ToolPaths(
        ffmpeg=which_local(ffmpeg_candidates, ["ffmpeg"]),
        whisper=which_local(whisper_candidates, ["whisper-cli", "whisper-cpp", "main"]),
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def default_processing_profile() -> str:
    return "calidad" if platform.system() == "Darwin" else "seguro_windows"


def normalize_processing_profile(profile: Optional[str]) -> str:
    value = (profile or "auto").strip().lower()
    if value == "auto":
        return default_processing_profile()
    if value not in PROCESSING_PROFILES:
        return default_processing_profile()
    return value


def processing_profile_settings(profile: Optional[str]) -> dict[str, Any]:
    normalized = normalize_processing_profile(profile)
    settings = dict(PROCESSING_PROFILES[normalized])
    settings["name"] = normalized
    settings["retry_chunk_seconds"] = list(settings.get("retry_chunk_seconds") or [])
    return settings


def select_model_for_request(models: list[dict[str, Any]], requested_model: str, profile: str) -> str:
    if not models:
        return "auto"
    if requested_model != "auto" and any(item["name"] == requested_model for item in models):
        return requested_model
    prefer = PROCESSING_PROFILES.get(profile, {}).get("prefer_model")
    if prefer:
        for item in models:
            if str(prefer) in str(item.get("name", "")):
                return str(item["name"])
    return str(models[0]["name"])


def audio_signature(path: Path, duration: float) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path),
        "size": stat.st_size,
        "sha256": sha256_file(path),
        "duration": round(duration, 3),
    }


def model_integrity_error(path: Path) -> Optional[str]:
    expected = WHISPER_MODEL_INTEGRITY.get(path.name)
    if not expected or not path.exists():
        return None
    stat = path.stat()
    expected_size = int(expected.get("size") or 0)
    if expected_size and stat.st_size != expected_size:
        return f"tamano esperado {expected_size} bytes, encontrado {stat.st_size} bytes"
    cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    if cache_key in MODEL_INTEGRITY_CACHE:
        return MODEL_INTEGRITY_CACHE[cache_key]
    expected_hash = str(expected.get("sha256") or "")
    error = None
    if expected_hash:
        actual_hash = sha256_file(path)
        if actual_hash != expected_hash:
            error = f"sha256 esperado {expected_hash}, encontrado {actual_hash}"
    MODEL_INTEGRITY_CACHE[cache_key] = error
    return error


def available_models() -> list[dict[str, Any]]:
    model_dir = MODELS_DIR / "whisper"
    model_dir.mkdir(parents=True, exist_ok=True)
    paths = sorted(
        (path for path in model_dir.glob("*.bin") if not model_integrity_error(path)),
        key=model_rank,
    )
    models = []
    for index, path in enumerate(paths):
        size_mb = path.stat().st_size / (1024 * 1024)
        models.append(
            {
                "name": path.name,
                "path": str(path),
                "size_mb": round(size_mb, 1),
                "recommended": index == 0,
            }
        )
    return models


def model_rank(path: Path) -> tuple[int, str]:
    name = path.name
    is_mac_apple = platform.system() == "Darwin" and platform.machine() == "arm64"
    if is_mac_apple:
        order = [
            "ggml-large-v3.bin",
            "large-v3-q5_0",
            "large-v3-turbo",
            "medium",
            "small",
        ]
    else:
        order = [
            "ggml-large-v3.bin",
            "large-v3-q5_0",
            "large-v3-turbo",
            "medium",
            "small",
        ]
    for index, marker in enumerate(order):
        if marker in name:
            return index, name
    return len(order), name


def diarization_ready() -> dict[str, Any]:
    segmentation = MODELS_DIR / "diarization" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    embedding = MODELS_DIR / "diarization" / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    package_ok = True
    error = None
    try:
        import sherpa_onnx  # noqa: F401
    except Exception as exc:  # pragma: no cover - environment dependent
        package_ok = False
        error = str(exc)
    return {
        "package": package_ok,
        "segmentation_model": segmentation.exists(),
        "embedding_model": embedding.exists(),
        "ready": package_ok and segmentation.exists() and embedding.exists(),
        "error": error,
    }


def update_job(project_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        current = JOBS.setdefault(project_id, {})
        current.update(values)
        status = values.get("status", current.get("status", ""))
    if "step" in values:
        append_project_log(project_id, f"JOB {status}: {values['step']}")


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in job.items()
        if key not in {"process"} and isinstance(value, (str, int, float, bool, type(None)))
    }


def get_stop_request(project_id: str) -> Optional[str]:
    with JOBS_LOCK:
        value = JOBS.get(project_id, {}).get("stop_requested")
        return str(value) if value else None


def clear_stop_request(project_id: str) -> None:
    with JOBS_LOCK:
        if project_id in JOBS:
            JOBS[project_id].pop("stop_requested", None)


def ensure_not_stopped(project_id: str) -> None:
    requested = get_stop_request(project_id)
    if requested in {"paused", "cancelled"}:
        raise JobStopped(requested)


def request_job_stop(project_id: str, status: str) -> dict[str, Any]:
    if status not in {"paused", "cancelled"}:
        raise HTTPException(status_code=400, detail="Estado de detencion invalido")
    project = load_project(project_id)
    if project.get("status") not in {"queued", "processing"}:
        return {"ok": True, "status": project.get("status")}

    ui_status = "pausing" if status == "paused" else "cancelling"
    update_job(
        project_id,
        status=ui_status,
        step="Pausando..." if status == "paused" else "Cancelando...",
        stop_requested=status,
    )
    with JOBS_LOCK:
        process = RUNNING_PROCESSES.get(project_id)
    if process and process.poll() is None:
        append_project_log(project_id, f"Terminando proceso activo con estado solicitado: {status}")
        process.terminate()
    return {"ok": True, "status": ui_status}


def stop_project_for_delete(project_id: str) -> None:
    with JOBS_LOCK:
        process = RUNNING_PROCESSES.get(project_id)
        if project_id in JOBS:
            JOBS[project_id]["stop_requested"] = "cancelled"
            JOBS[project_id]["status"] = "cancelling"
            JOBS[project_id]["step"] = "Eliminando proyecto..."
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def run_command(project_id: str, command: list[str], cwd: Optional[Path] = None) -> subprocess.CompletedProcess[str]:
    ensure_not_stopped(project_id)
    append_project_log(project_id, "RUN " + " ".join(command))
    process = subprocess.Popen(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    with JOBS_LOCK:
        RUNNING_PROCESSES[project_id] = process
    try:
        output, _ = process.communicate()
    finally:
        with JOBS_LOCK:
            if RUNNING_PROCESSES.get(project_id) is process:
                RUNNING_PROCESSES.pop(project_id, None)
    requested = get_stop_request(project_id)
    if requested in {"paused", "cancelled"}:
        append_project_log(project_id, f"STOP {requested}")
        raise JobStopped(requested)
    append_project_log(project_id, f"EXIT {process.returncode}")
    if output:
        append_project_log(project_id, output[-4000:])
    return subprocess.CompletedProcess(command, process.returncode, output or "", None)


def parse_time_value(value: Any) -> float:
    return transcription_service.parse_time_value(value)


def parse_whisper_time(offset_value: Any, timestamp_value: Any, fallback: Any = 0) -> float:
    return transcription_service.parse_whisper_time(offset_value, timestamp_value, fallback)


def parse_whisper_json(path: Path) -> list[dict[str, Any]]:
    return transcription_service.parse_whisper_json(path)


def parse_whisper_stdout(text: str) -> list[dict[str, Any]]:
    return transcription_service.parse_whisper_stdout(text)

DIARIZE_PROGRESS_RE = re.compile(r"^DIARIZE_PROGRESS\s+(?P<percent>\d+(?:\.\d+)?)\s*(?P<message>.*)$")


def parse_speaker_count(value: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return DEFAULT_DIARIZATION_SPEAKERS
    return parsed if parsed > 0 else DEFAULT_DIARIZATION_SPEAKERS


def normalize_repetition_key(text: str) -> str:
    return transcription_service.normalize_repetition_key(text)


def repeated_clause_keep_limit(key: str) -> int:
    return transcription_service.repeated_clause_keep_limit(key)


def last_clause_key(text: str) -> str:
    return transcription_service.last_clause_key(text)


def collapse_repeated_clauses(text: str) -> tuple[str, dict[str, Any]]:
    return transcription_service.collapse_repeated_clauses(text)


def internal_loop_candidates(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return transcription_service.internal_loop_candidates(segments)


def merge_cleanup_data(*items: dict[str, Any]) -> dict[str, Any]:
    return transcription_service.merge_cleanup_data(*items)


def sanitize_internal_loop_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    return transcription_service.sanitize_internal_loop_segments(segments)


def convert_audio(project: dict[str, Any], tools: ToolPaths) -> Path:
    if not tools.ffmpeg:
        raise RuntimeError("No encontre ffmpeg. Ejecuta el setup otra vez.")
    ensure_not_stopped(project["id"])
    source = project_media_path(project, "source_path", "source")
    if not source or not source.is_file():
        raise RuntimeError("Audio original no encontrado dentro del proyecto.")
    wav_path = project_dir(project["id"]) / "audio_16k.wav"
    command = [
        tools.ffmpeg,
        "-y",
        "-i",
        str(source),
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    result = run_command(project["id"], command)
    if result.returncode != 0 or not wav_path.exists():
        raise RuntimeError(f"ffmpeg fallo:\n{result.stdout[-2000:]}")
    return wav_path


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
    return frames / rate if rate else 0.0


def format_seconds_label(seconds: float) -> str:
    return transcription_service.format_seconds_label(seconds)

def wav_rms(path: Path, start_seconds: float, end_seconds: float) -> float:
    if end_seconds <= start_seconds:
        return 0.0
    with wave.open(str(path), "rb") as wav:
        sample_width = wav.getsampwidth()
        channels = wav.getnchannels()
        rate = wav.getframerate()
        total_frames = wav.getnframes()
        if sample_width != 2 or rate <= 0:
            return 0.0
        start_frame = max(0, min(total_frames, int(round(start_seconds * rate))))
        end_frame = max(start_frame, min(total_frames, int(round(end_seconds * rate))))
        frame_count = end_frame - start_frame
        if frame_count <= 0:
            return 0.0
        wav.setpos(start_frame)
        raw = wav.readframes(frame_count)
    if not raw:
        return 0.0
    import array

    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    if channels > 1:
        samples = array.array("h", samples[::channels])
    if not samples:
        return 0.0
    square_sum = sum(float(sample) * float(sample) for sample in samples)
    return math.sqrt(square_sum / len(samples))


def whisper_supported_options(whisper_path: str) -> set[str]:
    cached = WHISPER_OPTION_CACHE.get(whisper_path)
    if cached is not None:
        return cached
    try:
        result = subprocess.run(
            [whisper_path, "--help"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=8,
            check=False,
        )
        text = result.stdout or ""
    except Exception:
        text = ""
    options = {
        option
        for option in ("--max-context", "--no-fallback", "--suppress-nst", "--max-len", "--split-on-word")
        if option in text
    }
    WHISPER_OPTION_CACHE[whisper_path] = options
    return options


def whisper_strict_args(whisper_path: str) -> list[str]:
    supported = whisper_supported_options(whisper_path)
    args: list[str] = []
    if "--max-context" in supported:
        args.extend(["--max-context", "0"])
    if "--no-fallback" in supported:
        args.append("--no-fallback")
    if "--suppress-nst" in supported:
        args.append("--suppress-nst")
    if "--max-len" in supported:
        args.extend(["--max-len", str(WHISPER_MAX_LEN)])
    if "--split-on-word" in supported:
        args.append("--split-on-word")
    return args


def write_wav_chunk(source: Path, target: Path, start_seconds: float, duration_seconds: float) -> None:
    with wave.open(str(source), "rb") as src:
        params = src.getparams()
        rate = src.getframerate()
        start_frame = max(0, int(round(start_seconds * rate)))
        frame_count = max(0, int(round(duration_seconds * rate)))
        src.setpos(min(start_frame, src.getnframes()))
        frames = src.readframes(min(frame_count, src.getnframes() - min(start_frame, src.getnframes())))
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as out:
        out.setparams(params)
        out.writeframes(frames)


def shift_segments(segments: list[dict[str, Any]], offset: float, id_prefix: str) -> list[dict[str, Any]]:
    return transcription_service.shift_segments(segments, offset, id_prefix)


def write_combined_whisper_json(output_base: Path, segments: list[dict[str, Any]]) -> None:
    transcription_service.write_combined_whisper_json(output_base, segments)

def run_whisper_file(
    project: dict[str, Any],
    audio_path: Path,
    tools: ToolPaths,
    model_path: Path,
    output_base: Path,
    *,
    strict: bool = True,
    allow_empty: bool = False,
    max_threads: int = 4,
) -> list[dict[str, Any]]:
    if not tools.whisper:
        raise RuntimeError("No encontre whisper.cpp. Ejecuta el setup otra vez.")
    threads = str(max(1, min((os.cpu_count() or 2), max_threads)))
    command = [
        tools.whisper,
        "-m",
        str(model_path),
        "-f",
        str(audio_path),
        "-l",
        "es",
        "-t",
        threads,
        *(whisper_strict_args(tools.whisper) if strict else []),
        "-oj",
        "-otxt",
        "-osrt",
        "-ovtt",
        "-of",
        str(output_base),
    ]
    result = run_command(project["id"], command)
    ensure_not_stopped(project["id"])
    json_path = output_base.with_suffix(".json")
    if result.returncode != 0:
        raise RuntimeError(f"whisper.cpp fallo:\n{result.stdout[-2500:]}")
    if json_path.exists():
        segments = parse_whisper_json(json_path)
    else:
        segments = parse_whisper_stdout(result.stdout)
    if not segments:
        txt_path = output_base.with_suffix(".txt")
        if txt_path.exists():
            text = txt_path.read_text(encoding="utf-8", errors="ignore").strip()
            if text:
                segments = [{"id": "seg-00000", "start": 0, "end": 0, "speaker": "SPEAKER_00", "text": text}]
    if not segments:
        if allow_empty:
            return []
        raise RuntimeError("Whisper termino, pero no produjo texto interpretable.")
    return segments


def segment_word_count(segments: list[dict[str, Any]]) -> int:
    return sum(len((segment.get("text") or "").split()) for segment in segments)


def trim_segments_to_core(
    segments: list[dict[str, Any]],
    core_start: float,
    core_end: float,
) -> list[dict[str, Any]]:
    trimmed: list[dict[str, Any]] = []
    for segment in segments:
        start = float(segment.get("start", 0))
        end = float(segment.get("end", start))
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        midpoint = (start + end) / 2 if end > start else start
        if midpoint < core_start or midpoint >= core_end:
            continue
        clipped_start = max(start, core_start)
        clipped_end = min(max(end, clipped_start), core_end)
        trimmed.append(
            {
                **segment,
                "start": round(clipped_start, 3),
                "end": round(clipped_end, 3),
                "text": text,
            }
        )
    return trimmed


def split_time_range(start: float, end: float, chunk_seconds: float) -> list[tuple[float, float]]:
    return transcription_service.split_time_range(start, end, chunk_seconds)


def loop_candidates(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return transcription_service.loop_candidates(segments)


def dedupe_loop_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return transcription_service.dedupe_loop_candidates(candidates)

def non_silent_gaps(
    wav_path: Path,
    core_start: float,
    core_end: float,
    segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    gaps: list[dict[str, Any]] = []
    intervals = sorted(
        (
            max(core_start, float(segment.get("start", 0))),
            min(core_end, float(segment.get("end", 0))),
        )
        for segment in segments
        if (segment.get("text") or "").strip()
    )
    cursor = core_start
    for start, end in intervals:
        if start - cursor >= WHISPER_MAX_NON_SILENT_GAP_SECONDS:
            rms = wav_rms(wav_path, cursor, start)
            if rms >= WHISPER_RMS_SPEECH_THRESHOLD:
                gaps.append(
                    {
                        "start": round(cursor, 3),
                        "end": round(start, 3),
                        "seconds": round(start - cursor, 1),
                        "rms": round(rms, 1),
                    }
                )
        cursor = max(cursor, end)
    if core_end - cursor >= WHISPER_MAX_NON_SILENT_GAP_SECONDS:
        rms = wav_rms(wav_path, cursor, core_end)
        if rms >= WHISPER_RMS_SPEECH_THRESHOLD:
            gaps.append(
                {
                    "start": round(cursor, 3),
                    "end": round(core_end, 3),
                    "seconds": round(core_end - cursor, 1),
                    "rms": round(rms, 1),
                }
            )
    return gaps


def validate_whisper_chunk(
    wav_path: Path,
    segments: list[dict[str, Any]],
    core_start: float,
    core_end: float,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    rms = wav_rms(wav_path, core_start, core_end)
    if not segments and rms >= WHISPER_RMS_SPEECH_THRESHOLD:
        issues.append(
            {
                "type": "no_text_non_silent",
                "message": "Whisper no produjo texto en un tramo con audio detectable",
                "rms": round(rms, 1),
            }
        )

    loops = loop_candidates(segments)
    if loops:
        examples = ", ".join(f"{item['text']} ({item['count']})" for item in loops[:3])
        issues.append(
            {
                "type": "loop",
                "message": f"posible repeticion de Whisper: {examples}",
                "loops": loops[:6],
            }
        )

    gaps = non_silent_gaps(wav_path, core_start, core_end, segments)
    if gaps:
        first = gaps[0]
        issues.append(
            {
                "type": "non_silent_gap",
                "message": (
                    "gap con audio detectable "
                    f"{format_seconds_label(first['start'])}-{format_seconds_label(first['end'])}"
                ),
                "gaps": gaps[:8],
            }
        )

    return {
        "ok": not issues,
        "issues": issues,
        "segment_count": len(segments),
        "word_count": segment_word_count(segments),
        "rms": round(rms, 1),
    }


def summarize_quality_issues(issues: list[dict[str, Any]]) -> str:
    return transcription_service.summarize_quality_issues(issues)


def sanitize_local_loop_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    return transcription_service.sanitize_local_loop_segments(segments)


def sanitize_whisper_loops_with_ranges(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    return transcription_service.sanitize_whisper_loops_with_ranges(segments)


def format_cleanup_warning(cleanup: dict[str, Any]) -> str:
    return transcription_service.format_cleanup_warning(cleanup)


def review_segments_for_quality(
    issues: list[dict[str, Any]],
    core_start: float,
    core_end: float,
) -> list[dict[str, Any]]:
    return transcription_service.review_segments_for_quality(issues, core_start, core_end)

def run_whisper_chunked(
    project: dict[str, Any],
    wav_path: Path,
    tools: ToolPaths,
    model_path: Path,
    profile: str,
    *,
    reset_manifest: bool = False,
) -> list[dict[str, Any]]:
    project_id = project["id"]
    duration = wav_duration(wav_path)
    settings = processing_profile_settings(profile)
    base_chunk_seconds = max(20.0, float(settings["chunk_seconds"]))
    configured_retries = settings.get("retry_chunk_seconds") or WHISPER_RETRY_CHUNK_SECONDS
    retry_sizes = [float(size) for size in configured_retries if 5.0 <= float(size) < base_chunk_seconds]
    chunk_sizes = [base_chunk_seconds, *retry_sizes]
    overlap_seconds = max(0.0, min(float(settings["overlap_seconds"]), base_chunk_seconds / 4))
    max_threads = int(settings.get("max_threads") or 4)
    base_ranges = split_time_range(0.0, duration, base_chunk_seconds)
    total_chunks = max(1, len(base_ranges))
    chunk_dir = project_dir(project_id) / "whisper_chunks"
    output_base = project_dir(project_id) / "whisper"
    manifest_file = processing_manifest_path(project_id)
    audio_info = audio_signature(wav_path, duration)
    all_segments: list[dict[str, Any]] = []
    profile_name = str(settings["name"])

    def new_manifest() -> dict[str, Any]:
        return {
            "version": 1,
            "project_id": project_id,
            "created_at": now_ms(),
            "updated_at": now_ms(),
            "stage": "whisper",
            "model": model_path.name,
            "profile": profile_name,
            "audio": audio_info,
            "whisper": {
                "settings": {
                    "chunk_seconds": base_chunk_seconds,
                    "overlap_seconds": overlap_seconds,
                    "retry_chunk_seconds": retry_sizes,
                    "max_non_silent_gap_seconds": WHISPER_MAX_NON_SILENT_GAP_SECONDS,
                    "rms_speech_threshold": WHISPER_RMS_SPEECH_THRESHOLD,
                    "strict_args": whisper_strict_args(tools.whisper) if tools.whisper else [],
                    "max_threads": max_threads,
                },
                "chunks": [
                    {
                        "index": index,
                        "core_start": start,
                        "core_end": end,
                        "status": "pending",
                    }
                    for index, (start, end) in enumerate(base_ranges)
                ],
                "attempts": [],
                "warnings": [],
            },
        }

    def is_compatible_manifest(payload: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        whisper = payload.get("whisper") or {}
        manifest_audio = payload.get("audio") or {}
        manifest_settings = whisper.get("settings") or {}
        return (
            payload.get("version") == 1
            and payload.get("model") == model_path.name
            and payload.get("profile") == profile_name
            and manifest_audio.get("sha256") == audio_info["sha256"]
            and abs(float(manifest_audio.get("duration", 0)) - duration) < 0.01
            and float(manifest_settings.get("chunk_seconds", 0)) == base_chunk_seconds
            and float(manifest_settings.get("overlap_seconds", 0)) == overlap_seconds
        )

    if reset_manifest:
        shutil.rmtree(chunk_dir, ignore_errors=True)
        manifest_file.unlink(missing_ok=True)

    existing_manifest = read_json_or_none(manifest_file)
    if is_compatible_manifest(existing_manifest):
        manifest = existing_manifest
        manifest["stage"] = "whisper"
        manifest["updated_at"] = now_ms()
    else:
        if existing_manifest:
            append_project_log(project_id, "Manifest de procesamiento incompatible; se reiniciaran checkpoints de Whisper.")
        shutil.rmtree(chunk_dir, ignore_errors=True)
        manifest = new_manifest()

    chunk_dir.mkdir(parents=True, exist_ok=True)

    def write_manifest() -> None:
        manifest["updated_at"] = now_ms()
        write_json_atomic(manifest_file, manifest)

    write_manifest()
    whisper_manifest = manifest["whisper"]
    attempts: list[dict[str, Any]] = list(whisper_manifest.get("attempts") or [])
    quality_warnings: list[str] = list(dict.fromkeys(whisper_manifest.get("warnings") or []))
    attempt_counter = max([int(attempt.get("index") or 0) for attempt in attempts] or [0])

    def accepted_chunk_path(chunk_index: int) -> Path:
        return chunk_dir / f"chunk_{chunk_index:04d}" / "accepted.json"

    def chunk_meta(chunk_index: int) -> dict[str, Any]:
        chunks = whisper_manifest.setdefault("chunks", [])
        while len(chunks) <= chunk_index:
            start, end = base_ranges[len(chunks)]
            chunks.append({"index": len(chunks), "core_start": start, "core_end": end, "status": "pending"})
        return chunks[chunk_index]

    def load_accepted_chunk(chunk_index: int) -> Optional[list[dict[str, Any]]]:
        meta = chunk_meta(chunk_index)
        if meta.get("status") != "accepted":
            return None
        payload = read_json_or_none(accepted_chunk_path(chunk_index))
        if not isinstance(payload, dict):
            meta["status"] = "pending"
            return None
        segments = payload.get("segments")
        if not isinstance(segments, list):
            meta["status"] = "pending"
            return None
        return segments

    def save_accepted_chunk(chunk_index: int, start: float, end: float, segments: list[dict[str, Any]]) -> None:
        path = accepted_chunk_path(chunk_index)
        payload = {
            "version": 1,
            "accepted_at": now_ms(),
            "index": chunk_index,
            "core_start": round(start, 3),
            "core_end": round(end, 3),
            "segments": segments,
        }
        write_json_atomic(path, payload)
        meta = chunk_meta(chunk_index)
        meta.update(
            {
                "status": "accepted",
                "accepted_path": str(path.relative_to(project_dir(project_id))),
                "segment_count": len(segments),
                "word_count": segment_word_count(segments),
                "updated_at": now_ms(),
            }
        )
        write_manifest()

    def save_partial_project() -> None:
        partial = [dict(segment) for segment in all_segments]
        for idx, segment in enumerate(partial):
            segment["id"] = f"seg-{idx:05d}"
        project["segments"] = partial
        project["speaker_labels"] = default_speaker_labels(partial, project.get("speaker_labels") or {})
        project["updated_at"] = now_ms()
        save_project(project)

    append_project_log(
        project_id,
        (
            "Whisper adaptativo: "
            f"duracion={duration:.1f}s chunk={base_chunk_seconds:.0f}s "
            f"overlap={overlap_seconds:.0f}s retries={','.join(str(int(size)) for size in retry_sizes) or 'none'} "
            f"profile={profile_name} threads={max_threads}"
        ),
    )

    def run_attempt(core_start: float, core_end: float, chunk_seconds: float, depth: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        nonlocal attempt_counter
        ensure_not_stopped(project_id)
        attempt_counter += 1
        read_start = max(0.0, core_start - overlap_seconds)
        read_end = min(duration, core_end + overlap_seconds)
        chunk_path = chunk_dir / f"chunk_{attempt_counter:04d}_{int(core_start * 1000)}_{int(core_end * 1000)}.wav"
        chunk_output = chunk_dir / chunk_path.stem
        progress = round(25 + (core_start / max(duration, 1.0)) * 40)
        label = f"{format_seconds_label(core_start)}-{format_seconds_label(core_end)}"
        update_job(
            project_id,
            status="processing",
            step=f"Transcribiendo con Whisper {label}",
            progress=max(25, min(68, progress)),
            stage="whisper",
            retry_size=round(chunk_seconds, 1),
            can_resume=True,
        )
        append_project_log(
            project_id,
            (
                f"Whisper tramo {label}: intento chunk={chunk_seconds:.0f}s "
                f"read={format_seconds_label(read_start)}-{format_seconds_label(read_end)}"
            ),
        )
        try:
            write_wav_chunk(wav_path, chunk_path, read_start, read_end - read_start)
            raw_segments = run_whisper_file(
                project,
                chunk_path,
                tools,
                model_path,
                chunk_output,
                strict=True,
                allow_empty=True,
                max_threads=max_threads,
            )
            shifted = shift_segments(raw_segments, read_start, f"attempt-{attempt_counter:04d}")
            segments = trim_segments_to_core(shifted, core_start, core_end)
            quality = validate_whisper_chunk(wav_path, segments, core_start, core_end)
        except JobStopped:
            raise
        except Exception as exc:
            raw_error = str(exc)
            segments = []
            quality = {
                "ok": False,
                "fatal_error": is_fatal_whisper_error(raw_error),
                "issues": [{"type": "whisper_error", "message": compact_error_message(exc)}],
                "segment_count": 0,
                "word_count": 0,
                "rms": round(wav_rms(wav_path, core_start, core_end), 1),
            }
        finally:
            for path in [chunk_path, *[chunk_output.with_suffix(suffix) for suffix in (".json", ".txt", ".srt", ".vtt")]]:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass

        attempt = {
            "index": attempt_counter,
            "depth": depth,
            "chunk_seconds": round(chunk_seconds, 3),
            "core_start": round(core_start, 3),
            "core_end": round(core_end, 3),
            "read_start": round(read_start, 3),
            "read_end": round(read_end, 3),
            "accepted": False,
            **quality,
        }
        attempts.append(attempt)
        whisper_manifest["attempts"] = attempts
        write_manifest()
        return segments, attempt

    def transcribe_adaptive(core_start: float, core_end: float, size_index: int = 0, depth: int = 0) -> list[dict[str, Any]]:
        ensure_not_stopped(project_id)
        chunk_seconds = chunk_sizes[min(size_index, len(chunk_sizes) - 1)]
        segments, attempt = run_attempt(core_start, core_end, chunk_seconds, depth)
        if attempt.get("fatal_error"):
            raise RuntimeError(summarize_quality_issues(attempt.get("issues") or []))
        if attempt["ok"]:
            attempt["accepted"] = True
            return segments

        has_retry = size_index + 1 < len(chunk_sizes) and core_end - core_start > chunk_sizes[size_index + 1] + 5
        if has_retry:
            next_size = chunk_sizes[size_index + 1]
            append_project_log(
                project_id,
                (
                    f"Whisper reintentara {format_seconds_label(core_start)}-{format_seconds_label(core_end)} "
                    f"en tramos de {next_size:.0f}s: {summarize_quality_issues(attempt.get('issues') or [])}"
                ),
            )
            recovered: list[dict[str, Any]] = []
            for child_start, child_end in split_time_range(core_start, core_end, next_size):
                recovered.extend(transcribe_adaptive(child_start, child_end, size_index + 1, depth + 1))
            return recovered

        cleaned_segments, cleanup = sanitize_local_loop_segments(segments)
        if cleanup:
            attempt["local_cleanup"] = cleanup
            segments = cleaned_segments
            post_cleanup_quality = validate_whisper_chunk(wav_path, segments, core_start, core_end)
            attempt["post_cleanup_quality"] = post_cleanup_quality
            if post_cleanup_quality["ok"]:
                attempt["accepted"] = True
                attempt["accepted_after_cleanup"] = True
                cleanup_warning = format_cleanup_warning(cleanup)
                if cleanup_warning:
                    append_project_log(project_id, cleanup_warning)
                return segments
        attempt["accepted"] = True
        attempt["accepted_with_warning"] = True
        review_segments = review_segments_for_quality(attempt.get("issues") or [], core_start, core_end)
        if review_segments:
            segments = sorted([*segments, *review_segments], key=lambda item: (float(item.get("start", 0)), float(item.get("end", 0))))
        warning = (
            "Whisper requiere revision entre "
            f"{format_seconds_label(core_start)} y {format_seconds_label(core_end)}: "
            f"{summarize_quality_issues(attempt.get('issues') or [])}."
        )
        if cleanup:
            cleanup_warning = format_cleanup_warning(cleanup)
            if cleanup_warning:
                warning = f"{warning} {cleanup_warning}"
        if warning not in quality_warnings:
            quality_warnings.append(warning)
        whisper_manifest["warnings"] = quality_warnings
        update_job(project_id, status="processing", step=f"Revisar Whisper {format_seconds_label(core_start)}-{format_seconds_label(core_end)}", last_warning=warning)
        write_manifest()
        append_project_log(project_id, warning)
        return segments

    for chunk_index, (start, end) in enumerate(base_ranges):
        accepted_segments = load_accepted_chunk(chunk_index)
        if accepted_segments is not None:
            update_job(
                project_id,
                status="processing",
                step=f"Saltando tramo Whisper ya completado ({chunk_index + 1}/{total_chunks})",
                progress=round(25 + (chunk_index / total_chunks) * 40),
                stage="whisper",
                chunk_index=chunk_index + 1,
                chunk_total=total_chunks,
                can_resume=True,
            )
            all_segments.extend(accepted_segments)
            continue

        meta = chunk_meta(chunk_index)
        meta["status"] = "processing"
        meta["updated_at"] = now_ms()
        write_manifest()
        update_job(
            project_id,
            status="processing",
            step=f"Transcribiendo con Whisper ({chunk_index + 1}/{total_chunks})",
            progress=round(25 + (chunk_index / total_chunks) * 40),
            stage="whisper",
            chunk_index=chunk_index + 1,
            chunk_total=total_chunks,
            can_resume=True,
        )
        chunk_segments = transcribe_adaptive(start, end)
        save_accepted_chunk(chunk_index, start, end, chunk_segments)
        all_segments.extend(chunk_segments)
        save_partial_project()

    for idx, segment in enumerate(all_segments):
        segment["id"] = f"seg-{idx:05d}"
    write_combined_whisper_json(output_base, all_segments)
    quality_payload = {
        "version": 1,
        "created_at": now_ms(),
        "duration": round(duration, 3),
        "settings": {
            "chunk_seconds": base_chunk_seconds,
            "overlap_seconds": overlap_seconds,
            "retry_chunk_seconds": retry_sizes,
            "max_non_silent_gap_seconds": WHISPER_MAX_NON_SILENT_GAP_SECONDS,
            "rms_speech_threshold": WHISPER_RMS_SPEECH_THRESHOLD,
            "strict_args": whisper_strict_args(tools.whisper) if tools.whisper else [],
            "profile": profile_name,
            "max_threads": max_threads,
        },
        "summary": {
            "base_chunks": total_chunks,
            "attempts": len(attempts),
            "accepted_with_warning": sum(1 for attempt in attempts if attempt.get("accepted_with_warning")),
            "warnings": len(quality_warnings),
        },
        "warnings": quality_warnings,
        "attempts": attempts,
    }
    write_json_atomic(project_dir(project_id) / "whisper_quality.json", quality_payload)
    manifest["stage"] = "whisper_done"
    whisper_manifest["warnings"] = quality_warnings
    write_manifest()
    if quality_warnings:
        project.setdefault("warnings", []).extend(quality_warnings)
    if not all_segments:
        detail = quality_warnings[0] if quality_warnings else "Whisper no produjo texto."
        raise RuntimeError(f"Whisper no produjo segmentos transcritos. {detail}")
    return all_segments


def run_whisper(
    project: dict[str, Any],
    wav_path: Path,
    tools: ToolPaths,
    model_name: str,
    profile: str,
    *,
    reset_manifest: bool = False,
) -> list[dict[str, Any]]:
    if not tools.whisper:
        raise RuntimeError("No encontre whisper.cpp. Ejecuta el setup otra vez.")
    ensure_not_stopped(project["id"])
    model_path = MODELS_DIR / "whisper" / model_name
    if not model_path.exists():
        models = available_models()
        if not models:
            raise RuntimeError("No hay modelos Whisper en models/whisper. Ejecuta el setup otra vez.")
        model_path = Path(models[0]["path"])
    integrity_error = model_integrity_error(model_path)
    if integrity_error:
        raise RuntimeError(
            f"Modelo Whisper invalido ({model_path.name}): {integrity_error}. "
            "Borra ese archivo y descargalo de nuevo."
        )

    segments = run_whisper_chunked(project, wav_path, tools, model_path, profile, reset_manifest=reset_manifest)

    segments, cleanup = sanitize_whisper_loops_with_ranges(segments)
    if cleanup:
        message = format_cleanup_warning(cleanup)
        append_project_log(project["id"], message)
        project.setdefault("warnings", []).append(message)
        quality_path = project_dir(project["id"]) / "whisper_quality.json"
        if quality_path.exists():
            try:
                quality_payload = json.loads(quality_path.read_text(encoding="utf-8"))
                quality_payload["final_cleanup"] = cleanup
                quality_payload.setdefault("warnings", []).append(message)
                quality_path.write_text(json.dumps(quality_payload, ensure_ascii=False, indent=2), encoding="utf-8")
            except (OSError, json.JSONDecodeError):
                append_project_log(project["id"], "No se pudo actualizar whisper_quality.json con cleanup final.")
        write_combined_whisper_json(project_dir(project["id"]) / "whisper", segments)
    return segments


def read_wav_float32(path: Path) -> tuple[Any, int]:
    import numpy as np

    with wave.open(str(path), "rb") as wav:
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if sample_width != 2:
        raise RuntimeError("La separacion de hablantes espera WAV PCM 16-bit.")
    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, sample_rate


def run_diarization(wav_path: Path, output_path: Path, num_speakers: Optional[int] = None) -> list[dict[str, Any]]:
    project_id = output_path.parent.name
    ensure_not_stopped(project_id)
    command = [
        sys.executable,
        str(ROOT_DIR / "scripts" / "diarize_file.py"),
        "--wav",
        str(wav_path),
        "--models-dir",
        str(MODELS_DIR),
        "--output",
        str(output_path),
        "--chunk-seconds",
        str(DIARIZATION_CHUNK_SECONDS),
        "--chunk-overlap-seconds",
        str(DIARIZATION_CHUNK_OVERLAP_SECONDS),
    ]
    if num_speakers:
        command.extend(["--speakers", str(num_speakers)])
    append_project_log(project_id, "RUN " + " ".join(command))
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    process = subprocess.Popen(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        env=env,
    )
    output_tail: list[str] = []
    with JOBS_LOCK:
        RUNNING_PROCESSES[project_id] = process
    try:
        if process.stdout:
            for raw_line in process.stdout:
                line = raw_line.rstrip()
                if not line:
                    continue
                output_tail.append(line)
                output_tail = output_tail[-120:]
                append_project_log(project_id, line)
                match = DIARIZE_PROGRESS_RE.match(line)
                if match:
                    percent = float(match.group("percent"))
                    message = match.group("message").strip() or "Separando hablantes"
                    mapped_progress = round(70 + (max(0.0, min(100.0, percent)) * 0.18))
                    update_job(
                        project_id,
                        status="processing",
                        step=message,
                        progress=mapped_progress,
                        stage="diarization",
                        can_resume=True,
                    )
        returncode = process.wait()
    finally:
        with JOBS_LOCK:
            if RUNNING_PROCESSES.get(project_id) is process:
                RUNNING_PROCESSES.pop(project_id, None)

    requested = get_stop_request(project_id)
    if requested in {"paused", "cancelled"}:
        append_project_log(project_id, f"STOP {requested}")
        raise JobStopped(requested)

    detail = "\n".join(output_tail).strip()
    if returncode != 0:
        if returncode < 0:
            detail = f"Proceso terminado por senal {-returncode}." + (f"\n{detail}" if detail else "")
        elif not detail:
            detail = f"Codigo de salida {returncode}, sin salida adicional."
        append_project_log(project_id, f"EXIT {returncode}\n{detail[-4000:]}")
        raise RuntimeError(f"sherpa-onnx fallo o fue terminado:\n{detail[-2000:]}")
    append_project_log(project_id, f"EXIT {returncode}")
    if not output_path.exists():
        raise RuntimeError("sherpa-onnx termino, pero no genero separacion de hablantes.")
    return json.loads(output_path.read_text(encoding="utf-8"))



def write_diarization_quality(project_id: str, quality: dict[str, Any]) -> None:
    (project_dir(project_id) / "diarization_quality.json").write_text(
        json.dumps(quality, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def relabel_segments_with_diagnostics(
    project_id: str,
    segments: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    existing_labels: Optional[dict[str, str]] = None,
) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, Any], str]:
    processed_turns = postprocess_diarization_turns(turns)
    assigned = assign_speakers_from_processed_turns(segments, processed_turns, existing_labels)
    labels = default_speaker_labels(assigned, existing_labels)
    quality = compute_diarization_quality(turns, processed_turns, assigned)
    write_diarization_quality(project_id, quality)
    warning = format_diarization_quality_warning(quality)
    return assigned, labels, quality, warning


def clear_diarization_warnings(warnings: list[str]) -> list[str]:
    cleaned = []
    for warning in warnings:
        text = warning.lower()
        if "diariz" in text or text.startswith("separacion de hablantes"):
            continue
        cleaned.append(warning)
    return cleaned


def compact_error_message(error: Exception) -> str:
    text = str(error).strip()
    if not text:
        return "error sin detalle."
    lowered_text = text.lower()
    if ("winerror 5" in lowered_text or "access is denied" in lowered_text) and "project.json" in lowered_text:
        return "Windows bloqueo temporalmente el archivo del proyecto. Reinicia la app local y presiona Reanudar."
    for line in text.splitlines():
        line = line.strip()
        lowered = line.lower()
        if not line:
            continue
        if lowered in {"whisper.cpp fallo:", "sherpa-onnx fallo o fue terminado:"}:
            continue
        if lowered.endswith("fallo:") and len(line) < 80:
            continue
        if line:
            return redact_local_paths(line)[:300]
    return redact_local_paths(text)[:300]


def redact_local_paths(text: str) -> str:
    text = re.sub(r"[A-Za-z]:\\[^\n\r'\"<>|]+", "[ruta local]", text)
    text = re.sub(r"(?<!\w)/(?:[^/\s'\"<>]+/){2,}[^/\s'\"<>]+", "[ruta local]", text)
    return re.sub(r"['\"]?\[ruta local\]['\"]?", "[ruta local]", text)


def parse_java_major_version(text: str) -> Optional[int]:
    return proofread_service.parse_java_major_version(text)


def java_install_hint() -> str:
    return proofread_service.java_install_hint(platform.system())


def java_candidate_paths() -> list[Path]:
    return proofread_service.java_candidate_paths(platform.system(), os.environ)


def java_version_for_path(java_bin: Path) -> tuple[Optional[int], str]:
    return proofread_service.java_version_for_path(java_bin, compact_error_message=compact_error_message)


def activate_java_runtime(java_bin: Path) -> None:
    proofread_service.activate_java_runtime(java_bin, os.environ)


def java_runtime_error() -> str:
    candidates = java_candidate_paths()
    if not candidates:
        return f"Falta Java {MIN_LANGUAGETOOL_JAVA_MAJOR} o superior. {java_install_hint()}"

    checked: list[tuple[Path, Optional[int], str]] = []
    for candidate in candidates:
        major, output = java_version_for_path(candidate)
        checked.append((candidate, major, output))
        if major is not None and major >= MIN_LANGUAGETOOL_JAVA_MAJOR:
            activate_java_runtime(candidate)
            return ""

    detected = next((item for item in checked if item[1] is not None), None)
    if detected is not None:
        java_bin, major, _ = detected
        return (
            f"Java {major} detectado en {java_bin}. "
            f"LanguageTool {LANGUAGETOOL_VERSION} requiere Java {MIN_LANGUAGETOOL_JAVA_MAJOR} o superior. "
            f"{java_install_hint()}"
        )
    detail = checked[0][2].strip().splitlines()[0] if checked and checked[0][2].strip() else str(candidates[0])
    return f"No pude detectar la version de Java. LanguageTool requiere Java {MIN_LANGUAGETOOL_JAVA_MAJOR} o superior. {detail[:160]}"


def proofread_status_snapshot() -> dict[str, Any]:
    with PROOFREAD_STATUS_LOCK:
        return dict(PROOFREAD_STATUS)


def set_proofread_status(status: str, message: str = "", missing: Optional[list[str]] = None) -> None:
    with PROOFREAD_STATUS_LOCK:
        PROOFREAD_STATUS.update(
            {
                "status": status,
                "available": status == "ready",
                "message": message,
                "missing": missing or [],
                "updated_at": now_ms(),
            }
        )


def language_tool_dir_has_jar(directory: Path) -> bool:
    return proofread_service.language_tool_dir_has_jar(directory, LANGUAGETOOL_JAR_PATTERNS)


def latest_language_tool_dir(base_dir: Path) -> Optional[Path]:
    return proofread_service.latest_language_tool_dir(base_dir, LANGUAGETOOL_JAR_PATTERNS)


def configure_language_tool_paths() -> None:
    proofread_service.configure_language_tool_paths(LANGUAGETOOL_DIR, LANGUAGETOOL_JAR_PATTERNS, environ=os.environ)


def proofread_package_error() -> str:
    try:
        import language_tool_python  # type: ignore  # noqa: F401
    except ModuleNotFoundError:
        setup_script = "setup_windows.bat" if platform.system() == "Windows" else "setup_mac.sh"
        return f"Falta language-tool-python. Ejecuta {setup_script} o pip install -r requirements.txt."
    return ""


def proofread_start_error() -> str:
    package_error = proofread_package_error()
    if package_error:
        return package_error
    return java_runtime_error()


def start_proofread_background() -> None:
    global PROOFREAD_INIT_STARTED
    startup_error = proofread_start_error()
    if startup_error:
        set_proofread_status("unavailable", startup_error, [startup_error])
        return
    with PROOFREAD_STATUS_LOCK:
        if PROOFREAD_INIT_STARTED or PROOFREAD_STATUS.get("status") in {"preparing", "ready"}:
            return
        PROOFREAD_INIT_STARTED = True
        PROOFREAD_STATUS.update(
            {
                "status": "preparing",
                "available": False,
                "message": "Iniciando corrector local...",
                "missing": [],
                "updated_at": now_ms(),
            }
        )

    def worker() -> None:
        global PROOFREAD_INIT_STARTED
        try:
            get_proofread_tool("es")
            set_proofread_status("ready", "Corrector local listo.")
        except Exception as exc:
            set_proofread_status("unavailable", compact_error_message(exc), [compact_error_message(exc)])
            with PROOFREAD_STATUS_LOCK:
                PROOFREAD_INIT_STARTED = False

    threading.Thread(target=worker, daemon=True).start()


def stop_proofread_tool() -> None:
    global PROOFREAD_TOOL, PROOFREAD_INIT_STARTED
    with PROOFREAD_LOCK:
        tool = PROOFREAD_TOOL
        PROOFREAD_TOOL = None
    if tool is not None:
        close = getattr(tool, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
    with PROOFREAD_STATUS_LOCK:
        PROOFREAD_INIT_STARTED = False
        PROOFREAD_STATUS.update(
            {
                "status": "idle",
                "available": False,
                "message": "Corrector local apagado.",
                "missing": [],
                "updated_at": now_ms(),
            }
        )


def proofread_cache_key(language: str, text: str) -> str:
    return proofread_service.proofread_cache_key(language, text)


def cached_proofread_result(language: str, text: str) -> Optional[dict[str, Any]]:
    key = proofread_cache_key(language, text)
    with PROOFREAD_CACHE_LOCK:
        result = PROOFREAD_CACHE.get(key)
        return dict(result) if result is not None else None


def remember_proofread_result(language: str, text: str, result: dict[str, Any]) -> None:
    key = proofread_cache_key(language, text)
    with PROOFREAD_CACHE_LOCK:
        if key not in PROOFREAD_CACHE:
            PROOFREAD_CACHE_ORDER.append(key)
        PROOFREAD_CACHE[key] = dict(result)
        while len(PROOFREAD_CACHE_ORDER) > PROOFREAD_CACHE_LIMIT:
            old_key = PROOFREAD_CACHE_ORDER.pop(0)
            PROOFREAD_CACHE.pop(old_key, None)


def get_proofread_tool(language: str = "es") -> Any:
    global PROOFREAD_TOOL
    normalized_language = proofread_service.normalize_language(language)
    with PROOFREAD_LOCK:
        if PROOFREAD_TOOL is not None:
            return PROOFREAD_TOOL
        startup_error = proofread_start_error()
        if startup_error:
            raise RuntimeError(startup_error)
        configure_language_tool_paths()
        import language_tool_python  # type: ignore
        try:
            PROOFREAD_TOOL = language_tool_python.LanguageTool(
                normalized_language,
                language_tool_download_version=LANGUAGETOOL_VERSION,
            )
        except Exception as exc:
            raise RuntimeError(f"No pude iniciar LanguageTool local: {compact_error_message(exc)}") from exc
        return PROOFREAD_TOOL


def proofread_text(text: str, language: str = "es") -> dict[str, Any]:
    original = text or ""
    if not original.strip():
        return {"ok": True, "language": "es", "matches": [], "truncated": False, "cached": False}
    if len(original) > 8000:
        raise HTTPException(status_code=400, detail="Texto demasiado largo para revisar en una sola pasada.")
    cached = cached_proofread_result(language, original)
    if cached is not None:
        cached["cached"] = True
        return cached
    tool = get_proofread_tool(language)
    matches = tool.check(original)
    serialized = [serialize_proofread_match(match, original) for match in matches[:40]]
    result = {
        "ok": True,
        "language": "es",
        "matches": serialized,
        "truncated": len(matches) > len(serialized),
        "cached": False,
    }
    remember_proofread_result(language, original, result)
    return result


def serialize_proofread_match(match: Any, text: str) -> dict[str, Any]:
    return proofread_service.serialize_proofread_match(match, text)


def is_fatal_whisper_error(text: str) -> bool:
    lowered = text.lower()
    fatal_markers = [
        "failed to initialize whisper context",
        "failed to load model",
        "unknown tensor",
        "modelo whisper invalido",
        "no encontre whisper.cpp",
        "no hay modelos whisper",
    ]
    return any(marker in lowered for marker in fatal_markers)


def process_project(
    project_id: str,
    model_name: str,
    diarize: bool,
    num_speakers: Optional[int],
    profile: str,
    reset_manifest: bool = False,
) -> None:
    try:
        profile_name = normalize_processing_profile(profile)
        append_project_log(project_id, f"Iniciando procesamiento con modelo {model_name}, perfil {profile_name}")
        project = load_project(project_id)
        existing_labels = project.get("speaker_labels") or {}
        tools = get_tools()
        project["status"] = "processing"
        project["updated_at"] = now_ms()
        project["warnings"] = []
        project["error"] = None
        project["run_config"] = {
            "model": model_name,
            "diarize": diarize,
            "num_speakers": num_speakers,
            "profile": profile_name,
        }
        save_project(project)
        update_processing_manifest(project_id, stage="convert")
        update_job(project_id, status="processing", step="Convirtiendo audio", progress=10, stage="convert", can_resume=True)

        existing_wav = project_media_path(project, "audio_path", "audio")
        if existing_wav and existing_wav.is_file():
            wav_path = existing_wav
        else:
            wav_path = convert_audio(project, tools)
        project["audio_path"] = str(wav_path)
        save_project(project)
        ensure_not_stopped(project_id)

        update_job(project_id, step="Transcribiendo con Whisper", progress=25, stage="whisper", can_resume=True)
        segments = run_whisper(project, wav_path, tools, model_name, profile_name, reset_manifest=reset_manifest)
        project["segments"] = segments
        project["speaker_labels"] = default_speaker_labels(segments, existing_labels)
        project["model"] = model_name
        project["status"] = "transcribed"
        project["updated_at"] = now_ms()
        save_project(project)

        turns = []
        if diarize:
            ready = diarization_ready()
            if ready["ready"]:
                update_processing_manifest(project_id, stage="diarization")
                update_job(project_id, step="Separando hablantes", progress=70, stage="diarization", can_resume=True)
                ensure_not_stopped(project_id)
                try:
                    turns = run_diarization(
                        wav_path,
                        project_dir(project_id) / "diarization_turns.json",
                        num_speakers=num_speakers,
                    )
                except Exception as exc:
                    project["warnings"].append(f"Separacion de hablantes omitida: {compact_error_message(exc)}")
            else:
                project["warnings"].append("Separacion de hablantes no disponible. Revisa setup o requirements_diarization.txt.")

        ensure_not_stopped(project_id)
        update_job(project_id, step="Preparando editor", progress=90, stage="editor", can_resume=False)
        if turns:
            segments, speaker_labels, _, diarization_warning = relabel_segments_with_diagnostics(
                project_id,
                segments,
                turns,
                existing_labels,
            )
            if diarization_warning:
                project["warnings"] = clear_diarization_warnings(project.get("warnings") or [])
                project["warnings"].append(diarization_warning)
        else:
            speaker_labels = default_speaker_labels(segments, existing_labels)
        project["segments"] = segments
        project["diarization_turns"] = turns
        project["speaker_labels"] = speaker_labels
        project["model"] = model_name
        project["status"] = "done"
        bump_content_revision(project)
        project["updated_at"] = now_ms()
        save_project(project)
        update_processing_manifest(project_id, stage="done")
        update_job(project_id, status="done", step="Listo", progress=100, stage="done", can_resume=False)
    except JobStopped as exc:
        try:
            project = load_project(project_id)
            project["status"] = exc.status
            project["error"] = None
            project["updated_at"] = now_ms()
            save_project(project)
            update_processing_manifest(project_id, stage=exc.status)
        except Exception:
            pass
        step = "Pausado. Puedes reanudar cuando quieras." if exc.status == "paused" else "Cancelado."
        update_job(project_id, status=exc.status, step=step, progress=100 if exc.status == "cancelled" else 0, can_resume=True)
    except Exception as exc:
        error_message = compact_error_message(exc)
        try:
            project = load_project(project_id)
            project["status"] = "error"
            project["error"] = error_message
            project["updated_at"] = now_ms()
            save_project(project)
            update_processing_manifest(project_id, stage="error", error=error_message)
        except Exception:
            pass
        update_job(project_id, status="error", step="Error", progress=100, error=error_message, can_resume=True)


def start_processing_thread(
    project_id: str,
    model_name: str,
    diarize: bool,
    num_speakers: Optional[int],
    profile: str,
    *,
    reset_manifest: bool = False,
) -> None:
    project = load_project(project_id)
    if project.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=400, detail="Ese proyecto ya se esta procesando.")
    clear_stop_request(project_id)
    profile_name = normalize_processing_profile(profile)
    project["status"] = "queued"
    project["error"] = None
    project["updated_at"] = now_ms()
    project["run_config"] = {
        "model": model_name,
        "diarize": diarize,
        "num_speakers": num_speakers,
        "profile": profile_name,
    }
    save_project(project)
    update_job(project_id, status="queued", step="En cola", progress=0, started_at=now_ms(), can_resume=True)
    thread = threading.Thread(
        target=process_project,
        args=(project_id, model_name, diarize, num_speakers, profile_name, reset_manifest),
        daemon=True,
    )
    thread.start()


def process_diarization_only(project_id: str, num_speakers: Optional[int]) -> None:
    try:
        append_project_log(project_id, f"Iniciando separacion de hablantes aislada. speakers={num_speakers or 'auto'}")
        clear_stop_request(project_id)
        project = load_project(project_id)
        existing_labels = project.get("speaker_labels") or {}
        if not project.get("segments"):
            raise RuntimeError("No hay segmentos transcritos para separar hablantes.")
        audio_path = project_media_path(project, "audio_path", "audio")
        if not audio_path or not audio_path.is_file():
            raise RuntimeError("No hay WAV convertido para separar hablantes.")
        if not diarization_ready()["ready"]:
            raise RuntimeError("Separacion de hablantes no disponible. Revisa setup o requirements_diarization.txt.")

        project["status"] = "processing"
        project["error"] = None
        project["warnings"] = clear_diarization_warnings(project.get("warnings") or [])
        project["updated_at"] = now_ms()
        save_project(project)
        update_processing_manifest(project_id, stage="diarization")
        update_job(
            project_id,
            status="processing",
            step="Separando hablantes",
            progress=70,
            started_at=now_ms(),
            stage="diarization",
            can_resume=True,
        )

        turns = run_diarization(
            audio_path,
            project_dir(project_id) / "diarization_turns.json",
            num_speakers=num_speakers,
        )
        segments, speaker_labels, _, diarization_warning = relabel_segments_with_diagnostics(
            project_id,
            project.get("segments") or [],
            turns,
            existing_labels,
        )
        project = load_project(project_id)
        project["segments"] = segments
        project["diarization_turns"] = turns
        project["speaker_labels"] = speaker_labels
        project["status"] = "done"
        project["error"] = None
        bump_content_revision(project)
        project["updated_at"] = now_ms()
        warnings = project.get("warnings") or []
        project["warnings"] = clear_diarization_warnings(warnings)
        if diarization_warning:
            project["warnings"].append(diarization_warning)
        save_project(project)
        update_processing_manifest(project_id, stage="done")
        update_job(project_id, status="done", step="Listo", progress=100, stage="done", can_resume=False)
    except Exception as exc:
        error_message = compact_error_message(exc)
        try:
            project = load_project(project_id)
            project["status"] = "done" if project.get("segments") else "error"
            project["error"] = None if project.get("segments") else error_message
            warnings = clear_diarization_warnings(project.get("warnings") or [])
            warnings.append(f"Separacion de hablantes omitida: {error_message}")
            project["warnings"] = warnings
            project["updated_at"] = now_ms()
            save_project(project)
        except Exception:
            pass
        update_job(project_id, status="done", step="Separacion de hablantes omitida", progress=100)


def start_diarization_thread(project_id: str, num_speakers: Optional[int]) -> None:
    project = load_project(project_id)
    if project.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=400, detail="Ese proyecto ya se esta procesando.")
    project["status"] = "queued"
    project["error"] = None
    project["updated_at"] = now_ms()
    save_project(project)
    update_job(project_id, status="queued", step="Preparando separacion de hablantes", progress=0, started_at=now_ms(), stage="diarization", can_resume=True)
    thread = threading.Thread(
        target=process_diarization_only,
        args=(project_id, num_speakers),
        daemon=True,
    )
    thread.start()


def package_deps() -> package_service.PackageDeps:
    return package_service.PackageDeps(
        now_ms=now_ms,
        clean_filename=clean_filename,
        project_dir=project_dir,
        project_media_path=project_media_path,
        project_content_revision=project_content_revision,
        save_project=save_project,
        append_project_log=append_project_log,
        list_projects=list_projects,
        sha256_file=sha256_file,
    )


def truthy_param(value: Any) -> bool:
    return package_service.truthy_param(value)


def safe_zip_member(name: str) -> str:
    return package_service.safe_zip_member(name)


def package_member_allowed(member: str) -> bool:
    return package_service.package_member_allowed(member)


def is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    return package_service.is_zip_symlink(info)


def validated_package_entries(package: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    return package_service.validated_package_entries(package)


def normalize_browser_settings(payload: Any) -> Optional[dict[str, Any]]:
    return package_service.normalize_browser_settings(payload)


def parse_browser_settings_param(raw: str = "") -> Optional[dict[str, Any]]:
    return package_service.parse_browser_settings_param(raw)


def read_package_browser_settings(
    package: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
) -> Optional[dict[str, Any]]:
    return package_service.read_package_browser_settings(package, entries)


def portable_project(project: dict[str, Any]) -> dict[str, Any]:
    return package_service.portable_project(project, package_deps())


def project_audio_for_package(project: dict[str, Any]) -> tuple[Optional[Path], str]:
    return package_service.project_audio_for_package(project, package_deps())


def add_file_if_exists(package: zipfile.ZipFile, path: Path, arcname: str) -> bool:
    return package_service.add_file_if_exists(package, path, arcname)


def export_package(
    project: dict[str, Any],
    output_path: Path,
    include_audio: bool = True,
    browser_settings: Optional[dict[str, Any]] = None,
) -> None:
    package_service.export_package(
        project,
        output_path,
        package_deps(),
        include_audio=include_audio,
        browser_settings=browser_settings,
    )


def read_package_json(package: zipfile.ZipFile, entries: dict[str, zipfile.ZipInfo], member: str) -> dict[str, Any]:
    return package_service.read_package_json(package, entries, member)


def copy_package_member(package: zipfile.ZipFile, info: zipfile.ZipInfo, destination: Path, max_bytes: int, description: str) -> None:
    package_service.copy_package_member(package, info, destination, max_bytes, description)


async def write_upload_to_path(upload: UploadFile, destination: Path, max_bytes: int, description: str) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    uploaded_bytes = 0
    try:
        with destination.open("wb") as out:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                uploaded_bytes += len(chunk)
                if uploaded_bytes > max_bytes:
                    raise HTTPException(status_code=400, detail=f"{description} es demasiado grande.")
                out.write(chunk)
        return uploaded_bytes
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def inspect_project_package(package_path: Path) -> dict[str, Any]:
    return package_service.inspect_project_package(package_path, package_deps())


def find_duplicate_import(package_info: dict[str, Any]) -> Optional[dict[str, Any]]:
    return package_service.find_duplicate_import(package_info, package_deps())


def unique_project_name(base_name: str) -> str:
    return package_service.unique_project_name(base_name, package_deps())


def normalize_imported_segments(project: dict[str, Any]) -> None:
    package_service.normalize_imported_segments(project)


def import_project_package(package_path: Path, package_info: Optional[dict[str, Any]] = None, copy_name: bool = False) -> dict[str, Any]:
    return package_service.import_project_package(
        package_path,
        package_deps(),
        package_info=package_info,
        copy_name=copy_name,
    )


def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


def api_status() -> dict[str, Any]:
    tools = get_tools()
    return {
        "tools": {
            "ffmpeg": bool(tools.ffmpeg),
            "ffmpeg_path": tools.ffmpeg,
            "whisper": bool(tools.whisper),
            "whisper_path": tools.whisper,
        },
        "models": available_models(),
        "profiles": [
            {"name": key, "label": value["label"], "default": key == default_processing_profile()}
            for key, value in PROCESSING_PROFILES.items()
        ],
        "default_profile": default_processing_profile(),
        "diarization": diarization_ready(),
        "data_dir": str(DATA_DIR),
    }


def api_projects() -> list[dict[str, Any]]:
    return list_projects()


async def api_create_project(
    file: UploadFile = File(...),
    model: str = Form("auto"),
    diarize: str = Form("true"),
    speakers: str = Form("auto"),
    profile: str = Form("auto"),
) -> dict[str, Any]:
    tools = get_tools()
    if not tools.ffmpeg or not tools.whisper:
        raise HTTPException(status_code=400, detail="Faltan herramientas. Ejecuta setup.")
    models = available_models()
    if not models:
        raise HTTPException(status_code=400, detail="No hay modelos Whisper. Ejecuta setup.")
    profile_name = normalize_processing_profile(profile)
    model_name = select_model_for_request(models, model, profile_name)
    if not any(item["name"] == model_name for item in models):
        raise HTTPException(status_code=400, detail="Modelo no disponible.")

    project_id = uuid.uuid4().hex[:12]
    pdir = project_dir(project_id)
    pdir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "audio").suffix
    source_path = pdir / f"source{suffix}"
    try:
        await write_upload_to_path(file, source_path, MAX_UPLOAD_AUDIO_BYTES, "El audio")
        num_speakers = parse_speaker_count(speakers)

        project = {
            "id": project_id,
            "name": clean_filename(file.filename or "audio"),
            "source_name": file.filename,
            "source_path": str(source_path),
            "status": "new",
            "content_revision": 0,
            "created_at": now_ms(),
            "updated_at": now_ms(),
            "segments": [],
            "speaker_labels": {},
            "warnings": [],
            "error": None,
            "run_config": {
                "model": model_name,
                "diarize": diarize.lower() == "true",
                "num_speakers": num_speakers,
                "profile": profile_name,
            },
        }
        save_project(project)
        start_processing_thread(project_id, model_name, diarize.lower() == "true", num_speakers, profile_name)
        return {"id": project_id, "status": "queued"}
    except Exception:
        shutil.rmtree(pdir, ignore_errors=True)
        raise


async def api_import_package(file: UploadFile = File(...), duplicate_mode: str = Form("ask")) -> dict[str, Any]:
    filename = file.filename or "transcripcion.transcriptor.zip"
    if not filename.lower().endswith((".zip", ".transcriptor.zip")):
        raise HTTPException(status_code=400, detail="Selecciona un paquete .transcriptor.zip o .zip.")
    duplicate_mode = duplicate_mode.strip().lower()
    if duplicate_mode not in {"ask", "copy", "open"}:
        raise HTTPException(status_code=400, detail="Modo de duplicado no soportado.")
    cleanup_stale_export_temps()
    temp_path = temporary_export_path("import", ".zip")
    try:
        await write_upload_to_path(file, temp_path, MAX_IMPORT_PACKAGE_BYTES, "El paquete")
        package_info = inspect_project_package(temp_path)
        duplicate = find_duplicate_import(package_info)
        if duplicate and duplicate_mode in {"ask", "open"}:
            return {
                "duplicate": True,
                "existing": project_summary(duplicate),
                "package": {
                    "name": package_info.get("name"),
                    "original_id": package_info.get("original_id"),
                    "segments": package_info.get("segments"),
                    "speakers": package_info.get("speakers"),
                    "has_diarization": package_info.get("has_diarization"),
                    "has_audio": package_info.get("has_audio"),
                    "has_browser_settings": package_info.get("has_browser_settings"),
                    "audio_name": package_info.get("audio_name"),
                    "audio_bytes": package_info.get("audio_bytes"),
                    "updated_at": package_info.get("updated_at"),
                },
            }
        project = import_project_package(temp_path, package_info=package_info, copy_name=duplicate_mode == "copy" and duplicate is not None)
        browser_settings = project.pop("browser_settings", None)
        return {"id": project["id"], "status": project.get("status"), "project": project, "browser_settings": browser_settings}
    finally:
        temp_path.unlink(missing_ok=True)


async def api_import_package_inspect(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = file.filename or "transcripcion.transcriptor.zip"
    if not filename.lower().endswith((".zip", ".transcriptor.zip")):
        raise HTTPException(status_code=400, detail="Selecciona un paquete .transcriptor.zip o .zip.")
    cleanup_stale_export_temps()
    temp_path = temporary_export_path("inspect", ".zip")
    try:
        await write_upload_to_path(file, temp_path, MAX_IMPORT_PACKAGE_BYTES, "El paquete")
        package_info = inspect_project_package(temp_path)
        duplicate = find_duplicate_import(package_info)
        return {
            "package": {
                "name": package_info.get("name"),
                "original_id": package_info.get("original_id"),
                "segments": package_info.get("segments"),
                "speakers": package_info.get("speakers"),
                "has_diarization": package_info.get("has_diarization"),
                "has_audio": package_info.get("has_audio"),
                "has_browser_settings": package_info.get("has_browser_settings"),
                "audio_name": package_info.get("audio_name"),
                "audio_bytes": package_info.get("audio_bytes"),
                "created_at": package_info.get("created_at"),
                "updated_at": package_info.get("updated_at"),
            },
            "duplicate": bool(duplicate),
            "existing": project_summary(duplicate) if duplicate else None,
        }
    finally:
        temp_path.unlink(missing_ok=True)


def api_project(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    return load_project(project_id)


def api_update_project(project_id: str, payload: ProjectUpdate) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    if payload.name is not None:
        project["name"] = payload.name.strip() or project["name"]
    if payload.playback_position is not None:
        project["playback_position"] = max(0.0, float(payload.playback_position))
    project["updated_at"] = now_ms()
    save_project(project)
    return project


def api_job(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    with JOBS_LOCK:
        job = public_job(dict(JOBS.get(project_id, {})))
    if not job:
        project = load_project(project_id)
        manifest = read_json_or_none(processing_manifest_path(project_id))
        job = {
            "status": project.get("status"),
            "step": project.get("status"),
            "progress": 100 if project.get("status") in {"done", "error"} else 0,
            "error": project.get("error"),
            "stage": manifest.get("stage") if isinstance(manifest, dict) else project.get("status"),
            "can_resume": project.get("status") in {"paused", "cancelled", "error"},
        }
    return job


def api_project_logs(project_id: str) -> dict[str, str]:
    project_id = validate_project_id(project_id)
    load_project(project_id)
    return {"log": read_project_log(project_id)}


def api_pause_job(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    return request_job_stop(project_id, "paused")


def api_cancel_job(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    return request_job_stop(project_id, "cancelled")


def api_resume_project(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    if project.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=400, detail="Ese proyecto ya se esta procesando.")
    previous_status = project.get("status")
    config = project.get("run_config") or {}
    models = available_models()
    profile_name = normalize_processing_profile(config.get("profile"))
    model_name = select_model_for_request(models, config.get("model") or "auto", profile_name)
    diarize = bool(config.get("diarize", True))
    num_speakers = config.get("num_speakers")
    start_processing_thread(
        project_id,
        model_name,
        diarize,
        num_speakers,
        profile_name,
        reset_manifest=previous_status == "done",
    )
    return {"id": project_id, "status": "queued"}


def api_diarize_project(project_id: str, speakers: str = Form("auto")) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    num_speakers = parse_speaker_count(speakers)
    start_diarization_thread(project_id, num_speakers)
    return {"id": project_id, "status": "queued"}


def api_relabel_speakers(project_id: str, payload: Optional[RelabelRequest] = None) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    if project.get("status") in {"queued", "processing"}:
        raise HTTPException(status_code=400, detail="Ese proyecto se esta procesando.")
    if (payload and payload.mode) not in {None, "interview_2p"}:
        raise HTTPException(status_code=400, detail="Modo de reetiquetado no soportado.")
    segments = project.get("segments") or []
    turns = project.get("diarization_turns") or []
    if not segments:
        raise HTTPException(status_code=400, detail="No hay segmentos para reetiquetar.")
    if not turns:
        raise HTTPException(status_code=400, detail="No hay separacion de hablantes guardada para reetiquetar.")

    existing_labels = project.get("speaker_labels") or {}
    segments, labels, _, diarization_warning = relabel_segments_with_diagnostics(
        project_id,
        segments,
        turns,
        existing_labels,
    )
    project["segments"] = segments
    project["speaker_labels"] = labels
    project["warnings"] = clear_diarization_warnings(project.get("warnings") or [])
    if diarization_warning:
        project["warnings"].append(diarization_warning)
    bump_content_revision(project)
    project["updated_at"] = now_ms()
    save_project(project)
    return project


def api_save_segments(project_id: str, payload: SegmentUpdate) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    current_revision = project_content_revision(project)
    if payload.base_content_revision is not None and int(payload.base_content_revision) != current_revision:
        raise HTTPException(
            status_code=409,
            detail="Hay cambios guardados desde otra ventana. Revisa antes de sobrescribir.",
        )
    project["segments"] = payload.segments
    project["speaker_labels"] = payload.speaker_labels
    if payload.name is not None:
        project["name"] = payload.name.strip() or project.get("name") or "Transcripcion"
    bump_content_revision(project)
    project["updated_at"] = now_ms()
    save_project(project)
    return project


def api_proofread_status(start: bool = False) -> dict[str, Any]:
    status = proofread_status_snapshot()
    if start and status.get("status") in {"idle", "unavailable"}:
        start_proofread_background()
        status = proofread_status_snapshot()
    return status


def api_proofread_stop() -> dict[str, Any]:
    stop_proofread_tool()
    return {"ok": True, **proofread_status_snapshot()}


def api_proofread(payload: ProofreadRequest) -> dict[str, Any]:
    try:
        return proofread_text(payload.text, payload.language)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=compact_error_message(exc)) from exc


def api_proofread_batch(payload: ProofreadBatchRequest) -> dict[str, Any]:
    if len(payload.items) > 24:
        raise HTTPException(status_code=400, detail="Demasiados segmentos para revisar en una sola pasada.")
    results = []
    try:
        for item in payload.items:
            result = proofread_text(item.text, payload.language)
            results.append(
                {
                    "id": item.id,
                    "matches": result.get("matches", []),
                    "truncated": bool(result.get("truncated")),
                    "cached": bool(result.get("cached")),
                }
            )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=compact_error_message(exc)) from exc
    return {"ok": True, "language": "es", "results": results}


def api_audio(project_id: str) -> FileResponse:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    audio_path = project_media_path(project, "audio_path", "audio")
    if audio_path and audio_path.is_file():
        return FileResponse(audio_path, media_type="audio/wav")
    source = project_media_path(project, "source_path", "source")
    if source and source.is_file():
        return FileResponse(source)
    raise HTTPException(status_code=404, detail="Audio no encontrado")


def api_export(project_id: str, fmt: str, audio: str = "true", browser_settings: str = "") -> Response:
    project_id = validate_project_id(project_id)
    project = load_project(project_id)
    safe_name = clean_filename(project.get("name") or "transcripcion")
    if fmt in {"package", "package-lite"}:
        include_audio = fmt == "package" and truthy_param(audio)
        suffix = "" if include_audio else "_sin_audio"
        output_path = safe_export_path(project_id, f"{suffix}.transcriptor.zip")
        settings = parse_browser_settings_param(browser_settings)
        write_export_atomically(
            output_path,
            lambda tmp: export_package(project, tmp, include_audio=include_audio, browser_settings=settings),
        )
        return FileResponse(
            output_path,
            media_type="application/zip",
            filename=f"{safe_name}{suffix}.transcriptor.zip",
        )
    if fmt == "txt":
        return PlainTextResponse(
            export_txt(project),
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.txt"'},
        )
    if fmt == "srt":
        return PlainTextResponse(
            export_srt(project),
            media_type="application/x-subrip",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.srt"'},
        )
    if fmt == "vtt":
        return PlainTextResponse(
            export_srt(project, vtt=True),
            media_type="text/vtt",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.vtt"'},
        )
    if fmt == "json":
        payload = json.dumps(project, ensure_ascii=False, indent=2)
        return JSONResponse(
            content=json.loads(payload),
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )
    if fmt == "docx":
        output_path = safe_export_path(project_id, ".docx")
        write_export_atomically(output_path, lambda tmp: export_docx(project, tmp))
        return FileResponse(
            output_path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=f"{safe_name}.docx",
        )
    if fmt == "docx-ts":
        output_path = safe_export_path(project_id, "-timestamps.docx")
        write_export_atomically(output_path, lambda tmp: export_docx(project, tmp, include_timestamps=True))
        return FileResponse(
            output_path,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename=f"{safe_name}_timestamps.docx",
        )
    raise HTTPException(status_code=404, detail="Formato no soportado")


def delete_project_files(project_id: str) -> None:
    project_id = validate_project_id(project_id)
    pdir = project_dir(project_id)
    if not pdir.exists():
        raise HTTPException(status_code=404, detail="Proyecto no encontrado")
    stop_project_for_delete(project_id)
    shutil.rmtree(pdir)
    for export_path in EXPORTS_DIR.glob(f"{project_id}*"):
        if export_path.is_file():
            export_path.unlink(missing_ok=True)
    for export_path in EXPORTS_DIR.glob(f"{EXPORT_TEMP_PREFIX}*{project_id}*"):
        if export_path.is_file():
            export_path.unlink(missing_ok=True)
    with JOBS_LOCK:
        JOBS.pop(project_id, None)
        RUNNING_PROCESSES.pop(project_id, None)


def api_delete_project(project_id: str) -> dict[str, Any]:
    project_id = validate_project_id(project_id)
    delete_project_files(project_id)
    return {"ok": True}


def find_available_port(host: str, preferred_port: int, attempts: int = 25) -> int:
    for port in range(preferred_port, preferred_port + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"No encontre un puerto libre entre {preferred_port} y {preferred_port + attempts - 1}.")


def configure_windows_event_loop_policy() -> None:
    if platform.system() != "Windows":
        return
    selector_policy = getattr(asyncio, "WindowsSelectorEventLoopPolicy", None)
    if selector_policy is None:
        return
    if isinstance(asyncio.get_event_loop_policy(), selector_policy):
        return
    asyncio.set_event_loop_policy(selector_policy())


def uvicorn_loop_name() -> str:
    if platform.system() == "Windows":
        return "none"
    return "auto"



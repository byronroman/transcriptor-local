from __future__ import annotations

import json
import math
import re
import shutil
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import HTTPException

from app.config import (
    ALLOWED_IMPORT_AUDIO_SUFFIXES,
    ALLOWED_PACKAGE_DIAGNOSTICS,
    BROWSER_SETTINGS_FORMAT,
    BROWSER_SETTINGS_MEMBER,
    MAX_BROWSER_SETTINGS_BYTES,
    MAX_IMPORTED_SEGMENTS,
    MAX_IMPORTED_TEXT_CHARS,
    MAX_IMPORT_PACKAGE_BYTES,
    MAX_PACKAGE_AUDIO_BYTES,
    MAX_PACKAGE_DIAGNOSTIC_BYTES,
    MAX_PACKAGE_JSON_BYTES,
    MAX_PACKAGE_MEMBERS,
)
from app.services.speaker_separation import default_speaker_labels


@dataclass(frozen=True)
class PackageDeps:
    now_ms: Callable[[], int]
    clean_filename: Callable[[str], str]
    project_dir: Callable[[str], Path]
    project_media_path: Callable[[dict[str, Any], str, str], Optional[Path]]
    project_content_revision: Callable[[dict[str, Any]], int]
    save_project: Callable[[dict[str, Any]], None]
    append_project_log: Callable[[str, str], None]
    list_projects: Callable[[], list[dict[str, Any]]]
    sha256_file: Callable[[Path], str]


def truthy_param(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "si", "sí", "sÃ­", "sÃƒÂ­", "on"}


def safe_zip_member(name: str) -> str:
    raw = str(name or "")
    if not raw or "\x00" in raw:
        raise HTTPException(status_code=400, detail="Paquete invalido: ruta vacia.")
    if raw.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", raw):
        raise HTTPException(status_code=400, detail="Paquete invalido: ruta no permitida.")
    normalized = raw.replace("\\", "/")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=400, detail="Paquete invalido: ruta no permitida.")
    return "/".join(parts)


def package_member_allowed(member: str) -> bool:
    if member in {"project.json", "manifest.json"}:
        return True
    if member == BROWSER_SETTINGS_MEMBER:
        return True
    parts = member.split("/")
    if len(parts) != 2:
        return False
    if parts[0] == "audio":
        suffix = Path(parts[1]).suffix.lower() or ".audio"
        return suffix in ALLOWED_IMPORT_AUDIO_SUFFIXES
    if parts[0] == "diagnostics":
        return parts[1] in ALLOWED_PACKAGE_DIAGNOSTICS
    return False


def is_zip_symlink(info: zipfile.ZipInfo) -> bool:
    return ((info.external_attr >> 16) & 0o170000) == 0o120000


def validated_package_entries(package: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    entries: dict[str, zipfile.ZipInfo] = {}
    total_size = 0
    for info in package.infolist():
        if info.is_dir():
            continue
        if is_zip_symlink(info):
            raise HTTPException(status_code=400, detail="Paquete invalido: enlaces simbolicos no permitidos.")
        member = safe_zip_member(info.filename)
        if not package_member_allowed(member):
            raise HTTPException(status_code=400, detail=f"Paquete invalido: archivo no permitido ({member}).")
        if member in entries:
            raise HTTPException(status_code=400, detail=f"Paquete invalido: archivo duplicado ({member}).")
        total_size += int(info.file_size or 0)
        if total_size > MAX_IMPORT_PACKAGE_BYTES:
            raise HTTPException(status_code=400, detail="Paquete invalido: contenido demasiado grande.")
        entries[member] = info
        if len(entries) > MAX_PACKAGE_MEMBERS:
            raise HTTPException(status_code=400, detail="Paquete invalido: demasiados archivos.")
    if "project.json" not in entries:
        raise HTTPException(status_code=400, detail="Paquete invalido: falta project.json.")
    return entries


def normalize_browser_settings(payload: Any) -> Optional[dict[str, Any]]:
    if not isinstance(payload, dict):
        return None
    preferences_obj = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else payload
    if not isinstance(preferences_obj, dict):
        return None
    preferences: dict[str, Any] = {str(key): value for key, value in preferences_obj.items()}

    normalized: dict[str, Any] = {}
    theme = str(preferences.get("theme") or "").strip().lower()
    if theme in {"dark", "light"}:
        normalized["theme"] = theme

    for key in ("sidebarCollapsed", "speakersPanelOpen", "proofreadEnabled", "audioMuted"):
        value = preferences.get(key)
        if isinstance(value, bool):
            normalized[key] = value

    if "audioVolume" in preferences:
        raw_volume = preferences.get("audioVolume")
        try:
            volume = float(raw_volume) if raw_volume is not None else math.nan
        except (TypeError, ValueError):
            volume = math.nan
        if math.isfinite(volume):
            normalized["audioVolume"] = round(max(0.0, min(1.0, volume)), 3)

    if "audioPlaybackRate" in preferences:
        raw_rate = preferences.get("audioPlaybackRate")
        try:
            rate = float(raw_rate) if raw_rate is not None else math.nan
        except (TypeError, ValueError):
            rate = math.nan
        if math.isfinite(rate):
            allowed_rates = (0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0)
            normalized["audioPlaybackRate"] = min(allowed_rates, key=lambda item: abs(item - rate))

    if not normalized:
        return None
    result: dict[str, Any] = {
        "format": BROWSER_SETTINGS_FORMAT,
        "version": 1,
        "preferences": normalized,
    }
    exported_at = payload.get("exported_at")
    if isinstance(exported_at, (int, float)) and math.isfinite(float(exported_at)) and exported_at > 0:
        result["exported_at"] = int(exported_at)
    return result


def parse_browser_settings_param(raw: str = "") -> Optional[dict[str, Any]]:
    if not raw:
        return None
    if len(raw.encode("utf-8")) > MAX_BROWSER_SETTINGS_BYTES:
        raise HTTPException(status_code=400, detail="Las preferencias del navegador son demasiado grandes.")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Preferencias del navegador invalidas.") from exc
    return normalize_browser_settings(payload)


def read_package_json(package: zipfile.ZipFile, entries: dict[str, zipfile.ZipInfo], member: str) -> dict[str, Any]:
    try:
        info = entries[member]
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"Paquete invalido: falta {member}.") from exc
    if info.file_size > MAX_PACKAGE_JSON_BYTES:
        raise HTTPException(status_code=400, detail=f"Paquete invalido: {member} es demasiado grande.")
    try:
        with package.open(info) as file:
            payload = json.loads(file.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=f"Paquete invalido: {member} no es JSON valido.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail=f"Paquete invalido: {member} debe ser objeto JSON.")
    return payload


def read_package_browser_settings(
    package: zipfile.ZipFile,
    entries: dict[str, zipfile.ZipInfo],
) -> Optional[dict[str, Any]]:
    info = entries.get(BROWSER_SETTINGS_MEMBER)
    if not info:
        return None
    if info.file_size > MAX_BROWSER_SETTINGS_BYTES:
        raise HTTPException(status_code=400, detail="Paquete invalido: preferencias del navegador demasiado grandes.")
    return normalize_browser_settings(read_package_json(package, entries, BROWSER_SETTINGS_MEMBER))


def portable_project(project: dict[str, Any], deps: PackageDeps) -> dict[str, Any]:
    portable = json.loads(json.dumps(project, ensure_ascii=False))
    portable["portable_format"] = "transcriptor-local-project"
    portable["portable_version"] = 1
    portable["original_id"] = project.get("id")
    portable["exported_at"] = deps.now_ms()
    portable["source_path"] = ""
    portable["audio_path"] = ""
    portable["status"] = "done" if portable.get("segments") else portable.get("status", "done")
    return portable


def project_audio_for_package(project: dict[str, Any], deps: PackageDeps) -> tuple[Optional[Path], str]:
    project_id = project.get("id")
    if not project_id:
        return None, ""
    source = deps.project_media_path(project, "source_path", "source")
    if source and source.exists() and source.is_file():
        suffix = source.suffix or Path(project.get("source_name") or "").suffix or ".audio"
        return source, f"audio/source{suffix}"
    audio = deps.project_media_path(project, "audio_path", "audio")
    if audio and audio.exists() and audio.is_file():
        return audio, f"audio/audio{audio.suffix or '.wav'}"
    return None, ""


def add_file_if_exists(package: zipfile.ZipFile, path: Path, arcname: str) -> bool:
    if path.exists() and path.is_file():
        package.write(path, arcname)
        return True
    return False


def export_package(
    project: dict[str, Any],
    output_path: Path,
    deps: PackageDeps,
    include_audio: bool = True,
    browser_settings: Optional[dict[str, Any]] = None,
) -> None:
    pdir = deps.project_dir(project["id"])
    portable = portable_project(project, deps)
    normalized_browser_settings = normalize_browser_settings(browser_settings) if browser_settings else None
    manifest: dict[str, Any] = {
        "format": "transcriptor-local-package",
        "version": 1,
        "created_at": deps.now_ms(),
        "app": "Transcriptor Mi Cami",
        "project": {
            "id": project.get("id"),
            "name": project.get("name"),
            "segments": len(project.get("segments") or []),
            "speakers": len(project.get("speaker_labels") or {}),
            "has_diarization": bool(project.get("diarization_turns")),
        },
        "audio": None,
    }
    if normalized_browser_settings:
        manifest["settings"] = {
            "browser": {
                "path": BROWSER_SETTINGS_MEMBER,
                "preferences": sorted(normalized_browser_settings["preferences"].keys()),
            }
        }

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as package:
        if include_audio:
            audio_path, audio_arcname = project_audio_for_package(project, deps)
            if audio_path and audio_arcname:
                package.write(audio_path, audio_arcname)
                manifest["audio"] = {"path": audio_arcname, "source_name": project.get("source_name") or audio_path.name}
                if audio_arcname.startswith("audio/source"):
                    portable["source_path"] = audio_arcname
                    portable["audio_path"] = ""
                else:
                    portable["source_path"] = ""
                    portable["audio_path"] = audio_arcname

        package.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        package.writestr("project.json", json.dumps(portable, ensure_ascii=False, indent=2))
        if normalized_browser_settings:
            package.writestr(
                BROWSER_SETTINGS_MEMBER,
                json.dumps(normalized_browser_settings, ensure_ascii=False, indent=2),
            )

        for filename in (
            "whisper_quality.json",
            "diarization_quality.json",
            "diarization_turns.json",
            "process.log",
        ):
            add_file_if_exists(package, pdir / filename, f"diagnostics/{filename}")


def copy_package_member(package: zipfile.ZipFile, info: zipfile.ZipInfo, destination: Path, max_bytes: int, description: str) -> None:
    if info.file_size > max_bytes:
        raise HTTPException(status_code=400, detail=f"{description} del paquete es demasiado grande.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with package.open(info) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target)


def inspect_project_package(package_path: Path, deps: PackageDeps) -> dict[str, Any]:
    try:
        package = zipfile.ZipFile(package_path)
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Paquete invalido: no es un ZIP valido.") from exc
    with package:
        entries = validated_package_entries(package)
        project = read_package_json(package, entries, "project.json")
        manifest = read_package_json(package, entries, "manifest.json") if "manifest.json" in entries else {}
        preview_project = json.loads(json.dumps(project, ensure_ascii=False))
        normalize_imported_segments(preview_project)
        segments = preview_project.get("segments") if isinstance(preview_project.get("segments"), list) else []
        labels = preview_project.get("speaker_labels") if isinstance(preview_project.get("speaker_labels"), dict) else {}
        turns = preview_project.get("diarization_turns") if isinstance(preview_project.get("diarization_turns"), list) else []
        manifest_project = manifest.get("project") if isinstance(manifest.get("project"), dict) else {}
        manifest_audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
        audio_member = safe_zip_member(str(manifest_audio.get("path") or "")) if manifest_audio.get("path") else ""
        audio_entry = entries.get(audio_member) if audio_member else None
        browser_settings = read_package_browser_settings(package, entries)
    original_id = project.get("original_id") or project.get("id")
    return {
        "original_id": str(original_id or ""),
        "name": deps.clean_filename(str(project.get("name") or "Transcripcion importada")),
        "package_sha256": deps.sha256_file(package_path),
        "manifest": manifest,
        "segments": len(segments),
        "speakers": len(labels) or len({str(segment.get("speaker") or "") for segment in segments if isinstance(segment, dict)}),
        "has_diarization": bool(turns or manifest_project.get("has_diarization")),
        "has_audio": bool(audio_entry),
        "has_browser_settings": bool(browser_settings),
        "browser_settings": browser_settings,
        "audio_name": str(manifest_audio.get("source_name") or Path(audio_member).name) if audio_member else "",
        "audio_bytes": int(audio_entry.file_size) if audio_entry else 0,
        "created_at": project.get("created_at") or manifest.get("created_at"),
        "updated_at": project.get("updated_at") or project.get("exported_at") or manifest.get("created_at"),
    }


def find_duplicate_import(package_info: dict[str, Any], deps: PackageDeps) -> Optional[dict[str, Any]]:
    original_id = package_info.get("original_id")
    package_sha256 = package_info.get("package_sha256")
    for project in deps.list_projects():
        imported_from = project.get("imported_from") if isinstance(project.get("imported_from"), dict) else {}
        if package_sha256 and imported_from.get("package_sha256") == package_sha256:
            return project
        if original_id and (project.get("id") == original_id or imported_from.get("original_id") == original_id):
            return project
    return None


def unique_project_name(base_name: str, deps: PackageDeps) -> str:
    existing = {str(project.get("name") or "") for project in deps.list_projects()}
    if base_name not in existing:
        return base_name
    first_copy = f"{base_name} (copia)"
    if first_copy not in existing:
        return first_copy
    index = 2
    while True:
        candidate = f"{base_name} (copia {index})"
        if candidate not in existing:
            return candidate
        index += 1


def normalize_imported_segments(project: dict[str, Any]) -> None:
    segments = project.get("segments")
    if not isinstance(segments, list):
        raise HTTPException(status_code=400, detail="Paquete invalido: no contiene segmentos.")
    if len(segments) > MAX_IMPORTED_SEGMENTS:
        raise HTTPException(status_code=400, detail="Paquete invalido: demasiados segmentos.")
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise HTTPException(status_code=400, detail="Paquete invalido: segmento invalido.")
        segment.setdefault("id", f"seg-{index:05d}")
        try:
            start = float(segment.get("start") or 0)
            end = float(segment.get("end") or start)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Paquete invalido: timestamps invalidos.") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < 0:
            raise HTTPException(status_code=400, detail="Paquete invalido: timestamps invalidos.")
        if end < start:
            raise HTTPException(status_code=400, detail="Paquete invalido: segmento con fin antes del inicio.")
        segment["id"] = str(segment.get("id") or f"seg-{index:05d}")[:80]
        segment["start"] = start
        segment["end"] = end
        segment["speaker"] = str(segment.get("speaker") or "SPEAKER_00")[:80]
        segment["text"] = str(segment.get("text") or "")[:MAX_IMPORTED_TEXT_CHARS]
    labels = project.get("speaker_labels")
    if not isinstance(labels, dict):
        project["speaker_labels"] = default_speaker_labels(segments, {})
    else:
        project["speaker_labels"] = {str(key)[:80]: str(value)[:120] for key, value in list(labels.items())[:1000]}
    turns = project.get("diarization_turns")
    if turns is not None and not isinstance(turns, list):
        project["diarization_turns"] = []
    elif isinstance(turns, list):
        normalized_turns = []
        for turn in turns[: MAX_IMPORTED_SEGMENTS * 3]:
            if not isinstance(turn, dict):
                continue
            try:
                start = float(turn.get("start") or 0)
                end = float(turn.get("end") or start)
            except (TypeError, ValueError):
                continue
            if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
                continue
            normalized_turns.append(
                {
                    "start": start,
                    "end": end,
                    "speaker": str(turn.get("speaker") or "SPEAKER_00")[:80],
                }
            )
        project["diarization_turns"] = normalized_turns


def import_project_package(
    package_path: Path,
    deps: PackageDeps,
    package_info: Optional[dict[str, Any]] = None,
    copy_name: bool = False,
) -> dict[str, Any]:
    try:
        package = zipfile.ZipFile(package_path)
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail="Paquete invalido: no es un ZIP valido.") from exc

    with package:
        entries = validated_package_entries(package)
        project = read_package_json(package, entries, "project.json")
        manifest = read_package_json(package, entries, "manifest.json") if "manifest.json" in entries else {}
        normalize_imported_segments(project)
        browser_settings = (package_info or {}).get("browser_settings") or read_package_browser_settings(package, entries)
        manifest_audio = manifest.get("audio") if isinstance(manifest.get("audio"), dict) else {}
        audio_info = manifest_audio
        audio_member = safe_zip_member(str(audio_info.get("path") or "")) if audio_info.get("path") else ""

        project_id = uuid.uuid4().hex[:12]
        pdir = deps.project_dir(project_id)
        pdir.mkdir(parents=True, exist_ok=True)
        try:
            original_id = (package_info or {}).get("original_id") or project.get("original_id") or project.get("id")
            base_name = deps.clean_filename(str(project.get("name") or (package_info or {}).get("name") or "Transcripcion importada"))
            project["id"] = project_id
            project["name"] = unique_project_name(base_name, deps) if copy_name else base_name
            project["source_name"] = str(project.get("source_name") or manifest_audio.get("source_name") or "")
            project["status"] = "done"
            project["content_revision"] = deps.project_content_revision(project)
            project["created_at"] = deps.now_ms()
            project["updated_at"] = deps.now_ms()
            project["imported_at"] = deps.now_ms()
            project["imported_from"] = {
                "original_id": original_id,
                "package_format": manifest.get("format") or "transcriptor-local-package",
                "package_sha256": (package_info or {}).get("package_sha256") or deps.sha256_file(package_path),
            }
            project["error"] = None
            project["warnings"] = project.get("warnings") if isinstance(project.get("warnings"), list) else []
            project["source_path"] = ""
            project["audio_path"] = ""

            if audio_member and audio_member in entries:
                suffix = Path(audio_member).suffix or ".audio"
                destination = pdir / f"source{suffix}"
                copy_package_member(package, entries[audio_member], destination, MAX_PACKAGE_AUDIO_BYTES, "El audio")
                project["source_path"] = str(destination)
                project["source_name"] = project.get("source_name") or Path(audio_member).name

            for filename in ("whisper_quality.json", "diarization_quality.json", "diarization_turns.json", "process.log"):
                member = f"diagnostics/{filename}"
                if member in entries:
                    copy_package_member(package, entries[member], pdir / filename, MAX_PACKAGE_DIAGNOSTIC_BYTES, "El diagnostico")

            deps.save_project(project)
            deps.append_project_log(project_id, f"Proyecto importado desde paquete portable. Original: {original_id or 'desconocido'}.")
            if browser_settings:
                project["browser_settings"] = browser_settings
            return project
        except Exception:
            shutil.rmtree(pdir, ignore_errors=True)
            raise

from __future__ import annotations

from pathlib import Path, PurePosixPath
from re import Pattern
from typing import Any, Optional

from fastapi import HTTPException


def validate_project_id(project_id: str, project_id_re: Pattern[str], not_found_detail: str) -> str:
    value = str(project_id or "")
    if value != value.strip():
        raise HTTPException(status_code=404, detail=not_found_detail)
    value = value.lower()
    if not project_id_re.fullmatch(value):
        raise HTTPException(status_code=404, detail=not_found_detail)
    return value


def safe_project_dir(project_id: str, projects_dir: Path, project_id_re: Pattern[str], not_found_detail: str) -> Path:
    validated = validate_project_id(project_id, project_id_re, not_found_detail)
    root = projects_dir.resolve()
    path = (root / validated).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=not_found_detail) from exc
    return path


def project_owned_path(project_dir: Path, raw_path: Any) -> Optional[Path]:
    text = str(raw_path or "").strip()
    if not text:
        return None
    pdir = project_dir.resolve()
    candidate = Path(text)
    if not candidate.is_absolute():
        candidate = pdir / candidate
    try:
        resolved = candidate.resolve()
        resolved.relative_to(pdir)
    except (OSError, ValueError):
        return None
    return resolved


def path_leaf(raw_path: Any) -> str:
    text = str(raw_path or "").strip()
    if not text or "\x00" in text:
        return ""
    return PurePosixPath(text.replace("\\", "/")).name


def allowed_audio_file(path: Path, allowed_suffixes: set[str]) -> bool:
    return path.is_file() and (path.suffix.lower() or ".audio") in allowed_suffixes


def project_media_fallback(
    project_dir: Path,
    raw_path: Any,
    role: str,
    allowed_suffixes: set[str],
    source_name: Any = "",
) -> Optional[Path]:
    candidates: list[Path] = []
    seen: set[str] = set()

    def add_name(name: Any) -> None:
        leaf = path_leaf(name)
        if not leaf:
            return
        candidate = project_dir / leaf
        key = candidate.name.lower()
        if key not in seen:
            seen.add(key)
            candidates.append(candidate)

    def add_path(path: Path) -> None:
        key = path.name.lower()
        if key not in seen:
            seen.add(key)
            candidates.append(path)

    add_name(raw_path)
    if role == "source":
        add_name(source_name)
        for path in sorted(project_dir.glob("source.*")):
            add_path(path)
    elif role == "audio":
        add_name("audio_16k.wav")
        for path in sorted(project_dir.glob("audio_16k.*")):
            add_path(path)

    for candidate in candidates:
        if allowed_audio_file(candidate, allowed_suffixes):
            return candidate
    return None


def project_media_path(
    project: dict[str, Any],
    key: str,
    role: str,
    projects_dir: Path,
    project_id_re: Pattern[str],
    not_found_detail: str,
    allowed_suffixes: set[str],
) -> Optional[Path]:
    project_id = validate_project_id(str(project.get("id") or ""), project_id_re, not_found_detail)
    pdir = safe_project_dir(project_id, projects_dir, project_id_re, not_found_detail)
    owned = project_owned_path(pdir, project.get(key))
    if owned and allowed_audio_file(owned, allowed_suffixes):
        return owned
    return project_media_fallback(pdir, project.get(key), role, allowed_suffixes, project.get("source_name"))


def repair_project_media_paths(
    project: dict[str, Any],
    projects_dir: Path,
    project_id_re: Pattern[str],
    not_found_detail: str,
    allowed_suffixes: set[str],
) -> list[str]:
    project_id = validate_project_id(str(project.get("id") or ""), project_id_re, not_found_detail)
    pdir = safe_project_dir(project_id, projects_dir, project_id_re, not_found_detail).resolve()
    repaired: list[str] = []
    for key, role in (("source_path", "source"), ("audio_path", "audio")):
        value = project.get(key)
        if not value:
            continue
        owned = project_owned_path(pdir, value)
        if owned and allowed_audio_file(owned, allowed_suffixes):
            continue
        fallback = project_media_fallback(pdir, value, role, allowed_suffixes, project.get("source_name"))
        if not fallback:
            continue
        try:
            project[key] = str(fallback.resolve().relative_to(pdir))
        except ValueError:
            continue
        repaired.append(key)
    return repaired

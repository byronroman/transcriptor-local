from __future__ import annotations

import hashlib
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Optional


def parse_java_major_version(text: str) -> Optional[int]:
    match = re.search(r'version\s+"?([0-9]+)(?:\.([0-9]+))?', text or "", re.IGNORECASE)
    if not match:
        return None
    first = int(match.group(1))
    second = int(match.group(2) or 0)
    if first == 1 and second:
        return second
    return first


def java_install_hint(system: Optional[str] = None) -> str:
    system = system or platform.system()
    if system == "Windows":
        return "Instala Java 17 o superior de 64 bits. Con winget: winget install -e --id EclipseAdoptium.Temurin.17.JRE"
    if system == "Darwin":
        return "Instala Java 17 o superior. Con Homebrew: brew install --cask temurin"
    return "Instala Java 17 o superior y vuelve a activar el corrector."


def java_candidate_paths(system: Optional[str] = None, environ: Optional[dict[str, str]] = None) -> list[Path]:
    system = system or platform.system()
    environ = environ or os.environ
    executable = "java.exe" if system == "Windows" else "java"
    candidates: list[Path] = []
    seen: set[str] = set()

    def add(candidate: Optional[Path | str]) -> None:
        if not candidate:
            return
        path = Path(candidate)
        key = str(path).lower() if system == "Windows" else str(path)
        if key in seen:
            return
        seen.add(key)
        candidates.append(path)

    java_home = environ.get("JAVA_HOME")
    if java_home:
        add(Path(java_home) / "bin" / executable)
    add(shutil.which("java"))

    if system == "Windows":
        install_roots = [
            environ.get("ProgramW6432"),
            environ.get("ProgramFiles"),
            environ.get("ProgramFiles(x86)"),
        ]
        patterns = (
            "Eclipse Adoptium/*/bin/java.exe",
            "Java/*/bin/java.exe",
            "Microsoft/jdk-*/bin/java.exe",
            "Microsoft/*/bin/java.exe",
            "BellSoft/*/bin/java.exe",
            "Amazon Corretto/*/bin/java.exe",
        )
        for root in install_roots:
            if not root:
                continue
            base = Path(root)
            for pattern in patterns:
                for path in base.glob(pattern):
                    add(path)

    return candidates


def java_version_for_path(
    java_bin: Path,
    *,
    compact_error_message: Callable[[Exception], str],
) -> tuple[Optional[int], str]:
    try:
        result = subprocess.run(
            [str(java_bin), "-version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=8,
        )
    except Exception as exc:
        return None, compact_error_message(exc)
    output = "\n".join(part for part in (result.stderr, result.stdout) if part)
    if result.returncode != 0:
        return None, output.strip()
    return parse_java_major_version(output), output


def activate_java_runtime(java_bin: Path, environ: Optional[dict[str, str]] = None) -> None:
    environ = environ or os.environ
    bin_dir = str(java_bin.parent)
    current_path = environ.get("PATH", "")
    path_parts = current_path.split(os.pathsep) if current_path else []
    if not any(part.lower() == bin_dir.lower() for part in path_parts):
        environ["PATH"] = bin_dir + (os.pathsep + current_path if current_path else "")
    environ["JAVA_HOME"] = str(java_bin.parent.parent)


def language_tool_dir_has_jar(directory: Path, jar_patterns: tuple[str, ...]) -> bool:
    return any(path.is_file() for pattern in jar_patterns for path in directory.glob(pattern))


def latest_language_tool_dir(base_dir: Path, jar_patterns: tuple[str, ...]) -> Optional[Path]:
    if not base_dir.is_dir():
        return None
    candidates = [
        path
        for path in base_dir.glob("LanguageTool*")
        if path.is_dir() and language_tool_dir_has_jar(path, jar_patterns)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.name)


def configure_language_tool_paths(
    language_tool_dir: Path,
    jar_patterns: tuple[str, ...],
    *,
    home_dir: Optional[Path] = None,
    environ: Optional[dict[str, str]] = None,
) -> None:
    environ = environ or os.environ
    home_dir = home_dir or Path.home()
    language_tool_dir.mkdir(parents=True, exist_ok=True)
    if environ.get("LTP_JAR_DIR_PATH"):
        return
    for base_dir in (language_tool_dir, home_dir / ".cache" / "language_tool_python"):
        existing = latest_language_tool_dir(base_dir, jar_patterns)
        if existing is not None:
            environ["LTP_JAR_DIR_PATH"] = str(existing)
            environ.setdefault("LTP_PATH", str(base_dir))
            return
    environ.setdefault("LTP_PATH", str(language_tool_dir))


def proofread_cache_key(language: str, text: str) -> str:
    normalized_language = "es" if not language or language.lower().startswith("es") else language
    digest = hashlib.sha256(f"{normalized_language}\0{text}".encode("utf-8")).hexdigest()
    return digest


def normalize_language(language: str = "es") -> str:
    return "es" if not language or language.lower().startswith("es") else language


def serialize_proofread_match(match: Any, text: str) -> dict[str, Any]:
    offset = max(0, int(getattr(match, "offset", 0) or 0))
    length = max(0, int(getattr(match, "errorLength", 0) or 0))
    issue_text = text[offset : offset + length]
    replacements = [str(item) for item in (getattr(match, "replacements", None) or [])[:6]]
    category = getattr(getattr(match, "category", None), "name", None) or getattr(match, "category", None)
    return {
        "offset": offset,
        "length": length,
        "text": issue_text,
        "message": str(getattr(match, "message", "") or "Revisar texto"),
        "short_message": str(getattr(match, "shortMessage", "") or ""),
        "rule_id": str(getattr(match, "ruleId", "") or ""),
        "category": str(category or ""),
        "issue_type": str(getattr(match, "ruleIssueType", "") or ""),
        "replacements": replacements,
    }

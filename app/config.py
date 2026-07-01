from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT_DIR / "static"
DATA_DIR = ROOT_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"
EXPORTS_DIR = DATA_DIR / "exports"
MODELS_DIR = ROOT_DIR / "models"
TOOLS_DIR = ROOT_DIR / "tools"
LANGUAGETOOL_DIR = TOOLS_DIR / "languagetool"
LANGUAGETOOL_VERSION = os.environ.get("LANGUAGETOOL_VERSION", "6.6")
MIN_LANGUAGETOOL_JAVA_MAJOR = int(os.environ.get("MIN_LANGUAGETOOL_JAVA_MAJOR", "17"))
LANGUAGETOOL_JAR_PATTERNS = (
    "languagetool-server.jar",
    "languagetool-standalone*.jar",
    "LanguageTool.jar",
    "LanguageTool.uno.jar",
)
MAX_IMPORT_PACKAGE_BYTES = int(os.environ.get("MAX_IMPORT_PACKAGE_BYTES", str(2_200_000_000)))
MAX_PACKAGE_MEMBERS = int(os.environ.get("MAX_PACKAGE_MEMBERS", "32"))
MAX_PACKAGE_JSON_BYTES = int(os.environ.get("MAX_PACKAGE_JSON_BYTES", str(50_000_000)))
MAX_BROWSER_SETTINGS_BYTES = int(os.environ.get("MAX_BROWSER_SETTINGS_BYTES", str(32_000)))
MAX_PACKAGE_DIAGNOSTIC_BYTES = int(os.environ.get("MAX_PACKAGE_DIAGNOSTIC_BYTES", str(50_000_000)))
MAX_PACKAGE_AUDIO_BYTES = int(os.environ.get("MAX_PACKAGE_AUDIO_BYTES", str(2_000_000_000)))
MAX_UPLOAD_AUDIO_BYTES = int(os.environ.get("MAX_UPLOAD_AUDIO_BYTES", str(2_200_000_000)))
MAX_IMPORTED_SEGMENTS = int(os.environ.get("MAX_IMPORTED_SEGMENTS", "100000"))
MAX_IMPORTED_TEXT_CHARS = int(os.environ.get("MAX_IMPORTED_TEXT_CHARS", "50000"))
EXPORT_TEMP_MAX_AGE_SECONDS = int(os.environ.get("EXPORT_TEMP_MAX_AGE_SECONDS", str(24 * 60 * 60)))
EXPORT_TEMP_PREFIX = ".tmp-"
ALLOWED_PACKAGE_DIAGNOSTICS = {
    "whisper_quality.json",
    "diarization_quality.json",
    "diarization_turns.json",
    "process.log",
}
BROWSER_SETTINGS_MEMBER = "settings/browser.json"
BROWSER_SETTINGS_FORMAT = "transcriptor-local-browser-settings"
ALLOWED_IMPORT_AUDIO_SUFFIXES = {
    ".aac",
    ".aiff",
    ".aif",
    ".audio",
    ".flac",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}

HOST = "127.0.0.1"
PORT = int(os.environ.get("TRANSCRIPTOR_PORT", "8765"))
DIARIZATION_CHUNK_SECONDS = float(os.environ.get("DIARIZATION_CHUNK_SECONDS", "180"))
DIARIZATION_CHUNK_OVERLAP_SECONDS = float(os.environ.get("DIARIZATION_CHUNK_OVERLAP_SECONDS", "3"))
DEFAULT_DIARIZATION_SPEAKERS = int(os.environ.get("DEFAULT_DIARIZATION_SPEAKERS", "2"))
WHISPER_CHUNK_SECONDS = float(os.environ.get("WHISPER_CHUNK_SECONDS", "120"))
WHISPER_CHUNK_OVERLAP_SECONDS = float(os.environ.get("WHISPER_CHUNK_OVERLAP_SECONDS", "10"))
WHISPER_RETRY_CHUNK_SECONDS = tuple(
    float(value.strip())
    for value in os.environ.get("WHISPER_RETRY_CHUNK_SECONDS", "60,45,30,20").split(",")
    if value.strip()
)
WHISPER_MAX_NON_SILENT_GAP_SECONDS = float(os.environ.get("WHISPER_MAX_NON_SILENT_GAP_SECONDS", "30"))
WHISPER_RMS_SPEECH_THRESHOLD = float(os.environ.get("WHISPER_RMS_SPEECH_THRESHOLD", "80"))
WHISPER_MAX_LEN = int(os.environ.get("WHISPER_MAX_LEN", "120"))

PROCESSING_PROFILES: dict[str, dict[str, Any]] = {
    "calidad": {
        "label": "Calidad",
        "chunk_seconds": 120.0,
        "overlap_seconds": 10.0,
        "retry_chunk_seconds": [60.0, 45.0, 30.0, 20.0],
        "max_threads": 4,
    },
    "seguro_windows": {
        "label": "Seguro Windows",
        "chunk_seconds": 60.0,
        "overlap_seconds": 8.0,
        "retry_chunk_seconds": [45.0, 30.0, 20.0],
        "max_threads": 1,
    },
    "rapido": {
        "label": "Rapido",
        "chunk_seconds": 90.0,
        "overlap_seconds": 8.0,
        "retry_chunk_seconds": [45.0, 30.0, 20.0],
        "max_threads": 4,
        "prefer_model": "large-v3-turbo",
    },
}

WHISPER_MODEL_INTEGRITY = {
    "ggml-large-v3.bin": {
        "size": 3095033483,
        "sha256": "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    }
}
PROJECT_ID_RE = re.compile(r"^[a-f0-9]{12}$")
PROJECT_NOT_FOUND_DETAIL = "Proyecto no encontrado"


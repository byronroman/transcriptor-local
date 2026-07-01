from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
MODELS = ROOT / "models"

WHISPER_MODELS = {
    "small": {
        "file": "ggml-small-q5_1.bin",
        "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    },
    "medium": {
        "file": "ggml-medium-q5_0.bin",
        "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin",
    },
    "turbo": {
        "file": "ggml-large-v3-turbo-q5_0.bin",
        "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    },
    "large-v3": {
        "file": "ggml-large-v3-q5_0.bin",
        "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
    },
    "large-v3-full": {
        "file": "ggml-large-v3.bin",
        "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        "size": 3095033483,
        "sha256": "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
    },
}

DIARIZATION_FILES = [
    {
        "kind": "archive",
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        "target": MODELS / "diarization" / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx",
    },
    {
        "kind": "file",
        "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        "target": MODELS / "diarization" / "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    },
]


def log(message: str) -> None:
    print(message, flush=True)


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0:
        log(f"OK: {destination}")
        return
    tmp = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "transcriptor-local/1.0"})
    for attempt in range(1, 4):
        try:
            log(f"Descargando: {url}")
            with urllib.request.urlopen(request, timeout=60) as response, tmp.open("wb") as out:
                total = int(response.headers.get("Content-Length") or 0)
                done = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 / total
                        print(f"\r  {pct:5.1f}%", end="", flush=True)
                if total:
                    print()
            tmp.replace(destination)
            return
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log(f"Intento {attempt} fallo: {exc}")
            if tmp.exists():
                tmp.unlink()
    raise RuntimeError(f"No pude descargar {url}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def integrity_error(path: Path, info: dict[str, str | int]) -> Optional[str]:
    if not path.exists():
        return None
    expected_size = int(info.get("size") or 0)
    if expected_size and path.stat().st_size != expected_size:
        return f"tamano esperado {expected_size} bytes, encontrado {path.stat().st_size} bytes"
    expected_hash = str(info.get("sha256") or "")
    if expected_hash:
        actual_hash = sha256_file(path)
        if actual_hash != expected_hash:
            return f"sha256 esperado {expected_hash}, encontrado {actual_hash}"
    return None


def github_latest_asset(repo: str, predicate) -> Optional[tuple[str, str]]:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"User-Agent": "transcriptor-local/1.0"},
    )
    data = json.loads(urllib.request.urlopen(request, timeout=60).read().decode("utf-8"))
    for asset in data.get("assets", []):
        name = asset.get("name", "")
        if predicate(name):
            return name, asset["browser_download_url"]
    return None


def install_ffmpeg_windows() -> None:
    target = TOOLS / "ffmpeg" / "ffmpeg.exe"
    if target.exists():
        log(f"OK: {target}")
        return
    asset = github_latest_asset(
        "BtbN/FFmpeg-Builds",
        lambda name: name.endswith(".zip") and "win64-gpl" in name and "shared" not in name,
    )
    if not asset:
        raise RuntimeError("No encontre un build Windows de ffmpeg.")
    name, url = asset
    with tempfile.TemporaryDirectory() as tmpdir:
        archive = Path(tmpdir) / name
        extract_dir = Path(tmpdir) / "ffmpeg"
        download(url, archive)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(extract_dir)
        exe = next(extract_dir.rglob("ffmpeg.exe"), None)
        if not exe:
            raise RuntimeError("El zip de ffmpeg no contiene ffmpeg.exe.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(exe, target)
    log(f"Instalado: {target}")


def install_whisper_windows() -> None:
    target_dir = TOOLS / "whisper"
    target = target_dir / "whisper-cli.exe"
    if target.exists():
        log(f"OK: {target}")
        return
    asset = github_latest_asset(
        "ggml-org/whisper.cpp",
        lambda name: name == "whisper-bin-x64.zip",
    )
    if not asset:
        raise RuntimeError("No encontre whisper-bin-x64.zip.")
    name, url = asset
    with tempfile.TemporaryDirectory() as tmpdir:
        archive = Path(tmpdir) / name
        extract_dir = Path(tmpdir) / "whisper"
        download(url, archive)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(extract_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        for item in extract_dir.rglob("*"):
            if item.is_file() and item.suffix.lower() in {".exe", ".dll"}:
                shutil.copy2(item, target_dir / item.name)
    if not target.exists():
        alternative = target_dir / "main.exe"
        if not alternative.exists():
            raise RuntimeError("No encontre whisper-cli.exe en el paquete de whisper.cpp.")
    log(f"Instalado: {target_dir}")


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def install_tools() -> None:
    system = platform.system().lower()
    if system == "windows":
        install_ffmpeg_windows()
        install_whisper_windows()
    else:
        if command_exists("ffmpeg"):
            log("OK: ffmpeg disponible en PATH")
        else:
            log("Aviso: falta ffmpeg. En Mac instala con: brew install ffmpeg")
        if command_exists("whisper-cli") or command_exists("whisper-cpp") or command_exists("main"):
            log("OK: whisper.cpp disponible en PATH")
        else:
            log("Aviso: falta whisper.cpp. En Mac instala con: brew install whisper-cpp")


def install_whisper_model(name: str) -> None:
    info = WHISPER_MODELS[name]
    target = MODELS / "whisper" / info["file"]
    error = integrity_error(target, info)
    if error:
        log(f"Modelo invalido, se descargara de nuevo: {target.name} ({error})")
        target.unlink()
    download(info["url"], target)
    error = integrity_error(target, info)
    if error:
        target.unlink(missing_ok=True)
        raise RuntimeError(f"Modelo descargado no paso verificacion: {error}")


def safe_extract_tar(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:bz2") as tar:
        root = destination.resolve()
        for member in tar.getmembers():
            member_path = (destination / member.name).resolve()
            if not str(member_path).startswith(str(root)):
                raise RuntimeError("Archivo tar inseguro.")
        tar.extractall(destination)


def install_diarization_models() -> None:
    target_root = MODELS / "diarization"
    target_root.mkdir(parents=True, exist_ok=True)
    for item in DIARIZATION_FILES:
        target = item["target"]
        if target.exists():
            log(f"OK: {target}")
            continue
        if item["kind"] == "file":
            download(item["url"], target)
            continue
        with tempfile.TemporaryDirectory() as tmpdir:
            archive = Path(tmpdir) / Path(item["url"]).name
            download(item["url"], archive)
            safe_extract_tar(archive, target_root)
        if not target.exists():
            raise RuntimeError(f"No encontre modelo esperado: {target}")


def make_scripts_executable() -> None:
    for path in [ROOT / "setup_mac.sh", ROOT / "run_mac.sh"]:
        if path.exists():
            mode = path.stat().st_mode
            path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-diarization", action="store_true")
    parser.add_argument("--quality-models", action="store_true", help="Descarga medium y turbo ademas de small.")
    parser.add_argument("--max-quality-model", action="store_true", help="Descarga large-v3 q5_0 ademas de los modelos anteriores.")
    parser.add_argument("--best-quality-model", action="store_true", help="Descarga large-v3 completo (~3 GB, maxima calidad).")
    args = parser.parse_args()

    TOOLS.mkdir(exist_ok=True)
    MODELS.mkdir(exist_ok=True)
    make_scripts_executable()

    errors = []
    for action in [
        ("herramientas", install_tools),
        ("modelo small", lambda: install_whisper_model("small")),
    ]:
        try:
            action[1]()
        except Exception as exc:
            errors.append(f"{action[0]}: {exc}")
            log(f"Aviso: fallo {action[0]}: {exc}")

    if args.quality_models:
        for name in ["medium", "turbo"]:
            try:
                install_whisper_model(name)
            except Exception as exc:
                errors.append(f"modelo {name}: {exc}")
                log(f"Aviso: fallo modelo {name}: {exc}")

    if args.max_quality_model:
        try:
            install_whisper_model("large-v3")
        except Exception as exc:
            errors.append(f"modelo large-v3: {exc}")
            log(f"Aviso: fallo modelo large-v3: {exc}")

    if args.best_quality_model:
        try:
            install_whisper_model("large-v3-full")
        except Exception as exc:
            errors.append(f"modelo large-v3 completo: {exc}")
            log(f"Aviso: fallo modelo large-v3 completo: {exc}")

    if args.with_diarization:
        try:
            install_diarization_models()
        except Exception as exc:
            errors.append(f"separacion de hablantes: {exc}")
            log(f"Aviso: fallo separacion de hablantes: {exc}")

    if errors:
        log("\nSetup termino con avisos:")
        for error in errors:
            log(f"- {error}")
        return 1
    log("\nHerramientas listas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

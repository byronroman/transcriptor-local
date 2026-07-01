from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
import wave
import zipfile
from pathlib import Path
from unittest import mock

from docx import Document
from fastapi import HTTPException

from app.main import (
    EXPORTS_DIR,
    api_audio,
    api_export,
    api_relabel_speakers,
    api_save_segments,
    assign_speakers,
    compact_error_message,
    default_speaker_labels,
    delete_project_files,
    export_docx,
    import_project_package,
    inspect_project_package,
    format_cleanup_warning,
    format_diarization_quality_warning,
    loop_candidates,
    model_integrity_error,
    model_rank,
    postprocess_diarization_turns,
    processing_profile_settings,
    project_dir,
    relabel_segments_with_diagnostics,
    review_segments_for_quality,
    safe_project_dir,
    safe_zip_member,
    sanitize_internal_loop_segments,
    select_model_for_request,
    SegmentUpdate,
    validate_project_id,
)


class ProcessingProofreadTests(unittest.TestCase):
    def test_seguro_windows_profile_uses_short_chunks_and_one_thread(self) -> None:
        settings = processing_profile_settings("seguro_windows")

        self.assertEqual(settings["chunk_seconds"], 60.0)
        self.assertEqual(settings["max_threads"], 1)

    def test_rapido_profile_prefers_turbo_when_model_is_auto(self) -> None:
        models = [
            {"name": "ggml-large-v3-q5_0.bin"},
            {"name": "ggml-large-v3-turbo-q5_0.bin"},
        ]

        selected = select_model_for_request(models, "auto", "rapido")

        self.assertEqual(selected, "ggml-large-v3-turbo-q5_0.bin")

    def test_review_segment_marks_unrecovered_audio_range(self) -> None:
        segments = review_segments_for_quality(
            [
                {
                    "type": "non_silent_gap",
                    "gaps": [{"start": 35.0, "end": 70.0}],
                }
            ],
            0.0,
            120.0,
        )

        self.assertEqual(len(segments), 1)
        self.assertTrue(segments[0]["needs_review"])
        self.assertIn("Audio no recuperado", segments[0]["text"])

    def test_whisper_manifest_skips_accepted_chunk_on_resume(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_project_dir = app_main.project_dir
            original_run_whisper_file = app_main.run_whisper_file
            app_main.project_dir = lambda _project_id: Path(tmpdir)  # type: ignore[assignment]
            try:
                wav_path = Path(tmpdir) / "audio_16k.wav"
                with wave.open(str(wav_path), "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes(b"\0\0" * 16000)

                audio_info = app_main.audio_signature(wav_path, app_main.wav_duration(wav_path))
                manifest = {
                    "version": 1,
                    "project_id": "abc111def222",
                    "stage": "whisper",
                    "model": "ggml-large-v3-q5_0.bin",
                    "profile": "calidad",
                    "audio": audio_info,
                    "whisper": {
                        "settings": {
                            "chunk_seconds": 120.0,
                            "overlap_seconds": 10.0,
                            "retry_chunk_seconds": [60.0, 45.0, 30.0, 20.0],
                        },
                        "chunks": [
                            {
                                "index": 0,
                                "core_start": 0.0,
                                "core_end": 1.0,
                                "status": "accepted",
                            }
                        ],
                        "attempts": [],
                        "warnings": [],
                    },
                }
                (Path(tmpdir) / "processing_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                accepted_dir = Path(tmpdir) / "whisper_chunks" / "chunk_0000"
                accepted_dir.mkdir(parents=True)
                (accepted_dir / "accepted.json").write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "segments": [
                                {
                                    "id": "old",
                                    "start": 0.0,
                                    "end": 1.0,
                                    "speaker": "SPEAKER_00",
                                    "text": "texto reutilizado",
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )

                def fail_if_called(*_args, **_kwargs):
                    raise AssertionError("Whisper no debia ejecutarse para un chunk aceptado")

                app_main.run_whisper_file = fail_if_called  # type: ignore[assignment]

                segments = app_main.run_whisper_chunked(
                    {"id": "abc111def222", "segments": [], "speaker_labels": {}},
                    wav_path,
                    app_main.ToolPaths(ffmpeg=None, whisper="/bin/true"),
                    Path("ggml-large-v3-q5_0.bin"),
                    "calidad",
                )

                self.assertEqual(len(segments), 1)
                self.assertEqual(segments[0]["text"], "texto reutilizado")
            finally:
                app_main.project_dir = original_project_dir  # type: ignore[assignment]
                app_main.run_whisper_file = original_run_whisper_file  # type: ignore[assignment]

    def test_parse_java_major_version_handles_legacy_and_modern_versions(self) -> None:
        from app import main as app_main

        self.assertEqual(app_main.parse_java_major_version('java version "1.8.0_471"'), 8)
        self.assertEqual(app_main.parse_java_major_version('openjdk version "17.0.15" 2025-04-15'), 17)
        self.assertEqual(app_main.parse_java_major_version('java version "21.0.7" 2025-04-15 LTS'), 21)
        self.assertIsNone(app_main.parse_java_major_version("java runtime disponible"))

    def test_java_runtime_error_rejects_java_8_on_windows_with_install_hint(self) -> None:
        from app import main as app_main

        completed = app_main.subprocess.CompletedProcess(
            ["java", "-version"],
            0,
            "",
            'java version "1.8.0_471"\nJava(TM) SE Runtime Environment\n',
        )

        with (
            mock.patch.object(app_main, "java_candidate_paths", return_value=[Path(r"C:\Program Files (x86)\Java\bin\java.exe")]),
            mock.patch.object(app_main, "java_version_for_path", return_value=(8, completed.stderr)),
            mock.patch.object(app_main.platform, "system", return_value="Windows"),
        ):
            error = app_main.java_runtime_error()

        self.assertIn("Java 8 detectado", error)
        self.assertIn("Java 17 o superior", error)
        self.assertIn("winget install", error)

    def test_java_runtime_error_accepts_java_17(self) -> None:
        from app import main as app_main

        completed = app_main.subprocess.CompletedProcess(
            ["java", "-version"],
            0,
            "",
            'openjdk version "17.0.15" 2025-04-15\n',
        )

        with (
            mock.patch.object(app_main, "java_candidate_paths", return_value=[Path(r"C:\Program Files\Eclipse Adoptium\bin\java.exe")]),
            mock.patch.object(app_main, "java_version_for_path", return_value=(17, completed.stderr)),
            mock.patch.object(app_main, "activate_java_runtime") as activate_java_runtime,
        ):
            self.assertEqual(app_main.java_runtime_error(), "")
            activate_java_runtime.assert_called_once_with(Path(r"C:\Program Files\Eclipse Adoptium\bin\java.exe"))

    def test_windows_event_loop_policy_uses_selector_when_available(self) -> None:
        from app import main as app_main

        class FakeSelectorPolicy:
            pass

        with (
            mock.patch.object(app_main.platform, "system", return_value="Windows"),
            mock.patch.object(app_main.asyncio, "WindowsSelectorEventLoopPolicy", FakeSelectorPolicy, create=True),
            mock.patch.object(app_main.asyncio, "get_event_loop_policy", return_value=object()),
            mock.patch.object(app_main.asyncio, "set_event_loop_policy") as set_policy,
        ):
            app_main.configure_windows_event_loop_policy()

        set_policy.assert_called_once()
        self.assertIsInstance(set_policy.call_args.args[0], FakeSelectorPolicy)

    def test_uvicorn_loop_name_uses_policy_loop_on_windows(self) -> None:
        from app import main as app_main

        with mock.patch.object(app_main.platform, "system", return_value="Windows"):
            self.assertEqual(app_main.uvicorn_loop_name(), "none")

        with mock.patch.object(app_main.platform, "system", return_value="Darwin"):
            self.assertEqual(app_main.uvicorn_loop_name(), "auto")

    def test_proofread_status_start_reports_java_error_immediately(self) -> None:
        from app import main as app_main

        original_status = dict(app_main.PROOFREAD_STATUS)
        original_started = app_main.PROOFREAD_INIT_STARTED
        try:
            with app_main.PROOFREAD_STATUS_LOCK:
                app_main.PROOFREAD_STATUS.update(
                    {
                        "status": "idle",
                        "available": False,
                        "message": "Corrector local sin iniciar.",
                        "missing": [],
                        "updated_at": None,
                    }
                )
            app_main.PROOFREAD_INIT_STARTED = False
            with mock.patch.object(app_main, "proofread_start_error", return_value="Java 8 detectado"):
                status = app_main.api_proofread_status(start=True)

            self.assertEqual(status["status"], "unavailable")
            self.assertFalse(status["available"])
            self.assertEqual(status["message"], "Java 8 detectado")
            self.assertEqual(status["missing"], ["Java 8 detectado"])
            self.assertFalse(app_main.PROOFREAD_INIT_STARTED)
        finally:
            with app_main.PROOFREAD_STATUS_LOCK:
                app_main.PROOFREAD_STATUS.clear()
                app_main.PROOFREAD_STATUS.update(original_status)
            app_main.PROOFREAD_INIT_STARTED = original_started

    def test_proofread_text_uses_cache_for_same_text(self) -> None:
        from app import main as app_main

        class FakeMatch:
            offset = 0
            errorLength = 5
            replacements = ["municipalidad"]
            message = "Posible error ortografico"
            shortMessage = ""
            ruleId = "UNIT_RULE"
            category = "Ortografia"
            ruleIssueType = "misspelling"

        class FakeTool:
            def __init__(self) -> None:
                self.calls = 0

            def check(self, _text: str):
                self.calls += 1
                return [FakeMatch()]

        fake_tool = FakeTool()
        original_tool_getter = app_main.get_proofread_tool
        app_main.PROOFREAD_CACHE.clear()
        app_main.PROOFREAD_CACHE_ORDER.clear()
        app_main.get_proofread_tool = lambda _language="es": fake_tool  # type: ignore[assignment]
        try:
            first = app_main.proofread_text("municipalida", "es")
            second = app_main.proofread_text("municipalida", "es")
        finally:
            app_main.get_proofread_tool = original_tool_getter  # type: ignore[assignment]
            app_main.PROOFREAD_CACHE.clear()
            app_main.PROOFREAD_CACHE_ORDER.clear()

        self.assertEqual(fake_tool.calls, 1)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["matches"][0]["replacements"], ["municipalidad"])


if __name__ == "__main__":
    unittest.main()

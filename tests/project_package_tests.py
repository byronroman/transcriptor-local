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
    api_update_project,
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
    ProjectUpdate,
    SegmentUpdate,
    validate_project_id,
)


class ProjectPackageTests(unittest.TestCase):
    def test_model_rank_prefers_full_large_v3_for_quality(self) -> None:
        ordered = sorted(
            [
                Path("ggml-large-v3-turbo-q5_0.bin"),
                Path("ggml-large-v3-q5_0.bin"),
                Path("ggml-large-v3.bin"),
                Path("ggml-medium-q5_0.bin"),
            ],
            key=model_rank,
        )

        self.assertEqual(ordered[0].name, "ggml-large-v3.bin")
        self.assertEqual(ordered[1].name, "ggml-large-v3-q5_0.bin")

    def test_full_large_v3_integrity_is_checked(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            model = Path(tmpdir) / "ggml-large-v3.bin"
            model.write_bytes(b"bad")

            error = model_integrity_error(model)

        self.assertIsNotNone(error)
        self.assertIn("tamano esperado", error or "")

    def test_compact_error_message_skips_generic_prefix(self) -> None:
        error = RuntimeError("whisper.cpp fallo:\nfailed to initialize whisper context\nother detail")

        self.assertEqual(compact_error_message(error), "failed to initialize whisper context")

    def test_compact_error_message_hides_project_json_access_denied_paths(self) -> None:
        error = RuntimeError(
            "[WinError 5] Access is denied: "
            "'C:\\Users\\byrom\\Documents\\ideas\\ideas\\data\\projects\\abc123\\project.json.1.tmp' "
            "-> "
            "'C:\\Users\\byrom\\Documents\\ideas\\ideas\\data\\projects\\abc123\\project.json'"
        )

        message = compact_error_message(error)

        self.assertIn("Windows bloqueo temporalmente", message)
        self.assertNotIn("C:\\", message)
        self.assertNotIn("Users", message)

    def test_timestamped_docx_contains_segment_times(self) -> None:
        project = {
            "name": "Prueba",
            "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
            "segments": [
                {
                    "start": 1.2,
                    "end": 3.8,
                    "speaker": "SPEAKER_00",
                    "text": "Texto de prueba.",
                }
            ],
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "timestamped.docx"
            export_docx(project, output_path, include_timestamps=True)
            text = "\n".join(paragraph.text for paragraph in Document(output_path).paragraphs)

        self.assertIn("[00:00:01-00:00:03] Entrevistador/a:", text)
        self.assertIn("Texto de prueba.", text)

    def test_delete_project_files_removes_cached_exports(self) -> None:
        project_id = "abc123abc123"
        pdir = project_dir(project_id)
        if pdir.exists():
            shutil.rmtree(pdir)
        for path in EXPORTS_DIR.glob(f"{project_id}*"):
            path.unlink(missing_ok=True)

        pdir.mkdir(parents=True)
        (pdir / "project.json").write_text("{}", encoding="utf-8")
        export_path = EXPORTS_DIR / f"{project_id}.docx"
        timestamp_export_path = EXPORTS_DIR / f"{project_id}-timestamps.docx"
        export_path.write_text("x", encoding="utf-8")
        timestamp_export_path.write_text("x", encoding="utf-8")

        delete_project_files(project_id)

        self.assertFalse(pdir.exists())
        self.assertFalse(export_path.exists())
        self.assertFalse(timestamp_export_path.exists())

    def test_api_export_docx_failure_keeps_old_file_and_removes_temp(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            original_exports_dir = app_main.EXPORTS_DIR
            original_export_docx = app_main.export_docx
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.EXPORTS_DIR = Path(tmpdir) / "exports"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            app_main.EXPORTS_DIR.mkdir(parents=True)
            project_id = "abc123def456"
            pdir = app_main.PROJECTS_DIR / project_id
            pdir.mkdir()
            (pdir / "project.json").write_text(
                json.dumps(
                    {
                        "id": project_id,
                        "name": "Falla",
                        "segments": [{"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"}],
                        "speaker_labels": {"SPEAKER_00": "A"},
                    }
                ),
                encoding="utf-8",
            )
            final_path = app_main.EXPORTS_DIR / f"{project_id}.docx"
            final_path.write_text("version anterior", encoding="utf-8")

            def failing_export_docx(_project, output_path, include_timestamps=False):
                output_path.write_text("parcial", encoding="utf-8")
                raise RuntimeError("fallo controlado")

            app_main.export_docx = failing_export_docx  # type: ignore[assignment]
            try:
                with self.assertRaises(RuntimeError):
                    api_export(project_id, "docx")
                self.assertEqual(final_path.read_text(encoding="utf-8"), "version anterior")
                self.assertEqual(list(app_main.EXPORTS_DIR.glob(f"{app_main.EXPORT_TEMP_PREFIX}*")), [])
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]
                app_main.EXPORTS_DIR = original_exports_dir  # type: ignore[assignment]
                app_main.export_docx = original_export_docx  # type: ignore[assignment]

    def test_cleanup_stale_export_temps_removes_only_old_temp_files(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_exports_dir = app_main.EXPORTS_DIR
            app_main.EXPORTS_DIR = Path(tmpdir) / "exports"  # type: ignore[assignment]
            app_main.EXPORTS_DIR.mkdir(parents=True)
            old_temp = app_main.EXPORTS_DIR / f"{app_main.EXPORT_TEMP_PREFIX}old.zip"
            fresh_temp = app_main.EXPORTS_DIR / f"{app_main.EXPORT_TEMP_PREFIX}fresh.zip"
            final_file = app_main.EXPORTS_DIR / "abc123abc123.docx"
            old_temp.write_text("old", encoding="utf-8")
            fresh_temp.write_text("fresh", encoding="utf-8")
            final_file.write_text("final", encoding="utf-8")
            old_time = 1_600_000_000
            os.utime(old_temp, (old_time, old_time))
            try:
                app_main.cleanup_stale_export_temps(max_age_seconds=60)

                self.assertFalse(old_temp.exists())
                self.assertTrue(fresh_temp.exists())
                self.assertTrue(final_file.exists())
            finally:
                app_main.EXPORTS_DIR = original_exports_dir  # type: ignore[assignment]

    def test_load_project_repairs_trailing_extra_json_data(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc123def456"
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                project_path = pdir / "project.json"
                project_path.write_text(f'{{"id": "{project_id}", "segments": []}}\n}}', encoding="utf-8")

                project = app_main.load_project(project_id)

                self.assertEqual(project["id"], project_id)
                self.assertTrue(list(pdir.glob("project.json.corrupt-*")))
                self.assertEqual(app_main.load_project(project_id)["segments"], [])
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_write_json_atomic_retries_transient_access_denied(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "project.json"
            original_replace = Path.replace
            calls = []

            def flaky_replace(source: Path, target: Path) -> Path:
                calls.append((source, target))
                if len(calls) == 1:
                    raise PermissionError(5, "Access is denied", str(target))
                return original_replace(source, target)

            with (
                mock.patch.object(Path, "replace", autospec=True, side_effect=flaky_replace),
                mock.patch.object(app_main.time, "sleep") as sleep,
            ):
                app_main.write_json_atomic(path, {"ok": True})

            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"ok": True})
            self.assertEqual(len(calls), 2)
            sleep.assert_called_once()

    def test_save_segments_increments_content_revision_atomically(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc123abc123"
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps(
                        {
                            "id": project_id,
                            "name": "Original",
                            "segments": [],
                            "speaker_labels": {},
                            "content_revision": 0,
                        }
                    ),
                    encoding="utf-8",
                )

                updated = api_save_segments(
                    project_id,
                    SegmentUpdate(
                        name="Nuevo nombre",
                        segments=[{"id": "seg-1", "start": 0, "end": 1, "text": "hola"}],
                        speaker_labels={"SPEAKER_00": "Entrevistador/a"},
                        base_content_revision=0,
                    ),
                )

                self.assertEqual(updated["content_revision"], 1)
                self.assertEqual(updated["name"], "Nuevo nombre")
                self.assertEqual(updated["segments"][0]["text"], "hola")
                saved = app_main.load_project(project_id)
                self.assertEqual(saved["content_revision"], 1)
                self.assertEqual(saved["speaker_labels"]["SPEAKER_00"], "Entrevistador/a")
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_save_segments_rejects_stale_content_revision(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc123def456"
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps(
                        {
                            "id": project_id,
                            "name": "Original",
                            "segments": [{"id": "old", "text": "original"}],
                            "speaker_labels": {},
                            "content_revision": 2,
                        }
                    ),
                    encoding="utf-8",
                )

                with self.assertRaises(HTTPException) as context:
                    api_save_segments(
                        project_id,
                        SegmentUpdate(
                            name="Pisado",
                            segments=[{"id": "new", "text": "nuevo"}],
                            speaker_labels={},
                            base_content_revision=1,
                        ),
                    )

                self.assertEqual(context.exception.status_code, 409)
                saved = app_main.load_project(project_id)
                self.assertEqual(saved["content_revision"], 2)
                self.assertEqual(saved["segments"][0]["text"], "original")
                self.assertEqual(saved["name"], "Original")
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_save_segments_accepts_stale_revision_when_payload_is_unchanged(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc123fed456"
                segments = [{"id": "seg-1", "text": "sin cambios"}]
                labels = {"SPEAKER_00": "Entrevistador/a"}
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps(
                        {
                            "id": project_id,
                            "name": "Original",
                            "segments": segments,
                            "speaker_labels": labels,
                            "content_revision": 3,
                        }
                    ),
                    encoding="utf-8",
                )

                updated = api_save_segments(
                    project_id,
                    SegmentUpdate(
                        name="Original",
                        segments=segments,
                        speaker_labels=labels,
                        base_content_revision=2,
                    ),
                )

                self.assertEqual(updated["content_revision"], 3)
                self.assertEqual(updated["segments"], segments)
                self.assertEqual(app_main.load_project(project_id)["content_revision"], 3)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_update_project_playback_preserves_content_revision_and_segments(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc456fed789"
                segments = [{"id": "seg-1", "text": "contenido guardado"}]
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps(
                        {
                            "id": project_id,
                            "name": "Original",
                            "segments": segments,
                            "speaker_labels": {},
                            "content_revision": 4,
                            "playback_position": 0,
                        }
                    ),
                    encoding="utf-8",
                )

                updated = api_update_project(project_id, ProjectUpdate(playback_position=42.5))

                self.assertEqual(updated["content_revision"], 4)
                self.assertEqual(updated["segments"], segments)
                self.assertEqual(updated["playback_position"], 42.5)
                saved = app_main.load_project(project_id)
                self.assertEqual(saved["content_revision"], 4)
                self.assertEqual(saved["segments"], segments)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_save_segments_treats_missing_content_revision_as_zero(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc999def999"
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps({"id": project_id, "name": "Antiguo", "segments": [], "speaker_labels": {}}),
                    encoding="utf-8",
                )

                updated = api_save_segments(
                    project_id,
                    SegmentUpdate(
                        segments=[{"id": "seg-1", "start": 0, "end": 1, "text": "ok"}],
                        speaker_labels={},
                        base_content_revision=0,
                    ),
                )

                self.assertEqual(updated["content_revision"], 1)
                self.assertEqual(app_main.load_project(project_id)["content_revision"], 1)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_relabel_speakers_increments_content_revision(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir)  # type: ignore[assignment]
            try:
                project_id = "abc123abc123"
                pdir = Path(tmpdir) / project_id
                pdir.mkdir(parents=True)
                (pdir / "project.json").write_text(
                    json.dumps(
                        {
                            "id": project_id,
                            "name": "Original",
                            "segments": [
                                {
                                    "id": "seg-1",
                                    "start": 0,
                                    "end": 2,
                                    "speaker": "SPEAKER_00",
                                    "text": "¿Ustedes participan?",
                                }
                            ],
                            "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
                            "diarization_turns": [{"start": 0, "end": 2, "speaker": "SPEAKER_00"}],
                            "content_revision": 3,
                        }
                    ),
                    encoding="utf-8",
                )

                updated = api_relabel_speakers(project_id)

                self.assertEqual(updated["content_revision"], 4)
                self.assertEqual(app_main.load_project(project_id)["content_revision"], 4)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_project_id_validation_allows_only_hex_ids(self) -> None:
        self.assertEqual(validate_project_id("B1F1E12BEC1F"), "b1f1e12bec1f")
        for invalid in ("", "../secret", "abc/def12345", "abc123", "abc123abc1234", "abc123abc12g", " abc123abc123 "):
            with self.assertRaises(HTTPException):
                validate_project_id(invalid)

    def test_safe_project_dir_stays_inside_projects_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            try:
                resolved = safe_project_dir("b1f1e12bec1f")
                self.assertEqual(resolved, (app_main.PROJECTS_DIR / "b1f1e12bec1f").resolve())
                self.assertEqual(resolved.relative_to(app_main.PROJECTS_DIR.resolve()).parts, ("b1f1e12bec1f",))
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_invalid_project_id_cannot_delete_outside_projects_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            outside = Path(tmpdir) / "outside"
            outside.mkdir()
            marker = outside / "keep.txt"
            marker.write_text("safe", encoding="utf-8")
            try:
                with self.assertRaises(HTTPException):
                    delete_project_files("../outside")
                self.assertTrue(marker.exists())
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_project_endpoints_reject_invalid_project_ids(self) -> None:
        for call in (
            lambda: api_audio("../outside"),
            lambda: api_export("../outside", "txt"),
        ):
            with self.assertRaises(HTTPException):
                call()

    def test_package_member_validation_rejects_unsafe_paths(self) -> None:
        for invalid in ("../project.json", "/project.json", "audio/../source.wav", "C:/project.json"):
            with self.assertRaises(HTTPException):
                safe_zip_member(invalid)

    def test_package_import_rejects_unexpected_members(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            package_path = Path(tmpdir) / "bad.transcriptor.zip"
            with zipfile.ZipFile(package_path, "w") as package:
                package.writestr(
                    "project.json",
                    json.dumps({"name": "Mala", "segments": [{"start": 0, "end": 1, "text": "hola"}]}),
                )
                package.writestr("scripts/run.sh", "echo nope")

            with self.assertRaises(HTTPException):
                inspect_project_package(package_path)

    def test_package_import_rejects_traversal_members_without_writing_outside(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            package_path = Path(tmpdir) / "bad.transcriptor.zip"
            outside = Path(tmpdir) / "outside.txt"
            outside.write_text("keep", encoding="utf-8")
            with zipfile.ZipFile(package_path, "w") as package:
                package.writestr(
                    "project.json",
                    json.dumps({"name": "Mala", "segments": [{"start": 0, "end": 1, "text": "hola"}]}),
                )
                package.writestr("../outside.txt", "overwrite")

            with self.assertRaises(HTTPException):
                inspect_project_package(package_path)
            self.assertEqual(outside.read_text(encoding="utf-8"), "keep")

    def test_inspect_project_package_reports_import_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            package_path = Path(tmpdir) / "summary.transcriptor.zip"
            payload = {
                "id": "abcdefabcdef",
                "name": "Resumen",
                "segments": [
                    {"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"},
                    {"start": 1, "end": 2, "speaker": "SPEAKER_01", "text": "chao"},
                ],
                "speaker_labels": {"SPEAKER_00": "A", "SPEAKER_01": "B"},
                "diarization_turns": [{"start": 0, "end": 1, "speaker": "SPEAKER_00"}],
            }
            manifest = {
                "format": "transcriptor-local-package",
                "audio": {"path": "audio/source.wav", "source_name": "entrevista.wav"},
            }
            with zipfile.ZipFile(package_path, "w") as package:
                package.writestr("project.json", json.dumps(payload))
                package.writestr("manifest.json", json.dumps(manifest))
                package.writestr("audio/source.wav", b"RIFF")

            info = inspect_project_package(package_path)

            self.assertEqual(info["name"], "Resumen")
            self.assertEqual(info["segments"], 2)
            self.assertEqual(info["speakers"], 2)
            self.assertTrue(info["has_diarization"])
            self.assertTrue(info["has_audio"])
            self.assertEqual(info["audio_name"], "entrevista.wav")

    def test_export_package_includes_browser_settings(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "settings.transcriptor.zip"
            project = {
                "id": "abc123abc123",
                "name": "Con preferencias",
                "segments": [{"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"}],
                "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
            }
            app_main.export_package(
                project,
                output_path,
                include_audio=False,
                browser_settings={
                    "preferences": {
                        "theme": "dark",
                        "sidebarCollapsed": True,
                        "speakersPanelOpen": False,
                        "proofreadEnabled": True,
                        "audioVolume": 1.5,
                        "audioMuted": False,
                        "audioPlaybackRate": 1.5,
                        "draft": "no portable",
                    }
                },
            )

            with zipfile.ZipFile(output_path) as package:
                names = package.namelist()
                manifest = json.loads(package.read("manifest.json"))
                settings = json.loads(package.read("settings/browser.json"))

            self.assertIn("settings/browser.json", names)
            self.assertEqual(manifest["settings"]["browser"]["path"], "settings/browser.json")
            self.assertEqual(settings["format"], "transcriptor-local-browser-settings")
            self.assertEqual(settings["preferences"]["theme"], "dark")
            self.assertTrue(settings["preferences"]["sidebarCollapsed"])
            self.assertEqual(settings["preferences"]["audioVolume"], 1.0)
            self.assertEqual(settings["preferences"]["audioPlaybackRate"], 1.5)
            self.assertNotIn("draft", settings["preferences"])

    def test_package_browser_settings_are_reported_and_returned_on_import(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            package_path = Path(tmpdir) / "settings-import.transcriptor.zip"
            settings_payload = {
                "format": "transcriptor-local-browser-settings",
                "version": 1,
                "preferences": {
                    "theme": "light",
                    "proofreadEnabled": False,
                    "audioMuted": True,
                    "audioVolume": 0.42,
                    "audioPlaybackRate": 0.75,
                },
            }
            try:
                with zipfile.ZipFile(package_path, "w") as package:
                    package.writestr(
                        "project.json",
                        json.dumps({"name": "Importada", "segments": [{"start": 0, "end": 1, "text": "hola"}]}),
                    )
                    package.writestr("manifest.json", json.dumps({"format": "transcriptor-local-package"}))
                    package.writestr("settings/browser.json", json.dumps(settings_payload))

                info = inspect_project_package(package_path)
                imported = import_project_package(package_path, package_info=info)
                saved = json.loads((app_main.PROJECTS_DIR / imported["id"] / "project.json").read_text(encoding="utf-8"))

                self.assertTrue(info["has_browser_settings"])
                self.assertEqual(info["browser_settings"]["preferences"]["audioVolume"], 0.42)
                self.assertEqual(info["browser_settings"]["preferences"]["audioPlaybackRate"], 0.75)
                self.assertEqual(imported["browser_settings"]["preferences"]["theme"], "light")
                self.assertNotIn("browser_settings", saved)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_inspect_project_package_validates_segments_before_preview(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            package_path = Path(tmpdir) / "bad-preview.transcriptor.zip"
            with zipfile.ZipFile(package_path, "w") as package:
                package.writestr(
                    "project.json",
                    json.dumps({"name": "Mala", "segments": [{"start": 10, "end": 1, "text": "hola"}]}),
                )

            with self.assertRaises(HTTPException):
                inspect_project_package(package_path)

    def test_import_project_package_copies_audio_inside_project_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            package_path = Path(tmpdir) / "ok.transcriptor.zip"
            project_payload = {
                "id": "ffffffffffff",
                "name": "Importada",
                "source_path": "../../outside.wav",
                "audio_path": "../../outside.wav",
                "segments": [{"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"}],
                "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
            }
            manifest = {
                "format": "transcriptor-local-package",
                "audio": {"path": "audio/source.wav", "source_name": "source.wav"},
            }
            try:
                with zipfile.ZipFile(package_path, "w") as package:
                    package.writestr("project.json", json.dumps(project_payload))
                    package.writestr("manifest.json", json.dumps(manifest))
                    package.writestr("audio/source.wav", b"RIFF")

                imported = import_project_package(package_path)
                source_path = Path(imported["source_path"]).resolve()

                self.assertTrue(validate_project_id(imported["id"]))
                self.assertTrue(source_path.is_file())
                source_path.relative_to(app_main.PROJECTS_DIR.resolve())
                self.assertEqual(imported["segments"][0]["text"], "hola")
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_import_project_package_with_bad_manifest_audio_path_leaves_no_project_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            package_path = Path(tmpdir) / "bad-manifest.transcriptor.zip"
            try:
                with zipfile.ZipFile(package_path, "w") as package:
                    package.writestr(
                        "project.json",
                        json.dumps({"name": "Mala", "segments": [{"start": 0, "end": 1, "text": "hola"}]}),
                    )
                    package.writestr(
                        "manifest.json",
                        json.dumps({"format": "transcriptor-local-package", "audio": {"path": "../source.wav"}}),
                    )

                with self.assertRaises(HTTPException):
                    import_project_package(package_path)
                self.assertEqual(list(app_main.PROJECTS_DIR.glob("*")), [])
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_api_audio_rejects_audio_path_outside_project_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            project_id = "abc123abc123"
            outside_audio = Path(tmpdir) / "outside.wav"
            outside_audio.write_bytes(b"RIFF")
            pdir = app_main.PROJECTS_DIR / project_id
            pdir.mkdir()
            (pdir / "project.json").write_text(
                json.dumps(
                    {
                        "id": project_id,
                        "name": "Alterado",
                        "source_path": str(outside_audio),
                        "audio_path": str(outside_audio),
                        "segments": [],
                        "speaker_labels": {},
                    }
                ),
                encoding="utf-8",
            )
            try:
                with self.assertRaises(HTTPException) as context:
                    api_audio(project_id)
                self.assertEqual(context.exception.status_code, 404)
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]

    def test_migrated_macos_audio_paths_are_repaired_and_exported(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            original_exports_dir = app_main.EXPORTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.EXPORTS_DIR = Path(tmpdir) / "exports"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            app_main.EXPORTS_DIR.mkdir(parents=True)
            project_id = "abc123abc123"
            pdir = app_main.PROJECTS_DIR / project_id
            pdir.mkdir()
            (pdir / "source.m4a").write_bytes(b"audio-source")
            (pdir / "audio_16k.wav").write_bytes(b"RIFF-audio")
            (pdir / "project.json").write_text(
                json.dumps(
                    {
                        "id": project_id,
                        "name": "Migrado",
                        "source_name": "entrevista.m4a",
                        "source_path": f"/Users/byronroman/Documents/ideas/data/projects/{project_id}/source.m4a",
                        "audio_path": f"/Users/byronroman/Documents/ideas/data/projects/{project_id}/audio_16k.wav",
                        "segments": [{"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"}],
                        "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
                    }
                ),
                encoding="utf-8",
            )
            try:
                project = app_main.load_project(project_id)

                self.assertEqual(project["source_path"], "source.m4a")
                self.assertEqual(project["audio_path"], "audio_16k.wav")
                self.assertEqual(Path(app_main.api_audio(project_id).path).name, "audio_16k.wav")

                api_export(project_id, "package")
                output_path = app_main.EXPORTS_DIR / f"{project_id}.transcriptor.zip"
                with zipfile.ZipFile(output_path) as package:
                    names = package.namelist()
                    manifest = json.loads(package.read("manifest.json"))

                self.assertIn("audio/source.m4a", names)
                self.assertEqual(manifest["audio"]["path"], "audio/source.m4a")
                saved = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
                self.assertEqual(saved["source_path"], "source.m4a")
                self.assertEqual(saved["audio_path"], "audio_16k.wav")
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]
                app_main.EXPORTS_DIR = original_exports_dir  # type: ignore[assignment]

    def test_api_export_package_skips_audio_path_outside_project_dir(self) -> None:
        from app import main as app_main

        with tempfile.TemporaryDirectory() as tmpdir:
            original_projects_dir = app_main.PROJECTS_DIR
            original_exports_dir = app_main.EXPORTS_DIR
            app_main.PROJECTS_DIR = Path(tmpdir) / "projects"  # type: ignore[assignment]
            app_main.EXPORTS_DIR = Path(tmpdir) / "exports"  # type: ignore[assignment]
            app_main.PROJECTS_DIR.mkdir(parents=True)
            app_main.EXPORTS_DIR.mkdir(parents=True)
            project_id = "def456def456"
            outside_audio = Path(tmpdir) / "outside.wav"
            outside_audio.write_bytes(b"RIFF")
            pdir = app_main.PROJECTS_DIR / project_id
            pdir.mkdir()
            project = {
                "id": project_id,
                "name": "Alterado",
                "source_name": "outside.wav",
                "source_path": str(outside_audio),
                "audio_path": str(outside_audio),
                "segments": [{"start": 0, "end": 1, "speaker": "SPEAKER_00", "text": "hola"}],
                "speaker_labels": {"SPEAKER_00": "Entrevistador/a"},
            }
            (pdir / "project.json").write_text(json.dumps(project), encoding="utf-8")
            try:
                api_export(project_id, "package")
                output_path = app_main.EXPORTS_DIR / f"{project_id}.transcriptor.zip"

                with zipfile.ZipFile(output_path) as package:
                    names = package.namelist()
                    manifest = json.loads(package.read("manifest.json"))

                self.assertFalse(any(name.startswith("audio/") for name in names))
                self.assertIsNone(manifest["audio"])
            finally:
                app_main.PROJECTS_DIR = original_projects_dir  # type: ignore[assignment]
                app_main.EXPORTS_DIR = original_exports_dir  # type: ignore[assignment]



if __name__ == "__main__":
    unittest.main()

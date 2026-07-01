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


class CoreAppTests(unittest.TestCase):
    def test_assign_speakers_splits_segment_when_turns_change(self) -> None:
        segments = [
            {
                "id": "seg-1",
                "start": 0.0,
                "end": 10.0,
                "speaker": "SPEAKER_00",
                "text": (
                    "Primera parte con muchas palabras para que el segmento pueda dividirse correctamente "
                    "segunda parte tambien con suficientes palabras para conservar sentido completo"
                ),
            }
        ]
        turns = [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
            {"start": 5.0, "end": 10.0, "speaker": "SPEAKER_01"},
        ]

        assigned = assign_speakers(segments, turns)

        self.assertEqual(len(assigned), 2)
        self.assertEqual([item["speaker"] for item in assigned], ["SPEAKER_00", "SPEAKER_01"])
        self.assertGreater(float(assigned[1]["start"]), float(assigned[0]["start"]))
        self.assertTrue(assigned[0]["text"])
        self.assertTrue(assigned[1]["text"])

    def test_short_segment_is_not_split_by_diarization(self) -> None:
        segments = [
            {
                "id": "seg-1",
                "start": 0.0,
                "end": 3.0,
                "speaker": "SPEAKER_00",
                "text": "¿Ustedes pasan a todas las casas o los que tienen negocios?",
            }
        ]
        turns = [
            {"start": 0.0, "end": 1.2, "speaker": "SPEAKER_00"},
            {"start": 1.2, "end": 3.0, "speaker": "SPEAKER_01"},
        ]

        assigned = assign_speakers(segments, turns)

        self.assertEqual(len(assigned), 1)
        self.assertEqual(assigned[0]["speaker"], "SPEAKER_00")

    def test_micro_turn_between_same_speaker_is_absorbed(self) -> None:
        turns = [
            {"start": 0.0, "end": 3.0, "speaker": "SPEAKER_00"},
            {"start": 3.1, "end": 3.35, "speaker": "SPEAKER_01"},
            {"start": 3.4, "end": 6.0, "speaker": "SPEAKER_00"},
        ]

        processed = postprocess_diarization_turns(turns)

        self.assertEqual(len(processed), 1)
        self.assertEqual(processed[0]["speaker"], "SPEAKER_00")
        self.assertAlmostEqual(float(processed[0]["end"]), 6.0)

    def test_overlapping_turns_become_non_overlapping(self) -> None:
        turns = [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
            {"start": 4.0, "end": 8.0, "speaker": "SPEAKER_01"},
        ]

        processed = postprocess_diarization_turns(turns)

        for current, next_item in zip(processed, processed[1:]):
            self.assertLessEqual(float(current["end"]), float(next_item["start"]))

    def test_relabel_merges_auto_split_first_question(self) -> None:
        segments = [
            {
                "id": "seg-00000-sp0",
                "start": 1.48,
                "end": 1.87,
                "speaker": "SPEAKER_00",
                "text": "¿Ustedes pasan",
            },
            {
                "id": "seg-00000-sp1",
                "start": 1.87,
                "end": 3.72,
                "speaker": "SPEAKER_01",
                "text": "a todas las casas o los que tienen negocios?",
            },
        ]
        turns = [
            {"start": 1.48, "end": 1.87, "speaker": "SPEAKER_00"},
            {"start": 1.87, "end": 3.72, "speaker": "SPEAKER_01"},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            from app import main as app_main

            original_project_dir = app_main.project_dir
            original_quality_writer = app_main.write_diarization_quality
            app_main.project_dir = lambda _project_id: Path(tmpdir)  # type: ignore[assignment]
            app_main.write_diarization_quality = lambda _project_id, _quality: None  # type: ignore[assignment]
            try:
                relabeled, labels, _, _ = relabel_segments_with_diagnostics(
                    "abc123abc123",
                    segments,
                    turns,
                    {"SPEAKER_00": "Entrevistador/a", "SPEAKER_01": "Entrevistada/o"},
                )
            finally:
                app_main.project_dir = original_project_dir  # type: ignore[assignment]
                app_main.write_diarization_quality = original_quality_writer  # type: ignore[assignment]

        self.assertEqual(len(relabeled), 1)
        self.assertEqual(relabeled[0]["speaker"], "SPEAKER_00")
        self.assertIn("todas las casas", relabeled[0]["text"])
        self.assertEqual(labels["SPEAKER_00"], "Entrevistador/a")

    def test_default_speaker_labels_preserves_custom_names(self) -> None:
        segments = [{"speaker": "SPEAKER_00"}, {"speaker": "SPEAKER_02"}]

        labels = default_speaker_labels(
            segments,
            {"SPEAKER_00": "Moderadora", "SPEAKER_02": "Vecina"},
        )

        self.assertEqual(labels["SPEAKER_00"], "Moderadora")
        self.assertEqual(labels["SPEAKER_02"], "Vecina")

    def test_internal_loop_cleanup_reduces_repeated_clause(self) -> None:
        text = "Es de septiembre, " * 14
        segments = [{"start": 1.0, "end": 8.0, "text": text.strip()}]

        cleaned, cleanup = sanitize_internal_loop_segments(segments)

        self.assertEqual(len(cleaned), 1)
        self.assertLess(cleaned[0]["text"].lower().count("septiembre"), text.lower().count("septiembre"))
        self.assertTrue(cleanup.get("text_cleanups"))

    def test_loop_candidates_dedupes_repeated_internal_loops(self) -> None:
        text = "No, " * 30
        segments = [{"start": 1.0, "end": 1.0, "text": text.strip()} for _ in range(4)]

        candidates = loop_candidates(segments)

        self.assertEqual(len([item for item in candidates if item["text"] == "no"]), 1)
        self.assertEqual(candidates[0]["text"], "no")
        self.assertEqual(candidates[0]["count"], 30)

    def test_cleanup_warning_is_actionable(self) -> None:
        warning = format_cleanup_warning(
            {
                "text_cleanups": [{"start": 455.0, "end": 456.0, "removed": {"no": 8}}],
                "ranges": [],
            }
        )

        self.assertIn("Whisper corrigio repeticiones", warning)
        self.assertIn("Primer rango para revisar: 00:07:35-00:07:36", warning)
        self.assertNotIn("Filtro anti-loop", warning)

    def test_diarization_warning_explains_smoothing(self) -> None:
        warning = format_diarization_quality_warning(
            {
                "short_speaker_islands": 24,
                "raw_adjacent_overlaps": {"count": 178, "seconds": 19.0},
                "raw_micro_turns": 76,
                "short_auto_split_segments": 0,
            }
        )

        self.assertIn("Separacion de hablantes", warning)
        self.assertIn("se suavizo", warning)
        self.assertIn("quedan 24 cambios breves", warning)
        self.assertNotIn("Diarizacion", warning)

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

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


class SpeakerSeparationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

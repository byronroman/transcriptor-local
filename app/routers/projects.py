from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/api/projects", backend.api_projects, methods=["GET"])
router.add_api_route("/api/projects", backend.api_create_project, methods=["POST"])
router.add_api_route("/api/projects/{project_id}", backend.api_project, methods=["GET"])
router.add_api_route("/api/projects/{project_id}", backend.api_update_project, methods=["PATCH"])
router.add_api_route("/api/projects/{project_id}", backend.api_delete_project, methods=["DELETE"])
router.add_api_route("/api/projects/{project_id}/logs", backend.api_project_logs, methods=["GET"])
router.add_api_route("/api/projects/{project_id}/resume", backend.api_resume_project, methods=["POST"])
router.add_api_route("/api/projects/{project_id}/diarize", backend.api_diarize_project, methods=["POST"])
router.add_api_route("/api/projects/{project_id}/relabel-speakers", backend.api_relabel_speakers, methods=["POST"])
router.add_api_route("/api/projects/{project_id}/segments", backend.api_save_segments, methods=["POST"])

from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/api/jobs/{project_id}", backend.api_job, methods=["GET"])
router.add_api_route("/api/jobs/{project_id}/pause", backend.api_pause_job, methods=["POST"])
router.add_api_route("/api/jobs/{project_id}/cancel", backend.api_cancel_job, methods=["POST"])

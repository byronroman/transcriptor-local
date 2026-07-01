from __future__ import annotations

from fastapi import APIRouter

from app import backend

router = APIRouter()
router.add_api_route("/api/proofread/status", backend.api_proofread_status, methods=["GET"])
router.add_api_route("/api/proofread/stop", backend.api_proofread_stop, methods=["POST"])
router.add_api_route("/api/proofread", backend.api_proofread, methods=["POST"])
router.add_api_route("/api/proofread/batch", backend.api_proofread_batch, methods=["POST"])

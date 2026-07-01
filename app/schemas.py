from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from pydantic import BaseModel


class SegmentUpdate(BaseModel):
    segments: list[dict[str, Any]]
    speaker_labels: dict[str, str] = {}
    name: Optional[str] = None
    base_content_revision: Optional[int] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    playback_position: Optional[float] = None


class RelabelRequest(BaseModel):
    mode: str = "interview_2p"


class ProofreadRequest(BaseModel):
    text: str
    language: str = "es"


class ProofreadBatchItem(BaseModel):
    id: str
    text: str


class ProofreadBatchRequest(BaseModel):
    items: list[ProofreadBatchItem]
    language: str = "es"


@dataclass
class ToolPaths:
    ffmpeg: Optional[str]
    whisper: Optional[str]


class JobStopped(RuntimeError):
    def __init__(self, status: str):
        self.status = status
        message = "Proceso pausado" if status == "paused" else "Proceso cancelado"
        super().__init__(message)


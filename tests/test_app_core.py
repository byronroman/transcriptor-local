from __future__ import annotations

import unittest

from tests.processing_proofread_tests import ProcessingProofreadTests
from tests.project_package_tests import ProjectPackageTests
from tests.speaker_separation_tests import SpeakerSeparationTests

__all__ = [
    "ProcessingProofreadTests",
    "ProjectPackageTests",
    "SpeakerSeparationTests",
]


if __name__ == "__main__":
    unittest.main()

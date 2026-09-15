"""Exercise durable removal rules without a live spreadsheet."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "bookmarks"))

from sheet import Identity, SavedJobsSheet
from store import BookmarkOperations, ExtractedJob, Job, identity, open_database


class MemorySheet(SavedJobsSheet):
    def __init__(self) -> None:
        self.data: list[list[str]] = []
        self.fail_removal = False

    def initialize(self) -> None:
        pass

    def rows(self) -> list[list[str]]:
        return self.data

    def write(self, area: str, values: list[list[str]]) -> None:
        index = int(area.split(":")[0][1:]) - 3
        while len(self.data) <= index:
            self.data.append([])
        self.data[index] = values[0]

    def remove(self, key: Identity) -> None:
        if self.fail_removal:
            raise OSError("The sheet request failed.")
        for row in self.matching_rows(key):
            self.data[row - 3] = []


class BookmarkRulesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "bookmarks.sqlite"
        self.database = open_database(self.path)
        self.sheet = MemorySheet()
        self.operations = BookmarkOperations(self.database, "test")
        self.operations._sheet = self.sheet
        self.job: Job = {
            "organizationName": "Organization", "title": "Biologist",
            "link": "https://example.com/jobs", "pageUrl": "https://example.com/jobs",
        }
        self.operations.register("token", self.job)
        self.assertEqual(self.operations.save("token"), "saved")

    def tearDown(self) -> None:
        self.database.close()
        self.directory.cleanup()

    def observe(self, extraction: str, jobs: list[ExtractedJob], page: str = "https://example.com/jobs") -> None:
        self.operations.observe({
            "pageUrl": page, "organizationName": "Organization", "jobs": jobs, "extractionId": extraction,
        })

    def test_six_distinct_absences_reset_when_fallback_job_returns(self) -> None:
        for index in range(5):
            self.observe(str(index), [])
        self.observe("4", [])
        self.observe("elsewhere", [], "https://another.example/jobs")
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [3])
        self.observe("return", [{"title": "Biologist", "link": "https://example.com/jobs/biologist"}])
        for index in range(5):
            self.observe(f"second-{index}", [])
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [3])
        self.observe("second-5", [])
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [])
        self.assertEqual(self.operations.execute({"action": "pending-removals"}), [{"id": "token", "job": self.job}])
        self.operations.execute({"action": "acknowledge-removal", "id": "token"})
        self.assertEqual(self.operations.execute({"action": "pending-removals"}), [])

    def test_manual_edits_and_partial_identities_never_authorize_removal(self) -> None:
        self.sheet.data = [["Organization", "Biologist", "https://example.com/other"], ["Organization", "Biologist"]]
        for index in range(6):
            self.observe(str(index), [])
        self.assertEqual(self.sheet.data, [
            ["Organization", "Biologist", "https://example.com/other"], ["Organization", "Biologist"],
        ])
        self.assertEqual(self.operations.execute({"action": "pending-removals"}), [])

    def test_old_button_survives_restart_and_repeated_taps_do_not_duplicate_rows(self) -> None:
        self.database.close()
        self.database = open_database(self.path)
        self.operations = BookmarkOperations(self.database, "test")
        self.operations._sheet = self.sheet
        self.assertEqual(self.operations.save("token"), "already-saved")
        self.assertEqual(self.operations.save("unknown"), "unavailable")
        self.assertEqual(self.sheet.rows(), [list(identity(self.job))])
        self.sheet.data = []
        self.assertEqual(self.operations.save("token"), "saved")
        self.assertEqual(self.sheet.rows(), [list(identity(self.job))])

    def test_sheet_failure_keeps_removal_pending_until_delete_succeeds(self) -> None:
        for index in range(5):
            self.observe(str(index), [])
        self.sheet.fail_removal = True
        with self.assertRaises(OSError):
            self.observe("sixth", [])
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [3])
        self.sheet.fail_removal = False
        self.assertEqual(self.operations.execute({"action": "pending-removals"}), [{"id": "token", "job": self.job}])
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [])
        self.assertEqual(self.operations.save("token"), "unavailable")

    def test_direct_link_identity_does_not_match_another_job_with_same_title(self) -> None:
        direct: Job = {**self.job, "link": "https://example.com/jobs/one"}
        self.operations.register("direct", direct)
        self.operations.save("direct")
        for index in range(6):
            self.observe(str(index), [{"title": "Biologist", "link": "https://example.com/jobs/two"}])
        self.assertEqual(self.sheet.matching_rows(identity(direct)), [])
        self.assertEqual(self.sheet.matching_rows(identity(self.job)), [3])


if __name__ == "__main__":
    unittest.main()

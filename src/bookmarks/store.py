"""Serialize bookmark state and sheet changes across the poll and Telegram processes."""

import fcntl
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Literal, TypedDict, cast
from urllib.parse import urlparse

from sheet import Identity, SavedJobsSheet


class Job(TypedDict):
    organizationName: str
    title: str
    link: str
    pageUrl: str


class ExtractedJob(TypedDict):
    title: str
    link: str | None


class Observation(TypedDict):
    pageUrl: str
    organizationName: str
    jobs: list[ExtractedJob]
    extractionId: str


class SimpleCommand(TypedDict):
    action: Literal["initialize", "pending-removals"]


class RegisterCommand(TypedDict):
    action: Literal["register"]
    token: str
    job: Job


class SaveCommand(TypedDict):
    action: Literal["save"]
    token: str


class ObserveCommand(TypedDict):
    action: Literal["observe"]
    observation: Observation


class AcknowledgeCommand(TypedDict):
    action: Literal["acknowledge-removal"]
    id: str


Command = SimpleCommand | RegisterCommand | SaveCommand | ObserveCommand | AcknowledgeCommand
ABSENCE_LIMIT = 6


def identity(job: Job) -> Identity:
    values = (job["organizationName"], job["title"], job["link"])
    if not all(isinstance(value, str) and value.strip() for value in values):
        raise ValueError("A bookmarked job requires a complete identity.")
    for link in (job["link"], job["pageUrl"]):
        parsed = urlparse(link)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("A bookmarked job requires an HTTP or HTTPS link.")
    return values


def open_database(path: Path) -> sqlite3.Connection:
    database = sqlite3.connect(path)
    database.row_factory = sqlite3.Row
    database.executescript("""
        CREATE TABLE IF NOT EXISTS jobs (
            token TEXT PRIMARY KEY, job TEXT NOT NULL, page_url TEXT NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0, last_extraction TEXT NOT NULL DEFAULT '',
            retired INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS removals (
            id TEXT PRIMARY KEY, job TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0
        );
    """)
    return database


class BookmarkOperations:
    def __init__(self, database: sqlite3.Connection, spreadsheet_id: str) -> None:
        self.database = database
        self.spreadsheet_id = spreadsheet_id
        self._sheet: SavedJobsSheet | None = None

    @property
    def sheet(self) -> SavedJobsSheet:
        if self._sheet is None:
            self._sheet = SavedJobsSheet(self.spreadsheet_id)
        return self._sheet

    def register(self, token: str, job: Job) -> None:
        identity(job)
        existing = self.database.execute("SELECT job FROM jobs WHERE token = ?", (token,)).fetchone()
        if existing is not None and identity(cast(Job, json.loads(existing["job"]))) != identity(job):
            raise ValueError("The bookmark token belongs to a different job.")
        self.database.execute(
            "INSERT INTO jobs(token, job, page_url) VALUES (?, ?, ?) "
            "ON CONFLICT(token) DO UPDATE SET retired = 0",
            (token, json.dumps(job), job["pageUrl"]),
        )
        self.database.commit()

    def save(self, token: str) -> str:
        row = self.database.execute("SELECT job, retired FROM jobs WHERE token = ?", (token,)).fetchone()
        if row is None or row["retired"]:
            return "unavailable"
        job = cast(Job, json.loads(row["job"]))
        added = self.sheet.save(identity(job))
        if added:
            self.database.execute("UPDATE jobs SET missing = 0 WHERE token = ?", (token,))
            self.database.commit()
        logging.info("The bookmark is saved: %s", job["title"])
        return "saved" if added else "already-saved"

    def observe(self, observation: Observation) -> None:
        rows = self.database.execute(
            "SELECT token, job, missing, last_extraction FROM jobs WHERE page_url = ? AND retired = 0",
            (observation["pageUrl"],),
        ).fetchall()
        if not rows:
            return
        sheet_identities = {tuple(row) for row in self.sheet.rows() if len(row) == 3}
        for row in rows:
            job = cast(Job, json.loads(row["job"]))
            if job["organizationName"] != observation["organizationName"]:
                continue
            if row["last_extraction"] == observation["extractionId"]:
                continue
            present = any(
                item["title"] == job["title"] and (
                    job["link"] == job["pageUrl"] or item["link"] == job["link"]
                ) for item in observation["jobs"]
            )
            saved = identity(job) in sheet_identities
            missing = 0 if present or not saved else row["missing"] + 1
            self.database.execute(
                "UPDATE jobs SET missing = ?, last_extraction = ? WHERE token = ?",
                (missing, observation["extractionId"], row["token"]),
            )
            if missing >= ABSENCE_LIMIT:
                self.database.execute(
                    "INSERT OR IGNORE INTO removals(id, job) VALUES (?, ?)", (row["token"], row["job"]),
                )
                self.database.execute("UPDATE jobs SET retired = 1 WHERE token = ?", (row["token"],))
                logging.info("The bookmarked job was absent for six extractions: %s", job["title"])
        self.database.commit()
        self.finish_removals()

    def finish_removals(self) -> None:
        pending = self.database.execute("SELECT id, job FROM removals WHERE ready = 0").fetchall()
        for row in pending:
            job = cast(Job, json.loads(row["job"]))
            self.sheet.remove(identity(job))
            self.database.execute("UPDATE removals SET ready = 1 WHERE id = ?", (row["id"],))
            self.database.commit()
            logging.info("Removed the bookmarked job from the spreadsheet: %s", job["title"])

    def execute(self, command: Command) -> object:
        action = command["action"]
        if action == "initialize":
            self.sheet.initialize()
        elif action == "register":
            self.register(command["token"], command["job"])
        elif action == "save":
            return self.save(command["token"])
        elif action == "observe":
            self.observe(command["observation"])
        elif action == "pending-removals":
            self.finish_removals()
            return [
                {"id": row["id"], "job": json.loads(row["job"])}
                for row in self.database.execute("SELECT id, job FROM removals WHERE ready = 1")
            ]
        elif action == "acknowledge-removal":
            self.database.execute("DELETE FROM removals WHERE id = ? AND ready = 1", (command["id"],))
            self.database.commit()
        else:
            raise ValueError("Unknown bookmark operation.")
        return None


def main() -> None:
    spreadsheet_id, state_directory, command_json = sys.argv[1:]
    directory = Path(state_directory)
    directory.mkdir(parents=True, exist_ok=True)
    command = cast(Command, json.loads(command_json))
    with (directory / "store.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        database = open_database(directory / "store.sqlite")
        try:
            result = BookmarkOperations(database, spreadsheet_id).execute(command)
            print(json.dumps(result))
        finally:
            database.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        main()
    except Exception:
        logging.exception("The bookmark operation failed.")
        sys.exit(1)

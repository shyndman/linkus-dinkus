"""Read and change only the saved-job area on the first sheet."""

from typing import TypedDict, cast

from spreadsheet_mcp.sheets_client import SheetsClient


class SheetProperties(TypedDict):
    sheetId: int
    title: str
    index: int


class SheetMetadata(TypedDict):
    properties: SheetProperties


class Metadata(TypedDict):
    sheets: list[SheetMetadata]


class Values(TypedDict):
    values: list[list[str]]


Identity = tuple[str, str, str]
FIRST_DATA_ROW = 4
HEADERS = ["Organization", "Job title", "Link"]


class SavedJobsSheet:
    def __init__(self, spreadsheet_id: str) -> None:
        self.spreadsheet_id = spreadsheet_id
        self.client = SheetsClient()
        metadata = cast(Metadata, self.client.spreadsheets.get(
            spreadsheetId=spreadsheet_id,
            fields="sheets(properties(sheetId,title,index))",
        ).execute())
        first = min(metadata["sheets"], key=lambda sheet: sheet["properties"]["index"])
        self.prefix = "'" + first["properties"]["title"].replace("'", "''") + "'!"

    def read(self, area: str) -> list[list[str]]:
        result = cast(Values, self.client.spreadsheets.values().get(
            spreadsheetId=self.spreadsheet_id, range=self.prefix + area,
        ).execute())
        return result.get("values", [])

    def write(self, area: str, values: list[list[str]]) -> None:
        self.client.spreadsheets.values().update(
            spreadsheetId=self.spreadsheet_id, range=self.prefix + area,
            valueInputOption="RAW", body={"values": values},
        ).execute()

    def initialize(self) -> None:
        existing = self.read("H2:J3")
        expected = [["Saved jobs"], HEADERS]
        if existing and existing != expected:
            raise ValueError("The saved-job header area contains other data.")
        if not existing:
            self.write("H2:J3", expected)

    def rows(self) -> list[list[str]]:
        return self.read("H4:J")

    def matching_rows(self, identity: Identity) -> list[int]:
        return [index + FIRST_DATA_ROW for index, row in enumerate(self.rows()) if tuple(row) == identity]

    def save(self, identity: Identity) -> bool:
        self.initialize()
        rows = self.rows()
        if any(tuple(row) == identity for row in rows):
            return False
        index = next((index for index, row in enumerate(rows) if not any(row)), len(rows))
        row_number = FIRST_DATA_ROW + index
        self.write(f"H{row_number}:J{row_number}", [list(identity)])
        return True

    def remove(self, identity: Identity) -> None:
        ranges = [f"{self.prefix}H{row}:J{row}" for row in self.matching_rows(identity)]
        if ranges:
            self.client.spreadsheets.values().batchClear(
                spreadsheetId=self.spreadsheet_id, body={"ranges": ranges},
            ).execute()

"""Mark invalid watched URL cells without changing their values."""

import json
import logging
import sys
from typing import NotRequired, TypedDict, cast

from spreadsheet_mcp.sheets_client import SheetsClient


class CellOffset(TypedDict):
    row: int
    column: int


class GridRange(TypedDict):
    sheetId: int
    startRowIndex: NotRequired[int]
    endRowIndex: NotRequired[int]
    startColumnIndex: NotRequired[int]
    endColumnIndex: NotRequired[int]


class NamedRange(TypedDict):
    name: str
    range: GridRange


class SpreadsheetMetadata(TypedDict):
    namedRanges: list[NamedRange]


class Color(TypedDict):
    red: float
    green: float
    blue: float


class TextFormat(TypedDict):
    foregroundColor: Color


class CellFormat(TypedDict):
    backgroundColor: Color
    textFormat: TextFormat


class FormattedCell(TypedDict):
    userEnteredFormat: CellFormat


class RepeatCell(TypedDict):
    range: GridRange
    cell: FormattedCell
    fields: str


class FormatRequest(TypedDict):
    repeatCell: RepeatCell


ERROR_TEXT_COLOR: Color = {"red": 0.7, "green": 0.0, "blue": 0.0}
ERROR_BACKGROUND_COLOR: Color = {"red": 1.0, "green": 0.9, "blue": 0.9}
ERROR_FORMAT: CellFormat = {
    "backgroundColor": ERROR_BACKGROUND_COLOR,
    "textFormat": {"foregroundColor": ERROR_TEXT_COLOR},
}
FORMAT_FIELDS = "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.foregroundColor"


def format_request(origin: GridRange, cell: CellOffset) -> FormatRequest:
    row = origin.get("startRowIndex", 0) + cell["row"] - 1
    column = origin.get("startColumnIndex", 0) + cell["column"] - 1
    return {
        "repeatCell": {
            "range": {
                "sheetId": origin["sheetId"],
                "startRowIndex": row,
                "endRowIndex": row + 1,
                "startColumnIndex": column,
                "endColumnIndex": column + 1,
            },
            "cell": {"userEnteredFormat": ERROR_FORMAT},
            "fields": FORMAT_FIELDS,
        }
    }


def main() -> None:
    spreadsheet_id, range_name, cells_json = sys.argv[1:]
    cells = cast(list[CellOffset], json.loads(cells_json))
    client = SheetsClient()
    metadata = cast(SpreadsheetMetadata, client.spreadsheets.get(
        spreadsheetId=spreadsheet_id,
        fields="namedRanges(name,range)",
    ).execute())
    origin = next(item["range"] for item in metadata["namedRanges"] if item["name"] == range_name)
    requests = [format_request(origin, cell) for cell in cells]
    client.spreadsheets.batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()
    print(json.dumps({"styledCells": len(cells)}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logging.exception("Could not mark invalid URL cells in the spreadsheet.")
        sys.exit(1)

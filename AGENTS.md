# Page-watch instructions

Spreadsheet ID: `1885pAekZfP__9yGRXhCJU5_N8jAzoXUi6IyHaPf149E`

Run all commands from the project root. Use pnpm for JavaScript dependencies.

## Spreadsheet input

Read these named ranges with the Google Sheets batch-read tool:

- `notificationTrigger`
- `pollFrequency`
- `urls`

Immediately after the spreadsheet read succeeds:

1. Run `date --iso-8601=seconds` on the host machine.
2. Write the command output to the `lastCheckDateTime` named range with the Google Sheets write-cells tool.

Treat the spreadsheet as the current configuration. Do not poll a URL that is absent from `urls`.

## Poll frequency

Interpret the natural-language `pollFrequency` value. Produce one or more cron expressions.

Pass each expression as one quoted command argument:

```sh
bin/check-poll-frequency '*/20 * * * * 1-5'
```

For a schedule that needs multiple expressions, pass multiple arguments:

```sh
bin/check-poll-frequency \
  '0,30 9-16 * * 1-5' \
  '0 17 * * 1-5'
```

The agent interprets `pollFrequency`. The command only compares strings. It does not parse or validate cron expressions.

The command stores one expression per line in `cache/poll-frequency.txt`. It returns one of these states:

- `initialized`: The command wrote the first expressions.
- `unchanged`: The expressions match the cache.
- `changed`: The result contains `previous` and `desired` expression arrays. The command does not replace the cache.

The future schedule-update script will let cron validate the expressions. Until that script exists, log changed expressions and stop the run.

## URL state

For each current URL, run:

```sh
bin/url-state "$url"
```

The command returns the cache directory and one state:

- `new`: The cache directory does not exist.
- `incomplete`: The directory exists without an executable `extract` file.
- `configured`: The directory contains an executable `extract` file.

Use the new-URL procedure for `new` and `incomplete`. Use the known-URL procedure for `configured`.

## New-URL procedure

1. Capture the rendered Document Object Model (DOM). This command opens the URL in Camoufox.

   ```sh
   snapshot=$(bin/capture-page "$url")
   ```

2. Inspect the rendered page.

   ```sh
   bin/camou snapshot -i
   ```

3. Record the visible items, names, counts, and direct links as extraction expectations.
4. Create a draft Markdown file with Defuddle.

   ```sh
   draft=$(bin/defuddle-snapshot "$snapshot")
   ```

5. Compare the draft with the rendered-page expectations.
6. Inspect the HTML when the draft loses required content or relationships.
7. Create `cache/<url-slug>/extract` and its typed source file.
8. Run the extractor through the canonical runner.

   ```sh
   canonical=$(bin/extract-snapshot "$snapshot")
   ```

9. Compare the canonical Markdown with every extraction expectation.
10. Do not accept the baseline until the canonical Markdown contains all required data.
11. Record the baseline state.

   ```sh
   bin/compare-snapshots "$(dirname "$snapshot")"
   ```

The comparison command must return `baseline` for the first canonical snapshot.

## Extractor contract

The fixed extractor path is `cache/<url-slug>/extract`.

The command contract is:

```text
extract <snapshot.html>
```

The extractor must obey these rules:

- Read one local HTML snapshot.
- Make no network requests.
- Write canonical Markdown to standard output.
- Write failure details to standard error.
- Return a nonzero status after a failure.
- Return identical output for identical input.
- Exclude timestamps and run-specific values from the Markdown.
- Preserve data required by `notificationTrigger`.

Use Cheerio for HTML inspection and repair. Use `bin/defuddle` for Markdown extraction when its output is useful.

The executable `extract` file can call a typed TypeScript source file through `pnpm exec tsx`.

## Known-URL procedure

1. Capture a new rendered DOM snapshot.

   ```sh
   snapshot=$(bin/capture-page "$url")
   ```

2. Run the saved extractor.

   ```sh
   canonical=$(bin/extract-snapshot "$snapshot")
   ```

3. Compare the two newest canonical snapshots.

   ```sh
   comparison=$(bin/compare-snapshots "$(dirname "$snapshot")")
   ```

4. If the state is `unchanged`, finish this URL without an agent review.
5. If the state is `changed`, evaluate only the reported difference against `notificationTrigger`.
6. If the difference matches the trigger, identify each added job.
7. For each added job without a direct link, inspect the current HTML snapshot.
8. Examine the matching job element, attributes, nearby anchors, embedded data, and event metadata for a URL.
9. Resolve a relative URL against the watched page URL.
10. Call `notify` with a description of what changed.
    Include each added job name and each recovered direct link.
11. If URL recovery fails, call `notify` without a link.
12. Use URL recovery only for notification content. Do not change the canonical artifact.
13. If the difference does not match the trigger, finish this URL without a notification.


## Cache layout

```text
cache/
├── poll-frequency.json
└── <url-slug>/
    ├── extract
    ├── extract.ts
    ├── snapshot-<UTC timestamp>.html
    ├── snapshot-<UTC timestamp>.draft.md
    └── snapshot-<UTC timestamp>.md
```

HTML snapshots are immutable evidence. Draft Markdown is inspection output. Markdown without `.draft` is canonical comparison data.

## Installed commands

- `bin/check-poll-frequency <value>`: Canonicalize and compare the poll frequency.
- `bin/url-state <url>`: Classify a URL cache.
- `bin/capture-page <url>`: Open the URL and save rendered HTML.
- `bin/defuddle-snapshot <snapshot.html>`: Create draft Markdown.
- `bin/extract-snapshot <snapshot.html>`: Run the saved extractor and create canonical Markdown.
- `bin/compare-snapshots <cache-directory>`: Compare the two newest canonical Markdown files.

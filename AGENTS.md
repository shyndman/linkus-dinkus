# Page-watch agent instructions

Run all commands from the project root. Use pnpm for JavaScript dependencies.

The prompt assigns one role: extractor agent or change judge. Do only the assigned role.

## Extractor agent

The extractor agent makes sure that one saved extractor converts a supplied HTML snapshot into the requested data.

The prompt supplies:

- One URL
- One cache directory
- One current HTML snapshot
- The notification trigger, which identifies data that the extractor must preserve
- A setup or audit reason

Do not evaluate a change against the notification trigger. Do not send notifications.

### Setup task

1. Inspect the rendered page.

   ```sh
   bin/camou snapshot -i
   ```

2. Record the visible items, names, counts, and direct links as extraction expectations.
3. Create a draft Markdown file with Defuddle.

   ```sh
   bin/defuddle-snapshot "$snapshot"
   ```

4. Compare the draft with the extraction expectations.
5. Inspect the supplied HTML when the draft loses required content or relationships.
6. Create `cache/<url-slug>/extract` and its typed source file.
7. Run the extractor through the canonical runner.

   ```sh
   bin/extract-snapshot "$snapshot"
   ```

8. Compare the canonical Markdown with every extraction expectation.
9. Finish only when the canonical Markdown contains all required data.

### Audit task

1. Inspect the supplied HTML and the saved extractor.
2. Run the saved extractor against the supplied HTML.
3. Compare the output with the data in the HTML.
4. If the extractor is wrong, fix it and test it again.
5. If the extractor is correct, do not change it.

### Extractor contract

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
- Preserve data required by the notification trigger.

Use Cheerio for HTML inspection and repair. Use `bin/defuddle` when its Markdown output is useful.

The executable `extract` file can call a typed TypeScript source file through `pnpm exec tsx`.

## Change judge

The change judge decides whether one supplied Markdown difference matches the supplied notification trigger.

The prompt supplies:

- One URL
- One cache directory
- One current HTML snapshot
- One notification trigger
- The previous and current canonical Markdown paths
- Their Markdown difference

Do not edit the extractor or a snapshot.

1. Evaluate only the supplied Markdown difference against the notification trigger.
2. If the difference does not match the trigger, finish without a notification.
3. If the difference matches the trigger, identify each added job.
4. For each added job without a direct link, inspect the current HTML snapshot.
5. Examine the matching element, attributes, nearby anchors, embedded data, and event metadata for a URL.
6. Resolve a relative URL against the watched page URL.
7. Call `notify` with a description of the change.
8. Include each added job name and each recovered direct link.
9. If URL recovery fails, call `notify` without a link.

Use URL recovery only for notification content. Do not change the canonical Markdown.

## Cache layout

```text
cache/
└── <url-slug>/
    ├── extract
    ├── extract.ts
    ├── snapshot-<UTC timestamp>.html
    ├── snapshot-<UTC timestamp>.draft.md
    ├── snapshot-<UTC timestamp>.md
    └── failure-state.json
```

HTML snapshots are immutable evidence. Draft Markdown is inspection output. Markdown without `.draft` is canonical comparison data.

## Installed commands

- `bin/defuddle-snapshot <snapshot.html>`: Create draft Markdown.
- `bin/extract-snapshot <snapshot.html>`: Run the saved extractor and create canonical Markdown.
- `bin/compare-snapshots <cache-directory>`: Compare the two newest canonical Markdown files.

# Page-watch agent instructions

Run all commands from the project root. Use pnpm for JavaScript dependencies.

The prompt assigns one role: extractor agent or change judge. Do only the assigned role.

## Extractor agent

The extractor agent configures extraction and records the organization name for a watched page.

The prompt supplies:

- One URL
- One snapshot directory
- One current HTML snapshot
- The notification trigger, which identifies data that the extractor must preserve
- A setup, audit, or organization-name reason

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
6. Create `snapshots/<url-slug>/extract` and its typed source file.
7. Run the extractor through the canonical runner.

   ```sh
   bin/extract-snapshot "$snapshot"
   ```

8. Compare the canonical Markdown with every extraction expectation.
9. Save the page's organization name at the supplied `organizationNamePath`.
10. Finish only when the canonical Markdown contains all required data.

### Audit task

1. Inspect the supplied HTML and the saved extractor.
2. Run the saved extractor against the supplied HTML.
3. Compare the output with the data in the HTML.
4. If the extractor is wrong, fix it and test it again.
5. If the extractor is correct, do not change it.

### Organization-name task

1. Inspect the supplied HTML.
2. Identify the organization that owns the jobs page.
3. Use standard capitalization where appropriate.
4. Preserve intentional lowercase or uppercase company styling from the source.
5. Write only that organization name and a newline to the supplied `organizationNamePath`.
6. Do not edit the extractor or a snapshot.

### Extractor contract

The fixed extractor path is `snapshots/<url-slug>/extract`.
The fixed organization-name path is `snapshots/<url-slug>/organization-name.txt`.

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
- One snapshot directory
- One current HTML snapshot
- One notification trigger
- One saved organization name
- The previous and current canonical Markdown paths
- Their Markdown difference

Do not edit the extractor or a snapshot.

1. Evaluate only the supplied Markdown difference against the notification trigger.
2. If the difference does not match the trigger, submit a `not-matched` judgment.
3. If the difference matches the trigger, identify each added job.
4. For each added job without a direct link, inspect the current HTML snapshot.
5. Examine the matching element, attributes, nearby anchors, embedded data, and event metadata for a URL.
6. Resolve a relative URL against the watched page URL.
7. Submit a `matched` judgment with the change text that the notification trigger requests.
8. Include each added job name and each recovered direct link.
9. If URL recovery fails, submit the judgment without a link.
10. If a system problem prevents a valid judgment, submit a `failure` judgment that describes the problem.

Call `submit-judgment` exactly once. The workflow sends failure text without changes.
The workflow places matched text under the saved organization-name heading. Do not repeat that name in the text.
Use URL recovery only for judgment text. Do not change the canonical Markdown.

## Snapshot layout

```text
snapshots/
└── <url-slug>/
    ├── extract
    ├── extract.ts
    ├── objects/
    │   └── <SHA-256>.html
    ├── snapshot-<UTC timestamp>.html -> objects/<SHA-256>.html
    ├── snapshot-<UTC timestamp>.draft.md
    ├── snapshot-<UTC timestamp>.md
    └── failure-state.json
```

HTML snapshots are immutable evidence. Each timestamped HTML path is a symbolic link to its content-addressed object.
Draft Markdown is inspection output. Markdown without `.draft` is canonical comparison data.
The poll cycle deletes snapshot files after seven days. It then deletes each HTML object that has no timestamped link.

## Installed commands

- `bin/defuddle-snapshot <snapshot.html>`: Create draft Markdown.
- `bin/extract-snapshot <snapshot.html>`: Run the saved extractor and create canonical Markdown.
- `bin/compare-snapshots <snapshot-directory>`: Compare the two newest canonical Markdown files.

# Docker deployment

The image runs systemd as PID 1, then a lingering `linkus-dinkus` user manager
(UID/GID 1000). That manager runs the Google Sheets poller, its generated timer,
and the Telegram bookmark bot. Do not override the image command or enable
Compose's `init` option.

## Host requirements

Use a dedicated Linux Docker Engine host with Docker Compose v2 and cgroup v2.
The published image targets `linux/amd64`; other architectures need emulation.
This deployment grants the container privileged access and a writable host cgroup
mount so systemd can manage its system and user services. It is **not a sandbox**:
do not use a shared/untrusted host. Rootless Docker and Docker Desktop are not
supported by this configuration. No inbound network ports are needed; outbound
HTTPS must reach the LLM provider, Google Sheets, Telegram, and watched sites.

## Configure

Create a private environment file outside the repository, for example
`/etc/linkus-dinkus/container.env`, readable only by the deploying administrator:

```dotenv
LLM_PROVIDER_URL=https://your-gateway.example/
LLM_PROVIDER_API_TOKEN=replace-with-gateway-token
LLM_PROVIDER_MODEL_PROVIDER=replace-with-model-provider
LLM_PROVIDER_MODEL_ID=replace-with-model-id
TELEGRAM_BOT_TOKEN=replace-with-bot-token
TELEGRAM_CHAT_ID=replace-with-chat-id
GOOGLE_SERVICE_ACCOUNT_PATH=/etc/linkus-dinkus/google-service-account.json
# Optional: pin an immutable GitHub-built image rather than latest.
# LINKUS_IMAGE=ghcr.io/shyndman/linkus-dinkus:sha-FULL_COMMIT_SHA
```

All four `LLM_PROVIDER_*` values are required. The URL is the gateway root
(for example `https://host/`). Direct Vercel AI SDK calls append `/v1` and use
the provider-qualified model ID. Agent calls use `pi-native` transport at the
root URL, selecting the same provider and model while retaining client catalog
metadata. Supply the provider separately; model IDs can include that provider prefix.
The gateway owns the upstream credentials; its bearer token authenticates both paths.

The gateway currently drops `response_format` when translating compatible API
requests. JSON-schema enforcement is therefore a gateway limitation; direct
text generation and tool-result round trips work through the compatible API.

Never bake credentials into the image or commit this environment file.
Docker administrators can inspect container environment variables.

Place the Google service-account JSON at the configured absolute host path.
Its parent directories must be traversable and the file readable by container
UID/GID 1000. For example, use root ownership, group 1000, directory mode 0750,
and file mode 0640; do not make the private key world-readable. Compose refuses
to create a missing source file, and mounts it read-only at
`/etc/linkus-dinkus/secrets/google-service-account.json`.
Share the spreadsheet with the service account's email as an editor.
The spreadsheet ID and named ranges (`notificationTrigger`, `pollFrequency`,
`urls`, `lastCheckDateTime`) are configured in `src/config.ts`; provision those
ranges and check that ID before deployment. A different ID currently requires
changing that configuration and building an image. Retain the existing spacer
row and saved-job layout in the sheet.

## Start and inspect

From this repository's root (the location of `compose.yml`):

```sh
docker compose --env-file /etc/linkus-dinkus/container.env pull
docker compose --env-file /etc/linkus-dinkus/container.env up -d
# PID 1 and user-manager status:
docker compose exec linkus systemctl status user@1000.service --no-pager
# Status as the application user, connected to its user bus:
docker compose exec --user 1000:1000 -e XDG_RUNTIME_DIR=/run/user/1000 linkus \
  systemctl --user status linkus-dinkus-bootstrap.service linkus-dinkus-bookmarks.service --no-pager
docker compose exec --user 1000:1000 -e XDG_RUNTIME_DIR=/run/user/1000 linkus \
  systemctl --user list-timers --all --no-pager
docker compose exec linkus journalctl --no-pager -n 100 \
  _SYSTEMD_USER_UNIT=linkus-dinkus.service \
  _SYSTEMD_USER_UNIT=linkus-dinkus-bootstrap.service \
  _SYSTEMD_USER_UNIT=linkus-dinkus-bookmarks.service
```

The bootstrap performs the initial real poll and creates the persistent user
timer when it does not exist. A completed bootstrap oneshot may show `inactive
(dead)`; inspect its journal and the generated timer rather than treating this
as a failed daemon. On later starts, the persisted enabled timer is reused.
Service journals are inside the container; `docker compose logs` alone does not
show all application logs. Journals are not retained across container replacement.

The Compose-managed `state` volume mounts the user's entire home at
`/var/lib/linkus-dinkus`. It preserves snapshots, generated extractors, bookmark
state, and user timer configuration across upgrades. A new named volume inherits
the image directory's UID/GID 1000 and mode 0700. If replacing it with a bind
mount or restoring a backup, provision that ownership and permissions first.
Do not share the volume between independent deployments/users. Use distinct
Compose project names (`-p`) for separate deployments. Never use `down -v` unless
you deliberately want to erase all persistent state. Stop the service before
backing up/restoring the volume for a consistent snapshot.

To update, repeat `pull` and `up -d`. Environment changes require container
recreation (`up -d --force-recreate`), not just restarting a user service.
To build locally without credentials:

```sh
docker build --pull -t linkus-dinkus:local .
LINKUS_IMAGE=linkus-dinkus:local docker compose \
  --env-file /etc/linkus-dinkus/container.env up -d
```

Local shell launchers share `bin/runtime-env`, which adds the installed
`~/.local/share/pnpm/bin` directory to PATH before invoking dependencies.
The container uses its installed `/usr/local/bin` runtimes; local user services
also include the existing Homebrew runtime directory through that shared setup.

## GitHub-built images

`.github/workflows/publish-image.yml` builds on pull requests, pushes to `main`,
`v*` tags, and manual dispatch. Every build loads the image and checks installed
runtimes, the TypeScript loader, service enablement, and application-user access
before publication. Pull requests never log in or publish. Other events publish
`ghcr.io/<repository>:sha-<full-commit-sha>`; `main` additionally publishes
`latest`, and version tags publish their exact tag. A manual run on another
branch publishes only its commit tag. BuildKit layers are cached through GitHub
Actions. The workflow uses `GITHUB_TOKEN` with package-write permission; no
provider, Telegram, or Google credentials are needed for builds.

For a private GHCR package, authenticate Docker with a token allowed to read that
package before pulling. Public deployments require making the package public
in GitHub's package settings. Repository administrators must allow Actions to
publish packages. Runtime validation against real integrations still requires
the private configuration above; CI's smoke check does not boot systemd or call
external services.

The browser CLI source is pinned with `CAMOUFOX_REVISION` in the Dockerfile;
spreadsheet MCP uses `SPREADSHEET_MCP_REVISION`. Browser Python dependencies
are resolved by `uv sync` because that upstream revision does not contain a
`uv.lock`; the spreadsheet integration uses its committed frozen lockfile.

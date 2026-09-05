# syntax=docker/dockerfile:1.18

FROM node:24.5.0-bookworm-slim AS node
FROM oven/bun:1.4.0 AS bun
FROM ghcr.io/astral-sh/uv:0.11.16 AS uv

FROM ubuntu:26.04

ARG CAMOUFOX_BUILD_REVISION=local
ARG SPREADSHEET_MCP_REVISION=598f4f53febe8ff4466b2babb582eaa9ef803745

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Toronto
ENV XDG_CACHE_HOME=/usr/lib/linkus-dinkus/cache

COPY --from=node /usr/local/ /usr/local/
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        dbus \
        dbus-user-session \
        git \
        libasound2t64 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo-gobject2 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libfontconfig1 \
        libfreetype6 \
        libgbm1 \
        libgdk-pixbuf-2.0-0 \
        libgtk-3-0t64 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcomposite1 \
        libxcursor1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxi6 \
        libxkbcommon0 \
        libxrandr2 \
        libxrender1 \
        libxcb-shm0 \
        libxcb1 \
        libxshmfence1 \
        python3 \
        systemd \
        systemd-sysv \
        tzdata \
        util-linux \
    && rm --recursive --force /var/lib/apt/lists/* \
    && ln --symbolic --force "/usr/share/zoneinfo/${TZ}" /etc/localtime \
    && printf '%s\n' "${TZ}" > /etc/timezone

RUN corepack enable pnpm \
    && corepack prepare pnpm@11.24.0 --activate \
    && npm install --global --omit=dev @oh-my-pi/pi-coding-agent@18.1.4

RUN userdel ubuntu \
    && useradd \
        --uid 1000 \
        --user-group \
        --home-dir /var/lib/linkus-dinkus \
        --create-home \
        --shell /usr/sbin/nologin \
        linkus-dinkus \
    && install --directory --owner=linkus-dinkus --group=linkus-dinkus --mode=0700 /var/lib/linkus-dinkus \
    && install --directory --mode=0755 /etc/linkus-dinkus/secrets /usr/lib/linkus-dinkus/cache /var/lib/systemd/linger \
    && touch /var/lib/systemd/linger/linkus-dinkus

WORKDIR /opt/linkus-dinkus

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY AGENTS.md tsconfig.json ./
COPY .omp/agents/ .omp/agents/
COPY .omp/config.yml .omp/mcp.json .omp/
COPY .omp/extensions/ .omp/extensions/
COPY bin/ bin/
COPY resources/ resources/
COPY src/ src/

RUN git clone https://github.com/shyndman/spreadsheet-mcp.git .tools/spreadsheet-mcp \
    && git -C .tools/spreadsheet-mcp checkout "${SPREADSHEET_MCP_REVISION}" \
    && uv sync --directory .tools/spreadsheet-mcp --frozen --no-dev \
    && printf '%s\n' "${CAMOUFOX_BUILD_REVISION}" > /tmp/camoufox-build-revision \
    && git clone --depth=1 https://github.com/shyndman/camoufox-cli.git .tools/camoufox-cli \
    && uv sync --directory .tools/camoufox-cli --no-dev \
    && .tools/camoufox-cli/.venv/bin/camou install \
    && rm --recursive --force .tools/spreadsheet-mcp/.git .tools/camoufox-cli/.git /tmp/camoufox-build-revision \
    && ln --symbolic /var/lib/linkus-dinkus snapshots \
    && chmod --recursive a-w /opt/linkus-dinkus \
    && chown --recursive linkus-dinkus:linkus-dinkus /usr/lib/linkus-dinkus/cache

ENV HOME=/var/lib/linkus-dinkus

COPY systemd/linkus-dinkus.service systemd/linkus-dinkus-failure.service systemd/linkus-dinkus-bootstrap.service /usr/lib/systemd/user/
COPY systemd/linkus-dinkus-user-environment.conf /etc/systemd/system/user@1000.service.d/linkus-dinkus-environment.conf

RUN install --directory --mode=0755 /etc/systemd/user/default.target.wants \
    && ln --symbolic \
        /usr/lib/systemd/user/linkus-dinkus-bootstrap.service \
        /etc/systemd/user/default.target.wants/linkus-dinkus-bootstrap.service \
    && truncate --size=0 /etc/machine-id

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]

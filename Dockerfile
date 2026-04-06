FROM oven/bun:1.3.11-slim AS base
WORKDIR /usr/src/app

FROM base AS base_with_playwright
ARG TARGETARCH
# install dependencies into temp directory
# this will cache them and speed up future builds
RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    bunx playwright@1.59.1 install-deps chromium-headless-shell
# Install to a fixed path accessible by all users (including the 'bun' user at runtime)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    bunx playwright@1.59.1 install --only-shell chromium-headless-shell
# Load custom fonts into the system font cache
COPY src/infrastructure/exporters/fonts /usr/local/share/fonts/genie
RUN fc-cache -f -v

FROM base AS download_dependencies
ARG TARGETARCH

RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip wget \
    && mkdir -p ./bin

RUN --mount=type=cache,id=yt-dlp-2026-03-17-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp_linux"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp_linux_aarch64"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && ( [ -s /cache/yt-dlp-2026-03-17 ] || wget -q --show-progress --progress=bar:force -O /cache/yt-dlp-2026-03-17 "$YT_DLP_URL" ) \
    && cp /cache/yt-dlp-2026-03-17 ./bin/yt-dlp \
    && chmod +x ./bin/yt-dlp
RUN --mount=type=cache,id=deno-v2-7-9-$TARGETARCH,target=/cache \
    if [ "$TARGETARCH" = "amd64" ]; then \
        DENO_URL="https://github.com/denoland/deno/releases/download/v2.7.9/deno-x86_64-unknown-linux-gnu.zip"; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        DENO_URL="https://github.com/denoland/deno/releases/download/v2.7.9/deno-aarch64-unknown-linux-gnu.zip"; \
    else \
        echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1; \
    fi \
    && ( [ -s /cache/deno-v2-7-9 ] || ( wget -q --show-progress --progress=bar:force -O /cache/deno-v2-7-9.zip "$DENO_URL" \
        && unzip /cache/deno-v2-7-9.zip deno -d /cache \
        && mv /cache/deno /cache/deno-v2-7-9 \
        && rm /cache/deno-v2-7-9.zip ) ) \
    && cp /cache/deno-v2-7-9 ./bin/deno \
    && chmod +x ./bin/deno

FROM base AS install
ARG TARGETARCH
# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bunfig.toml bun.lock /temp/prod/
RUN --mount=type=cache,id=bun-$TARGETARCH,target=/root/.bun/install/cache \
    cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS prerelease
COPY . .

# copy production dependencies and source code into final image
FROM base_with_playwright AS release
COPY --from=download_dependencies /usr/src/app/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=download_dependencies /usr/src/app/bin/deno /usr/local/bin/deno
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/tsconfig.json .
COPY --from=prerelease /usr/src/app/config.default.yaml .

ENV NODE_ENV=production

# run the app
USER bun
ENTRYPOINT [ "bun" ]
CMD [ "run", "start:instrumented" ]

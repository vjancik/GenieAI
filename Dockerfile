FROM oven/bun:1.3.11-slim AS base
WORKDIR /usr/src/app

FROM base AS base_with_playwright
ARG TARGETARCH
# install dependencies into temp directory
# this will cache them and speed up future builds
RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    bunx playwright@1.58.2 install-deps chromium-headless-shell
# Install to a fixed path accessible by all users (including the 'bun' user at runtime)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright@1.58.2 install --only-shell chromium-headless-shell
# Load custom fonts into the system font cache
COPY src/infrastructure/exporters/fonts /usr/local/share/fonts/genie
RUN fc-cache -f -v

FROM base AS download_dependencies
ARG TARGETARCH

RUN --mount=type=cache,id=apt-cache-$TARGETARCH,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib-$TARGETARCH,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends unzip

COPY ./scripts/docker/downloadFile.ts .
RUN bun run downloadFile.ts \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.03.17/yt-dlp_linux \
    ./bin/yt-dlp \
    && chmod +x ./bin/yt-dlp \
    && chown bun:bun ./bin/yt-dlp
RUN bun run downloadFile.ts \
    https://github.com/denoland/deno/releases/download/v2.7.9/deno-x86_64-unknown-linux-gnu.zip \
    ./bin/deno.zip \
    && unzip ./bin/deno.zip -d ./bin \
    && rm ./bin/deno.zip \
    && chmod +x ./bin/deno \
    && chown bun:bun ./bin/deno

FROM base AS install
# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

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
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "start:instrumented" ]

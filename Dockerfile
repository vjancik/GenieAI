# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1.3.11-slim AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS base_with_playwright_deps
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    bunx playwright@1.58.2 install-deps chromium

FROM base_with_playwright_deps AS base_with_playwright
# Install to a fixed path accessible by all users (including the 'bun' user at runtime)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright@1.58.2 install chromium
# Load custom fonts into the system font cache
COPY src/infrastructure/exporters/fonts /usr/local/share/fonts/genie
RUN fc-cache -f -v

FROM base AS install
# RUN mkdir -p /temp/dev
# COPY package.json bun.lock /temp/dev/
# RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
# COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# copy production dependencies and source code into final image
FROM base_with_playwright AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/package.json .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# run the app
USER bun
ENTRYPOINT [ "bun", "run", "start:instrumented" ]

FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq unzip python3 \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
RUN corepack enable

# Extra system tools your repos need (tofu, ...) go here.

# The agent's browser: Playwright MCP and the Chromium build its Playwright expects,
# with Chromium's system libraries. Launched by the bridge (bridge/browser.ts).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g @playwright/mcp@0.0.83 \
 && node "$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

WORKDIR /opt/gilfoyle
COPY bridge/package.json bridge/bun.lock bridge/
RUN cd bridge && bun install --frozen-lockfile --production
COPY CLAUDE.md gilfoyle.yaml ./
COPY skills skills/
COPY bridge bridge/
COPY bin bin/
ENV PATH=/opt/gilfoyle/bin:$PATH GILFOYLE_DATA=/data COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
ENTRYPOINT ["entrypoint.sh"]

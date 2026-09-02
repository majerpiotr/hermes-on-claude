# Claude Code as a model backend for an OpenAI-compatible caller.
# Kept separate from the Hermes image on purpose: the subscription token lives
# only in this container, so the agent runtime (which has a shell and an LLM
# driving it) never has access to it.
#
# Single runtime: Node is required anyway to run @anthropic-ai/claude-code
# (it is an npm package), so the HTTP bridge is written in Node too rather
# than pulling in Python for that half alone.
#
# Alpine, not Debian: @anthropic-ai/claude-code ships explicit musl builds
# (linux-x64-musl, linux-arm64-musl as optionalDependencies) alongside the
# glibc ones, so it is officially supported here, not just "happens to run".
#
# Node 24, Alpine 3.21 -- a real version pin, not the floating `latest` or
# `node:24-alpine` (which drifts to whatever Alpine minor is current). Bump
# deliberately by changing this tag, not by chasing latest on every rebuild.
FROM node:24-alpine3.21

RUN npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force

# Empty cwd for the CLI: nothing to discover even if --safe-mode ever changes.
# Alpine's BusyBox userland uses adduser, not Debian's useradd. -D creates a
# real home dir (Claude Code writes its own state there, e.g. .claude.json)
# without setting a password.
RUN adduser -D -u 10001 shim \
 && mkdir -p /var/empty-workspace \
 && chown shim:shim /var/empty-workspace

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci, not npm install: the lockfile pins the resolution, and app.mjs
# relies on a Fastify API newer than the floor of the ^5.2.1 range declared
# in package.json, so a drifting resolution could break startup.
RUN npm ci --omit=dev && npm cache clean --force

COPY app.mjs translate.mjs claude_backend.mjs ./

USER shim
ENV HOME=/home/shim \
    CLAUDE_SHIM_CWD=/var/empty-workspace \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.mjs"]

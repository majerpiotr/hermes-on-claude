# Hermes Agent on a Claude subscription

Run [Hermes Agent](https://hermes-agent.nousresearch.com) in Docker with your
**Claude subscription** as its model backend, instead of a pay-per-token API
key.

Hermes stays the agent: it plans, holds the conversation, and runs its own
tools (shell, files, web search, and more). Claude Code is reduced to a
completion engine behind an OpenAI-compatible bridge, with no tools, no project
config and no loop of its own.

```
Hermes (agent: tools, loop, state)
   |  OpenAI /v1/chat/completions
   v
claude-shim  (Node, Fastify)
   |  claude -p --tools "" --model <chosen per call>
   v
Claude Code CLI  ->  authenticates with your Claude subscription
```

## Why two containers

| Service | Holds | Why it is separate |
|---|---|---|
| `hermes` | agent state, skills, sessions, memories | official upstream image, stays upgradable |
| `claude-shim` | the Claude Code CLI **and the subscription token** | Hermes runs a shell driven by an LLM; anything it can read is one prompt injection away from leaving the machine |

**The token never enters the Hermes container.** It is passed only to
`claude-shim`, which holds the CLI, does the authenticating, and returns
nothing but model output. Hermes talks to it over an internal Docker network
and never sees a credential. This is the main reason the stack is split.

## Requirements

- **Docker with Compose v2** (`docker compose`, not the old `docker-compose`)
- **A Claude subscription.** Built and verified on Max 5x.
- **Claude Code on a machine with a browser**, to mint the token once. The VPS
  itself does not need one.
- **RAM: 4 GB is enough.** Defaults are sized for a 2 vCPU / 4 GB VPS
  (Hetzner CX22/CX23 and equivalents) and leave ~1 GB for the host. Measured on
  this stack: Hermes peaks around 480 MB doing real work, the shim around
  260 MB per concurrent model call. Tune via `.env` if your box differs.
- **Disk: ~8 GB free.** Measured breakdown:

  | What | Size | Note |
  |---|---|---|
  | Hermes image | 3.9 GB | upstream; bundles Python, Node, Playwright/Chromium, ffmpeg |
  | shim image | 550 MB | Alpine + Node + the Claude Code CLI |
  | `hermes-home/` | ~150 MB | config, session databases, logs, skills |
  | `hermes-home/lazy-packages/` | ~30 MB | optional ML packages Hermes fetches on demand |

  Most of the total is the upstream Hermes image, which is large because it
  ships a browser and media tooling. Leave headroom: Docker build cache and
  image layers add more, and `lazy-packages/` grows if you use vision or audio
  tools.
- **Hermes 0.21** (`v2026.8.31`), pinned in `hermes/Dockerfile`. A floating
  `latest` would let two machines building the same commit land on
  different releases, with a config schema that no longer matches the
  template here.
- **amd64 and arm64 both work.** Verified: the shim image builds on both, and
  `@anthropic-ai/claude-code` ships musl builds for each.

## Setup

```bash
git clone https://github.com/majerpiotr/hermes-on-claude.git
cd hermes-on-claude
./setup.sh
```

The first run creates `.env` and stops, telling you what to fill in:

1. **Mint a token** on a machine with a browser (your laptop, not a headless
   VPS). It is valid for 12 months. This needs the Claude Code CLI installed
   first: `npm install -g @anthropic-ai/claude-code`, or see
   [the docs](https://docs.claude.com/en/docs/claude-code/overview).

   ```bash
   claude setup-token
   ```

2. **Paste it into `.env`** as `CLAUDE_CODE_OAUTH_TOKEN`, on **one unbroken
   line** (see the trap below), and set a dashboard password:

   ```bash
   openssl rand -hex 24
   ```

3. **Run `./setup.sh` again.** It is idempotent: it creates and chowns
   `hermes-home/`, seeds the config, generates Hermes' own secrets, builds both
   images, starts the containers and migrates the config to the image's schema.

Then:

```bash
docker compose exec hermes hermes chat        # talk to the agent
docker compose logs -f claude-shim            # see model + cost per call
```

Everything the agent owns lands in `hermes-home/` inside the clone: config,
sessions, memories, skills, and Hermes' own secrets. It is a bind mount, not a
Docker volume, so the files are plainly there on the host, but Hermes sets the
directory to mode 700 under its own uid (10000), so use `sudo` to look inside.
That directory is the agent: back it up, and if you move the deployment, point
`HERMES_DATA_DIR` at it rather than starting over.

Dashboard on `http://127.0.0.1:9119` when you run this on your own machine.
It asks for a username and password: `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`
(`hermes` unless you changed it) and `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`,
both from `.env`. `setup.sh` prints the URL and username when it finishes. On
a server the address is different, see
[Reaching the dashboard](#reaching-the-dashboard).

## Adopting an existing Hermes installation

If you already run Hermes and want to keep its identity (sessions, memories,
skills, and any messaging-platform credentials it holds), point the stack at
that data directory instead of a fresh one:

```bash
HERMES_DATA_DIR=/srv/hermes    # in .env, the dir bind-mounted to /opt/data
```

`setup.sh` never overwrites an existing `config.yaml`, and it adds only the
missing keys to the existing secrets file, so nothing already in there is
touched. Two consequences worth knowing:

- **Your old model provider survives the move.** Keeping the config is what
  protects your bot token, but it also means `model.provider` still points
  wherever it did before, and the stack quietly keeps billing that way. Setup
  now checks the six routing keys and prints the exact `hermes config set`
  commands when they do not point at the shim.
- **Back up first.** The data directory is the bot. Run
  `tar czf hermes-backup.tgz /srv/hermes` before the first run, and keep your
  old compose file so you can put the previous version back.

## Lifecycle

- **Is it working?** `setup.sh` ends with a real end-to-end model call through
  the shim. A green finish means auth actually works, not just that the
  containers started.
- **Stop:** `docker compose down`.
- **Stop and wipe Claude Code's container state:** `docker compose down -v`.
  `hermes-home/` survives this, since it is a bind mount, not a volume, and
  holds all agent state.
- **Upgrade Hermes:** the base image is pinned in `hermes/Dockerfile`
  (currently `v2026.8.31`, which is Hermes 0.21). Bump that tag, then
  `docker compose build --pull hermes && ./setup.sh`. Going through
  `setup.sh` rather than `up -d` matters: it migrates `config.yaml` to the
  new release's schema and re-runs the end-to-end check.
- **Logs:** `docker compose logs -f hermes`, or
  `docker compose logs -f claude-shim`.

## Choosing models per task

Hermes picks a model per call; the shim passes it straight to `claude --model`.
Set in `hermes-home/config.yaml` (seeded from `hermes-config.template.yaml`):

| Setting | Purpose | Default here |
|---|---|---|
| `model.default` | main reasoning | `claude-sonnet-5` |
| `auxiliary.compression.model` | context compression -- mechanical, keep it cheap | `claude-haiku-4-5` |
| `delegation.model` | subagents | `claude-sonnet-5` |

Note the compression key is nested under `auxiliary`. A top-level
`compression:` block is accepted by the YAML and then ignored, so
`hermes config show` reports `Context Compression Model: (auto)` and every
compression turn silently runs on the main model. Check it with:

```bash
docker compose exec hermes hermes config show | grep -A6 "Context Compression"
```

Full ids (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`) and aliases
(`opus`, `sonnet`, `haiku`) both work. Only Anthropic models are reachable this
way -- a Claude subscription does not cover anyone else's models.

## Billing and terms

Anthropic's help centre, 15 June 2026:

> Update June 15: We're pausing the changes to Claude Agent SDK usage described
> below. For now, nothing has changed: Claude Agent SDK, `claude -p`, and
> third-party app usage still draw from your subscription's usage limits.

This draws on your subscription, not on separately purchased credits, because
the **Claude Code CLI does the authenticating and the calling** -- the
supported path.

It deliberately does **not** use Hermes' own
`hermes auth add anthropic --type oauth`. That is a third party holding a
subscription OAuth token directly, which Anthropic restricted in March 2026,
and which Hermes' own documentation says requires Max plus purchased extra
credits.

That policy is explicitly in transition ("we're working to update the plan"),
so the provider is kept swappable. Moving to a pay-per-token API key:

```bash
docker compose exec hermes hermes config set model.provider anthropic
docker compose exec hermes hermes config set model.default claude-sonnet-5
# then add ANTHROPIC_API_KEY to hermes-home/.env
```

`CLAUDE_SHIM_MAX_BUDGET_USD` caps a single model call. Note it is a *notional*
figure at API list rates: on a subscription you are not billed per token, you
consume your plan's allowance. It is still the only common unit available, and
it does stop a runaway loop.

## Deploying to a VPS

The compose file transfers unchanged. This has been run on a real Linux VPS
(2 vCPU, amd64): both adopting an existing data directory in place, and
checking that a directory created by root and chowned to uid 10000 is then
writable by the container, which is the ownership step below.

What differs from running it on your own machine:

- **Ownership is real on Linux.** `setup.sh` runs
  `chown -R 10000:10000 hermes-home` (with `sudo` if needed). On macOS it
  falls back to `chmod 777`, because Docker Desktop maps uids in its VM.
- **Choose how you reach the ports.** `BIND_ADDR` in `.env` controls the
  Hermes dashboard (9119) and gateway (8642). The default `127.0.0.1` means
  the machine itself only; a private mesh address (Tailscale, WireGuard) makes
  it reachable from the mesh. **Never set it to `0.0.0.0` on a public VPS.**
  Both routes are spelled out in [Reaching the dashboard](#reaching-the-dashboard).

  `SHIM_BIND_ADDR` is separate and controls the shim's port (8080) on its own.
  It defaults to `127.0.0.1` and must stay there, including on a mesh: the
  shim has no authentication of any kind, so anyone who can reach port 8080
  can spend your Claude subscription, unlike the dashboard, which at least has
  basic auth. Hermes reaches the shim over the internal Docker network, not
  through the published port, so keeping it on loopback costs nothing.
- **Mint the token on your laptop, not the server.** `claude setup-token` needs
  a browser. Copy the resulting value over; nothing else about it is
  machine-specific.
- **No inbound connectivity is required** by anything in the stack.
- **Note the token's expiry.** It lasts 12 months. Re-minting it is not a
  restart: `docker compose restart` reuses the container's existing baked-in
  environment, so a new token in `.env` is not picked up and you get a
  confusing 401 from a token that looks perfectly valid (see the "restart
  vs. recreate" trap below). Recreate the container instead:

  ```bash
  # on your laptop
  claude setup-token
  # then on the VPS, after updating .env
  docker compose up -d --force-recreate claude-shim
  ```

### Reaching the dashboard

The container listens on `0.0.0.0`, and Docker publishes that on port 9119 at
the address `BIND_ADDR` names. That setting decides which of these two routes
you use.

**Default `BIND_ADDR=127.0.0.1`: forward the port over SSH.** The port is bound
to the server's own loopback, so nothing outside the machine can reach it.
Forward it from your laptop:

```bash
ssh -L 9119:localhost:9119 user@your-vps
```

Leave that session open and browse to `http://localhost:9119`.

If port 9119 is already taken on your own machine (running this stack locally
takes it), ssh does not stop. It prints `bind: Address already in use` and
`Could not request local forwarding`, then connects anyway and exits 0. The
tunnel is dead while the session looks healthy, and `http://localhost:9119`
quietly serves whatever else holds the port. Forward to a free local port
instead:

```bash
ssh -L 19119:localhost:9119 user@your-vps
```

Then browse to `http://localhost:19119`.

**`BIND_ADDR` set to a mesh address: browse to it directly.** With, say,
`BIND_ADDR=100.x.y.z`, the dashboard is at `http://100.x.y.z:9119` from any
machine on the mesh, no tunnel needed. Note the port is then bound to that
address *only*, so an SSH tunnel to `localhost` stops working: pick one route
or the other.

Either way the dashboard shows a login form. The credentials are
`HERMES_DASHBOARD_BASIC_AUTH_USERNAME` (`hermes` unless you changed it) and
`HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`, both from `.env` on the server.
`setup.sh` prints the URL and the username when it finishes.

## Known limitations

1. **Tool definitions travel in the system prompt.** The CLI offers no way to
   inject external tool schemas, so the shim describes the caller's tools in
   the prompt and constrains the reply with `--json-schema`. That costs more
   input tokens than native tool use and weakens prompt caching. It works; it
   is not free.
2. **Streaming is synthetic.** The CLI returns a whole turn at once.
   `stream: true` is honoured, but arrives as a single chunk.
3. **`temperature`, `top_p` and `max_tokens` are ignored** -- the CLI exposes
   no equivalent knobs. They are accepted and dropped rather than rejected.
4. **Process start-up per call.** Every model call spawns a Node process,
   adding roughly a second of latency.
5. **Browser automation needs extra setup.** Hermes bundles headless Chromium,
   but most `browser_*` tools fail their availability check out of the box and
   the agent falls back to `web_search` or `curl` via `terminal`. If you need
   real browser automation, run
   `docker compose exec hermes hermes tools post-setup agent_browser` and give
   the container more memory. Everything else in this README works without it.

6. **Tool-call syntax can leak into an answer.** The model occasionally
   reaches for Claude's native tool-call XML inside the free-text field the
   decision schema gives it, and the tail of that block (`</content>`,
   `</invoke>`) arrives as part of the reply. Rare: seen once in a session
   that mixed month-old history with fresh turns. The shim logs a warning
   (`reply ends with a closing tag it never opened`) and changes nothing.
   Trimming the tail would corrupt a reply that ends in XML on purpose, an
   Atom feed's own `</content>` being the obvious case, and would turn a
   visible artefact into a quietly truncated answer with nothing left to
   investigate.

## Traps worth knowing

These each cost real debugging time; they are documented so they cost you none.

- **Paste the token as one unbroken line.** A `setup-token` value is ~108
  characters. If your editor wraps it, `.env` keeps only the first part, the
  remainder becomes an orphan line, and you get
  `401 OAuth access token is invalid` from a token that looks perfectly
  correct. `setup.sh` warns when the value is under 100 characters. To check
  by hand:

  ```bash
  awk -F= '/^CLAUDE_CODE_OAUTH_TOKEN=/ {print "token length:", length($2)}' .env
  ```

- **`--bare` would break auth.** It reads as the ideal minimal mode, but it
  forces `ANTHROPIC_API_KEY` and never reads OAuth, defeating the whole point.
  `--safe-mode` is the flag that strips configuration while keeping
  subscription auth.

- **Ambient `CLAUDE*` env vars hijack the CLI.** Inheriting `CLAUDECODE=1` or
  `CLAUDE_CODE_CHILD_SESSION=1` from a parent process makes the CLI treat
  itself as a nested child session and *silently ignore `--model`*. The shim
  passes an explicit allowlist, never the full environment.

- **`modelUsage` lists more than one model.** A single turn bills the requested
  model plus a cheaper one for side duties, so it cannot tell you which model
  answered -- neither "first key" nor "largest output" is reliable. Read
  `message.model` from the last assistant event instead.

- **Tool results must read as ordinary user messages.** An official-looking
  banner (`RUNTIME RESULT from x:`) makes the model treat the content as a
  forged system marker and refuse to trust it. The shim phrases them as
  something the user is reporting.

- **The model refuses to emit tool calls if you claim it has tools.** With its
  own tools stripped, it trusts the runtime over the prompt and answers that
  the tool is unavailable. Framing it as a *planner that only names the action
  an external runtime will perform* removes the contradiction. This is the
  single trick the whole bridge depends on.

- **The dashboard is fail-closed.** It refuses to bind `0.0.0.0` without an
  auth provider, and inside Docker it must bind `0.0.0.0` for the published
  port to reach it. Publishing on `127.0.0.1` is not a substitute for setting
  the basic-auth variables.

- **Hermes' default web search is broken without a key.** It tries keyless
  Firecrawl, gets `403`, and burns a tool turn on every search before falling
  back to the browser or `curl`. This repo switches it to `ddgs` (DuckDuckGo,
  no API key) in the config, and bakes the package into the Hermes image.

- **`docker compose restart` does not pick up a new `.env`.** It reuses the
  container's existing baked-in environment. After changing `.env` (a rotated
  token, a changed bind address), use
  `docker compose up -d --force-recreate <service>` instead. See "Deploying to
  a VPS" for the token-rotation case.

- **Anything installed into a running container disappears.**
  `hermes tools post-setup ddgs` works, but
  `docker compose up --force-recreate` silently wipes it and search quietly
  regresses. That is why `ddgs` is in
  `hermes/Dockerfile` instead. It also keeps uv's ~577 MB package cache out of
  the bind-mounted volume.

## Layout

```
setup.sh                     idempotent installer; start here
docker-compose.yml           deployment, kept outside the volume so the agent cannot edit it
hermes-config.template.yaml  seeded into hermes-home/config.yaml on first run
.env.example                 copy to .env: token, dashboard password, bind address
hermes/Dockerfile            derived Hermes image: upstream + the ddgs search backend
shim/                        the OpenAI-compatible bridge (Node)
  app.mjs                    HTTP surface (Fastify)
  translate.mjs              OpenAI <-> CLI message and tool translation
  claude_backend.mjs         CLI process invocation
hermes-home/                 generated at runtime, gitignored: config, sessions, memories, caches
```

## License

MIT -- see [LICENSE](LICENSE).

Hermes Agent is a separate project by Nous Research, under its own license.
This repository only packages a deployment of it.

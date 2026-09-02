# Hermes with the ddgs search backend baked in.
#
# Why a derived image rather than installing at runtime:
#
# Hermes' default web search is keyless Firecrawl, which returns 403 and burns
# a tool turn on every search. The fix is the ddgs (DuckDuckGo) package, which
# needs no API key -- but installing it into the running container puts it in
# the container's own filesystem, so it silently disappears on any
# `docker compose up --force-recreate` or image pull. That is a routine
# command, and the failure is quiet: search just starts failing again.
#
# Baking it into an image also keeps uv's ~577 MB package cache out of the
# bind-mounted volume, where it would otherwise sit on the deployer's disk
# forever.
#
# Pinned, not `latest`: the base tag is the only thing to bump when upgrading
# Hermes, and a floating tag means two machines building the same commit can
# end up on different Hermes releases, with a config schema that no longer
# matches hermes-config.template.yaml. Bump this deliberately and re-run
# setup.sh, which migrates the config to the new schema.
FROM nousresearch/hermes-agent:v2026.8.31

# Hermes' venv has no pip and `ensurepip` fails on this image, which is why the
# bundled `hermes tools post-setup ddgs` hook cannot finish on its own. uv is
# the supported way in; install it to a system path rather than /opt/data so it
# does not land in the mounted volume.
RUN set -eu; \
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh; \
    UV_CACHE_DIR=/tmp/uv-cache \
      /usr/local/bin/uv pip install --python /opt/hermes/.venv/bin/python3 ddgs; \
    rm -rf /tmp/uv-cache; \
    /opt/hermes/.venv/bin/python3 -c 'import ddgs'

# No USER directive on purpose. The image starts as root because its s6 init
# needs to, then drops to uid 10000 (hermes) for the agent processes. Setting
# USER here would break that handoff. That uid is also why setup.sh chowns the
# bind mount to 10000:10000 -- root starts the container, hermes writes the files.

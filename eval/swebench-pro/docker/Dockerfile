# Derive an eval image from a SWE-bench Pro per-instance image.
# The base already contains the repo checked out at base_commit plus its deps,
# which lets the cliclaw sub-agent build/run the project to self-verify.
#
#   docker build \
#     --build-arg BASE_IMAGE=jefzda/sweap-images:<dockerhub_tag> \
#     -t cliclaw-eval:<tag> \
#     -f eval/swebench-pro/docker/Dockerfile .
#
# Build context must be the cliclaw repo root (we copy dist/ + eval/).
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# --- toolchain: node (>=20), tmux, git ---------------------------------------
# The base images are Ubuntu/Debian-derived. Adjust if a given image differs.
RUN (command -v node >/dev/null 2>&1 && node -v | grep -Eq 'v(2[0-9]|[3-9][0-9])') || ( \
      apt-get update && apt-get install -y curl ca-certificates gnupg tmux git && \
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
      apt-get install -y nodejs && rm -rf /var/lib/apt/lists/* ) \
    && (command -v tmux >/dev/null 2>&1 || (apt-get update && apt-get install -y tmux git))

# --- Claude Code CLI (the sub-agent) -----------------------------------------
RUN npm install -g @anthropic-ai/claude-code

# --- cliclaw (prebuilt dist) + eval harness ----------------------------------
WORKDIR /opt/cliclaw
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY prompts ./prompts
COPY web ./web
COPY eval ./eval

# Auth + per-instance wiring are provided at `docker run` time via env/mounts:
#   -e REPO_PATH=/path/to/repo/in/image   (the checked-out repo at base_commit)
#   -e INSTANCE_JSON=/work/instance.json  (mounted single-instance JSON)
#   -e OUT_PATH=/out/prediction.json      (mounted output dir)
#   -e ANTHROPIC_API_KEY=...  OR  mount ~/.claude.json to /root/.claude.json
#   -v <real ~/.cliclaw/config.json>:/root/.cliclaw/config.json:ro
ENTRYPOINT ["node", "/opt/cliclaw/eval/swebench-pro/docker/in-container-run.mjs"]

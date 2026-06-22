# Evaluating cliclaw on SWE-bench Pro (public set)

Harness to run **cliclaw** against [SWE-bench Pro](https://github.com/scaleapi/SWE-bench_Pro-os)
and score it with the official grader.

> **What is under test:** cliclaw is a meta-orchestrator, not a standard SWE-bench
> agent. A score reflects the *composite system*: **orchestrator brain
> (`gpt-5.5` via the local gateway) + worker (`claude-code`) + cliclaw glue.**
> Pin all three for any reported number (see "Reproducibility").

## ✅ End-to-end verified (2026-05-29)

One instance taken all the way through, on this machine (Apple Silicon, Docker Desktop):

- instance `instance_ansible__ansible-0ea40e09…` (ansible/ansible, python)
- host-mode generation → `status=done`, 0 nudges, clean 841B patch (only `lib/ansible/vars/manager.py`)
- official grader (local Docker, amd64 emulation) → **resolved = true, 16/16 tests PASSED, accuracy 1.0**

The driver/patch logic also has a free hermetic test: `node eval/swebench-pro/test/smoke.mjs` (9/9).

---

## How many tasks?

SWE-bench Pro = **1,865** problems / 41 repos, in three sets:

| Set | Instances | Repos | Public? |
|---|---:|---:|---|
| **Public** (`ScaleAI/SWE-bench_Pro`, split `test`) | **731** | 11 | ✅ problems **and** oracle |
| Held-out | 858 | 12 | ❌ |
| Commercial | 276 | 18 | ❌ (results only) |

**You can run the full 731 locally.** Verified breakdown of the public set:

- Languages: **go 280, python 266, js 165, ts 20**
- Repos (11): ansible 96, openlibrary 91, flipt 85, qutebrowser 79, teleport 76,
  webclients 65, vuls 62, navidrome 57, element-web 56, NodeBB 44, tutanota 20

Resolved = after applying your patch + the gold `test_patch`, **all `fail_to_pass`
pass and all `pass_to_pass` still pass**. Resolve Rate = resolved / 731.

---

## Recommended flow: hybrid (host generates, Docker grades)

Chosen because Claude Code's subscription token lives in the macOS **login
Keychain** and only resolves under the user's **real HOME** — it cannot be
carried into a Linux container or a temp HOME (verified: copy/symlink both report
"Not logged in"). Generating on the host keeps the worker authenticated and
native (fast); only grading runs in Docker (no Claude needed there).

```
Phase A — host (per instance)                     Phase B — Docker (once)
  prepare-repo.mjs                                  swe_bench_pro_eval.py
   docker cp <image>:/app -> repos/<id>             --raw_sample_path …jsonl   (jsonl read directly!)
  run-instance.mjs                                  --patch_path predictions.json
   isolated cliclaw (own $HOME + own tmux server)   --use_local_docker --docker_platform linux/amd64
   -> WS task -> sub-agent edits -> git diff        applies patch + gold tests -> resolved?
   -> append {instance_id, patch, prefix}
```

### Isolation & auth mechanism (how host mode stays safe)
- cliclaw runs with `HOME=<tempdir>` → uses an isolated `~/.cliclaw` (the user's
  real `memory.sqlite` / conversation is never touched). Config is seeded from the
  real `config.json` with MCP/embeddings/mdns/learning stripped.
- Each instance gets its **own tmux server** via `TMUX_TMPDIR` → it cannot adopt
  the user's running cliclaw sessions (`listCliclawAgents()` hardcodes `cliclaw-`).
- That tmux server is **pre-started with the real HOME** and `set-environment -g
  HOME <real>`, so sub-agent panes inherit the real HOME and Claude Code
  authenticates via the Keychain. (`lib/server.mjs`.)

---

## Layout

```
lib/driver.mjs     WS driver: cookie auth -> /ws -> task -> completion (sentinel + active-agent poll)
lib/server.mjs     isolated cliclaw launcher (temp $HOME, own tmux server w/ real-HOME panes)
lib/patch.mjs      git diff extraction; excludes agent venv/__pycache__/node_modules junk
lib/prompt.mjs     task prompt + sentinel protocol + oracle-leak guard
lib/api.mjs util.mjs   REST GET helper / port helpers
prepare-repo.mjs   docker cp the repo@base_commit out of the official image
run-instance.mjs   run ONE instance (host mode) -> append prediction
run-batch.mjs      select N (ids / ids-file / stratified sample) and run sequentially
dataset/prepare.py download the 731-row public set -> jsonl
mock/ test/        protocol-faithful fake server + hermetic smoke (no LLM/Docker)
docker/            full-container mode (needs ANTHROPIC_API_KEY for the worker) — template
runs/              predictions + logs + repo checkouts (gitignored)
```

---

## Run it

```bash
# 0. free hermetic smoke (no LLM/tmux/Docker; never touches ~/.cliclaw)
node eval/swebench-pro/test/smoke.mjs

# 1. dataset (731 rows)
uv run --with datasets python3 eval/swebench-pro/dataset/prepare.py \
  --out eval/swebench-pro/dataset/swe_bench_pro.jsonl

# 2a. one instance, end to end (host gen)
npm run build
node eval/swebench-pro/prepare-repo.mjs --instances eval/swebench-pro/dataset/swe_bench_pro.jsonl --id <id>
node eval/swebench-pro/run-instance.mjs --instances eval/swebench-pro/dataset/swe_bench_pro.jsonl \
  --id <id> --repo-dir eval/swebench-pro/runs/repos/<id> \
  --out eval/swebench-pro/runs/predictions.json --prefix run1 --timeout-min 25

# 2b. a stratified pilot (sequential — host mode shares one machine)
node eval/swebench-pro/run-batch.mjs --instances eval/swebench-pro/dataset/swe_bench_pro.jsonl \
  --sample 10 --out eval/swebench-pro/runs/predictions.json --prefix pilot

# 3. grade (from a SWE-bench_Pro-os checkout; needs pandas/tqdm/docker)
git clone https://github.com/scaleapi/SWE-bench_Pro-os && cd SWE-bench_Pro-os
DOCKER_HOST=unix://$HOME/.docker/run/docker.sock \
uv run --with pandas --with tqdm --with docker python swe_bench_pro_eval.py \
  --raw_sample_path /abs/eval/swebench-pro/dataset/swe_bench_pro.jsonl \
  --patch_path     /abs/eval/swebench-pro/runs/predictions.json \
  --output_dir     /abs/eval/swebench-pro/runs/grade \
  --scripts_dir run_scripts --num_workers 4 \
  --dockerhub_username jefzda --use_local_docker --docker_platform linux/amd64
# -> runs/grade/eval_results.json + "Overall accuracy"
```

---

## Phased plan

| Phase | N | Goal |
|---|---:|---|
| 0 Smoke | 1 | ✅ done — pipeline proven, 1/1 resolved |
| 1 Pilot | ~50 (stratified) | stability, timeout tuning, cost/time extrapolation |
| 2 Full | 731 | reported Resolve Rate |

**Cost/time:** generation dominates (long-horizon agent runs, sequential in host
mode). Grading is fast but every sweap image is **linux/amd64** → runs under
emulation on Apple Silicon (fine for tens; slow for 731 — consider an amd64 Linux
box or Modal for the full grade). Extrapolate from the pilot before committing.

## Reproducibility — pin in any report
orchestrator provider/model (`gpt-5.5` / `openai-responses`), worker + version
(`claude-code` 2.1.x), `--timeout-min`, `--max-nudges`, MCP on/off (default off),
thinking level, cliclaw commit, dataset revision. `run-instance.mjs` records these
under each prediction's `_meta`.

## Notes / limits
- **Container mode** (`docker/`) is a template: faithful + parallel, but the worker
  needs an `ANTHROPIC_API_KEY` (subscription auth can't enter the container).
- Host mode is **sequential** (single shared machine/tmux). For parallelism use an
  amd64 Linux host + container mode + API key.
- The agent is given only `problem_statement` (+ optional `requirements`/`interface`);
  oracle fields are stripped by `lib/prompt.mjs`.
```

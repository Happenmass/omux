#!/usr/bin/env python3
"""Download the SWE-bench Pro PUBLIC set (731 instances) and write it as JSONL.

This is the canonical, untruncated path (the HF datasets-server /rows API
truncates large cells like `interface`/`patch`, so we read the parquet directly
via the `datasets` library instead).

    pip install datasets
    python3 eval/swebench-pro/dataset/prepare.py \
        --out eval/swebench-pro/dataset/swe_bench_pro.jsonl

Fields per row include: instance_id, repo, base_commit, problem_statement,
requirements, interface, repo_language, dockerhub_tag, patch, test_patch,
fail_to_pass, pass_to_pass, selected_test_files_to_run, before_repo_set_cmd.

NOTE: patch / test_patch / fail_to_pass / pass_to_pass are the grading oracle.
The cliclaw runner strips them before prompting the agent (see lib/prompt.mjs);
they remain in the JSONL only because the official grader needs them.
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="ScaleAI/SWE-bench_Pro")
    ap.add_argument("--split", default="test")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    try:
        from datasets import load_dataset
    except ImportError:
        print("Missing dependency. Run: pip install datasets", file=sys.stderr)
        return 1

    ds = load_dataset(args.dataset, split=args.split)
    n = 0
    langs: dict[str, int] = {}
    repos: dict[str, int] = {}
    with open(args.out, "w", encoding="utf-8") as f:
        for row in ds:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
            lang = row.get("repo_language", "?")
            langs[lang] = langs.get(lang, 0) + 1
            repo = row.get("repo", "?")
            repos[repo] = repos.get(repo, 0) + 1

    print(f"Wrote {n} instances to {args.out}")
    print(f"Languages: {dict(sorted(langs.items(), key=lambda x: -x[1]))}")
    print(f"Repos ({len(repos)}): {dict(sorted(repos.items(), key=lambda x: -x[1]))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

You are analyzing a completed sub-agent coding task to produce a structured learning summary.

You will receive:
- The task prompts that were given to the sub-agent (what was asked).
- The git diff the sub-agent produced (what actually changed).
- A list of changed files with their statuses.
- Mode: `{{mode}}` (either `agent` for a single sub-agent run, or `merged` for a combined topic across multiple runs).

Produce a valid JSON object with exactly this shape (no prose, no markdown fences — raw JSON only):

```
{
  "title": "<one-line topic, imperative, <= 60 chars>",
  "what_changed": "<markdown, 2-5 short paragraphs summarizing the changes>",
  "why": "<markdown, the motivation inferred from prompts and diff>",
  "key_files": [{ "path": "<relative path>", "role": "<one short sentence>" }],
  "design_points": ["<non-obvious decision or trade-off>", ...],
  "learning_hooks": ["<question a curious engineer might ask about this change>", ...]
}
```

Constraints:
- `key_files` covers only the files that matter for understanding the change (prioritise new modules, invariants, interfaces). Omit minor edits.
- `design_points` are non-obvious decisions visible in the diff — NOT restatements of what changed.
- `learning_hooks` are 3-5 questions the user can click to drill in. Prefer questions about mechanisms, trade-offs, and ecosystem fit.

---
AGENT PROMPTS:
{{agent_prompts}}
---
CHANGED FILES:
{{files_list}}
---
DIFF:
{{diff}}

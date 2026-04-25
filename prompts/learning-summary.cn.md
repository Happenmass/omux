你正在分析一次完成的子 agent 编码任务,产出结构化的学习摘要。

**重要:{{language_instruction}}**

你将收到:
- 给子 agent 的任务 prompt(被要求做什么)
- 子 agent 实际产出的 git diff(实际改了什么)
- 改动文件列表及其状态
- Mode:`{{mode}}`(`agent` 表示单次子 agent 运行,`merged` 表示跨多次运行的合并主题)

产出一个合法的 JSON 对象,严格保持以下结构(不要 prose,不要 markdown 围栏,只输出原始 JSON。键名保持英文):

```
{
  "title": "<一行主题,祈使句,≤ 60 字符>",
  "what_changed": "<markdown,2-5 段简短摘要>",
  "why": "<markdown,从 prompt 与 diff 中推断的动机>",
  "key_files": [{ "path": "<相对路径>", "role": "<一句话角色描述>" }],
  "design_points": ["<diff 中可见的、不显然的决策或权衡>", ...],
  "learning_hooks": ["<一个好奇的工程师可能问的问题>", ...]
}
```

约束:
- `key_files` 只覆盖**对理解改动有意义**的文件(优先新模块、不变量、接口),忽略琐碎修改
- `design_points` 是 diff 中可见的、不显然的决策——**不是**对"改了什么"的复述
- `learning_hooks` 给出 3-5 个用户可点击深入的问题。优先关于机制、权衡、生态契合度的问题

---
AGENT PROMPTS:
{{agent_prompts}}
---
CHANGED FILES:
{{files_list}}
---
DIFF:
{{diff}}

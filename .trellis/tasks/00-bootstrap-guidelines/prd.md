# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `trellis init` on this project for the first time.
`.trellis/` now exists with empty spec scaffolding, and this bootstrap task
exists under `.trellis/tasks/`. When they want to work on it, they should start
this task from a session that provides Trellis session identity.

**Your job**: help them populate `.trellis/spec/` with the team's real
coding conventions. Every future AI session — this project's
`trellis-implement` and `trellis-check` sub-agents — auto-loads spec files
listed in per-task jsonl manifests. Empty spec = sub-agents write generic
code. Real spec = sub-agents match the team's actual patterns.

Don't dump instructions. Open with a short greeting, figure out if the repo
has any existing convention docs (CLAUDE.md, .cursorrules, etc.), and drive
the rest conversationally.

---

## Status (update the checkboxes as you complete each item)

- [x] Fill backend guidelines → 已改为 `qinglong/` 单层(详见下方"本项目适配说明")
- [x] Fill frontend guidelines → **不适用,已删除**
- [x] Add code examples

---

## 本项目适配说明(2026-10 实际执行)

`trellis init` 把本仓库探测为 fullstack,生成了 `backend/` + `frontend/` 双层
spec。实际仓库是**青龙签到脚本集合**(无 `package.json`、无前端代码),故:

1. 删除 `.trellis/spec/frontend/`(6 个 React/TS 模板文件,本仓库无对应代码)
2. `.trellis/spec/backend/` 重命名为 `.trellis/spec/qinglong/`,并按真实关注点重组:
   - `index.md` —— 仓库定位、运行环境、三条最易违反的约定
   - `directory-structure.md` —— 单脚本自包含原则、不可手改文件
   - `env-and-config.md` —— 环境变量前缀与命名现状
   - `logging-and-notify.md` —— `cron`/`new Env` 头声明、日志前缀、sendNotify 加载
   - `error-handling.md` —— 站点专属错误类、顶层兜底、429 预算退避
   - `quality-guidelines.md` —— 本地可验证范围、审阅清单、提交约定
3. 删除模板生成的 `database-guidelines.md`(本仓库无数据库)
4. spec **使用中文**(有意覆盖模板的英文要求):仓库内注释、日志、通知文案全为中文
5. 补充根目录 `.gitignore`(`__pycache__/`、`*.pyc`、`node_modules/`)

---

## Spec files to populate

### 已填充的规范(替代原 backend/frontend 模板)

| 文件 | 记录内容 |
|------|----------|
| `.trellis/spec/qinglong/index.md` | 仓库定位、青龙运行环境、规范索引 |
| `.trellis/spec/qinglong/directory-structure.md` | 单脚本自包含原则、命名约定、`newapi.js` 勿手改 |
| `.trellis/spec/qinglong/env-and-config.md` | 站点前缀命名、`_COOKIE` vs `_ACCOUNTS`、多账号 JSON、`.env` 优先级 |
| `.trellis/spec/qinglong/logging-and-notify.md` | `cron:`/`new Env()` 头格式、日志前缀与脱敏、sendNotify 多路径加载 |
| `.trellis/spec/qinglong/error-handling.md` | 9 个站点错误类、顶层兜底结构、429 预算退避 |
| `.trellis/spec/qinglong/quality-guidelines.md` | 本地唯一可验证项(`node --check` / `py_compile`)、审阅清单 |


### Thinking guides (already populated)

`.trellis/spec/guides/` contains general thinking guides pre-filled with
best practices. Customize only if something clearly doesn't fit this project.

---

## How to fill the spec

### Step 1: Import from existing convention files first (preferred)

Search the repo for existing convention docs. If any exist, read them and
extract the relevant rules into the matching `.trellis/spec/` files —
usually much faster than documenting from scratch.

| File / Directory | Tool |
|------|------|
| `CLAUDE.md` / `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Codex / Claude Code / agent-compatible tools |
| `.cursorrules` | Cursor |
| `.cursor/rules/*.mdc` | Cursor (rules directory) |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline |
| `.roomodes` | Roo Code |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.vscode/settings.json` → `github.copilot.chat.codeGeneration.instructions` | VS Code Copilot |
| `CONVENTIONS.md` / `.aider.conf.yml` | aider |
| `CONTRIBUTING.md` | General project conventions |
| `.editorconfig` | Editor formatting rules |

> **本项目实际结果**:仓库内无任何上述约定文档(仅有一个 Trellis 自己生成的 `AGENTS.md`,
> 其中除 TRELLIS 托管块外无项目约定)。因此 spec 完全基于**代码勘察**写成
> (逐脚本提取头部声明、环境变量、错误类、通知与退避实现,并记录真实行号作为证据)。
> `.trellis/spec/guides/` 的通用思考指南保留未改(内容对本项目适用)。

### Step 2: Analyze the codebase for anything not covered by existing docs

Scan real code to discover patterns. Before writing each spec file:
- Find 2-3 real examples of each pattern in the codebase.
- Reference real file paths (not hypothetical ones).
- Document anti-patterns the team clearly avoids.

### Step 3: Document reality, not ideals

**Critical**: write what the code *actually does*, not what it should do.
Sub-agents match the spec, so aspirational patterns that don't exist in the
codebase will cause sub-agents to write code that looks out of place.

If the team has known tech debt, document the current state — improvement
is a separate conversation, not a bootstrap concern.

---

## Quick explainer of the runtime (share when they ask "why do we need spec at all")

- Every AI coding task spawns two sub-agents: `trellis-implement` (writes
  code) and `trellis-check` (verifies quality).
- Each task has `implement.jsonl` / `check.jsonl` manifests listing which
  spec files to load.
- The platform hook auto-injects those spec files + the task's `prd.md`
  into every sub-agent prompt, so the sub-agent codes/reviews per team
  conventions without anyone pasting them manually.
- Source of truth: `.trellis/spec/`. That's why filling it well now pays
  off forever.

---

## Completion

When the developer confirms the checklist items above are done with real
examples (not placeholders), guide them to run:

```bash
python ./.trellis/scripts/task.py finish
python ./.trellis/scripts/task.py archive 00-bootstrap-guidelines
```

After archive, every new developer who joins this project will get a
`00-join-<slug>` onboarding task instead of this bootstrap task.

---

## Suggested opening line

"Welcome to Trellis! Your init just set me up to help you fill the project
spec — a one-time setup so every future AI session follows the team's
conventions instead of writing generic code. Before we start, do you have
any existing convention docs (CLAUDE.md, .cursorrules, CONTRIBUTING.md,
etc.) I can pull from, or should I scan the codebase from scratch?"

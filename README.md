# 🤖 FFC Autonomous AI Developer Agents (`FFC-IN-google_antigravity_agents`)

Welcome to the **FreeForCharity (FFC) Autonomous Developer Agents** codebase. This repository contains the complete suite of highly sophisticated, subscription-backed AI agents running under the Antigravity 2.0 framework. 

Together, these agents form a fully self-healing, closed development loop that operates completely autonomously across **79 personal and organization repositories** (including `clarkemoyer`, `FreeForCharity`, and `koenig-childhood-cancer-foundation`).

---

## 🌟 High-Level System Architecture

```
                    ┌──────────────────────────────┐
                    │  Community GitHub Ecosystem  │
                    └──────────────┬───────────────┘
                                   │
                   Scan Diffs &    │    Code Edits &
                   PR Review       │    Draft PRs
                                   ▼
                    ┌──────────────────────────────┐
                    │    Autonomous Dev Loop       │
                    │                              │
                    │   ┌──────────────────────┐   │
                    │   │  PR Reviewer Agent   │   │
                    │   └──────────────────────┘   │
                    │   ┌──────────────────────┐   │
                    │   │  Issue Coder Agent   │   │
                    │   └──────────────────────┘   │
                    └──────────────┬───────────────┘
                                   │ Injects Compiled
                                   │ State Metrics
                                   ▼
                    ┌──────────────────────────────┐
                    │ Glassmorphic HTML Dashboard  │
                    └──────────────────────────────┘
```

---

## 🛡️ Core Capabilities & Safety Guardrails

* **Smart Bot & Agent Filtering**: Completely filters out automated bot contributions (such as `@dependabot` PRs, CI dependencies, `@Copilot` drafts, and `@cbmagent` helpers) to conserve AI Max/Joules quotas.
* **Oversized Change Protection**: Shields LLM contexts against massive diffs. Diff fetches that exceed `10,000` lines or `500,000` characters are safely skipped with detailed logger feedback.
* **Draft Mode Safety Constraint**: To guarantee absolute safety, all automatically generated pull requests are opened strictly in **Draft Mode** (`--draft`), preventing accidental merges or pipeline triggers before a human review.
* **Glassmorphic Offline Dashboard**: Automatically builds a beautiful, client-side searchable, responsive HTML status dashboard showing all community issues, active branches, PR review statuses, and filtered exclusions.

---

## 📦 Agent Modules Included

### 1. PR Reviewer Agent
* **`src/review_runner.js`**: Scans open PRs across personal and organization scopes, verifies they are not bot-created or overly large, and places valid developer diffs into a `pending_reviews/` directory.
* **`src/post_review.js`**: Posts high-quality, professional code reviews directly back to GitHub using the pre-authenticated local **GitHub CLI (`gh`)** and records comments in `.antigravity/pr_reviewer_state.json` to prevent duplicates.
* **`src/gemini_reviewer.js`**: Tailored runtime script optimized for execution inside a GitHub Action pipeline.

### 2. Autonomous Issue Coder Agent
* **`src/issue_coder.js`**: Standalone zero-dependency Node.js script. When provided a `GEMINI_API_KEY`, it identifies the oldest `🟢 Ready for Work` issue, checks out a clean branch locally, harvests context from relevant files, writes complete fixes, and automatically pushes and launches a Draft PR.
* **`src/issue_coder_agent.js`**: Helper utility that parses the generated HTML dashboard to target the oldest ready community issue, designed for zero-config native subagents.

---

## 🚀 Setup & Execution Guide

### Local Prerequisites
1. **Node.js**: Node 18+ (utilizes built-in `fetch`).
2. **GitHub CLI (`gh`)**: Must be pre-authenticated locally (`gh auth login`).
3. **Git**: Installed and configured.

### Local Commands
Install dependencies (convenience wrapper):
```bash
npm install
```

Scan PRs and generate the dynamic status report & dashboard:
```bash
npm run scan
```

Verify target unaddressed community issues:
```bash
npm run find-target
```

Run the standalone issue coder script (requires `GEMINI_API_KEY`):
```bash
$env:GEMINI_API_KEY="your-api-key"
npm run code-issue
```

---

## ⏰ Background Scheduling Configuration

To achieve completely unattended execution, register these agents as background tasks in your Antigravity scheduler:

### 1. PR Reviewer Cron Job (Hourly)
```javascript
// Schedule: Every hour (0 * * * *)
// Command sequence:
node src/review_runner.js
// If pending diffs exist in pending_reviews/, they are drafted by the agent and posted:
node src/post_review.js <owner> <repo> <pr_number> <updated_at> <temp_file>
```

### 2. Automated Issue Coder Cron Job (Hourly)
```javascript
// Schedule: Every hour (0 * * * *)
// Action flow:
// 1. Run the PR and issue scanner to sync reports
node src/review_runner.js
// 2. Identify oldest "🟢 Ready for Work" issue and spawn native subagent to code it
node src/issue_coder_agent.js
// 3. Subagent checks out repository, applies changes, pushes branch, and submits Draft PR
```

---

## 🌐 Dynamic Local HTML Dashboard

When running `npm run scan`, the system automatically compiles and injects the latest state metrics into:
**`review_status_dashboard.html`**

Open it directly in any web browser to experience a premium, glassmorphic developer surface equipped with:
1. **Interactive State Resolution**: Displays issues categorized as `🟢 Ready for Work` (no branch/PR), `🌿 Active Branch` (branch in progress), or `🔗 Linked to Open PR`.
2. **One-Click Workspace Actions**: Quick clipboard buttons to execute `git checkout -b issue-<number>` or `gh issue checkout <number>` directly in your terminal.
3. **Live Search & Filter**: Instant, zero-latency client-side search by repository, author, or keyword.
4. **Exclusions Inspector**: Collapsible accordions showing detailed metrics on all bot-filtered and too-large PRs.

---

## 🛠️ Deploying as a GitHub Action Workflow

To run the PR reviewer automatically on every pull request, copy `.github/workflows/gemini-reviewer.yml` into your target repository and add your Gemini API Key as a repository secret:

```yaml
# Configure under target-repo/.github/workflows/gemini-reviewer.yml
name: Gemini PR Reviewer
on:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run Reviewer
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          GEMINI_MODEL: 'gemini-2.5-flash'
        run: node src/gemini_reviewer.js
```

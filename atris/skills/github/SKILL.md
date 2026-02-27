---
name: github
description: GitHub integration via AtrisOS API. Manage PRs, issues, branches, CI status, code review, search. Use when user asks about repos, pull requests, issues, branches, or code changes.
version: 1.0.0
tags:
  - github
  - backend
  - devops
---

# GitHub Agent

> Drop this in `~/.claude/skills/github/SKILL.md` and Claude Code becomes your GitHub assistant.

## Bootstrap (ALWAYS Run First)

```bash
#!/bin/bash
set -e

# 1. Check if atris CLI is installed
if ! command -v atris &> /dev/null; then
  echo "Installing atris CLI..."
  npm install -g atris
fi

# 2. Check if logged in to AtrisOS
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in. Run: atris login"
  exit 1
fi

# 3. Extract token
if command -v node &> /dev/null; then
  TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
elif command -v python3 &> /dev/null; then
  TOKEN=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.atris/credentials.json')))['token'])")
else
  TOKEN=$(jq -r '.token' ~/.atris/credentials.json)
fi

# 4. Check GitHub connection
STATUS=$(curl -s "https://api.atris.ai/api/integrations/github/status" \
  -H "Authorization: Bearer $TOKEN")

CONNECTED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected', False))" 2>/dev/null || echo "false")

if [ "$CONNECTED" != "true" ] && [ "$CONNECTED" != "True" ]; then
  echo "GitHub not connected. Getting authorization URL..."
  AUTH=$(curl -s -X POST "https://api.atris.ai/api/integrations/github/start" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"return_url":"https://atris.ai/settings/integrations"}')

  URL=$(echo "$AUTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('auth_url', ''))")

  echo ""
  echo "Open this URL to connect GitHub:"
  echo "$URL"
  echo ""
  echo "After authorizing, run your command again."
  exit 0
fi

echo "Ready. GitHub is connected."
export ATRIS_TOKEN="$TOKEN"
```

---

## Tool Actions

The GitHub tool is available to agents as `github`. All actions accept optional `owner` and `repo` params (defaults to configured repo).

### Repos
| Action | Params | Description |
|--------|--------|-------------|
| `list_repos` | `per_page` | List your accessible repos |
| `get_repo` | `owner`, `repo` | Get repo details |

### Pull Requests
| Action | Params | Description |
|--------|--------|-------------|
| `list_prs` | `state` (open/closed/all), `per_page` | List PRs |
| `get_pr` | `pr_number` | Get PR details + merge status |
| `create_pr` | `title`, `head`, `base`, `body` | Open a PR |
| `list_pr_files` | `pr_number` | Files changed in PR |
| `list_pr_reviews` | `pr_number` | Reviews on PR |
| `create_pr_review` | `pr_number`, `body`, `event` | Add review (APPROVE/REQUEST_CHANGES/COMMENT) |
| `create_pr_comment` | `pr_number`, `body` | Comment on PR |
| `merge_pr` | `pr_number`, `merge_method` | Merge PR (squash/merge/rebase) |

### Issues
| Action | Params | Description |
|--------|--------|-------------|
| `list_issues` | `state`, `labels`, `per_page` | List issues |
| `get_issue` | `issue_number` | Get issue details |
| `create_issue` | `title`, `body`, `labels` | Open issue |
| `update_issue` | `issue_number`, `title`/`body`/`state`/`labels` | Update issue |
| `list_issue_comments` | `issue_number` | Get issue comments |
| `create_issue_comment` | `issue_number`, `body` | Comment on issue |
| `add_labels` | `issue_number`/`pr_number`, `labels` | Add labels |

### Branches
| Action | Params | Description |
|--------|--------|-------------|
| `list_branches` | `per_page` | List branches |
| `create_branch` | `branch`, `from_ref` | Create branch from ref |
| `delete_branch` | `branch` | Delete branch |

### Commits
| Action | Params | Description |
|--------|--------|-------------|
| `list_commits` | `sha`/`branch`, `per_page` | Recent commits |
| `get_commit` | `ref` | Commit details |
| `compare_commits` | `base`, `head` | Diff between refs |

### CI / Checks
| Action | Params | Description |
|--------|--------|-------------|
| `get_combined_status` | `ref`/`branch` | CI status for ref |
| `list_check_runs` | `ref`/`branch` | Check runs (Actions) |

### Search
| Action | Params | Description |
|--------|--------|-------------|
| `search_issues` | `query` | Search issues/PRs across repos |
| `search_code` | `query` | Search code across repos |

### Files
| Action | Params | Description |
|--------|--------|-------------|
| `list_contents` | `path` | List directory |
| `get_file` | `path`, `ref` | Read file (returns decoded_content) |
| `put_file` | `path`, `message`, `content`, `sha`, `branch` | Create/update file |

---

## Workflows

### "Check open PRs"
1. Bootstrap
2. `list_prs` with `state=open`
3. For each PR: `get_combined_status` with the PR's head ref
4. Display: title, author, CI status, review count, age

### "Review a PR"
1. `get_pr` with `pr_number`
2. `list_pr_files` to see what changed
3. `get_file` on key changed files to read content
4. `create_pr_review` with body and event (APPROVE/REQUEST_CHANGES/COMMENT)

### "Triage new issues"
1. `list_issues` with `state=open`
2. For each: inspect title/body for keywords
3. `add_labels` based on content (bug, feature, docs)
4. `create_issue_comment` acknowledging triage

### "Clean merged branches"
1. `list_branches` to see all branches
2. `list_prs` with `state=closed` to find merged PRs
3. For branches with merged PRs (not main/master/develop): `delete_branch`

### "Get CI status"
1. `get_combined_status` with `ref=main` for overall status
2. `list_check_runs` for individual check details

### "Weekly repo report"
1. `list_prs` with `state=all` + filter by date
2. `list_issues` with `state=all` + filter by date
3. `list_commits` for recent activity
4. Summarize: PRs merged, issues opened/closed, top contributors

---

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| `GitHub not connected` | No OAuth token | Run bootstrap |
| `GitHub API error (401)` | Token expired | Reconnect GitHub in settings |
| `GitHub API error (403)` | Rate limited or no permission | Wait or check repo access |
| `GitHub API error (404)` | Repo/resource not found | Check owner/repo/number |
| `GitHub API error (422)` | Invalid request | Check required params |
| `No repo specified` | No default repo configured | Set default in Settings > Integrations > GitHub |

---

## Quick Reference

```bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# Check connection
curl -s "https://api.atris.ai/api/integrations/github/status" -H "Authorization: Bearer $TOKEN"

# List repos
curl -s "https://api.atris.ai/api/integrations/github/repos" -H "Authorization: Bearer $TOKEN"

# Configure default repo
curl -s -X PUT "https://api.atris.ai/api/integrations/github/config" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"owner":"atrislabs","repo":"atrisos-backend","default_branch":"master"}'

# Disconnect
curl -s -X DELETE "https://api.atris.ai/api/integrations/github" -H "Authorization: Bearer $TOKEN"
```

/**
 * Auto PR Scanner & Issue Tracker Dashboard Generator (Zero-Config)
 * Programmatically leverages the pre-authenticated 'gh' CLI and GITHUB_PERSONAL_ACCESS_TOKEN
 * to dynamically scan all personal and organization repositories, tracking open user-generated
 * issues and PRs (non-clarkemoyer, non-bot) and generating a beautiful Markdown status dashboard.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATE_PATH = path.join(__dirname, '..', '.antigravity', 'pr_reviewer_state.json');
const PENDING_DIR = path.join(__dirname, 'pending_reviews');
const REPORT_PATH = path.join(__dirname, 'review_status_report.md');
const HTML_REPORT_PATH = path.join(__dirname, 'review_status_dashboard.html');

// Ensure directories exist
const agyDir = path.dirname(STATE_PATH);
if (!fs.existsSync(agyDir)) {
  fs.mkdirSync(agyDir, { recursive: true });
}

if (!fs.existsSync(PENDING_DIR)) {
  fs.mkdirSync(PENDING_DIR, { recursive: true });
}

function run() {
  console.log('🤖 Starting Dynamic Zero-Config PR & Issue Tracker Scanner...');

  // 1. Read existing state
  let state = { reviewed_prs: {} };
  if (fs.existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      console.warn('⚠️ Could not parse existing state file. Re-initializing state.');
    }
  }

  if (!state.reviewed_prs) {
    state.reviewed_prs = {};
  }

  // Clear previous pending reviews
  fs.readdirSync(PENDING_DIR).forEach(file => {
    fs.unlinkSync(path.join(PENDING_DIR, file));
  });

  // Initialize status metrics & lists
  const startTime = new Date();
  const summary = {
    totalPRsScanned: 0,
    botPRsSkipped: 0,
    alreadyReviewedPRs: 0,
    largeDiffPRsSkipped: 0,
    emptyDiffPRsSkipped: 0,
    pendingPRsQueued: 0,
    queuedPRsYour: [],
    queuedPRsCommunity: [],
    skippedPRsDetails: [],
    communityIssues: [],
    communityPRs: [] // Track all open user-generated PRs (non-clarkemoyer, non-bot)
  };

  // 2. Query all open PRs owned by clarkemoyer, FreeForCharity, and koenig-childhood-cancer-foundation
  console.log('📡 Fetching open PRs across all repositories (personal & orgs) using local gh CLI...');
  let prsJson = [];
  try {
    const rawOutput = execSync(
      'gh search prs --state=open --owner=clarkemoyer --owner=FreeForCharity --owner=koenig-childhood-cancer-foundation --limit 500 --json repository,number,title,body,url,updatedAt,author',
      { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
    );
    prsJson = JSON.parse(rawOutput);
  } catch (error) {
    console.error('❌ Error executing gh search prs CLI command:', error.message);
    process.exit(1);
  }

  summary.totalPRsScanned = prsJson ? prsJson.length : 0;

  console.log(`🔍 Found ${summary.totalPRsScanned} open pull requests total. Checking filtering rules...`);

  // 3. Process and filter PRs
  if (prsJson && prsJson.length > 0) {
    for (const pr of prsJson) {
      const repoWithOwner = pr.repository.nameWithOwner;
      const prNumber = pr.number;
      const prKey = `${repoWithOwner}#${prNumber}`;
      const authorLogin = pr.author?.login || 'unknown';

      // Determine if this is a community-generated PR (non-clarkemoyer, non-bot)
      const isBot =
        authorLogin.toLowerCase().includes('dependabot') ||
        authorLogin.toLowerCase().includes('copilot') ||
        authorLogin.toLowerCase().includes('copiliot') ||
        authorLogin.toLowerCase().includes('cbmagent') ||
        authorLogin.toLowerCase().includes('github-actions') ||
        authorLogin.toLowerCase().endsWith('[bot]') ||
        pr.title.toLowerCase().startsWith('ci(deps)') ||
        pr.title.toLowerCase().startsWith('npm(deps)') ||
        pr.title.toLowerCase().startsWith('chore(deps)');
      
      const isCommunity = !isBot && authorLogin.toLowerCase() !== 'clarkemoyer';

      // RULE 1: Skip bot PRs (e.g. dependabot, renovate, actions)
      if (isBot) {
        summary.botPRsSkipped++;
        summary.skippedPRsDetails.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: '🤖 Skipped (Bot)',
          reason: 'Automated dependency or system bot pull request.',
          sizeInfo: '-'
        });
        continue;
      }

      const lastReviewedUpdatedAt = state.reviewed_prs[prKey];

      // RULE 2: Skip already-reviewed unchanged PRs
      if (lastReviewedUpdatedAt === pr.updatedAt) {
        summary.alreadyReviewedPRs++;
        summary.skippedPRsDetails.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: '✅ Up-to-Date',
          reason: `Already reviewed up to commit timestamp: ${pr.updatedAt}`,
          sizeInfo: '-'
        });
        if (isCommunity) {
          summary.communityPRs.push({
            key: prKey,
            title: pr.title,
            author: authorLogin,
            url: pr.url,
            status: '✅ Reviewed',
            reason: `Already reviewed up to: ${pr.updatedAt}`,
            sizeInfo: '-'
          });
        }
        continue;
      }

      console.log(`   ✨ New/updated developer PR detected: ${prKey} (Author: @${authorLogin})`);

      // Fetch the diff using gh CLI
      let diff;
      try {
        diff = execSync(
          `gh pr diff ${prNumber} -R ${repoWithOwner}`,
          { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }
        );
      } catch (diffError) {
        console.error(`      ⚠️ Failed to fetch diff for ${prKey}. This is likely a massive, binary, or restricted diff exceeding limits (e.g. HTTP 406):`);
        summary.largeDiffPRsSkipped++;
        summary.skippedPRsDetails.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: '⚠️ Skipped (Large/Failed)',
          reason: 'Failed to fetch diff (likely exceeds GitHub 20,000 line limit, or contains compiled/binary artifacts)',
          sizeInfo: 'N/A'
        });
        if (isCommunity) {
          summary.communityPRs.push({
            key: prKey,
            title: pr.title,
            author: authorLogin,
            url: pr.url,
            status: '⚠️ Large/Failed',
            reason: 'Failed to fetch diff (exceeds size limit or binary)',
            sizeInfo: 'N/A'
          });
        }
        continue;
      }

      if (!diff || diff.trim() === '') {
        summary.emptyDiffPRsSkipped++;
        summary.skippedPRsDetails.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: 'ℹ️ Skipped (Empty)',
          reason: 'Pull request has no code diff content (metadata changes only)',
          sizeInfo: '0 lines'
        });
        if (isCommunity) {
          summary.communityPRs.push({
            key: prKey,
            title: pr.title,
            author: authorLogin,
            url: pr.url,
            status: 'ℹ️ Empty',
            reason: 'Pull request has no code diff content',
            sizeInfo: '0 lines'
          });
        }
        continue;
      }

      // Protection against giant files, compiled/binary artifacts, or massive diffs exceeding AI context limit
      const lineCount = diff.split('\n').length;
      const charCount = diff.length;
      const MAX_LINES = 10000;
      const MAX_CHARS = 500000;
      const sizeString = `${lineCount.toLocaleString()} lines, ${(charCount / 1024).toFixed(1)} KB`;

      if (lineCount > MAX_LINES || charCount > MAX_CHARS) {
        console.log(`      ⚠️ Skipping overly large PR: ${prKey} (${sizeString}). Exceeds context boundaries.`);
        summary.largeDiffPRsSkipped++;
        summary.skippedPRsDetails.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: '⚠️ Skipped (Too Large)',
          reason: `Exceeds context boundaries (${lineCount.toLocaleString()} lines / ${MAX_LINES.toLocaleString()} max)`,
          sizeInfo: sizeString
        });
        if (isCommunity) {
          summary.communityPRs.push({
            key: prKey,
            title: pr.title,
            author: authorLogin,
            url: pr.url,
            status: '⚠️ Too Large',
            reason: `Exceeds context boundaries (${lineCount.toLocaleString()} lines)`,
            sizeInfo: sizeString
          });
        }
        continue;
      }

      // Save details to the pending directory for the agent to review
      const safeFilename = repoWithOwner.replace('/', '_') + `_pr_${prNumber}.json`;
      const pendingFile = path.join(PENDING_DIR, safeFilename);

      fs.writeFileSync(pendingFile, JSON.stringify({
        owner: repoWithOwner.split('/')[0],
        repo: repoWithOwner.split('/')[1],
        repoWithOwner,
        number: prNumber,
        title: pr.title,
        body: pr.body || '',
        url: pr.url,
        updatedAt: pr.updatedAt,
        diff: diff
      }, null, 2));

      summary.pendingPRsQueued++;
      
      const queuedPR = {
        key: prKey,
        title: pr.title,
        author: authorLogin,
        url: pr.url,
        status: '🔥 Queued for Review',
        reason: 'Awaiting local agent context analysis cycle.',
        sizeInfo: sizeString
      };

      // Separate clarkemoyer PRs from community-generated PRs
      if (authorLogin.toLowerCase() === 'clarkemoyer') {
        summary.queuedPRsYour.push(queuedPR);
      } else {
        summary.queuedPRsCommunity.push(queuedPR);
        summary.communityPRs.push({
          key: prKey,
          title: pr.title,
          author: authorLogin,
          url: pr.url,
          status: '🔥 Pending Review',
          reason: 'Awaiting local agent context analysis cycle.',
          sizeInfo: sizeString
        });
      }
    }
  }

  // 4. Query all open issues across clarkemoyer, FreeForCharity, and koenig-childhood-cancer-foundation
  console.log('📡 Fetching open Issues across all repositories (personal & orgs) using local gh CLI...');
  let issuesJson = [];
  try {
    const rawIssues = execSync(
      'gh search issues "type:issue" --state=open --owner=clarkemoyer --owner=FreeForCharity --owner=koenig-childhood-cancer-foundation --limit 500 --json repository,number,title,body,url,updatedAt,author',
      { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
    );
    issuesJson = JSON.parse(rawIssues);
  } catch (error) {
    console.error('⚠️ Warning: Failed to execute gh search issues CLI command:', error.message);
  }

  const repoBranchesCache = {};
  const openPRNumbersMap = {};

  // Build a fast lookup of open PR numbers for each repo to verify linked PR states
  if (prsJson && prsJson.length > 0) {
    for (const pr of prsJson) {
      const repo = pr.repository.nameWithOwner;
      if (!openPRNumbersMap[repo]) {
        openPRNumbersMap[repo] = new Set();
      }
      openPRNumbersMap[repo].add(pr.number);
    }
  }

  // Filter issues for user-generated (non-clarkemoyer, non-bot) and resolve link status
  if (issuesJson && issuesJson.length > 0) {
    // First, filter the issues to get only community ones so we can report progress accurately
    const rawCommunityIssues = issuesJson.filter(issue => {
      const authorLogin = issue.author?.login || 'unknown';
      if (authorLogin.toLowerCase() === 'clarkemoyer') return false;
      if (
        authorLogin.toLowerCase().includes('dependabot') ||
        authorLogin.toLowerCase().includes('copilot') ||
        authorLogin.toLowerCase().includes('copiliot') ||
        authorLogin.toLowerCase().includes('cbmagent') ||
        authorLogin.toLowerCase().includes('github-actions') ||
        authorLogin.toLowerCase().endsWith('[bot]')
      ) return false;
      return true;
    });

    console.log(`🔍 Resolving branch and PR connection states for ${rawCommunityIssues.length} community-generated issues...`);
    
    for (let i = 0; i < rawCommunityIssues.length; i++) {
      const issue = rawCommunityIssues[i];
      const authorLogin = issue.author?.login || 'unknown';
      const repoWithOwner = issue.repository.nameWithOwner;
      const issueNumber = issue.number;
      const issueKey = `${repoWithOwner}#${issueNumber}`;

      console.log(`   🔗 [${i + 1}/${rawCommunityIssues.length}] Querying references for: ${issueKey}...`);
      let linkStatus = '🟢 Unaddressed (Ready for Work)';
      let linkedPRUrl = null;
      let activeBranchName = null;

      try {
        const rawIssueView = execSync(
          `gh issue view ${issueNumber} -R ${repoWithOwner} --json closedByPullRequestsReferences`,
          { encoding: 'utf8' }
        );
        const issueViewData = JSON.parse(rawIssueView);
        const refs = issueViewData.closedByPullRequestsReferences || [];
        
        const openPRNumbers = openPRNumbersMap[repoWithOwner] || new Set();
        const openLinkedPR = refs.find(ref => ref.state === 'OPEN' || openPRNumbers.has(ref.number));
        
        if (openLinkedPR) {
          linkStatus = '🔗 Linked to Open PR';
          linkedPRUrl = openLinkedPR.url;
        } else {
          // Check if an active developer branch matching this issue exists
          if (!repoBranchesCache[repoWithOwner]) {
            console.log(`      🌿 Fetching active branches for ${repoWithOwner} to search for matches...`);
            try {
              const branchesRaw = execSync(
                `gh api repos/${repoWithOwner}/branches?per_page=100`,
                { encoding: 'utf8' }
              );
              repoBranchesCache[repoWithOwner] = JSON.parse(branchesRaw);
            } catch (branchError) {
              console.warn(`      ⚠️ Failed to fetch branches for ${repoWithOwner}:`, branchError.message);
              repoBranchesCache[repoWithOwner] = [];
            }
          }

          const branches = repoBranchesCache[repoWithOwner];
          const branchRegex = new RegExp('(^|[^0-9])' + issueNumber + '($|[^0-9])');
          const matchingBranch = branches.find(b => branchRegex.test(b.name));
          
          if (matchingBranch) {
            linkStatus = '🌿 Active Branch Exists';
            activeBranchName = matchingBranch.name;
          }
        }
      } catch (err) {
        console.warn(`      ⚠️ Failed to query references for issue ${issueKey}:`, err.message);
      }

      summary.communityIssues.push({
        key: issueKey,
        number: issueNumber,
        repo: repoWithOwner,
        title: issue.title,
        author: authorLogin,
        url: issue.url,
        updatedAt: issue.updatedAt,
        linkStatus,
        linkedPRUrl,
        activeBranchName
      });
    }
  }

  // 5. Generate visual dashboard markdown and HTML reports
  generateReport(summary, startTime);
  generateHTMLReport(summary, startTime);

  console.log(`\n🎉 Scan complete.`);
  console.log(`🔥 Queued PRs: ${summary.queuedPRsYour.length} (Yours), ${summary.queuedPRsCommunity.length} (Community)`);
  console.log(`👥 Community Issues Identified: ${summary.communityIssues.length}`);
  console.log(`📊 Comprehensive markdown report written to: ${REPORT_PATH}`);
  console.log(`🌐 Premium dynamic HTML Dashboard written to: ${HTML_REPORT_PATH}`);
}

function generateReport(summary, startTime) {
  const endTime = new Date();
  const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);

  // Group skipped PRs by status for cleaner display
  const skippedLarge = summary.skippedPRsDetails.filter(d => d.status.includes('Large'));
  const skippedUpToDate = summary.skippedPRsDetails.filter(d => d.status.includes('Up-to-Date'));
  const skippedBot = summary.skippedPRsDetails.filter(d => d.status.includes('Bot'));
  const skippedEmpty = summary.skippedPRsDetails.filter(d => d.status.includes('Empty'));

  const markdown = `# 📊 Pull Request & Issue Tracker: Status Dashboard

This dashboard is automatically re-generated after every review scanner pipeline execution. It tracks accessible repositories, bot filtering exclusions, and separates community-generated contributions from your own work.

> [!NOTE]
> **Job Info**
> - **Execution Timestamp**: \`${startTime.toLocaleString()}\`
> - **Duration**: \`${elapsedSeconds} seconds\`
> - **Scheduling Interval**: Hourly Background Cron

---

## 📈 Pipeline Scan Metrics

### Pull Request Metrics
| Metric Category | Count | Description / Action |
| :--- | :---: | :--- |
| **Total Open PRs Scanned** | **${summary.totalPRsScanned}** | Open PRs fetched across personal & organization scopes |
| **💻 Your PRs Pending Review** | **${summary.queuedPRsYour.length}** | Open PRs created by you awaiting code review |
| **👥 Total Open User-Generated PRs** | **${summary.communityPRs.length}** | Total open PRs submitted by other contributors (non-clarkemoyer, non-bot) |
| **🔥 User-Generated PRs Pending Review** | **${summary.queuedPRsCommunity.length}** | User-generated PRs awaiting active code review |
| **🤖 Bot/Dependabot Exclusions** | **${summary.botPRsSkipped}** | Automated PRs automatically skipped to save subscription Joules |
| **✅ Up-to-Date Exclusions** | **${summary.alreadyReviewedPRs}** | Already reviewed and unchanged since last analysis |
| **⚠️ Overly Large Diff Exclusions** | **${summary.largeDiffPRsSkipped}** | Diffs exceeding GitHub boundaries or context limits (>10k lines) |
| **ℹ️ Empty Diff Exclusions** | **${summary.emptyDiffPRsSkipped}** | Metadata-only or empty PRs requiring no code changes |

### Issue & Community Metrics
| Metric Category | Count | Description / Action |
| :--- | :---: | :--- |
| **👥 Community Generated Issues** | **${summary.communityIssues.length}** | Open issues created by other contributors (non-clarkemoyer, non-bot) |

---

## 👥 Open User-Generated Pull Requests (${summary.communityPRs.length})
These are all active open pull requests submitted by other contributors, categorized by their current review status.

${
  summary.communityPRs.length === 0
    ? '*🎉 No open user-generated pull requests currently!*'
    : `| Pull Request | Title | Author | Diff Size | Status | Details / Reason |
| :--- | :--- | :---: | :---: | :---: | :--- |
` + summary.communityPRs.map(c => `| [${c.key}](${c.url}) | ${c.title} | **@${c.author}** | \`${c.sizeInfo}\` | ${c.status} | ${c.reason} |`).join('\n')
}

---

## 👥 Community / User-Generated Open Issues (${summary.communityIssues.length})
These are active open issues opened by external users and contributors.

${
  summary.communityIssues.length === 0
    ? '*🎉 No active community-generated issues!*'
    : `| Issue / Ticket | Title | Author | Last Updated |
| :--- | :--- | :---: | :--- |
` + summary.communityIssues.map(i => `| [${i.key}](${i.url}) | ${i.title} | **@${i.author}** | \`${new Date(i.updatedAt).toLocaleDateString()}\` |`).join('\n')
}

---

## 💻 Your Pull Requests Pending Review (${summary.queuedPRsYour.length})
These are your open pull requests tracked by the automated review engine.

${
  summary.queuedPRsYour.length === 0
    ? '*No personal pull requests awaiting review.*'
    : `| Pull Request | Title | Diff Size |
| :--- | :--- | :---: |
` + summary.queuedPRsYour.map(q => `| [${q.key}](${q.url}) | ${q.title} | \`${q.sizeInfo}\` |`).join('\n')
}

---

## ⚠️ Overly Large / Restricted Exclusions (${skippedLarge.length})
These PRs exceed GitHub's size boundaries (20,000+ lines, seen in cases like #1613), contain massive compiled/binary assets, or exceed AI context limits (>10,000 lines).

${
  skippedLarge.length === 0
    ? '*No overly large PRs detected in this scan.*'
    : `| Pull Request | Title | Author | Recorded Size | Exclusion Reason |
| :--- | :--- | :---: | :---: | :--- |
` + skippedLarge.map(s => `| [${s.key}](${s.url}) | ${s.title} | **@${s.author}** | \`${s.sizeInfo}\` | ${s.reason} |`).join('\n')
}

---

## 🤖 Automated Bot / Dependency Exclusions (${skippedBot.length})
These automated PRs (Dependabot, Renovate, auto-deps) were filtered out to avoid consumption of subscription Joules.

<details>
<summary><b>Click to expand bot exclusions (${skippedBot.length})</b></summary>

| Pull Request | Title | Author | Exclusion Reason |
| :--- | :--- | :---: | :--- |
${skippedBot.map(s => `| [${s.key}](${s.url}) | ${s.title} | **@${s.author}** | ${s.reason} |`).join('\n')}

</details>

---

## ✅ Up-to-Date PRs (Unchanged) (${skippedUpToDate.length})
These PRs have already been reviewed and have had no new commits or changes since the last review.

<details>
<summary><b>Click to expand up-to-date exclusions (${skippedUpToDate.length})</b></summary>

| Pull Request | Title | Last Analyzed Timestamp |
| :--- | :--- | :--- |
${skippedUpToDate.map(s => `| [${s.key}](${s.url}) | ${s.title} | \`${s.reason.split(': ')[1] || '-'}\` |`).join('\n')}

</details>

---

*Dashboard managed by Antigravity under your AI Max / Joules plan.*
`;

  fs.writeFileSync(REPORT_PATH, markdown);
}

function generateHTMLReport(summary, startTime) {
  const endTime = new Date();
  const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(1);
  const totalIssues = summary.communityIssues.length;
  const unaddressedIssuesCount = summary.communityIssues.filter(i => i.linkStatus.includes('Unaddressed')).length;
  const linkedIssuesCount = summary.communityIssues.filter(i => i.linkStatus.includes('Linked')).length;
  const branchIssuesCount = summary.communityIssues.filter(i => i.linkStatus.includes('Branch')).length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title> E-Reviewer Ecosystem Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-color: #0b0f19;
      --card-bg: rgba(20, 27, 45, 0.65);
      --card-border: rgba(255, 255, 255, 0.07);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --text-muted: #6b7280;
      
      --accent-color: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.15);
      
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.15);
      
      --warning: #f59e0b;
      --warning-glow: rgba(245, 158, 11, 0.15);
      
      --danger: #ef4444;
      --danger-glow: rgba(239, 68, 68, 0.15);
      
      --info: #0ea5e9;
      --info-glow: rgba(14, 165, 233, 0.15);
      
      --font-body: 'Inter', sans-serif;
      --font-display: 'Outfit', sans-serif;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--text-primary);
      font-family: var(--font-body);
      min-height: 100vh;
      line-height: 1.5;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.06) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.05) 0%, transparent 40%);
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2.5rem 2rem;
    }

    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 1.5rem;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }

    .brand-logo {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, var(--accent-color), var(--info));
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 1.35rem;
      color: #fff;
      box-shadow: 0 0 20px rgba(59, 130, 246, 0.35);
    }

    .brand-title h1 {
      font-family: var(--font-display);
      font-size: 1.6rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      background: linear-gradient(to right, #fff, #9ca3af);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand-title p {
      font-size: 0.85rem;
      color: var(--text-secondary);
      margin-top: 0.1rem;
    }

    .metadata-badge {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 0.6rem 1.2rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 0.65rem;
      backdrop-filter: blur(10px);
    }

    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 10px var(--success);
      animation: pulse-animation 2s infinite;
    }

    @keyframes pulse-animation {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2.5rem;
    }

    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 1.5rem;
      backdrop-filter: blur(10px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
    }

    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 4px;
      height: 100%;
      background: var(--accent-color);
      opacity: 0.8;
    }

    .metric-card.success::before { background: var(--success); }
    .metric-card.warning::before { background: var(--warning); }
    .metric-card.info::before { background: var(--info); }
    .metric-card.danger::before { background: var(--danger); }

    .metric-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 24px -10px rgba(0,0,0,0.6);
      border-color: rgba(255,255,255,0.12);
    }

    .metric-label {
      font-size: 0.8rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
      font-weight: 600;
    }

    .metric-value {
      font-family: var(--font-display);
      font-size: 2.25rem;
      font-weight: 700;
      color: #fff;
      line-height: 1.1;
      margin-bottom: 0.25rem;
    }

    .metric-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    /* Tab Controls */
    .tabs-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 0.4rem;
      margin-bottom: 2rem;
      backdrop-filter: blur(10px);
      flex-wrap: wrap;
      gap: 1rem;
    }

    .tabs {
      display: flex;
      gap: 0.35rem;
      flex-wrap: wrap;
    }

    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 0.65rem 1.3rem;
      border-radius: 10px;
      font-family: var(--font-body);
      font-weight: 500;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .tab-btn:hover {
      color: #fff;
      background: rgba(255,255,255,0.03);
    }

    .tab-btn.active {
      color: #fff;
      background: rgba(59, 130, 246, 0.16);
      box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.25);
    }

    /* Filters Panel */
    .filters-box {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      flex-wrap: wrap;
    }

    .search-input {
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid var(--card-border);
      padding: 0.6rem 1rem 0.6rem 2.3rem;
      border-radius: 10px;
      color: #fff;
      font-family: var(--font-body);
      font-size: 0.9rem;
      width: 240px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: 0.75rem center;
      background-size: 1rem;
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px var(--accent-glow);
      width: 320px;
    }

    .select-filter {
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid var(--card-border);
      padding: 0.6rem 2.2rem 0.6rem 1rem;
      border-radius: 10px;
      color: #fff;
      font-family: var(--font-body);
      font-size: 0.9rem;
      cursor: pointer;
      outline: none;
      transition: all 0.2s ease;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: calc(100% - 0.85rem) center;
      background-size: 0.85rem;
    }

    .select-filter:focus {
      border-color: var(--accent-color);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }

    /* Content Switching */
    .tab-content {
      display: none;
      animation: tabFadeIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .tab-content.active {
      display: block;
    }

    @keyframes tabFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      overflow: hidden;
      margin-bottom: 2.5rem;
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.2);
    }

    .panel-header {
      padding: 1.25rem 1.75rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(15, 23, 42, 0.2);
    }

    .panel-title {
      font-family: var(--font-display);
      font-size: 1.2rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }

    .panel-title svg {
      width: 20px;
      height: 20px;
      color: var(--accent-color);
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.9rem;
    }

    th {
      background: rgba(10, 15, 30, 0.45);
      padding: 1rem 1.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--card-border);
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
    }

    td {
      padding: 1.2rem 1.75rem;
      border-bottom: 1px solid var(--card-border);
      vertical-align: middle;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: rgba(255, 255, 255, 0.015);
    }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.75rem;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .badge-success { background: var(--success-glow); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.25); }
    .badge-warning { background: var(--warning-glow); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.25); }
    .badge-info { background: var(--info-glow); color: var(--info); border: 1px solid rgba(14, 165, 233, 0.25); }
    .badge-danger { background: var(--danger-glow); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.25); }
    .badge-neutral { background: rgba(255, 255, 255, 0.04); color: var(--text-secondary); border: 1px solid rgba(255, 255, 255, 0.08); }

    /* Interactive Copy Buttons */
    .action-group {
      display: flex;
      gap: 0.5rem;
    }

    .btn-copy {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--card-border);
      color: var(--text-secondary);
      padding: 0.4rem 0.8rem;
      border-radius: 8px;
      font-size: 0.75rem;
      cursor: pointer;
      font-family: var(--font-body);
      font-weight: 500;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      white-space: nowrap;
    }

    .btn-copy svg {
      width: 13px;
      height: 13px;
      stroke-width: 2;
    }

    .btn-copy:hover {
      background: rgba(255, 255, 255, 0.09);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.2);
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .btn-copy:active {
      transform: scale(0.96);
    }

    /* Links */
    .link-primary {
      color: #fff;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.15s ease;
    }

    .link-primary:hover {
      color: var(--accent-color);
      text-decoration: underline;
    }

    .link-subtext {
      font-size: 0.75rem;
      color: var(--text-muted);
      display: block;
      margin-top: 0.2rem;
    }

    .link-external {
      color: var(--text-secondary);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
    }

    .link-external:hover {
      color: #fff;
    }

    /* Overview Tab Layout */
    .overview-layout {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 2rem;
      margin-bottom: 2rem;
    }

    .overview-text-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 2rem;
      backdrop-filter: blur(10px);
    }

    .overview-text-card h2 {
      font-family: var(--font-display);
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #fff, var(--text-secondary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .overview-text-card p {
      color: var(--text-secondary);
      margin-bottom: 1.25rem;
      font-size: 0.95rem;
      line-height: 1.6;
    }

    .highlight-card {
      background: rgba(59, 130, 246, 0.04);
      border: 1px solid rgba(59, 130, 246, 0.15);
      border-radius: 12px;
      padding: 1.25rem;
      margin-top: 1.5rem;
    }

    .highlight-card h3 {
      font-family: var(--font-display);
      font-size: 1.05rem;
      font-weight: 600;
      color: #fff;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .highlight-card h3 svg {
      width: 18px;
      height: 18px;
      color: var(--accent-color);
    }

    .highlight-card ul {
      list-style-type: none;
      padding-left: 0;
    }

    .highlight-card li {
      color: var(--text-secondary);
      font-size: 0.85rem;
      margin-bottom: 0.4rem;
      padding-left: 1.25rem;
      position: relative;
    }

    .highlight-card li::before {
      content: '✦';
      position: absolute;
      left: 0;
      top: 0;
      color: var(--accent-color);
    }

    /* Accordions */
    .accordion-row {
      border-bottom: 1px solid var(--card-border);
    }

    .accordion-toggle {
      padding: 1.1rem 1.75rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.15s ease;
    }

    .accordion-toggle:hover {
      background: rgba(255,255,255,0.01);
    }

    .accordion-title {
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .accordion-arrow {
      color: var(--text-muted);
      transition: transform 0.2s ease;
    }

    .accordion-content {
      padding: 0 1.75rem 1.5rem 1.75rem;
      display: none;
      background: rgba(15, 23, 42, 0.25);
      border-top: 1px solid rgba(255, 255, 255, 0.02);
    }

    .accordion-row.open .accordion-content {
      display: block;
    }

    .accordion-row.open .accordion-toggle {
      background: rgba(255, 255, 255, 0.015);
    }

    .accordion-row.open .accordion-arrow {
      transform: rotate(180deg);
    }

    /* Toast Notification */
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid var(--success);
      color: #fff;
      padding: 0.8rem 1.5rem;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 500;
      box-shadow: 0 12px 30px rgba(0,0,0,0.6);
      backdrop-filter: blur(12px);
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 0.65rem;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* Scrollbars */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: #0b0f19; }
    ::-webkit-scrollbar-thumb { background: #1f293d; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #2d3b55; }

    /* Empty States */
    .empty-state {
      padding: 4.5rem 2rem;
      text-align: center;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 2.75rem;
      margin-bottom: 0.85rem;
      opacity: 0.4;
      display: block;
    }

    .empty-title {
      font-family: var(--font-display);
      font-size: 1.15rem;
      font-weight: 600;
      color: #fff;
      margin-bottom: 0.35rem;
    }

    .empty-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    footer {
      text-align: center;
      margin-top: 4rem;
      padding-top: 2rem;
      border-top: 1px solid var(--card-border);
      font-size: 0.8rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-logo">💎</div>
        <div class="brand-title">
          <h1>Ecosystem PR & Issue Monitor</h1>
          <p>Zero-Config Scanner Pipeline & Work Planner</p>
        </div>
      </div>
      <div class="metadata-badge">
        <span class="pulse"></span>
        <span>Sync Successful</span>
        <span style="color: var(--card-border);">|</span>
        <span>Last updated: <strong>${startTime.toLocaleString()}</strong></span>
      </div>
    </header>

    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Scanned PRs</div>
        <div class="metric-value">${summary.totalPRsScanned}</div>
        <div class="metric-desc">Fetched across personal & organization scopes</div>
      </div>
      <div class="metric-card success">
        <div class="metric-label">Unaddressed Issues</div>
        <div class="metric-value" style="color: var(--success)">${unaddressedIssuesCount}</div>
        <div class="metric-desc">🟢 Open user tickets ready for work (No PR/Branch)</div>
      </div>
      <div class="metric-card info">
        <div class="metric-label">Community Open PRs</div>
        <div class="metric-value" style="color: var(--info)">${summary.communityPRs.length}</div>
        <div class="metric-desc">Awaiting active code review cycles</div>
      </div>
      <div class="metric-card warning">
        <div class="metric-label">Your Open PRs</div>
        <div class="metric-value" style="color: var(--warning)">${summary.queuedPRsYour.length}</div>
        <div class="metric-desc">Personal PRs tracked in review queue</div>
      </div>
    </div>

    <!-- Navigation & Filters Bar -->
    <div class="tabs-bar">
      <div class="tabs">
        <button class="tab-btn active" data-tab="overview">
          <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
          Overview
        </button>
        <button class="tab-btn" data-tab="community-prs">
          <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
          Community PRs (${summary.queuedPRsCommunity.length} Pending)
        </button>
        <button class="tab-btn" data-tab="community-issues">
          <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
          🟢 Unaddressed Issues (${unaddressedIssuesCount})
        </button>
        <button class="tab-btn" data-tab="personal-prs">
          <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
          Your Personal PRs
        </button>
        <button class="tab-btn" data-tab="exclusions">
          <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
          Exclusions / Skipped
        </button>
      </div>

      <div class="filters-box">
        <input type="text" id="search-bar" class="search-input" placeholder="Search by title, author, key..." />
        
        <select id="repo-filter" class="select-filter">
          <option value="all">All Repositories</option>
        </select>

        <select id="issue-status-filter" class="select-filter" style="display: none;">
          <option value="all">All Issue Statuses</option>
          <option value="unaddressed">🟢 Unaddressed (Ready for Work)</option>
          <option value="branch">🌿 Active Branch Exists</option>
          <option value="linked">🔗 Linked to Open PR</option>
        </select>
      </div>
    </div>

    <!-- Overview Tab Content -->
    <div id="overview-content" class="tab-content active">
      <div class="overview-layout">
        <div class="overview-text-card">
          <h2>⚡ Automated Multi-Org Pipeline Tracker</h2>
          <p>
            Welcome to your <strong>Ecosystem Review Dashboard</strong>. This local tracking system runs automatically as part of your background scheduler. It utilizes your pre-authenticated <strong>GitHub CLI (gh)</strong> and environment credentials to perform local PR review drafts entirely under your <strong>AI Max / Joules plan</strong> with zero extra billing.
          </p>
          <p>
            The dashboard scans all accessible repositories across your personal account and multi-org scopes (<code>clarkemoyer</code>, <code>FreeForCharity</code>, <code>koenig-childhood-cancer-foundation</code>), providing full visibility into what's being actively reviewed, what is skipped to preserve Joules (like Dependabot PRs), and which community issues are waiting for you to jump in and code.
          </p>

          <div class="highlight-card">
            <h3>
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              Smart Issue-Link Tracking Resolution Heuristic
            </h3>
            <p style="font-size: 0.85rem; margin-bottom: 0.75rem; color: var(--text-secondary);">
              To help you start working on community issues immediately, our scanning pipeline runs a high-precision resolution heuristic on all open community tickets:
            </p>
            <ul>
              <li><strong>🔗 Linked to Open PR:</strong> Evaluates if a pull request connected via <code>closedByPullRequestsReferences</code> is open. If found, it marks the ticket as linked to prevent duplicate effort.</li>
              <li><strong>🌿 Active Branch Exists:</strong> Queries the active branch names of the repository (with smart caching). Matches issue IDs using strict isolation (regex matching digit boundaries) to see if a developer is working on a branch (e.g. <code>issue-61</code>, <code>issue-61-domain-workflows</code>).</li>
              <li><strong>🟢 Unaddressed (Ready for Work):</strong> If there is no open PR and no developer branch associated with the issue, it is highlighted as unaddressed. Click-to-copy commands are generated on the fly so you can start working instantly!</li>
            </ul>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 1.5rem;">
          <div class="metric-card" style="background: rgba(16, 185, 129, 0.03);">
            <div class="metric-label" style="color: var(--success)">Issue Status Ratios</div>
            <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem;">
              <div style="display: flex; justify-content: space-between; font-size: 0.85rem;">
                <span>🟢 Ready for Work</span>
                <strong>${unaddressedIssuesCount} (${totalIssues > 0 ? Math.round(unaddressedIssuesCount/totalIssues*100) : 0}%)</strong>
              </div>
              <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden;">
                <div style="width: ${totalIssues > 0 ? unaddressedIssuesCount/totalIssues*100 : 0}%; height: 100%; background: var(--success);"></div>
              </div>

              <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-top: 0.25rem;">
                <span>🌿 Active Branch</span>
                <strong>${branchIssuesCount} (${totalIssues > 0 ? Math.round(branchIssuesCount/totalIssues*100) : 0}%)</strong>
              </div>
              <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden;">
                <div style="width: ${totalIssues > 0 ? branchIssuesCount/totalIssues*100 : 0}%; height: 100%; background: var(--warning);"></div>
              </div>

              <div style="display: flex; justify-content: space-between; font-size: 0.85rem; margin-top: 0.25rem;">
                <span>🔗 Linked to Open PR</span>
                <strong>${linkedIssuesCount} (${totalIssues > 0 ? Math.round(linkedIssuesCount/totalIssues*100) : 0}%)</strong>
              </div>
              <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden;">
                <div style="width: ${totalIssues > 0 ? linkedIssuesCount/totalIssues*100 : 0}%; height: 100%; background: var(--info);"></div>
              </div>
            </div>
          </div>

          <div class="metric-card" style="background: rgba(59, 130, 246, 0.03);">
            <div class="metric-label" style="color: var(--accent-color)">Job Pipeline Stats</div>
            <div style="display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-secondary);">
              <div>⏱️ Elapsed Time: <strong>${elapsedSeconds} seconds</strong></div>
              <div>📅 Execution: <strong>Hourly Background Cron</strong></div>
              <div>🤖 Bot PRs Excluded: <strong>${summary.botPRsSkipped}</strong></div>
              <div>✅ Up-to-Date PRs: <strong>${summary.alreadyReviewedPRs}</strong></div>
              <div>⚠️ Giant Diffs Excluded: <strong>${summary.largeDiffPRsSkipped}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Community PRs Tab -->
    <div id="community-prs-content" class="tab-content">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
            Open User-Generated Pull Requests
          </div>
          <span class="badge badge-neutral" id="community-pr-count">0 items</span>
        </div>
        <table id="community-pr-table">
          <thead>
            <tr>
              <th style="width: 25%">Pull Request</th>
              <th style="width: 35%">Title</th>
              <th style="width: 12%">Author</th>
              <th style="width: 10%">Diff Size</th>
              <th style="width: 18%">Status & Reason</th>
            </tr>
          </thead>
          <tbody id="community-pr-tbody">
            <!-- Dynamic rows -->
          </tbody>
        </table>
        <div id="community-pr-empty" class="empty-state" style="display: none;">
          <span class="empty-icon">🎉</span>
          <div class="empty-title">No community PRs found</div>
          <div class="empty-desc">No community pull requests match your search or filter rules.</div>
        </div>
      </div>
    </div>

    <!-- Community Issues Tab -->
    <div id="community-issues-content" class="tab-content">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
            Community Open Issues & Linked State Tracker
          </div>
          <span class="badge badge-neutral" id="community-issue-count">0 items</span>
        </div>
        <table id="community-issue-table">
          <thead>
            <tr>
              <th style="width: 20%">Issue / Ticket</th>
              <th style="width: 35%">Title</th>
              <th style="width: 10%">Author</th>
              <th style="width: 12%">Last Updated</th>
              <th style="width: 23%">Link Status / Developer Workspace Action</th>
            </tr>
          </thead>
          <tbody id="community-issue-tbody">
            <!-- Dynamic rows -->
          </tbody>
        </table>
        <div id="community-issue-empty" class="empty-state" style="display: none;">
          <span class="empty-icon">🟢</span>
          <div class="empty-title">No matching issues found</div>
          <div class="empty-desc">Try clearing your filters or search criteria.</div>
        </div>
      </div>
    </div>

    <!-- Personal PRs Tab -->
    <div id="personal-prs-content" class="tab-content">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
            Your Personal Open Pull Requests Awaiting Review
          </div>
          <span class="badge badge-neutral" id="personal-pr-count">0 items</span>
        </div>
        <table id="personal-pr-table">
          <thead>
            <tr>
              <th style="width: 30%">Pull Request</th>
              <th style="width: 50%">Title</th>
              <th style="width: 20%">Diff Size Info</th>
            </tr>
          </thead>
          <tbody id="personal-pr-tbody">
            <!-- Dynamic rows -->
          </tbody>
        </table>
        <div id="personal-pr-empty" class="empty-state" style="display: none;">
          <span class="empty-icon">☕</span>
          <div class="empty-title">All clear!</div>
          <div class="empty-desc">No personal pull requests are currently in the scanner queue.</div>
        </div>
      </div>
    </div>

    <!-- Exclusions Tab -->
    <div id="exclusions-content" class="tab-content">
      <!-- Accordions of Exclusions -->
      <div class="panel" style="background: transparent; border: none; box-shadow: none;">
        <div style="display: flex; flex-direction: column; gap: 1rem;">
          
          <!-- Large Diff Exclusions -->
          <div class="accordion-row panel" id="accordion-large">
            <div class="accordion-toggle" onclick="toggleAccordion('accordion-large')">
              <div class="accordion-title">
                <span class="badge badge-danger">⚠️ Overly Large Diff Exclusions (${summary.largeDiffPRsSkipped})</span>
                <span style="font-size: 0.85rem; color: var(--text-secondary);">PRs exceeding context limitations (>10k lines) or binary files</span>
              </div>
              <span class="accordion-arrow">▼</span>
            </div>
            <div class="accordion-content">
              <table id="large-excl-table" style="margin-top: 1rem;">
                <thead>
                  <tr>
                    <th style="width: 30%">Pull Request</th>
                    <th style="width: 40%">Title</th>
                    <th style="width: 15%">Author</th>
                    <th style="width: 15%">Recorded Size</th>
                  </tr>
                </thead>
                <tbody id="large-excl-tbody">
                  <!-- Dynamic -->
                </tbody>
              </table>
            </div>
          </div>

          <!-- Bot Exclusions -->
          <div class="accordion-row panel" id="accordion-bots">
            <div class="accordion-toggle" onclick="toggleAccordion('accordion-bots')">
              <div class="accordion-title">
                <span class="badge badge-info">🤖 Bot / Dependency Exclusions (${summary.botPRsSkipped})</span>
                <span style="font-size: 0.85rem; color: var(--text-secondary);">Automated dependency or bot PRs skipped to conserve plan Joules</span>
              </div>
              <span class="accordion-arrow">▼</span>
            </div>
            <div class="accordion-content">
              <table id="bot-excl-table" style="margin-top: 1rem;">
                <thead>
                  <tr>
                    <th style="width: 30%">Pull Request</th>
                    <th style="width: 50%">Title</th>
                    <th style="width: 20%">Author</th>
                  </tr>
                </thead>
                <tbody id="bot-excl-tbody">
                  <!-- Dynamic -->
                </tbody>
              </table>
            </div>
          </div>

          <!-- Up-to-Date Exclusions -->
          <div class="accordion-row panel" id="accordion-uptodate">
            <div class="accordion-toggle" onclick="toggleAccordion('accordion-uptodate')">
              <div class="accordion-title">
                <span class="badge badge-success">✅ Up-to-Date Exclusions (${summary.alreadyReviewedPRs})</span>
                <span style="font-size: 0.85rem; color: var(--text-secondary);">Previously analyzed pull requests with no new changes</span>
              </div>
              <span class="accordion-arrow">▼</span>
            </div>
            <div class="accordion-content">
              <table id="uptodate-excl-table" style="margin-top: 1rem;">
                <thead>
                  <tr>
                    <th style="width: 40%">Pull Request</th>
                    <th style="width: 60%">Title</th>
                  </tr>
                </thead>
                <tbody id="uptodate-excl-tbody">
                  <!-- Dynamic -->
                </tbody>
              </table>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- Footer -->
    <footer>
      <p>Dashboard generated by <strong>Antigravity 2.0</strong> • Powered by your local pre-authorized environment</p>
    </footer>
  </div>

  <!-- Toast Notification System -->
  <div id="toast" class="toast">
    <svg style="width: 16px; height: 16px; stroke: var(--success); fill: none;" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
    <span id="toast-message">Copied successfully</span>
  </div>

  <!-- Interactive Client-side Scripting -->
  <script>
    const data = ${JSON.stringify(summary)};

    // State Variables
    let activeTab = 'overview';
    let searchQuery = '';
    let repoFilter = 'all';
    let statusFilter = 'all';

    // Page Initialization
    window.addEventListener('DOMContentLoaded', () => {
      populateRepoFilter();
      setupEventListeners();
      renderAll();
    });

    // Populate Repo Filter Dropdown
    function populateRepoFilter() {
      const repoSelect = document.getElementById('repo-filter');
      const repos = new Set();
      
      data.communityPRs.forEach(pr => repos.add(pr.key.split('#')[0]));
      data.communityIssues.forEach(iss => repos.add(iss.repo));
      data.queuedPRsYour.forEach(pr => repos.add(pr.key.split('#')[0]));
      
      Array.from(repos).sort().forEach(repo => {
        const opt = document.createElement('option');
        opt.value = repo;
        opt.textContent = repo;
        repoSelect.appendChild(opt);
      });
    }

    // Bind Event Listeners
    function setupEventListeners() {
      // Tab Switching
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const tab = btn.getAttribute('data-tab');
          switchTab(tab);
        });
      });

      // Search & Dropdown Filters
      document.getElementById('search-bar').addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim();
        renderAll();
      });

      document.getElementById('repo-filter').addEventListener('change', (e) => {
        repoFilter = e.target.value;
        renderAll();
      });

      document.getElementById('issue-status-filter').addEventListener('change', (e) => {
        statusFilter = e.target.value;
        renderAll();
      });
    }

    // Switch active dashboard tabs
    function switchTab(tabId) {
      activeTab = tabId;
      
      // Update Tab Buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.getAttribute('data-tab') === tabId) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      // Update Tab Content Areas
      document.querySelectorAll('.tab-content').forEach(content => {
        if (content.id === \`\${tabId}-content\`) {
          content.classList.add('active');
        } else {
          content.classList.remove('active');
        }
      });

      // Display Status Filter only on Issues Tab
      const statusFilterEl = document.getElementById('issue-status-filter');
      if (tabId === 'community-issues') {
        statusFilterEl.style.display = 'inline-block';
      } else {
        statusFilterEl.style.display = 'none';
      }

      renderAll();
    }

    // Master Render Controller
    function renderAll() {
      if (activeTab === 'community-prs') {
        renderCommunityPRs();
      } else if (activeTab === 'community-issues') {
        renderCommunityIssues();
      } else if (activeTab === 'personal-prs') {
        renderPersonalPRs();
      } else if (activeTab === 'exclusions') {
        renderExclusions();
      }
    }

    // Render Community PRs Tab
    function renderCommunityPRs() {
      const tbody = document.getElementById('community-pr-tbody');
      tbody.innerHTML = '';

      const filtered = data.communityPRs.filter(pr => {
        const repo = pr.key.split('#')[0];
        const matchRepo = (repoFilter === 'all' || repo === repoFilter);
        const matchSearch = !searchQuery || 
          pr.key.toLowerCase().includes(searchQuery) ||
          pr.title.toLowerCase().includes(searchQuery) ||
          pr.author.toLowerCase().includes(searchQuery);
        return matchRepo && matchSearch;
      });

      document.getElementById('community-pr-count').textContent = \`\${filtered.length} items\`;

      if (filtered.length === 0) {
        document.getElementById('community-pr-table').style.display = 'none';
        document.getElementById('community-pr-empty').style.display = 'block';
      } else {
        document.getElementById('community-pr-table').style.display = 'table';
        document.getElementById('community-pr-empty').style.display = 'none';

        filtered.forEach(pr => {
          const tr = document.createElement('tr');
          
          let statusBadgeClass = 'badge-success';
          if (pr.status.includes('Pending')) statusBadgeClass = 'badge-warning';
          if (pr.status.includes('Large') || pr.status.includes('Too Large')) statusBadgeClass = 'badge-danger';
          if (pr.status.includes('Empty')) statusBadgeClass = 'badge-info';

          tr.innerHTML = \`
            <td><a href="\${pr.url}" target="_blank" class="link-primary">\${pr.key}</a></td>
            <td><strong>\${pr.title}</strong></td>
            <td><span style="color: var(--accent-color)">@\${pr.author}</span></td>
            <td><code>\${pr.sizeInfo}</code></td>
            <td>
              <span class="badge \${statusBadgeClass}">\${pr.status}</span>
              <span class="link-subtext">\${pr.reason}</span>
            </td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    // Render Community Issues Tab
    function renderCommunityIssues() {
      const tbody = document.getElementById('community-issue-tbody');
      tbody.innerHTML = '';

      const filtered = data.communityIssues.filter(issue => {
        const matchRepo = (repoFilter === 'all' || issue.repo === repoFilter);
        
        let matchStatus = true;
        if (statusFilter === 'unaddressed') matchStatus = issue.linkStatus.includes('Unaddressed');
        if (statusFilter === 'branch') matchStatus = issue.linkStatus.includes('Branch');
        if (statusFilter === 'linked') matchStatus = issue.linkStatus.includes('Linked');

        const matchSearch = !searchQuery || 
          issue.key.toLowerCase().includes(searchQuery) ||
          issue.title.toLowerCase().includes(searchQuery) ||
          issue.author.toLowerCase().includes(searchQuery);

        return matchRepo && matchStatus && matchSearch;
      });

      document.getElementById('community-issue-count').textContent = \`\${filtered.length} items\`;

      if (filtered.length === 0) {
        document.getElementById('community-issue-table').style.display = 'none';
        document.getElementById('community-issue-empty').style.display = 'block';
      } else {
        document.getElementById('community-issue-table').style.display = 'table';
        document.getElementById('community-issue-empty').style.display = 'none';

        filtered.forEach(iss => {
          const tr = document.createElement('tr');
          
          let statusBadge = '';
          let actionCell = '';

          if (iss.linkStatus.includes('Linked')) {
            statusBadge = \`<span class="badge badge-info">🔗 Linked to Open PR</span>\`;
            actionCell = \`<a href="\${iss.linkedPRUrl}" target="_blank" class="link-primary" style="font-size: 0.8rem;">View Connected PR ↗</a>\`;
          } else if (iss.linkStatus.includes('Branch')) {
            statusBadge = \`
              <span class="badge badge-warning">🌿 Active Branch</span>
              <span class="link-subtext">Branch: <code>\${iss.activeBranchName}</code></span>
            \`;
            actionCell = \`<span style="font-size: 0.8rem; color: var(--text-muted);">Active in workspace</span>\`;
          } else {
            statusBadge = \`<span class="badge badge-success" style="box-shadow: 0 0 10px rgba(16, 185, 129, 0.15)">🟢 Ready for Work</span>\`;
            actionCell = \`
              <div class="action-group">
                <button class="btn-copy" onclick="copyToClipboard('git checkout -b issue-\${iss.number}', this)">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2"/></svg>
                  Checkout Branch
                </button>
                <button class="btn-copy" onclick="copyToClipboard('gh issue checkout \${iss.number}', this)">
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
                  gh checkout
                </button>
              </div>
            \`;
          }

          tr.innerHTML = \`
            <td><a href="\${iss.url}" target="_blank" class="link-primary">\${iss.key}</a></td>
            <td>
              <strong>\${iss.title}</strong>
            </td>
            <td><span style="color: var(--text-secondary)">@\${iss.author}</span></td>
            <td><span style="color: var(--text-muted); font-size: 0.8rem;">\${new Date(iss.updatedAt).toLocaleDateString()}</span></td>
            <td>
              <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                \${statusBadge}
                \${actionCell !== '' ? \`<div style="margin-top: 0.25rem;">\${actionCell}</div>\` : ''}
              </div>
            </td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    // Render Personal PRs Tab
    function renderPersonalPRs() {
      const tbody = document.getElementById('personal-pr-tbody');
      tbody.innerHTML = '';

      const filtered = data.queuedPRsYour.filter(pr => {
        const repo = pr.key.split('#')[0];
        const matchRepo = (repoFilter === 'all' || repo === repoFilter);
        const matchSearch = !searchQuery || 
          pr.key.toLowerCase().includes(searchQuery) ||
          pr.title.toLowerCase().includes(searchQuery);
        return matchRepo && matchSearch;
      });

      document.getElementById('personal-pr-count').textContent = \`\${filtered.length} items\`;

      if (filtered.length === 0) {
        document.getElementById('personal-pr-table').style.display = 'none';
        document.getElementById('personal-pr-empty').style.display = 'block';
      } else {
        document.getElementById('personal-pr-table').style.display = 'table';
        document.getElementById('personal-pr-empty').style.display = 'none';

        filtered.forEach(pr => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><a href="\${pr.url}" target="_blank" class="link-primary">\${pr.key}</a></td>
            <td><strong>\${pr.title}</strong></td>
            <td><code>\${pr.sizeInfo}</code></td>
          \`;
          tbody.appendChild(tr);
        });
      }
    }

    // Render Exclusions Accordions
    function renderExclusions() {
      // 1. Large Diffs
      const largeTbody = document.getElementById('large-excl-tbody');
      largeTbody.innerHTML = '';
      const largeFiltered = data.skippedPRsDetails.filter(s => {
        const repo = s.key.split('#')[0];
        const matchRepo = (repoFilter === 'all' || repo === repoFilter);
        const matchSearch = !searchQuery || s.key.toLowerCase().includes(searchQuery) || s.title.toLowerCase().includes(searchQuery);
        return s.status.includes('Large') && matchRepo && matchSearch;
      });
      document.querySelector('#accordion-large .badge').textContent = \`⚠️ Overly Large Diff Exclusions (\${largeFiltered.length})\`;
      
      if (largeFiltered.length === 0) {
        largeTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No overly large exclusions match current filters.</td></tr>';
      } else {
        largeFiltered.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><a href="\${s.url}" target="_blank" class="link-primary">\${s.key}</a></td>
            <td><strong>\${s.title}</strong><span class="link-subtext">\${s.reason}</span></td>
            <td>@\${s.author}</td>
            <td><code>\${s.sizeInfo}</code></td>
          \`;
          largeTbody.appendChild(tr);
        });
      }

      // 2. Bots
      const botTbody = document.getElementById('bot-excl-tbody');
      botTbody.innerHTML = '';
      const botFiltered = data.skippedPRsDetails.filter(s => {
        const repo = s.key.split('#')[0];
        const matchRepo = (repoFilter === 'all' || repo === repoFilter);
        const matchSearch = !searchQuery || s.key.toLowerCase().includes(searchQuery) || s.title.toLowerCase().includes(searchQuery);
        return s.status.includes('Bot') && matchRepo && matchSearch;
      });
      document.querySelector('#accordion-bots .badge').textContent = \`🤖 Bot / Dependency Exclusions (\${botFiltered.length})\`;

      if (botFiltered.length === 0) {
        botTbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No bot exclusions match current filters.</td></tr>';
      } else {
        botFiltered.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><a href="\${s.url}" target="_blank" class="link-primary">\${s.key}</a></td>
            <td><strong>\${s.title}</strong></td>
            <td>@\${s.author}</td>
          \`;
          botTbody.appendChild(tr);
        });
      }

      // 3. Up to Date
      const uptodateTbody = document.getElementById('uptodate-excl-tbody');
      uptodateTbody.innerHTML = '';
      const uptodateFiltered = data.skippedPRsDetails.filter(s => {
        const repo = s.key.split('#')[0];
        const matchRepo = (repoFilter === 'all' || repo === repoFilter);
        const matchSearch = !searchQuery || s.key.toLowerCase().includes(searchQuery) || s.title.toLowerCase().includes(searchQuery);
        return s.status.includes('Up-to-Date') && matchRepo && matchSearch;
      });
      document.querySelector('#accordion-uptodate .badge').textContent = \`✅ Up-to-Date Exclusions (\${uptodateFiltered.length})\`;

      if (uptodateFiltered.length === 0) {
        uptodateTbody.innerHTML = '<tr><td colspan="2" style="text-align: center; color: var(--text-muted);">No up-to-date exclusions match current filters.</td></tr>';
      } else {
        uptodateFiltered.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><a href="\${s.url}" target="_blank" class="link-primary">\${s.key}</a></td>
            <td><strong>\${s.title}</strong><span class="link-subtext">\${s.reason}</span></td>
          \`;
          uptodateTbody.appendChild(tr);
        });
      }
    }

    // Toggle Accordion State
    function toggleAccordion(id) {
      const el = document.getElementById(id);
      el.classList.toggle('open');
    }

    // Clipboard Copy Helper with Toast Notification
    function copyToClipboard(text, element) {
      navigator.clipboard.writeText(text).then(() => {
        // Show Success Toast
        const toast = document.getElementById('toast');
        document.getElementById('toast-message').textContent = \`Copied: "\${text}"\`;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);

        // Animate Button State
        const originalHtml = element.innerHTML;
        element.innerHTML = \`
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" style="stroke: var(--success);"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
          Copied!
        \`;
        element.style.borderColor = 'var(--success)';
        element.style.color = '#fff';
        
        setTimeout(() => {
          element.innerHTML = originalHtml;
          element.style.borderColor = '';
          element.style.color = '';
        }, 1500);
      }).catch(err => {
        console.error('Failed to copy command: ', err);
      });
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(HTML_REPORT_PATH, html);
}

run();

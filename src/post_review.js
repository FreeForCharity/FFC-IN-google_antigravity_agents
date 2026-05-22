/**
 * PR Review Poster (Zero-Config)
 * Posts the generated code review comment using the local pre-authenticated 'gh' CLI,
 * and updates the local state to mark this PR as reviewed.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STATE_PATH = path.join(__dirname, '..', '.antigravity', 'pr_reviewer_state.json');

function run() {
  const args = process.argv.slice(2);
  if (args.length < 5) {
    console.error('❌ Usage: node post_review.js <owner> <repo> <pr_number> <updated_at_timestamp> <path_to_comment_markdown_file>');
    process.exit(1);
  }

  const [owner, repo, prNumber, updatedAt, commentFilePath] = args;
  const repoWithOwner = `${owner}/${repo}`;
  const prKey = `${repoWithOwner}#${prNumber}`;

  if (!fs.existsSync(commentFilePath)) {
    console.error(`❌ Review comment file not found at: ${commentFilePath}`);
    process.exit(1);
  }

  console.log(`📡 Posting review comment to ${prKey} using local gh CLI...`);

  try {
    // Post the comment to the pull request
    execSync(
      `gh pr comment ${prNumber} -R ${repoWithOwner} -F "${commentFilePath}"`,
      { stdio: 'inherit' }
    );

    console.log('✅ Review comment posted successfully on GitHub.');

    // Update local state to mark this PR/updatedAt as reviewed
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

    state.reviewed_prs[prKey] = updatedAt;

    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log(`📝 Local state updated: ${prKey} marked as reviewed up to ${updatedAt}`);

    // Check if this PR belongs to a README review branch and increment cycle count
    let headBranch = '';
    try {
      const rawPrInfo = execSync(
        `gh pr view ${prNumber} -R ${repoWithOwner} --json headRefName`,
        { encoding: 'utf8' }
      );
      const prInfo = JSON.parse(rawPrInfo);
      headBranch = prInfo.headRefName || '';
    } catch (e) {
      console.warn('⚠️ Could not determine head branch name for PR:', e.message);
    }

    if (headBranch.startsWith('readme-review-')) {
      const README_STATE_PATH = path.join(path.dirname(STATE_PATH), 'readme_agent_state.json');
      let readmeState = { repositories: {} };
      if (fs.existsSync(README_STATE_PATH)) {
        try {
          readmeState = JSON.parse(fs.readFileSync(README_STATE_PATH, 'utf8'));
        } catch (e) {
          console.warn('⚠️ Could not parse existing readme state file.');
        }
      }
      if (!readmeState.repositories) {
        readmeState.repositories = {};
      }
      if (!readmeState.repositories[repoWithOwner]) {
        readmeState.repositories[repoWithOwner] = {
          last_run: new Date().toISOString(),
          pr_number: parseInt(prNumber),
          branch: headBranch,
          cycles: 0,
          applied_cycles: 0
        };
      }
      readmeState.repositories[repoWithOwner].cycles = (readmeState.repositories[repoWithOwner].cycles || 0) + 1;
      readmeState.repositories[repoWithOwner].pr_number = parseInt(prNumber);
      readmeState.repositories[repoWithOwner].branch = headBranch;
      
      fs.writeFileSync(README_STATE_PATH, JSON.stringify(readmeState, null, 2));
      console.log(`📝 README state updated: ${repoWithOwner} cycles incremented to ${readmeState.repositories[repoWithOwner].cycles}`);
    }

  } catch (error) {
    console.error('❌ Error posting review comment:', error.message);
    process.exit(1);
  }
}

run();

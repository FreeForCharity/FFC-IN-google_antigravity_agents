/**
 * Readme Review & Refinement Agent Script
 * Zero-dependency script that audits repository codebases, drafts premium READMEs,
 * and manages an iterative 3-turn review feedback loop with the PR Reviewer Agent.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'; // High-fidelity flash model

if (!GEMINI_API_KEY) {
  console.error('❌ Error: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

// Target organizations / owner scopes
const SCOPES = ['clarkemoyer', 'FreeForCharity', 'koenig-childhood-cancer-foundation'];
const STATE_PATH = path.join('C:\\AntiGravity', '.antigravity', 'readme_agent_state.json');

// Ensure parent dir exists
const stateDir = path.dirname(STATE_PATH);
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

async function run() {
  console.log('🤖 Starting Readme Review & Refinement Coder Agent...');

  // 1. Load existing state
  let state = { repositories: {} };
  if (fs.existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      console.warn('⚠️ Could not parse existing state file. Re-initializing state.');
    }
  }
  if (!state.repositories) {
    state.repositories = {};
  }

  // 2. Fetch all repositories across our scopes using gh CLI
  console.log('📡 Listing organization and personal repositories using local gh CLI...');
  let repositories = [];
  for (const scope of SCOPES) {
    try {
      const rawRepos = execSync(
        `gh repo list ${scope} --limit 100 --json nameWithOwner,name,description,updatedAt`,
        { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
      );
      repositories = repositories.concat(JSON.parse(rawRepos));
    } catch (err) {
      console.error(`⚠️ Failed to list repositories for scope ${scope}:`, err.message);
    }
  }

  console.log(`🔍 Discovered ${repositories.length} total repositories in scopes.`);

  // To save subscription quota, we limit new PR generation to a max of 2 repos per day,
  // but we ALWAYS process active PRs that have pending review comments.
  let newPrsCreatedCount = 0;
  const NEW_PR_LIMIT = 2;

  for (const repo of repositories) {
    const repoWithOwner = repo.nameWithOwner;
    const repoName = repo.name;
    const workspacePath = path.join('C:\\AntiGravity', repoName);

    // Initialize or load repo state
    if (!state.repositories[repoWithOwner]) {
      state.repositories[repoWithOwner] = {
        last_run: null,
        pr_number: null,
        branch: null,
        cycles: 0,
        applied_cycles: 0
      };
    }

    const repoState = state.repositories[repoWithOwner];

    // Determine state scenario
    if (repoState.pr_number) {
      // SCENARIO B: Active PR exists. Check if it's still open
      console.log(`🔗 Repo ${repoWithOwner} has an active README review PR #${repoState.pr_number}. Checking status...`);
      let isPrOpen = false;
      try {
        const rawPrView = execSync(
          `gh pr view ${repoState.pr_number} -R ${repoWithOwner} --json state`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
        const prView = JSON.parse(rawPrView);
        isPrOpen = prView.state === 'OPEN';
      } catch (e) {
        console.warn(`   ⚠️ PR #${repoState.pr_number} view command returned error (likely closed or deleted):`, e.message);
      }

      if (!isPrOpen) {
        console.log(`   PR #${repoState.pr_number} is closed or merged. Resetting active PR state.`);
        repoState.pr_number = null;
        repoState.cycles = 0;
        repoState.applied_cycles = 0;
        // Continue to check if we should start a new cycle
      } else {
        // PR is open. Check if we have new review comments from the PR Reviewer Agent
        console.log(`   PR #${repoState.pr_number} is open. Cycles: ${repoState.cycles}, Applied: ${repoState.applied_cycles}`);
        
        if (repoState.cycles > repoState.applied_cycles) {
          console.log(`🔥 Active review feedback detected (Cycle ${repoState.cycles} vs Applied ${repoState.applied_cycles}). Syncing workspace and applying feedback...`);
          await applyFeedbackAndRefine(repoWithOwner, repoName, workspacePath, repoState);
          fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        } else {
          console.log(`   💤 No new review comments. Awaiting Reviewer feedback for cycle ${repoState.applied_cycles + 1}.`);
        }
        continue;
      }
    }

    if (!repoState.pr_number) {
      // SCENARIO A: No active PR exists. Check 24 hour threshold
      const now = new Date();
      const lastRunDate = repoState.last_run ? new Date(repoState.last_run) : null;
      const hoursElapsed = lastRunDate ? (now - lastRunDate) / (1000 * 60 * 60) : 999;

      if (hoursElapsed >= 24) {
        if (newPrsCreatedCount >= NEW_PR_LIMIT) {
          console.log(`   ⏳ Skipping new README audit for ${repoWithOwner} (daily draft creation limit of ${NEW_PR_LIMIT} reached).`);
          continue;
        }

        console.log(`🚀 Triggering new README audit & generation cycle for ${repoWithOwner} (last run: ${repoState.last_run || 'never'})...`);
        const prNumber = await startNewReadmeCycle(repoWithOwner, repoName, workspacePath, repoState);
        if (prNumber) {
          newPrsCreatedCount++;
          fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
        }
      } else {
        console.log(`   ✅ Repo ${repoWithOwner} is up-to-date (audited ${hoursElapsed.toFixed(1)} hours ago).`);
      }
    }
  }

  console.log('✅ Readme Review & Refinement Coder Agent execution cycle complete.');
}

/**
 * Syncs the local workspace, checks out the readme-review-* branch,
 * harvests comments, feeds them into Gemini, and commits/pushes the refined README.md.
 */
async function applyFeedbackAndRefine(repoWithOwner, repoName, workspacePath, repoState) {
  // Sync workspace and branch
  prepareWorkspace(repoWithOwner, workspacePath);
  const branchName = repoState.branch || `readme-review-${repoName}`;
  
  try {
    execSync(`git checkout ${branchName}`, { cwd: workspacePath, stdio: 'inherit' });
    execSync(`git pull origin ${branchName}`, { cwd: workspacePath, stdio: 'pipe' });
  } catch (err) {
    console.error(`❌ Failed to pull branch ${branchName} for repo ${repoName}:`, err.message);
    return;
  }

  // Fetch comments and reviews from GitHub PR
  console.log(`   Fetching PR #${repoState.pr_number} review comments...`);
  let commentsText = '';
  try {
    const rawComments = execSync(
      `gh pr view ${repoState.pr_number} -R ${repoWithOwner} --json comments,reviews`,
      { encoding: 'utf8' }
    );
    const commentsData = JSON.parse(rawComments);
    
    const comments = commentsData.comments || [];
    const reviews = commentsData.reviews || [];
    
    const relevantComments = [];
    comments.forEach(c => {
      relevantComments.push(`[Comment by @${c.author?.login}]: ${c.body}`);
    });
    reviews.forEach(r => {
      if (r.body && r.body.trim() !== '') {
        relevantComments.push(`[Review by @${r.author?.login} (${r.state})]: ${r.body}`);
      }
    });

    commentsText = relevantComments.join('\n\n');
  } catch (e) {
    console.error(`❌ Failed to retrieve PR comments:`, e.message);
    return;
  }

  if (commentsText.trim() === '') {
    console.log('   ⚠️ No review text found. Automatically matching applied cycles.');
    repoState.applied_cycles = repoState.cycles;
    return;
  }

  console.log(`🔍 Received Reviewer Feedback:\n${commentsText}\n`);

  // Read current README
  const readmePath = path.join(workspacePath, 'README.md');
  let currentReadme = '';
  if (fs.existsSync(readmePath)) {
    currentReadme = fs.readFileSync(readmePath, 'utf8');
  }

  const systemPrompt = `You are a world-class technical writer and senior software engineer.
Your goal is to refine and perfect the README.md of a repository in response to comments and feedback from a code reviewer.
Ensure the refined README.md addresses all feedback while keeping premium aesthetics, beautiful formatting, harmonious color palettes, clear typography, and accurate technical details intact.`;

  const refinePrompt = `We are refining the README.md for repository: ${repoWithOwner}
Head Branch: ${branchName}
PR Number: #${repoState.pr_number}

Here are the reviewer's feedback and requested adjustments:
${commentsText}

Here is the current content of the README.md:
\`\`\`markdown
${currentReadme}
\`\`\`

Please update and refine the README.md to perfectly resolve all reviewer feedback.
Output the complete new refined README.md content. Do not output diffs or commentary. Output ONLY the markdown code block.`;

  console.log(`🧠 Calling Gemini (${GEMINI_MODEL}) to refine README...`);
  const refinedReadmeRaw = await callGemini(systemPrompt, refinePrompt);
  let refinedReadme = refinedReadmeRaw.trim();
  
  // Extract markdown block if model wrapped it
  if (refinedReadme.startsWith('```markdown')) {
    refinedReadme = refinedReadme.substring(11, refinedReadme.length - 3).trim();
  } else if (refinedReadme.startsWith('```')) {
    refinedReadme = refinedReadme.substring(3, refinedReadme.length - 3).trim();
  }

  // Write refined readme
  fs.writeFileSync(readmePath, refinedReadme, 'utf8');
  console.log('✨ Written refined README.md');

  // Stage, commit and push
  try {
    execSync('git add README.md', { cwd: workspacePath, stdio: 'inherit' });
    execSync(`git commit -m "chore: refine README based on PR reviewer feedback (cycle ${repoState.cycles})"`, { cwd: workspacePath, stdio: 'inherit' });
    execSync(`git push origin ${branchName}`, { cwd: workspacePath, stdio: 'inherit' });
    console.log(`✅ Refined README pushed successfully.`);

    // Update PR body
    const newPrBody = `Automated premium README review and refinement cycle.

This pull request will undergo an **iterative 3-turn feedback loop** with the PR Reviewer Agent before final merge.

- **Turn Cycle**: ${repoState.cycles}/3
- **Latest Update**: Refinement applied based on reviewer feedback (Cycle ${repoState.cycles}).`;
    
    execSync(`gh pr edit ${repoState.pr_number} -R ${repoWithOwner} --body "${newPrBody.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
    
    // Mark as applied
    repoState.applied_cycles = repoState.cycles;
  } catch (err) {
    console.error('❌ Git commit/push or PR edit failed:', err.message);
  }
}

/**
 * Prepares workspace, audits files, generates a premium README using Gemini,
 * pushes the readme-review-* branch, and opens a Draft PR.
 */
async function startNewReadmeCycle(repoWithOwner, repoName, workspacePath, repoState) {
  prepareWorkspace(repoWithOwner, workspacePath);
  const branchName = `readme-review-${repoName}`;

  // Checkout clean branch
  try {
    try {
      execSync(`git branch -D ${branchName}`, { cwd: workspacePath, stdio: 'pipe' });
    } catch (e) {}
    execSync(`git checkout -b ${branchName}`, { cwd: workspacePath, stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Failed to checkout branch ${branchName}:`, err.message);
    return null;
  }

  // Audit file structure
  const filesList = getFilesList(workspacePath);
  console.log(`   Found ${filesList.length} files in repository. Auditing tech stack...`);

  // Read existing README if it exists
  const readmePath = path.join(workspacePath, 'README.md');
  let existingReadme = '';
  if (fs.existsSync(readmePath)) {
    existingReadme = fs.readFileSync(readmePath, 'utf8');
  }

  // Read package.json or config files if present to infer stack
  let techStackDetails = '';
  const packageJsonPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      techStackDetails = `\npackage.json dependencies:\n${JSON.stringify(packageJson.dependencies || {}, null, 2)}\ndevDependencies:\n${JSON.stringify(packageJson.devDependencies || {}, null, 2)}`;
    } catch (e) {}
  }

  const systemPrompt = `You are a world-class senior software engineer, technical writer, and documentation architect.
Your goal is to build a premium, highly informative, beautiful, and completely accurate README.md for a given repository.
Use best practices in modern web and documentation design:
- Sleek structure and curated harmonized color schemes.
- Google Fonts or beautiful typography recommendations.
- Interactive sections, installation details, features, configuration, deployment, and testing.
- Include flowcharts or Mermaid diagrams to visualize architecture where applicable.
- Make the design feel professional, professional, premium and state-of-the-art.
- Do NOT use placeholders. Generate a full, complete, high-fidelity documentation.`;

  const auditPrompt = `We are generating a premium, up-to-date README.md for repository: ${repoWithOwner}

Here is a list of all source files in the repository:
${filesList.map(f => `- ${f}`).join('\n')}
${techStackDetails}

Here is the existing README.md if it exists (leverage the useful details from it, but elevate the structure and aesthetics dramatically):
\`\`\`markdown
${existingReadme}
\`\`\`

Please generate the complete, high-fidelity new README.md.
Output ONLY the markdown content inside the markdown code block. Do not output diffs or explanations.`;

  console.log(`🧠 Calling Gemini (${GEMINI_MODEL}) to generate initial premium README...`);
  const generatedReadmeRaw = await callGemini(systemPrompt, auditPrompt);
  let generatedReadme = generatedReadmeRaw.trim();

  // Extract markdown block
  if (generatedReadme.startsWith('```markdown')) {
    generatedReadme = generatedReadme.substring(11, generatedReadme.length - 3).trim();
  } else if (generatedReadme.startsWith('```')) {
    generatedReadme = generatedReadme.substring(3, generatedReadme.length - 3).trim();
  }

  // Write new readme
  fs.writeFileSync(readmePath, generatedReadme, 'utf8');
  console.log('   ✨ Generated initial README.md');

  // Stage, commit, and push
  try {
    execSync('git add README.md', { cwd: workspacePath, stdio: 'inherit' });
    execSync('git commit -m "chore: premium README audit & refinement"', { cwd: workspacePath, stdio: 'inherit' });
    execSync(`git push -u origin ${branchName} -f`, { cwd: workspacePath, stdio: 'inherit' });
    console.log(`   ✅ Branch pushed: origin/${branchName}`);

    // Create Draft PR using gh CLI
    const prTitle = `Draft: Premium README Review & Refinement - ${repoName}`;
    const prBody = `Automated premium README review and refinement cycle.

This pull request will undergo an **iterative 3-turn feedback loop** with the PR Reviewer Agent before final merge.

- **Turn Cycle**: 0/3
- **Latest Update**: Initial audit and draft.`;

    const prCreateCmd = `gh pr create --draft --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --head "${branchName}"`;
    const prUrl = execSync(prCreateCmd, { cwd: workspacePath, encoding: 'utf8' }).trim();
    const prNumber = parseInt(prUrl.split('/').pop());

    console.log(`🎉 Draft PR created successfully! URL: ${prUrl}`);

    // Update state
    repoState.pr_number = prNumber;
    repoState.branch = branchName;
    repoState.cycles = 0;
    repoState.applied_cycles = 0;
    repoState.last_run = new Date().toISOString();

    return prNumber;
  } catch (err) {
    console.error('❌ Git commit/push or PR creation failed:', err.message);
    return null;
  }
}

/**
 * Prepares the local repository directory: clones if missing, pulls default branch latest.
 */
function prepareWorkspace(repoWithOwner, workspacePath) {
  if (!fs.existsSync(workspacePath)) {
    console.log(`   Cloning repository ${repoWithOwner} into ${workspacePath}...`);
    try {
      execSync(`gh repo clone ${repoWithOwner} "${workspacePath}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`❌ Failed to clone repository:`, err.message);
      process.exit(1);
    }
  } else {
    try {
      execSync(`git stash`, { cwd: workspacePath, stdio: 'pipe' });
      const defaultBranch = execSync(`git symbolic-ref refs/remotes/origin/HEAD`, { cwd: workspacePath, encoding: 'utf8' })
        .trim().split('/').pop();
      execSync(`git checkout ${defaultBranch}`, { cwd: workspacePath, stdio: 'inherit' });
      execSync(`git pull`, { cwd: workspacePath, stdio: 'inherit' });
    } catch (err) {
      console.warn(`   ⚠️ Warning sync workspace:`, err.message);
    }
  }
}

/**
 * Recursive file helper (skips binary, git, and build folders)
 */
function getFilesList(dir, relativeTo = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'bin', 'obj', '.antigravity'];
  const skipExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.db', '.mp4', '.mp3', '.ttf', '.woff', '.woff2'];

  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat && stat.isDirectory()) {
      if (!skipDirs.includes(file)) {
        results = results.concat(getFilesList(fullPath, relativeTo));
      }
    } else {
      const ext = path.extname(file).toLowerCase();
      if (!skipExtensions.includes(ext)) {
        results.push(path.relative(relativeTo, fullPath));
      }
    }
  });
  
  return results;
}

/**
 * Call Gemini API via fetch
 */
async function callGemini(systemPrompt, userPrompt) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 8192
    }
  };

  try {
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API responded with status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    console.error('❌ Fetch call to Gemini API failed:', err.message);
    throw err;
  }
}

run();

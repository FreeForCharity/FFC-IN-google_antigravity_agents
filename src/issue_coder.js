/**
 * Autonomous Issue Coder Agent (Zero-Config, Self-Healing)
 * Finds the oldest user-generated community issue in 'Ready for Work' state,
 * checks it out, harvests context, generates patches using the Gemini API,
 * applies them locally, and pushes a linked Draft PR.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro'; // Pro for high reasoning and coding

if (!GEMINI_API_KEY) {
  console.error('❌ Error: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

// Target organizations / owner scopes
const SCOPES = ['clarkemoyer', 'FreeForCharity', 'koenig-childhood-cancer-foundation'];

async function run() {
  console.log('🤖 Starting Autonomous Issue Coder Agent...');
  
  // 1. Fetch all open issues across scopes
  console.log('📡 Fetching open Issues across accessible scopes using local gh CLI...');
  let issuesJson = [];
  try {
    const rawIssues = execSync(
      `gh search issues "type:issue" --state=open ${SCOPES.map(s => `--owner=${s}`).join(' ')} --limit 100 --json repository,number,title,body,url,updatedAt,author`,
      { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
    );
    issuesJson = JSON.parse(rawIssues);
  } catch (error) {
    console.error('❌ Error executing gh search issues CLI command:', error.message);
    process.exit(1);
  }

  // 2. Query open PRs to build reference map
  console.log('📡 Fetching open PRs to resolve linked states...');
  let prsJson = [];
  try {
    const rawPRs = execSync(
      `gh search prs --state=open ${SCOPES.map(s => `--owner=${s}`).join(' ')} --limit 300 --json repository,number`,
      { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
    );
    prsJson = JSON.parse(rawPRs);
  } catch (error) {
    console.error('❌ Error executing gh search prs CLI command:', error.message);
    process.exit(1);
  }

  const openPRNumbersMap = {};
  if (prsJson && prsJson.length > 0) {
    for (const pr of prsJson) {
      const repo = pr.repository.nameWithOwner;
      if (!openPRNumbersMap[repo]) {
        openPRNumbersMap[repo] = new Set();
      }
      openPRNumbersMap[repo].add(pr.number);
    }
  }

  // 3. Filter for community-generated issues (non-clarkemoyer, non-bot)
  const communityIssues = issuesJson.filter(issue => {
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

  console.log(`🔍 Found ${communityIssues.length} open community-generated issues. Checking address states...`);

  // 4. Find the first issue that is "🟢 Ready for Work" (No PR, No branch)
  let targetIssue = null;
  const repoBranchesCache = {};

  for (const issue of communityIssues) {
    const repoWithOwner = issue.repository.nameWithOwner;
    const issueNumber = issue.number;
    const issueKey = `${repoWithOwner}#${issueNumber}`;

    console.log(`   🔗 Evaluating issue: ${issueKey}...`);
    let isLinked = false;

    // Check closedByPullRequestsReferences
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
        console.log(`      🔗 Already linked to open PR: ${openLinkedPR.url}. Skipping.`);
        isLinked = true;
      }
    } catch (err) {
      console.warn(`      ⚠️ Failed to query references for issue ${issueKey}:`, err.message);
    }

    if (isLinked) continue;

    // Check active developer branches
    if (!repoBranchesCache[repoWithOwner]) {
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
      console.log(`      🌿 Active branch exists: ${matchingBranch.name}. Skipping.`);
      continue;
    }

    // Found an unaddressed ready-for-work issue!
    targetIssue = issue;
    console.log(`🚀 Found Ready-for-Work target issue!`);
    console.log(`   Key: ${issueKey}`);
    console.log(`   Title: "${issue.title}"`);
    console.log(`   Author: @${issue.author?.login}`);
    break;
  }

  if (!targetIssue) {
    console.log('💤 No unaddressed community issues ready for work. Exiting.');
    process.exit(0);
  }

  // 5. Setup Local Workspace
  const repoWithOwner = targetIssue.repository.nameWithOwner;
  const repoBasename = repoWithOwner.split('/')[1];
  const workspacePath = path.join('C:\\AntiGravity', repoBasename);
  const issueNumber = targetIssue.number;
  const branchName = `issue-${issueNumber}`;

  console.log(`\n📂 Setting up workspace in directory: ${workspacePath}...`);

  if (!fs.existsSync(workspacePath)) {
    console.log(`   🌿 Directory does not exist. Cloning repository using gh CLI...`);
    try {
      execSync(`gh repo clone ${repoWithOwner} "${workspacePath}"`, { stdio: 'inherit' });
    } catch (err) {
      console.error(`❌ Failed to clone repository:`, err.message);
      process.exit(1);
    }
  } else {
    console.log(`   ✅ Local folder exists. Stashing any unsaved changes & pulling latest...`);
    try {
      execSync(`git stash`, { cwd: workspacePath, stdio: 'inherit' });
      // Fetch default branch
      const defaultBranch = execSync(`git symbolic-ref refs/remotes/origin/HEAD`, { cwd: workspacePath, encoding: 'utf8' })
        .trim().split('/').pop();
      console.log(`   🌿 Default branch detected: ${defaultBranch}`);
      execSync(`git checkout ${defaultBranch}`, { cwd: workspacePath, stdio: 'inherit' });
      execSync(`git pull`, { cwd: workspacePath, stdio: 'inherit' });
    } catch (err) {
      console.warn(`   ⚠️ Warning: Workspace sync returned warning:`, err.message);
    }
  }

  // 6. Checkout clean branch
  console.log(`🌿 Checking out new branch "${branchName}"...`);
  try {
    // Delete branch locally if it already exists to start clean
    try {
      execSync(`git branch -D ${branchName}`, { cwd: workspacePath, stdio: 'pipe' });
    } catch (e) {}
    execSync(`git checkout -b ${branchName}`, { cwd: workspacePath, stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Failed to check out branch:`, err.message);
    process.exit(1);
  }

  // 7. Enumerate codebase files (excluding binaries, node_modules, and git directories)
  console.log('📂 Surveying local file structure...');
  const filesList = getFilesList(workspacePath);
  console.log(`   Found ${filesList.length} text files in the repository structure.`);

  // 8. Turn 1: Present issue and ask Gemini which files to inspect
  const systemPrompt = `You are a world-class senior software engineer and autonomous coding assistant.
Your goal is to resolve open GitHub issues by:
1. Identifying which source files are relevant to the issue.
2. Reading those files and proposing complete, correct code solutions.
3. Returning fully-implemented code changes.

Maintain codebase integrity, respect local architectures, and write extremely clean, high-performance code. Avoid placeholders.`;

  const surveyPrompt = `We are solving the following GitHub Issue:
Repository: ${repoWithOwner}
Issue Number: #${issueNumber}
Title: "${targetIssue.title}"
Description:
${targetIssue.body || 'No description provided.'}

Here is a list of all source files in the repository:
${filesList.map(f => `- ${f}`).join('\n')}

Based on the issue description and file list, please select which files you need to inspect/read to understand and fix this issue.
Output your response STRICTLY as a JSON block with the following format:
\`\`\`json
{
  "files_to_read": ["path/to/file1", "path/to/file2"]
}
\`\`\`

Do not include any introductory or concluding text outside the JSON code block.`;

  console.log(`🧠 Calling Gemini (${GEMINI_MODEL}) for turn 1 (Context Harvesting)...`);
  const turn1Response = await callGemini(systemPrompt, surveyPrompt);
  const turn1Data = parseJsonFromText(turn1Response);

  if (!turn1Data || !Array.isArray(turn1Data.files_to_read)) {
    console.error('❌ Failed to parse a valid list of files to read from Gemini response:', turn1Response);
    process.exit(1);
  }

  const filesToRead = turn1Data.files_to_read.map(f => f.trim());
  console.log(`   Gemini requested to inspect the following files:`, filesToRead);

  // 9. Turn 2: Feed file contents and request code fixes
  const loadedFiles = [];
  for (const relativePath of filesToRead) {
    const absolutePath = path.join(workspacePath, relativePath);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      try {
        const content = fs.readFileSync(absolutePath, 'utf8');
        loadedFiles.push({ path: relativePath, content });
      } catch (err) {
        console.warn(`      ⚠️ Failed to read requested file ${relativePath}:`, err.message);
      }
    } else {
      console.warn(`      ⚠️ Requested file does not exist: ${relativePath}`);
    }
  }

  if (loadedFiles.length === 0) {
    console.log('⚠️ No requested files could be read. Supplying empty context to let Gemini write from scratch.');
  }

  const codingPrompt = `We are solving the following GitHub Issue:
Repository: ${repoWithOwner}
Issue Number: #${issueNumber}
Title: "${targetIssue.title}"
Description:
${targetIssue.body || 'No description provided.'}

Here are the current contents of the files you requested to inspect:

${loadedFiles.map(f => `### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`).join('\n')}

Please generate the complete source code changes required to fully resolve this issue.
For each file you want to edit or create, supply the entire new file content (do not output diffs, output complete file replacements).

Output your response STRICTLY as a valid JSON block with the following format:
\`\`\`json
{
  "files_to_write": [
    {
      "path": "path/to/file1",
      "content": "...complete new content for file1..."
    },
    {
      "path": "path/to/new_file",
      "content": "...complete content for new file..."
    }
  ],
  "explanation": "Detailed summary of the changes made and how they address the issue."
}
\`\`\`

Do not include any introductory or concluding text outside the JSON code block.`;

  console.log(`🧠 Calling Gemini (${GEMINI_MODEL}) for turn 2 (Code Generation)...`);
  const turn2Response = await callGemini(systemPrompt, codingPrompt);
  const turn2Data = parseJsonFromText(turn2Response);

  if (!turn2Data || !Array.isArray(turn2Data.files_to_write)) {
    console.error('❌ Failed to parse a valid list of files to write from Gemini response:', turn2Response);
    process.exit(1);
  }

  // 10. Write files locally to workspace
  console.log(`\n✍️ Applying code changes to repository...`);
  for (const change of turn2Data.files_to_write) {
    const targetPath = path.join(workspacePath, change.path);
    const parentDir = path.dirname(targetPath);
    
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    
    fs.writeFileSync(targetPath, change.content, 'utf8');
    console.log(`   ✨ Written: ${change.path}`);
  }

  console.log(`\n📋 Explanation from Coder Agent:\n${turn2Data.explanation}\n`);

  // 11. Git Commit & Push
  console.log('📤 Committing and pushing changes to branch...');
  try {
    execSync('git add .', { cwd: workspacePath, stdio: 'inherit' });
    const commitMsg = `Draft solution for issue #${issueNumber}: ${targetIssue.title.replace(/"/g, '\\"')}`;
    execSync(`git commit -m "${commitMsg}"`, { cwd: workspacePath, stdio: 'inherit' });
    execSync(`git push -u origin ${branchName} -f`, { cwd: workspacePath, stdio: 'inherit' });
    console.log(`   ✅ Branch pushed successfully: origin/${branchName}`);
  } catch (err) {
    console.error('❌ Git commit/push failed:', err.message);
    process.exit(1);
  }

  // 12. Submit Draft PR using gh CLI
  console.log('🚀 Creating GitHub Draft Pull Request...');
  try {
    const prTitle = `Draft: Fixes #${issueNumber} - ${targetIssue.title}`;
    const prBody = `Automated draft pull request generated by **Gemini Code Agent** to resolve issue #${issueNumber}.

### 📋 Agent Solution Summary
${turn2Data.explanation}

Closes #${issueNumber}.`;

    const prCreateCmd = `gh pr create --draft --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}" --head "${branchName}"`;
    const prResult = execSync(prCreateCmd, { cwd: workspacePath, encoding: 'utf8' }).trim();
    console.log(`\n🎉 Draft PR created successfully!`);
    console.log(`🌐 URL: ${prResult}`);
  } catch (err) {
    console.error('❌ Failed to create Draft PR:', err.message);
    process.exit(1);
  }
}

// Recursive file helper (skips binary, git, and build folders)
function getFilesList(dir, relativeTo = dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'bin', 'obj'];
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

// Call Gemini API via fetch
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

// Robust JSON extractor from markdown blocks or raw text
function parseJsonFromText(text) {
  try {
    // Try to parse the entire text block first
    return JSON.parse(text.trim());
  } catch (e) {
    // Attempt block match
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/;
    const match = text.match(jsonBlockRegex);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch (blockError) {
        console.error('⚠️ Found ```json block but failed to parse:', blockError.message);
      }
    }

    // Last resort fallback curly brace search
    const startCurly = text.indexOf('{');
    const endCurly = text.lastIndexOf('}');
    if (startCurly !== -1 && endCurly !== -1) {
      try {
        return JSON.parse(text.substring(startCurly, endCurly + 1));
      } catch (curlyError) {
        console.error('⚠️ Extracted curly braces but failed to parse:', curlyError.message);
      }
    }
    
    return null;
  }
}

run();

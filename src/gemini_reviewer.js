/**
 * Gemini Pull Request Reviewer
 * A self-contained, lightweight Node.js script that reviews GitHub Pull Requests
 * using the Gemini API. Zero external dependencies (uses built-in fetch).
 */

const fs = require('fs');
const path = require('path');

async function run() {
  console.log('🤖 Starting Gemini PR Reviewer...');

  // 1. Gather configuration
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const customPrompt = process.env.CUSTOM_PROMPT || '';

  if (!githubToken) {
    console.error('❌ GITHUB_TOKEN environment variable is required.');
    process.exit(1);
  }

  if (!geminiApiKey) {
    console.error('❌ GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  // 2. Parse GitHub Event Context
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.error('❌ GITHUB_EVENT_PATH is not set or file does not exist. This script should run in a GitHub Action environment.');
    process.exit(1);
  }

  const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  
  // Verify this is a pull request event
  if (!eventData.pull_request) {
    console.log('⚠️ No pull_request context found in event. Skipping review.');
    process.exit(0);
  }

  const owner = eventData.repository.owner.login;
  const repo = eventData.repository.name;
  const pullNumber = eventData.pull_request.number;
  const prTitle = eventData.pull_request.title;
  const prBody = eventData.pull_request.body || 'No description provided.';
  const prUrl = eventData.pull_request.html_url;

  console.log(`📦 Reviewing PR #${pullNumber}: "${prTitle}" in ${owner}/${repo}`);

  try {
    // 3. Fetch PR Diff from GitHub API
    console.log('📡 Fetching PR diff from GitHub...');
    const diffResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3.diff',
          'Authorization': `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }
    );

    if (!diffResponse.ok) {
      const errorText = await diffResponse.text();
      throw new Error(`Failed to fetch PR diff (${diffResponse.status}): ${errorText}`);
    }

    const diff = await diffResponse.text();
    
    if (!diff || diff.trim() === '') {
      console.log('ℹ️ Pull request diff is empty. Nothing to review.');
      process.exit(0);
    }

    console.log(`🔍 Diff fetched successfully. Size: ${diff.length} characters.`);

    // Truncate diff if it is too massive (e.g. over 150k characters)
    const MAX_DIFF_LEN = 150000;
    let preparedDiff = diff;
    if (diff.length > MAX_DIFF_LEN) {
      console.log(`⚠️ Diff is very large (${diff.length} chars). Truncating to first ${MAX_DIFF_LEN} chars for Gemini context safety.`);
      preparedDiff = diff.substring(0, MAX_DIFF_LEN) + '\n\n[... Diff truncated due to size limits ...]';
    }

    // 4. Construct AI System & User Prompt
    const systemPrompt = `You are a world-class senior software engineer and security auditor acting as an autonomous code review agent.
Your goal is to perform a meticulous, high-quality code review on the provided Pull Request git diff.

Be constructive, specific, and actionable. Focus on:
1. **Security Vulnerabilities**: Injection risks, auth issues, leak of secrets, buffer overflows, etc.
2. **Logic Errors & Bugs**: Corner cases, resource leaks, off-by-one errors, async handling.
3. **Performance & Efficiency**: Algorithmic complexity, unnecessary allocations, database query bottlenecks.
4. **Readability & Design**: Code style, modularity, naming, architectural patterns, clean code principles.

Style and Presentation Rules:
- Keep the tone professional, objective, and collaborative.
- Use emojis to make the review readable, engaging, and structured.
- Use standard markdown. Use GitHub alerts (e.g. \`> [!IMPORTANT]\`, \`> [!WARNING]\`, \`> [!NOTE]\`) to emphasize key messages.
- Always include an overall qualitative rating (e.g. out of 10) for the PR.
- Use collapsible markdown blocks (\`<details><summary>Click to view suggestion</summary>...</details>\`) for detailed code block suggestions or minor comments so the PR summary stays clean and scannable.
- Be concise. If there are no issues, warmly praise the developer!`;

    const userPrompt = `Review the following Pull Request details and Git Diff:

### Pull Request Metadata
- **Title**: ${prTitle}
- **Description**: ${prBody}

### Git Diff
\`\`\`diff
${preparedDiff}
\`\`\`

${customPrompt ? `### Custom Project Instructions:\n${customPrompt}\n` : ''}

Provide your review in the following clean, professional markdown format:

1. **## 🎯 PR Overview & Summary**: A brief, high-level summary of what the PR accomplishes and its scope.
2. **## 📊 Code Health Index**:
   - **Quality Score**: X/10 (with a brief 1-sentence justification)
   - **Security Score**: X/10
   - **Performance Score**: X/10
3. **## 🌟 Key Strengths**: Highlight 2-3 aspects of the code that are well-designed or correctly implemented.
4. **## 🛠️ Actionable Feedback & Recommendations**:
   Categorize findings by severity. For each issue, specify the file, approximate line or context, and provide a clear explanation and code recommendation.
   Use the following formats:
   - **🚨 [CRITICAL/HIGH] <Issue Title>**
     - **File**: \`path/to/file\`
     - **Why**: Explanation of the issue.
     - **Fix**: Collapsible block (\`<details>\`) containing the corrected code snippet.
   - **⚠️ [MEDIUM] <Issue Title>**
     - ...
   - **💡 [LOW/SUGGESTION] <Issue Title>**
     - ...
5. **## 🏁 Conclusion**: A warm, encouraging concluding remark indicating whether the PR is ready for merge or needs changes.`;

    // 5. Call Gemini API
    console.log(`🧠 Invoking Gemini API (${modelName})...`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
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
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Gemini API error (${geminiResponse.status}): ${errorText}`);
    }

    const resultData = await geminiResponse.json();
    const reviewMarkdown = resultData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reviewMarkdown) {
      throw new Error('Received empty response from Gemini API.');
    }

    console.log('✍️ Review generated successfully. Posting comment to PR...');

    // 6. Post Review Comment to GitHub PR
    const commentBody = `${reviewMarkdown}\n\n---\n*🤖 Reviewed automatically by **Gemini Code Agent**.*`;

    const githubResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ body: commentBody })
      }
    );

    if (!githubResponse.ok) {
      const errorText = await githubResponse.text();
      throw new Error(`Failed to post comment to GitHub (${githubResponse.status}): ${errorText}`);
    }

    console.log('✅ PR review posted successfully!');

  } catch (error) {
    console.error('❌ Error during PR review execution:', error);
    process.exit(1);
  }
}

run();

const fs = require('fs');
const path = require('path');
const htmlFile = path.join(__dirname, 'review_status_dashboard.html');

if (!fs.existsSync(htmlFile)) {
  console.error(JSON.stringify({ error: 'Dashboard HTML file not found at: ' + htmlFile }));
  process.exit(1);
}

try {
  const content = fs.readFileSync(htmlFile, 'utf8');
  const regex = /const\s+data\s*=\s*({[\s\S]*?});/;
  const match = content.match(regex);
  
  if (!match || !match[1]) {
    console.error(JSON.stringify({ error: 'Could not extract data payload from HTML dashboard' }));
    process.exit(1);
  }
  
  const data = JSON.parse(match[1]);
  const communityIssues = data.communityIssues || [];
  
  // Find the first issue with status "Unaddressed (Ready for Work)"
  const readyIssue = communityIssues.find(iss => 
    iss.linkStatus && (iss.linkStatus.includes('Ready for Work') || iss.linkStatus.includes('Unaddressed'))
  );
  
  if (!readyIssue) {
    console.log(JSON.stringify({ found: false, message: 'No unaddressed community issues ready for work.' }));
    process.exit(0);
  }
  
  const repo = readyIssue.repo || readyIssue.repository?.nameWithOwner;
  console.log(JSON.stringify({
    found: true,
    repo: repo,
    number: readyIssue.number,
    title: readyIssue.title,
    author: readyIssue.author?.login || readyIssue.author,
    url: readyIssue.url,
    body: readyIssue.body || ''
  }, null, 2));
  
} catch (err) {
  console.error(JSON.stringify({ error: 'Failed to process dashboard: ' + err.message }));
  process.exit(1);
}

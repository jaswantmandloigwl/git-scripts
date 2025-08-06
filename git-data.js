require('dotenv').config();
const fs = require('fs');
const simpleGit = require('simple-git');
const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { execSync } = require('child_process');
const { minimatch } = require('minimatch');
const path = require('path');

const REPO_PATH = process.env.REPO_PATH; // Read from .env file
const AUTHOR = process.env.AUTHOR;      // Read from .env file
const SINCE_DATE = "2025-07-01";          // Start date for commit filtering
const UNTIL_DATE = "2025-07-31";          // End date for commit filtering




// Helper to run shell commands safely
function runCommand(command, cwd) {
  try {
    const result = execSync(command, { cwd, encoding: 'utf-8' });
    return result ? result.trim() : '';
  } catch (error) {
    console.error(`Command failed: ${command}`);
    console.error(error.message);
    return '';
  }
}

// Validate Git repository path
function validateGitRepo(repoPath) {
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.error('Invalid Git repository path:', repoPath);
    process.exit(1);
  }
}

// Get commits by the author within the date range
function getCommits(repoPath) {
  console.log(`\n=== DEBUGGING getCommits function ===`);
  
  // First, check what authors exist in the repository
  const authorsCommand = `git log --pretty=format:"%an" | sort | uniq`;
  console.log(`Getting all authors...`);
  const authors = runCommand(authorsCommand, repoPath);
  console.log(`Available authors in repository:\n${authors}`);
  
  // Check if there are any commits in the date range (any author)
  const dateRangeCommand = `git log --since="${SINCE_DATE}" --until="${UNTIL_DATE}" --pretty=format:"%H %an %ad" --date=short`;
  console.log(`\nChecking commits in date range ${SINCE_DATE} to ${UNTIL_DATE} (any author)...`);
  const dateRangeOutput = runCommand(dateRangeCommand, repoPath);
  console.log(`Commits in date range:\n${dateRangeOutput || 'No commits found in date range'}`);
  
  // Check recent commits by this author (any date)
  const recentAuthorCommand = `git log --author="${AUTHOR}" --max-count=5 --pretty=format:"%H %ad" --date=short`;
  console.log(`\nChecking recent commits by author "${AUTHOR}"...`);
  const recentAuthorOutput = runCommand(recentAuthorCommand, repoPath);
  console.log(`Recent commits by ${AUTHOR}:\n${recentAuthorOutput || 'No commits found for this author'}`);
  
  // Collect commits from all possible author name variations
  const allCommits = new Set();
  
  // Method 1: Exact author name match
  const logCommand = `git log --author="${AUTHOR}" --since="${SINCE_DATE}T00:00:00" --until="${UNTIL_DATE}T23:59:59" --pretty=format:"%H"`;
  console.log(`\nRunning main command: ${logCommand}`);
  const stdout = runCommand(logCommand, repoPath);
  console.log(`Git log output: "${stdout}"`);
  
  if (stdout) {
    stdout.split('\n').filter(hash => hash.trim() !== '').forEach(hash => allCommits.add(hash));
  }
  
  // Method 2: Try reversed name format (Last, First)
  const nameParts = AUTHOR.split(' ');
  if (nameParts.length >= 2) {
    const reversedAuthor = `${nameParts[nameParts.length - 1]}, ${nameParts.slice(0, -1).join(' ')}`;
    const reversedCommand = `git log --author="${reversedAuthor}" --since="${SINCE_DATE}T00:00:00" --until="${UNTIL_DATE}T23:59:59" --pretty=format:"%H"`;
    console.log(`\nTrying reversed name format "${reversedAuthor}": ${reversedCommand}`);
    const reversedOutput = runCommand(reversedCommand, repoPath);
    console.log(`Reversed name output: "${reversedOutput}"`);
    
    if (reversedOutput) {
      reversedOutput.split('\n').filter(hash => hash.trim() !== '').forEach(hash => allCommits.add(hash));
    }
  }
  
  // Method 3: Try partial matching with first name only
  const firstNameOnly = AUTHOR.split(' ')[0];
  const partialAuthorCommand = `git log --author="${firstNameOnly}" --since="${SINCE_DATE}T00:00:00" --until="${UNTIL_DATE}T23:59:59" --pretty=format:"%H %an"`;
  console.log(`\nTrying partial author match with "${firstNameOnly}": ${partialAuthorCommand}`);
  const partialOutput = runCommand(partialAuthorCommand, repoPath);
  console.log(`Partial author output: "${partialOutput}"`);
  
  if (partialOutput) {
    partialOutput.split('\n')
      .filter(line => line.trim() !== '')
      .forEach(line => {
        const [hash, ...authorParts] = line.split(' ');
        const authorName = authorParts.join(' ');
        // Only include if it contains both first and last name
        if (authorName.toLowerCase().includes(nameParts[0].toLowerCase()) && 
            authorName.toLowerCase().includes(nameParts[nameParts.length - 1].toLowerCase())) {
          allCommits.add(hash);
        }
      });
  }
  
  const finalCommits = Array.from(allCommits);
  console.log(`\nTotal unique commits found: ${finalCommits.length}`);
  console.log(`=== END DEBUGGING ===\n`);
  
  return finalCommits;
}

// Get list of files changed in commits
function getListOfFiles(commits, repoPath) {
  const files = new Set();
  commits.forEach(commit => {
    const showCommand = `git show --pretty="" --name-only ${commit}`;
    const stdout = runCommand(showCommand, repoPath);
    if (stdout) {
      stdout.split('\n').forEach(file => {
        const trimmedFile = file.trim();
        if (trimmedFile) files.add(trimmedFile);
      });
    }
  });

  console.log({commits: commits.length, files: files.size});

  return Array.from(files);
}

// Filter test case files from a list of files
function getTestCaseFiles(files) {
  return files.filter(file => 
    minimatch(file, '**/*.spec.js') || minimatch(file, '**/*.test.js') || minimatch(file, '**/*.test.tsx') || minimatch(file, '**/*.test.jsx') || minimatch(file, '**/*.test.ts')
  );
}

// Parse Git diff output to extract line numbers
function parseDiff(diffOutput) {
  const lines = diffOutput.split('\n');
  const lineNumbers = [];
  let startLine = 0;

  lines.forEach(line => {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@/);
      if (match) startLine = parseInt(match[1], 10);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumbers.push(startLine++);
    } else if (!line.startsWith('\\')) {
      startLine++;
    }
  });

  return lineNumbers;
}

// Get updated lines in a file
function getTestCasesUpdatedLineNumbersByFile(filePath, commits, repoPath) {
  const updatedLineNumbers = [];
  commits.forEach(commit => {
    const diffCommand = `git diff -U0 ${commit}^ ${commit} -- "${filePath}"`;
    const diffOutput = runCommand(diffCommand, repoPath);
    if (diffOutput) {
      updatedLineNumbers.push(...parseDiff(diffOutput));
    }
  });
  return updatedLineNumbers;
}

// Extract test case ranges from a file
function getTestCasesLineNumbersByFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const code = fs.readFileSync(filePath, 'utf8');
  const ast = babelParser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const lineNumberRanges = [];
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (
        (callee.type === 'Identifier' && (callee.name === 'test' || callee.name === 'it')) ||
        (callee.type === 'MemberExpression' &&
          (callee.object.name === 'test' || callee.object.name === 'it') &&
          ['skip', 'only'].includes(callee.property.name))
      ) {
        const loc = path.node.loc;
        lineNumberRanges.push({
          start: loc.start.line,
          end: loc.end.line,
        });
      }
    },
  });

  return lineNumberRanges;
}

// Get updated test cases based on line changes
function getUpdatedTestCases(testCases, updateLines) {
  return testCases.filter(testCase =>
    updateLines.some(line => line >= testCase.start && line <= testCase.end)
  );
}

// Get total lines added by the author
function getTotalLinesByAuthor(commits, repoPath) {
  let totalLines = 0;
  commits.forEach(commit => {
    const diffCommand = `git show ${commit} --numstat`;
    const stdout = runCommand(diffCommand, repoPath);
    const addedLines = stdout
      .split('\n')
      .map(line => line.split('\t')[0])
      .filter(val => /^\d+$/.test(val))
      .reduce((sum, val) => sum + parseInt(val, 10), 0);
    totalLines += addedLines;
  });
  return totalLines;
}

// Main function
function main() {
  console.log(`Configuration:`);
  console.log(`  REPO_PATH: ${REPO_PATH}`);
  console.log(`  AUTHOR: ${AUTHOR}`);
  console.log(`  SINCE_DATE: ${SINCE_DATE}`);
  console.log(`  UNTIL_DATE: ${UNTIL_DATE}`);
  
  if (!REPO_PATH || !AUTHOR) {
    console.error('Error: REPO_PATH and AUTHOR must be set in environment variables');
    process.exit(1);
  }

  validateGitRepo(REPO_PATH);

  const commits = getCommits(REPO_PATH);
  if (commits.length === 0) {
    console.log('No commits found for the specified author and date range.');
    return;
  }

  const files = getListOfFiles(commits, REPO_PATH);
  const testCaseFiles = getTestCaseFiles(files);

  if (testCaseFiles.length === 0) {
    console.log('No test case files found.');
    return;
  }

  let updatedTestCases = [];
  testCaseFiles.forEach(file => {
    const filePath = path.join(REPO_PATH, file);
    console.log(`Processing test file: ${filePath}`);
    const testCases = getTestCasesLineNumbersByFile(filePath);
    const updatedLines = getTestCasesUpdatedLineNumbersByFile(file, commits, REPO_PATH);
    const updated = getUpdatedTestCases(testCases, updatedLines);
    console.log(`  Found ${testCases.length} test cases, ${updated.length} updated`);
    updatedTestCases.push(...updated);
  });

  const totalLines = getTotalLinesByAuthor(commits, REPO_PATH);
  console.log(`Total lines added by ${AUTHOR}: ${totalLines}`);
  console.log(`Updated/Added Test Cases by ${AUTHOR}: ${updatedTestCases.length}`);
}

main();
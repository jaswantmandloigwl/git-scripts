require('dotenv').config();
const fs = require('fs');
const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { execSync } = require('child_process');
const { minimatch } = require('minimatch');
const path = require('path');

const REPO_PATH = process.env.REPO_PATH; // Read from .env file
const AUTHOR = process.env.AUTHOR;      // Read from .env file
const SINCE_DATE = "2025-06-01";          // Start date for commit filtering
const UNTIL_DATE = "2025-06-30";          // End date for commit filtering




// Helper to run shell commands safely
function runCommand(command, cwd) {
  try {
    return execSync(command, { cwd, encoding: 'utf-8' }).trim();
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
  const logCommand = `git log --author="${AUTHOR}" --since="${SINCE_DATE}" --until="${UNTIL_DATE}" --pretty=format:"%H"`;
  const stdout = runCommand(logCommand, repoPath);
  return stdout ? stdout.split('\n') : [];
}

// Get list of files changed in commits
function getListOfFiles(commits, repoPath) {
  const files = new Set();
  commits.forEach(commit => {
    const showCommand = `git show --pretty="" --name-only ${commit}`;
    const stdout = runCommand(showCommand, repoPath);
    stdout.split('\n').forEach(file => files.add(file));
  });
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
    updatedLineNumbers.push(...parseDiff(diffOutput));
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
    const testCases = getTestCasesLineNumbersByFile(filePath);
    const updatedLines = getTestCasesUpdatedLineNumbersByFile(filePath, commits, REPO_PATH);
    const updated = getUpdatedTestCases(testCases, updatedLines);
    updatedTestCases.push(...updated);
  });

  const totalLines = getTotalLinesByAuthor(commits, REPO_PATH);
  console.log(`Total lines added by ${AUTHOR}: ${totalLines}`);
  console.log(`Updated/Added Test Cases by ${AUTHOR}: ${updatedTestCases.length}`);
}

main();
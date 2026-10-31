/**
 * Tests for the revert-checks CI step (scripts/revert-checks.sh).
 *
 * These tests verify that the revert-checks script correctly:
 * - Parses PR body for revert-check lines
 * - Reverts source files to base version
 * - Expects tests to fail when guarded code is reverted
 * - Reports malformed lines
 * - Never modifies the actual branch
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT_PATH = resolve(__dirname, '../../scripts/revert-checks.sh');

interface TestRepo {
  dir: string;
  cleanup: () => void;
}

/**
 * Creates a temporary git repository for testing.
 * Sets up a base branch with a source file, then creates
 * a PR branch with changes and a test file.
 */
function createTestRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), 'revert-checks-test-'));

  // Initialize git repo
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  // Create base state: a source file
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    join(srcDir, 'feature.ts'),
    `// Feature module
export function calculate(a: number, b: number): number {
  return a + b;
}
`
  );

  // Create a minimal package.json for npm test
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'test-repo',
        scripts: {
          test: 'node test.js',
        },
      },
      null,
      2
    )
  );

  // Create a test that will pass with the base code
  writeFileSync(
    join(dir, 'test.js'),
    `// Simple test runner
const fs = require('fs');
const content = fs.readFileSync('src/feature.ts', 'utf-8');
// Base version uses "a + b"
if (content.includes('a + b')) {
  console.log('Test passed');
  process.exit(0);
} else {
  console.log('Test failed: expected a + b');
  process.exit(1);
}
`
  );

  // Commit base state
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "Base commit"', { cwd: dir, stdio: 'pipe' });
  execSync('git branch base-branch', { cwd: dir, stdio: 'pipe' });

  // Create PR branch with changes
  execSync('git checkout -b pr-branch', { cwd: dir, stdio: 'pipe' });

  // Modify the source file
  writeFileSync(
    join(srcDir, 'feature.ts'),
    `// Feature module
export function calculate(a: number, b: number): number {
  // Changed: now multiplies instead of adds
  return a * b;
}
`
  );

  // Update the test to check for the new behavior
  writeFileSync(
    join(dir, 'test.js'),
    `// Simple test runner
const fs = require('fs');
const content = fs.readFileSync('src/feature.ts', 'utf-8');
// PR version uses "a * b"
if (content.includes('a * b')) {
  console.log('Test passed');
  process.exit(0);
} else {
  console.log('Test failed: expected a * b');
  process.exit(1);
}
`
  );

  // Commit PR changes
  execSync('git add .', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "PR: change add to multiply"', { cwd: dir, stdio: 'pipe' });

  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs the script and captures exit code (doesn't throw on non-zero).
 */
function runRevertChecksWithCode(
  repoDir: string,
  prBodyContent: string,
  baseRef: string
): { exitCode: number; stdout: string; stderr: string } {
  const prBodyFile = join(repoDir, 'pr-body.md');
  writeFileSync(prBodyFile, prBodyContent);

  try {
    const result = execSync(`bash "${SCRIPT_PATH}" "${prBodyFile}" "${baseRef}"`, {
      cwd: repoDir,
      stdio: 'pipe',
      timeout: 30000,
    });
    return {
      exitCode: 0,
      stdout: result.toString(),
      stderr: '',
    };
  } catch (error: unknown) {
    const execError = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: execError.status ?? 1,
      stdout: execError.stdout?.toString() ?? '',
      stderr: execError.stderr?.toString() ?? '',
    };
  }
}

describe('revert-checks script', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  describe('parsing', () => {
    it('finds revert-check lines in PR body', () => {
      const prBody = `
## Changes
This PR changes add to multiply.

revert-check: test.js guards src/feature.ts

## Testing
Manual testing done.
`;
      // This should find 1 check
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.stdout).toContain('Found 1 revert-check');
    });

    it('reports malformed revert-check lines', () => {
      const prBody = `
revert-check: missing-guards-keyword src/feature.ts
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Malformed');
    });

    it('handles PR body with no revert-check lines', () => {
      const prBody = `
## Changes
Just a simple doc update.
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No revert-check lines found');
    });

    it('parses line range format correctly', () => {
      const prBody = `
revert-check: test.js guards src/feature.ts:3-4
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      // Should find and process the check
      expect(result.stdout).toContain('Found 1 revert-check');
    });
  });

  describe('validation', () => {
    it('fails when guarded test still passes after revert', () => {
      // Create a bad test that passes regardless of the code change
      writeFileSync(
        join(repo.dir, 'bad-test.js'),
        `// This test doesn't actually guard the change
console.log('Test passed');
process.exit(0);
`
      );

      // Update package.json to run bad-test
      writeFileSync(
        join(repo.dir, 'package.json'),
        JSON.stringify({ name: 'test', scripts: { test: 'node bad-test.js' } }, null, 2)
      );

      const prBody = `
revert-check: bad-test.js guards src/feature.ts
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('REVERT-CHECK FAILED');
    });

    it('passes when guarded test fails after revert', () => {
      // The test.js in the repo is set up to fail when code is reverted
      // because it checks for "a * b" which becomes "a + b" after revert
      const prBody = `
revert-check: test.js guards src/feature.ts
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PASSED');
    });

    it('reports error for missing source file', () => {
      const prBody = `
revert-check: test.js guards src/nonexistent.ts
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Source file not found');
    });

    it('reports error for missing test file', () => {
      const prBody = `
revert-check: nonexistent.test.ts guards src/feature.ts
`;
      const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Test file not found');
    });
  });

  describe('branch safety', () => {
    it('does not modify the branch after running', () => {
      const prBody = `
revert-check: test.js guards src/feature.ts
`;

      // Get current HEAD before running
      const headBefore = execSync('git rev-parse HEAD', {
        cwd: repo.dir,
        encoding: 'utf-8',
      }).trim();

      // Run the check
      runRevertChecksWithCode(repo.dir, prBody, 'base-branch');

      // Verify HEAD is unchanged
      const headAfter = execSync('git rev-parse HEAD', {
        cwd: repo.dir,
        encoding: 'utf-8',
      }).trim();

      expect(headAfter).toBe(headBefore);

      // Verify no uncommitted changes
      const status = execSync('git status --porcelain', {
        cwd: repo.dir,
        encoding: 'utf-8',
      }).trim();

      // Only the pr-body.md file we created should show
      const nonPrBodyChanges = status
        .split('\n')
        .filter((line) => line && !line.includes('pr-body.md'));
      expect(nonPrBodyChanges).toHaveLength(0);
    });

    it('restores files after each check', () => {
      const prBody = `
revert-check: test.js guards src/feature.ts
`;

      runRevertChecksWithCode(repo.dir, prBody, 'base-branch');

      // Verify the source file is back to PR version
      const content = readFileSync(join(repo.dir, 'src/feature.ts'), 'utf-8');
      expect(content).toContain('a * b');
    });
  });

  describe('line-level revert', () => {
    it('reverts only specified lines', () => {
      // Set up a file where only certain lines change
      const srcPath = join(repo.dir, 'src', 'multi.ts');
      writeFileSync(
        srcPath,
        `line1
line2
line3-changed
line4
line5
`
      );
      execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
      execSync('git commit -m "Add multi line file"', { cwd: repo.dir, stdio: 'pipe' });

      // Create base version
      execSync('git checkout base-branch', { cwd: repo.dir, stdio: 'pipe' });
      writeFileSync(
        srcPath,
        `line1
line2
line3-original
line4
line5
`
      );
      execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
      execSync('git commit -m "Base multi line"', { cwd: repo.dir, stdio: 'pipe' });
      execSync('git checkout pr-branch', { cwd: repo.dir, stdio: 'pipe' });

      const prBody = `
revert-check: test.js guards src/multi.ts:3
`;

      // Run check
      runRevertChecksWithCode(repo.dir, prBody, 'base-branch');

      // After cleanup, file should be back to PR version
      const content = readFileSync(srcPath, 'utf-8');
      expect(content).toContain('line3-changed');
    });
  });
});

/**
 * Test that the script file exists and is executable.
 */
describe('self-validation', () => {
  it('script file exists and is executable', () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
    const stats = statSync(SCRIPT_PATH);
    // Check executable bit (owner)
    expect(stats.mode & 0o100).toBeTruthy();
  });
});

describe('CRLF handling', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('handles Windows-style CRLF line endings', () => {
    // Create PR body with CRLF line endings
    const prBody = 'Some description\r\nrevert-check: test.js guards src/feature.ts\r\n## More stuff\r\n';
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    // Should parse correctly and find the check
    expect(result.stdout).toContain('Found 1 revert-check');
    expect(result.exitCode).toBe(0);
  });

  it('handles mixed LF and CRLF line endings', () => {
    const prBody = 'Line one\nLine two\r\nrevert-check: test.js guards src/feature.ts\r\nLine four\n';
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    expect(result.stdout).toContain('Found 1 revert-check');
    expect(result.exitCode).toBe(0);
  });
});

describe('self-revert protection', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('rejects revert-check that targets the script itself', () => {
    // Create scripts directory and a copy of the revert-checks script
    mkdirSync(join(repo.dir, 'scripts'), { recursive: true });
    writeFileSync(
      join(repo.dir, 'scripts/revert-checks.sh'),
      '#!/bin/bash\necho "the script"\n'
    );
    execSync('git add scripts/', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Add scripts"', { cwd: repo.dir, stdio: 'pipe' });

    const prBody = `
revert-check: test.js guards scripts/revert-checks.sh
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Cannot revert the revert-checks script itself');
  });
});

describe('test spec validation', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('rejects test specs with shell metacharacters', () => {
    const prBody = `
revert-check: test.js; rm -rf / guards src/feature.ts
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    // Should be caught as malformed (the ; breaks the pattern)
    expect(result.exitCode).toBe(2);
  });

  it('rejects test specs with backticks', () => {
    // Even if it parsed, the test spec itself would be rejected
    const prBody = 'revert-check: `whoami`.test.ts guards src/feature.ts\n';
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    expect(result.exitCode).toBe(2);
  });
});

describe('code fence handling', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('ignores revert-check lines inside fenced code blocks', () => {
    const prBody = `
## Examples
\`\`\`
revert-check: example.test.ts guards src/example.ts
\`\`\`

## Real checks
revert-check: test.js guards src/feature.ts
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    // Should find only 1 check (the one outside the code fence)
    expect(result.stdout).toContain('Found 1 revert-check');
    expect(result.exitCode).toBe(0);
  });

  it('ignores revert-check lines inside fenced blocks with language tag', () => {
    const prBody = `
\`\`\`markdown
revert-check: example.test.ts guards src/example.ts
\`\`\`

revert-check: test.js guards src/feature.ts
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    expect(result.stdout).toContain('Found 1 revert-check');
    expect(result.exitCode).toBe(0);
  });

  it('handles multiple fenced code blocks', () => {
    const prBody = `
\`\`\`
revert-check: a.test.ts guards src/a.ts
\`\`\`

revert-check: test.js guards src/feature.ts

\`\`\`
revert-check: b.test.ts guards src/b.ts
\`\`\`
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    // Only the middle one should be found
    expect(result.stdout).toContain('Found 1 revert-check');
    expect(result.exitCode).toBe(0);
  });
});

describe('error handling', () => {
  let repo: TestRepo;

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  it('exits 2 when checks have mix of passes and errors', () => {
    // Set up an additional source file that exists
    const srcPath = join(repo.dir, 'src', 'exists.ts');
    writeFileSync(srcPath, 'export const x = 1;\n');
    execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Add exists.ts"', { cwd: repo.dir, stdio: 'pipe' });

    // Create base version
    execSync('git checkout base-branch', { cwd: repo.dir, stdio: 'pipe' });
    writeFileSync(srcPath, 'export const x = 0;\n');
    execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Base exists.ts"', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git checkout pr-branch', { cwd: repo.dir, stdio: 'pipe' });

    const prBody = `
revert-check: test.js guards src/feature.ts
revert-check: test.js guards src/nonexistent.ts
`;
    // One will pass (src/feature.ts exists), one will error (src/nonexistent.ts doesn't exist)
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Source file not found');
    expect(result.stdout).toContain('Errors: 1');
  });

  it('errors count propagate to non-zero exit even with passes', () => {
    // Create multiple source files
    const src1 = join(repo.dir, 'src', 'good.ts');
    writeFileSync(src1, 'export const good = "changed";\n');
    execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Add good.ts on PR"', { cwd: repo.dir, stdio: 'pipe' });

    // Base version
    execSync('git checkout base-branch', { cwd: repo.dir, stdio: 'pipe' });
    writeFileSync(src1, 'export const good = "original";\n');
    execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Base good.ts"', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git checkout pr-branch', { cwd: repo.dir, stdio: 'pipe' });

    // Update test to check for the good.ts change specifically
    writeFileSync(
      join(repo.dir, 'test.js'),
      `const fs = require('fs');
const feature = fs.readFileSync('src/feature.ts', 'utf-8');
const good = fs.readFileSync('src/good.ts', 'utf-8');
// Pass if feature has "a * b" and good has "changed"
if (feature.includes('a * b') && good.includes('changed')) {
  process.exit(0);
}
process.exit(1);
`
    );
    execSync('git add .', { cwd: repo.dir, stdio: 'pipe' });
    execSync('git commit -m "Update test"', { cwd: repo.dir, stdio: 'pipe' });

    const prBody = `
revert-check: test.js guards src/feature.ts
revert-check: test.js guards src/missing.ts
`;
    const result = runRevertChecksWithCode(repo.dir, prBody, 'base-branch');
    // Should exit 2 due to the error, even though one passed
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('Passed: 1');
    expect(result.stdout).toContain('Errors: 1');
  });
});

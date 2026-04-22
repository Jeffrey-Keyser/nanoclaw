# Git PR Helper Test Scenarios

Comprehensive test cases for `create-pr`, `merge-pr`, and `create-and-merge`.

## Setup

```bash
cd /home/jkeyser/nanoclaw
export PATH="$PATH:$(pwd)/scripts/git"
```

## create-pr Test Scenarios

### ✅ Happy Path

**Test 1.1: Create PR from local branch**
```bash
git checkout -b test-feature-001
echo "test" > test.txt
git add test.txt
git commit -m "test: add test file"
git push -u origin test-feature-001
create-pr test-feature-001
# Expected: PR URL printed, PR created successfully
```

**Test 1.2: Create PR with custom title**
```bash
create-pr test-feature-001 --title "feat: Custom Feature Title"
# Expected: PR created with specified title
```

**Test 1.3: Create PR with auto-merge**
```bash
create-pr test-feature-001 --auto-merge
# Expected: PR created with auto-merge enabled (if repo settings allow)
```

**Test 1.4: Create PR targeting different base**
```bash
create-pr test-feature-001 --base develop
# Expected: PR created targeting develop branch
```

### ⚠️ Edge Cases

**Test 2.1: Branch has no commits (true negative)**
```bash
git checkout -b test-no-commits
create-pr test-no-commits
# Expected: Clear error message with git log commands to debug
# Should show recent commits on both branches
```

**Test 2.2: Branch has no commits (false positive after rebase)**
```bash
git checkout -b test-rebased
echo "test" > test2.txt
git add test2.txt
git commit -m "test: before rebase"
git push -u origin test-rebased
git fetch origin main
git rebase origin/main
create-pr test-rebased
# Expected: Should fetch latest and re-check, then succeed
```

**Test 2.3: Branch exists in worktree**
```bash
git worktree add /tmp/test-worktree-branch test-feature-002
create-pr test-feature-002
# Expected: Warning about worktree with cleanup instructions
# Should still create PR successfully
```

**Test 2.4: PR already exists (open)**
```bash
create-pr test-feature-001  # Already created in Test 1.1
# Expected: Returns existing PR URL, no error
```

**Test 2.5: PR already exists (merged)**
```bash
merge-pr $(gh pr list --head test-feature-001 --json number --jq '.[0].number')
create-pr test-feature-001
# Expected: Returns merged PR URL, indicates already merged
```

**Test 2.6: Branch doesn't exist**
```bash
create-pr nonexistent-branch-xyz
# Expected: Clear error "Branch does not exist locally or on remote"
```

**Test 2.7: Branch only exists remotely**
```bash
git push origin main:test-remote-only
create-pr test-remote-only
# Expected: Creates PR from remote branch successfully
```

### 🔄 Retry Logic

**Test 3.1: Network timeout (simulated)**
```bash
# Simulate by disconnecting network briefly
create-pr test-feature-001
# Expected: Retries up to 3 times with exponential backoff
```

**Test 3.2: GitHub API rate limit**
```bash
# Make many rapid API calls to trigger rate limit, then:
create-pr test-feature-001
# Expected: Retries with backoff, shows "rate limit" message
```

**Test 3.3: Transient server error (502/503)**
```bash
# Can only be tested with gh CLI mocking or during actual GitHub incidents
# Expected: Should retry and eventually succeed
```

**Test 3.4: Non-retryable error (401 auth)**
```bash
gh auth logout
create-pr test-feature-001
# Expected: Fails immediately with authentication error and fix suggestion
gh auth login
```

**Test 3.5: Push failure with retry**
```bash
git checkout -b test-push-retry
echo "test" > test3.txt
git add test3.txt
git commit -m "test: push retry"
# Simulate network issue during push
create-pr test-push-retry
# Expected: Retries push up to 3 times
```

## merge-pr Test Scenarios

### ✅ Happy Path

**Test 4.1: Merge with squash (default)**
```bash
PR_NUM=$(create-pr test-feature-003 | grep -oE '[0-9]+$')
merge-pr $PR_NUM --squash
# Expected: PR merged with squash commit, branch deleted
```

**Test 4.2: Merge with merge commit**
```bash
PR_NUM=$(create-pr test-feature-004 | grep -oE '[0-9]+$')
merge-pr $PR_NUM --merge
# Expected: PR merged with merge commit
```

**Test 4.3: Merge with rebase**
```bash
PR_NUM=$(create-pr test-feature-005 | grep -oE '[0-9]+$')
merge-pr $PR_NUM --rebase
# Expected: PR merged with rebase
```

**Test 4.4: Merge keeping branch**
```bash
PR_NUM=$(create-pr test-feature-006 | grep -oE '[0-9]+$')
merge-pr $PR_NUM --no-delete-branch
# Expected: PR merged, branch not deleted
```

### ⚠️ Edge Cases

**Test 5.1: PR already merged**
```bash
merge-pr $PR_NUM  # Use a PR number that's already merged
# Expected: "PR is already merged", exits successfully
```

**Test 5.2: PR is closed (not merged)**
```bash
PR_NUM=$(create-pr test-feature-007 | grep -oE '[0-9]+$')
gh pr close $PR_NUM
merge-pr $PR_NUM
# Expected: Clear error "PR is closed (not merged)"
```

**Test 5.3: PR doesn't exist**
```bash
merge-pr 999999
# Expected: Clear error "PR not found"
```

**Test 5.4: PR has merge conflicts**
```bash
# Create conflicting changes and push
git checkout -b test-conflict-a
echo "version A" > conflict.txt
git add conflict.txt
git commit -m "test: version A"
git push -u origin test-conflict-a

git checkout main
echo "version B" > conflict.txt
git add conflict.txt
git commit -m "test: version B"
git push

PR_NUM=$(create-pr test-conflict-a | grep -oE '[0-9]+$')
merge-pr $PR_NUM
# Expected: Clear error about conflicts with resolution guidance
```

**Test 5.5: PR has failing CI checks**
```bash
# This requires a repo with CI configured to fail
# Expected: Waits for CI, then fails with clear error showing check status
```

### ⏱️ CI Wait Logic

**Test 6.1: CI checks pending → pass**
```bash
# Requires a repo with slow CI
PR_NUM=$(create-pr test-ci-pending | grep -oE '[0-9]+$')
merge-pr $PR_NUM
# Expected: Shows "Waiting for CI checks", polls every 10s, shows progress
```

**Test 6.2: CI timeout**
```bash
merge-pr $PR_NUM --ci-timeout 30
# Expected: Waits 30s, then warns and attempts merge anyway
```

**Test 6.3: CI API errors with retry**
```bash
# Simulate network issues during CI check
# Expected: Retries up to 3 times, distinguishes API errors from check failures
```

**Test 6.4: No CI checks configured**
```bash
PR_NUM=$(create-pr test-no-ci | grep -oE '[0-9]+$')
merge-pr $PR_NUM
# Expected: "No CI checks configured", merges immediately
```

### 🔄 Merge Retry Logic

**Test 7.1: Concurrent merge**
```bash
PR_NUM=$(create-pr test-concurrent | grep -oE '[0-9]+$')
# In another terminal: gh pr merge $PR_NUM --squash
merge-pr $PR_NUM
# Expected: Detects concurrent merge, reports success
```

**Test 7.2: Transient merge failure**
```bash
# Simulate network issue during merge
# Expected: Retries up to 3 times with backoff
```

**Test 7.3: Permission error**
```bash
# Use PR from a repo where you don't have merge permission
merge-pr $PR_NUM
# Expected: Clear error about permissions with fix suggestion
```

## create-and-merge Test Scenarios

### ✅ Happy Path

**Test 8.1: Create and merge in one step**
```bash
git checkout -b test-combined-001
echo "test" > combined.txt
git add combined.txt
git commit -m "test: combined operation"
create-and-merge test-combined-001
# Expected: PR created and merged successfully
```

**Test 8.2: With custom title and strategy**
```bash
create-and-merge test-combined-002 --title "feat: Custom Combined" --merge
# Expected: PR created with custom title and merged with merge commit
```

### ⚠️ Edge Cases

**Test 9.1: create-pr fails**
```bash
create-and-merge nonexistent-branch
# Expected: Fails at create-pr stage, no merge attempted
```

**Test 9.2: PR already merged**
```bash
create-and-merge test-combined-001  # Already merged in Test 8.1
# Expected: Detects already merged, skips merge step
```

**Test 9.3: Create succeeds, merge fails**
```bash
# Create PR with failing CI
create-and-merge test-failing-ci
# Expected: PR created successfully, merge fails with clear error and PR URL
```

## Success Metrics

Target: >90% success rate for valid operations

- **Retryable failures**: Should succeed after 1-3 retries
- **Non-retryable failures**: Should fail fast with clear error messages
- **Edge cases**: Should handle gracefully with helpful guidance
- **Concurrent operations**: Should detect and handle race conditions
- **API errors**: Should distinguish between transient and permanent errors

## Common Test Cleanup

```bash
# Delete test branches
git branch -D test-feature-* test-combined-* test-*
git push origin --delete test-feature-* test-combined-* test-* 2>/dev/null || true

# Prune remote refs
git remote prune origin

# Remove worktrees
git worktree remove /tmp/test-worktree-branch --force 2>/dev/null || true
```

## Automated Testing

For CI/CD integration:

```bash
#!/bin/bash
# run-pr-helper-tests.sh

set -euo pipefail

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local cmd="$2"
  local expected_exit="$3"

  echo "Running: $name"
  if eval "$cmd"; then
    if [[ "$expected_exit" == "0" ]]; then
      echo "  ✅ PASS"
      PASS=$((PASS + 1))
    else
      echo "  ❌ FAIL (expected failure)"
      FAIL=$((FAIL + 1))
    fi
  else
    if [[ "$expected_exit" == "1" ]]; then
      echo "  ✅ PASS (expected failure)"
      PASS=$((PASS + 1))
    else
      echo "  ❌ FAIL (unexpected failure)"
      FAIL=$((FAIL + 1))
    fi
  fi
}

# Add test cases here
run_test "Create PR - nonexistent branch" "create-pr nonexistent-xyz-123" "1"
run_test "Merge PR - nonexistent PR" "merge-pr 999999" "1"

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $([[ $FAIL -eq 0 ]] && echo 0 || echo 1)
```

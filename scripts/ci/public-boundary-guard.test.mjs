import assert from "node:assert/strict";
import test from "node:test";
import { findFindings, trackedFixturePaths } from "./public-boundary-guard.mjs";

test("detects secret material without printing its value", () => {
  assert.deepEqual(findFindings("apps/docs/dist/app.js", "const key = 'ghp_123456789012345678901234567890123456';"), ["github-token"]);
  assert.deepEqual(findFindings("apps/docs/dist/app.js", "const key = 'github_pat_123456789012345678901234567890123456';"), ["github-token"]);
});

test("detects private hosts and private IPs in generated content", () => {
  assert.deepEqual(findFindings("apps/docs/dist/app.js", "https://api.service.internal 10.2.3.4"), ["private-hostname", "private-ip"]);
});

test("checks fixtures for personal data but permits reserved example addresses", () => {
  assert.deepEqual(findFindings("packages/niho-cloud-contract/v1/security-cases.json", "test@example.com /Users/example/docs"), []);
  assert.deepEqual(findFindings("packages/niho-cloud-contract/v1/security-cases.json", "person@company.co /Users/alice/docs"), ["non-example-email", "absolute-user-path"]);
});

test("includes tracked fixture folders across Docs, shared packages, and editor code", () => {
  assert.deepEqual(trackedFixturePaths([
    "apps/docs/fixtures/sample.json",
    "apps/docs/test/fixtures/sample.txt",
    "packages/docs-core/fixtures/sample.json",
    "packages/docs-ui/src/editor/fixtures/sample.svg",
    "packages/docs-core/src/index.ts",
  ]), [
    "apps/docs/fixtures/sample.json",
    "apps/docs/test/fixtures/sample.txt",
    "packages/docs-core/fixtures/sample.json",
    "packages/docs-ui/src/editor/fixtures/sample.svg",
  ]);
});

test("does not apply fixture-only personal data patterns to ordinary source", () => {
  assert.deepEqual(findFindings("apps/docs/dist/app.js", "person@company.co /Users/example/docs"), []);
});

test("rejects privileged pull request triggers and workflow secret references", () => {
  assert.deepEqual(findFindings(".github/workflows/ci.yml", "pull_request_target:\n  env: ${{ secrets.API_KEY }}"), [
    "privileged-pull-request",
    "workflow-secret-reference",
  ]);
});

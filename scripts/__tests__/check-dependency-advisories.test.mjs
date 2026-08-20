// Phase 18 plan 01 (DEP-01, DEP-02, DEP-03). Regression suite for the
// dependency advisory gate: parser correctness against the committed real
// pre-fix audit report, and fail-closed registry handling.
//
// Mirrors scripts/__tests__/validate-alloy-config.test.mjs's own mix: the
// exported pure functions (collectAdvisories, selectBlockingFindings,
// formatFailureReport) are asserted on directly with the committed fixture
// and small inline synthetic auditReportVersion-2 objects; child-process
// substitution is reserved for the retry/fail-closed path only, via
// runNpmAuditWithRetries's injectable `runAudit` seam -- never a
// module-level mock.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BLOCKING_SEVERITIES,
  collectAdvisories,
  formatFailureReport,
  REPO_ROOT,
  runNpmAuditWithRetries,
  selectBlockingFindings,
} from "../check-dependency-advisories.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "../__fixtures__/dependency-advisories/pre-fix-audit.json");

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

describe("Test 1 -- collectAdvisories against the committed real pre-fix fixture", () => {
  it("yields exactly 9 blocking-severity records covering 7 distinct leaf packages", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const blocking = advisories.filter((a) => BLOCKING_SEVERITIES.has(a.severity));
    expect(blocking).toHaveLength(9);
    const distinctPackages = new Set(blocking.map((a) => a.package));
    expect(distinctPackages.size).toBe(7);
  });

  it("selectBlockingFindings(..., [], now) returns all 9 with an empty accept-list", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const findings = selectBlockingFindings(advisories, [], new Date());
    expect(findings).toHaveLength(9);
  });
});

describe("Test 2 -- compound parent contributes no advisory of its own", () => {
  it("attributes GHSA-395f-4hp3-45gv to shell-quote, and concurrently owns zero records", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const shellQuote = advisories.find((a) => a.advisoryId === "GHSA-395f-4hp3-45gv");
    expect(shellQuote?.package).toBe("shell-quote");
    const concurrentlyRecords = advisories.filter((a) => a.package === "concurrently");
    expect(concurrentlyRecords).toHaveLength(0);
  });
});

describe("Test 3 -- package-level rollup severity is never consulted", () => {
  it("postcss yields two records with distinct severities; only the high one is blocking", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const postcssRecords = advisories.filter((a) => a.package === "postcss");
    expect(postcssRecords).toHaveLength(2);
    const severities = postcssRecords.map((r) => r.severity).sort();
    expect(severities).toEqual(["high", "moderate"]);

    const moderateRecord = postcssRecords.find((r) => r.advisoryId === "GHSA-fxqj-rqcc-2cmp");
    expect(moderateRecord?.severity).toBe("moderate");

    const findings = selectBlockingFindings(advisories, [], new Date());
    const postcssFindings = findings.filter((f) => f.package === "postcss");
    expect(postcssFindings).toHaveLength(1);
    expect(postcssFindings[0].advisoryId).toBe("GHSA-r28c-9q8g-f849");
  });
});

describe("Test 4 -- cyclic via[] references terminate", () => {
  it("completes and yields each advisory once given a deliberate cycle", () => {
    const cyclic = {
      a: { name: "a", severity: "high", via: ["b"] },
      b: { name: "b", severity: "high", via: ["a", { url: "https://x/GHSA-aaaa-aaaa-aaaa", severity: "high", title: "t" }] },
    };
    const advisories = collectAdvisories(cyclic);
    expect(advisories).toHaveLength(1);
    expect(advisories[0].package).toBe("b");
    expect(advisories[0].advisoryId).toBe("GHSA-aaaa-aaaa-aaaa");
  });
});

describe("Test 5 -- moderate/low-only report yields zero blocking findings", () => {
  it("treats a moderate-and-low-only tree as a pass", () => {
    const vulnerabilities = {
      pkgA: { name: "pkgA", severity: "moderate", via: [{ url: "https://x/GHSA-mod0-mod0-mod0", severity: "moderate" }] },
      pkgB: { name: "pkgB", severity: "low", via: [{ url: "https://x/GHSA-low0-low0-low0", severity: "low" }] },
    };
    const advisories = collectAdvisories(vulnerabilities);
    const findings = selectBlockingFindings(advisories, [], new Date());
    expect(findings).toHaveLength(0);
  });
});

describe("Test 6 -- prototype-pollution-shaped key is inert", () => {
  it("does not mutate Object.prototype and does not throw on a __proto__-shaped key", () => {
    const malicious = JSON.parse(
      '{"__proto__": {"name": "__proto__", "severity": "high", "via": [{"url": "https://x/GHSA-evil-evil-evil", "severity": "high"}]}, "safe": {"name": "safe", "severity": "high", "via": [{"url": "https://x/GHSA-safe-safe-safe", "severity": "high"}]}}',
    );
    expect(() => collectAdvisories(malicious)).not.toThrow();
    const advisories = collectAdvisories(malicious);
    expect(advisories.some((a) => a.package === "safe")).toBe(true);
    // eslint-disable-next-line no-prototype-builtins
    expect(({}).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, "name")).toBe(false);
  });
});

describe("Test 7 -- runNpmAuditWithRetries parses a report delivered on a non-zero exit", () => {
  it("treats npm's normal 'found vulnerabilities' non-zero exit as a valid report, not a tool failure", () => {
    const report = { auditReportVersion: 2, vulnerabilities: { x: { name: "x", severity: "high", via: [] } } };
    let calls = 0;
    const runAudit = () => {
      calls += 1;
      const err = new Error("npm audit exited 1");
      err.stdout = JSON.stringify(report);
      throw err;
    };
    const result = runNpmAuditWithRetries(REPO_ROOT, 3, { runAudit });
    expect(result).toEqual(report);
    expect(calls).toBe(1);
  });
});

describe("Test 8 -- runNpmAuditWithRetries fails closed after exhausting retries", () => {
  it("retries the configured number of times on unparseable stdout, then throws naming the attempt count", () => {
    let calls = 0;
    const runAudit = () => {
      calls += 1;
      const err = new Error("registry unreachable");
      err.stdout = "";
      throw err;
    };
    expect(() => runNpmAuditWithRetries(REPO_ROOT, 3, { runAudit })).toThrowError(/3 attempt/);
    expect(calls).toBe(3);
  });

  it("never returns an empty report and never resolves to a pass", () => {
    const runAudit = () => {
      const err = new Error("registry unreachable");
      throw err; // no .stdout at all
    };
    expect(() => runNpmAuditWithRetries(REPO_ROOT, 2, { runAudit })).toThrowError(/FAILED CLOSED/);
  });
});

describe("Test 9 -- wrong auditReportVersion is a failed attempt, not a silent accept", () => {
  it("throws fail-closed after retries when the version never matches 2", () => {
    let calls = 0;
    const runAudit = () => {
      calls += 1;
      return JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} });
    };
    expect(() => runNpmAuditWithRetries(REPO_ROOT, 3, { runAudit })).toThrowError(/3 attempt/);
    expect(calls).toBe(3);
  });
});

describe("Test 10 -- selectBlockingFindings sorts by package name then advisory id", () => {
  it("orders deliberately shuffled input deterministically", () => {
    const advisories = [
      { package: "zeta", advisoryId: "GHSA-zzzz-zzzz-zzzz", severity: "high" },
      { package: "alpha", advisoryId: "GHSA-bbbb-bbbb-bbbb", severity: "high" },
      { package: "alpha", advisoryId: "GHSA-aaaa-aaaa-aaaa", severity: "high" },
    ];
    const findings = selectBlockingFindings(advisories, [], new Date());
    expect(findings.map((f) => `${f.package}:${f.advisoryId}`)).toEqual([
      "alpha:GHSA-aaaa-aaaa-aaaa",
      "alpha:GHSA-bbbb-bbbb-bbbb",
      "zeta:GHSA-zzzz-zzzz-zzzz",
    ]);
  });
});

describe("Test 11 -- formatFailureReport is actionable", () => {
  it("names the leaf package, GHSA id, severity, and a Remediation section", () => {
    const findings = [{ package: "shell-quote", advisoryId: "GHSA-395f-4hp3-45gv", severity: "high", title: "t", url: "https://x" }];
    const report = formatFailureReport(findings);
    expect(report).toMatch(/shell-quote/);
    expect(report).toMatch(/GHSA-395f-4hp3-45gv/);
    expect(report).toMatch(/Remediation:/);
    expect(report).toMatch(/npm audit fix/);
    expect(report).toMatch(/\.advisory-accept-list\.json/);
  });
});

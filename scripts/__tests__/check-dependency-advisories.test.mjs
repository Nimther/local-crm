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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCEPT_LIST_FILENAME,
  BLOCKING_SEVERITIES,
  collectAdvisories,
  formatFailureReport,
  loadAcceptList,
  MAX_EXPIRY_DAYS,
  MIN_JUSTIFICATION_LENGTH,
  REPO_ROOT,
  runNpmAuditWithRetries,
  selectBlockingFindings,
  validateAcceptListEntry,
} from "../check-dependency-advisories.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "../__fixtures__/dependency-advisories/pre-fix-audit.json");

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

// Plan 18-02: every date assertion in this file (including the pre-existing
// Tests 1/3/5/8/10 above, which originally read the live system clock for
// their `now` argument) is driven from this single injected `now` so the
// suite can never start failing on a future real-world date, and so no test
// reads the system clock (D-05).
function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}
function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}
const NOW = new Date(Date.UTC(2026, 0, 15));
const TODAY = toIsoDate(NOW);
const YESTERDAY = toIsoDate(addUtcDays(NOW, -1));
// `?? 90` is a load-time-only fallback so this module can still be imported
// (and the RED suite can still run and name the missing exports) before Task
// 2 defines MAX_EXPIRY_DAYS; Test 12 below independently pins the real
// exported value to 90, so the fallback never masks a wrong constant.
const TODAY_PLUS_MAX = toIsoDate(addUtcDays(NOW, MAX_EXPIRY_DAYS ?? 90));
const TODAY_PLUS_MAX_PLUS_ONE = toIsoDate(addUtcDays(NOW, (MAX_EXPIRY_DAYS ?? 90) + 1));

function baseValidAcceptListEntry(overrides = {}) {
  return {
    advisoryId: "GHSA-abcd-1234-efgh",
    package: "postcss",
    justification:
      "This finding lives entirely inside a build-time watcher path that never ships in the runtime " +
      "bundle; verified by tracing every import of the affected function and confirming none are " +
      "reachable at request time.",
    owner: "security-lead@example.com",
    expiry: TODAY_PLUS_MAX,
    ...overrides,
  };
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
    const findings = selectBlockingFindings(advisories, [], NOW);
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

    const findings = selectBlockingFindings(advisories, [], NOW);
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
    const findings = selectBlockingFindings(advisories, [], NOW);
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
    const findings = selectBlockingFindings(advisories, [], NOW);
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

// ---------------------------------------------------------------------------
// Plan 18-02 (DEP-03): accept-list schema validation. Everything below fails
// RED until validateAcceptListEntry, loadAcceptList, MAX_EXPIRY_DAYS,
// MIN_JUSTIFICATION_LENGTH and ACCEPT_LIST_FILENAME exist (Task 2).
// ---------------------------------------------------------------------------

describe("Test 12 -- accept-list constants", () => {
  it("ACCEPT_LIST_FILENAME matches the committed file name", () => {
    expect(ACCEPT_LIST_FILENAME).toBe(".advisory-accept-list.json");
  });

  it("MAX_EXPIRY_DAYS is the 90-day renewal cadence (D-05)", () => {
    expect(MAX_EXPIRY_DAYS).toBe(90);
  });

  it("MIN_JUSTIFICATION_LENGTH rejects a one-word entry but accepts a real reachability paragraph (D-06)", () => {
    expect(MIN_JUSTIFICATION_LENGTH).toBeGreaterThan("unreachable".length);
    expect(baseValidAcceptListEntry().justification.trim().length).toBeGreaterThanOrEqual(MIN_JUSTIFICATION_LENGTH);
  });
});

const MANDATORY_FIELDS = ["advisoryId", "package", "justification", "owner", "expiry"];

describe.each(MANDATORY_FIELDS)("Test 13 -- validateAcceptListEntry mandatory field: %s (D-04)", (field) => {
  it("rejects the entry when the field is missing, naming the field", () => {
    const entry = baseValidAcceptListEntry();
    delete entry[field];
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(field))).toBe(true);
  });

  it("rejects the entry when the field is an empty string, naming the field", () => {
    const entry = baseValidAcceptListEntry({ [field]: "" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(field))).toBe(true);
  });

  it("rejects the entry when the field is whitespace-only, naming the field", () => {
    const entry = baseValidAcceptListEntry({ [field]: "   " });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(field))).toBe(true);
  });

  it.each([123, null, [], {}])("rejects a non-string value (%j), naming the field", (badValue) => {
    const entry = baseValidAcceptListEntry({ [field]: badValue });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes(field))).toBe(true);
  });
});

describe("Test 14 -- justification length (D-06: the field IS the reachability analysis)", () => {
  it("rejects a justification shorter than MIN_JUSTIFICATION_LENGTH", () => {
    const short = "not reachable";
    expect(short.length).toBeLessThan(MIN_JUSTIFICATION_LENGTH);
    const entry = baseValidAcceptListEntry({ justification: short });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("justification"))).toBe(true);
  });

  it("accepts a genuine multi-sentence reachability analysis", () => {
    const entry = baseValidAcceptListEntry();
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems).toEqual([]);
  });
});

describe("Test 15 -- owner is email-shaped (D-07: a git author email)", () => {
  it("rejects a non-email owner", () => {
    const entry = baseValidAcceptListEntry({ owner: "not-an-email" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("owner"))).toBe(true);
  });

  it("accepts a plain email address", () => {
    const entry = baseValidAcceptListEntry({ owner: "person@example.com" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems).toEqual([]);
  });
});

describe("Test 16 -- advisoryId is GHSA-shaped", () => {
  it("rejects an advisoryId that is not GHSA-shaped", () => {
    const entry = baseValidAcceptListEntry({ advisoryId: "CVE-2026-12345" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("advisoryId"))).toBe(true);
  });

  it("accepts a well-formed GHSA id", () => {
    const entry = baseValidAcceptListEntry({ advisoryId: "GHSA-9999-8888-7777" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems).toEqual([]);
  });
});

describe("Test 17 -- expiry format", () => {
  it("rejects an expiry that is not YYYY-MM-DD", () => {
    const entry = baseValidAcceptListEntry({ expiry: "02/01/2026" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("expiry"))).toBe(true);
  });

  it("rejects an expiry shaped like a date but not a real calendar date", () => {
    const entry = baseValidAcceptListEntry({ expiry: "2026-02-30" });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("expiry"))).toBe(true);
  });
});

describe("Test 18 -- expiry boundaries against an injected now (D-05)", () => {
  it("rejects an expiry of yesterday as expired", () => {
    const entry = baseValidAcceptListEntry({ expiry: YESTERDAY });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("expiry"))).toBe(true);
  });

  it("accepts an expiry of exactly today -- the expiry date is inclusive", () => {
    const entry = baseValidAcceptListEntry({ expiry: TODAY });
    expect(validateAcceptListEntry(entry, NOW)).toEqual([]);
  });

  it("accepts an expiry of exactly today plus MAX_EXPIRY_DAYS", () => {
    const entry = baseValidAcceptListEntry({ expiry: TODAY_PLUS_MAX });
    expect(validateAcceptListEntry(entry, NOW)).toEqual([]);
  });

  it("rejects an expiry of today plus MAX_EXPIRY_DAYS plus one as exceeding the cap", () => {
    const entry = baseValidAcceptListEntry({ expiry: TODAY_PLUS_MAX_PLUS_ONE });
    const problems = validateAcceptListEntry(entry, NOW);
    expect(problems.some((p) => p.includes("expiry"))).toBe(true);
  });

  it("the expired rejection and the over-cap rejection carry distinct, distinguishable reasons", () => {
    const expiredProblems = validateAcceptListEntry(baseValidAcceptListEntry({ expiry: YESTERDAY }), NOW);
    const overCapProblems = validateAcceptListEntry(baseValidAcceptListEntry({ expiry: TODAY_PLUS_MAX_PLUS_ONE }), NOW);
    expect(expiredProblems).toHaveLength(1);
    expect(overCapProblems).toHaveLength(1);
    expect(expiredProblems[0]).not.toBe(overCapProblems[0]);
  });

  it("compares in UTC regardless of a now set near a UTC day boundary", () => {
    const nowNearUtcMidnight = new Date(Date.UTC(2026, 0, 15, 23, 59, 59));
    const entry = baseValidAcceptListEntry({ expiry: "2026-01-15" });
    expect(validateAcceptListEntry(entry, nowNearUtcMidnight)).toEqual([]);
  });
});

describe("Test 19 -- loadAcceptList file-level shape (D-04 file contract)", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "advisory-accept-list-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list and signals the file was absent, without throwing", () => {
    const missingPath = path.join(dir, "does-not-exist.json");
    expect(() => loadAcceptList(missingPath)).not.toThrow();
    const result = loadAcceptList(missingPath);
    expect(result.fileExisted).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("fails on unparseable JSON", () => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{not valid json", "utf8");
    const result = loadAcceptList(file);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("fails when entries is missing", () => {
    const file = path.join(dir, "no-entries.json");
    writeFileSync(file, JSON.stringify({}), "utf8");
    const result = loadAcceptList(file);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("fails when entries is an object rather than an array", () => {
    const file = path.join(dir, "entries-object.json");
    writeFileSync(file, JSON.stringify({ entries: {} }), "utf8");
    const result = loadAcceptList(file);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("fails on two entries sharing the same advisoryId and package, naming the duplicate pair", () => {
    const file = path.join(dir, "dup.json");
    const dupEntry = baseValidAcceptListEntry();
    writeFileSync(file, JSON.stringify({ entries: [dupEntry, { ...dupEntry }] }), "utf8");
    const result = loadAcceptList(file);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.includes(dupEntry.advisoryId) && p.includes(dupEntry.package))).toBe(true);
  });

  it("succeeds with zero entries and no failure on {\"entries\": []}", () => {
    const file = path.join(dir, "empty.json");
    writeFileSync(file, JSON.stringify({ entries: [] }), "utf8");
    const result = loadAcceptList(file);
    expect(result.fileExisted).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.problems).toEqual([]);
  });
});

describe("Test 20 -- end-to-end suppression through selectBlockingFindings", () => {
  it("a valid, unexpired entry suppresses exactly the finding whose advisoryId and package both match", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const target = advisories.find((a) => a.package === "shell-quote" && a.advisoryId === "GHSA-395f-4hp3-45gv");
    expect(target).toBeDefined();

    const findingsWithout = selectBlockingFindings(advisories, [], NOW);
    const acceptEntry = baseValidAcceptListEntry({ advisoryId: target.advisoryId, package: target.package });
    const findingsWith = selectBlockingFindings(advisories, [acceptEntry], NOW);

    expect(findingsWith).toHaveLength(findingsWithout.length - 1);
    expect(findingsWith.some((f) => f.package === target.package && f.advisoryId === target.advisoryId)).toBe(false);

    const expectedSurviving = findingsWithout
      .filter((f) => !(f.package === target.package && f.advisoryId === target.advisoryId))
      .map((f) => `${f.package}::${f.advisoryId}`);
    expect(findingsWith.map((f) => `${f.package}::${f.advisoryId}`)).toEqual(expectedSurviving);
  });

  it("an entry whose advisoryId matches but whose package does not, does NOT suppress the finding", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const target = advisories.find((a) => a.package === "shell-quote");
    const acceptEntry = baseValidAcceptListEntry({ advisoryId: target.advisoryId, package: "some-other-package" });
    const findings = selectBlockingFindings(advisories, [acceptEntry], NOW);
    expect(findings.some((f) => f.package === target.package && f.advisoryId === target.advisoryId)).toBe(true);
  });

  it("an entry whose package matches but whose advisoryId does not, does NOT suppress the finding", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const target = advisories.find((a) => a.package === "shell-quote");
    const acceptEntry = baseValidAcceptListEntry({ advisoryId: "GHSA-0000-1111-2222", package: target.package });
    const findings = selectBlockingFindings(advisories, [acceptEntry], NOW);
    expect(findings.some((f) => f.package === target.package && f.advisoryId === target.advisoryId)).toBe(true);
  });

  it("a valid entry matching no advisory in the current tree suppresses nothing and does not fail the run by itself", () => {
    const fixture = loadFixture();
    const advisories = collectAdvisories(fixture.vulnerabilities);
    const findingsWithout = selectBlockingFindings(advisories, [], NOW);
    const staleEntry = baseValidAcceptListEntry({ advisoryId: "GHSA-9999-9999-9999", package: "nonexistent-package" });
    const findingsWith = selectBlockingFindings(advisories, [staleEntry], NOW);
    expect(findingsWith).toHaveLength(findingsWithout.length);
  });
});

// ---------------------------------------------------------------------------
// CR-01 regression: selectBlockingFindings must apply the same UTC-day-
// inclusive expiry semantics validateAcceptListEntry does. Every test above
// this point pins `now` at exact UTC midnight (`NOW = Date.UTC(2026, 0,
// 15)`), which is the ONE instant where the old millisecond-precision
// comparison in selectBlockingFindings happened to agree with
// validateAcceptListEntry's UTC-day comparison -- masking the bug. These
// tests pin `now` to a non-midnight UTC time so the two can no longer
// silently diverge.
// ---------------------------------------------------------------------------

describe("Test 21 -- selectBlockingFindings expiry inclusivity matches validateAcceptListEntry at a non-midnight `now` (D-05, CR-01)", () => {
  const EXPIRY = "2026-01-15";
  const advisoriesFor = (severity = "high") => [{ package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity }];

  it("suppresses the finding at noon UTC on the expiry day, matching validateAcceptListEntry's own verdict", () => {
    const nowNoon = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    const entry = baseValidAcceptListEntry({ expiry: EXPIRY });
    expect(validateAcceptListEntry(entry, nowNoon)).toEqual([]);
    const findings = selectBlockingFindings(advisoriesFor(), [entry], nowNoon);
    expect(findings).toHaveLength(0);
  });

  it("still suppresses the finding one second before UTC midnight on the expiry day -- the bug expired it here", () => {
    const nowLateOnExpiryDay = new Date(Date.UTC(2026, 0, 15, 23, 59, 59));
    const entry = baseValidAcceptListEntry({ expiry: EXPIRY });
    expect(validateAcceptListEntry(entry, nowLateOnExpiryDay)).toEqual([]);
    const findings = selectBlockingFindings(advisoriesFor(), [entry], nowLateOnExpiryDay);
    expect(findings).toHaveLength(0);
  });

  it("expires the finding once `now`'s UTC day is strictly after the expiry day", () => {
    const nowNextDay = new Date(Date.UTC(2026, 0, 16, 0, 0, 1));
    const entry = baseValidAcceptListEntry({ expiry: EXPIRY });
    expect(validateAcceptListEntry(entry, nowNextDay).some((p) => p.includes("expiry"))).toBe(true);
    const findings = selectBlockingFindings(advisoriesFor(), [entry], nowNextDay);
    expect(findings).toHaveLength(1);
  });

  it("an unparseable expiry never covers a finding -- fails closed, not 'covers forever'", () => {
    const nowNoon = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    const entry = { ...baseValidAcceptListEntry(), expiry: "not-a-real-date" };
    const findings = selectBlockingFindings(advisoriesFor(), [entry], nowNoon);
    expect(findings).toHaveLength(1);
  });
});

describe("Test 22 -- BLOCKING_SEVERITIES lookup normalizes severity case (WR-01)", () => {
  it("treats a differently-cased severity ('High') as blocking, not silently non-blocking", () => {
    const advisories = [{ package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity: "High" }];
    const findings = selectBlockingFindings(advisories, [], NOW);
    expect(findings).toHaveLength(1);
  });

  it("treats an upper-case severity ('CRITICAL') as blocking", () => {
    const advisories = [{ package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity: "CRITICAL" }];
    const findings = selectBlockingFindings(advisories, [], NOW);
    expect(findings).toHaveLength(1);
  });

  it("treats a non-string severity as non-blocking without throwing", () => {
    const advisories = [{ package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity: undefined }];
    expect(() => selectBlockingFindings(advisories, [], NOW)).not.toThrow();
    const findings = selectBlockingFindings(advisories, [], NOW);
    expect(findings).toHaveLength(0);
  });
});

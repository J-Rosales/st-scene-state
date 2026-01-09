(() => {
  const FIXTURE_SLUGS = [
    "crosslegged_touch_chair",
    "two_people_handshake",
    "standing_to_sitting_transition",
    "implied_floor_support",
    "conflicting_posture_within_k",
    "object_pruning_salience"
  ];
  const EPSILON = 0.05;

  function normalizeTimestampKeys(obj) {
    if (Array.isArray(obj)) {
      return obj.map((item) => normalizeTimestampKeys(item));
    }
    if (obj && typeof obj === "object") {
      const result = {};
      Object.entries(obj).forEach(([key, value]) => {
        if (/updated_at|updated_at_iso|timestamp/i.test(key)) {
          return;
        }
        result[key] = normalizeTimestampKeys(value);
      });
      return result;
    }
    return obj;
  }

  function compareValues(expected, actual, path, diffs) {
    if (typeof expected !== typeof actual) {
      diffs.push(`${path}: type mismatch`);
      return;
    }
    if (typeof expected === "number") {
      const isConfidence = /confidence/i.test(path);
      if (isConfidence) {
        if (Math.abs(expected - actual) > EPSILON) {
          diffs.push(`${path}: confidence diff ${expected} vs ${actual}`);
        }
        return;
      }
      if (expected !== actual) {
        diffs.push(`${path}: value diff ${expected} vs ${actual}`);
      }
      return;
    }
    if (typeof expected === "string" || typeof expected === "boolean" || expected === null) {
      if (expected !== actual) {
        diffs.push(`${path}: value diff ${expected} vs ${actual}`);
      }
      return;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) {
        diffs.push(`${path}: expected array`);
        return;
      }
      if (expected.length !== actual.length) {
        diffs.push(`${path}: array length ${expected.length} vs ${actual.length}`);
        return;
      }
      expected.forEach((item, index) => {
        compareValues(item, actual[index], `${path}[${index}]`, diffs);
      });
      return;
    }
    if (expected && typeof expected === "object") {
      const expectedKeys = Object.keys(expected).sort();
      const actualKeys = Object.keys(actual).sort();
      if (expectedKeys.join(",") !== actualKeys.join(",")) {
        diffs.push(`${path}: keys mismatch ${expectedKeys.join(",")} vs ${actualKeys.join(",")}`);
        return;
      }
      expectedKeys.forEach((key) => {
        compareValues(expected[key], actual[key], `${path}.${key}`, diffs);
      });
    }
  }

  function diffSnapshots(expected, actual) {
    const diffs = [];
    compareValues(expected, actual, "root", diffs);
    return diffs;
  }

  async function fetchText(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}`);
    return response.text();
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}`);
    return response.json();
  }

  async function runAllFixtures(options = {}) {
    const baseUrl = options.baseUrl || "";
    const extractor = options.extractor;
    if (!extractor) {
      throw new Error("Fixture runner requires extractor function.");
    }
    const yamlUtils = window.STSceneStateInternal?.yamlUtils;
    if (!yamlUtils) {
      throw new Error("Fixture runner missing yaml utils.");
    }
    const results = [];
    let passed = 0;
    let failed = 0;

    for (const slug of FIXTURE_SLUGS) {
      const fixtureBase = `${baseUrl}/fixtures/${slug}`;
      try {
        const transcript = await fetchJson(`${fixtureBase}/transcript.json`);
        const expectedYaml = await fetchText(`${fixtureBase}/expected.yaml`);
        const expectedObjRaw = yamlUtils.parseSimpleYaml(expectedYaml);
        if (!expectedObjRaw) {
          throw new Error("Expected YAML parse failed.");
        }
        const overrides = {
          context_window_k: transcript.meta?.k,
          allow_implied_objects: transcript.meta?.allow_implied_objects,
          max_present_characters: transcript.meta?.max_present_characters
        };
        const extraction = await extractor(overrides, transcript);
        const actualObj = extraction.snapshotObj;
        const actualYaml = yamlUtils.dumpYaml(actualObj);
        const expectedObj = yamlUtils.stableClone(normalizeTimestampKeys(expectedObjRaw));
        const normalizedActual = yamlUtils.stableClone(normalizeTimestampKeys(actualObj));
        const diffs = diffSnapshots(expectedObj, normalizedActual);
        const ok = diffs.length === 0;
        if (ok) {
          passed += 1;
        } else {
          failed += 1;
        }
        results.push({
          slug,
          title: transcript.meta?.title || slug,
          passed: ok,
          diffs,
          expected_yaml: expectedYaml,
          actual_yaml: actualYaml
        });
      } catch (error) {
        failed += 1;
        results.push({
          slug,
          title: slug,
          passed: false,
          diffs: [error instanceof Error ? error.message : "Fixture error"],
          expected_yaml: "",
          actual_yaml: ""
        });
      }
    }

    const summary = {
      total: results.length,
      passed,
      failed
    };

    const reportLines = [
      `Fixture run: ${passed}/${summary.total} passed`,
      ""
    ];
    results.forEach((result) => {
      reportLines.push(`${result.passed ? "PASS" : "FAIL"}: ${result.slug}`);
      if (!result.passed) {
        reportLines.push(`  Diffs: ${result.diffs.slice(0, 5).join("; ")}`);
      }
    });

    return {
      summary,
      results,
      reportText: reportLines.join("\n")
    };
  }

  window.STSceneStateFixtureRunner = {
    runAllFixtures
  };
})();

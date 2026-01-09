# Fixture format

Each fixture lives in its own folder under `/fixtures/<slug>/` and contains:

- `transcript.json` (required)
- `expected.yaml` (required)
- `notes.md` (optional)

## transcript.json schema

```json
{
  "meta": {
    "title": "string",
    "k": 8,
    "allow_implied_objects": true,
    "max_present_characters": 4
  },
  "messages": [
    { "role": "user", "content": "string" },
    { "role": "assistant", "content": "string" }
  ]
}
```

- `k`, `allow_implied_objects`, and `max_present_characters` override extension defaults for the fixture.

## expected.yaml

The expected YAML should match the canonical snapshot structure, including:

- `schema_version`
- `meta`
- `agents`, `objects`, `supports`, `contacts`
- `narrative_projection`
- `conflicts`

Confidence values are compared with an epsilon (±0.05). Timestamp fields (such as `updated_at`) are ignored during comparison.

## Running fixtures

Enable **Developer mode** in the panel, then click **Run Fixtures**. A report will appear in the Developer section and is stored in extension settings for later review.

## Pass/fail criteria

A fixture passes when:

- Entities and IDs match expected output.
- Salience ordering and pruning are deterministic.
- Conflicts, supports, contacts, and anchors match.
- Only timestamp and confidence (within epsilon) differences are allowed.

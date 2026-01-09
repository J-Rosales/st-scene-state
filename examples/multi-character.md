# Example: Two characters interacting

**Recent messages (last K):**
- User: "Alex is standing near the table while Morgan kneels beside the crate."
- Assistant: "Morgan grips the crate handle with both hands."
- User: "Alex leans on the table, watching."

**Expected YAML snapshot (excerpt):**
```yaml
schema_version: pose-contact-spec-0.1
agents:
  - id: alex
    name: Alex
    present: true
    confidence: 0.8
    salience_score: 0.8
    posture:
      value: standing
      confidence: 0.7
    anchors:
      - name: torso
        supports:
          - target: objects/table
            confidence: 0.5
  - id: morgan
    name: Morgan
    present: true
    confidence: 0.9
    salience_score: 0.9
    posture:
      value: kneeling
      confidence: 0.8
    anchors:
      - name: both_hands
        contacts:
          - target: objects/crate
            kind: grip
            confidence: 0.8
objects:
  - id: table
    name: table
    type: furniture
    confidence: 0.7
  - id: crate
    name: crate
    type: container
    confidence: 0.8
narrative_projection:
  - text: Alex stands near the table, leaning on it while Morgan kneels by the crate and grips its handle.
    confidence: 0.7
```

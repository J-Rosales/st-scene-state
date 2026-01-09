# Example: Cross-legged on floor, touching chair

**Recent messages (last K):**
- User: "Rin sits cross-legged on the floor beside the chair."
- Assistant: "She steadies herself by resting her left hand on the chair leg."

**Expected YAML snapshot (excerpt):**
```yaml
schema_version: pose-contact-spec-0.1
agents:
  - id: rin
    name: Rin
    present: true
    confidence: 0.7
    salience_score: 0.9
    posture:
      value: crosslegged
      confidence: 0.7
    anchors:
      - name: left_hand
        contacts:
          - target: objects/chair
            kind: touch
            confidence: 0.6
objects:
  - id: chair
    name: chair
    type: furniture
    confidence: 0.8
  - id: floor
    name: floor
    type: surface
    confidence: 0.3
narrative_projection:
  - text: Rin sits cross-legged on the floor, steadying herself with a hand on a chair leg.
    confidence: 0.6
```

# Pose-Contact-Spec (vendored)

This directory contains a locally vendored snapshot of the pose-contact-spec
schema used by the st-scene-state extension. It is designed to be stable across
incremental updates and does not require network access at runtime.

## Update helper
When the extension is updated, replace `pose-contact-spec.schema.json` with the
new schema snapshot and update `SCHEMA_MANIFEST.json` with version/source
metadata. See `scripts/update-schema.sh` for a helper template.

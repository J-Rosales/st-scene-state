# Pose-Contact-Spec (vendored)

This directory contains a locally vendored, simplified snapshot of the pose-contact-spec
schema used by the st-scene-state extension. It is designed to be stable across
incremental updates and does not require network access at runtime.

## Update helper
When the extension is updated, replace `schema.yaml` with the new schema snapshot
and adjust `schema_version` accordingly. See `scripts/update-schema.sh` for a helper
template.

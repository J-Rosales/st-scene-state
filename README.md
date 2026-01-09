# st-scene-state

SillyTavern extension that infers and maintains a per-chat physical scene snapshot
(characters, posture, contacts, nearby objects) from the latest messages. It keeps
one canonical YAML snapshot per chat and optionally injects a short, clearly labeled,
non-authoritative summary into the prompt context.

## What this does
- Infers a pose-contact-spec inspired scene snapshot from the last K messages.
- Stores one snapshot per chat in chat metadata (not global storage).
- Shows a side panel with narrative projection + canonical YAML.
- Optionally injects a read-only scene summary into prompts.

## What this does NOT do
- Does not write story or dialogue.
- Does not advance plot or override canon.
- Does not invent details; implied details are low confidence only.
- Does not keep historical logs (only latest snapshot).

## How inference works
- **Context window (K):** last K messages (any role) are used for extraction.
- **Update cadence (N):** if N=0, update every message; otherwise update every N messages.
- **Confidence:** each extracted fact carries confidence [0..1].
- **Soft failure:** if YAML parsing fails, the prior snapshot is retained and the UI shows an error.

## Settings
- `context_window_k` (default 8): number of most recent messages to analyze.
- `update_every_n_messages` (default 0): cadence; 0 = update on every message.
- `allow_implied_objects` (default true): allow implied floor/ground/wall at low confidence.
- `max_present_characters` (default 4): hard cap for present character list.
- `inject_prompt` (default true): inject read-only summary into prompt context.
- `only_assistant_messages` (default false): only auto-refresh on assistant messages.

## Privacy note
The extractor prompt contains only the last K chat messages and optional prior snapshot
for continuity. This content is sent to the model for inference.

## Installation (SillyTavern)
1. Place this folder in your SillyTavern `extensions` directory.
2. Enable the extension in the SillyTavern UI.
3. Use the "Scene State" side panel to adjust settings and refresh.

## Vendored schema
The pose-contact-spec inspired schema snapshot is stored locally in:
- `schemas/pose-contact-spec/schema.yaml`

Use `scripts/update-schema.sh` to guide schema refreshes when updating the extension.

## Examples
See `examples/` for sample chat snippets and expected YAML.

## License
MIT

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
- Supports manual edits, pins, and locks for stability.
- Provides a developer fixture harness for evaluation.

## What this does NOT do
- Does not write story or dialogue.
- Does not advance plot or override canon.
- Does not invent details; implied details are low confidence only.
- Does not keep historical logs (only latest snapshot).

## How inference works
- **Context window (K):** last K messages (any role) are used for extraction.
- **Update cadence (N):** if N=0, update every message; otherwise update every N messages.
- **Confidence:** each extracted fact carries confidence [0..1].
- **Extraction mode:** conservative (default) or descriptive.
- **Soft failure:** if YAML parsing fails, a reformat-only pass is attempted, then the prior snapshot is retained with an error note.

## Settings
- `context_window_k` (default 8): number of most recent messages to analyze.
- `update_every_n_messages` (default 0): cadence; 0 = update on every message.
- `allow_implied_objects` (default true): allow implied floor/ground/wall at low confidence.
- `max_present_characters` (default 4): hard cap for present character list.
- `inject_prompt` (default true): inject read-only summary into prompt context.
- `only_assistant_messages` (default false): only auto-refresh on assistant messages.
- `extraction_mode` (default conservative): conservative vs descriptive extraction behavior.
- `max_chars_per_message` (default 3000): per-message truncation limit.
- `max_total_chars` (default 15000): total input budget across K messages.
- `strip_code_blocks` (default true): remove fenced code blocks from input.
- `strip_quotes` (default false): remove quoted lines (">") from input.
- `prompt_profile` (default auto): prompt variant per model provider.
- `max_inference_output_chars` (default 15000): output size guardrail.
- `developer_mode` (default false): show fixture runner tools.

## Pins, locks, and manual edits
- **Pins** keep character entities from being pruned by `max_present_characters`.
- **Locks** prevent posture/support updates unless explicit contradictions appear in recent messages.
- **Manual YAML edit** lets you apply a snapshot directly; future inference can overwrite unless entities are pinned/locked.

## Developer mode & fixtures
Enable **Developer mode** to access:
- **Run Fixtures**: executes all fixture transcripts and compares output.
- **Open Last Fixture Report**: shows the stored report in settings.

Fixture format and evaluation notes are in [`fixtures/README.md`](fixtures/README.md).

## Export actions
- **Copy canonical YAML**
- **Download snapshot YAML**
- **Copy JSON equivalent** (stable ordering)

## Privacy note
The extractor prompt contains only the last K chat messages and optional prior snapshot
for continuity. This content is sent to the model for inference.

## Installation (SillyTavern)
1. Place this folder in your SillyTavern `extensions` directory.
2. Enable the extension in the SillyTavern UI.
3. Use the "Scene State" side panel to adjust settings and refresh.

## Vendored schema
The pose-contact-spec inspired schema snapshot is stored locally in:
- `schemas/pose-contact-spec/pose-contact-spec.schema.json`

See `schemas/pose-contact-spec/SCHEMA_MANIFEST.json` for the version manifest.

## Examples
See `examples/` for sample chat snippets and expected YAML.

## License
MIT

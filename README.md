# st-scene-state

## What this does
Infers and maintains a canonical physical scene state (characters, pose, spatial relations, object interactions) from recent SillyTavern chat messages.

## What this does NOT do
- Does not write dialogue
- Does not advance plot
- Does not override user or model intent
- Does not guarantee correctness

## Architecture (high-level)
- Canonical scene state (machine-readable, authoritative)
- Narrative projection (optional, non-authoritative)
- Prompt injection (opt-in)

## Usage
- Automatic inference on new messages
- Manual refresh
- Slash commands (if enabled)

## Status
Experimental / WIP

## License
MIT

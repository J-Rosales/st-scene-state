(() => {
  const EXTENSION_NAME = "st-scene-state";
  const STORAGE_KEY = "stSceneState";
  const SCHEMA_VERSION = "pose-contact-spec-0.1";
  const DEFAULT_SETTINGS = {
    context_window_k: 8,
    update_every_n_messages: 0,
    allow_implied_objects: true,
    max_present_characters: 4,
    inject_prompt: true,
    only_assistant_messages: false,
    panel_open: false,
    extraction_mode: "conservative",
    max_chars_per_message: 3000,
    max_total_chars: 15000,
    strip_code_blocks: true,
    strip_quotes: false,
    developer_mode: false,
    prompt_profile: "auto",
    max_inference_output_chars: 15000,
    last_fixture_report: ""
  };
  const PRONOUN_NAMES = new Set([
    "he",
    "him",
    "his",
    "she",
    "her",
    "hers",
    "they",
    "them",
    "their",
    "theirs",
    "it",
    "its"
  ]);
  const SALIENCE_WEIGHTS = {
    recency: 0.4,
    interaction: 0.2,
    confidence: 0.3,
    explicit: 0.1
  };
  const PROMPT_PROFILES = {
    openai: {
      label: "OpenAI",
      instruction: "Be terse and exact. YAML only. No extra commentary."
    },
    anthropic: {
      label: "Anthropic",
      instruction: "Return only YAML. Do not wrap in markdown. Keep it minimal."
    },
    google: {
      label: "Google",
      instruction: "Strict YAML only, no backticks. Avoid verbosity."
    },
    generic: {
      label: "Generic",
      instruction: "Return strict YAML only, with minimal text."
    }
  };

  const state = {
    ui: {
      panel: null,
      panelWrapper: null,
      panelToggle: null,
      narrative: null,
      yaml: null,
      yamlEditor: null,
      yamlError: null,
      yamlWarning: null,
      status: null,
      indicator: null,
      cadence: null,
      promptStatus: null,
      error: null,
      timestamp: null,
      schemaVersion: null,
      devReport: null,
      devStatus: null,
      controls: {},
      sections: {}
    },
    runtime: {
      inferenceRunning: false,
      yamlEditMode: false,
      yamlDraft: "",
      lastFixtureReport: null
    }
  };

  const yamlUtils = (() => {
    function sanitizeForYaml(text) {
      const safe = (text || "").replace(/\r?\n/g, " ").trim();
      if (safe === "") return '""';
      if (/[:\[\]\{\}#&*!|>'"%@`]/.test(safe)) {
        return JSON.stringify(safe);
      }
      return safe;
    }

    function parseScalar(value) {
      if (value === "null") return null;
      if (value === "true") return true;
      if (value === "false") return false;
      if (!Number.isNaN(Number(value)) && value.trim() !== "") {
        return Number(value);
      }
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        return value.slice(1, -1);
      }
      return value;
    }

    function parseSimpleYaml(yamlText) {
      if (!yamlText || typeof yamlText !== "string") return null;
      const lines = yamlText.split(/\r?\n/);
      let index = 0;

      function nextNonEmpty(start) {
        for (let i = start; i < lines.length; i += 1) {
          const trimmed = lines[i].trim();
          if (trimmed && !trimmed.startsWith("#")) {
            return { line: lines[i], index: i };
          }
        }
        return null;
      }

      function parseBlock(startIndent) {
        let container = {};
        let asArray = false;

        while (index < lines.length) {
          const raw = lines[index];
          index += 1;
          if (!raw.trim() || raw.trim().startsWith("#")) continue;
          const indent = raw.match(/^ */)[0].length;
          if (indent < startIndent) {
            index -= 1;
            break;
          }
          const trimmed = raw.trim();
          if (trimmed.startsWith("- ")) {
            if (!asArray) {
              container = [];
              asArray = true;
            }
            const content = trimmed.slice(2);
            if (content.includes(":")) {
              const [key, ...rest] = content.split(":");
              const valuePart = rest.join(":").trim();
              const item = {};
              if (valuePart) {
                item[key.trim()] = parseScalar(valuePart);
                const next = nextNonEmpty(index);
                if (next && next.line.match(/^ */)[0].length > indent) {
                  const child = parseBlock(indent + 2);
                  Object.assign(item, child);
                }
                container.push(item);
              } else {
                const child = parseBlock(indent + 2);
                item[key.trim()] = child;
                container.push(item);
              }
            } else {
              container.push(parseScalar(content));
            }
            continue;
          }
          const colonIndex = trimmed.indexOf(":");
          if (colonIndex === -1) continue;
          const key = trimmed.slice(0, colonIndex).trim();
          const valuePart = trimmed.slice(colonIndex + 1).trim();
          if (valuePart) {
            container[key] = parseScalar(valuePart);
          } else {
            const next = nextNonEmpty(index);
            const child = parseBlock(indent + 2);
            if (next?.line.trim().startsWith("-")) {
              container[key] = Array.isArray(child) ? child : [child];
            } else {
              container[key] = child;
            }
          }
        }
        return container;
      }

      return parseBlock(0);
    }

    function stringifyScalar(value) {
      if (value === null || typeof value === "undefined") return "null";
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      if (value === "") return '""';
      const text = String(value);
      if (/[:\[\]\{\}#&*!|>'"%@`\n\r]/.test(text)) {
        return JSON.stringify(text);
      }
      return text;
    }

    function dumpYaml(value, indent = 0) {
      const pad = " ".repeat(indent);
      if (Array.isArray(value)) {
        return value
          .map((item) => {
            if (typeof item === "object" && item !== null) {
              const child = dumpYaml(item, indent + 2);
              return `${pad}- ${child.trimStart()}`;
            }
            return `${pad}- ${stringifyScalar(item)}`;
          })
          .join("\n");
      }
      if (typeof value === "object" && value !== null) {
        return Object.entries(value)
          .map(([key, val]) => {
            if (typeof val === "object" && val !== null) {
              const child = dumpYaml(val, indent + 2);
              return `${pad}${key}:\n${child}`;
            }
            return `${pad}${key}: ${stringifyScalar(val)}`;
          })
          .join("\n");
      }
      return `${pad}${stringifyScalar(value)}`;
    }

    function normalizeSnapshot(snapshotObj) {
      const normalized = snapshotObj && typeof snapshotObj === "object" ? snapshotObj : {};
      normalized.schema_version = normalized.schema_version || SCHEMA_VERSION;
      normalized.meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};
      normalized.agents = Array.isArray(normalized.agents) ? normalized.agents : [];
      normalized.objects = Array.isArray(normalized.objects) ? normalized.objects : [];
      normalized.supports = Array.isArray(normalized.supports) ? normalized.supports : [];
      normalized.contacts = Array.isArray(normalized.contacts) ? normalized.contacts : [];
      normalized.narrative_projection = Array.isArray(normalized.narrative_projection)
        ? normalized.narrative_projection
        : [];
      normalized.conflicts = Array.isArray(normalized.conflicts) ? normalized.conflicts : [];
      normalized.agents.forEach((agent) => {
        agent.anchors = Array.isArray(agent?.anchors) ? agent.anchors : [];
      });
      return normalized;
    }

    function buildSupportsAndContacts(snapshotObj) {
      const supports = [];
      const contacts = [];
      (snapshotObj.agents || []).forEach((agent) => {
        const source = agent?.id || agent?.name || "";
        (agent?.anchors || []).forEach((anchor) => {
          const anchorName = anchor?.name || "";
          (anchor?.supports || []).forEach((support) => {
            if (!support?.target) return;
            supports.push({
              source,
              anchor: anchorName,
              target: support.target,
              confidence: Number(support.confidence ?? 0.4)
            });
          });
          (anchor?.contacts || []).forEach((contact) => {
            if (!contact?.target) return;
            contacts.push({
              source,
              anchor: anchorName,
              target: contact.target,
              kind: contact.kind || "touch",
              confidence: Number(contact.confidence ?? 0.4)
            });
          });
        });
      });
      snapshotObj.supports = supports;
      snapshotObj.contacts = contacts;
    }

    function applyMeta(snapshotObj, metaPatch) {
      snapshotObj.meta = snapshotObj.meta && typeof snapshotObj.meta === "object" ? snapshotObj.meta : {};
      Object.assign(snapshotObj.meta, metaPatch);
    }

    function orderSnapshotKeys(snapshotObj) {
      const ordered = {
        schema_version: snapshotObj.schema_version,
        meta: snapshotObj.meta,
        agents: snapshotObj.agents,
        objects: snapshotObj.objects,
        supports: snapshotObj.supports,
        contacts: snapshotObj.contacts,
        narrative_projection: snapshotObj.narrative_projection,
        conflicts: snapshotObj.conflicts
      };
      return ordered;
    }

    function canonicalizeSnapshot(snapshotObj, metaPatch) {
      const normalized = normalizeSnapshot(snapshotObj);
      if (metaPatch) {
        applyMeta(normalized, metaPatch);
      }
      buildSupportsAndContacts(normalized);
      return orderSnapshotKeys(normalized);
    }

    function stableClone(value) {
      if (Array.isArray(value)) {
        return value.map((item) => stableClone(item));
      }
      if (value && typeof value === "object") {
        const sortedKeys = Object.keys(value).sort();
        const clone = {};
        sortedKeys.forEach((key) => {
          clone[key] = stableClone(value[key]);
        });
        return clone;
      }
      return value;
    }

    return {
      sanitizeForYaml,
      parseSimpleYaml,
      dumpYaml,
      canonicalizeSnapshot,
      stableClone,
      normalizeSnapshot
    };
  })();

  function getExtensionSettings() {
    if (!window.extension_settings) {
      window.extension_settings = {};
    }
    if (!window.extension_settings[EXTENSION_NAME]) {
      window.extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    }
    const settings = window.extension_settings[EXTENSION_NAME];
    Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => {
      if (typeof settings[key] === "undefined") {
        settings[key] = value;
      }
    });
    return settings;
  }

  function saveSettings() {
    if (typeof window.saveSettingsDebounced === "function") {
      window.saveSettingsDebounced();
    }
  }

  function getContextSafe() {
    if (window.SillyTavern?.getContext) {
      return window.SillyTavern.getContext();
    }
    if (typeof window.getContext === "function") {
      return window.getContext();
    }
    return null;
  }

  function getChatMetadata() {
    const context = getContextSafe();
    if (!context) return null;
    if (!context.chatMetadata) {
      context.chatMetadata = {};
    }
    return context.chatMetadata;
  }

  function getChatState() {
    const chatMetadata = getChatMetadata();
    if (!chatMetadata) return null;
    if (!chatMetadata[STORAGE_KEY]) {
      const settings = getExtensionSettings();
      chatMetadata[STORAGE_KEY] = {
        schema_version: SCHEMA_VERSION,
        updated_at_iso: null,
        context_window_k: settings.context_window_k,
        update_every_n_messages: settings.update_every_n_messages,
        countdown_remaining: settings.update_every_n_messages,
        max_present_characters: settings.max_present_characters,
        allow_implied_objects: settings.allow_implied_objects,
        snapshot_yaml: "",
        snapshot_obj: null,
        narrative_lines: [],
        last_error: null,
        last_success: null,
        pinned_entity_ids: [],
        locks: {}
      };
    }
    const chatState = chatMetadata[STORAGE_KEY];
    if (!Array.isArray(chatState.pinned_entity_ids)) {
      chatState.pinned_entity_ids = [];
    }
    if (!chatState.locks || typeof chatState.locks !== "object") {
      chatState.locks = {};
    }
    return chatState;
  }

  function persistChatState(patch) {
    const chatState = getChatState();
    if (!chatState) return;
    Object.assign(chatState, patch);
  }

  function getEventSource() {
    return window.SillyTavern?.eventSource || window.eventSource;
  }

  function getEventTypes() {
    return window.SillyTavern?.eventTypes || window.event_types;
  }

  function getChatMessages() {
    const context = getContextSafe();
    if (!context?.chat) return [];
    return context.chat.map((message) => {
      const role = message.is_user
        ? "user"
        : message.is_system
        ? "system"
        : "assistant";
      return {
        role,
        name: message.name || message.user || message.author || "",
        content: message.mes || message.content || ""
      };
    });
  }

  function normalizeSettingsToState(chatState) {
    const settings = getExtensionSettings();
    persistChatState({
      context_window_k: settings.context_window_k,
      update_every_n_messages: settings.update_every_n_messages,
      max_present_characters: settings.max_present_characters,
      allow_implied_objects: settings.allow_implied_objects
    });
    if (
      chatState &&
      settings.update_every_n_messages !== chatState.update_every_n_messages
    ) {
      persistChatState({
        countdown_remaining: settings.update_every_n_messages
      });
    }
  }

  function preprocessMessages(messages, settings, overrides = {}) {
    const k = Number(overrides.context_window_k ?? settings.context_window_k);
    const stripCode = Boolean(overrides.strip_code_blocks ?? settings.strip_code_blocks);
    const stripQuotes = Boolean(overrides.strip_quotes ?? settings.strip_quotes);
    const maxPer = Number(overrides.max_chars_per_message ?? settings.max_chars_per_message);
    const maxTotal = Number(overrides.max_total_chars ?? settings.max_total_chars);
    let processed = messages.slice(-k).map((msg) => {
      let content = String(msg.content || "");
      if (stripCode) {
        content = content.replace(/```[\s\S]*?```/g, " ");
        content = content.replace(/~~~[\s\S]*?~~~/g, " ");
      }
      if (stripQuotes) {
        content = content
          .split(/\r?\n/)
          .filter((line) => !line.trim().startsWith(">"))
          .join("\n");
      }
      content = content.replace(/\s+/g, " ").trim();
      if (maxPer > 0 && content.length > maxPer) {
        const marker = "…";
        const available = Math.max(0, maxPer - marker.length);
        const head = Math.ceil(available / 2);
        const tail = Math.floor(available / 2);
        content = `${content.slice(0, head)}${marker}${content.slice(-tail)}`;
      }
      return { ...msg, content };
    });
    let totalChars = processed.reduce((sum, msg) => sum + msg.content.length, 0);
    let dropped = false;
    if (maxTotal > 0) {
      while (processed.length > 1 && totalChars > maxTotal) {
        const removed = processed.shift();
        totalChars -= removed.content.length;
        dropped = true;
      }
    }
    const wasTruncated = processed.some((msg) => msg.content.includes("…"));
    return {
      messages: processed,
      totalChars,
      wasTruncated,
      wasDropped: dropped
    };
  }

  function getPromptProfile(settings) {
    const selected = settings.prompt_profile || "auto";
    if (selected !== "auto") return selected;
    const context = getContextSafe();
    const provider =
      context?.settings?.chatCompletionSource ||
      context?.settings?.model?.provider ||
      context?.settings?.model?.source ||
      window.SillyTavern?.model?.provider ||
      "";
    const normalized = String(provider).toLowerCase();
    if (normalized.includes("openai") || normalized.includes("gpt")) return "openai";
    if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
    if (normalized.includes("google") || normalized.includes("gemini")) return "google";
    return "generic";
  }

  function buildPromptProfileInstruction(profile) {
    const instructions = PROMPT_PROFILES[profile] || PROMPT_PROFILES.generic;
    return instructions.instruction;
  }

  function buildExtractionPrompt(messages, chatState, overrides = {}) {
    const settings = getExtensionSettings();
    const extractionMode = overrides.extraction_mode || settings.extraction_mode;
    const allowImplied =
      typeof overrides.allow_implied_objects === "boolean"
        ? overrides.allow_implied_objects
        : settings.allow_implied_objects;
    const maxPresent = overrides.max_present_characters ?? settings.max_present_characters;
    const k = overrides.context_window_k ?? settings.context_window_k;
    const preprocess = preprocessMessages(messages, settings, overrides);
    const formattedMessages = preprocess.messages
      .map((msg) => `- role: ${msg.role}\n  content: ${yamlUtils.sanitizeForYaml(msg.content)}`)
      .join("\n");

    const profile = getPromptProfile(settings);
    const truncationNote = preprocess.wasTruncated || preprocess.wasDropped
      ? "Messages may be truncated; do not infer missing details."
      : "";

    return [
      "You are a scene-state extraction engine.",
      buildPromptProfileInstruction(profile),
      "Output strict YAML only (no code fences, no markdown).",
      "Do not invent details. Omit unknowns or set low confidence (<=0.4).",
      "Use character names as they appear. Do not create new names.",
      "Do not create new objects unless allow_implied_objects is true and mode rules allow.",
      "Include confidence for every stated fact.",
      `Extraction mode: ${extractionMode}.`,
      `Max present characters: ${maxPresent}.`,
      `Allow implied objects: ${allowImplied ? "true" : "false"}.`,
      "Conservative mode: only explicit or strongly implied facts. If uncertain, omit.",
      "Descriptive mode: allow baseline surfaces when implied by posture; keep low confidence.",
      truncationNote,
      "Schema:",
      "schema_version: string",
      "meta: { updated_at, extraction_mode, k, allow_implied_objects, max_present_characters }",
      "agents: [ { id, name, present, confidence, salience_score, posture: { value, confidence }, anchors: [ { name, contacts: [ { target, kind, confidence } ], supports: [ { target, confidence } ] } ] } ]",
      "objects: [ { id, name, type, confidence, salience_score } ]",
      "supports: [ { source, anchor, target, confidence } ]",
      "contacts: [ { source, anchor, target, kind, confidence } ]",
      "narrative_projection: [ { text, confidence } ]",
      "conflicts: [ { entity_id, note, confidence } ]",
      "Salience scoring: prioritize recent mentions in the last K messages (extra weight for last message), interaction (contacts/supports), confidence mass, and explicit naming.",
      "If an agent/object was present in the prior snapshot with the same name, reuse the same id (case-insensitive).",
      "If posture/support changed but uncertain, reduce confidence instead of hard switches.",
      "Prune to max_present_characters using salience (keep the most salient).",
      "If allow_implied_objects is false, do not create baseline surfaces.",
      "Messages:",
      formattedMessages,
      "Current snapshot (optional, for continuity only; do not assume it is true):",
      chatState?.snapshot_yaml ? chatState.snapshot_yaml : "null"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildReformatPrompt(rawText) {
    return [
      "You are a YAML formatter.",
      "Return ONLY valid YAML that matches the schema. No code fences.",
      "Do not add, remove, or infer any content. Only reformat the text below.",
      "Schema:",
      "schema_version: string",
      "meta: { updated_at, extraction_mode, k, allow_implied_objects, max_present_characters }",
      "agents: [ ... ]",
      "objects: [ ... ]",
      "supports: [ ... ]",
      "contacts: [ ... ]",
      "narrative_projection: [ ... ]",
      "conflicts: [ ... ]",
      "Raw text:",
      rawText
    ].join("\n");
  }

  function extractNarrativeLines(snapshotObj, snapshotYaml) {
    if (snapshotObj?.narrative_projection?.length) {
      return snapshotObj.narrative_projection.map((line) => ({
        text: line.text || "",
        confidence: Number(line.confidence ?? 0.4)
      }));
    }
    if (!snapshotYaml) return [];
    const lines = snapshotYaml.split(/\r?\n/);
    const narrativeLines = [];
    let inNarrative = false;
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("narrative_projection:")) {
        inNarrative = true;
        continue;
      }
      if (!inNarrative) continue;
      if (!trimmed.startsWith("-")) {
        if (trimmed && !trimmed.startsWith("#")) break;
        continue;
      }
      const textMatch = trimmed.match(/text:\s*(.+)$/);
      const confMatch = trimmed.match(/confidence:\s*([0-9.]+)/);
      if (textMatch) {
        narrativeLines.push({
          text: textMatch[1].replace(/^"|"$/g, ""),
          confidence: confMatch ? Number(confMatch[1]) : 0.4
        });
      }
    }
    return narrativeLines;
  }

  async function generateInference(prompt) {
    if (window.SillyTavern?.generateQuietPrompt) {
      return window.SillyTavern.generateQuietPrompt(prompt, {
        stream: false,
        stop: []
      });
    }
    if (typeof window.generateQuietPrompt === "function") {
      return window.generateQuietPrompt(prompt, { stream: false });
    }
    const context = window.SillyTavern?.getContext?.();
    if (context?.generateQuietPrompt) {
      return context.generateQuietPrompt(prompt, {
        stream: false,
        stop: []
      });
    }
    throw new Error("generateQuietPrompt API not available.");
  }

  function normalizeEntityName(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function buildStableId(prefix, name, index) {
    const slug = normalizeEntityName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (slug) return `${prefix}-${slug}`;
    return `${prefix}-unknown-${index}`;
  }

  function buildEntityLookup(entities) {
    const lookup = new Map();
    const list = Array.isArray(entities) ? entities : [];
    list.forEach((entity) => {
      const key = normalizeEntityName(entity?.name);
      if (!key) return;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key).push(entity);
    });
    return lookup;
  }

  function compareBySalienceThenName(a, b) {
    const scoreA = Number(a?.salience_score ?? a?.confidence ?? 0);
    const scoreB = Number(b?.salience_score ?? b?.confidence ?? 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const nameA = normalizeEntityName(a?.name);
    const nameB = normalizeEntityName(b?.name);
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  }

  function selectEntityMatch(normalizedName, priorByName, priorBySalience, rawName) {
    if (!normalizedName) return null;
    const matches = priorByName.get(normalizedName) || [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return matches.slice().sort(compareBySalienceThenName)[0];
    }
    if (isPronounName(rawName)) {
      return priorBySalience[0] || null;
    }
    return null;
  }

  function isPronounName(name) {
    const normalized = normalizeEntityName(name);
    return PRONOUN_NAMES.has(normalized);
  }

  function applyContinuity(snapshotObj, previousObj) {
    const previousAgents = Array.isArray(previousObj?.agents) ? previousObj.agents : [];
    const previousObjects = Array.isArray(previousObj?.objects) ? previousObj.objects : [];
    if (snapshotObj?.agents && Array.isArray(snapshotObj.agents)) {
      const priorByName = buildEntityLookup(previousAgents);
      const priorBySalience = [...previousAgents].sort(compareBySalienceThenName);
      snapshotObj.agents.forEach((agent, index) => {
        if (!agent) return;
        const name = normalizeEntityName(agent.name);
        if (name) {
          const match = selectEntityMatch(name, priorByName, priorBySalience, agent.name);
          if (match?.id) {
            agent.id = match.id;
          }
        }
        if (!agent.id) {
          agent.id = buildStableId("agent", agent.name, index);
        }
      });
    }
    if (snapshotObj?.objects && Array.isArray(snapshotObj.objects)) {
      const priorByName = buildEntityLookup(previousObjects);
      const priorBySalience = [...previousObjects].sort(compareBySalienceThenName);
      snapshotObj.objects.forEach((object, index) => {
        if (!object) return;
        const name = normalizeEntityName(object.name);
        if (name) {
          const match = selectEntityMatch(name, priorByName, priorBySalience, object.name);
          if (match?.id) {
            object.id = match.id;
          }
        }
        if (!object.id) {
          object.id = buildStableId("object", object.name, index);
        }
      });
    }
  }

  function countMentions(recentText, name) {
    return recentText.reduce((sum, text) => sum + (text.includes(name) ? 1 : 0), 0);
  }

  function countAgentInteractions(agent) {
    if (!agent?.anchors || !Array.isArray(agent.anchors)) return 0;
    return agent.anchors.reduce((sum, anchor) => {
      return sum + (anchor?.contacts?.length || 0) + (anchor?.supports?.length || 0);
    }, 0);
  }

  function sumAgentConfidenceMass(agent) {
    let total = Number(agent?.confidence ?? 0);
    total += Number(agent?.posture?.confidence ?? 0);
    if (agent?.anchors && Array.isArray(agent.anchors)) {
      agent.anchors.forEach((anchor) => {
        (anchor?.contacts || []).forEach((contact) => {
          total += Number(contact?.confidence ?? 0);
        });
        (anchor?.supports || []).forEach((support) => {
          total += Number(support?.confidence ?? 0);
        });
      });
    }
    return total;
  }

  function countObjectInteractions(agents, object) {
    if (!agents || !Array.isArray(agents)) return 0;
    const objectKey = normalizeEntityName(object?.name || object?.id);
    if (!objectKey) return 0;
    return agents.reduce((sum, agent) => {
      return sum + countObjectMentionsInAgent(agent, objectKey);
    }, 0);
  }

  function sumObjectConfidenceMass(object, agents) {
    let total = Number(object?.confidence ?? 0);
    if (!agents || !Array.isArray(agents)) return total;
    const objectKey = normalizeEntityName(object?.name || object?.id);
    if (!objectKey) return total;
    agents.forEach((agent) => {
      (agent?.anchors || []).forEach((anchor) => {
        (anchor?.contacts || []).forEach((contact) => {
          if (normalizeEntityName(contact?.target) === objectKey) {
            total += Number(contact?.confidence ?? 0);
          }
        });
        (anchor?.supports || []).forEach((support) => {
          if (normalizeEntityName(support?.target) === objectKey) {
            total += Number(support?.confidence ?? 0);
          }
        });
      });
    });
    return total;
  }

  function countObjectMentionsInAgent(agent, objectKey) {
    if (!agent?.anchors || !Array.isArray(agent.anchors)) return 0;
    return agent.anchors.reduce((sum, anchor) => {
      const contacts = (anchor?.contacts || []).filter(
        (contact) => normalizeEntityName(contact?.target) === objectKey
      ).length;
      const supports = (anchor?.supports || []).filter(
        (support) => normalizeEntityName(support?.target) === objectKey
      ).length;
      return sum + contacts + supports;
    }, 0);
  }

  function computeSalienceScores(snapshotObj, messages) {
    if (!snapshotObj) return;
    const settings = getExtensionSettings();
    const windowed = messages.slice(-settings.context_window_k);
    const recentText = windowed.map((msg) => String(msg.content || "").toLowerCase());
    const lastMessageText = recentText[recentText.length - 1] || "";
    if (snapshotObj.agents && Array.isArray(snapshotObj.agents)) {
      snapshotObj.agents.forEach((agent) => {
        const name = normalizeEntityName(agent?.name);
        const mentionCount = name ? countMentions(recentText, name) : 0;
        const lastMention = name && lastMessageText.includes(name) ? 1 : 0;
        const recencyScore = Math.min(
          1,
          (mentionCount / Math.max(1, recentText.length)) * 0.7 + lastMention * 0.3
        );
        const interactionCount = countAgentInteractions(agent);
        const interactionScore = Math.min(1, interactionCount / 6);
        const confidenceMass = sumAgentConfidenceMass(agent);
        const confidenceScore = Math.min(1, confidenceMass / 3);
        const explicitBonus = mentionCount > 0 ? 1 : 0;
        const score =
          recencyScore * SALIENCE_WEIGHTS.recency +
          interactionScore * SALIENCE_WEIGHTS.interaction +
          confidenceScore * SALIENCE_WEIGHTS.confidence +
          explicitBonus * SALIENCE_WEIGHTS.explicit;
        agent.salience_score = Number(score.toFixed(3));
      });
    }
    if (snapshotObj.objects && Array.isArray(snapshotObj.objects)) {
      snapshotObj.objects.forEach((object) => {
        const name = normalizeEntityName(object?.name);
        const mentionCount = name ? countMentions(recentText, name) : 0;
        const lastMention = name && lastMessageText.includes(name) ? 1 : 0;
        const recencyScore = Math.min(
          1,
          (mentionCount / Math.max(1, recentText.length)) * 0.7 + lastMention * 0.3
        );
        const interactionCount = countObjectInteractions(snapshotObj.agents, object);
        const interactionScore = Math.min(1, interactionCount / 6);
        const confidenceMass = sumObjectConfidenceMass(object, snapshotObj.agents);
        const confidenceScore = Math.min(1, confidenceMass / 3);
        const explicitBonus = mentionCount > 0 ? 1 : 0;
        const score =
          recencyScore * SALIENCE_WEIGHTS.recency +
          interactionScore * SALIENCE_WEIGHTS.interaction +
          confidenceScore * SALIENCE_WEIGHTS.confidence +
          explicitBonus * SALIENCE_WEIGHTS.explicit;
        object.salience_score = Number(score.toFixed(3));
      });
    }
  }

  function findLastMentionIndex(recentText, term) {
    if (!term) return null;
    const normalized = normalizeEntityName(term);
    if (!normalized) return null;
    for (let i = recentText.length - 1; i >= 0; i -= 1) {
      if (recentText[i].includes(normalized)) {
        return i;
      }
    }
    return null;
  }

  function compareConflict(field, previousValue, currentValue, previousConfidence, currentConfidence, recentText) {
    if (!previousValue || !currentValue) return null;
    if (String(previousValue).toLowerCase() === String(currentValue).toLowerCase()) {
      return null;
    }
    return {
      fields: [field],
      previous_value: previousValue,
      current_value: currentValue,
      confidence_comparison: {
        previous: Number(previousConfidence.toFixed(3)),
        current: Number(currentConfidence.toFixed(3))
      },
      message_indices: {
        previous: findLastMentionIndex(recentText, previousValue),
        current: findLastMentionIndex(recentText, currentValue)
      }
    };
  }

  function getPrimarySupport(agent) {
    let bestSupport = null;
    (agent?.anchors || []).forEach((anchor) => {
      (anchor?.supports || []).forEach((support) => {
        const confidence = Number(support?.confidence ?? 0);
        if (!support?.target) return;
        if (!bestSupport || confidence > bestSupport.confidence) {
          bestSupport = {
            target: support.target,
            confidence
          };
        }
      });
    });
    return bestSupport;
  }

  function detectConflicts(snapshotObj, previousObj, messages) {
    const settings = getExtensionSettings();
    const windowed = messages.slice(-settings.context_window_k);
    const recentText = windowed.map((msg) => String(msg.content || "").toLowerCase());
    const conflicts = Array.isArray(snapshotObj?.conflicts) ? snapshotObj.conflicts : [];
    const previousAgents = previousObj?.agents;
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) {
      snapshotObj.conflicts = conflicts;
      return;
    }
    snapshotObj.agents.forEach((agent) => {
      if (!agent?.id || !previousAgents || !Array.isArray(previousAgents)) return;
      const previousAgent = previousAgents.find((prior) => prior?.id === agent.id);
      if (!previousAgent) return;
      const postureConflict = compareConflict(
        "posture",
        previousAgent?.posture?.value,
        agent?.posture?.value,
        Number(previousAgent?.posture?.confidence ?? 0),
        Number(agent?.posture?.confidence ?? 0),
        recentText
      );
      if (postureConflict) {
        conflicts.push({ entity_id: agent.id, ...postureConflict });
      }
      const previousSupport = getPrimarySupport(previousAgent);
      const currentSupport = getPrimarySupport(agent);
      const supportConflict = compareConflict(
        "primary_support",
        previousSupport?.target,
        currentSupport?.target,
        Number(previousSupport?.confidence ?? 0),
        Number(currentSupport?.confidence ?? 0),
        recentText
      );
      if (supportConflict) {
        conflicts.push({ entity_id: agent.id, ...supportConflict });
      }
    });
    snapshotObj.conflicts = conflicts;
  }

  function sortEntitiesBySalience(snapshotObj) {
    if (snapshotObj?.agents && Array.isArray(snapshotObj.agents)) {
      snapshotObj.agents.sort(compareBySalienceThenName);
    }
    if (snapshotObj?.objects && Array.isArray(snapshotObj.objects)) {
      snapshotObj.objects.sort(compareBySalienceThenName);
    }
  }

  function enforceMaxCharacters(snapshotObj, pinnedIds = [], maxPresentOverride = null) {
    const settings = getExtensionSettings();
    const maxPresent =
      typeof maxPresentOverride === "number"
        ? maxPresentOverride
        : settings.max_present_characters;
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return;
    if (snapshotObj.agents.length <= maxPresent) return;
    const pinnedSet = new Set(pinnedIds);
    const pinned = snapshotObj.agents.filter((agent) => pinnedSet.has(agent.id));
    const unpinned = snapshotObj.agents.filter((agent) => !pinnedSet.has(agent.id));
    unpinned.sort(compareBySalienceThenName);
    const remainingSlots = Math.max(0, maxPresent - pinned.length);
    snapshotObj.agents = [...pinned, ...unpinned.slice(0, remainingSlots)];
    if (pinned.length > maxPresent) {
      snapshotObj.conflicts = snapshotObj.conflicts || [];
      snapshotObj.conflicts.push({
        note: "Pinned entities exceed max_present_characters; pruning skipped.",
        confidence: 0.6
      });
    }
  }

  function isExplicitContradiction(agentName, messages) {
    if (!agentName) return false;
    const normalized = normalizeEntityName(agentName);
    if (!normalized) return false;
    const verbs = [
      "stands up",
      "stands",
      "stand",
      "sits",
      "sit",
      "kneels",
      "kneel",
      "lies down",
      "lies",
      "lie down",
      "lays down",
      "lay down",
      "sits on",
      "sits in"
    ];
    return messages.some((msg) => {
      const text = String(msg.content || "").toLowerCase();
      if (!text.includes(normalized)) return false;
      return verbs.some((verb) => text.includes(verb));
    });
  }

  function applyLocks(snapshotObj, previousObj, messages, locks = {}) {
    const lockNotes = [];
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return lockNotes;
    const settings = getExtensionSettings();
    const windowedMessages = messages.slice(-settings.context_window_k);
    snapshotObj.agents.forEach((agent) => {
      if (!agent?.id) return;
      const lock = locks[agent.id];
      if (!lock) return;
      const previousAgent = previousObj?.agents?.find((prior) => prior?.id === agent.id);
      if (!previousAgent) return;
      const explicit = isExplicitContradiction(agent.name, windowedMessages);
      if (lock.posture && agent?.posture?.value && previousAgent?.posture?.value) {
        if (
          normalizeEntityName(agent.posture.value) !==
            normalizeEntityName(previousAgent.posture.value) &&
          !explicit
        ) {
          agent.posture = { ...previousAgent.posture };
          lockNotes.push({
            entity_id: agent.id,
            note: "Posture lock prevented update.",
            confidence: 0.7
          });
        }
      }
      if (lock.primary_support) {
        const previousSupport = getPrimarySupport(previousAgent);
        const currentSupport = getPrimarySupport(agent);
        if (
          previousSupport?.target &&
          currentSupport?.target &&
          normalizeEntityName(previousSupport.target) !==
            normalizeEntityName(currentSupport.target) &&
          !explicit
        ) {
          agent.anchors = Array.isArray(previousAgent.anchors)
            ? previousAgent.anchors.map((anchor) => ({ ...anchor }))
            : agent.anchors;
          lockNotes.push({
            entity_id: agent.id,
            note: "Support lock prevented update.",
            confidence: 0.7
          });
        }
      }
    });
    return lockNotes;
  }

  function buildInjectionText() {
    const settings = getExtensionSettings();
    if (!settings.inject_prompt) return "";
    const chatState = getChatState();
    if (!chatState?.snapshot_yaml) return "";
    const summary = sanitizeNarrativeForInjection(chatState.narrative_lines || []);
    const fallback = summary || "Scene state summary is unavailable.";
    return [
      "Scene state summary (non-authoritative):",
      fallback
    ].join("\n");
  }

  function sanitizeNarrativeForInjection(lines) {
    const blocked = /\b(you|must|should|please|do not|don't|avoid|instruct)\b/i;
    const cleaned = lines
      .map((line) => String(line.text || "").trim())
      .filter((text) => text && !blocked.test(text));
    return cleaned.join(" ");
  }

  function registerPromptInjection() {
    const injectionHandler = () => buildInjectionText();
    if (window.SillyTavern?.registerPromptInjection) {
      window.SillyTavern.registerPromptInjection(EXTENSION_NAME, injectionHandler);
      return;
    }
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (eventSource && eventTypes?.PROMPT_INJECTION) {
      eventSource.on(eventTypes.PROMPT_INJECTION, (context) => {
        const injection = injectionHandler();
        if (injection) {
          context.prompt += `\n\n${injection}`;
        }
      });
    }
  }

  async function runExtraction({ messages, chatState, overrides = {}, manual = false } = {}) {
    const settings = getExtensionSettings();
    const prompt = buildExtractionPrompt(messages, chatState, overrides);
    const maxOutputChars = Number(settings.max_inference_output_chars) || 15000;
    let rawResult = null;
    let parseResult = null;
    let errorMessage = null;
    let usedReformat = false;
    let output = null;

    try {
      rawResult = await generateInference(prompt);
      if (!rawResult || typeof rawResult !== "string") {
        throw new Error("No YAML received from model.");
      }
      if (rawResult.length > maxOutputChars) {
        rawResult = rawResult.slice(0, maxOutputChars);
        throw new Error("Model output exceeded max length.");
      }
      parseResult = yamlUtils.parseSimpleYaml(rawResult);
      if (!parseResult || typeof parseResult !== "object") {
        throw new Error("Failed to parse YAML.");
      }
      output = parseResult;
    } catch (error) {
      const rawText = rawResult || (error instanceof Error ? error.message : String(error));
      const reformatPrompt = buildReformatPrompt(rawText);
      try {
        const reformatted = await generateInference(reformatPrompt);
        usedReformat = true;
        if (!reformatted || typeof reformatted !== "string") {
          throw new Error("No reformatted YAML received.");
        }
        if (reformatted.length > maxOutputChars) {
          throw new Error("Reformatted output exceeded max length.");
        }
        parseResult = yamlUtils.parseSimpleYaml(reformatted);
        if (!parseResult || typeof parseResult !== "object") {
          throw new Error("Failed to parse reformatted YAML.");
        }
        output = parseResult;
      } catch (reformatError) {
        errorMessage = reformatError instanceof Error ? reformatError.message : "Invalid YAML output";
      }
    }

    if (!output) {
      const fallback = chatState?.snapshot_obj
        ? JSON.parse(JSON.stringify(chatState.snapshot_obj))
        : {
            schema_version: SCHEMA_VERSION,
            meta: {},
            agents: [],
            objects: [],
            supports: [],
            contacts: [],
            narrative_projection: [],
            conflicts: []
          };
      fallback.conflicts = Array.isArray(fallback.conflicts) ? fallback.conflicts : [];
      fallback.conflicts.push({ note: "inference_failed", confidence: 0.4 });
      return {
        snapshotObj: fallback,
        error: errorMessage || "Inference failed.",
        usedReformat: true,
        prompt
      };
    }

    const metaPatch = {
      updated_at: new Date().toISOString(),
      extraction_mode: overrides.extraction_mode || settings.extraction_mode,
      k: overrides.context_window_k ?? settings.context_window_k,
      allow_implied_objects:
        typeof overrides.allow_implied_objects === "boolean"
          ? overrides.allow_implied_objects
          : settings.allow_implied_objects,
      max_present_characters: overrides.max_present_characters ?? settings.max_present_characters
    };
    const normalized = yamlUtils.canonicalizeSnapshot(output, metaPatch);
    return {
      snapshotObj: normalized,
      error: null,
      usedReformat,
      prompt
    };
  }

  async function runInference({ manual = false } = {}) {
    const chatState = getChatState();
    if (!chatState) return;
    normalizeSettingsToState(chatState);
    const messages = getChatMessages();
    state.runtime.inferenceRunning = true;
    renderPanel();

    try {
      const extraction = await runExtraction({ messages, chatState, manual });
      const canonicalSnapshot = postProcessSnapshot(extraction.snapshotObj, chatState, messages);
      const canonicalYaml = yamlUtils.dumpYaml(canonicalSnapshot);
      persistChatState({
        schema_version: canonicalSnapshot.schema_version || SCHEMA_VERSION,
        updated_at_iso: canonicalSnapshot.meta?.updated_at || new Date().toISOString(),
        snapshot_yaml: canonicalYaml,
        snapshot_obj: canonicalSnapshot,
        narrative_lines: extractNarrativeLines(canonicalSnapshot, canonicalYaml),
        last_error: extraction.error,
        last_success: extraction.error ? null : new Date().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Inference error";
      persistChatState({
        last_error: message
      });
      if (manual) {
        console.warn(`[${EXTENSION_NAME}]`, message);
      }
    }
    state.runtime.inferenceRunning = false;
    renderPanel();
  }

  function postProcessSnapshot(snapshotObj, chatState, messages) {
    const previousObj = chatState?.snapshot_obj;
    applyContinuity(snapshotObj, previousObj);
    computeSalienceScores(snapshotObj, messages);
    sortEntitiesBySalience(snapshotObj);
    const lockNotes = applyLocks(snapshotObj, previousObj, messages, chatState?.locks || {});
    detectConflicts(snapshotObj, previousObj, messages);
    if (lockNotes.length) {
      snapshotObj.conflicts = snapshotObj.conflicts || [];
      snapshotObj.conflicts.push(...lockNotes);
    }
    const maxPresentValue = Number(snapshotObj?.meta?.max_present_characters);
    const maxPresentOverride = Number.isFinite(maxPresentValue) ? maxPresentValue : null;
    enforceMaxCharacters(snapshotObj, chatState?.pinned_entity_ids || [], maxPresentOverride);
    return yamlUtils.canonicalizeSnapshot(snapshotObj);
  }

  function buildNarrativeCopyText(chatState) {
    const narrativeLines = chatState?.narrative_lines || [];
    const cleaned = narrativeLines.map((line) => line.text).filter(Boolean);
    return cleaned.join("\n").trim();
  }

  function resetChatState() {
    const choice = window.prompt(
      "Reset Scene State:\n- Type 'snapshot' to clear snapshot only\n- Type 'all' to clear snapshot + pins/locks\n- Anything else cancels",
      "snapshot"
    );
    if (!choice) return;
    const selection = choice.trim().toLowerCase();
    if (selection !== "snapshot" && selection !== "all") return;
    const chatState = getChatState();
    if (!chatState) return;
    if (selection === "snapshot") {
      persistChatState({
        snapshot_yaml: "",
        snapshot_obj: null,
        narrative_lines: [],
        last_error: null,
        last_success: null
      });
    } else {
      const chatMetadata = getChatMetadata();
      if (chatMetadata && chatMetadata[STORAGE_KEY]) {
        delete chatMetadata[STORAGE_KEY];
      }
    }
    renderPanel();
  }

  function getExtensionBaseUrl() {
  if (window.SillyTavern?.getExtensionUrl) {
    return window.SillyTavern.getExtensionUrl(EXTENSION_NAME);
  }
  if (typeof window.getExtensionUrl === "function") {
    return window.getExtensionUrl(EXTENSION_NAME);
  }

  // Correct fallback for older ST builds
  return `/scripts/extensions/third-party/${EXTENSION_NAME}`;
  }

  async function loadSchemaManifest() {
    const base = getExtensionBaseUrl();
    const url = `${base}/schemas/pose-contact-spec/SCHEMA_MANIFEST.json`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("manifest fetch failed");
      return response.json();
    } catch (error) {
      return null;
    }
  }

  function applySessionToggle(details, key) {
    if (!details || !key) return;
    const stored = window.sessionStorage?.getItem(key);
    if (stored !== null) {
      details.open = stored === "true";
    }
    details.addEventListener("toggle", () => {
      window.sessionStorage?.setItem(key, String(details.open));
    });
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "st-scene-state-panel";
    panel.innerHTML = `
      <div class="st-scene-state-header">
        <div class="st-scene-state-title-group">
          <div class="st-scene-state-title">Scene State</div>
          <div class="st-scene-state-subtitle" data-role="prompt-status"></div>
        </div>
        <div class="st-scene-state-status">
          <span class="st-scene-state-indicator" data-role="indicator"></span>
          <span data-role="status">Idle</span>
        </div>
      </div>
      <div class="st-scene-state-meta">
        <div class="st-scene-state-meta-row">
          <div class="st-scene-state-timestamp" data-role="timestamp"></div>
          <div class="st-scene-state-cadence" data-role="cadence"></div>
        </div>
        <div class="st-scene-state-meta-row">
          <div class="st-scene-state-schema" data-role="schema-version"></div>
        </div>
        <div class="st-scene-state-error" data-role="error"></div>
      </div>
      <details class="st-scene-state-section st-scene-state-narrative" data-role="narrative-section" open>
        <summary>
          <span>Narrative</span>
          <button class="st-scene-state-copy" type="button" data-role="copy-narrative">Copy Narrative</button>
        </summary>
        <div class="st-scene-state-narrative-body" data-role="narrative"></div>
      </details>
      <details class="st-scene-state-section st-scene-state-yaml" data-role="yaml-section">
        <summary>
          <span>Canonical YAML</span>
          <div class="st-scene-state-inline-actions">
            <button class="st-scene-state-copy" type="button" data-role="copy-yaml">Copy YAML</button>
            <button class="st-scene-state-copy" type="button" data-role="copy-json">Copy JSON</button>
            <button class="st-scene-state-copy" type="button" data-role="download-yaml">Download YAML</button>
            <button class="st-scene-state-copy" type="button" data-role="edit-yaml">Edit</button>
          </div>
        </summary>
        <div class="st-scene-state-warning" data-role="yaml-warning"></div>
        <pre data-role="yaml"></pre>
        <textarea class="st-scene-state-yaml-editor" data-role="yaml-editor"></textarea>
        <div class="st-scene-state-yaml-actions">
          <button type="button" data-role="apply-yaml">Apply YAML</button>
          <button type="button" data-role="revert-yaml">Revert</button>
        </div>
        <div class="st-scene-state-error" data-role="yaml-error"></div>
      </details>
      <details class="st-scene-state-section st-scene-state-characters" data-role="characters-section">
        <summary>
          <span>Characters</span>
        </summary>
        <div class="st-scene-state-character-list" data-role="characters"></div>
      </details>
      <div class="st-scene-state-controls">
        <label title="How many recent messages to include in extraction.">
          <span>Context window (K)</span>
          <input type="number" min="1" step="1" data-role="context-window" />
        </label>
        <label title="Run extraction every N messages. Set to 0 for every message.">
          <span>Update cadence (N)</span>
          <input type="number" min="0" step="1" data-role="update-cadence" />
        </label>
        <label title="Allow inferred baseline objects such as floor or wall.">
          <span>Allow implied objects</span>
          <input type="checkbox" data-role="implied-objects" />
        </label>
        <label title="Extraction mode controls strictness.">
          <span>Extraction mode</span>
          <select data-role="extraction-mode">
            <option value="conservative">Conservative</option>
            <option value="descriptive">Descriptive</option>
          </select>
        </label>
        <label title="Maximum characters to keep in the present list.">
          <span>Max present characters</span>
          <input type="number" min="1" step="1" data-role="max-characters" />
        </label>
        <label title="Limit per-message input size.">
          <span>Max chars per message</span>
          <input type="number" min="200" step="100" data-role="max-chars-message" />
        </label>
        <label title="Limit total characters across the extraction window.">
          <span>Max total chars</span>
          <input type="number" min="1000" step="500" data-role="max-total-chars" />
        </label>
        <label title="Strip fenced code blocks from input.">
          <span>Strip code blocks</span>
          <input type="checkbox" data-role="strip-code" />
        </label>
        <label title="Strip quoted blocks from input.">
          <span>Strip quoted blocks</span>
          <input type="checkbox" data-role="strip-quotes" />
        </label>
        <label title="Prompt profile for multi-model robustness.">
          <span>Prompt profile</span>
          <select data-role="prompt-profile">
            <option value="auto">Auto</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
            <option value="generic">Generic</option>
          </select>
        </label>
        <label title="Maximum model output size before triggering fallback.">
          <span>Max output chars</span>
          <input type="number" min="2000" step="500" data-role="max-output-chars" />
        </label>
        <label title="Inject the narrative summary into the prompt for continuity.">
          <span>Inject summary into prompt</span>
          <input type="checkbox" data-role="inject-prompt" />
        </label>
        <label title="Experimental: only decrement the countdown on assistant responses.">
          <span>Only refresh on assistant messages <span class="st-scene-state-badge">Advanced</span></span>
          <input type="checkbox" data-role="assistant-only" />
        </label>
        <label title="Enable developer tools (fixtures, reports).">
          <span>Developer mode</span>
          <input type="checkbox" data-role="developer-mode" />
        </label>
        <div class="st-scene-state-buttons">
          <button data-role="refresh">Refresh Scene State</button>
          <button data-role="reset">Reset Scene State</button>
        </div>
      </div>
      <details class="st-scene-state-section st-scene-state-developer" data-role="developer-section">
        <summary>
          <span>Developer</span>
        </summary>
        <div class="st-scene-state-dev-controls">
          <button data-role="run-fixtures">Run Fixtures</button>
          <button data-role="open-fixture-report">Open Last Fixture Report</button>
        </div>
        <div class="st-scene-state-dev-status" data-role="dev-status"></div>
        <pre class="st-scene-state-dev-report" data-role="dev-report"></pre>
      </details>
    `;
    return panel;
  }

  function buildFloatingPanel() {
    const wrapper = document.createElement("div");
    wrapper.className = "drawer-content fillRight st-scene-state-floating closedDrawer";
    wrapper.id = "st-scene-state-floating-panel";
    const controlBar = document.createElement("div");
    controlBar.className = "panelControlBar flex-container alignItemsBaseline";
    controlBar.innerHTML = `
      <div class="fa-fw fa-solid fa-grip drag-grabber"></div>
      <div class="inline-drawer-maximize">
        <i class="floating_panel_maximize fa-fw fa-solid fa-window-maximize"></i>
      </div>
      <div class="fa-fw fa-solid fa-circle-xmark floating_panel_close"></div>
    `;
    const body = document.createElement("div");
    body.className = "st-scene-state-body scrollY";
    const panel = buildPanel();
    body.appendChild(panel);
    wrapper.appendChild(controlBar);
    wrapper.appendChild(body);
    return { wrapper, panel };
  }

  function buildExtensionSettings() {
    const wrapper = document.createElement("div");
    wrapper.className = "inline-drawer wide100p st-scene-state-extension-settings";
    wrapper.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Scene State</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label">
          <input type="checkbox" data-role="panel-open" />
          <span>Show floating panel</span>
        </label>
      </div>
    `;
    return wrapper;
  }

  function applyPanelState() {
    if (!state.ui.panelWrapper) return;
    const settings = getExtensionSettings();
    if (settings.panel_open) {
      state.ui.panelWrapper.classList.add("openDrawer");
      state.ui.panelWrapper.classList.remove("closedDrawer");
    } else {
      state.ui.panelWrapper.classList.remove("openDrawer");
      state.ui.panelWrapper.classList.add("closedDrawer");
    }
  }

  function renderCharacters(chatState) {
    const list = state.ui.controls.characters;
    if (!list) return;
    list.innerHTML = "";
    const agents = chatState?.snapshot_obj?.agents || [];
    if (agents.length === 0) {
      const empty = document.createElement("div");
      empty.className = "st-scene-state-empty";
      empty.textContent = "No characters to pin or lock yet.";
      list.appendChild(empty);
      return;
    }
    const pinnedSet = new Set(chatState?.pinned_entity_ids || []);
    agents.forEach((agent) => {
      const row = document.createElement("div");
      row.className = "st-scene-state-character-row";
      const name = document.createElement("div");
      name.className = "st-scene-state-character-name";
      name.textContent = agent.name || agent.id;
      const pinLabel = document.createElement("label");
      pinLabel.className = "st-scene-state-lock-toggle";
      pinLabel.innerHTML = `<span>Pin</span><input type="checkbox" ${
        pinnedSet.has(agent.id) ? "checked" : ""
      } />`;
      const postureLabel = document.createElement("label");
      postureLabel.className = "st-scene-state-lock-toggle";
      postureLabel.innerHTML = `<span>Lock posture</span><input type="checkbox" ${
        chatState?.locks?.[agent.id]?.posture ? "checked" : ""
      } />`;
      const supportLabel = document.createElement("label");
      supportLabel.className = "st-scene-state-lock-toggle";
      supportLabel.innerHTML = `<span>Lock support</span><input type="checkbox" ${
        chatState?.locks?.[agent.id]?.primary_support ? "checked" : ""
      } />`;
      pinLabel.querySelector("input").addEventListener("change", (event) => {
        const next = new Set(chatState?.pinned_entity_ids || []);
        if (event.target.checked) {
          next.add(agent.id);
        } else {
          next.delete(agent.id);
        }
        persistChatState({ pinned_entity_ids: Array.from(next) });
        renderPanel();
      });
      postureLabel.querySelector("input").addEventListener("change", (event) => {
        const locks = { ...(chatState?.locks || {}) };
        locks[agent.id] = {
          ...(locks[agent.id] || {}),
          posture: event.target.checked
        };
        persistChatState({ locks });
        renderPanel();
      });
      supportLabel.querySelector("input").addEventListener("change", (event) => {
        const locks = { ...(chatState?.locks || {}) };
        locks[agent.id] = {
          ...(locks[agent.id] || {}),
          primary_support: event.target.checked
        };
        persistChatState({ locks });
        renderPanel();
      });
      const toggles = document.createElement("div");
      toggles.className = "st-scene-state-character-toggles";
      toggles.appendChild(pinLabel);
      toggles.appendChild(postureLabel);
      toggles.appendChild(supportLabel);
      row.appendChild(name);
      row.appendChild(toggles);
      list.appendChild(row);
    });
  }

  function renderPanel() {
    if (!state.ui.panel) return;
    const chatState = getChatState();
    const settings = getExtensionSettings();
    const conflictCount = chatState?.snapshot_obj?.conflicts?.length || 0;
    const hasSnapshot = Boolean(chatState?.snapshot_yaml);
    const hasError = Boolean(chatState?.last_error);
    let statusLabel = "Idle";
    let statusIcon = "•";
    let statusClass = "is-idle";
    if (hasError) {
      statusLabel = "Error";
      statusIcon = "✖";
      statusClass = "is-error";
    } else if (conflictCount > 0) {
      statusLabel = "Warning";
      statusIcon = "⚠";
      statusClass = "is-warning";
    } else if (hasSnapshot) {
      statusLabel = "OK";
      statusIcon = "✓";
      statusClass = "is-ok";
    }
    state.ui.status.textContent = `${statusIcon} ${statusLabel}`;
    state.ui.indicator.classList.remove("is-error", "is-ok", "is-idle", "is-warning");
    state.ui.indicator.classList.add(statusClass);
    state.ui.promptStatus.textContent = settings.inject_prompt
      ? "Prompt injection: On"
      : "Prompt injection: Off";
    state.ui.timestamp.textContent = chatState?.updated_at_iso
      ? `Last updated: ${new Date(chatState.updated_at_iso).toLocaleString()}`
      : "Last updated: never";
    const assistantNote = settings.only_assistant_messages ? " (assistant-only)" : "";
    if (settings.update_every_n_messages === 0) {
      state.ui.cadence.textContent = `Auto: every message${assistantNote}`;
    } else {
      const remaining =
        typeof chatState?.countdown_remaining === "number"
          ? chatState.countdown_remaining
          : settings.update_every_n_messages;
      state.ui.cadence.textContent = `Auto: every ${settings.update_every_n_messages} msgs • next in ${remaining}${assistantNote}`;
    }
    state.ui.error.textContent = hasError ? `Last error: ${chatState.last_error}` : "";
    state.ui.yaml.textContent = chatState?.snapshot_yaml || "";
    state.ui.yamlEditor.value = state.runtime.yamlDraft || chatState?.snapshot_yaml || "";
    state.ui.yamlWarning.textContent = state.runtime.yamlEditMode
      ? "Manual edits are non-authoritative and may be overwritten by future inference unless locked/pinned."
      : "";
    state.ui.yamlError.textContent = "";
    state.ui.yaml.style.display = state.runtime.yamlEditMode ? "none" : "block";
    state.ui.yamlEditor.style.display = state.runtime.yamlEditMode ? "block" : "none";
    state.ui.controls.applyYaml.style.display = state.runtime.yamlEditMode ? "inline-flex" : "none";
    state.ui.controls.revertYaml.style.display = state.runtime.yamlEditMode ? "inline-flex" : "none";
    state.ui.controls.editYaml.textContent = state.runtime.yamlEditMode ? "View" : "Edit";
    state.ui.narrative.innerHTML = "";
    const narrativeLines = chatState?.narrative_lines || [];
    if (narrativeLines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "st-scene-state-empty";
      empty.textContent = "No narrative snapshot yet. Run refresh to generate one.";
      state.ui.narrative.appendChild(empty);
    }
    narrativeLines.forEach((line) => {
      const p = document.createElement("div");
      p.textContent = line.text;
      const alpha = Math.min(1, Math.max(0.2, Number(line.confidence || 0.4)));
      p.style.opacity = String(alpha);
      state.ui.narrative.appendChild(p);
    });
    if (!hasSnapshot) {
      state.ui.yaml.textContent = "No canonical snapshot yet.";
    }
    state.ui.controls.contextWindow.value = settings.context_window_k;
    state.ui.controls.updateCadence.value = settings.update_every_n_messages;
    state.ui.controls.impliedObjects.checked = settings.allow_implied_objects;
    state.ui.controls.extractionMode.value = settings.extraction_mode;
    state.ui.controls.maxCharacters.value = settings.max_present_characters;
    state.ui.controls.maxCharsMessage.value = settings.max_chars_per_message;
    state.ui.controls.maxTotalChars.value = settings.max_total_chars;
    state.ui.controls.stripCode.checked = settings.strip_code_blocks;
    state.ui.controls.stripQuotes.checked = settings.strip_quotes;
    state.ui.controls.promptProfile.value = settings.prompt_profile;
    state.ui.controls.maxOutputChars.value = settings.max_inference_output_chars;
    state.ui.controls.injectPrompt.checked = settings.inject_prompt;
    state.ui.controls.assistantOnly.checked = settings.only_assistant_messages;
    state.ui.controls.developerMode.checked = settings.developer_mode;
    state.ui.controls.refresh.disabled = state.runtime.inferenceRunning;
    state.ui.controls.refresh.textContent = state.runtime.inferenceRunning
      ? "Refreshing..."
      : "Refresh Scene State";
    const narrativeText = buildNarrativeCopyText(chatState);
    state.ui.controls.copyNarrative.disabled = narrativeText.length === 0;
    state.ui.controls.copyYaml.disabled = !chatState?.snapshot_yaml;
    const parsedSnapshot = chatState?.snapshot_yaml
      ? yamlUtils.parseSimpleYaml(chatState.snapshot_yaml)
      : null;
    state.ui.controls.copyJson.disabled = !parsedSnapshot;
    state.ui.controls.downloadYaml.disabled = !chatState?.snapshot_yaml;
    state.ui.sections.developer.style.display = settings.developer_mode ? "block" : "none";
    state.ui.controls.openFixtureReport.disabled = !settings.last_fixture_report;
    state.ui.devReport.textContent = settings.last_fixture_report || "";
    if (state.ui.panelToggle instanceof HTMLInputElement) {
      state.ui.panelToggle.checked = settings.panel_open;
    }
    applyPanelState();
    renderCharacters(chatState);
  }

  function handleMessageEvent(eventPayload) {
    const chatState = getChatState();
    if (!chatState) return;
    normalizeSettingsToState(chatState);
    const settings = getExtensionSettings();
    if (settings.only_assistant_messages && !isAssistantEvent(eventPayload)) {
      renderPanel();
      return;
    }
    if (settings.update_every_n_messages === 0) {
      runInference();
      return;
    }
    const nextCountdown = Math.max(0, (chatState.countdown_remaining ?? 0) - 1);
    persistChatState({
      countdown_remaining: nextCountdown
    });
    if (nextCountdown === 0) {
      runInference();
      persistChatState({
        countdown_remaining: settings.update_every_n_messages
      });
    }
    renderPanel();
  }

  function copyTextToClipboard(text, button) {
    if (!text) return;
    return navigator.clipboard.writeText(text).then(() => {
      if (!button) return;
      const original = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = original;
      }, 1500);
    });
  }

  function downloadYamlSnapshot(text) {
    if (!text) return;
    const context = getContextSafe();
    const chatIdRaw = context?.chatId || context?.chat_id || "chat";
    const chatId = String(chatIdRaw).replace(/[^a-z0-9_-]/gi, "_");
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `scene-state_${chatId}_${timestamp}.yaml`;
    if (window.SillyTavern?.downloadTextFile) {
      window.SillyTavern.downloadTextFile(filename, text);
      return;
    }
    if (typeof window.downloadTextFile === "function") {
      window.downloadTextFile(filename, text);
      return;
    }
    const blob = new Blob([text], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function runFixtures() {
    const settings = getExtensionSettings();
    if (!settings.developer_mode) return;
    state.ui.devStatus.textContent = "Running fixtures...";
    state.ui.devReport.textContent = "";
    const base = getExtensionBaseUrl();
    const runnerUrl = `${base}/src/dev/fixtureRunner.js`;
    try {
      await loadScriptOnce(runnerUrl);
      if (!window.STSceneStateFixtureRunner?.runAllFixtures) {
        throw new Error("Fixture runner unavailable.");
      }
      const report = await window.STSceneStateFixtureRunner.runAllFixtures({
        baseUrl: base,
        extractor: async (fixtureOverrides, transcript) => {
          const chatState = {
            snapshot_obj: null,
            locks: {},
            pinned_entity_ids: []
          };
          const messages = transcript.messages || [];
          const extraction = await runExtraction({
            messages,
            chatState: {
              snapshot_yaml: fixtureOverrides?.prior_snapshot || "",
              snapshot_obj: fixtureOverrides?.prior_snapshot_obj || null
            },
            overrides: fixtureOverrides,
            manual: true
          });
          const canonicalSnapshot = postProcessSnapshot(
            extraction.snapshotObj,
            chatState,
            messages
          );
          return { ...extraction, snapshotObj: canonicalSnapshot };
        }
      });
      settings.last_fixture_report = report?.reportText || "";
      saveSettings();
      state.ui.devStatus.textContent = report?.summary
        ? `Fixtures: ${report.summary.passed}/${report.summary.total} passed`
        : "Fixtures complete.";
      state.ui.devReport.textContent = report?.reportText || "";
    } catch (error) {
      state.ui.devStatus.textContent = "Fixture run failed.";
      state.ui.devReport.textContent = error instanceof Error ? error.message : "Unknown error";
    }
  }

  function wirePanelEvents() {
    const { controls } = state.ui;
    controls.contextWindow.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.context_window_k = Math.max(1, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.updateCadence.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.update_every_n_messages = Math.max(0, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.impliedObjects.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.allow_implied_objects = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.extractionMode.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.extraction_mode = event.target.value;
      saveSettings();
      renderPanel();
    });
    controls.maxCharacters.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.max_present_characters = Math.max(1, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.maxCharsMessage.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.max_chars_per_message = Math.max(200, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.maxTotalChars.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.max_total_chars = Math.max(1000, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.stripCode.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.strip_code_blocks = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.stripQuotes.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.strip_quotes = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.promptProfile.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.prompt_profile = event.target.value;
      saveSettings();
      renderPanel();
    });
    controls.maxOutputChars.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.max_inference_output_chars = Math.max(2000, Number(event.target.value));
      saveSettings();
      renderPanel();
    });
    controls.injectPrompt.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.inject_prompt = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.assistantOnly.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.only_assistant_messages = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.developerMode.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.developer_mode = Boolean(event.target.checked);
      saveSettings();
      renderPanel();
    });
    controls.refresh.addEventListener("click", () => runInference({ manual: true }));
    controls.reset.addEventListener("click", resetChatState);
    controls.copyYaml.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = state.ui.yaml.textContent || "";
      await copyTextToClipboard(text, controls.copyYaml);
    });
    controls.copyJson.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = state.ui.yaml.textContent || "";
      const parsed = yamlUtils.parseSimpleYaml(text);
      if (!parsed) return;
      const stable = yamlUtils.stableClone(parsed);
      const json = JSON.stringify(stable, null, 2);
      await copyTextToClipboard(json, controls.copyJson);
    });
    controls.downloadYaml.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = state.ui.yaml.textContent || "";
      if (!text) return;
      downloadYamlSnapshot(text);
    });
    controls.editYaml.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.runtime.yamlEditMode = !state.runtime.yamlEditMode;
      if (state.runtime.yamlEditMode) {
        state.runtime.yamlDraft = state.ui.yaml.textContent || "";
      }
      renderPanel();
    });
    controls.applyYaml.addEventListener("click", () => {
      const draft = state.ui.yamlEditor.value;
      const parsed = yamlUtils.parseSimpleYaml(draft);
      if (!parsed) {
        state.ui.yamlError.textContent = "Invalid YAML. Fix errors before applying.";
        return;
      }
      const snapshotObj = yamlUtils.canonicalizeSnapshot(parsed, {
        updated_at: new Date().toISOString(),
        extraction_mode: getExtensionSettings().extraction_mode,
        k: getExtensionSettings().context_window_k,
        allow_implied_objects: getExtensionSettings().allow_implied_objects,
        max_present_characters: getExtensionSettings().max_present_characters
      });
      const canonicalYaml = yamlUtils.dumpYaml(snapshotObj);
      persistChatState({
        snapshot_yaml: canonicalYaml,
        snapshot_obj: snapshotObj,
        narrative_lines: extractNarrativeLines(snapshotObj, canonicalYaml),
        last_error: null,
        last_success: new Date().toISOString()
      });
      state.runtime.yamlEditMode = false;
      state.runtime.yamlDraft = "";
      renderPanel();
    });
    controls.revertYaml.addEventListener("click", () => {
      state.runtime.yamlEditMode = false;
      state.runtime.yamlDraft = "";
      renderPanel();
    });
    controls.copyNarrative.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = buildNarrativeCopyText(getChatState());
      if (!text) return;
      await copyTextToClipboard(text, controls.copyNarrative);
    });
    controls.runFixtures.addEventListener("click", () => runFixtures());
    controls.openFixtureReport.addEventListener("click", () => {
      const settings = getExtensionSettings();
      state.ui.devReport.textContent = settings.last_fixture_report || "";
    });
  }

  function loadScriptOnce(src) {
    if (!src) return Promise.reject(new Error("Missing script source"));
    if (!loadScriptOnce.cache) loadScriptOnce.cache = new Map();
    if (loadScriptOnce.cache.has(src)) return loadScriptOnce.cache.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
    loadScriptOnce.cache.set(src, promise);
    return promise;
  }

  function mountPanel() {
    if (state.ui.panel) return;
    const { wrapper, panel } = buildFloatingPanel();
    const host = document.querySelector("#movingDivs") || document.body;
    host.appendChild(wrapper);
    state.ui.panel = panel;
    state.ui.panelWrapper = wrapper;
    state.ui.status = panel.querySelector("[data-role='status']");
    state.ui.indicator = panel.querySelector("[data-role='indicator']");
    state.ui.timestamp = panel.querySelector("[data-role='timestamp']");
    state.ui.cadence = panel.querySelector("[data-role='cadence']");
    state.ui.promptStatus = panel.querySelector("[data-role='prompt-status']");
    state.ui.error = panel.querySelector("[data-role='error']");
    state.ui.narrative = panel.querySelector("[data-role='narrative']");
    state.ui.yaml = panel.querySelector("[data-role='yaml']");
    state.ui.yamlEditor = panel.querySelector("[data-role='yaml-editor']");
    state.ui.yamlError = panel.querySelector("[data-role='yaml-error']");
    state.ui.yamlWarning = panel.querySelector("[data-role='yaml-warning']");
    state.ui.schemaVersion = panel.querySelector("[data-role='schema-version']");
    state.ui.devReport = panel.querySelector("[data-role='dev-report']");
    state.ui.devStatus = panel.querySelector("[data-role='dev-status']");
    state.ui.sections = {
      narrative: panel.querySelector("[data-role='narrative-section']"),
      yaml: panel.querySelector("[data-role='yaml-section']"),
      characters: panel.querySelector("[data-role='characters-section']"),
      developer: panel.querySelector("[data-role='developer-section']")
    };
    state.ui.controls = {
      contextWindow: panel.querySelector("[data-role='context-window']"),
      updateCadence: panel.querySelector("[data-role='update-cadence']"),
      impliedObjects: panel.querySelector("[data-role='implied-objects']"),
      extractionMode: panel.querySelector("[data-role='extraction-mode']"),
      maxCharacters: panel.querySelector("[data-role='max-characters']"),
      maxCharsMessage: panel.querySelector("[data-role='max-chars-message']"),
      maxTotalChars: panel.querySelector("[data-role='max-total-chars']"),
      stripCode: panel.querySelector("[data-role='strip-code']"),
      stripQuotes: panel.querySelector("[data-role='strip-quotes']"),
      promptProfile: panel.querySelector("[data-role='prompt-profile']"),
      maxOutputChars: panel.querySelector("[data-role='max-output-chars']"),
      injectPrompt: panel.querySelector("[data-role='inject-prompt']"),
      assistantOnly: panel.querySelector("[data-role='assistant-only']"),
      developerMode: panel.querySelector("[data-role='developer-mode']"),
      refresh: panel.querySelector("[data-role='refresh']"),
      reset: panel.querySelector("[data-role='reset']"),
      copyYaml: panel.querySelector("[data-role='copy-yaml']"),
      copyJson: panel.querySelector("[data-role='copy-json']"),
      downloadYaml: panel.querySelector("[data-role='download-yaml']"),
      editYaml: panel.querySelector("[data-role='edit-yaml']"),
      applyYaml: panel.querySelector("[data-role='apply-yaml']"),
      revertYaml: panel.querySelector("[data-role='revert-yaml']"),
      copyNarrative: panel.querySelector("[data-role='copy-narrative']"),
      runFixtures: panel.querySelector("[data-role='run-fixtures']"),
      openFixtureReport: panel.querySelector("[data-role='open-fixture-report']"),
      characters: panel.querySelector("[data-role='characters']")
    };
    applyPanelState();
    const closeButton = wrapper.querySelector(".floating_panel_close");
    closeButton?.addEventListener("click", () => {
      const nextSettings = getExtensionSettings();
      nextSettings.panel_open = false;
      saveSettings();
      applyPanelState();
      renderPanel();
    });
    const extensionSettingsHost =
      document.querySelector("#extensions_settings") ||
      document.querySelector("#extensions_settings2") ||
      document.querySelector("#extensionsMenu");
    if (extensionSettingsHost && !document.querySelector(".st-scene-state-extension-settings")) {
      const settingsBlock = buildExtensionSettings();
      extensionSettingsHost.appendChild(settingsBlock);
      const panelToggle = settingsBlock.querySelector("[data-role='panel-open']");
      panelToggle?.addEventListener("change", (event) => {
        const nextSettings = getExtensionSettings();
        nextSettings.panel_open = Boolean(event.target.checked);
        saveSettings();
        applyPanelState();
      });
      state.ui.panelToggle = panelToggle;
    }
    const closeButton = wrapper.querySelector(".floating_panel_close");
    closeButton?.addEventListener("click", () => {
      wrapper.classList.remove("is-open");
      const nextSettings = getExtensionSettings();
      nextSettings.panel_open = false;
      saveSettings();
    });
    const toggleMenu = document.querySelector("#option_toggle_AN");
    if (toggleMenu && !document.querySelector("#option_toggle_scene_state")) {
      const menuItem = document.createElement("a");
      menuItem.id = "option_toggle_scene_state";
      menuItem.innerHTML = `
        <i class="fa-lg fa-solid fa-wave-square"></i>
        <span>Scene State</span>
      `;
      toggleMenu.insertAdjacentElement("afterend", menuItem);
      menuItem.addEventListener("click", () => {
        wrapper.classList.toggle("is-open");
        const nextSettings = getExtensionSettings();
        nextSettings.panel_open = wrapper.classList.contains("is-open");
        saveSettings();
      });
      state.ui.panelToggle = menuItem;
    }
    applySessionToggle(state.ui.sections.narrative, `${EXTENSION_NAME}-narrative-open`);
    applySessionToggle(state.ui.sections.yaml, `${EXTENSION_NAME}-yaml-open`);
    applySessionToggle(state.ui.sections.characters, `${EXTENSION_NAME}-characters-open`);
    applySessionToggle(state.ui.sections.developer, `${EXTENSION_NAME}-developer-open`);
    wirePanelEvents();
    renderPanel();
  }

  function registerMessageHooks() {
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    if (!eventSource || !eventTypes) return;
    const events = [
      eventTypes.MESSAGE_SENT,
      eventTypes.MESSAGE_RECEIVED,
      eventTypes.MESSAGE_EDITED,
      eventTypes.CHAT_CHANGED
    ].filter(Boolean);
    events.forEach((eventType) => {
      eventSource.on(eventType, (payload) => {
        if (eventType === eventTypes.CHAT_CHANGED) {
          renderPanel();
        } else {
          handleMessageEvent(payload);
        }
      });
    });
  }

  function isAssistantEvent(eventPayload) {
    if (eventPayload?.is_user === true) return false;
    if (eventPayload?.is_user === false) return true;
    if (eventPayload?.role) {
      return eventPayload.role === "assistant";
    }
    const messages = getChatMessages();
    const lastMessage = messages[messages.length - 1];
    return lastMessage?.role === "assistant";
  }

  async function init() {
    mountPanel();
    registerMessageHooks();
    registerPromptInjection();
    const manifest = await loadSchemaManifest();
    if (manifest?.schema_versions?.length) {
      state.ui.schemaVersion.textContent = `Schema: ${manifest.schema_versions[0]}`;
    } else {
      state.ui.schemaVersion.textContent = `Schema: ${SCHEMA_VERSION}`;
    }
    window.STSceneState = {
      simulateInference: () => runInference({ manual: true }),
      getSnapshot: () => getChatState()?.snapshot_yaml || ""
    };
    window.STSceneStateInternal = {
      yamlUtils,
      runExtraction
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

(() => {
  const EXTENSION_NAME = "st-scene-state";
  const STORAGE_KEY = "stSceneState";
  const DEFAULT_SETTINGS = {
    context_window_k: 8,
    update_every_n_messages: 0,
    allow_implied_objects: true,
    max_present_characters: 4,
    inject_prompt: true,
    only_assistant_messages: false,
    panel_open: false
  };

  const SCHEMA_VERSION = "pose-contact-spec-0.1";
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

  const state = {
    ui: {
      panel: null,
      narrative: null,
      yaml: null,
      status: null,
      indicator: null,
      cadence: null,
      promptStatus: null,
      error: null,
      timestamp: null,
      controls: {},
      sections: {}
    },
    runtime: {
      inferenceRunning: false
    }
  };

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
        last_success: null
      };
    }
    return chatMetadata[STORAGE_KEY];
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

  function buildExtractionPrompt(messages, chatState) {
    const settings = getExtensionSettings();
    const windowed = messages.slice(-settings.context_window_k);
    const formattedMessages = windowed
      .map((msg) => `- role: ${msg.role}\n  content: ${sanitizeForYaml(msg.content)}`)
      .join("\n");

    return [
      "You are a scene-state extraction engine.",
      "Output strict YAML only (no code fences).",
      "Do not invent details. Omit unknowns or set low confidence (<=0.4).",
      "Use character names as they appear. Do not create new names.",
      `Max present characters: ${settings.max_present_characters}.`,
      `Allow implied baseline objects: ${settings.allow_implied_objects ? "true" : "false"}.`,
      "If implied baseline objects are allowed, only include floor/ground/wall/door when posture/support implies them, and set confidence low.",
      "Schema (pose-contact-spec inspired):",
      "schema_version: string",
      "agents: [ { id, name, present, confidence, salience_score, posture: { value, confidence }, anchors: [ { name, contacts: [ { target, kind, confidence } ], supports: [ { target, confidence } ] } ] } ]",
      "objects: [ { id, name, type, confidence, salience_score } ]",
      "narrative_projection: [ { text, confidence } ]",
      "conflict_notes: [ { text, confidence } ]",
      "Salience scoring: prioritize recent mentions in the last K messages (extra weight for last message), degree of interaction (contacts/supports), confidence mass, and explicit naming.",
      "If an agent/object was present in the prior snapshot with the same name, reuse the same id (case-insensitive). Do not merge different explicit names; pronouns may refer to a prior entity.",
      "If posture/support changed but uncertain, reduce confidence instead of hard switches.",
      "If you are unsure about a fact, reduce confidence rather than guessing.",
      "Messages:",
      formattedMessages,
      "Current snapshot (optional, for continuity only; do not assume it is true):",
      chatState?.snapshot_yaml ? chatState.snapshot_yaml : "null"
    ].join("\n");
  }

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

  async function runInference({ manual = false } = {}) {
    const chatState = getChatState();
    if (!chatState) return;
    normalizeSettingsToState(chatState);
    const messages = getChatMessages();
    const prompt = buildExtractionPrompt(messages, chatState);
    state.runtime.inferenceRunning = true;
    renderPanel();

    try {
      const result = await generateInference(prompt);
      if (!result || typeof result !== "string") {
        throw new Error("No YAML received from model.");
      }
      const snapshotObj = parseSimpleYaml(result);
      if (!snapshotObj || typeof snapshotObj !== "object") {
        throw new Error("Failed to parse YAML.");
      }
      applyContinuity(snapshotObj, chatState.snapshot_obj);
      computeSalienceScores(snapshotObj, messages);
      detectConflicts(snapshotObj, chatState.snapshot_obj, messages);
      sortEntitiesBySalience(snapshotObj);
      enforceMaxCharacters(snapshotObj);
      const canonicalYaml = dumpYaml(snapshotObj);
      persistChatState({
        schema_version: snapshotObj.schema_version || SCHEMA_VERSION,
        updated_at_iso: new Date().toISOString(),
        snapshot_yaml: canonicalYaml,
        snapshot_obj: snapshotObj,
        narrative_lines: extractNarrativeLines(snapshotObj, canonicalYaml),
        last_error: null,
        last_success: new Date().toISOString()
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

  function enforceMaxCharacters(snapshotObj) {
    const settings = getExtensionSettings();
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return;
    if (snapshotObj.agents.length <= settings.max_present_characters) return;
    snapshotObj.agents.sort(compareBySalienceThenName);
    snapshotObj.agents = snapshotObj.agents.slice(0, settings.max_present_characters);
  }

  function applyContinuity(snapshotObj, previousObj) {
    const previousAgents = previousObj?.agents;
    const previousObjects = previousObj?.objects;
    if (snapshotObj?.agents && Array.isArray(snapshotObj.agents)) {
      // ID stability rules:
      // - Reuse prior IDs when names match case-insensitively.
      // - If multiple candidates match, pick highest prior salience.
      // - Do not merge different explicit names; pronouns may reuse a prior ID.
      const priorByName = buildEntityLookup(previousAgents);
      const priorBySalience = [...(previousAgents || [])].sort(compareBySalienceThenName);
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
      const priorBySalience = [...(previousObjects || [])].sort(compareBySalienceThenName);
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

  function detectConflicts(snapshotObj, previousObj, messages) {
    const settings = getExtensionSettings();
    const windowed = messages.slice(-settings.context_window_k);
    const recentText = windowed.map((msg) => String(msg.content || "").toLowerCase());
    const conflicts = [];
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

  function sortEntitiesBySalience(snapshotObj) {
    if (snapshotObj?.agents && Array.isArray(snapshotObj.agents)) {
      snapshotObj.agents.sort(compareBySalienceThenName);
    }
    if (snapshotObj?.objects && Array.isArray(snapshotObj.objects)) {
      snapshotObj.objects.sort(compareBySalienceThenName);
    }
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

  function normalizeEntityName(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function buildEntityLookup(entities) {
    const lookup = new Map();
    (entities || []).forEach((entity) => {
      const key = normalizeEntityName(entity?.name);
      if (!key) return;
      if (!lookup.has(key)) lookup.set(key, []);
      lookup.get(key).push(entity);
    });
    return lookup;
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

  function buildStableId(prefix, name, index) {
    const slug = normalizeEntityName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (slug) return `${prefix}-${slug}`;
    return `${prefix}-unknown-${index}`;
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
    throw new Error("generateQuietPrompt API not available.");
  }

  function buildInjectionText() {
    const settings = getExtensionSettings();
    if (!settings.inject_prompt) return "";
    const chatState = getChatState();
    if (!chatState?.snapshot_yaml) return "";
    const summary = chatState.narrative_lines
      ?.map((line) => line.text)
      .filter(Boolean)
      .join(" ");
    const fallback = summary || "Scene state inferred from recent messages.";
    return [
      "INFERRED SCENE STATE (non-authoritative, do not treat as canon; do not invent beyond it):",
      fallback
    ].join("\n");
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

  function resetChatState() {
    const chatMetadata = getChatMetadata();
    if (chatMetadata && chatMetadata[STORAGE_KEY]) {
      delete chatMetadata[STORAGE_KEY];
    }
    renderPanel();
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
          <button class="st-scene-state-copy" type="button" data-role="copy-yaml">Copy YAML</button>
        </summary>
        <pre data-role="yaml"></pre>
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
        <label title="Maximum characters to keep in the present list.">
          <span>Max present characters</span>
          <input type="number" min="1" step="1" data-role="max-characters" />
        </label>
        <label title="Inject the narrative summary into the prompt for continuity.">
          <span>Inject summary into prompt</span>
          <input type="checkbox" data-role="inject-prompt" />
        </label>
        <label title="Experimental: only decrement the countdown on assistant responses.">
          <span>Only refresh on assistant messages <span class="st-scene-state-badge">Advanced</span></span>
          <input type="checkbox" data-role="assistant-only" />
        </label>
        <div class="st-scene-state-buttons">
          <button data-role="refresh">Refresh Scene State</button>
          <button data-role="reset">Reset Scene State</button>
        </div>
      </div>
    `;
    return panel;
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
    state.ui.controls.maxCharacters.value = settings.max_present_characters;
    state.ui.controls.injectPrompt.checked = settings.inject_prompt;
    state.ui.controls.assistantOnly.checked = settings.only_assistant_messages;
    state.ui.controls.refresh.disabled = state.runtime.inferenceRunning;
    state.ui.controls.refresh.textContent = state.runtime.inferenceRunning
      ? "Refreshing..."
      : "Refresh Scene State";
    const narrativeText = buildNarrativeCopyText(chatState);
    state.ui.controls.copyNarrative.disabled = narrativeText.length === 0;
    state.ui.controls.copyYaml.disabled = !chatState?.snapshot_yaml;
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
    controls.maxCharacters.addEventListener("change", (event) => {
      const settings = getExtensionSettings();
      settings.max_present_characters = Math.max(1, Number(event.target.value));
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
    controls.refresh.addEventListener("click", () => runInference({ manual: true }));
    controls.reset.addEventListener("click", resetChatState);
    controls.copyYaml.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = state.ui.yaml.textContent || "";
      await navigator.clipboard.writeText(text);
      controls.copyYaml.textContent = "Copied";
      setTimeout(() => {
        controls.copyYaml.textContent = "Copy YAML";
      }, 1500);
    });
    controls.copyNarrative.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = buildNarrativeCopyText(getChatState());
      if (!text) return;
      await navigator.clipboard.writeText(text);
      controls.copyNarrative.textContent = "Copied";
      setTimeout(() => {
        controls.copyNarrative.textContent = "Copy Narrative";
      }, 1500);
    });
  }

  function buildNarrativeCopyText(chatState) {
    const narrativeLines = chatState?.narrative_lines || [];
    const cleaned = narrativeLines.map((line) => line.text).filter(Boolean);
    return cleaned.join("\n").trim();
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

  function mountPanel() {
    if (state.ui.panel) return;
    const panel = buildPanel();
    const host =
      document.querySelector("#right-nav-panel") ||
      document.querySelector("#right-panel") ||
      document.body;
    const wrapper = document.createElement("div");
    wrapper.className = "st-scene-state-container";
    const toggle = document.createElement("button");
    toggle.className = "st-scene-state-toggle";
    toggle.textContent = "Scene State";
    toggle.addEventListener("click", () => {
      wrapper.classList.toggle("is-open");
      const settings = getExtensionSettings();
      settings.panel_open = wrapper.classList.contains("is-open");
      saveSettings();
    });
    wrapper.appendChild(toggle);
    wrapper.appendChild(panel);
    host.appendChild(wrapper);
    state.ui.panel = panel;
    state.ui.status = panel.querySelector("[data-role='status']");
    state.ui.indicator = panel.querySelector("[data-role='indicator']");
    state.ui.timestamp = panel.querySelector("[data-role='timestamp']");
    state.ui.cadence = panel.querySelector("[data-role='cadence']");
    state.ui.promptStatus = panel.querySelector("[data-role='prompt-status']");
    state.ui.error = panel.querySelector("[data-role='error']");
    state.ui.narrative = panel.querySelector("[data-role='narrative']");
    state.ui.yaml = panel.querySelector("[data-role='yaml']");
    state.ui.sections = {
      narrative: panel.querySelector("[data-role='narrative-section']"),
      yaml: panel.querySelector("[data-role='yaml-section']")
    };
    state.ui.controls = {
      contextWindow: panel.querySelector("[data-role='context-window']"),
      updateCadence: panel.querySelector("[data-role='update-cadence']"),
      impliedObjects: panel.querySelector("[data-role='implied-objects']"),
      maxCharacters: panel.querySelector("[data-role='max-characters']"),
      injectPrompt: panel.querySelector("[data-role='inject-prompt']"),
      assistantOnly: panel.querySelector("[data-role='assistant-only']"),
      refresh: panel.querySelector("[data-role='refresh']"),
      reset: panel.querySelector("[data-role='reset']"),
      copyYaml: panel.querySelector("[data-role='copy-yaml']"),
      copyNarrative: panel.querySelector("[data-role='copy-narrative']")
    };
    const settings = getExtensionSettings();
    if (settings.panel_open) {
      wrapper.classList.add("is-open");
    }
    applySessionToggle(state.ui.sections.narrative, `${EXTENSION_NAME}-narrative-open`);
    applySessionToggle(state.ui.sections.yaml, `${EXTENSION_NAME}-yaml-open`);
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

  function init() {
    mountPanel();
    registerMessageHooks();
    registerPromptInjection();
    window.STSceneState = {
      simulateInference: () => runInference({ manual: true }),
      getSnapshot: () => getChatState()?.snapshot_yaml || ""
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

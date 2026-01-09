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

  const state = {
    ui: {
      panel: null,
      narrative: null,
      yaml: null,
      status: null,
      indicator: null,
      error: null,
      timestamp: null,
      controls: {}
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
      "objects: [ { id, name, type, confidence } ]",
      "narrative_projection: [ { text, confidence } ]",
      "conflict_notes: [ { text, confidence } ]",
      "Salience scoring: prioritize recent mentions in the last K messages, degree of interaction (contacts/supports), and confidence mass.",
      "If an agent was present in the prior snapshot with the same name, reuse the same id.",
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
    renderPanel();
  }

  function enforceMaxCharacters(snapshotObj) {
    const settings = getExtensionSettings();
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return;
    if (snapshotObj.agents.length <= settings.max_present_characters) return;
    snapshotObj.agents.sort((a, b) => {
      const scoreA = Number(a.salience_score ?? a.confidence ?? 0);
      const scoreB = Number(b.salience_score ?? b.confidence ?? 0);
      return scoreB - scoreA;
    });
    snapshotObj.agents = snapshotObj.agents.slice(0, settings.max_present_characters);
  }

  function applyContinuity(snapshotObj, previousObj) {
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return;
    if (!previousObj?.agents || !Array.isArray(previousObj.agents)) return;
    const priorByName = new Map(
      previousObj.agents
        .filter((agent) => agent?.name)
        .map((agent) => [String(agent.name).toLowerCase(), agent])
    );
    snapshotObj.agents.forEach((agent) => {
      if (!agent?.name) return;
      const match = priorByName.get(String(agent.name).toLowerCase());
      if (match?.id) {
        agent.id = match.id;
      }
    });
  }

  function computeSalienceScores(snapshotObj, messages) {
    if (!snapshotObj?.agents || !Array.isArray(snapshotObj.agents)) return;
    const recentText = messages.map((msg) => msg.content.toLowerCase());
    snapshotObj.agents.forEach((agent) => {
      const name = String(agent.name || "").toLowerCase();
      let score = Number(agent.confidence ?? 0.4);
      if (agent.posture?.value) score += 0.1;
      const anchorCount = Array.isArray(agent.anchors) ? agent.anchors.length : 0;
      if (anchorCount > 0) score += 0.1;
      const contactCount = (agent.anchors || []).reduce((sum, anchor) => {
        return sum + (anchor.contacts?.length || 0) + (anchor.supports?.length || 0);
      }, 0);
      score += Math.min(0.2, contactCount * 0.05);
      if (name) {
        const mentions = recentText.reduce(
          (sum, text) => sum + (text.includes(name) ? 1 : 0),
          0
        );
        score += Math.min(0.2, mentions * 0.05);
      }
      agent.salience_score = Math.min(1, Number(score.toFixed(3)));
    });
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
        <div class="st-scene-state-title">Scene State</div>
        <div class="st-scene-state-status">
          <span class="st-scene-state-indicator" data-role="indicator"></span>
          <span data-role="status">Disabled</span>
        </div>
      </div>
      <div class="st-scene-state-meta">
        <div class="st-scene-state-timestamp" data-role="timestamp"></div>
        <div class="st-scene-state-error" data-role="error"></div>
      </div>
      <div class="st-scene-state-narrative" data-role="narrative"></div>
      <details class="st-scene-state-yaml">
        <summary>Canonical YAML</summary>
        <button class="st-scene-state-copy" data-role="copy">Copy YAML</button>
        <pre data-role="yaml"></pre>
      </details>
      <div class="st-scene-state-controls">
        <label>Context window (K)
          <input type="number" min="1" step="1" data-role="context-window" />
        </label>
        <label>Update cadence (N)
          <input type="number" min="0" step="1" data-role="update-cadence" />
        </label>
        <label>Allow implied objects
          <input type="checkbox" data-role="implied-objects" />
        </label>
        <label>Max present characters
          <input type="number" min="1" step="1" data-role="max-characters" />
        </label>
        <label>Inject summary into prompt
          <input type="checkbox" data-role="inject-prompt" />
        </label>
        <label>Only refresh on assistant messages
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
    state.ui.status.textContent = settings.inject_prompt ? "Enabled" : "Disabled";
    state.ui.indicator.classList.remove("is-error", "is-ok", "is-idle");
    if (chatState?.last_error) {
      state.ui.indicator.classList.add("is-error");
    } else if (chatState?.snapshot_yaml) {
      state.ui.indicator.classList.add("is-ok");
    } else {
      state.ui.indicator.classList.add("is-idle");
    }
    state.ui.timestamp.textContent = chatState?.updated_at_iso
      ? `Last updated: ${new Date(chatState.updated_at_iso).toLocaleString()}`
      : "No snapshot yet";
    state.ui.error.textContent = chatState?.last_error
      ? `Last error: ${chatState.last_error}`
      : "";
    state.ui.yaml.textContent = chatState?.snapshot_yaml || "";
    state.ui.narrative.innerHTML = "";
    const narrativeLines = chatState?.narrative_lines || [];
    narrativeLines.forEach((line) => {
      const p = document.createElement("div");
      p.textContent = line.text;
      const alpha = Math.min(1, Math.max(0.2, Number(line.confidence || 0.4)));
      p.style.opacity = String(alpha);
      state.ui.narrative.appendChild(p);
    });
    state.ui.controls.contextWindow.value = settings.context_window_k;
    state.ui.controls.updateCadence.value = settings.update_every_n_messages;
    state.ui.controls.impliedObjects.checked = settings.allow_implied_objects;
    state.ui.controls.maxCharacters.value = settings.max_present_characters;
    state.ui.controls.injectPrompt.checked = settings.inject_prompt;
    state.ui.controls.assistantOnly.checked = settings.only_assistant_messages;
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
    controls.copy.addEventListener("click", async () => {
      const text = state.ui.yaml.textContent || "";
      await navigator.clipboard.writeText(text);
      controls.copy.textContent = "Copied";
      setTimeout(() => {
        controls.copy.textContent = "Copy YAML";
      }, 1500);
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
    state.ui.error = panel.querySelector("[data-role='error']");
    state.ui.narrative = panel.querySelector("[data-role='narrative']");
    state.ui.yaml = panel.querySelector("[data-role='yaml']");
    state.ui.controls = {
      contextWindow: panel.querySelector("[data-role='context-window']"),
      updateCadence: panel.querySelector("[data-role='update-cadence']"),
      impliedObjects: panel.querySelector("[data-role='implied-objects']"),
      maxCharacters: panel.querySelector("[data-role='max-characters']"),
      injectPrompt: panel.querySelector("[data-role='inject-prompt']"),
      assistantOnly: panel.querySelector("[data-role='assistant-only']"),
      refresh: panel.querySelector("[data-role='refresh']"),
      reset: panel.querySelector("[data-role='reset']"),
      copy: panel.querySelector("[data-role='copy']")
    };
    const settings = getExtensionSettings();
    if (settings.panel_open) {
      wrapper.classList.add("is-open");
    }
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

import type { DesignAsset, ProviderConfig, TokenUsage } from "./types";

type StreamEvent =
  | { kind: "content"; textDelta: string }
  | { kind: "reasoning"; textDelta: string }
  | { kind: "usage"; usage: TokenUsage; usageIsFinal?: boolean; loadDurationMs?: number }
  | {
      kind: "status";
      status: "waiting_for_first_chunk" | "first_chunk_received";
      latencyMs?: number;
      modelResident?: boolean;
    }
  | { kind: "step_complete"; usage?: TokenUsage; usageIsFinal?: boolean };

type StreamHandlers = {
  onEvent?: (event: StreamEvent) => void;
};

export interface LlmProvider {
  supportsVision: boolean;
  supportsReasoningStream: boolean;
  generateText(prompt: string): Promise<string>;
  analyzeAssets(prompt: string, assets: DesignAsset[]): Promise<string>;
  generateTextStream(prompt: string, handlers?: StreamHandlers): Promise<string>;
  analyzeAssetsStream(prompt: string, assets: DesignAsset[], handlers?: StreamHandlers): Promise<string>;
}

export function validateProviderConfig(config: ProviderConfig) {
  if (!config.model?.trim()) {
    throw new Error("Choose a model before running generation.");
  }
  if (config.kind === "openai" && !config.apiKey?.trim()) {
    throw new Error("OpenAI requires an API key for cloud generation.");
  }
  if (config.kind === "ollama") {
    const url = config.baseUrl || "http://localhost:11434";
    try {
      new URL(url);
    } catch {
      throw new Error("Ollama base URL must be a valid URL.");
    }
  }
}

export function createProvider(config: ProviderConfig): LlmProvider {
  validateProviderConfig(config);
  if (config.kind === "openai") return new OpenAIProvider(config);
  return new OllamaProvider(config);
}

class OpenAIProvider implements LlmProvider {
  supportsVision = true;
  supportsReasoningStream = false;

  constructor(private readonly config: ProviderConfig) {}

  async generateText(prompt: string) {
    return this.callChat([{ role: "user", content: prompt }]);
  }

  async analyzeAssets(prompt: string, assets: DesignAsset[]) {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: buildAssetPrompt(prompt, assets) }];
    for (const asset of assets.filter((item) => item.type === "image" && item.dataUrl).slice(0, 12)) {
      content.push({ type: "image_url", image_url: { url: asset.dataUrl } });
    }
    return this.callChat([{ role: "user", content }]);
  }

  async generateTextStream(prompt: string, handlers?: StreamHandlers) {
    return this.callChatStream([{ role: "user", content: prompt }], handlers);
  }

  async analyzeAssetsStream(prompt: string, assets: DesignAsset[], handlers?: StreamHandlers) {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: buildAssetPrompt(prompt, assets) }];
    for (const asset of assets.filter((item) => item.type === "image" && item.dataUrl).slice(0, 12)) {
      content.push({ type: "image_url", image_url: { url: asset.dataUrl } });
    }
    return this.callChatStream([{ role: "user", content }], handlers);
  }

  private async callChat(messages: Array<Record<string, unknown>>) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.35
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() || "";
  }

  private async callChatStream(messages: Array<Record<string, unknown>>, handlers?: StreamHandlers) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.35,
        stream: true,
        stream_options: { include_usage: true }
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("OpenAI did not return a stream body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let content = "";
    let finalUsage: TokenUsage | undefined;

    const emitFromJson = (chunk: Record<string, unknown>) => {
      const usage = parseUsage(chunk.usage);
      if (usage) {
        finalUsage = usage;
        handlers?.onEvent?.({ kind: "usage", usage, usageIsFinal: true });
      }

      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      if (!choices.length) return;
      const first = choices[0] as Record<string, unknown>;
      const delta = (first?.delta || {}) as Record<string, unknown>;
      const contentDelta = extractOpenAiDeltaText(delta.content);
      if (contentDelta) {
        content += contentDelta;
        handlers?.onEvent?.({ kind: "content", textDelta: contentDelta });
      }
      const reasoningDelta = extractReasoningText(delta);
      if (reasoningDelta) {
        this.supportsReasoningStream = true;
        handlers?.onEvent?.({ kind: "reasoning", textDelta: reasoningDelta });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        emitFromJson(json);
      }
      if (done) break;
    }

    handlers?.onEvent?.({ kind: "step_complete", usage: finalUsage, usageIsFinal: true });
    return content.trim();
  }
}

class OllamaProvider implements LlmProvider {
  supportsVision = false;
  supportsReasoningStream = false;

  constructor(private readonly config: ProviderConfig) {}

  async generateText(prompt: string) {
    return this.callGenerate(prompt);
  }

  async analyzeAssets(prompt: string, assets: DesignAsset[]) {
    return this.callGenerate(buildAssetPrompt(prompt, assets));
  }

  async generateTextStream(prompt: string, handlers?: StreamHandlers) {
    return this.callGenerateStream(prompt, handlers);
  }

  async analyzeAssetsStream(prompt: string, assets: DesignAsset[], handlers?: StreamHandlers) {
    return this.callGenerateStream(buildAssetPrompt(prompt, assets), handlers);
  }

  private async callGenerate(prompt: string) {
    const baseUrl = (this.config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        stream: false
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { response?: string };
    return json.response?.trim() || "";
  }

  private async callGenerateStream(prompt: string, handlers?: StreamHandlers) {
    const baseUrl = (this.config.baseUrl || "http://localhost:11434").replace(/\/$/, "");
    const requestStartedAt = Date.now();
    const modelResident = await this.probeModelResident(baseUrl).catch(() => undefined);
    handlers?.onEvent?.({
      kind: "status",
      status: "waiting_for_first_chunk",
      modelResident
    });
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        prompt,
        stream: true
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("Ollama did not return a stream body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let content = "";
    let finalUsage: TokenUsage | undefined;
    let firstChunkSeen = false;

    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const delta = typeof json.response === "string" ? json.response : "";
        if (!firstChunkSeen && (delta || json.done === true)) {
          firstChunkSeen = true;
          handlers?.onEvent?.({
            kind: "status",
            status: "first_chunk_received",
            latencyMs: Date.now() - requestStartedAt,
            modelResident
          });
        }
        if (delta) {
          content += delta;
          handlers?.onEvent?.({ kind: "content", textDelta: delta });
        }
        if (json.done === true) {
          const loadDurationMs = nanosToMs(asNumber(json.load_duration));
          finalUsage = {
            promptTokens: asNumber(json.prompt_eval_count),
            completionTokens: asNumber(json.eval_count),
            totalTokens: sumNumbers(asNumber(json.prompt_eval_count), asNumber(json.eval_count))
          };
          if (finalUsage.promptTokens || finalUsage.completionTokens || finalUsage.totalTokens) {
            handlers?.onEvent?.({ kind: "usage", usage: finalUsage, usageIsFinal: true, loadDurationMs });
          }
        }
      }
      if (done) break;
    }

    handlers?.onEvent?.({ kind: "step_complete", usage: finalUsage, usageIsFinal: true });
    return content.trim();
  }

  private async probeModelResident(baseUrl: string) {
    const response = await fetch(`${baseUrl}/api/ps`);
    if (!response.ok) return undefined;
    const json = (await response.json()) as { models?: Array<{ model?: string; name?: string }> };
    const models = Array.isArray(json.models) ? json.models : [];
    return models.some((entry) => {
      const value = (entry.model || entry.name || "").toLowerCase();
      return value.includes(this.config.model.toLowerCase());
    });
  }
}

function extractOpenAiDeltaText(content: unknown) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function extractReasoningText(delta: Record<string, unknown>) {
  const candidates = [delta.reasoning, delta.reasoning_content, delta.thinking];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const text = (item as Record<string, unknown>).text;
          return typeof text === "string" ? text : "";
        })
        .join("");
      if (joined) return joined;
    }
  }
  return "";
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const promptTokens = asNumber(usage.prompt_tokens);
  const completionTokens = asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens);
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumbers(a?: number, b?: number) {
  if (typeof a !== "number" && typeof b !== "number") return undefined;
  return (a || 0) + (b || 0);
}

function nanosToMs(value?: number) {
  if (typeof value !== "number") return undefined;
  return Math.round(value / 1_000_000);
}

export function buildAssetPrompt(prompt: string, assets: DesignAsset[]) {
  const assetBlocks = assets
    .map((asset, index) => {
      const body = asset.content || asset.warning || "[visual asset supplied separately if supported]";
      return `Asset ${index + 1}: ${asset.name}
Type: ${asset.type}
Source: ${asset.source}
Status: ${asset.status}
Content:
${body.slice(0, 12_000)}`;
    })
    .join("\n\n---\n\n");
  return `${prompt}

Analyze these design references. Use concrete, reusable design observations and cite asset names when useful.

${assetBlocks}`;
}

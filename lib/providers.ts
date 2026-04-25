import type { DesignAsset, ProviderConfig } from "./types";

export interface LlmProvider {
  supportsVision: boolean;
  generateText(prompt: string): Promise<string>;
  analyzeAssets(prompt: string, assets: DesignAsset[]): Promise<string>;
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
}

class OllamaProvider implements LlmProvider {
  supportsVision = false;

  constructor(private readonly config: ProviderConfig) {}

  async generateText(prompt: string) {
    return this.callGenerate(prompt);
  }

  async analyzeAssets(prompt: string, assets: DesignAsset[]) {
    return this.callGenerate(buildAssetPrompt(prompt, assets));
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

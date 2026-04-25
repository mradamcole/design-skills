import { describe, expect, it } from "vitest";
import { validateProviderConfig } from "@/lib/providers";

describe("provider validation", () => {
  it("requires an OpenAI API key", () => {
    expect(() => validateProviderConfig({ kind: "openai", model: "gpt-4o-mini" })).toThrow("API key");
  });

  it("requires a model", () => {
    expect(() => validateProviderConfig({ kind: "ollama", model: "", baseUrl: "http://localhost:11434" })).toThrow(
      "model"
    );
  });

  it("rejects invalid Ollama URLs", () => {
    expect(() => validateProviderConfig({ kind: "ollama", model: "llama3", baseUrl: "not a url" })).toThrow(
      "valid URL"
    );
  });

  it("accepts valid Ollama config", () => {
    expect(() => validateProviderConfig({ kind: "ollama", model: "llama3", baseUrl: "http://localhost:11434" })).not.toThrow();
  });
});

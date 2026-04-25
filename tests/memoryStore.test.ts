import { describe, expect, it } from "vitest";
import { addAsset, clearSettingsMemory, createSession, getSettingsMemory, updateSettingsMemory } from "@/lib/store";

describe("settings memory store", () => {
  it("persists updates until cleared", () => {
    clearSettingsMemory();

    updateSettingsMemory({
      providerKind: "ollama",
      model: "llama3.2",
      baseUrl: "http://127.0.0.1:11434",
      guidance: "Prefer concise rules."
    });

    const afterUpdate = getSettingsMemory();
    expect(afterUpdate.providerKind).toBe("ollama");
    expect(afterUpdate.model).toBe("llama3.2");
    expect(afterUpdate.baseUrl).toBe("http://127.0.0.1:11434");
    expect(afterUpdate.guidance).toContain("concise");

    const afterClear = clearSettingsMemory();
    expect(afterClear.providerKind).toBe("openai");
    expect(afterClear.model).toBe("gpt-4o-mini");
    expect(afterClear.guidance).toBe("");
    expect(afterClear.assets).toEqual([]);
  });

  it("remembers assets across newly created sessions", () => {
    clearSettingsMemory();

    const first = createSession("generate");
    addAsset(first.id, {
      id: "asset-1",
      type: "url",
      name: "Example",
      source: "https://example.com",
      mimeType: "text/plain",
      content: "sample",
      status: "ready"
    });

    const second = createSession("generate");
    expect(second.assets).toHaveLength(1);
    expect(second.assets[0].name).toBe("Example");
    expect(second.assets[0].source).toBe("https://example.com");
    expect(second.assets[0].id).not.toBe("asset-1");
  });
});

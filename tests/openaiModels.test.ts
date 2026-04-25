import { describe, expect, it } from "vitest";
import { formatOpenAIModelLabel, resolveApproxCostPer1M } from "@/lib/openaiModels";

describe("openai model pricing map", () => {
  it("resolves approximate costs for listed model families and variants", () => {
    const listedModels = [
      "gpt-3.5-turbo",
      "gpt-3.5-turbo-0125",
      "gpt-3.5-turbo-1106",
      "gpt-3.5-turbo-16k",
      "gpt-3.5-turbo-instruct",
      "gpt-3.5-turbo-instruct-0914",
      "gpt-4",
      "gpt-4-0613",
      "gpt-4-turbo-2024-04-09",
      "gpt-4.1",
      "gpt-4.1-2025-04-14",
      "gpt-4.1-mini-2025-04-14",
      "gpt-4.1-nano-2025-04-14",
      "gpt-4o",
      "gpt-4o-2024-11-20",
      "gpt-4o-mini-tts-2025-12-15",
      "gpt-4o-search-preview-2025-03-11",
      "gpt-4o-transcribe-diarize",
      "gpt-5",
      "gpt-5-2025-08-07",
      "gpt-5-chat-latest",
      "gpt-5-codex",
      "gpt-5-mini-2025-08-07",
      "gpt-5-nano-2025-08-07",
      "gpt-5-pro-2025-10-06",
      "gpt-5-search-api-2025-10-14",
      "gpt-5.1",
      "gpt-5.1-2025-11-13",
      "gpt-5.1-chat-latest",
      "gpt-5.1-codex-mini",
      "gpt-5.2",
      "gpt-5.2-2025-12-11",
      "gpt-5.2-chat-latest",
      "gpt-5.2-codex",
      "gpt-5.2-pro-2025-12-11",
      "gpt-5.3-chat-latest",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-2026-03-05",
      "gpt-5.4-mini-2026-03-17",
      "gpt-5.4-nano-2026-03-17",
      "gpt-5.4-pro-2026-03-05",
      "gpt-5.5",
      "gpt-5.5-2026-04-23",
      "gpt-5.5-pro-2026-04-23",
      "gpt-image-1-mini",
      "gpt-image-1.5",
      "gpt-image-2-2026-04-21"
    ];

    for (const modelId of listedModels) {
      const approxCost = resolveApproxCostPer1M(modelId);
      expect(approxCost, `missing approx cost for ${modelId}`).toBeTypeOf("number");
      expect(formatOpenAIModelLabel(modelId, approxCost)).toContain("~$");
    }
  });
});

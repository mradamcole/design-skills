import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, buildSkillPrompt, buildSynthesisPrompt } from "@/lib/workflowCore";

describe("workflow prompts", () => {
  it("asks extraction to preserve concrete design evidence", () => {
    const prompt = buildExtractionPrompt("prioritize website identity");

    expect(prompt).toContain("category=<one of color|typography|layout|components|accessibility|visual language>");
    expect(prompt).toContain("confidence=<high|medium|low>");
    expect(prompt).toContain("font families");
    expect(prompt).toContain("CSS variables");
    expect(prompt).toContain("Keep each bullet under 180 characters");
    expect(prompt).toContain("prioritize website identity");
  });

  it("asks synthesis and final skill prompts to carry tokens into implementation rules", () => {
    const synthesisPrompt = buildSynthesisPrompt("Typography: Inter. Color: --brand #2563eb.");
    const skillPrompt = buildSkillPrompt("Use Inter and --brand #2563eb.");

    expect(synthesisPrompt).toContain("### High Confidence");
    expect(synthesisPrompt).toContain("Keep each bullet under 180 characters");
    expect(skillPrompt).toContain("## Verification Checklist");
    expect(skillPrompt).toContain("## Brand");
    expect(skillPrompt).toContain("Keep output concise and grounded in evidence");
  });
});

import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, buildSkillPrompt, buildSynthesisPrompt } from "@/lib/workflow";

describe("workflow prompts", () => {
  it("asks extraction to preserve concrete design evidence", () => {
    const prompt = buildExtractionPrompt("prioritize website identity");

    expect(prompt).toContain("Icons, Favicons, And Imagery");
    expect(prompt).toContain("font families");
    expect(prompt).toContain("CSS custom properties");
    expect(prompt).toContain("icon/favicon paths");
    expect(prompt).toContain("Weak Or Uncertain Inferences");
    expect(prompt).toContain("prioritize website identity");
  });

  it("asks synthesis and final skill prompts to carry tokens into implementation rules", () => {
    const synthesisPrompt = buildSynthesisPrompt("Typography: Inter. Color: --brand #2563eb.");
    const skillPrompt = buildSkillPrompt("Use Inter and --brand #2563eb.");

    expect(synthesisPrompt).toContain("Preserve high-confidence tokens");
    expect(synthesisPrompt).toContain("icons/favicon/assets");
    expect(skillPrompt).toContain("## Verification Checklist");
    expect(skillPrompt).toContain("Color and tokens");
    expect(skillPrompt).toContain("Icons, favicon, and imagery");
    expect(skillPrompt).toContain("Verification: checks that compare output against concrete values");
  });
});

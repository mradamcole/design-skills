import { describe, expect, it } from "vitest";
import {
  getCompactnessIssues,
  getMissingSkillSections,
  getRepeatedSkillBullets,
  getVagueSkillPhrases,
  hasValidSkillShape,
  SECTION_INTENTS
} from "@/lib/skillQualityCore";

const validSkill = `# Design System Skill

## When To Use
Use this for design work.

## Workflow
- Inspect references.

## Design Rules
- Use compact controls.

## Brand
- Use the logo with required clear space.

## Colors
- Use semantic tokens for palette decisions.

## Typography
- Pair primary and secondary families from the system.

## Voice
- Use sentence case for product copy.

## Accessibility And Responsiveness
- Keep text readable.

## Verification Checklist
- Check layout.

## Examples
- Build a sample.
`;

describe("skill quality", () => {
  it("accepts the required skill shape", () => {
    expect(hasValidSkillShape(validSkill)).toBe(true);
  });

  it("reports missing sections", () => {
    const missing = getMissingSkillSections("# Design System Skill");
    expect(missing).toContain("## Design Rules");
    expect(missing).toContain("## Brand");
    expect(missing).toContain("## Colors");
    expect(missing).toContain("## Typography");
    expect(missing).toContain("## Voice");
  });

  it("flags vague phrases", () => {
    expect(getVagueSkillPhrases(`${validSkill}\nMake it clean and modern.`)).toContain("clean and modern");
  });

  it("detects repeated bullets and compactness issues", () => {
    const withRepeated = `${validSkill}\n- Check layout.\n- Check layout.`;
    expect(getRepeatedSkillBullets(withRepeated)).toContain("check layout.");
    expect(getCompactnessIssues("# Design System Skill\n\n## When To Use\n- one")).toContain(
      "## Workflow: section body is empty."
    );
  });

  it("exports intents for canonical sections", () => {
    expect(SECTION_INTENTS["## Brand"]).toContain("logo");
    expect(SECTION_INTENTS["## Colors"]).toContain("tokens");
    expect(SECTION_INTENTS["## Typography"]).toContain("font");
    expect(SECTION_INTENTS["## Voice"]).toContain("capitalization");
  });
});

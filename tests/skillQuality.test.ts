import { describe, expect, it } from "vitest";
import { getMissingSkillSections, getVagueSkillPhrases, hasValidSkillShape } from "@/lib/skillQuality";

const validSkill = `# Design System Skill

## When To Use
Use this for design work.

## Workflow
- Inspect references.

## Design Rules
- Use compact controls.

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
    expect(getMissingSkillSections("# Design System Skill")).toContain("## Design Rules");
  });

  it("flags vague phrases", () => {
    expect(getVagueSkillPhrases(`${validSkill}\nMake it clean and modern.`)).toContain("clean and modern");
  });
});

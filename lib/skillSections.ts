export type SkillSectionId =
  | "when_to_use"
  | "workflow"
  | "design_rules"
  | "brand"
  | "colors"
  | "typography"
  | "voice"
  | "accessibility_and_responsiveness"
  | "verification_checklist"
  | "examples";

export interface SkillSectionDefinition {
  id: SkillSectionId;
  heading: `## ${string}`;
  intent: string;
  evidenceCategories: string[];
  target: {
    minBullets?: number;
    maxBullets?: number;
    maxCharsPerBullet?: number;
  };
  emptyEvidencePolicy: string;
}

export const SKILL_TITLE = "# Design System Skill";

export const SKILL_SECTION_DEFINITIONS: SkillSectionDefinition[] = [
  {
    id: "when_to_use",
    heading: "## When To Use",
    intent: "Explain when an agent should apply this skill and what outcome it is optimizing for.",
    evidenceCategories: ["visual language", "layout", "components"],
    target: { minBullets: 2, maxBullets: 4, maxCharsPerBullet: 140 },
    emptyEvidencePolicy: "State the scope boundaries and avoid claiming specific visual tokens."
  },
  {
    id: "workflow",
    heading: "## Workflow",
    intent: "Provide ordered operational steps the agent can follow while implementing UI output.",
    evidenceCategories: ["layout", "components", "accessibility", "visual language"],
    target: { minBullets: 4, maxBullets: 7, maxCharsPerBullet: 160 },
    emptyEvidencePolicy: "Use generic operational steps; do not claim source-specific design facts."
  },
  {
    id: "design_rules",
    heading: "## Design Rules",
    intent: "Capture enforceable cross-cutting rules for composition, components, and interaction.",
    evidenceCategories: ["layout", "components", "visual language", "accessibility"],
    target: { minBullets: 4, maxBullets: 10, maxCharsPerBullet: 180 },
    emptyEvidencePolicy: "Emit only broadly safe constraints and explicitly avoid invented specifics."
  },
  {
    id: "brand",
    heading: "## Brand",
    intent: "Define logo, identity, and asset constraints with concrete do/don't guidance.",
    evidenceCategories: ["visual language", "components"],
    target: { minBullets: 1, maxBullets: 5, maxCharsPerBullet: 160 },
    emptyEvidencePolicy: "State that logo/brand specifics are unknown and must not be invented."
  },
  {
    id: "colors",
    heading: "## Colors",
    intent: "Document concrete color tokens, values, and semantic pairings.",
    evidenceCategories: ["color", "visual language", "components"],
    target: { minBullets: 2, maxBullets: 8, maxCharsPerBullet: 180 },
    emptyEvidencePolicy: "State that palette tokens are unavailable and should not be fabricated."
  },
  {
    id: "typography",
    heading: "## Typography",
    intent: "Specify font/type families, sizes, weights, and hierarchy behaviors.",
    evidenceCategories: ["typography", "layout", "visual language"],
    target: { minBullets: 2, maxBullets: 8, maxCharsPerBullet: 180 },
    emptyEvidencePolicy: "State that type scale/families are unknown and must remain unspecified."
  },
  {
    id: "voice",
    heading: "## Voice",
    intent: "Describe copy style and capitalization requirements supported by evidence.",
    evidenceCategories: ["visual language"],
    target: { minBullets: 1, maxBullets: 4, maxCharsPerBullet: 140 },
    emptyEvidencePolicy: "Say copy tone is not evidenced and avoid inventing branding voice."
  },
  {
    id: "accessibility_and_responsiveness",
    heading: "## Accessibility And Responsiveness",
    intent: "Define a11y and responsive behaviors with concrete checks and state requirements.",
    evidenceCategories: ["accessibility", "layout", "components", "typography", "color"],
    target: { minBullets: 3, maxBullets: 8, maxCharsPerBullet: 180 },
    emptyEvidencePolicy: "Provide baseline accessibility constraints without claiming unsupported breakpoints."
  },
  {
    id: "verification_checklist",
    heading: "## Verification Checklist",
    intent: "Provide concise checks to verify output against concrete values and patterns.",
    evidenceCategories: ["layout", "typography", "color", "components", "accessibility"],
    target: { minBullets: 4, maxBullets: 10, maxCharsPerBullet: 160 },
    emptyEvidencePolicy: "Use generic verification checks and explicitly note missing concrete tokens."
  },
  {
    id: "examples",
    heading: "## Examples",
    intent: "Give short examples that demonstrate correct application of the rules.",
    evidenceCategories: ["components", "layout", "typography", "color", "voice"],
    target: { minBullets: 1, maxBullets: 3, maxCharsPerBullet: 200 },
    emptyEvidencePolicy: "Provide minimal placeholder examples and avoid introducing unsupported branding facts."
  }
];

export const REQUIRED_SKILL_SECTIONS = SKILL_SECTION_DEFINITIONS.map((section) => section.heading);

export const SECTION_INTENTS: Record<string, string> = Object.fromEntries(
  SKILL_SECTION_DEFINITIONS.map((section) => [section.heading, section.intent])
);

export const SECTION_DEFINITION_BY_HEADING: Record<string, SkillSectionDefinition> = Object.fromEntries(
  SKILL_SECTION_DEFINITIONS.map((section) => [section.heading, section])
);

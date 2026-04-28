export * from "./skillQualityCore";
import { REQUIRED_SKILL_SECTIONS, SECTION_INTENTS, SKILL_SECTION_DEFINITIONS } from "./skillSections";

const VAGUE_PHRASES = [
  "clean and modern",
  "make it pop",
  "user friendly",
  "beautiful",
  "nice design",
  "visually appealing",
  "delightful"
];

export { SECTION_INTENTS };

export function getMissingSkillSections(markdown: string) {
  return REQUIRED_SKILL_SECTIONS.filter((section) => !markdown.includes(section));
}

export function getVagueSkillPhrases(markdown: string) {
  const lower = markdown.toLowerCase();
  return VAGUE_PHRASES.filter((phrase) => lower.includes(phrase));
}

export function getRepeatedSkillBullets(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").toLowerCase());
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([line]) => line);
}

export function getCompactnessIssues(markdown: string) {
  const issues: string[] = [];
  for (const section of SKILL_SECTION_DEFINITIONS) {
    const body = extractSectionBody(markdown, section.heading);
    if (!body) {
      issues.push(`${section.heading}: section body is empty.`);
      continue;
    }
    const bullets = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, ""));
    if (section.target.maxBullets && bullets.length > section.target.maxBullets) {
      issues.push(`${section.heading}: too many bullets (${bullets.length}/${section.target.maxBullets}).`);
    }
    if (section.target.minBullets && bullets.length < section.target.minBullets) {
      issues.push(`${section.heading}: too few bullets (${bullets.length}/${section.target.minBullets}).`);
    }
    const maxCharsPerBullet = section.target.maxCharsPerBullet;
    if (maxCharsPerBullet) {
      const tooLong = bullets.find((bullet) => bullet.length > maxCharsPerBullet);
      if (tooLong) {
        issues.push(`${section.heading}: bullet exceeds ${maxCharsPerBullet} chars.`);
      }
    }
  }
  return issues;
}

export function hasValidSkillShape(markdown: string) {
  return markdown.trim().startsWith("#") && getMissingSkillSections(markdown).length === 0;
}

function extractSectionBody(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return markdown.match(pattern)?.[1]?.trim() || "";
}
import { REQUIRED_SKILL_SECTIONS, SECTION_INTENTS, SKILL_SECTION_DEFINITIONS } from "./skillSections";

const VAGUE_PHRASES = [
  "clean and modern",
  "make it pop",
  "user friendly",
  "beautiful",
  "nice design",
  "visually appealing",
  "delightful"
];

export { SECTION_INTENTS };

export function getMissingSkillSections(markdown: string) {
  return REQUIRED_SKILL_SECTIONS.filter((section) => !markdown.includes(section));
}

export function getVagueSkillPhrases(markdown: string) {
  const lower = markdown.toLowerCase();
  return VAGUE_PHRASES.filter((phrase) => lower.includes(phrase));
}

export function getRepeatedSkillBullets(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").toLowerCase());
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([line]) => line);
}

export function getCompactnessIssues(markdown: string) {
  const issues: string[] = [];
  for (const section of SKILL_SECTION_DEFINITIONS) {
    const body = extractSectionBody(markdown, section.heading);
    if (!body) {
      issues.push(`${section.heading}: section body is empty.`);
      continue;
    }
    const bullets = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, ""));
    if (section.target.maxBullets && bullets.length > section.target.maxBullets) {
      issues.push(`${section.heading}: too many bullets (${bullets.length}/${section.target.maxBullets}).`);
    }
    if (section.target.minBullets && bullets.length < section.target.minBullets) {
      issues.push(`${section.heading}: too few bullets (${bullets.length}/${section.target.minBullets}).`);
    }
    const maxCharsPerBullet = section.target.maxCharsPerBullet;
    if (maxCharsPerBullet) {
      const tooLong = bullets.find((bullet) => bullet.length > maxCharsPerBullet);
      if (tooLong) {
        issues.push(`${section.heading}: bullet exceeds ${maxCharsPerBullet} chars.`);
      }
    }
  }
  return issues;
}

export function hasValidSkillShape(markdown: string) {
  return markdown.trim().startsWith("#") && getMissingSkillSections(markdown).length === 0;
}

function extractSectionBody(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return markdown.match(pattern)?.[1]?.trim() || "";
}
const REQUIRED_SECTIONS = [
  "## When To Use",
  "## Workflow",
  "## Design Rules",
  "## Brand",
  "## Colors",
  "## Typography",
  "## Voice",
  "## Accessibility And Responsiveness",
  "## Verification Checklist",
  "## Examples"
];

export const SECTION_INTENTS: Record<string, string> = {
  "## When To Use": "Explain when an agent should apply this skill and what problems it is meant to solve.",
  "## Workflow": "Outline the step-by-step process the agent should follow to apply the guidance consistently.",
  "## Design Rules": "Capture concrete, enforceable UI rules the agent must implement across components and layouts.",
  "## Brand": "Define logo usage, required clear space, and concrete do/don't guidance.",
  "## Colors": "Document palette choices, design tokens, and semantic color mappings.",
  "## Typography": "Specify font families, scale, weights, and approved pairings.",
  "## Voice": "Describe copy tone and capitalization rules for consistent messaging.",
  "## Accessibility And Responsiveness":
    "Specify accessibility requirements and responsive behavior expectations across breakpoints and interaction modes.",
  "## Verification Checklist":
    "Provide concrete checks an agent can run to confirm outputs match required patterns and values.",
  "## Examples": "Give practical examples that demonstrate how to apply the rules correctly in real UI work."
};

const VAGUE_PHRASES = [
  "clean and modern",
  "make it pop",
  "user friendly",
  "beautiful",
  "nice design",
  "visually appealing"
];

export function getMissingSkillSections(markdown: string) {
  return REQUIRED_SECTIONS.filter((section) => !markdown.includes(section));
}

export function getVagueSkillPhrases(markdown: string) {
  const lower = markdown.toLowerCase();
  return VAGUE_PHRASES.filter((phrase) => lower.includes(phrase));
}

export function hasValidSkillShape(markdown: string) {
  return markdown.trim().startsWith("#") && getMissingSkillSections(markdown).length === 0;
}

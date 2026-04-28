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
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
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
    if (section.target.maxCharsPerBullet) {
      const tooLong = bullets.find((bullet) => bullet.length > section.target.maxCharsPerBullet!);
      if (tooLong) issues.push(`${section.heading}: bullet exceeds ${section.target.maxCharsPerBullet} chars.`);
    }
  }
  return issues;
}

export function hasValidSkillShape(markdown: string) {
  return markdown.trim().startsWith("#") && getMissingSkillSections(markdown).length === 0;
}

export function getCrossSectionContaminationIssues(markdown: string) {
  const issues: string[] = [];
  const typographyBody = extractSectionBody(markdown, "## Typography").toLowerCase();
  if (typographyBody.match(/#[0-9a-f]{3,8}\b|rgba?\(/i)) {
    issues.push("## Typography: appears to contain color values that should live in ## Colors.");
  }
  const colorsBody = extractSectionBody(markdown, "## Colors").toLowerCase();
  if (colorsBody.includes("font-family") || colorsBody.includes("font-size")) {
    issues.push("## Colors: appears to contain typography declarations.");
  }
  const brandBody = extractSectionBody(markdown, "## Brand").toLowerCase();
  if (brandBody.includes("tone") || brandBody.includes("sentence case")) {
    issues.push("## Brand: appears to contain voice guidance.");
  }
  return issues;
}

export function getGroundingCoverage(markdown: string, factValues: string[]) {
  const bullets = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").toLowerCase());
  if (!bullets.length || !factValues.length) return 0;
  const normalizedFacts = factValues.map((value) => value.toLowerCase());
  const grounded = bullets.filter((bullet) => normalizedFacts.some((fact) => bullet.includes(fact) || fact.includes(bullet)));
  return grounded.length / bullets.length;
}

function extractSectionBody(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return markdown.match(pattern)?.[1]?.trim() || "";
}

const REQUIRED_SECTIONS = [
  "## When To Use",
  "## Workflow",
  "## Design Rules",
  "## Accessibility And Responsiveness",
  "## Verification Checklist",
  "## Examples"
];

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

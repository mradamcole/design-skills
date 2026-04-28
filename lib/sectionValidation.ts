import type { SkillSectionDefinition } from "./skillSections";
import type { CompiledSectionEvidence } from "./sectionEvidence";

export type ValidationSeverity = "error" | "warning";

export interface SectionValidationIssue {
  severity: ValidationSeverity;
  message: string;
}

export interface SectionValidationResult {
  isValid: boolean;
  issues: SectionValidationIssue[];
}

export function validateSectionClaims(section: SkillSectionDefinition, draftSection: string, packet: CompiledSectionEvidence): SectionValidationResult {
  const issues: SectionValidationIssue[] = [];
  const body = stripHeading(section.heading, draftSection);
  const bullets = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""));

  if (section.target.minBullets && bullets.length < section.target.minBullets) {
    issues.push({ severity: "error", message: `${section.heading}: too few bullets (${bullets.length}/${section.target.minBullets}).` });
  }
  if (section.target.maxBullets && bullets.length > section.target.maxBullets) {
    issues.push({ severity: "error", message: `${section.heading}: too many bullets (${bullets.length}/${section.target.maxBullets}).` });
  }
  if (section.target.maxCharsPerBullet) {
    const tooLong = bullets.find((line) => line.length > section.target.maxCharsPerBullet!);
    if (tooLong) issues.push({ severity: "error", message: `${section.heading}: bullet exceeds ${section.target.maxCharsPerBullet} chars.` });
  }

  if (!packet.selectedFacts.length && !body.toLowerCase().includes(section.emptyEvidencePolicy.toLowerCase().slice(0, 24))) {
    issues.push({ severity: "error", message: `${section.heading}: sparse evidence fallback was not used.` });
  }

  const normalizedFacts = packet.selectedFacts.map((fact) => fact.normalizedValue);
  const concreteValues = body.match(/#[0-9a-f]{3,8}\b|--[\w-]+|\b\d+(?:\.\d+)?(?:px|rem|em|%)\b/gi) || [];
  for (const value of concreteValues) {
    const normalized = value.toLowerCase();
    const grounded = normalizedFacts.some((factValue) => factValue.includes(normalized) || normalized.includes(factValue));
    if (!grounded) {
      issues.push({ severity: "error", message: `${section.heading}: unsupported concrete value '${value}'.` });
      break;
    }
  }

  if (packet.conflicts.length && !/(conflict|mixed|varies|uncertain|inconsistent)/i.test(body)) {
    issues.push({ severity: "warning", message: `${section.heading}: conflicts exist but section may be over-assertive.` });
  }

  return {
    isValid: !issues.some((issue) => issue.severity === "error"),
    issues
  };
}

function stripHeading(heading: string, sectionText: string) {
  return sectionText.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

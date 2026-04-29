import { SKILL_SECTION_DEFINITIONS, type SkillSectionDefinition, type SkillSectionId } from "./skillSections";
import type { DesignAsset, SourceObservation } from "./types";

export type ObservationCategory =
  | "color"
  | "typography"
  | "layout"
  | "components"
  | "accessibility"
  | "visual language"
  | "voice";
export type FactConfidence = "low" | "medium" | "high";

export type FactKind =
  | "font-import"
  | "font-family"
  | "font-size"
  | "font-weight"
  | "line-height"
  | "letter-spacing"
  | "color-value"
  | "css-token"
  | "semantic-color-hint"
  | "contrast-risk"
  | "spacing"
  | "grid"
  | "alignment"
  | "density"
  | "breakpoint"
  | "container"
  | "component-pattern"
  | "state"
  | "radius"
  | "shadow"
  | "interaction"
  | "focus-state"
  | "contrast"
  | "motion"
  | "target-size"
  | "keyboard"
  | "responsive-behavior"
  | "logo"
  | "icon"
  | "asset"
  | "theme-color"
  | "identity-constraint"
  | "tone"
  | "capitalization"
  | "copy-pattern"
  | "label-style"
  | "composition"
  | "mood"
  | "surface"
  | "hierarchy"
  | "imagery"
  | "unknown";

export interface CompiledEvidenceFact {
  factId: string;
  sectionId: SkillSectionId;
  category: ObservationCategory;
  kind: FactKind;
  value: string;
  normalizedValue: string;
  confidence: FactConfidence;
  sourceAssetIds: string[];
  sourceAssetNames: string[];
  sourceCount: number;
  frequency: number;
  supportScore: number;
}

export interface EvidenceConflict {
  kind: FactKind;
  values: string[];
  sourceAssetIds: string[];
}

export interface CompiledSectionEvidence {
  section: SkillSectionDefinition;
  facts: CompiledEvidenceFact[];
  selectedFacts: CompiledEvidenceFact[];
  conflicts: EvidenceConflict[];
  unknowns: string[];
  /** True when URL assets include substantial `## Readable Page Text` (Voice + validation). */
  voiceReadableNarrativeAvailable?: boolean;
}

const CONFIDENCE_WEIGHT: Record<FactConfidence, number> = {
  high: 1,
  medium: 0.7,
  low: 0.3
};

const GENERIC_PHRASES = ["clean and modern", "make it pop", "user friendly", "beautiful", "visually appealing"];
const CSS_SIGNAL_HEADING_MAP: Array<{ heading: string; category: ObservationCategory }> = [
  { heading: "Typography Signals", category: "typography" },
  { heading: "Color And Token Signals", category: "color" },
  { heading: "Shape, Shadow, And Spacing Signals", category: "layout" }
];

const FACT_KIND_PRIORITY: Partial<Record<FactKind, number>> = {
  "font-family": 12,
  "font-size": 11,
  "font-weight": 10,
  "line-height": 9,
  "letter-spacing": 8,
  "css-token": 12,
  "color-value": 11,
  spacing: 9,
  radius: 8,
  tone: 9,
  "copy-pattern": 9,
  capitalization: 9,
  "label-style": 9
};

const SECTION_FACT_LIMITS: Partial<Record<SkillSectionId, number>> = {
  typography: 12,
  colors: 12,
  design_rules: 14,
  brand: 6,
  voice: 6,
  verification_checklist: 8,
  examples: 6
};

export function normalizeObservationCategory(category: string): ObservationCategory {
  const value = category.trim().toLowerCase();
  if (/\bvoice\b/.test(value) || /\bcopy\b/.test(value) || /\bmicrocopy\b/.test(value) || /\bcopywriting\b/.test(value)) return "voice";
  if (value.includes("color")) return "color";
  if (value.includes("type") || value.includes("font")) return "typography";
  if (value.includes("layout") || value.includes("grid")) return "layout";
  if (value.includes("component") || value.includes("pattern")) return "components";
  if (value.includes("access")) return "accessibility";
  return "visual language";
}

/** Exported for section evidence packets and hybrid Voice routing. */
export function urlAssetsHaveSubstantialReadableText(assets: DesignAsset[], minChars = 120): boolean {
  const marker = "## Readable Page Text";
  for (const asset of assets) {
    if (asset.type !== "url" || !asset.content) continue;
    const idx = asset.content.indexOf(marker);
    if (idx === -1) continue;
    const after = asset.content.slice(idx + marker.length);
    const segment = (after.split(/\n##\s+/)[0] ?? "").replace(/^\s+/, "").trim();
    if (!segment || segment.toLowerCase() === "no readable page text extracted.") continue;
    if (segment.length >= minChars) return true;
  }
  return false;
}

export type CompileSectionEvidenceOptions = {
  sectionDefinitions?: SkillSectionDefinition[];
  /** When set, caps selected facts for ## Colors (defaults to static SECTION_FACT_LIMITS.colors). */
  colorsFactLimit?: number;
};

export function compileSectionEvidence(
  observations: SourceObservation[],
  assets: DesignAsset[],
  options?: CompileSectionEvidenceOptions
): CompiledSectionEvidence[] {
  const defs = options?.sectionDefinitions ?? SKILL_SECTION_DEFINITIONS;
  const merged = observations.concat(extractAssetSignalObservations(assets));
  return defs.map((section) => {
    const candidates = merged.filter((observation) => section.evidenceCategories.includes(normalizeObservationCategory(observation.category)));
    const facts = compileFactsForSection(section.id, candidates);
    const conflicts = detectConflicts(facts);
    const voiceReadableNarrativeAvailable = section.id === "voice" ? urlAssetsHaveSubstantialReadableText(assets) : false;
    const unknowns = buildUnknowns(section, facts, section.id === "voice" && voiceReadableNarrativeAvailable);
    const selectedFacts = selectFactsForSection(section.id, facts, options?.colorsFactLimit);
    return {
      section,
      facts,
      selectedFacts,
      conflicts,
      unknowns,
      voiceReadableNarrativeAvailable: section.id === "voice" ? voiceReadableNarrativeAvailable : undefined
    };
  });
}

function extractAssetSignalObservations(assets: DesignAsset[]): SourceObservation[] {
  const observations: SourceObservation[] = [];
  for (const asset of assets) {
    if (!asset.content || asset.type !== "url") continue;
    for (const signalSection of CSS_SIGNAL_HEADING_MAP) {
      const sectionBody = extractMarkdownSection(asset.content, signalSection.heading);
      for (const line of sectionBody) {
        const value = line.replace(/^-\s*/, "").trim();
        if (!value || value.toLowerCase() === "none detected") continue;
        observations.push({
          assetId: asset.id,
          assetName: asset.name,
          category: signalSection.category,
          observation: value,
          confidence: "high"
        });
      }
    }
  }
  return observations;
}

function extractMarkdownSection(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s+${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const body = markdown.match(pattern)?.[1] || "";
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function compileFactsForSection(sectionId: SkillSectionId, observations: SourceObservation[]) {
  const dedupe = new Map<string, CompiledEvidenceFact>();
  for (const item of observations) {
    const parsed = parseObservation(item.observation, normalizeObservationCategory(item.category), sectionId);
    for (const candidate of parsed) {
      const key = `${candidate.kind}::${candidate.normalizedValue}`;
      const existing = dedupe.get(key);
      if (!existing) {
        dedupe.set(key, {
          factId: crypto.randomUUID(),
          sectionId,
          category: normalizeObservationCategory(item.category),
          kind: candidate.kind,
          value: candidate.value,
          normalizedValue: candidate.normalizedValue,
          confidence: item.confidence,
          sourceAssetIds: [item.assetId],
          sourceAssetNames: [item.assetName],
          sourceCount: 1,
          frequency: 1,
          supportScore: 0
        });
        continue;
      }
      if (!existing.sourceAssetIds.includes(item.assetId)) existing.sourceAssetIds.push(item.assetId);
      if (!existing.sourceAssetNames.includes(item.assetName)) existing.sourceAssetNames.push(item.assetName);
      existing.sourceCount = existing.sourceAssetIds.length;
      existing.frequency += 1;
      existing.confidence = higherConfidence(existing.confidence, item.confidence);
    }
  }
  return Array.from(dedupe.values()).map((fact) => ({
    ...fact,
    supportScore: scoreFact(fact)
  }));
}

function looksLikeCssOrTokenLine(value: string): boolean {
  const v = value.trim();
  if (/^import:\s/i.test(v)) return true;
  if (
    /\b(font-family|font-size|font-weight|line-height|letter-spacing|color|margin|padding|gap|spacing|border-radius|box-shadow)\s*:/i.test(v)
  )
    return true;
  if (/--[\w-]+\s*:/.test(v)) return true;
  return false;
}

function parseVoiceObservationHeuristics(value: string, lower: string, normalized: string) {
  const results: Array<{ kind: FactKind; value: string; normalizedValue: string }> = [];
  if (lower.includes("sentence case") || lower.includes("title case")) {
    results.push({ kind: "capitalization", value: normalized, normalizedValue: normalized.toLowerCase() });
  }
  if (lower.includes("tone") || lower.includes("voice") || lower.includes("microcopy")) {
    results.push({ kind: "tone", value: normalized, normalizedValue: normalized.toLowerCase() });
  }
  if (/\b(we|our|you|your|you're)\b/i.test(lower)) {
    results.push({ kind: "copy-pattern", value: normalized, normalizedValue: "pronoun-address" });
  }
  if (
    /\b(get started|learn more|sign up|sign in|contact us|try for free|subscribe|book a demo|request demo|start free)\b/i.test(lower)
  ) {
    results.push({ kind: "label-style", value: normalized, normalizedValue: "cta-verb-pattern" });
  }
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){2,}/.test(value) && /[a-z]/.test(value)) {
    results.push({ kind: "capitalization", value: normalized, normalizedValue: "title-case-phrases" });
  }
  if (/\?/.test(value)) {
    results.push({ kind: "copy-pattern", value: normalized, normalizedValue: "question-led" });
  }
  return results;
}

function appendDesignTokenFacts(
  normalized: string,
  lower: string,
  results: Array<{ kind: FactKind; value: string; normalizedValue: string }>,
  options?: { omitCssTokensAndHex?: boolean }
) {
  if (!options?.omitCssTokensAndHex) {
    const cssTokenMatches = normalized.match(/--[\w-]+/g) || [];
    for (const token of cssTokenMatches) {
      results.push({ kind: "css-token", value: token, normalizedValue: token.toLowerCase() });
    }
    const colorMatches = normalized.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi) || [];
    for (const color of colorMatches) {
      results.push({ kind: "color-value", value: color, normalizedValue: normalizeColor(color) });
    }
  }
  const fontFamily = captureValue(normalized, /font-family:\s*([^;]+)/i);
  if (fontFamily) results.push({ kind: "font-family", value: fontFamily, normalizedValue: fontFamily.toLowerCase() });
  const fontSize = captureValue(normalized, /font-size:\s*([^;]+)/i);
  if (fontSize) results.push({ kind: "font-size", value: fontSize, normalizedValue: fontSize.toLowerCase() });
  const fontWeight = captureValue(normalized, /font-weight:\s*([^;]+)/i);
  if (fontWeight) results.push({ kind: "font-weight", value: fontWeight, normalizedValue: fontWeight.toLowerCase() });
  const lineHeight = captureValue(normalized, /line-height:\s*([^;]+)/i);
  if (lineHeight) results.push({ kind: "line-height", value: lineHeight, normalizedValue: lineHeight.toLowerCase() });
  const letterSpacing = captureValue(normalized, /letter-spacing:\s*([^;]+)/i);
  if (letterSpacing) results.push({ kind: "letter-spacing", value: letterSpacing, normalizedValue: letterSpacing.toLowerCase() });
  const spacingValue = captureValue(normalized, /(gap|margin|padding|spacing):\s*([^;]+)/i, 2);
  if (spacingValue) results.push({ kind: "spacing", value: spacingValue, normalizedValue: spacingValue.toLowerCase() });
  const radiusValue = captureValue(normalized, /(border-radius|radius):\s*([^;]+)/i, 2);
  if (radiusValue) results.push({ kind: "radius", value: radiusValue, normalizedValue: radiusValue.toLowerCase() });
  const shadowValue = captureValue(normalized, /box-shadow:\s*([^;]+)/i);
  if (shadowValue) results.push({ kind: "shadow", value: shadowValue, normalizedValue: shadowValue.toLowerCase() });
  if (lower.includes("focus")) results.push({ kind: "focus-state", value: normalized, normalizedValue: "focus-state" });
  if (lower.includes("contrast")) results.push({ kind: "contrast", value: normalized, normalizedValue: "contrast" });
  if (lower.includes("hover") || lower.includes("active")) results.push({ kind: "state", value: normalized, normalizedValue: "state" });
  if (lower.includes("logo") || lower.includes("icon")) results.push({ kind: "icon", value: normalized, normalizedValue: "icon-or-logo" });
  if (lower.includes("sentence case") || lower.includes("title case")) {
    results.push({ kind: "capitalization", value: normalized, normalizedValue: normalized.toLowerCase() });
  }
  if (lower.includes("tone") || lower.includes("voice")) {
    results.push({ kind: "tone", value: normalized, normalizedValue: normalized.toLowerCase() });
  }
}

function parseObservation(value: string, category: ObservationCategory, sectionId: SkillSectionId) {
  const normalized = normalizeValue(value);
  const lower = normalized.toLowerCase();
  const results: Array<{ kind: FactKind; value: string; normalizedValue: string }> = [];

  if (sectionId === "voice") {
    const voiceHeuristics = parseVoiceObservationHeuristics(value, lower, normalized);
    if (voiceHeuristics.length) return voiceHeuristics;

    const omitTokens =
      !looksLikeCssOrTokenLine(normalized) && normalized.length > 50
        ? { omitCssTokensAndHex: true as const }
        : undefined;
    appendDesignTokenFacts(normalized, lower, results, omitTokens);
    if (!results.length) {
      results.push({ kind: fallbackKindForCategory(category, sectionId), value: normalized, normalizedValue: normalized.toLowerCase() });
    }
    return results;
  }

  appendDesignTokenFacts(normalized, lower, results);
  if (!results.length) {
    results.push({ kind: fallbackKindForCategory(category, sectionId), value: normalized, normalizedValue: normalized.toLowerCase() });
  }
  return results;
}

function factKindSortPriority(sectionId: SkillSectionId, kind: FactKind): number {
  const base = FACT_KIND_PRIORITY[kind] || 0;
  if (sectionId !== "voice") return base;
  const voiceBoost: Partial<Record<FactKind, number>> = {
    tone: 20,
    "copy-pattern": 20,
    capitalization: 18,
    "label-style": 18
  };
  return base + (voiceBoost[kind] || 0);
}

function selectFactsForSection(sectionId: SkillSectionId, facts: CompiledEvidenceFact[], colorsFactLimit?: number) {
  const defaultLimit = SECTION_FACT_LIMITS[sectionId] ?? 10;
  const limit =
    sectionId === "colors" && colorsFactLimit !== undefined ? colorsFactLimit : defaultLimit;
  return facts
    .slice()
    .sort((a, b) => {
      if (b.supportScore !== a.supportScore) return b.supportScore - a.supportScore;
      if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return a.normalizedValue.localeCompare(b.normalizedValue);
    })
    .sort((a, b) => factKindSortPriority(sectionId, b.kind) - factKindSortPriority(sectionId, a.kind))
    .slice(0, limit);
}

function detectConflicts(facts: CompiledEvidenceFact[]): EvidenceConflict[] {
  const byKind = new Map<FactKind, CompiledEvidenceFact[]>();
  for (const fact of facts) {
    const list = byKind.get(fact.kind) || [];
    list.push(fact);
    byKind.set(fact.kind, list);
  }
  const conflicts: EvidenceConflict[] = [];
  for (const [kind, entries] of byKind.entries()) {
    if (entries.length < 2) continue;
    const top = entries
      .slice()
      .sort((a, b) => b.supportScore - a.supportScore)
      .slice(0, 2);
    if (top.length < 2 || top[0].normalizedValue === top[1].normalizedValue) continue;
    const diff = Math.abs(top[0].supportScore - top[1].supportScore);
    if (diff <= 0.4) {
      conflicts.push({
        kind,
        values: top.map((entry) => entry.value),
        sourceAssetIds: Array.from(new Set(top.flatMap((entry) => entry.sourceAssetIds)))
      });
    }
  }
  return conflicts;
}

function buildUnknowns(section: SkillSectionDefinition, facts: CompiledEvidenceFact[], voiceReadableTextAvailable: boolean) {
  if (facts.length) return [];
  if (section.id === "voice" && voiceReadableTextAvailable) {
    return [
      "Readable text is present; only state copy patterns clearly supported by observations; do not invent a full brand voice."
    ];
  }
  return [section.emptyEvidencePolicy];
}

function scoreFact(fact: Omit<CompiledEvidenceFact, "supportScore">) {
  const confidence = CONFIDENCE_WEIGHT[fact.confidence];
  const sourceCountWeight = 1 + Math.min(Math.max(fact.sourceCount - 1, 0), 3) * 0.25;
  const frequencyWeight = Math.log(1 + fact.frequency);
  const specificityWeight = computeSpecificityWeight(fact);
  const genericPenalty = GENERIC_PHRASES.some((phrase) => fact.normalizedValue.includes(phrase)) ? 0.75 : 1;
  return confidence * sourceCountWeight * frequencyWeight * specificityWeight * genericPenalty;
}

function computeSpecificityWeight(fact: Omit<CompiledEvidenceFact, "supportScore">) {
  if (fact.kind === "css-token" || fact.kind === "font-size" || fact.kind === "color-value") return 1.3;
  if (/\b\d+(px|rem|em|%)\b/i.test(fact.value)) return 1.2;
  if (fact.value.includes("--")) return 1.2;
  return 1;
}

function fallbackKindForCategory(category: ObservationCategory, sectionId: SkillSectionId): FactKind {
  if (sectionId === "voice") return "tone";
  if (category === "voice") return "tone";
  if (sectionId === "brand") return "identity-constraint";
  if (category === "color") return "semantic-color-hint";
  if (category === "typography") return "hierarchy";
  if (category === "layout") return "composition";
  if (category === "components") return "component-pattern";
  if (category === "accessibility") return "responsive-behavior";
  return "unknown";
}

function normalizeValue(value: string) {
  return value.replace(/^-\s*/, "").replace(/\s+/g, " ").trim();
}

function normalizeColor(color: string) {
  return color
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

function captureValue(value: string, pattern: RegExp, index = 1) {
  const match = value.match(pattern);
  return match?.[index]?.trim();
}

function higherConfidence(a: FactConfidence, b: FactConfidence): FactConfidence {
  const order: FactConfidence[] = ["low", "medium", "high"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

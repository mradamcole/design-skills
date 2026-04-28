import { addProgress, getSession, updateSession } from "./store";
import { createProvider, type LlmProvider } from "./providers";
import {
  REQUIRED_SKILL_SECTIONS,
  SECTION_DEFINITION_BY_HEADING,
  SKILL_SECTION_DEFINITIONS,
  SKILL_TITLE,
  type SkillSectionDefinition
} from "./skillSections";
import {
  getCompactnessIssues,
  getMissingSkillSections,
  getRepeatedSkillBullets,
  getVagueSkillPhrases
} from "./skillQualityCore";
import type {
  DesignAsset,
  ProgressStepId,
  ProviderConfig,
  SourceObservation,
  TokenUsage,
  VerificationFinding,
  VerificationReport
} from "./types";

type GenerationRuntimeOptions = {
  provider?: LlmProvider;
  sectionFirstEnabled?: boolean;
  retriesPerSection?: number;
  sectionTimeoutMs?: number;
  onSkillDraftUpdate?: (markdown: string) => void;
};
type SectionDraft = { heading: string; critique: string; revised: string };
type SectionEvidencePacket = { section: SkillSectionDefinition; observations: SourceObservation[] };

const DEFAULT_RETRIES_PER_SECTION = 1;
const DEFAULT_SECTION_TIMEOUT_MS = 45_000;
const USE_SECTION_FIRST_GENERATION = process.env.SECTION_FIRST_GENERATION !== "0";
const MAX_EVIDENCE_LINES_PER_SECTION = 14;

export async function runGeneration(
  sessionId: string,
  providerConfig: ProviderConfig,
  guidance?: string,
  runtimeOptions?: GenerationRuntimeOptions
) {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  updateSession(sessionId, { providerConfig, guidance, status: "running", error: undefined });
  addProgress(sessionId, "queued", "Generation queued locally.");
  const sectionFirstEnabled = runtimeOptions?.sectionFirstEnabled ?? USE_SECTION_FIRST_GENERATION;
  if (!sectionFirstEnabled) addProgress(sessionId, "warning", "Legacy pipeline disabled; running section-first generation.");

  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) throw new Error("Add at least one usable asset before generation.");
    for (const asset of usableAssets) {
      addProgress(sessionId, "ingesting_asset", `Prepared ${asset.name}.`);
      if (asset.warning) addProgress(sessionId, "warning", `${asset.name}: ${asset.warning}`);
    }
    const provider = runtimeOptions?.provider ?? createProvider(providerConfig);
    const usageTotals: TokenUsage = {};
    const skeletonMarkdown = buildSkeletonSkillMarkdown();
    updateSession(sessionId, {
      skillDraft: {
        markdown: skeletonMarkdown,
        observations: [],
        qualityNotes: []
      }
    });
    runtimeOptions?.onSkillDraftUpdate?.(skeletonMarkdown);

    const rawExtraction = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "extract_observations",
      stepType: "extracting_design_signals",
      message: "Extracting concrete design observations from references.",
      run: (handlers) => provider.analyzeAssetsStream(buildExtractionPrompt(guidance), usableAssets, handlers),
      usageTotals
    });
    const observations = parseObservations(rawExtraction, usableAssets);
    addProgress(sessionId, "synthesizing_rules", "Planning section-specific evidence packets.", { stepId: "plan_sections" });
    const sectionEvidence = buildSectionEvidence(observations);
    const sectionDrafts: SectionDraft[] = [];

    for (const packet of sectionEvidence) {
      const sectionLabel = packet.section.heading.replace(/^##\s*/, "");
      const draft = await runStepWithRetry(
        () =>
          runStreamedStep({
            sessionId,
            providerConfig,
            providerSupportsReasoning: provider.supportsReasoningStream,
            stepId: "draft_section",
            stepType: "drafting_skill",
            message: `Drafting ${sectionLabel}.`,
            run: (handlers) =>
              provider.generateTextStream(buildSectionPrompt(packet.section, packet.observations, guidance), handlers),
            usageTotals
          }),
        runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
        runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
      );
      const critique = await runStepWithRetry(
        () =>
          runStreamedStep({
            sessionId,
            providerConfig,
            providerSupportsReasoning: provider.supportsReasoningStream,
            stepId: "critique_section",
            stepType: "critiquing_skill",
            message: `Critiquing ${sectionLabel}.`,
            run: (handlers) =>
              provider.generateTextStream(buildSectionCritiquePrompt(packet.section, draft, packet.observations), handlers),
            usageTotals
          }),
        runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
        runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
      );
      const revised = await runStepWithRetry(
        () =>
          runStreamedStep({
            sessionId,
            providerConfig,
            providerSupportsReasoning: provider.supportsReasoningStream,
            stepId: "revise_section",
            stepType: "critiquing_skill",
            message: `Revising ${sectionLabel}.`,
            run: (handlers) =>
              provider.generateTextStream(buildSectionRevisionPrompt(packet.section, draft, critique), handlers),
            usageTotals
          }),
        runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
        runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
      );
      sectionDrafts.push({
        heading: packet.section.heading,
        critique,
        revised: normalizeSectionBody(packet.section.heading, revised, packet.section.target.maxBullets)
      });
      const partialMarkdown = buildIncrementalSkillMarkdown(sectionDrafts);
      updateSession(sessionId, {
        skillDraft: {
          markdown: partialMarkdown,
          observations,
          qualityNotes: sectionDrafts
            .map((section) => `${section.heading}: ${splitLines(section.critique)[0] || "No critique notes."}`)
            .slice(0, 12)
        }
      });
      runtimeOptions?.onSkillDraftUpdate?.(partialMarkdown);
    }

    addProgress(sessionId, "drafting_skill", "Assembling SKILL.md from section outputs.", { stepId: "assemble_skill" });
    const assembledMarkdown = assembleSkillMarkdown(sectionDrafts);
    const finalizedMarkdown = await runStepWithRetry(
      () =>
        runStreamedStep({
          sessionId,
          providerConfig,
          providerSupportsReasoning: provider.supportsReasoningStream,
          stepId: "finalize_skill",
          stepType: "critiquing_skill",
          message: "Running final consistency and compactness pass.",
          run: (handlers) => provider.generateTextStream(buildFinalConsistencyPrompt(assembledMarkdown, guidance), handlers),
          usageTotals
        }),
      runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
      runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
    );
    const markdown = normalizeSkillMarkdown(finalizedMarkdown);
    const qualityNotes = buildQualityNotes(markdown, sectionDrafts);

    const sampleHtml = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "generate_sample",
      stepType: "generating_sample",
      message: "Generating a standalone sample HTML/CSS page using the skill.",
      run: (handlers) => provider.generateTextStream(buildSamplePrompt(markdown), handlers),
      usageTotals
    });

    addProgress(sessionId, "complete", `Token usage total: ${formatUsage(usageTotals)}.`, {
      streamKind: "summary",
      tokenUsage: usageTotals,
      providerMeta: { provider: providerConfig.kind, model: providerConfig.model, reasoningExposed: provider.supportsReasoningStream }
    });
    updateSession(sessionId, { skillDraft: { markdown, observations, qualityNotes }, sampleHtml: extractHtml(sampleHtml), status: "complete" });
    runtimeOptions?.onSkillDraftUpdate?.(markdown);
    addProgress(sessionId, "complete", "Section-first skill draft, quality notes, and sample preview are ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function runVerification(sessionId: string, providerConfig: ProviderConfig, existingSkill: string, guidance?: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  updateSession(sessionId, { providerConfig, existingSkill, guidance, status: "running", error: undefined });
  addProgress(sessionId, "queued", "Verification queued locally.");
  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) throw new Error("Add at least one asset to verify against the skill.");
    const provider = createProvider(providerConfig);
    const usageTotals: TokenUsage = {};
    const analysis = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "verify_skill",
      stepType: "extracting_design_signals",
      message: "Analyzing new references against the loaded skill.",
      run: (handlers) => provider.analyzeAssetsStream(buildVerificationPrompt(existingSkill, guidance), usableAssets, handlers),
      usageTotals
    });
    updateSession(sessionId, { verificationReport: parseVerificationReport(analysis), status: "complete" });
    addProgress(sessionId, "complete", `Token usage total: ${formatUsage(usageTotals)}.`, {
      streamKind: "summary",
      tokenUsage: usageTotals,
      providerMeta: { provider: providerConfig.kind, model: providerConfig.model, reasoningExposed: provider.supportsReasoningStream }
    });
    addProgress(sessionId, "complete", "Verification report is ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verification failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function generateSampleFromSkill(providerConfig: ProviderConfig, skillMarkdown: string) {
  const provider = createProvider(providerConfig);
  return extractHtml(await provider.generateText(buildSamplePrompt(skillMarkdown)));
}

type StepRunArgs = {
  sessionId: string;
  providerConfig: ProviderConfig;
  providerSupportsReasoning: boolean;
  stepId: ProgressStepId;
  stepType: "extracting_design_signals" | "synthesizing_rules" | "drafting_skill" | "critiquing_skill" | "generating_sample";
  message: string;
  run: (handlers: { onEvent: (event: any) => void }) => Promise<string>;
  usageTotals: TokenUsage;
};

async function runStreamedStep({ sessionId, providerConfig, providerSupportsReasoning, stepId, stepType, message, run, usageTotals }: StepRunArgs) {
  addProgress(sessionId, stepType, message, { stepId, providerMeta: { provider: providerConfig.kind, model: providerConfig.model, reasoningExposed: providerSupportsReasoning } });
  const text = await run({
    onEvent: (event) => {
      if (event.kind === "content" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming output)`, { stepId, streamKind: "content", textDelta: event.textDelta });
      } else if (event.kind === "reasoning" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming reasoning)`, { stepId, streamKind: "reasoning", textDelta: event.textDelta });
      } else if (event.kind === "usage" && event.usage) {
        mergeUsage(usageTotals, event.usage);
        addProgress(sessionId, stepType, `${message} (token usage updated)`, { stepId, streamKind: "usage", tokenUsage: event.usage });
      } else if (event.kind === "status" && event.status) {
        const statusMessage = event.status === "waiting_for_first_chunk" ? "Preparing generation." : "First response chunk received.";
        addProgress(sessionId, stepType, statusMessage, { stepId, streamKind: "status" });
      }
    }
  });
  addProgress(sessionId, stepType, `${message} (step complete)`, { stepId, streamKind: "step_complete" });
  return text;
}

async function runStepWithRetry(step: () => Promise<string>, retries: number, timeoutMs: number) {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= retries) {
    try {
      return await withTimeout(step(), timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
    attempt += 1;
  }
  throw lastError instanceof Error ? lastError : new Error("Step failed after retries.");
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => (timeoutHandle = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms.`)), timeoutMs)));
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function buildSectionEvidence(observations: SourceObservation[]): SectionEvidencePacket[] {
  return SKILL_SECTION_DEFINITIONS.map((section) => {
    const candidates = observations.filter((observation) => observation.confidence !== "low" && section.evidenceCategories.includes(observation.category));
    return { section, observations: (candidates.length ? candidates : observations).slice(0, MAX_EVIDENCE_LINES_PER_SECTION) };
  });
}
function assembleSkillMarkdown(sectionDrafts: SectionDraft[]) {
  const byHeading = new Map(sectionDrafts.map((section) => [section.heading, section]));
  const blocks = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const draft = byHeading.get(heading);
    if (!draft) return `${heading}\n- No validated guidance available for this section.`;
    const body = draft.revised.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
    return `${heading}\n${body || "- No validated guidance available for this section."}`;
  });
  return `${SKILL_TITLE}\n\n${blocks.join("\n\n")}`;
}
function buildSkeletonSkillMarkdown() {
  return `${SKILL_TITLE}\n\n${REQUIRED_SKILL_SECTIONS.join("\n\n")}`;
}
function buildIncrementalSkillMarkdown(sectionDrafts: SectionDraft[]) {
  const byHeading = new Map(sectionDrafts.map((section) => [section.heading, section]));
  const blocks = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const section = byHeading.get(heading);
    if (!section) return heading;
    const body = section.revised.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
    return body ? `${heading}\n${body}` : heading;
  });
  return `${SKILL_TITLE}\n\n${blocks.join("\n\n")}`;
}
function buildQualityNotes(markdown: string, sectionDrafts: SectionDraft[]) {
  const notes = sectionDrafts.map((section) => `${section.heading}: ${splitLines(section.critique)[0] || "No critique notes."}`);
  const missing = getMissingSkillSections(markdown);
  if (missing.length) notes.push(`Missing sections: ${missing.join(", ")}`);
  const vague = getVagueSkillPhrases(markdown);
  if (vague.length) notes.push(`Vague phrases found: ${vague.join(", ")}`);
  const repeated = getRepeatedSkillBullets(markdown);
  if (repeated.length) notes.push(`Repeated bullets: ${repeated.slice(0, 3).join(" | ")}`);
  notes.push(...getCompactnessIssues(markdown).slice(0, 3));
  return notes.slice(0, 12);
}

export function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.
Return bullets: - category=<one of color|typography|layout|components|accessibility|visual language>; confidence=<high|medium|low>; source=<asset name>; observation=<concrete observation>
Preserve concrete values (font families, type sizes, CSS variables, colors, tokens, spacing, radii, states). Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}`;
}
export function buildSynthesisPrompt(rawExtraction: string, guidance?: string) {
  return `Summarize extraction into concise rules with headers ### High Confidence ### Medium Confidence ### Low Confidence.
Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}
Raw observations:
${rawExtraction}`;
}
export function buildSkillPrompt(synthesis: string, guidance?: string) {
  return `Legacy helper prompt. Produce SKILL.md with required headings:
${REQUIRED_SKILL_SECTIONS.join("\n")}
Keep output concise and grounded in evidence.
Optional user guidance: ${guidance || "none"}
Synthesis:
${synthesis}`;
}
function buildSectionPrompt(section: SkillSectionDefinition, observations: SourceObservation[], guidance?: string) {
  const evidence = observations.map((item) => `- [${item.category}/${item.confidence}] ${item.assetName}: ${item.observation}`).join("\n") || "- No reliable evidence.";
  const target = section.target;
  return `Write only ${section.heading}.
Intent: ${section.intent}
At least ${target.minBullets || 1} bullets. At most ${target.maxBullets || 8}. ${target.maxCharsPerBullet ? `Each bullet <= ${target.maxCharsPerBullet} chars.` : ""}
Do not invent details. If sparse evidence: ${section.emptyEvidencePolicy}
Optional user guidance: ${guidance || "none"}
Evidence:
${evidence}`;
}
function buildSectionCritiquePrompt(section: SkillSectionDefinition, draftSection: string, observations: SourceObservation[]) {
  return `Critique ${section.heading} for unsupported claims, vagueness, repetition, and bullet-length violations.
Evidence:
${observations.map((item) => `- ${item.assetName}: ${item.observation}`).join("\n") || "- none"}
Draft:
${draftSection}`;
}
function buildSectionRevisionPrompt(section: SkillSectionDefinition, draftSection: string, critique: string) {
  return `Revise ${section.heading} using critique. Output only markdown section. No new facts.
Draft:
${draftSection}
Critique:
${critique}`;
}
function buildFinalConsistencyPrompt(markdown: string, guidance?: string) {
  return `Finalize this SKILL.md. Keep headings/order, trim verbosity, remove duplicates and unsupported claims, add no new facts.
Optional user guidance: ${guidance || "none"}
SKILL.md:
${markdown}`;
}
function buildSamplePrompt(skillMarkdown: string) {
  return `Create a standalone HTML document demonstrating this SKILL.md. Return only HTML.
SKILL.md:
${skillMarkdown}`;
}
function buildVerificationPrompt(existingSkill: string, guidance?: string) {
  return `Compare references against this SKILL.md. Headings: Missing From Skill, Conflicts With Skill, Unvalidated Skill Rules, Strong Matches.
Optional user guidance: ${guidance || "none"}
Existing SKILL.md:
${existingSkill}`;
}

function parseObservations(raw: string, assets: DesignAsset[]): SourceObservation[] {
  const lines = splitLines(raw).slice(0, 180);
  const observations: SourceObservation[] = [];
  let fallbackIndex = 0;
  for (const line of lines) {
    const match = line.match(
      /^[-*]\s*category=(?<category>[^;]+);\s*confidence=(?<confidence>[^;]+);\s*source=(?<source>[^;]+);\s*observation=(?<observation>.+)$/i
    );
    if (!match?.groups?.observation) continue;
    const sourceName = match.groups.source.trim();
    const matchingAsset = assets.find((asset) => asset.name.toLowerCase() === sourceName.toLowerCase());
    const asset = matchingAsset || assets[fallbackIndex++ % assets.length];
    observations.push({
      assetId: asset.id,
      assetName: asset.name,
      category: normalizeCategory(match.groups.category),
      observation: match.groups.observation.trim(),
      confidence: normalizeConfidence(match.groups.confidence)
    });
  }
  if (observations.length) return observations;
  return lines.slice(0, 20).map((line, index) => {
    const asset = assets[index % assets.length];
    return { assetId: asset.id, assetName: asset.name, category: inferCategory(line), observation: line.replace(/^[-*]\s*/, ""), confidence: "medium" };
  });
}

function parseVerificationReport(text: string): VerificationReport {
  const categories: Array<VerificationFinding["category"]> = ["missing", "conflict", "unvalidated", "match"];
  const headingMap: Record<string, VerificationFinding["category"]> = {
    "missing from skill": "missing",
    "conflicts with skill": "conflict",
    "unvalidated skill rules": "unvalidated",
    "strong matches": "match"
  };
  const findings: VerificationFinding[] = [];
  let current: VerificationFinding["category"] = "missing";
  for (const line of splitLines(text)) {
    const normalized = line.replace(/^#+\s*/, "").toLowerCase();
    const heading = Object.keys(headingMap).find((key) => normalized.includes(key));
    if (heading) {
      current = headingMap[heading];
      continue;
    }
    if (!line.match(/^[-*]\s+|^\d+\.\s+/)) continue;
    const clean = line.replace(/^[-*]\s+|^\d+\.\s+/, "");
    const [title, ...rest] = clean.split(":");
    findings.push({
      id: crypto.randomUUID(),
      category: categories.includes(current) ? current : "missing",
      title: title.trim() || clean.slice(0, 70),
      detail: rest.join(":").trim() || clean,
      suggestedPatch: current === "missing" || current === "conflict" ? makePatch(current, clean) : undefined
    });
  }
  if (!findings.length) {
    findings.push({ id: crypto.randomUUID(), category: "unvalidated", title: "Review needed", detail: text.slice(0, 800) || "The model did not return structured findings." });
  }
  return { findings, summary: `${findings.length} verification finding${findings.length === 1 ? "" : "s"} generated.` };
}

function makePatch(category: VerificationFinding["category"], text: string) {
  const heading = category === "conflict" ? "### Conflict Resolution" : "### Additional Design Rule";
  return `${heading}\n- ${text.replace(/Suggested patch:/i, "").trim()}`;
}
function normalizeSkillMarkdown(markdown: string) {
  const stripped = markdown.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  const withTitle = stripped.startsWith("#") ? stripped : `${SKILL_TITLE}\n\n${stripped}`;
  const blocks = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const definition = SECTION_DEFINITION_BY_HEADING[heading];
    const body = extractSectionBody(withTitle, heading);
    return `${heading}\n${normalizeSectionBody(heading, body || definition.emptyEvidencePolicy, definition.target.maxBullets)}`;
  });
  return `${SKILL_TITLE}\n\n${blocks.join("\n\n")}`;
}
function normalizeSectionBody(heading: string, raw: string, maxBullets?: number) {
  const withoutHeading = raw.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
  const bullets = splitLines(withoutHeading)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);
  const limited = typeof maxBullets === "number" ? bullets.slice(0, maxBullets) : bullets;
  if (limited.length) return limited.join("\n");
  if (withoutHeading) return `- ${withoutHeading}`;
  return "- No validated guidance available.";
}
function extractSectionBody(markdown: string, heading: string) {
  const pattern = new RegExp(`${escapeRegExp(heading)}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  return markdown.match(pattern)?.[1]?.trim() || "";
}
function extractHtml(text: string) {
  const stripped = text.replace(/^```(?:html)?/i, "").replace(/```$/i, "").trim();
  if (stripped.toLowerCase().includes("<html")) return stripped;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:32px;line-height:1.5}</style></head><body>${stripped}</body></html>`;
}
function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
function inferCategory(line: string) {
  const lower = line.toLowerCase();
  if (lower.includes("color") || lower.includes("palette") || lower.includes("token")) return "color";
  if (lower.includes("type") || lower.includes("font")) return "typography";
  if (lower.includes("layout") || lower.includes("grid")) return "layout";
  if (lower.includes("button") || lower.includes("card") || lower.includes("component")) return "components";
  if (lower.includes("access") || lower.includes("contrast")) return "accessibility";
  return "visual language";
}
function normalizeCategory(category: string) {
  const value = category.trim().toLowerCase();
  if (value.includes("color")) return "color";
  if (value.includes("type") || value.includes("font")) return "typography";
  if (value.includes("layout") || value.includes("grid")) return "layout";
  if (value.includes("component") || value.includes("pattern")) return "components";
  if (value.includes("access")) return "accessibility";
  return "visual language";
}
function normalizeConfidence(confidence: string): SourceObservation["confidence"] {
  const value = confidence.trim().toLowerCase();
  if (value === "high") return "high";
  if (value === "low") return "low";
  return "medium";
}
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function mergeUsage(target: TokenUsage, next: TokenUsage) {
  if (typeof next.promptTokens === "number") target.promptTokens = (target.promptTokens || 0) + next.promptTokens;
  if (typeof next.completionTokens === "number") target.completionTokens = (target.completionTokens || 0) + next.completionTokens;
  if (typeof next.totalTokens === "number") target.totalTokens = (target.totalTokens || 0) + next.totalTokens;
  else if (typeof next.promptTokens === "number" || typeof next.completionTokens === "number") {
    target.totalTokens = (target.totalTokens || 0) + (next.promptTokens || 0) + (next.completionTokens || 0);
  }
}
function formatUsage(usage: TokenUsage) {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  return `prompt ${prompt.toLocaleString()} · completion ${completion.toLocaleString()} · total ${total.toLocaleString()}`;
}

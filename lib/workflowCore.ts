import { addProgress, getSession, getSettingsMemory, updateSession } from "./store";
import { createProvider, type LlmProvider } from "./providers";
import {
  STATIC_BASELINE_SECTION_IDS,
  REQUIRED_SKILL_SECTIONS,
  SECTION_DEFINITION_BY_HEADING,
  SKILL_TITLE,
  clampMaxCssColors,
  skillSectionDefinitionsForColorBudget,
  type SkillSectionDefinition
} from "./skillSections";
import {
  getCompactnessIssues,
  getCrossSectionContaminationIssues,
  getGroundingCoverage,
  getMissingSkillSections,
  getRepeatedSkillBullets,
  getVagueSkillPhrases
} from "./skillQualityCore";
import {
  compileSectionEvidence,
  normalizeObservationCategory,
  urlAssetsHaveSubstantialReadableText,
  type CompiledSectionEvidence,
  type ObservationCategory
} from "./sectionEvidence";
import { validateSectionClaims } from "./sectionValidation";
import { collectPinnedBrandCards, formatRequiredBrandPinsBlock, type ImageCard } from "./imageCards";
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
  sectionEvidenceCompilerEnabled?: boolean;
  sectionEvidenceShadowEnabled?: boolean;
  sectionClaimValidationEnabled?: boolean;
  sectionEvidenceDiagnosticsEnabled?: boolean;
  sectionStaticBaselinesEnabled?: boolean;
  /** Overrides persisted settings maxCssColors for this run when set. */
  maxCssColors?: number;
};
type SectionDraft = { heading: string; critique: string; revised: string };
type SectionEvidencePacket = {
  section: SkillSectionDefinition;
  observations: SourceObservation[];
  compiled?: CompiledSectionEvidence;
  diagnostics?: string[];
  isStaticSection?: boolean;
  brandPins?: ImageCard[];
};

function buildSectionQualityNotes(sectionDrafts: SectionDraft[]) {
  return sectionDrafts
    .map((section) => `${section.heading}: ${splitLines(section.critique)[0] || "No critique notes."}`)
    .slice(0, 12);
}

const DEFAULT_RETRIES_PER_SECTION = 1;
const DEFAULT_SECTION_TIMEOUT_MS = 45_000;
const USE_SECTION_FIRST_GENERATION = process.env.SECTION_FIRST_GENERATION !== "0";
const USE_SECTION_EVIDENCE_COMPILER = process.env.SECTION_EVIDENCE_COMPILER === "1";
const USE_SECTION_EVIDENCE_SHADOW = process.env.SECTION_EVIDENCE_SHADOW === "1";
const USE_SECTION_CLAIM_VALIDATION = process.env.SECTION_CLAIM_VALIDATION === "1";
const USE_SECTION_EVIDENCE_DIAGNOSTICS = process.env.SECTION_EVIDENCE_DIAGNOSTICS === "1";
const USE_SECTION_STATIC_BASELINES = process.env.SECTION_STATIC_BASELINES !== "0";
const MAX_EVIDENCE_LINES_PER_SECTION = 14;
const MAX_VALIDATION_REPAIRS = 1;

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
  const sectionEvidenceCompilerEnabled = runtimeOptions?.sectionEvidenceCompilerEnabled ?? USE_SECTION_EVIDENCE_COMPILER;
  const sectionEvidenceShadowEnabled = runtimeOptions?.sectionEvidenceShadowEnabled ?? USE_SECTION_EVIDENCE_SHADOW;
  const sectionClaimValidationEnabled = runtimeOptions?.sectionClaimValidationEnabled ?? USE_SECTION_CLAIM_VALIDATION;
  const sectionEvidenceDiagnosticsEnabled = runtimeOptions?.sectionEvidenceDiagnosticsEnabled ?? USE_SECTION_EVIDENCE_DIAGNOSTICS;
  const sectionStaticBaselinesEnabled = runtimeOptions?.sectionStaticBaselinesEnabled ?? USE_SECTION_STATIC_BASELINES;
  if (!sectionFirstEnabled) addProgress(sessionId, "warning", "Legacy pipeline disabled; running section-first generation.");

  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) throw new Error("Add at least one usable asset before generation.");
    for (const asset of usableAssets) {
      addProgress(sessionId, "ingesting_asset", `Prepared ${asset.name}.`);
      if (asset.warning) addProgress(sessionId, "warning", `${asset.name}: ${asset.warning}`);
    }
    const maxCssColors = clampMaxCssColors(runtimeOptions?.maxCssColors ?? getSettingsMemory().maxCssColors);
    const sectionDefinitions = skillSectionDefinitionsForColorBudget(maxCssColors);
    const sectionDefinitionByHeading: Record<string, SkillSectionDefinition> = Object.fromEntries(
      sectionDefinitions.map((section) => [section.heading, section])
    );
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
    const compiledEvidence = compileSectionEvidence(observations, usableAssets, {
      sectionDefinitions,
      colorsFactLimit: maxCssColors
    });
    const sectionEvidence = buildSectionEvidence(
      observations,
      compiledEvidence,
      usableAssets,
      {
        useCompiled: sectionEvidenceCompilerEnabled,
        shadowCompiled: sectionEvidenceShadowEnabled,
        staticBaselines: sectionStaticBaselinesEnabled,
        sectionDefinitions,
        maxCssColors
      }
    );
    if (sectionEvidenceDiagnosticsEnabled) {
      const summary = compiledEvidence
        .map((packet) => `${packet.section.id}: facts=${packet.facts.length}, selected=${packet.selectedFacts.length}, conflicts=${packet.conflicts.length}, unknowns=${packet.unknowns.length}`)
        .join(" | ");
      addProgress(sessionId, "synthesizing_rules", `Section evidence diagnostics: ${summary}`.slice(0, 600), { stepId: "plan_sections" });
    }
    const sectionDrafts: SectionDraft[] = [];

    for (const packet of sectionEvidence) {
      const sectionLabel = packet.section.heading.replace(/^##\s*/, "");
      if (packet.isStaticSection) {
        const staticBody = buildStaticSectionBody(packet.section);
        sectionDrafts.push({
          heading: packet.section.heading,
          critique: "Static baseline section; generation skipped.",
          revised: normalizeSectionBody(packet.section.heading, staticBody, packet.section.target.maxBullets)
        });
        const partialMarkdown = buildIncrementalSkillMarkdown(sectionDrafts);
        const qualityNotes = buildSectionQualityNotes(sectionDrafts);
        updateSession(sessionId, {
          skillDraft: {
            markdown: partialMarkdown,
            observations,
            qualityNotes
          }
        });
        addProgress(sessionId, "drafting_skill", `Updated SKILL.md with ${sectionLabel}.`, {
          stepId: "draft_section",
          streamKind: "status",
          partialMarkdown,
          sectionHeading: sectionLabel,
          completedSections: sectionDrafts.length,
          totalSections: REQUIRED_SKILL_SECTIONS.length
        });
        runtimeOptions?.onSkillDraftUpdate?.(partialMarkdown);
        continue;
      }
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
              provider.generateTextStream(buildSectionPrompt(packet, guidance), handlers),
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
              provider.generateTextStream(buildSectionCritiquePrompt(packet, draft), handlers),
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
              provider.generateTextStream(buildSectionRevisionPrompt(packet, draft, critique), handlers),
            usageTotals
          }),
        runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
        runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
      );
      const validatedRevision = await validateSectionRevision({
        sectionClaimValidationEnabled,
        packet,
        revised,
        provider,
        sessionId,
        providerConfig,
        usageTotals,
        retriesPerSection: runtimeOptions?.retriesPerSection ?? DEFAULT_RETRIES_PER_SECTION,
        sectionTimeoutMs: runtimeOptions?.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS
      });
      sectionDrafts.push({
        heading: packet.section.heading,
        critique,
        revised: normalizeSectionBody(packet.section.heading, validatedRevision, packet.section.target.maxBullets)
      });
      const partialMarkdown = buildIncrementalSkillMarkdown(sectionDrafts);
      const qualityNotes = buildSectionQualityNotes(sectionDrafts);
      updateSession(sessionId, {
        skillDraft: {
          markdown: partialMarkdown,
          observations,
          qualityNotes
        }
      });
      addProgress(sessionId, "drafting_skill", `Updated SKILL.md with ${sectionLabel}.`, {
        stepId: "revise_section",
        streamKind: "status",
        partialMarkdown,
        sectionHeading: sectionLabel,
        completedSections: sectionDrafts.length,
        totalSections: REQUIRED_SKILL_SECTIONS.length
      });
      runtimeOptions?.onSkillDraftUpdate?.(partialMarkdown);
    }

    addProgress(sessionId, "drafting_skill", "Assembling SKILL.md from section outputs.", { stepId: "assemble_skill" });
    const assembledMarkdown = assembleSkillMarkdown(sectionDrafts);
    addProgress(sessionId, "drafting_skill", "Assembled SKILL.md section draft.", {
      stepId: "assemble_skill",
      streamKind: "status",
      partialMarkdown: assembledMarkdown,
      sectionHeading: "Assemble skill",
      completedSections: REQUIRED_SKILL_SECTIONS.length,
      totalSections: REQUIRED_SKILL_SECTIONS.length
    });
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
    const markdown = normalizeSkillMarkdown(finalizedMarkdown, sectionDefinitionByHeading);
    const qualityNotes = buildQualityNotes(markdown, sectionDrafts, compiledEvidence, sectionDefinitions);

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

function observationEvidenceKey(observation: SourceObservation) {
  return `${observation.assetName}::${observation.observation}`.toLowerCase();
}

function mergeVoiceHybridEvidence(compiledLines: SourceObservation[], rawLines: SourceObservation[], maxLines: number): SourceObservation[] {
  const keys = new Set<string>();
  const out: SourceObservation[] = [];
  for (const obs of compiledLines) {
    const key = observationEvidenceKey(obs);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(obs);
  }
  for (const obs of rawLines) {
    if (out.length >= maxLines) break;
    const key = observationEvidenceKey(obs);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(obs);
  }
  return out;
}

function buildSectionEvidence(
  observations: SourceObservation[],
  compiled: CompiledSectionEvidence[],
  assets: DesignAsset[],
  options: {
    useCompiled: boolean;
    shadowCompiled: boolean;
    staticBaselines: boolean;
    sectionDefinitions: SkillSectionDefinition[];
    maxCssColors: number;
  }
): SectionEvidencePacket[] {
  const brandPins = collectPinnedBrandCards(assets);
  return options.sectionDefinitions.map((section) => {
    const compiledPacket = compiled.find((entry) => entry.section.id === section.id);
    const staticSection = options.staticBaselines && STATIC_BASELINE_SECTION_IDS.includes(section.id);
    const compiledObservations =
      compiledPacket?.selectedFacts.map((fact) => ({
        assetId: fact.sourceAssetIds[0] || "compiled",
        assetName: fact.sourceAssetNames[0] || "Compiled evidence",
        category: fact.category,
        observation: `${fact.kind}: ${fact.value}`,
        confidence: fact.confidence
      })) || [];
    const categoryFiltered = observations.filter(
      (observation) =>
        observation.confidence !== "low" && section.evidenceCategories.includes(normalizeObservationCategory(observation.category))
    );
    let chosen: SourceObservation[];
    if (options.useCompiled && compiledObservations.length) {
      if (section.id === "voice" && urlAssetsHaveSubstantialReadableText(assets) && categoryFiltered.length) {
        chosen = mergeVoiceHybridEvidence(compiledObservations, categoryFiltered, MAX_EVIDENCE_LINES_PER_SECTION);
      } else {
        chosen = compiledObservations;
      }
    } else if (categoryFiltered.length) {
      chosen = categoryFiltered;
    } else {
      chosen = observations;
    }
    const diagnostics: string[] = [];
    if (options.shadowCompiled && compiledPacket) {
      diagnostics.push(`compiled_selected=${compiledPacket.selectedFacts.length}`);
      diagnostics.push(`legacy_selected=${categoryFiltered.length}`);
    }
    const evidenceCap =
      section.id === "colors" ? Math.max(MAX_EVIDENCE_LINES_PER_SECTION, options.maxCssColors + 4) : MAX_EVIDENCE_LINES_PER_SECTION;
    return {
      section,
      observations: chosen.slice(0, evidenceCap),
      compiled: compiledPacket,
      diagnostics,
      isStaticSection: staticSection,
      brandPins: section.id === "brand" ? brandPins : undefined
    };
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
function buildQualityNotes(
  markdown: string,
  sectionDrafts: SectionDraft[],
  compiledEvidence: CompiledSectionEvidence[],
  sectionDefinitions: SkillSectionDefinition[]
) {
  const notes = sectionDrafts.map((section) => `${section.heading}: ${splitLines(section.critique)[0] || "No critique notes."}`);
  const missing = getMissingSkillSections(markdown);
  if (missing.length) notes.push(`Missing sections: ${missing.join(", ")}`);
  const vague = getVagueSkillPhrases(markdown);
  if (vague.length) notes.push(`Vague phrases found: ${vague.join(", ")}`);
  const repeated = getRepeatedSkillBullets(markdown);
  if (repeated.length) notes.push(`Repeated bullets: ${repeated.slice(0, 3).join(" | ")}`);
  notes.push(...getCompactnessIssues(markdown, sectionDefinitions).slice(0, 3));
  notes.push(...getCrossSectionContaminationIssues(markdown).slice(0, 2));
  const factValues = compiledEvidence.flatMap((packet) => packet.selectedFacts.map((fact) => fact.normalizedValue));
  const groundingCoverage = getGroundingCoverage(markdown, factValues);
  if (groundingCoverage > 0) notes.push(`Grounding coverage: ${(groundingCoverage * 100).toFixed(0)}%`);
  return notes.slice(0, 12);
}

export function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.
Return bullets: - category=<one of color|typography|layout|components|accessibility|visual language|voice>; confidence=<high|medium|low>; source=<asset name>; observation=<concrete observation>
Preserve concrete values (font families, type sizes, CSS variables, colors, tokens, spacing, radii, states). Keep each bullet under 180 characters.
Also extract copy and voice signals for category=voice from URL assets: read "## Readable Page Text" and visible UI strings. Cover tone (formal/casual/playful), point of view (we/you), CTA phrasing, headline vs body patterns, capitalization (sentence vs title case, ALL CAPS segments), punctuation habits, and length/clarity of lines. Use category=voice for anything primarily about words, not CSS.
For each URL asset whose "## Readable Page Text" section is longer than 200 characters (excluding the placeholder "No readable page text extracted."), emit at least one voice bullet tied to that asset name in source=.
Do not use emojis.
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
function buildSectionPrompt(packet: SectionEvidencePacket, guidance?: string) {
  const { section, observations, compiled, brandPins } = packet;
  const evidence = observations.map((item) => `- [${item.category}/${item.confidence}] ${item.assetName}: ${item.observation}`).join("\n") || "- No reliable evidence.";
  const target = section.target;
  const facts = compiled?.selectedFacts || [];
  const conflicts = compiled?.conflicts || [];
  const unknowns = compiled?.unknowns || [];
  const factLines = facts.length
    ? facts.map((fact) => `- fact_id=${fact.factId}; kind=${fact.kind}; confidence=${fact.confidence}; value=${fact.value}`).join("\n")
    : "- None";
  const conflictLines = conflicts.length
    ? conflicts.map((conflict) => `- ${conflict.kind}: ${conflict.values.join(" | ")}`).join("\n")
    : "- None";
  const unknownLines = unknowns.length ? unknowns.map((unknown) => `- ${unknown}`).join("\n") : "- None";
  const requiredBrandPins = section.id === "brand" ? formatRequiredBrandPinsBlock(brandPins || []) : "";
  return `Required heading: ${section.heading}
Intent: ${section.intent}
At least ${target.minBullets || 1} bullets. At most ${target.maxBullets || 8}. ${target.maxCharsPerBullet ? `Each bullet <= ${target.maxCharsPerBullet} chars.` : ""}
Use only evidence-backed claims. Every bullet must map to one or more fact_id values when available.
Do not use emojis.
If sparse evidence: ${section.emptyEvidencePolicy}
Optional user guidance: ${guidance || "none"}
Top Facts:
${factLines}
Conflicts:
${conflictLines}
Unknowns:
${unknownLines}
Observed Evidence:
${evidence}${requiredBrandPins}`;
}
function buildSectionCritiquePrompt(packet: SectionEvidencePacket, draftSection: string) {
  const section = packet.section;
  let evidence: string;
  if (section.id === "voice" && packet.compiled?.selectedFacts.length) {
    const factLines = packet.compiled.selectedFacts.map((fact) => `- ${fact.value}`).join("\n");
    const obsLines = packet.observations.map((item) => `- ${item.assetName}: ${item.observation}`).join("\n") || "- none";
    evidence = `Compiled facts:\n${factLines}\n\nObserved evidence lines:\n${obsLines}`;
  } else if (packet.compiled?.selectedFacts.length) {
    evidence = packet.compiled.selectedFacts.map((fact) => `- ${fact.value}`).join("\n");
  } else {
    evidence = packet.observations.map((item) => `- ${item.assetName}: ${item.observation}`).join("\n") || "- none";
  }
  return `Critique this section ${section.heading} for unsupported claims, vagueness, repetition, bullet-length violations, and any emoji usage.
Evidence:
${evidence}
Draft:
${draftSection}`;
}
function buildSectionRevisionPrompt(packet: SectionEvidencePacket, draftSection: string, critique: string) {
  return `Revise this section ${packet.section.heading} using critique. Return only markdown for ${packet.section.heading}. No new facts. Do not use emojis.
Draft:
${draftSection}
Critique:
${critique}`;
}
function buildFinalConsistencyPrompt(markdown: string, guidance?: string) {
  return `Finalize this SKILL.md. Keep headings/order, trim verbosity, remove duplicates and unsupported claims, add no new facts. Remove any emojis.
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

function buildStaticSectionBody(section: SkillSectionDefinition) {
  switch (section.id) {
    case "when_to_use":
      return [
        "- Use this skill when implementing UI that should follow extracted design-system constraints.",
        "- Prioritize fidelity to evidenced tokens, component behavior, and accessibility patterns.",
        "- Avoid adding brand-specific details unless they are explicitly evidenced."
      ].join("\n");
    case "workflow":
      return [
        "- Gather references and extract concrete observations before drafting section guidance.",
        "- Convert observations into enforceable rules with explicit constraints and fallback language.",
        "- Validate section claims against evidence, then remove unsupported or repetitive bullets.",
        "- Assemble sections in canonical order and run compactness/consistency checks."
      ].join("\n");
    case "verification_checklist":
      return [
        "- Confirm required sections are present and ordered correctly.",
        "- Verify concrete tokens and values are grounded in extracted evidence.",
        "- Check for section contamination (e.g., colors in typography guidance).",
        "- Ensure accessibility and interaction-state guidance is explicit and testable."
      ].join("\n");
    default:
      return section.emptyEvidencePolicy;
  }
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
      category: normalizeObservationCategory(match.groups.category),
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

async function validateSectionRevision(args: {
  sectionClaimValidationEnabled: boolean;
  packet: SectionEvidencePacket;
  revised: string;
  provider: LlmProvider;
  sessionId: string;
  providerConfig: ProviderConfig;
  usageTotals: TokenUsage;
  retriesPerSection: number;
  sectionTimeoutMs: number;
}) {
  const { sectionClaimValidationEnabled, packet } = args;
  if (!sectionClaimValidationEnabled || !packet.compiled) return args.revised;
  let latest = args.revised;
  let attempts = 0;
  while (attempts <= MAX_VALIDATION_REPAIRS) {
    const validation = validateSectionClaims(packet.section, latest, packet.compiled);
    if (validation.isValid) return latest;
    const blockingIssues = validation.issues.filter((issue) => issue.severity === "error");
    if (!blockingIssues.length) return latest;
    if (attempts >= MAX_VALIDATION_REPAIRS) return latest;
    const repaired = await runStepWithRetry(
      () =>
        runStreamedStep({
          sessionId: args.sessionId,
          providerConfig: args.providerConfig,
          providerSupportsReasoning: args.provider.supportsReasoningStream,
          stepId: "revise_section",
          stepType: "critiquing_skill",
          message: `Repairing ${packet.section.heading.replace(/^##\s*/, "")} after validation.`,
          run: (handlers) =>
            args.provider.generateTextStream(
              `Repair ${packet.section.heading}. Fix these issues and output only markdown section:\n${blockingIssues.map((issue) => `- ${issue.message}`).join("\n")}\nDraft:\n${latest}`,
              handlers
            ),
          usageTotals: args.usageTotals
        }),
      args.retriesPerSection,
      args.sectionTimeoutMs
    );
    latest = repaired;
    attempts += 1;
  }
  return latest;
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
function normalizeSkillMarkdown(
  markdown: string,
  definitionByHeading: Record<string, SkillSectionDefinition> = SECTION_DEFINITION_BY_HEADING
) {
  const stripped = markdown.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  const withTitle = stripped.startsWith("#") ? stripped : `${SKILL_TITLE}\n\n${stripped}`;
  const blocks = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const definition = definitionByHeading[heading] ?? SECTION_DEFINITION_BY_HEADING[heading];
    const body = extractSectionBody(withTitle, heading);
    return `${heading}\n${normalizeSectionBody(heading, body || definition.emptyEvidencePolicy, definition.target.maxBullets)}`;
  });
  return `${SKILL_TITLE}\n\n${blocks.join("\n\n")}`;
}
function normalizeSectionBody(heading: string, raw: string, maxBullets?: number) {
  const withoutHeading = raw.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
  const bullets = splitLines(withoutHeading)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .map((line) => stripEmoji(line))
    .filter(Boolean)
    .map((line) => `- ${line}`);
  const limited = typeof maxBullets === "number" ? bullets.slice(0, maxBullets) : bullets;
  if (limited.length) return limited.join("\n");
  if (withoutHeading) return `- ${stripEmoji(withoutHeading)}`;
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
function inferCategory(line: string): ObservationCategory {
  const lower = line.toLowerCase();
  if (
    /\b(tone|voice|microcopy|copywriting|headline|tagline|strapline|cta|wording|punctuation|placard|narrative)\b/.test(lower) ||
    /\b(we|our|your|you're)\b/.test(lower)
  ) {
    return "voice";
  }
  if (lower.includes("color") || lower.includes("palette") || lower.includes("token")) return "color";
  if (lower.includes("type") || lower.includes("font")) return "typography";
  if (lower.includes("layout") || lower.includes("grid")) return "layout";
  if (lower.includes("button") || lower.includes("card") || lower.includes("component")) return "components";
  if (lower.includes("access") || lower.includes("contrast")) return "accessibility";
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

function stripEmoji(value: string) {
  return value.replace(/\p{Extended_Pictographic}/gu, "").replace(/\s{2,}/g, " ").trim();
}

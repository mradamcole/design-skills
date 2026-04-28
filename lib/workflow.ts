export * from "./workflowCore";
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
} from "./skillQuality";
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
};

type SectionDraft = {
  heading: string;
  critique: string;
  revised: string;
};

type SectionEvidencePacket = {
  section: SkillSectionDefinition;
  observations: SourceObservation[];
};

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
  if (!sectionFirstEnabled) {
    addProgress(sessionId, "warning", "Legacy pipeline disabled; running section-first generation.");
  }

  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) {
      throw new Error("Add at least one usable asset before generation.");
    }
    for (const asset of usableAssets) {
      addProgress(sessionId, "ingesting_asset", `Prepared ${asset.name}.`);
      if (asset.warning) addProgress(sessionId, "warning", `${asset.name}: ${asset.warning}`);
    }

    const provider = runtimeOptions?.provider ?? createProvider(providerConfig);
    const usageTotals: TokenUsage = {};

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
    const sectionEvidence = buildSectionEvidence(observations);

    addProgress(sessionId, "synthesizing_rules", "Planning section-specific evidence packets.", {
      stepId: "plan_sections"
    });

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
    }

    addProgress(sessionId, "drafting_skill", "Assembling SKILL.md from section outputs.", {
      stepId: "assemble_skill"
    });
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
      providerMeta: {
        provider: providerConfig.kind,
        model: providerConfig.model,
        reasoningExposed: provider.supportsReasoningStream
      }
    });

    updateSession(sessionId, {
      skillDraft: {
        markdown,
        observations,
        qualityNotes
      },
      sampleHtml: extractHtml(sampleHtml),
      status: "complete"
    });
    addProgress(sessionId, "complete", "Section-first skill draft, quality notes, and sample preview are ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function runVerification(
  sessionId: string,
  providerConfig: ProviderConfig,
  existingSkill: string,
  guidance?: string
) {
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
    const report = parseVerificationReport(analysis);
    updateSession(sessionId, { verificationReport: report, status: "complete" });
    addProgress(sessionId, "complete", `Token usage total: ${formatUsage(usageTotals)}.`, {
      streamKind: "summary",
      tokenUsage: usageTotals,
      providerMeta: {
        provider: providerConfig.kind,
        model: providerConfig.model,
        reasoningExposed: provider.supportsReasoningStream
      }
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
  const html = await provider.generateText(buildSamplePrompt(skillMarkdown));
  return extractHtml(html);
}

type StepRunArgs = {
  sessionId: string;
  providerConfig: ProviderConfig;
  providerSupportsReasoning: boolean;
  stepId: ProgressStepId;
  stepType: "extracting_design_signals" | "synthesizing_rules" | "drafting_skill" | "critiquing_skill" | "generating_sample";
  message: string;
  run: (handlers: {
    onEvent: (event: {
      kind: "content" | "reasoning" | "usage" | "status" | "step_complete";
      textDelta?: string;
      usage?: TokenUsage;
      usageIsFinal?: boolean;
      loadDurationMs?: number;
      status?: "waiting_for_first_chunk" | "first_chunk_received";
      latencyMs?: number;
      modelResident?: boolean;
    }) => void;
  }) => Promise<string>;
  usageTotals: TokenUsage;
};

async function runStreamedStep({
  sessionId,
  providerConfig,
  providerSupportsReasoning,
  stepId,
  stepType,
  message,
  run,
  usageTotals
}: StepRunArgs) {
  addProgress(sessionId, stepType, message, {
    stepId,
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

  const text = await run({
    onEvent: (event) => {
      if (event.kind === "content" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming output)`, {
          stepId,
          streamKind: "content",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning
          }
        });
        return;
      }
      if (event.kind === "reasoning" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming reasoning)`, {
          stepId,
          streamKind: "reasoning",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: true
          }
        });
        return;
      }
      if (event.kind === "usage" && event.usage) {
        mergeUsage(usageTotals, event.usage);
        addProgress(sessionId, stepType, `${message} (token usage updated)`, {
          stepId,
          streamKind: "usage",
          tokenUsage: event.usage,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            usageIsFinal: event.usageIsFinal,
            loadDurationMs: event.loadDurationMs
          }
        });
        return;
      }
      if (event.kind === "status" && event.status) {
        const statusMessage =
          event.status === "waiting_for_first_chunk"
            ? event.modelResident
              ? "Contacting provider and preparing generation."
              : "Loading model/runtime resources (cold start)."
            : "First response chunk received. Generation is now active.";
        addProgress(sessionId, stepType, statusMessage, {
          stepId,
          streamKind: "status",
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            streamStatus: event.status,
            modelResident: event.modelResident,
            latencyMs: event.latencyMs
          }
        });
      }
    }
  });

  addProgress(sessionId, stepType, `${message} (step complete)`, {
    stepId,
    streamKind: "step_complete",
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

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
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function buildSectionEvidence(observations: SourceObservation[]): SectionEvidencePacket[] {
  return SKILL_SECTION_DEFINITIONS.map((section) => {
    const candidates = observations.filter((observation) => {
      if (observation.confidence === "low") return false;
      return section.evidenceCategories.includes(observation.category);
    });
    const selected = candidates.length
      ? candidates.slice(0, MAX_EVIDENCE_LINES_PER_SECTION)
      : observations.slice(0, Math.min(4, observations.length));
    return { section, observations: selected };
  });
}

function assembleSkillMarkdown(sectionDrafts: SectionDraft[]) {
  const byHeading = new Map(sectionDrafts.map((section) => [section.heading, section]));
  const sectionBodies = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const draft = byHeading.get(heading);
    if (!draft) return `${heading}\n- No validated guidance available for this section.`;
    const body = draft.revised.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
    return `${heading}\n${body || "- No validated guidance available for this section."}`;
  });
  return `${SKILL_TITLE}\n\n${sectionBodies.join("\n\n")}`.trim();
}

function buildQualityNotes(markdown: string, sectionDrafts: SectionDraft[]) {
  const notes: string[] = [];
  for (const section of sectionDrafts) {
    const critiqueLine = splitLines(section.critique)[0];
    if (critiqueLine) {
      notes.push(`${section.heading}: ${critiqueLine}`);
    }
  }
  const missingSections = getMissingSkillSections(markdown);
  if (missingSections.length) {
    notes.push(`Missing sections: ${missingSections.join(", ")}`);
  }
  const vague = getVagueSkillPhrases(markdown);
  if (vague.length) {
    notes.push(`Vague phrases found: ${vague.join(", ")}`);
  }
  const repeatedBullets = getRepeatedSkillBullets(markdown);
  if (repeatedBullets.length) {
    notes.push(`Repeated bullets: ${repeatedBullets.slice(0, 3).join(" | ")}`);
  }
  const compactness = getCompactnessIssues(markdown);
  if (compactness.length) {
    notes.push(...compactness.slice(0, 3));
  }
  return notes.slice(0, 12);
}

export function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.

Return structured observations as bullet lines prefixed by category and confidence:
- category=<one of color|typography|layout|components|accessibility|visual language>; confidence=<high|medium|low>; source=<asset name>; observation=<concrete observation>

Extraction requirements:
- Preserve concrete values: font families, type sizes, font weights, line heights, color values, CSS variables, radii, shadows, spacing, icon/favicon paths.
- Separate direct evidence from inference by lowering confidence for uncertain observations.
- Prefer enforceable implementation guidance.
- Do not include unsupported taste terms unless directly quoted from source text.
- Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}`;
}

export function buildSynthesisPrompt(rawExtraction: string, guidance?: string) {
  return `Summarize the extraction into compact rule groups by category.
Return markdown bullets only with headers:
### High Confidence
### Medium Confidence
### Low Confidence
Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}

Raw observations:
${rawExtraction}`;
}

export function buildSkillPrompt(synthesis: string, guidance?: string) {
  return `Legacy helper compatibility prompt. Produce a complete SKILL.md with required headings:
${REQUIRED_SKILL_SECTIONS.join("\n")}
Keep output concise and grounded in evidence.
Optional user guidance: ${guidance || "none"}

Synthesis:
${synthesis}`;
}

function buildSectionPrompt(section: SkillSectionDefinition, observations: SourceObservation[], guidance?: string) {
  const evidence = observations.length
    ? observations.map((item) => `- [${item.category}/${item.confidence}] ${item.assetName}: ${item.observation}`).join("\n")
    : "- No reliable evidence for this section.";
  const target = section.target;
  return `Write only this section for a SKILL.md.
Required heading: ${section.heading}
Intent: ${section.intent}
Evidence categories: ${section.evidenceCategories.join(", ")}
Constraints:
- ${target.minBullets ? `At least ${target.minBullets} bullets.` : "Use bullets only."}
- ${target.maxBullets ? `At most ${target.maxBullets} bullets.` : "Keep it concise."}
- ${target.maxCharsPerBullet ? `Each bullet <= ${target.maxCharsPerBullet} chars.` : "Use short bullets."}
- Do not invent tokens, brand details, or typography values.
- Omit unsupported claims; prefer explicit limits.
- Avoid filler words like clean, modern, beautiful, delightful, visually appealing.
- Output only markdown for ${section.heading}.
- If evidence is sparse: ${section.emptyEvidencePolicy}
Optional user guidance: ${guidance || "none"}

Evidence:
${evidence}`;
}

function buildSectionCritiquePrompt(section: SkillSectionDefinition, draftSection: string, observations: SourceObservation[]) {
  return `Critique this section for a SKILL.md.
Section: ${section.heading}
Focus:
- unsupported claims
- vague wording
- repeated guidance
- missing concrete values where evidence exists
- length/bullet violations
Return concise bullet issues only.

Evidence:
${observations.map((item) => `- ${item.assetName}: ${item.observation}`).join("\n") || "- none"}

Draft:
${draftSection}`;
}

function buildSectionRevisionPrompt(section: SkillSectionDefinition, draftSection: string, critique: string) {
  return `Revise this section based on critique.
Return only markdown for ${section.heading}.
Keep concise and evidence-grounded.
Do not add new facts.

Draft:
${draftSection}

Critique:
${critique}`;
}

function buildFinalConsistencyPrompt(markdown: string, guidance?: string) {
  return `Finalize this SKILL.md.
Rules:
- Keep title and required headings exactly.
- Remove repeated bullets.
- Remove unsupported or vague claims.
- Trim verbosity and keep implementation focus.
- Do not introduce any new design facts.
- Keep heading order unchanged.
Optional user guidance: ${guidance || "none"}

SKILL.md:
${markdown}`;
}

function buildSamplePrompt(skillMarkdown: string) {
  return `Create a standalone HTML document that demonstrates the design guidance in this SKILL.md.
Return only HTML, including CSS in a <style> tag. No Markdown fences.
The page should be a realistic app/tool screen, not a landing page.

SKILL.md:
${skillMarkdown}`;
}

function buildVerificationPrompt(existingSkill: string, guidance?: string) {
  return `Compare the new design references against this existing Codex design SKILL.md.
Return findings with headings:
Missing From Skill
Conflicts With Skill
Unvalidated Skill Rules
Strong Matches
For missing/conflict items, include a short "Suggested patch:" paragraph when useful.
Optional user guidance: ${guidance || "none"}

Existing SKILL.md:
${existingSkill}`;
}

function parseObservations(raw: string, assets: DesignAsset[]): SourceObservation[] {
  const lines = splitLines(raw).slice(0, 180);
  const observations: SourceObservation[] = [];
  let fallbackIndex = 0;
  for (const line of lines) {
    const parsed = parseObservationLine(line, assets, fallbackIndex);
    if (parsed) {
      observations.push(parsed.observation);
      fallbackIndex = parsed.nextIndex;
    }
  }
  if (!observations.length) {
    return lines.slice(0, 20).map((line, index) => {
      const asset = assets[index % assets.length];
      return {
        assetId: asset.id,
        assetName: asset.name,
        category: inferCategory(line),
        observation: line.replace(/^[-*]\s*/, ""),
        confidence: "medium"
      };
    });
  }
  return observations;
}

function parseObservationLine(line: string, assets: DesignAsset[], fallbackIndex: number) {
  const match = line.match(
    /^[-*]\s*category=(?<category>[^;]+);\s*confidence=(?<confidence>[^;]+);\s*source=(?<source>[^;]+);\s*observation=(?<observation>.+)$/i
  );
  if (!match?.groups?.observation) return null;
  const sourceName = match.groups.source.trim();
  const matchingAsset = assets.find((asset) => asset.name.toLowerCase() === sourceName.toLowerCase());
  const fallbackAsset = assets[fallbackIndex % assets.length];
  const asset = matchingAsset || fallbackAsset;
  const confidence = normalizeConfidence(match.groups.confidence);
  return {
    observation: {
      assetId: asset.id,
      assetName: asset.name,
      category: normalizeCategory(match.groups.category),
      observation: match.groups.observation.trim(),
      confidence
    },
    nextIndex: fallbackIndex + 1
  };
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
    findings.push({
      id: crypto.randomUUID(),
      category: "unvalidated",
      title: "Review needed",
      detail: text.slice(0, 800) || "The model did not return structured findings."
    });
  }

  return {
    findings,
    summary: `${findings.length} verification finding${findings.length === 1 ? "" : "s"} generated.`
  };
}

function makePatch(category: VerificationFinding["category"], text: string) {
  const heading = category === "conflict" ? "### Conflict Resolution" : "### Additional Design Rule";
  return `${heading}
- ${text.replace(/Suggested patch:/i, "").trim()}`;
}

function normalizeSkillMarkdown(markdown: string) {
  const stripped = markdown.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  const withTitle = stripped.startsWith("#") ? stripped : `${SKILL_TITLE}\n\n${stripped}`;
  const normalized = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const definition = SECTION_DEFINITION_BY_HEADING[heading];
    const body = extractSectionBody(withTitle, heading);
    return `${heading}\n${normalizeSectionBody(heading, body || definition.emptyEvidencePolicy, definition.target.maxBullets)}`;
  });
  return `${SKILL_TITLE}\n\n${normalized.join("\n\n")}`;
}

function normalizeSectionBody(heading: string, raw: string, maxBullets?: number) {
  const withoutHeading = raw.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
  const rawLines = withoutHeading ? splitLines(withoutHeading) : [];
  const bullets = rawLines
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);
  const limitedBullets = typeof maxBullets === "number" ? bullets.slice(0, maxBullets) : bullets;
  if (limitedBullets.length) return limitedBullets.join("\n");
  if (withoutHeading) return `- ${withoutHeading}`;
  return "- No validated guidance available.";
}

function extractSectionBody(markdown: string, heading: string) {
  const escaped = escapeRegExp(heading);
  const pattern = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = markdown.match(pattern);
  return match?.[1]?.trim() || "";
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
  if (typeof next.promptTokens === "number") {
    target.promptTokens = (target.promptTokens || 0) + next.promptTokens;
  }
  if (typeof next.completionTokens === "number") {
    target.completionTokens = (target.completionTokens || 0) + next.completionTokens;
  }
  if (typeof next.totalTokens === "number") {
    target.totalTokens = (target.totalTokens || 0) + next.totalTokens;
  } else if (typeof next.promptTokens === "number" || typeof next.completionTokens === "number") {
    const p = next.promptTokens || 0;
    const c = next.completionTokens || 0;
    target.totalTokens = (target.totalTokens || 0) + p + c;
  }
}

function formatUsage(usage: TokenUsage) {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  return `prompt ${prompt.toLocaleString()} · completion ${completion.toLocaleString()} · total ${total.toLocaleString()}`;
}
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
} from "./skillQuality";
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
};

type SectionDraft = {
  heading: string;
  draft: string;
  critique: string;
  revised: string;
  evidence: SourceObservation[];
};

type SectionEvidencePacket = {
  section: SkillSectionDefinition;
  observations: SourceObservation[];
};

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
  if (!sectionFirstEnabled) {
    addProgress(sessionId, "warning", "Legacy pipeline disabled; running section-first generation.");
  }

  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) {
      throw new Error("Add at least one usable asset before generation.");
    }
    for (const asset of usableAssets) {
      addProgress(sessionId, "ingesting_asset", `Prepared ${asset.name}.`);
      if (asset.warning) addProgress(sessionId, "warning", `${asset.name}: ${asset.warning}`);
    }

    const provider = runtimeOptions?.provider ?? createProvider(providerConfig);
    const usageTotals: TokenUsage = {};

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
    const sectionEvidence = buildSectionEvidence(observations);

    addProgress(sessionId, "synthesizing_rules", "Planning section-specific evidence packets.", {
      stepId: "plan_sections"
    });

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
        draft,
        critique,
        revised: normalizeSectionBody(packet.section.heading, revised, packet.section.target.maxBullets),
        evidence: packet.observations
      });
    }

    addProgress(sessionId, "drafting_skill", "Assembling SKILL.md from section outputs.", {
      stepId: "assemble_skill"
    });
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
      providerMeta: {
        provider: providerConfig.kind,
        model: providerConfig.model,
        reasoningExposed: provider.supportsReasoningStream
      }
    });

    updateSession(sessionId, {
      skillDraft: {
        markdown,
        observations,
        qualityNotes
      },
      sampleHtml: extractHtml(sampleHtml),
      status: "complete"
    });
    addProgress(sessionId, "complete", "Section-first skill draft, quality notes, and sample preview are ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function runVerification(
  sessionId: string,
  providerConfig: ProviderConfig,
  existingSkill: string,
  guidance?: string
) {
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
    const report = parseVerificationReport(analysis);
    updateSession(sessionId, { verificationReport: report, status: "complete" });
    addProgress(sessionId, "complete", `Token usage total: ${formatUsage(usageTotals)}.`, {
      streamKind: "summary",
      tokenUsage: usageTotals,
      providerMeta: {
        provider: providerConfig.kind,
        model: providerConfig.model,
        reasoningExposed: provider.supportsReasoningStream
      }
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
  const html = await provider.generateText(buildSamplePrompt(skillMarkdown));
  return extractHtml(html);
}

type StepRunArgs = {
  sessionId: string;
  providerConfig: ProviderConfig;
  providerSupportsReasoning: boolean;
  stepId: ProgressStepId;
  stepType: "extracting_design_signals" | "synthesizing_rules" | "drafting_skill" | "critiquing_skill" | "generating_sample";
  message: string;
  run: (handlers: {
    onEvent: (event: {
      kind: "content" | "reasoning" | "usage" | "status" | "step_complete";
      textDelta?: string;
      usage?: TokenUsage;
      usageIsFinal?: boolean;
      loadDurationMs?: number;
      status?: "waiting_for_first_chunk" | "first_chunk_received";
      latencyMs?: number;
      modelResident?: boolean;
    }) => void;
  }) => Promise<string>;
  usageTotals: TokenUsage;
};

async function runStreamedStep({
  sessionId,
  providerConfig,
  providerSupportsReasoning,
  stepId,
  stepType,
  message,
  run,
  usageTotals
}: StepRunArgs) {
  addProgress(sessionId, stepType, message, {
    stepId,
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

  const text = await run({
    onEvent: (event) => {
      if (event.kind === "content" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming output)`, {
          stepId,
          streamKind: "content",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning
          }
        });
        return;
      }
      if (event.kind === "reasoning" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming reasoning)`, {
          stepId,
          streamKind: "reasoning",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: true
          }
        });
        return;
      }
      if (event.kind === "usage" && event.usage) {
        mergeUsage(usageTotals, event.usage);
        addProgress(sessionId, stepType, `${message} (token usage updated)`, {
          stepId,
          streamKind: "usage",
          tokenUsage: event.usage,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            usageIsFinal: event.usageIsFinal,
            loadDurationMs: event.loadDurationMs
          }
        });
        return;
      }
      if (event.kind === "status" && event.status) {
        const statusMessage =
          event.status === "waiting_for_first_chunk"
            ? event.modelResident
              ? "Contacting provider and preparing generation."
              : "Loading model/runtime resources (cold start)."
            : "First response chunk received. Generation is now active.";
        addProgress(sessionId, stepType, statusMessage, {
          stepId,
          streamKind: "status",
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            streamStatus: event.status,
            modelResident: event.modelResident,
            latencyMs: event.latencyMs
          }
        });
      }
    }
  });

  addProgress(sessionId, stepType, `${message} (step complete)`, {
    stepId,
    streamKind: "step_complete",
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

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
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Step timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function buildSectionEvidence(observations: SourceObservation[]): SectionEvidencePacket[] {
  return SKILL_SECTION_DEFINITIONS.map((section) => {
    const candidates = observations.filter((observation) => {
      if (observation.confidence === "low") return false;
      return section.evidenceCategories.includes(observation.category);
    });
    const selected = candidates.length
      ? candidates.slice(0, MAX_EVIDENCE_LINES_PER_SECTION)
      : observations.slice(0, Math.min(4, observations.length));
    return { section, observations: selected };
  });
}

function assembleSkillMarkdown(sectionDrafts: SectionDraft[]) {
  const byHeading = new Map(sectionDrafts.map((section) => [section.heading, section]));
  const sectionBodies = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const draft = byHeading.get(heading);
    if (!draft) return `${heading}\n- No validated guidance available for this section.`;
    const body = draft.revised
      .replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "")
      .trim();
    return `${heading}\n${body || "- No validated guidance available for this section."}`;
  });
  return `${SKILL_TITLE}\n\n${sectionBodies.join("\n\n")}`.trim();
}

function buildQualityNotes(markdown: string, sectionDrafts: SectionDraft[]) {
  const notes: string[] = [];
  for (const section of sectionDrafts) {
    const critiqueLine = splitLines(section.critique)[0];
    if (critiqueLine) {
      notes.push(`${section.heading}: ${critiqueLine}`);
    }
  }
  const missingSections = getMissingSkillSections(markdown);
  if (missingSections.length) {
    notes.push(`Missing sections: ${missingSections.join(", ")}`);
  }
  const vague = getVagueSkillPhrases(markdown);
  if (vague.length) {
    notes.push(`Vague phrases found: ${vague.join(", ")}`);
  }
  const repeatedBullets = getRepeatedSkillBullets(markdown);
  if (repeatedBullets.length) {
    notes.push(`Repeated bullets: ${repeatedBullets.slice(0, 3).join(" | ")}`);
  }
  const compactness = getCompactnessIssues(markdown);
  if (compactness.length) {
    notes.push(...compactness.slice(0, 3));
  }
  return notes.slice(0, 12);
}

export function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.

Return structured observations as bullet lines prefixed by category and confidence:
- category=<one of color|typography|layout|components|accessibility|visual language>; confidence=<high|medium|low>; source=<asset name>; observation=<concrete observation>

Extraction requirements:
- Preserve concrete values: font families, type sizes, font weights, line heights, color values, CSS variables, radii, shadows, spacing, icon/favicon paths.
- Separate direct evidence from inference by lowering confidence for uncertain observations.
- Prefer enforceable implementation guidance.
- Do not include unsupported taste terms unless directly quoted from source text.
- Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}`;
}

export function buildSynthesisPrompt(rawExtraction: string, guidance?: string) {
  return `Summarize the extraction into compact rule groups by category.
Return markdown bullets only with headers:
### High Confidence
### Medium Confidence
### Low Confidence
Keep each bullet under 180 characters.
Optional user guidance: ${guidance || "none"}

Raw observations:
${rawExtraction}`;
}

export function buildSkillPrompt(synthesis: string, guidance?: string) {
  return `Legacy helper compatibility prompt. Produce a complete SKILL.md with required headings:
${REQUIRED_SKILL_SECTIONS.join("\n")}
Keep output concise and grounded in evidence.
Optional user guidance: ${guidance || "none"}

Synthesis:
${synthesis}`;
}

function buildSectionPrompt(section: SkillSectionDefinition, observations: SourceObservation[], guidance?: string) {
  const evidence = observations.length
    ? observations.map((item) => `- [${item.category}/${item.confidence}] ${item.assetName}: ${item.observation}`).join("\n")
    : "- No reliable evidence for this section.";
  const target = section.target;
  return `Write only this section for a SKILL.md.
Required heading: ${section.heading}
Intent: ${section.intent}
Evidence categories: ${section.evidenceCategories.join(", ")}
Constraints:
- ${target.minBullets ? `At least ${target.minBullets} bullets.` : "Use bullets only."}
- ${target.maxBullets ? `At most ${target.maxBullets} bullets.` : "Keep it concise."}
- ${target.maxCharsPerBullet ? `Each bullet <= ${target.maxCharsPerBullet} chars.` : "Use short bullets."}
- Do not invent tokens, brand details, or typography values.
- Omit unsupported claims; prefer explicit limits.
- Avoid filler words like clean, modern, beautiful, delightful, visually appealing.
- Output only markdown for ${section.heading}.
- If evidence is sparse: ${section.emptyEvidencePolicy}
Optional user guidance: ${guidance || "none"}

Evidence:
${evidence}`;
}

function buildSectionCritiquePrompt(section: SkillSectionDefinition, draftSection: string, observations: SourceObservation[]) {
  return `Critique this section for a SKILL.md.
Section: ${section.heading}
Focus:
- unsupported claims
- vague wording
- repeated guidance
- missing concrete values where evidence exists
- length/bullet violations
Return concise bullet issues only.

Evidence:
${observations.map((item) => `- ${item.assetName}: ${item.observation}`).join("\n") || "- none"}

Draft:
${draftSection}`;
}

function buildSectionRevisionPrompt(section: SkillSectionDefinition, draftSection: string, critique: string) {
  return `Revise this section based on critique.
Return only markdown for ${section.heading}.
Keep concise and evidence-grounded.
Do not add new facts.

Draft:
${draftSection}

Critique:
${critique}`;
}

function buildFinalConsistencyPrompt(markdown: string, guidance?: string) {
  return `Finalize this SKILL.md.
Rules:
- Keep title and required headings exactly.
- Remove repeated bullets.
- Remove unsupported or vague claims.
- Trim verbosity and keep implementation focus.
- Do not introduce any new design facts.
- Keep heading order unchanged.
Optional user guidance: ${guidance || "none"}

SKILL.md:
${markdown}`;
}

function buildVerificationPrompt(existingSkill: string, guidance?: string) {
  return `Compare the new design references against this existing Codex design SKILL.md.
Return findings with headings:
Missing From Skill
Conflicts With Skill
Unvalidated Skill Rules
Strong Matches
For missing/conflict items, include a short "Suggested patch:" paragraph when useful.
Optional user guidance: ${guidance || "none"}

Existing SKILL.md:
${existingSkill}`;
}

function parseObservations(raw: string, assets: DesignAsset[]): SourceObservation[] {
  const lines = splitLines(raw).slice(0, 180);
  const observations: SourceObservation[] = [];
  let fallbackIndex = 0;
  for (const line of lines) {
    const parsed = parseObservationLine(line, assets, fallbackIndex);
    if (parsed) {
      observations.push(parsed.observation);
      fallbackIndex = parsed.nextIndex;
    }
  }
  if (!observations.length) {
    return lines.slice(0, 20).map((line, index) => {
      const asset = assets[index % assets.length];
      return {
        assetId: asset.id,
        assetName: asset.name,
        category: inferCategory(line),
        observation: line.replace(/^[-*]\s*/, ""),
        confidence: "medium"
      };
    });
  }
  return observations;
}

function parseObservationLine(line: string, assets: DesignAsset[], fallbackIndex: number) {
  const match = line.match(
    /^[-*]\s*category=(?<category>[^;]+);\s*confidence=(?<confidence>[^;]+);\s*source=(?<source>[^;]+);\s*observation=(?<observation>.+)$/i
  );
  if (!match?.groups?.observation) return null;
  const sourceName = match.groups.source.trim();
  const matchingAsset = assets.find((asset) => asset.name.toLowerCase() === sourceName.toLowerCase());
  const fallbackAsset = assets[fallbackIndex % assets.length];
  const asset = matchingAsset || fallbackAsset;
  const confidence = normalizeConfidence(match.groups.confidence);
  return {
    observation: {
      assetId: asset.id,
      assetName: asset.name,
      category: normalizeCategory(match.groups.category),
      observation: match.groups.observation.trim(),
      confidence
    },
    nextIndex: fallbackIndex + 1
  };
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
    findings.push({
      id: crypto.randomUUID(),
      category: "unvalidated",
      title: "Review needed",
      detail: text.slice(0, 800) || "The model did not return structured findings."
    });
  }

  return {
    findings,
    summary: `${findings.length} verification finding${findings.length === 1 ? "" : "s"} generated.`
  };
}

function makePatch(category: VerificationFinding["category"], text: string) {
  const heading = category === "conflict" ? "### Conflict Resolution" : "### Additional Design Rule";
  return `${heading}
- ${text.replace(/Suggested patch:/i, "").trim()}`;
}

function normalizeSkillMarkdown(markdown: string) {
  const stripped = markdown.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  const withTitle = stripped.startsWith("#") ? stripped : `${SKILL_TITLE}\n\n${stripped}`;
  const normalized = REQUIRED_SKILL_SECTIONS.map((heading) => {
    const definition = SECTION_DEFINITION_BY_HEADING[heading];
    const body = extractSectionBody(withTitle, heading);
    return `${heading}\n${normalizeSectionBody(heading, body || definition.emptyEvidencePolicy, definition.target.maxBullets)}`;
  });
  return `${SKILL_TITLE}\n\n${normalized.join("\n\n")}`;
}

function normalizeSectionBody(heading: string, raw: string, maxBullets?: number) {
  const withoutHeading = raw.replace(new RegExp(`^${escapeRegExp(heading)}\\s*`, "i"), "").trim();
  const rawLines = withoutHeading ? splitLines(withoutHeading) : [];
  const bullets = rawLines
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => `- ${line}`);
  const limitedBullets = typeof maxBullets === "number" ? bullets.slice(0, maxBullets) : bullets;
  if (limitedBullets.length) return limitedBullets.join("\n");
  if (withoutHeading) return `- ${withoutHeading}`;
  return "- No validated guidance available.";
}

function extractSectionBody(markdown: string, heading: string) {
  const escaped = escapeRegExp(heading);
  const pattern = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = markdown.match(pattern);
  return match?.[1]?.trim() || "";
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
  if (typeof next.promptTokens === "number") {
    target.promptTokens = (target.promptTokens || 0) + next.promptTokens;
  }
  if (typeof next.completionTokens === "number") {
    target.completionTokens = (target.completionTokens || 0) + next.completionTokens;
  }
  if (typeof next.totalTokens === "number") {
    target.totalTokens = (target.totalTokens || 0) + next.totalTokens;
  } else if (typeof next.promptTokens === "number" || typeof next.completionTokens === "number") {
    const p = next.promptTokens || 0;
    const c = next.completionTokens || 0;
    target.totalTokens = (target.totalTokens || 0) + p + c;
  }
}

function formatUsage(usage: TokenUsage) {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  return `prompt ${prompt.toLocaleString()} · completion ${completion.toLocaleString()} · total ${total.toLocaleString()}`;
}
import { addProgress, getSession, updateSession } from "./store";
import type {
  DesignAsset,
  ProgressStepId,
  ProviderConfig,
  SourceObservation,
  TokenUsage,
  VerificationFinding,
  VerificationReport
} from "./types";
import { createProvider } from "./providers";

export async function runGeneration(sessionId: string, providerConfig: ProviderConfig, guidance?: string) {
  const session = getSession(sessionId);
  if (!session) throw new Error("Session not found");
  updateSession(sessionId, { providerConfig, guidance, status: "running", error: undefined });
  addProgress(sessionId, "queued", "Generation queued locally.");

  try {
    const usableAssets = session.assets.filter((asset) => asset.status !== "error");
    if (!usableAssets.length) {
      throw new Error("Add at least one usable asset before generation.");
    }
    for (const asset of usableAssets) {
      addProgress(sessionId, "ingesting_asset", `Prepared ${asset.name}.`);
      if (asset.warning) addProgress(sessionId, "warning", `${asset.name}: ${asset.warning}`);
    }

    const provider = createProvider(providerConfig);
    const usageTotals: TokenUsage = {};
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

    const synthesis = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "synthesize_rules",
      stepType: "synthesizing_rules",
      message: "Grouping observations into reusable design rules.",
      run: (handlers) => provider.generateTextStream(buildSynthesisPrompt(rawExtraction, guidance), handlers),
      usageTotals
    });

    const draft = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "draft_skill",
      stepType: "drafting_skill",
      message: "Drafting Codex-compatible SKILL.md instructions.",
      run: (handlers) => provider.generateTextStream(buildSkillPrompt(synthesis, guidance), handlers),
      usageTotals
    });

    const critique = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "critique_skill",
      stepType: "critiquing_skill",
      message: "Checking for vague, contradictory, or missing guidance.",
      run: (handlers) => provider.generateTextStream(buildCritiquePrompt(draft), handlers),
      usageTotals
    });
    const markdown = await runStreamedStep({
      sessionId,
      providerConfig,
      providerSupportsReasoning: provider.supportsReasoningStream,
      stepId: "revise_skill",
      stepType: "critiquing_skill",
      message: "Applying critique and revising the skill draft.",
      run: (handlers) => provider.generateTextStream(buildRevisionPrompt(draft, critique), handlers),
      usageTotals
    });

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

    addProgress(
      sessionId,
      "complete",
      `Token usage total: ${formatUsage(usageTotals)}.`,
      {
        streamKind: "summary",
        tokenUsage: usageTotals,
        providerMeta: {
          provider: providerConfig.kind,
          model: providerConfig.model,
          reasoningExposed: provider.supportsReasoningStream
        }
      }
    );

    updateSession(sessionId, {
      skillDraft: {
        markdown: normalizeSkillMarkdown(markdown),
        observations,
        qualityNotes: splitLines(critique).slice(0, 8)
      },
      sampleHtml: extractHtml(sampleHtml),
      status: "complete"
    });
    addProgress(sessionId, "complete", "Skill draft, quality notes, and sample preview are ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function runVerification(
  sessionId: string,
  providerConfig: ProviderConfig,
  existingSkill: string,
  guidance?: string
) {
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
    const report = parseVerificationReport(analysis);
    updateSession(sessionId, { verificationReport: report, status: "complete" });
    addProgress(
      sessionId,
      "complete",
      `Token usage total: ${formatUsage(usageTotals)}.`,
      {
        streamKind: "summary",
        tokenUsage: usageTotals,
        providerMeta: {
          provider: providerConfig.kind,
          model: providerConfig.model,
          reasoningExposed: provider.supportsReasoningStream
        }
      }
    );
    addProgress(sessionId, "complete", "Verification report is ready.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verification failed";
    updateSession(sessionId, { status: "error", error: message });
    addProgress(sessionId, "error", message);
  }
}

export async function generateSampleFromSkill(providerConfig: ProviderConfig, skillMarkdown: string) {
  const provider = createProvider(providerConfig);
  const html = await provider.generateText(buildSamplePrompt(skillMarkdown));
  return extractHtml(html);
}

type StepRunArgs = {
  sessionId: string;
  providerConfig: ProviderConfig;
  providerSupportsReasoning: boolean;
  stepId: ProgressStepId;
  stepType: "extracting_design_signals" | "synthesizing_rules" | "drafting_skill" | "critiquing_skill" | "generating_sample";
  message: string;
  run: (handlers: {
    onEvent: (event: {
      kind: "content" | "reasoning" | "usage" | "status" | "step_complete";
      textDelta?: string;
      usage?: TokenUsage;
      usageIsFinal?: boolean;
      loadDurationMs?: number;
      status?: "waiting_for_first_chunk" | "first_chunk_received";
      latencyMs?: number;
      modelResident?: boolean;
    }) => void;
  }) => Promise<string>;
  usageTotals: TokenUsage;
};

async function runStreamedStep({
  sessionId,
  providerConfig,
  providerSupportsReasoning,
  stepId,
  stepType,
  message,
  run,
  usageTotals
}: StepRunArgs) {
  addProgress(sessionId, stepType, message, {
    stepId,
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

  const text = await run({
    onEvent: (event) => {
      if (event.kind === "content" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming output)`, {
          stepId,
          streamKind: "content",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning
          }
        });
        return;
      }
      if (event.kind === "reasoning" && event.textDelta) {
        addProgress(sessionId, stepType, `${message} (streaming reasoning)`, {
          stepId,
          streamKind: "reasoning",
          textDelta: event.textDelta,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: true
          }
        });
        return;
      }
      if (event.kind === "usage" && event.usage) {
        mergeUsage(usageTotals, event.usage);
        addProgress(sessionId, stepType, `${message} (token usage updated)`, {
          stepId,
          streamKind: "usage",
          tokenUsage: event.usage,
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            usageIsFinal: event.usageIsFinal,
            loadDurationMs: event.loadDurationMs
          }
        });
        return;
      }
      if (event.kind === "status" && event.status) {
        const statusMessage =
          event.status === "waiting_for_first_chunk"
            ? event.modelResident
              ? "Contacting Ollama and preparing generation."
              : "Loading model into GPU memory (cold start)."
            : "First response chunk received. Generation is now active.";
        addProgress(sessionId, stepType, statusMessage, {
          stepId,
          streamKind: "status",
          providerMeta: {
            provider: providerConfig.kind,
            model: providerConfig.model,
            reasoningExposed: providerSupportsReasoning,
            streamStatus: event.status,
            modelResident: event.modelResident,
            latencyMs: event.latencyMs
          }
        });
      }
    }
  });

  addProgress(sessionId, stepType, `${message} (step complete)`, {
    stepId,
    streamKind: "step_complete",
    providerMeta: {
      provider: providerConfig.kind,
      model: providerConfig.model,
      reasoningExposed: providerSupportsReasoning
    }
  });

  return text;
}

function mergeUsage(target: TokenUsage, next: TokenUsage) {
  if (typeof next.promptTokens === "number") {
    target.promptTokens = (target.promptTokens || 0) + next.promptTokens;
  }
  if (typeof next.completionTokens === "number") {
    target.completionTokens = (target.completionTokens || 0) + next.completionTokens;
  }
  if (typeof next.totalTokens === "number") {
    target.totalTokens = (target.totalTokens || 0) + next.totalTokens;
  } else if (typeof next.promptTokens === "number" || typeof next.completionTokens === "number") {
    const p = next.promptTokens || 0;
    const c = next.completionTokens || 0;
    target.totalTokens = (target.totalTokens || 0) + p + c;
  }
}

function formatUsage(usage: TokenUsage) {
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  return `prompt ${prompt.toLocaleString()} · completion ${completion.toLocaleString()} · total ${total.toLocaleString()}`;
}

export function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.

Return structured observations with these exact headings:
Source Inventory
Brand And Content Voice
Layout And Composition
Typography
Color And Design Tokens
Icons, Favicons, And Imagery
Components And Patterns
Interaction States
Accessibility
Responsive Behavior
Avoid Rules
Weak Or Uncertain Inferences

Extraction rules:
- Cite asset names for important observations.
- Preserve concrete values when present: font families, type sizes, font weights, line heights, color values, CSS custom properties, icon/favicon paths, radii, shadows, spacing, and component states.
- Distinguish direct evidence from inference. Put guesses under "Weak Or Uncertain Inferences".
- Prefer enforceable implementation guidance over mood words.
- Do not use unsupported phrases like "clean", "modern", "beautiful", or "visually appealing" unless the source explicitly says them as content.
Optional user guidance: ${guidance || "none"}`;
}

export function buildSynthesisPrompt(rawExtraction: string, guidance?: string) {
  return `Turn these raw observations into concrete reusable design rules for a Codex skill.
Preserve high-confidence tokens and exact source values where they are useful for implementation.
Keep source distinctions when references disagree or when a rule only applies to one source.
Mark weak inferences explicitly and do not promote them into rules unless they are useful with caveats.
Include coverage for typography, color/tokens, icons/favicon/assets, component anatomy, interaction states, accessibility, and responsive behavior when evidence exists.
Optional user guidance: ${guidance || "none"}

Raw observations:
${rawExtraction}`;
}

export function buildSkillPrompt(synthesis: string, guidance?: string) {
  return `Write a complete Codex design SKILL.md.
Use Markdown. Include exactly these top-level sections:
# Design System Skill
## When To Use
## Workflow
## Design Rules
## Accessibility And Responsiveness
## Verification Checklist
## Examples
Make rules specific, actionable, and useful to an agent building UI.
Avoid claims that are not supported by the supplied references.
Within those required sections, include practical guidance for:
- Typography: font families, scale, weights, line heights, and text hierarchy when known.
- Color and tokens: named CSS variables, exact colors, contrast-sensitive pairings, gradients, shadows, radii, and spacing patterns when known.
- Icons, favicon, and imagery: preferred icon sources, favicon/apple-touch/manifest assets, image treatments, and when not to invent missing assets.
- Components: anatomy, density, borders, elevation, state styles, and reusable layout patterns.
- Interaction: hover/focus/active/loading/empty/error states when supported by the evidence.
- Verification: checks that compare output against concrete values and visible patterns, not generic taste.
Optional user guidance: ${guidance || "none"}

Synthesized design rules:
${synthesis}`;
}

function buildCritiquePrompt(draft: string) {
  return `Critique this SKILL.md draft. List only concrete issues: vague rules, contradictions, missing required sections, missing concrete typography/color/icon guidance, missing accessibility/responsive guidance, unsupported claims, or rules that are not actionable.

Draft:
${draft}`;
}

function buildRevisionPrompt(draft: string, critique: string) {
  return `Revise the SKILL.md using the critique. Return only the final Markdown.

Draft:
${draft}

Critique:
${critique}`;
}

function buildSamplePrompt(skillMarkdown: string) {
  return `Create a standalone HTML document that demonstrates the design guidance in this SKILL.md.
Return only HTML, including CSS in a <style> tag. No Markdown fences.
The page should be a realistic app/tool screen, not a landing page.

SKILL.md:
${skillMarkdown}`;
}

function buildVerificationPrompt(existingSkill: string, guidance?: string) {
  return `Compare the new design references against this existing Codex design SKILL.md.
Return findings with headings:
Missing From Skill
Conflicts With Skill
Unvalidated Skill Rules
Strong Matches
For missing/conflict items, include a short "Suggested patch:" paragraph when useful.
Optional user guidance: ${guidance || "none"}

Existing SKILL.md:
${existingSkill}`;
}

function parseObservations(raw: string, assets: DesignAsset[]): SourceObservation[] {
  const lines = splitLines(raw).slice(0, 40);
  return lines.map((line, index) => {
    const asset = assets[index % assets.length];
    return {
      assetId: asset.id,
      assetName: asset.name,
      category: inferCategory(line),
      observation: line.replace(/^[-*]\s*/, ""),
      confidence: "medium"
    };
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
    findings.push({
      id: crypto.randomUUID(),
      category: "unvalidated",
      title: "Review needed",
      detail: text.slice(0, 800) || "The model did not return structured findings."
    });
  }

  return {
    findings,
    summary: `${findings.length} verification finding${findings.length === 1 ? "" : "s"} generated.`
  };
}

function makePatch(category: VerificationFinding["category"], text: string) {
  const heading = category === "conflict" ? "### Conflict Resolution" : "### Additional Design Rule";
  return `${heading}
- ${text.replace(/Suggested patch:/i, "").trim()}`;
}

function normalizeSkillMarkdown(markdown: string) {
  const stripped = markdown.replace(/^```(?:markdown)?/i, "").replace(/```$/i, "").trim();
  return stripped.startsWith("#") ? stripped : `# Design System Skill\n\n${stripped}`;
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
  if (lower.includes("color") || lower.includes("palette")) return "color";
  if (lower.includes("type") || lower.includes("font")) return "typography";
  if (lower.includes("layout") || lower.includes("grid")) return "layout";
  if (lower.includes("button") || lower.includes("card") || lower.includes("component")) return "components";
  if (lower.includes("access")) return "accessibility";
  return "visual language";
}

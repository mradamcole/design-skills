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

function buildExtractionPrompt(guidance?: string) {
  return `You are extracting design-system guidance for a Codex SKILL.md file.
Return a concise but rich list of observations grouped by:
visual language, layout, typography, color, components, interaction, accessibility, responsive behavior, avoid rules.
Prefer enforceable observations over mood words.
Optional user guidance: ${guidance || "none"}`;
}

function buildSynthesisPrompt(rawExtraction: string, guidance?: string) {
  return `Turn these raw observations into concrete reusable design rules for a Codex skill.
Keep source distinctions where useful and mark weak inferences.
Optional user guidance: ${guidance || "none"}

Raw observations:
${rawExtraction}`;
}

function buildSkillPrompt(synthesis: string, guidance?: string) {
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
Optional user guidance: ${guidance || "none"}

Synthesized design rules:
${synthesis}`;
}

function buildCritiquePrompt(draft: string) {
  return `Critique this SKILL.md draft. List only concrete issues: vague rules, contradictions, missing required sections, missing accessibility/responsive guidance, or rules that are not actionable.

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

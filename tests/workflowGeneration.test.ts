import { describe, expect, it } from "vitest";
import { addAsset, createSession, getSession } from "@/lib/store";
import { runGeneration } from "@/lib/workflowCore";
import type { LlmProvider } from "@/lib/providers";
import type { ProviderConfig } from "@/lib/types";

const providerConfig: ProviderConfig = {
  kind: "openai",
  model: "test-model",
  apiKey: "test-key"
};

function createMockProvider(options?: { failFirstWhenToUseDraft?: boolean }): LlmProvider {
  let failedOnce = false;
  return {
    supportsVision: true,
    supportsReasoningStream: false,
    async generateText(prompt: string) {
      return `<html><body>${prompt.slice(0, 20)}</body></html>`;
    },
    async analyzeAssets() {
      return [
        "- category=color; confidence=high; source=Reference A; observation=Primary token --brand uses #2563eb.",
        "- category=typography; confidence=high; source=Reference A; observation=Headings use Inter 700.",
        "- category=layout; confidence=medium; source=Reference A; observation=Cards use 24px spacing.",
        "- category=components; confidence=medium; source=Reference A; observation=Buttons are rounded with clear hover states.",
        "- category=accessibility; confidence=high; source=Reference A; observation=Focus states are visible and contrast is strong.",
        "- category=voice; confidence=high; source=Reference A; observation=Our team uses friendly second-person copy with short Learn more CTAs."
      ].join("\n");
    },
    async generateTextStream(prompt: string, handlers) {
      handlers?.onEvent?.({ kind: "content", textDelta: "x" });
      handlers?.onEvent?.({
        kind: "usage",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        usageIsFinal: true
      });
      if (prompt.includes("Required heading: ## When To Use")) {
        if (options?.failFirstWhenToUseDraft && !failedOnce) {
          failedOnce = true;
          throw new Error("Transient draft failure");
        }
        return "## When To Use\n- Apply this skill when reproducing the referenced UI style.\n- Use when concrete tokens must stay consistent.";
      }
      if (prompt.includes("Required heading: ## Workflow")) {
        return "## Workflow\n- Inspect references.\n- Extract concrete tokens.\n- Draft targeted sections.\n- Verify output against evidence.";
      }
      if (prompt.includes("Required heading: ## Design Rules")) {
        return "## Design Rules\n- Keep card spacing consistent at 24px.\n- Preserve rounded button shape.\n- Reuse visible hover/focus states.";
      }
      if (prompt.includes("Required heading: ## Brand")) {
        return "## Brand\n- Brand-specific logo usage is not evidenced; do not invent logo rules.";
      }
      if (prompt.includes("Required heading: ## Colors")) {
        return "## Colors\n- Use --brand #2563eb as the primary accent.\n- Preserve contrast for interactive states.";
      }
      if (prompt.includes("Required heading: ## Typography")) {
        return "## Typography\n- Use Inter for headings at strong weight.\n- Keep readable body hierarchy with consistent scale.";
      }
      if (prompt.includes("Required heading: ## Voice")) {
        return "## Voice\n- Prefer second-person you/your in marketing copy.\n- Use short CTA verbs such as Learn more.\n- Keep an approachable, team-forward we voice in hero copy.";
      }
      if (prompt.includes("Required heading: ## Accessibility And Responsiveness")) {
        return "## Accessibility And Responsiveness\n- Keep visible focus states.\n- Preserve contrast in interactive elements.\n- Maintain readable spacing on narrow screens.";
      }
      if (prompt.includes("Required heading: ## Verification Checklist")) {
        return "## Verification Checklist\n- Check brand color token usage.\n- Check heading font treatment.\n- Check button hover/focus states.\n- Check spacing consistency.";
      }
      if (prompt.includes("Required heading: ## Examples")) {
        return "## Examples\n- Build a dashboard card list with rounded CTA buttons using the brand accent.";
      }
      if (prompt.startsWith("Critique this section")) {
        return "- Remove vague wording.\n- Keep only evidence-backed bullets.";
      }
      if (prompt.startsWith("Revise this section")) {
        const headingMatch = prompt.match(/Return only markdown for (## [^\n]+)/);
        const heading = headingMatch?.[1] || "## Unknown";
        if (heading === "## Voice") {
          return `${heading}\n- Prefer second-person you/your in marketing copy.\n- Use short CTA verbs such as Learn more.\n- Keep an approachable, team-forward we voice in hero copy.`;
        }
        return `${heading}\n- Evidence-backed guidance retained.\n- Unsupported claims removed.`;
      }
      if (prompt.startsWith("Finalize this SKILL.md")) {
        const split = prompt.split("SKILL.md:");
        return split[split.length - 1].trim();
      }
      if (prompt.startsWith("Create a standalone HTML document")) {
        return "<!doctype html><html><body><main>sample</main></body></html>";
      }
      return "## Fallback\n- fallback";
    },
    async analyzeAssetsStream(prompt: string, assets, handlers) {
      const text = await this.analyzeAssets(prompt, assets);
      handlers?.onEvent?.({ kind: "content", textDelta: text });
      return text;
    }
  };
}

describe("workflow generation", () => {
  it("seeds skeleton markdown and incrementally updates sections", async () => {
    const session = createSession("generate");
    const snapshots: string[] = [];
    addAsset(session.id, {
      id: "asset-0",
      type: "url",
      name: "Reference A",
      source: "https://example.com/skeleton",
      mimeType: "text/plain",
      content: "reference content",
      status: "ready"
    });

    await runGeneration(session.id, providerConfig, "be concise", {
      provider: createMockProvider(),
      sectionFirstEnabled: true,
      retriesPerSection: 1,
      onSkillDraftUpdate: (markdown) => snapshots.push(markdown)
    });

    const updated = getSession(session.id);
    expect(snapshots.length).toBeGreaterThan(3);
    expect(snapshots[0]).toContain("# Design System Skill");
    expect(snapshots[0]).toContain("## When To Use");
    expect(snapshots[0]).toContain("## Verification Checklist");
    expect(snapshots[0]).not.toContain("- No validated guidance available for this section.");
    expect(snapshots.some((snapshot) => snapshot.includes("## When To Use\n-"))).toBe(true);
    expect(snapshots[snapshots.length - 1]).toBe(updated?.skillDraft?.markdown);
  });

  it("assembles all required sections in canonical order", async () => {
    const session = createSession("generate");
    addAsset(session.id, {
      id: "asset-1",
      type: "url",
      name: "Reference A",
      source: "https://example.com",
      mimeType: "text/plain",
      content: "reference content",
      status: "ready"
    });

    await runGeneration(session.id, providerConfig, "be concise", {
      provider: createMockProvider(),
      sectionFirstEnabled: true,
      retriesPerSection: 1
    });

    const updated = getSession(session.id);
    expect(updated?.status).toBe("complete");
    expect(updated?.skillDraft?.markdown).toContain("## Brand");
    expect(updated?.skillDraft?.markdown).toContain("## Colors");
    expect(updated?.skillDraft?.markdown).toContain("## Typography");
    expect(updated?.sampleHtml).toContain("<html");
  });

  it("retries failed section drafts and still completes", async () => {
    const session = createSession("generate");
    addAsset(session.id, {
      id: "asset-2",
      type: "url",
      name: "Reference A",
      source: "https://example.com/2",
      mimeType: "text/plain",
      content: "reference content",
      status: "ready"
    });

    await runGeneration(session.id, providerConfig, undefined, {
      provider: createMockProvider({ failFirstWhenToUseDraft: true }),
      sectionFirstEnabled: true,
      retriesPerSection: 1
    });

    const updated = getSession(session.id);
    expect(updated?.status).toBe("complete");
    expect(updated?.skillDraft?.qualityNotes.length).toBeGreaterThan(0);
  });

  it("uses static baseline sections without drafting prompts", async () => {
    const session = createSession("generate");
    const draftedHeadings: string[] = [];
    addAsset(session.id, {
      id: "asset-3",
      type: "url",
      name: "Reference A",
      source: "https://example.com/3",
      mimeType: "text/plain",
      content: "reference content",
      status: "ready"
    });
    const provider: LlmProvider = {
      ...createMockProvider(),
      async generateTextStream(prompt, handlers) {
        const heading = prompt.match(/Required heading:\s*(##[^\n]+)/)?.[1];
        if (heading) draftedHeadings.push(heading);
        return createMockProvider().generateTextStream(prompt, handlers);
      }
    };
    await runGeneration(session.id, providerConfig, undefined, {
      provider,
      sectionFirstEnabled: true,
      sectionStaticBaselinesEnabled: true
    });
    expect(draftedHeadings).not.toContain("## When To Use");
    expect(draftedHeadings).not.toContain("## Workflow");
    expect(draftedHeadings).not.toContain("## Verification Checklist");
    expect(draftedHeadings).toContain("## Typography");
  });

  it("merges compiled Voice facts with raw observations when compiler is enabled and readable text exists", async () => {
    const session = createSession("generate");
    const readable = `${"Wordy marketing narrative. ".repeat(12)}Get started today.`;
    addAsset(session.id, {
      id: "asset-compiler-voice",
      type: "url",
      name: "Reference A",
      source: "https://example.com/voice",
      mimeType: "text/plain",
      content: `## Readable Page Text\n${readable}\n\n## Typography Signals\n- font-size: 16px`,
      status: "ready"
    });

    await runGeneration(session.id, providerConfig, undefined, {
      provider: createMockProvider(),
      sectionFirstEnabled: true,
      retriesPerSection: 1,
      sectionEvidenceCompilerEnabled: true
    });

    const updated = getSession(session.id);
    expect(updated?.status).toBe("complete");
    const voiceSection = updated?.skillDraft?.markdown.match(/## Voice\n([\s\S]*?)(?=\n## |\n*$)/)?.[1] || "";
    expect(voiceSection).not.toMatch(/not strongly evidenced|not evidenced/i);
    expect(voiceSection.length).toBeGreaterThan(40);
  });
});

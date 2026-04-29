import { describe, expect, it } from "vitest";
import { compileSectionEvidence, normalizeObservationCategory } from "@/lib/sectionEvidence";
import type { DesignAsset, SourceObservation } from "@/lib/types";

const observations: SourceObservation[] = [
  {
    assetId: "a1",
    assetName: "Reference A",
    category: "typography",
    observation: "font-family: Inter, system-ui",
    confidence: "high"
  },
  {
    assetId: "a1",
    assetName: "Reference A",
    category: "typography",
    observation: "font-size: 16px",
    confidence: "high"
  },
  {
    assetId: "a2",
    assetName: "Reference B",
    category: "color",
    observation: "Primary token --brand: #2563eb",
    confidence: "high"
  },
  {
    assetId: "a2",
    assetName: "Reference B",
    category: "color",
    observation: "Primary token --brand: #2563eb",
    confidence: "medium"
  }
];

const assets: DesignAsset[] = [
  {
    id: "a1",
    type: "url",
    name: "Reference A",
    source: "https://example.com/a",
    mimeType: "text/plain",
    content: `## Typography Signals
- font-family: Inter, system-ui
- font-size: 16px

## Color And Token Signals
- --brand: #2563eb`,
    status: "ready"
  }
];

describe("section evidence compiler", () => {
  it("maps voice-related extractor categories to voice", () => {
    expect(normalizeObservationCategory("voice")).toBe("voice");
    expect(normalizeObservationCategory("microcopy")).toBe("voice");
    expect(normalizeObservationCategory("Copy")).toBe("voice");
  });

  it("compiles selected facts and preserves deterministic ordering", () => {
    const packets = compileSectionEvidence(observations, assets);
    const typography = packets.find((packet) => packet.section.id === "typography");
    expect(typography?.selectedFacts.length).toBeGreaterThan(0);
    expect(typography?.selectedFacts[0].kind).toBe("font-family");
  });

  it("deduplicates repeated facts and accumulates provenance", () => {
    const packets = compileSectionEvidence(observations, assets);
    const colors = packets.find((packet) => packet.section.id === "colors");
    const brandToken = colors?.facts.find((fact) => fact.kind === "css-token" && fact.normalizedValue === "--brand");
    expect(brandToken?.frequency).toBeGreaterThanOrEqual(2);
    expect(brandToken?.sourceCount).toBeGreaterThanOrEqual(1);
  });

  it("honors colorsFactLimit when selecting color facts", () => {
    const manyColorObs: SourceObservation[] = Array.from({ length: 15 }, (_, i) => ({
      assetId: "a1",
      assetName: "Ref",
      category: "color" as const,
      observation: `color: #${String(i + 1).padStart(6, "0")}`,
      confidence: "high" as const
    }));
    const defaultPackets = compileSectionEvidence(manyColorObs, []);
    const defaultColors = defaultPackets.find((packet) => packet.section.id === "colors");
    expect(defaultColors?.selectedFacts.length).toBeLessThanOrEqual(12);

    const widePackets = compileSectionEvidence(manyColorObs, [], { colorsFactLimit: 24 });
    const wideColors = widePackets.find((packet) => packet.section.id === "colors");
    expect(wideColors?.selectedFacts.length).toBe(15);
  });

  it("produces voice facts from voice-category observations", () => {
    const voiceObs: SourceObservation[] = [
      {
        assetId: "a1",
        assetName: "Marketing",
        category: "voice",
        observation: "Our team welcomes you—tap Get started to learn more today.",
        confidence: "high"
      }
    ];
    const voicePackets = compileSectionEvidence(voiceObs, []);
    const voice = voicePackets.find((packet) => packet.section.id === "voice");
    expect(voice?.selectedFacts.length).toBeGreaterThan(0);
    const kinds = new Set(voice?.selectedFacts.map((f) => f.kind));
    expect([...kinds].some((k) => k === "tone" || k === "copy-pattern" || k === "label-style" || k === "capitalization")).toBe(true);
  });
});

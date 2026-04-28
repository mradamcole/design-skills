import { describe, expect, it } from "vitest";
import { compileSectionEvidence } from "@/lib/sectionEvidence";
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
});

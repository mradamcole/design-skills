import { describe, expect, it } from "vitest";
import {
  collectImageCards,
  collectPinnedBrandCards,
  decodedByteLength,
  formatBytes,
  formatPinnedBrandAssetsBlock,
  formatRequiredBrandPinsBlock,
  proposeHumanName,
  type ImageCard
} from "@/lib/imageCards";
import type { DesignAsset } from "@/lib/types";

describe("proposeHumanName", () => {
  it("title-cases a filename without extension", () => {
    expect(proposeHumanName("logo_mark-dark_v2.png")).toBe("Logo Mark Dark V2");
  });
});

describe("decodedByteLength", () => {
  it("matches length for a known small base64 string", () => {
    expect(decodedByteLength("eA==")).toBe(1);
  });
});

describe("formatBytes", () => {
  it("formats bytes and kilobytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1024)).toMatch(/KB/);
  });
});

describe("collectImageCards", () => {
  it("includes uploaded image assets and embedded url images", () => {
    const upload: DesignAsset = {
      id: "a1",
      type: "image",
      name: "shot.png",
      source: "upload",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,xx",
      status: "ready"
    };
    const page: DesignAsset = {
      id: "a2",
      type: "url",
      name: "Site",
      source: "https://example.com",
      mimeType: "text/html",
      content: "x",
      status: "ready",
      embeddedAssets: [
        {
          id: "e1",
          kind: "image",
          sourceUrl: "https://example.com/i.jpg",
          fileName: "hero.jpg",
          mimeType: "image/jpeg",
          fetchedAt: 1,
          status: "fetched",
          bytesBase64: "eA=="
        }
      ]
    };
    const cards = collectImageCards([upload, page]);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.fileName).toBe("shot.png");
    expect(cards[0]!.kind).toBe("upload");
    expect(cards[0]!.fileSizeBytes).toBe(decodedByteLength("xx"));
    expect(cards[1]!.fileName).toBe("hero.jpg");
    expect(cards[1]!.displaySrc.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(cards[1]!.fileSizeBytes).toBe(decodedByteLength("eA=="));
  });

  it("deduplicates embedded assets with identical image bytes and mime", () => {
    const b64 = "eA==";
    const page1: DesignAsset = {
      id: "o1",
      type: "url",
      name: "A",
      source: "https://a.com/1",
      mimeType: "text/html",
      content: "x",
      status: "ready",
      embeddedAssets: [
        {
          id: "e1",
          kind: "image",
          sourceUrl: "https://a.com/one.png",
          fileName: "a.png",
          mimeType: "image/png",
          fetchedAt: 1,
          status: "fetched",
          bytesBase64: b64
        }
      ]
    };
    const page2: DesignAsset = {
      id: "o2",
      type: "url",
      name: "B",
      source: "https://b.com/2",
      mimeType: "text/html",
      content: "x",
      status: "ready",
      embeddedAssets: [
        {
          id: "e2",
          kind: "image",
          sourceUrl: "https://b.com/two.png",
          fileName: "b.png",
          mimeType: "image/png",
          fetchedAt: 1,
          status: "fetched",
          bytesBase64: b64
        }
      ]
    };
    const cards = collectImageCards([page1, page2]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.fileName).toBe("a.png");
  });

  it("returns pinned cards only", () => {
    const a: DesignAsset = {
      id: "a1",
      type: "image",
      name: "a.png",
      source: "upload",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,xx",
      status: "ready",
      pinToBrand: true
    };
    const b: DesignAsset = {
      id: "a2",
      type: "image",
      name: "b.png",
      source: "upload",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,yy",
      status: "ready"
    };
    const pinned = collectPinnedBrandCards([a, b]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.fileName).toBe("a.png");
  });
});

const minimalCard = (overrides: Partial<ImageCard>): ImageCard => ({
  id: "id1",
  ownerAssetId: "o1",
  kind: "upload",
  fileName: "SDH_2064x64.png",
  sourceUrl: "https://example.com/x.png",
  displaySrc: "data:image/png;base64,xx",
  fileSizeBytes: 1,
  ...overrides
});

describe("formatRequiredBrandPinsBlock", () => {
  it("emits Image prefix, backticked display name, and plain filename", () => {
    const block = formatRequiredBrandPinsBlock([
      minimalCard({ humanName: "Sdh 2064x64" })
    ]);
    expect(block).toContain("exactly as shown");
    expect(block).toContain("- Image: `Sdh 2064x64` SDH_2064x64.png");
    expect(block).not.toContain("Always use");
  });

  it("returns empty string when no pins", () => {
    expect(formatRequiredBrandPinsBlock([])).toBe("");
  });
});

describe("formatPinnedBrandAssetsBlock", () => {
  it("lists pinned assets with Image line and source", () => {
    const assets: DesignAsset[] = [
      {
        id: "a1",
        type: "image",
        name: "logo.png",
        source: "upload",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,xx",
        status: "ready",
        pinToBrand: true,
        humanName: "Primary Logo"
      }
    ];
    const block = formatPinnedBrandAssetsBlock(assets);
    expect(block).toContain("## Pinned Brand Assets");
    expect(block).toContain("- Image: `Primary Logo` logo.png (source: upload)");
  });
});

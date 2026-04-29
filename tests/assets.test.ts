import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyAsset, extractCssSignals, extractPageMetadata, urlToAsset } from "@/lib/assets";

const html = `<!doctype html>
<html>
  <head>
    <title>Example Product</title>
    <meta name="description" content="Design reference page">
    <meta name="theme-color" content="#101828">
    <meta property="og:image" content="/og.png">
    <link rel="icon" href="/favicon.ico" sizes="32x32">
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="manifest" href="/site.webmanifest">
    <link rel="stylesheet" href="/styles.css">
    <style>
      :root { --brand: #2563eb; --radius-card: 16px; }
      body { font-family: Inter, system-ui; font-size: 16px; line-height: 1.5; }
      .card { border-radius: var(--radius-card); box-shadow: 0 12px 30px rgba(15, 23, 42, .18); padding: 24px; }
    </style>
  </head>
  <body>
    <img src="/hero.png" />
    <h1>Build polished design skills</h1>
    <p>Extract typography, colors, and interaction guidance.</p>
  </body>
</html>`;

describe("asset classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies common asset types", () => {
    expect(classifyAsset("screen.png", "image/png")).toBe("image");
    expect(classifyAsset("guide.md", "text/markdown")).toBe("markdown");
    expect(classifyAsset("notes.txt", "text/plain")).toBe("text");
    expect(classifyAsset("system.pdf", "application/pdf")).toBe("pdf");
    expect(classifyAsset("brand.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
  });

  it("marks unknown binary assets unsupported", () => {
    expect(classifyAsset("archive.bin", "application/octet-stream")).toBe("unsupported");
  });

  it("extracts URL metadata and linked design assets", () => {
    const metadata = extractPageMetadata(html, new URL("https://example.com/reference"));

    expect(metadata.title).toBe("Example Product");
    expect(metadata.description).toBe("Design reference page");
    expect(metadata.themeColor).toBe("#101828");
    expect(metadata.openGraphImage).toBe("https://example.com/og.png");
    expect(metadata.manifest).toBe("https://example.com/site.webmanifest");
    expect(metadata.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel: "icon", href: "https://example.com/favicon.ico", sizes: "32x32" }),
        expect.objectContaining({ rel: "apple-touch-icon", href: "https://example.com/touch.png" })
      ])
    );
    expect(metadata.stylesheets).toContain("https://example.com/styles.css");
    expect(metadata.images).toContain("https://example.com/hero.png");
  });

  it("summarizes typography, color, radius, shadow, and spacing CSS signals", () => {
    const signals = extractCssSignals(`
      @import url("https://fonts.example/inter.css");
      :root { --brand: #2563eb; --surface: rgb(255, 255, 255); }
      body { font-family: Inter, system-ui; font-size: 16px; font-weight: 400; line-height: 1.5; letter-spacing: -0.01em; }
      .card { border-radius: 16px; box-shadow: 0 12px 30px rgba(15, 23, 42, .18); padding: 24px; gap: 12px; }
    `);

    expect(signals.fontImports).toContain("https://fonts.example/inter.css");
    expect(signals.fontFamilies).toContain("Inter, system-ui");
    expect(signals.fontSizes).toContain("16px");
    expect(signals.fontWeights).toContain("400");
    expect(signals.lineHeights).toContain("1.5");
    expect(signals.letterSpacings).toContain("-0.01em");
    expect(signals.colors).toEqual(expect.arrayContaining(["#2563eb", "rgb(255, 255, 255)"]));
    expect(signals.customProperties).toContainEqual({ name: "--brand", value: "#2563eb" });
    expect(signals.radii).toContain("16px");
    expect(signals.shadows).toContain("0 12px 30px rgba(15, 23, 42, .18)");
    expect(signals.spacing).toEqual(expect.arrayContaining(["24px", "12px"]));
  });

  it("limits distinct CSS color literals via maxColors", () => {
    const css = Array.from({ length: 20 }, (_, i) => `.c${i}{color:#${String(i + 1).padStart(6, "0")}}`).join("\n");
    const many = extractCssSignals(css, { maxColors: 20 });
    expect(many.colors.length).toBe(20);
    const few = extractCssSignals(css, { maxColors: 4 });
    expect(few.colors.length).toBe(4);
  });

  it("builds URL assets with readable text, icons, stylesheet CSS, and typography evidence", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const value = input.toString();
      if (value === "https://example.com/reference") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (value === "https://example.com/styles.css") {
        return new Response('.button { font-weight: 700; color: #f97316; border-radius: 999px; background-image: url("/bg.png"); }');
      }
      if (value === "https://example.com/site.webmanifest") {
        return new Response(JSON.stringify({ icons: [{ src: "/icon-192.png" }] }), {
          headers: { "content-type": "application/manifest+json" }
        });
      }
      if (
        value === "https://example.com/favicon.ico" ||
        value === "https://example.com/touch.png" ||
        value === "https://example.com/hero.png" ||
        value === "https://example.com/og.png" ||
        value === "https://example.com/bg.png" ||
        value === "https://example.com/icon-192.png"
      ) {
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "content-type": "image/png" }
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const asset = await urlToAsset("https://example.com/reference");

    expect(asset.name).toBe("Example Product");
    expect(asset.content).toContain("## Icons And Favicons");
    expect(asset.content).toContain("https://example.com/favicon.ico");
    expect(asset.content).toContain("--brand: #2563eb");
    expect(asset.content).toContain("font-family: Inter, system-ui");
    expect(asset.content).toContain("font-weight: 700");
    expect(asset.content).toContain("Build polished design skills");
    expect(asset.content).toContain("## Embedded Asset Inventory");
    expect(asset.embeddedAssets?.some((item) => item.kind === "icon" && item.status === "fetched")).toBe(true);
    expect(asset.embeddedAssets?.some((item) => item.kind === "manifest" && item.status === "fetched")).toBe(true);
    expect(asset.embeddedAssets?.some((item) => item.kind === "image" && item.sourceUrl.includes("bg.png"))).toBe(true);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { GET } from "@/app/api/download/[sessionId]/bundle/route";
import { addAsset, createSession, store, updateSession } from "@/lib/store";
import type { DesignAsset } from "@/lib/types";

describe("bundle download route", () => {
  beforeEach(() => {
    store.sessions.clear();
    store.settingsMemory.assets = [];
  });

  it("returns reference summaries by default", async () => {
    const session = createSession("generate");
    updateSession(session.id, {
      skillDraft: { markdown: "# Design System Skill", observations: [], qualityNotes: [] },
      sampleHtml: "<!doctype html><html><body>sample</body></html>"
    });
    addAsset(session.id, makeUrlAsset());

    const response = await GET(new Request(`http://localhost/api/download/${session.id}/bundle`), {
      params: Promise.resolve({ sessionId: session.id })
    });
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const fileNames = Object.keys(zip.files);

    expect(response.status).toBe(200);
    expect(fileNames).toContain("assets/Example.txt");
    expect(fileNames.some((name) => name.startsWith("assets/embedded/icons/"))).toBe(false);
    expect(await zip.file("assets/embedded/index.json")?.async("string")).toContain('"mode": "reference"');
  });

  it("includes embedded assets when assetMode=download", async () => {
    const session = createSession("generate");
    updateSession(session.id, {
      skillDraft: { markdown: "# Design System Skill", observations: [], qualityNotes: [] },
      sampleHtml: "<!doctype html><html><body>sample</body></html>"
    });
    addAsset(session.id, makeUrlAsset());

    const response = await GET(new Request(`http://localhost/api/download/${session.id}/bundle?assetMode=download`), {
      params: Promise.resolve({ sessionId: session.id })
    });
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const fileNames = Object.keys(zip.files);
    const indexJson = await zip.file("assets/embedded/index.json")?.async("string");

    expect(response.status).toBe(200);
    expect(fileNames.some((name) => name.startsWith("assets/embedded/icons/"))).toBe(true);
    expect(fileNames.some((name) => name.startsWith("assets/embedded/styles/"))).toBe(true);
    expect(fileNames.some((name) => name.startsWith("assets/embedded/manifests/"))).toBe(true);
    expect(indexJson).toContain('"mode": "download"');
    expect(indexJson).toContain('"count": 3');
  });
});

function makeUrlAsset(): DesignAsset {
  return {
    id: crypto.randomUUID(),
    type: "url",
    name: "Example",
    source: "https://example.com",
    mimeType: "text/html",
    content: "URL summary",
    status: "ready",
    embeddedAssets: [
      {
        id: crypto.randomUUID(),
        kind: "icon",
        sourceUrl: "https://example.com/favicon.ico",
        fileName: "favicon.ico",
        mimeType: "image/x-icon",
        fetchedAt: Date.now(),
        status: "fetched",
        bytesBase64: Buffer.from([1, 2, 3]).toString("base64")
      },
      {
        id: crypto.randomUUID(),
        kind: "stylesheet",
        sourceUrl: "https://example.com/main.css",
        fileName: "main.css",
        mimeType: "text/css",
        fetchedAt: Date.now(),
        status: "fetched",
        bytesBase64: Buffer.from("body{}", "utf8").toString("base64")
      },
      {
        id: crypto.randomUUID(),
        kind: "manifest",
        sourceUrl: "https://example.com/site.webmanifest",
        fileName: "site.webmanifest",
        mimeType: "application/manifest+json",
        fetchedAt: Date.now(),
        status: "fetched",
        bytesBase64: Buffer.from('{"name":"Example"}', "utf8").toString("base64")
      }
    ]
  };
}

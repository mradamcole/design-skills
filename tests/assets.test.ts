import { describe, expect, it } from "vitest";
import { classifyAsset } from "@/lib/assets";

describe("asset classification", () => {
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
});

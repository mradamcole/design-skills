import type { AssetType, DesignAsset } from "./types";

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/typescript"
]);

export function classifyAsset(name: string, mimeType: string): AssetType {
  const lowerName = name.toLowerCase();
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) return "pdf";
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "markdown";
  if (
    lowerName.endsWith(".doc") ||
    lowerName.endsWith(".docx") ||
    lowerName.endsWith(".ppt") ||
    lowerName.endsWith(".pptx")
  ) {
    return "document";
  }
  if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || TEXT_MIME_TYPES.has(mimeType)) {
    return "text";
  }
  if (lowerName.endsWith(".txt") || lowerName.endsWith(".css") || lowerName.endsWith(".html")) return "text";
  return "unsupported";
}

export async function fileToAsset(file: File): Promise<DesignAsset> {
  const mimeType = file.type || "application/octet-stream";
  const type = classifyAsset(file.name, mimeType);
  const bytes = Buffer.from(await file.arrayBuffer());
  const base = {
    id: crypto.randomUUID(),
    type,
    name: file.name,
    source: "upload",
    mimeType
  };

  if (type === "image") {
    return {
      ...base,
      dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      status: "ready"
    };
  }

  if (type === "markdown" || type === "text") {
    return {
      ...base,
      content: bytes.toString("utf8").slice(0, 80_000),
      status: "ready"
    };
  }

  if (type === "pdf" || type === "document") {
    return {
      ...base,
      status: "warning",
      warning: "This file type is accepted, but v1 can only use its filename and metadata unless text is pasted separately."
    };
  }

  return {
    ...base,
    status: "warning",
    warning: "Unsupported file type. It will be listed as context but not analyzed deeply."
  };
}

export async function urlToAsset(rawUrl: string): Promise<DesignAsset> {
  const url = new URL(rawUrl);
  const response = await fetch(url, {
    headers: {
      "user-agent": "DesignSkillGenerator/0.1"
    }
  });
  const text = await response.text();
  const title = text.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.replace(/\s+/g, " ").trim();
  const stripped = text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80_000);

  return {
    id: crypto.randomUUID(),
    type: "url",
    name: title || url.hostname,
    source: url.toString(),
    mimeType: response.headers.get("content-type") || "text/html",
    content: stripped,
    status: stripped ? "ready" : "warning",
    warning: stripped ? undefined : "The URL was reachable, but no readable page text was extracted."
  };
}

import type { AssetType, DesignAsset } from "./types";

const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/typescript"
]);
const MAX_TEXT_CHARS = 80_000;
const MAX_CSS_CHARS = 60_000;
const MAX_LINKED_STYLESHEETS = 4;

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
      content: bytes.toString("utf8").slice(0, MAX_TEXT_CHARS),
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
  const metadata = extractPageMetadata(text, url);
  const inlineCss = extractInlineCss(text);
  const linkedCss = await fetchLinkedStylesheets(text, url);
  const cssSignals = extractCssSignals([inlineCss, linkedCss.css].filter(Boolean).join("\n\n"));
  const readableText = extractReadableText(text);
  const content = buildUrlAssetContent({
    source: url.toString(),
    metadata,
    cssSignals,
    readableText,
    stylesheetWarnings: linkedCss.warnings
  }).slice(0, MAX_TEXT_CHARS);

  return {
    id: crypto.randomUUID(),
    type: "url",
    name: metadata.title || url.hostname,
    source: url.toString(),
    mimeType: response.headers.get("content-type") || "text/html",
    content,
    status: content ? "ready" : "warning",
    warning: content ? linkedCss.warnings[0] : "The URL was reachable, but no readable page text was extracted."
  };
}

export type PageMetadata = {
  title?: string;
  description?: string;
  themeColor?: string;
  openGraphTitle?: string;
  openGraphImage?: string;
  manifest?: string;
  icons: Array<{ rel: string; href: string; sizes?: string; type?: string }>;
  stylesheets: string[];
};

export type CssSignals = {
  fontImports: string[];
  fontFamilies: string[];
  fontSizes: string[];
  fontWeights: string[];
  lineHeights: string[];
  letterSpacings: string[];
  colors: string[];
  customProperties: Array<{ name: string; value: string }>;
  radii: string[];
  shadows: string[];
  spacing: string[];
};

export function extractPageMetadata(html: string, baseUrl: URL): PageMetadata {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const metaTags = Array.from(html.matchAll(/<meta\b[^>]*>/gi)).map((match) => parseAttributes(match[0]));
  const linkTags = Array.from(html.matchAll(/<link\b[^>]*>/gi)).map((match) => parseAttributes(match[0]));

  const findMeta = (...keys: string[]) => {
    for (const attrs of metaTags) {
      const name = (attrs.name || attrs.property || "").toLowerCase();
      if (keys.includes(name) && attrs.content) return cleanText(attrs.content);
    }
    return undefined;
  };

  const icons = linkTags
    .filter((attrs) => {
      const rel = (attrs.rel || "").toLowerCase();
      return rel.includes("icon") || rel.includes("apple-touch-icon");
    })
    .map((attrs) => ({
      rel: attrs.rel || "icon",
      href: resolveAssetUrl(attrs.href, baseUrl) || attrs.href || "",
      sizes: attrs.sizes,
      type: attrs.type
    }))
    .filter((icon) => icon.href);

  const manifest = linkTags.find((attrs) => (attrs.rel || "").toLowerCase().includes("manifest"))?.href;
  const stylesheets = linkTags
    .filter((attrs) => (attrs.rel || "").toLowerCase().includes("stylesheet") && attrs.href)
    .map((attrs) => resolveAssetUrl(attrs.href, baseUrl))
    .filter((href): href is string => Boolean(href));

  return {
    title,
    description: findMeta("description"),
    themeColor: findMeta("theme-color"),
    openGraphTitle: findMeta("og:title"),
    openGraphImage: resolveOptionalUrl(findMeta("og:image"), baseUrl),
    manifest: resolveOptionalUrl(manifest, baseUrl),
    icons,
    stylesheets: unique(stylesheets).slice(0, MAX_LINKED_STYLESHEETS)
  };
}

export function extractCssSignals(css: string): CssSignals {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, " ").slice(0, MAX_CSS_CHARS);
  const customProperties = Array.from(cleaned.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g))
    .map((match) => ({ name: match[1], value: cleanCssValue(match[2]) }))
    .filter((item) => item.value)
    .slice(0, 40);

  return {
    fontImports: unique(Array.from(cleaned.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?[^;]*;/gi)).map((match) => match[1])).slice(0, 12),
    fontFamilies: topDeclarationValues(cleaned, "font-family", 12),
    fontSizes: topDeclarationValues(cleaned, "font-size", 16),
    fontWeights: topDeclarationValues(cleaned, "font-weight", 12),
    lineHeights: topDeclarationValues(cleaned, "line-height", 12),
    letterSpacings: topDeclarationValues(cleaned, "letter-spacing", 12),
    colors: topValues(cleaned.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi) || [], 24),
    customProperties,
    radii: topDeclarationValues(cleaned, "border-radius", 16),
    shadows: topDeclarationValues(cleaned, "box-shadow", 12),
    spacing: topDeclarationValues(cleaned, "gap", 10)
      .concat(topDeclarationValues(cleaned, "padding", 10))
      .concat(topDeclarationValues(cleaned, "margin", 10))
      .slice(0, 24)
  };
}

function buildUrlAssetContent({
  source,
  metadata,
  cssSignals,
  readableText,
  stylesheetWarnings
}: {
  source: string;
  metadata: PageMetadata;
  cssSignals: CssSignals;
  readableText: string;
  stylesheetWarnings: string[];
}) {
  const lines = [
    "# URL Design Evidence",
    `Source: ${source}`,
    "",
    "## Page Metadata",
    formatField("Title", metadata.title),
    formatField("Description", metadata.description),
    formatField("Theme color", metadata.themeColor),
    formatField("Open Graph title", metadata.openGraphTitle),
    formatField("Open Graph image", metadata.openGraphImage),
    formatField("Manifest", metadata.manifest),
    "",
    "## Icons And Favicons",
    ...formatList(metadata.icons.map((icon) => `${icon.rel}: ${icon.href}${icon.sizes ? ` (${icon.sizes})` : ""}${icon.type ? ` [${icon.type}]` : ""}`)),
    "",
    "## Stylesheets",
    ...formatList(metadata.stylesheets),
    ...formatList(stylesheetWarnings.map((warning) => `Warning: ${warning}`)),
    "",
    "## Typography Signals",
    ...formatList([
      ...cssSignals.fontImports.map((value) => `import: ${value}`),
      ...cssSignals.fontFamilies.map((value) => `font-family: ${value}`),
      ...cssSignals.fontSizes.map((value) => `font-size: ${value}`),
      ...cssSignals.fontWeights.map((value) => `font-weight: ${value}`),
      ...cssSignals.lineHeights.map((value) => `line-height: ${value}`),
      ...cssSignals.letterSpacings.map((value) => `letter-spacing: ${value}`)
    ]),
    "",
    "## Color And Token Signals",
    ...formatList([
      ...cssSignals.customProperties.map((token) => `${token.name}: ${token.value}`),
      ...cssSignals.colors.map((value) => `color: ${value}`)
    ]),
    "",
    "## Shape, Shadow, And Spacing Signals",
    ...formatList([
      ...cssSignals.radii.map((value) => `border-radius: ${value}`),
      ...cssSignals.shadows.map((value) => `box-shadow: ${value}`),
      ...cssSignals.spacing.map((value) => `spacing: ${value}`)
    ]),
    "",
    "## Readable Page Text",
    readableText || "No readable page text extracted."
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function extractInlineCss(html: string) {
  return Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    .map((match) => match[1])
    .join("\n\n")
    .slice(0, MAX_CSS_CHARS);
}

async function fetchLinkedStylesheets(html: string, baseUrl: URL) {
  const metadata = extractPageMetadata(html, baseUrl);
  const chunks: string[] = [];
  const warnings: string[] = [];
  for (const href of metadata.stylesheets) {
    try {
      const stylesheetUrl = new URL(href);
      if (!["http:", "https:"].includes(stylesheetUrl.protocol)) continue;
      const response = await fetch(stylesheetUrl, {
        headers: { "user-agent": "DesignSkillGenerator/0.1" },
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        warnings.push(`Could not fetch stylesheet ${href} (${response.status}).`);
        continue;
      }
      chunks.push((await response.text()).slice(0, MAX_CSS_CHARS / MAX_LINKED_STYLESHEETS));
    } catch {
      warnings.push(`Could not fetch stylesheet ${href}.`);
    }
  }
  return { css: chunks.join("\n\n"), warnings };
}

function extractReadableText(html: string) {
  return (
    cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
    ) || ""
  ).slice(0, 24_000);
}

function parseAttributes(tag: string) {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const [, key, doubleQuoted, singleQuoted, unquoted] = match;
    attrs[key.toLowerCase()] = decodeHtmlEntity(doubleQuoted || singleQuoted || unquoted || "");
  }
  return attrs;
}

function topDeclarationValues(css: string, property: string, limit: number) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = Array.from(css.matchAll(new RegExp(`${escaped}\\s*:\\s*([^;{}]+)`, "gi"))).map((match) =>
    cleanCssValue(match[1])
  );
  return topValues(values, limit);
}

function topValues(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = cleanCssValue(raw);
    if (!value || value === "inherit" || value === "initial" || value === "unset") continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value)
    .slice(0, limit);
}

function cleanCssValue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanText(value?: string) {
  return value ? decodeHtmlEntity(value).replace(/\s+/g, " ").trim() : undefined;
}

function resolveOptionalUrl(value: string | undefined, baseUrl: URL) {
  return value ? resolveAssetUrl(value, baseUrl) || value : undefined;
}

function resolveAssetUrl(value: string | undefined, baseUrl: URL) {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function formatField(label: string, value?: string) {
  return value ? `${label}: ${value}` : undefined;
}

function formatList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`) : ["- None detected"];
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function decodeHtmlEntity(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

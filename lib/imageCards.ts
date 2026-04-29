import type { DesignAsset, EmbeddedAsset } from "./types";

export type ImageCard = {
  id: string;
  ownerAssetId: string;
  embeddedAssetId?: string;
  kind: "upload" | "icon" | "image";
  fileName: string;
  sourceUrl: string;
  displaySrc: string;
  fileSizeBytes: number;
  humanName?: string;
  pinToBrand?: boolean;
};

function isImageMime(mime: string) {
  return mime.startsWith("image/");
}

export function decodedByteLength(base64: string): number {
  const len = base64.length;
  if (!len) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

export function extractDataUrlBase64(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.*)$/s);
  return match?.[1] ? match[1].replace(/\s/g, "") : null;
}

function fileSizeFromDataUrl(dataUrl: string): number {
  const b64 = extractDataUrlBase64(dataUrl);
  return b64 ? decodedByteLength(b64) : 0;
}

export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (bytes < 1024 * 1024) {
    return kb < 10 ? `${kb.toFixed(1).replace(/\.0$/, "")} KB` : `${Math.round(kb)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function embeddedToCard(owner: DesignAsset, emb: EmbeddedAsset): ImageCard | null {
  if (emb.status !== "fetched" || !emb.bytesBase64) return null;
  if (!isImageMime(emb.mimeType)) return null;
  const kind: "icon" | "image" = emb.kind === "icon" ? "icon" : "image";
  return {
    id: `${owner.id}:${emb.id}`,
    ownerAssetId: owner.id,
    embeddedAssetId: emb.id,
    kind,
    fileName: emb.fileName,
    sourceUrl: emb.sourceUrl,
    displaySrc: `data:${emb.mimeType};base64,${emb.bytesBase64}`,
    fileSizeBytes: decodedByteLength(emb.bytesBase64),
    humanName: emb.humanName,
    pinToBrand: emb.pinToBrand
  };
}

export function proposeHumanName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return base
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function displayHumanName(fileName: string, humanName?: string) {
  if (humanName && humanName.trim()) return humanName.trim();
  return proposeHumanName(fileName);
}

export function collectImageCards(assets: DesignAsset[]): ImageCard[] {
  const seen = new Set<string>();
  const out: ImageCard[] = [];

  function pushCard(card: ImageCard | null) {
    if (!card) return;
    if (seen.has(card.displaySrc)) return;
    seen.add(card.displaySrc);
    out.push(card);
  }

  for (const asset of assets) {
    if (asset.type === "image" && asset.dataUrl) {
      pushCard({
        id: asset.id,
        ownerAssetId: asset.id,
        kind: "upload",
        fileName: asset.name,
        sourceUrl: asset.source,
        displaySrc: asset.dataUrl,
        fileSizeBytes: fileSizeFromDataUrl(asset.dataUrl),
        humanName: asset.humanName,
        pinToBrand: asset.pinToBrand
      });
    }
    if (asset.type === "url" && asset.embeddedAssets?.length) {
      for (const emb of asset.embeddedAssets) {
        pushCard(embeddedToCard(asset, emb));
      }
    }
  }
  return out;
}

export function collectPinnedBrandCards(assets: DesignAsset[]) {
  return collectImageCards(assets).filter((c) => c.pinToBrand === true);
}

export function formatPinnedBrandAssetsBlock(assets: DesignAsset[]): string {
  const pinned = collectPinnedBrandCards(assets);
  if (!pinned.length) return "";
  const lines = pinned.map(
    (c) =>
      `- Image: \`${displayHumanName(c.fileName, c.humanName)}\` ${c.fileName} (source: ${c.sourceUrl})`
  );
  return `## Pinned Brand Assets\n${lines.join("\n")}\n\n`;
}

export function formatRequiredBrandPinsBlock(brandPins: ImageCard[]): string {
  if (!brandPins.length) return "";
  const lines = brandPins.map(
    (c) =>
      `- Image: \`${displayHumanName(c.fileName, c.humanName)}\` ${c.fileName}`
  );
  return `

Required brand pins (non-optional):
These MUST appear in this section, one bullet each, exactly as shown (one bullet per pin, do not shorten):
${lines.join("\n")}`;
}

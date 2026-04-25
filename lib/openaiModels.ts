export interface OpenAIModelOption {
  id: string;
  label: string;
  approxCostPer1M?: number;
}

// Rough blended estimate of input + output cost per 1M tokens.
const approxCostPer1MByModel: Record<string, number> = {
  "gpt-3.5-turbo": 2.50,
  "gpt-4": 45.00,
  "gpt-4.1": 7.00,
  "gpt-4.1-mini": 1.20,
  "gpt-4.1-nano": 0.30,
  "gpt-4o-search-preview": 8.00,
  "gpt-4o-transcribe": 8.00,
  "gpt-4o": 8.00,
  "gpt-4o-mini": 0.75,
  "gpt-4-turbo": 20.00,
  "gpt-5-pro": 30.00,
  "gpt-5-mini": 1.6,
  "gpt-5-nano": 0.50,
  "gpt-5.1": 8.00,
  "gpt-5.2-pro": 20.00,
  "gpt-5.2": 7.00,
  "gpt-5.3": 9.00,
  "gpt-5.4-pro": 24.00,
  "gpt-5.4-mini": 1.8,
  "gpt-5.4-nano": 0.55,
  "gpt-5.4": 9.00,
  "gpt-5.5-pro": 26.00,
  "gpt-5.5": 10.00,
  "gpt-5": 8.00,
  "gpt-image-1": 10.00,
  "gpt-image-2": 14.00
};

export function resolveApproxCostPer1M(modelId: string) {
  if (approxCostPer1MByModel[modelId] !== undefined) return approxCostPer1MByModel[modelId];
  const matchedPrefix = Object.keys(approxCostPer1MByModel)
    .sort((left, right) => right.length - left.length)
    .find((prefix) => modelId.startsWith(prefix));
  if (!matchedPrefix) return undefined;
  return approxCostPer1MByModel[matchedPrefix];
}

export function formatOpenAIModelLabel(modelId: string, approxCostPer1M?: number) {
  if (typeof approxCostPer1M !== "number") return modelId;
  return `${modelId} (~$${approxCostPer1M.toFixed(2)} / 1M tokens)`;
}

export function toOpenAIModelOption(modelId: string): OpenAIModelOption {
  const approxCostPer1M = resolveApproxCostPer1M(modelId);
  return {
    id: modelId,
    label: formatOpenAIModelLabel(modelId, approxCostPer1M),
    approxCostPer1M
  };
}

export function isOpenAIChatModel(modelId: string) {
  const normalized = modelId.toLowerCase();
  if (!normalized.startsWith("gpt-")) return false;
  if (normalized.includes("audio") || normalized.includes("realtime") || normalized.includes("vision")) return false;
  return true;
}

export function selectLatestOpenAIModels(modelIds: string[]) {
  const byFamily = new Map<string, string[]>();
  for (const modelId of modelIds) {
    const family = getModelFamily(modelId);
    byFamily.set(family, [...(byFamily.get(family) || []), modelId]);
  }
  return Array.from(byFamily.values())
    .map((familyModels) => pickLatestModel(familyModels))
    .sort((left, right) => left.localeCompare(right));
}

function getModelFamily(modelId: string) {
  const parts = modelId.split("-");
  if (parts.length < 3) return modelId;
  return parts.slice(0, 3).join("-");
}

function pickLatestModel(modelIds: string[]) {
  return modelIds.sort(compareModelsForRecency)[0];
}

function compareModelsForRecency(left: string, right: string) {
  const leftIsAlias = isAliasModel(left);
  const rightIsAlias = isAliasModel(right);
  if (leftIsAlias !== rightIsAlias) return leftIsAlias ? -1 : 1;

  const leftDate = extractReleaseDate(left);
  const rightDate = extractReleaseDate(right);
  if (leftDate !== rightDate) return rightDate - leftDate;

  return right.localeCompare(left);
}

function isAliasModel(modelId: string) {
  return !/-\d{4,8}$/.test(modelId) && !/-\d+k$/i.test(modelId) && !modelId.includes("-instruct");
}

function extractReleaseDate(modelId: string) {
  const match = modelId.match(/-(\d{4,8})$/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

export type ProviderKind = "openai" | "ollama";

export type SessionMode = "generate" | "verify";

export type AssetType = "image" | "url" | "pdf" | "markdown" | "text" | "document" | "unsupported";

export type AssetStatus = "queued" | "ready" | "warning" | "error";

export type ProgressType =
  | "queued"
  | "ingesting_asset"
  | "extracting_design_signals"
  | "synthesizing_rules"
  | "drafting_skill"
  | "critiquing_skill"
  | "generating_sample"
  | "complete"
  | "warning"
  | "error";

export type ProgressStepId =
  | "extract_observations"
  | "synthesize_rules"
  | "draft_skill"
  | "critique_skill"
  | "revise_skill"
  | "generate_sample"
  | "verify_skill";

export type StreamKind = "content" | "reasoning" | "usage" | "status" | "step_complete" | "summary";

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ProviderConfig {
  kind: ProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface UserSettingsMemory {
  providerKind: ProviderKind;
  model: string;
  apiKey: string;
  baseUrl: string;
  guidance: string;
  existingSkill: string;
  assets: DesignAsset[];
}

export interface DesignAsset {
  id: string;
  type: AssetType;
  name: string;
  source: string;
  mimeType: string;
  content?: string;
  dataUrl?: string;
  status: AssetStatus;
  warning?: string;
}

export interface ProgressEvent {
  id: string;
  type: ProgressType;
  message: string;
  timestamp: number;
  stepId?: ProgressStepId;
  streamKind?: StreamKind;
  textDelta?: string;
  tokenUsage?: TokenUsage;
  providerMeta?: {
    provider?: ProviderKind;
    model?: string;
    reasoningExposed?: boolean;
    usageIsFinal?: boolean;
    streamStatus?: "waiting_for_first_chunk" | "first_chunk_received";
    modelResident?: boolean;
    loadDurationMs?: number;
    latencyMs?: number;
  };
}

export interface SourceObservation {
  assetId: string;
  assetName: string;
  category: string;
  observation: string;
  confidence: "low" | "medium" | "high";
}

export interface SkillDraft {
  markdown: string;
  observations: SourceObservation[];
  qualityNotes: string[];
}

export interface VerificationFinding {
  id: string;
  category: "missing" | "conflict" | "unvalidated" | "match";
  title: string;
  detail: string;
  suggestedPatch?: string;
  accepted?: boolean;
}

export interface VerificationReport {
  findings: VerificationFinding[];
  summary: string;
}

export interface GenerationSession {
  id: string;
  mode: SessionMode;
  assets: DesignAsset[];
  providerConfig?: ProviderConfig;
  guidance?: string;
  progressEvents: ProgressEvent[];
  skillDraft?: SkillDraft;
  sampleHtml?: string;
  verificationReport?: VerificationReport;
  existingSkill?: string;
  status: "idle" | "running" | "complete" | "error";
  error?: string;
  createdAt: number;
  updatedAt: number;
}

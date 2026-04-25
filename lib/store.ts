import type {
  DesignAsset,
  GenerationSession,
  ProgressEvent,
  ProviderConfig,
  SessionMode,
  UserSettingsMemory
} from "./types";

type StoreShape = {
  sessions: Map<string, GenerationSession>;
  settingsMemory: UserSettingsMemory;
};

const globalStore = globalThis as typeof globalThis & { __designSkillStore?: Partial<StoreShape> };

const defaultSettingsMemory: UserSettingsMemory = {
  providerKind: "openai",
  model: "gpt-4o-mini",
  apiKey: "",
  baseUrl: "http://localhost:11434",
  guidance: "",
  existingSkill: "",
  assets: []
};

function ensureSettingsMemory(value: Partial<UserSettingsMemory> | undefined): UserSettingsMemory {
  return {
    ...defaultSettingsMemory,
    ...(value || {}),
    assets: Array.isArray(value?.assets) ? value.assets : []
  };
}

function cloneAsset(asset: DesignAsset): DesignAsset {
  return {
    ...asset,
    id: crypto.randomUUID()
  };
}

export const store: StoreShape = {
  sessions: globalStore.__designSkillStore?.sessions ?? new Map(),
  settingsMemory: ensureSettingsMemory(globalStore.__designSkillStore?.settingsMemory)
};

globalStore.__designSkillStore = store;

export function createSession(mode: SessionMode = "generate") {
  const now = Date.now();
  const session: GenerationSession = {
    id: crypto.randomUUID(),
    mode,
    assets: store.settingsMemory.assets.map(cloneAsset),
    progressEvents: [],
    status: "idle",
    createdAt: now,
    updatedAt: now
  };
  store.sessions.set(session.id, session);
  return session;
}

export function getSession(id: string) {
  return store.sessions.get(id);
}

export function updateSession(id: string, patch: Partial<GenerationSession>) {
  const session = getSession(id);
  if (!session) {
    return undefined;
  }
  Object.assign(session, patch, { updatedAt: Date.now() });
  return session;
}

export function addAsset(sessionId: string, asset: DesignAsset) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  session.assets.push(asset);
  store.settingsMemory.assets.push({ ...asset });
  session.updatedAt = Date.now();
  return asset;
}

export function addProgress(sessionId: string, type: ProgressEvent["type"], message: string) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }
  session.progressEvents.push({
    id: crypto.randomUUID(),
    type,
    message,
    timestamp: Date.now()
  });
  session.updatedAt = Date.now();
}

export function setProvider(sessionId: string, providerConfig: ProviderConfig, guidance?: string) {
  return updateSession(sessionId, { providerConfig, guidance });
}

export function getSettingsMemory() {
  return { ...store.settingsMemory };
}

export function updateSettingsMemory(patch: Partial<UserSettingsMemory>) {
  const nextPatch = patch && typeof patch === "object" ? patch : {};
  Object.assign(store.settingsMemory, nextPatch);
  return getSettingsMemory();
}

export function clearSettingsMemory() {
  store.settingsMemory = { ...defaultSettingsMemory };
  return getSettingsMemory();
}

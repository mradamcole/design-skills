import type { DesignAsset, GenerationSession, ProgressEvent, ProviderConfig, SessionMode } from "./types";

type StoreShape = {
  sessions: Map<string, GenerationSession>;
};

const globalStore = globalThis as typeof globalThis & { __designSkillStore?: StoreShape };

export const store: StoreShape = globalStore.__designSkillStore ?? {
  sessions: new Map()
};

globalStore.__designSkillStore = store;

export function createSession(mode: SessionMode = "generate") {
  const now = Date.now();
  const session: GenerationSession = {
    id: crypto.randomUUID(),
    mode,
    assets: [],
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

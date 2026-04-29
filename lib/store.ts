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
  maxCssColors: 16,
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
    embeddedAssets: asset.embeddedAssets?.map((embedded) => ({ ...embedded })),
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

export function removeAsset(sessionId: string, assetId: string) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const targetAsset = session.assets.find((asset) => asset.id === assetId);
  if (!targetAsset) return false;

  session.assets = session.assets.filter((asset) => asset.id !== assetId);

  const memoryByIdIndex = store.settingsMemory.assets.findIndex((asset) => asset.id === assetId);
  if (memoryByIdIndex >= 0) {
    store.settingsMemory.assets.splice(memoryByIdIndex, 1);
  } else {
    const memoryByFingerprintIndex = store.settingsMemory.assets.findIndex(
      (asset) =>
        asset.name === targetAsset.name &&
        asset.source === targetAsset.source &&
        asset.type === targetAsset.type &&
        asset.mimeType === targetAsset.mimeType
    );
    if (memoryByFingerprintIndex >= 0) {
      store.settingsMemory.assets.splice(memoryByFingerprintIndex, 1);
    }
  }

  session.updatedAt = Date.now();
  return true;
}

export function updateImageMetadata(
  sessionId: string,
  assetId: string,
  embeddedAssetId: string | null | undefined,
  patch: { humanName?: string; pinToBrand?: boolean }
) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  const target = session.assets.find((a) => a.id === assetId);
  if (!target) {
    throw new Error("Asset not found");
  }

  if (embeddedAssetId) {
    const em = target.embeddedAssets?.find((e) => e.id === embeddedAssetId);
    if (!em) {
      throw new Error("Embedded asset not found");
    }
    Object.assign(em, patch);
  } else {
    if (target.type !== "image") {
      throw new Error("Top-level image metadata only applies to uploaded image assets");
    }
    Object.assign(target, patch);
  }
  session.updatedAt = Date.now();

  const mirror = (memAsset: DesignAsset) => {
    if (embeddedAssetId) {
      const e = memAsset.embeddedAssets?.find((x) => x.id === embeddedAssetId);
      if (e) Object.assign(e, patch);
    } else {
      Object.assign(memAsset, patch);
    }
  };

  const memById = store.settingsMemory.assets.find((a) => a.id === assetId);
  if (memById) {
    mirror(memById);
  } else {
    const memByFp = store.settingsMemory.assets.findIndex(
      (asset) =>
        asset.name === target.name &&
        asset.source === target.source &&
        asset.type === target.type &&
        asset.mimeType === target.mimeType
    );
    if (memByFp >= 0) {
      mirror(store.settingsMemory.assets[memByFp]!);
    }
  }

  return session;
}

export function addProgress(
  sessionId: string,
  type: ProgressEvent["type"],
  message: string,
  details?: Omit<Partial<ProgressEvent>, "id" | "type" | "message" | "timestamp">
) {
  const session = getSession(sessionId);
  if (!session) {
    return;
  }
  session.progressEvents.push({
    id: crypto.randomUUID(),
    type,
    message,
    timestamp: Date.now(),
    ...(details || {})
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

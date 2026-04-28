"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { resolveApproxCostPer1M } from "@/lib/openaiModels";
import type {
  DesignAsset,
  GenerationSession,
  ProgressStepId,
  ProgressEvent,
  ProviderConfig,
  ProviderKind,
  TokenUsage,
  UserSettingsMemory,
  VerificationFinding
} from "@/lib/types";

const defaultSkill = `# Design System Skill

## When To Use
Use this skill when generating or reviewing interfaces for this design system.

## Workflow
1. Inspect the user request and available references.
2. Apply the design rules before adding new visual ideas.
3. Verify the final output against the checklist.

## Design Rules
- Add concrete rules here as the generator extracts them.

## Accessibility And Responsiveness
- Maintain readable contrast and resilient layouts across viewport sizes.

## Verification Checklist
- Confirm layout, typography, color, and interaction choices match the skill.

## Examples
- Reference generated sample outputs when judging whether the skill is specific enough.
`;

export default function Home() {
  type RunState = "idle" | "running" | "complete" | "error";
  type BundleAssetMode = "reference" | "download";
  type SaveState = "idle" | "saving" | "saved" | "error";
  type OpenAIModelOption = { id: string; label: string; approxCostPer1M?: number };
  type UiLogEntry =
    | { id: string; kind: "event"; event: ProgressEvent }
    | { id: string; kind: "summary"; summary: { durationMs: number; usage?: TokenUsage; endedAt: number } }
    | { id: string; kind: "boundary"; label: string; startedAt: number };
  const [session, setSession] = useState<GenerationSession | null>(null);
  const [activeTab, setActiveTab] = useState<"edit" | "sample" | "verify">("edit");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [openaiModels, setOpenaiModels] = useState<OpenAIModelOption[]>([]);
  const [openaiModelsLoading, setOpenaiModelsLoading] = useState(false);
  const [openaiModelsError, setOpenaiModelsError] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [guidance, setGuidance] = useState("");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [skillMarkdown, setSkillMarkdown] = useState(defaultSkill);
  const [existingSkill, setExistingSkill] = useState(defaultSkill);
  const [sampleHtml, setSampleHtml] = useState("");
  const [uiLog, setUiLog] = useState<UiLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runMode, setRunMode] = useState<"generate" | "verify" | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [currentStage, setCurrentStage] = useState<ProgressEvent["type"] | null>(null);
  const [lastMessage, setLastMessage] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [streamStepId, setStreamStepId] = useState<ProgressStepId | null>(null);
  const [streamContent, setStreamContent] = useState("");
  const [reasoningContent, setReasoningContent] = useState("");
  const [reasoningAvailable, setReasoningAvailable] = useState(false);
  const [tokenTotals, setTokenTotals] = useState<TokenUsage>({});
  const [stepTokenUsage, setStepTokenUsage] = useState<Record<string, TokenUsage>>({});
  const [lastRunSummary, setLastRunSummary] = useState<{ durationMs: number; usage?: TokenUsage; endedAt: number } | null>(null);
  const [streamPhase, setStreamPhase] = useState("Waiting to start.");
  const [lastLoadDurationMs, setLastLoadDurationMs] = useState<number | null>(null);
  const [memoryReady, setMemoryReady] = useState(false);
  const [sampleSyncStatus, setSampleSyncStatus] = useState<"empty" | "synced" | "stale" | "refreshing" | "error">("empty");
  const [lastSampleMarkdown, setLastSampleMarkdown] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [bundleAssetMode, setBundleAssetMode] = useState<BundleAssetMode>("reference");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const saveDebounceRef = useRef<number | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const savedSkillRef = useRef(defaultSkill);

  useEffect(() => {
    void loadSettingsMemory();
    void createSession("generate");
  }, []);

  useEffect(() => {
    if (providerKind === "openai" && model === "llama3.2-vision") setModel("gpt-4o-mini");
    if (providerKind === "ollama" && model === "gpt-4o-mini") setModel("llama3.2-vision");
  }, [providerKind, model]);

  useEffect(() => {
    if (!memoryReady) return;
    const timeoutId = window.setTimeout(() => {
      void fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerKind,
          model,
          apiKey,
          baseUrl,
          guidance,
          existingSkill
        } satisfies Partial<UserSettingsMemory>)
      });
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [apiKey, baseUrl, existingSkill, guidance, memoryReady, model, providerKind]);

  useEffect(() => {
    if (providerKind !== "openai") {
      setOpenaiModelsLoading(false);
      setOpenaiModelsError("");
      return;
    }

    if (!apiKey.trim()) {
      setOpenaiModels([]);
      setOpenaiModelsLoading(false);
      setOpenaiModelsError("");
      return;
    }

    const controller = new AbortController();
    let isActive = true;

    async function fetchOpenAIModels() {
      setOpenaiModelsLoading(true);
      setOpenaiModelsError("");
      const response = await fetch(`/api/openai/models?apiKey=${encodeURIComponent(apiKey)}`, {
        signal: controller.signal
      }).catch(() => null);
      if (!isActive) return;

      if (!response) {
        setOpenaiModels([]);
        setOpenaiModelsError("Unable to load models from OpenAI.");
        setOpenaiModelsLoading(false);
        return;
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setOpenaiModels([]);
        setOpenaiModelsError(data.error || "Unable to load models from OpenAI.");
        setOpenaiModelsLoading(false);
        return;
      }

      const data = (await response.json()) as { models?: OpenAIModelOption[] };
      const nextModels = data.models || [];
      setOpenaiModels(nextModels);
      setOpenaiModelsError("");
      setModel((current) => {
        if (!nextModels.length) return current;
        return nextModels.some((option) => option.id === current) ? current : nextModels[0].id;
      });
      setOpenaiModelsLoading(false);
    }

    const timeoutId = window.setTimeout(() => {
      void fetchOpenAIModels();
    }, 350);

    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiKey, providerKind]);

  useEffect(() => {
    if (providerKind !== "ollama") {
      setModelsLoading(false);
      setModelsError("");
      return;
    }

    const controller = new AbortController();
    let isActive = true;

    async function fetchOllamaModels() {
      setModelsLoading(true);
      setModelsError("");
      const response = await fetch(`/api/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`, {
        signal: controller.signal
      }).catch(() => null);
      if (!isActive) return;

      if (!response) {
        setOllamaModels([]);
        setModelsError("Unable to load models from Ollama.");
        setModelsLoading(false);
        return;
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setOllamaModels([]);
        setModelsError(data.error || "Unable to load models from Ollama.");
        setModelsLoading(false);
        return;
      }

      const data = (await response.json()) as { models?: string[] };
      const nextModels = data.models || [];
      setOllamaModels(nextModels);
      setModelsError("");
      setModel((current) => {
        if (!nextModels.length) return current;
        return nextModels.includes(current) ? current : nextModels[0];
      });
      setModelsLoading(false);
    }

    const timeoutId = window.setTimeout(() => {
      void fetchOllamaModels();
    }, 350);

    return () => {
      isActive = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [baseUrl, providerKind]);

  useEffect(() => {
    if (runState !== "running") return;
    const intervalId = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runState]);

  useEffect(() => {
    scrollToBottom(logRef.current);
  }, [uiLog]);

  useEffect(() => {
    scrollToBottom(streamRef.current);
  }, [streamContent]);

  useEffect(() => {
    scrollToBottom(reasoningRef.current);
  }, [reasoningContent]);

  const providerConfig = useMemo<ProviderConfig>(
    () => ({
      kind: providerKind,
      model,
      apiKey: providerKind === "openai" ? apiKey : undefined,
      baseUrl: providerKind === "ollama" ? baseUrl : undefined
    }),
    [apiKey, baseUrl, model, providerKind]
  );

  async function createSession(mode: "generate" | "verify") {
    setBusy(true);
    setNotice("");
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode })
    });
    const data = (await response.json()) as { session: GenerationSession };
    setSession(data.session);
    setUiLog([]);
    setLastRunSummary(null);
    if (mode === "generate") {
      setSkillMarkdown(defaultSkill);
      savedSkillRef.current = defaultSkill;
      setSaveState("idle");
      setSampleHtml("");
      setLastSampleMarkdown("");
      setSampleSyncStatus("empty");
    }
    setRunState("idle");
    setRunMode(null);
    setRunStartedAt(null);
    setLastEventAt(null);
    setCurrentStage(null);
    setLastMessage("");
    setStreamStepId(null);
    setStreamContent("");
    setReasoningContent("");
    setReasoningAvailable(false);
    setTokenTotals({});
    setStepTokenUsage({});
    setStreamPhase("Waiting to start.");
    setLastLoadDurationMs(null);
    setBusy(false);
  }

  async function loadSettingsMemory() {
    const response = await fetch("/api/memory").catch(() => null);
    if (!response?.ok) {
      setMemoryReady(true);
      return;
    }
    const data = (await response.json()) as { memory?: UserSettingsMemory };
    const memory = data.memory;
    if (memory) {
      setProviderKind(memory.providerKind || "openai");
      setModel(memory.model || "gpt-4o-mini");
      setApiKey(memory.apiKey || "");
      setBaseUrl(memory.baseUrl || "http://localhost:11434");
      setGuidance(memory.guidance || "");
      setExistingSkill(memory.existingSkill || defaultSkill);
    }
    setMemoryReady(true);
  }

  function resetWorkspace() {
    window.location.reload();
  }

  async function refreshSession(sessionId = session?.id) {
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { session: GenerationSession };
    setSession(data.session);
    if (data.session.skillDraft?.markdown) {
      setSkillMarkdown(data.session.skillDraft.markdown);
      savedSkillRef.current = data.session.skillDraft.markdown;
      setSaveState("saved");
    }
    if (data.session.sampleHtml) {
      setSampleHtml(data.session.sampleHtml);
      const syncedMarkdown = data.session.skillDraft?.markdown || skillMarkdown;
      setLastSampleMarkdown(syncedMarkdown);
      setSampleSyncStatus("synced");
    } else {
      setSampleSyncStatus("empty");
    }
    return data.session;
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!session || files.length === 0) return;
    const form = new FormData();
    form.append("sessionId", session.id);
    Array.from(files).forEach((file) => form.append("files", file));
    setBusy(true);
    const response = await fetch("/api/assets", { method: "POST", body: form });
    setBusy(false);
    if (!response.ok) {
      setNotice(await response.text());
      return;
    }
    await refreshSession();
  }

  async function addUrl(event: FormEvent) {
    event.preventDefault();
    if (!session || !url.trim()) return;
    setBusy(true);
    setNotice("Fetching URL and extracting readable page text.");
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, url: url.trim() })
    });
    setBusy(false);
    if (!response.ok) {
      setNotice(await response.text());
      return;
    }
    setUrl("");
    setNotice("");
    await refreshSession();
  }

  async function removeAssetById(assetId: string) {
    if (!session) return;
    setBusy(true);
    setNotice("");
    const response = await fetch("/api/assets", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, assetId })
    });
    setBusy(false);
    if (!response.ok) {
      setNotice(await response.text());
      return;
    }
    await refreshSession();
  }

  async function startGeneration() {
    if (!session) return;
    setBusy(true);
    setNotice("");
    startRun("generate");
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, providerConfig, guidance })
    });
    setBusy(false);
    if (!response.ok) {
      finishRun("error", "error", "Unable to start generation.");
      setNotice(await response.text());
      return;
    }
    attachProgressStream(session.id);
  }

  async function startVerification() {
    if (!session) return;
    setBusy(true);
    setNotice("");
    startRun("verify");
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, providerConfig, existingSkill, guidance })
    });
    setBusy(false);
    if (!response.ok) {
      finishRun("error", "error", "Unable to start verification.");
      setNotice(await response.text());
      return;
    }
    attachProgressStream(session.id);
  }

  function attachProgressStream(sessionId: string) {
    const events = new EventSource(`/api/progress/${sessionId}`);
    events.addEventListener("progress", (event) => {
      const parsedEvent = JSON.parse((event as MessageEvent).data) as ProgressEvent;
      if (isTimelineEvent(parsedEvent)) {
        setUiLog((current) => [...current, { id: parsedEvent.id, kind: "event", event: parsedEvent }]);
      }
      setCurrentStage(parsedEvent.type);
      if (parsedEvent.streamKind !== "content" && parsedEvent.streamKind !== "reasoning" && parsedEvent.streamKind !== "usage") {
        setLastMessage(parsedEvent.message);
      }
      setLastEventAt(parsedEvent.timestamp);
      if (parsedEvent.stepId) setStreamStepId(parsedEvent.stepId);
      if (parsedEvent.streamKind === "content" && parsedEvent.textDelta) {
        setStreamContent((current) => appendWithLimit(current, parsedEvent.textDelta || ""));
        setStreamPhase("Generating output...");
      } else if (parsedEvent.streamKind === "reasoning" && parsedEvent.textDelta) {
        setReasoningAvailable(true);
        setReasoningContent((current) => appendWithLimit(current, parsedEvent.textDelta || ""));
      } else if (parsedEvent.streamKind === "usage" && parsedEvent.tokenUsage) {
        if (parsedEvent.stepId) {
          setStepTokenUsage((current) => ({ ...current, [parsedEvent.stepId as string]: parsedEvent.tokenUsage as TokenUsage }));
        }
        if (typeof parsedEvent.providerMeta?.loadDurationMs === "number") {
          setLastLoadDurationMs(parsedEvent.providerMeta.loadDurationMs);
        }
      } else if (parsedEvent.streamKind === "summary" && parsedEvent.tokenUsage) {
        setTokenTotals(parsedEvent.tokenUsage);
      } else if (parsedEvent.streamKind === "status" && parsedEvent.providerMeta?.streamStatus) {
        if (parsedEvent.providerMeta.streamStatus === "waiting_for_first_chunk") {
          setStreamPhase(
            parsedEvent.providerMeta.modelResident
              ? "Contacting Ollama..."
              : "Loading model into GPU memory..."
          );
        } else {
          setStreamPhase("Generating output...");
        }
      }
    });
    events.addEventListener("session", (event) => {
      const nextSession = JSON.parse((event as MessageEvent).data) as GenerationSession;
      setSession(nextSession);
      if (nextSession.skillDraft?.markdown) {
        setSkillMarkdown(nextSession.skillDraft.markdown);
        savedSkillRef.current = nextSession.skillDraft.markdown;
        setSaveState("saved");
      }
      if (nextSession.sampleHtml) {
        setSampleHtml(nextSession.sampleHtml);
        const syncedMarkdown = nextSession.skillDraft?.markdown || skillMarkdown;
        setLastSampleMarkdown(syncedMarkdown);
        setSampleSyncStatus("synced");
      } else {
        setSampleSyncStatus("empty");
      }
      setBusy(false);
      if (nextSession.status === "error") {
        finishRun("error", "error", nextSession.error || "The run ended with an error.");
      } else {
        finishRun("complete", "complete", "Run complete. Outputs are ready.");
      }
      events.close();
    });
    events.onerror = () => {
      events.close();
      void (async () => {
        const refreshed = await refreshSession(sessionId);
        if (refreshed?.status === "error") {
          finishRun("error", "error", refreshed.error || "The run ended with an error.");
          return;
        }
        if (refreshed?.status === "complete") {
          finishRun("complete", "complete", "Run complete. Outputs are ready.");
          return;
        }
        finishRun("error", "error", "Lost progress connection before completion.");
      })();
    };
  }

  function startRun(mode: "generate" | "verify") {
    const now = Date.now();
    setUiLog((current) => {
      const next = [...current];
      if (lastRunSummary) {
        next.push({
          id: crypto.randomUUID(),
          kind: "summary",
          summary: lastRunSummary
        });
      }
      next.push({
        id: crypto.randomUUID(),
        kind: "boundary",
        label: `New ${mode === "verify" ? "verification" : "generation"} session`,
        startedAt: now
      });
      return next;
    });
    setLastRunSummary(null);
    setRunState("running");
    setRunMode(mode);
    setRunStartedAt(now);
    setLastEventAt(now);
    setCurrentStage("queued");
    setLastMessage(mode === "generate" ? "Starting skill generation..." : "Starting skill verification...");
    setClockNow(now);
    setStreamStepId(null);
    setStreamContent("");
    setReasoningContent("");
    setReasoningAvailable(false);
    setTokenTotals({});
    setStepTokenUsage({});
    setStreamPhase("Contacting provider...");
    setLastLoadDurationMs(null);
  }

  function finishRun(nextState: Exclude<RunState, "idle" | "running">, stage: ProgressEvent["type"], message: string) {
    const now = Date.now();
    setRunState(nextState);
    setCurrentStage(stage);
    setLastMessage(message);
    setLastEventAt(now);
    setClockNow(now);
    if (runStartedAt) {
      setLastRunSummary({
        durationMs: Math.max(0, now - runStartedAt),
        usage: tokenTotals,
        endedAt: now
      });
    }
  }

  async function persistSkillToSession(markdown: string): Promise<boolean> {
    if (!session) return false;
    setSaveState("saving");
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillDraft: {
          markdown,
          observations: session.skillDraft?.observations || [],
          qualityNotes: session.skillDraft?.qualityNotes || []
        },
        existingSkill: markdown
      })
    });
    if (response.ok) {
      savedSkillRef.current = markdown;
      setSaveState("saved");
      return true;
    }
    setSaveState("error");
    return false;
  }

  async function flushPendingSave() {
    if (saveDebounceRef.current) {
      window.clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
      if (session && skillMarkdown !== savedSkillRef.current) {
        savePromiseRef.current = persistSkillToSession(skillMarkdown);
      }
    }
    if (savePromiseRef.current) {
      await savePromiseRef.current;
      savePromiseRef.current = null;
    }
  }

  async function refreshSamplePreview(openSampleTab = false) {
    if (!session) return;
    setSampleSyncStatus("refreshing");
    setBusy(true);
    const response = await fetch("/api/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, providerConfig, skillMarkdown })
    });
    setBusy(false);
    if (!response.ok) {
      setNotice(await response.text());
      setSampleSyncStatus("error");
      return;
    }
    const data = (await response.json()) as { sampleHtml: string };
    setSampleHtml(data.sampleHtml);
    setLastSampleMarkdown(skillMarkdown);
    setSampleSyncStatus("synced");
    if (openSampleTab) setActiveTab("sample");
  }

  function acceptPatch(finding: VerificationFinding) {
    if (!finding.suggestedPatch) return;
    const next = `${skillMarkdown.trim()}\n\n${finding.suggestedPatch.trim()}\n`;
    setSkillMarkdown(next);
    setExistingSkill(next);
    setActiveTab("edit");
  }

  function downloadCurrentSkill() {
    const blob = new Blob([skillMarkdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "SKILL.md";
    link.click();
    URL.revokeObjectURL(href);
  }

  async function downloadBundle() {
    if (!session) return;
    await flushPendingSave();
    const query = new URLSearchParams({ assetMode: bundleAssetMode });
    window.open(`/api/download/${session.id}/bundle?${query.toString()}`, "_blank");
  }

  const assets = session?.assets || [];
  const findings = session?.verificationReport?.findings || [];
  const runActive = runState === "running";
  const elapsedSeconds = runStartedAt ? Math.max(0, Math.floor((clockNow - runStartedAt) / 1000)) : 0;
  const secondsSinceEvent = lastEventAt ? Math.max(0, Math.floor((clockNow - lastEventAt) / 1000)) : 0;
  const statusClass = runState === "running" ? "running" : runState === "error" ? "error" : runState === "complete" ? "complete" : "idle";
  const currentStepUsage = streamStepId ? stepTokenUsage[streamStepId] : undefined;
  const approxCostPer1M =
    providerKind === "openai"
      ? openaiModels.find((option) => option.id === model)?.approxCostPer1M ?? resolveApproxCostPer1M(model)
      : undefined;

  useEffect(() => {
    if (!sampleHtml) {
      setSampleSyncStatus("empty");
      return;
    }
    if (skillMarkdown !== lastSampleMarkdown && sampleSyncStatus !== "refreshing") {
      setSampleSyncStatus("stale");
    }
  }, [lastSampleMarkdown, sampleHtml, sampleSyncStatus, skillMarkdown]);

  useEffect(() => {
    if (sampleSyncStatus !== "stale" || !session || runActive || busy) return;
    const timeoutId = window.setTimeout(() => {
      void refreshSamplePreview(false);
    }, 900);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [busy, runActive, sampleSyncStatus, session, skillMarkdown]);

  useEffect(() => {
    if (!session) return;
    if (skillMarkdown === savedSkillRef.current) {
      if (saveState === "saving") setSaveState("saved");
      return;
    }
    if (saveDebounceRef.current) window.clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = window.setTimeout(() => {
      saveDebounceRef.current = null;
      savePromiseRef.current = persistSkillToSession(skillMarkdown);
    }, 500);
    return () => {
      if (saveDebounceRef.current) {
        window.clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
    };
  }, [session, skillMarkdown]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <strong>Design SKILL.md Generator</strong>
            <span>Local web app for distilling design references into reusable Codex skills</span>
          </div>
          <div className="row">
            <button onClick={() => void resetWorkspace()} disabled={busy || runActive}>
              Reset
            </button>
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="rail">
          <section className="stack">
            <div className="section-title">Provider</div>
            <div className="field">
              <label htmlFor="provider">LLM provider</label>
              <select id="provider" value={providerKind} onChange={(event) => setProviderKind(event.target.value as ProviderKind)}>
                <option value="openai">OpenAI cloud</option>
                <option value="ollama">Ollama local</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="model">Model</label>
              {providerKind === "openai" ? (
                <select
                  id="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={openaiModelsLoading || !apiKey.trim() || !openaiModels.length}
                >
                  {openaiModels.length ? (
                    openaiModels.map((openaiModel) => (
                      <option key={openaiModel.id} value={openaiModel.id}>
                        {openaiModel.label}
                      </option>
                    ))
                  ) : (
                    <option value={model}>
                      {!apiKey.trim() ? "Enter API key to load models" : openaiModelsLoading ? "Loading models..." : "No models found"}
                    </option>
                  )}
                </select>
              ) : (
                <select
                  id="model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={modelsLoading || !ollamaModels.length}
                >
                  {ollamaModels.length ? (
                    ollamaModels.map((ollamaModel) => (
                      <option key={ollamaModel} value={ollamaModel}>
                        {ollamaModel}
                      </option>
                    ))
                  ) : (
                    <option value={model}>{modelsLoading ? "Loading models..." : "No models found"}</option>
                  )}
                </select>
              )}
              {providerKind === "openai" && openaiModelsError && <div className="disclosure hint">{openaiModelsError}</div>}
              {providerKind === "openai" && !apiKey.trim() && (
                <div className="disclosure hint">Add an OpenAI API key to load available models and estimated token cost.</div>
              )}
              {providerKind === "openai" && !!apiKey.trim() && !openaiModelsLoading && !openaiModelsError && !openaiModels.length && (
                <div className="disclosure hint">No compatible chat models were returned by OpenAI for this key.</div>
              )}
              {providerKind === "ollama" && modelsError && <div className="disclosure hint">{modelsError}</div>}
              {providerKind === "ollama" && !modelsLoading && !modelsError && !ollamaModels.length && (
                <div className="disclosure hint">No models were returned by Ollama. Pull a model and try again.</div>
              )}
            </div>
            {providerKind === "openai" ? (
              <div className="field">
                <label htmlFor="api-key">API key</label>
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-..."
                />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="base-url">Ollama base URL</label>
                <input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              </div>
            )}
            {providerKind === "openai" && (
              <div className="disclosure hint">
                Cloud generation sends uploaded references or extracted text to OpenAI for this session only.
              </div>
            )}
          </section>

          <section className="stack">
            <div className="section-title">Assets</div>
            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void uploadFiles(event.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div>
                <strong>Drop design assets here</strong>
                <p className="hint">Images, PDFs, Markdown, text, and basic document uploads are accepted.</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) void uploadFiles(event.target.files);
                }}
              />
            </div>
            <form className="row" onSubmit={addUrl}>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/style-guide" />
              <button type="submit" disabled={busy || runActive || !url.trim()}>
                Add URL
              </button>
            </form>
            <div className="asset-list">
              {assets.length ? (
                assets.map((asset: DesignAsset) => (
                  <div className="asset" key={asset.id}>
                    <div>
                      <strong>{asset.name}</strong>
                      <div className="meta">{asset.source}</div>
                      {asset.warning && <div className="meta">{asset.warning}</div>}
                    </div>
                    <div className="asset-actions">
                      <span className={`badge${asset.status === "warning" ? " warn" : ""}`}>{asset.type}</span>
                      <button
                        type="button"
                        onClick={() => void removeAssetById(asset.id)}
                        disabled={busy || runActive}
                        aria-label={`Remove ${asset.name}`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">No assets added yet.</div>
              )}
            </div>
            <button className="primary" onClick={startGeneration} disabled={busy || runActive || !session || !assets.length}>
              Generate Skill
            </button>
            <div className="disclosure hint">Step 3: Generate from your current provider settings and uploaded assets.</div>
          </section>

          <section className="stack">
            <div className="field">
              <label htmlFor="guidance">Optional extraction guidance</label>
              <textarea
                id="guidance"
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
                placeholder="Example: Focus on dashboard density, component behavior, and accessibility rules."
              />
            </div>
          </section>

          <section className="stack">
            <div className="section-title">Progress</div>
            <div className={`run-status ${statusClass}`} aria-live="polite">
              <div className="run-status-head">
                <span className={`status-pill ${statusClass}`}>
                  {runState === "running"
                    ? `Running ${runMode === "verify" ? "verification" : "generation"}`
                    : runState === "complete"
                      ? "Run completed"
                      : runState === "error"
                        ? "Run failed"
                        : "Idle"}
                </span>
                {runActive && <span className="status-pulse" aria-hidden />}
              </div>
              <div className="run-stage">{labelForProgressType(currentStage)}{lastMessage ? ` - ${lastMessage}` : ""}</div>
              <div className="run-meta">
                {runStartedAt ? `Elapsed ${formatDuration(elapsedSeconds)}` : "Waiting to start"}
                {lastEventAt ? ` · last update ${secondsSinceEvent}s ago` : ""}
              </div>
            </div>
            <div className="event-list">
              {uiLog.length ? (
                <div className="event-log" role="log" aria-live="polite" ref={logRef}>
                  {uiLog.map((entry) => (
                    entry.kind === "event" ? (
                      <div className="event-log-line" key={entry.id}>
                        <span className="event-log-time">{new Date(entry.event.timestamp).toLocaleTimeString()}</span>
                        <span className="event-log-type">{entry.event.type}</span>
                        <span className="event-log-message">{entry.event.message}</span>
                      </div>
                    ) : entry.kind === "summary" ? (
                      <div className="event-log-summary" key={entry.id}>
                        Previous run · {formatDurationMs(entry.summary.durationMs)} · {formatTokenUsage(entry.summary.usage, approxCostPer1M)}
                      </div>
                    ) : (
                      <div className="event-log-boundary" key={entry.id}>
                        <div className="event-log-boundary-banner">{entry.label}</div>
                        <div className="event-log-boundary-rule">
                          <span>{new Date(entry.startedAt).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              ) : (
                <div className="empty">Progress updates will stream here.</div>
              )}
            </div>
            <div className="stream-panel">
              <div className="section-title">Model stream</div>
              <div className="meta">Current step: {labelForStep(streamStepId)}</div>
              <div className="meta stream-phase">
                {streamPhase}
                {typeof lastLoadDurationMs === "number" ? ` (model load ${formatDurationMs(lastLoadDurationMs)})` : ""}
              </div>
              <div className="stream-console" ref={streamRef}>
                {streamContent || "Output stream will appear here while the model is generating."}
              </div>
              <div className="token-row">
                <span className="token-chip">Step: {formatTokenUsage(currentStepUsage, approxCostPer1M)}</span>
                <span className="token-chip">Total: {formatTokenUsage(tokenTotals, approxCostPer1M)}</span>
              </div>
              <div className="meta">
                {reasoningAvailable
                  ? "Reasoning stream is shown because this provider/model is exposing it."
                  : "Reasoning stream not exposed by provider/model."}
              </div>
              <div className="reasoning-console" ref={reasoningRef}>{reasoningContent || "No reasoning chunks received."}</div>
            </div>
            {notice && <div className="quality-note">{notice}</div>}
          </section>
        </aside>

        <section className="main-panel">
          <nav className="tabs" aria-label="Workspace tabs">
            <button className={`tab${activeTab === "edit" ? " active" : ""}`} onClick={() => setActiveTab("edit")}>
              Edit
            </button>
            <button className={`tab${activeTab === "sample" ? " active" : ""}`} onClick={() => setActiveTab("sample")}>
              Sample
            </button>
            <button className={`tab${activeTab === "verify" ? " active" : ""}`} onClick={() => setActiveTab("verify")}>
              Verify
            </button>
          </nav>

          {activeTab === "edit" && (
            <div className="panel-body stack">
              <div className="row">
                <button onClick={downloadCurrentSkill}>Download SKILL.md</button>
                <div className="row" role="group" aria-label="Download bundle controls">
                  <button onClick={() => void downloadBundle()} disabled={!session}>
                    Download Bundle
                  </button>
                  <select
                    aria-label="Bundle asset mode"
                    value={bundleAssetMode}
                    onChange={(event) => setBundleAssetMode(event.target.value as BundleAssetMode)}
                  >
                    <option value="reference">Reference assets</option>
                    <option value="download">Download embedded assets</option>
                  </select>
                </div>
                <span className="meta" aria-live="polite">
                  {saveState === "saving"
                    ? "Saving..."
                    : saveState === "saved"
                      ? "Saved"
                      : saveState === "error"
                        ? "Save failed"
                        : "Autosave idle"}
                </span>
              </div>
              <div className="split-pane">
                <section>
                  <header>
                    <strong>SKILL.md</strong>
                    <span className="meta">{skillMarkdown.length.toLocaleString()} chars</span>
                  </header>
                  <textarea
                    id="skill-editor"
                    className="editor"
                    value={skillMarkdown}
                    onChange={(event) => setSkillMarkdown(event.target.value)}
                    spellCheck={false}
                  />
                </section>
                <section>
                  <header>
                    <strong>Preview</strong>
                  </header>
                  <article className="preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(skillMarkdown) }} />
                </section>
              </div>
              {!!session?.skillDraft?.qualityNotes.length && (
                <div className="stack">
                  <div className="section-title">Quality notes</div>
                  {session.skillDraft.qualityNotes.map((note) => (
                    <div className="quality-note" key={note}>
                      {note}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "sample" && (
            <div className="panel-body stack">
              <div className="meta">
                {sampleSyncStatus === "refreshing"
                  ? "Refreshing sample preview from current SKILL.md..."
                  : sampleSyncStatus === "stale"
                    ? "Detected SKILL.md changes. Refresh will run automatically."
                    : sampleSyncStatus === "error"
                      ? "Sample refresh failed. Keep editing and it will retry automatically."
                      : sampleSyncStatus === "synced"
                        ? "Sample preview is synced with the latest SKILL.md."
                        : "Generate a skill to create the first sample preview."}
              </div>
              {sampleHtml ? (
                <iframe className="sample-frame" sandbox="allow-same-origin" srcDoc={sampleHtml} title="Generated sample page" />
              ) : (
                <div className="empty">Generate a skill to preview an applied design sample.</div>
              )}
            </div>
          )}

          {activeTab === "verify" && (
            <div className="panel-body stack">
              <div className="verify-card">
                <header>
                  <strong>Verify / Update Mode</strong>
                  <button className="primary" onClick={startVerification} disabled={busy || runActive || !session || !assets.length}>
                    Run Verification
                  </button>
                </header>
                <div className="panel-body stack">
                  <div className="field">
                    <label htmlFor="existing-skill">Existing SKILL.md</label>
                    <textarea
                      id="existing-skill"
                      value={existingSkill}
                      onChange={(event) => setExistingSkill(event.target.value)}
                      placeholder="Paste or load an existing SKILL.md here."
                    />
                  </div>
                  <div className="row">
                    <input
                      type="file"
                      accept=".md,.markdown,text/markdown,text/plain"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (file) setExistingSkill(await file.text());
                      }}
                    />
                  </div>
                  <p className="hint">
                    Use the same asset rail to add new references. Verification compares those references with the skill text above.
                  </p>
                </div>
              </div>

              {session?.verificationReport && <div className="quality-note">{session.verificationReport.summary}</div>}
              <div className="findings">
                {findings.length ? (
                  findings.map((finding) => (
                    <div className="finding" key={finding.id}>
                      <div className="row">
                        <span className={finding.category === "conflict" ? "badge error" : "badge"}>{labelForFinding(finding.category)}</span>
                        <strong>{finding.title}</strong>
                      </div>
                      <p>{finding.detail}</p>
                      {finding.suggestedPatch && (
                        <>
                          <pre>{finding.suggestedPatch}</pre>
                          <button onClick={() => acceptPatch(finding)}>Accept Patch</button>
                        </>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="empty">Verification findings will appear here.</div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function labelForFinding(category: VerificationFinding["category"]) {
  if (category === "missing") return "Missing";
  if (category === "conflict") return "Conflict";
  if (category === "unvalidated") return "Unvalidated";
  return "Match";
}

function labelForProgressType(type: ProgressEvent["type"] | null) {
  if (!type) return "No run activity yet.";
  if (type === "queued") return "Queued";
  if (type === "ingesting_asset") return "Preparing assets";
  if (type === "extracting_design_signals") return "Extracting design signals";
  if (type === "synthesizing_rules") return "Synthesizing design rules";
  if (type === "drafting_skill") return "Drafting SKILL.md";
  if (type === "critiquing_skill") return "Reviewing and tightening the draft";
  if (type === "generating_sample") return "Generating sample UI";
  if (type === "complete") return "Completed";
  if (type === "warning") return "Warning";
  return "Error";
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function appendWithLimit(current: string, nextChunk: string, limit = 12_000) {
  const next = `${current}${nextChunk}`;
  if (next.length <= limit) return next;
  return `...${next.slice(next.length - limit)}`;
}

function labelForStep(stepId: ProgressStepId | null) {
  if (!stepId) return "Waiting for first stream event";
  if (stepId === "extract_observations") return "Extract observations";
  if (stepId === "synthesize_rules") return "Synthesize rules";
  if (stepId === "draft_skill") return "Draft skill";
  if (stepId === "critique_skill") return "Critique skill";
  if (stepId === "revise_skill") return "Revise skill";
  if (stepId === "generate_sample") return "Generate sample";
  return "Verify skill";
}

function formatTokenUsage(usage?: TokenUsage, approxCostPer1M?: number) {
  if (!usage) return "n/a";
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  const estimate = typeof approxCostPer1M === "number" ? (total / 1_000_000) * approxCostPer1M : null;
  const costSegment = estimate !== null ? ` · $ ${estimate.toFixed(4)}` : "";
  return `i ${prompt.toLocaleString()} · o ${completion.toLocaleString()} · t ${total.toLocaleString()}${costSegment}`;
}

function isTimelineEvent(event: ProgressEvent) {
  if (!event.streamKind) return true;
  return event.streamKind === "status" || event.streamKind === "step_complete" || event.streamKind === "summary";
}

function formatDurationMs(totalMs: number) {
  if (totalMs < 1000) return `${totalMs}ms`;
  const seconds = totalMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = Math.round(seconds % 60);
  return `${minutes}m ${remain}s`;
}

function scrollToBottom(element: HTMLDivElement | null) {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}

function renderMarkdown(markdown: string) {
  const escaped = escapeHtml(markdown);
  const lines = escaped.split(/\r?\n/);
  const html: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h1>${line.slice(2)}</h1>`);
    } else if (line.startsWith("## ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h2>${line.slice(3)}</h2>`);
    } else if (line.startsWith("### ")) {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<h3>${line.slice(4)}</h3>`);
    } else if (line.startsWith("- ")) {
      if (!inList) html.push("<ul>");
      inList = true;
      html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`);
    } else if (!line.trim()) {
      if (inList) html.push("</ul>");
      inList = false;
    } else {
      if (inList) html.push("</ul>");
      inList = false;
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("");
}

function inlineMarkdown(value: string) {
  return value
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

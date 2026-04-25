"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesignAsset,
  GenerationSession,
  ProgressEvent,
  ProviderConfig,
  ProviderKind,
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
  const [session, setSession] = useState<GenerationSession | null>(null);
  const [activeTab, setActiveTab] = useState<"edit" | "sample" | "verify">("edit");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [guidance, setGuidance] = useState("");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [skillMarkdown, setSkillMarkdown] = useState(defaultSkill);
  const [existingSkill, setExistingSkill] = useState(defaultSkill);
  const [sampleHtml, setSampleHtml] = useState("");
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runMode, setRunMode] = useState<"generate" | "verify" | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [currentStage, setCurrentStage] = useState<ProgressEvent["type"] | null>(null);
  const [lastMessage, setLastMessage] = useState("");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [memoryReady, setMemoryReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const providerConfig = useMemo<ProviderConfig>(
    () => ({
      kind: providerKind,
      model,
      apiKey: providerKind === "openai" ? apiKey : undefined,
      baseUrl: providerKind === "ollama" ? baseUrl : undefined
    }),
    [apiKey, baseUrl, model, providerKind]
  );

  const headings = useMemo(() => {
    return skillMarkdown
      .split(/\r?\n/)
      .filter((line) => line.startsWith("## "))
      .map((line) => line.replace(/^##\s+/, ""));
  }, [skillMarkdown]);

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
    setProgress([]);
    if (mode === "generate") {
      setSkillMarkdown(defaultSkill);
      setSampleHtml("");
    }
    setRunState("idle");
    setRunMode(null);
    setRunStartedAt(null);
    setLastEventAt(null);
    setCurrentStage(null);
    setLastMessage("");
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

  async function resetWorkspace() {
    setBusy(true);
    setNotice("");
    await fetch("/api/memory", { method: "DELETE" });
    setProviderKind("openai");
    setModel("gpt-4o-mini");
    setApiKey("");
    setBaseUrl("http://localhost:11434");
    setGuidance("");
    setExistingSkill(defaultSkill);
    await createSession("generate");
  }

  async function refreshSession(sessionId = session?.id) {
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}`);
    if (!response.ok) return null;
    const data = (await response.json()) as { session: GenerationSession };
    setSession(data.session);
    if (data.session.skillDraft?.markdown) setSkillMarkdown(data.session.skillDraft.markdown);
    if (data.session.sampleHtml) setSampleHtml(data.session.sampleHtml);
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

  async function startGeneration() {
    if (!session) return;
    setBusy(true);
    setProgress([]);
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
    setProgress([]);
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
      setProgress((current) => [...current, parsedEvent]);
      setCurrentStage(parsedEvent.type);
      setLastMessage(parsedEvent.message);
      setLastEventAt(parsedEvent.timestamp);
    });
    events.addEventListener("session", (event) => {
      const nextSession = JSON.parse((event as MessageEvent).data) as GenerationSession;
      setSession(nextSession);
      if (nextSession.skillDraft?.markdown) setSkillMarkdown(nextSession.skillDraft.markdown);
      if (nextSession.sampleHtml) setSampleHtml(nextSession.sampleHtml);
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
    setRunState("running");
    setRunMode(mode);
    setRunStartedAt(now);
    setLastEventAt(now);
    setCurrentStage("queued");
    setLastMessage(mode === "generate" ? "Starting skill generation..." : "Starting skill verification...");
    setClockNow(now);
  }

  function finishRun(nextState: Exclude<RunState, "idle" | "running">, stage: ProgressEvent["type"], message: string) {
    const now = Date.now();
    setRunState(nextState);
    setCurrentStage(stage);
    setLastMessage(message);
    setLastEventAt(now);
    setClockNow(now);
  }

  async function saveSkillToSession() {
    if (!session) return;
    const response = await fetch(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skillDraft: {
          markdown: skillMarkdown,
          observations: session.skillDraft?.observations || [],
          qualityNotes: session.skillDraft?.qualityNotes || []
        },
        existingSkill: skillMarkdown
      })
    });
    if (response.ok) {
      setNotice("Saved current Markdown to the in-memory session.");
      await refreshSession();
    }
  }

  async function regenerateSample() {
    if (!session) return;
    setBusy(true);
    const response = await fetch("/api/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, providerConfig, skillMarkdown })
    });
    setBusy(false);
    if (!response.ok) {
      setNotice(await response.text());
      return;
    }
    const data = (await response.json()) as { sampleHtml: string };
    setSampleHtml(data.sampleHtml);
    setActiveTab("sample");
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

  const assets = session?.assets || [];
  const findings = session?.verificationReport?.findings || [];
  const runActive = runState === "running";
  const elapsedSeconds = runStartedAt ? Math.max(0, Math.floor((clockNow - runStartedAt) / 1000)) : 0;
  const secondsSinceEvent = lastEventAt ? Math.max(0, Math.floor((clockNow - lastEventAt) / 1000)) : 0;
  const statusClass = runState === "running" ? "running" : runState === "error" ? "error" : runState === "complete" ? "complete" : "idle";

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
            <button className="primary" onClick={startGeneration} disabled={busy || runActive || !session || !assets.length}>
              Generate Skill
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
              {providerKind === "ollama" ? (
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
              ) : (
                <input id="model" value={model} onChange={(event) => setModel(event.target.value)} />
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
                    <span className={`badge${asset.status === "warning" ? " warn" : ""}`}>{asset.type}</span>
                  </div>
                ))
              ) : (
                <div className="empty">No assets added yet.</div>
              )}
            </div>
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
              {progress.length ? (
                progress.map((event) => (
                  <div className="event" key={event.id}>
                    <strong>{event.message}</strong>
                    <div className="event-time">
                      {event.type} · {new Date(event.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">Progress updates will stream here.</div>
              )}
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
                <button onClick={() => void saveSkillToSession()} disabled={!session}>
                  Save
                </button>
                <button onClick={downloadCurrentSkill}>Download SKILL.md</button>
                <button onClick={() => session && window.open(`/api/download/${session.id}/bundle`, "_blank")} disabled={!session}>
                  Download Bundle
                </button>
                <button onClick={regenerateSample} disabled={busy || runActive || !session}>
                  Regenerate Sample
                </button>
              </div>
              <div className="outline">
                {headings.map((heading) => (
                  <button
                    key={heading}
                    onClick={() => {
                      const next = document.getElementById("skill-editor");
                      next?.focus();
                    }}
                  >
                    {heading}
                  </button>
                ))}
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
              <div className="row">
                <button onClick={regenerateSample} disabled={busy || runActive || !session}>
                  Regenerate Sample
                </button>
              </div>
              {sampleHtml ? (
                <iframe className="sample-frame" sandbox="allow-same-origin" srcDoc={sampleHtml} title="Generated sample page" />
              ) : (
                <div className="empty">Generate a skill or regenerate the sample to preview an applied design.</div>
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

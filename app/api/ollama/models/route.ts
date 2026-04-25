import { NextResponse } from "next/server";

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

const defaultBaseUrl = "http://localhost:11434";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedBaseUrl = searchParams.get("baseUrl")?.trim() || defaultBaseUrl;

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(requestedBaseUrl);
  } catch {
    return NextResponse.json({ error: "Ollama base URL must be a valid URL." }, { status: 400 });
  }

  const baseUrl = parsedBaseUrl.toString().replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/tags`).catch(() => null);
  if (!response) {
    return NextResponse.json({ error: "Unable to reach Ollama at the configured base URL." }, { status: 502 });
  }
  if (!response.ok) {
    const details = await response.text();
    return NextResponse.json(
      { error: `Failed to load Ollama models: ${response.status} ${details || response.statusText}` },
      { status: 502 }
    );
  }

  const json = (await response.json().catch(() => ({}))) as OllamaTagsResponse;
  const models = (json.models || [])
    .map((model) => model.name?.trim() || "")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  return NextResponse.json({ models });
}

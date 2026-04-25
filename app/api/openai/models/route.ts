import { NextResponse } from "next/server";
import { isOpenAIChatModel, selectLatestOpenAIModels, toOpenAIModelOption } from "@/lib/openaiModels";

interface OpenAIModelsResponse {
  data?: Array<{ id?: string }>;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const apiKey = searchParams.get("apiKey")?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "OpenAI API key is required to list models." }, { status: 400 });
  }

  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ error: "Unable to reach OpenAI model catalog." }, { status: 502 });
  }
  if (!response.ok) {
    const details = await response.text();
    return NextResponse.json(
      { error: `Failed to load OpenAI models: ${response.status} ${details || response.statusText}` },
      { status: 502 }
    );
  }

  const json = (await response.json().catch(() => ({}))) as OpenAIModelsResponse;
  const models = (json.data || [])
    .map((entry) => entry.id?.trim() || "")
    .filter((id): id is string => Boolean(id))
    .filter((id) => isOpenAIChatModel(id))
    .filter((id, index, all) => all.indexOf(id) === index);
  const latestModels = selectLatestOpenAIModels(models)
    .map((id) => toOpenAIModelOption(id));

  return NextResponse.json({ models: latestModels });
}

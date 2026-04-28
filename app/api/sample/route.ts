import { NextResponse } from "next/server";
import { generateSampleFromSkill } from "@/lib/workflowCore";
import { getSession, updateSession } from "@/lib/store";
import type { ProviderConfig } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    sessionId?: string;
    providerConfig?: ProviderConfig;
    skillMarkdown?: string;
  };
  if (!body.sessionId || !getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!body.providerConfig || !body.skillMarkdown?.trim()) {
    return NextResponse.json({ error: "Provider config and skill markdown are required" }, { status: 400 });
  }
  const sampleHtml = await generateSampleFromSkill(body.providerConfig, body.skillMarkdown);
  updateSession(body.sessionId, { sampleHtml });
  return NextResponse.json({ sampleHtml });
}

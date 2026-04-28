import { NextResponse } from "next/server";
import { runGeneration } from "@/lib/workflowCore";
import { getSession } from "@/lib/store";
import type { ProviderConfig } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    sessionId?: string;
    providerConfig?: ProviderConfig;
    guidance?: string;
  };
  if (!body.sessionId || !getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!body.providerConfig) {
    return NextResponse.json({ error: "Provider config is required" }, { status: 400 });
  }

  void runGeneration(body.sessionId, body.providerConfig, body.guidance);
  return NextResponse.json({ sessionId: body.sessionId });
}

import { NextResponse } from "next/server";
import { getSession } from "@/lib/store";
import { runVerification } from "@/lib/workflowCore";
import type { ProviderConfig } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    sessionId?: string;
    providerConfig?: ProviderConfig;
    existingSkill?: string;
    guidance?: string;
  };
  if (!body.sessionId || !getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!body.providerConfig || !body.existingSkill?.trim()) {
    return NextResponse.json({ error: "Provider config and existing skill are required" }, { status: 400 });
  }
  void runVerification(body.sessionId, body.providerConfig, body.existingSkill, body.guidance);
  return NextResponse.json({ sessionId: body.sessionId });
}

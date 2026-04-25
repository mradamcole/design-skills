import { NextResponse } from "next/server";
import { createSession } from "@/lib/store";
import type { SessionMode } from "@/lib/types";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { mode?: SessionMode };
  const session = createSession(body.mode || "generate");
  return NextResponse.json({ session });
}

import { NextResponse } from "next/server";
import { clearSettingsMemory, getSettingsMemory, updateSettingsMemory } from "@/lib/store";
import type { UserSettingsMemory } from "@/lib/types";

export async function GET() {
  return NextResponse.json({ memory: getSettingsMemory() });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Partial<UserSettingsMemory>;
  const memory = updateSettingsMemory(body);
  return NextResponse.json({ memory });
}

export async function DELETE() {
  const memory = clearSettingsMemory();
  return NextResponse.json({ memory });
}

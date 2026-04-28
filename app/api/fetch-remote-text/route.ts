import { NextResponse } from "next/server";
import { fetchRemoteText } from "@/lib/fetchRemoteText";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { url?: string } | null;
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url.trim()) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }

  try {
    const text = await fetchRemoteText(url);
    return NextResponse.json({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to fetch URL";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

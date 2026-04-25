import { NextResponse } from "next/server";
import { fileToAsset, urlToAsset } from "@/lib/assets";
import { addAsset, getSession } from "@/lib/store";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const sessionId = String(form.get("sessionId") || "");
    const session = getSession(sessionId);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    const assets = [];
    for (const file of files) {
      assets.push(addAsset(sessionId, await fileToAsset(file)));
    }
    return NextResponse.json({ assets });
  }

  const body = (await request.json()) as { sessionId?: string; url?: string };
  if (!body.sessionId || !getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!body.url) {
    return NextResponse.json({ error: "URL is required" }, { status: 400 });
  }
  try {
    const asset = addAsset(body.sessionId, await urlToAsset(body.url));
    return NextResponse.json({ assets: [asset] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to ingest URL" },
      { status: 400 }
    );
  }
}

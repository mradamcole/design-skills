import { NextResponse } from "next/server";
import { fileToAsset, urlToAsset } from "@/lib/assets";
import { addAsset, getSession, removeAsset, updateImageMetadata } from "@/lib/store";

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

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    sessionId?: string;
    assetId?: string;
    embeddedAssetId?: string | null;
    humanName?: string;
    pinToBrand?: boolean;
  } | null;
  if (!body?.sessionId || !getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (!body.assetId) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }
  const patch: { humanName?: string; pinToBrand?: boolean } = {};
  if (typeof body.humanName === "string") patch.humanName = body.humanName;
  if (typeof body.pinToBrand === "boolean") patch.pinToBrand = body.pinToBrand;
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "humanName and/or pinToBrand required" }, { status: 400 });
  }
  try {
    const session = updateImageMetadata(body.sessionId, body.assetId, body.embeddedAssetId ?? null, patch);
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unable to update image metadata" },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as { sessionId?: string; assetId?: string } | null;
  if (!body?.sessionId || !body?.assetId) {
    return NextResponse.json({ error: "sessionId and assetId are required" }, { status: 400 });
  }
  if (!getSession(body.sessionId)) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const removed = removeAsset(body.sessionId, body.assetId);
    if (!removed) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to remove asset" },
      { status: 400 }
    );
  }
}

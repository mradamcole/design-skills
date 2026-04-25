import { getSession } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!getSession(sessionId)) {
    return new Response("Session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let cursor = 0;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = () => {
        if (closed) return;
        const session = getSession(sessionId);
        if (!session) {
          closed = true;
          controller.close();
          return;
        }
        const events = session.progressEvents.slice(cursor);
        cursor = session.progressEvents.length;
        for (const event of events) {
          controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify(event)}\n\n`));
        }
        if (session.status === "complete" || session.status === "error") {
          controller.enqueue(encoder.encode(`event: session\ndata: ${JSON.stringify(session)}\n\n`));
          closed = true;
          clearInterval(interval);
          controller.close();
        }
      };
      const interval = setInterval(send, 500);
      send();
      setTimeout(() => {
        closed = true;
        clearInterval(interval);
      }, 1000 * 60 * 10);
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

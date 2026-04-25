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
      let interval: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the runtime when client disconnects.
        }
      };

      const enqueue = (payload: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          closeStream();
          return false;
        }
      };

      const send = () => {
        if (closed) return;
        const session = getSession(sessionId);
        if (!session) {
          closeStream();
          return;
        }
        const events = session.progressEvents.slice(cursor);
        cursor = session.progressEvents.length;
        for (const event of events) {
          const didEnqueue = enqueue(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
          if (!didEnqueue) return;
        }
        if (session.status === "complete" || session.status === "error") {
          enqueue(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
          closeStream();
        }
      };
      interval = setInterval(send, 500);
      send();
      timeout = setTimeout(() => {
        closeStream();
      }, 1000 * 60 * 10);
    },
    cancel() {
      // Client disconnected; stream cleanup is handled by guarded enqueue/close logic.
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

import { getSession } from "@/lib/store";

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = getSession(sessionId);
  if (!session?.skillDraft?.markdown && !session?.existingSkill) {
    return new Response("No skill available", { status: 404 });
  }
  const markdown = session.skillDraft?.markdown || session.existingSkill || "";
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'attachment; filename="SKILL.md"'
    }
  });
}

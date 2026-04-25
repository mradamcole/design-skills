import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/ollama/models/route";

describe("ollama models route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes model names from ollama tags", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ name: "llama3.2" }, { name: " codellama " }, { name: "" }, {}]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const request = new Request("http://localhost:3000/api/ollama/models?baseUrl=http%3A%2F%2Flocalhost%3A11434");
    const response = await GET(request);
    const body = (await response.json()) as { models: string[] };

    expect(response.status).toBe(200);
    expect(body.models).toEqual(["codellama", "llama3.2"]);
  });

  it("returns 400 for an invalid baseUrl", async () => {
    const request = new Request("http://localhost:3000/api/ollama/models?baseUrl=not+a+url");
    const response = await GET(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("valid URL");
  });

  it("returns 502 when ollama responds with non-ok status", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    const request = new Request("http://localhost:3000/api/ollama/models?baseUrl=http%3A%2F%2Flocalhost%3A11434");
    const response = await GET(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(body.error).toContain("Failed to load Ollama models");
    expect(body.error).toContain("503");
  });
});

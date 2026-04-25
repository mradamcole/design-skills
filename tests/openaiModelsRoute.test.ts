import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/openai/models/route";

describe("openai models route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 400 when api key is missing", async () => {
    const request = new Request("http://localhost:3000/api/openai/models");
    const response = await GET(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("API key");
  });

  it("returns 502 on upstream non-ok response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("invalid auth", { status: 401 }));

    const request = new Request("http://localhost:3000/api/openai/models?apiKey=sk-test");
    const response = await GET(request);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(502);
    expect(body.error).toContain("Failed to load OpenAI models");
    expect(body.error).toContain("401");
  });

  it("returns normalized model options with approximate cost labels", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4o-mini" },
            { id: "gpt-4.1" },
            { id: "whisper-1" },
            { id: "gpt-realtime" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const request = new Request("http://localhost:3000/api/openai/models?apiKey=sk-test");
    const response = await GET(request);
    const body = (await response.json()) as {
      models: Array<{ id: string; label: string; approxCostPer1M?: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.models.map((item) => item.id)).toEqual(["gpt-4.1", "gpt-4o-mini"]);
    expect(body.models[0].label).toContain("~$7.00 / 1M tokens");
    expect(body.models[1].label).toContain("~$0.75 / 1M tokens");
  });

  it("keeps only the latest model per family", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-3.5-turbo" },
            { id: "gpt-3.5-turbo-0125" },
            { id: "gpt-3.5-turbo-1106" },
            { id: "gpt-3.5-turbo-16k" },
            { id: "gpt-3.5-turbo-instruct" },
            { id: "gpt-3.5-turbo-instruct-0914" }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const request = new Request("http://localhost:3000/api/openai/models?apiKey=sk-test");
    const response = await GET(request);
    const body = (await response.json()) as {
      models: Array<{ id: string; label: string; approxCostPer1M?: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.models.map((item) => item.id)).toEqual(["gpt-3.5-turbo"]);
  });
});

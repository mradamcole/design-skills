const MAX_CHARS = 1_000_000;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export async function fetchRemoteText(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("URL is required");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "DesignSkillGenerator/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Remote server returned ${response.status}`);
  }

  const text = await response.text();
  if (text.length > MAX_CHARS) {
    throw new Error(`Response exceeds maximum size (${MAX_CHARS} characters)`);
  }

  return text;
}

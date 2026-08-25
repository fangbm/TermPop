/**
 * Small SSE reader shared by LLM providers. It deliberately only exposes
 * parsed data payloads, so provider-specific chunk parsing stays local.
 */
export async function readSsePayloads(response: Response, onPayload: (payload: unknown) => void): Promise<void> {
  if (!response.body) {
    throw new Error("LLM streaming response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const consumed = consumeSseFrames(buffer, onPayload);
    buffer = consumed.remainder;
    if (done) {
      break;
    }
  }

  buffer += decoder.decode();
  consumeSseFrames(`${buffer}\n\n`, onPayload);
}

export function consumeSseFrames(input: string, onPayload: (payload: unknown) => void): { remainder: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";

  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      onPayload(JSON.parse(data));
    } catch {
      // Providers occasionally send keep-alives or non-JSON diagnostic SSE
      // records. Ignore those rather than dropping an otherwise valid reply.
    }
  }

  return { remainder };
}

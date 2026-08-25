import assert from "node:assert/strict";
import { consumeSseFrames } from "../src/background/streaming.ts";

const payloads: Array<{ choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> }> = [];
const first = consumeSseFrames(
  "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Thinking\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}",
  (payload) => payloads.push(payload as typeof payloads[number])
);

assert.equal(payloads.length, 1);
assert.equal(payloads[0].choices?.[0].delta?.reasoning_content, "Thinking");

consumeSseFrames(
  `${first.remainder}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" world\"}}]}\n\ndata: [DONE]\n\n`,
  (payload) => payloads.push(payload as typeof payloads[number])
);

assert.equal(payloads.length, 3);
assert.equal(payloads[1].choices?.[0].delta?.content, "Hello");
assert.equal(payloads[2].choices?.[0].delta?.content, " world");
console.log("ok - SSE follow-up chunks retain split frames and ignore completion sentinels");

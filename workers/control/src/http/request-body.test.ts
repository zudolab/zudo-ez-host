import { describe, expect, it } from "vitest";

import { readBoundedJsonRequest } from "./request-body.js";

function jsonRequest(body: BodyInit, headers?: HeadersInit): Request {
  return new Request("https://control.test/input", {
    method: "POST",
    headers,
    body,
  });
}

describe("bounded JSON request bodies", () => {
  it("parses a body within the byte ceiling", async () => {
    await expect(readBoundedJsonRequest(jsonRequest('{"ok":true}'), 64)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects a declared length before reading an oversized body", async () => {
    const request = jsonRequest("{}", { "Content-Length": "65" });

    await expect(readBoundedJsonRequest(request, 64)).rejects.toMatchObject({
      reason: "body_too_large",
      status: 413,
    });
  });

  it("stops a body whose actual streamed bytes exceed the ceiling", async () => {
    await expect(
      readBoundedJsonRequest(jsonRequest('{"value":"too large"}'), 8),
    ).rejects.toMatchObject({
      reason: "body_too_large",
      status: 413,
    });
  });

  it("rejects malformed length and JSON inputs", async () => {
    await expect(
      readBoundedJsonRequest(jsonRequest("{}", { "Content-Length": "1.5" }), 64),
    ).rejects.toMatchObject({ reason: "invalid_content_length", status: 400 });
    await expect(readBoundedJsonRequest(jsonRequest("{"), 64)).rejects.toMatchObject({
      reason: "invalid_json",
      status: 400,
    });
  });
});

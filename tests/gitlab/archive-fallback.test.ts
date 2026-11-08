import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { requestArchiveWithNode } from "../../src/gitlab/archive-fallback";

type CapturedOptions = {
  method: string;
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
};

function fakeTransport() {
  const captured: Array<{ url: string; options: CapturedOptions }> = [];
  const request = (
    url: string,
    options: CapturedOptions,
    callback: (response: any) => void,
  ) => {
    captured.push({ url, options });
    const response = new EventEmitter() as any;
    response.statusCode = 200;
    response.headers = {};
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => {
      callback(response);
      response.emit("data", Buffer.from("hello"));
      response.emit("end");
    };
    return outgoing;
  };
  return { captured, request };
}

const request: {
  url: string;
  method: "GET";
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
} = {
  url: "https://gitlab.example.com/api/v4/projects/group%2Fproject/repository/archive.zip?sha=head",
  method: "GET",
  headers: { Accept: "application/zip", "PRIVATE-TOKEN": "glpat-test" },
  rejectUnauthorized: true,
};

describe("requestArchiveWithNode", () => {
  it("keeps certificate verification enabled by default", async () => {
    const transport = fakeTransport();

    const result = await requestArchiveWithNode(
      { ...request, rejectUnauthorized: true },
      { request: transport.request as any },
    );

    expect(transport.captured).toHaveLength(1);
    expect(transport.captured[0].options.rejectUnauthorized).toBe(true);
    expect(result.text).toBe("hello");
  });

  it("forwards the explicit Connect archive TLS opt-in", async () => {
    const transport = fakeTransport();

    await requestArchiveWithNode(
      { ...request, rejectUnauthorized: false },
      { request: transport.request as any },
    );

    expect(transport.captured).toHaveLength(1);
    expect(transport.captured[0].options.rejectUnauthorized).toBe(false);
  });
});
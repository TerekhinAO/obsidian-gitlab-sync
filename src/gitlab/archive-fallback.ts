import type { IncomingHttpHeaders } from "http";

export interface ArchiveFallbackRequest {
  url: string;
  method: "GET";
  headers: Record<string, string>;
}

export interface ArchiveFallbackResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export async function requestArchiveWithNode(
  request: ArchiveFallbackRequest,
): Promise<ArchiveFallbackResponse> {
  const url = new URL(request.url);
  // Electron loads Obsidian plugins as CommonJS; dynamic import() is not resolved there.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const transport = require(url.protocol === "https:" ? "https" : "http") as
    typeof import("https");

  return await new Promise((resolve, reject) => {
    const outgoing = transport.request(url, {
      method: request.method,
      headers: request.headers,
    }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          arrayBuffer: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          text: body.toString("utf8"),
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
  );
}

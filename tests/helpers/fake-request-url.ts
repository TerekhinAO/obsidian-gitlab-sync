export interface FakeRequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface FakeRequestUrlResponse {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
}

export class FakeRequestUrl {
  readonly calls: FakeRequestUrlOptions[] = [];
  private responses: FakeRequestUrlResponse[] = [];

  queue(response: FakeRequestUrlResponse): void {
    this.responses.push(response);
  }

  requestUrl = async (
    options: FakeRequestUrlOptions,
  ): Promise<FakeRequestUrlResponse> => {
    this.calls.push(options);
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`No fake response queued for ${options.url}`);
    }
    return response;
  };
}

export function arrayBufferFromText(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

export interface FakeRequestUrlOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface FakeRequestUrlResponse {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
  text?: string;
}

type FakeRequestUrlItem =
  | FakeRequestUrlResponse
  | { error: Error };

export class FakeRequestUrl {
  readonly calls: FakeRequestUrlOptions[] = [];
  private items: FakeRequestUrlItem[] = [];

  queue(response: FakeRequestUrlResponse): void {
    this.items.push(response);
  }

  queueError(error: Error): void {
    this.items.push({ error });
  }

  requestUrl = async (
    options: FakeRequestUrlOptions,
  ): Promise<FakeRequestUrlResponse> => {
    this.calls.push(options);
    const item = this.items.shift();
    if (!item) {
      throw new Error(`No fake response queued for ${options.url}`);
    }
    if ("error" in item) {
      throw item.error;
    }
    return item;
  };
}

export function arrayBufferFromText(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer;
}

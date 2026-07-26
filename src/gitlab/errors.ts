export class GitLabApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

export class GitLabAuthenticationError extends GitLabApiError {
  constructor(message: string) {
    super(401, message);
    this.name = "GitLabAuthenticationError";
  }
}

export class GitLabForbiddenError extends GitLabApiError {
  constructor(message: string) {
    super(403, message);
    this.name = "GitLabForbiddenError";
  }
}

export class GitLabNotFoundError extends GitLabApiError {
  constructor(message: string) {
    super(404, message);
    this.name = "GitLabNotFoundError";
  }
}

export class GitLabConflictError extends GitLabApiError {
  constructor(message: string) {
    super(409, message);
    this.name = "GitLabConflictError";
  }
}

export class GitLabRateLimitError extends GitLabApiError {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number | null,
  ) {
    super(429, message);
    this.name = "GitLabRateLimitError";
  }
}

export class GitLabPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLabPayloadTooLargeError";
  }
}

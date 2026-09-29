/** Retains HTTP evidence while staying compatible with existing Error callers. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A response arrived but cannot safely be used as application state. */
export class InvalidApiResponseError extends Error {
  constructor(message = "La réponse du serveur ne peut pas être utilisée.") {
    super(message);
    this.name = "InvalidApiResponseError";
  }
}

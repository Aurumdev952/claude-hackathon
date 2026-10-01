/** Error envelope identical to the FastAPI app: {"error": {"code", "message", "details"}}. */
export class ApiError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 422 | 500 | 503,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

// Error classes for the remote adapter layer (docs/remote-interface.md).
// Messages are user-facing and carry both Chinese and English text. They never
// contain credentials: adapters only pass redacted server bodies as `detail`.

/** Base class for every remote failure. */
export class RemoteError extends Error {
  /**
   * @param {string} message user-facing message (中文 + English)
   * @param {{ code?: string, status?: number, detail?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message === undefined ? '远端操作失败 / remote operation failed' : String(message))
    this.name = new.target.name
    /** Stable machine-readable code: 'auth' | 'conflict' | 'path' | 'unavailable' | ... */
    this.code = options.code ?? 'remote_error'
    /** HTTP status when the failure came from a response. */
    this.status = options.status
    /** Short, redacted server detail; safe to log. */
    this.detail = options.detail
    if (options.cause !== undefined) this.cause = options.cause
  }

  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message }
    if (this.status !== undefined) out.status = this.status
    if (this.detail !== undefined) out.detail = this.detail
    return out
  }
}

/** Bad or missing credentials (HTTP 401/403). */
export class RemoteAuthError extends RemoteError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'auth' })
  }
}

/** An etag/sha precondition failed (HTTP 412 / GitHub 409/422). */
export class RemoteConflictError extends RemoteError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'conflict' })
  }
}

/** A remote path was rejected before any request was made. */
export class RemotePathError extends RemoteError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'path' })
  }
}

/** Network, DNS, timeout or server-side (5xx) failure. */
export class RemoteUnavailableError extends RemoteError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'unavailable' })
  }
}

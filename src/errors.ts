/** Base class for every error thrown by Ghuri packages. */
export class GhuriError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Settings or app setup is wrong (Django: ImproperlyConfigured). */
export class ImproperlyConfigured extends GhuriError {}

/** Apps registry used before `apps.populate()` finished (Django: AppRegistryNotReady). */
export class AppRegistryNotReady extends GhuriError {}

export class ObjectDoesNotExist extends GhuriError {}
export class MultipleObjectsReturned extends GhuriError {}

/** HTTP-mapped errors. `status` is used by the default error handler. */
export class HttpError extends GhuriError {
  status = 500
}
export class Http404 extends HttpError {
  override status = 404
  constructor(message = 'Not found.') {
    super(message)
  }
}
export class PermissionDenied extends HttpError {
  override status = 403
  constructor(message = 'Permission denied.') {
    super(message)
  }
}
export class BadRequest extends HttpError {
  override status = 400
  constructor(message = 'Bad request.') {
    super(message)
  }
}
export class SuspiciousOperation extends HttpError {
  override status = 400
  constructor(message = 'Suspicious operation.') {
    super(message)
  }
}

export type ValidationMessages = string[] | Record<string, string[]>

/**
 * Validation failure. Mirrors Django's ValidationError:
 * - `new ValidationError('msg')` → messages ['msg']
 * - `new ValidationError(['a', 'b'])`
 * - `new ValidationError({ title: ['Too long'] })` → messageDict
 */
export class ValidationError extends GhuriError {
  readonly messages: string[]
  readonly messageDict?: Record<string, string[]>
  readonly code?: string

  constructor(message: string | string[] | Record<string, string | string[]>, options?: { code?: string }) {
    const normalized = ValidationError.normalize(message)
    super(Array.isArray(normalized) ? normalized.join(' ') : JSON.stringify(normalized))
    this.code = options?.code
    if (Array.isArray(normalized)) {
      this.messages = normalized
    } else {
      this.messageDict = normalized
      this.messages = Object.values(normalized).flat()
    }
  }

  get hasFieldErrors(): boolean {
    return this.messageDict !== undefined
  }

  /** Merge into a field → messages dict; non-field errors go under `nonFieldKey`. */
  toDict(nonFieldKey = '__all__'): Record<string, string[]> {
    return this.messageDict ?? { [nonFieldKey]: this.messages }
  }

  private static normalize(m: string | string[] | Record<string, string | string[]>): ValidationMessages {
    if (typeof m === 'string') return [m]
    if (Array.isArray(m)) return m
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(m)) out[k] = Array.isArray(v) ? v : [v]
    return out
  }
}

/** A view does not support the request method (405). `allowed` becomes the `Allow` header. */
export class MethodNotAllowed extends HttpError {
  override status = 405
  constructor(
    readonly method: string,
    readonly allowed: string[] = [],
    message = `Method "${method.toUpperCase()}" not allowed.`,
  ) {
    super(message)
  }
}

/** The request's Host header is not in ALLOWED_HOSTS (Django: DisallowedHost). */
export class DisallowedHost extends SuspiciousOperation {
  constructor(message = 'Invalid HTTP_HOST header.') {
    super(message)
  }
}

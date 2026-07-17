export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class AuthenticationError extends DomainError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTHENTICATION_FAILED');
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends DomainError {
  constructor(message = 'Action is not permitted') {
    super(message, 'ACTION_NOT_PERMITTED');
    this.name = 'AuthorizationError';
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message = 'The request is invalid') {
    super(message, 'INVALID_REQUEST');
    this.name = 'InvalidRequestError';
  }
}

export class RateLimitError extends DomainError {
  constructor(message = 'Request rate limit exceeded') {
    super(message, 'RATE_LIMITED');
    this.name = 'RateLimitError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

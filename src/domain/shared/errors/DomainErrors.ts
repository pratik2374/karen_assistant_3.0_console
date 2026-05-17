export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class DomainInvariantError extends DomainError {
  constructor(message: string) {
    super(`DomainInvariantViolation: ${message}`);
  }
}

export class PermissionViolationError extends DomainError {
  constructor(message: string) {
    super(`PermissionViolation: ${message}`);
  }
}

export class TemporalValidityError extends DomainError {
  constructor(message: string) {
    super(`TemporalValidityViolation: ${message}`);
  }
}

export class RetryLimitExceededError extends DomainError {
  constructor(message: string) {
    super(`RetryLimitExceeded: ${message}`);
  }
}

export class DndViolationError extends DomainError {
  constructor(message: string) {
    super(`DndViolation: ${message}`);
  }
}

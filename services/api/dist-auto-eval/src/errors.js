export class AppError extends Error {
    statusCode;
    code;
    constructor(message, opts = {}) {
        super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
        this.name = 'AppError';
        this.statusCode = opts.statusCode ?? 500;
        this.code = opts.code ?? 'INTERNAL_ERROR';
    }
}
export class ValidationError extends AppError {
    constructor(message, cause) {
        super(message, { statusCode: 400, code: 'VALIDATION_ERROR', cause });
        this.name = 'ValidationError';
    }
}
export class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
        this.name = 'UnauthorizedError';
    }
}
export class UpstreamError extends AppError {
    constructor(message, cause) {
        super(message, { statusCode: 502, code: 'UPSTREAM_ERROR', cause });
        this.name = 'UpstreamError';
    }
}

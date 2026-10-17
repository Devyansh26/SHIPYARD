export class AppError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Session required', 401),
  notFound: (msg = 'Not found') => new AppError('NOT_FOUND', msg, 404),
  conflict: (code, msg) => new AppError(code, msg, 409),
  badRequest: (code, msg) => new AppError(code, msg, 400),
};

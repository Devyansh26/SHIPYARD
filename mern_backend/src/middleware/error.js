// Central error handler. All errors become { error: { code, message } }.
// Never log tokens, secrets, or cookies.
//
// An error we authored carries an explicit numeric `status` (see utils/errors.js
// and the `e.status = ...` throws in the modules). That is the discriminator for
// whether a message is safe to return: authored messages are written for the
// client — including the 502s that deliberately forward a provider's own
// explanation — while anything else (a pg error, a TypeError) is unexpected and
// must not leak its text or SQLSTATE to the browser.
export function errorHandler(err, req, res, _next) {
  const authored = typeof err?.status === 'number';
  const status = authored ? err.status : 500;
  const code = authored ? (err.code ?? 'ERROR') : 'INTERNAL_ERROR';
  const message = authored ? (err.message || 'Request failed') : 'Internal server error';

  if (!authored) {
    // Full detail server-side only: unexpected errors are where the stack matters.
    console.error('[INTERNAL_ERROR]', req.method, req.path, err?.code ?? '', err?.message ?? err);
    if (err?.stack) console.error(err.stack);
  } else if (status >= 500) {
    console.error(`[${code}]`, req.method, req.path, err.message);
  }

  res.status(status).json({ error: { code, message } });
}

export function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` } });
}

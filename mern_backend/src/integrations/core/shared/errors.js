/**
 * Standardized error factory for cloud provider integrations.
 * Ensures every provider error surfaces with an HTTP status and machine-readable code.
 */
export function providerFail(status, code, message, detail) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

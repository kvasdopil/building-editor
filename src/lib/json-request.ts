/**
 * Read a JSON request body, or null when there isn't one. Route handlers all need
 * the same guard: a malformed body is a client error, not a crash.
 */
export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export class ContractorApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

/** Session-scoped local API calls. A failed acknowledgement never becomes success. */
export async function contractorRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    cache: "no-store",
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
    ...(options.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new ContractorApiError(
      response.status,
      value?.code ?? "request_failed",
    );
  if (value === null)
    throw new ContractorApiError(0, "acknowledgement_unavailable");
  return value as T;
}

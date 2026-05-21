import { logger } from "@trigger.dev/sdk";

/** Result shape returned by every n8n webhook call. */
export interface N8nWebhookResult {
  success: boolean;
  data: unknown;
  error: string | null;
}

/**
 * POSTs a JSON payload to an n8n webhook URL.
 *
 * Retries up to 3 times with exponential backoff on network errors or
 * non-2xx responses. Each attempt is logged to the Trigger.dev run log.
 *
 * @param url  - Full n8n webhook URL (e.g. value of N8N_WEBHOOK_CONTRACT)
 * @param body - JSON-serializable payload to POST
 * @returns    Result with success flag, response data, and error message
 */
export async function callN8nWebhook(
  url: string,
  body: Record<string, unknown>
): Promise<N8nWebhookResult> {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 500;

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    logger.info(`n8n webhook attempt ${attempt}/${MAX_ATTEMPTS}`, {
      url,
      attempt,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        let data: unknown = null;
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        logger.info(`n8n webhook succeeded on attempt ${attempt}`, {
          url,
          status: response.status,
        });

        return { success: true, data, error: null };
      }

      const errorText = await response.text();
      lastError = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
      logger.warn(`n8n webhook non-2xx on attempt ${attempt}`, {
        url,
        status: response.status,
        error: lastError,
      });
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : "Unknown network error";
      logger.warn(`n8n webhook threw on attempt ${attempt}`, {
        url,
        error: lastError,
      });
    }

    if (attempt < MAX_ATTEMPTS) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  logger.error(`n8n webhook failed after ${MAX_ATTEMPTS} attempts`, {
    url,
    error: lastError,
  });

  return { success: false, data: null, error: lastError };
}

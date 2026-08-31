import type { WebhookPayload } from "@mcp-contracts/core";

/** Result of a webhook send attempt. */
export interface WebhookResult {
	success: boolean;
	statusCode?: number;
	error?: string;
}

/**
 * Sends a webhook payload to the given URL via HTTP POST.
 *
 * Never throws — returns a result object indicating success or failure,
 * so a broken receiver cannot fail the contract check itself.
 *
 * @param url - The webhook endpoint URL.
 * @param payload - The webhook payload to send.
 * @returns A result indicating success or failure.
 */
export async function sendWebhook(url: string, payload: WebhookPayload): Promise<WebhookResult> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(10_000),
		});

		if (response.ok) {
			return { success: true, statusCode: response.status };
		}

		return {
			success: false,
			statusCode: response.status,
			error: `HTTP ${response.status} ${response.statusText}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: message };
	}
}

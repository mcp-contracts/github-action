import { readFileSync } from "node:fs";
import type { MCPContractSnapshot } from "@mcp-contracts/core";
import { parseSignatureFile, verifyContentHash, verifySignature } from "@mcp-contracts/core";

/**
 * Reads a baseline snapshot file and verifies its content hash.
 *
 * The hash is recomputed and compared to the stored value, so a corrupted
 * or hand-edited baseline is rejected even without signature verification.
 *
 * @param filePath - Path to the .mcpc.json file.
 * @returns The parsed and integrity-checked snapshot.
 */
export function readBaseline(filePath: string): MCPContractSnapshot {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read baseline "${filePath}": ${message}`);
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON in baseline "${filePath}"`);
	}

	const record = data as Record<string, unknown>;
	if (typeof record["snapshotVersion"] !== "string") {
		throw new Error(`Invalid baseline "${filePath}": missing "snapshotVersion"`);
	}
	if (typeof record["contentHash"] !== "string" || !record["contentHash"].startsWith("sha256:")) {
		throw new Error(`Invalid baseline "${filePath}": missing or invalid "contentHash"`);
	}

	const snapshot = data as unknown as MCPContractSnapshot;

	const hashCheck = verifyContentHash(snapshot);
	if (!hashCheck.valid) {
		throw new Error(
			`Baseline "${filePath}" failed content hash verification: ` +
				`stored "${hashCheck.expected}" but recomputed "${hashCheck.actual}". ` +
				"The file was modified after capture — regenerate it with mcpdiff.",
		);
	}

	return snapshot;
}

/**
 * Verifies the detached signature of a baseline snapshot.
 *
 * The public key may be given as PEM content or a file path. The signature
 * file is derived from the baseline path (`.mcpc.json` → `.mcpc.sig`).
 *
 * @param baseline - The parsed baseline snapshot.
 * @param baselinePath - Path the baseline was read from.
 * @param keyInput - Public key PEM content or file path.
 */
export function verifyBaselineSignature(
	baseline: MCPContractSnapshot,
	baselinePath: string,
	keyInput: string,
): void {
	const keyPem = keyInput.startsWith("-----BEGIN") ? keyInput : readFileSync(keyInput, "utf-8");

	const sigPath = baselinePath.endsWith(".mcpc.json")
		? `${baselinePath.slice(0, -".mcpc.json".length)}.mcpc.sig`
		: `${baselinePath}.sig`;

	const sigJson = readFileSync(sigPath, "utf-8");
	const sig = parseSignatureFile(sigJson);
	const result = verifySignature(baseline, sig, keyPem);

	if (!result.valid) {
		throw new Error(`Baseline signature verification failed: ${result.error}`);
	}
}

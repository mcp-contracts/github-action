import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
	CollisionReport,
	CompositionDiffReport,
	ServerSnapshotEntry,
	Severity,
} from "@mcp-contracts/core";
import { detectToolCollisions, diffComposition, SEVERITY_ORDER } from "@mcp-contracts/core";
import { readBaseline } from "./baseline.js";
import { captureSnapshot } from "./mcp-client.js";
import { listConfigServers } from "./mcp-config.js";

/** A server that could not be captured. */
export interface CaptureFailure {
	serverName: string;
	error: string;
}

/** Result of capturing and diffing a full composition. */
export interface CompositionResult {
	/** The unfiltered composition diff report. */
	report: CompositionDiffReport;
	/** Tool name collision report, when conflict checking was requested. */
	collisions?: CollisionReport;
	/** Servers that could not be captured. */
	captureFailures: CaptureFailure[];
}

/**
 * Converts a config server name to its snapshot file name.
 *
 * @param serverName - The server name from the config.
 * @returns The name with unsafe path characters replaced by "-", plus the .mcpc.json extension.
 */
export function snapshotFileName(serverName: string): string {
	return `${serverName.replace(/[^a-zA-Z0-9._-]/g, "-")}.mcpc.json`;
}

/**
 * Reads all baseline snapshots from a contracts directory.
 *
 * Each `<name>.mcpc.json` file becomes an entry named by its file stem,
 * which is how `mcpdiff snapshot --all` writes them. Every baseline's
 * content hash is verified on load.
 *
 * @param baselineDir - Directory containing .mcpc.json files.
 * @returns The baseline entries.
 */
export function readBaselineDir(baselineDir: string): ServerSnapshotEntry[] {
	let files: string[];
	try {
		files = readdirSync(baselineDir);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read baseline directory "${baselineDir}": ${message}`);
	}

	return files
		.filter((f) => f.endsWith(".mcpc.json"))
		.map((f) => ({
			serverName: f.slice(0, -".mcpc.json".length),
			snapshot: readBaseline(join(baselineDir, f)),
		}));
}

/**
 * Renames baseline entries to their matching config server names.
 *
 * Baselines are named by file stem, which is the sanitized config key
 * (see snapshotFileName). This maps stems back to the actual config keys
 * so diffComposition can match servers to baselines.
 *
 * @param baselines - Baseline entries named by file stem.
 * @param serverNames - The config's server names.
 * @returns Baseline entries renamed to config keys where a match exists.
 */
export function matchBaselineNames(
	baselines: ServerSnapshotEntry[],
	serverNames: string[],
): ServerSnapshotEntry[] {
	const stemToConfigName = new Map(
		serverNames.map((name) => [snapshotFileName(name), name] as const),
	);
	return baselines.map((b) => {
		const configName = stemToConfigName.get(`${b.serverName}.mcpc.json`);
		return configName ? { ...b, serverName: configName } : b;
	});
}

/**
 * Decides whether a composition diff should fail the action.
 *
 * A composition fails when any per-server change meets the fail-on
 * threshold, when a baseline's server is missing from the composition
 * (treated as breaking), or — at warning level or below — when a server
 * has no baseline.
 *
 * @param report - The unfiltered composition diff report.
 * @param failOn - The severity threshold.
 * @returns True when the composition should fail.
 */
export function compositionHasFailure(report: CompositionDiffReport, failOn: Severity): boolean {
	const threshold = SEVERITY_ORDER[failOn];

	if (report.summary.missingServers > 0) {
		return true;
	}
	if (report.summary.missingBaselines > 0 && threshold <= SEVERITY_ORDER.warning) {
		return true;
	}
	return report.servers.some((s) =>
		(s.report?.changes ?? []).some((c) => SEVERITY_ORDER[c.severity] >= threshold),
	);
}

/**
 * Captures every server in an mcp.json composition and diffs it against
 * the baseline directory.
 *
 * @param configPath - Path to the mcp.json config file.
 * @param baselineDir - Directory containing baseline .mcpc.json files.
 * @param checkConflicts - Also detect tool name collisions across servers.
 * @returns The composition diff, optional collision report, and capture failures.
 */
export async function runComposition(
	configPath: string,
	baselineDir: string,
	checkConflicts: boolean,
): Promise<CompositionResult> {
	const servers = listConfigServers(configPath);
	const baselines = matchBaselineNames(
		readBaselineDir(baselineDir),
		servers.map((s) => s.name),
	);

	const entries: ServerSnapshotEntry[] = [];
	const captureFailures: CaptureFailure[] = [];
	for (const server of servers) {
		try {
			entries.push({
				serverName: server.name,
				snapshot: await captureSnapshot(server.transport),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			captureFailures.push({ serverName: server.name, error: message });
		}
	}

	const report = diffComposition(baselines, entries);
	const collisions = checkConflicts ? detectToolCollisions(entries) : undefined;

	return { report, collisions, captureFailures };
}

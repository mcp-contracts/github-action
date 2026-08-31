import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ProjectConfig } from "@mcp-contracts/core";
import {
	isProjectServerCommand,
	isProjectServerUrl,
	PROJECT_CONFIG_FILENAME,
	parseProjectConfig,
} from "@mcp-contracts/core";
import type { ResolvedTransport } from "./mcp-client.js";
import { readMcpConfig } from "./mcp-config.js";

/** Default baseline path used when neither inputs nor config specify one. */
export const DEFAULT_BASELINE_PATH = "contracts/baseline.mcpc.json";

/** A project config together with where it was found. */
export interface LoadedProjectConfig {
	/** Absolute path to the config file. */
	path: string;
	/** Directory containing the config file; base for its relative paths. */
	dir: string;
	/** The validated config contents. */
	config: ProjectConfig;
}

/**
 * Loads and validates the mcpcontracts.json project config.
 *
 * With an explicit path (the `project` input), the file must exist.
 * Otherwise the file is looked up in the workspace root, and its absence
 * is not an error. A file that exists but fails to parse or validate
 * always throws, so typos are surfaced.
 *
 * @param explicitPath - Path from the `project` input, if given.
 * @param workspaceDir - The workspace directory to look in.
 * @returns The loaded config, or null when no config file exists.
 */
export function loadProjectConfig(
	explicitPath: string | undefined,
	workspaceDir: string,
): LoadedProjectConfig | null {
	let path: string;
	if (explicitPath) {
		path = resolve(workspaceDir, explicitPath);
		if (!existsSync(path)) {
			throw new Error(`Project config file "${path}" not found`);
		}
	} else {
		const candidate = resolve(workspaceDir, PROJECT_CONFIG_FILENAME);
		if (!existsSync(candidate)) {
			return null;
		}
		path = candidate;
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read project config "${path}": ${message}`);
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON in project config "${path}"`);
	}

	let config: ProjectConfig;
	try {
		config = parseProjectConfig(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${message} (in "${path}")`);
	}

	return { path, dir: dirname(path), config };
}

/**
 * Resolves a possibly-relative path against the config file's directory.
 *
 * @param project - The loaded project config.
 * @param path - Path from the config file.
 * @returns An absolute path.
 */
export function resolveProjectPath(project: LoadedProjectConfig, path: string): string {
	return isAbsolute(path) ? path : resolve(project.dir, path);
}

/**
 * Resolves the project config's server block into a transport.
 *
 * Stdio servers spawn with the config file's directory as their working
 * directory, so relative command args (e.g. "node server.js") work no
 * matter where the action runs from.
 *
 * @param project - The loaded project config.
 * @returns The resolved transport configuration.
 */
export function resolveProjectTransport(project: LoadedProjectConfig): ResolvedTransport {
	const server = project.config.server;
	if (!server) {
		throw new Error(`Project config "${project.path}" has no "server" block`);
	}
	if (isProjectServerCommand(server)) {
		return {
			transport: "stdio",
			command: server.command,
			args: server.args,
			env: server.env,
			cwd: project.dir,
		};
	}
	if (isProjectServerUrl(server)) {
		return {
			transport: server.sse ? "sse" : "streamable-http",
			url: server.url,
			headers: server.headers,
		};
	}
	const mcpConfigPath = resolveProjectPath(project, server.config);
	return readMcpConfig(mcpConfigPath, server.name);
}

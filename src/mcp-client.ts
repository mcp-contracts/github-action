import type {
	MCPContractSnapshot,
	RawPrompt,
	RawResource,
	RawResourceTemplate,
	RawTool,
	SnapshotCapture,
	SnapshotServer,
} from "@mcp-contracts/core";
import { createSnapshot } from "@mcp-contracts/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { ACTION_TOOL, ACTION_VERSION } from "./version.js";

/** Resolved transport configuration for connecting to an MCP server. */
export interface ResolvedTransport {
	transport: "stdio" | "streamable-http" | "sse";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Working directory for the spawned stdio server (defaults to the CWD). */
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

/** Data captured from a live MCP server. */
interface CapturedData {
	tools: RawTool[];
	resources: RawResource[];
	resourceTemplates: RawResourceTemplate[];
	prompts: RawPrompt[];
}

/**
 * Creates a Client and Transport, then connects to the MCP server.
 *
 * @param config - The resolved transport configuration.
 * @returns The connected client and transport.
 */
async function connectToServer(
	config: ResolvedTransport,
): Promise<{ client: Client; transport: Transport }> {
	const client = new Client({ name: "mcp-contracts-action", version: ACTION_VERSION });

	let transport: Transport;
	if (config.transport === "stdio") {
		if (!config.command) {
			throw new Error("stdio transport requires a command");
		}
		transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: { ...getDefaultEnvironment(), ...config.env },
			cwd: config.cwd,
		});
	} else if (config.transport === "sse") {
		if (!config.url) {
			throw new Error("sse transport requires a URL");
		}
		const sseOpts = config.headers ? { requestInit: { headers: config.headers } } : {};
		transport = new SSEClientTransport(new URL(config.url), sseOpts);
	} else {
		if (!config.url) {
			throw new Error("streamable-http transport requires a URL");
		}
		const httpOpts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
		transport = httpOpts
			? new StreamableHTTPClientTransport(new URL(config.url), httpOpts)
			: new StreamableHTTPClientTransport(new URL(config.url));
	}

	await client.connect(transport, { signal: AbortSignal.timeout(30_000) });

	return { client, transport };
}

/**
 * Captures tools, resources, and prompts from a connected MCP server.
 *
 * @param client - The connected MCP client.
 * @returns Captured server data.
 */
async function captureData(client: Client): Promise<CapturedData> {
	const capabilities = client.getServerCapabilities() ?? {};

	const tools: RawTool[] = [];
	const resources: RawResource[] = [];
	const resourceTemplates: RawResourceTemplate[] = [];
	const prompts: RawPrompt[] = [];

	if (capabilities.tools) {
		let cursor: string | undefined;
		do {
			const result = await client.listTools(cursor ? { cursor } : undefined);
			for (const tool of result.tools) {
				tools.push({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema as RawTool["inputSchema"],
					...(tool.outputSchema && {
						outputSchema: tool.outputSchema as Record<string, unknown>,
					}),
					...(tool.annotations && {
						annotations: tool.annotations as Record<string, unknown>,
					}),
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
	}

	if (capabilities.resources) {
		let cursor: string | undefined;
		do {
			const result = await client.listResources(cursor ? { cursor } : undefined);
			for (const resource of result.resources) {
				resources.push({
					uri: resource.uri,
					name: resource.name,
					description: resource.description,
					mimeType: resource.mimeType,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);

		cursor = undefined;
		do {
			const result = await client.listResourceTemplates(cursor ? { cursor } : undefined);
			for (const template of result.resourceTemplates) {
				resourceTemplates.push({
					uriTemplate: template.uriTemplate,
					name: template.name,
					description: template.description,
					mimeType: template.mimeType,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
	}

	if (capabilities.prompts) {
		let cursor: string | undefined;
		do {
			const result = await client.listPrompts(cursor ? { cursor } : undefined);
			for (const prompt of result.prompts) {
				prompts.push({
					name: prompt.name,
					description: prompt.description,
					arguments: prompt.arguments,
				});
			}
			cursor = result.nextCursor;
		} while (cursor);
	}

	return { tools, resources, resourceTemplates, prompts };
}

/**
 * Connects to an MCP server, captures its full contract, and disconnects.
 *
 * @param config - The resolved transport configuration.
 * @returns The captured snapshot.
 */
export async function captureSnapshot(config: ResolvedTransport): Promise<MCPContractSnapshot> {
	const { client, transport } = await connectToServer(config);
	try {
		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities() ?? {};
		const data = await captureData(client);

		const server: SnapshotServer = {
			name: serverVersion?.name ?? "unknown",
			version: serverVersion?.version ?? "unknown",
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: serverCapabilities as Record<string, unknown>,
		};

		const source =
			config.transport === "stdio"
				? [config.command, ...(config.args ?? [])].join(" ")
				: config.url;

		const capture: SnapshotCapture = {
			transport: config.transport,
			source,
			tool: ACTION_TOOL,
		};

		return createSnapshot({
			server,
			tools: data.tools,
			resources: data.resources,
			resourceTemplates: data.resourceTemplates,
			prompts: data.prompts,
			capture,
		});
	} finally {
		try {
			await transport.close();
		} catch {
			// ignore close errors
		}
	}
}

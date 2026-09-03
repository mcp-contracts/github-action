import { resolve } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Severity } from "@mcp-contracts/core";
import {
	createWebhookPayload,
	diffSnapshots,
	formatCollisionsMarkdown,
	formatCompositionMarkdown,
	formatMarkdown,
	resolveCommandString,
	SEVERITY_ORDER,
} from "@mcp-contracts/core";
import { readBaseline, verifyBaselineSignature } from "./baseline.js";
import { postOrUpdatePRComment } from "./comment.js";
import { compositionHasFailure, runComposition } from "./composition.js";
import type { ResolvedTransport } from "./mcp-client.js";
import { captureSnapshot } from "./mcp-client.js";
import {
	DEFAULT_BASELINE_PATH,
	loadProjectConfig,
	resolveProjectPath,
	resolveProjectTransport,
} from "./project-config.js";
import { sendWebhook } from "./webhook.js";

const VALID_SEVERITIES = new Set<string>(["safe", "warning", "breaking"]);

/** Parsed and validated action inputs. */
interface ActionInputs {
	baseline: string | undefined;
	command: string | undefined;
	args: string[] | undefined;
	url: string | undefined;
	sse: boolean;
	headers: Record<string, string> | undefined;
	config: string | undefined;
	project: string | undefined;
	failOn: string | undefined;
	checkConflicts: boolean;
	webhook: string | undefined;
	verifySignature: boolean;
	signatureKey: string | undefined;
}

/**
 * Reads and validates all action inputs.
 *
 * @returns The parsed inputs.
 */
function readInputs(): ActionInputs {
	const headersRaw = core.getMultilineInput("headers", { required: false });
	const headers: Record<string, string> = {};
	for (const line of headersRaw) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const idx = trimmed.indexOf(":");
		if (idx === -1) {
			throw new Error(`Invalid header line (expected "Key: Value"): ${trimmed}`);
		}
		headers[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
	}

	const failOn = core.getInput("fail-on") || undefined;
	if (failOn && !VALID_SEVERITIES.has(failOn)) {
		throw new Error(`Invalid fail-on value "${failOn}". Must be one of: safe, warning, breaking`);
	}

	const sse = core.getBooleanInput("sse");
	const url = core.getInput("url") || undefined;
	if (sse && !url) {
		throw new Error("'sse' requires 'url' to be set");
	}

	const argsStr = core.getInput("args") || undefined;

	return {
		baseline: core.getInput("baseline") || undefined,
		command: core.getInput("command") || undefined,
		args: argsStr ? argsStr.split(/\s+/) : undefined,
		url,
		sse,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		config: core.getInput("config") || undefined,
		project: core.getInput("project") || undefined,
		failOn,
		checkConflicts: core.getBooleanInput("check-conflicts"),
		webhook: core.getInput("webhook") || undefined,
		verifySignature: core.getBooleanInput("verify-signature"),
		signatureKey:
			core.getInput("signature-key") || process.env["MCP_SIGNATURE_KEY"] || undefined,
	};
}

/**
 * Writes the step summary and optionally posts the report as a PR comment.
 *
 * @param markdown - The formatted report.
 */
async function publishReport(markdown: string): Promise<void> {
	core.summary.addRaw(markdown);
	await core.summary.write();

	const commentOnPr = core.getBooleanInput("comment-on-pr");
	if (commentOnPr && github.context.eventName === "pull_request") {
		const token = core.getInput("github-token", { required: false }) || process.env["GITHUB_TOKEN"];
		if (token) {
			const prNumber = github.context.payload.pull_request?.number;
			if (prNumber) {
				await postOrUpdatePRComment(markdown, token, prNumber);
			}
		} else {
			core.warning("No GitHub token available — skipping PR comment");
		}
	}
}

/**
 * Runs composition mode: diffs every server in an mcp.json config against
 * its baseline in the baseline directory.
 *
 * @param inputs - The parsed action inputs.
 */
async function runCompositionMode(inputs: ActionInputs): Promise<void> {
	if (!inputs.baseline) {
		throw new Error("'baseline' must point to a baseline directory when 'config' is set");
	}
	if (inputs.verifySignature) {
		throw new Error("'verify-signature' is not supported in composition mode");
	}
	if (inputs.webhook) {
		core.warning("'webhook' is ignored in composition mode");
	}
	const failOn = (inputs.failOn ?? "breaking") as Severity;

	const { report, collisions, captureFailures } = await runComposition(
		inputs.config as string,
		inputs.baseline,
		inputs.checkConflicts,
	);

	let markdown = formatCompositionMarkdown(report);
	if (collisions) {
		markdown += `\n${formatCollisionsMarkdown(collisions)}`;
	}
	await publishReport(markdown);

	const hasConflicts = (collisions?.summary.conflicting ?? 0) > 0;
	const shouldFail = compositionHasFailure(report, failOn);

	core.setOutput("has-changes", String(report.summary.total > 0));
	core.setOutput("has-breaking", String(report.summary.breaking > 0 || report.summary.missingServers > 0));
	core.setOutput("has-conflicts", String(hasConflicts));
	core.setOutput("summary", JSON.stringify(report.summary));
	core.setOutput("exit-code", shouldFail || hasConflicts || captureFailures.length > 0 ? "1" : "0");

	if (captureFailures.length > 0) {
		const failed = captureFailures.map((f) => `${f.serverName} (${f.error})`).join(", ");
		core.setFailed(`Failed to capture ${captureFailures.length} server(s): ${failed}`);
		return;
	}
	if (hasConflicts) {
		core.setFailed("Conflicting tool names detected across servers");
		return;
	}
	if (shouldFail) {
		core.setFailed(`MCP contract changes at or above "${failOn}" severity detected`);
	}
}

/**
 * Runs single-server mode: captures one server and diffs it against a
 * baseline snapshot file.
 *
 * @param inputs - The parsed action inputs.
 */
async function runSingleServerMode(inputs: ActionInputs): Promise<void> {
	const workspace = process.env["GITHUB_WORKSPACE"] || process.cwd();

	let transport: ResolvedTransport;
	let baselinePath: string;
	let failOn: Severity;

	if (inputs.command || inputs.url) {
		transport = inputs.command
			? { transport: "stdio", ...resolveCommandString(inputs.command, inputs.args) }
			: {
					transport: inputs.sse ? "sse" : "streamable-http",
					url: inputs.url,
					headers: inputs.headers,
				};
		const project = loadProjectConfig(inputs.project, workspace);
		baselinePath =
			inputs.baseline ??
			(project?.config.baseline
				? resolveProjectPath(project, project.config.baseline)
				: resolve(workspace, DEFAULT_BASELINE_PATH));
		failOn = (inputs.failOn ?? project?.config.failOn ?? "breaking") as Severity;
	} else {
		const project = loadProjectConfig(inputs.project, workspace);
		if (!project?.config.server) {
			throw new Error(
				"Provide 'command', 'url', or 'config' inputs — or add an mcpcontracts.json with a \"server\" block to the repository",
			);
		}
		transport = resolveProjectTransport(project);
		baselinePath =
			inputs.baseline ??
			(project.config.baseline
				? resolveProjectPath(project, project.config.baseline)
				: resolve(workspace, DEFAULT_BASELINE_PATH));
		failOn = (inputs.failOn ?? project.config.failOn ?? "breaking") as Severity;
	}

	const baseline = readBaseline(baselinePath);

	if (inputs.verifySignature) {
		if (!inputs.signatureKey) {
			throw new Error(
				"'verify-signature' requires 'signature-key' (or the MCP_SIGNATURE_KEY environment variable)",
			);
		}
		verifyBaselineSignature(baseline, baselinePath, inputs.signatureKey);
		core.info("Baseline signature verified");
	}

	const current = await captureSnapshot(transport);
	const report = diffSnapshots(baseline, current);

	await publishReport(formatMarkdown(report));

	if (inputs.webhook) {
		const serverSource =
			transport.transport === "stdio"
				? [transport.command, ...(transport.args ?? [])].join(" ")
				: transport.url;
		const payload = createWebhookPayload(report, {
			trigger: "ci",
			baselinePath,
			serverSource,
		});
		const result = await sendWebhook(inputs.webhook, payload);
		if (result.success) {
			core.info(`Webhook delivered (HTTP ${result.statusCode})`);
		} else {
			core.warning(`Webhook delivery failed: ${result.error}`);
		}
	}

	const threshold = SEVERITY_ORDER[failOn];
	const shouldFail = report.changes.some((c) => SEVERITY_ORDER[c.severity] >= threshold);

	core.setOutput("has-changes", String(report.changes.length > 0));
	core.setOutput("has-breaking", String(report.summary.breaking > 0));
	core.setOutput("has-conflicts", "false");
	core.setOutput("summary", JSON.stringify(report.summary));
	core.setOutput("exit-code", shouldFail ? "1" : "0");

	if (shouldFail) {
		core.setFailed(`MCP contract changes at or above "${failOn}" severity detected`);
	}
}

/**
 * Main entry point for the GitHub Action.
 *
 * Reads inputs, dispatches to single-server or composition mode, sets
 * outputs, writes the step summary, and optionally fails the action.
 */
export async function run(): Promise<void> {
	try {
		const inputs = readInputs();
		if (inputs.config) {
			await runCompositionMode(inputs);
		} else {
			await runSingleServerMode(inputs);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		core.setFailed(message);
	}
}

run();

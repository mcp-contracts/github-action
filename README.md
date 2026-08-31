# MCP Contract Diff — GitHub Action

Diff MCP server tool schemas against a baseline contract. Detects breaking changes, warnings, and safe additions in your MCP server's API surface.

## Usage

```yaml
name: MCP Contract Check
on:
  pull_request:
    paths:
      - "src/**"
      - "package.json"

jobs:
  contract-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: npm install
      - name: Check MCP contract
        uses: mcp-contracts/github-action@main
        with:
          baseline: contracts/baseline.mcpc.json
          command: node
          args: dist/index.js
          fail-on: breaking
```

If your repository has an [`mcpcontracts.json`](https://github.com/mcp-contracts/mcp-contracts) project config, the action needs no inputs at all — the server and baseline come from the config:

```yaml
      - name: Check MCP contract
        uses: mcp-contracts/github-action@main
```

## Inputs

| Input              | Required | Default        | Description                                               |
| ------------------ | -------- | -------------- | --------------------------------------------------------- |
| `baseline`         | No       | see below      | Path to baseline snapshot (`.mcpc.json`); with `config`, a directory of baselines |
| `command`          | No\*     |                | Server command to run via stdio (e.g., `node dist/index.js`) |
| `args`             | No       |                | Arguments for the server command (space-separated)        |
| `url`              | No\*     |                | Server URL for streamable-http transport                  |
| `sse`              | No       | `false`        | Use SSE transport instead of streamable-http (requires `url`) |
| `headers`          | No       |                | Custom HTTP headers, one per line as `Key: Value`         |
| `config`           | No\*     |                | Path to an mcp.json — enables [composition mode](#composition-mode-multiple-servers) |
| `project`          | No       | auto-discovered | Path to `mcpcontracts.json`                              |
| `fail-on`          | No       | `breaking`     | Severity threshold for failure: `safe`, `warning`, `breaking` |
| `check-conflicts`  | No       | `false`        | Composition mode: fail on conflicting duplicate tool names |
| `webhook`          | No       |                | URL to POST the diff report to as JSON                    |
| `verify-signature` | No       | `false`        | Require a valid signature on the baseline before diffing  |
| `signature-key`    | No       | `$MCP_SIGNATURE_KEY` | Public key PEM content or file path                 |
| `comment-on-pr`    | No       | `true`         | Post diff as a PR comment                                 |
| `github-token`     | No       | `github.token` | GitHub token for PR comments                              |

\* Provide `command`, `url`, or `config` — or none of them if `mcpcontracts.json` defines a server.

When `baseline` is omitted, the action uses the `baseline` from `mcpcontracts.json`, falling back to `contracts/baseline.mcpc.json`.

Baselines are integrity-checked on load: the content hash is recomputed and compared to the stored value, so a corrupted or hand-edited baseline fails the check even without signature verification.

## Outputs

| Output          | Description                                        |
| --------------- | -------------------------------------------------- |
| `has-changes`   | Whether any changes were detected (`true`/`false`) |
| `has-breaking`  | Whether breaking changes were detected             |
| `has-conflicts` | Whether conflicting tool names were detected across servers |
| `summary`       | JSON summary object with change counts             |
| `exit-code`     | `0` = pass, `1` = fail                             |

## How It Works

1. Reads the baseline snapshot and verifies its content hash
2. Connects to your MCP server (via stdio command or HTTP URL)
3. Captures the current tool/resource/prompt schemas
4. Diffs the current state against the baseline
5. Reports changes as a step summary and optional PR comment
6. Fails the check if changes meet the `fail-on` severity threshold

## Creating a Baseline

Use the [`mcpdiff` CLI](https://github.com/mcp-contracts/mcp-contracts) to capture a baseline snapshot:

```bash
npx mcpdiff snapshot --command node --args server.js -o contracts/baseline.mcpc.json
```

Commit this file to your repository and reference it in the `baseline` input.

## Composition Mode (Multiple Servers)

Point `config` at an mcp.json and `baseline` at a directory of baseline snapshots (as written by `mcpdiff snapshot --config mcp.json --all --out-dir contracts/composition`). Every server in the config is captured and diffed against its baseline in one unified report. With `check-conflicts`, duplicate tool names across servers are detected too — schema-conflicting duplicates fail the check.

```yaml
- name: Check MCP composition
  uses: mcp-contracts/github-action@main
  with:
    config: mcp.json
    baseline: contracts/composition
    check-conflicts: "true"
```

A baseline whose server disappeared from the config always fails; servers without a baseline fail at `fail-on: warning` or stricter.

## Signed Baselines

Require a valid detached signature (`.mcpc.sig` next to the baseline, created with `mcpdiff sign`) before diffing, so a tampered baseline can't hide breaking changes:

```yaml
- name: Check MCP contract (signed baseline)
  uses: mcp-contracts/github-action@main
  with:
    baseline: contracts/baseline.mcpc.json
    command: node
    args: dist/index.js
    verify-signature: "true"
    signature-key: ${{ secrets.MCP_PUBLIC_KEY }}
```

`signature-key` accepts PEM content or a file path, and falls back to the `MCP_SIGNATURE_KEY` environment variable.

## Webhooks

POST the diff report as JSON to any HTTP endpoint on completion. Delivery failures are logged as warnings and never fail the check:

```yaml
- name: Check MCP contract
  uses: mcp-contracts/github-action@main
  with:
    baseline: contracts/baseline.mcpc.json
    command: node
    args: dist/index.js
    webhook: ${{ secrets.WEBHOOK_URL }}
```

## SSE Transport with Custom Headers

```yaml
- name: Check MCP contract (SSE)
  uses: mcp-contracts/github-action@main
  with:
    baseline: contracts/baseline.mcpc.json
    url: https://mcp.example.com/sse
    sse: "true"
    headers: |
      Authorization: Bearer ${{ secrets.MCP_TOKEN }}
    fail-on: breaking
```

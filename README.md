# MCP Contract Diff GitHub Action

Diffs an MCP server's tool schemas against a baseline contract on every pull request and reports breaking changes, warnings and safe additions as a step summary and PR comment. The companion to the [`mcpdiff` CLI](https://github.com/mcp-contracts/mcp-contracts).

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
        uses: mcp-contracts/github-action@v0.8.0
        with:
          baseline: contracts/baseline.mcpc.json
          command: node
          args: dist/index.js
          fail-on: breaking
```

With an [`mcpcontracts.json`](https://github.com/mcp-contracts/mcp-contracts#project-config-mcpcontractsjson) project config in the repository the action needs no inputs at all; server and baseline come from the config:

```yaml
      - name: Check MCP contract
        uses: mcp-contracts/github-action@v0.8.0
```

Run the action on `pull_request`, never `pull_request_target`: the config names a command that the action executes, and on `pull_request` a fork's config runs with a read-only token and no secrets. See the [trust model](https://github.com/mcp-contracts/mcp-contracts/blob/main/SECURITY.md#trust-model).

## Inputs

| Input              | Required | Default        | Description                                               |
| ------------------ | -------- | -------------- | --------------------------------------------------------- |
| `baseline`         | No       | see below      | Path to baseline snapshot (`.mcpc.json`); with `config`, a directory of baselines |
| `command`          | No\*     |                | Server command to run via stdio (e.g., `node dist/index.js`) |
| `args`             | No       |                | Arguments for the server command (space-separated)        |
| `url`              | No\*     |                | Server URL for streamable-http transport                  |
| `sse`              | No       | `false`        | Use SSE transport instead of streamable-http (requires `url`) |
| `headers`          | No       |                | Custom HTTP headers, one per line as `Key: Value`         |
| `config`           | No\*     |                | Path to an mcp.json; enables [composition mode](#composition-mode-multiple-servers) |
| `project`          | No       | auto-discovered | Path to `mcpcontracts.json`                              |
| `fail-on`          | No       | `breaking`     | Severity threshold for failure: `safe`, `warning`, `breaking` |
| `check-conflicts`  | No       | `false`        | Composition mode: fail on conflicting duplicate tool names |
| `webhook`          | No       |                | URL to POST the diff report to as JSON                    |
| `verify-signature` | No       | `false`        | Require a valid signature on the baseline before diffing  |
| `signature-key`    | No       | `$MCP_SIGNATURE_KEY` | Public key PEM content or file path                 |
| `comment-on-pr`    | No       | `true`         | Post diff as a PR comment                                 |
| `github-token`     | No       | `github.token` | GitHub token for PR comments                              |

\* Provide `command`, `url` or `config`, or none of them if `mcpcontracts.json` defines a server.

When `baseline` is omitted, the action uses the `baseline` from `mcpcontracts.json`, falling back to `contracts/baseline.mcpc.json`. Baselines are integrity-checked on load: the content hash is recomputed and compared to the stored value, so a corrupted or hand-edited baseline fails the check even without signature verification.

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
3. Captures the current tool, resource and prompt schemas
4. Diffs the current state against the baseline
5. Reports changes as a step summary and optional PR comment
6. Fails the check if changes meet the `fail-on` severity threshold

## Creating a Baseline

Use the `mcpdiff` CLI once to write the project config and capture the baseline, then commit both files:

```bash
npx @mcp-contracts/cli init --command node --args dist/index.js
```

`mcpdiff update` refreshes the committed baseline after an intended change.

## Composition Mode (Multiple Servers)

Point `config` at an mcp.json and `baseline` at a directory of baseline snapshots (as written by `mcpdiff snapshot --config mcp.json --all --out-dir contracts/composition`). Every server in the config is captured and diffed against its baseline in one unified report. With `check-conflicts`, duplicate tool names across servers are detected too, and schema-conflicting duplicates fail the check.

```yaml
- name: Check MCP composition
  uses: mcp-contracts/github-action@v0.8.0
  with:
    config: mcp.json
    baseline: contracts/composition
    check-conflicts: "true"
```

A baseline whose server disappeared from the config always fails; servers without a baseline fail at `fail-on: warning` or stricter.

## Signed Baselines

Require a valid detached signature (`.mcpc.sig` next to the baseline, created with `mcpdiff sign`) before diffing, so a tampered baseline cannot hide breaking changes. Supply the public key from a secret, not from the checkout, otherwise a pull request could replace key, baseline and signature together.

```yaml
- name: Check MCP contract (signed baseline)
  uses: mcp-contracts/github-action@v0.8.0
  with:
    baseline: contracts/baseline.mcpc.json
    command: node
    args: dist/index.js
    verify-signature: "true"
    signature-key: ${{ secrets.MCP_PUBLIC_KEY }}
```

`signature-key` accepts PEM content or a file path and falls back to the `MCP_SIGNATURE_KEY` environment variable.

## Remote Servers and Webhooks

Remote servers are reached with `url`, optionally over SSE with custom headers. `webhook` POSTs the diff report as JSON to an endpoint when the check completes; delivery failures are logged as warnings and never fail the check.

```yaml
- name: Check MCP contract (remote server)
  uses: mcp-contracts/github-action@v0.8.0
  with:
    baseline: contracts/baseline.mcpc.json
    url: https://mcp.example.com/sse
    sse: "true"
    headers: |
      Authorization: Bearer ${{ secrets.MCP_TOKEN }}
    webhook: ${{ secrets.WEBHOOK_URL }}
```

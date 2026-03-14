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

## Inputs

| Input            | Required | Default      | Description                                               |
| ---------------- | -------- | ------------ | --------------------------------------------------------- |
| `baseline`       | Yes      |              | Path to baseline snapshot (`.mcpc.json`)                  |
| `command`        | No\*     |              | Server command to run via stdio (e.g., `node dist/index.js`) |
| `args`           | No       |              | Arguments for the server command (space-separated)        |
| `url`            | No\*     |              | Server URL for streamable-http transport                  |
| `sse`            | No       | `false`      | Use SSE transport instead of streamable-http (requires `url`) |
| `headers`        | No       |              | Custom HTTP headers, one per line as `Key: Value`         |
| `fail-on`        | No       | `breaking`   | Severity threshold for failure: `safe`, `warning`, `breaking` |
| `comment-on-pr`  | No       | `true`       | Post diff as a PR comment                                 |
| `github-token`   | No       | `github.token` | GitHub token for PR comments                            |

\* Either `command` or `url` is required.

## Outputs

| Output        | Description                                    |
| ------------- | ---------------------------------------------- |
| `has-changes` | Whether any changes were detected (`true`/`false`) |
| `has-breaking`| Whether breaking changes were detected         |
| `summary`     | JSON summary object with change counts         |
| `exit-code`   | `0` = pass, `1` = fail                        |

## How It Works

1. Reads the baseline snapshot from the file path you provide
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

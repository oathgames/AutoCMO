// Merlin MCP Server — In-Process Tool Registration
//
// Creates an MCP server using the Claude Agent SDK's createSdkMcpServer().
// Runs inside Electron's main process — no separate child process, no cloud.
// All tool handlers have direct access to the vault, config, and binary via
// the injected context object.
//
// Security guarantee: credentials are read from the vault INSIDE this
// process and passed to the binary via ephemeral temp configs. Claude
// only sees sanitized tool results — never raw tokens.

'use strict';

const { buildTools } = require('./mcp-tools');

// Cache the SDK import — same pattern as importClaudeAgentSdk() in main.js.
let _sdkModule = null;
async function importSdk() {
  if (_sdkModule) return _sdkModule;
  try {
    _sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    // Packaged app: try the unpacked asar path
    const path = require('path');
    const app = require('electron').app;
    const unpacked = path.join(
      path.dirname(app.getPath('exe')),
      'resources', 'app.asar.unpacked', 'node_modules',
      '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'
    );
    _sdkModule = await import(unpacked);
  }
  return _sdkModule;
}

/**
 * Create the Merlin MCP server instance.
 *
 * @param {object} ctx - Dependency-injected context from main.js:
 *   - getBinaryPath(): string
 *   - readConfig(): object
 *   - readBrandConfig(brand): object
 *   - vaultGet(brand, key): string|null
 *   - vaultPut(brand, key, value): void
 *   - writeBrandTokens(brand, tokens): void
 *   - runOAuthFlow(platform, brand, extra): Promise<{success?, error?}>
 *   - getConnections(brand): [{platform, status}]
 *   - appRoot: string
 *   - activeChildProcesses: Set
 *   - appendAudit(event, details): void
 *
 * @returns {Promise<McpSdkServerConfigWithInstance>} — pass to query options.mcpServers
 */
async function createMerlinMcpServer(ctx) {
  const sdk = await importSdk();
  const { createSdkMcpServer, tool } = sdk;

  // Zod is a peer dependency of the SDK — both the SDK and Merlin resolve
  // to the same copy in node_modules/zod. The tool() function accepts
  // ZodRawShape objects for input schema validation.
  const z = require('zod');

  const allTools = buildTools(tool, z, ctx);

  const server = createSdkMcpServer({
    name: 'merlin',
    version: require('../package.json').version,
    tools: allTools,
  });

  console.log(`[mcp] Merlin server registered with ${allTools.length} tools`);
  return server;
}

module.exports = { createMerlinMcpServer };

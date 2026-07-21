// Minimal JSON-RPC 2.0 error envelope. The gateway returns these for failures
// it handles itself (auth, bad name, provisioning), before/instead of handing
// the request to the MCP transport. `id: null` is valid when we can't correlate
// to a request id (e.g. auth rejected before parsing).
export function rpcError(code: number, message: string, id: unknown = null) {
  return {
    jsonrpc: "2.0" as const,
    error: { code, message },
    id: id ?? null,
  };
}

// Standard JSON-RPC / MCP-ish codes we reuse.
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  INTERNAL: -32603,
  // Application range for gateway-specific conditions.
  UNAUTHORIZED: -32001,
  NOT_FOUND: -32002,
  BUSY: -32003,
  FLEET_FULL: -32004,
  PROVISION_FAILED: -32005,
} as const;

/**
 * The slice of chrome-devtools-mcp's (untyped, unexported) internals the format
 * tests drive directly. `McpResponse.format` is the single code path that
 * renders every page-scoped reply the nav watchdog parses, so cdm-format.test.ts
 * pins the watchdog against the real dependency rather than against literals.
 * Declared here rather than depended on in `src/`: the gateway itself only ever
 * sees this output over the child's stdio.
 */
declare module "chrome-devtools-mcp/build/src/McpResponse.js" {
  export class McpResponse {
    constructor(args: unknown);
    setIncludePages(value: boolean): void;
    appendResponseLine(value: string): void;
    format(
      toolName: string,
      context: unknown,
      data: unknown,
    ): { content: Array<{ type: string; text?: string }>; structuredContent: Record<string, unknown> };
  }
}

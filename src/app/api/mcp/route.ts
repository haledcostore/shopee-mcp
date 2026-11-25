import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { keyFromRequest, verifyApiKey } from "@/lib/api-keys";
import { createMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing or invalid API key. Send 'Authorization: Bearer smcp_…'." },
      id: null,
    },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="shopee-mcp"' } }
  );
}

/**
 * Stateless server: there is no standalone SSE stream to offer. Per the
 * Streamable HTTP spec, answering GET with 405 tells MCP clients not to open
 * one. Handling GET like POST opened a stream and closed it at once, so
 * clients reconnected in a tight loop.
 */
function methodNotAllowed(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: "POST, DELETE" } }
  );
}

/**
 * Stateless Streamable HTTP endpoint: each request gets a fresh MCP server bound
 * to the caller's API key, which fits Vercel's serverless functions.
 */
async function handle(request: Request): Promise<Response> {
  const ctx = await verifyApiKey(keyFromRequest(request));
  if (!ctx) return unauthorized();

  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Responses are fully buffered (enableJsonResponse), so it's safe to close.
    await server.close();
  }
}

export { methodNotAllowed as GET, handle as POST, handle as DELETE };

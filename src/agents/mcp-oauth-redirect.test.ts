import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";
import { completeMcpOAuthAuthorization, resolveMcpOAuthAccessToken } from "./mcp-oauth.js";
import { withMcpOAuthTempHome } from "./mcp-oauth.test-harness.js";
import { resolvedOAuthConfig, seedMcpOAuthStoreForTest } from "./mcp-oauth.test-support.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";
const lookupMock = vi.hoisted(() => vi.fn());
const redirectRefusal = "Refusing to follow cross-origin redirect for POST request body";

class TestDispatcher {
  constructor(readonly options: unknown) {}
}

vi.mock("node:dns/promises", () => ({
  lookup: lookupMock,
}));

function installRedirectingRuntime(status: number) {
  const runtimeFetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status,
        headers: { location: "https://example.org/token" },
      }),
    )
    .mockResolvedValueOnce(new Response("ok"));
  Reflect.set(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY, {
    Agent: TestDispatcher,
    EnvHttpProxyAgent: TestDispatcher,
    ProxyAgent: TestDispatcher,
    fetch: runtimeFetchMock,
  });
  return runtimeFetchMock;
}

function prepareGrant(identity: ReturnType<typeof operatorMcpOAuthIdentity>, grant: McpOAuthStore) {
  const issuer = "https://example.com/";
  seedMcpOAuthStoreForTest(identity.storeKey, {
    authorizationId: "synthetic-authorization",
    clientInformation: { client_id: "fixture-client" },
    tokensAuthorizationServerUrl: issuer,
    discoveryState: {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      resourceMetadata: {
        resource: identity.serverUrl,
        authorization_servers: [issuer],
      },
    },
    ...grant,
  });
}

describe("MCP OAuth redirects", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, TEST_UNDICI_RUNTIME_DEPS_KEY);
  });

  it.each([307, 308])(
    "rejects a cross-origin code-exchange %s redirect before replaying its body",
    async (status) => {
      await withMcpOAuthTempHome(async () => {
        const identity = operatorMcpOAuthIdentity(`Redirect ${status}`, "https://example.com/mcp");
        prepareGrant(identity, {
          codeVerifier: "synthetic-verifier",
          redirectUrl: "http://127.0.0.1:8989/oauth/callback",
        });

        const runtimeFetchMock = installRedirectingRuntime(status);
        await expect(
          completeMcpOAuthAuthorization(identity, resolvedOAuthConfig(identity), {
            code: "synthetic-code",
          }),
        ).rejects.toThrow(redirectRefusal);
        expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
      }, "openclaw-mcp-oauth-redirect-");
    },
  );

  it("preserves the redirect refusal through real SDK token refresh", async () => {
    await withMcpOAuthTempHome(async () => {
      const identity = operatorMcpOAuthIdentity("Refresh Redirect", "https://example.com/mcp");
      prepareGrant(identity, {
        tokenExpiresAt: 0,
        tokens: {
          access_token: "expired-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
        },
      });
      const runtimeFetchMock = installRedirectingRuntime(307);

      const error = await resolveMcpOAuthAccessToken({ identity }).catch(
        (failure: unknown) => failure,
      );
      // A redirected token POST may already have been accepted, so the owner fences the grant.
      expect(error).toMatchObject({
        message: "MCP OAuth refresh outcome is uncertain; sign in again.",
        oauthRefreshOutcome: { phase: "after-token-response", outcome: "unknown" },
        cause: expect.objectContaining({ message: expect.stringContaining(redirectRefusal) }),
      });
      expect(formatErrorMessage(error)).toContain(redirectRefusal);
      await expect(resolveMcpOAuthAccessToken({ identity })).rejects.toThrow(/uncertain/);
      expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    }, "openclaw-mcp-oauth-redirect-");
  });
});

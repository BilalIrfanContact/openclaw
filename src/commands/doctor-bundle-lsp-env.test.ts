import { userInfo } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bundleLsp from "../plugins/bundle-lsp.js";
import { noteBundleLspEnvPassthrough } from "./doctor-bundle-lsp-env.js";

const { shouldManageGatewayService } = vi.hoisted(() => ({
  shouldManageGatewayService: vi.fn(async () => false),
}));
vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService,
}));

const noteFn = vi.fn();
const service = { readCommand: vi.fn() };

function lspConfig(
  servers: Record<string, Record<string, unknown>>,
): ReturnType<typeof bundleLsp.loadEnabledBundleLspConfig> {
  return { config: { lspServers: servers }, diagnostics: [] };
}

const gopls = { gopls: { command: "gopls", env: { DOTNET_ROOT: "/bundle/dotnet" } } };
const gatewayEnv = {
  HTTPS_PROXY: ["http://user", "proxy-pass-canary@proxy.example:3128"].join(":"),
  ANDROID_HOME: "/srv/android-canary",
  DOTNET_ROOT: "/srv/dotnet-canary",
  NPM_TOKEN: "npm-token-canary",
  OPENAI_API_KEY: "provider-key-canary",
};

beforeEach(() => {
  noteFn.mockReset();
  service.readCommand.mockReset().mockResolvedValue({
    programArguments: [],
    environment: { VIRTUAL_ENV: "/srv/venv-canary" },
  });
  shouldManageGatewayService.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

async function diagnose(
  options: Partial<Parameters<typeof noteBundleLspEnvPassthrough>[0]> & {
    loadLspConfig?: typeof bundleLsp.loadEnabledBundleLspConfig;
  } = {},
): Promise<string | undefined> {
  const { loadLspConfig = () => lspConfig(gopls), ...params } = options;
  vi.spyOn(bundleLsp, "loadEnabledBundleLspConfig").mockImplementation(loadLspConfig);
  await noteBundleLspEnvPassthrough({
    cfg: {},
    workspaceDirs: ["/synthetic/workspace"],
    env: gatewayEnv,
    service,
    noteFn,
    ...params,
  });
  return noteFn.mock.calls[0]?.[0];
}

it("names withheld Gateway variables per configured server, never values or secrets", async () => {
  shouldManageGatewayService.mockResolvedValue(true);
  const text = await diagnose({ env: { ...gatewayEnv, HOME: userInfo().homedir } });

  expect(text).toContain(`- "gopls": ANDROID_HOME: add to the server's "env"`);
  expect(text).toContain(`- "gopls": HTTPS_PROXY: refused by the host exec env policy`);
  expect(text).toContain(`- "gopls": VIRTUAL_ENV: refused by the host exec env policy`);
  expect(text).toContain("https://docs.openclaw.ai/plugins/bundles#lsp-server-environment");
  expect(text).not.toMatch(/DOTNET_ROOT|NPM_TOKEN|OPENAI_API_KEY|canary|proxy-pass|proxy\.example/);
});

it.each([
  { loadLspConfig: () => lspConfig({}) },
  { loadLspConfig: () => lspConfig({ remote: { transport: "socket" } }) },
  { env: { OPENAI_API_KEY: "provider-key-canary" } },
  { cfg: { gateway: { mode: "remote" as const } } },
])("stays quiet for an inapplicable environment: %j", async (options) => {
  expect(await diagnose(options)).toBeUndefined();
});

it("evaluates each workspace's config when workspaces reuse a server name", async () => {
  const text = await diagnose({
    workspaceDirs: ["/synthetic/android-a", "/synthetic/android-b"],
    env: { ANDROID_HOME: "/srv/android" },
    loadLspConfig: ({ workspaceDir }) =>
      lspConfig({
        kotlin: {
          command: "kotlin-lsp",
          env: workspaceDir.endsWith("-a") ? { ANDROID_HOME: "/bundle/android" } : undefined,
        },
      }),
  });

  expect(text).toContain(`- "kotlin": ANDROID_HOME: add to the server's "env"`);
  expect(text).not.toMatch(/\/srv\/android|\/bundle\/android/);
});

it("does not read the installed service for a non-default install identity", async () => {
  shouldManageGatewayService.mockResolvedValue(true);
  expect(await diagnose({ env: { HOME: "/srv/relocated-home" } })).toBeUndefined();
  expect(service.readCommand).not.toHaveBeenCalled();
});

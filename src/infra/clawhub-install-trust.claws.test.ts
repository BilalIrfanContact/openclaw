import { afterEach, expect, it, vi } from "vitest";
import { checkClawHubPackageTrust } from "./clawhub-install-trust.js";
import { captureClawHubResponse } from "./clawhub.test-support.js";

const subject = { kind: "claw" as const, packageName: "@openclaw/research-briefing" };
const version = "1.0.0";
const expectedClawArtifact = {
  sha256: "a".repeat(64),
  npmIntegrity: "sha512-proof",
};

function check(
  response: Response,
  options: Partial<Parameters<typeof checkClawHubPackageTrust>[0]> = {},
) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response);
  return checkClawHubPackageTrust({
    subject,
    version,
    expectedClawArtifact,
    ...options,
  });
}

function securityResponse(
  family = "claw",
  verdict: string | null = "benign",
  trustOverrides: Record<string, unknown> = {},
  releaseOverrides: Record<string, unknown> = {},
) {
  return Response.json({
    package: { name: subject.packageName, family },
    release: {
      version,
      artifactKind: "npm-pack",
      artifactSha256: expectedClawArtifact.sha256,
      npmIntegrity: expectedClawArtifact.npmIntegrity,
      ...releaseOverrides,
    },
    overview: "No concerning capabilities found.",
    ...(verdict ? { verdict } : {}),
    securityAuditUrl: "https://clawhub.example/audit",
    trust: {
      scanStatus: "clean",
      moderationState: "approved",
      blockedFromDownload: false,
      reasons: [],
      pending: false,
      stale: false,
      ...trustOverrides,
    },
  });
}

afterEach(() => vi.restoreAllMocks());

it("checks the exact Claw release through the current package security route", async () => {
  const request = captureClawHubResponse(() => securityResponse());
  const result = await checkClawHubPackageTrust({
    subject,
    version,
    expectedClawArtifact,
    baseUrl: "https://clawhub.example",
  });

  expect(result).toMatchObject({
    ok: true,
    trustInstallRecordFields: { clawhubTrustDisposition: "clean" },
  });
  expect(request.url().pathname).toBe(
    "/api/v1/packages/%40openclaw%2Fresearch-briefing/versions/1.0.0/security",
  );
});

it.each([true, false])("matches the selected npm shasum: %s", async (matches) => {
  const selectedArtifact = { ...expectedClawArtifact, npmShasum: "a".repeat(40) };
  const npmShasum = (matches ? "a" : "b").repeat(40);
  const result = await check(securityResponse("claw", "benign", {}, { npmShasum }), {
    expectedClawArtifact: selectedArtifact,
  });
  expect(result).toMatchObject(
    matches ? { ok: true } : { ok: false, code: "clawhub_security_unavailable" },
  );
});

it.each([
  ["different digest", "claw", { artifactSha256: "b".repeat(64) }, {}],
  ["missing artifact kind", "claw", { artifactKind: null }, {}],
  ["different artifact kind", "claw", { artifactKind: "legacy-zip" }, {}],
  ["missing digest", "claw", { artifactSha256: null }, {}],
  ["missing npm integrity", "claw", { npmIntegrity: null }, {}],
  ["different npm integrity", "claw", { npmIntegrity: "sha512-other" }, {}],
  ["different package family", "code-plugin", {}, {}],
  ["missing selected artifact", "claw", {}, { expectedClawArtifact: undefined }],
] as const)("refuses %s", async (_label, family, releaseOverrides, options) => {
  const result = await check(securityResponse(family, "benign", {}, releaseOverrides), options);
  expect(result).toMatchObject({ ok: false, code: "clawhub_security_unavailable" });
});

it.each([
  ["unknown", undefined, false],
  [null, undefined, false],
  ["malicious", undefined, true],
  ["blocked", undefined, true],
  ["benign", "pending", false],
  ["benign", "stale", false],
] as const)("does not call verdict %s / scan %s Safe", async (verdict, state, blocked) => {
  const trust = state ? { scanStatus: state, reasons: [`scan:${state}`], [state]: true } : {};
  const result = await check(securityResponse("claw", verdict, trust));
  expect(result).toMatchObject(
    blocked
      ? { ok: false, code: "clawhub_download_blocked" }
      : {
          ok: true,
          trustInstallRecordFields: { clawhubTrustDisposition: "review-required" },
        },
  );
  expect(result.warning).toContain(`Outcome: ${blocked ? "Blocked" : "Review"}`);
});

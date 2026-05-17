import { createHash, randomBytes } from "node:crypto";

export type PkcePair = {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: "S256";
};

// 32 bytes → 43 base64url chars. RFC 7636 requires 43–128 chars.
export function generatePkcePair(
  randomBytesFn: (n: number) => Buffer = randomBytes,
): PkcePair {
  const verifier = base64url(randomBytesFn(32));
  const challenge = base64url(
    createHash("sha256").update(verifier).digest(),
  );
  return {
    code_verifier: verifier,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
}

export function buildAuthorizationUrl(input: {
  authorization_endpoint: string;
  client_id: string;
  redirect_uri: string;
  scope?: string;
  state: string;
  code_challenge: string;
}): string {
  const u = new URL(input.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.client_id);
  u.searchParams.set("redirect_uri", input.redirect_uri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("code_challenge", input.code_challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (input.scope) u.searchParams.set("scope", input.scope);
  return u.toString();
}

export function generateState(
  randomBytesFn: (n: number) => Buffer = randomBytes,
): string {
  return base64url(randomBytesFn(16));
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

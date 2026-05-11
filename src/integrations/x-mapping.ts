import type { XProfile } from "./apify-x.js";

export type MappedXPerson = {
  name: string | null;
  twitter_url: string;
  handle: string;
};

export type MappedXProfile = {
  person: MappedXPerson;
};

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return null;
}

export function mapProfile(
  profile: XProfile,
  fallbackHandle: string,
): MappedXProfile {
  // apidojo/twitter-user-scraper field names vary by version; try common keys.
  const username =
    pickString(
      (profile as { userName?: unknown }).userName,
      (profile as { username?: unknown }).username,
      (profile as { screen_name?: unknown }).screen_name,
      (profile as { handle?: unknown }).handle,
    ) ?? fallbackHandle;

  const displayName = pickString(
    (profile as { name?: unknown }).name,
    (profile as { displayName?: unknown }).displayName,
    (profile as { fullName?: unknown }).fullName,
  );

  const handle = username.replace(/^@/, "").toLowerCase();
  const twitterUrl = `x.com/${handle}`;

  return {
    person: {
      name: displayName,
      twitter_url: twitterUrl,
      handle,
    },
  };
}

import type { LinkedInProfile } from "./apify-linkedin.js";

export type MappedPerson = {
  name: string | null;
  linkedin_url: string | null;
  profile_picture_url: string | null;
  job_title: string | null;
};

export type MappedCompany = {
  name: string | null;
  linkedin_url: string | null;
};

export type MappedProfile = {
  person: MappedPerson;
  company: MappedCompany;
};

type Position = {
  position?: string | null;
  companyName?: string | null;
  companyLinkedinUrl?: string | null;
};

function pickString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function firstPosition(profile: LinkedInProfile): Position {
  const cp = profile.currentPosition;
  if (Array.isArray(cp) && cp.length > 0) return cp[0] as Position;
  const exp = profile.experience;
  if (Array.isArray(exp) && exp.length > 0) return exp[0] as Position;
  return {};
}

export function mapProfile(profile: LinkedInProfile): MappedProfile {
  const first = pickString(profile.firstName);
  const last = pickString(profile.lastName);
  const fullName =
    [first, last].filter(Boolean).join(" ").trim() ||
    pickString((profile as { fullName?: unknown }).fullName);

  const linkedinUrl =
    pickString(profile.linkedinUrl) ??
    (pickString(profile.publicIdentifier)
      ? `https://www.linkedin.com/in/${pickString(profile.publicIdentifier)}`
      : null);
  const profilePictureUrl =
    pickString(profile.profilePictureUrl) ??
    pickString(profile.profile_picture_url) ??
    pickString(profile.profileImageUrl) ??
    pickString(profile.profile_image_url) ??
    pickString(profile.pictureUrl) ??
    pickString(profile.picture_url) ??
    pickString(profile.imageUrl) ??
    pickString(profile.image_url);

  const current = firstPosition(profile);
  const experience = Array.isArray(profile.experience)
    ? (profile.experience[0] as Position | undefined)
    : undefined;

  const jobTitle =
    pickString(current.position) ??
    pickString(experience?.position) ??
    pickString(profile.headline);

  const companyName =
    pickString(current.companyName) ?? pickString(experience?.companyName);

  const companyLinkedin =
    pickString(current.companyLinkedinUrl) ??
    pickString(experience?.companyLinkedinUrl);

  return {
    person: {
      name: fullName || null,
      linkedin_url: linkedinUrl,
      profile_picture_url: profilePictureUrl,
      job_title: jobTitle,
    },
    company: {
      name: companyName,
      linkedin_url: companyLinkedin,
    },
  };
}

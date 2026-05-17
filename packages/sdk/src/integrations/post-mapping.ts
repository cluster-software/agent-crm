import type { RawPost } from "./apify-post.js";

export type MappedPost = {
  post_url: string;
  author_profile_url: string;
  posted_at: string | null; // YYYY-MM-DD
  content: string | null;
};

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length) return v.trim();
  }
  return null;
}

function toDateOnly(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1]! : null;
  }
  return d.toISOString().slice(0, 10);
}

export function mapLinkedinPost(raw: RawPost): MappedPost {
  // apimaestro/linkedin-post-detail wraps fields under `post` + `author`.
  // Fall back to top-level keys for resilience against schema drift.
  const post = ((raw.post ?? raw) as Record<string, unknown>) ?? {};
  const author = ((raw.author ?? {}) as Record<string, unknown>) ?? {};

  const postUrl =
    pickString(
      post.url,
      post.postUrl,
      post.post_url,
      post.linkedinUrl,
      post.permalink,
    ) ?? "";

  const authorProfileUrl =
    pickString(
      author.profile_url,
      author.profileUrl,
      author.url,
      author.linkedinUrl,
      author.linkedin_url,
    ) ?? "";

  const createdAt = post.created_at as
    | { timestamp?: number; date?: string }
    | string
    | undefined;
  let postedAtRaw: string | null = null;
  if (createdAt && typeof createdAt === "object") {
    if (typeof createdAt.timestamp === "number") {
      postedAtRaw = new Date(createdAt.timestamp).toISOString();
    } else if (typeof createdAt.date === "string") {
      postedAtRaw = createdAt.date;
    }
  } else if (typeof createdAt === "string") {
    postedAtRaw = createdAt;
  }
  if (!postedAtRaw) {
    postedAtRaw = pickString(
      post.postedAt,
      post.posted_at,
      post.createdAt,
      post.date,
      post.publishedAt,
      post.published_at,
    );
  }

  const content = pickString(
    post.text,
    post.content,
    post.commentary,
    post.postText,
    post.post_text,
    post.body,
  );

  return {
    post_url: postUrl,
    author_profile_url: authorProfileUrl,
    posted_at: toDateOnly(postedAtRaw),
    content,
  };
}

export function mapXPost(post: RawPost): MappedPost {
  const author = (post.author ?? post.user ?? {}) as Record<string, unknown>;

  const postUrl =
    pickString(post.url, post.tweetUrl, post.permalink) ?? "";

  const authorHandle = pickString(
    author.userName,
    author.username,
    author.screen_name,
    author.handle,
  );

  const authorProfileUrl =
    pickString(author.url, author.profileUrl, author.profile_url) ??
    (authorHandle ? `https://x.com/${authorHandle}` : "");

  const postedAtRaw = pickString(
    post.createdAt,
    post.created_at,
    post.date,
    post.postedAt,
    post.posted_at,
  );

  const content = pickString(post.text, post.fullText, post.full_text);

  return {
    post_url: postUrl,
    author_profile_url: authorProfileUrl,
    posted_at: toDateOnly(postedAtRaw),
    content,
  };
}

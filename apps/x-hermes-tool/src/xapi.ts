export function buildRecentSearchPath(query: string, limit: number): string {
  const params = new URLSearchParams({
    query,
    max_results: String(clamp(limit, 10, 100)),
    "tweet.fields": "author_id,created_at,public_metrics,possibly_sensitive,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,name,verified,created_at,public_metrics"
  });
  return `/2/tweets/search/recent?${params.toString()}`;
}

export function buildReplyBody(tweetId: string, text: string): string {
  return JSON.stringify({
    text,
    reply: {
      in_reply_to_tweet_id: tweetId
    }
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}


import twitterText from "twitter-text";

/** X follows its official URL/Unicode/emoji rules; other channels retain code-point counts. */
export function postLength(channel: string, body: string): number {
  return channel === "x" ? twitterText.parseTweet(body).weightedLength : [...body].length;
}

import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Returns the signed-in user's GitHub OAuth access token from Clerk when they
 * have connected GitHub, or undefined so public repositories still work.
 */
export async function getUserGitHubToken(): Promise<string | undefined> {
  const { userId } = await auth();
  if (userId) {
    try {
      const client = await clerkClient();
      const { data } = await client.users.getUserOauthAccessToken(userId, "github");
      if (data[0]?.token) return data[0].token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Clerk GitHub OAuth token unavailable (${message}); falling back to GITHUB_TOKEN if set.`);
    }
  }
  return process.env.GITHUB_TOKEN?.trim() || undefined;
}

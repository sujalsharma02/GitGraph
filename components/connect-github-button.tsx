"use client";

import { useUser } from "@clerk/nextjs";
import { useState } from "react";

type Props = {
  variant?: "default" | "header";
};

export function ConnectGitHubButton({ variant = "default" }: Props) {
  const { user, isLoaded } = useUser();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLoaded || !user) return null;

  const githubAccount = user.externalAccounts.find((a) => a.provider === "github");
  const hasRepoScope = githubAccount?.approvedScopes?.split(/\s+/).includes("repo") ?? false;

  if (variant === "header" && hasRepoScope) {
    return (
      <span
        title="GitHub private repository access is enabled"
        className="flex h-6 items-center gap-1.5 rounded border border-line bg-canvas px-2 font-mono text-[11px] text-fg-muted"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Private repos
      </span>
    );
  }

  async function handleConnect() {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const redirectUrl = window.location.href;
      const account = githubAccount
        ? await githubAccount.reauthorize({ additionalScopes: ["repo"], redirectUrl })
        : await user.createExternalAccount({ strategy: "oauth_github", redirectUrl, additionalScopes: ["repo"] });

      const url = account.verification?.externalVerificationRedirectURL;
      if (url) {
        window.location.href = url.toString();
        return;
      }
      setError("GitHub redirect URL was not returned by Clerk.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start GitHub connection.");
    } finally {
      setLoading(false);
    }
  }

  if (variant === "header") {
    return (
      <button
        type="button"
        onClick={handleConnect}
        disabled={loading}
        title={error ?? "Optional: connect GitHub with repo access to analyse your private repositories"}
        className="h-6 rounded border border-line bg-canvas px-2 text-xs text-fg-muted transition-colors hover:border-fg-muted hover:text-fg disabled:opacity-60"
      >
        {loading ? "Connecting…" : githubAccount ? "Enable private repos" : "Connect GitHub"}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <button
          type="button"
          onClick={handleConnect}
          disabled={loading}
          className="h-6 rounded bg-accent px-2.5 text-xs font-medium text-accent-fg disabled:opacity-60"
        >
          {loading
            ? "Connecting…"
            : hasRepoScope
              ? "Reconnect GitHub"
              : githubAccount
                ? "Grant GitHub private repo access"
                : "Login / Connect with GitHub"}
        </button>
      </div>
      {error && <p className="text-xs text-fg-muted">{error}</p>}
    </div>
  );
}

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import React from "https://esm.sh/react";

/**
 * Regex for validating Instagram usernames
 */
const INSTAGRAM_USERNAME_REGEX = /^(?!\d+$)(?!.*[_.]{2})(?!\.)(?!.*\.$)[a-z\d_.]+$/;

Deno.serve(async (req) => {
  const { username } = await req.json()

  // Format username
  const usernameFormatted = username.toLowerCase().replace(/^@+/, "");

  // Validate username
  const validated = INSTAGRAM_USERNAME_REGEX.test(usernameFormatted);
  if (!validated) {
    return new Response(JSON.stringify({ error: "Invalid Instagram username" }), { status: 400 });
  }

  // Initialize Supabase client (service role for upsert)
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  // Try cache first (TTL 6 hours)
  const now = Date.now();
  const ttlMs = 6 * 60 * 60 * 1000;
  const { data: cached, error: cacheReadError } = await supabase
    .from("instagram_profiles")
    .select("profile, fetched_at")
    .eq("username", usernameFormatted)
    .maybeSingle();

  if (!cacheReadError && cached?.profile && cached?.fetched_at) {
    const fetchedAtMs = new Date(cached.fetched_at as string).getTime();
    const isFresh = now - fetchedAtMs < ttlMs;
    if (isFresh) {
      return new Response(
        JSON.stringify({ username: usernameFormatted, profile: cached.profile, cached: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // Fetch Instagram profile from the web
  const profile = await fetchInstagramProfileFromWeb(usernameFormatted);
  if (!profile) {
    return new Response(
      JSON.stringify({ error: "Could not fetch Instagram profile" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  // Cache profile in Supabase DB (best-effort)
  const { error: upsertError } = await supabase
    .from("instagram_profiles")
    .upsert({
      username: usernameFormatted,
      profile,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "username" });

  // Return profile
  return new Response(
    JSON.stringify({ username: usernameFormatted, profile, cached: false, cacheError: upsertError?.message ?? null }),
    { headers: { "Content-Type": "application/json" } },
  )
})
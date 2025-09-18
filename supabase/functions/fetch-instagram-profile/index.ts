import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Regex for validating Instagram usernames
 */
const INSTAGRAM_USERNAME_REGEX = /^(?!\d+$)(?!.*[_.]{2})(?!\.)(?!.*\.$)[a-z\d_.]+$/;

interface HikerApiProfilePayload {
  pk: number;
  username: string;
  is_private: boolean;
  is_verified: boolean;
  is_business: boolean;
  full_name: string | null;
  profile_pic_url: string | null;
  biography: string | null;
  external_url: string | null;
}

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
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Try cache first (TTL 30 days)
  const now = Date.now();
  const ttlMs = 30 * 24 * 60 * 60 * 1000;
  const { data: cached, error: cacheReadError } = await supabase
    .from("instagram_profiles")
    .select("*")
    .eq("username", usernameFormatted)
    .maybeSingle();

  // If cached, return the profile
  if (cached) {
    // Check if the profile is fresh
    const updatedAtMs = new Date(cached.updated_at as string).getTime();
    const isFresh = now - updatedAtMs < ttlMs;
    if (isFresh) {
      return new Response(
        JSON.stringify({ ...cached, cached: true }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // If cache read error, log it
  if (cacheReadError) {
    console.error("cacheReadError", cacheReadError);
  }

  // Fetch Instagram profile from the web
  let profile: HikerApiProfilePayload | null;
  try {
    profile = await fetchProfile(usernameFormatted);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // If profile is not found, return 404
  if (!profile) {
    return new Response(
      JSON.stringify({ error: "Instagram profile not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Cache profile in Supabase DB (best-effort)
  await supabase
    .from("instagram_profiles")
    .upsert({
      pk: profile.pk,
      username: usernameFormatted,
      full_name: profile.full_name,
      profile_pic_url: profile.profile_pic_url,
      biography: profile.biography,
      external_url: profile.external_url,
      is_private: profile.is_private,
      is_verified: profile.is_verified,
      is_business: profile.is_business,
      updated_at: new Date().toISOString(),
    }, { onConflict: "pk" });

  // Return profile
  return new Response(
    JSON.stringify(profile),
    { headers: { "Content-Type": "application/json" } },
  )
})

/**
 * Fetches an Instagram profile from the web
 * @param username - The username of the Instagram profile to fetch
 * @returns The profile data
 */
async function fetchProfile(username: string): Promise<HikerApiProfilePayload | null> {
  const res = await fetch(
    `https://api.hikerapi.com/v1/user/by/username?username=${encodeURIComponent(username)}`,
    {
      headers: {
        accept: "application/json",
        "x-access-key": Deno.env.get("HIKER_API_KEY")!,
      }
    }
  );
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch Instagram profile: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data as HikerApiProfilePayload;
}
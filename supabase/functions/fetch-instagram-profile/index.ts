import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "node:console";

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

type InstagramProfile = Omit<HikerApiProfilePayload, "pk" | "profile_pic_url"> & {
  id: number;
  updated_at: string;
  created_at?: string;
  profile_pic_url?: string | null;
};

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
    .maybeSingle<InstagramProfile>();

  // If cached, return the profile
  if (cached) {
    // Check if the profile is fresh
    const updatedAtMs = new Date(cached.updated_at).getTime();
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
  let profileInfo: HikerApiProfilePayload | null;
  try {
    profileInfo = await fetchProfile(usernameFormatted);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // If profile is not found, return 404
  if (!profileInfo) {
    return new Response(
      JSON.stringify({ error: "Instagram profile not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  // Create Instagram profile
  const profile: InstagramProfile = {
    id: profileInfo.pk,
    username: usernameFormatted,
    full_name: profileInfo.full_name,
    biography: profileInfo.biography,
    external_url: profileInfo.external_url,
    is_private: profileInfo.is_private,
    is_verified: profileInfo.is_verified,
    is_business: profileInfo.is_business,
    updated_at: new Date().toISOString(),
  };

  // Cache profile picture
  if (profileInfo.profile_pic_url) {
    // Download profile picture
    const profilePicture = await downloadProfilePicture(profileInfo.profile_pic_url);
    if (profilePicture) {
      // Cache profile picture
      console.log(`Caching profile picture: ${profileInfo.profile_pic_url}`);
      const {data, error} = await supabase.storage.from("instagram_profile_pictures")
        .upload(`${profile.id}/profile_pic.jpg`, profilePicture, {
            upsert: true,
          });
      if (error) {
        console.error(`Failed to cache profile picture: ${JSON.stringify(error)}`);
      } else {
        // Get public URL
        const {data: {publicUrl}} = supabase.storage.from("instagram_profile_pictures").getPublicUrl(data.path);
        profile.profile_pic_url = publicUrl;
      }
    }
  }

  // Cache profile in Supabase DB (best-effort)
  await supabase
    .from("instagram_profiles")
    .upsert<InstagramProfile>(profile, { onConflict: "id" });

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

/**
 * Downloads a profile picture from the web
 * @param url - The URL of the profile picture to download
 * @returns The profile picture data
 */
async function downloadProfilePicture(url: string): Promise<Blob | null> {
  console.log(`Downloading profile picture: ${url}`);
  const res = await fetch(url);
  console.log(`Profile picture downloaded: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.error(`Failed to download profile picture: ${res.status} ${res.statusText}`);
    return null;
  }
  return await res.blob();
}
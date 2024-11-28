import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

/**
 * Creates a new Turso client instance.
 * @returns {Object} Turso client.
 */
const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
};

/**
 * Obtains the necessary CORS headers for responses.
 * @returns {Object} CORS headers.
 */
const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("CRON_JOB_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

/**
 * Validates the API key provided in the headers.
 * @param {string|null} apiKey - API key to validate.
 * @throws {Error} If the API key is not valid.
 */
const validateApiKey = (apiKey) => {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("CRON_JOB_KEY")) {
    throw new Error("Invalid API key");
  }
};

/**
 * Handles incoming requests to keep the database alive.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response indicating success or error.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const turso = createTursoClient();

  try {
    if (request.method !== "GET") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    await turso.execute({
      sql: `SELECT 1`,
      args: [],
    });

    return new Response(
      JSON.stringify({ status: "Request processed correctly..." }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("[ERROR] failed:", error);

    return new Response(JSON.stringify({ error: "Failed..." }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } finally {
    if (turso) {
      try {
        await turso.close();
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", {
          name: closeError.name,
          message: closeError.message,
        });
      }
    }
  }
};

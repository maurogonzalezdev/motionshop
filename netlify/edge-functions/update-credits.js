// update-credits.js
import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
};

const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

const validateApiKey = (apiKey) => {
  const expectedKey = Deno.env.get("API_KEY");
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== expectedKey) {
    throw new Error("Invalid API key");
  }
};

const validateRequestData = (requestData) => {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid request data");
  }

  const { user_id, credits } = requestData;

  if (user_id === undefined || user_id === null) {
    throw new Error("user_id is required");
  }

  const sanitizedUserId = parseInt(user_id, 10);

  if (isNaN(sanitizedUserId)) {
    throw new Error("Invalid user_id");
  }

  if (credits === undefined || credits === null) {
    throw new Error("credits is required");
  }

  const sanitizedCredits = parseFloat(credits);

  if (isNaN(sanitizedCredits) || sanitizedCredits < 0) {
    throw new Error("Invalid credits amount");
  }

  return { user_id: sanitizedUserId, credits: sanitizedCredits };
};

const updateUserCredits = async (turso, userId, newCredits) => {
  const tx = await turso.transaction();

  try {
    const userResponse = await tx.execute({
      sql: `SELECT id, credits FROM users WHERE user_id = ?`,
      args: [userId],
    });

    if (!userResponse.rows.length) {
      throw new Error("User not found");
    }

    const user = userResponse.rows[0];

    if (newCredits < 0) {
      throw new Error("Credits cannot be negative");
    }

    await tx.execute({
      sql: `UPDATE users SET credits = ?, edited_at = datetime('now') WHERE id = ?`,
      args: [newCredits, user.id],
    });

    await tx.execute({
      sql: `
        INSERT INTO users_audit (user_id, action_type, old_values, new_values) 
        VALUES (?, 'UPDATE', ?, ?)
      `,
      args: [
        user.id,
        JSON.stringify({ credits: user.credits }),
        JSON.stringify({ credits: newCredits }),
      ],
    });

    await tx.commit();

    console.log(
      `[INFO] Créditos actualizados para user_id: ${userId}, nuevos créditos: ${newCredits}`
    );

    return { user_id: userId, credits: newCredits };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData;

  try {
    if (request.method !== "PUT") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();
    const { user_id, credits } = validateRequestData(requestData);

    const turso = createTursoClient();

    const updatedUser = await updateUserCredits(turso, user_id, credits);

    return new Response(
      JSON.stringify({
        message: "Credits updated successfully",
        user: updatedUser,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("[ERROR] update-credits failed:", {
      error: error.message,
      requestData: requestData || "Unknown",
    });

    let status = 500;
    if (
      error.message === "API key is required" ||
      error.message === "Invalid API key"
    ) {
      status = 403;
    } else if (error.message === "Method not allowed") {
      status = 405;
    } else if (
      error.message === "user_id is required" ||
      error.message === "Invalid user_id" ||
      error.message === "credits is required" ||
      error.message === "Invalid credits amount" ||
      error.message === "Credits cannot be negative" ||
      error.message === "Invalid request data"
    ) {
      status = 400;
    } else if (error.message === "User not found") {
      status = 404;
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};

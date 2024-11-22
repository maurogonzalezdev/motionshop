// get-user-inventory.js
import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

const createTursoClient = () => {
  return createClient({
    url: Deno.env.get("TURSO_URL"),
    authToken: Deno.env.get("TURSO_AUTH_TOKEN"),
  });
};

/**
 * @returns {Object} CORS
 */
const getCorsHeaders = () => {
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

/**
 * @param {string|null} apiKey
 */
const validateApiKey = (apiKey) => {
  const expectedKey = Deno.env.get("API_KEY");
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== expectedKey) {
    throw new Error("Invalid API key");
  }
};

/**
 * @param {URL} url
 * @returns {void}
 */
const validateUrlParams = (url) => {
  const allowedParams = ["user_id"];
  for (const param of url.searchParams.keys()) {
    if (!allowedParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}`);
    }
  }
};

/**
 * @param {string|null} userId
 */
const validateUserId = (userId) => {
  if (!userId) {
    throw new Error("user_id is required");
  }
  const sanitizedUserId = parseInt(userId, 10);
  if (isNaN(sanitizedUserId)) {
    throw new Error("Invalid user_id");
  }
  return sanitizedUserId;
};

const registerUser = async (turso, userId) => {
  // Insert new user with 100 credits
  await turso.execute({
    sql: `INSERT INTO users (user_id, credits) VALUES (?, 100)`,
    args: [userId],
  });

  const userRecord = await turso.execute({
    sql: `SELECT id FROM users WHERE user_id = ?`,
    args: [userId],
  });

  const generatedId = userRecord.rows[0]?.id;

  if (!generatedId) {
    throw new Error("Failed to retrieve generated user ID");
  }

  await turso.execute({
    sql: `INSERT INTO users_audit (user_id, action_type, new_values) VALUES (?, 'INSERT', ?)`,
    args: [generatedId, JSON.stringify({ user_id: userId, credits: 100 })],
  });

  console.log(`[INFO] Usuario registrado: ${userId} con 100 créditos`);

  return { id: generatedId, user_id: userId, credits: 100 };
};

const getUserData = async (turso, userId) => {
  const userResponse = await turso.execute({
    sql: `
      SELECT id, user_id, credits 
      FROM users 
      WHERE user_id = ?
    `,
    args: [userId],
  });

  let user;

  if (!userResponse.rows.length) {
    user = await registerUser(turso, userId);

    return { user_id: user.user_id, credits: user.credits, inventory: [] };
  } else {
    user = userResponse.rows[0];
  }

  const inventoryResponse = await turso.execute({
    sql: `
      SELECT items.id, items.name, items.description, items.price, items.image, inventory.quantity
      FROM inventory
      INNER JOIN items ON inventory.item_id = items.id
      WHERE inventory.user_id = ?
    `,
    args: [user.id],
  });

  return {
    user_id: user.user_id,
    credits: user.credits,
    inventory: inventoryResponse.rows,
  };
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (request.method !== "GET") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const url = new URL(request.url);
    validateUrlParams(url);

    const userIdParam = url.searchParams.get("user_id");
    const userId = validateUserId(userIdParam);

    const turso = createTursoClient();

    // Obtain user data
    const userData = await getUserData(turso, userId);

    console.log(`[INFO] get-user-inventory successful for user_id: ${userId}`);

    return new Response(
      JSON.stringify({
        user: userData,
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
    console.error("[ERROR] get-user-inventory failed:", {
      error: error.message,
      request: request.url,
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
      error.message.includes("Invalid parameter")
    ) {
      status = 400;
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

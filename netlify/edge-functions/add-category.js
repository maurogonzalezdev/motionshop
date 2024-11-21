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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

const validateApiKey = (apiKey) => {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }
};

const validateRequestData = (requestData) => {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid request data");
  }

  const { user_id, name, image } = requestData;

  if (!user_id || !name || !image) {
    throw new Error("All fields are required: user_id, name, and image");
  }

  return { name, image, user_id };
};

const sanitizeData = (name, image) => {
  const sanitized = {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
  return sanitized;
};

const addCategory = async (turso, name, image, userId) => {
  const isActiveInt = 1;

  const tx = await turso.transaction();

  try {
    const insertResponse = await tx.execute({
      sql: "INSERT INTO categories (name, image, is_active, created_by, edited_by) VALUES (?, ?, ?, ?, ?)",
      args: [name, image, isActiveInt, userId, userId],
    });

    const newCategoryId = insertResponse.lastInsertRowid;
    if (!newCategoryId) {
      throw new Error("Failed to retrieve new category ID");
    }

    const auditValues = {
      name,
      image,
      is_active: isActiveInt,
    };

    await tx.execute({
      sql: "INSERT INTO categories_audit (category_id, user_id, action_type, old_values, new_values) VALUES (?, ?, 'INSERT', NULL, ?)",
      args: [newCategoryId, userId, JSON.stringify(auditValues)],
    });

    await tx.commit();

    return newCategoryId;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    try {
      await tx.rollback();
      console.log("[INFO] Transaction rolled back");
    } catch (rollbackError) {
      console.error("[ERROR] Rollback failed:", rollbackError);
    }
    throw error;
  }
};

const getCategoryById = async (turso, categoryId) => {
  const response = await turso.execute({
    sql: `
      SELECT id, name, image, created_at, edited_at, is_active
      FROM categories
      WHERE id = ?
    `,
    args: [categoryId],
  });

  if (!response?.rows?.length) {
    throw new Error("Category not found");
  }

  return response.rows[0];
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData;

  try {
    if (request.method !== "POST") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();

    const { name, image, user_id } = validateRequestData(requestData);

    const { sanitized_name, sanitized_image } = sanitizeData(name, image);

    const turso = createTursoClient();

    console.log("[INFO] Received add request with parameters:", {
      name: sanitized_name,
      image: sanitized_image,
      user_id,
    });

    const newCategoryId = await addCategory(
      turso,
      sanitized_name,
      sanitized_image,
      user_id
    );

    const category = await getCategoryById(turso, newCategoryId);

    console.log("[INFO] Add successful. New category:", category);

    return new Response(JSON.stringify(category), {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message === "Invalid request data") status = 400;
    if (error.message === "Failed to retrieve new category ID") status = 500;

    console.log(
      "[INFO] Add failed for category with name:",
      requestData?.name || "Unknown"
    );

    return new Response(
      JSON.stringify({
        error: error.message,
      }),
      {
        status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
};

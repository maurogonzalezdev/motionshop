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
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }
};

// Validate request data and return sanitized values
const validateRequestData = (requestData) => {
  if (!requestData || typeof requestData !== "object") {
    throw new Error("Invalid request data");
  }

  const { id, user_id, name, image, is_active } = requestData;

  if (!id || !user_id || !name || !image || is_active === undefined) {
    throw new Error(
      "All fields are required: id, user_id, name, image, and is_active"
    );
  }

  return { id, name, image, user_id, is_active };
};

const sanitizeData = (name, image) => {
  const sanitized = {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
  return sanitized;
};

const updateCategory = async (turso, id, name, image, userId, isActive) => {
  const isActiveInt = isActive ? 1 : 0;

  const oldCategoryResponse = await turso.execute({
    sql: "SELECT * FROM categories WHERE id = ?",
    args: [id],
  });

  if (!oldCategoryResponse?.rows?.length) {
    throw new Error("Category not found");
  }

  const oldCategory = oldCategoryResponse.rows[0];

  const tx = await turso.transaction();

  try {
    // Update category
    await tx.execute({
      sql: "UPDATE categories SET name = ?, image = ?, is_active = ?, edited_by = ?, edited_at = datetime('now') WHERE id = ?",
      args: [name, image, isActiveInt, userId, id],
    });

    // Prepare values for audit
    const oldValues = {
      id: oldCategory.id,
      name: oldCategory.name,
      image: oldCategory.image,
      is_active: oldCategory.is_active === 1,
      created_at: oldCategory.created_at,
      edited_at: oldCategory.edited_at,
    };

    const newValues = {
      name,
      image,
      is_active: isActiveInt,
    };

    // Insert audit record
    await tx.execute({
      sql: "INSERT INTO categories_audit (category_id, user_id, action_type, old_values, new_values) VALUES (?, ?, 'UPDATE', ?, ?)",
      args: [id, userId, JSON.stringify(oldValues), JSON.stringify(newValues)],
    });

    // Commit transaction
    await tx.commit();

    return id;
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
    if (request.method !== "PUT") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();

    const { id, name, image, user_id, is_active } =
      validateRequestData(requestData);

    const { sanitized_name, sanitized_image } = sanitizeData(name, image);

    const turso = createTursoClient();

    console.log("[INFO] Received update request with parameters:", {
      id,
      name: sanitized_name,
      image: sanitized_image,
      user_id,
      is_active,
    });

    const updatedCategoryId = await updateCategory(
      turso,
      id,
      sanitized_name,
      sanitized_image,
      user_id,
      is_active
    );

    const category = await getCategoryById(turso, updatedCategoryId);

    console.log("[INFO] Update successful. Updated category:", category);

    return new Response(JSON.stringify(category), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);

    // Set status code based on error message
    let status = 500;
    if (error.message.includes("API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message === "Invalid request data") status = 400;

    console.log(
      "[INFO] Update failed for category ID:",
      requestData?.id || "Unknown"
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

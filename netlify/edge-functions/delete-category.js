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
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
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

  const { id, user_id } = requestData;

  if (!id || !user_id) {
    throw new Error("All fields are required: id and user_id");
  }

  const sanitizedId = parseInt(id, 10);
  const sanitizedUserId = parseInt(user_id, 10);

  if (isNaN(sanitizedId) || isNaN(sanitizedUserId)) {
    throw new Error("Invalid ID or user ID");
  }

  return { id: sanitizedId, user_id: sanitizedUserId };
};

const getCategoryById = async (turso, categoryId) => {
  const response = await turso.execute({
    sql: `
      SELECT id, name, image, created_at, edited_at, is_active, is_deleted, edited_by
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
    if (request.method !== "DELETE") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();
    const { id, user_id } = validateRequestData(requestData);

    const turso = createTursoClient();
    console.log("[INFO] Received delete request with parameters:", {
      id,
      user_id,
    });

    const tx = await turso.transaction();

    try {
      // Soft delete category
      const oldCategoryResponse = await tx.execute({
        sql: "SELECT * FROM categories WHERE id = ?",
        args: [id],
      });

      if (!oldCategoryResponse?.rows?.length) {
        throw new Error("Category not found");
      }

      const oldCategory = oldCategoryResponse.rows[0];

      await tx.execute({
        sql: `UPDATE categories 
              SET is_active = 0, 
                  is_deleted = 1, 
                  edited_at = datetime('now'),
                  edited_by = ?
              WHERE id = ?`,
        args: [user_id, id],
      });

      const oldValues = {
        id: oldCategory.id,
        name: oldCategory.name,
        image: oldCategory.image,
        is_active: oldCategory.is_active === 1,
        is_deleted: oldCategory.is_deleted === 1,
        edited_by: oldCategory.edited_by,
      };

      // Log audit trail
      await tx.execute({
        sql: `INSERT INTO categories_audit 
              (category_id, user_id, action_type, old_values, new_values) 
              VALUES (?, ?, 'DELETE', ?, ?)`,
        args: [
          id,
          user_id,
          JSON.stringify(oldValues),
          JSON.stringify({
            is_active: false,
            is_deleted: true,
            edited_by: user_id,
          }),
        ],
      });

      // Commit transaction
      await tx.commit();

      const updatedCategory = await getCategoryById(turso, id);
      console.log(
        "[INFO] Soft delete successful. Category updated:",
        updatedCategory
      );

      return new Response(JSON.stringify(updatedCategory), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      console.error("[ERROR] Transaction failed:", error);
      await tx.rollback();
      throw error;
    }
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
      "[INFO] Delete failed for category ID:",
      requestData?.id || "Unknown"
    );

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};

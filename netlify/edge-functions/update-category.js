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

  const sanitizedId = parseInt(id, 10);
  const sanitizedUserId = parseInt(user_id, 10);

  if (isNaN(sanitizedId) || isNaN(sanitizedUserId)) {
    throw new Error("Invalid ID or user ID");
  }

  return { id: sanitizedId, name, image, user_id: sanitizedUserId, is_active };
};

const sanitizeData = (name, image) => {
  return {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
};

const updateCategory = async (turso, id, name, image, userId, isActive) => {
  const tx = await turso.transaction();

  try {
    const oldCategoryResponse = await tx.execute({
      sql: "SELECT * FROM categories WHERE id = ?",
      args: [id],
    });

    if (!oldCategoryResponse?.rows?.length) {
      throw new Error("Category not found");
    }

    const oldCategory = oldCategoryResponse.rows[0];

    if (oldCategory.is_deleted === 1) {
      throw new Error("Cannot update a deleted category");
    }

    const isActiveInt = isActive ? 1 : 0;

    await tx.execute({
      sql: `UPDATE categories 
            SET name = ?, 
                image = ?, 
                is_active = ?, 
                edited_by = ?,
                edited_at = datetime('now')
            WHERE id = ?`,
      args: [name, image, isActiveInt, userId, id],
    });

    const updatedCategoryResponse = await tx.execute({
      sql: `SELECT * FROM categories WHERE id = ?`,
      args: [id],
    });

    if (!updatedCategoryResponse?.rows?.length) {
      throw new Error("Failed to verify category update");
    }

    const updatedCategory = updatedCategoryResponse.rows[0];

    await tx.execute({
      sql: `INSERT INTO categories_audit 
            (category_id, user_id, action_type, old_values, new_values) 
            VALUES (?, ?, 'UPDATE', ?, ?)`,
      args: [
        id,
        userId,
        JSON.stringify({
          id: oldCategory.id,
          name: oldCategory.name,
          image: oldCategory.image,
          is_active: oldCategory.is_active === 1,
        }),
        JSON.stringify({
          name,
          image,
          is_active: isActiveInt === 1,
        }),
      ],
    });

    await tx.commit();
    return updatedCategory;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
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
    const { id, name, image, user_id, is_active } =
      validateRequestData(requestData);
    const { sanitized_name, sanitized_image } = sanitizeData(name, image);

    const turso = createTursoClient();

    console.log("[INFO] Updating category:", {
      id,
      name: sanitized_name,
      image: sanitized_image,
      user_id,
      is_active,
    });

    const category = await updateCategory(
      turso,
      id,
      sanitized_name,
      sanitized_image,
      user_id,
      is_active
    );

    console.log("[SUCCESS] Category updated successfully:", {
      id: category.id,
      name: category.name,
    });

    return new Response(JSON.stringify(category), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to update category:", {
      error: error.message,
      category: requestData?.name || "Unknown",
    });

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message === "Cannot update a deleted category") status = 400;
    if (error.message === "Invalid ID or user ID") status = 400;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};

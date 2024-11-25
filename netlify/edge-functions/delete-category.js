// delete-category.js

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
  const allowedOrigin = Deno.env.get("FORUM_URL");
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

/**
 * Validates the API key provided in the headers.
 * @param {string} apiKey - API key to validate.
 * @throws {Error} If the API key is not valid.
 */
const validateApiKey = (apiKey) => {
  if (!apiKey) {
    throw new Error("API key is required");
  }
  if (apiKey !== Deno.env.get("API_KEY")) {
    throw new Error("Invalid API key");
  }
};

/**
 * Validates the request data.
 * @param {Object} requestData - Request data.
 * @returns {Object} Sanitized data.
 * @throws {Error} If the data is not valid.
 */
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

/**
 * Soft deletes a category in the database.
 * @param {Object} turso - Turso client.
 * @param {number} id - Category ID.
 * @param {number} userId - ID of the user performing the deletion.
 * @returns {Promise<Object>} Updated category object.
 * @throws {Error} If an error occurs during the transaction.
 */
const softDeleteCategory = async (turso, id, userId) => {
  const tx = await turso.transaction();

  try {
    console.log("[INFO] Starting transaction for category ID:", id);

    const oldCategoryResponse = await tx.execute({
      sql: "SELECT * FROM categories WHERE id = ?",
      args: [id],
    });

    if (!oldCategoryResponse?.rows?.length) {
      throw new Error("Category not found");
    }

    const oldCategory = oldCategoryResponse.rows[0];
    console.log("[INFO] Found category:", oldCategory);

    if (oldCategory.is_deleted === 1) {
      throw new Error("Category is already deleted");
    }

    // Soft delete the category
    await tx.execute({
      sql: `UPDATE categories 
            SET is_active = 0, 
                is_deleted = 1, 
                edited_at = datetime('now'),
                edited_by = ?
            WHERE id = ?`,
      args: [userId, id],
    });
    console.log("[INFO] Soft deleted category ID:", id);

    // Get items that will need to be soft deleted (those with only this category)
    const itemsToDeleteResponse = await tx.execute({
      sql: `WITH ItemCategoryCounts AS (
              SELECT ic.item_id, COUNT(ic.category_id) as category_count
              FROM item_categories ic
              GROUP BY ic.item_id
            )
            SELECT DISTINCT i.id
            FROM items i
            INNER JOIN item_categories ic ON i.id = ic.item_id
            INNER JOIN ItemCategoryCounts icc ON i.id = icc.item_id
            WHERE ic.category_id = ?
            AND icc.category_count = 1
            AND i.is_deleted = 0`,
      args: [id],
    });

    console.log("[INFO] Items to be soft deleted:", itemsToDeleteResponse.rows);

    // Soft delete items that only belonged to this category
    if (itemsToDeleteResponse.rows.length > 0) {
      const itemIds = itemsToDeleteResponse.rows.map((row) => row.id);

      // Create placeholders for the IN clause
      const placeholders = itemIds.map(() => "?").join(",");

      // Get current state of items before updating them
      const itemsBeforeUpdateResponse = await tx.execute({
        sql: `SELECT id, is_active, is_deleted FROM items WHERE id IN (${placeholders})`,
        args: itemIds,
      });

      if (!itemsBeforeUpdateResponse?.rows?.length) {
        throw new Error("Items not found for soft delete");
      }

      const itemsBeforeUpdate = itemsBeforeUpdateResponse.rows;
      console.log("[INFO] Items before update:", itemsBeforeUpdate);

      // Soft delete the items using placeholders
      await tx.execute({
        sql: `UPDATE items 
              SET is_active = 0,
                  is_deleted = 1,
                  edited_at = datetime('now'),
                  edited_by = ?
              WHERE id IN (${placeholders})`,
        args: [userId, ...itemIds],
      });
      console.log("[INFO] Soft deleted items:", itemIds);

      // Add audit entries with correct old values
      for (const item of itemsBeforeUpdate) {
        await tx.execute({
          sql: `INSERT INTO items_audit 
                (item_id, user_id, action_type, old_values, new_values)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            item.id,
            userId,
            "DELETE",
            JSON.stringify({
              is_active: item.is_active === 1,
              is_deleted: item.is_deleted === 0,
            }),
            JSON.stringify({
              is_active: false,
              is_deleted: true,
            }),
          ],
        });
      }
      console.log("[INFO] Added audit entries for items:", itemIds);
    }

    // Remove all category associations for this category
    await tx.execute({
      sql: `DELETE FROM item_categories WHERE category_id = ?`,
      args: [id],
    });
    console.log("[INFO] Removed category associations for category ID:", id);

    // Add category audit entry with more detailed information
    await tx.execute({
      sql: `INSERT INTO categories_audit 
            (category_id, user_id, action_type, old_values, new_values)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        id,
        userId,
        "DELETE",
        JSON.stringify({
          id: oldCategory.id,
          name: oldCategory.name,
          image: oldCategory.image,
          is_active: oldCategory.is_active === 1,
          is_deleted: oldCategory.is_deleted === 0,
          created_at: oldCategory.created_at,
          edited_at: oldCategory.edited_at,
          created_by: oldCategory.created_by,
          edited_by: oldCategory.edited_by,
        }),
        JSON.stringify({
          is_active: false,
          is_deleted: true,
          edited_by: userId,
          edited_at: new Date().toISOString(),
        }),
      ],
    });
    console.log("[INFO] Added audit entry for category ID:", id);

    await tx.commit();
    console.log("[INFO] Transaction committed for category ID:", id);
    return oldCategory;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to delete a category.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing the updated category data or an error message.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let requestData;
  const turso = createTursoClient();

  try {
    if (request.method !== "DELETE") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();
    const { id, user_id } = validateRequestData(requestData);

    console.log("[INFO] Received delete request:", { id, user_id });

    const category = await softDeleteCategory(turso, id, user_id);

    console.log("[SUCCESS] Category soft deleted:", {
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
    console.error("[ERROR] Operation failed:", error);

    let status = 500;
    if (error.message.includes("API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Category not found") status = 404;
    if (error.message === "Category is already deleted") status = 400;
    if (error.message === "Invalid ID or user ID") status = 400;

    console.log(
      "[ERROR] Delete failed for category ID:",
      requestData?.id || "Unknown"
    );

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } finally {
    if (turso) {
      try {
        // Close connection without parameters
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

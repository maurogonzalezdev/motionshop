// delete-item.js

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
 * Soft deletes an item in the database.
 * @param {Object} turso - Turso client.
 * @param {number} id - Item ID.
 * @param {number} userId - ID of the user performing the deletion.
 * @returns {Promise<Object>} Updated item object.
 * @throws {Error} If an error occurs during the transaction.
 */
const softDeleteItem = async (turso, id, userId) => {
  const tx = await turso.transaction();

  try {
    // Retrieve the existing item
    const oldItemResponse = await tx.execute({
      sql: "SELECT * FROM items WHERE id = ?",
      args: [id],
    });

    if (!oldItemResponse?.rows?.length) {
      throw new Error("Item not found");
    }

    const oldItem = oldItemResponse.rows[0];

    if (oldItem.is_deleted === 1) {
      throw new Error("Item is already deleted");
    }

    // Soft delete the item
    await tx.execute({
      sql: `UPDATE items 
            SET is_active = 0, 
                is_deleted = 1, 
                edited_at = datetime('now'),
                edited_by = ?
            WHERE id = ?`,
      args: [userId, id],
    });

    // Retrieve the updated item
    const updatedItemResponse = await tx.execute({
      sql: `SELECT * FROM items WHERE id = ?`,
      args: [id],
    });

    if (!updatedItemResponse?.rows?.length) {
      throw new Error("Failed to verify item update");
    }

    const updatedItem = updatedItemResponse.rows[0];

    // Insert into audit table
    await tx.execute({
      sql: `INSERT INTO items_audit 
            (item_id, user_id, action_type, old_values, new_values) 
            VALUES (?, ?, 'DELETE', ?, ?)`,
      args: [
        id,
        userId,
        JSON.stringify({
          id: oldItem.id,
          name: oldItem.name,
          description: oldItem.description,
          price: oldItem.price,
          image: oldItem.image,
          is_active: oldItem.is_active === 1,
          is_deleted: oldItem.is_deleted === 1,
          created_at: oldItem.created_at,
          edited_at: oldItem.edited_at,
          created_by: oldItem.created_by,
          edited_by: oldItem.edited_by,
        }),
        JSON.stringify({
          is_active: false,
          is_deleted: true,
          edited_by: userId,
          edited_at: new Date().toISOString(),
        }),
      ],
    });

    await tx.commit();
    return updatedItem;
  } catch (error) {
    console.error("[ERROR] Transaction failed:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles incoming requests to delete an item.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing the updated item data or an error message.
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

    const item = await softDeleteItem(turso, id, user_id);

    console.log("[SUCCESS] Item soft deleted:", {
      id: item.id,
      name: item.name,
    });

    return new Response(JSON.stringify(item), {
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
    if (error.message === "Item not found") status = 404;
    if (error.message === "Item is already deleted") status = 400;
    if (error.message === "Invalid ID or user ID") status = 400;

    console.log(
      "[ERROR] Delete failed for item ID:",
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
        await turso.execute({ type: "close" });
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", closeError);
      }
    }
  }
};

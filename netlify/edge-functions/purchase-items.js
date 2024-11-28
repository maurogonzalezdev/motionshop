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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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
 * Validates the purchase request data.
 * @param {Object} data - The purchase request data.
 * @throws {Error} If the data is invalid.
 */
const validatePurchaseData = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid request data");
  }

  const { user_id, items } = data;

  if (!user_id || !items || !Array.isArray(items) || items.length === 0) {
    throw new Error("Invalid purchase data structure");
  }

  items.forEach((item, index) => {
    if (!item.item_id || !item.quantity || !item.price) {
      throw new Error(`Invalid item data at position ${index}`);
    }
    if (item.quantity <= 0) {
      throw new Error(`Invalid quantity for item at position ${index}`);
    }
    if (item.price <= 0) {
      throw new Error(`Invalid price for item at position ${index}`);
    }
  });
};

/**
 * Verifies that the user has sufficient credits for the purchase.
 * @param {Object} turso - Turso client instance.
 * @param {number} userId - User ID.
 * @param {number} totalAmount - Total purchase amount.
 * @returns {Promise<number>} Current user credits.
 * @throws {Error} If user has insufficient credits.
 */
const verifyUserCredits = async (turso, userId, totalAmount) => {
  const userResponse = await turso.execute({
    sql: "SELECT credits FROM users WHERE user_id = ?",
    args: [userId],
  });

  if (!userResponse.rows.length) {
    throw new Error("User not found");
  }

  const userCredits = Number(userResponse.rows[0].credits);
  if (userCredits < totalAmount) {
    throw new Error("Insufficient credits");
  }

  return userCredits;
};

/**
 * Verifies that all items exist and are active.
 * @param {Object} turso - Turso client instance.
 * @param {Array} items - Array of items to verify.
 * @throws {Error} If any item is invalid.
 */
const verifyItems = async (turso, items) => {
  const itemIds = items.map(item => item.item_id);
  const placeholders = itemIds.map(() => "?").join(",");
  
  const response = await turso.execute({
    sql: `SELECT id, price, is_active, is_deleted FROM items WHERE id IN (${placeholders})`,
    args: itemIds,
  });

  const foundItems = response.rows;
  if (foundItems.length !== itemIds.length) {
    throw new Error("One or more items not found");
  }

  foundItems.forEach(item => {
    if (!item.is_active || item.is_deleted) {
      throw new Error(`Item ${item.id} is not available for purchase`);
    }
  });
};

/**
 * Processes the purchase transaction.
 * @param {Object} turso - Turso client instance.
 * @param {number} userId - User ID.
 * @param {Array} items - Items to purchase.
 * @param {number} userCredits - Current user credits.
 * @returns {Promise<Object>} Purchase result.
 */
const processPurchaseTransaction = async (turso, userId, items, userCredits) => {
  const tx = await turso.transaction();
  try {
    const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const creditsAfter = userCredits - totalAmount;

    // Create purchase transaction
    const transactionResponse = await tx.execute({
      sql: `INSERT INTO purchase_transactions 
            (user_id, credits_before, credits_after, total_credits_spent) 
            VALUES (?, ?, ?, ?)`,
      args: [userId, userCredits, creditsAfter, totalAmount],
    });

    const transactionId = Number(transactionResponse.lastInsertRowid);

    // Record purchased items and update inventory
    for (const item of items) {
      // Registro de items comprados
      await tx.execute({
        sql: `INSERT INTO purchase_items 
              (transaction_id, item_id, quantity, item_price) 
              VALUES (?, ?, ?, ?)`,
        args: [transactionId, item.item_id, item.quantity, item.price],
      });

      // Verificar si el item existe y obtener información actual del inventario
      const inventoryCheck = await tx.execute({
        sql: `SELECT total_quantity, quantity_in_bag 
              FROM inventory 
              WHERE user_id = ? AND item_id = ?`,
        args: [userId, item.item_id],
      });

      if (inventoryCheck.rows.length > 0) {
        // Actualizar cantidad existente
        const currentQuantity = Number(inventoryCheck.rows[0].total_quantity);
        await tx.execute({
          sql: `UPDATE inventory 
                SET total_quantity = ?,
                    last_updated = datetime('now')
                WHERE user_id = ? AND item_id = ?`,
          args: [currentQuantity + item.quantity, userId, item.item_id],
        });
      } else {
        // Crear nuevo registro en inventario
        await tx.execute({
          sql: `INSERT INTO inventory 
                (user_id, item_id, total_quantity, quantity_in_bag, last_updated) 
                VALUES (?, ?, ?, 0, datetime('now'))`,
          args: [userId, item.item_id, item.quantity],
        });
      }
    }

    // Update user credits
    await tx.execute({
      sql: "UPDATE users SET credits = ? WHERE user_id = ?",
      args: [creditsAfter, userId],
    });

    // Create audit record
    await tx.execute({
      sql: `INSERT INTO purchases_audit 
            (transaction_id, user_id, credits_before, credits_after, 
             total_credits_spent, items_purchased)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        transactionId,
        userId,
        userCredits,
        creditsAfter,
        totalAmount,
        JSON.stringify(items),
      ],
    });

    await tx.commit();

    return {
      transaction_id: transactionId,
      credits_spent: totalAmount,
      credits_remaining: creditsAfter,
      items_purchased: items.length,
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

/**
 * Handles purchase requests.
 * @param {Request} request - The incoming request.
 * @returns {Promise<Response>} The response.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const turso = createTursoClient();

  try {
    if (request.method !== "POST") {
      throw new Error("Method not allowed");
    }

    validateApiKey(request.headers.get("X-API-KEY"));

    const data = await request.json();
    validatePurchaseData(data);

    const totalAmount = data.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    const userCredits = await verifyUserCredits(turso, data.user_id, totalAmount);
    await verifyItems(turso, data.items);

    const result = await processPurchaseTransaction(
      turso,
      data.user_id,
      data.items,
      userCredits
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Purchase failed:", error);

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("Invalid request data")) status = 400;
    if (error.message.includes("Insufficient credits")) status = 400;
    if (error.message.includes("User not found")) status = 404;
    if (error.message.includes("One or more items not found")) status = 404;
    if (error.message === "Method not allowed") status = 405;

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
        await turso.close();
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", closeError);
      }
    }
  }
};

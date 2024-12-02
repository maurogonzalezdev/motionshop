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
 * Validates the update inventory data.
 * @param {Object} data - The request data.
 * @throws {Error} If the data is invalid.
 */
const validateInventoryData = (data) => {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid request data");
  }

  const { user_id, inventory, bag } = data;

  if (!user_id || !Array.isArray(inventory) || !Array.isArray(bag)) {
    throw new Error("Invalid data structure");
  }

  // Validate inventory items
  for (const item of inventory) {
    if (!item.item_id || typeof item.quantity !== "number") {
      throw new Error("Invalid inventory item data");
    }
  }

  // Validate bag items
  for (const item of bag) {
    if (!item.item_id || typeof item.quantity !== "number") {
      throw new Error("Invalid bag item data");
    }
  }
};

/**
 * Processes the inventory and bag update transaction.
 * @param {Object} turso - Turso client instance.
 * @param {number} userId - User ID.
 * @param {Array} inventory - Inventory items.
 * @param {Array} bag - Bag items.
 * @returns {Promise<Object>} Update result.
 */
const processInventoryUpdate = async (turso, userId, inventory, bag) => {
  // Agregar registros de depuración
  console.log(`Procesando actualización de inventario para user_id: ${userId}`);
  console.log('Inventario recibido:', inventory);
  console.log('Bolsa recibida:', bag);

  const tx = await turso.transaction();
  try {
    console.log(`Processing inventory update for user_id: ${userId}`);
    console.log('Inventory data:', inventory);
    console.log('Bag data:', bag);

    // Clear existing inventory for the user
    await tx.execute({
      sql: `DELETE FROM inventory WHERE user_id = ?`,
      args: [userId],
    });

    // Process inventory items first
    for (const item of inventory) {
      const totalQuantity = parseInt(item.quantity, 10);
      const bagItem = bag.find(b => b.item_id === item.item_id);
      const quantityInBag = bagItem ? parseInt(bagItem.quantity, 10) : 0;

      // Validar cantidades
      if (isNaN(totalQuantity) || totalQuantity < 0) {
        throw new Error(`Invalid total quantity for item_id ${item.item_id}`);
      }
      if (isNaN(quantityInBag) || quantityInBag < 0) {
        throw new Error(`Invalid bag quantity for item_id ${item.item_id}`);
      }
      if (quantityInBag > totalQuantity) {
        throw new Error(`Bag quantity (${quantityInBag}) exceeds total quantity (${totalQuantity}) for item_id ${item.item_id}`);
      }

      // Insertar en inventario
      await tx.execute({
        sql: `
          INSERT INTO inventory 
          (user_id, item_id, total_quantity, quantity_in_bag, last_updated)
          VALUES (?, ?, ?, ?, datetime('now'))
        `,
        args: [
          userId,
          item.item_id,
          totalQuantity,
          quantityInBag
        ],
      });

      console.log(`Updated item ${item.item_id}: total=${totalQuantity}, inBag=${quantityInBag}`);
    }

    await tx.commit();
    console.log(`Inventory update successful for user_id: ${userId}`);
    return { message: "Inventario y bolsa actualizados correctamente." };
  } catch (error) {
    console.error("[ERROR] Failed to process inventory update:", error);
    await tx.rollback();
    throw error;
  }
};

/**
 * Gets the total quantity of an item for a user.
 * @param {Object} tx - Turso transaction instance.
 * @param {number} userId - User ID.
 * @param {number} itemId - Item ID.
 * @returns {Promise<number>} Total quantity of the item.
 */
const getTotalQuantity = async (tx, userId, itemId) => {
  const response = await tx.execute({
    sql: `SELECT total_quantity FROM inventory WHERE user_id = ? AND item_id = ?`,
    args: [userId, itemId],
  });

  if (response.rows.length > 0) {
    return Number(response.rows[0].total_quantity);
  } else {
    return 0;
  }
};

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
    validateInventoryData(data);

    const result = await processInventoryUpdate(
      turso,
      data.user_id,
      data.inventory,
      data.bag
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Inventory update failed:", error);

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("Invalid request data")) status = 400;
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
        console.error(
          "[ERROR] Failed to close Turso connection:",
          closeError
        );
      }
    }
  }
};
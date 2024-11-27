import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";

// Duplicar funciones utilitarias necesarias
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

const validateApiKey = (apiKey) => {
  if (!apiKey) throw new Error("API key is required");
  if (apiKey !== Deno.env.get("API_KEY")) throw new Error("Invalid API key");
};

const validateUserId = (userId) => {
  if (!userId || isNaN(Number(userId))) throw new Error("Invalid user ID");
};

const validateUserIds = (userIds) => {
  if (!userIds || !Array.isArray(userIds))
    throw new Error("Invalid user IDs format");
  userIds.forEach((id) => {
    if (isNaN(Number(id))) throw new Error("Invalid user ID format");
  });
};

const registerNewUser = async (turso, userId) => {
  const tx = await turso.transaction();
  try {
    // Insert new user with initial 100 credits
    await tx.execute({
      sql: `INSERT INTO users (user_id, credits) VALUES (?, 100)`,
      args: [userId],
    });

    // Add audit record
    await tx.execute({
      sql: `INSERT INTO users_audit (user_id, action_type, new_values)
            VALUES (?, 'INSERT', ?)`,
      args: [userId, JSON.stringify({ user_id: userId, credits: 100 })],
    });

    // Retrieve the newly inserted user
    const userResult = await tx.execute({
      sql: `SELECT * FROM users WHERE user_id = ?`,
      args: [userId],
    });

    if (userResult.rows.length === 0) {
      throw new Error("Failed to register new user");
    }

    await tx.commit();

    const user = userResult.rows[0];
    return {
      id: user.id,
      user_id: user.user_id,
      credits: user.credits,
      inventory: [],
      bag: [],
    };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

const registerNewUsers = async (turso, userIds) => {
  const tx = await turso.transaction();
  try {
    const newUsers = [];
    for (const userId of userIds) {
      // Attempt to insert new user
      const insertResponse = await tx.execute({
        sql: `INSERT INTO users (user_id, credits) 
              SELECT ?, 100 
              WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = ?)`, // Changed from 1000 to 100
        args: [userId, userId],
      });

      if (insertResponse.rowsAffected > 0) {
        // Add audit record
        await tx.execute({
          sql: `INSERT INTO users_audit (user_id, action_type, new_values)
                VALUES (?, 'INSERT', ?)`,
          args: [userId, JSON.stringify({ user_id: userId, credits: 100 })],
        });

        // Obtener datos del usuario recién creado
        await tx.execute({
          sql: `SELECT * FROM users WHERE user_id = ?`,
          args: [userId],
        });

        newUsers.push({
          user_id: userId,
          credits: 100,
          inventory: [],
          bag: [],
        });
      }
    }

    await tx.commit();
    return newUsers;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
};

const getInventory = async (turso, userId) => {
  let userResult = await turso.execute({
    sql: `SELECT * FROM users WHERE user_id = ?`,
    args: [userId],
  });

  if (!userResult.rows.length) {
    return await registerNewUser(turso, userId);
  }

  const user = userResult.rows[0];

  // Get all inventory items including bag quantities
  const inventoryResult = await turso.execute({
    sql: `
      SELECT 
        i.id, i.name, i.description, i.price, i.image,
        inv.total_quantity, inv.quantity_in_bag
      FROM items i
      INNER JOIN inventory inv ON i.id = inv.item_id
      WHERE inv.user_id = ? 
      AND i.is_deleted = 0
      ORDER BY i.name ASC
    `,
    args: [user.id],
  });

  // Get categories for all items
  const itemIds = inventoryResult.rows.map((item) => item.id);
  const categoriesResult = itemIds.length
    ? await turso.execute({
        sql: `
      SELECT c.id, c.name, c.image, ic.item_id
      FROM categories c
      INNER JOIN item_categories ic ON c.id = ic.category_id
      WHERE ic.item_id IN (${itemIds.join(",")}) AND c.is_deleted = 0
    `,
        args: [],
      })
    : { rows: [] };

  // Create categories lookup
  const categoriesByItem = {};
  categoriesResult.rows.forEach((cat) => {
    if (!categoriesByItem[cat.item_id]) categoriesByItem[cat.item_id] = [];
    categoriesByItem[cat.item_id].push({
      id: cat.id,
      name: cat.name,
      image: cat.image,
    });
  });

  // Process inventory items
  const inventory = inventoryResult.rows.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    image: item.image,
    total_quantity: item.total_quantity,
    quantity_in_bag: item.quantity_in_bag,
    categories: categoriesByItem[item.id] || [],
  }));

  return {
    id: user.id,
    user_id: user.user_id,
    credits: user.credits,
    inventory,
    bag: inventory.filter((item) => item.quantity_in_bag > 0),
  };
};

const getInventories = async (turso, userIds) => {
  // Register any new users first
  const newUsers = await registerNewUsers(turso, userIds);

  // Get all users' inventories in parallel
  const inventoryPromises = userIds.map((userId) =>
    getInventory(turso, parseInt(userId))
  );
  const inventories = await Promise.all(inventoryPromises);

  // Convert array to object with user_id as key
  return inventories.reduce((acc, inv) => {
    acc[inv.user_id] = inv;
    return acc;
  }, {});
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();
  if (request.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  const turso = createTursoClient();

  try {
    if (request.method !== "GET") throw new Error("Method not allowed");

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const url = new URL(request.url);
    const userId = url.searchParams.get("user_id");
    const userIds = url.searchParams.get("user_ids");

    let result;
    if (userId) {
      validateUserId(userId);
      result = await getInventory(turso, parseInt(userId));
    } else if (userIds) {
      const ids = userIds.split(",");
      validateUserIds(ids);
      result = await getInventories(turso, ids);
    } else {
      throw new Error("Either user_id or user_ids parameter is required");
    }

    const responseData = JSON.stringify(result);
    console.log("[DEBUG] Response data:", responseData); // Add debug log

    return new Response(responseData, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);
    const errorResponse = JSON.stringify({ error: error.message });
    console.log("[DEBUG] Error response:", errorResponse); // Add debug log

    let status = 500;
    if (error.message.includes("API key")) status = 403;
    if (error.message === "Method not allowed") status = 405;
    if (error.message.includes("Invalid user ID")) status = 400;

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
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", closeError);
      }
    }
  }
};

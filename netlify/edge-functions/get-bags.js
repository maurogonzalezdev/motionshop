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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

const validateUserId = (userId) => {
  if (!userId || isNaN(Number(userId))) {
    throw new Error("Invalid user ID");
  }
};

const validateUserIds = (userIds) => {
  if (!userIds || !Array.isArray(userIds)) {
    throw new Error("Invalid user IDs format");
  }
  userIds.forEach((id) => {
    if (isNaN(Number(id))) {
      throw new Error("Invalid user ID format");
    }
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

    await tx.commit();

    return {
      user_id: userId,
      credits: 100,
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
              WHERE NOT EXISTS (SELECT 1 FROM users WHERE user_id = ?)`,
        args: [userId, userId],
      });

      if (insertResponse.rowsAffected > 0) {
        // Obtener datos del usuario recién creado
        await tx.execute({
          sql: `SELECT * FROM users WHERE user_id = ?`,
          args: [userId],
        });

        // Registrar en la auditoría
        await tx.execute({
          sql: `INSERT INTO users_audit (user_id, action_type, new_values)
                VALUES (?, 'INSERT', ?)`,
          args: [userId, JSON.stringify({ user_id: userId, credits: 100 })],
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

const getBag = async (turso, userId) => {
  // Check if user exists or register
  let userResult = await turso.execute({
    sql: `SELECT * FROM users WHERE user_id = ?`,
    args: [userId],
  });

  if (!userResult.rows.length) {
    return await registerNewUser(turso, userId);
  }

  const user = userResult.rows[0];

  // Get only bag items
  const bagResult = await turso.execute({
    sql: `
      SELECT 
        i.id, i.name, i.description, i.price, i.image,
        inv.quantity_in_bag
      FROM items i
      INNER JOIN inventory inv ON i.id = inv.item_id
      WHERE inv.user_id = ? 
      AND inv.quantity_in_bag > 0 
      AND i.is_deleted = 0
      ORDER BY i.name ASC
    `,
    args: [user.id],
  });

  // Get categories for bag items only
  const itemIds = bagResult.rows.map((item) => item.id);
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

  // Process bag items
  const bag = bagResult.rows.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    image: item.image,
    quantity: item.quantity_in_bag,
    categories: categoriesByItem[item.id] || [],
  }));

  return {
    id: user.id,
    user_id: user.user_id,
    credits: user.credits,
    bag,
  };
};

const getBags = async (turso, userIds) => {
  // Register any new users first
  const newUsers = await registerNewUsers(turso, userIds);

  // Get all users (existing + new)
  const userResult = await turso.execute({
    sql: `SELECT * FROM users WHERE user_id IN (${userIds.join(",")})`,
    args: [],
  });

  const users = [...userResult.rows, ...newUsers];

  // Get all bags in one efficient query
  const bagResult = await turso.execute({
    sql: `
      SELECT 
        u.user_id as forum_user_id,
        i.id, i.name, i.description, i.price, i.image,
        inv.quantity_in_bag
      FROM users u
      LEFT JOIN inventory inv ON u.id = inv.user_id
      LEFT JOIN items i ON inv.item_id = i.id
      WHERE u.user_id IN (${userIds.join(",")})
      AND (inv.quantity_in_bag > 0 OR inv.quantity_in_bag IS NULL)
      AND (i.is_deleted = 0 OR i.is_deleted IS NULL)
      ORDER BY u.user_id, i.name ASC
    `,
    args: [],
  });

  // Get all item IDs that are in bags
  const itemIds = [...new Set(bagResult.rows.filter(row => row.id).map(row => row.id))];
  
  // Get categories for items that exist
  const categoriesResult = itemIds.length
    ? await turso.execute({
        sql: `
          SELECT c.id, c.name, ic.item_id
          FROM categories c
          INNER JOIN item_categories ic ON c.id = ic.category_id
          WHERE ic.item_id IN (${itemIds.join(",")}) 
          AND c.is_deleted = 0
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
      name: cat.name
    });
  });

  // Process and return results
  const result = {};
  users.forEach(user => {
    const userBagItems = bagResult.rows.filter(item => 
      item.forum_user_id === user.user_id && item.id
    );

    const bag = userBagItems.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description || '',
      price: item.price,
      image: item.image,
      quantity: item.quantity_in_bag,
      categories: categoriesByItem[item.id] || []
    }));

    result[user.user_id] = {
      id: user.id,
      user_id: user.user_id,
      credits: user.credits,
      bag: bag
    };
  });

  return result;
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
      result = await getBag(turso, parseInt(userId));
    } else if (userIds) {
      const ids = userIds.split(",");
      validateUserIds(ids);
      result = await getBags(turso, ids);
    } else {
      throw new Error("Either user_id or user_ids parameter is required");
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);

    let status = 500;
    const errorMessage = error.message;

    if (errorMessage.includes("API key")) status = 403;
    if (errorMessage === "Method not allowed") status = 405;
    if (errorMessage.includes("Invalid user ID")) status = 400;

    return new Response(JSON.stringify({ error: errorMessage }), {
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
        console.error("[ERROR] Failed to close Turso connection:", {
          name: closeError.name,
          message: closeError.message,
        });
      }
    }
  }
};

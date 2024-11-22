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

  const { name, description, image, price, categories, user_id } = requestData;

  if (!name || !description || !image || !price || !categories || !user_id) {
    throw new Error(
      "All fields are required: name, description, image, price, categories, and user_id"
    );
  }

  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("Categories must be an array with at least one category");
  }

  const sanitizedPrice = parseFloat(price);
  const sanitizedUserId = parseInt(user_id, 10);
  const sanitizedCategories = categories.map((id) => parseInt(id, 10));

  if (isNaN(sanitizedPrice) || isNaN(sanitizedUserId)) {
    throw new Error("Invalid price or user ID");
  }

  if (sanitizedCategories.some((id) => isNaN(id))) {
    throw new Error("Invalid category ID format");
  }

  if (sanitizedPrice < 0) {
    throw new Error("Price cannot be negative");
  }

  return {
    name,
    description,
    image,
    price: sanitizedPrice,
    categories: sanitizedCategories,
    user_id: sanitizedUserId,
  };
};

const sanitizeData = (name, description, image) => {
  return {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_description: String(description).replace(/[^a-zA-Z0-9 .,]/g, ""),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
};

const validateCategoriesExist = async (turso, categories) => {
  const placeholders = categories.map(() => "?").join(",");
  const response = await turso.execute({
    sql: `SELECT id, name FROM categories WHERE id IN (${placeholders}) AND is_deleted = 0`,
    args: categories,
  });

  if (response.rows.length !== categories.length) {
    const foundIds = response.rows.map((row) => row.id);
    const missingIds = categories.filter((id) => !foundIds.includes(id));
    throw new Error(`Categories not found: ${missingIds.join(", ")}`);
  }
};

const addItem = async (
  turso,
  name,
  description,
  image,
  price,
  categories,
  userId
) => {
  const tx = await turso.transaction();
  let newItemId;

  try {
    await validateCategoriesExist(turso, categories);

    const insertResponse = await tx.execute({
      sql: `INSERT INTO items (
              name, description, price, image, 
              is_active, is_deleted, created_by, edited_by
            ) VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      args: [name, description, price, image, userId, userId],
    });

    newItemId = Number(insertResponse.lastInsertRowid);

    for (const categoryId of categories) {
      await tx.execute({
        sql: "INSERT INTO item_categories (category_id, item_id) VALUES (?, ?)",
        args: [categoryId, newItemId],
      });
    }

    const itemResponse = await tx.execute({
      sql: `SELECT * FROM items WHERE id = ?`,
      args: [newItemId],
    });

    if (!itemResponse?.rows?.length) {
      throw new Error("Failed to verify item creation");
    }

    const categoriesResponse = await tx.execute({
      sql: `SELECT category_id FROM item_categories WHERE item_id = ?`,
      args: [newItemId],
    });

    const item = itemResponse.rows[0];
    item.categories = categoriesResponse.rows.map((row) =>
      Number(row.category_id)
    );

    await tx.execute({
      sql: `INSERT INTO items_audit (
              item_id, user_id, action_type, 
              old_values, new_values
            ) VALUES (?, ?, 'INSERT', NULL, ?)`,
      args: [
        newItemId,
        userId,
        JSON.stringify({
          name,
          description,
          image,
          price,
          is_active: true,
          is_deleted: false,
          categories,
        }),
      ],
    });

    await tx.commit();
    return item;
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
    if (request.method !== "POST") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    requestData = await request.json();
    const { name, description, image, price, categories, user_id } =
      validateRequestData(requestData);
    const { sanitized_name, sanitized_description, sanitized_image } =
      sanitizeData(name, description, image);

    const turso = createTursoClient();

    console.log("[INFO] Creating item:", {
      name: sanitized_name,
      description: sanitized_description,
      image: sanitized_image,
      price,
      categories,
      user_id,
    });

    const item = await addItem(
      turso,
      sanitized_name,
      sanitized_description,
      sanitized_image,
      price,
      categories,
      user_id
    );

    console.log("[SUCCESS] Item created successfully:", {
      id: item.id,
      name: item.name,
    });

    return new Response(JSON.stringify(item), {
      status: 201,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to create item:", {
      error: error.message,
      item: requestData?.name || "Unknown",
    });

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Failed to verify item creation") status = 500;
    if (error.message === "Invalid request data") status = 400;
    if (error.message.includes("Categories not found")) status = 400;
    if (error.message === "Invalid price or user ID") status = 400;
    if (error.message === "Invalid category ID format") status = 400;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};

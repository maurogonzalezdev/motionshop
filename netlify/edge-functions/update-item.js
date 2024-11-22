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

  const { id, user_id, name, description, price, image, is_active } =
    requestData;

  if (
    !id ||
    !user_id ||
    !name ||
    !description ||
    price === undefined ||
    !image ||
    is_active === undefined
  ) {
    throw new Error(
      "All fields are required: id, user_id, name, description, price, image, and is_active"
    );
  }

  const sanitizedId = parseInt(id, 10);
  const sanitizedUserId = parseInt(user_id, 10);
  const sanitizedPrice = parseFloat(price);

  if (
    isNaN(sanitizedId) ||
    isNaN(sanitizedUserId) ||
    isNaN(sanitizedPrice) ||
    sanitizedPrice < 0
  ) {
    throw new Error("Invalid ID, user ID, or price");
  }

  return {
    id: sanitizedId,
    name,
    description,
    price: sanitizedPrice,
    image,
    user_id: sanitizedUserId,
    is_active,
  };
};

const sanitizeData = (name, description, image) => {
  return {
    sanitized_name: String(name).replace(/[^a-zA-Z0-9 ]/g, ""),
    sanitized_description: String(description).replace(
      /[^a-zA-Z0-9 .,!?]/g,
      ""
    ),
    sanitized_image: String(image).replace(/[^a-zA-Z0-9:/.]/g, ""),
  };
};

const updateItem = async (
  turso,
  id,
  name,
  description,
  price,
  image,
  userId,
  isActive
) => {
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
      throw new Error("Cannot update a deleted item");
    }

    const isActiveInt = isActive ? 1 : 0;

    // Update the item
    await tx.execute({
      sql: `UPDATE items 
            SET name = ?, 
                description = ?, 
                price = ?, 
                image = ?, 
                is_active = ?, 
                edited_by = ?,
                edited_at = datetime('now')
            WHERE id = ?`,
      args: [name, description, price, image, isActiveInt, userId, id],
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
            VALUES (?, ?, 'UPDATE', ?, ?)`,
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
        }),
        JSON.stringify({
          name,
          description,
          price,
          image,
          is_active: isActiveInt === 1,
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
    const { id, name, description, price, image, user_id, is_active } =
      validateRequestData(requestData);
    const { sanitized_name, sanitized_description, sanitized_image } =
      sanitizeData(name, description, image);

    const turso = createTursoClient();

    console.log("[INFO] Updating item:", {
      id,
      name: sanitized_name,
      description: sanitized_description,
      price,
      image: sanitized_image,
      user_id,
      is_active,
    });

    const item = await updateItem(
      turso,
      id,
      sanitized_name,
      sanitized_description,
      price,
      sanitized_image,
      user_id,
      is_active
    );

    console.log("[SUCCESS] Item updated successfully:", {
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
    console.error("[ERROR] Failed to update item:", {
      error: error.message,
      item: requestData?.name || "Unknown",
    });

    let status = 500;
    if (error.message.includes("Invalid API key")) status = 403;
    if (error.message.includes("All fields are required")) status = 400;
    if (error.message === "Method not allowed") status = 405;
    if (error.message === "Item not found") status = 404;
    if (error.message === "Cannot update a deleted item") status = 400;
    if (error.message.includes("Invalid ID") || error.message.includes("price"))
      status = 400;

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};

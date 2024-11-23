// get-items.js

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
  };
};

/**
 * Validates the API key provided in the headers.
 * @param {string|null} apiKey - API key to validate.
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
 * Validates the URL parameters.
 * @param {URL} url - The URL object containing search parameters.
 * @throws {Error} If any parameter is invalid.
 */
const validateUrlParams = (url) => {
  const allowedParams = ["id", "category_id"];
  for (const param of url.searchParams.keys()) {
    if (!allowedParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}`);
    }
  }
};

/**
 * Validates the item ID parameter.
 * @param {string|null} itemId - The item ID to validate.
 * @throws {Error} If the item ID is invalid.
 */
const validateItemId = (itemId) => {
  if (itemId && isNaN(Number(itemId))) {
    throw new Error("Invalid item ID");
  }
};

/**
 * Validates the category ID parameter.
 * @param {string|null} categoryId - The category ID to validate.
 * @throws {Error} If the category ID is invalid.
 */
const validateCategoryId = (categoryId) => {
  if (categoryId && isNaN(Number(categoryId))) {
    throw new Error("Invalid category ID");
  }
};

/**
 * Retrieves items and their associated categories from the database.
 * @param {Object} turso - Turso client.
 * @param {string|null} itemId - Specific item ID to retrieve.
 * @param {string|null} categoryId - Specific category ID to filter items.
 * @returns {Promise<Object|Object[]>} Single item with categories or an array of items.
 * @throws {Error} If the item or category is not found or a database error occurs.
 */
const getItems = async (turso, itemId, categoryId) => {
  if (itemId) {
    const itemResponse = await turso.execute({
      sql: `
        SELECT id, name, description, price, image, is_active, is_deleted, created_at, edited_at, created_by, edited_by
        FROM items
        WHERE id = ? AND is_deleted = 0
      `,
      args: [itemId],
    });

    if (!itemResponse?.rows?.length) {
      throw new Error("Item not found");
    }

    const categoriesResponse = await turso.execute({
      sql: `
        SELECT categories.id, categories.name, categories.image
        FROM categories
        INNER JOIN item_categories ON categories.id = item_categories.category_id
        WHERE item_categories.item_id = ? AND categories.is_deleted = 0
      `,
      args: [itemId],
    });

    const item = itemResponse.rows[0];
    item.categories = categoriesResponse.rows;

    return item;
  } else if (categoryId) {
    const itemsResponse = await turso.execute({
      sql: `
        SELECT items.id, items.name, items.description, items.price, items.image, items.is_active, items.is_deleted, items.created_at, items.edited_at, items.created_by, items.edited_by
        FROM items
        INNER JOIN item_categories ON items.id = item_categories.item_id
        WHERE item_categories.category_id = ? AND items.is_deleted = 0
      `,
      args: [categoryId],
    });

    return itemsResponse.rows;
  } else {
    const response = await turso.execute({
      sql: `
        SELECT id, name, description, price, image, is_active, is_deleted, created_at, edited_at, created_by, edited_by
        FROM items
        WHERE is_deleted = 0
      `,
      args: [],
    });

    return response.rows;
  }
};

/**
 * Handles incoming requests to retrieve items.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing items data or an error message.
 */
export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const turso = createTursoClient();

  try {
    if (request.method !== "GET") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const url = new URL(request.url);
    validateUrlParams(url);

    const itemId = url.searchParams.get("id");
    const categoryId = url.searchParams.get("category_id");

    validateItemId(itemId);
    validateCategoryId(categoryId);

    const items = await getItems(turso, itemId, categoryId);

    if (itemId) {
      console.log("[INFO] Get successful. Item and its categories retrieved.");
    } else if (categoryId) {
      console.log("[INFO] Get successful. Items by category retrieved.");
    } else {
      console.log("[INFO] Get successful. All items retrieved.");
    }

    return new Response(JSON.stringify(items), {
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
    if (errorMessage === "Item not found") status = 404;
    if (errorMessage === "Category not found") status = 404;
    if (errorMessage.includes("Invalid parameter")) status = 400;
    if (
      errorMessage.includes("Invalid item ID") ||
      errorMessage.includes("Invalid category ID")
    )
      status = 400;

    console.log("[INFO] Get failed.");

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
        await turso.execute({ type: "close" });
        console.log("[INFO] Turso connection closed successfully.");
      } catch (closeError) {
        console.error("[ERROR] Failed to close Turso connection:", closeError);
      }
    }
  }
};

// get-categories.js

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
  const allowedParams = ["id"];
  for (const param of url.searchParams.keys()) {
    if (!allowedParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}`);
    }
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
 * Retrieves categories and their associated items from the database.
 * @param {Object} turso - Turso client.
 * @param {string|null} categoryId - Specific category ID to retrieve.
 * @returns {Promise<Object|Object[]>} Single category with items or an array of categories.
 * @throws {Error} If the category is not found or a database error occurs.
 */
const getCategories = async (turso, categoryId) => {
  if (categoryId) {
    const categoryResponse = await turso.execute({
      sql: `
        SELECT id, name, image, created_at, edited_at, is_active, is_deleted, edited_by
        FROM categories
        WHERE id = ? AND is_deleted = 0
      `,
      args: [categoryId],
    });

    if (!categoryResponse?.rows?.length) {
      throw new Error("Category not found");
    }

    const itemsResponse = await turso.execute({
      sql: `
        SELECT items.id, items.name, items.description, items.price, items.image, items.is_active, items.is_deleted, items.created_at, items.edited_at, items.created_by, items.edited_by
        FROM items
        INNER JOIN item_categories ON items.id = item_categories.item_id
        WHERE item_categories.category_id = ? AND items.is_deleted = 0
      `,
      args: [categoryId],
    });

    const category = categoryResponse.rows[0];
    category.items = itemsResponse.rows;

    return category;
  } else {
    const response = await turso.execute({
      sql: `
        SELECT id, name, image, created_at, edited_at, is_active, is_deleted, edited_by
        FROM categories
        WHERE is_deleted = 0
      `,
      args: [],
    });

    return response.rows;
  }
};

/**
 * Handles incoming requests to retrieve categories.
 * Applies best practices for Turso connections, error handling, and documentation.
 * @param {Request} request - Incoming request object.
 * @returns {Promise<Response>} HTTP response containing categories data or an error message.
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

    const categoryId = url.searchParams.get("id");
    validateCategoryId(categoryId);

    const categories = await getCategories(turso, categoryId);

    if (categoryId) {
      console.log("[INFO] Get successful. Category and its items retrieved.");
    } else {
      console.log("[INFO] Get successful. Categories retrieved.");
    }

    return new Response(JSON.stringify(categories), {
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
    if (errorMessage === "Category not found") status = 404;
    if (errorMessage.includes("Invalid parameter")) status = 400;
    if (errorMessage.includes("Invalid category ID")) status = 400;

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

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
  const allowedParams = ["id", "category_id", "page", "limit"];
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
 * Validates pagination parameters
 * @param {string|null} page - Page number
 * @param {string|null} limit - Items per page
 * @throws {Error} If parameters are invalid
 */
const validatePagination = (page, limit) => {
  if (page && (isNaN(Number(page)) || Number(page) < 1)) {
    throw new Error("Invalid page number");
  }
  if (
    limit &&
    (isNaN(Number(limit)) || Number(limit) < 1 || Number(limit) > 24)
  ) {
    throw new Error("Invalid limit value");
  }
};

/**
 * Retrieves items and their associated categories from the database.
 * @param {Object} turso - Turso client.
 * @param {string|null} itemId - Specific item ID to retrieve.
 * @param {string|null} categoryId - Specific category ID to filter items.
 * @param {number} page - Page number for pagination.
 * @param {number} limit - Items per page.
 * @returns {Promise<Object|Object[]>} Single item with categories o un arreglo de items con sus categorías.
 * @throws {Error} If the item or category is not found or a database error occurs.
 */
const getItems = async (turso, itemId, categoryId, page = 1, limit = 24) => {
  const offset = (page - 1) * limit;

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
    // Obtener total de items para la categoría
    const totalQuery = await turso.execute({
      sql: `
        SELECT COUNT(DISTINCT items.id) as total 
        FROM items
        INNER JOIN item_categories ON items.id = item_categories.item_id
        WHERE item_categories.category_id = ? AND items.is_deleted = 0
      `,
      args: [categoryId],
    });

    if (!totalQuery?.rows?.length) {
      throw new Error("Category not found");
    }

    const itemsResponse = await turso.execute({
      sql: `
        SELECT DISTINCT items.id, items.name, items.description, items.price, 
               items.image, items.is_active, items.is_deleted, items.created_at, 
               items.edited_at, items.created_by, items.edited_by
        FROM items
        INNER JOIN item_categories ON items.id = item_categories.item_id
        WHERE item_categories.category_id = ? AND items.is_deleted = 0
        ORDER BY items.created_at DESC
        LIMIT ? OFFSET ?
      `,
      args: [categoryId, limit, offset],
    });

    const items = await Promise.all(
      itemsResponse.rows.map(async (item) => {
        const categoriesResponse = await turso.execute({
          sql: `
            SELECT categories.id, categories.name, categories.image
            FROM categories
            INNER JOIN item_categories ON categories.id = item_categories.category_id
            WHERE item_categories.item_id = ? AND categories.is_deleted = 0
          `,
          args: [item.id],
        });
        item.categories = categoriesResponse.rows;
        return item;
      })
    );

    return {
      items,
      pagination: {
        total: totalQuery.rows[0].total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(totalQuery.rows[0].total / limit),
      },
    };
  } else {
    // Obtener total de items
    const totalQuery = await turso.execute({
      sql: `SELECT COUNT(*) as total FROM items WHERE is_deleted = 0`,
      args: [], // Añadido args vacío
    });

    if (!totalQuery?.rows?.length) {
      throw new Error("No items found");
    }

    const response = await turso.execute({
      sql: `
        SELECT id, name, description, price, image, is_active, is_deleted, 
               created_at, edited_at, created_by, edited_by
        FROM items
        WHERE is_deleted = 0
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      args: [limit, offset],
    });

    const items = await Promise.all(
      response.rows.map(async (item) => {
        const categoriesResponse = await turso.execute({
          sql: `
            SELECT categories.id, categories.name, categories.image
            FROM categories
            INNER JOIN item_categories ON categories.id = item_categories.category_id
            WHERE item_categories.item_id = ? AND categories.is_deleted = 0
          `,
          args: [item.id],
        });
        item.categories = categoriesResponse.rows;
        return item;
      })
    );

    return {
      items,
      pagination: {
        total: totalQuery.rows[0].total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(totalQuery.rows[0].total / limit),
      },
    };
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
    const page = url.searchParams.get("page") || "1";
    const limit = url.searchParams.get("limit") || "24";

    validateItemId(itemId);
    validateCategoryId(categoryId);
    validatePagination(page, limit);

    const result = await getItems(
      turso,
      itemId,
      categoryId,
      parseInt(page),
      parseInt(limit)
    );

    if (itemId) {
      console.log("[INFO] Get successful. Item and its categories retrieved.");
    } else if (categoryId) {
      console.log("[INFO] Get successful. Items by category retrieved.");
    } else {
      console.log("[INFO] Get successful. All items retrieved.");
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
    if (errorMessage === "Item not found") status = 404;
    if (errorMessage === "Category not found") status = 404;
    if (errorMessage === "No items found") status = 404;
    if (errorMessage.includes("Invalid parameter")) status = 400;
    if (
      errorMessage.includes("Invalid item ID") ||
      errorMessage.includes("Invalid category ID") ||
      errorMessage.includes("Invalid page") ||
      errorMessage.includes("Invalid limit")
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

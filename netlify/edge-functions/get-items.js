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

const validateUrlParams = (url) => {
  const allowedParams = ["id"];
  for (const param of url.searchParams.keys()) {
    if (!allowedParams.includes(param)) {
      throw new Error(`Invalid parameter: ${param}`);
    }
  }
};

const validateId = (id) => {
  if (id && isNaN(Number(id))) {
    throw new Error("Invalid ID");
  }
};

export default async (request) => {
  const corsHeaders = getCorsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (request.method !== "GET") {
      throw new Error("Method not allowed");
    }

    const apiKey = request.headers.get("X-API-KEY");
    validateApiKey(apiKey);

    const url = new URL(request.url);
    validateUrlParams(url);

    const itemId = url.searchParams.get("id");

    validateId(itemId);

    const turso = createTursoClient();
    let response;

    if (itemId) {
      response = await turso.execute({
        sql: `
          SELECT items.*, categories.id AS category_id, categories.name AS category_name, categories.is_active AS category_is_active
          FROM items
          LEFT JOIN item_categories ON items.id = item_categories.item_id
          LEFT JOIN categories ON item_categories.category_id = categories.id
          WHERE items.id = ? AND items.is_deleted = 0
        `,
        args: [itemId],
      });

      if (!response?.rows?.length) {
        throw new Error("Item not found");
      }

      // Agrupar categorías
      const item = response.rows.reduce((acc, row) => {
        if (!acc.id) {
          acc = {
            id: row.id,
            name: row.name,
            description: row.description,
            price: row.price,
            image: row.image,
            is_active: row.is_active,
            is_deleted: row.is_deleted,
            created_at: row.created_at,
            edited_at: row.edited_at,
            created_by: row.created_by,
            edited_by: row.edited_by,
            categories: [],
          };
        }
        if (row.category_id) {
          acc.categories.push({
            id: row.category_id,
            name: row.category_name,
            is_active: !!row.category_is_active,
          });
        }
        return acc;
      }, {});

      console.log("[INFO] Get item successful.");

      return new Response(JSON.stringify(item), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    } else {
      response = await turso.execute({
        sql: `
          SELECT items.*, categories.id AS category_id, categories.name AS category_name, categories.is_active AS category_is_active
          FROM items
          LEFT JOIN item_categories ON items.id = item_categories.item_id
          LEFT JOIN categories ON item_categories.category_id = categories.id
          WHERE items.is_deleted = 0
        `,
        args: [],
      });

      if (!response?.rows?.length) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      }

      // Agrupar categorías por cada item
      const itemsMap = {};

      response.rows.forEach((row) => {
        if (!itemsMap[row.id]) {
          itemsMap[row.id] = {
            id: row.id,
            name: row.name,
            description: row.description,
            price: row.price,
            image: row.image,
            is_active: row.is_active,
            is_deleted: row.is_deleted,
            created_at: row.created_at,
            edited_at: row.edited_at,
            created_by: row.created_by,
            edited_by: row.edited_by,
            categories: [],
          };
        }
        if (row.category_id) {
          itemsMap[row.id].categories.push({
            id: row.category_id,
            name: row.category_name,
            is_active: !!row.category_is_active,
          });
        }
      });

      const items = Object.values(itemsMap);

      console.log("[INFO] Get all items successful.");

      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }
  } catch (error) {
    console.error("[ERROR] Operation failed:", error);

    let status = 500;
    if (error.message.includes("API key")) status = 403;
    if (error.message === "Método no permitido") status = 405;
    if (error.message === "Item no encontrado") status = 404;
    if (error.message.includes("Parámetro inválido")) status = 400;
    if (error.message.includes("ID inválido")) status = 400;

    console.log("[INFO] Get items failed.");

    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
};
